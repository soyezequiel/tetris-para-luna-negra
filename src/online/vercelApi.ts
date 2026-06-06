import { MemoryRoomStore, OnlineRoomError, type RoomStore } from './roomService.js';
import type { MatchmakingQueue, MatchmakingTicket, OnlineMatchResult, OnlineProfile, QuickPlayLeaderboardEntry } from './protocol.js';
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

  async saveRoom(room: unknown, ttlSeconds?: number): Promise<void> {
    const key = roomKey((room as { id: string }).id);
    const value = JSON.stringify(room);
    if (ttlSeconds) await this.command(['SET', key, value, 'EX', ttlSeconds]);
    else await this.command(['SET', key, value]);
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

  async getMatchmakingTicket(id: string): Promise<MatchmakingTicket | null> {
    const raw = await this.command<string | null>(['GET', matchmakingTicketKey(id)]);
    return raw ? JSON.parse(raw) as MatchmakingTicket : null;
  }

  async saveMatchmakingTicket(ticket: MatchmakingTicket, ttlSeconds?: number): Promise<void> {
    const key = matchmakingTicketKey(ticket.id);
    const value = JSON.stringify(ticket);
    if (ttlSeconds) await this.command(['SET', key, value, 'EX', ttlSeconds]);
    else await this.command(['SET', key, value]);
  }

  async listMatchmakingTicketIds(queue: MatchmakingQueue): Promise<string[]> {
    const raw = await this.command<string | null>(['GET', matchmakingQueueKey(queue)]);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  async saveMatchmakingTicketIds(queue: MatchmakingQueue, ids: string[], ttlSeconds?: number): Promise<void> {
    const value = JSON.stringify(ids);
    if (ttlSeconds) await this.command(['SET', matchmakingQueueKey(queue), value, 'EX', ttlSeconds]);
    else await this.command(['SET', matchmakingQueueKey(queue), value]);
  }

  async getProfile(playerId: string): Promise<OnlineProfile | null> {
    const raw = await this.command<string | null>(['GET', profileKey(playerId)]);
    return raw ? JSON.parse(raw) as OnlineProfile : null;
  }

  async saveProfile(profile: OnlineProfile, ttlSeconds?: number): Promise<void> {
    const value = JSON.stringify(profile);
    if (ttlSeconds) await this.command(['SET', profileKey(profile.playerId), value, 'EX', ttlSeconds]);
    else await this.command(['SET', profileKey(profile.playerId), value]);
  }

  async getMatchResult(id: string): Promise<OnlineMatchResult | null> {
    const raw = await this.command<string | null>(['GET', matchResultKey(id)]);
    return raw ? JSON.parse(raw) as OnlineMatchResult : null;
  }

  async saveMatchResult(result: OnlineMatchResult, ttlSeconds?: number): Promise<void> {
    const value = JSON.stringify(result);
    if (ttlSeconds) await this.command(['SET', matchResultKey(result.id), value, 'EX', ttlSeconds]);
    else await this.command(['SET', matchResultKey(result.id), value]);
  }

  async listMatchResultIds(playerId: string): Promise<string[]> {
    const raw = await this.command<string | null>(['GET', matchResultIdsKey(playerId)]);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  async saveMatchResultIds(playerId: string, ids: string[], ttlSeconds?: number): Promise<void> {
    const value = JSON.stringify(ids);
    if (ttlSeconds) await this.command(['SET', matchResultIdsKey(playerId), value, 'EX', ttlSeconds]);
    else await this.command(['SET', matchResultIdsKey(playerId), value]);
  }

  async getQuickPlayLeaderboard(weekId: string): Promise<QuickPlayLeaderboardEntry[]> {
    const raw = await this.command<string | null>(['GET', quickPlayLeaderboardKey(weekId)]);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value as QuickPlayLeaderboardEntry[] : [];
    } catch {
      return [];
    }
  }

  async saveQuickPlayLeaderboard(weekId: string, entries: QuickPlayLeaderboardEntry[], ttlSeconds?: number): Promise<void> {
    const value = JSON.stringify(entries);
    if (ttlSeconds) await this.command(['SET', quickPlayLeaderboardKey(weekId), value, 'EX', ttlSeconds]);
    else await this.command(['SET', quickPlayLeaderboardKey(weekId), value]);
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

function roomKey(id: string): string {
  return `stack40:room:${id}`;
}

function publicRoomsKey(): string {
  return 'stack40:publicRooms';
}

function matchmakingTicketKey(id: string): string {
  return `stack40:matchmaking:ticket:${id}`;
}

function matchmakingQueueKey(queue: MatchmakingQueue): string {
  return `stack40:matchmaking:queue:${queue}`;
}

function profileKey(playerId: string): string {
  return `stack40:profile:${playerId}`;
}

function matchResultKey(id: string): string {
  return `stack40:match:${id}`;
}

function matchResultIdsKey(playerId: string): string {
  return `stack40:profile:${playerId}:matches`;
}

function quickPlayLeaderboardKey(weekId: string): string {
  return `stack40:quickplay:leaderboard:${weekId}`;
}
