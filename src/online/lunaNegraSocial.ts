import { normalizeNpub, OnlineRoomError, sortLunaFriends } from './roomService.js';
import type {
  LunaFriend,
  LunaIdentity,
  LunaInviteRequest,
  LunaPresenceRequest,
  LunaLaunchRequest,
} from './protocol';

// Capa social de Luna Negra (login SSO, amigos, presencia, invitaciones).
//
// Habla con los endpoints v1 de Luna Negra (/session, /friends, /presence,
// /invites) usando la API key del proveedor, que nunca sale del servidor: el
// frontend pega a /api/luna-negra/*. Tetris y Luna Negra se despliegan juntos,
// así que la API siempre está configurada; sin config, las funciones fallan con
// un error claro en vez de simular datos.

interface LunaConfig {
  baseUrl: string;
  apiKey: string;
}

function readConfig(): LunaConfig {
  const baseUrl = (process.env.LUNA_NEGRA_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = (process.env.LUNA_NEGRA_API_KEY ?? '').trim();
  if (!baseUrl) throw new OnlineRoomError('LUNA_NEGRA_BASE_URL no está configurada.', 500);
  if (!apiKey) throw new OnlineRoomError('LUNA_NEGRA_API_KEY no está configurada.', 500);
  return { baseUrl, apiKey };
}

async function lunaGet<T>(config: LunaConfig, path: string, bearer = config.apiKey): Promise<T | null> {
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!response.ok) return null;
    return (await response.json().catch(() => null)) as T | null;
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
    return (await response.json().catch(() => null)) as T | null;
  } catch {
    return null;
  }
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
): Promise<{ identity: LunaIdentity; source: 'luna-negra' }> {
  const config = readConfig();
  // Valida el token de sesión contra Luna Negra y devuelve la identidad.
  const payload = await lunaGet<LunaSessionPayload>(config, '/api/v1/session', token);
  if (!payload?.npub) {
    throw new OnlineRoomError('Sesión de Luna Negra inválida o expirada.', 401);
  }
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
  selfNpub: string,
): Promise<{ friends: LunaFriend[]; source: 'luna-negra' }> {
  const self = normalizeNpub(selfNpub) ?? '';
  const config = readConfig();
  if (!self) return { friends: [], source: 'luna-negra' };
  // Amigos del usuario con su presencia en este juego.
  const payload = await lunaGet<{ friends?: LunaFriendPayload[] }>(
    config,
    `/api/v1/friends?npub=${encodeURIComponent(self)}&presence=true`,
  );
  const list = payload?.friends ?? [];
  const friends = list
    .filter((entry): entry is LunaFriendPayload & { npub: string } => typeof entry.npub === 'string')
    .map((entry) => normalizeFriendPayload(entry));
  return { friends: sortLunaFriends(friends), source: 'luna-negra' };
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
  request: LunaPresenceRequest,
): Promise<{ source: 'luna-negra' }> {
  const config = readConfig();
  // Reporta presencia al grafo real de Luna Negra.
  await lunaPost(config, '/api/v1/presence', {
    npub: request.npub,
    status: request.status,
    roomId: request.roomId ?? null,
  });
  return { source: 'luna-negra' };
}

// ─────────────────────────────── Invitaciones ───────────────────────────────

export async function sendLunaInvite(
  request: LunaInviteRequest,
  inviteUrl: string,
  fromNpub: string | null,
): Promise<{ delivered: boolean; source: 'luna-negra' }> {
  const config = readConfig();
  // Luna Negra es dueña de la entrega: notifica al amigo (toast in-app /
  // deep-link). fromNpub alimenta el "X te invitó" del toast.
  const result = await lunaPost<{ delivered?: boolean }>(config, '/api/v1/invites', {
    fromNpub,
    toNpub: request.friendNpub,
    roomId: request.roomId,
    inviteUrl,
    gameId: request.gameId ?? null,
  });
  return { delivered: result?.delivered === true, source: 'luna-negra' };
}

export async function consumeLunaLaunchRequest(
  selfNpub: string,
): Promise<{ request: LunaLaunchRequest | null; source: 'luna-negra' }> {
  const self = normalizeNpub(selfNpub) ?? '';
  const config = readConfig();
  if (!self) return { request: null, source: 'luna-negra' };
  const payload = await lunaGet<{ request?: unknown }>(
    config,
    `/api/v1/invites?npub=${encodeURIComponent(self)}`,
  );
  return { request: normalizeLaunchRequest(payload?.request), source: 'luna-negra' };
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
