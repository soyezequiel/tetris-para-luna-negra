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
import type { Event } from 'nostr-tools';
import type { LunaSigner } from './nostrSigner';
import { PUBLIC_WRITE_RELAYS, getPool } from './nostrRelays';
import { TETRA_GAME_COORD } from './nostrChallenge';

// kind:31337 = evento de puntaje propuesto por la 2.0 (addressable).
const LEADERBOARD_KIND = 31337;

// Nombres de tabla: DEBEN coincidir con los del camino REST (lunaNegraLeaderboard.ts)
// para que ambos alimenten el mismo ranking. `victorias` = victorias multijugador,
// `supervivencia` = mejor tiempo (ms) en modo Supervivencia.
export const NOSTR_BOARD_WINS = 'victorias';
export const NOSTR_BOARD_SURVIVAL = 'supervivencia';

// Tope que acepta Luna Negra para el puntaje (entero 0…1e9). El tiempo de
// supervivencia en ms solo lo superaría tras ~11 días de una sola partida; igual
// clampeamos por las dudas.
const MAX_SCORE = 1_000_000_000;

// Nombre de tabla válido según la spec: ^[a-z0-9][a-z0-9_-]{0,63}$ (no empieza con
// `_`/`-`). Lo validamos acá para no publicar un `d`-tag que Luna Negra descarte.
const BOARD_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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
  if (!BOARD_RE.test(board)) {
    throw new Error(`Nombre de tabla inválido: ${board}`);
  }
  const value = Math.floor(score);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Puntaje inválido: ${score}`);
  }
  const clamped = Math.min(value, MAX_SCORE);
  return signer.signEvent({
    kind: LEADERBOARD_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['a', TETRA_GAME_COORD], // ancla al juego (30023:<tienda>:<slug>)
      ['d', `${TETRA_GAME_COORD}:${board}`], // 1 récord por jugador y tabla
      ['board', board],
      ['score', String(clamped)],
      ['client', 'tetra'],
    ],
    content: '',
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
