// Lectura del perfil público (kind:0) de un usuario Nostr desde relays. Porteado
// del repo de Luna Negra (src/lib/nostr.ts): el login 2.0 lo usa para resolver
// nombre y avatar a partir de la pubkey del firmante. El juego no escribe nada en
// Nostr acá: solo lee metadata pública.
import { getPool, PROFILE_RELAYS } from './nostrRelays';

// Re-export para no romper imports existentes que traían PROFILE_RELAYS de acá.
export { PROFILE_RELAYS };

export interface NostrProfile {
  name?: string;
  display_name?: string;
  displayName?: string;
  picture?: string;
  about?: string;
  nip05?: string;
  lud16?: string;
}

function parseProfile(content: string): NostrProfile | null {
  try {
    return JSON.parse(content) as NostrProfile;
  } catch {
    return null;
  }
}

/**
 * Lee el metadata (kind:0) de un usuario desde relays públicos.
 *
 * El kind:0 es reemplazable: cada relay puede tener una versión distinta. Por eso
 * no usamos `pool.get()` (que devuelve el primero que responda, posiblemente
 * viejo), sino `querySync` en todos los relays y nos quedamos con el `created_at`
 * más alto (el más reciente). Best-effort: cualquier fallo devuelve null.
 */
export async function fetchProfile(pubkey: string): Promise<NostrProfile | null> {
  try {
    const evs = await getPool().querySync(PROFILE_RELAYS, {
      kinds: [0],
      authors: [pubkey],
    });
    if (evs.length === 0) return null;
    const newest = evs.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    return parseProfile(newest.content);
  } catch {
    return null;
  }
}

/**
 * Trae los perfiles de varias pubkeys en una sola query (para la lista de amigos).
 * Se queda con el kind:0 más reciente por autor. Best-effort: devuelve un mapa
 * (posiblemente parcial) y nunca lanza.
 */
export async function fetchProfiles(
  pubkeys: string[],
): Promise<Map<string, NostrProfile>> {
  const result = new Map<string, NostrProfile>();
  const unique = [...new Set(pubkeys)].filter((p) => /^[0-9a-f]{64}$/.test(p));
  if (unique.length === 0) return result;
  try {
    const evs = await getPool().querySync(PROFILE_RELAYS, {
      kinds: [0],
      authors: unique,
    });
    const newestAt = new Map<string, number>();
    for (const ev of evs) {
      const prev = newestAt.get(ev.pubkey);
      if (prev !== undefined && ev.created_at <= prev) continue;
      const profile = parseProfile(ev.content);
      if (!profile) continue;
      newestAt.set(ev.pubkey, ev.created_at);
      result.set(ev.pubkey, profile);
    }
  } catch {
    /* relays caídos: devolvemos lo que haya (posiblemente vacío) */
  }
  return result;
}

export function profileName(p: NostrProfile | null): string | null {
  return p?.displayName || p?.display_name || p?.name || null;
}
