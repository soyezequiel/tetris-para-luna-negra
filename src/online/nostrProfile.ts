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

// Cota de espera por consulta: sin `maxWait`, querySync espera el EOSE de TODOS
// los relays (o 4.4s de timeout por relay), y un solo relay lento demora todo.
const PROFILE_MAX_WAIT_MS = 3500;

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
    }, { maxWait: PROFILE_MAX_WAIT_MS });
    if (evs.length === 0) return null;
    const newest = evs.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    return parseProfile(newest.content);
  } catch {
    return null;
  }
}

// Muchos relays limitan cuántos eventos devuelven por suscripción (~500). Si
// pedimos los kind:0 de cientos de follows en un solo filtro, los que sobran se
// pierden y esos amigos quedan sin nombre/avatar. Partimos en lotes chicos.
const PROFILE_BATCH_SIZE = 100;

/**
 * Trae los perfiles de varias pubkeys (para la lista de amigos), en lotes para no
 * chocar con el límite de eventos por suscripción de los relays. Se queda con el
 * kind:0 más reciente por autor. Best-effort: devuelve un mapa (posiblemente
 * parcial) y nunca lanza. `onBatch` (opcional) se dispara al completar cada lote
 * con el mapa acumulado hasta ese momento, para que la UI pueda vestir la lista
 * progresivamente en vez de esperar al lote más lento.
 */
export async function fetchProfiles(
  pubkeys: string[],
  onBatch?: (partial: Map<string, NostrProfile>) => void,
): Promise<Map<string, NostrProfile>> {
  const result = new Map<string, NostrProfile>();
  const unique = [...new Set(pubkeys)].filter((p) => /^[0-9a-f]{64}$/.test(p));
  if (unique.length === 0) return result;

  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += PROFILE_BATCH_SIZE) {
    batches.push(unique.slice(i, i + PROFILE_BATCH_SIZE));
  }

  const newestAt = new Map<string, number>();
  await Promise.all(
    batches.map(async (authors) => {
      try {
        const evs = await getPool().querySync(PROFILE_RELAYS, {
          kinds: [0],
          authors,
        }, { maxWait: PROFILE_MAX_WAIT_MS });
        for (const ev of evs) {
          const prev = newestAt.get(ev.pubkey);
          if (prev !== undefined && ev.created_at <= prev) continue;
          const profile = parseProfile(ev.content);
          if (!profile) continue;
          newestAt.set(ev.pubkey, ev.created_at);
          result.set(ev.pubkey, profile);
        }
        if (evs.length > 0) onBatch?.(result);
      } catch {
        /* relays caídos para este lote: seguimos con los demás */
      }
    }),
  );
  return result;
}

export function profileName(p: NostrProfile | null): string | null {
  return p?.displayName || p?.display_name || p?.name || null;
}
