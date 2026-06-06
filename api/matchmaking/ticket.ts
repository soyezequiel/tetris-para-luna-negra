import { getMatchmakingTicket } from '../../src/online/roomService.js';
import { getRoomStore, handleApiError, queryParam, sendJson } from '../../src/online/vercelApi.js';

export { config } from '../../src/online/vercelApi.js';

export async function GET(request: Request): Promise<Response> {
  try {
    const { ticket, room } = await getMatchmakingTicket(
      getRoomStore(),
      queryParam(request, 'ticketId'),
      queryParam(request, 'playerId'),
    );
    return sendJson(200, { ticket, room, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}
