// ⚠️ VENDORIZADO desde Luna Negra (`sdk/nge.ts`). Fuente canónica; no editar acá
//    salvo para adaptar imports. Al actualizar Luna, re-copiar este archivo.
//
// SDK NGE (Nostr Game Escrow) — la "NWC del escrow".
//
// El dev pega UN string en `NGE_CONNECTION` y ya puede crear apuestas, seguir su
// estado y reportar el ganador, SIN API key, sin backend propio, sin env-var soup.
// Colapsa lo que hoy está disperso (LUNA_NEGRA_NGP_NSEC/_BETS/_KEYLESS/_EVENTS +
// fetch a ngp-config + ensureOracleDeclared) detrás de la URI y del `bind` event.
//
// Modelo: escrow transparente por eventos (ver docs/nostr-games-protocol-apuestas.md
// y docs/nge/). Kinds 1339 (contrato) / 1341 (resultado) / 31340 (estado + bind).
//
// Peer dependency:  npm i nostr-tools
import {
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  type Event,
  type EventTemplate,
} from "nostr-tools/pure";
import { SimplePool, nip19, type Filter } from "nostr-tools";

export const NGE_KIND = { contract: 1339, result: 1341, state: 31340 } as const;
/** Tag de descubrimiento del protocolo. `ngp-bet` es el alias legacy que el
 *  escrow de Luna todavía filtra; se emiten ambos durante la transición. */
export const NGE_TAG = "nge";
export const NGE_TAG_LEGACY = "ngp-bet";

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
  /** Pubkey (hex) del escrow: quién custodia y firma los 31340. */
  escrowPubkey: string;
  /** Relays de arranque (≥1). */
  relays: string[];
  /** Clave de servicio (bytes): firma el 1339 y el 1341. */
  secretKey: Uint8Array;
  /** Pubkey (hex) del oráculo = derivada del `secret`. */
  oraclePubkey: string;
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
 * Parsea `nostr+nge://<escrow-pubkey>?relay=…&secret=…`. Campos mínimos: host,
 * al menos un `relay`, y `secret`. Todo lo demás (coordenada, lud16, límites) se
 * deriva del `bind` event (§1.1), no de la URI.
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
  const oraclePubkey = getPublicKey(secretKey);
  return { escrowPubkey, relays, secretKey, oraclePubkey };
}

// ── Transporte de relays (inyectable → testeable sin red) ───────────────────

export interface NgeTransport {
  publish(event: Event): Promise<void>;
  query(filter: Filter): Promise<Event[]>;
  subscribe(filter: Filter, onEvent: (e: Event) => void): () => void;
  close(): void;
}

/** Transporte por defecto sobre SimplePool. Pool fresco por conexión (los sockets
 *  se congelan entre invocaciones serverless). */
export function poolTransport(relays: string[]): NgeTransport {
  const pool = new SimplePool();
  return {
    async publish(ev) {
      const results = await Promise.allSettled(pool.publish(relays, ev));
      if (!results.some((r) => r.status === "fulfilled")) {
        throw new NgeError("PUBLISH_FAILED", "ningún relay aceptó el evento");
      }
    },
    async query(filter) {
      return (await pool.querySync(relays, filter, { maxWait: 3000 })) as Event[];
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

// ── Builders puros (sin I/O, testeables contra los vectores) ────────────────

const now = () => Math.floor(Date.now() / 1000);

function discoveryTags(extra: string[] = [NGE_TAG, NGE_TAG_LEGACY]): string[][] {
  return extra.map((t) => ["t", t]);
}

export type ContractInput = {
  /** Pubkeys (hex) de los asientos, en orden. ≥2. */
  seats: string[];
  /** Sats por asiento (entero). */
  stakeSats: number;
  /** Unix absoluto del límite de fondeo. Si falta, se usa `windowSec`. */
  deadlineSec?: number;
  /** Ventana de fondeo relativa (default 3600) si no se pasa `deadlineSec`. */
  windowSec?: number;
  /** Texto humano del contrato (content). */
  memo?: string;
  /** Sala del juego (correlación), opcional. */
  roomId?: string;
  /** Sobrescribe los tags de descubrimiento (default: nge + ngp-bet). */
  tags?: string[];
};

/** Template SIN firmar del contrato kind:1339. `cfg` aporta escrow/oráculo/coord. */
export function contractTemplate(
  input: ContractInput,
  cfg: { escrowPubkey: string; oraclePubkey: string; gameCoord: string; relayHint?: string },
): EventTemplate {
  if (!input.seats || input.seats.length < 2) {
    throw new NgeError("BAD_SEATS", "se necesitan al menos 2 asientos");
  }
  const seats = input.seats.map((p, i) => decodePubkey(p, `seat[${i}]`));
  if (!Number.isInteger(input.stakeSats) || input.stakeSats <= 0) {
    throw new NgeError("BAD_STAKE", "stakeSats debe ser un entero positivo");
  }
  const deadline =
    input.deadlineSec ?? now() + (input.windowSec ?? 3600);
  const relay = cfg.relayHint ?? "";
  const tags: string[][] = [
    ["a", cfg.gameCoord],
    ...seats.map((p) => ["p", p]),
    ["p", cfg.escrowPubkey, relay, "escrow"],
    ["p", cfg.oraclePubkey, relay, "oracle"],
    ["stake", String(input.stakeSats)],
    ["deadline", String(deadline)],
  ];
  if (input.roomId) tags.push(["room", input.roomId]);
  tags.push(...discoveryTags(input.tags));
  return { kind: NGE_KIND.contract, created_at: now(), tags, content: input.memo ?? "" };
}

/** Template SIN firmar del zap request de depósito (NIP-57 kind:9734). Lo firma el
 *  participante (o el juego por un asiento efímero) y lo manda al LNURL del escrow. */
export function depositRequestTemplate(params: {
  contractId: string;
  escrowPubkey: string;
  stakeSats: number;
  relays: string[];
}): EventTemplate {
  return {
    kind: 9734,
    created_at: now(),
    tags: [
      ["e", params.contractId],
      ["p", params.escrowPubkey],
      ["amount", String(params.stakeSats * 1000)],
      ["relays", ...params.relays],
    ],
    content: "",
  };
}

export type ResultInput = {
  contractId: string;
  gameCoord: string;
  /** Ganadores (hex o npub). Vacío ⇒ empate/anulación (draw). */
  winners: string[];
  /** `win` | `draw` | `void`. Default: win si hay ganadores, si no draw. */
  status?: "win" | "draw" | "void";
  /** Metadata libre (ej. score) → content JSON. */
  meta?: Record<string, unknown>;
  tags?: string[];
};

/** Template SIN firmar del resultado kind:1341. Lo firma el oráculo (=`secret`). */
export function resultTemplate(input: ResultInput): EventTemplate {
  const status = input.status ?? (input.winners.length > 0 ? "win" : "draw");
  const tags: string[][] = [
    ["e", input.contractId],
    ["a", input.gameCoord],
  ];
  for (const w of input.winners) tags.push(["p", decodePubkey(w, "winner")]);
  tags.push(["status", status]);
  tags.push(...discoveryTags(input.tags));
  return {
    kind: NGE_KIND.result,
    created_at: now(),
    tags,
    content: input.meta ? JSON.stringify(input.meta) : "",
  };
}

/** Template SIN firmar de la anulación (1341 `status=void`). Pre-fondeo lo firma el
 *  retador; una vez fondeada, el oráculo. Con `secret` único, sirve para ambos. */
export function voidTemplate(contractId: string, tags?: string[]): EventTemplate {
  return {
    kind: NGE_KIND.result,
    created_at: now(),
    tags: [["e", contractId], ["status", "void"], ...discoveryTags(tags)],
    content: "",
  };
}

// ── Estado / bind ────────────────────────────────────────────────────────────

export type NgeBinding = {
  gameCoord: string;
  lud16?: string;
  minStakeSats: number;
  maxStakeSats: number;
  feePct?: number;
  devFeePct?: number;
};

export type NgeState = {
  status: string;
  contractId: string;
  content: Record<string, unknown>;
  event: Event;
};

function newest(events: Event[]): Event | null {
  let best: Event | null = null;
  for (const e of events) if (!best || e.created_at > best.created_at) best = e;
  return best;
}

function tag(ev: Event, name: string): string | undefined {
  return ev.tags.find((t) => t[0] === name)?.[1];
}

// ── Cliente ──────────────────────────────────────────────────────────────────

export type NgeOptions = {
  /** Transporte alternativo (tests, relays custom). Default: poolTransport. */
  transport?: NgeTransport;
};

export class NGE {
  readonly escrowPubkey: string;
  readonly oraclePubkey: string;
  readonly relays: string[];
  private readonly sk: Uint8Array;
  private readonly transport: NgeTransport;
  private bindingCache: NgeBinding | null = null;

  private constructor(conn: NgeConnection, opts: NgeOptions = {}) {
    this.escrowPubkey = conn.escrowPubkey;
    this.oraclePubkey = conn.oraclePubkey;
    this.relays = conn.relays;
    this.sk = conn.secretKey;
    this.transport = opts.transport ?? poolTransport(conn.relays);
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

  private sign(t: EventTemplate): Event {
    return finalizeEvent(t, this.sk);
  }

  /** Resuelve el `bind` event (coordenada del juego, lud16, límites). Cacheado. */
  async binding(): Promise<NgeBinding> {
    if (this.bindingCache) return this.bindingCache;
    const events = await this.transport.query({
      kinds: [NGE_KIND.state],
      authors: [this.escrowPubkey],
      "#d": [`bind:${this.oraclePubkey}`],
    });
    const ev = newest(events.filter((e) => e.pubkey === this.escrowPubkey && verifyEvent(e)));
    if (!ev) {
      throw new NgeError(
        "NO_BINDING",
        "el escrow no publicó el bind de este oráculo (¿credencial emitida?)",
      );
    }
    const gameCoord = tag(ev, "a");
    if (!gameCoord) throw new NgeError("BAD_BINDING", "el bind no trae coordenada de juego");
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(ev.content || "{}");
    } catch {
      /* límites por defecto */
    }
    this.bindingCache = {
      gameCoord,
      lud16: typeof body.lud16 === "string" ? body.lud16 : undefined,
      minStakeSats: Number(body.minStakeSats) || 1,
      maxStakeSats: Number(body.maxStakeSats) || Number.MAX_SAFE_INTEGER,
      feePct: typeof body.feePct === "number" ? body.feePct : undefined,
      devFeePct: typeof body.devFeePct === "number" ? body.devFeePct : undefined,
    };
    return this.bindingCache;
  }

  /**
   * Crea la apuesta: firma y publica el contrato kind:1339. El escrow lo
   * materializa al llegar el primer depósito (lazy, sin API key). Devuelve el id
   * del contrato y los handles de depósito por asiento.
   */
  async createBet(input: ContractInput): Promise<{
    contractId: string;
    event: Event;
    gameCoord: string;
    deposits: Array<{ pubkey: string; request: EventTemplate; lud16?: string }>;
  }> {
    const bind = await this.binding();
    if (input.stakeSats < bind.minStakeSats || input.stakeSats > bind.maxStakeSats) {
      throw new NgeError(
        "STAKE_OUT_OF_RANGE",
        `stake ${input.stakeSats} fuera de [${bind.minStakeSats}, ${bind.maxStakeSats}]`,
      );
    }
    const tmpl = contractTemplate(input, {
      escrowPubkey: this.escrowPubkey,
      oraclePubkey: this.oraclePubkey,
      gameCoord: bind.gameCoord,
      relayHint: this.relays[0],
    });
    const ev = this.sign(tmpl);
    await this.transport.publish(ev);
    const deposits = input.seats.map((p) => ({
      pubkey: decodePubkey(p, "seat"),
      request: depositRequestTemplate({
        contractId: ev.id,
        escrowPubkey: this.escrowPubkey,
        stakeSats: input.stakeSats,
        relays: this.relays,
      }),
      lud16: bind.lud16,
    }));
    return { contractId: ev.id, event: ev, gameCoord: bind.gameCoord, deposits };
  }

  /** Reporta el resultado: firma y publica el 1341. `winners` vacío = empate. */
  async reportResult(
    contractId: string,
    input: { winners: string[]; status?: "win" | "draw"; meta?: Record<string, unknown> },
  ): Promise<{ id: string; event: Event }> {
    const bind = await this.binding();
    const ev = this.sign(
      resultTemplate({
        contractId,
        gameCoord: bind.gameCoord,
        winners: input.winners,
        status: input.status,
        meta: input.meta,
      }),
    );
    await this.transport.publish(ev);
    return { id: ev.id, event: ev };
  }

  /** Anula la apuesta (reembolso): firma y publica un 1341 `status=void`. */
  async voidBet(contractId: string): Promise<{ id: string; event: Event }> {
    const ev = this.sign(voidTemplate(contractId));
    await this.transport.publish(ev);
    return { id: ev.id, event: ev };
  }

  /** Estado vigente del escrow para un contrato (31340 más nuevo, firmado por el escrow). */
  async state(contractId: string): Promise<NgeState | null> {
    const events = await this.transport.query({
      kinds: [NGE_KIND.state],
      authors: [this.escrowPubkey],
      "#d": [contractId],
    });
    const ev = newest(events.filter((e) => e.pubkey === this.escrowPubkey && verifyEvent(e)));
    if (!ev) return null;
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(ev.content || "{}");
    } catch {
      /* estado sin content estructurado */
    }
    return { status: tag(ev, "status") ?? "unknown", contractId, content, event: ev };
  }

  /** Se suscribe a las transiciones de estado del contrato. Devuelve un `unsubscribe`. */
  onState(contractId: string, cb: (s: NgeState) => void): () => void {
    return this.transport.subscribe(
      { kinds: [NGE_KIND.state], authors: [this.escrowPubkey], "#d": [contractId] },
      (ev) => {
        if (ev.pubkey !== this.escrowPubkey || !verifyEvent(ev)) return;
        let content: Record<string, unknown> = {};
        try {
          content = JSON.parse(ev.content || "{}");
        } catch {
          /* noop */
        }
        cb({ status: tag(ev, "status") ?? "unknown", contractId, content, event: ev });
      },
    );
  }

  /** Cierra el transporte (sockets). */
  close(): void {
    this.transport.close();
  }
}
