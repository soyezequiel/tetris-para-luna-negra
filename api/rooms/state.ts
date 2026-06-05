import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRoomState } from '../../src/online/roomService';
import { getRoomStore, handleApiError, queryParam, sendJson, sendMethodNotAllowed } from '../../src/online/vercelApi';

export { config } from '../../src/online/vercelApi';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res);
    return;
  }
  try {
    const room = await getRoomState(getRoomStore(), queryParam(req, 'roomId'));
    sendJson(res, 200, { room, serverNowMs: Date.now() });
  } catch (error) {
    handleApiError(res, error);
  }
}
