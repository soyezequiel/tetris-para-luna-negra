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
  // Valida el token de sesión contra Luna Negra y devuelve la identidad. A
  // diferencia de lunaGet (que se traga el motivo y devuelve null), acá surface-amos
  // la causa REAL del fallo para que la puerta de login no muestre un 401 mudo:
  //   · throw de fetch  → URL/red rota (p. ej. baseUrl con basura → 502).
  //   · HTTP no-2xx     → el store rechazó (401 token vencido/inválido, 403 WAF…).
  //   · payload sin npub → respuesta inesperada.
  const url = `${config.baseUrl}/api/v1/session`;
  let response: Response;
  try {
    response = await lunaFetch(url, { method: 'GET' }, token);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'fetch falló';
    throw new OnlineRoomError(`No se pudo contactar a Luna Negra en ${url} (${reason}).`, 502);
  }
  if (!response.ok) {
    // Propagamos el motivo REAL que manda Luna ({ error: { code, message } }) en vez de un
    // 401 mudo: así la puerta de login dice por qué (token vencido / firma / emisor) en lugar
    // de "rechazó la sesión" a secas. Si el body no trae detalle, cae al genérico.
    const body = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } | string }
      | null;
    const detail =
      typeof body?.error === 'object' && body.error
        ? [body.error.message, body.error.code].filter(Boolean).join(' · ')
        : typeof body?.error === 'string'
          ? body.error
          : '';
    const suffix = detail ? `: ${detail}` : '.';
    throw new OnlineRoomError(
      `Luna Negra rechazó la sesión (HTTP ${response.status})${suffix}`,
      response.status === 401 ? 401 : 502,
    );
  }
  const payload = (await response.json().catch(() => null)) as LunaSessionPayload | null;
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
