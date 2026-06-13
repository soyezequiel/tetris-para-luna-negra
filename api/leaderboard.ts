import type { SubmitScoreRequest } from '../src/online/protocol.js';
import { getWinsLeaderboard, submitWin, LEADERBOARD_DEFAULT_LIMIT } from '../src/online/leaderboard.js';
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
    await submitWin(store, await readJsonBody<SubmitScoreRequest>(request));
    const entries = await getWinsLeaderboard(store);
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
