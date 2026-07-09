// PUERTO del oráculo de atestaciones (NGP kind:31338) — SERVER-SIDE.
//
// El formato del evento (ancla `a`, `d` permanente por partida, `status`) vive en
// la capa protocolo (`nostr-game-protocol/ngp`, buildAttestationEvent); acá quedan
// las cosas del PROGRAMA: la clave del oráculo (env), la coordenada del juego, el
// mapeo sala→ganador y la publicación a relays.
//
// Certifica SOLO lo que el servidor presenció: el ganador de un versus arbitrado
// por la sala autoritativa (room.winnerPlayerId), en el momento en que ese mismo
// resultado mueve el dinero del escrow (settle NGE). Nunca un score de cliente.
//
// Cadena de confianza (delegación): la pubkey de LUNA_NEGRA_NGP_NSEC está
// declarada como oráculo del juego en su listado 30023 de Luna Negra (tag
// ["oracle", pk], POST /api/provider/games/{id}/attestation-oracle con prueba de
// posesión). Un verificador cruza el firmante del 31338 contra esa delegación
// (oraclePubkeyFromListing + isAuthorizedAttestation del SDK).
//
// Corre en Node serverless (Vercel), NUNCA en el navegador: la nsec vive solo en
// el env del server. Best-effort: la atestación jamás bloquea ni rompe el settle.
import { SimplePool, nip19, finalizeEvent, getPublicKey } from 'nostr-tools';
import type { Event, EventTemplate } from 'nostr-tools';
import { buildAttestationEvent, type NgpSigner } from 'nostr-game-protocol/ngp';
import { PUBLIC_WRITE_RELAYS } from './nostrRelays';
import type { OnlineRoom } from './protocol';

/** Corte total de la publicación: en serverless no podemos colgar el settle. */
const PUBLISH_TIMEOUT_MS = 5_000;

/** Clave del oráculo (nsec bech32 o hex de 64) desde el env, o null. */
function attestationSecretKey(): Uint8Array | null {
  const raw = (process.env.LUNA_NEGRA_NGP_NSEC ?? '').trim();
  if (!raw) return null;
  try {
    if (raw.startsWith('nsec')) {
      const d = nip19.decode(raw);
      return d.type === 'nsec' ? (d.data as Uint8Array) : null;
    }
    if (/^[0-9a-f]{64}$/i.test(raw)) return Uint8Array.from(Buffer.from(raw, 'hex'));
  } catch {
    /* cae abajo */
  }
  return null;
}

/** Coordenada del juego (30023:<dev>:<slug>) del lado server. Misma env que el
 *  cliente (Vite la inyecta en build; acá la lee Node directo). */
function serverGameCoord(): string | null {
  const coord = (process.env.gameCoord ?? '').trim();
  return coord || null;
}

/** ¿Está configurado el oráculo? (nsec + coordenada). Es el único gate. */
export function attestationConfigured(): boolean {
  return attestationSecretKey() !== null && serverGameCoord() !== null;
}

/** Firmante NgpSigner sobre la clave local del oráculo (solo firma; sin NIP-44). */
function localSigner(sk: Uint8Array): NgpSigner {
  return {
    getPublicKey: async () => getPublicKey(sk),
    signEvent: async (template: EventTemplate) => finalizeEvent(template, sk),
  };
}

/** Pubkey hex del ganador de la sala, o null si no hay ganador con identidad
 *  Nostr REAL (invitados anónimos no se atestan: no hay a quién certificar). */
function winnerPubkeyFromRoom(room: OnlineRoom): string | null {
  if (!room.winnerPlayerId) return null; // sin ganador (empate/anulación)
  const winner = room.players.find((p) => p.id === room.winnerPlayerId);
  if (!winner?.npub) return null; // invitado sin identidad Nostr
  try {
    const d = nip19.decode(winner.npub);
    return d.type === 'npub' ? (d.data as string) : null;
  } catch {
    return null;
  }
}

/**
 * Arma y FIRMA la atestación del ganador del versus (kind:31338), o null si no
 * aplica: oráculo sin configurar, sala sin ganador, o ganador sin identidad
 * Nostr. `ref` = betId (id único de la partida apostada; el 31340/1341 públicos
 * de esa apuesta ya llevan la sala). No publica: sólo firma.
 */
export async function buildRoomWinnerAttestation(
  room: OnlineRoom,
  betId: string,
): Promise<Event | null> {
  const sk = attestationSecretKey();
  const gameCoord = serverGameCoord();
  if (!sk || !gameCoord) return null;
  const playerPubkey = winnerPubkeyFromRoom(room);
  if (!playerPubkey) return null;
  try {
    return await buildAttestationEvent(localSigner(sk), {
      gameCoord,
      ref: betId,
      playerPubkey,
      status: 'verified',
    });
  } catch {
    return null; // template inválido (ref vacío, etc.): no hay nada que atestar
  }
}

/** Publica al primer relay que acepte (el resto sigue en background) con corte
 *  duro de PUBLISH_TIMEOUT_MS. Pool fresco por invocación (serverless). */
async function publishFirstAck(ev: Event): Promise<boolean> {
  const pool = new SimplePool();
  try {
    const timeout = new Promise<false>((resolve) =>
      setTimeout(() => resolve(false), PUBLISH_TIMEOUT_MS),
    );
    const anyOk = Promise.any(pool.publish(PUBLIC_WRITE_RELAYS, ev)).then(
      () => true,
      () => false,
    );
    return await Promise.race([anyOk, timeout]);
  } finally {
    pool.close(PUBLIC_WRITE_RELAYS);
  }
}

/**
 * Atesta al ganador del versus de `room` (best-effort, NUNCA lanza): firma el
 * 31338 con la clave del oráculo y lo publica. Pensada para correr EN PARALELO
 * con la persistencia del settle (mismo Promise.all): no agrega latencia y
 * termina antes de que la invocación serverless retorne.
 */
export async function attestRoomWinner(room: OnlineRoom, betId: string): Promise<void> {
  try {
    const ev = await buildRoomWinnerAttestation(room, betId);
    if (!ev) return;
    const ok = await publishFirstAck(ev);
    if (!ok) {
      console.warn(`[attestation] ningún relay aceptó el 31338 de la apuesta ${betId}`);
    }
  } catch (error) {
    console.warn(`[attestation] falló la atestación de la apuesta ${betId}:`, error);
  }
}
