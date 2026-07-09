import type {
  CreateBetRequest,
  RoomBetActionRequest,
} from '../../src/online/protocol.js';
import {
  cancelRoomBet,
  createBetForRoom,
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

// NOTA DEPLOY (cache de funciones Vercel): este handler importa la lógica de
// ../../src/online/* (lunaNegraBets, etc.). El build cache de Vercel cachea la
// función por el hash de ESTE archivo entry y NO re-traza los imports locales
// transitivos: cambios en lunaNegraBets.ts (p. ej. agregar depositZapRequest al
// participante) NO rebuildean la función salvo que cambie este archivo. Si tocás la
// lógica de apuestas y no se refleja en el deploy, bumpeá `deploy-rev` de abajo (o
// seteá VERCEL_FORCE_NO_BUILD_CACHE=1 en el proyecto para desactivar el cache).
// deploy-rev: 18
//
// BET_API_REV: marcador de versión HORNEADO en el código de ESTA función. Como el build
// cache de Vercel puede servir una copia vieja de la función (sin re-trazar los imports),
// exponemos esta constante por `GET /api/bets/version` para saber, desde afuera y sin
// una sala viva, qué código está realmente corriendo. Si `version` no existe (405) o la
// `rev` es vieja → la función está cacheada vieja. Subilo cada vez que toques la lógica.
const BET_API_REV = 18;

export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handleNodeApi(request, response, { GET, POST });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const action = actionFromRequest(request);
    if (action === 'version') {
      // Diagnóstico de deploy: rev horneada + commit del deploy (Vercel) + si el reporte
      // de Discord tiene webhook configurado en ESTE entorno. No requiere sala.
      return sendJson(200, {
        rev: BET_API_REV,
        commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? 'local').slice(0, 7),
        hasBetReportWebhook: Boolean(
          (process.env.DISCORD_BET_REPORT_WEBHOOK_URL
            ?? process.env.DISCORD_ALERT_WEBHOOK_URL
            ?? process.env.DISCORD_WEBHOOK_URL
            ?? '').trim(),
        ),
        serverNowMs: Date.now(),
      });
    }
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
