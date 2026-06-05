import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { MemoryRoomStore, OnlineRoomError, type RoomStore } from './roomService';

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
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new UpstashRoomStore(url, token);
  globalThis.stack40MemoryRoomStore ??= new MemoryRoomStore();
  return globalThis.stack40MemoryRoomStore;
}

export async function readJsonBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

export function queryParam(req: IncomingMessage, name: string): string {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  return url.searchParams.get(name) ?? '';
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export function sendMethodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { error: 'Method not allowed.' });
}

export function handleApiError(res: ServerResponse, error: unknown): void {
  if (error instanceof OnlineRoomError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  sendJson(res, 500, { error: error instanceof Error ? error.message : 'Unexpected server error.' });
}

function roomKey(id: string): string {
  return `stack40:room:${id}`;
}

function publicRoomsKey(): string {
  return 'stack40:publicRooms';
}
