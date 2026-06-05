import type { ResultRequest } from '../../src/online/protocol.js';
import { submitResult } from '../../src/online/roomService.js';
import { getRoomStore, handleApiError, readJsonBody, sendJson } from '../../src/online/vercelApi.js';

export { config } from '../../src/online/vercelApi.js';

export async function POST(request: Request): Promise<Response> {
  try {
    const room = await submitResult(getRoomStore(), await readJsonBody<ResultRequest>(request));
    return sendJson(200, { room, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}
