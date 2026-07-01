// Contactos NIP-02: lee la lista de "seguidos" (kind:3) de un usuario para armar
// la lista de amigos a los que retar. Nativo 2.0: no depende de Luna Negra ni de
// ninguna API, solo de los relays. Best-effort.
import { getPool, PROFILE_RELAYS } from './nostrRelays';

// Cuántos relays extra (del outbox del usuario) sumamos como máximo al buscar su
// kind:3. Acota el fan-out sin dejar afuera la lista real de quien publica en
// relays propios.
const MAX_OUTBOX_RELAYS = 6;

/**
 * Relays donde el usuario publica su propia metadata (kind:0/3/10002), según su
 * lista NIP-65 (kind:10002). Sin esto, un kind:3 que solo vive en el relay de
 * escritura del usuario (modelo outbox) no aparece en los PROFILE_RELAYS y la
 * lista de amigos sale incompleta o vieja. Best-effort: `[]` si no hay lista.
 */
async function fetchOutboxRelays(author: string): Promise<string[]> {
  try {
    const evs = await getPool().querySync(PROFILE_RELAYS, {
      kinds: [10002],
      authors: [author],
    });
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

/**
 * Devuelve las pubkeys (hex) que `pubkey` sigue, según su kind:3 más reciente.
 * El kind:3 es reemplazable: cada relay puede tener una versión distinta, así que
 * consultamos todos y nos quedamos con el `created_at` más alto. Además de los
 * PROFILE_RELAYS sumamos los relays de escritura del propio usuario (NIP-65), por
 * si su lista completa vive ahí (modelo outbox). Devuelve `[]` si el usuario no
 * tiene lista de contactos o los relays no responden.
 */
export async function fetchContacts(pubkey: string): Promise<string[]> {
  const author = pubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(author)) return [];
  try {
    const outbox = await fetchOutboxRelays(author);
    const relays = [...new Set([...PROFILE_RELAYS, ...outbox])];
    const evs = await getPool().querySync(relays, {
      kinds: [3],
      authors: [author],
    });
    if (evs.length === 0) return [];
    const newest = evs.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    const contacts = new Set<string>();
    for (const t of newest.tags) {
      if (t[0] !== 'p') continue;
      const p = (t[1] ?? '').trim().toLowerCase();
      if (/^[0-9a-f]{64}$/.test(p) && p !== author) contacts.add(p);
    }
    return [...contacts];
  } catch {
    return [];
  }
}
