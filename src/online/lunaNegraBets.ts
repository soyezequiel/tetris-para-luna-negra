import {
  loadRoom,
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
  const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | T | null;
  if (!response.ok) {
    const err = payload as { error?: { code?: string; message?: string } } | null;
    const message = err?.error?.message ?? `Luna Negra respondió ${response.status}.`;
    throw new OnlineRoomError(message, response.status === 400 || response.status === 409 ? response.status : 502);
  }
  return payload as T;
}

function nonNegInt(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : fallback;
}

function normalizeDepositStatus(value: unknown): RoomBetParticipant['depositStatus'] {
  if (value === 'paid' || value === 'refunded' || value === 'failed') return value;
  return 'pending';
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
  const participants: RoomBetParticipant[] = npubs.map((npub) => {
    const d = detailByNpub.get(npub);
    const h = depByNpub.get(npub);
    const player = room.players.find((candidate) => candidate.npub === npub);
    return {
      npub,
      playerId: player?.id ?? null,
      depositStatus: normalizeDepositStatus(h?.depositStatus ?? d?.depositStatus),
      bolt11: typeof h?.bolt11 === 'string' ? h.bolt11 : null,
      lnurl: typeof h?.lnurl === 'string' ? h.lnurl : null,
      payUrl: typeof h?.payUrl === 'string' ? h.payUrl : null,
      payoutSats: typeof d?.payoutSats === 'number' ? d.payoutSats : null,
    };
  });
  const status = (detail?.status ?? deposits?.status ?? previous?.status ?? 'pending_deposits') as RoomBet['status'];
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
    createdByPlayerId,
    createdAtServerMs: previous?.createdAtServerMs ?? nowMs,
    updatedAtServerMs: nowMs,
  };
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
  if (room.bet && !['cancelled', 'expired', 'refunded'].includes(room.bet.status)) {
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

export async function refreshRoomBet(store: RoomStore, roomId: string, nowMs = Date.now()): Promise<OnlineRoom> {
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

/** Reporta el ganador a Luna Negra cuando la sala terminó y la apuesta está fondeada. */
export async function maybeReportRoomBetResult(
  store: RoomStore,
  room: OnlineRoom,
  nowMs = Date.now(),
): Promise<OnlineRoom | null> {
  const bet = room.bet;
  if (!bet || bet.resultReported) return null;
  if (room.status !== 'finished') return null;
  if (bet.status !== 'funded') return null;
  if (!isLunaNegraApiConfigured()) return null;
  const config = readApiConfig();
  const winners = winnerNpubsFromRoom(room);

  // Camino por API key: Luna Negra firma el resultado con el oráculo gestionado
  // del proveedor. El game server no toca Nostr. winners vacío = empate/anulación.
  try {
    await lunaFetch(config, `/api/v1/bets/${encodeURIComponent(bet.betId)}/result`, {
      method: 'POST',
      body: { winners },
    });
  } catch {
    // Si ya estaba resuelta (ALREADY_RESOLVED) u otro error transitorio, lo marcamos
    // igual y dejamos que el siguiente refresh sincronice el estado real.
  }
  const reported: RoomBet = { ...bet, resultReported: true, winnerNpubs: winners, updatedAtServerMs: nowMs };
  let updated = await setRoomBet(store, room.id, reported, nowMs);
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
    updated = await setRoomBet(store, room.id, synced, nowMs);
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
