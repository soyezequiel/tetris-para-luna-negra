import { MemoryRoomStore, normalizeRoomId, OnlineRoomError, RoomVersionConflictError, type RoomStore } from './roomService.js';
import { LEADERBOARD_MAX_ENTRIES, MemoryLeaderboardStore, type LeaderboardStore, type LeaderboardWinMeta } from './leaderboard.js';
import { MemorySurvivalLeaderboardStore, type SurvivalLeaderboardStore, type SurvivalTimeMeta } from './survivalLeaderboard.js';
import type { LeaderboardEntry, OnlineRoom, SurvivalEntry } from './protocol.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const config = {
  regions: ['gru1'],
};

interface UpstashResponse<T> {
  result?: T;
  error?: string;
}

interface PartyBridgeResponse {
  room?: OnlineRoom | null;
  error?: string;
}

class UpstashRoomStore implements RoomStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async getRoom(id: string) {
    const raw = await this.command<string | null>(['GET', roomKey(id)]);
    return raw ? JSON.parse(raw) : null;
  }

  async saveRoom(room: OnlineRoom, ttlSeconds?: number): Promise<void> {
    // Compare-and-set: solo escribe si nadie guardó la sala desde que la leímos.
    // Sin esto, requests concurrentes (progress/attack/eliminate) se pisaban el
    // estado entre sí y se perdían eliminaciones o el final de la partida.
    const expectedVersion = room.version ?? 0;
    const nextRoom = { ...room, version: expectedVersion + 1 };
    const result = await this.command<number>([
      'EVAL',
      CAS_SAVE_ROOM_SCRIPT,
      2,
      roomKey(room.id),
      roomVersionKey(room.id),
      JSON.stringify(nextRoom),
      String(expectedVersion),
      String(expectedVersion + 1),
      String(ttlSeconds ?? 0),
    ]);
    if (result !== 1) throw new RoomVersionConflictError();
    // El objeto del llamador queda apuntando a la revisión recién guardada.
    room.version = expectedVersion + 1;
  }

  async deleteRoom(id: string): Promise<void> {
    await this.command(['DEL', roomKey(id), roomVersionKey(id)]);
  }

  async listPublicRoomIds(): Promise<string[]> {
    const raw = await this.command<string | null>(['GET', publicRoomsKey()]);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  async savePublicRoomIds(ids: string[], ttlSeconds?: number): Promise<void> {
    const value = JSON.stringify(ids);
    if (ttlSeconds) await this.command(['SET', publicRoomsKey(), value, 'EX', ttlSeconds]);
    else await this.command(['SET', publicRoomsKey(), value]);
  }

  private async command<T>(command: unknown[]): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(command),
    });
    const payload = await response.json() as UpstashResponse<T>;
    if (!response.ok || payload.error) throw new Error(payload.error ?? 'Upstash command failed.');
    return payload.result as T;
  }
}

class PartyBridgeRoomStore implements RoomStore {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async getRoom(id: string): Promise<OnlineRoom | null> {
    const payload = await this.request('GET', normalizeRoomId(id));
    return payload.room ?? null;
  }

  async saveRoom(room: OnlineRoom): Promise<void> {
    const payload = await this.request('PUT', room.id, { room });
    if (!payload.room) throw new OnlineRoomError('Room bridge returned an empty room.', 502);
    Object.assign(room, payload.room);
  }

  async deleteRoom(): Promise<void> {
    throw new OnlineRoomError('Room bridge delete is not supported.', 405);
  }

  async listPublicRoomIds(): Promise<string[]> {
    return [];
  }

  async savePublicRoomIds(): Promise<void> {
    // El lobby de WebSocket vive en Cloudflare; las apuestas no actualizan listas publicas de Vercel.
  }

  private async request(method: 'GET' | 'PUT', roomId: string, body?: unknown): Promise<PartyBridgeResponse> {
    const response = await fetch(`${this.baseUrl}/__bridge/rooms/${encodeURIComponent(normalizeRoomId(roomId))}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as PartyBridgeResponse | null;
    if (!response.ok) {
      throw new OnlineRoomError(payload?.error ?? 'Room bridge request failed.', response.status);
    }
    return payload ?? {};
  }
}

declare global {
  // eslint-disable-next-line no-var
  var stack40MemoryRoomStore: MemoryRoomStore | undefined;
}

export function getRoomStore(): RoomStore {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (url && token) return new UpstashRoomStore(url, token);
  globalThis.stack40MemoryRoomStore ??= new MemoryRoomStore();
  return globalThis.stack40MemoryRoomStore;
}

export function getBetRoomStore(): RoomStore {
  const token = (process.env.PARTY_BRIDGE_TOKEN ?? '').trim();
  if (token) {
    const bridgeUrl = (process.env.PARTY_BRIDGE_URL ?? '').trim() || 'https://tetra.naranjas.workers.dev';
    return new PartyBridgeRoomStore(
      bridgeUrl,
      token,
    );
  }
  return getRoomStore();
}

declare global {
  // eslint-disable-next-line no-var
  var stack40MemoryLeaderboardStore: MemoryLeaderboardStore | undefined;
}

/**
 * Ranking mundial sobre Upstash: un sorted set con la cantidad de victorias
 * (mayor = mejor) de cada jugador, más un hash con los metadatos (nombre, avatar,
 * npub). El sorted set ordena y acota el top; el hash guarda lo que no entra en el
 * score.
 */
class UpstashLeaderboardStore implements LeaderboardStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async topWins(limit: number): Promise<LeaderboardEntry[]> {
    const flat = await upstashCommand<string[] | null>(this.url, this.token, [
      'ZRANGE', winsKey(), '0', String(Math.max(0, limit - 1)), 'REV', 'WITHSCORES',
    ]);
    if (!Array.isArray(flat) || flat.length === 0) return [];
    const members: string[] = [];
    const scores = new Map<string, number>();
    for (let index = 0; index < flat.length; index += 2) {
      const member = flat[index];
      members.push(member);
      scores.set(member, Number(flat[index + 1]));
    }
    const metas = await upstashCommand<(string | null)[] | null>(this.url, this.token, [
      'HMGET', winsMetaKey(), ...members,
    ]);
    // El top mundial solo lista a jugadores con sesión de Luna Negra (npub). Filtramos
    // también al leer para esconder entradas de invitados persistidas de antes de la regla.
    return members
      .map((member, index) => parseLeaderboardEntry(member, scores.get(member) ?? 0, metas?.[index] ?? null))
      .filter((entry) => entry.npub);
  }

  async recordWin(meta: LeaderboardWinMeta): Promise<void> {
    // Sin sesión de Luna Negra (sin npub) no se entra al top: lo descartamos en silencio
    // para que el ranking solo cuente jugadores identificados.
    if (!meta.npub) return;
    await upstashCommand(this.url, this.token, [
      'EVAL', LEADERBOARD_WIN_SCRIPT, 2,
      winsKey(), winsMetaKey(),
      meta.playerId, JSON.stringify(meta), String(LEADERBOARD_MAX_ENTRIES),
    ]);
  }
}

/**
 * Ranking mundial servido por el Worker de Cloudflare (DO `LeaderboardServer`) vía
 * el bridge HTTP `/__bridge/leaderboard`. Reemplaza a Upstash, cuya cuota free se
 * agotaba y tiraba abajo el "Top mundial". Mismo token/host que el bridge de salas.
 */
class PartyBridgeLeaderboardStore implements LeaderboardStore {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async topWins(limit: number): Promise<LeaderboardEntry[]> {
    const payload = await this.request('GET', `?limit=${encodeURIComponent(String(limit))}`);
    return Array.isArray(payload.entries) ? payload.entries : [];
  }

  async recordWin(meta: LeaderboardWinMeta): Promise<void> {
    await this.request('POST', '', meta);
  }

  private async request(
    method: 'GET' | 'POST',
    suffix: string,
    body?: unknown,
  ): Promise<{ entries?: LeaderboardEntry[]; error?: string }> {
    const response = await fetch(`${this.baseUrl}/__bridge/leaderboard${suffix}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as { entries?: LeaderboardEntry[]; error?: string } | null;
    if (!response.ok) {
      throw new OnlineRoomError(payload?.error ?? 'Leaderboard bridge request failed.', response.status);
    }
    return payload ?? {};
  }
}

export function getLeaderboardStore(): LeaderboardStore {
  // Preferimos el Worker de Cloudflare (DO) cuando hay token de bridge: saca el
  // ranking de Upstash, que se quedaba sin cuota. Cae a Upstash y luego a memoria.
  const bridgeToken = (process.env.PARTY_BRIDGE_TOKEN ?? '').trim();
  if (bridgeToken) {
    const bridgeUrl = (process.env.PARTY_BRIDGE_URL ?? '').trim() || 'https://tetra.naranjas.workers.dev';
    return new PartyBridgeLeaderboardStore(bridgeUrl, bridgeToken);
  }
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (url && token) return new UpstashLeaderboardStore(url, token);
  globalThis.stack40MemoryLeaderboardStore ??= new MemoryLeaderboardStore();
  return globalThis.stack40MemoryLeaderboardStore;
}

/**
 * Top de supervivencia servido por el Worker de Cloudflare (DO `SurvivalLeaderboardServer`)
 * vía el bridge HTTP `/__bridge/survival`. Mismo token/host que el bridge de salas y el
 * de victorias.
 */
class PartyBridgeSurvivalStore implements SurvivalLeaderboardStore {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async topTimes(limit: number): Promise<SurvivalEntry[]> {
    const payload = await this.request('GET', `?limit=${encodeURIComponent(String(limit))}`);
    return Array.isArray(payload.entries) ? payload.entries : [];
  }

  async recordTime(meta: SurvivalTimeMeta): Promise<void> {
    await this.request('POST', '', meta);
  }

  private async request(
    method: 'GET' | 'POST',
    suffix: string,
    body?: unknown,
  ): Promise<{ entries?: SurvivalEntry[]; error?: string }> {
    const response = await fetch(`${this.baseUrl}/__bridge/survival${suffix}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as { entries?: SurvivalEntry[]; error?: string } | null;
    if (!response.ok) {
      throw new OnlineRoomError(payload?.error ?? 'Survival bridge request failed.', response.status);
    }
    return payload ?? {};
  }
}

declare global {
  // eslint-disable-next-line no-var
  var stack40MemorySurvivalStore: MemorySurvivalLeaderboardStore | undefined;
}

export function getSurvivalLeaderboardStore(): SurvivalLeaderboardStore {
  // Igual que el ranking de victorias: preferimos el Worker de Cloudflare (DO) cuando
  // hay token de bridge; en dev caemos a un store en memoria.
  const bridgeToken = (process.env.PARTY_BRIDGE_TOKEN ?? '').trim();
  if (bridgeToken) {
    const bridgeUrl = (process.env.PARTY_BRIDGE_URL ?? '').trim() || 'https://tetra.naranjas.workers.dev';
    return new PartyBridgeSurvivalStore(bridgeUrl, bridgeToken);
  }
  globalThis.stack40MemorySurvivalStore ??= new MemorySurvivalLeaderboardStore();
  return globalThis.stack40MemorySurvivalStore;
}

async function upstashCommand<T>(url: string, token: string, command: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  const payload = await response.json() as UpstashResponse<T>;
  if (!response.ok || payload.error) throw new Error(payload.error ?? 'Upstash command failed.');
  return payload.result as T;
}

function parseLeaderboardEntry(playerId: string, wins: number, metaJson: string | null): LeaderboardEntry {
  let name = playerId;
  let avatarUrl: string | null = null;
  let npub: string | null = null;
  let createdAtServerMs = 0;
  if (metaJson) {
    try {
      const meta = JSON.parse(metaJson) as Partial<LeaderboardEntry>;
      if (typeof meta.name === 'string') name = meta.name;
      if (typeof meta.avatarUrl === 'string') avatarUrl = meta.avatarUrl;
      if (typeof meta.npub === 'string') npub = meta.npub;
      if (typeof meta.createdAtServerMs === 'number') createdAtServerMs = meta.createdAtServerMs;
    } catch {
      // Metadato corrupto: caemos al playerId como nombre.
    }
  }
  return { playerId, npub, name, avatarUrl, wins, createdAtServerMs };
}

export async function readJsonBody<T = Record<string, unknown>>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export function queryParam(request: Request, name: string): string {
  const url = new URL(request.url);
  return url.searchParams.get(name) ?? '';
}

export function sendJson(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  });
}

export function sendMethodNotAllowed(): Response {
  return sendJson(405, { error: 'Method not allowed.' });
}

export function handleApiError(error: unknown): Response {
  if (error instanceof OnlineRoomError) {
    return sendJson(error.status, { error: error.message });
  }
  return sendJson(500, { error: error instanceof Error ? error.message : 'Unexpected server error.' });
}

export type WebApiHandlers = Partial<Record<'GET' | 'POST', (request: Request) => Response | Promise<Response>>>;

export async function handleNodeApi(
  request: IncomingMessage,
  response: ServerResponse,
  handlers: WebApiHandlers,
): Promise<void> {
  try {
    const method = request.method === 'POST' ? 'POST' : 'GET';
    const handler = handlers[method];
    const webResponse = handler
      ? await handler(await toWebRequest(request))
      : sendMethodNotAllowed();
    await writeNodeResponse(response, webResponse);
  } catch (error) {
    await writeNodeResponse(response, handleApiError(error));
  }
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const host = request.headers.host ?? '127.0.0.1';
  const proto = firstHeader(request.headers['x-forwarded-proto']) ?? 'https';
  const url = `${proto}://${host}${request.url ?? '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else if (value !== undefined) headers.set(key, value);
  }
  const method = request.method ?? 'GET';
  const rawBody = method === 'GET' || method === 'HEAD' ? undefined : await readNodeBody(request);
  const body = rawBody ? Buffer.from(rawBody).toString('utf8') : undefined;
  return new Request(url, { method, headers, body });
}

async function readNodeBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

async function writeNodeResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => response.setHeader(key, value));
  response.end(Buffer.from(await webResponse.arrayBuffer()));
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

// La versión vive en una key aparte (no dentro del JSON) para que el script
// compare sin parsear la sala. Solo este script escribe ambas keys, así nunca
// divergen. Una sala vieja sin key de versión cuenta como versión 0.
const CAS_SAVE_ROOM_SCRIPT = `
local current = redis.call('GET', KEYS[2])
if current == false then current = '0' end
if current ~= ARGV[2] then return 0 end
local ttl = tonumber(ARGV[4])
if ttl > 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
  redis.call('SET', KEYS[2], ARGV[3], 'EX', ttl)
else
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('SET', KEYS[2], ARGV[3])
end
return 1
`;

// Suma una victoria al jugador, actualiza sus metadatos y poda el sorted set (y su
// hash) al top N por victorias, todo de forma atómica. Como el ranking es
// descendente, la poda elimina a los de MENOR puntaje (los primeros en orden asc).
const LEADERBOARD_WIN_SCRIPT = `
local key = KEYS[1]
local meta = KEYS[2]
local member = ARGV[1]
redis.call('ZINCRBY', key, 1, member)
redis.call('HSET', meta, member, ARGV[2])
local max = tonumber(ARGV[3])
if redis.call('ZCARD', key) > max then
  local removed = redis.call('ZRANGE', key, 0, -(max + 1))
  for _, m in ipairs(removed) do
    redis.call('ZREM', key, m)
    redis.call('HDEL', meta, m)
  end
end
return 1
`;

function winsKey(): string {
  return 'stack40:leaderboard:wins';
}

function winsMetaKey(): string {
  return 'stack40:leaderboard:wins:meta';
}

function roomKey(id: string): string {
  return `stack40:room:${id}`;
}

function roomVersionKey(id: string): string {
  return `stack40:room:${id}:version`;
}

function publicRoomsKey(): string {
  return 'stack40:publicRooms';
}

