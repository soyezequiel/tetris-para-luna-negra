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
import {
  setActiveSigner,
  setTransientSigner,
  type LunaSigner,
  type StoredSigner,
} from './nostrSigner';

function shortNpub(npub: string): string {
  return npub.length > 12 ? `${npub.slice(0, 8)}…${npub.slice(-4)}` : npub;
}

/**
 * Inicia sesión con el firmante elegido: resuelve la pubkey, deriva el npub y
 * activa el signer inmediatamente. El perfil kind:0 se hidrata aparte para que
 * los relays lentos no agreguen hasta 3,5 segundos al ingreso.
 *
 * `gameId` queda null: en 2.0 la identidad no viene de la sesión de Luna. Las
 * features que lo requieren (invitar/apostar desde el panel) se habilitan aparte.
 */
export async function loginWithSigner(
  signer: LunaSigner,
  stored: StoredSigner | null,
  knownPubkey?: string,
): Promise<LunaIdentity> {
  const pubkey = (knownPubkey ?? await signer.getPublicKey()).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    throw new Error('El firmante devolvió una pubkey inválida');
  }
  const npub = nip19.npubEncode(pubkey);

  // Fijamos el firmante apenas la pubkey es válida. No esperamos ningún relay.
  if (stored) setActiveSigner(signer, stored);
  else setTransientSigner(signer);

  return { npub, pubkey, name: shortNpub(npub), avatarUrl: null, gameId: null };
}

/** Completa nombre/avatar en segundo plano sin bloquear el inicio de sesión. */
export async function hydrateIdentityProfile(identity: LunaIdentity): Promise<LunaIdentity> {
  if (!identity.pubkey) return identity;
  try {
    const profile = await fetchProfile(identity.pubkey);
    const resolved = profileName(profile);
    return {
      ...identity,
      name: resolved ? resolved.slice(0, 18) : identity.name,
      avatarUrl: profile?.picture || identity.avatarUrl,
    };
  } catch {
    return identity;
  }
}
