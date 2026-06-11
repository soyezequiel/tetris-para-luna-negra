import type {
  AttackRequest,
  CreateRoomRequest,
  EliminateRequest,
  JoinRoomRequest,
  KickPlayerRequest,
  LeaveRoomRequest,
  OnlineMatchType,
  OnlineRoomStatus,
  PeerSignalRequest,
  ProgressRequest,
  PublicRoomsFilters,
  ReadyRequest,
  RestartRoomRequest,
  ResultRequest,
  SetTargetingRequest,
  StartRoomRequest,
  UpdateRoomSettingsRequest,
} from '../../src/online/protocol.js';
import {
  addAttack,
  addPeerSignal,
  createRoom,
  eliminatePlayer,
  getRoomState,
  joinRoom,
  kickPlayer,
  leaveRoom,
  listPublicRooms,
  reopenRoom,
  restartRoom,
  setPlayerReady,
  setPlayerTargeting,
  startRoom,
  submitResult,
  updateRoomSettings,
  updateProgress,
} from '../../src/online/roomService.js';
import { maybeReportRoomBetResult, syncBetParticipantsWithRoom } from '../../src/online/lunaNegraBets.js';
import { getRoomStore, handleApiError, handleNodeApi, queryParam, readJsonBody, sendJson, sendMethodNotAllowed } from '../../src/online/vercelApi.js';
import type { OnlineRoom } from '../../src/online/protocol.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export { config } from '../../src/online/vercelApi.js';

export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handleNodeApi(request, response, { GET, POST });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const action = actionFromRequest(request);
    if (action === 'public') {
      const rooms = await listPublicRooms(getRoomStore(), Date.now(), filtersFromRequest(request));
      return sendJson(200, { rooms, serverNowMs: Date.now() });
    }
    if (action === 'state') {
      const room = await getRoomState(getRoomStore(), queryParam(request, 'roomId'));
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
    if (action === 'attack') {
      const room = await addAttack(getRoomStore(), await readJsonBody<AttackRequest>(request));
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'create') {
      const room = await createRoom(getRoomStore(), await readJsonBody<CreateRoomRequest>(request));
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'eliminate') {
      const room = await settleBetIfFinished(await eliminatePlayer(getRoomStore(), await readJsonBody<EliminateRequest>(request)));
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'join') {
      const joined = await joinRoom(getRoomStore(), await readJsonBody<JoinRoomRequest>(request));
      // El que entra después de creada la apuesta también participa: si todavía
      // no hubo depósitos, la apuesta se recrea incluyéndolo.
      const room = await syncBetParticipants(joined);
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'leave') {
      const { room: rawRoom, hostMigratedTo } = await leaveRoom(getRoomStore(), await readJsonBody<LeaveRoomRequest>(request));
      const room = rawRoom ? await syncBetParticipants(await settleBetIfFinished(rawRoom)) : null;
      return sendJson(200, { room, hostMigratedTo, serverNowMs: Date.now() });
    }
    if (action === 'kick') {
      const room = await syncBetParticipants(await kickPlayer(getRoomStore(), await readJsonBody<KickPlayerRequest>(request)));
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'progress') {
      const room = await updateProgress(getRoomStore(), await readJsonBody<ProgressRequest>(request));
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'ready') {
      const room = await setPlayerReady(getRoomStore(), await readJsonBody<ReadyRequest>(request));
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'result') {
      const room = await settleBetIfFinished(await submitResult(getRoomStore(), await readJsonBody<ResultRequest>(request)));
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'restart') {
      const room = await restartRoom(getRoomStore(), await readJsonBody<RestartRoomRequest>(request));
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'reopen') {
      const room = await reopenRoom(getRoomStore(), await readJsonBody<RestartRoomRequest>(request));
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'settings') {
      const room = await updateRoomSettings(getRoomStore(), await readJsonBody<UpdateRoomSettingsRequest>(request));
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'signal') {
      const room = await addPeerSignal(getRoomStore(), await readJsonBody<PeerSignalRequest>(request));
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'start') {
      const room = await startRoom(getRoomStore(), await readJsonBody<StartRoomRequest>(request));
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    if (action === 'targeting') {
      const room = await setPlayerTargeting(getRoomStore(), await readJsonBody<SetTargetingRequest>(request));
      return sendJson(200, { room, serverNowMs: Date.now() });
    }
    return sendMethodNotAllowed();
  } catch (error) {
    return handleApiError(error);
  }
}

async function syncBetParticipants(room: OnlineRoom): Promise<OnlineRoom> {
  if (!room.bet || room.bet.status !== 'pending_deposits' || room.status !== 'lobby') return room;
  try {
    return await syncBetParticipantsWithRoom(getRoomStore(), room.id);
  } catch {
    return room;
  }
}

async function settleBetIfFinished(room: OnlineRoom): Promise<OnlineRoom> {
  if (room.status !== 'finished' || !room.bet || room.bet.resultReported || room.bet.status !== 'funded') return room;
  try {
    return (await maybeReportRoomBetResult(getRoomStore(), room)) ?? room;
  } catch {
    return room;
  }
}

function actionFromRequest(request: Request): string {
  const pathname = new URL(request.url).pathname;
  return pathname.split('/').filter(Boolean).at(-1) ?? '';
}

function filtersFromRequest(request: Request): PublicRoomsFilters {
  const params = new URL(request.url).searchParams;
  return {
    matchType: readMatchType(params.get('matchType')),
    status: readStatus(params.get('status')),
    region: readString(params.get('region')),
    customPreset: readString(params.get('customPreset')),
    minPlayers: readInteger(params.get('minPlayers')),
    maxPlayers: readInteger(params.get('maxPlayers')),
  };
}

function readMatchType(value: string | null): OnlineMatchType | undefined {
  if (value === 'custom') return value;
  return undefined;
}

function readStatus(value: string | null): OnlineRoomStatus | undefined {
  if (value === 'lobby' || value === 'countdown' || value === 'playing' || value === 'finished') return value;
  return undefined;
}

function readInteger(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : undefined;
}

function readString(value: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
