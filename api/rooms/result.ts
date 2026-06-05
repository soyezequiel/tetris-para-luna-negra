import type { ResultRequest } from '../../src/online/protocol';
import { submitResult } from '../../src/online/roomService';
import { getRoomStore, handleApiError, readJsonBody, sendJson } from '../../src/online/vercelApi';

export { config } from '../../src/online/vercelApi';

export async function POST(request: Request): Promise<Response> {
  try {
    const room = await submitResult(getRoomStore(), await readJsonBody<ResultRequest>(request));
    return sendJson(200, { room, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}
