import {
  loadRoom,
  isTerminalRoomBetStatus,
  OnlineRoomError,
  RoomVersionConflictError,
  setRoomBet,
  winnerBetNpubsFromRoom,
  type RoomStore,
} from './roomService.js';
import type {
  OnlineRoom,
  RoomBet,
  RoomBetDepositStatus,
  RoomBetParticipant,
  RoomBetPayoutStatus,
  RoomBetStatus,
  UnsignedZapRequestTemplate,
} from './protocol';
import { alertBetDepositHandlesIncomplete } from './moneyPathAlert.js';
import {
  pubkeyFromNpub,
  ngeConnected,
  fetchNgeConfig,
  fetchNgeBet,
  createNgeBet,
  reportNgeResult,
  cancelNgeBet,
  type NgeConfig,
} from './lunaNegraNge.js';

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
    payoutStatus?: string;
    payoutSats?: number | null;
    bolt11?: string | null;
    lnurl?: string | null;
    payUrl?: string | null;
    // v2 (zaps): 9734 sin firmar + callback para que el cliente firme el depósito y
    // obtenga el invoice (así extensión y QR son zaps reales, no LNURL-pay plano).
    depositZapRequest?: UnsignedZapRequestTemplate | null;
    depositCallback?: string | null;
    // v2 (zaps): comentario de participación sin firmar + callback donde postearlo
    // firmado. Si el jugador gana, el premio se ancla a su comentario.
    participationComment?: UnsignedZapRequestTemplate | null;
    commentCallback?: string | null;
    withdrawLnurl?: string | null;
    withdrawUrl?: string | null;
    depositError?: string | null;
    // v2 (zaps): el cobro es push por zap. `payoutKind` = 'zap' | 'lnurl' | 'withdraw'.
    // 'withdraw' (invitado sin destino) no trae LNURL por API key: se reclama en la
    // página hosteada <base>/apuestas/{betId}. `participantId` es el asiento estable.
    payoutKind?: string | null;
    participantId?: string | null;
  }>;
}

interface LunaBetCreateWithSeats extends LunaBetCreate {
  /** Mapeo asiento→npub que devuelve Luna cuando hay invitados (anónima/mixta). */
  participants?: Array<{ seat: number; npub: string }>;
}

export const LUNA_NEGRA_MIN_STAKE_SATS = 1;
export const LUNA_NEGRA_MAX_STAKE_SATS = 1_000_000;

export function isLunaNegraApiConfigured(): boolean {
  // NGE-only: el único gate de apuestas es la credencial del escrow.
  return ngeConnected();
}

// Base URL pública de Luna Negra para armar el link web de reclamo de retiro del
// ganador invitado (v2). Deriva de LUNA_NEGRA_BASE_URL (la usa también el social).
function publicLunaBaseUrl(): string {
  return (process.env.LUNA_NEGRA_BASE_URL ?? '').replace(/\/+$/, '');
}

/**
 * URL de reclamo del cobro para un ganador invitado en v2. El escrow paga automático
 * (`payoutStatus: paid`) al ganador con dirección Lightning; el invitado sin destino
 * queda `withdraw_pending` y reclama su parte en la página hosteada
 * `<base>/apuestas/{betId}` (con su sesión). Devuelve null si no aplica o no hay base URL.
 */
function withdrawClaimUrl(
  betId: string,
  payoutStatus: RoomBetPayoutStatus,
  payoutKind: string | null | undefined,
  detailWithdrawUrl: string | null,
): string | null {
  if (detailWithdrawUrl) return detailWithdrawUrl;
  const isWithdraw = payoutStatus === 'withdraw_pending' || payoutKind === 'withdraw';
  if (!isWithdraw) return null;
  const base = publicLunaBaseUrl();
  return base ? `${base}/apuestas/${encodeURIComponent(betId)}` : null;
}

function nonNegInt(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : fallback;
}

const BET_STATUSES: RoomBetStatus[] = [
  'pending_deposits', 'funded', 'settled', 'cancelled', 'expired', 'refunded',
];
const DEPOSIT_STATUSES: RoomBetDepositStatus[] = ['pending', 'paid', 'refunded', 'failed'];
const PAYOUT_STATUSES: RoomBetPayoutStatus[] = [
  'none', 'pending', 'paid', 'failed', 'withdraw_pending', 'claimed', 'forfeited',
];

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

function asPayoutStatus(value: unknown): RoomBetPayoutStatus {
  return PAYOUT_STATUSES.includes(value as RoomBetPayoutStatus)
    ? (value as RoomBetPayoutStatus)
    : 'none';
}

// Estrecha el 9734 sin firmar que manda Luna (v2): validamos la forma mínima que el
// signer necesita (kind/created_at/tags/content). Si no cuadra, va null y el panel
// cae al fallback `payUrl` (firmar en la web de Luna).
function asUnsignedZapRequest(value: unknown): UnsignedZapRequestTemplate | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.kind !== 'number' ||
    typeof v.created_at !== 'number' ||
    typeof v.content !== 'string' ||
    !Array.isArray(v.tags) ||
    !v.tags.every((t) => Array.isArray(t) && t.every((s) => typeof s === 'string'))
  ) {
    return null;
  }
  return {
    kind: v.kind,
    created_at: v.created_at,
    tags: v.tags as string[][],
    content: v.content,
  };
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
  // Mapeo explícito asiento→jugador, presente solo al CREAR la apuesta. Para los
  // invitados el npub es efímero (≠ npub del jugador), así que no se puede mapear
  // por npub: hay que fijarlo acá y luego preservarlo (carry-forward del previo).
  playerIdByNpub: Map<string, string | null> | null = null,
): RoomBet {
  const detailByNpub = new Map((detail?.participants ?? []).map((p) => [p.npub, p]));
  const prevByNpub = new Map((previous?.participants ?? []).map((p) => [p.npub, p]));
  const participants: RoomBetParticipant[] = npubs.map((npub) => {
    const d = detailByNpub.get(npub);
    const previousParticipant = prevByNpub.get(npub);
    const payoutStatus = asPayoutStatus(d?.payoutStatus);
    // Un retiro pendiente representa el mismo cobro hasta que vence o se reclama.
    // Conservamos el primer handle válido: servidores viejos podían re-firmar el
    // token en cada GET, cambiando el LNURL y obligando a regenerar/parpadear el QR.
    const preserveWithdrawHandle = payoutStatus === 'withdraw_pending'
      && previousParticipant?.payoutStatus === 'withdraw_pending';
    // playerId: 1) el del bet previo (estable, sobrevive a npubs efímeros de invitado),
    // 2) el mapeo explícito del create, 3) match por npub real en la sala.
    const playerId = previousParticipant?.playerId
      ?? playerIdByNpub?.get(npub)
      ?? room.players.find((candidate) => candidate.npub === npub)?.id
      ?? null;
    return {
      npub,
      playerId,
      depositStatus: asDepositStatus(d?.depositStatus),
      bolt11: typeof d?.bolt11 === 'string' ? d.bolt11 : null,
      lnurl: typeof d?.lnurl === 'string' ? d.lnurl : null,
      payUrl: typeof d?.payUrl === 'string' ? d.payUrl : null,
      depositZapRequest: asUnsignedZapRequest(d?.depositZapRequest),
      depositCallback: typeof d?.depositCallback === 'string' ? d.depositCallback : null,
      participationComment: asUnsignedZapRequest(d?.participationComment),
      commentCallback: typeof d?.commentCallback === 'string' ? d.commentCallback : null,
      depositError: typeof d?.depositError === 'string' ? d.depositError : null,
      payoutSats: typeof d?.payoutSats === 'number' ? d.payoutSats : null,
      payoutStatus,
      withdrawLnurl: preserveWithdrawHandle && previousParticipant.withdrawLnurl
        ? previousParticipant.withdrawLnurl
        : (typeof d?.withdrawLnurl === 'string' ? d.withdrawLnurl : null),
      // v2: el detalle no trae withdrawUrl para el invitado; lo derivamos a la página
      // hosteada de reclamo. Conservamos el handle previo mientras siga pendiente.
      withdrawUrl: preserveWithdrawHandle && previousParticipant.withdrawUrl
        ? previousParticipant.withdrawUrl
        : withdrawClaimUrl(
            econ.betId,
            payoutStatus,
            typeof d?.payoutKind === 'string' ? d.payoutKind : null,
            typeof d?.withdrawUrl === 'string' ? d.withdrawUrl : null,
          ),
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

function comparableRoomBet(bet: RoomBet): Omit<RoomBet, 'updatedAtServerMs'> {
  const { updatedAtServerMs: _updatedAtServerMs, ...rest } = bet;
  return rest;
}

function sameRoomBetForRefresh(current: RoomBet, next: RoomBet): boolean {
  return JSON.stringify(comparableRoomBet(current)) === JSON.stringify(comparableRoomBet(next));
}

function settlementErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'No se pudo reportar el resultado a Luna Negra.';
}

/**
 * Cancela/anula la apuesta en el escrow NGE v2: pre-fondeo → RPC `cancel_bet`
 * (reembolsa a quien ya pagó); ya fondeada → `report_result` con ganadores vacío
 * (anulación con reembolso a todos, spec §8, ya que `cancel_bet` daría NOT_CANCELLABLE).
 */
async function cancelBetRemote(betId: string, funded = false): Promise<void> {
  if (funded) await reportNgeResult(betId, []);
  else await cancelNgeBet(betId);
}

/**
 * Trae el detalle de la apuesta sintetizado desde el RPC `get_bet` del escrow (la
 * fuente de verdad). `npubs`/`stakeSats` fijan el mapeo asiento→jugador y el pozo.
 */
async function fetchDetail(
  betId: string,
  npubs: string[],
  stakeSats: number,
  previous?: RoomBet | null,
): Promise<LunaBetDetail | null> {
  const ngeConfig = await fetchNgeConfig();
  return synthesizeNgeBetDetail(betId, npubs, stakeSats, ngeConfig, previous);
}

export async function createBetForRoom(
  store: RoomStore,
  input: { roomId: string; playerId: string; stakeSats: number; victoryCondition?: string },
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await loadRoom(store, input.roomId);
  if (room.hostPlayerId !== input.playerId) throw new OnlineRoomError('Solo el host puede crear la apuesta.', 403);
  if (room.status !== 'lobby') throw new OnlineRoomError('La sala ya empezó.', 409);
  if (room.bet && !isTerminalRoomBetStatus(room.bet.status)) {
    throw new OnlineRoomError('Ya hay una apuesta activa para esta sala.', 409);
  }
  if (room.players.length < 2) throw new OnlineRoomError('Se necesitan al menos 2 jugadores para apostar.', 409);
  const gameId = room.lunaGameId?.trim() || (process.env.LUNA_NEGRA_GAME_ID ?? '').trim();
  const stakeSats = Math.floor(Number(input.stakeSats));
  if (!Number.isFinite(stakeSats) || stakeSats < LUNA_NEGRA_MIN_STAKE_SATS || stakeSats > LUNA_NEGRA_MAX_STAKE_SATS) {
    throw new OnlineRoomError('Monto de apuesta inválido.', 400);
  }

  const players = room.players;

  // NGE v2 (corte duro): con la credencial `NGE_CONNECTION` y todos los asientos con
  // npub (los invitados obtienen una cuenta efímera local, Paso 3), la apuesta va 100%
  // por el RPC cifrado del escrow (create_bet / get_bet / report_result). El SDK NGE
  // devuelve un bolt11 por asiento; sin credencial NGE, no hay apuestas. Ver
  // docs/nge-migration.md y el SDK vendorizado en src/online/nge.ts.
  if (ngeConnected() && players.every((player) => !!player.npub)) {
    const created = await createBetViaNge(room, stakeSats, input.victoryCondition);
    return finalizeCreatedBet(store, room, created, gameId || 'nge', input.playerId, nowMs);
  }

  throw new OnlineRoomError('El servidor usa el modo NGE que requiere que todos los jugadores tengan cuenta.', 400);
}







/**
 * NGE v2: crea la apuesta por RPC `create_bet`. Solo se llama cuando todos los
 * asientos tienen npub (validado por el caller; los invitados obtienen una cuenta
 * efímera local — Paso 3). El `seatId` estable = npub del jugador, así el mapeo
 * asiento→jugador de v1 se conserva en `get_bet`/`report_result`. Devuelve la misma
 * forma que `POST /api/v2/bets`: `betId` = id que asigna el escrow.
 */
async function createBetViaNge(
  room: OnlineRoom,
  stakeSats: number,
  victoryCondition: string | undefined,
): Promise<LunaBetCreateWithSeats> {
  const seats = room.players.map((player) => ({
    seatId: player.npub as string,
    // `pubkey` habilita que el escrow pueda pagar el premio a esa identidad si tiene
    // lud16; sin destino, el ganador cobra por QR de retiro (cascada §8).
    pubkey: pubkeyFromNpub(player.npub as string),
  }));
  const created = await createNgeBet({ seats, stakeSats, victoryCondition });
  return { betId: created.betId, stakeSats };
}

/** Estado público NGE v2 → vocabulario RoomBetStatus de Tetris. `resolving` (entre
 *  funded y settled, mientras el escrow liquida) se muestra como `funded`: sigue en
 *  vuelo, no es terminal. */
function mapNgeStatusToRoomStatus(status: string): RoomBetStatus {
  switch (status) {
    case 'funded':
    case 'resolving':
      return 'funded';
    case 'settled':
      return 'settled';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    case 'refunded':
      return 'refunded';
    case 'pending_deposits':
    default:
      return 'pending_deposits';
  }
}

/**
 * NGE v2: sintetiza el `LunaBetDetail` desde `get_bet` (la fuente de verdad del
 * escrow). Mapea cada asiento (seatId = npub) a su participante: el `bolt11` vigente
 * si no pagó —el escrow lo re-emite—, el estado de depósito, y el payout
 * (tier/sats/status) si ya se liquidó. Reemplaza a la síntesis desde el 31340 de v1.
 */
async function synthesizeNgeBetDetail(
  betId: string,
  npubs: string[],
  stakeSats: number,
  config: NgeConfig,
  previous?: RoomBet | null,
): Promise<LunaBetDetail> {
  const bet = await fetchNgeBet(betId).catch(() => null);
  const bySeatId = new Map((bet?.seats ?? []).map((s) => [s.seatId, s]));
  const prevByNpub = new Map((previous?.participants ?? []).map((p) => [p.npub, p]));
  const potTargetSats = stakeSats * npubs.length;
  const feePctTotal = config.feePct + config.devFeePct;

  const participants = npubs.map((npub) => {
    const seat = bySeatId.get(npub);
    const prev = prevByNpub.get(npub);
    const deposited = seat?.deposited ?? false;
    const payout = seat?.payout ?? null;
    return {
      npub,
      depositStatus: deposited ? 'paid' : 'pending',
      // get_bet re-emite el bolt11 vigente para asientos sin pagar; conservamos el
      // previo como respaldo si un poll llega sin él.
      bolt11: deposited ? null : (seat?.bolt11 ?? prev?.bolt11 ?? null),
      payoutStatus: payout?.status ?? 'none',
      payoutSats: payout ? payout.sats : null,
      payoutKind: payout?.tier ?? null,
    };
  });

  const paidCount = participants.filter((p) => p.depositStatus === 'paid').length;
  const potSats = bet?.potSats ?? stakeSats * paidCount;
  const feeSats = Math.floor(potTargetSats * (feePctTotal / 100));

  return {
    betId,
    status: bet ? mapNgeStatusToRoomStatus(bet.status) : 'pending_deposits',
    stakeSats,
    potSats,
    potTargetSats,
    feeSats,
    feePct: feePctTotal,
    netPayoutSats: Math.max(0, potTargetSats - feeSats),
    depositsReceived: paidCount,
    depositsTotal: npubs.length,
    participants,
  };
}

/**
 * Cola común de la creación (legacy y NGP): mapea asiento→jugador, trae el detalle
 * con los handles de depósito, arma el RoomBet y lo persiste. Si hubo invitados
 * (solo legacy) Luna devuelve el mapeo asiento→npub en orden; si fue 100% con
 * cuenta, el mapeo es directo por npub.
 */
async function finalizeCreatedBet(
  store: RoomStore,
  room: OnlineRoom,
  create: LunaBetCreateWithSeats,
  gameId: string,
  createdByPlayerId: string,
  nowMs: number,
): Promise<OnlineRoom> {
  const players = room.players;
  let npubs: string[];
  const playerIdByNpub = new Map<string, string | null>();
  if (create.participants && create.participants.length) {
    const sorted = [...create.participants].sort((a, b) => a.seat - b.seat);
    npubs = sorted.map((s) => s.npub);
    sorted.forEach((s, index) => playerIdByNpub.set(s.npub, players[index]?.id ?? null));
  } else {
    npubs = players.map((player) => player.npub as string);
    players.forEach((player) => playerIdByNpub.set(player.npub as string, player.id));
  }

  const detail = await fetchDetail(create.betId, npubs, create.stakeSats ?? 0);
  const bet = buildRoomBet(room, npubs, create, detail, null, createdByPlayerId, nowMs, playerIdByNpub);
  const updatedRoom = await setRoomBet(store, room.id, bet, nowMs);
  // Reporte de diagnóstico a Discord: si algún participante quedó sin forma de depositar
  // en el juego (ni bolt11 ni 9734+callback), avisamos con el detalle de qué vino y qué
  // falta. `await` a propósito: en serverless, sin esperar, el fetch se corta al terminar
  // la función. Nunca lanza (best-effort), así que no afecta la creación de la apuesta.
  await alertBetDepositHandlesIncomplete(bet, { roomId: room.id, gameId });
  return updatedRoom;
}

/**
 * Mantiene la apuesta en sincronía con los jugadores de la sala mientras está en
 * el lobby (antes de arrancar):
 *  - Sin depósitos todavía: si alguien entró o salió, se cancela en Luna y se
 *    recrea con el mismo stake incluyendo a todos los jugadores actuales.
 *  - Con depósitos ya hechos: no se pueden cambiar participantes sin perder pagos,
 *    así que si alguien que YA estaba en el pozo se fue de la sala, cancelamos el
 *    pozo en Luna —reembolso a TODOS los que pagaron— y dejamos el estado terminal;
 *    el host lo vuelve a crear con el roster actual. Sin esto, el que fondeó y se
 *    fue forfeiteaba su stake al pozo. Ver [[online-mixed-bet-no-nostr]].
 * Best-effort: ante cualquier falla devuelve la sala sin cambios.
 */
export async function syncBetParticipantsWithRoom(
  store: RoomStore,
  roomId: string,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await loadRoom(store, roomId);
  const bet = room.bet;
  if (!bet || isTerminalRoomBetStatus(bet.status)) return room;
  if (room.status !== 'lobby') return room;
  if (!isLunaNegraApiConfigured()) return room;
  const anyDeposit = bet.depositsReceived > 0
    || bet.participants.some((participant) => participant.depositStatus === 'paid');

  // Con depósitos: solo actuamos si un participante del pozo dejó la sala. No se
  // puede recrear sin perder pagos, así que cancelamos (refund a todos) y listo.
  if (anyDeposit) {
    const activePlayerIds = new Set(room.players.map((player) => player.id));
    const someoneLeft = bet.participants.some(
      (participant) => participant.playerId && !activePlayerIds.has(participant.playerId),
    );
    if (!someoneLeft) return room;
    try {
      await cancelBetRemote(bet.betId, bet.status === 'funded');
      const refreshed = await refreshRoomBet(store, roomId, nowMs, { reportResult: false });
      if (refreshed.bet && isTerminalRoomBetStatus(refreshed.bet.status)) return refreshed;
      // El GET no reflejó la cancelación: forzamos el estado terminal igual (como
      // hace cancelRoomBet) para que el host vea el reembolso y pueda recrear.
      const cancelled: RoomBet = { ...(refreshed.bet ?? bet), status: 'cancelled', updatedAtServerMs: nowMs };
      return setRoomBet(store, roomId, cancelled, nowMs);
    } catch {
      return loadRoom(store, roomId).catch(() => room);
    }
  }

  if (bet.status !== 'pending_deposits') return room;
  // Comparamos por jugador de la sala (playerId), no por npub: los invitados no
  // tienen npub propio (es efímero), así que el conjunto estable es el de jugadores.
  const desired = [...new Set(room.players.map((player) => player.id))].sort();
  const current = [...new Set(
    bet.participants.map((participant) => participant.playerId).filter((id): id is string => !!id),
  )].sort();
  if (desired.length === current.length && desired.every((id, index) => id === current[index])) return room;
  if (desired.length < 2) return room;

  try {
    await cancelBetRemote(bet.betId).catch(() => undefined);
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
  const room = await loadRoom(store, roomId);
  if (!room.bet) return room;
  const npubs = room.bet.participants.map((p) => p.npub);
  const detail = await fetchDetail(room.bet.betId, npubs, room.bet.stakeSats, room.bet);
  if (!detail) return room;
  const bet = buildRoomBet(
    room,
    npubs,
    { betId: room.bet.betId, depositDeadline: room.bet.depositDeadline },
    detail,
    room.bet,
    room.bet.createdByPlayerId,
    nowMs,
  );
  if (sameRoomBetForRefresh(room.bet, bet)) {
    if (options.reportResult === false) return room;
    return (await maybeReportRoomBetResult(store, room, nowMs)) ?? room;
  }
  let updated: OnlineRoom;
  try {
    updated = await setRoomBet(store, room.id, bet, nowMs);
  } catch (error) {
    if (error instanceof RoomVersionConflictError) {
      return loadRoom(store, room.id).catch(() => room);
    }
    throw error;
  }
  if (options.reportResult === false) return updated;
  return (await maybeReportRoomBetResult(store, updated, nowMs)) ?? updated;
}

export async function cancelRoomBet(
  store: RoomStore,
  roomId: string,
  playerId: string,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await loadRoom(store, roomId);
  if (!room.bet) throw new OnlineRoomError('No hay apuesta para cancelar.', 404);
  if (room.hostPlayerId !== playerId) throw new OnlineRoomError('Solo el host puede cancelar la apuesta.', 403);
  if (['settled', 'cancelled', 'expired', 'refunded'].includes(room.bet.status)) {
    return room;
  }
  // NGE v2: cancel_bet pre-fondeo, o report_result con ganadores vacío si ya está
  // fondeada (anulación con reembolso).
  await cancelBetRemote(room.bet.betId, room.bet.status === 'funded');
  // El cancel ya salió. refreshRoomBet es best-effort: si el get_bet falla (red, 404
  // transitorio) devuelve la sala sin tocar el bet → la apuesta quedaría "pendiente"
  // pese a estar cancelada. Forzamos el estado terminal para que el host vea la
  // cancelación igual (el RPC de cancel no devuelve estado).
  const refreshed = await refreshRoomBet(store, roomId, nowMs);
  if (!refreshed.bet || isTerminalRoomBetStatus(refreshed.bet.status)) return refreshed;
  const bet: RoomBet = { ...refreshed.bet, status: 'cancelled', updatedAtServerMs: nowMs };
  return setRoomBet(store, roomId, bet, nowMs);
}

export async function retryRoomBetInvoiceGeneration(
  store: RoomStore,
  roomId: string,
  playerId: string,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await loadRoom(store, roomId);
  const bet = room.bet;
  if (!bet) throw new OnlineRoomError('No hay apuesta para reintentar.', 404);
  if (room.hostPlayerId !== playerId) throw new OnlineRoomError('Solo el host puede reintentar la apuesta.', 403);
  if (room.status !== 'lobby') throw new OnlineRoomError('La sala ya empezó.', 409);
  if (bet.status !== 'pending_deposits') {
    throw new OnlineRoomError('La apuesta ya no está esperando depósitos.', 409);
  }
  const hasDeposit = bet.depositsReceived > 0
    || bet.participants.some((participant) => participant.depositStatus === 'paid');
  if (hasDeposit) {
    throw new OnlineRoomError('No se puede recrear una apuesta con depósitos recibidos.', 409);
  }
  const hasInvoiceFailure = bet.participants.some((participant) => (
    participant.depositStatus === 'pending'
    && !!participant.depositError
    && !participant.bolt11
    && !participant.lnurl
    && !participant.payUrl
  ));
  if (!hasInvoiceFailure) return refreshRoomBet(store, roomId, nowMs);

  await cancelBetRemote(bet.betId).catch(() => undefined);
  await setRoomBet(store, room.id, null, nowMs);
  return createBetForRoom(store, {
    roomId: room.id,
    playerId,
    stakeSats: bet.stakeSats,
  }, nowMs);
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
  // Usamos los ganadores ya registrados en la apuesta si existen, o los calculamos y persistimos de inmediato
  let winners = bet.winnerNpubs;
  let updatedRoom = room;
  if (!winners) {
    // Mapeamos el ganador por playerId al npub de SU participante en la apuesta
    // (real o efímero de invitado); winnerNpubsFromRoom no sirve porque el
    // invitado no tiene npub en la sala. Vacío = empate/anulación → reembolso.
    winners = winnerBetNpubsFromRoom(room);
    const reportedBet: RoomBet = { ...bet, winnerNpubs: winners, updatedAtServerMs: nowMs };
    updatedRoom = await setRoomBet(store, room.id, reportedBet, nowMs);
  }

  // NGE v2: report_result por RPC con los seatId ganadores (= npubs que fijamos al
  // crear la apuesta). El escrow liquida y paga; la firma del request (credencial `C`)
  // es la autenticación. Vacío = empate/anulación → reembolso a todos.
  try {
    await reportNgeResult(bet.betId, winners);
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
  const detail = await fetchDetail(bet.betId, bet.participants.map((p) => p.npub), bet.stakeSats, updated.bet ?? bet);
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

