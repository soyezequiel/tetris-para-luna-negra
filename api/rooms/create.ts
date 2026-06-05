import type { CreateRoomRequest } from '../../src/online/protocol';
import { createRoom } from '../../src/online/roomService';
import { getRoomStore, handleApiError, readJsonBody, sendJson } from '../../src/online/vercelApi';

export { config } from '../../src/online/vercelApi';

export async function POST(request: Request): Promise<Response> {
  try {
    const room = await createRoom(getRoomStore(), await readJsonBody<CreateRoomRequest>(request));
    return sendJson(200, { room, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}
