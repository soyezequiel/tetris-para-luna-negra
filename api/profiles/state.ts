import { getOnlineProfileState } from '../../src/online/roomService.js';
import { getRoomStore, handleApiError, handleNodeApi, queryParam, sendJson } from '../../src/online/vercelApi.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export { config } from '../../src/online/vercelApi.js';

export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handleNodeApi(request, response, { GET });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { profile, recentResults } = await getOnlineProfileState(
      getRoomStore(),
      queryParam(request, 'playerId'),
      queryParam(request, 'name'),
    );
    return sendJson(200, { profile, recentResults, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}
