import { routePartykitRequest, getServerByName } from 'partyserver';
import { normalizeRoomId, OnlineRoomError } from '../src/online/roomService.js';
import { LEADERBOARD_DEFAULT_LIMIT, type LeaderboardWinMeta } from '../src/online/leaderboard.js';
import { SURVIVAL_DEFAULT_LIMIT, type SurvivalTimeMeta } from '../src/online/survivalLeaderboard.js';
import type { OnlineRoom } from '../src/online/protocol.js';
import { LEADERBOARD_PARTY_ID } from './leaderboard.js';
import { SURVIVAL_PARTY_ID } from './survivalLeaderboard.js';
import type { Env } from './env.js';

// Los Durable Objects deben exportarse desde el módulo main del Worker.
export { RoomServer } from './room.js';
export { LobbyServer } from './lobby.js';
export { LeaderboardServer } from './leaderboard.js';
export { SurvivalLeaderboardServer } from './survivalLeaderboard.js';

const ROOM_BRIDGE_PREFIX = '/__bridge/rooms/';
const LEADERBOARD_BRIDGE_PATH = '/__bridge/leaderboard';
const SURVIVAL_BRIDGE_PATH = '/__bridge/survival';

/**
 * Entrypoint del Worker. `routePartykitRequest` mantiene el esquema de URL
 * `/parties/:party/:name` (el mismo que usa `partysocket` en el cliente), mapeando
 * el segmento `:party` al binding por kebab-case: `Main`→`main`, `Lobby`→`lobby`.
 * Así el cliente conecta igual que con PartyKit, sin cambios.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const roomBridge = await handleRoomBridgeRequest(request, env);
    if (roomBridge) return roomBridge;
    const leaderboardBridge = await handleLeaderboardBridgeRequest(request, env);
    if (leaderboardBridge) return leaderboardBridge;
    const survivalBridge = await handleSurvivalBridgeRequest(request, env);
    if (survivalBridge) return survivalBridge;
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

/**
 * Bridge HTTP del ranking mundial, respaldado por el DO singleton `LeaderboardServer`.
 * Vercel (api/leaderboard.ts) lo consume en vez de Upstash. Mismo token que el bridge
 * de salas. GET → top; POST {meta} → suma una victoria y devuelve el top actualizado.
 */
async function handleLeaderboardBridgeRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== LEADERBOARD_BRIDGE_PATH) return null;

  try {
    authorizeBridgeRequest(request, env);
    // getServerByName (no el stub crudo) espera a onStart(), donde el DO rehidrata el
    // ranking desde su storage durable. Ver la misma nota en handleRoomBridgeRequest.
    const leaderboard = await getServerByName(env.Leaderboard, LEADERBOARD_PARTY_ID);

    if (request.method === 'GET') {
      const requested = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(requested) && requested > 0 ? requested : LEADERBOARD_DEFAULT_LIMIT;
      return sendBridgeJson(200, { entries: await leaderboard.topWins(limit) });
    }
    if (request.method === 'POST') {
      const meta = await request.json() as LeaderboardWinMeta;
      if (!meta || typeof meta.playerId !== 'string' || !meta.playerId) {
        throw new OnlineRoomError('Missing leaderboard win payload.', 400);
      }
      return sendBridgeJson(200, { entries: await leaderboard.recordWin(meta) });
    }
    return sendBridgeJson(405, { error: 'Method not allowed.' });
  } catch (error) {
    const status = error instanceof OnlineRoomError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Unexpected bridge error.';
    return sendBridgeJson(status, { error: message });
  }
}

/**
 * Bridge HTTP del top de supervivencia, respaldado por el DO singleton
 * `SurvivalLeaderboardServer`. Vercel (api/survival.ts) lo consume. Mismo token que el
 * resto de bridges. GET → top por tiempo; POST {meta} → registra un tiempo (solo mejora
 * el récord) y devuelve el top actualizado.
 */
async function handleSurvivalBridgeRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== SURVIVAL_BRIDGE_PATH) return null;

  try {
    authorizeBridgeRequest(request, env);
    const survival = await getServerByName(env.SurvivalLeaderboard, SURVIVAL_PARTY_ID);

    if (request.method === 'GET') {
      const requested = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(requested) && requested > 0 ? requested : SURVIVAL_DEFAULT_LIMIT;
      return sendBridgeJson(200, { entries: await survival.topTimes(limit) });
    }
    if (request.method === 'POST') {
      const meta = await request.json() as SurvivalTimeMeta;
      if (!meta || typeof meta.playerId !== 'string' || !meta.playerId) {
        throw new OnlineRoomError('Missing survival time payload.', 400);
      }
      return sendBridgeJson(200, { entries: await survival.recordTime(meta) });
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
