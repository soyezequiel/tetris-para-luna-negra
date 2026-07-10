import { consumeLunaLaunchRequest } from '../../src/online/lunaNegraSocial.js';
import { verifyRoomInvite } from '../../src/online/lunaNegraRoomInvite.js';
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
    if (action === 'verify-room-invite') {
      // Verifica offline (JWKS de Luna) el `lnInvite` de una invitación dirigida a
      // una sala de ESTE juego ("Luna Room Link"). No requiere API key: el token
      // es autocontenido y solo autoriza entrada a sala (no toca dinero).
      const body = await readJsonBody<{ lnInvite?: string }>(request);
      const token = typeof body.lnInvite === 'string' ? body.lnInvite.trim() : '';
      if (!token) throw new OnlineRoomError('Falta el lnInvite.', 400);
      if (!(process.env.LUNA_NEGRA_BASE_URL ?? '').trim()) {
        throw new OnlineRoomError('LUNA_NEGRA_BASE_URL is not configured.', 500);
      }
      const invite = await verifyRoomInvite(token);
      return sendJson(200, { invite, serverNowMs: Date.now() });
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

function buildInviteWindowUrl(gameId: string, roomId: string): string {
  const baseUrl = (process.env.LUNA_NEGRA_BASE_URL ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new OnlineRoomError('LUNA_NEGRA_BASE_URL is not configured.', 500);
  const url = new URL('/invite-friend', baseUrl);
  url.searchParams.set('gameId', gameId);
  url.searchParams.set('roomId', roomId);
  return url.toString();
}

