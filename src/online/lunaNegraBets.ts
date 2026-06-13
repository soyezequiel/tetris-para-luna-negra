import {
  loadRoom,
  isTerminalRoomBetStatus,
  OnlineRoomError,
  setRoomBet,
  winnerNpubsFromRoom,
  type RoomStore,
} from './roomService.js';
import type {
  OnlineRoom,
  RoomBet,
  RoomBetDepositStatus,
  RoomBetParticipant,
  RoomBetStatus,
} from './protocol';

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
  depositsReceived?: number;
  depositsTotal?: number;
  participants?: Array<{
    npub: string;
    depositStatus?: string;
    payoutSats?: number | null;
    bolt11?: string | null;
    lnurl?: string | null;
    payUrl?: string | null;
  }>;
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
  };
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  // Los GET de apuesta vienen con `Cache-Control: no-store` desde Luna Negra, así
  // que no hace falta cache-busting ni headers anti-caché del lado del cliente.
  const response = await fetch(`${config.baseUrl}${path}`, {
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

function nonNegInt(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : fallback;
}

const BET_STATUSES: RoomBetStatus[] = [
  'pending_deposits', 'funded', 'settled', 'cancelled', 'expired', 'refunded',
];
const DEPOSIT_STATUSES: RoomBetDepositStatus[] = ['pending', 'paid', 'refunded', 'failed'];

// Luna Negra reporta un único vocabulario canónico (igual a nuestros enums), así
// que solo estrechamos el tipo: si llegara algo fuera del set, caemos al fallback.
function asBetStatus(value: unknown, fallback: RoomBetStatus): RoomBetStatus {
  return BET_STATUSES.includes(value as RoomBetStatus) ? (value as RoomBetStatus) : fallback;
}

function asDepositStatus(value: unknown): RoomBetDepositStatus {
  return DEPOSIT_STATUSES.includes(value as RoomBetDepositStatus)
    ? (value as RoomBetDepositStatus)
    : 'pending';
}

function isTerminalBetStatus(status: RoomBetStatus | undefined | null): boolean {
  return status === 'settled' || status === 'cancelled' || status === 'expired' || status === 'refunded';
}

function buildRoomBet(
  room: OnlineRoom,
  npubs: string[],
  econ: LunaEconomics & { betId: string; depositDeadline?: string | null },
  detail: LunaBetDetail | null,
  previous: RoomBet | null,
  createdByPlayerId: string,
  nowMs: number,
): RoomBet {
  const detailByNpub = new Map((detail?.participants ?? []).map((p) => [p.npub, p]));
  const participants: RoomBetParticipant[] = npubs.map((npub) => {
    const d = detailByNpub.get(npub);
    const player = room.players.find((candidate) => candidate.npub === npub);
    return {
      npub,
      playerId: player?.id ?? null,
      depositStatus: asDepositStatus(d?.depositStatus),
      bolt11: typeof d?.bolt11 === 'string' ? d.bolt11 : null,
      lnurl: typeof d?.lnurl === 'string' ? d.lnurl : null,
      payUrl: typeof d?.payUrl === 'string' ? d.payUrl : null,
      payoutSats: typeof d?.payoutSats === 'number' ? d.payoutSats : null,
    };
  });
  // El detalle viene fresco (Cache-Control: no-store) y es la fuente de verdad:
  // el estado de la apuesta y los depósitos se toman directo de Luna Negra. Solo
  // conservamos del estado previo los campos locales de la sala (bookkeeping del
  // reporte de resultado, marcas de tiempo) que la API no conoce.
  const status = asBetStatus(detail?.status, previous?.status ?? 'pending_deposits');
  const paidParticipants = participants.filter((p) => p.depositStatus === 'paid').length;
  return {
    betId: econ.betId,
    status,
    stakeSats: nonNegInt(detail?.stakeSats ?? econ.stakeSats ?? previous?.stakeSats),
    potSats: nonNegInt(detail?.potSats ?? previous?.potSats),
    potTargetSats: nonNegInt(detail?.potTargetSats ?? econ.potTargetSats ?? previous?.potTargetSats),
    feeSats: nonNegInt(detail?.feeSats ?? econ.feeSats ?? previous?.feeSats),
    feePct: Number.isFinite(Number(detail?.feePct ?? econ.feePct)) ? Number(detail?.feePct ?? econ.feePct) : (previous?.feePct ?? 0),
    netPayoutSats: nonNegInt(detail?.netPayoutSats ?? econ.netPayoutSats ?? previous?.netPayoutSats),
    depositDeadline: econ.depositDeadline ?? detail?.depositDeadline ?? previous?.depositDeadline ?? null,
    depositsReceived: nonNegInt(detail?.depositsReceived ?? paidParticipants),
    depositsTotal: nonNegInt(detail?.depositsTotal ?? npubs.length),
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

// GET /api/v1/bets/{id} trae todo en una sola llamada: estado, economía y, por
// participante, su depósito + los handles de pago (bolt11/lnurl/payUrl).
async function getBetDetail(config: LunaConfig, betId: string): Promise<LunaBetDetail | null> {
  return lunaFetch<LunaBetDetail>(
    config,
    `/api/v1/bets/${encodeURIComponent(betId)}`,
  ).catch(() => null);
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
  const detail = await getBetDetail(config, create.betId);
  const bet = buildRoomBet(room, participants, create, detail, null, input.playerId, nowMs);
  return setRoomBet(store, room.id, bet, nowMs);
}

/**
 * Mantiene la apuesta pendiente en sincronía con los jugadores de la sala: si
 * alguien entró (o salió) después de que el host creó la apuesta y todavía NO
 * hubo ningún depósito, se cancela la apuesta en Luna Negra y se recrea con el
 * mismo stake incluyendo a todos los jugadores actuales. Con depósitos ya
 * hechos no se toca (no podemos cambiar participantes sin perder pagos).
 * Best-effort: ante cualquier falla devuelve la sala sin cambios.
 */
export async function syncBetParticipantsWithRoom(
  store: RoomStore,
  roomId: string,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await loadRoom(store, roomId);
  const bet = room.bet;
  if (!bet || bet.status !== 'pending_deposits') return room;
  if (room.status !== 'lobby') return room;
  if (!isLunaNegraApiConfigured()) return room;
  const anyDeposit = bet.depositsReceived > 0
    || bet.participants.some((participant) => participant.depositStatus === 'paid');
  if (anyDeposit) return room;
  const roomNpubs = room.players.map((player) => player.npub);
  if (roomNpubs.some((npub) => !npub)) return room;
  const desired = [...new Set(roomNpubs as string[])].sort();
  const current = [...new Set(bet.participants.map((participant) => participant.npub))].sort();
  if (desired.length === current.length && desired.every((npub, index) => npub === current[index])) return room;
  if (desired.length < 2) return room;

  try {
    const config = readApiConfig();
    await lunaFetch(config, `/api/v1/bets/${encodeURIComponent(bet.betId)}/cancel`, { method: 'POST' }).catch(() => undefined);
    // Limpiamos la apuesta local antes de recrear: createBetForRoom rechaza
    // salas con una apuesta no terminal.
    await setRoomBet(store, room.id, null, nowMs);
    return await createBetForRoom(store, {
      roomId: room.id,
      playerId: room.hostPlayerId,
      stakeSats: bet.stakeSats,
    }, nowMs);
  } catch {
    return loadRoom(store, roomId).catch(() => room);
  }
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
  const detail = await getBetDetail(config, room.bet.betId);
  if (!detail) return room;
  const npubs = room.bet.participants.map((p) => p.npub);
  const bet = buildRoomBet(
    room,
    npubs,
    { betId: room.bet.betId, depositDeadline: room.bet.depositDeadline },
    detail,
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
    // El reporte falló de verdad. El éxito —incluido re-reportar el mismo ganador—
    // vuelve 200 idempotente (`alreadyResolved`) y no entra acá; lo que llega son
    // rechazos genuinos (NOT_READY, CONTRACT_MISMATCH, etc.), reintentables por
    // polling o por el botón manual de liquidación.
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

  const currentBet = updatedRoom.bet ?? bet;
  const reported: RoomBet = {
    ...currentBet,
    resultReported: true,
    winnerNpubs: winners,
    settlementError: null,
    updatedAtServerMs: nowMs,
  };
  let updated = await setRoomBet(store, updatedRoom.id, reported, nowMs);
  const detail = await getBetDetail(config, bet.betId);
  if (detail) {
    const npubs = reported.participants.map((p) => p.npub);
    const synced = buildRoomBet(
      updated,
      npubs,
      { betId: bet.betId, depositDeadline: reported.depositDeadline },
      detail,
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
