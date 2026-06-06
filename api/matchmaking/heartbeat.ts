import type { MatchmakingHeartbeatRequest } from '../../src/online/protocol.js';
import { heartbeatMatchmaking } from '../../src/online/roomService.js';
import { getRoomStore, handleApiError, readJsonBody, sendJson } from '../../src/online/vercelApi.js';

export { config } from '../../src/online/vercelApi.js';

export async function POST(request: Request): Promise<Response> {
  try {
    const { ticket, room } = await heartbeatMatchmaking(getRoomStore(), await readJsonBody<MatchmakingHeartbeatRequest>(request));
    return sendJson(200, { ticket, room, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}
