import type { CreateBetRequest, RoomBetActionRequest } from '../../src/online/protocol.js';
import { cancelRoomBet, createBetForRoom, ensureWebhookRegistered, refreshRoomBet } from '../../src/online/lunaNegraBets.js';
import {
  getRoomStore,
  handleApiError,
  handleNodeApi,
  queryParam,
  readJsonBody,
  sendJson,
  sendMethodNotAllowed,
} from '../../src/online/vercelApi.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export { config } from '../../src/online/vercelApi.js';

export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handleNodeApi(request, response, { GET, POST });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const action = actionFromRequest(request);
    if (action === 'state') {
      const room = await refreshRoomBet(getRoomStore(), queryParam(request, 'roomId'));
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    return sendMethodNotAllowed();
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const action = actionFromRequest(request);
    if (action === 'create') {
      const body = await readJsonBody<CreateBetRequest>(request);
      await ensureWebhookRegistered(new URL(request.url).origin);
      const room = await createBetForRoom(getRoomStore(), {
        roomId: body.roomId,
        playerId: body.playerId,
        stakeSats: body.stakeSats,
        victoryCondition: body.victoryCondition,
      });
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'refresh') {
      const body = await readJsonBody<RoomBetActionRequest>(request);
      const room = await refreshRoomBet(getRoomStore(), body.roomId);
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'cancel') {
      const body = await readJsonBody<RoomBetActionRequest>(request);
      const room = await cancelRoomBet(getRoomStore(), body.roomId, body.playerId);
      return sendJson(200, { room, serverNowMs: Date.now() });
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
