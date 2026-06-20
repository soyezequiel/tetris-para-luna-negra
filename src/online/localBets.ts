import { OnlineRoomError } from './roomService.js';

// ─────────────────────────────────────────────────────────────────────────────
// APUESTA LOCAL ANÓNIMA (Duelo Local / Bitconf)
//
// Flujo de apuesta SIN cuentas Nostr, para el modo 1v1 en la misma computadora.
// A diferencia de las apuestas online (lunaNegraBets.ts), acá NO hay sala ni
// jugadores con npub: Luna Negra genera una identidad efímera por asiento (modo
// `anonymous`), cada jugador deposita su stake por QR (invoice) y el ganador cobra
// el pozo por LNURL-withdraw (no tiene wallet asociada).
//
// Es server-side porque usa la API key del proveedor (secreto). El cliente pega a
// /api/local-bet/* (ver api/local-bet/[action].ts), nunca directo a Luna Negra.
// ─────────────────────────────────────────────────────────────────────────────

interface LunaConfig {
  baseUrl: string;
  apiKey: string;
}

function readApiConfig(): LunaConfig {
  const baseUrl = (process.env.LUNA_NEGRA_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = (process.env.LUNA_NEGRA_API_KEY ?? '').trim();
  if (!baseUrl) throw new OnlineRoomError('LUNA_NEGRA_BASE_URL no está configurada.', 500);
  if (!apiKey) throw new OnlineRoomError('LUNA_NEGRA_API_KEY no está configurada.', 500);
  return { baseUrl, apiKey };
}

export function isLocalBetConfigured(): boolean {
  return Boolean(
    (process.env.LUNA_NEGRA_BASE_URL ?? '').trim()
    && (process.env.LUNA_NEGRA_API_KEY ?? '').trim()
    && (process.env.LUNA_NEGRA_GAME_ID ?? '').trim(),
  );
}

function gameId(): string {
  const id = (process.env.LUNA_NEGRA_GAME_ID ?? '').trim();
  if (!id) throw new OnlineRoomError('LUNA_NEGRA_GAME_ID no está configurada.', 500);
  return id;
}

async function lunaFetch<T>(
  config: LunaConfig,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' },
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${config.apiKey}` };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const payload = await response.json().catch(() => null) as
    | { error?: { code?: string; message?: string } }
    | T
    | null;
  if (!response.ok) {
    const err = payload as { error?: { code?: string; message?: string } } | null;
    const message = err?.error?.message ?? `Luna Negra respondió ${response.status}.`;
    const status = response.status === 400 || response.status === 409 ? response.status : 502;
    throw new OnlineRoomError(message, status);
  }
  return payload as T;
}

// ── Tipos que devuelve Luna Negra (subset que nos importa) ──────────────────

interface LunaCreateAnon {
  betId: string;
  depositDeadline?: string | null;
  stakeSats?: number;
  potTargetSats?: number;
  feePct?: number;
  feeSats?: number;
  netPayoutSats?: number;
  participants?: Array<{ seat: number; npub: string }>;
}

interface LunaBetDetail {
  betId: string;
  status?: string;
  stakeSats?: number;
  potSats?: number;
  potTargetSats?: number;
  feePct?: number;
  feeSats?: number;
  netPayoutSats?: number;
  depositDeadline?: string | null;
  depositsReceived?: number;
  depositsTotal?: number;
  participants?: Array<{
    npub: string;
    depositStatus?: string;
    result?: string;
    payoutStatus?: string;
    payoutSats?: number | null;
    bolt11?: string | null;
    lnurl?: string | null;
    payUrl?: string | null;
    withdrawLnurl?: string | null;
    withdrawUrl?: string | null;
    depositError?: string | null;
  }>;
}

// ── Vista que devolvemos al cliente (estable, en sats) ──────────────────────

export interface LocalBetParticipant {
  seat: number; // 1..N (por orden de creación / npub)
  npub: string;
  depositStatus: string; // pending | paid | refunded | failed
  result: string; // pending | won | lost | tie
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
  status: string; // pending_deposits | funded/ready | settled | cancelled | ...
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
  // Mapa asiento→npub fijado al crear (el orden del GET no está garantizado, así
  // que el cliente mapea su jugador local por npub).
  seats: Array<{ seat: number; npub: string }>;
}

const MIN_STAKE = 1;
const MAX_STAKE = 1_000_000;

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function buildView(
  detail: LunaBetDetail,
  seats: Array<{ seat: number; npub: string }>,
): LocalBetView {
  const seatByNpub = new Map(seats.map((s) => [s.npub, s.seat]));
  const participants: LocalBetParticipant[] = (detail.participants ?? []).map((p, index) => ({
    seat: seatByNpub.get(p.npub) ?? index + 1,
    npub: p.npub,
    depositStatus: typeof p.depositStatus === 'string' ? p.depositStatus : 'pending',
    result: typeof p.result === 'string' ? p.result : 'pending',
    payoutStatus: typeof p.payoutStatus === 'string' ? p.payoutStatus : 'none',
    payoutSats: typeof p.payoutSats === 'number' ? p.payoutSats : null,
    bolt11: typeof p.bolt11 === 'string' ? p.bolt11 : null,
    lnurl: typeof p.lnurl === 'string' ? p.lnurl : null,
    payUrl: typeof p.payUrl === 'string' ? p.payUrl : null,
    withdrawLnurl: typeof p.withdrawLnurl === 'string' ? p.withdrawLnurl : null,
    withdrawUrl: typeof p.withdrawUrl === 'string' ? p.withdrawUrl : null,
    depositError: typeof p.depositError === 'string' ? p.depositError : null,
  }));
  return {
    betId: detail.betId,
    status: typeof detail.status === 'string' ? detail.status : 'pending_deposits',
    stakeSats: num(detail.stakeSats),
    potSats: num(detail.potSats),
    potTargetSats: num(detail.potTargetSats),
    feePct: Number.isFinite(Number(detail.feePct)) ? Number(detail.feePct) : 0,
    feeSats: num(detail.feeSats),
    netPayoutSats: num(detail.netPayoutSats),
    depositDeadline: detail.depositDeadline ?? null,
    depositsReceived: num(detail.depositsReceived),
    depositsTotal: num(detail.depositsTotal, seats.length),
    participants,
    seats,
  };
}

// Cachecito en memoria del mapa asiento→npub por betId (el GET de Luna no trae el
// número de asiento). En serverless puede perderse entre invocaciones; por eso el
// fallback de buildView indexa por orden. El cliente igual guarda su propio mapa.
const seatsByBet = new Map<string, Array<{ seat: number; npub: string }>>();

export async function createLocalBet(input: {
  stakeSats: number;
  seats?: number;
  victoryCondition?: string;
}): Promise<LocalBetView> {
  const config = readApiConfig();
  const stakeSats = Math.floor(Number(input.stakeSats));
  if (!Number.isFinite(stakeSats) || stakeSats < MIN_STAKE || stakeSats > MAX_STAKE) {
    throw new OnlineRoomError('Monto de apuesta inválido.', 400);
  }
  const seatCount = Math.min(8, Math.max(2, Math.floor(input.seats ?? 2)));
  const create = await lunaFetch<LunaCreateAnon>(config, '/api/v1/bets', {
    method: 'POST',
    body: {
      gameId: gameId(),
      anonymous: true,
      seats: seatCount,
      stakeSats,
      victoryCondition: input.victoryCondition?.slice(0, 280) || 'Duelo local: el último en pie gana el pozo.',
    },
  });
  const seats = (create.participants ?? []).map((p) => ({ seat: p.seat, npub: p.npub }));
  seatsByBet.set(create.betId, seats);
  const detail = await getBetDetail(config, create.betId);
  return buildView(detail ?? { betId: create.betId, status: 'pending_deposits', participants: [] }, seats);
}

async function getBetDetail(config: LunaConfig, betId: string): Promise<LunaBetDetail | null> {
  return lunaFetch<LunaBetDetail>(config, `/api/v1/bets/${encodeURIComponent(betId)}`).catch(() => null);
}

export async function getLocalBet(
  betId: string,
  seatsHint?: Array<{ seat: number; npub: string }>,
): Promise<LocalBetView> {
  const config = readApiConfig();
  const detail = await getBetDetail(config, betId);
  if (!detail) throw new OnlineRoomError('No se pudo leer la apuesta.', 502);
  const seats = seatsHint && seatsHint.length
    ? seatsHint
    : seatsByBet.get(betId)
      ?? (detail.participants ?? []).map((p, i) => ({ seat: i + 1, npub: p.npub }));
  seatsByBet.set(betId, seats);
  return buildView(detail, seats);
}

export async function reportLocalBetResult(
  betId: string,
  winnerNpubs: string[],
  seatsHint?: Array<{ seat: number; npub: string }>,
): Promise<LocalBetView> {
  const config = readApiConfig();
  await lunaFetch(config, `/api/v1/bets/${encodeURIComponent(betId)}/result`, {
    method: 'POST',
    body: { winners: winnerNpubs },
  });
  return getLocalBet(betId, seatsHint);
}

export async function cancelLocalBet(
  betId: string,
  seatsHint?: Array<{ seat: number; npub: string }>,
): Promise<LocalBetView> {
  const config = readApiConfig();
  await lunaFetch(config, `/api/v1/bets/${encodeURIComponent(betId)}/cancel`, { method: 'POST' })
    .catch(() => undefined);
  return getLocalBet(betId, seatsHint);
}
