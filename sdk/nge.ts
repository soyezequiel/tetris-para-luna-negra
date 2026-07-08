// SDK NGE v2 (Nostr Game Escrow) — la "NWC del escrow".
//
// Protocolo request/response (RPC) calcado de NWC/NIP-47: el juego (cliente `C`,
// el `secret` de la URI) le habla al escrow (`S`, el host de la URI) por eventos
// Nostr EFÍMEROS cifrados con NIP-44. El relay es un caño tonto; la fuente de
// verdad vive en el escrow y se consulta con `get_bet` (polling).
//
// El dev pega UN string en `NGE_CONNECTION` y ya puede crear apuestas, cobrar
// depósitos por bolt11, consultar estado y reportar el ganador. Sin API key, sin
// `bind` event: la config se pide por RPC (`get_info`). NGE es SOLO el canal de
// coordinación (privado): la liquidación pública (contrato, estado 31340,
// resultado 1341, payouts) es una capacidad del ESCROW que éste declara en
// `get_info.transparency` — su formato vive en NGP, no acá.
// Spec: docs/nge/nge-v2-spec.md.
//
// Entrega sobre relay efímero (§6.1 de la spec): si el escrow está offline el
// mensaje se pierde, así que el cliente REENVÍA EL MISMO evento firmado hasta
// recibir la response o agotar el timeout. El escrow deduplica por id y cachea
// la response, así que reenviar nunca duplica efectos.
//
// Peer dependency:  npm i nostr-tools
import {
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  type Event,
  type EventTemplate,
} from "nostr-tools/pure";
import { SimplePool, nip19, nip44, type Filter } from "nostr-tools";

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

function decodePubkey(raw: string, field: string): string {
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

// ── Transporte de relays (inyectable → testeable sin red) ───────────────────

export interface NgeTransport {
  publish(event: Event): Promise<void>;
  subscribe(filter: Filter, onEvent: (e: Event) => void): () => void;
  close(): void;
}

/** Transporte por defecto sobre SimplePool. Pool fresco por conexión (los sockets
 *  se congelan entre invocaciones serverless). */
export function poolTransport(relays: string[]): NgeTransport {
  const pool = new SimplePool();
  return {
    // First-ack: con que UN relay acepte, el evento viaja — esperar a todos
    // hace que el más lento mande la latencia del RPC. El resto sigue en
    // background. Falla solo si NINGUNO aceptó.
    publish(ev) {
      const pubs = pool.publish(relays, ev).map((p) => p.then(() => true, () => false));
      return new Promise<void>((resolve, reject) => {
        let pending = pubs.length;
        if (pending === 0) {
          return reject(new NgeError("PUBLISH_FAILED", "ningún relay aceptó el evento"));
        }
        for (const p of pubs) {
          void p.then((ok) => {
            if (ok) resolve();
            if (--pending === 0) {
              reject(new NgeError("PUBLISH_FAILED", "ningún relay aceptó el evento"));
            }
          });
        }
      });
    },
    subscribe(filter, onEvent) {
      const sub = pool.subscribeMany(relays, filter, { onevent: onEvent });
      return () => sub.close();
    },
    close() {
      pool.close(relays);
    },
  };
}

// ── Tipos de la API ──────────────────────────────────────────────────────────

export type NgeSeatInput = {
  /** Id estable que asigna el juego (una pubkey o lo que sea). */
  seatId: string;
  /** Pubkey Nostr del jugador (hex o npub), opcional: habilita el payout social. */
  pubkey?: string;
  /** Dirección Lightning (lud16) de cobro, opcional: payout LNURL directo. */
  payoutAddress?: string;
};

export type NgeCreateBetInput = {
  seats: NgeSeatInput[];
  /** Sats POR ASIENTO (entero); el pozo objetivo es stake × asientos. */
  stakeSats: number;
  /** Texto humano de la condición de victoria. */
  condition?: string;
  /** Unix absoluto del límite de fondeo (opcional; el escrow tiene default). */
  deadlineSec?: number;
  /** Clave de idempotencia del juego (§6.1): reintentar con el mismo `clientRef`
   *  devuelve el MISMO betId, nunca crea otra apuesta. */
  clientRef?: string;
  /** Sala/partida del juego (correlación y display en el escrow). Opaco. */
  roomId?: string;
  /**
   * Visibilidad de la liquidación pública (si el escrow la soporta, ver
   * `get_info.visibilityOptions`): "public" (default) publica la sombra de estado
   * y la liquidación en Nostr; "unlisted" omite la sombra 31340 y la nota social
   * (el contrato-ancla y los recibos de pago existen igual: son el riel del escrow).
   */
  visibility?: "public" | "unlisted";
};

export type NgeDeposit = {
  seatId: string;
  /** Invoice a pagar por el jugador del asiento (null si ya pagó o no se pudo emitir). */
  bolt11: string | null;
  amountSats: number;
  /** Unix del vencimiento del handle (el deadline de fondeo). */
  expiresAt: number | null;
};

export type NgeInfo = {
  methods: string[];
  version: string;
  currency: "sat";
  minStakeSats: number;
  maxStakeSats: number;
  feePct: number;
  devFeePct: number;
  /**
   * Capacidad declarada del escrow (no del canal): "public" = liquida en Nostr
   * con eventos públicos auditables (formato NGP: contrato + 31340 + 1341 +
   * 9735); "none" = solo coordinación privada, sin rastro público.
   */
  transparency?: "public" | "none";
  /** Modos de visibilidad por-apuesta que acepta `create_bet.visibility`. */
  visibilityOptions?: string[];
  /** Piso de comisión en sats (v1.1; para que `auditSettlement` no adivine). */
  feeMinSats?: number;
  /** Tipos de notification 24942 que emite el escrow (v1.1). Ausente = solo polling. */
  notifications?: string[];
  /** Límites de uso por credencial (v1.1); excederlos → error RATE_LIMITED. */
  limits?: { createBetPerMin?: number; maxPendingBets?: number };
  /** Ventana de disputa (v1.1, spec §7.1): con pozo ≥ `settleDelayMinPotSats`,
   *  el payout se difiere `settleDelaySec` tras report_result. 0/ausente = inmediato. */
  settleDelaySec?: number;
  settleDelayMinPotSats?: number;
};

export type NgePayout = {
  /** Cascada §8: `zap` (social) | `lnurl` (plano) | `withdraw` (QR de retiro). */
  tier: string;
  sats: number;
  status: string;
  receiptId?: string | null;
};

export type NgeSeat = {
  seatId: string;
  deposited: boolean;
  /** Para asientos sin pagar (apuesta abierta): bolt11 VIGENTE (el escrow lo re-emite). */
  bolt11?: string | null;
  payout?: NgePayout | null;
};

export type NgeBetStatus =
  | "pending_deposits"
  | "funded"
  | "resolving"
  | "settled"
  | "cancelled"
  | "expired"
  | "refunded";

export type NgeBet = {
  betId: string;
  status: NgeBetStatus;
  stakeSats: number;
  potSats: number;
  deadlineSec: number | null;
  seats: NgeSeat[];
  result?: { winners: string[] } | null;
};

/**
 * Respuesta de `create_bet` (v1.1): el detalle COMPLETO de la apuesta (mismo
 * shape que `get_bet`) más los handles de depósito. Un solo RPC deja al juego
 * con los QR y el estado inicial — no hace falta un `get_bet` post-creación.
 * (Contra un escrow v1.0 los campos del detalle llegan undefined; `deposits`
 * existe en ambas versiones.)
 */
export type NgeCreateBetResult = NgeBet & {
  deposits: NgeDeposit[];
};

// ── Cliente ──────────────────────────────────────────────────────────────────

export type NgeOptions = {
  /** Transporte alternativo (tests, relays custom). Default: poolTransport. */
  transport?: NgeTransport;
  /** Corte total de un RPC (default 15 s). */
  timeoutMs?: number;
  /** Cadencia de reenvío del MISMO request firmado mientras no llega response (default 4 s). */
  resendMs?: number;
};

export class NGE {
  readonly escrowPubkey: string;
  readonly clientPubkey: string;
  readonly relays: string[];
  private readonly sk: Uint8Array;
  private readonly transport: NgeTransport;
  private readonly timeoutMs: number;
  private readonly resendMs: number;

  private constructor(conn: NgeConnection, opts: NgeOptions = {}) {
    this.escrowPubkey = conn.escrowPubkey;
    this.clientPubkey = conn.clientPubkey;
    this.relays = conn.relays;
    this.sk = conn.secretKey;
    this.transport = opts.transport ?? poolTransport(conn.relays);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.resendMs = opts.resendMs ?? 4_000;
  }

  /** Conecta desde una URI `nostr+nge://…`. */
  static connect(uri: string, opts?: NgeOptions): NGE {
    return new NGE(parseNgeUri(uri), opts);
  }

  /** Conecta leyendo la URI de una variable de entorno (default `NGE_CONNECTION`). */
  static fromEnv(envVar = "NGE_CONNECTION", opts?: NgeOptions): NGE {
    const uri = (process.env[envVar] ?? "").trim();
    if (!uri) throw new NgeError("NO_ENV", `falta ${envVar} en el entorno`);
    return NGE.connect(uri, opts);
  }

  /**
   * Núcleo del RPC: firma el request, se suscribe a SU response (tag `e` = id del
   * request, autor = `S`), publica, y reenvía el MISMO evento firmado cada
   * `resendMs` hasta la response o el timeout. Verifica que la response la firme
   * la pubkey del escrow antes de confiar en ella.
   */
  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const ev = finalizeEvent(
      requestTemplate(
        { method, params },
        { escrowPubkey: this.escrowPubkey, secretKey: this.sk },
      ),
      this.sk,
    );

    return await new Promise<T>((resolve, reject) => {
      let done = false;
      let unsubscribe: () => void = () => {};
      let resendTimer: ReturnType<typeof setInterval> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        if (resendTimer) clearInterval(resendTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        unsubscribe();
        fn();
      };

      // Suscripción ANTES de publicar: la response puede llegar en milisegundos.
      unsubscribe = this.transport.subscribe(
        { kinds: [NGE_KIND.response], authors: [this.escrowPubkey], "#e": [ev.id] },
        (resp) => {
          if (resp.pubkey !== this.escrowPubkey || !verifyEvent(resp)) return;
          let payload: NgeResponsePayload;
          try {
            payload = decryptPayload(resp.content, this.sk, this.escrowPubkey) as NgeResponsePayload;
          } catch {
            return; // basura cifrada: seguimos esperando la response real
          }
          if (payload.error) {
            const e = payload.error;
            finish(() => reject(new NgeError(e.code || "ERROR", e.message || "error del escrow")));
            return;
          }
          finish(() => resolve((payload.result ?? {}) as T));
        },
      );

      const send = () =>
        this.transport.publish(ev).catch((err) => {
          // Si NINGÚN relay acepta y es el primer envío, no hay canal: fallar ya.
          if (!done && err instanceof NgeError && err.code === "PUBLISH_FAILED") {
            finish(() => reject(err));
          }
        });

      void send();
      // At-least-once (§6.1): reenviar el MISMO evento (mismo id) no duplica nada
      // — el escrow deduplica por id y re-publica la response cacheada.
      resendTimer = setInterval(() => void this.transport.publish(ev).catch(() => {}), this.resendMs);
      timeoutTimer = setTimeout(
        () =>
          finish(() =>
            reject(new NgeError("TIMEOUT", `el escrow no respondió \`${method}\` a tiempo`)),
          ),
        this.timeoutMs,
      );
    });
  }

  /** Config y capacidades del escrow (reemplaza al `bind` event de v1). */
  async getInfo(): Promise<NgeInfo> {
    return this.rpc<NgeInfo>("get_info", {});
  }

  /** Crea la apuesta y devuelve un bolt11 POR ASIENTO para mostrar como QR. */
  async createBet(input: NgeCreateBetInput): Promise<NgeCreateBetResult> {
    if (!Array.isArray(input.seats) || input.seats.length < 2) {
      throw new NgeError("BAD_SEATS", "se necesitan al menos 2 asientos");
    }
    const seen = new Set<string>();
    const seats = input.seats.map((s, i) => {
      const seatId = String(s.seatId ?? "").trim();
      if (!seatId) throw new NgeError("BAD_SEATS", `seat[${i}] necesita seatId`);
      if (seen.has(seatId)) throw new NgeError("BAD_SEATS", `seatId duplicado: ${seatId}`);
      seen.add(seatId);
      return {
        seatId,
        ...(s.pubkey ? { pubkey: decodePubkey(s.pubkey, `seat[${i}].pubkey`) } : {}),
        ...(s.payoutAddress ? { payoutAddress: s.payoutAddress.trim() } : {}),
      };
    });
    if (!Number.isInteger(input.stakeSats) || input.stakeSats <= 0) {
      throw new NgeError("BAD_STAKE", "stakeSats debe ser un entero positivo");
    }
    return this.rpc<NgeCreateBetResult>("create_bet", {
      seats,
      stakeSats: input.stakeSats,
      ...(input.condition ? { condition: input.condition } : {}),
      ...(input.deadlineSec ? { deadlineSec: input.deadlineSec } : {}),
      ...(input.clientRef ? { clientRef: input.clientRef } : {}),
      ...(input.roomId ? { roomId: input.roomId } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
    });
  }

  /** La fuente de verdad: estado + asientos + bolt11 vigentes. De esto se hace polling. */
  async getBet(betId: string): Promise<NgeBet> {
    return this.rpc<NgeBet>("get_bet", { betId });
  }

  /** Reporta ganadores por seatId (el cliente ES el oráculo). Vacío = empate/anulación.
   *  Con ventana de disputa (spec §7.1) devuelve `settleAt`: el resultado quedó fijo
   *  pero el payout se ejecuta recién a esa hora (unix). */
  async reportResult(
    betId: string,
    winners: string[],
  ): Promise<{ ok: boolean; status: NgeBetStatus; settleAt?: number }> {
    if (!Array.isArray(winners) || winners.some((w) => typeof w !== "string")) {
      throw new NgeError("BAD_WINNERS", "winners debe ser un array de seatIds");
    }
    return this.rpc("report_result", { betId, winners });
  }

  /** Cancela la apuesta pre-fondeo (reembolsa a los asientos que ya pagaron). */
  async cancelBet(betId: string): Promise<{ ok: boolean; status: NgeBetStatus }> {
    return this.rpc("cancel_bet", { betId });
  }

  /**
   * Polling con azúcar: consulta `get_bet` cada `intervalMs` y notifica SOLO las
   * transiciones de estado. Devuelve `stop`. Para clientes sin proceso persistente
   * (serverless); con listener vivo conviene `watchBet` (push + respaldo).
   */
  pollBet(
    betId: string,
    cb: (bet: NgeBet) => void,
    intervalMs = 3_000,
  ): () => void {
    let last = "";
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const bet = await this.getBet(betId);
        const key = `${bet.status}:${bet.seats.map((s) => (s.deposited ? 1 : 0)).join("")}`;
        if (key !== last) {
          last = key;
          cb(bet);
        }
      } catch {
        /* transitorio: el próximo tick reintenta */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  /**
   * Suscripción a las notifications 24942 del escrow (spec §9, v1.1). Verifica
   * autor+firma y descifra; entrega solo payloads `bet_updated` bien formados.
   * El contenido NO es autoritativo: confirmar con `get_bet`. Devuelve `stop`.
   */
  subscribeNotifications(cb: (n: NgeNotificationPayload) => void): () => void {
    return this.transport.subscribe(
      { kinds: [NGE_KIND.notification], authors: [this.escrowPubkey], "#p": [this.clientPubkey] },
      (ev) => {
        if (ev.pubkey !== this.escrowPubkey || !verifyEvent(ev)) return;
        let payload: NgeNotificationPayload;
        try {
          payload = decryptPayload(ev.content, this.sk, this.escrowPubkey) as NgeNotificationPayload;
        } catch {
          return;
        }
        if (payload?.notification_type !== "bet_updated") return;
        if (typeof payload.notification?.betId !== "string") return;
        cb(payload);
      },
    );
  }

  /**
   * Seguimiento con push + respaldo (spec §9, v1.1): se suscribe a `bet_updated`
   * y ante cada aviso de ESTA apuesta confirma con `get_bet` (la fuente de
   * verdad); un polling lento de respaldo (default 15 s) cubre pushes perdidos
   * (relay caído, cliente offline al publicarse). Notifica solo transiciones.
   * En serverless usá `pollBet`. Devuelve `stop`.
   */
  watchBet(
    betId: string,
    cb: (bet: NgeBet) => void,
    fallbackIntervalMs = 15_000,
  ): () => void {
    let last = "";
    let stopped = false;
    let inFlight = false;
    const confirm = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const bet = await this.getBet(betId);
        const key = `${bet.status}:${bet.seats.map((s) => (s.deposited ? 1 : 0)).join("")}`;
        if (!stopped && key !== last) {
          last = key;
          cb(bet);
        }
      } catch {
        /* transitorio: el próximo aviso o tick de respaldo reintenta */
      } finally {
        inFlight = false;
      }
    };
    const unsubscribe = this.subscribeNotifications((n) => {
      if (n.notification.betId === betId) void confirm();
    });
    void confirm();
    const timer = setInterval(() => void confirm(), fallbackIntervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
    };
  }

  /** Cierra el transporte (sockets). */
  close(): void {
    this.transport.close();
  }
}

// ── Auditoría de liquidación (cliente) ───────────────────────────────────────

/**
 * Verificación del lado cliente (v1.1): cruza la liquidación que reporta
 * `get_bet` contra los fees que el escrow declaró en `get_info`. Devuelve una
 * lista de anomalías (vacía = todo consistente). Es un AUDIT, no un veto: los
 * umbrales son tolerantes (piso de comisión, recargo de routing por fallback
 * ~1,1 %, redondeos a sat), así que una anomalía amerita registrarse/alertarse,
 * no abortar el flujo.
 */
export function auditSettlement(bet: NgeBet, info: NgeInfo): string[] {
  const issues: string[] = [];
  if (bet.status !== "settled" && bet.status !== "refunded") return issues;

  const payoutSats = (s: NgeSeat) => s.payout?.sats ?? 0;
  const totalPaid = bet.seats.reduce((acc, s) => acc + payoutSats(s), 0);
  if (totalPaid > bet.potSats) {
    issues.push(`el escrow reporta pagos por ${totalPaid} sats > pozo de ${bet.potSats}`);
  }

  const winners = bet.result?.winners ?? [];
  if (bet.status === "settled" && winners.length > 0) {
    const winnerSeats = bet.seats.filter((s) => winners.includes(s.seatId));
    const missing = winners.filter(
      (w) => !bet.seats.some((s) => s.seatId === w && s.payout != null),
    );
    if (missing.length > 0) {
      issues.push(`ganadores sin payout reportado: ${missing.join(", ")}`);
    }
    const paidWinners = winnerSeats.reduce((acc, s) => acc + payoutSats(s), 0);
    // Fee máxima esperable: % declarado (casa+dev) con su piso, más el recargo
    // de routing del fallback (~1,1 %) y un margen de redondeo por ganador.
    const pctFee = Math.ceil((bet.potSats * (info.feePct + info.devFeePct)) / 100);
    const maxFee =
      Math.max(info.feeMinSats ?? 0, pctFee) +
      Math.ceil(bet.potSats * 0.011) +
      winners.length;
    if (paidWinners > 0 && paidWinners < bet.potSats - maxFee) {
      issues.push(
        `los ganadores cobraron ${paidWinners} sats; con pozo ${bet.potSats} y fees declaradas (${info.feePct}+${info.devFeePct}% / piso ${info.feeMinSats ?? 0}) se esperaba al menos ${bet.potSats - maxFee}`,
      );
    }
  }

  if (bet.status === "refunded") {
    // Empate/anulación: cada asiento que depositó recupera su stake (sin fee).
    for (const s of bet.seats) {
      if (s.deposited && s.payout != null && payoutSats(s) < bet.stakeSats) {
        issues.push(
          `reembolso de ${s.seatId} por ${payoutSats(s)} sats < stake de ${bet.stakeSats}`,
        );
      }
    }
  }
  return issues;
}
