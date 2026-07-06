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
 * Texto humano de fallback (NIP-31 `alt`): los clientes Nostr que no saben
 * renderizar el kind:1339 muestran este texto en vez de "no se puede manejar el
 * evento". El formato máquina (tags a/p/stake/deadline) queda intacto.
 */
function buildContractAlt(p: {
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

/**
 * Construye, firma (clave de servicio) y publica el contrato NGP kind:1339. Los
 * `p` participantes van en orden; la tienda (escrow) y el oráculo con su marker.
 * Devuelve el id del evento (= ancla de la apuesta). Lanza si ningún relay aceptó.
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

  const tags: string[][] = [
    ['a', params.gameCoord],
    ...params.participantPubkeys.map((pk) => ['p', pk]),
    ['p', params.storePubkey, '', 'escrow'],
    ['p', params.oraclePubkey, '', 'oracle'],
    ['stake', String(params.stakeSats)],
    ['deadline', String(params.deadlineSec)],
    ['room', params.roomId],
    ['t', NGP_TAG],
    // NIP-31: texto humano de fallback para clientes que no rendericen el kind:1339.
    [
      'alt',
      buildContractAlt({
        participantPubkeys: params.participantPubkeys,
        stakeSats: params.stakeSats,
        victoryCondition: params.victoryCondition,
        deadlineSec: params.deadlineSec,
      }),
    ],
  ];
  const ev = finalizeEvent(
    {
      kind: NGP_CONTRACT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: params.victoryCondition,
    },
    sk,
  );
  const accepted = await publishToRelays(ev);
  if (!accepted) {
    throw new OnlineRoomError('No se pudo publicar el contrato NGP en ningún relay.', 502);
  }
  return ev.id;
}
