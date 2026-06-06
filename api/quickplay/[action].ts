import type { QuickPlayEnterRequest } from '../../src/online/protocol.js';
import { enterQuickPlay, getQuickPlayLeaderboard } from '../../src/online/roomService.js';
import { getRoomStore, handleApiError, queryParam, readJsonBody, sendJson, sendMethodNotAllowed } from '../../src/online/vercelApi.js';

export { config } from '../../src/online/vercelApi.js';

export async function GET(request: Request): Promise<Response> {
  try {
    if (actionFromRequest(request) !== 'leaderboard') return sendMethodNotAllowed();
    const weekId = queryParam(request, 'weekId') || undefined;
    const entries = await getQuickPlayLeaderboard(getRoomStore(), weekId);
    return sendJson(200, { weekId: entries[0]?.weekId ?? weekId ?? '', entries, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (actionFromRequest(request) !== 'enter') return sendMethodNotAllowed();
    const { room, leaderboard } = await enterQuickPlay(getRoomStore(), await readJsonBody<QuickPlayEnterRequest>(request));
    return sendJson(200, { room, leaderboard, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}

function actionFromRequest(request: Request): string {
  const pathname = new URL(request.url).pathname;
  return pathname.split('/').filter(Boolean).at(-1) ?? '';
}
