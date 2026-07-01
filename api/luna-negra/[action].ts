import type {
  LunaInviteRequest,
  LunaPresenceRequest,
} from '../../src/online/protocol.js';
import {
  heartbeatLunaPresence,
  listLunaFriends,
  consumeLunaLaunchRequest,
  sendLunaInvite,
} from '../../src/online/lunaNegraSocial.js';
import { OnlineRoomError, loadRoom, normalizeRoomId } from '../../src/online/roomService.js';
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
    if (action === 'friends') {
      const npub = queryParam(request, 'npub');
      if (!npub) throw new OnlineRoomError('Falta el npub.', 400);
      const { friends, source } = await listLunaFriends(npub);
      return sendJson(200, { friends, source, serverNowMs: Date.now() });
    }
    if (action === 'invite-window') {
      const gameId = queryParam(request, 'gameId')?.trim() ?? '';
      const roomId = normalizeRoomId(queryParam(request, 'roomId') ?? '');
      const playerId = queryParam(request, 'playerId')?.trim() ?? '';
      if (!gameId) throw new OnlineRoomError('Falta el gameId de Luna Negra.', 400);
      if (!roomId) throw new OnlineRoomError('Falta la sala.', 400);
      if (!playerId) throw new OnlineRoomError('Falta el jugador.', 400);
      const room = await loadRoom(getBetRoomStore(), roomId);
      if (room.hostPlayerId !== playerId) {
        throw new OnlineRoomError('Solo el host puede invitar amigos.', 403);
      }
      return sendJson(200, { url: buildInviteWindowUrl(gameId, roomId), serverNowMs: Date.now() });
    }
    if (action === 'game-info') {
      // Expone el gameId (cuid) y slug del juego —ya configurados server-side para
      // apuestas/marcadores— al cliente. Lo usa el login Nostr 2.0 para poblar
      // identity.gameId (sin él, invitar/apostar quedan gateados). No es secreto:
      // el gameId ya viajaba en la sesión SSO 1.0 y en las URLs de invitación.
      const gameId = (process.env.LUNA_NEGRA_GAME_ID ?? '').trim() || null;
      const slug = (process.env.LUNA_NEGRA_GAME_SLUG ?? '').trim() || null;
      return sendJson(200, { gameId, slug, serverNowMs: Date.now() });
    }
    if (action === 'launch-request') {
      const npub = queryParam(request, 'npub');
      if (!npub) throw new OnlineRoomError('Falta el npub.', 400);
      const { request: launchRequest, source } = await consumeLunaLaunchRequest(npub);
      return sendJson(200, { request: launchRequest, source, serverNowMs: Date.now() });
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
      const { source } = await heartbeatLunaPresence(body);
      return sendJson(200, { ok: true, source, serverNowMs: Date.now() });
    }
    if (action === 'invite') {
      const body = await readJsonBody<LunaInviteRequest>(request);
      const roomId = normalizeRoomId(body.roomId ?? '');
      if (!roomId) throw new OnlineRoomError('Falta la sala.', 400);
      if (!body.friendNpub) throw new OnlineRoomError('Falta el amigo a invitar.', 400);
      const inviteUrl = buildInviteUrl(request, roomId);
      const context = await lunaInviteContext(roomId, body.playerId);
      const { delivered, source } = await sendLunaInvite({ ...body, roomId, gameId: context.gameId }, inviteUrl, context.fromNpub);
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
async function lunaInviteContext(roomId: string, playerId: string): Promise<{ fromNpub: string | null; gameId: string | null }> {
  try {
    const room = await loadRoom(getBetRoomStore(), roomId);
    return {
      fromNpub: room.players.find((player) => player.id === playerId)?.npub ?? null,
      gameId: room.lunaGameId ?? null,
    };
  } catch {
    return { fromNpub: null, gameId: null };
  }
}

function buildInviteUrl(request: Request, roomId: string): string {
  const url = new URL(request.url);
  const origin = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '') || url.origin;
  return `${origin}/?join=${encodeURIComponent(roomId)}`;
}

function buildInviteWindowUrl(gameId: string, roomId: string): string {
  const baseUrl = (process.env.LUNA_NEGRA_BASE_URL ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new OnlineRoomError('LUNA_NEGRA_BASE_URL is not configured.', 500);
  const url = new URL('/invite-friend', baseUrl);
  url.searchParams.set('gameId', gameId);
  url.searchParams.set('roomId', roomId);
  return url.toString();
}

