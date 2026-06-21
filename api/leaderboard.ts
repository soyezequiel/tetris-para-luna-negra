import type { SubmitScoreRequest } from '../src/online/protocol.js';
import { getWinsLeaderboard, submitWin, LEADERBOARD_DEFAULT_LIMIT } from '../src/online/leaderboard.js';
import { LUNA_BOARD_WINS, mirrorLunaScore } from '../src/online/lunaNegraLeaderboard.js';
import { getLeaderboardStore, handleApiError, handleNodeApi, readJsonBody, sendJson } from '../src/online/vercelApi.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export { config } from '../src/online/vercelApi.js';

export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handleNodeApi(request, response, { GET, POST });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const entries = await getWinsLeaderboard(getLeaderboardStore(), readLimit(request));
    return sendJson(200, { entries, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const store = getLeaderboardStore();
    const meta = await submitWin(store, await readJsonBody<SubmitScoreRequest>(request));
    const entries = await getWinsLeaderboard(store);
    // Espejo a Luna Negra (§6): empujamos el TOTAL de victorias del jugador a su
    // marcador (Luna se queda el mejor → el total acumulado siempre gana). Lo
    // tomamos del ranking autoritativo recién actualizado. Best-effort, no
    // bloquea ni rompe la respuesta.
    const mine = entries.find((entry) => entry.playerId === meta.playerId);
    if (mine) void mirrorLunaScore(LUNA_BOARD_WINS, meta.npub, mine.wins);
    return sendJson(200, { entries, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}

function readLimit(request: Request): number {
  const value = new URL(request.url).searchParams.get('limit');
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : LEADERBOARD_DEFAULT_LIMIT;
}
