// Contactos NIP-02: lee la lista de "seguidos" (kind:3) de un usuario para armar
// la lista de amigos a los que retar. Nativo 2.0: no depende de Luna Negra ni de
// ninguna API, solo de los relays. Best-effort.
import { getPool, PROFILE_RELAYS } from './nostrRelays';

/**
 * Devuelve las pubkeys (hex) que `pubkey` sigue, según su kind:3 más reciente.
 * El kind:3 es reemplazable: cada relay puede tener una versión distinta, así que
 * consultamos todos y nos quedamos con el `created_at` más alto. Devuelve `[]` si
 * el usuario no tiene lista de contactos o los relays no responden.
 */
export async function fetchContacts(pubkey: string): Promise<string[]> {
  const author = pubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(author)) return [];
  try {
    const evs = await getPool().querySync(PROFILE_RELAYS, {
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
