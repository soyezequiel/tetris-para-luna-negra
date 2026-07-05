// Reto/invitación 1v1 por NIP-17 (gift-wrap). En la 2.0 de Luna Negra la
// invitación a jugar ES el reto: un DM cifrado de extremo a extremo que apunta a
// una sala de TETRA (por su link `?join=`), sin token de acceso ni paso por la
// tienda. Ver la skill `integrar-luna-negra` §5 / interfaz 2.0.
//
// Construimos los tres sobres NIP-17 (rumor kind:14 → seal kind:13 → gift-wrap
// kind:1059) A MANO sobre la abstracción `LunaSigner`, porque los helpers
// `nip17`/`nip59` de nostr-tools exigen la clave privada cruda y nuestro firmante
// (NIP-07 extensión / NIP-46 bunker) no la expone. El firmante sí ofrece
// nip44Encrypt/Decrypt + signEvent; la capa externa del gift-wrap usa una clave
// EFÍMERA local (así el server no puede correlacionar quién le escribe a quién).
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  nip19,
  nip44,
  type Event,
} from 'nostr-tools';
import type { LunaSigner } from './nostrSigner';
import { DM_RELAYS, getPool, randomizedTimestamp } from './nostrRelays';

// Coordenada real del juego en Luna Negra: `30023:<tienda-pubkey>:<slug>`, la
// dirección del listado kind:30023 que publica la tienda (verificado en relays:
// #d="tetra-tetris-copia" → pubkey ed13c4…cc4d3, título "Tetra (Pre-alfa)").
//
// El reto (§5) sólo la usa de ETIQUETA (lo accionable es el `url`), pero la
// presencia NIP-38 (§3 2.0) la pone en el tag `a` y Luna Negra filtra los
// kind:30315 por ESE coord exacto: si no coincide, no detecta "Jugando TETRA".
// Por eso el fallback debe ser el coord real, no un placeholder. Override por env
// (VITE_TETRA_GAME_COORD) para self-hosts o si se re-publica bajo otra tienda.
const TETRA_GAME_COORD_FALLBACK =
  '30023:ed13c471be6bff9195a6261d8cbd6c7ab6efe79a7947b208d2b6f066b99cc4d3:tetra-tetris-copia';
export const TETRA_GAME_COORD: string =
  ((import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_TETRA_GAME_COORD ?? '').trim() || TETRA_GAME_COORD_FALLBACK;

const RUMOR_KIND = 14;
const SEAL_KIND = 13;
const GIFT_WRAP_KIND = 1059;
const DEFAULT_TTL_SEC = 60 * 60; // 1h

export interface ChallengeInput {
  /** pubkey (hex) del amigo al que retás. */
  toPubkey: string;
  /** id de la sala online de TETRA donde se juega. */
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
  signer: LunaSigner,
  rumor: unknown,
  sealTo: string,
  wrapTo: string,
): Promise<Event> {
  // seal kind:13: cifra el rumor hacia `sealTo` y lo firma MI clave.
  const sealContent = await signer.nip44Encrypt!(sealTo, JSON.stringify(rumor));
  const seal = await signer.signEvent({
    kind: SEAL_KIND,
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
      kind: GIFT_WRAP_KIND,
      created_at: randomizedTimestamp(),
      tags: [['p', wrapTo]],
      content: wrapContent,
    },
    ephemeralSk,
  );
}

/**
 * Arma los DOS gift-wrap NIP-17 de un reto: el del `recipient` (destinatario) y la
 * `selfCopy` (auto-copia para MI propio historial, para poder ver en Luna / otros
 * clientes el reto que mandé). Ambos envuelven el MISMO rumor kind:14. Lanza si el
 * firmante no soporta NIP-44.
 */
export async function buildChallengeGiftWraps(
  signer: LunaSigner,
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
    kind: RUMOR_KIND,
    pubkey: myPubkey,
    created_at: nowSec,
    tags: [
      ['p', toPubkey],
      ['game', TETRA_GAME_COORD],
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

/**
 * Arma el gift-wrap NIP-17 (kind:1059) del destinatario, listo para publicar. Lanza
 * si el firmante no soporta NIP-44. (Para incluir la auto-copia del emisor, usá
 * `buildChallengeGiftWraps`.)
 */
export async function buildChallengeGiftWrap(
  signer: LunaSigner,
  input: ChallengeInput,
): Promise<Event> {
  return (await buildChallengeGiftWraps(signer, input)).recipient;
}

interface ParseOptions {
  /**
   * Si se pasa, se exige que el `url` del reto sea del mismo origin (seguridad:
   * no navegamos a orígenes ajenos). En el navegador pasá `window.location.origin`.
   */
  origin?: string | null;
}

/**
 * Desarma un gift-wrap NIP-17 entrante y devuelve el reto, o `null` si no es un
 * reto válido/para nosotros/vigente. Best-effort: nunca lanza.
 */
export async function parseChallengeGiftWrap(
  signer: LunaSigner,
  giftWrap: Event,
  options: ParseOptions = {},
): Promise<ParsedChallenge | null> {
  try {
    if (giftWrap.kind !== GIFT_WRAP_KIND || !signer.nip44Decrypt) return null;

    // Capa externa: conversación entre mi clave y la efímera (giftWrap.pubkey).
    const seal = JSON.parse(
      await signer.nip44Decrypt(giftWrap.pubkey, giftWrap.content),
    ) as Event;
    if (!seal || seal.kind !== SEAL_KIND || typeof seal.pubkey !== 'string') {
      return null;
    }

    // Capa interna: el seal lo firmó el remitente; su content cifra el rumor.
    const rumor = JSON.parse(
      await signer.nip44Decrypt(seal.pubkey, seal.content),
    ) as Event & { id?: string };
    if (!rumor || rumor.kind !== RUMOR_KIND) return null;

    // Chequeo de seguridad NIP-59: el autor del rumor DEBE ser quien firmó el seal
    // (si no, alguien podría suplantar el remitente).
    if (rumor.pubkey !== seal.pubkey) return null;

    const tags = Array.isArray(rumor.tags) ? (rumor.tags as string[][]) : [];
    const tag = (k: string): string | null =>
      tags.find((t) => t[0] === k)?.[1] ?? null;

    const joinUrl = tag('url');
    if (!joinUrl) return null;
    const game = tag('game');
    if (game && game !== TETRA_GAME_COORD) return null;

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
      kinds: [10050],
      authors: [pubkey.trim().toLowerCase()],
    });
    if (evs.length > 0) {
      const newest = evs.reduce((a, b) => (b.created_at > a.created_at ? b : a));
      for (const t of newest.tags) {
        if (t[0] === 'relay' && typeof t[1] === 'string') relays.add(t[1]);
      }
    }
  } catch {
    /* sin lista propia: usamos solo el fallback */
  }
  return [...relays];
}
