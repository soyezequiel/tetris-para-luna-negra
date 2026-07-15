import type { ActivePiece, AttackTableId, Cell, GameEngineSnapshot, GameRules } from '../game/types';

export type RoomVisibility = 'public' | 'private';
export type OnlineRoomMode = 'custom';
export type OnlineMatchType = 'custom' | 'battle';
export type OnlineRoomStatus = 'lobby' | 'countdown' | 'playing' | 'finished';
export type OnlinePlayerStatus = 'joined' | 'ready' | 'playing' | 'eliminated' | 'winner' | 'won' | 'lost' | 'disconnected';
export type OnlineAttackTable = AttackTableId;
export type TargetingMode = 'random' | 'even' | 'ko' | 'attackers' | 'leader' | 'manual';

export type OnlineObjective =
  | { type: 'lastStanding' }
  | { type: 'sprint'; targetLines: number }
  | { type: 'survivalScore'; durationSeconds: number | null };

export interface OnlineRuleset {
  rulesetId: string;
  rulesetVersion: number;
  objective: OnlineObjective;
  attackTable: OnlineAttackTable;
  targeting: TargetingMode;
  /**
   * Preferencia de música del HOST para la sala: si es true, todos los clientes
   * reproducen sólo temas libres de derechos (prefijo 'ncc') durante la partida.
   * Así suena la misma música en todos los clientes y la elige el host, no cada
   * cliente con su ajuste local. Ver musicTracksFor() y maybeStartOnlineRun().
   */
  royaltyFreeOnly: boolean;
}

export interface OnlineGameSnapshot {
  seed?: number;
  board: Cell[][];
  active: ActivePiece | null;
  visibleRows: number;
  boardWidth: number;
  elapsedFrames: number;
  status?: 'ready' | 'playing' | 'finished' | 'gameover';
  lines?: number;
  pieces?: number;
  sentGarbage?: number;
  receivedGarbage?: number;
  pendingGarbage?: number;
  engine?: GameEngineSnapshot;
  lastProcessedInputSequence?: number;
}

export type OnlinePeerSignalType = 'offer' | 'answer' | 'ice';

export interface OnlinePeerSignal {
  id: string;
  roomId: string;
  fromPlayerId: string;
  toPlayerId: string;
  type: OnlinePeerSignalType;
  data: unknown;
  createdAtServerMs: number;
}

export interface OnlineAttack {
  id: string;
  roomId: string;
  authorityPlayerId: string;
  fromPlayerId: string;
  toPlayerId: string;
  seed?: number;
  lines: number;
  holeSeed: number;
  frame: number;
  createdAtServerMs: number;
}

export interface OnlinePlayer {
  id: string;
  npub: string | null;
  name: string;
  avatarUrl: string | null;
  ready: boolean;
  status: OnlinePlayerStatus;
  lines: number;
  pieces: number;
  elapsedFrames: number;
  sentGarbage: number;
  receivedGarbage: number;
  pendingGarbage: number;
  alive: boolean;
  updatedAtServerMs: number;
  finishedAtServerMs: number | null;
  eliminatedAtFrame: number | null;
  eliminatedAtServerMs: number | null;
  game: OnlineGameSnapshot | null;
  targetingMode: TargetingMode;
  manualTargetPlayerId: string | null;
  currentTargetPlayerId: string | null;
  recentAttackers: string[];
  koCount: number;
  receivedGarbageThisRound: number;
  dangerLevel: number;
}

export type RoomBetStatus =
  | 'pending_deposits'
  | 'funded'
  | 'settled'
  | 'cancelled'
  | 'expired'
  | 'refunded';

export type RoomBetDepositStatus = 'pending' | 'paid' | 'refunded' | 'failed';

export type RoomBetPayoutStatus =
  | 'none'
  | 'pending'
  | 'paid'
  | 'failed'
  | 'withdraw_pending'
  | 'claimed'
  | 'forfeited';

/**
 * Zap request NIP-57 (kind 9734) SIN firmar, tal como lo arma Luna Negra para el
 * depósito v2. El cliente lo firma con la identidad Nostr del jugador y lo manda al
 * callback LNURL-pay para obtener el invoice (así el depósito es un zap real).
 */
export interface UnsignedZapRequestTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface RoomBetParticipant {
  npub: string;
  /** pubkey del jugador en la sala, si pudo mapearse. */
  playerId: string | null;
  depositStatus: RoomBetDepositStatus;
  /** Handles de pago (cómo deposita su stake). `null` cuando el depósito cerró. */
  bolt11: string | null;
  lnurl: string | null;
  payUrl: string | null;
  /**
   * v2 (zaps): zap request 9734 SIN firmar del depósito, anclado al contrato. El
   * cliente lo firma con la identidad del jugador y lo manda a `depositCallback`
   * (`?amount&nostr=`) para emitir el invoice, de modo que "pagar con extensión" y
   * el QR sean zaps reales. Ausente/`null` cuando ya hay `bolt11` o el depósito cerró.
   */
  depositZapRequest?: UnsignedZapRequestTemplate | null;
  /** v2: URL LNURL-pay a donde mandar el 9734 firmado (`?amount&nostr`) → `{ pr }`. */
  depositCallback?: string | null;
  /**
   * v2 (zaps): comentario de participación (kind:1 reply al contrato) SIN firmar. El
   * cliente lo firma con la MISMA identidad del jugador y lo manda a `commentCallback`.
   * Si el jugador gana, el premio se zapea a ESTE comentario en vez del post del
   * contrato (queda como zap recibido en su perfil). Opcional: el depósito funciona
   * igual sin él. Comparte forma con el 9734 (kind/created_at/tags/content).
   */
  participationComment?: UnsignedZapRequestTemplate | null;
  /** v2: URL a donde mandar el comentario firmado (`POST { signedComment }`). */
  commentCallback?: string | null;
  /**
   * Motivo por el que Luna Negra no pudo generar el invoice de depósito (p. ej.
   * NWC sin permiso make-invoice, budget agotado o relay caído). `null` cuando no
   * hubo error (handles presentes o depósito cerrado). Sirve para mostrar la causa
   * real en vez de un panel mudo sin métodos de pago.
   */
  depositError: string | null;
  /** Pago recibido por este participante (si ganó), en sats. */
  payoutSats: number | null;
  /**
   * Estado del cobro del ganador. Un ganador con cuenta/billetera cobra automático
   * (`paid`); un ganador invitado (sin billetera) cae en `withdraw_pending` y cobra
   * escaneando `withdrawLnurl` (LNURL-withdraw) o con la extensión.
   */
  payoutStatus: RoomBetPayoutStatus;
  /** LNURL de retiro del ganador invitado (solo en `withdraw_pending`). */
  withdrawLnurl: string | null;
  /** URL web del retiro (alternativa al LNURL). */
  withdrawUrl: string | null;
}

/** Estado de la apuesta de la sala, sincronizado desde Luna Negra. */
export interface RoomBet {
  betId: string;
  status: RoomBetStatus;
  stakeSats: number;
  potSats: number;
  potTargetSats: number;
  feeSats: number;
  feePct: number;
  netPayoutSats: number;
  depositDeadline: string | null;
  depositsReceived: number;
  depositsTotal: number;
  participants: RoomBetParticipant[];
  winnerNpubs: string[] | null;
  resultReported: boolean;
  settlementError: string | null;
  createdByPlayerId: string;
  createdAtServerMs: number;
  updatedAtServerMs: number;
}

export interface OnlineRoom {
  id: string;
  visibility: RoomVisibility;
  mode: OnlineRoomMode;
  matchType: OnlineMatchType;
  region: string;
  ruleset: OnlineRuleset;
  rules: GameRules;
  status: OnlineRoomStatus;
  hostPlayerId: string;
  createdAtServerMs: number;
  updatedAtServerMs: number;
  startsAtServerMs: number | null;
  seed: number;
  winnerPlayerId: string | null;
  matchResultId: string | null;
  players: OnlinePlayer[];
  peerSignals: OnlinePeerSignal[];
  attacks: OnlineAttack[];
  bet: RoomBet | null;
  /** gameId de Luna Negra capturado del invite (para crear apuestas). */
  lunaGameId: string | null;
  /**
   * Versión del registro para escritura optimista (compare-and-set). La maneja
   * el RoomStore: cada save exitoso la incrementa y un save con versión vieja
   * falla, así dos requests concurrentes no se pisan el estado de la sala.
   */
  version?: number;
}

export interface OnlineRoomSummary {
  id: string;
  hostName: string;
  hostAvatarUrl: string | null;
  playerCount: number;
  mode: OnlineRoomMode;
  matchType: OnlineMatchType;
  region: string;
  customPreset: string | null;
  ruleset: OnlineRuleset;
  status: OnlineRoomStatus;
  createdAtServerMs: number;
}

export interface PublicRoomsFilters {
  matchType?: OnlineMatchType;
  status?: OnlineRoomStatus;
  region?: string;
  customPreset?: string;
  minPlayers?: number;
  maxPlayers?: number;
}

export interface CreateRoomRequest {
  roomId?: string;
  playerId: string;
  npub?: string | null;
  lunaGameId?: string | null;
  name: string;
  avatarUrl?: string | null;
  visibility: RoomVisibility;
  mode?: OnlineRoomMode;
  matchType?: OnlineMatchType;
  region?: string;
  ruleset?: Partial<OnlineRuleset>;
  rules?: GameRules;
}

/** Entrada idempotente para enlaces: une si existe o crea si falta. */
export interface JoinOrCreateRoomRequest extends CreateRoomRequest {
  roomId: string;
}

export interface JoinRoomRequest {
  roomId: string;
  playerId: string;
  npub?: string | null;
  name: string;
  avatarUrl?: string | null;
}

export interface ReadyRequest {
  roomId: string;
  playerId: string;
  ready: boolean;
}

export interface StartRoomRequest {
  roomId: string;
  playerId: string;
}

export interface RestartRoomRequest {
  roomId: string;
  playerId: string;
}

/**
 * Un jugador vivo pide que el servidor migre la autoridad porque detectó al host
 * inalcanzable (su canal WebRTC al host lleva caído un rato). El servidor solo lo
 * honra si el host realmente dejó de escribir hace HOST_UNREACHABLE_MS, así un
 * cliente no puede dar de baja a un host presente. Acorta la recuperación 1v1
 * (no hace falta esperar HOST_STALE_MS).
 */
export interface RequestHostFailoverRequest {
  roomId: string;
  playerId: string;
}

export interface UpdateRoomSettingsRequest {
  roomId: string;
  playerId: string;
  visibility?: RoomVisibility;
  /** true = solo cambia la visibilidad (no toca reglas, jugadores ni apuesta). */
  visibilityOnly?: boolean;
  mode?: OnlineRoomMode;
  matchType: OnlineMatchType;
  ruleset?: Partial<OnlineRuleset>;
  rules?: GameRules;
}

export interface SetTargetingRequest {
  roomId: string;
  playerId: string;
  targetingMode: TargetingMode;
  manualTargetPlayerId?: string | null;
}

export interface ProgressRequest {
  roomId: string;
  authorityPlayerId: string;
  playerId: string;
  seed?: number;
  lines: number;
  pieces: number;
  elapsedFrames: number;
  sentGarbage?: number;
  receivedGarbage?: number;
  pendingGarbage?: number;
  game?: OnlineGameSnapshot | null;
}

export interface ResultRequest extends ProgressRequest {
  result: 'won' | 'lost';
}

export interface PeerSignalRequest {
  roomId: string;
  fromPlayerId: string;
  toPlayerId: string;
  type: OnlinePeerSignalType;
  data: unknown;
}

export interface AttackRequest {
  roomId: string;
  attackId: string;
  authorityPlayerId: string;
  fromPlayerId: string;
  toPlayerId: string;
  seed?: number;
  lines: number;
  holeSeed: number;
  frame: number;
}

export interface EliminateRequest extends ProgressRequest {
  frame: number;
}

export interface OnlineErrorResponse {
  error: string;
}

export interface OnlineRoomResponse {
  room: OnlineRoom;
  serverNowMs: number;
}


export interface LunaNegraEnterRequest {
  inviteToken: string;
  roomId: string;
}

export interface LunaNegraPlayer {
  id: string;
  npub: string;
  pubkey: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  host: boolean;
  hostPubkey: string | null;
  expiresAt: string | null;
}

export interface LunaNegraEnterResponse extends OnlineRoomResponse {
  player: LunaNegraPlayer;
}

// ───────────────────────── Salir / echar de la sala ─────────────────────────

export interface LeaveRoomRequest {
  roomId: string;
  playerId: string;
}

export interface KickPlayerRequest {
  roomId: string;
  /** Host que ejecuta el kick. */
  playerId: string;
  /** Jugador a expulsar. */
  targetPlayerId: string;
}

/**
 * Respuesta de salir de una sala. `room` es null cuando la sala quedó vacía y se
 * eliminó. `hostMigratedTo` indica el nuevo host cuando se migró la autoridad.
 */
export interface LeaveRoomResponse {
  room: OnlineRoom | null;
  hostMigratedTo: string | null;
  serverNowMs: number;
}

// ─────────────────────────── Identidad de Luna Negra ────────────────────────

/** Identidad resuelta de Luna Negra (la produce el login Nostr; ver nostrLogin.ts). */
export interface LunaIdentity {
  npub: string;
  pubkey: string | null;
  name: string;
  avatarUrl: string | null;
  /** gameId de Luna Negra asociado a la sesión (para apuestas / invites). */
  gameId: string | null;
}


export interface LunaInviteWindowResponse {
  /** URL first-party de Luna Negra que renderiza el selector de amigos. */
  url: string;
  serverNowMs: number;
}

/** Identidad del juego en Luna Negra (config server-side), para poblar el gameId
 * de una sesión Nostr 2.0 (que no lo trae del token). `null` si no está configurado. */
export interface LunaGameInfoResponse {
  gameId: string | null;
  slug: string | null;
  serverNowMs: number;
}

export interface LunaLaunchRequest {
  id: string;
  roomId: string;
  inviteToken: string;
  /** `room-link` usa `inviteToken` como `lnInvite` y la sala vive en TETRA. */
  kind: 'luna-room' | 'room-link';
  slug: string;
  title: string;
  gameUrl: string;
}

/** Resultado de verificar un `lnInvite` de "Luna Room Link" (invitación dirigida a
 * una sala hosteada por este juego). `invite` es `null` si el token es inválido. */
export interface LunaRoomInviteResponse {
  invite: {
    gameId: string;
    slug: string;
    roomId: string;
    toNpub: string;
    expiresAt: string | null;
  } | null;
  serverNowMs: number;
}

export interface LunaLaunchRequestResponse {
  request: LunaLaunchRequest | null;
  serverNowMs: number;
  source: 'luna-negra';
}

export interface CreateBetRequest {
  roomId: string;
  playerId: string;
  stakeSats: number;
  victoryCondition?: string;
}

export interface RoomBetActionRequest {
  roomId: string;
  playerId: string;
}

export interface PublicRoomsResponse {
  rooms: OnlineRoomSummary[];
  serverNowMs: number;
}

// ───────────────────────── Tabla global (leaderboard) ─────────────────────────
// Ranking mundial del sprint de 40 líneas: el mejor (menor) tiempo de cada
// jugador. El rank no se persiste; se deriva del orden de la lista.
export interface LeaderboardEntry {
  playerId: string;
  npub: string | null;
  name: string;
  avatarUrl: string | null;
  // Cantidad de partidas multijugador ganadas (mayor = mejor).
  wins: number;
  // Momento de la última victoria (desempata el ranking).
  createdAtServerMs: number;
}

export interface SubmitScoreRequest {
  playerId: string;
  name: string;
  avatarUrl?: string | null;
  npub?: string | null;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  serverNowMs: number;
}

// ───────────────────── Top de supervivencia (por tiempo) ─────────────────────
// Ranking mundial del modo Supervivencia (reglas iguales para todos): el mejor
// (mayor) tiempo que cada jugador logró sobrevivir antes de perder. El rank no se
// persiste; se deriva del orden de la lista (mayor tiempo primero).
export interface SurvivalEntry {
  playerId: string;
  npub: string | null;
  name: string;
  avatarUrl: string | null;
  // Mejor tiempo de supervivencia en milisegundos (mayor = mejor).
  bestMs: number;
  // Momento en que se logró el mejor tiempo (desempata el ranking).
  createdAtServerMs: number;
}

export interface SubmitSurvivalRequest {
  playerId: string;
  name: string;
  avatarUrl?: string | null;
  npub?: string | null;
  // Duración de la partida en milisegundos.
  durationMs: number;
}

export interface SurvivalLeaderboardResponse {
  entries: SurvivalEntry[];
  serverNowMs: number;
}
