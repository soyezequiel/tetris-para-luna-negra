// PUERTO del reto 1v1 NIP-17 — la frontera protocolo↔juego. La gramática de los
// sobres (rumor kind:14 → seal kind:13 → gift-wrap kind:1059) vive en la capa
// protocolo `sdk/ngp.ts`; acá quedan las cosas del PROGRAMA: la coordenada real
// del juego (env), el pool de relays y la publicación/descubrimiento de inboxes.
// El resto del juego (main, inbox, presencia, marcador) importa de ACÁ, nunca del
// SDK. Ver la skill `integrar-luna-negra` §5 / interfaz 2.0.
import type { Event } from 'nostr-tools';
import type { LunaSigner } from './nostrSigner';
import { DM_RELAYS, getPool } from './nostrRelays';
import {
  buildChallengeGiftWraps as ngpBuildChallengeGiftWraps,
  parseChallengeGiftWrap as ngpParseChallengeGiftWrap,
  dmRelaysFromInboxEvent,
  NGP_KIND,
  type ChallengeInput,
  type ParsedChallenge,
  type ParseChallengeOptions,
} from '../../sdk/ngp.js';

export type { ChallengeInput, ParsedChallenge };

// Coordenada real del juego en Luna Negra: `30023:<tienda-pubkey>:<slug>`, la
// dirección del listado kind:30023 que publica la tienda (verificado en relays y en
// la DB de prod: #d="tetris-beta" → pubkey ed13c4…cc4d3).
//
// El reto (§5) sólo la usa de ETIQUETA (lo accionable es el `url`), pero la presencia
// NIP-38 (§3 2.0) y el marcador (kind:31337) la ponen en el tag `a`, y Luna Negra
// filtra por ESE coord exacto: si no coincide, no detecta nada (ni "Jugando TETRA" ni
// los puntajes) — 0 matches, sin error. Por eso el fallback debe ser el coord real, no
// un placeholder ni un slug viejo. Override por env (VITE_TETRA_GAME_COORD) para
// self-hosts o si se re-publica bajo otra tienda/slug.
//
// ⚠️ Si la tienda re-publica el juego con otro slug, ESTE valor queda viejo y Luna deja
// de detectar la actividad 2.0 (pasó con el slug anterior `tetra-tetris-copia`).
const TETRA_GAME_COORD_FALLBACK =
  '30023:ed13c471be6bff9195a6261d8cbd6c7ab6efe79a7947b208d2b6f066b99cc4d3:tetris-beta';
export const TETRA_GAME_COORD: string =
  ((import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_TETRA_GAME_COORD ?? '').trim() || TETRA_GAME_COORD_FALLBACK;

/**
 * Arma los DOS gift-wrap NIP-17 de un reto (destinatario + auto-copia del emisor),
 * anclados a la coordenada de TETRA. Lanza si el firmante no soporta NIP-44.
 */
export async function buildChallengeGiftWraps(
  signer: LunaSigner,
  input: ChallengeInput,
): Promise<{ recipient: Event; selfCopy: Event }> {
  return ngpBuildChallengeGiftWraps(signer, TETRA_GAME_COORD, input);
}

/**
 * Arma el gift-wrap NIP-17 (kind:1059) del destinatario, listo para publicar.
 * (Para incluir la auto-copia del emisor, usá `buildChallengeGiftWraps`.)
 */
export async function buildChallengeGiftWrap(
  signer: LunaSigner,
  input: ChallengeInput,
): Promise<Event> {
  return (await buildChallengeGiftWraps(signer, input)).recipient;
}

/**
 * Desarma un gift-wrap NIP-17 entrante y devuelve el reto, o `null` si no es un
 * reto válido/para nosotros/vigente/de TETRA. Best-effort: nunca lanza.
 */
export async function parseChallengeGiftWrap(
  signer: LunaSigner,
  giftWrap: Event,
  options: ParseChallengeOptions = {},
): Promise<ParsedChallenge | null> {
  return ngpParseChallengeGiftWrap(signer, TETRA_GAME_COORD, giftWrap, options);
}

/**
 * Publica el gift-wrap en los relays de DM del destinatario (kind:10050, si los
 * publicó) unidos a un set por defecto. Best-effort: no lanza si los relays fallan.
 */
export async function publishChallenge(
  giftWrap: Event,
  toPubkey: string,
): Promise<boolean> {
  const relays = await resolveDmInboxRelays(toPubkey);
  try {
    await Promise.any(getPool().publish(relays, giftWrap));
    return true;
  } catch {
    /* ningún relay aceptó: el reto no llegó (el llamador puede avisar) */
    return false;
  }
}

/**
 * Lee la lista NIP-17 de relays de DM de un pubkey (kind:10050) unida al fallback
 * `DM_RELAYS`. La usan LOS DOS lados y por eso debe ser simétrica: el emisor publica
 * el reto acá, y el receptor DEBE escuchar acá también, o el reto llega a un relay
 * que el destinatario nunca lee (bug de invitación que no aparece). Best-effort.
 */
export async function resolveDmInboxRelays(pubkey: string): Promise<string[]> {
  const relays = new Set(DM_RELAYS);
  try {
    const evs = await getPool().querySync(DM_RELAYS, {
      kinds: [NGP_KIND.dmInboxRelays],
      authors: [pubkey.trim().toLowerCase()],
    });
    if (evs.length > 0) {
      const newest = evs.reduce((a, b) => (b.created_at > a.created_at ? b : a));
      for (const r of dmRelaysFromInboxEvent(newest)) relays.add(r);
    }
  } catch {
    /* sin lista propia: usamos solo el fallback */
  }
  return [...relays];
}
