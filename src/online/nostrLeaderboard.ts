// Marcador Nostr 2.0 (kind:31337, evento de puntaje addressable). A diferencia del
// marcador 1.0 (REST → POST /api/v1/leaderboards/{name}/scores, donde el ranking lo
// custodia Luna Negra), acá el PROPIO jugador firma su mejor puntaje y lo publica a
// los relays. Ventaja: el marcador vive en Nostr, lo lee cualquier cliente y
// sobrevive aunque Luna Negra caiga; el juego no llama a ninguna API para esto. Luna
// Negra lo recoge sola (un sync lo proyecta al MISMO ranking que el camino REST). Ver
// la skill `integrar-luna-negra` §6 → Camino Nostr (2.0).
//
// El evento es addressable/replaceable (kind 30000-39999): el `d`=`<coord>:<board>`
// hace que cada jugador tenga UN récord por tabla, que se auto-reemplaza cuando
// mejora. No lleva `expiration`: un récord no caduca (a diferencia de la presencia).
//
// ⚠️ El puntaje lo firma el cliente del jugador y es FALSIFICABLE: sirve para MOSTRAR
// rankings, nunca para repartir dinero (el resultado de una apuesta viene del game
// server por /bets/{id}/result). Ver Reglas de oro de la skill.
// PUERTO del marcador — el formato del evento (kind:31337, validación de board y
// clamp del puntaje) vive en la capa protocolo (`sdk/ngp.ts`); acá quedan los
// nombres de tabla del juego, la coordenada y los relays.
import type { Event } from 'nostr-tools';
import type { LunaSigner } from './nostrSigner';
import { PUBLIC_WRITE_RELAYS, getPool } from './nostrRelays';
import { TETRA_GAME_COORD } from './nostrChallenge';
import { buildScoreEvent as ngpBuildScoreEvent } from '../../sdk/ngp.js';

// Nombres de tabla: DEBEN coincidir con los del camino REST (lunaNegraLeaderboard.ts)
// para que ambos alimenten el mismo ranking. `victorias` = victorias multijugador,
// `supervivencia` = mejor tiempo (ms) en modo Supervivencia.
export const NOSTR_BOARD_WINS = 'victorias';
export const NOSTR_BOARD_SURVIVAL = 'supervivencia';

/**
 * Firma el evento de puntaje Nostr (kind:31337) para `board`. Lo ancla al juego con
 * `a`=gameCoord y usa `d`=`<coord>:<board>` para que sea el único récord del jugador
 * en esa tabla (se auto-reemplaza al mejorar). No publica: sólo firma (útil para
 * testear el round-trip). Lanza si el board o el puntaje son inválidos.
 */
export async function buildScoreEvent(
  signer: LunaSigner,
  board: string,
  score: number,
): Promise<Event> {
  return ngpBuildScoreEvent(signer, {
    gameCoord: TETRA_GAME_COORD,
    board,
    score,
    client: 'tetra',
  });
}

/**
 * Firma y publica el mejor puntaje del jugador en `board`. Best-effort: devuelve
 * `false` si ningún relay aceptó, si el firmante falló o si los datos eran inválidos
 * (nunca lanza).
 */
export async function publishScore(
  signer: LunaSigner,
  board: string,
  score: number,
): Promise<boolean> {
  try {
    const evt = await buildScoreEvent(signer, board, score);
    await Promise.any(getPool().publish(PUBLIC_WRITE_RELAYS, evt));
    return true;
  } catch {
    return false;
  }
}
