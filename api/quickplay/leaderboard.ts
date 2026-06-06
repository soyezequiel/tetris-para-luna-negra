import { getQuickPlayLeaderboard } from '../../src/online/roomService.js';
import { getRoomStore, handleApiError, queryParam, sendJson } from '../../src/online/vercelApi.js';

export { config } from '../../src/online/vercelApi.js';

export async function GET(request: Request): Promise<Response> {
  try {
    const weekId = queryParam(request, 'weekId') || undefined;
    const entries = await getQuickPlayLeaderboard(getRoomStore(), weekId);
    return sendJson(200, { weekId: entries[0]?.weekId ?? weekId ?? '', entries, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}
