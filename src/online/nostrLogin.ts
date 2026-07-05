// Login Nostr 2.0: produce la MISMA `LunaIdentity` que el SSO 1.0, pero a partir
// de un firmante Nostr en el navegador (NIP-07 / NIP-46 / clave local) en vez del
// `?lnToken=` de la tienda. Así todo lo que cuelga de `lunaState.identity`
// (presencia, amigos, salas, marcadores) sigue funcionando sin cambios.
//
// A diferencia de Luna Negra, acá NO hay challenge/verify contra un server: tetris
// no tiene DB de usuarios, la identidad Nostr se arma client-side. Eso es lo que
// desacopla el login de la tienda.
import { nip19 } from 'nostr-tools';
import type { LunaIdentity } from './protocol';
import { fetchProfile, profileName } from './nostrProfile';
import { setActiveSigner, type LunaSigner, type StoredSigner } from './nostrSigner';

function shortNpub(npub: string): string {
  return npub.length > 12 ? `${npub.slice(0, 8)}…${npub.slice(-4)}` : npub;
}

/**
 * Inicia sesión con el firmante elegido: resuelve la pubkey, deriva el npub y
 * trae nombre/avatar del perfil (kind:0, best-effort). Persiste el firmante para
 * rehidratar la sesión al recargar. Devuelve la identidad lista para
 * `applyLunaIdentity()`.
 *
 * `gameId` queda null: en 2.0 la identidad no viene de la sesión de Luna. Las
 * features que lo requieren (invitar/apostar desde el panel) se habilitan aparte.
 */
export async function loginWithSigner(
  signer: LunaSigner,
  stored: StoredSigner,
): Promise<LunaIdentity> {
  const pubkey = (await signer.getPublicKey()).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    throw new Error('El firmante devolvió una pubkey inválida');
  }
  const npub = nip19.npubEncode(pubkey);

  // Perfil best-effort: si los relays no responden, caemos a un nombre corto
  // derivado del npub y sin avatar. No bloquea el login.
  let name = shortNpub(npub);
  let avatarUrl: string | null = null;
  try {
    const profile = await fetchProfile(pubkey);
    const resolved = profileName(profile);
    if (resolved) name = resolved.slice(0, 18);
    if (profile?.picture) avatarUrl = profile.picture;
  } catch {
    /* sin perfil, usamos el fallback */
  }

  // Recién acá fijamos el firmante activo: si algo falló antes, no dejamos una
  // sesión a medias persistida.
  setActiveSigner(signer, stored);

  return { npub, pubkey, name, avatarUrl, gameId: null };
}
