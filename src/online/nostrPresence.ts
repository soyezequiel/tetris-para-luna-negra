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

// Vida del estado sin re-latir = TIEMPO MÁXIMO que la tienda te sigue mostrando
// "Jugando TETRA" tras cerrar/soltar el juego. El heartbeat re-publica antes de que
// expire mientras la pestaña está visible; al cerrar/minimizar/cambiar de app
// dejamos de latir (isPlayerActivelyPresent) y el evento caduca solo. Bajado de 240s
// a 60s para que "deje de jugar" se note rápido: antes colgaba ~4 min. Debe ser
// cómodamente mayor que NOSTR_PRESENCE_REPUBLISH_MS para no titilar mientras jugás.
// Cada re-publicación es una FIRMA (con bunker NIP-46 puede promptar), pero el
// throttle persistido evita re-firmar al abrir si el último evento sigue fresco.
// El logout limpia de inmediato (ver clearPresenceEvent).
export const PRESENCE_TTL_SEC = 60;

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
    return true;
  } catch {
    return false;
  }
}

/**
 * Limpia la presencia (NIP-38: content vacío + expiración inmediata). Se llama al
 * cerrar sesión para que "Jugando TETRA" desaparezca ya, sin esperar el TTL.
 * Best-effort: no lanza.
 */
export async function clearPresenceEvent(signer: LunaSigner): Promise<boolean> {
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
