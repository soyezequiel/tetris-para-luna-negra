import { OnlineRoomError } from './roomService.js';
import {
  ngeConnected,
  fetchNgeConfig,
  fetchNgeBet,
  createNgeBet,
  reportNgeResult,
  cancelNgeBet,
  auditNgeSettlement,
  betFromCreateResult,
  type NgeConfig,
} from './lunaNegraNge.js';
import { alertMoneyPathError } from './moneyPathAlert.js';
import type { NgeBet, NgeSeat } from '../../sdk/nge.js';

// ─────────────────────────────────────────────────────────────────────────────
// APUESTA LOCAL ANÓNIMA (Duelo Local / Bitconf)
//
// Flujo de apuesta SIN cuentas Nostr, para el modo 1v1 en la misma computadora.
// A diferencia de las apuestas online (lunaNegraBets.ts), acá NO hay sala ni
// jugadores con npub: los asientos van ANÓNIMOS por NGE (seatId `seat-N`, sin
// pubkey), cada jugador deposita su stake por QR (bolt11) y el ganador cobra en
// la página hosteada de Luna Negra (<base>/apuestas/{betId}).
//
// Va por el MISMO RPC cifrado NGE que las apuestas online (credencial
// `NGE_CONNECTION`, ver lunaNegraNge.ts): ya no existe el camino REST con API
// key. El campo `npub` de la vista es el seatId — opaco para el cliente, que
// solo lo usa como clave del mapeo asiento→jugador.
// ─────────────────────────────────────────────────────────────────────────────

export function isLocalBetConfigured(): boolean {
  // NGE-only: la única condición del duelo local con apuesta es la credencial.
  return ngeConnected();
}

// ── Vista que devolvemos al cliente (estable, en sats) ──────────────────────

export interface LocalBetParticipant {
  seat: number; // 1..N (por orden de creación)
  npub: string; // seatId opaco (`seat-N`)
  depositStatus: string; // pending | paid
  result: string; // pending | won | lost
  payoutStatus: string; // none | pending | paid | failed | withdraw_pending | claimed | forfeited
  payoutSats: number | null;
  bolt11: string | null;
  lnurl: string | null;
  payUrl: string | null;
  withdrawLnurl: string | null;
  withdrawUrl: string | null;
  depositError: string | null;
}

export interface LocalBetView {
  betId: string;
  status: string; // pending_deposits | funded | resolving | settled | cancelled | expired | refunded
  stakeSats: number;
  potSats: number;
  potTargetSats: number;
  feePct: number;
  feeSats: number;
  netPayoutSats: number;
  depositDeadline: string | null;
  depositsReceived: number;
  depositsTotal: number;
  participants: LocalBetParticipant[];
  // Mapa asiento→npub (=seatId) fijado al crear; el cliente lo guarda y lo
  // devuelve como hint, pero acá el seatId ya codifica el número de asiento.
  seats: Array<{ seat: number; npub: string }>;
}

const MIN_STAKE = 1;
const MAX_STAKE = 1_000_000;

// Base URL pública de Luna Negra para el claim del ganador (página hosteada
// <base>/apuestas/{betId}; el RPC no trae handle de retiro).
function publicLunaBaseUrl(): string {
  return (process.env.LUNA_NEGRA_BASE_URL ?? '').replace(/\/+$/, '');
}

function seatNumber(seatId: string, index: number): number {
  const m = /^seat-(\d+)$/.exec(seatId);
  return m ? Number(m[1]) : index + 1;
}

function buildView(bet: NgeBet, config: NgeConfig): LocalBetView {
  const base = publicLunaBaseUrl();
  const claimUrl = base ? `${base}/apuestas/${encodeURIComponent(bet.betId)}` : null;
  const winners = new Set(bet.result?.winners ?? []);
  const settled = bet.status === 'settled';

  const participants: LocalBetParticipant[] = bet.seats.map((s: NgeSeat, index) => {
    const payout = s.payout ?? null;
    const payoutStatus = payout?.status ?? 'none';
    const isWithdraw = payoutStatus === 'withdraw_pending' || payout?.tier === 'withdraw';
    return {
      seat: seatNumber(s.seatId, index),
      npub: s.seatId,
      depositStatus: s.deposited ? 'paid' : 'pending',
      result: settled ? (winners.has(s.seatId) ? 'won' : 'lost') : 'pending',
      payoutStatus,
      payoutSats: payout ? payout.sats : null,
      bolt11: s.deposited ? null : (s.bolt11 ?? null),
      lnurl: null,
      payUrl: null,
      withdrawLnurl: null,
      withdrawUrl: isWithdraw ? claimUrl : null,
      depositError: null,
    };
  });

  const potTargetSats = bet.stakeSats * bet.seats.length;
  const feePctTotal = config.feePct + config.devFeePct;
  const feeSats = Math.floor(potTargetSats * (feePctTotal / 100));
  const paid = participants.filter((p) => p.depositStatus === 'paid').length;

  return {
    betId: bet.betId,
    status: bet.status,
    stakeSats: bet.stakeSats,
    potSats: bet.potSats,
    potTargetSats,
    feePct: feePctTotal,
    feeSats,
    netPayoutSats: Math.max(0, potTargetSats - feeSats),
    depositDeadline: bet.deadlineSec ? new Date(bet.deadlineSec * 1000).toISOString() : null,
    depositsReceived: paid,
    depositsTotal: bet.seats.length,
    participants,
    seats: participants.map((p) => ({ seat: p.seat, npub: p.npub })),
  };
}

// Auditoría del lado cliente (SDK v1.1): si la liquidación no cuadra con los fees
// declarados en get_info, avisamos a Discord. Best-effort, nunca lanza.
async function auditAndAlert(bet: NgeBet): Promise<void> {
  const issues = await auditNgeSettlement(bet);
  if (issues.length === 0) return;
  await alertMoneyPathError(
    'bet:audit',
    { betId: bet.betId, potSats: bet.potSats, status: bet.status },
    new Error(issues.join(' · ')),
  );
}

export async function createLocalBet(input: {
  stakeSats: number;
  seats?: number;
  victoryCondition?: string;
}): Promise<LocalBetView> {
  if (!isLocalBetConfigured()) throw new OnlineRoomError('NGE_CONNECTION no está configurada.', 500);
  const stakeSats = Math.floor(Number(input.stakeSats));
  if (!Number.isFinite(stakeSats) || stakeSats < MIN_STAKE || stakeSats > MAX_STAKE) {
    throw new OnlineRoomError('Monto de apuesta inválido.', 400);
  }
  const seatCount = Math.min(8, Math.max(2, Math.floor(input.seats ?? 2)));
  const config = await fetchNgeConfig();
  const created = await createNgeBet({
    seats: Array.from({ length: seatCount }, (_, i) => ({ seatId: `seat-${i + 1}` })),
    stakeSats,
    victoryCondition: input.victoryCondition?.slice(0, 280) || 'Duelo local: el último en pie gana el pozo.',
  });
  // create_bet v1.1 ya devuelve el detalle completo + deposits: cero RPCs extra.
  return buildView(betFromCreateResult(created, stakeSats), config);
}

export async function getLocalBet(
  betId: string,
  _seatsHint?: Array<{ seat: number; npub: string }>,
): Promise<LocalBetView> {
  const config = await fetchNgeConfig();
  const bet = await fetchNgeBet(betId);
  if (!bet) throw new OnlineRoomError('No se pudo leer la apuesta.', 502);
  await auditAndAlert(bet);
  return buildView(bet, config);
}

export async function reportLocalBetResult(
  betId: string,
  winnerNpubs: string[],
  seatsHint?: Array<{ seat: number; npub: string }>,
): Promise<LocalBetView> {
  // Los "npubs" del cliente son los seatIds que fijamos al crear (opaco de punta
  // a punta). Vacío = empate/anulación → reembolso a ambos.
  await reportNgeResult(betId, winnerNpubs);
  return getLocalBet(betId, seatsHint);
}

export async function cancelLocalBet(
  betId: string,
  seatsHint?: Array<{ seat: number; npub: string }>,
): Promise<LocalBetView> {
  // Pre-fondeo: cancel_bet (reembolsa a quien pagó). Si ya está fondeada,
  // cancel_bet da NOT_CANCELLABLE → anulamos con report_result vacío (reembolso).
  try {
    await cancelNgeBet(betId);
  } catch {
    await reportNgeResult(betId, []).catch(() => undefined);
  }
  return getLocalBet(betId, seatsHint);
}
