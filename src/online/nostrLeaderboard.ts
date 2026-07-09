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
import { nip19, verifyEvent, type Event } from 'nostr-tools';
import type { LunaSigner } from './nostrSigner';
import { PROFILE_RELAYS, PUBLIC_WRITE_RELAYS, getPool } from './nostrRelays';
import { TETRA_GAME_COORD } from './nostrChallenge';
import {
  NGP_KIND,
  buildScoreEvent as ngpBuildScoreEvent,
  parseScoreEvent,
} from '../../sdk/ngp.js';

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

// ─────────────────────────── Lectura del marcador ───────────────────────────

// kind:31337 (evento de puntaje). Frozen en la capa protocolo (sdk/ngp-core.ts).
const SCORE_KIND = NGP_KIND.score;

// Cota de espera al leer de relays: sin `maxWait`, querySync espera el EOSE de TODOS
// los relays (un solo relay lento demora todo). Igual criterio que fetchProfiles.
const READ_MAX_WAIT_MS = 4000;

/** Una fila del ranking reconstruido desde Nostr (un récord por jugador). */
export interface NostrScoreEntry {
  /** Pubkey (hex) del jugador que firmó el puntaje. */
  pubkey: string;
  /** npub (bech32) estable, derivado de la pubkey. */
  npub: string;
  /** Mejor puntaje del jugador en esta tabla (para 'supervivencia' son ms). */
  score: number;
  /** created_at (segundos) del evento del récord; desempata a igualdad de score. */
  createdAt: number;
}

/**
 * Reconstruye el ranking de `board` LEYENDO los kind:31337 directo de relays, sin
 * pasar por Luna Negra ni por el PartyServer propio. Es la contraparte de
 * `publishScore`: cierra el marcador Nostr autónomo (el juego firma su puntaje y
 * también arma la tabla desde Nostr, así sobrevive aunque caiga cualquier servidor).
 *
 * Filtramos por `#a`=coord (los relays sólo indexan tags de UNA letra, así que
 * `#board` no sirve) y separamos la tabla en código, igual que el sync de Luna
 * (src/lib/score-sync.ts). Verificamos la firma de cada evento (anti-forja) y nos
 * quedamos con el mejor puntaje por jugador. Best-effort: ante relays caídos o datos
 * inválidos devuelve lo que haya (posiblemente `[]`), nunca lanza.
 *
 * ⚠️ Los puntajes los firma el cliente del jugador y son FALSIFICABLES: sirven para
 * mostrar rankings, nunca para repartir dinero.
 */
export async function fetchNostrLeaderboard(
  board: string,
  limit = 50,
): Promise<NostrScoreEntry[]> {
  let events: Event[];
  try {
    events = await getPool().querySync(
      PROFILE_RELAYS,
      { kinds: [SCORE_KIND], '#a': [TETRA_GAME_COORD] },
      { maxWait: READ_MAX_WAIT_MS },
    );
  } catch {
    return []; // relays caídos: el marcador es no crítico
  }
  return rankNostrScores(events, board, limit);
}

/**
 * Proyecta eventos crudos de puntaje al ranking de una tabla: descarta lo que no
 * sea un kind:31337 válido de ESTE juego y esta tabla, verifica la firma (anti-forja),
 * se queda con el mejor récord por jugador y ordena el top. Puro (sin red) para poder
 * testearlo; `fetchNostrLeaderboard` le pasa lo que devuelven los relays.
 *
 * Keep-best por jugador: mayor score; a igualdad, el récord más viejo (llegó primero).
 * Nota: kind:31337 es addressable (un evento por jugador/tabla), pero distintos relays
 * pueden servir versiones distintas del mismo `d`; por eso deduplicamos por pubkey.
 */
export function rankNostrScores(
  events: Event[],
  board: string,
  limit = 50,
): NostrScoreEntry[] {
  const best = new Map<string, NostrScoreEntry>();
  for (const ev of events) {
    const parsed = parseScoreEvent(ev);
    if (!parsed) continue;
    if (parsed.gameCoord !== TETRA_GAME_COORD) continue;
    if ((parsed.board ?? 'clasico') !== board) continue;
    const score = parsed.score;
    if (!Number.isFinite(score) || score < 0) continue;
    if (!verifyEvent(ev)) continue; // la firma tiene que cerrar con la pubkey
    const prev = best.get(ev.pubkey);
    if (
      !prev ||
      score > prev.score ||
      (score === prev.score && ev.created_at < prev.createdAt)
    ) {
      best.set(ev.pubkey, {
        pubkey: ev.pubkey,
        npub: nip19.npubEncode(ev.pubkey),
        score,
        createdAt: ev.created_at,
      });
    }
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.createdAt - b.createdAt)
    .slice(0, Math.max(1, limit));
}
