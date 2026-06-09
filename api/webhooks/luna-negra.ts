import { createHmac, timingSafeEqual } from 'node:crypto';
import { getWebhookSecret, refreshRoomBet } from '../../src/online/lunaNegraBets.js';
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
  const p = payload as Record<string, unknown>;
  const directRoot = typeof p.roomId === 'string' ? p.roomId : null;
  const metaRoot = typeof p.metadata === 'object' && p.metadata !== null
    ? (p.metadata as Record<string, unknown>).roomId
    : null;

  const data = typeof p.data === 'object' && p.data !== null ? p.data as Record<string, unknown> : null;
  const directData = data && typeof data.roomId === 'string' ? data.roomId : null;
  const metaData = data && typeof data.metadata === 'object' && data.metadata !== null
    ? (data.metadata as Record<string, unknown>).roomId
    : null;

  const value = directRoot ?? (typeof metaRoot === 'string' ? metaRoot : null) ?? directData ?? (typeof metaData === 'string' ? metaData : null);
  return value ? normalizeRoomId(value) : null;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const rawBody = await request.text();
    const secret = await getWebhookSecret();
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
          const store = getRoomStore();
          // Actualización optimista: Luna Negra puede cachear sus endpoints GET por ~3 minutos.
          // Usamos el payload del webhook para destrabar la UI inmediatamente.
          if (typeof (payload as any).data === 'object' && (payload as any).data !== null) {
            const data = (payload as any).data as Record<string, any>;
            const { loadRoom, setRoomBet } = await import('../../src/online/roomService.js');
            const room = await loadRoom(store, roomId);
            if (room.bet) {
              const bet = { ...room.bet };
              const npub = typeof data.npub === 'string' ? data.npub : null;
              
              if ((type === 'deposit.paid' || type === 'deposit.completed' || type === 'deposit.settled') && npub) {
                bet.participants = bet.participants.map((p) => 
                  p.npub === npub ? { ...p, depositStatus: 'paid' } : p
                );
                bet.depositsReceived = bet.participants.filter((p) => p.depositStatus === 'paid').length;
                if (bet.depositsReceived >= bet.depositsTotal) bet.status = 'funded';
              } else if (type === 'bet.funded') {
                bet.status = 'funded';
              } else if (type === 'bet.settled' || type === 'bet.resolved') {
                bet.status = 'settled';
              }
              
              await setRoomBet(store, roomId, bet, Date.now());
            }
          }
          // Igual intentamos el refresh completo por si la API ya está fresca.
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
