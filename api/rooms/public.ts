import { listPublicRooms } from '../../src/online/roomService.js';
import { getRoomStore, handleApiError, sendJson } from '../../src/online/vercelApi.js';

export { config } from '../../src/online/vercelApi.js';

export async function GET(): Promise<Response> {
  try {
    const rooms = await listPublicRooms(getRoomStore());
    return sendJson(200, { rooms, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}
