import { getRoomState } from '../../src/online/roomService';
import { getRoomStore, handleApiError, queryParam, sendJson } from '../../src/online/vercelApi';

export { config } from '../../src/online/vercelApi';

export async function GET(request: Request): Promise<Response> {
  try {
    const room = await getRoomState(getRoomStore(), queryParam(request, 'roomId'));
    return sendJson(200, { room, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}
