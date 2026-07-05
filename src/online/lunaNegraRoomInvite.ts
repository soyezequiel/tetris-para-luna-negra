// Verificación OFFLINE del token `lnInvite` de "Luna Room Link" (invitación
// dirigida a una sala hosteada por ESTE juego). Ver el estándar en el repo de Luna
// Negra: docs/luna-room-link.md.
//
// El `lnInvite` es un JWT ES256 firmado por Luna Negra; se valida contra su JWKS
// público (`/.well-known/jwks.json`) sin llamar a ningún endpoint de verificación
// (es autocontenido). Solo corre en el servidor (usa `process.env` y cachea el
// JWKS remoto): el frontend pega al proxy `/api/luna-negra/verify-room-invite`.
import { jwtVerify, createRemoteJWKSet } from 'jose';

const AUDIENCE = 'lunanegra:game';

export type VerifiedRoomInvite = {
  gameId: string;
  slug: string;
  roomId: string;
  /** Único npub autorizado a entrar a `roomId`. */
  toNpub: string;
  expiresAt: string | null;
};

// Cache del set de claves remoto (jose ya cachea las claves con TTL/cooldown
// internamente); lo reconstruimos solo si cambia la base URL.
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksBase = '';

function jwksFor(base: string): ReturnType<typeof createRemoteJWKSet> {
  if (!jwksCache || jwksBase !== base) {
    jwksCache = createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`));
    jwksBase = base;
  }
  return jwksCache;
}

/**
 * Verifica un `lnInvite` y devuelve su payload, o `null` si es inválido/expiró o
 * no está firmado por la instancia de Luna Negra configurada.
 */
export async function verifyRoomInvite(token: string): Promise<VerifiedRoomInvite | null> {
  const base = (process.env.LUNA_NEGRA_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!base || !token) return null;
  // Mismo issuer que el resto de los tokens de dev de Luna (LN_ISSUER ?? "luna-negra").
  const issuer = (process.env.LUNA_NEGRA_ISSUER ?? 'luna-negra').trim() || 'luna-negra';
  try {
    const { payload } = await jwtVerify(token, jwksFor(base), { issuer, audience: AUDIENCE });
    if (payload.scope !== 'room-invite') return null;
    const roomId = typeof payload.roomId === 'string' ? payload.roomId : '';
    const toNpub = typeof payload.toNpub === 'string' ? payload.toNpub : '';
    if (!roomId || !toNpub) return null;
    return {
      gameId: typeof payload.gameId === 'string' ? payload.gameId : '',
      slug: typeof payload.slug === 'string' ? payload.slug : '',
      roomId,
      toNpub,
      expiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : null,
    };
  } catch {
    return null;
  }
}
