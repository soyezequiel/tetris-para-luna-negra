import { normalizeNpub, OnlineRoomError, sortLunaFriends } from './roomService.js';
import type {
  LunaFriend,
  LunaInviteRequest,
  LunaPresenceRequest,
  LunaLaunchRequest,
} from './protocol';

// Capa social de Luna Negra (amigos, presencia, invitaciones).
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
  // OJO con el .trim(): lunaGet/lunaPost concatenan `${baseUrl}${path}` (string),
  // NO usan new URL(). Un espacio/salto de línea al final de la env (típico al
  // pegarla en Vercel) producía fetch('https://host\n/api/v1/session') → throw →
  // null → 401, MIENTRAS que buildLunaLoginUrl (new URL) lo toleraba: login andaba
  // pero la sesión SSO no. Por eso trimeamos antes de sacar los slashes finales.
  const baseUrl = (process.env.LUNA_NEGRA_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const apiKey = (process.env.LUNA_NEGRA_API_KEY ?? '').trim();
  if (!baseUrl) throw new OnlineRoomError('LUNA_NEGRA_BASE_URL no está configurada.', 500);
  if (!apiKey) throw new OnlineRoomError('LUNA_NEGRA_API_KEY no está configurada.', 500);
  return { baseUrl, apiKey };
}

// fetch() descarta el header Authorization al seguir un redirect cross-origin
// (Fetch spec). Si LUNA_NEGRA_BASE_URL es un alias que hace 3xx hacia el dominio
// real, el bearer se pierde y la sesión SIEMPRE falla (login → invitado). Cuando
// detectamos que hubo redirect, reintentamos directo contra la URL final
// re-adjuntando el header. Lo ideal igual es apuntar LUNA_NEGRA_BASE_URL al
// dominio final para evitar el doble request.
async function lunaFetch(url: string, init: RequestInit, bearer: string): Promise<Response> {
  const headers = { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${bearer}` };
  const response = await fetch(url, { ...init, headers });
  if (response.redirected && response.url && response.url !== url) {
    console.warn(
      `[luna-negra] ${url} redirigió a ${response.url}; fetch descarta el header Authorization `
        + 'en redirects cross-origin. Reintentando directo — apuntá LUNA_NEGRA_BASE_URL al dominio final.',
    );
    return fetch(response.url, { ...init, headers });
  }
  return response;
}

async function lunaGet<T>(config: LunaConfig, path: string, bearer = config.apiKey): Promise<T | null> {
  try {
    const response = await lunaFetch(`${config.baseUrl}${path}`, { method: 'GET' }, bearer);
    if (!response.ok) {
      console.warn(`[luna-negra] GET ${path} → HTTP ${response.status}`);
      return null;
    }
    return (await response.json().catch(() => null)) as T | null;
  } catch (error) {
    console.warn(`[luna-negra] GET ${path} falló:`, error);
    return null;
  }
}

async function lunaPost<T>(config: LunaConfig, path: string, body: unknown): Promise<T | null> {
  try {
    const response = await lunaFetch(
      `${config.baseUrl}${path}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      config.apiKey,
    );
    if (!response.ok) {
      console.warn(`[luna-negra] POST ${path} → HTTP ${response.status}`);
      return null;
    }
    return (await response.json().catch(() => null)) as T | null;
  } catch (error) {
    console.warn(`[luna-negra] POST ${path} falló:`, error);
    return null;
  }
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
  // Reporta presencia al grafo real de Luna Negra. `game` (id o slug del juego en
  // la tienda) atribuye el latido a ESTE deployment: sin él, Luna Negra cuenta la
  // presencia a nivel proveedor y la curva de jugadores concurrentes se comparte
  // entre todos los juegos del proveedor (Tetra y Pre-alfa se mezclaban).
  const game =
    (process.env.LUNA_NEGRA_GAME_ID ?? '').trim() ||
    (process.env.LUNA_NEGRA_GAME_SLUG ?? '').trim() ||
    null;
  await lunaPost(config, '/api/v1/presence', {
    npub: request.npub,
    status: request.status,
    roomId: request.roomId ?? null,
    game,
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

export function normalizeLaunchRequest(value: unknown): LunaLaunchRequest | null {
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
    // Luna anterior a Room Link no enviaba `kind`; conservar compatibilidad.
    kind: entry.kind === 'room-link' ? 'room-link' : 'luna-room',
    slug: entry.slug,
    title: entry.title,
    gameUrl: entry.gameUrl,
  };
}
