import { MemoryRoomStore, OnlineRoomError, RoomVersionConflictError, type LunaPresenceRecord, type RoomStore } from './roomService.js';
import { LEADERBOARD_MAX_ENTRIES, MemoryLeaderboardStore, type LeaderboardStore } from './leaderboard.js';
import type { LeaderboardEntry, OnlineRoom } from './protocol.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const config = {
  regions: ['gru1'],
};

interface UpstashResponse<T> {
  result?: T;
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

  async getPresenceRecords(): Promise<LunaPresenceRecord[]> {
    const raw = await this.command<string | null>(['GET', presenceKey()]);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value as LunaPresenceRecord[] : [];
    } catch {
      return [];
    }
  }

  async savePresenceRecords(records: LunaPresenceRecord[], ttlSeconds?: number): Promise<void> {
    const value = JSON.stringify(records);
    if (ttlSeconds) await this.command(['SET', presenceKey(), value, 'EX', ttlSeconds]);
    else await this.command(['SET', presenceKey(), value]);
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

declare global {
  // eslint-disable-next-line no-var
  var stack40MemoryLeaderboardStore: MemoryLeaderboardStore | undefined;
}

/**
 * Ranking mundial sobre Upstash: un sorted set con el mejor tiempo (menor = más
 * rápido) de cada jugador, más un hash con los metadatos (nombre, avatar, npub).
 * El sorted set ordena y acota el top; el hash guarda lo que no entra en el score.
 */
class UpstashLeaderboardStore implements LeaderboardStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async topSprint40(limit: number): Promise<LeaderboardEntry[]> {
    const flat = await upstashCommand<string[] | null>(this.url, this.token, [
      'ZRANGE', sprint40Key(), '0', String(Math.max(0, limit - 1)), 'WITHSCORES',
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
      'HMGET', sprint40MetaKey(), ...members,
    ]);
    return members.map((member, index) => (
      parseLeaderboardEntry(member, scores.get(member) ?? 0, metas?.[index] ?? null)
    ));
  }

  async submitSprint40(entry: LeaderboardEntry): Promise<void> {
    await upstashCommand(this.url, this.token, [
      'EVAL', LEADERBOARD_SUBMIT_SCRIPT, 2,
      sprint40Key(), sprint40MetaKey(),
      entry.playerId, String(entry.elapsedFrames), JSON.stringify(entry), String(LEADERBOARD_MAX_ENTRIES),
    ]);
  }
}

export function getLeaderboardStore(): LeaderboardStore {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (url && token) return new UpstashLeaderboardStore(url, token);
  globalThis.stack40MemoryLeaderboardStore ??= new MemoryLeaderboardStore();
  return globalThis.stack40MemoryLeaderboardStore;
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

function parseLeaderboardEntry(playerId: string, elapsedFrames: number, metaJson: string | null): LeaderboardEntry {
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
  return { playerId, npub, name, avatarUrl, elapsedFrames, createdAtServerMs };
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

// Guarda el resultado solo si mejora el mejor tiempo previo del jugador y poda el
// sorted set (y su hash de metadatos) al top N, todo de forma atómica.
const LEADERBOARD_SUBMIT_SCRIPT = `
local key = KEYS[1]
local meta = KEYS[2]
local member = ARGV[1]
local score = tonumber(ARGV[2])
local cur = redis.call('ZSCORE', key, member)
if cur ~= false and score >= tonumber(cur) then return 0 end
redis.call('ZADD', key, score, member)
redis.call('HSET', meta, member, ARGV[3])
local max = tonumber(ARGV[4])
if redis.call('ZCARD', key) > max then
  local removed = redis.call('ZRANGE', key, max, -1)
  for _, m in ipairs(removed) do
    redis.call('ZREM', key, m)
    redis.call('HDEL', meta, m)
  end
end
return 1
`;

function sprint40Key(): string {
  return 'stack40:leaderboard:sprint40';
}

function sprint40MetaKey(): string {
  return 'stack40:leaderboard:sprint40:meta';
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

function presenceKey(): string {
  return 'stack40:luna:presence';
}
