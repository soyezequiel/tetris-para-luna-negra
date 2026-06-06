import { getOnlineProfileState } from '../../src/online/roomService.js';
import { getRoomStore, handleApiError, queryParam, sendJson } from '../../src/online/vercelApi.js';

export { config } from '../../src/online/vercelApi.js';

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
