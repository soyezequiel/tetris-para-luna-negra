// CAPA PROTOCOLO NGP (Nostr Games Protocol) — la punta del JUEGO.
//
// La gramática del wire (kinds, templates sin firmar, parsers) vive en
// `sdk/ngp-core.ts`, copia byte-idéntica del núcleo canónico de Luna Negra
// (se sincroniza con scripts/sync-nge-core.mjs de aquel repo). Acá queda lo que
// solo el juego necesita: la interfaz de firma `NgpSigner` (estructuralmente
// compatible con `LunaSigner`), los wrappers que firman los templates del core
// (presencia NIP-38, marcador 31337) y el reto 1v1 por NIP-17 (gift-wrap),
// que es juego↔juego y no lo habla la tienda.
//
// Este directorio (`sdk/`) es protocolo y NADA más: cero imports del juego, cero
// `import.meta.env`, cero relays/pools. Todo lo contextual entra por parámetro
// (la coordenada del juego, el mensaje de presencia, el TTL). Los únicos módulos
// del juego que importan de acá son los puertos `src/online/nostr*.ts`; el resto
// del programa habla con esos puertos.
//
// Spec: skill `integrar-luna-negra` (interfaz 2.0) y, del lado tienda,
// docs/nostr-games-protocol.md de Luna Negra.
//
// Peer dependency:  npm i nostr-tools
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  nip19,
  nip44,
  type Event,
  type EventTemplate,
} from 'nostr-tools';
import {
  NGP_KIND,
  buildPresenceTemplate,
  buildPresenceClearTemplate,
  buildScoreTemplate,
} from './ngp-core.js';

// Re-exporta el núcleo entero: los consumidores siguen importando todo de acá.
export * from './ngp-core.js';

/**
 * Firmante mínimo que requiere el protocolo. `LunaSigner` (NIP-07 extensión /
 * NIP-46 bunker / clave local) lo satisface estructuralmente; el protocolo no
 * conoce esas implementaciones.
 */
export interface NgpSigner {
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<Event>;
  nip44Encrypt?(peerPubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt?(peerPubkey: string, ciphertext: string): Promise<string>;
}

// NIP-59: los sobres (seal y gift-wrap) llevan `created_at` aleatorizado hacia
// atrás (hasta 2 días) para no filtrar el momento real en que se armó el reto.
const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;

export function randomizedTimestamp(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec - Math.floor(Math.random() * TWO_DAYS_SECONDS);
}

// ── Reto 1v1 por NIP-17 (gift-wrap) ──────────────────────────────────────────

const DEFAULT_TTL_SEC = 60 * 60; // 1h

export interface ChallengeInput {
  /** pubkey (hex) del amigo al que retás. */
  toPubkey: string;
  /** id de la sala online donde se juega. */
  roomId: string;
  /** link `?join=<sala>` con el que el amigo entra a la sala. */
  joinUrl: string;
  /** texto del reto (aparece en el DM / toast). */
  message: string;
  /** vencimiento del reto en segundos (default 1h). */
  ttlSec?: number;
}

export interface ParsedChallenge {
  fromPubkey: string;
  fromNpub: string;
  roomId: string | null;
  joinUrl: string;
  game: string | null;
  message: string;
  createdAt: number | null;
  expiresAt: number | null;
  giftWrapId: string;
  rumorId: string | null;
}

/**
 * Sella un rumor hacia `sealTo` (cifrado NIP-44, firmado por MI clave) y lo envuelve
 * en un gift-wrap kind:1059 con clave EFÍMERA hacia `wrapTo`. Para el destinatario,
 * `sealTo` = `wrapTo` = él; para la auto-copia del emisor, ambos = yo.
 */
async function sealAndWrap(
  signer: NgpSigner,
  rumor: unknown,
  sealTo: string,
  wrapTo: string,
): Promise<Event> {
  // seal kind:13: cifra el rumor hacia `sealTo` y lo firma MI clave.
  const sealContent = await signer.nip44Encrypt!(sealTo, JSON.stringify(rumor));
  const seal = await signer.signEvent({
    kind: NGP_KIND.seal,
    created_at: randomizedTimestamp(),
    tags: [],
    content: sealContent,
  });

  // gift-wrap kind:1059: cifra el seal con una clave efímera hacia `wrapTo`.
  const ephemeralSk = generateSecretKey();
  const wrapContent = nip44.encrypt(
    JSON.stringify(seal),
    nip44.getConversationKey(ephemeralSk, wrapTo),
  );
  return finalizeEvent(
    {
      kind: NGP_KIND.giftWrap,
      created_at: randomizedTimestamp(),
      tags: [['p', wrapTo]],
      content: wrapContent,
    },
    ephemeralSk,
  );
}

/**
 * Arma los DOS gift-wrap NIP-17 de un reto: el del `recipient` (destinatario) y la
 * `selfCopy` (auto-copia para MI propio historial). Ambos envuelven el MISMO rumor
 * kind:14, anclado al juego con el tag `game`=<coordenada NIP-23>. Lanza si el
 * firmante no soporta NIP-44.
 */
export async function buildChallengeGiftWraps(
  signer: NgpSigner,
  gameCoord: string,
  input: ChallengeInput,
): Promise<{ recipient: Event; selfCopy: Event }> {
  if (!signer.nip44Encrypt) {
    throw new Error('Tu firmante no soporta NIP-44 (necesario para retos cifrados).');
  }
  const myPubkey = (await signer.getPublicKey()).trim().toLowerCase();
  const toPubkey = input.toPubkey.trim().toLowerCase();
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + (input.ttlSec ?? DEFAULT_TTL_SEC);

  // rumor kind:14 (sin firmar; lleva id pero no sig, por NIP-59). Uno solo para
  // ambas copias, así el reto que ve el destinatario y el que veo yo son el mismo.
  const rumorBase = {
    kind: NGP_KIND.rumor,
    pubkey: myPubkey,
    created_at: nowSec,
    tags: [
      ['p', toPubkey],
      ['game', gameCoord],
      ['room', input.roomId],
      ['url', input.joinUrl],
      ['expiration', String(expiresAt)],
    ],
    content: input.message,
  };
  const rumor = { ...rumorBase, id: getEventHash(rumorBase) };

  const recipient = await sealAndWrap(signer, rumor, toPubkey, toPubkey);
  const selfCopy = await sealAndWrap(signer, rumor, myPubkey, myPubkey);
  return { recipient, selfCopy };
}

export interface ParseChallengeOptions {
  /**
   * Si se pasa, se exige que el `url` del reto sea del mismo origin (seguridad:
   * no navegamos a orígenes ajenos). En el navegador pasá `window.location.origin`.
   */
  origin?: string | null;
}

/**
 * Desarma un gift-wrap NIP-17 entrante y devuelve el reto, o `null` si no es un
 * reto válido/para nosotros/vigente o si su `game` no coincide con `gameCoord`.
 * Best-effort: nunca lanza.
 */
export async function parseChallengeGiftWrap(
  signer: NgpSigner,
  gameCoord: string,
  giftWrap: Event,
  options: ParseChallengeOptions = {},
): Promise<ParsedChallenge | null> {
  try {
    if (giftWrap.kind !== NGP_KIND.giftWrap || !signer.nip44Decrypt) return null;

    // Capa externa: conversación entre mi clave y la efímera (giftWrap.pubkey).
    const seal = JSON.parse(
      await signer.nip44Decrypt(giftWrap.pubkey, giftWrap.content),
    ) as Event;
    if (!seal || seal.kind !== NGP_KIND.seal || typeof seal.pubkey !== 'string') {
      return null;
    }

    // Capa interna: el seal lo firmó el remitente; su content cifra el rumor.
    const rumor = JSON.parse(
      await signer.nip44Decrypt(seal.pubkey, seal.content),
    ) as Event & { id?: string };
    if (!rumor || rumor.kind !== NGP_KIND.rumor) return null;

    // Chequeo de seguridad NIP-59: el autor del rumor DEBE ser quien firmó el seal
    // (si no, alguien podría suplantar el remitente).
    if (rumor.pubkey !== seal.pubkey) return null;

    const tags = Array.isArray(rumor.tags) ? (rumor.tags as string[][]) : [];
    const tag = (k: string): string | null =>
      tags.find((t) => t[0] === k)?.[1] ?? null;

    const joinUrl = tag('url');
    if (!joinUrl) return null;
    const game = tag('game');
    if (game && game !== gameCoord) return null;

    const expStr = tag('expiration');
    const expiresAt = expStr ? Number(expStr) : null;
    if (
      expiresAt !== null &&
      Number.isFinite(expiresAt) &&
      expiresAt * 1000 <= Date.now()
    ) {
      return null; // reto vencido
    }

    if (options.origin && !isSameOrigin(joinUrl, options.origin)) return null;

    return {
      fromPubkey: seal.pubkey,
      fromNpub: nip19.npubEncode(seal.pubkey),
      roomId: tag('room'),
      joinUrl,
      game,
      message: typeof rumor.content === 'string' ? rumor.content : '',
      createdAt: typeof rumor.created_at === 'number' ? rumor.created_at : null,
      expiresAt: expiresAt !== null && Number.isFinite(expiresAt) ? expiresAt : null,
      giftWrapId: giftWrap.id,
      rumorId: typeof rumor.id === 'string' ? rumor.id : null,
    };
  } catch {
    return null;
  }
}

function isSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Extrae los relays de DM de una lista NIP-17 (kind:10050) ya levantada de relays.
 * El QUERY es del puerto (I/O); esta función solo entiende el formato del evento.
 */
export function dmRelaysFromInboxEvent(ev: Event | null | undefined): string[] {
  if (!ev || ev.kind !== NGP_KIND.dmInboxRelays) return [];
  const relays: string[] = [];
  for (const t of ev.tags) {
    if (t[0] === 'relay' && typeof t[1] === 'string' && t[1]) relays.push(t[1]);
  }
  return relays;
}

// ── Presencia NIP-38 (kind:30315) — firma sobre el template del core ────────

/**
 * Firma el evento de presencia NIP-38 (kind:30315). El formato (ancla `a`,
 * `d`="general", expiración NIP-40) vive en el core; `message` es la copy
 * visible ("Jugando TETRA") — la decide el juego, no el protocolo. No publica:
 * sólo firma.
 */
export async function buildPresenceEvent(
  signer: NgpSigner,
  p: { gameCoord: string; message: string; ttlSec: number },
): Promise<Event> {
  return signer.signEvent(buildPresenceTemplate(p));
}

/**
 * Firma el evento que LIMPIA la presencia (NIP-38: content vacío + expiración
 * inmediata), para que "Jugando X" desaparezca ya al cerrar sesión.
 */
export async function buildPresenceClearEvent(signer: NgpSigner): Promise<Event> {
  return signer.signEvent(buildPresenceClearTemplate());
}

// ── Marcador NGP (kind:31337) — firma sobre el template del core ─────────────

/**
 * Firma el evento de puntaje NGP (kind:31337). El formato (ancla `a`, `d` por
 * tabla, clamp del puntaje, gramática del board) vive en el core. ⚠️ Lo firma el
 * CLIENTE del jugador: es falsificable — sirve para rankings sociales, nunca
 * para repartir dinero. No publica: sólo firma. Lanza si el board o el puntaje
 * son inválidos.
 */
export async function buildScoreEvent(
  signer: NgpSigner,
  p: { gameCoord: string; board: string; score: number; client?: string },
): Promise<Event> {
  return signer.signEvent(buildScoreTemplate(p));
}
