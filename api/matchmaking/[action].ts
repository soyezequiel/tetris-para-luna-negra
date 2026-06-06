import type { EnqueueMatchmakingRequest, LeaveMatchmakingRequest, MatchmakingHeartbeatRequest } from '../../src/online/protocol.js';
import { enqueueMatchmaking, getMatchmakingTicket, heartbeatMatchmaking, leaveMatchmaking } from '../../src/online/roomService.js';
import { getRoomStore, handleApiError, queryParam, readJsonBody, sendJson, sendMethodNotAllowed } from '../../src/online/vercelApi.js';

export { config } from '../../src/online/vercelApi.js';

export async function GET(request: Request): Promise<Response> {
  try {
    if (actionFromRequest(request) !== 'ticket') return sendMethodNotAllowed();
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

export async function POST(request: Request): Promise<Response> {
  try {
    const action = actionFromRequest(request);
    if (action === 'enqueue') {
      const { ticket, room } = await enqueueMatchmaking(getRoomStore(), await readJsonBody<EnqueueMatchmakingRequest>(request));
      return sendJson(200, { ticket, room, serverNowMs: Date.now() });
    }
    if (action === 'heartbeat') {
      const { ticket, room } = await heartbeatMatchmaking(getRoomStore(), await readJsonBody<MatchmakingHeartbeatRequest>(request));
      return sendJson(200, { ticket, room, serverNowMs: Date.now() });
    }
    if (action === 'leave') {
      const { ticket, room } = await leaveMatchmaking(getRoomStore(), await readJsonBody<LeaveMatchmakingRequest>(request));
      return sendJson(200, { ticket, room, serverNowMs: Date.now() });
    }
    return sendMethodNotAllowed();
  } catch (error) {
    return handleApiError(error);
  }
}

function actionFromRequest(request: Request): string {
  const pathname = new URL(request.url).pathname;
  return pathname.split('/').filter(Boolean).at(-1) ?? '';
}
