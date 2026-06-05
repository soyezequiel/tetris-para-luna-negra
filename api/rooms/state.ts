import { getRoomState } from '../../src/online/roomService.js';
import { getRoomStore, handleApiError, queryParam, sendJson } from '../../src/online/vercelApi.js';

export { config } from '../../src/online/vercelApi.js';

export async function GET(request: Request): Promise<Response> {
  try {
    const room = await getRoomState(getRoomStore(), queryParam(request, 'roomId'));
    return sendJson(200, { room, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}
