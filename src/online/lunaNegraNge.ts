import { nip19 } from 'nostr-tools';
import {
  NGE,
  parseNgeUri,
  NgeError,
  type NgeBet,
  type NgeCreateBetResult,
  type NgeSeatInput,
} from './nge.js';
import { OnlineRoomError } from './roomService.js';

// Núcleo NGE-backed de las apuestas de Tetris — NGE v2 (RPC cifrado estilo NWC).
// Una sola credencial `NGE_CONNECTION` (la "NWC del escrow") aporta la pubkey del
// escrow, los relays y la clave del cliente `C`. Ya no hay contrato 1339 propio,
// ni estado público 31340, ni 9734 de depósito: el escrow devuelve un `bolt11`
// por asiento en `create_bet`/`get_bet`, y la config (límites/comisiones) se pide
// por `get_info`. Ver docs/nge-migration.md y sdk NGE v2 (`nge.ts`).

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
}

// Config cacheada por instancia serverless (límites/comisiones no cambian salvo que
// Luna toque la economía). Antes salía del `bind` event; ahora de `get_info`.
let configCache: NgeConfig | null = null;

/** Resuelve la config del escrow por RPC `get_info` (una llamada, cacheada). */
export async function fetchNgeConfig(): Promise<NgeConfig> {
  if (configCache) return configCache;
  return withNge(async (nge) => {
    const info = await nge.getInfo().catch((e) => {
      const msg = e instanceof NgeError ? e.message : 'no se pudo leer get_info del escrow';
      throw new OnlineRoomError(`NGE: ${msg}`, 502);
    });
    configCache = {
      minStakeSats: info.minStakeSats,
      maxStakeSats: info.maxStakeSats,
      feePct: info.feePct,
      devFeePct: info.devFeePct,
    };
    return configCache;
  });
}

export function resetNgeConfigCacheForTests(): void {
  configCache = null;
}

/**
 * Crea la apuesta por RPC `create_bet`. `seats` lleva el `seatId` estable del juego
 * (usamos el npub del jugador) + su `pubkey`; el escrow devuelve `betId` y un
 * `bolt11` por asiento para mostrar como QR. Reemplaza al 1339 + 9734 de v1.
 */
export async function createNgeBet(params: {
  seats: NgeSeatInput[];
  stakeSats: number;
  victoryCondition?: string;
}): Promise<NgeCreateBetResult> {
  return withNge(async (nge) => {
    try {
      return await nge.createBet({
        seats: params.seats,
        stakeSats: params.stakeSats,
        condition: params.victoryCondition?.slice(0, 280) || 'Último jugador en pie gana el pozo.',
      });
    } catch (e) {
      if (e instanceof NgeError) {
        // STAKE_OUT_OF_RANGE u otros límites → 400; el resto (relay/escrow) → 502.
        const status = e.code === 'STAKE_OUT_OF_RANGE' || e.code === 'BAD_REQUEST' ? 400 : 502;
        throw new OnlineRoomError(`NGE: ${e.message}`, status);
      }
      throw e;
    }
  });
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
      throw new OnlineRoomError(`NGE: ${msg}`, 502);
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
      throw new OnlineRoomError(`NGE: ${msg}`, 502);
    }
  });
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
