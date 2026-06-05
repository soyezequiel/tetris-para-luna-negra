import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProgressRequest } from '../../src/online/protocol';
import { updateProgress } from '../../src/online/roomService';
import { getRoomStore, handleApiError, readJsonBody, sendJson, sendMethodNotAllowed } from '../../src/online/vercelApi';

export { config } from '../../src/online/vercelApi';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res);
    return;
  }
  try {
    const room = await updateProgress(getRoomStore(), await readJsonBody<ProgressRequest>(req));
    sendJson(res, 200, { room, serverNowMs: Date.now() });
  } catch (error) {
    handleApiError(res, error);
  }
}
