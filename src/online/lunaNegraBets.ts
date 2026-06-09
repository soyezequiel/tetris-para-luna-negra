import {
  loadRoom,
  isTerminalRoomBetStatus,
  OnlineRoomError,
  setRoomBet,
  winnerNpubsFromRoom,
  type RoomStore,
} from './roomService.js';
import type { OnlineRoom, RoomBet, RoomBetParticipant } from './protocol';

interface LunaConfig {
  baseUrl: string;
  apiKey: string;
}

interface LunaEconomics {
  stakeSats?: number;
  potTargetSats?: number;
  feePct?: number;
  feeSats?: number;
  netPayoutSats?: number;
}

interface LunaBetCreate extends LunaEconomics {
  betId: string;
  depositDeadline?: string | null;
}

interface LunaBetDetail extends LunaEconomics {
  betId: string;
  status?: string;
  potSats?: number;
  depositDeadline?: string | null;
  participants?: Array<{ npub: string; depositStatus?: string; payoutSats?: number | null }>;
}

interface LunaDepositHandle {
  npub: string;
  depositStatus?: string;
  bolt11?: string | null;
  lnurl?: string | null;
  payUrl?: string | null;
}

interface LunaBetDeposits {
  status?: string;
  potSats?: number;
  potTargetSats?: number;
  depositsReceived?: number;
  depositsTotal?: number;
  depositDeadline?: string | null;
  deposits?: LunaDepositHandle[];
}

export const LUNA_NEGRA_MIN_STAKE_SATS = 1;
export const LUNA_NEGRA_MAX_STAKE_SATS = 1_000_000;

function readApiConfig(): LunaConfig {
  const baseUrl = (process.env.LUNA_NEGRA_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = (process.env.LUNA_NEGRA_API_KEY ?? '').trim();
  if (!baseUrl) throw new OnlineRoomError('LUNA_NEGRA_BASE_URL no está configurada.', 500);
  if (!apiKey) throw new OnlineRoomError('LUNA_NEGRA_API_KEY no está configurada.', 500);
  return { baseUrl, apiKey };
}

export function isLunaNegraApiConfigured(): boolean {
  return Boolean(
    (process.env.LUNA_NEGRA_BASE_URL ?? '').trim()
    && (process.env.LUNA_NEGRA_API_KEY ?? '').trim(),
  );
}

// Error de la API de Luna Negra que conserva el status HTTP real y el código de
// error del proveedor, para poder clasificar fallos (transitorio vs. definitivo)
// sin perder información al aplanar el status que ve el resto de la app.
class LunaApiError extends OnlineRoomError {
  constructor(
    message: string,
    status: number,
    readonly httpStatus: number,
    readonly code: string | null,
  ) {
    super(message, status);
  }
}

async function lunaFetch<T>(
  config: LunaConfig,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' },
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.apiKey}`,
    'cache-control': 'no-cache',
    pragma: 'no-cache',
  };
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  let urlPath = path;
  if (init.method === 'GET') {
    const separator = path.includes('?') ? '&' : '?';
    urlPath = `${path}${separator}_cb=${Date.now()}`;
  }

  const response = await fetch(`${config.baseUrl}${urlPath}`, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | T | null;
  if (!response.ok) {
    const err = payload as { error?: { code?: string; message?: string } } | null;
    const message = err?.error?.message ?? `Luna Negra respondió ${response.status}.`;
    const status = response.status === 400 || response.status === 409 ? response.status : 502;
    throw new LunaApiError(message, status, response.status, err?.error?.code ?? null);
  }
  return payload as T;
}

// Reconoce, a partir del error del POST /result, que la apuesta ya estaba resuelta
// (reporte duplicado). Cubre tanto el código como el mensaje porque el vocabulario
// exacto del proveedor no está documentado.
function errorLooksResolved(error: unknown): boolean {
  const code = error instanceof LunaApiError ? (error.code ?? '') : '';
  const message = error instanceof Error ? error.message : '';
  const normalizedCode = code.trim().toUpperCase();
  if ([
    'NOT_READY',
    'TOO_LATE',
    'CONTRACT_MISMATCH',
    'ORACLE_NOT_PROVISIONED',
    'BAD_WINNERS',
    'FORBIDDEN',
    'INVALID_API_KEY',
    'RATE_LIMITED',
  ].includes(normalizedCode)) return false;
  if (/ALREADY|DUPLICATE/.test(normalizedCode) && /RESOL|SETTL|PAID|COMPLET|FINALIZ/.test(normalizedCode)) return true;
  return /ya .*(resuelt|pagad|finaliz|complet)|already .*(resolved|settled|paid|finali[sz]ed|completed)|duplicate|duplicad/i.test(message);
}

function nonNegInt(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : fallback;
}

function normalizeDepositStatus(value: unknown): RoomBetParticipant['depositStatus'] {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  // Luna Negra puede reportar el depósito confirmado con distintas palabras según
  // el endpoint; las tratamos todas como 'paid'.
  if (['paid', 'confirmed', 'completed', 'complete', 'settled', 'received', 'deposited', 'funded', 'success', 'succeeded'].includes(v)) {
    return 'paid';
  }
  if (['refunded', 'returned'].includes(v)) return 'refunded';
  if (['failed', 'error', 'expired', 'cancelled', 'canceled'].includes(v)) return 'failed';
  return 'pending';
}

// Traduce el vocabulario de estado de la apuesta de Luna Negra a nuestro enum.
// Devuelve null si la palabra es desconocida, para poder caer al estado previo.
function normalizeBetStatus(value: unknown): RoomBet['status'] | null {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!v) return null;
  if (['settled', 'resolved', 'paid', 'paid_out', 'paidout', 'payout', 'won', 'win', 'closed'].includes(v)) return 'settled';
  if (['funded', 'active', 'locked', 'in_progress', 'inprogress', 'ready', 'full', 'started', 'playing'].includes(v)) return 'funded';
  if (['pending_deposits', 'pending', 'awaiting_deposits', 'awaiting', 'open', 'created', 'new', 'deposits_pending'].includes(v)) return 'pending_deposits';
  if (['cancelled', 'canceled'].includes(v)) return 'cancelled';
  if (['expired', 'timeout', 'timedout'].includes(v)) return 'expired';
  if (['refunded', 'returned', 'reimbursed'].includes(v)) return 'refunded';
  return null;
}

function isTerminalBetStatus(status: RoomBet['status'] | undefined | null): boolean {
  return status === 'settled' || status === 'cancelled' || status === 'expired' || status === 'refunded';
}

// Determina, a partir de la respuesta cruda de Luna Negra, si la apuesta ya quedó
// resuelta (pagada/reembolsada). Sirve para cortar el reintento de reporte cuando
// el pago ya se hizo aunque el POST /result devuelva error.
function isResolvedFromLuna(detail: LunaBetDetail | null, deposits: LunaBetDeposits | null): boolean {
  const status = normalizeBetStatus(detail?.status ?? deposits?.status);
  if (isTerminalBetStatus(status)) return true;
  return (detail?.participants ?? []).some((p) => typeof p.payoutSats === 'number' && p.payoutSats > 0);
}

// Combina el estado de las dos fuentes (detail y deposits) quedándose con el más
// avanzado, para que un handle que sigue en 'pending' no enmascare un pago real.
function mergeDepositStatus(...values: unknown[]): RoomBetParticipant['depositStatus'] {
  const rank: Record<RoomBetParticipant['depositStatus'], number> = {
    pending: 0,
    failed: 1,
    paid: 2,
    refunded: 3,
  };
  let best: RoomBetParticipant['depositStatus'] = 'pending';
  for (const value of values) {
    const normalized = normalizeDepositStatus(value);
    if (rank[normalized] > rank[best]) best = normalized;
  }
  return best;
}

function buildRoomBet(
  room: OnlineRoom,
  npubs: string[],
  econ: LunaEconomics & { betId: string; depositDeadline?: string | null },
  detail: LunaBetDetail | null,
  deposits: LunaBetDeposits | null,
  previous: RoomBet | null,
  createdByPlayerId: string,
  nowMs: number,
): RoomBet {
  const detailByNpub = new Map((detail?.participants ?? []).map((p) => [p.npub, p]));
  const depByNpub = new Map((deposits?.deposits ?? []).map((d) => [d.npub, d]));
  const previousByNpub = new Map((previous?.participants ?? []).map((p) => [p.npub, p]));
  const participants: RoomBetParticipant[] = npubs.map((npub) => {
    const d = detailByNpub.get(npub);
    const h = depByNpub.get(npub);
    const player = room.players.find((candidate) => candidate.npub === npub);
    return {
      npub,
      playerId: player?.id ?? null,
      depositStatus: mergeDepositStatus(h?.depositStatus, d?.depositStatus, previousByNpub.get(npub)?.depositStatus),
      bolt11: typeof h?.bolt11 === 'string' ? h.bolt11 : null,
      lnurl: typeof h?.lnurl === 'string' ? h.lnurl : null,
      payUrl: typeof h?.payUrl === 'string' ? h.payUrl : null,
      payoutSats: typeof d?.payoutSats === 'number' ? d.payoutSats : null,
    };
  });
  // No regresamos de un estado terminal; si no, traducimos el vocabulario de Luna
  // Negra y, como respaldo, marcamos 'settled' cuando ya reportamos el resultado y
  // el ganador tiene un payout efectivo (la palabra de estado puede no llegarnos).
  let status: RoomBet['status'];
  if (isTerminalBetStatus(previous?.status)) {
    status = previous!.status;
  } else {
    const normalized = normalizeBetStatus(detail?.status ?? deposits?.status);
    const paidOut = previous?.resultReported === true
      && participants.some((p) => typeof p.payoutSats === 'number' && p.payoutSats > 0);
    status = paidOut ? 'settled' : (normalized ?? previous?.status ?? 'pending_deposits');
  }
  const depositsReceived = deposits?.depositsReceived ?? participants.filter((p) => p.depositStatus === 'paid').length;
  return {
    betId: econ.betId,
    status,
    stakeSats: nonNegInt(detail?.stakeSats ?? econ.stakeSats ?? previous?.stakeSats),
    potSats: nonNegInt(detail?.potSats ?? deposits?.potSats ?? previous?.potSats),
    potTargetSats: nonNegInt(detail?.potTargetSats ?? econ.potTargetSats ?? deposits?.potTargetSats ?? previous?.potTargetSats),
    feeSats: nonNegInt(detail?.feeSats ?? econ.feeSats ?? previous?.feeSats),
    feePct: Number.isFinite(Number(detail?.feePct ?? econ.feePct)) ? Number(detail?.feePct ?? econ.feePct) : (previous?.feePct ?? 0),
    netPayoutSats: nonNegInt(detail?.netPayoutSats ?? econ.netPayoutSats ?? previous?.netPayoutSats),
    depositDeadline: econ.depositDeadline ?? detail?.depositDeadline ?? deposits?.depositDeadline ?? previous?.depositDeadline ?? null,
    depositsReceived: nonNegInt(depositsReceived),
    depositsTotal: nonNegInt(deposits?.depositsTotal ?? npubs.length),
    participants,
    winnerNpubs: previous?.winnerNpubs ?? null,
    resultReported: previous?.resultReported ?? false,
    settlementError: isTerminalBetStatus(status) ? null : (previous?.settlementError ?? null),
    createdByPlayerId,
    createdAtServerMs: previous?.createdAtServerMs ?? nowMs,
    updatedAtServerMs: nowMs,
  };
}

function settlementErrorMessage(error: unknown): string {
  const code = error instanceof LunaApiError ? error.code : null;
  const message = error instanceof Error ? error.message : 'No se pudo reportar el resultado a Luna Negra.';
  return code ? `${code}: ${message}` : message;
}

async function fetchDetailAndDeposits(
  config: LunaConfig,
  betId: string,
): Promise<{ detail: LunaBetDetail | null; deposits: LunaBetDeposits | null }> {
  const [detail, deposits] = await Promise.all([
    lunaFetch<LunaBetDetail>(config, `/api/v1/bets/${encodeURIComponent(betId)}`).catch(() => null),
    lunaFetch<LunaBetDeposits>(config, `/api/v1/bets/${encodeURIComponent(betId)}/deposits`).catch(() => null),
  ]);
  return { detail, deposits };
}

export async function createBetForRoom(
  store: RoomStore,
  input: { roomId: string; playerId: string; stakeSats: number; victoryCondition?: string },
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const config = readApiConfig();
  const room = await loadRoom(store, input.roomId);
  if (room.hostPlayerId !== input.playerId) throw new OnlineRoomError('Solo el host puede crear la apuesta.', 403);
  if (room.status !== 'lobby') throw new OnlineRoomError('La sala ya empezó.', 409);
  if (room.bet && !isTerminalRoomBetStatus(room.bet.status)) {
    throw new OnlineRoomError('Ya hay una apuesta activa para esta sala.', 409);
  }
  if (room.players.length < 2) throw new OnlineRoomError('Se necesitan al menos 2 jugadores para apostar.', 409);
  const gameId = room.lunaGameId?.trim() || (process.env.LUNA_NEGRA_GAME_ID ?? '').trim();
  if (!gameId) throw new OnlineRoomError('No se pudo determinar el gameId de Luna Negra para esta sala.', 409);
  const npubs = room.players.map((player) => player.npub);
  if (npubs.some((npub) => !npub)) {
    throw new OnlineRoomError('Todos los jugadores deben tener cuenta Luna Negra (npub) para apostar.', 409);
  }
  const stakeSats = Math.floor(Number(input.stakeSats));
  if (!Number.isFinite(stakeSats) || stakeSats < LUNA_NEGRA_MIN_STAKE_SATS || stakeSats > LUNA_NEGRA_MAX_STAKE_SATS) {
    throw new OnlineRoomError('Monto de apuesta inválido.', 400);
  }
  const participants = npubs as string[];

  const create = await lunaFetch<LunaBetCreate>(config, '/api/v1/bets', {
    method: 'POST',
    body: {
      gameId,
      participants,
      stakeSats,
      victoryCondition: input.victoryCondition?.slice(0, 280) || 'Último jugador en pie gana el pozo.',
      roomId: room.id,
      metadata: { roomId: room.id },
    },
  });
  const { detail, deposits } = await fetchDetailAndDeposits(config, create.betId);
  const bet = buildRoomBet(room, participants, create, detail, deposits, null, input.playerId, nowMs);
  return setRoomBet(store, room.id, bet, nowMs);
}

export async function refreshRoomBet(
  store: RoomStore,
  roomId: string,
  nowMs = Date.now(),
  options: { reportResult?: boolean } = {},
): Promise<OnlineRoom> {
  const config = readApiConfig();
  const room = await loadRoom(store, roomId);
  if (!room.bet) return room;
  const { detail, deposits } = await fetchDetailAndDeposits(config, room.bet.betId);
  if (!detail && !deposits) return room;
  const npubs = room.bet.participants.map((p) => p.npub);
  const bet = buildRoomBet(
    room,
    npubs,
    { betId: room.bet.betId, depositDeadline: room.bet.depositDeadline },
    detail,
    deposits,
    room.bet,
    room.bet.createdByPlayerId,
    nowMs,
  );
  const updated = await setRoomBet(store, room.id, bet, nowMs);
  if (options.reportResult === false) return updated;
  return (await maybeReportRoomBetResult(store, updated, nowMs)) ?? updated;
}

export async function cancelRoomBet(
  store: RoomStore,
  roomId: string,
  playerId: string,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const config = readApiConfig();
  const room = await loadRoom(store, roomId);
  if (!room.bet) throw new OnlineRoomError('No hay apuesta para cancelar.', 404);
  if (room.hostPlayerId !== playerId) throw new OnlineRoomError('Solo el host puede cancelar la apuesta.', 403);
  if (['settled', 'cancelled', 'expired', 'refunded'].includes(room.bet.status)) {
    return room;
  }
  await lunaFetch(config, `/api/v1/bets/${encodeURIComponent(room.bet.betId)}/cancel`, { method: 'POST' });
  return refreshRoomBet(store, roomId, nowMs);
}

/**
 * Liquidación manual disparada por el host desde la pantalla de resultados, como
 * red de seguridad si el reporte automático no llegó a concretarse. Reutiliza
 * refreshRoomBet, que internamente reintenta `maybeReportRoomBetResult`.
 */
export async function settleRoomBet(
  store: RoomStore,
  roomId: string,
  playerId: string,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  readApiConfig();
  const room = await loadRoom(store, roomId);
  if (!room.bet) throw new OnlineRoomError('No hay apuesta para liquidar.', 404);
  if (room.hostPlayerId !== playerId) throw new OnlineRoomError('Solo el host puede liquidar la apuesta.', 403);
  if (room.status !== 'finished') throw new OnlineRoomError('La partida todavía no terminó.', 409);
  const refreshed = await refreshRoomBet(store, roomId, nowMs, { reportResult: false });
  return (await maybeReportRoomBetResult(store, refreshed, nowMs, { throwOnFailure: true })) ?? refreshed;
}

/** Reporta el ganador a Luna Negra cuando la sala terminó y la apuesta está fondeada. */
export async function maybeReportRoomBetResult(
  store: RoomStore,
  room: OnlineRoom,
  nowMs = Date.now(),
  options: { throwOnFailure?: boolean } = {},
): Promise<OnlineRoom | null> {
  const bet = room.bet;
  if (!bet || bet.resultReported) return null;
  if (room.status !== 'finished') return null;
  if (bet.status !== 'funded') return null;
  if (!isLunaNegraApiConfigured()) return null;
  const config = readApiConfig();
  // Usamos los ganadores ya registrados en la apuesta si existen, o los calculamos y persistimos de inmediato
  let winners = bet.winnerNpubs;
  let updatedRoom = room;
  if (!winners) {
    winners = winnerNpubsFromRoom(room);
    const reportedBet: RoomBet = { ...bet, winnerNpubs: winners, updatedAtServerMs: nowMs };
    updatedRoom = await setRoomBet(store, room.id, reportedBet, nowMs);
  }

  // Camino por API key: Luna Negra firma el resultado con el oráculo gestionado
  // del proveedor. El game server no toca Nostr. winners vacío = empate/anulación.
  try {
    await lunaFetch(config, `/api/v1/bets/${encodeURIComponent(bet.betId)}/result`, {
      method: 'POST',
      body: { winners },
    });
  } catch (error) {
    // El reporte falló. Solo lo damos por hecho si Luna Negra ya lo había
    // aceptado/resuelto; otros rechazos quedan reintentables por polling o botón manual.
    const probe = await fetchDetailAndDeposits(config, bet.betId).catch(() => ({ detail: null, deposits: null }));
    const resolved = errorLooksResolved(error) || isResolvedFromLuna(probe.detail, probe.deposits);
    if (!resolved) {
      const failedBet: RoomBet = {
        ...(updatedRoom.bet ?? bet),
        winnerNpubs: winners,
        settlementError: settlementErrorMessage(error),
        updatedAtServerMs: nowMs,
      };
      const failedRoom = await setRoomBet(store, updatedRoom.id, failedBet, nowMs);
      if (options.throwOnFailure) {
        if (error instanceof OnlineRoomError) throw error;
        throw new OnlineRoomError(settlementErrorMessage(error), 502);
      }
      return failedRoom;
    }
  }

  const currentBet = updatedRoom.bet ?? bet;
  const reported: RoomBet = {
    ...currentBet,
    resultReported: true,
    winnerNpubs: winners,
    settlementError: null,
    updatedAtServerMs: nowMs,
  };
  let updated = await setRoomBet(store, updatedRoom.id, reported, nowMs);
  const { detail, deposits } = await fetchDetailAndDeposits(config, bet.betId);
  if (detail || deposits) {
    const npubs = reported.participants.map((p) => p.npub);
    const synced = buildRoomBet(
      updated,
      npubs,
      { betId: bet.betId, depositDeadline: reported.depositDeadline },
      detail,
      deposits,
      reported,
      reported.createdByPlayerId,
      nowMs,
    );
    updated = await setRoomBet(store, updated.id, synced, nowMs);
  }
  return updated;
}

// ───────────────────────── Webhook (auto-registro) ─────────────────────────

interface LunaWebhookConfig {
  url: string | null;
  secret: string | null;
}

let cachedWebhookSecret: string | null = null;
let webhookSetupDone = false;

function webhookPath(): string {
  return '/api/webhooks/luna-negra';
}

/**
 * Registra automáticamente la URL de webhook usando solo la API key y cachea el
 * secreto de firma. Memoizado por instancia. No requiere `LUNA_NEGRA_GAME_ID`.
 * `requestOrigin` es el origin público del deploy (ej. https://mi-tetris.vercel.app).
 */
export async function ensureWebhookRegistered(requestOrigin: string): Promise<void> {
  if (webhookSetupDone || !isLunaNegraApiConfigured()) return;
  webhookSetupDone = true;
  try {
    const config = readApiConfig();
    const explicit = (process.env.LUNA_NEGRA_WEBHOOK_URL ?? '').trim().replace(/\/+$/, '');
    // En previews de Vercel no pisamos la URL de producción salvo override explícito.
    const allowFromRequest = process.env.VERCEL_ENV !== 'preview';
    const desiredUrl = explicit || (allowFromRequest && requestOrigin ? `${requestOrigin}${webhookPath()}` : '');
    if (!desiredUrl) return;

    const current = await lunaFetch<LunaWebhookConfig>(config, '/api/v1/provider/webhook');
    if (current.url === desiredUrl && current.secret) {
      cachedWebhookSecret = current.secret;
      return;
    }
    const updated = await lunaFetch<LunaWebhookConfig>(config, '/api/v1/provider/webhook', {
      method: 'POST',
      body: { url: desiredUrl },
    });
    cachedWebhookSecret = updated.secret;
  } catch {
    // Si falla el registro, el lobby igual refresca la apuesta por polling.
    webhookSetupDone = false;
  }
}

/**
 * Secreto para verificar la firma de los webhooks. Prioriza el override por env;
 * si no, lo obtiene/cachea desde Luna Negra con la API key (sin pegarlo a mano).
 */
export async function getWebhookSecret(): Promise<string | null> {
  const override = (process.env.LUNA_NEGRA_WEBHOOK_SECRET ?? '').trim();
  if (override) return override;
  if (cachedWebhookSecret) return cachedWebhookSecret;
  if (!isLunaNegraApiConfigured()) return null;
  try {
    const config = readApiConfig();
    const current = await lunaFetch<LunaWebhookConfig>(config, '/api/v1/provider/webhook');
    cachedWebhookSecret = current.secret;
    return cachedWebhookSecret;
  } catch {
    return null;
  }
}
