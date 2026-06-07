import { createHmac, timingSafeEqual } from 'node:crypto';
import { refreshRoomBet } from '../../src/online/lunaNegraBets.js';
import { normalizeRoomId } from '../../src/online/roomService.js';
import { getRoomStore, handleApiError, handleNodeApi, sendJson } from '../../src/online/vercelApi.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export { config } from '../../src/online/vercelApi.js';

export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handleNodeApi(request, response, { POST });
}

function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function roomIdFromPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const data = (payload as { data?: Record<string, unknown> }).data;
  if (!data) return null;
  const direct = typeof data.roomId === 'string' ? data.roomId : null;
  const meta = typeof data.metadata === 'object' && data.metadata !== null
    ? (data.metadata as Record<string, unknown>).roomId
    : null;
  const value = direct ?? (typeof meta === 'string' ? meta : null);
  return value ? normalizeRoomId(value) : null;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const secret = (process.env.LUNA_NEGRA_WEBHOOK_SECRET ?? '').trim();
    const rawBody = await request.text();
    if (secret) {
      const signature = request.headers.get('x-lunanegra-signature') ?? '';
      if (!verifySignature(rawBody, signature, secret)) return sendJson(401, { error: 'Invalid signature.' });
    }
    const payload = rawBody ? JSON.parse(rawBody) as { type?: string } : {};
    const type = typeof payload.type === 'string' ? payload.type : '';
    if (type.startsWith('bet.') || type.startsWith('deposit.')) {
      const roomId = roomIdFromPayload(payload);
      if (roomId) {
        try {
          await refreshRoomBet(getRoomStore(), roomId);
        } catch {
          // Best-effort: la sala puede haber expirado; igual respondemos 200.
        }
      }
    }
    return sendJson(200, { received: true });
  } catch (error) {
    return handleApiError(error);
  }
}
