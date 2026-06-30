// Lectura del perfil público (kind:0) de un usuario Nostr desde relays. Porteado
// del repo de Luna Negra (src/lib/nostr.ts): el login 2.0 lo usa para resolver
// nombre y avatar a partir de la pubkey del firmante. El juego no escribe nada en
// Nostr acá: solo lee metadata pública.
import { SimplePool } from 'nostr-tools';

// Relays públicos para leer perfil. Mismos que usa Luna Negra (constants.ts) para
// que el nombre/avatar coincidan con lo que muestra la tienda.
export const PROFILE_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

export interface NostrProfile {
  name?: string;
  display_name?: string;
  displayName?: string;
  picture?: string;
  about?: string;
  nip05?: string;
  lud16?: string;
}

let pool: SimplePool | null = null;
function getPool(): SimplePool {
  if (!pool) pool = new SimplePool();
  return pool;
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
    return JSON.parse(newest.content) as NostrProfile;
  } catch {
    return null;
  }
}

export function profileName(p: NostrProfile | null): string | null {
  return p?.displayName || p?.display_name || p?.name || null;
}
