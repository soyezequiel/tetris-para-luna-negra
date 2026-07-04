// Contactos NIP-02: lee la lista de "seguidos" (kind:3) de un usuario para armar
// la lista de amigos a los que retar. Nativo 2.0: no depende de Luna Negra ni de
// ninguna API, solo de los relays. Best-effort.
import type { Event } from 'nostr-tools';
import { getPool, PROFILE_RELAYS } from './nostrRelays';

// Cuántos relays extra (del outbox del usuario) sumamos como máximo al buscar su
// kind:3. Acota el fan-out sin dejar afuera la lista real de quien publica en
// relays propios.
const MAX_OUTBOX_RELAYS = 6;

// Cotas de espera por consulta. Sin `maxWait`, querySync espera el EOSE de TODOS
// los relays (o 4.4s de timeout por relay): uno solo lento o caído arrastra la
// lista entera. El camino outbox (10002 → kind:3 en relays desconocidos) usa una
// cota más corta porque corre en paralelo al camino principal y suele ser el que
// cuelga (relays personales apagados).
const CONTACTS_MAX_WAIT_MS = 3000;
const OUTBOX_MAX_WAIT_MS = 2000;

/**
 * Relays donde el usuario publica su propia metadata (kind:0/3/10002), según su
 * lista NIP-65 (kind:10002). Sin esto, un kind:3 que solo vive en el relay de
 * escritura del usuario (modelo outbox) no aparece en los PROFILE_RELAYS y la
 * lista de amigos sale incompleta o vieja. Best-effort: `[]` si no hay lista.
 */
async function fetchOutboxRelays(author: string): Promise<string[]> {
  try {
    const evs = await getPool().querySync(
      PROFILE_RELAYS,
      { kinds: [10002], authors: [author] },
      { maxWait: OUTBOX_MAX_WAIT_MS },
    );
    if (evs.length === 0) return [];
    const newest = evs.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    const relays: string[] = [];
    for (const t of newest.tags) {
      // ['r', <url>, ('read' | 'write')?]. Nos quedamos con los de ESCRITURA (o
      // los sin marcar, que valen para ambos): ahí publica su kind:3.
      if (t[0] !== 'r' || typeof t[1] !== 'string') continue;
      const marker = t[2];
      if (marker === 'read') continue;
      const url = t[1].trim();
      if (url.startsWith('wss://') || url.startsWith('ws://')) relays.push(url);
      if (relays.length >= MAX_OUTBOX_RELAYS) break;
    }
    return relays;
  } catch {
    return [];
  }
}

async function queryContactEvents(
  relays: string[],
  author: string,
  maxWait: number,
): Promise<Event[]> {
  try {
    return await getPool().querySync(
      relays,
      { kinds: [3], authors: [author] },
      { maxWait },
    );
  } catch {
    return [];
  }
}

// Compara URLs de relay ignorando mayúsculas y la barra final, para no repetir
// la consulta en un relay que ya cubren los PROFILE_RELAYS.
function normalizeRelayUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * Devuelve las pubkeys (hex) que `pubkey` sigue, según su kind:3 más reciente.
 * El kind:3 es reemplazable: cada relay puede tener una versión distinta, así que
 * consultamos todos y nos quedamos con el `created_at` más alto. Además de los
 * PROFILE_RELAYS sumamos los relays de escritura del propio usuario (NIP-65), por
 * si su lista completa vive ahí (modelo outbox). Los dos caminos corren EN
 * PARALELO (antes eran secuenciales y sumaban sus latencias). Devuelve `[]` si el
 * usuario no tiene lista de contactos o los relays no responden.
 */
export async function fetchContacts(pubkey: string): Promise<string[]> {
  const author = pubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(author)) return [];
  const knownRelays = new Set(PROFILE_RELAYS.map(normalizeRelayUrl));
  const direct = queryContactEvents(PROFILE_RELAYS, author, CONTACTS_MAX_WAIT_MS);
  const viaOutbox = (async (): Promise<Event[]> => {
    const outbox = await fetchOutboxRelays(author);
    const extra = outbox.filter((url) => !knownRelays.has(normalizeRelayUrl(url)));
    if (extra.length === 0) return [];
    return queryContactEvents(extra, author, OUTBOX_MAX_WAIT_MS);
  })();
  const evs = (await Promise.all([direct, viaOutbox])).flat();
  if (evs.length === 0) return [];
  const newest = evs.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  const contacts = new Set<string>();
  for (const t of newest.tags) {
    if (t[0] !== 'p') continue;
    const p = (t[1] ?? '').trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(p) && p !== author) contacts.add(p);
  }
  return [...contacts];
}
