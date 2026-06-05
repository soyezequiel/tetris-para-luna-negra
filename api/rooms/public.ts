import type { IncomingMessage, ServerResponse } from 'node:http';
import { listPublicRooms } from '../../src/online/roomService';
import { getRoomStore, handleApiError, sendJson, sendMethodNotAllowed } from '../../src/online/vercelApi';

export { config } from '../../src/online/vercelApi';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res);
    return;
  }
  try {
    const rooms = await listPublicRooms(getRoomStore());
    sendJson(res, 200, { rooms, serverNowMs: Date.now() });
  } catch (error) {
    handleApiError(res, error);
  }
}
