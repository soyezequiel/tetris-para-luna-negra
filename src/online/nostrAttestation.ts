// PUERTO del oráculo de atestaciones (NGP kind:31338) — SERVER-SIDE.
//
// El formato del evento (ancla `a`, `d` permanente por partida, `status`) vive en
// la capa protocolo (`nostr-game-protocol/ngp`, buildAttestationEvent); acá quedan
// las cosas del PROGRAMA: la clave del oráculo (env), la coordenada del juego, el
// mapeo sala→ganador y la publicación a relays.
//
// Certifica SOLO lo que el servidor presenció: el ganador de un versus arbitrado
// por la sala autoritativa (room.winnerPlayerId). Disparadores:
//   - apuesta: en el settle NGE, con ref = betId (lunaNegraBets). ← el único vivo hoy.
//   - PENDIENTE, versus sin apuesta: al terminar la partida, con ref = matchResultId,
//     leyendo la sala AUTORITATIVA del DO por el bridge (attestFinishedRoomWinner).
//     `buildRoomWinnerAttestation` ya toma un `ref` genérico para soportarlo; falta
//     la función que lea el RoomStore y la enganche al fin de partida.
// Nunca un score de cliente ni el modo 1 jugador (no hay validación server-side
// del puntaje: firmarlo sería teatro de seguridad).
//
// Cadena de confianza (delegación): la pubkey de NGP_ATTESTATION_ORACLE_NSEC está
// declarada como oráculo del juego en su listado 30023 de Luna Negra (tag
// ["oracle", pk]; se declara en el panel de proveedor, POST
// /api/provider/games/{id}/attestation-oracle). Un verificador cruza el firmante
// del 31338 contra esa delegación (oraclePubkeyFromListing +
// isAuthorizedAttestation del SDK).
//
// Corre en Node serverless (Vercel), NUNCA en el navegador: la nsec vive solo en
// el env del server. Best-effort: la atestación jamás bloquea ni rompe el settle.
import { SimplePool, nip19, finalizeEvent, getPublicKey } from 'nostr-tools';
import type { Event, EventTemplate } from 'nostr-tools';
import { buildAttestationEvent, type NgpSigner } from 'nostr-game-protocol/ngp';
// OJO: la extensión `.js` es OBLIGATORIA. A este módulo lo alcanza `api/bets/*`, que
// Vercel corre como ESM de Node SIN empaquetar: un specifier relativo sin extensión
// tira ERR_MODULE_NOT_FOUND al importar y voltea la función ENTERA (500
// FUNCTION_INVOCATION_FAILED en todas sus rutas, incluso las que no tocan apuestas).
// Vite sí resuelve sin extensión, así que ni el build ni los tests lo detectan solos:
// lo cubre tests/apiEsmImports.test.ts.
import { PUBLIC_WRITE_RELAYS } from './nostrRelays.js';
import type { OnlineRoom } from './protocol';
import type { RoomStore } from './roomService.js';

/** Corte total de la publicación: en serverless no podemos colgar el settle. */
const PUBLISH_TIMEOUT_MS = 5_000;

/** Clave del oráculo (nsec bech32 o hex de 64) desde el env, o null. */
function attestationSecretKey(): Uint8Array | null {
  const raw = (process.env.NGP_ATTESTATION_ORACLE_NSEC ?? '').trim();
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
 * Nostr. `ref` = id único de la partida (betId en apuestas; matchResultId en un
 * versus sin apuesta). No publica: sólo firma.
 */
export async function buildRoomWinnerAttestation(
  room: OnlineRoom,
  ref: string,
): Promise<Event | null> {
  const sk = attestationSecretKey();
  const gameCoord = serverGameCoord();
  if (!sk || !gameCoord) return null;
  const playerPubkey = winnerPubkeyFromRoom(room);
  if (!playerPubkey) return null;
  try {
    return await buildAttestationEvent(localSigner(sk), {
      gameCoord,
      ref,
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
 * 31338 con la clave del oráculo y lo publica. En el settle de apuesta corre EN
 * PARALELO con la persistencia (mismo Promise.all): no agrega latencia y termina
 * antes de que la invocación serverless retorne.
 */
export async function attestRoomWinner(room: OnlineRoom, ref: string): Promise<void> {
  try {
    const ev = await buildRoomWinnerAttestation(room, ref);
    if (!ev) return;
    const ok = await publishFirstAck(ev);
    if (!ok) {
      console.warn(`[attestation] ningún relay aceptó el 31338 de la partida ${ref}`);
    }
  } catch (error) {
    console.warn(`[attestation] falló la atestación de la partida ${ref}:`, error);
  }
}

/**
 * Resuelve y FIRMA la atestación de un versus SIN apuesta leyendo la sala
 * AUTORITATIVA del store (el bridge al Durable Object): el cliente solo aporta el
 * `roomId`, el ganador lo dicta el SERVIDOR — un cliente no puede certificar a
 * quien no ganó. `ref` = `matchResultId` (único por partida, se limpia en el
 * rematch), así cada partida deja su propio registro permanente.
 *
 * Devuelve null (sin atestar) si: la sala no existe, no terminó, TIENE apuesta
 * (la atesta el settle con ref = betId; duplicarlo publicaría dos eventos de la
 * misma partida), no tiene `matchResultId`, o el ganador no tiene npub real.
 * No publica: sólo firma.
 */
export async function buildFinishedRoomAttestation(
  store: RoomStore,
  roomId: string,
): Promise<Event | null> {
  const room = await store.getRoom(roomId);
  if (!room) return null;
  if (room.status !== 'finished') return null; // la partida todavía no se selló
  if (room.bet) return null; // la atesta el settle de la apuesta, con ref = betId
  if (!room.matchResultId) return null; // sin id de partida no hay registro estable
  return buildRoomWinnerAttestation(room, room.matchResultId);
}

/**
 * Atesta al ganador de un versus SIN apuesta (best-effort, NUNCA lanza).
 * Idempotente: re-disparar publica el MISMO evento addressable
 * (`d` = coord:matchResultId), que el relay reemplaza sin duplicar — por eso es
 * seguro que lo dispare cada cliente al terminar la partida.
 */
export async function attestFinishedRoomWinner(
  store: RoomStore,
  roomId: string,
): Promise<void> {
  try {
    const ev = await buildFinishedRoomAttestation(store, roomId);
    if (!ev) return;
    const ok = await publishFirstAck(ev);
    if (!ok) console.warn(`[attestation] ningún relay aceptó el 31338 de la sala ${roomId}`);
  } catch (error) {
    console.warn(`[attestation] falló la atestación de la sala ${roomId}:`, error);
  }
}
