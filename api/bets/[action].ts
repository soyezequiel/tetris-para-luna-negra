import type { CreateBetRequest, RoomBetActionRequest } from '../../src/online/protocol.js';
import {
  cancelRoomBet,
  createBetForRoom,
  ensureWebhookRegistered,
  refreshRoomBet,
  retryRoomBetInvoiceGeneration,
  settleRoomBet,
  syncBetParticipantsWithRoom,
} from '../../src/online/lunaNegraBets.js';
import { alertMoneyPathError } from '../../src/online/moneyPathAlert.js';
import {
  getBetRoomStore,
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
      const room = await refreshBetWithParticipantSync(queryParam(request, 'roomId'));
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    return sendMethodNotAllowed();
  } catch (error) {
    return handleApiError(error);
  }
}

// Acciones que mueven plata: si fallan, además del error al cliente se dispara una
// alerta a Discord (best-effort) para enterarnos en el momento. `refresh` queda afuera
// a propósito: es polleo frecuente y sus fallos suelen ser benignos (sala expirada).
const MONEY_PATH_ACTIONS = new Set(['create', 'cancel', 'retry', 'settle']);

export async function POST(request: Request): Promise<Response> {
  const action = actionFromRequest(request);
  let alertContext: Record<string, unknown> = {};
  try {
    if (action === 'create') {
      const body = await readJsonBody<CreateBetRequest>(request);
      alertContext = { roomId: body.roomId, playerId: body.playerId, stakeSats: body.stakeSats };
      await ensureWebhookRegistered(new URL(request.url).origin);
      const room = await createBetForRoom(getBetRoomStore(), {
        roomId: body.roomId,
        playerId: body.playerId,
        stakeSats: body.stakeSats,
        victoryCondition: body.victoryCondition,
      });
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'refresh') {
      const body = await readJsonBody<RoomBetActionRequest>(request);
      const room = await refreshBetWithParticipantSync(body.roomId);
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'cancel') {
      const body = await readJsonBody<RoomBetActionRequest>(request);
      alertContext = { roomId: body.roomId, playerId: body.playerId };
      const room = await cancelRoomBet(getBetRoomStore(), body.roomId, body.playerId);
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'retry') {
      const body = await readJsonBody<RoomBetActionRequest>(request);
      alertContext = { roomId: body.roomId, playerId: body.playerId };
      const room = await retryRoomBetInvoiceGeneration(getBetRoomStore(), body.roomId, body.playerId);
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'settle') {
      const body = await readJsonBody<RoomBetActionRequest>(request);
      alertContext = { roomId: body.roomId, playerId: body.playerId };
      const room = await settleRoomBet(getBetRoomStore(), body.roomId, body.playerId);
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    return sendMethodNotAllowed();
  } catch (error) {
    if (MONEY_PATH_ACTIONS.has(action)) await alertMoneyPathError(`bet:${action}`, alertContext, error);
    return handleApiError(error);
  }
}

function actionFromRequest(request: Request): string {
  const pathname = new URL(request.url).pathname;
  return pathname.split('/').filter(Boolean).at(-1) ?? '';
}

async function refreshBetWithParticipantSync(roomId: string) {
  const store = getBetRoomStore();
  await syncBetParticipantsWithRoom(store, roomId);
  return refreshRoomBet(store, roomId);
}
