// Recepción de invitaciones "Luna Room Link" por DM Nostr: el cliente de Luna
// Negra manda la invitación como DM NIP-04 (kind:4) con el texto "Te invito a
// jugar … <url ?join=>" (ver friends-sidebar/inviteViaRoomLink en el repo de
// Luna). Su propio cliente lo detecta descifrando el DM y buscando el enlace
// (`parseRoomLink` de lib/invite.ts); acá replicamos EXACTAMENTE esa detección
// para que el TETRA abierto muestre el mismo popup sin depender del poll REST
// de launch-requests (que además necesita las env LUNA_NEGRA_* en el server).
//
// Mismo patrón singleton que nostrChallengeInbox: una sola suscripción activa,
// dedup por id de evento persistida en localStorage.
import type { Event } from 'nostr-tools';
import type { LunaSigner } from './nostrSigner';
import { DM_RELAYS, getPool } from './nostrRelays';

// Lo que devuelve pool.subscribeMany: un handle para cerrar la suscripción.
type SubCloser = { close: () => void };

export type RoomLinkInvite = {
  /** Id del evento kind:4 (sirve como id estable para dedup/ignorar). */
  eventId: string;
  fromPubkey: string;
  roomId: string;
  /** URL completa del enlace (`…?join=<roomId>`), ya validada same-origin. */
  url: string;
  /** Título del juego extraído del texto ("Te invito a jugar X…"), si vino. */
  title: string | null;
};

const SEEN_KEY = 'stack40.roomlink_invite_seen.v1';
// kind:4 lleva created_at real (a diferencia de los gift-wrap NIP-59), así que
// la ventana puede ser corta: una invitación vieja apunta a una sala muerta.
const LOOKBACK_SECONDS = 10 * 60;

// Mismos regex que lib/invite.ts de Luna (parseRoomLink / parseInviteTitle).
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const LN_ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TITLE_RE = /Te invito a jugar (.+?) en Luna Negra/i;

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
    const trimmed = [...seen].slice(-200);
    localStorage.setItem(SEEN_KEY, JSON.stringify(trimmed));
  } catch {
    /* storage bloqueado: la dedup vive solo en memoria esta sesión */
  }
}

/**
 * Busca en un texto arbitrario un enlace `?join=` que apunte a ESTE deploy
 * (mismo origin). El check de origin es la diferencia con el parseRoomLink de
 * Luna (que abre cualquier juego en otra pestaña): acá "aceptar" une a una sala
 * del backend PROPIO, así que un enlace de otro juego no debe generar popup.
 */
export function parseOwnRoomLink(
  text: string,
  origin: string | null,
): { url: string; roomId: string } | null {
  const matches = text.match(URL_RE);
  if (!matches) return null;
  for (const raw of matches) {
    try {
      const u = new URL(raw);
      if (origin && u.origin !== origin) continue;
      const roomId = u.searchParams.get('join');
      if (roomId && LN_ROOM_RE.test(roomId)) return { url: raw, roomId };
    } catch {
      /* no es una URL válida → seguir con la siguiente */
    }
  }
  return null;
}

export type RoomLinkInboxOptions = {
  /** Origin exigido a los enlaces (default: el de la página). `null` desactiva
   * el filtro — solo para tests. */
  origin?: string | null;
};

/**
 * Arranca la escucha de invitaciones room-link entrantes (DM kind:4) para
 * `myPubkey`. Llama `onInvite` una vez por invitación nueva a una sala de este
 * juego. Devuelve un stop (idempotente). Cierra la suscripción previa si la había.
 */
export function startRoomLinkInviteInbox(
  signer: LunaSigner,
  myPubkey: string,
  onInvite: (invite: RoomLinkInvite) => void,
  options: RoomLinkInboxOptions = {},
): () => void {
  activeStop?.();

  const me = myPubkey.trim().toLowerCase();
  const origin = options.origin !== undefined
    ? options.origin
    : typeof window !== 'undefined' ? window.location.origin : null;
  const seen = readSeen();
  let closed = false;

  const onevent = (event: Event) => {
    if (closed || seen.has(event.id)) return;
    const from = event.pubkey.trim().toLowerCase();
    // La auto-copia de un DM propio no es una invitación para mí.
    if (from === me) return;
    void (async () => {
      let plain = '';
      try {
        // NIP-04: el peer del descifrado es el emisor del evento.
        plain = await signer.nip04Decrypt(event.pubkey, event.content);
      } catch {
        return; // sin permiso del firmante / no descifrable: no es para nosotros
      }
      if (closed || !plain) return;
      const link = parseOwnRoomLink(plain, origin);
      if (!link) return;
      // Re-chequeo tras el await: otro relay pudo entregar el MISMO evento
      // mientras descifrábamos (misma carrera que cierra nostrChallengeInbox).
      if (seen.has(event.id)) return;
      seen.add(event.id);
      persistSeen(seen);
      const title = TITLE_RE.exec(plain)?.[1]?.trim() ?? null;
      onInvite({
        eventId: event.id,
        fromPubkey: from,
        roomId: link.roomId,
        url: link.url,
        title,
      });
    })();
  };

  // Luna publica el DM a sus relays (damus, nos.lol, primal, …); DM_RELAYS
  // comparte tres de ellos, con uno alcanza para recibirlo.
  const sub: SubCloser = getPool().subscribeMany(
    DM_RELAYS,
    {
      kinds: [4],
      '#p': [me],
      since: Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS,
    },
    { onevent },
  );

  const stop = () => {
    if (closed) return;
    closed = true;
    try {
      sub.close();
    } catch {
      /* ignore */
    }
    if (activeStop === stop) activeStop = null;
  };

  activeStop = stop;
  return stop;
}

export function stopRoomLinkInviteInbox(): void {
  activeStop?.();
}
