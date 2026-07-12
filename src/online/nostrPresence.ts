// Presencia Nostr (NIP-38, kind:30315 "User Statuses"). El PROPIO jugador firma su
// estado "Jugando TETRA" y lo publica a los relays. Ventaja: la presencia vive en
// Nostr, la lee cualquier cliente y sobrevive aunque Luna Negra caiga; el juego no
// depende de la API para esto. Es la única presencia que publica el juego. Ver la
// skill `integrar-ngp-v2` (Presencia NIP-38).
//
// PUERTO fino sobre el `createPresenceManager` del SDK (`nostr-game-protocol/ngp`),
// que ya trae el ciclo de vida completo: heartbeat sin gate de visibilidad, throttle
// de firma con cooldown, throttle PERSISTIDO entre recargas (evita el prompt de la
// extensión en cada reload), clear pre-firmado para `pagehide` y clear de logout.
// Acá quedan SOLO las decisiones del juego: la copy del estado, el TTL, los relays
// de escritura y la clave de storage.
import type { Event } from 'nostr-tools';
import type { LunaSigner } from './nostrSigner';
import { PUBLIC_WRITE_RELAYS, getPool } from './nostrRelays';
import { TETRA_GAME_COORD } from './nostrChallenge';
import {
  buildPresenceEvent as ngpBuildPresenceEvent,
  createPresenceManager,
  type NgpPresenceManager,
} from 'nostr-game-protocol/ngp';

// Vida del estado sin re-latir. Es la RED DE SEGURIDAD si el clear del cierre no
// llegó a salir (crash): fantasma acotado a ~3 min — el cierre normal lo baja al
// instante el clear pre-firmado de `pagehide` (clearPresenceNowSync) y el logout
// el suyo (stopPresence). Es la RED DE SEGURIDAD si el clear de cierre no llegó:
// acota el fantasma a este TTL. El heartbeat sigue corriendo con la pestaña de
// fondo ("jugando" = juego ABIERTO, no en primer plano) y los navegadores
// estrangulan los timers ocultos a ~1 disparo/min. 120s tolera UN latido
// estrangulado/perdido sin titilar (180s toleraba dos): si aparece flicker mirando
// la tienda con el juego abierto de fondo, subir a 150/180.
export const PRESENCE_TTL_SEC = 120;

export type PresenceStatus = 'in-game' | 'online';

// Sin emoji: la UI de Luna Negra (y su riel de amigos) antepone 🎮 al mostrar el
// estado, así que meter otro acá lo duplicaría. Los clientes Nostr genéricos igual
// leen el texto tal cual ("Jugando TETRA").
function statusMessage(status: PresenceStatus): string {
  return status === 'in-game' ? 'Jugando TETRA' : 'En TETRA';
}

/**
 * Firma el evento de presencia NIP-38 (kind:30315) para el estado dado. No publica:
 * sólo firma (útil para testear el round-trip). El manager de abajo arma el mismo
 * evento por adentro; esta función queda como builder puro.
 */
export async function buildPresenceEvent(
  signer: LunaSigner,
  status: PresenceStatus,
): Promise<Event> {
  return ngpBuildPresenceEvent(signer, {
    gameCoord: TETRA_GAME_COORD,
    message: statusMessage(status),
    ttlSec: PRESENCE_TTL_SEC,
  });
}

function publishToWrite(evt: Event): Promise<unknown> {
  return Promise.any(getPool().publish(PUBLIC_WRITE_RELAYS, evt));
}

// Envío fire-and-forget para el cierre de pestaña: encola el send sobre los
// sockets ya abiertos del pool, sin await (en el unload un await no llega).
function publishToWriteSync(evt: Event): void {
  try {
    for (const p of getPool().publish(PUBLIC_WRITE_RELAYS, evt)) p.catch(() => {});
  } catch {
    // pool caído en pleno cierre: el TTL corto la baja solo
  }
}

// Manager por CUENTA: se recrea si cambia la pubkey (no heredar throttle ni clears
// de otra sesión). El logout lo tira entero vía stopPresence, así un re-login
// (aunque sea la misma cuenta con otro método de firma) arranca con signer fresco.
let manager: NgpPresenceManager | null = null;
let managerPubkey: string | null = null;

/**
 * Anuncia/actualiza la presencia del jugador. Idempotente y barata: el manager
 * solo firma cuando cambia el estado o el último evento está por caducar, y el
 * throttle persistido evita re-firmar (= re-promptar) al recargar la página.
 */
export function syncPresence(
  signer: LunaSigner,
  pubkey: string,
  status: PresenceStatus,
): void {
  if (!manager || managerPubkey !== pubkey) {
    manager = createPresenceManager({
      signer,
      gameCoord: TETRA_GAME_COORD,
      pubkey,
      ttlSec: PRESENCE_TTL_SEC,
      publish: publishToWrite,
      publishSync: publishToWriteSync,
      storage: typeof localStorage === 'undefined' ? null : localStorage,
      storageKey: 'tetra.nostrPresence.v1',
    });
    managerPubkey = pubkey;
  }
  manager.start(statusMessage(status));
}

/**
 * Limpieza SINCRÓNICA para el cierre de pestaña (`pagehide`): despacha el clear
 * pre-firmado sin `await`, así "Jugando TETRA" desaparece ya al cerrar el juego en
 * vez de esperar el TTL. Conserva el throttle persistido a propósito: en un reload
 * es lo que evita re-firmar al volver.
 */
export function clearPresenceNowSync(): void {
  manager?.clearNow();
}

/**
 * Limpia la presencia y tira el manager (logout): publica un clear fresco para que
 * "Jugando TETRA" desaparezca ya, y olvida el throttle persistido — la próxima
 * sesión re-anuncia desde cero. Best-effort: no lanza.
 */
export async function stopPresence(): Promise<void> {
  const m = manager;
  manager = null;
  managerPubkey = null;
  if (m) await m.stop();
}
