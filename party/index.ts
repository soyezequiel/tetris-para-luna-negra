import { routePartykitRequest, getServerByName } from 'partyserver';
import { normalizeRoomId, OnlineRoomError } from '../src/online/roomService.js';
import type { OnlineRoom } from '../src/online/protocol.js';
import type { Env } from './env.js';

// Los Durable Objects deben exportarse desde el módulo main del Worker.
export { RoomServer } from './room.js';
export { LobbyServer } from './lobby.js';

const ROOM_BRIDGE_PREFIX = '/__bridge/rooms/';

/**
 * Entrypoint del Worker. `routePartykitRequest` mantiene el esquema de URL
 * `/parties/:party/:name` (el mismo que usa `partysocket` en el cliente), mapeando
 * el segmento `:party` al binding por kebab-case: `Main`→`main`, `Lobby`→`lobby`.
 * Así el cliente conecta igual que con PartyKit, sin cambios.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const bridge = await handleRoomBridgeRequest(request, env);
    if (bridge) return bridge;
    return (await routePartykitRequest(request, env as never)) ?? new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleRoomBridgeRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(ROOM_BRIDGE_PREFIX)) return null;

  try {
    authorizeBridgeRequest(request, env);
    const roomId = normalizeRoomId(decodeURIComponent(url.pathname.slice(ROOM_BRIDGE_PREFIX.length).split('/')[0] ?? ''));
    if (!roomId) throw new OnlineRoomError('Missing room id.', 400);
    // getServerByName (no env.Main.getByName a secas): los métodos RPC definidos por
    // el usuario NO disparan onStart(), y onStart() es donde RoomServer rehidrata la
    // sala desde el storage durable a su MemoryRoomStore. Con el stub crudo, una
    // instancia fría/hibernada respondería el bridge con la sala vacía (room=null) y
    // la apuesta nunca se crearía. getServerByName espera a onStart() antes de devolver.
    const room = await getServerByName(env.Main, roomId);

    if (request.method === 'GET') {
      return sendBridgeJson(200, { room: await room.bridgeGetRoom() });
    }
    if (request.method === 'PUT') {
      const body = await request.json() as { room?: OnlineRoom };
      if (!body.room) throw new OnlineRoomError('Missing room payload.', 400);
      return sendBridgeJson(200, { room: await room.bridgeSaveRoom(body.room) });
    }
    return sendBridgeJson(405, { error: 'Method not allowed.' });
  } catch (error) {
    const status = error instanceof OnlineRoomError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Unexpected bridge error.';
    return sendBridgeJson(status, { error: message });
  }
}

function authorizeBridgeRequest(request: Request, env: Env): void {
  const token = env.PARTY_BRIDGE_TOKEN?.trim();
  if (!token) throw new OnlineRoomError('Room bridge is not configured.', 503);
  if (request.headers.get('authorization') !== `Bearer ${token}`) {
    throw new OnlineRoomError('Unauthorized room bridge request.', 401);
  }
}

function sendBridgeJson(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}
