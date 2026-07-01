// Presencia Nostr 2.0 (NIP-38, kind:30315 "User Statuses"). A diferencia de la
// presencia 1.0 (REST → POST /api/v1/presence, la firma Luna Negra), acá el PROPIO
// jugador firma su estado "Jugando TETRA" y lo publica a los relays. Ventaja: la
// presencia vive en Nostr, la lee cualquier cliente y sobrevive aunque Luna Negra
// caiga; el juego no depende de la API para esto. Ver la skill `integrar-luna-negra`
// (interfaz 2.0 · Presencia NIP-38).
//
// El evento es addressable/replaceable (kind 30000-39999) con `d`="general": cada
// jugador tiene UN estado que se auto-reemplaza. Un `expiration` tag lo hace caducar
// solo si dejamos de latir (igual que el TTL de la presencia REST), así "Jugando"
// desaparece cuando el jugador cierra o cambia de app.
import type { Event } from 'nostr-tools';
import type { LunaSigner } from './nostrSigner';
import { PUBLIC_WRITE_RELAYS, getPool } from './nostrRelays';
import { TETRA_GAME_COORD } from './nostrChallenge';

// kind:30315 = live status NIP-38. `d`="general" es el estado de actividad (el otro
// valor reservado por la NIP es "music", que no usamos).
const PRESENCE_KIND = 30315;
const PRESENCE_D_TAG = 'general';

// Vida del estado sin re-latir. El heartbeat re-publica antes de que expire; si el
// jugador se va (cierra/minimiza/logout) dejamos de latir y a los ~4 min Nostr lo
// deja de mostrar como jugando. Más largo que el TTL REST (20s) a propósito: cada
// re-publicación es una FIRMA (y con un bunker NIP-46, puede ser un prompt), así que
// espaciamos los latidos para no molestar. El logout limpia de inmediato (ver
// clearPresenceEvent).
export const PRESENCE_TTL_SEC = 240;

export type PresenceStatus = 'in-game' | 'online';

function statusMessage(status: PresenceStatus): string {
  return status === 'in-game' ? 'Jugando TETRA 🎮' : 'En TETRA 🕹️';
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
  const nowSec = Math.floor(Date.now() / 1000);
  return signer.signEvent({
    kind: PRESENCE_KIND,
    created_at: nowSec,
    tags: [
      ['d', PRESENCE_D_TAG],
      ['a', TETRA_GAME_COORD],
      ['expiration', String(nowSec + PRESENCE_TTL_SEC)],
    ],
    content: statusMessage(status),
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
    const nowSec = Math.floor(Date.now() / 1000);
    const evt = await signer.signEvent({
      kind: PRESENCE_KIND,
      created_at: nowSec,
      tags: [
        ['d', PRESENCE_D_TAG],
        ['expiration', String(nowSec + 1)],
      ],
      content: '',
    });
    await Promise.any(getPool().publish(PUBLIC_WRITE_RELAYS, evt));
    return true;
  } catch {
    return false;
  }
}
