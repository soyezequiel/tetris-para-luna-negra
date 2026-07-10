import { normalizeNpub, OnlineRoomError } from './roomService.js';
import type { LunaLaunchRequest } from './protocol';

// Launch requests de Luna Negra ("jugar" desde la tienda deja un pedido pendiente
// que el juego consume al arrancar).
//
// Habla con el endpoint v1 de Luna Negra usando la API key del proveedor, que
// nunca sale del servidor: el frontend pega a /api/luna-negra/*. Tetris y Luna
// Negra se despliegan juntos, así que la API siempre está configurada; sin
// config, las funciones fallan con un error claro en vez de simular datos.
//
// Amigos, presencia e invitaciones vivían acá y ya no: los reemplazaron los
// contactos (kind:3), NIP-38 y NIP-17 del stack Nostr.

interface LunaConfig {
  baseUrl: string;
  apiKey: string;
}

function readConfig(): LunaConfig {
  // OJO con el .trim(): lunaGet concatena `${baseUrl}${path}` (string), NO usa
  // new URL(). Un espacio/salto de línea al final de la env (típico al pegarla en
  // Vercel) producía fetch('https://host\n/api/v1/invites') → throw → null.
  const baseUrl = (process.env.LUNA_NEGRA_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const apiKey = (process.env.LUNA_NEGRA_API_KEY ?? '').trim();
  if (!baseUrl) throw new OnlineRoomError('LUNA_NEGRA_BASE_URL no está configurada.', 500);
  if (!apiKey) throw new OnlineRoomError('LUNA_NEGRA_API_KEY no está configurada.', 500);
  return { baseUrl, apiKey };
}

// fetch() descarta el header Authorization al seguir un redirect cross-origin
// (Fetch spec). Si LUNA_NEGRA_BASE_URL es un alias que hace 3xx hacia el dominio
// real, el bearer se pierde y el pedido SIEMPRE falla. Cuando detectamos que hubo
// redirect, reintentamos directo contra la URL final re-adjuntando el header. Lo
// ideal igual es apuntar LUNA_NEGRA_BASE_URL al dominio final para evitar el
// doble request.
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
