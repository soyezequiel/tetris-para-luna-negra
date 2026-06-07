import type {
  AttackRequest,
  CreateRoomRequest,
  EliminateRequest,
  JoinRoomRequest,
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
} from '../../src/online/protocol.js';
import {
  addAttack,
  addPeerSignal,
  createRoom,
  eliminatePlayer,
  getRoomState,
  joinRoom,
  listPublicRooms,
  restartRoom,
  setPlayerReady,
  setPlayerTargeting,
  startRoom,
  submitResult,
  updateProgress,
} from '../../src/online/roomService.js';
import { maybeReportRoomBetResult } from '../../src/online/lunaNegraBets.js';
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
      const room = await joinRoom(getRoomStore(), await readJsonBody<JoinRoomRequest>(request));
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
    ranked: readBoolean(params.get('ranked')),
    customPreset: readString(params.get('customPreset')),
    minPlayers: readInteger(params.get('minPlayers')),
    maxPlayers: readInteger(params.get('maxPlayers')),
  };
}

function readMatchType(value: string | null): OnlineMatchType | undefined {
  if (
    value === 'battle'
    || value === 'duel'
    || value === 'league'
    || value === 'royale'
    || value === 'quickPlay'
    || value === 'custom'
    || value === 'sprintRace'
  ) return value;
  return undefined;
}

function readStatus(value: string | null): OnlineRoomStatus | undefined {
  if (value === 'lobby' || value === 'countdown' || value === 'playing' || value === 'finished') return value;
  return undefined;
}

function readBoolean(value: string | null): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
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
