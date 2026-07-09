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
// los puntajes) — 0 matches, sin error.
//
// ÚNICA fuente de la verdad: la env `gameCoord` (inyectada por Vite en build; el
// prefijo `gameCoord` está habilitado en `envPrefix` de vite.config.ts). No hay
// fallback hardcodeado. Setearla en `.env` y en Vercel con el coord real
// `30023:<tienda-pubkey>:<slug>` (p. ej. tetris-beta → pubkey 7c45df…7df4).
//
// Si falta NO tiramos error en la carga del módulo: eso caería TODA la app (pantalla
// negra) por un coord que sólo usa la capa online (presencia/marcador/reto). Avisamos
// fuerte por consola y dejamos el coord vacío; las funciones que emiten eventos usan
// `requireGameCoord()` para fallar en el punto de uso, sin voltear el juego.
export const TETRA_GAME_COORD: string = (
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.gameCoord ?? ''
).trim();
if (!TETRA_GAME_COORD) {
  console.error(
    '[nostr] Falta gameCoord: la coordenada del juego (30023:<tienda-pubkey>:<slug>) no está seteada. ' +
      'Presencia, marcador y retos NGP quedan deshabilitados hasta configurarla.',
  );
}

/** Devuelve la coordenada del juego o lanza si `gameCoord` no está configurada. */
export function requireGameCoord(): string {
  if (!TETRA_GAME_COORD) {
    throw new Error(
      'Falta gameCoord: seteá la coordenada del juego (30023:<tienda-pubkey>:<slug>) en el entorno.',
    );
  }
  return TETRA_GAME_COORD;
}

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
