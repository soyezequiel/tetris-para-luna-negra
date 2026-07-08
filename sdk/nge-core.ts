// NGE v2 — NÚCLEO DE PROTOCOLO (puro, compartido cliente ⇄ escrow).
//
// Esta capa es SOLO la gramática del wire NGE: kinds efímeros, parseo de la URI,
// cifrado NIP-44 entre `C` (juego) y `S` (escrow), y los templates SIN firmar de
// cada evento del RPC (request/response/notification). No sabe nada de "cliente"
// ni de "escrow" — ambas puntas la importan y no pueden desincronizarse porque el
// formato del wire vive acá, en un solo lugar. Lo que cambia seguido (ergonomía
// del cliente) vive aparte, en `nge-client.ts`.
//
// Spec: docs/nge/nge-v2-spec.md.
//
// Peer dependency:  npm i nostr-tools
import { getPublicKey, type EventTemplate } from "nostr-tools/pure";
import { nip19, nip44 } from "nostr-tools";

/** Kinds efímeros del RPC (espejo de NWC 23194/23195/23196, rango 20000–29999). */
export const NGE_KIND = { request: 24940, response: 24941, notification: 24942 } as const;
/** Versión de la spec que habla este SDK (la anuncia el escrow en `get_info`).
 *  v1.1 es aditiva: create_bet devuelve el detalle completo, push 24942
 *  (`bet_updated`), RATE_LIMITED + limits, ventana de disputa (settleAt). */
export const NGE_VERSION = "1.1";

export class NgeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "NgeError";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

// ── Parseo de la URI ─────────────────────────────────────────────────────────

export type NgeConnection = {
  /** Pubkey (hex) del escrow `S`: hacia ella se cifra y con ella se verifica toda response. */
  escrowPubkey: string;
  /** Relays de transporte (≥1). */
  relays: string[];
  /** Clave del cliente `C` (bytes): firma los requests, identidad autorizada por el escrow. */
  secretKey: Uint8Array;
  /** Pubkey (hex) del cliente = derivada del `secret`. */
  clientPubkey: string;
};

function decodeSecret(raw: string): Uint8Array {
  const s = raw.trim();
  try {
    if (s.startsWith("nsec")) {
      const d = nip19.decode(s);
      if (d.type !== "nsec") throw new Error();
      return d.data as Uint8Array;
    }
    if (/^[0-9a-f]{64}$/i.test(s)) return Uint8Array.from(Buffer.from(s, "hex"));
  } catch {
    /* cae abajo */
  }
  throw new NgeError("BAD_SECRET", "el `secret` debe ser un nsec o 32 bytes hex");
}

/** Normaliza una pubkey (hex de 64 o npub) a hex minúsculas. Lo usa el parseo de
 *  la URI y el cliente al validar las pubkeys de los asientos. */
export function decodePubkey(raw: string, field: string): string {
  let s = raw.trim();
  if (s.startsWith("npub")) {
    const d = nip19.decode(s);
    if (d.type !== "npub") throw new NgeError("BAD_PUBKEY", `${field} npub inválido`);
    s = d.data as string;
  }
  s = s.toLowerCase();
  if (!HEX64.test(s)) throw new NgeError("BAD_PUBKEY", `${field} debe ser hex de 64 o npub`);
  return s;
}

/**
 * Parsea `nostr+nge://<escrow-pubkey>?relay=…&secret=…`. Los 3 campos son TODO
 * lo que hace falta: la config (límites, fees, métodos) se pide por `get_info`.
 */
export function parseNgeUri(uri: string): NgeConnection {
  let u: URL;
  try {
    u = new URL(uri.trim());
  } catch {
    throw new NgeError("BAD_URI", "URI de conexión inválida");
  }
  if (u.protocol !== "nostr+nge:") {
    throw new NgeError("BAD_URI", "el esquema debe ser nostr+nge://");
  }
  const escrowPubkey = decodePubkey(u.host, "escrow");
  const relays = u.searchParams
    .getAll("relay")
    .map((r) => r.trim())
    .filter(Boolean);
  if (relays.length === 0) throw new NgeError("NO_RELAY", "la URI necesita al menos un `relay`");
  const secretRaw = u.searchParams.get("secret");
  if (!secretRaw) throw new NgeError("NO_SECRET", "la URI necesita `secret`");
  const secretKey = decodeSecret(secretRaw);
  const clientPubkey = getPublicKey(secretKey);
  return { escrowPubkey, relays, secretKey, clientPubkey };
}

// ── Payloads del RPC ─────────────────────────────────────────────────────────

export type NgeRequestPayload = {
  method: string;
  params: Record<string, unknown>;
};

export type NgeErrorBody = { code: string; message: string };

export type NgeResponsePayload = {
  result_type: string;
  result?: Record<string, unknown>;
  error?: NgeErrorBody;
};

// ── Cifrado (NIP-44 entre C y S) ─────────────────────────────────────────────

/** Clave de conversación NIP-44 entre la clave propia y la pubkey del par. */
export function conversationKey(sk: Uint8Array, peerPubkey: string): Uint8Array {
  return nip44.getConversationKey(sk, peerPubkey);
}

/** Cifra un payload JSON hacia el par. `nonce` fijo solo para vectores de test. */
export function encryptPayload(
  payload: unknown,
  sk: Uint8Array,
  peerPubkey: string,
  nonce?: Uint8Array,
): string {
  return nip44.encrypt(JSON.stringify(payload), conversationKey(sk, peerPubkey), nonce);
}

/** Descifra el `content` de un evento del par. Lanza NgeError si no es JSON válido. */
export function decryptPayload(content: string, sk: Uint8Array, peerPubkey: string): unknown {
  let plain: string;
  try {
    plain = nip44.decrypt(content, conversationKey(sk, peerPubkey));
  } catch {
    throw new NgeError("BAD_CIPHERTEXT", "no se pudo descifrar el payload NIP-44");
  }
  try {
    return JSON.parse(plain);
  } catch {
    throw new NgeError("BAD_PAYLOAD", "el payload descifrado no es JSON");
  }
}

// ── Builders puros (sin I/O; los usan el cliente, el escrow y los tests) ─────

const now = () => Math.floor(Date.now() / 1000);

/** Template SIN firmar de un request kind:24940 (lo firma `C`). */
export function requestTemplate(
  payload: NgeRequestPayload,
  cfg: {
    escrowPubkey: string;
    secretKey: Uint8Array;
    createdAt?: number;
    /** Tag opcional ["expiration", ts] (anti-replay complementario, §6). */
    expiresAt?: number;
    /** Nonce NIP-44 fijo (solo vectores de test). */
    nonce?: Uint8Array;
  },
): EventTemplate {
  const tags: string[][] = [["p", cfg.escrowPubkey]];
  if (cfg.expiresAt) tags.push(["expiration", String(cfg.expiresAt)]);
  return {
    kind: NGE_KIND.request,
    created_at: cfg.createdAt ?? now(),
    tags,
    content: encryptPayload(payload, cfg.secretKey, cfg.escrowPubkey, cfg.nonce),
  };
}

/** Template SIN firmar de una response kind:24941 (lo firma `S`; lo usa el escrow). */
export function responseTemplate(
  payload: NgeResponsePayload,
  cfg: {
    clientPubkey: string;
    requestId: string;
    secretKey: Uint8Array;
    createdAt?: number;
    nonce?: Uint8Array;
  },
): EventTemplate {
  return {
    kind: NGE_KIND.response,
    created_at: cfg.createdAt ?? now(),
    tags: [
      ["p", cfg.clientPubkey],
      ["e", cfg.requestId],
    ],
    content: encryptPayload(payload, cfg.secretKey, cfg.clientPubkey, cfg.nonce),
  };
}

/** Payload descifrado de una notification kind:24942 (spec §9, v1.1). */
export type NgeNotificationPayload = {
  notification_type: "bet_updated";
  notification: {
    betId: string;
    /** Estado público al momento del push. NO autoritativo: confirmar con get_bet. */
    status: string;
    /** seatIds con depósito acreditado al momento del push. */
    deposited?: string[];
  };
};

/** Template SIN firmar de una notification kind:24942 (la firma `S`; la usa el
 *  escrow). Sin tag `e`: no responde a ningún request (spec §9). */
export function notificationTemplate(
  payload: NgeNotificationPayload,
  cfg: {
    clientPubkey: string;
    secretKey: Uint8Array;
    createdAt?: number;
    nonce?: Uint8Array;
  },
): EventTemplate {
  return {
    kind: NGE_KIND.notification,
    created_at: cfg.createdAt ?? now(),
    tags: [["p", cfg.clientPubkey]],
    content: encryptPayload(payload, cfg.secretKey, cfg.clientPubkey, cfg.nonce),
  };
}
