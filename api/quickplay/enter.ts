import type { QuickPlayEnterRequest } from '../../src/online/protocol.js';
import { enterQuickPlay } from '../../src/online/roomService.js';
import { getRoomStore, handleApiError, readJsonBody, sendJson } from '../../src/online/vercelApi.js';

export { config } from '../../src/online/vercelApi.js';

export async function POST(request: Request): Promise<Response> {
  try {
    const { room, leaderboard } = await enterQuickPlay(getRoomStore(), await readJsonBody<QuickPlayEnterRequest>(request));
    return sendJson(200, { room, leaderboard, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}
