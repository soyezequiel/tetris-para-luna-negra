import type {
  LunaInviteRequest,
  LunaPresenceRequest,
} from '../../src/online/protocol.js';
import {
  heartbeatLunaPresence,
  listLunaFriends,
  resolveLunaSession,
  sendLunaInvite,
} from '../../src/online/lunaNegraSocial.js';
import { OnlineRoomError, loadRoom, normalizeRoomId } from '../../src/online/roomService.js';
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
    if (action === 'session') {
      const token = queryParam(request, 'token');
      if (!token) throw new OnlineRoomError('Falta el token de sesión de Luna Negra.', 400);
      const { identity, source } = await resolveLunaSession(token);
      return sendJson(200, { identity, source, serverNowMs: Date.now() });
    }
    if (action === 'friends') {
      const npub = queryParam(request, 'npub');
      if (!npub) throw new OnlineRoomError('Falta el npub.', 400);
      const { friends, source } = await listLunaFriends(getRoomStore(), npub);
      return sendJson(200, { friends, source, serverNowMs: Date.now() });
    }
    return sendMethodNotAllowed();
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const action = actionFromRequest(request);
    if (action === 'presence') {
      const body = await readJsonBody<LunaPresenceRequest>(request);
      const { source } = await heartbeatLunaPresence(getRoomStore(), body);
      return sendJson(200, { ok: true, source, serverNowMs: Date.now() });
    }
    if (action === 'invite') {
      const body = await readJsonBody<LunaInviteRequest>(request);
      const roomId = normalizeRoomId(body.roomId ?? '');
      if (!roomId) throw new OnlineRoomError('Falta la sala.', 400);
      if (!body.friendNpub) throw new OnlineRoomError('Falta el amigo a invitar.', 400);
      const inviteUrl = buildInviteUrl(request, roomId);
      const fromNpub = await inviterNpub(roomId, body.playerId);
      const { delivered, source } = await sendLunaInvite({ ...body, roomId }, inviteUrl, fromNpub);
      return sendJson(200, { ok: true, delivered, inviteUrl, source, serverNowMs: Date.now() });
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

// npub del jugador que invita (para el toast "X te invitó" de Luna Negra).
async function inviterNpub(roomId: string, playerId: string): Promise<string | null> {
  try {
    const room = await loadRoom(getRoomStore(), roomId);
    return room.players.find((player) => player.id === playerId)?.npub ?? null;
  } catch {
    return null;
  }
}

function buildInviteUrl(request: Request, roomId: string): string {
  const url = new URL(request.url);
  const origin = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '') || url.origin;
  return `${origin}/?join=${encodeURIComponent(roomId)}`;
}
