// Presencia Nostr (NIP-38, kind:30315 "User Statuses"). El PROPIO jugador firma su
// estado "Jugando TETRA" y lo publica a los relays. Ventaja: la presencia vive en
// Nostr, la lee cualquier cliente y sobrevive aunque Luna Negra caiga; el juego no
// depende de la API para esto. Es la única presencia que publica el juego. Ver la
// skill `integrar-luna-negra` (interfaz 2.0 · Presencia NIP-38).
//
// El evento es addressable/replaceable (kind 30000-39999) con `d`="general": cada
// jugador tiene UN estado que se auto-reemplaza. Un `expiration` tag lo hace caducar
// solo si dejamos de latir, así "Jugando" desaparece cuando el jugador cierra o
// cambia de app.
// PUERTO de presencia — el formato del evento vive en la capa protocolo
// (`nostr-game-protocol/ngp`); acá quedan la copy del estado, el TTL del juego y los relays.
import type { Event } from 'nostr-tools';
import type { LunaSigner } from './nostrSigner';
import { PUBLIC_WRITE_RELAYS, getPool } from './nostrRelays';
import { TETRA_GAME_COORD } from './nostrChallenge';
import {
  buildPresenceEvent as ngpBuildPresenceEvent,
  buildPresenceClearEvent,
} from 'nostr-game-protocol/ngp';
import { buildPresenceClearTemplate } from 'nostr-game-protocol/ngp-core';

// Vida del estado sin re-latir. Es la RED DE SEGURIDAD si el clear del cierre no
// llegó a salir (crash): fantasma acotado a ~3 min — el cierre normal lo baja al
// instante el clear pre-firmado de `pagehide` (clearPresenceNowSync) y el logout
// el suyo (clearPresenceEvent). NO puede ser menor: el heartbeat sigue corriendo
// con la pestaña de fondo ("jugando" = juego ABIERTO, no en primer plano — si no,
// mirar la tienda te bajaba en ~1 min), y los navegadores estrangulan los timers
// ocultos a ~1 disparo/min; 180s tolera hasta dos latidos estrangulados/perdidos
// sin titilar. Cada re-publicación es una FIRMA (con bunker NIP-46 puede promptar),
// pero el throttle persistido evita re-firmar al abrir si el último evento sigue
// fresco.
export const PRESENCE_TTL_SEC = 180;

export type PresenceStatus = 'in-game' | 'online';

// Sin emoji: la UI de Luna Negra (y su riel de amigos) antepone 🎮 al mostrar el
// estado, así que meter otro acá lo duplicaría. Los clientes Nostr genéricos igual
// leen el texto tal cual ("Jugando TETRA").
function statusMessage(status: PresenceStatus): string {
  return status === 'in-game' ? 'Jugando TETRA' : 'En TETRA';
}

/**
 * Firma el evento de presencia NIP-38 (kind:30315) para el estado dado. Lo ancla al
 * juego con el tag `a`=gameCoord para que Luna Negra (y cualquier cliente) derive
 * "Jugando TETRA". No publica: sólo firma (útil para testear el round-trip).
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

// Clear PRE-FIRMADO de la última presencia publicada, listo para mandarse
// SINCRÓNICAMENTE al cerrar la pestaña (`pagehide`): firmar en el unload no llega
// (la firma es async y el navegador mata la página antes), pero un `ws.send` sobre
// los sockets ya abiertos del pool suele salir. Se re-firma en cada publicación con
// `created_at` = presencia + 1 para que gane la resolución del slot replaceable
// `d:general`. Mismo patrón que el Ajedrez (presence.ts).
let preparedClear: Event | null = null;

/**
 * Firma y publica la presencia en los relays de escritura pública. Best-effort:
 * devuelve `false` si ningún relay aceptó o si el firmante falló (nunca lanza).
 */
export async function publishPresence(
  signer: LunaSigner,
  status: PresenceStatus,
): Promise<boolean> {
  try {
    const evt = await buildPresenceEvent(signer, status);
    await Promise.any(getPool().publish(PUBLIC_WRITE_RELAYS, evt));
    // Pre-firmamos el clear correspondiente a ESTA presencia. Best-effort: si el
    // firmante falla, queda el clear previo (peor caso: el TTL corto la baja solo).
    try {
      preparedClear = await signer.signEvent(
        buildPresenceClearTemplate({
          createdAt: evt.created_at + 1,
          gameCoord: TETRA_GAME_COORD,
        }),
      );
    } catch {
      // sin clear pre-firmado: el cierre cae al TTL
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Limpieza SINCRÓNICA para el cierre de pestaña (`pagehide`): encola el envío del
 * clear pre-firmado sin `await`, así "Jugando TETRA" desaparece ya al cerrar el
 * juego en vez de esperar el TTL. Best-effort total: sin clear pre-firmado (nunca
 * se publicó presencia, o el firmante no re-firmó) no hace nada.
 */
export function clearPresenceNowSync(): void {
  const evt = preparedClear;
  if (!evt) return;
  preparedClear = null;
  try {
    for (const p of getPool().publish(PUBLIC_WRITE_RELAYS, evt)) p.catch(() => {});
  } catch {
    // pool caído en pleno cierre: el TTL corto la baja solo
  }
}

/**
 * Limpia la presencia (NIP-38: content vacío + expiración inmediata). Se llama al
 * cerrar sesión para que "Jugando TETRA" desaparezca ya, sin esperar el TTL.
 * Best-effort: no lanza.
 */
export async function clearPresenceEvent(signer: LunaSigner): Promise<boolean> {
  preparedClear = null; // la sesión se cierra: el clear fresco de abajo ya la pisa
  try {
    // Con la coord anclada la tienda ve el clear al instante por su filtro #a
    // (sin ella solo "dejaba de ver" la presencia y esperaba el TTL).
    const evt = await buildPresenceClearEvent(signer, { gameCoord: TETRA_GAME_COORD });
    await Promise.any(getPool().publish(PUBLIC_WRITE_RELAYS, evt));
    return true;
  } catch {
    return false;
  }
}
