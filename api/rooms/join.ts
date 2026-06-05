import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JoinRoomRequest } from '../../src/online/protocol';
import { joinRoom } from '../../src/online/roomService';
import { getRoomStore, handleApiError, readJsonBody, sendJson, sendMethodNotAllowed } from '../../src/online/vercelApi';

export { config } from '../../src/online/vercelApi';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res);
    return;
  }
  try {
    const room = await joinRoom(getRoomStore(), await readJsonBody<JoinRoomRequest>(req));
    sendJson(res, 200, { room, serverNowMs: Date.now() });
  } catch (error) {
    handleApiError(res, error);
  }
}
