// Recepción de retos NIP-17: se suscribe a los gift-wrap (kind:1059) dirigidos a
// mí, los desarma con el firmante y avisa por callback. Singleton (una sola
// suscripción activa a la vez), con el patrón `activeStop` de playing-presence.
//
// Deduplica por id de gift-wrap Y de rumor (un mismo reto llega por varios relays),
// y persiste los ids ya avisados en localStorage para no re-mostrar el toast al
// recargar dentro de la ventana de vigencia del reto.
import type { Event } from 'nostr-tools';
import type { LunaSigner } from './nostrSigner';

// Lo que devuelve pool.subscribeMany: un handle para cerrar la suscripción.
type SubCloser = { close: () => void };

import { getPool } from './nostrRelays';
import {
  parseChallengeGiftWrap,
  resolveDmInboxRelays,
  type ParsedChallenge,
} from './nostrChallenge';

const SEEN_KEY = 'stack40.challenge_seen.v1';
// Ventana de escucha: los gift-wrap llevan created_at aleatorizado hasta 2 días
// atrás (NIP-59), así que miramos algo más que eso para no perder retos recientes.
const LOOKBACK_SECONDS = 3 * 24 * 60 * 60;

let activeStop: (() => void) | null = null;

function readSeen(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function persistSeen(seen: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    // Acotamos para que no crezca sin límite (los viejos ya expiraron igual).
    const trimmed = [...seen].slice(-500);
    localStorage.setItem(SEEN_KEY, JSON.stringify(trimmed));
  } catch {
    /* storage bloqueado: la dedup vive solo en memoria esta sesión */
  }
}

/**
 * Arranca la escucha de retos entrantes para `myPubkey`. Llama `onChallenge` una
 * vez por reto nuevo, válido y vigente. Devuelve un stop (idempotente). Cierra la
 * suscripción previa si la había.
 */
export function startChallengeInbox(
  signer: LunaSigner,
  myPubkey: string,
  onChallenge: (challenge: ParsedChallenge) => void,
): () => void {
  activeStop?.();

  const me = myPubkey.trim().toLowerCase();
  const origin = typeof window !== 'undefined' ? window.location.origin : null;
  const seen = readSeen();
  let closed = false;
  let sub: SubCloser | null = null;

  const onevent = (event: Event) => {
    if (closed || seen.has(event.id)) return;
    void (async () => {
      const challenge = await parseChallengeGiftWrap(signer, event, { origin });
      if (closed || !challenge) return;
      // Ignoramos la auto-copia (el reto que YO mandé se publica también a mi propia
      // bandeja para el historial en otros clientes): no debo retarme a mí mismo.
      if (challenge.fromPubkey.trim().toLowerCase() === me) return;
      // Dedup por gift-wrap y por rumor (mismo reto, distinto sobre/relay).
      if (seen.has(challenge.giftWrapId)) return;
      seen.add(challenge.giftWrapId);
      if (challenge.rumorId) {
        if (seen.has(challenge.rumorId)) return;
        seen.add(challenge.rumorId);
      }
      persistSeen(seen);
      onChallenge(challenge);
    })();
  };

  // Escuchamos en el MISMO conjunto de relays donde un emisor publicaría el reto
  // hacia mí: DM_RELAYS ∪ mis propios kind:10050. Si solo miráramos DM_RELAYS,
  // perderíamos los retos que llegan a mi bandeja NIP-17 declarada en otro cliente.
  // resolveDmInboxRelays es async, así que abrimos la suscripción cuando resuelve;
  // si para entonces ya cerraron, no la abrimos.
  void resolveDmInboxRelays(me)
    .then((relays) => {
      if (closed) return;
      sub = getPool().subscribeMany(
        relays,
        {
          kinds: [1059],
          '#p': [me],
          since: Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS,
        },
        { onevent },
      );
    })
    .catch(() => {
      /* no se pudo abrir la suscripción: quedará sin recibir (best-effort) */
    });

  const stop = () => {
    if (closed) return;
    closed = true;
    try {
      sub?.close();
    } catch {
      /* ignore */
    }
    if (activeStop === stop) activeStop = null;
  };

  activeStop = stop;
  return stop;
}

export function stopChallengeInbox(): void {
  activeStop?.();
}
