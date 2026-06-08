import {
  listLunaFriendsMock,
  recordLunaPresence,
  sortLunaFriends,
  normalizeNpub,
  type RoomStore,
} from './roomService.js';
import type {
  LunaFriend,
  LunaIdentity,
  LunaInviteRequest,
  LunaPresenceRequest,
  LunaLaunchRequest,
} from './protocol';

// Capa social de Luna Negra (login SSO, amigos, presencia, invitaciones).
//
// Los endpoints reales de amigos/presencia/sesión de Luna Negra TODAVÍA NO
// EXISTEN (ver docs/luna-negra-social-spec.md). Mientras tanto este módulo:
//   1. Intenta los endpoints propuestos si la API está configurada.
//   2. Si fallan/no existen, cae a un modo "mock" que funciona end-to-end usando
//      la presencia que el propio juego registra (otros jugadores con el juego
//      abierto cuentan como "amigos" hasta que exista el grafo real).
// La API key nunca sale del servidor: el frontend habla con /api/luna-negra/*.

interface LunaConfig {
  baseUrl: string;
  apiKey: string;
}

function readConfig(): LunaConfig | null {
  const baseUrl = (process.env.LUNA_NEGRA_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = (process.env.LUNA_NEGRA_API_KEY ?? '').trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

async function lunaGet<T>(config: LunaConfig, path: string, bearer = config.apiKey): Promise<T | null> {
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!response.ok) return null;
    return unwrapEnvelope<T>(await response.json().catch(() => null));
  } catch {
    return null;
  }
}

async function lunaPost<T>(config: LunaConfig, path: string, body: unknown): Promise<T | null> {
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    return unwrapEnvelope<T>(await response.json().catch(() => null));
  } catch {
    return null;
  }
}

// Luna Negra envuelve estos endpoints sociales en el envelope estándar de
// src/lib/api.ts (p. ej. { data: {...} } / { success, data }). Los endpoints de
// apuestas devuelven el objeto crudo. Desenvolvemos `data` cuando está presente
// para tolerar ambas formas sin romper si en el futuro dejan de envolver.
function unwrapEnvelope<T>(raw: unknown): T | null {
  if (raw && typeof raw === 'object' && 'data' in raw) {
    const data = (raw as { data: unknown }).data;
    if (data && typeof data === 'object') return data as T;
  }
  return raw as T | null;
}

// ───────────────────────────── Sesión / login SSO ─────────────────────────────

interface LunaSessionPayload {
  npub?: string;
  pubkey?: string | null;
  displayName?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
  gameId?: string | null;
}

export async function resolveLunaSession(
  token: string,
): Promise<{ identity: LunaIdentity; source: 'luna-negra' | 'mock' }> {
  const config = readConfig();
  if (config) {
    // Endpoint propuesto: valida el token de sesión y devuelve la identidad.
    const payload = await lunaGet<LunaSessionPayload>(config, '/api/v1/session', token);
    if (payload?.npub) {
      return {
        identity: {
          npub: payload.npub,
          pubkey: typeof payload.pubkey === 'string' ? payload.pubkey : null,
          name: (payload.displayName || payload.name || shortNpub(payload.npub)).slice(0, 18),
          avatarUrl: typeof payload.avatarUrl === 'string' ? payload.avatarUrl : null,
          gameId: typeof payload.gameId === 'string' ? payload.gameId : null,
        },
        source: 'luna-negra',
      };
    }
  }
  return { identity: mockIdentityFromToken(token), source: 'mock' };
}

// Identidad determinista derivada del token para desarrollo: dos pestañas con
// distinto token actúan como dos usuarios distintos y estables entre recargas.
function mockIdentityFromToken(token: string): LunaIdentity {
  const seed = token.trim() || 'anon';
  const hash = hashHex(seed);
  return {
    npub: `npub1mock${hash}`,
    pubkey: null,
    name: friendlyMockName(seed, hash),
    avatarUrl: null,
    gameId: null,
  };
}

function friendlyMockName(seed: string, hash: string): string {
  // Permite forzar un nombre legible con `?lnDemo=Nombre`.
  const cleaned = seed.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  if (cleaned && cleaned.length <= 18 && /[a-zA-Z]/.test(cleaned)) return cleaned;
  return `Jugador-${hash.slice(0, 4).toUpperCase()}`;
}

function hashHex(value: string): string {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function shortNpub(npub: string): string {
  return npub.length > 12 ? `${npub.slice(0, 8)}…${npub.slice(-4)}` : npub;
}

// ──────────────────────────────── Amigos ────────────────────────────────────

interface LunaFriendPayload {
  npub?: string;
  name?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  presence?: string | null;
  status?: string | null;
  roomId?: string | null;
  lastSeenMs?: number | null;
}

export async function listLunaFriends(
  store: RoomStore,
  selfNpub: string,
  nowMs = Date.now(),
): Promise<{ friends: LunaFriend[]; source: 'luna-negra' | 'mock' }> {
  const self = normalizeNpub(selfNpub) ?? '';
  const config = readConfig();
  if (config && self) {
    // Endpoint propuesto: amigos del usuario con su presencia en este juego.
    const payload = await lunaGet<{ friends?: LunaFriendPayload[] } | LunaFriendPayload[]>(
      config,
      `/api/v1/friends?npub=${encodeURIComponent(self)}&presence=true`,
    );
    // El envelope puede devolver { friends: [...] } o directamente el array.
    const list = Array.isArray(payload) ? payload : payload?.friends;
    if (list) {
      const friends = list
        .filter((entry): entry is LunaFriendPayload & { npub: string } => typeof entry.npub === 'string')
        .map((entry) => normalizeFriendPayload(entry));
      return { friends: sortLunaFriends(friends), source: 'luna-negra' };
    }
  }
  return { friends: await listLunaFriendsMock(store, self, nowMs), source: 'mock' };
}

function normalizeFriendPayload(entry: LunaFriendPayload & { npub: string }): LunaFriend {
  const presenceRaw = (entry.presence ?? entry.status ?? 'offline').toString().toLowerCase();
  const presence: LunaFriend['presence'] = presenceRaw.includes('game') || presenceRaw === 'playing'
    ? 'in-game'
    : presenceRaw === 'online' || presenceRaw === 'available'
      ? 'online'
      : 'offline';
  return {
    npub: entry.npub,
    name: (entry.displayName || entry.name || shortNpub(entry.npub)).toString().slice(0, 18),
    avatarUrl: typeof entry.avatarUrl === 'string' ? entry.avatarUrl : null,
    presence,
    roomId: typeof entry.roomId === 'string' ? entry.roomId : null,
    lastSeenMs: typeof entry.lastSeenMs === 'number' ? entry.lastSeenMs : null,
  };
}

// ──────────────────────────────── Presencia ─────────────────────────────────

export async function heartbeatLunaPresence(
  store: RoomStore,
  request: LunaPresenceRequest,
  nowMs = Date.now(),
): Promise<{ source: 'luna-negra' | 'mock' }> {
  // Siempre guardamos presencia local (alimenta el modo mock de amigos).
  await recordLunaPresence(store, request, nowMs);
  const config = readConfig();
  if (config) {
    // Endpoint propuesto: reporta presencia al grafo real de Luna Negra.
    const ok = await lunaPost(config, '/api/v1/presence', {
      npub: request.npub,
      status: request.status,
      roomId: request.roomId ?? null,
    });
    if (ok !== null) return { source: 'luna-negra' };
  }
  return { source: 'mock' };
}

// ─────────────────────────────── Invitaciones ───────────────────────────────

export async function sendLunaInvite(
  request: LunaInviteRequest,
  inviteUrl: string,
  fromNpub: string | null,
): Promise<{ delivered: boolean; source: 'luna-negra' | 'mock' }> {
  const config = readConfig();
  if (config) {
    // Luna Negra es dueña de la entrega: notifica al amigo (toast in-app /
    // deep-link). fromNpub alimenta el "X te invitó" del toast.
    const result = await lunaPost<{ delivered?: boolean }>(config, '/api/v1/friends/invite', {
      fromNpub,
      toNpub: request.friendNpub,
      roomId: request.roomId,
      inviteUrl,
    });
    if (result !== null) return { delivered: result.delivered !== false, source: 'luna-negra' };
  }
  // Mock: no hay canal de notificación; el host comparte el link manualmente.
  return { delivered: false, source: 'mock' };
}

export async function consumeLunaLaunchRequest(
  selfNpub: string,
): Promise<{ request: LunaLaunchRequest | null; source: 'luna-negra' | 'mock' }> {
  const self = normalizeNpub(selfNpub) ?? '';
  const config = readConfig();
  if (config && self) {
    const payload = await lunaGet<{ request?: unknown }>(
      config,
      `/api/v1/launch-requests?npub=${encodeURIComponent(self)}`,
    );
    if (payload && 'request' in payload) {
      return { request: normalizeLaunchRequest(payload.request), source: 'luna-negra' };
    }
  }
  return { request: null, source: 'mock' };
}

function normalizeLaunchRequest(value: unknown): LunaLaunchRequest | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<Record<keyof LunaLaunchRequest, unknown>>;
  if (
    typeof entry.id !== 'string'
    || typeof entry.roomId !== 'string'
    || typeof entry.inviteToken !== 'string'
    || typeof entry.slug !== 'string'
    || typeof entry.title !== 'string'
    || typeof entry.gameUrl !== 'string'
  ) {
    return null;
  }
  return {
    id: entry.id,
    roomId: entry.roomId,
    inviteToken: entry.inviteToken,
    slug: entry.slug,
    title: entry.title,
    gameUrl: entry.gameUrl,
  };
}
