import { SimplePool, nip19 } from 'nostr-tools';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { OnlineRoomError } from './roomService.js';
import { PUBLIC_WRITE_RELAYS } from './nostrRelays.js';
import { isLunaMockEnabled } from './lunaNegraMock.js';

// Capa NGP de apuestas (server-side). En vez de pedirle a Luna Negra que cree la
// apuesta por API (POST /api/v2/bets, donde Luna firma el ancla), publicamos un
// CONTRATO kind:1339 firmado por una clave de servicio de Tetris y le pedimos a
// Luna que lo materialice (POST /api/v2/bets/from-contract). El contrato queda en
// Nostr, verificable y portable; el depósito y el resultado siguen el mismo flujo
// v2 de siempre. Ver docs/nostr-games-protocol-apuestas.md (Fase 2).
//
// Gateado por env: solo se activa con LUNA_NEGRA_NGP_BETS=1 y una clave de
// servicio (LUNA_NEGRA_NGP_NSEC). Además, el caller solo lo usa cuando TODOS los
// jugadores tienen npub (NGP puro no tiene asientos invitados custodiados).

export const NGP_CONTRACT_KIND = 1339;
export const NGP_TAG = 'ngp-bet';

export interface NgpConfig {
  storePubkey: string;
  oraclePubkey: string;
  gameCoord: string;
  minStakeSats: number;
  maxStakeSats: number;
}

/** Clave de servicio (bytes) con la que Tetris firma el contrato 1339. Null si no
 *  está configurada. Acepta `nsec…` o hex crudo. */
function ngpServiceKey(): Uint8Array | null {
  const s = (process.env.LUNA_NEGRA_NGP_NSEC ?? '').trim();
  if (!s) return null;
  try {
    if (s.startsWith('nsec')) return nip19.decode(s).data as Uint8Array;
    return Uint8Array.from(Buffer.from(s, 'hex'));
  } catch {
    return null;
  }
}

/** ¿Está habilitada la ruta NGP? Requiere el flag + la clave de servicio, y nunca
 *  en modo mock (el hard test corre el money-path en memoria, sin relays). */
export function ngpBetsEnabled(): boolean {
  if (isLunaMockEnabled()) return false;
  if ((process.env.LUNA_NEGRA_NGP_BETS ?? '').trim() !== '1') return false;
  return ngpServiceKey() !== null;
}

/** Clave (bytes) con la que Tetris firma el RESULTADO 1341 como oráculo BYO. Por
 *  defecto es la misma clave de servicio que firma el contrato (Tetris es a la vez
 *  organizador y árbitro); se puede separar con LUNA_NEGRA_NGP_ORACLE_NSEC. Null si
 *  no hay clave. */
function ngpOracleKey(): Uint8Array | null {
  const s = (process.env.LUNA_NEGRA_NGP_ORACLE_NSEC ?? '').trim();
  if (s) {
    try {
      if (s.startsWith('nsec')) return nip19.decode(s).data as Uint8Array;
      return Uint8Array.from(Buffer.from(s, 'hex'));
    } catch {
      return null;
    }
  }
  return ngpServiceKey();
}

/** Pubkey (hex) del oráculo BYO de Tetris, o null si no hay clave. */
export function ngpOraclePubkey(): string | null {
  const sk = ngpOracleKey();
  if (!sk) return null;
  try {
    return getPublicKey(sk);
  } catch {
    return null;
  }
}

/** ¿Reportamos el resultado KEYLESS (firmando nuestro propio 1341) en vez de por
 *  API key (oráculo gestionado por Luna)? Requiere NGP + el flag explícito + clave de
 *  oráculo. Es opt-in para no romper el flujo gestionado que ya corre en prod: hasta
 *  que se declara la clave BYO en Luna, el camino gestionado sigue siendo el válido. */
export function ngpKeylessEnabled(): boolean {
  if (!ngpBetsEnabled()) return false;
  if ((process.env.LUNA_NEGRA_NGP_KEYLESS ?? '').trim() !== '1') return false;
  return ngpOracleKey() !== null;
}

/** ¿Operamos la apuesta 100% por EVENTOS Nostr (sin la REST autenticada de Luna)?
 *  Config por `terms`, crear = publicar 1339, depósito por LNURL de la tienda, estado
 *  por 31340, resultado por 1341 en relays. Requiere keyless (firmamos el 1341) + el
 *  flag explícito. Opt-in: sin él, sigue el camino REST/keyless que ya corre. */
export function ngpEventsEnabled(): boolean {
  if (!ngpKeylessEnabled()) return false;
  return (process.env.LUNA_NEGRA_NGP_EVENTS ?? '').trim() === '1';
}

/**
 * Estado de la config NGP tal como la ve ESTA función deployada. Sin secretos: solo
 * booleanos + la pubkey pública de servicio (que firma los 1339, para poder
 * matchearlos en relays). Lo expone `GET /api/bets/version` para diagnosticar por
 * qué NGP corre o no sin adivinar entre env/cache/gate.
 */
export function ngpDiagnostics(): {
  flag: boolean;
  hasKey: boolean;
  enabled: boolean;
  mock: boolean;
  servicePubkey: string | null;
  /** Valor crudo de LUNA_NEGRA_NGP_BETS tal como lo ve la función (JSON.stringify,
   *  no es secreto): revela comillas literales, "true"/"yes" u otro valor inesperado
   *  que no cuadre con el `=== '1'` esperado. */
  rawFlagValue: string;
  /** Reporte de resultado keyless (BYO): flag activo + hay clave de oráculo. */
  keyless: boolean;
  /** Pubkey del oráculo BYO con la que se firmarían los 1341 (para matchear en Luna). */
  oraclePubkey: string | null;
  /** Valor crudo de LUNA_NEGRA_NGP_KEYLESS (no es secreto). */
  rawKeylessValue: string;
  /** Flujo 100% por eventos (sin REST autenticada): keyless + LUNA_NEGRA_NGP_EVENTS=1. */
  events: boolean;
  /** Valor crudo de LUNA_NEGRA_NGP_EVENTS (no es secreto). */
  rawEventsValue: string;
} {
  const raw = process.env.LUNA_NEGRA_NGP_BETS ?? '';
  const flag = raw.trim() === '1';
  const sk = ngpServiceKey();
  let servicePubkey: string | null = null;
  if (sk) {
    try {
      servicePubkey = getPublicKey(sk);
    } catch {
      servicePubkey = null;
    }
  }
  return {
    flag,
    hasKey: sk !== null,
    enabled: ngpBetsEnabled(),
    mock: isLunaMockEnabled(),
    servicePubkey,
    rawFlagValue: JSON.stringify(raw),
    keyless: ngpKeylessEnabled(),
    oraclePubkey: ngpOraclePubkey(),
    rawKeylessValue: JSON.stringify(process.env.LUNA_NEGRA_NGP_KEYLESS ?? ''),
    events: ngpEventsEnabled(),
    rawEventsValue: JSON.stringify(process.env.LUNA_NEGRA_NGP_EVENTS ?? ''),
  };
}

/** Convierte un npub a pubkey hex. Lanza si es inválido. */
export function pubkeyFromNpub(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub') throw new OnlineRoomError(`npub inválido: ${npub}`, 400);
  return decoded.data as string;
}

// Config NGP cacheada por gameId (por instancia serverless): las pubkeys de la
// tienda/oráculo y la coordenada no cambian salvo rotación de oráculo o re-deploy.
const configCache = new Map<string, NgpConfig>();

/** Lee la config NGP del juego (pubkeys de escrow/oráculo, coordenada, límites)
 *  con la API key del proveedor. Memoizada por gameId. */
export async function fetchNgpConfig(
  baseUrl: string,
  apiKey: string,
  gameId: string,
): Promise<NgpConfig> {
  const cached = configCache.get(gameId);
  if (cached) return cached;

  const url = `${baseUrl.replace(/\/+$/, '')}/api/v2/bets/ngp-config?gameId=${encodeURIComponent(gameId)}`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
  } catch {
    throw new OnlineRoomError('No se pudo contactar a Luna Negra para la config NGP.', 502);
  }
  const payload = (await response.json().catch(() => null)) as
    | (NgpConfig & { error?: { message?: string } })
    | { error?: { message?: string } }
    | null;
  if (
    !response.ok ||
    !payload ||
    !('storePubkey' in payload) ||
    !payload.storePubkey ||
    !payload.oraclePubkey ||
    !payload.gameCoord
  ) {
    const reason =
      (payload && 'error' in payload && payload.error?.message) ||
      `Luna Negra respondió ${response.status} a la config NGP.`;
    throw new OnlineRoomError(reason, 502);
  }
  const cfg: NgpConfig = {
    storePubkey: payload.storePubkey,
    oraclePubkey: payload.oraclePubkey,
    gameCoord: payload.gameCoord,
    minStakeSats: Number(payload.minStakeSats) || 1,
    maxStakeSats: Number(payload.maxStakeSats) || Number.MAX_SAFE_INTEGER,
  };
  configCache.set(gameId, cfg);
  return cfg;
}

/**
 * Texto humano de la apuesta. Es el content del POST PRINCIPAL (kind:1) que
 * renderiza en cualquier cliente Nostr, y también se usa como `alt` (NIP-31) del
 * contrato kind:1339 que cuelga como comentario.
 */
function buildContractHuman(p: {
  participantPubkeys: string[];
  stakeSats: number;
  victoryCondition: string;
  deadlineSec: number;
}): string {
  const who = p.participantPubkeys.map((pk) => `nostr:${nip19.npubEncode(pk)}`).join(" vs ");
  const vence = new Date(p.deadlineSec * 1000).toISOString().replace("T", " ").slice(0, 16);
  return [
    "🌑 Apuesta en Tetra (Tetris)",
    "",
    who,
    `${p.stakeSats} sats cada uno · gana: ${p.victoryCondition}`,
    "",
    "El ganador se lleva el pozo menos la comisión de la casa. Depósitos y premio por zaps anclados a este contrato. Escrow: Luna Negra.",
    `Ventana de depósito hasta ${vence} UTC.`,
  ].join("\n");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`relay timeout ${ms}ms`)), ms)),
  ]);
}

/** Publica un evento firmado a los relays de escritura con pool fresco (los sockets
 *  quedan congelados entre invocaciones serverless). Devuelve true si ≥1 aceptó. */
async function publishToRelays(ev: ReturnType<typeof finalizeEvent>): Promise<boolean> {
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(
      pool.publish(PUBLIC_WRITE_RELAYS, ev).map((p) => withTimeout(p, 5000)),
    );
    return results.some((r) => r.status === 'fulfilled');
  } finally {
    pool.close(PUBLIC_WRITE_RELAYS);
  }
}

/** Firma con la clave de servicio y publica; devuelve el id del evento. Lanza si
 *  ningún relay aceptó. */
async function signAndPublish(
  sk: Uint8Array,
  template: { kind: number; created_at: number; tags: string[][]; content: string },
): Promise<string> {
  const ev = finalizeEvent(template, sk);
  const accepted = await publishToRelays(ev);
  if (!accepted) {
    throw new OnlineRoomError('No se pudo publicar el evento NGP en ningún relay.', 502);
  }
  return ev.id;
}

/**
 * Publica la apuesta como DOS eventos:
 *  1) un POST PRINCIPAL kind:1 humano (la cara legible, renderiza en cualquier
 *     cliente Nostr), y
 *  2) el CONTRATO máquina kind:1339 como COMENTARIO (reply `e` root) de ese post,
 *     con los tags estructurados (a/p/escrow/oracle/stake/deadline).
 * Devuelve el id del CONTRATO (1339); Luna lo materializa y usa el post humano
 * como ancla (deriva el root del `e` del contrato), así depósitos/estado/premio
 * cuelgan de la nota legible. Lanza si algún publish no llega a ningún relay.
 */
export async function publishNgpContract(params: {
  gameCoord: string;
  storePubkey: string;
  oraclePubkey: string;
  participantPubkeys: string[];
  stakeSats: number;
  victoryCondition: string;
  roomId: string;
  deadlineSec: number;
}): Promise<string> {
  const sk = ngpServiceKey();
  if (!sk) throw new OnlineRoomError('NGP no configurado (falta LUNA_NEGRA_NGP_NSEC).', 500);

  const createdAt = Math.floor(Date.now() / 1000);
  const human = buildContractHuman({
    participantPubkeys: params.participantPubkeys,
    stakeSats: params.stakeSats,
    victoryCondition: params.victoryCondition,
    deadlineSec: params.deadlineSec,
  });
  const relay = PUBLIC_WRITE_RELAYS[0] ?? '';

  // 1) Post principal humano (kind:1): lo que ve la gente. `p` participantes para
  //    que aparezcan como menciones/pills; `t=ngp-bet` para discovery.
  const rootId = await signAndPublish(sk, {
    kind: 1,
    created_at: createdAt,
    tags: [
      ...params.participantPubkeys.map((pk) => ['p', pk]),
      ['t', NGP_TAG],
    ],
    content: human,
  });

  // 2) Contrato máquina (kind:1339) como comentario del post principal.
  const contractId = await signAndPublish(sk, {
    kind: NGP_CONTRACT_KIND,
    created_at: createdAt,
    tags: [
      ['e', rootId, relay, 'root'],
      ['a', params.gameCoord],
      ...params.participantPubkeys.map((pk) => ['p', pk]),
      ['p', params.storePubkey, '', 'escrow'],
      ['p', params.oraclePubkey, '', 'oracle'],
      ['stake', String(params.stakeSats)],
      ['deadline', String(params.deadlineSec)],
      ['room', params.roomId],
      ['t', NGP_TAG],
      // NIP-31: fallback humano para clientes que sí lo soporten (además del post raíz).
      ['alt', human],
    ],
    content: params.victoryCondition,
  });

  return contractId;
}

/**
 * MODO EVENTOS (sin REST): publica SOLO el contrato kind:1339 (sin post raíz), así
 * el `anchorEventId` que Luna materializa == id del 1339 (necesario para que el
 * depósito lazy por LNURL de la tienda resuelva el contrato). Devuelve el id del 1339.
 * `oracle` = la pubkey BYO de Tetris (TOFU: Luna la guarda por-apuesta y valida el 1341).
 */
export async function publishBareNgpContract(params: {
  gameCoord: string;
  storePubkey: string;
  oraclePubkey: string;
  participantPubkeys: string[];
  stakeSats: number;
  victoryCondition: string;
  roomId: string;
  deadlineSec: number;
}): Promise<string> {
  const sk = ngpServiceKey();
  if (!sk) throw new OnlineRoomError('NGP no configurado (falta LUNA_NEGRA_NGP_NSEC).', 500);
  const human = buildContractHuman({
    participantPubkeys: params.participantPubkeys,
    stakeSats: params.stakeSats,
    victoryCondition: params.victoryCondition,
    deadlineSec: params.deadlineSec,
  });
  return signAndPublish(sk, {
    kind: NGP_CONTRACT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['a', params.gameCoord],
      ...params.participantPubkeys.map((pk) => ['p', pk]),
      ['p', params.storePubkey, '', 'escrow'],
      ['p', params.oraclePubkey, '', 'oracle'],
      ['stake', String(params.stakeSats)],
      ['deadline', String(params.deadlineSec)],
      ['room', params.roomId],
      ['t', NGP_TAG],
      ['alt', human], // NIP-31: fallback humano (no hay post raíz en modo eventos).
    ],
    content: params.victoryCondition,
  });
}

/** Publica un evento YA firmado (p. ej. el 1341 del resultado) a los relays de
 *  escritura. Devuelve true si ≥1 aceptó. Lanza si ninguno lo tomó. */
export async function publishSignedEventToRelays(
  ev: ReturnType<typeof finalizeEvent>,
): Promise<boolean> {
  const accepted = await publishToRelays(ev);
  if (!accepted) throw new OnlineRoomError('Ningún relay aceptó el evento.', 502);
  return accepted;
}

/** Lee eventos de los relays con un pool fresco (sockets no persisten entre
 *  invocaciones serverless). Devuelve [] ante cualquier fallo/timeout. `maxWait` corta
 *  la espera apenas los relays rápidos responden (el estado 31340 está replicado, no
 *  hace falta esperar al más lento) para que el polling del pago no se sienta lento. */
export async function queryRelays(
  relays: string[],
  filter: Parameters<SimplePool['querySync']>[1],
  maxWaitMs = 2500,
): Promise<ReturnType<typeof finalizeEvent>[]> {
  const pool = new SimplePool();
  try {
    return (await withTimeout(
      pool.querySync(relays, filter, { maxWait: maxWaitMs }),
      maxWaitMs + 1500,
    )) as ReturnType<typeof finalizeEvent>[];
  } catch {
    return [];
  } finally {
    pool.close(relays);
  }
}

// Declaración de la clave de oráculo BYO ante Luna, memoizada por instancia
// serverless (idempotente: re-declarar la misma clave es un no-op del lado de Luna).
let oracleDeclared = false;

/**
 * Declara la clave de oráculo PROPIA de Tetris ante Luna (keyless). Prueba posesión:
 * pide el reto (`GET /api/provider/oracle/self`, API key), lo firma con la clave de
 * oráculo y lo postea (`POST … { proof }`). DEBE correr antes de publicar el 1339,
 * porque la ingesta valida que el oráculo del contrato == `provider.oraclePubkey`
 * (ORACLE_MISMATCH). Lanza si falla: sin declaración, el pozo no debe crearse.
 */
export async function ensureOracleDeclared(baseUrl: string, apiKey: string): Promise<void> {
  if (oracleDeclared) return;
  const sk = ngpOracleKey();
  if (!sk) throw new OnlineRoomError('NGP keyless sin clave de oráculo (LUNA_NEGRA_NGP_NSEC).', 500);
  const base = baseUrl.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${apiKey}` };

  let challenge: string;
  try {
    const r = await fetch(`${base}/api/provider/oracle/self`, { headers });
    const j = (await r.json().catch(() => null)) as { challenge?: string; error?: string } | null;
    if (!r.ok || !j?.challenge) {
      throw new OnlineRoomError(j?.error || `Luna respondió ${r.status} al pedir el reto de oráculo.`, 502);
    }
    challenge = j.challenge;
  } catch (e) {
    if (e instanceof OnlineRoomError) throw e;
    throw new OnlineRoomError('No se pudo contactar a Luna para declarar el oráculo.', 502);
  }

  const proof = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [], content: challenge },
    sk,
  );
  const r = await fetch(`${base}/api/provider/oracle/self`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ proof }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => null)) as { error?: string } | null;
    throw new OnlineRoomError(j?.error || `Luna rechazó la clave de oráculo (${r.status}).`, 502);
  }
  oracleDeclared = true;
}

/**
 * Firma el evento de RESULTADO (kind:1341) con la clave de oráculo BYO. Lleva el tag
 * `bet` (id interno de Luna, que usa `handleSignedEvent` para localizar la apuesta) y
 * los ganadores como `winner` (npub, formato que lee ese endpoint) y como `p` (pubkey,
 * formato NGP del 1341 en relays). En modo EVENTOS se pasa `anchorEventId` (= id del
 * 1339) para el tag `e`, que es como `ngp-bet-result-sync` localiza la apuesta al
 * levantar el 1341 de relays. Ganadores vacío = empate/anulación → reembolso.
 */
export function signNgpResultEvent(params: {
  betId: string;
  winnerNpubs: string[];
  gameCoord?: string;
  anchorEventId?: string;
}): ReturnType<typeof finalizeEvent> {
  const sk = ngpOracleKey();
  if (!sk) throw new OnlineRoomError('NGP keyless sin clave de oráculo.', 500);
  const tags: string[][] = [
    ['bet', params.betId],
    ['status', params.winnerNpubs.length > 0 ? 'win' : 'draw'],
    ['t', NGP_TAG],
  ];
  if (params.anchorEventId) tags.push(['e', params.anchorEventId]);
  for (const np of params.winnerNpubs) {
    tags.push(['winner', np]);
    tags.push(['p', pubkeyFromNpub(np)]);
  }
  if (params.gameCoord) tags.push(['a', params.gameCoord]);
  return finalizeEvent(
    { kind: 1341, created_at: Math.floor(Date.now() / 1000), tags, content: '' },
    sk,
  );
}

/**
 * MODO EVENTOS: firma un 1341 `status=void` con la clave de SERVICIO (la que firmó el
 * 1339 = el "retador"). Es el cancel pre-fondeo: `ngp-bet-result-sync` de Luna lo
 * detecta como VOID DEL RETADOR (firmante == autor del contrato) y reembolsa/anula.
 * `e` = id del 1339 para que lo ubique. Reemplaza `POST /cancel`.
 */
export function signNgpVoidEvent(contractId: string): ReturnType<typeof finalizeEvent> {
  const sk = ngpServiceKey();
  if (!sk) throw new OnlineRoomError('NGP no configurado (falta LUNA_NEGRA_NGP_NSEC).', 500);
  return finalizeEvent(
    {
      kind: 1341,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['bet', contractId],
        ['e', contractId],
        ['status', 'void'],
        ['t', NGP_TAG],
      ],
      content: '',
    },
    sk,
  );
}
