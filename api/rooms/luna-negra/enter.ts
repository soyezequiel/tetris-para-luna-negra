import type { LunaNegraEnterRequest } from '../../../src/online/protocol.js';
import { enterLunaNegraRoom, normalizeRoomId, OnlineRoomError, type VerifiedLunaNegraInvite } from '../../../src/online/roomService.js';
import { getRoomStore, handleApiError, handleNodeApi, readJsonBody, sendJson } from '../../../src/online/vercelApi.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export { config } from '../../../src/online/vercelApi.js';

export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handleNodeApi(request, response, { POST });
}

interface LunaNegraVerifyResponse {
  valid?: boolean;
  npub?: string;
  pubkey?: string;
  gameId?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  roomId?: string;
  host?: boolean;
  hostPubkey?: string | null;
  expiresAt?: string | null;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody<LunaNegraEnterRequest>(request);
    const inviteToken = typeof body.inviteToken === 'string' ? body.inviteToken.trim() : '';
    const expectedRoomId = typeof body.roomId === 'string' ? normalizeRoomId(body.roomId) : '';
    if (!inviteToken) throw new OnlineRoomError('Missing Luna Negra invite token.', 400);
    if (!expectedRoomId) throw new OnlineRoomError('Missing Luna Negra room id.', 400);

    const verified = await verifyLunaNegraInvite(inviteToken);
    const verifiedRoomId = normalizeRoomId(verified.roomId);
    if (verifiedRoomId !== expectedRoomId) throw new OnlineRoomError('Luna Negra room mismatch.', 403);

    const { room, player } = await enterLunaNegraRoom(getRoomStore(), {
      ...verified,
      roomId: verifiedRoomId,
    });
    return sendJson(200, { room, player, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}

async function verifyLunaNegraInvite(inviteToken: string): Promise<VerifiedLunaNegraInvite> {
  const baseUrl = (process.env.LUNA_NEGRA_BASE_URL ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new OnlineRoomError('LUNA_NEGRA_BASE_URL is not configured.', 500);

  const response = await fetch(`${baseUrl}/api/v1/rooms/verify`, {
    method: 'GET',
    headers: { authorization: `Bearer ${inviteToken}` },
  });
  const payload = await response.json().catch(() => null) as LunaNegraVerifyResponse | null;
  if (!response.ok) throw new OnlineRoomError('Luna Negra verification failed.', response.status);
  if (!payload?.valid) throw new OnlineRoomError('Luna Negra invite token is invalid or expired.', 401);
  if (typeof payload.pubkey !== 'string' || payload.pubkey.trim().length === 0) {
    throw new OnlineRoomError('Luna Negra invite is missing pubkey.', 400);
  }
  if (typeof payload.npub !== 'string' || payload.npub.trim().length === 0) {
    throw new OnlineRoomError('Luna Negra invite is missing npub.', 400);
  }
  if (typeof payload.roomId !== 'string' || payload.roomId.trim().length === 0) {
    throw new OnlineRoomError('Luna Negra invite is missing room id.', 400);
  }

  return {
    npub: payload.npub,
    pubkey: payload.pubkey,
    gameId: typeof payload.gameId === 'string' ? payload.gameId : null,
    displayName: typeof payload.displayName === 'string' ? payload.displayName : null,
    avatarUrl: typeof payload.avatarUrl === 'string' ? payload.avatarUrl : null,
    roomId: payload.roomId,
    host: payload.host === true,
    hostPubkey: typeof payload.hostPubkey === 'string' ? payload.hostPubkey : null,
    expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : null,
  };
}
