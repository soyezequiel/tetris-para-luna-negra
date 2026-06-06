import type { EnqueueMatchmakingRequest } from '../../src/online/protocol.js';
import { enqueueMatchmaking } from '../../src/online/roomService.js';
import { getRoomStore, handleApiError, readJsonBody, sendJson } from '../../src/online/vercelApi.js';

export { config } from '../../src/online/vercelApi.js';

export async function POST(request: Request): Promise<Response> {
  try {
    const { ticket, room } = await enqueueMatchmaking(getRoomStore(), await readJsonBody<EnqueueMatchmakingRequest>(request));
    return sendJson(200, { ticket, room, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}
