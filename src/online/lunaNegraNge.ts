import { nip19 } from 'nostr-tools';
import {
  NGE,
  parseNgeUri,
  NgeError,
  auditSettlement,
  type NgeBet,
  type NgeCreateBetResult,
  type NgeInfo,
  type NgeSeatInput,
} from 'nostr-game-protocol/nge';
import { OnlineRoomError } from './roomService.js';

// PUERTO del escrow — la frontera protocolo↔juego. Este es el ÚNICO módulo que
// importa el SDK NGE (paquete `nostr-game-protocol/nge`): acá viven la
// credencial (env), el ciclo de vida por invocación serverless, el caché de
// config y la traducción de NgeError → OnlineRoomError. El resto del programa
// (lunaNegraBets, rooms, api) habla con estas funciones y no conoce el protocolo.
//
// NGE v2 (RPC cifrado estilo NWC): una sola credencial `NGE_CONNECTION` aporta
// la pubkey del escrow, los relays y la clave del cliente `C`. El escrow devuelve
// un `bolt11` por asiento en `create_bet`/`get_bet`, y la config (límites/
// comisiones/transparencia) se pide por `get_info`. Ver docs/nge-migration.md.

/** ¿Está configurada la credencial NGE? Es el ÚNICO gate del modo apuestas. */
export function ngeConnected(): boolean {
  return Boolean((process.env.NGE_CONNECTION ?? '').trim());
}

/** Crea una instancia del SDK por invocación (los sockets no persisten en
 *  serverless) y la cierra al terminar. Lanza OnlineRoomError si la URI es inválida. */
async function withNge<T>(fn: (nge: NGE) => Promise<T>): Promise<T> {
  let nge: NGE;
  try {
    nge = NGE.fromEnv();
  } catch (e) {
    const msg = e instanceof NgeError ? e.message : 'NGE_CONNECTION inválida';
    throw new OnlineRoomError(`NGE no configurado: ${msg}`, 500);
  }
  try {
    return await fn(nge);
  } finally {
    nge.close();
  }
}

/** Pubkey (hex) del cliente `C` derivada del `secret` de NGE_CONNECTION, o null si
 *  no hay credencial. Para diagnóstico. */
export function ngeClientPubkey(): string | null {
  if (!ngeConnected()) return null;
  try {
    return parseNgeUri(process.env.NGE_CONNECTION!.trim()).clientPubkey;
  } catch {
    return null;
  }
}

export interface NgeConfig {
  minStakeSats: number;
  maxStakeSats: number;
  feePct: number;
  devFeePct: number;
  /** Capacidad declarada del escrow: "public" = liquidación auditable en Nostr
   *  (formato NGP); "none" = solo coordinación privada. Escrows viejos no la
   *  anuncian → null. */
  transparency: 'public' | 'none' | null;
  /** Modos que acepta `create_bet.visibility` (p. ej. ["public","unlisted"]). */
  visibilityOptions: string[];
}

// Config cacheada por instancia serverless (límites/comisiones no cambian salvo que
// Luna toque la economía). Antes salía del `bind` event; ahora de `get_info`.
// `infoCache` guarda además el get_info CRUDO para la auditoría de liquidación.
let configCache: NgeConfig | null = null;
let infoCache: NgeInfo | null = null;

/** Resuelve la config del escrow por RPC `get_info` (una llamada, cacheada). */
export async function fetchNgeConfig(): Promise<NgeConfig> {
  if (configCache) return configCache;
  return withNge(async (nge) => {
    const info = await nge.getInfo().catch((e) => {
      const msg = e instanceof NgeError ? e.message : 'no se pudo leer get_info del escrow';
      throw new OnlineRoomError(`NGE: ${msg}`, 502, e instanceof NgeError ? e.code : null);
    });
    infoCache = info;
    configCache = {
      minStakeSats: info.minStakeSats,
      maxStakeSats: info.maxStakeSats,
      feePct: info.feePct,
      devFeePct: info.devFeePct,
      transparency: info.transparency ?? null,
      visibilityOptions: info.visibilityOptions ?? [],
    };
    return configCache;
  });
}

export function resetNgeConfigCacheForTests(): void {
  configCache = null;
  infoCache = null;
}

/**
 * Auditoría de la liquidación (SDK v1.1, `auditSettlement`): cruza los payouts que
 * reporta `get_bet` contra los fees que el escrow declaró en `get_info`. Devuelve
 * las anomalías (vacío = consistente, o apuesta no terminal). "Transparente" solo
 * sirve si alguien mira: esto es el cliente auditando al escrow. Nunca lanza.
 */
export async function auditNgeSettlement(bet: NgeBet): Promise<string[]> {
  if (bet.status !== 'settled' && bet.status !== 'refunded') return [];
  try {
    if (!infoCache) await fetchNgeConfig();
    if (!infoCache) return [];
    return auditSettlement(bet, infoCache);
  } catch {
    return [];
  }
}

/**
 * Crea la apuesta por RPC `create_bet`. `seats` lleva el `seatId` estable del juego
 * (usamos el npub del jugador) + su `pubkey`; el escrow devuelve `betId` y un
 * `bolt11` por asiento para mostrar como QR. Reemplaza al 1339 + 9734 de v1.
 */
/** Visibilidad de la liquidación pública por default para las apuestas de este
 *  juego. `NGE_BET_VISIBILITY=unlisted` omite la sombra 31340 y la nota social
 *  (solo si el escrow lo anuncia en `visibilityOptions`); default = public. */
function defaultVisibility(): 'unlisted' | undefined {
  return (process.env.NGE_BET_VISIBILITY ?? '').trim() === 'unlisted' ? 'unlisted' : undefined;
}

// Códigos de NgeError que NO tiene sentido reintentar: son rechazos deterministas
// del request (límites, forma). El resto —el escrow no contestó a tiempo, ningún
// relay aceptó, o rechazó la credencial estando reiniciándose— puede recuperarse
// solo, así que la creación reintenta UNA vez con backoff corto. El reintento es
// seguro porque va con `clientRef` (idempotencia §6.1): si la primera llamada llegó
// a crear la apuesta, el escrow devuelve el MISMO betId en vez de duplicarla.
const NON_RETRYABLE_NGE_CODES = new Set(['STAKE_OUT_OF_RANGE', 'BAD_REQUEST', 'BAD_SEATS', 'BAD_STAKE']);
const CREATE_RETRY_BACKOFF_MS = 1_500;

function isRetryableNgeError(e: unknown): e is NgeError {
  return e instanceof NgeError && !NON_RETRYABLE_NGE_CODES.has(e.code);
}

export async function createNgeBet(params: {
  seats: NgeSeatInput[];
  stakeSats: number;
  victoryCondition?: string;
  roomId?: string;
  // Clave de idempotencia estable para ESTE intento de creación (misma en el
  // reintento). Sin ella el reintento de un TIMEOUT podría duplicar la apuesta.
  clientRef?: string;
}): Promise<NgeCreateBetResult> {
  const run = (): Promise<NgeCreateBetResult> =>
    withNge(async (nge) => {
      try {
        return await nge.createBet({
          seats: params.seats,
          stakeSats: params.stakeSats,
          condition: params.victoryCondition?.slice(0, 280) || 'El último jugador en pie se lleva el pozo.',
          roomId: params.roomId,
          clientRef: params.clientRef,
          visibility: defaultVisibility(),
        });
      } catch (e) {
        if (e instanceof NgeError) {
          // STAKE_OUT_OF_RANGE u otros límites → 400; el resto (relay/escrow) → 502.
          const status = e.code === 'STAKE_OUT_OF_RANGE' || e.code === 'BAD_REQUEST' ? 400 : 502;
          throw new OnlineRoomError(`NGE: ${e.message}`, status, e.code);
        }
        throw e;
      }
    });

  try {
    return await run();
  } catch (first) {
    // Solo reintentamos fallas transitorias del escrow/relay (incluye UNAUTHORIZED,
    // que aparece cuando el escrow todavía no cargó su registro de credenciales tras
    // reiniciar). Los rechazos deterministas fallan de una.
    const cause = first instanceof OnlineRoomError ? first : null;
    const retryable = cause ? cause.code !== null && !NON_RETRYABLE_NGE_CODES.has(cause.code) : isRetryableNgeError(first);
    if (!retryable) throw first;
    await new Promise((resolve) => setTimeout(resolve, CREATE_RETRY_BACKOFF_MS));
    return await run();
  }
}

/** Estado + asientos (con `bolt11`/`payout`) de la apuesta por RPC `get_bet`. Es la
 *  fuente de verdad; se pollea. Devuelve null si el escrow no la conoce todavía. */
export async function fetchNgeBet(betId: string): Promise<NgeBet | null> {
  return withNge(async (nge) => nge.getBet(betId).catch(() => null));
}

/** Reporta el ganador por `seatId` (= npub del jugador). Vacío = empate/anulación →
 *  reembolso. El escrow liquida y paga. Reemplaza al 1341 de v1. */
export async function reportNgeResult(betId: string, winnerSeatIds: string[]): Promise<void> {
  await withNge(async (nge) => {
    try {
      await nge.reportResult(betId, winnerSeatIds);
    } catch (e) {
      // IN_PROGRESS no es un fallo: otra invocación ya disparó la liquidación (el
      // reporte al terminar la sala, el polling de refresh y el settle manual
      // compiten). El escrow está pagando; `get_bet` va a confirmar `settled` en el
      // próximo poll. Tratarlo como éxito evita el falso "⚠️ rechazó el cobro".
      if (e instanceof NgeError && e.code === 'IN_PROGRESS') return;
      const msg = e instanceof NgeError ? e.message : 'no se pudo reportar el resultado';
      throw new OnlineRoomError(`NGE: ${msg}`, 502, e instanceof NgeError ? e.code : null);
    }
  });
}

/** Cancela la apuesta PRE-fondeo por RPC `cancel_bet` (reembolsa a quien ya pagó).
 *  Una vez fondeada, la salida es `reportNgeResult` con ganadores vacío. */
export async function cancelNgeBet(betId: string): Promise<void> {
  await withNge(async (nge) => {
    try {
      await nge.cancelBet(betId);
    } catch (e) {
      const msg = e instanceof NgeError ? e.message : 'no se pudo cancelar la apuesta';
      throw new OnlineRoomError(`NGE: ${msg}`, 502, e instanceof NgeError ? e.code : null);
    }
  });
}

/**
 * Normaliza la respuesta de `create_bet` a un NgeBet (v1.1 ya ES el detalle
 * completo — mismo shape que `get_bet` — así que la creación no necesita RPCs
 * extra). Contra un escrow v1.0 el detalle no viene: se sintetiza el estado
 * inicial desde `deposits` (nadie depositó, sin resultado).
 */
export function betFromCreateResult(created: NgeCreateBetResult, stakeSats: number): NgeBet {
  if (Array.isArray(created.seats) && created.seats.length > 0) return created;
  return {
    betId: created.betId,
    status: created.status ?? 'pending_deposits',
    stakeSats: created.stakeSats ?? stakeSats,
    potSats: created.potSats ?? 0,
    deadlineSec: created.deadlineSec ?? created.deposits[0]?.expiresAt ?? null,
    seats: created.deposits.map((d) => ({
      seatId: d.seatId,
      deposited: false,
      bolt11: d.bolt11,
      payout: null,
    })),
    result: null,
  };
}

export function pubkeyFromNpub(npub: string): string {
  if (npub.startsWith('npub1')) {
    try {
      const { type, data } = nip19.decode(npub);
      if (type === 'npub') return data as string;
    } catch {}
  }
  return npub;
}
