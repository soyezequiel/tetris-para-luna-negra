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
import { isLunaMockEnabled, lunaMockFetch } from './lunaNegraMock.js';
import { alertBetDepositHandlesIncomplete } from './moneyPathAlert.js';
import {
  ngpBetsEnabled,
  ngpKeylessEnabled,
  ngpEventsEnabled,
  ngpOraclePubkey,
  ensureOracleDeclared,
  signNgpResultEvent,
  signNgpVoidEvent,
  fetchNgpConfig,
  publishNgpContract,
  publishBareNgpContract,
  publishSignedEventToRelays,
  pubkeyFromNpub,
} from './lunaNegraNgp.js';
import {
  fetchNgpTerms,
  fetchNgpBetState,
  pokeNgpBetDepositSync,
  mapNgpStatusToRoomStatus,
  buildDepositZapRequestTemplate,
  encodeLnurl,
  storeLnurlUrl,
  type NgpTerms,
} from './lunaNegraEvents.js';

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

function readApiConfig(): LunaConfig {
  // Mock dev (hard test): sentinels válidos para no exigir env de Luna real.
  if (isLunaMockEnabled()) return { baseUrl: 'mock://luna-negra', apiKey: 'mock' };
  const baseUrl = (process.env.LUNA_NEGRA_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = (process.env.LUNA_NEGRA_API_KEY ?? '').trim();
  if (!baseUrl) throw new OnlineRoomError('LUNA_NEGRA_BASE_URL no está configurada.', 500);
  // Modo eventos: no se usa la API key (todo va por eventos + LNURL de la tienda). Solo
  // hace falta la base URL para armar el LNURL-pay. En el resto de los modos, la key es
  // obligatoria.
  if (!apiKey && !ngpEventsEnabled()) {
    throw new OnlineRoomError('LUNA_NEGRA_API_KEY no está configurada.', 500);
  }
  return { baseUrl, apiKey };
}

export function isLunaNegraApiConfigured(): boolean {
  if (isLunaMockEnabled()) return true;
  // Modo eventos: alcanza con la base URL (la API key no se usa).
  if (ngpEventsEnabled()) return Boolean((process.env.LUNA_NEGRA_BASE_URL ?? '').trim());
  return Boolean(
    (process.env.LUNA_NEGRA_BASE_URL ?? '').trim()
    && (process.env.LUNA_NEGRA_API_KEY ?? '').trim(),
  );
}

// Base URL pública de Luna Negra para armar links web (claim de retiro del ganador
// invitado en v2). En mock no hay página real, así que devolvemos ''.
function publicLunaBaseUrl(): string {
  if (isLunaMockEnabled()) return '';
  return (process.env.LUNA_NEGRA_BASE_URL ?? '').replace(/\/+$/, '');
}

/**
 * URL de reclamo del cobro para un ganador invitado en v2. El escrow por zaps paga
 * automático (`payoutStatus: paid`) al ganador con dirección Lightning; el invitado
 * sin destino queda `withdraw_pending` y reclama su parte en la página hosteada
 * `<base>/apuestas/{betId}` (con su sesión). Esa página NO viene por la API key, así
 * que la construimos acá. Devuelve null si no aplica o si no hay base URL (mock).
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

// Traduce los códigos de error propios de la v2 (zaps) a mensajes claros para el
// panel; el resto conserva el mensaje del proveedor. Reemplazo duro a v2: si el
// deploy no la tiene habilitada, todas las apuestas fallan, así que el motivo tiene
// que ser legible y no un 502 mudo.
function messageForBetError(
  code: string | null,
  providerMessage: string | undefined,
  httpStatus: number,
): string {
  if (code === 'BETS_V2_DISABLED') {
    return 'Las apuestas por zaps no están habilitadas en este servidor de Luna Negra.';
  }
  if (code === 'ANCHOR_PUBLISH_FAILED') {
    return 'No se pudo anclar el contrato de la apuesta en Nostr; reintentá en un momento.';
  }
  return providerMessage ?? `Luna Negra respondió ${httpStatus}.`;
}

async function lunaFetch<T>(
  config: LunaConfig,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' },
): Promise<T> {
  // Mock dev (hard test): el money-path corre en memoria, sin red.
  if (isLunaMockEnabled()) return lunaMockFetch<T>(path, init);
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
    const code = err?.error?.code ?? null;
    const message = messageForBetError(code, err?.error?.message, response.status);
    const status = response.status === 400 || response.status === 409 ? response.status : 502;
    throw new LunaApiError(message, status, response.status, code);
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

function hasPendingNgpInvoice(bet: RoomBet | null | undefined): boolean {
  return bet?.status === 'pending_deposits'
    && bet.participants.some((p) => p.depositStatus === 'pending' && typeof p.bolt11 === 'string' && p.bolt11.length > 0);
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
  const code = error instanceof LunaApiError ? error.code : null;
  const message = error instanceof Error ? error.message : 'No se pudo reportar el resultado a Luna Negra.';
  return code ? `${code}: ${message}` : message;
}

// GET /api/v2/bets/{id} trae todo en una sola llamada: estado, economía y, por
// participante, su depósito + los handles de pago (bolt11/lnurl/payUrl).
async function getBetDetail(config: LunaConfig, betId: string): Promise<LunaBetDetail | null> {
  return lunaFetch<LunaBetDetail>(
    config,
    `/api/v2/bets/${encodeURIComponent(betId)}`,
  ).catch(() => null);
}

/**
 * Cancela/anula una apuesta según el modo: por EVENTOS (publica un 1341 `status=void`
 * firmado por el retador → Luna reembolsa) o por REST (`POST /cancel`). `betId` en modo
 * eventos == id del 1339. Devuelve una promesa para conservar el `.catch` de los callers.
 */
async function cancelBetRemote(config: LunaConfig, betId: string): Promise<unknown> {
  if (ngpEventsEnabled()) {
    return publishSignedEventToRelays(signNgpVoidEvent(betId));
  }
  return lunaFetch(config, `/api/v2/bets/${encodeURIComponent(betId)}/cancel`, { method: 'POST' });
}

/**
 * Trae el detalle de la apuesta según el modo: por EVENTOS (sintetizado desde el 31340
 * de relays, con handles de depósito armados localmente) o por REST (GET del detalle).
 * `npubs`/`stakeSats` solo se usan en modo eventos (el REST los trae en la respuesta).
 */
async function fetchDetail(
  config: LunaConfig,
  betId: string,
  npubs: string[],
  stakeSats: number,
  previous?: RoomBet | null,
): Promise<LunaBetDetail | null> {
  if (ngpEventsEnabled()) {
    const terms = await fetchNgpTerms();
    if (!terms) return null;
    if (hasPendingNgpInvoice(previous)) {
      await pokeNgpBetDepositSync(config.baseUrl, betId);
    }
    return synthesizeEventsBetDetail(betId, npubs, stakeSats, terms, config.baseUrl, previous);
  }
  return getBetDetail(config, betId);
}

/**
 * Radiografía temporal del pago de una apuesta (GET /api/v2/bets/{id}/timeline):
 * timestamps crudos (creación, fondeo, liquidación; depósito y payout por
 * participante; asientos del ledger) + duraciones por fase ya calculadas por Luna.
 * La usa el reporte del botón "Reportar problema" para adjuntar el desglose y poder
 * ver EN QUÉ FASE se fue el tiempo. Best-effort: devuelve null ante cualquier fallo
 * (Luna no configurada, red, apuesta no encontrada) — el reporte se manda igual.
 */
export async function fetchBetPaymentTimeline(betId: string): Promise<unknown | null> {
  // Modo eventos: el timeline es un diagnóstico REST; no está disponible sin API key.
  if (ngpEventsEnabled()) return null;
  if (!betId || !isLunaNegraApiConfigured()) return null;
  try {
    const config = readApiConfig();
    return await lunaFetch<unknown>(
      config,
      `/api/v2/bets/${encodeURIComponent(betId)}/timeline`,
    );
  } catch {
    return null;
  }
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
  const stakeSats = Math.floor(Number(input.stakeSats));
  if (!Number.isFinite(stakeSats) || stakeSats < LUNA_NEGRA_MIN_STAKE_SATS || stakeSats > LUNA_NEGRA_MAX_STAKE_SATS) {
    throw new OnlineRoomError('Monto de apuesta inválido.', 400);
  }

  const players = room.players;

  // NGP (escrow transparente): cuando está habilitado Y todos los jugadores tienen
  // npub, el contrato se publica como evento Nostr kind:1339 firmado por Tetris y
  // Luna lo materializa (POST /from-contract), en vez de crearlo por API. El pozo
  // con invitados (sin npub) NO puede ir por acá —NGP puro no tiene asientos
  // custodiados— así que cae al camino legacy. Ver docs/nostr-games-protocol-apuestas.md.
  if (ngpBetsEnabled() && players.every((player) => !!player.npub)) {
    const created = await createBetViaNgpContract(config, room, gameId, stakeSats, input.victoryCondition);
    return finalizeCreatedBet(store, room, config, created, gameId, input.playerId, nowMs);
  }

  // Legacy (custodial / API key). Pozo MIXTO: por cada jugador, su npub real si
  // entró con cuenta Luna; si es invitado (sin npub), un placeholder `{ guest: true }`
  // que Luna convierte en una identidad efímera. Así el de cuenta cobra a su billetera
  // y el invitado cobra por LNURL-withdraw. El orden se conserva para mapear asiento→jugador.
  const spec: Array<string | { guest: true }> = players.map(
    (player) => (player.npub ? player.npub : { guest: true }),
  );

  const create = await lunaFetch<LunaBetCreateWithSeats>(config, '/api/v2/bets', {
    method: 'POST',
    body: {
      gameId,
      participants: spec,
      stakeSats,
      victoryCondition: input.victoryCondition?.slice(0, 280) || 'Último jugador en pie gana el pozo.',
      roomId: room.id,
      metadata: { roomId: room.id },
      // Resiliencia del pozo: si algún jugador arrastra un npub de una sesión vieja que
      // Luna ya no reconoce (cuenta borrada / DB reseteada), que ese asiento se degrade a
      // invitado (cobra por LNURL-withdraw) en vez de tirar abajo TODA la apuesta. Sin
      // esto, en una sala grande basta un npub fantasma para bloquear el pozo entero.
      unknownNpubsAsGuests: true,
    },
  });

  return finalizeCreatedBet(store, room, config, create, gameId, input.playerId, nowMs);
}

/**
 * Publica el contrato NGP kind:1339 (clave de servicio de Tetris) y pide a Luna
 * materializar la apuesta desde él. Devuelve la misma forma que `POST /api/v2/bets`.
 * Solo se llama cuando todos los jugadores tienen npub (validado por el caller).
 */
async function createBetViaNgpContract(
  config: LunaConfig,
  room: OnlineRoom,
  gameId: string,
  stakeSats: number,
  victoryCondition: string | undefined,
): Promise<LunaBetCreateWithSeats> {
  // MODO EVENTOS: config por `terms`, publicar SOLO el 1339 (sin from-contract, sin
  // declarar oráculo — TOFU). El betId de tracking = id del 1339. Luna materializa
  // lazy al primer depósito. Ver createBetViaEvents.
  if (ngpEventsEnabled()) {
    return createBetViaEvents(room, stakeSats, victoryCondition);
  }

  const ngp = await fetchNgpConfig(config.baseUrl, config.apiKey, gameId);
  if (stakeSats < ngp.minStakeSats || stakeSats > ngp.maxStakeSats) {
    throw new OnlineRoomError(
      `El monto debe estar entre ${ngp.minStakeSats} y ${ngp.maxStakeSats} sats.`,
      400,
    );
  }
  const participantPubkeys = room.players.map((player) => pubkeyFromNpub(player.npub as string));

  // Keyless (BYO): declaramos NUESTRA clave de oráculo ante Luna ANTES de publicar el
  // contrato y la usamos como `oracle` del 1339. Así el resultado lo firmamos nosotros
  // (sin API key) y la ingesta valida oracle==provider.oraclePubkey. Si no es keyless,
  // el oráculo es el gestionado por Luna (de la config) y el resultado va por API key.
  let oraclePubkey = ngp.oraclePubkey;
  if (ngpKeylessEnabled()) {
    const own = ngpOraclePubkey();
    if (own) {
      await ensureOracleDeclared(config.baseUrl, config.apiKey);
      oraclePubkey = own;
    }
  }

  const contractEventId = await publishNgpContract({
    gameCoord: ngp.gameCoord,
    storePubkey: ngp.storePubkey,
    oraclePubkey,
    participantPubkeys,
    stakeSats,
    victoryCondition: victoryCondition?.slice(0, 280) || 'Último jugador en pie gana el pozo.',
    roomId: room.id,
    // El contrato pide una ventana holgada; Luna la acota a su propia ventana de depósito.
    deadlineSec: Math.floor(Date.now() / 1000) + 3600,
  });
  return lunaFetch<LunaBetCreateWithSeats>(config, '/api/v2/bets/from-contract', {
    method: 'POST',
    body: { contractEventId },
  });
}

/**
 * MODO EVENTOS: crea la apuesta publicando SOLO el contrato 1339 (sin post raíz), sin
 * llamar a la REST. Config desde `terms` (relays); oráculo = clave BYO de Tetris
 * (declarada EN el contrato, TOFU). El `betId` de tracking = id del 1339 (Luna lo
 * materializa lazy al primer depósito). La coordenada del juego viene de env
 * (`LUNA_NEGRA_GAME_COORD`, valor público de setup) porque no consultamos ngp-config.
 */
async function createBetViaEvents(
  room: OnlineRoom,
  stakeSats: number,
  victoryCondition: string | undefined,
): Promise<LunaBetCreateWithSeats> {
  const terms = await fetchNgpTerms();
  if (!terms) throw new OnlineRoomError('No se pudieron leer las condiciones del escrow de los relays.', 502);
  if (stakeSats < terms.minStakeSats || stakeSats > terms.maxStakeSats) {
    throw new OnlineRoomError(`El monto debe estar entre ${terms.minStakeSats} y ${terms.maxStakeSats} sats.`, 400);
  }
  const oraclePubkey = ngpOraclePubkey();
  if (!oraclePubkey) throw new OnlineRoomError('NGP eventos sin clave de oráculo.', 500);
  const gameCoord = (process.env.LUNA_NEGRA_GAME_COORD ?? '').trim();
  if (!gameCoord) throw new OnlineRoomError('Falta LUNA_NEGRA_GAME_COORD (coordenada 30023 del juego).', 500);

  const participantPubkeys = room.players.map((player) => pubkeyFromNpub(player.npub as string));
  const contractId = await publishBareNgpContract({
    gameCoord,
    storePubkey: terms.storePubkey,
    oraclePubkey,
    participantPubkeys,
    stakeSats,
    victoryCondition: victoryCondition?.slice(0, 280) || 'Último jugador en pie gana el pozo.',
    roomId: room.id,
    deadlineSec: Math.floor(Date.now() / 1000) + 3600,
  });
  // El betId de tracking es el id del contrato: en modo eventos no hay betId interno
  // de Luna hasta que materializa (y ahí lo trae el 31340). Todo el flujo local usa
  // el contractId como clave y el estado sale de los eventos.
  return { betId: contractId, stakeSats };
}

/**
 * MODO EVENTOS: sintetiza un `LunaBetDetail` (la forma que consume buildRoomBet) a
 * partir del estado en relays (31340) + contexto local, en vez del GET REST. Los
 * handles de depósito se arman localmente (9734 + LNURL de la tienda). Si Luna aún no
 * publicó estado (pre-materialización), devuelve un detalle en `pending_deposits` con
 * todos los asientos sin pagar pero con handles válidos para depositar.
 */
async function synthesizeEventsBetDetail(
  contractId: string,
  npubs: string[],
  stakeSats: number,
  terms: NgpTerms,
  baseUrl: string,
  previous?: RoomBet | null,
): Promise<LunaBetDetail> {
  // El 31340 es opcional antes del primer depósito y, además, los relays pueden
  // tardar/timeout. Los handles de depósito se pueden construir localmente con el
  // contrato + terms, así que no dejamos que una lectura lenta de estado bloquee el QR.
  const state = await fetchNgpBetState(contractId).catch(() => null);
  const lnurl = encodeLnurl(storeLnurlUrl(baseUrl));
  const freshTemplate = buildDepositZapRequestTemplate({
    contractId,
    storePubkey: terms.storePubkey,
    stakeSats,
    storeLnurlBech32: lnurl,
  });
  const storeCallback = storeLnurlUrl(baseUrl);
  const depositedByPubkey = new Set(state?.depositedPubkeys ?? []);
  const prevByNpub = new Map((previous?.participants ?? []).map((p) => [p.npub, p]));
  const potTargetSats = stakeSats * npubs.length;
  const potSats = stakeSats * depositedByPubkey.size;
  const feeSats = Math.floor(potTargetSats * (terms.feePct / 100));
  const netPayoutSats = Math.max(0, potTargetSats - feeSats);

  const participants = npubs.map((npub) => {
    const pubkey = pubkeyFromNpub(npub);
    const paid = depositedByPubkey.has(pubkey);
    const payout = state?.payouts[pubkey];
    const prev = prevByNpub.get(npub);
    return {
      npub,
      depositStatus: paid ? 'paid' : 'pending',
      // Handles ESTABLES entre polls: reusamos el invoice ya emitido (`bolt11`) y el
      // template YA armado del estado previo. Sin esto, cada refresh reconstruía el
      // template (con `created_at` nuevo) y perdía el bolt11 → el QR parpadeaba y se
      // re-pedía la firma a cada rato. Solo armamos uno nuevo si no había previo.
      bolt11: paid ? null : (prev?.bolt11 ?? null),
      depositZapRequest: paid ? null : (prev?.depositZapRequest ?? freshTemplate),
      depositCallback: paid ? null : (prev?.depositCallback ?? storeCallback),
      payoutStatus: payout?.status ?? 'none',
      payoutSats: payout ? payout.sats : null,
      payoutKind: payout?.kind ?? null,
    };
  });

  return {
    betId: contractId,
    status: state ? mapNgpStatusToRoomStatus(state.status) : 'pending_deposits',
    stakeSats,
    potSats,
    potTargetSats,
    feeSats,
    feePct: terms.feePct,
    netPayoutSats,
    depositsReceived: depositedByPubkey.size,
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
  config: LunaConfig,
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

  const detail = await fetchDetail(config, create.betId, npubs, create.stakeSats ?? 0);
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
      const config = readApiConfig();
      await cancelBetRemote(config, bet.betId);
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
    const config = readApiConfig();
    await cancelBetRemote(config, bet.betId).catch(() => undefined);
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
  const npubs = room.bet.participants.map((p) => p.npub);
  const detail = await fetchDetail(config, room.bet.betId, npubs, room.bet.stakeSats, room.bet);
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

/**
 * Emite el invoice de depósito v2 a partir del zap request 9734 ya firmado por el
 * jugador. Reenvía el 9734 al callback LNURL-pay del participante (`?amount&nostr=`)
 * y devuelve el bolt11. Ese invoice compromete el zap vía description hash, así que
 * pagarlo con extensión o escaneando el QR queda como un zap NIP-57 real: Luna Negra
 * publica el recibo 9735 al detectar el pago. Idempotente: si ya hay invoice emitido
 * lo devuelve sin re-firmar.
 */
export async function generateBetDepositInvoice(
  store: RoomStore,
  roomId: string,
  playerId: string,
  signedZapRequest: unknown,
  signedComment: unknown = null,
  nowMs = Date.now(),
): Promise<{ room: OnlineRoom; invoice: string }> {
  let room = await loadRoom(store, roomId);
  let bet = room.bet;
  if (!bet) throw new OnlineRoomError('No hay apuesta activa para depositar.', 404);
  let participant = bet.participants.find((p) => p.playerId === playerId);
  if (!participant) throw new OnlineRoomError('No sos participante de esta apuesta.', 403);
  if (participant.depositStatus === 'paid') {
    throw new OnlineRoomError('Ya depositaste.', 409);
  }

  // Auto-sanado contra un RoomStore desactualizado: si el snapshot local no tiene ni
  // invoice ni callback (p.ej. la firma anterior YA emitió el invoice en Luna pero la
  // respuesta no alcanzó a persistirse acá, o un poll viejo dejó al asiento sin
  // handles), refetcheamos el detalle desde Luna —la fuente de verdad— antes de tirar
  // "no disponible". Luna suele devolver ya el `bolt11` del depósito y el flujo sigue
  // sin re-firmar. Si Luna está caída, `refreshRoomBet` devuelve la sala sin tocar.
  if (!participant.bolt11 && !participant.depositCallback) {
    room = await refreshRoomBet(store, roomId, nowMs, { reportResult: false });
    participant = room.bet?.participants.find((p) => p.playerId === playerId) ?? participant;
    bet = room.bet ?? bet;
  }

  // Idempotencia: si ya se emitió el invoice (este intento u otro previo), reusamos
  // el mismo en vez de pedir otro. El QR y "pagar con extensión" pagan ese bolt11.
  if (participant.bolt11) return { room, invoice: participant.bolt11 };

  const callback = participant.depositCallback;
  if (!callback) {
    throw new OnlineRoomError(
      'El depósito por zap no está disponible ahora; usá «Pagar en Luna Negra».',
      409,
    );
  }
  if (!signedZapRequest || typeof signedZapRequest !== 'object') {
    throw new OnlineRoomError('Falta el zap request firmado.', 400);
  }

  const amountMsat = bet.stakeSats * 1000;
  const invoice = await fetchDepositInvoiceFromCallback(callback, amountMsat, signedZapRequest);

  // Comentario de participación (best-effort): si el jugador lo firmó, lo mandamos al
  // callback de Luna. Si gana, el premio se ancla a él. NUNCA rompe el depósito: un
  // fallo acá solo hace que el premio caiga al post del contrato (comportamiento previo).
  // `await` a propósito (serverless: sin esperar, el fetch se corta al terminar la función).
  if (signedComment && typeof signedComment === 'object' && participant.commentCallback) {
    await postParticipationComment(participant.commentCallback, signedComment).catch(() => undefined);
  }

  // Persistimos el invoice en la apuesta local para que el QR sobreviva a los polls
  // (el próximo GET a Luna ya lo devuelve en `bolt11` y reconcilia). Sin esto, el
  // panel volvería a pedir la firma en el siguiente refresh.
  const participants = bet.participants.map((p) =>
    p.playerId === playerId ? { ...p, bolt11: invoice } : p,
  );
  const updated: RoomBet = { ...bet, participants, updatedAtServerMs: nowMs };
  const updatedRoom = await setRoomBet(store, room.id, updated, nowMs);
  return { room: updatedRoom, invoice };
}

// GET al callback LNURL-pay del participante con el 9734 firmado. Devuelve el bolt11
// (`pr`) o lanza con el motivo del proveedor. El callback responde 200 incluso en
// error (formato LNURL `{ status:"ERROR", reason }`), así que el éxito lo determina
// la presencia de `pr`, no el status HTTP.
async function fetchDepositInvoiceFromCallback(
  callback: string,
  amountMsat: number,
  signedZapRequest: unknown,
): Promise<string> {
  if (isLunaMockEnabled()) {
    // El mock auto-fondea los depósitos, así que este camino no debería ejecutarse.
    throw new OnlineRoomError('Depósito por zap no soportado en modo mock.', 409);
  }
  let url: URL;
  try {
    url = new URL(callback);
  } catch {
    throw new OnlineRoomError('El callback de depósito de Luna Negra es inválido.', 502);
  }
  url.searchParams.set('amount', String(amountMsat));
  url.searchParams.set('nostr', JSON.stringify(signedZapRequest));

  let response: Response;
  try {
    response = await fetch(url.toString());
  } catch {
    throw new OnlineRoomError('No se pudo contactar a Luna Negra para emitir el invoice.', 502);
  }
  const payload = (await response.json().catch(() => null)) as
    | { pr?: string; reason?: string }
    | null;
  if (!payload || typeof payload.pr !== 'string' || !payload.pr) {
    const reason = payload?.reason ?? `Luna Negra respondió ${response.status}.`;
    throw new OnlineRoomError(reason, 502);
  }
  return payload.pr;
}

// POST del comentario de participación firmado al endpoint de Luna Negra
// (`/api/v2/bets/{id}/comment`). La FIRMA del evento es la autenticación (no hay API
// key). Best-effort: cualquier fallo se ignora arriba — el depósito ya salió y sin
// comentario el premio simplemente cae al post del contrato (fallback previo).
async function postParticipationComment(callback: string, signedComment: unknown): Promise<void> {
  if (isLunaMockEnabled()) return;
  let url: URL;
  try {
    url = new URL(callback);
  } catch {
    return;
  }
  await fetch(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signedComment }),
  });
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
  const cancelResult = await lunaFetch<{ ok?: boolean; status?: string }>(
    config,
    `/api/v2/bets/${encodeURIComponent(room.bet.betId)}/cancel`,
    { method: 'POST' },
  );
  // El POST ya canceló la apuesta en Luna. refreshRoomBet es best-effort: si el GET de
  // detalle falla (red, 404 transitorio) devuelve la sala sin tocar el bet → la apuesta
  // quedaría "pendiente" pese a estar cancelada, sin error visible. Forzamos el estado
  // terminal que devolvió el propio cancel para que el host vea la cancelación igual.
  const refreshed = await refreshRoomBet(store, roomId, nowMs);
  if (!refreshed.bet || isTerminalRoomBetStatus(refreshed.bet.status)) return refreshed;
  const reported = asBetStatus(cancelResult?.status, 'cancelled');
  const terminalStatus = isTerminalRoomBetStatus(reported) ? reported : 'cancelled';
  const bet: RoomBet = { ...refreshed.bet, status: terminalStatus, updatedAtServerMs: nowMs };
  return setRoomBet(store, roomId, bet, nowMs);
}

export async function retryRoomBetInvoiceGeneration(
  store: RoomStore,
  roomId: string,
  playerId: string,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const config = readApiConfig();
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

  await cancelBetRemote(config, bet.betId).catch(() => undefined);
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
    // Mapeamos el ganador por playerId al npub de SU participante en la apuesta
    // (real o efímero de invitado); winnerNpubsFromRoom no sirve porque el
    // invitado no tiene npub en la sala. Vacío = empate/anulación → reembolso.
    winners = winnerBetNpubsFromRoom(room);
    const reportedBet: RoomBet = { ...bet, winnerNpubs: winners, updatedAtServerMs: nowMs };
    updatedRoom = await setRoomBet(store, room.id, reportedBet, nowMs);
  }

  // Tres caminos de reporte (winners vacío = empate/anulación → reembolso en todos):
  //  - EVENTOS: firmamos el 1341 y lo PUBLICAMOS a relays (sin la REST). En modo eventos
  //    `bet.betId` == id del 1339, que va como `e` para que ngp-bet-result-sync lo ubique.
  //  - KEYLESS (BYO): firmamos el 1341 y lo mandamos como { event } al endpoint (sin API key).
  //  - Gestionado: mandamos { winners } y Luna firma con el oráculo que custodia.
  try {
    if (ngpEventsEnabled()) {
      const ev = signNgpResultEvent({
        betId: bet.betId,
        winnerNpubs: winners,
        anchorEventId: bet.betId,
      });
      await publishSignedEventToRelays(ev);
    } else {
      let body: { event: unknown } | { winners: string[] };
      if (ngpKeylessEnabled()) {
        // Aseguramos que NUESTRA clave esté declarada como oráculo (idempotente): si no,
        // Luna rechazaría el { event } con WRONG_SIGNER. Cubre el caso de reportar sin
        // haber creado una apuesta NGP en esta instancia (cold start).
        await ensureOracleDeclared(config.baseUrl, config.apiKey);
        body = { event: signNgpResultEvent({ betId: bet.betId, winnerNpubs: winners }) };
      } else {
        body = { winners };
      }
      await lunaFetch(config, `/api/v2/bets/${encodeURIComponent(bet.betId)}/result`, {
        method: 'POST',
        body,
      });
    }
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
  const detail = await fetchDetail(config, bet.betId, bet.participants.map((p) => p.npub), bet.stakeSats, updated.bet ?? bet);
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
  // Modo eventos: no hay webhooks (el estado se sigue por relays / 31340), y el
  // registro requiere API key que no usamos. No-op.
  if (ngpEventsEnabled()) return;
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
