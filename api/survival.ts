import type { SubmitSurvivalRequest } from '../src/online/protocol.js';
import { getSurvivalLeaderboard, submitSurvival, SURVIVAL_DEFAULT_LIMIT } from '../src/online/survivalLeaderboard.js';
import { getSurvivalLeaderboardStore, handleApiError, handleNodeApi, readJsonBody, sendJson } from '../src/online/vercelApi.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export { config } from '../src/online/vercelApi.js';

export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handleNodeApi(request, response, { GET, POST });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const entries = await getSurvivalLeaderboard(getSurvivalLeaderboardStore(), readLimit(request));
    return sendJson(200, { entries, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const store = getSurvivalLeaderboardStore();
    await submitSurvival(store, await readJsonBody<SubmitSurvivalRequest>(request));
    const entries = await getSurvivalLeaderboard(store);
    return sendJson(200, { entries, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}

function readLimit(request: Request): number {
  const value = new URL(request.url).searchParams.get('limit');
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : SURVIVAL_DEFAULT_LIMIT;
}
