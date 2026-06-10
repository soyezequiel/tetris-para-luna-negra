import type {
  AttackRequest,
  CreateRoomRequest,
  EliminateRequest,
  JoinRoomRequest,
  KickPlayerRequest,
  LeaveRoomRequest,
  LunaFriend,
  LunaNegraPlayer,
  LunaPresenceRequest,
  OnlineAttack,
  OnlineMatchType,
  OnlineGameSnapshot,
  OnlinePlayer,
  OnlinePeerSignal,
  OnlineRoom,
  OnlineRoomMode,
  OnlineRoomStatus,
  OnlineRuleset,
  OnlineRoomSummary,
  PeerSignalRequest,
  ProgressRequest,
  PublicRoomsFilters,
  ReadyRequest,
  RoomBet,
  RoomBetParticipant,
  RoomBetStatus,
  RestartRoomRequest,
  ResultRequest,
  RoomVisibility,
  SetTargetingRequest,
  StartRoomRequest,
  TargetingMode,
  UpdateRoomSettingsRequest,
} from './protocol';
import { BATTLE_RULES } from '../game/rules.js';
import type { GameRules } from '../game/types';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;
export const ROOM_ID_MIN_LENGTH = 4;
export const ROOM_ID_MAX_LENGTH = 64;
export const ROOM_START_DELAY_MS = 5_000;
export const PLAYER_STALE_MS = 10_000;
/**
 * Margen sin actividad del host autoritativo durante una ronda activa antes de
 * dar por perdida su conexión y migrar la autoridad. Mayor que PLAYER_STALE_MS
 * (que solo marca 'disconnected' visualmente) y holgado respecto al ritmo de
 * poll/progreso del host, así un host vivo nunca migra por una pausa pasajera.
 */
export const HOST_STALE_MS = 15_000;
export const ROOM_TTL_SECONDS = 2 * 60 * 60;
export const MAX_PEER_SIGNALS_PER_ROOM = 200;
export const MAX_ATTACKS_PER_ROOM = 300;
export const ONLINE_RULESET_VERSION = 1;
export const TARGETING_MODES: TargetingMode[] = ['random', 'even', 'ko', 'attackers', 'leader', 'manual'];
export const DEFAULT_ONLINE_REGION = 'gru1';

/** Registro de presencia de un npub respecto a este juego (para amigos Luna Negra). */
export interface LunaPresenceRecord {
  npub: string;
  name: string;
  avatarUrl: string | null;
  status: 'in-game' | 'online';
  roomId: string | null;
  updatedAtServerMs: number;
}

// Un jugador deja de figurar "jugando" si no emite heartbeat por más de 20s.
// El cliente late cada ~10s (la mitad del TTL) solo mientras tiene el juego en
// primer plano, así un jugador activo nunca expira pero quien se va cae solo.
export const LUNA_PRESENCE_TTL_MS = 20_000;
export const LUNA_PRESENCE_TTL_SECONDS = 20;

export interface RoomStore {
  getRoom(id: string): Promise<OnlineRoom | null>;
  saveRoom(room: OnlineRoom, ttlSeconds?: number): Promise<void>;
  deleteRoom(id: string): Promise<void>;
  listPublicRoomIds(): Promise<string[]>;
  savePublicRoomIds(ids: string[], ttlSeconds?: number): Promise<void>;
  getPresenceRecords(): Promise<LunaPresenceRecord[]>;
  savePresenceRecords(records: LunaPresenceRecord[], ttlSeconds?: number): Promise<void>;
}

export class OnlineRoomError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Falla de compare-and-set al guardar la sala: otro request la modificó entre
 * nuestra lectura y nuestra escritura. Las mutaciones se reintentan completas
 * (releen la sala) para no perder actualizaciones concurrentes — sin esto, un
 * `progress` en vuelo podía pisar una eliminación o el final de la partida.
 */
export class RoomVersionConflictError extends OnlineRoomError {
  constructor() {
    super('Room was modified concurrently.', 409);
  }
}

const ROOM_MUTATION_ATTEMPTS = 6;

/**
 * Reintenta una mutación de sala cuando el save falla por conflicto de versión.
 * Cada intento relee la sala desde el store, así la mutación se aplica sobre el
 * estado más reciente.
 */
async function withRoomConflictRetry<T>(mutation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await mutation();
    } catch (error) {
      if (!(error instanceof RoomVersionConflictError) || attempt >= ROOM_MUTATION_ATTEMPTS) throw error;
    }
  }
}

function retryRoomConflicts<A extends unknown[], R>(mutation: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args: A) => withRoomConflictRetry(() => mutation(...args));
}

// Toda mutación que persiste una sala pasa por el retry de conflictos de
// versión. Las funciones `*Once` releen la sala en cada intento.
export const createRoom = retryRoomConflicts(createRoomOnce);
export const enterLunaNegraRoom = retryRoomConflicts(enterLunaNegraRoomOnce);
export const joinRoom = retryRoomConflicts(joinRoomOnce);
export const setPlayerReady = retryRoomConflicts(setPlayerReadyOnce);
export const startRoom = retryRoomConflicts(startRoomOnce);
export const restartRoom = retryRoomConflicts(restartRoomOnce);
export const updateRoomSettings = retryRoomConflicts(updateRoomSettingsOnce);
export const leaveRoom = retryRoomConflicts(leaveRoomOnce);
export const kickPlayer = retryRoomConflicts(kickPlayerOnce);
export const setPlayerTargeting = retryRoomConflicts(setPlayerTargetingOnce);
export const updateProgress = retryRoomConflicts(updateProgressOnce);
export const submitResult = retryRoomConflicts(submitResultOnce);
export const addAttack = retryRoomConflicts(addAttackOnce);
export const eliminatePlayer = retryRoomConflicts(eliminatePlayerOnce);
export const getRoomState = retryRoomConflicts(getRoomStateOnce);
export const addPeerSignal = retryRoomConflicts(addPeerSignalOnce);
export const setRoomBet = retryRoomConflicts(setRoomBetOnce);

async function createRoomOnce(
  store: RoomStore,
  request: CreateRoomRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const player = createPlayer(request.playerId, request.name, nowMs, request.avatarUrl, request.npub);
  const id = request.roomId
    ? normalizeRoomIdStrict(request.roomId)
    : await generateUniqueRoomId((candidate) => store.getRoom(candidate));
  if (await store.getRoom(id)) throw new OnlineRoomError('Room already exists.', 409);
  const mode = normalizeRoomMode(request.mode, true);
  const matchType = normalizeMatchType(request.matchType, mode, true);
  const ruleset = normalizeRuleset(request.ruleset, matchType, true);
  const room: OnlineRoom = {
    id,
    visibility: normalizeVisibility(request.visibility),
    mode,
    matchType,
    region: normalizeRegion(request.region),
    ruleset,
    rules: normalizeRoomRules(request.rules, mode, ruleset),
    status: 'lobby',
    hostPlayerId: player.id,
    createdAtServerMs: nowMs,
    updatedAtServerMs: nowMs,
    startsAtServerMs: null,
    seed: randomSeed(),
    winnerPlayerId: null,
    matchResultId: null,
    players: [player],
    peerSignals: [],
    attacks: [],
    bet: null,
    lunaGameId: normalizeNullableString(request.lunaGameId),
  };
  await persistRoom(store, room);
  return room;
}

export interface VerifiedLunaNegraInvite {
  npub: string;
  pubkey: string;
  gameId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  roomId: string;
  host: boolean;
  hostPubkey: string | null;
  expiresAt: string | null;
}

async function enterLunaNegraRoomOnce(
  store: RoomStore,
  invite: VerifiedLunaNegraInvite,
  nowMs = Date.now(),
): Promise<{ room: OnlineRoom; player: LunaNegraPlayer }> {
  const player = lunaNegraPlayerFromInvite(invite);
  const roomId = normalizeRoomIdStrict(invite.roomId);
  const existing = await store.getRoom(roomId).then((value) => value ? normalizeRoomShape(value) : null);

  if (existing) {
    if (invite.hostPubkey && existing.hostPlayerId !== invite.hostPubkey) {
      throw new OnlineRoomError('Luna Negra host does not match this room.', 403);
    }
    if (invite.host && existing.hostPlayerId !== player.id) {
      throw new OnlineRoomError('Only the original Luna Negra host can reopen this room.', 403);
    }
    if (invite.gameId && !existing.lunaGameId) existing.lunaGameId = normalizeNullableString(invite.gameId);
    const room = await enterExistingLunaNegraRoom(store, existing, player, nowMs);
    return { room, player };
  }

  if (!invite.host) {
    throw new OnlineRoomError('La sala todavia no fue abierta por el host.', 404);
  }

  const room = await createRoom(store, {
    roomId,
    playerId: player.id,
    npub: player.npub,
    lunaGameId: invite.gameId,
    name: player.name,
    avatarUrl: player.avatarUrl,
    visibility: 'private',
    mode: 'custom',
    matchType: 'battle',
    rules: BATTLE_RULES,
  }, nowMs);
  return { room, player };
}

async function joinRoomOnce(
  store: RoomStore,
  request: JoinRoomRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await requireRoom(store, request.roomId);
  if (room.status !== 'lobby') throw new OnlineRoomError('Room already started.', 409);
  const player = createPlayer(request.playerId, request.name, nowMs, request.avatarUrl, request.npub);
  const existing = room.players.find((candidate) => candidate.id === player.id);
  if (existing) {
    existing.name = player.name;
    if (request.avatarUrl !== undefined) existing.avatarUrl = player.avatarUrl;
    if (player.npub) existing.npub = player.npub;
    existing.updatedAtServerMs = nowMs;
    existing.status = existing.ready ? 'ready' : 'joined';
  } else {
    room.players.push(player);
  }
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}

async function setPlayerReadyOnce(
  store: RoomStore,
  request: ReadyRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await requireRoom(store, request.roomId);
  if (room.status !== 'lobby') throw new OnlineRoomError('Room already started.', 409);
  const player = requirePlayer(room, request.playerId);
  player.ready = request.ready;
  player.status = request.ready ? 'ready' : 'joined';
  player.updatedAtServerMs = nowMs;
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}

async function startRoomOnce(
  store: RoomStore,
  request: StartRoomRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await requireRoom(store, request.roomId);
  if (room.hostPlayerId !== request.playerId) throw new OnlineRoomError('Only the host can start.', 403);
  if (room.status !== 'lobby') return room;
  if (room.players.some((player) => !player.ready)) {
    throw new OnlineRoomError('All players must be ready.', 409);
  }
  if (room.bet && room.bet.status !== 'funded') {
    throw new OnlineRoomError('La apuesta todavía no está fondeada por todos los jugadores.', 409);
  }
  prepareRoundCountdown(room, nowMs, false);
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}

async function restartRoomOnce(
  store: RoomStore,
  request: RestartRoomRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await requireRoom(store, request.roomId);
  if (room.hostPlayerId !== request.playerId) throw new OnlineRoomError('Only the host can restart.', 403);
  if (room.status !== 'finished') return room;
  if (room.bet) {
    if (!isTerminalRoomBetStatus(room.bet.status)) {
      throw new OnlineRoomError('La apuesta todavía no terminó de liquidarse.', 409);
    }
    room.bet = null;
  }
  room.matchResultId = null;
  prepareRoundCountdown(room, nowMs, true);
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}

async function updateRoomSettingsOnce(
  store: RoomStore,
  request: UpdateRoomSettingsRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await requireRoom(store, request.roomId);
  if (room.hostPlayerId !== request.playerId) throw new OnlineRoomError('Only the host can change room settings.', 403);
  if (room.status !== 'lobby') throw new OnlineRoomError('Room settings can only change in the lobby.', 409);
  if (room.bet && !isTerminalRoomBetStatus(room.bet.status)) {
    throw new OnlineRoomError('No se puede cambiar el modo con una apuesta activa.', 409);
  }

  const mode = normalizeRoomMode(request.mode, true);
  const matchType = normalizeMatchType(request.matchType, mode, true);
  const ruleset = normalizeRuleset(request.ruleset, matchType, true);
  room.visibility = normalizeVisibility(request.visibility ?? room.visibility);
  room.mode = 'custom';
  room.matchType = matchType;
  room.ruleset = ruleset;
  room.rules = normalizeRoomRules(request.rules, room.mode, ruleset);
  room.winnerPlayerId = null;
  room.matchResultId = null;
  room.startsAtServerMs = null;
  room.attacks = [];
  room.players = room.players.map((player) => ({
    ...player,
    ready: false,
    status: 'joined',
    updatedAtServerMs: nowMs,
  }));
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}

/**
 * Saca a un jugador de su sala. Si era el host, migra el host al siguiente
 * jugador que queda. Si la sala queda vacía, la elimina. Devuelve la sala
 * resultante (o null si se eliminó) y a quién se le pasó el host.
 */
async function leaveRoomOnce(
  store: RoomStore,
  request: LeaveRoomRequest,
  nowMs = Date.now(),
): Promise<{ room: OnlineRoom | null; hostMigratedTo: string | null }> {
  const room = await store.getRoom(normalizeRoomId(request.roomId)).then((value) => (value ? normalizeRoomShape(value) : null));
  if (!room) return { room: null, hostMigratedTo: null };
  const before = room.players.length;
  room.players = room.players.filter((player) => player.id !== request.playerId);
  if (room.players.length === before) {
    // El jugador no estaba en la sala; no hay cambios.
    return { room, hostMigratedTo: null };
  }

  if (room.players.length === 0) {
    await removeRoomEverywhere(store, room.id);
    return { room: null, hostMigratedTo: null };
  }

  const hostMigratedTo = migrateHostIfNeeded(room);

  if (room.status === 'playing' || room.status === 'countdown') {
    if (room.players.length === 1) {
      const winner = room.players[0];
      winner.status = 'winner';
      winner.alive = true;
      winner.finishedAtServerMs = nowMs;
      winner.updatedAtServerMs = nowMs;
      room.winnerPlayerId = winner.id;
      room.status = 'finished';
      sealMatchResult(room, nowMs);
    } else {
      finishRoomIfOnlyOneAlive(room, nowMs);
    }
  }

  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return { room, hostMigratedTo };
}

/** El host expulsa a otro jugador de la sala. Solo el host puede hacerlo. */
async function kickPlayerOnce(
  store: RoomStore,
  request: KickPlayerRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await requireRoom(store, request.roomId);
  if (room.hostPlayerId !== request.playerId) throw new OnlineRoomError('Solo el host puede expulsar jugadores.', 403);
  if (request.targetPlayerId === room.hostPlayerId) throw new OnlineRoomError('El host no puede expulsarse a sí mismo.', 409);
  if (room.status !== 'lobby') throw new OnlineRoomError('Solo se puede expulsar en el lobby.', 409);
  const before = room.players.length;
  room.players = room.players.filter((player) => player.id !== request.targetPlayerId);
  if (room.players.length === before) throw new OnlineRoomError('El jugador no está en la sala.', 404);
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}

/**
 * Asegura que el host de la sala siga presente. Si el host actual ya no está en
 * la lista de jugadores, le pasa la autoridad al primer jugador que queda
 * (el siguiente en la sala). Devuelve el nuevo hostPlayerId si hubo migración.
 */
function migrateHostIfNeeded(room: OnlineRoom): string | null {
  if (room.players.some((player) => player.id === room.hostPlayerId)) return null;
  const next = room.players[0];
  if (!next) return null;
  room.hostPlayerId = next.id;
  return next.id;
}

async function removeRoomEverywhere(store: RoomStore, roomId: string): Promise<void> {
  await store.deleteRoom(roomId);
  const publicIds = await store.listPublicRoomIds();
  if (publicIds.includes(roomId)) {
    await store.savePublicRoomIds(publicIds.filter((id) => id !== roomId), ROOM_TTL_SECONDS);
  }
}

// ───────────────────── Presencia / amigos de Luna Negra ─────────────────────

/** Registra/actualiza la presencia de un npub (tiene el juego abierto / está en sala). */
export async function recordLunaPresence(
  store: RoomStore,
  request: LunaPresenceRequest,
  nowMs = Date.now(),
): Promise<void> {
  const npub = normalizeNpub(request.npub);
  if (!npub) throw new OnlineRoomError('npub inválido.', 400);
  const records = prunePresence(await store.getPresenceRecords(), nowMs);
  const filtered = records.filter((record) => record.npub !== npub);
  filtered.push({
    npub,
    name: normalizePlayerName(request.name),
    avatarUrl: normalizeAvatarUrl(request.avatarUrl),
    status: request.status === 'in-game' ? 'in-game' : 'online',
    roomId: typeof request.roomId === 'string' && request.roomId.trim() ? normalizeRoomId(request.roomId) : null,
    updatedAtServerMs: nowMs,
  });
  await store.savePresenceRecords(filtered, LUNA_PRESENCE_TTL_SECONDS);
}

/**
 * Devuelve la lista de amigos (mock): todos los npubs con presencia reciente en
 * este juego, excepto uno mismo, ordenados in-game → online. El grafo real de
 * amistades lo provee Luna Negra; hasta entonces "amigos" = jugadores presentes.
 */
export async function listLunaFriendsMock(
  store: RoomStore,
  selfNpub: string,
  nowMs = Date.now(),
): Promise<LunaFriend[]> {
  const self = normalizeNpub(selfNpub);
  const records = prunePresence(await store.getPresenceRecords(), nowMs);
  const friends: LunaFriend[] = records
    .filter((record) => record.npub !== self)
    .map((record) => ({
      npub: record.npub,
      name: record.name,
      avatarUrl: record.avatarUrl,
      presence: record.status === 'in-game' ? 'in-game' : 'online',
      roomId: record.roomId,
      lastSeenMs: record.updatedAtServerMs,
    }));
  return sortLunaFriends(friends);
}

/** Ordena: primero los que tienen el juego abierto (in-game), luego online, luego offline. */
export function sortLunaFriends(friends: LunaFriend[]): LunaFriend[] {
  const rank: Record<LunaFriend['presence'], number> = { 'in-game': 0, online: 1, offline: 2 };
  return [...friends].sort((a, b) => {
    if (rank[a.presence] !== rank[b.presence]) return rank[a.presence] - rank[b.presence];
    return a.name.localeCompare(b.name);
  });
}

function prunePresence(records: LunaPresenceRecord[], nowMs: number): LunaPresenceRecord[] {
  return records.filter((record) => nowMs - record.updatedAtServerMs <= LUNA_PRESENCE_TTL_MS);
}

async function setPlayerTargetingOnce(
  store: RoomStore,
  request: SetTargetingRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await requireRoom(store, request.roomId);
  const player = requirePlayer(room, request.playerId);
  const targetingMode = normalizeTargetingMode(request.targetingMode, true);
  const manualTargetPlayerId = normalizeManualTarget(room, player.id, request.manualTargetPlayerId);
  player.targetingMode = targetingMode;
  player.manualTargetPlayerId = targetingMode === 'manual' ? manualTargetPlayerId : null;
  player.currentTargetPlayerId = targetingMode === 'manual' ? manualTargetPlayerId : player.currentTargetPlayerId;
  player.updatedAtServerMs = nowMs;
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}

async function updateProgressOnce(
  store: RoomStore,
  request: ProgressRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await requireRoom(store, request.roomId);
  requireHostAuthority(room, request.authorityPlayerId);
  if (!requestMatchesRoomSeed(room, request.seed)) return room;
  const player = requirePlayer(room, request.playerId);
  if (isTerminalPlayer(player)) return room;
  if (room.status === 'countdown' && room.startsAtServerMs !== null && nowMs >= room.startsAtServerMs) {
    room.status = 'playing';
  }
  player.status = player.alive ? 'playing' : player.status;
  player.lines = normalizeNonNegativeInteger(request.lines);
  player.pieces = normalizeNonNegativeInteger(request.pieces);
  player.elapsedFrames = normalizeNonNegativeInteger(request.elapsedFrames);
  player.sentGarbage = normalizeNonNegativeInteger(request.sentGarbage ?? player.sentGarbage);
  player.receivedGarbage = normalizeNonNegativeInteger(request.receivedGarbage ?? player.receivedGarbage);
  player.pendingGarbage = normalizeNonNegativeInteger(request.pendingGarbage ?? player.pendingGarbage);
  player.game = request.game ?? null;
  player.dangerLevel = calculateDangerLevel(player.game, player.pendingGarbage);
  player.updatedAtServerMs = nowMs;
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}

async function submitResultOnce(
  store: RoomStore,
  request: ResultRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await requireRoom(store, request.roomId);
  requireHostAuthority(room, request.authorityPlayerId);
  if (!requestMatchesRoomSeed(room, request.seed)) return room;
  const player = requirePlayer(room, request.playerId);
  if (isTerminalPlayer(player)) return room;
  player.status = request.result;
  player.ready = true;
  player.alive = request.result === 'won';
  player.lines = normalizeNonNegativeInteger(request.lines);
  player.pieces = normalizeNonNegativeInteger(request.pieces);
  player.elapsedFrames = normalizeNonNegativeInteger(request.elapsedFrames);
  player.sentGarbage = normalizeNonNegativeInteger(request.sentGarbage ?? player.sentGarbage);
  player.receivedGarbage = normalizeNonNegativeInteger(request.receivedGarbage ?? player.receivedGarbage);
  player.pendingGarbage = normalizeNonNegativeInteger(request.pendingGarbage ?? player.pendingGarbage);
  player.game = request.game ?? null;
  player.dangerLevel = calculateDangerLevel(player.game, player.pendingGarbage);
  player.updatedAtServerMs = nowMs;
  player.finishedAtServerMs = nowMs;
  room.updatedAtServerMs = nowMs;
  if (room.ruleset.objective.type === 'sprint' && request.result === 'won') {
    finishSprintRace(room, player, nowMs);
  } else if (room.players.every((candidate) => candidate.status === 'won' || candidate.status === 'lost')) {
    room.status = 'finished';
    room.winnerPlayerId = room.players.find((candidate) => candidate.status === 'won')?.id ?? null;
    sealMatchResult(room, nowMs);
  }
  await persistRoom(store, room);
  return room;
}

async function addAttackOnce(
  store: RoomStore,
  request: AttackRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await requireRoom(store, request.roomId);
  const authority = requireHostAuthority(room, request.authorityPlayerId);
  if (!requestMatchesRoomSeed(room, request.seed)) return room;
  const from = requirePlayer(room, request.fromPlayerId);
  const to = requirePlayer(room, request.toPlayerId);
  if (!from.alive || !to.alive || room.status === 'finished') return room;
  const id = normalizeAttackId(request.attackId);
  if ((room.attacks ?? []).some((attack) => attack.id === id)) return room;
  const attack: OnlineAttack = {
    id,
    roomId: room.id,
    authorityPlayerId: authority.id,
    fromPlayerId: from.id,
    toPlayerId: to.id,
    seed: request.seed,
    lines: normalizeNonNegativeInteger(request.lines),
    holeSeed: normalizeNonNegativeInteger(request.holeSeed),
    frame: normalizeNonNegativeInteger(request.frame),
    createdAtServerMs: nowMs,
  };
  if (attack.lines <= 0) return room;
  from.currentTargetPlayerId = to.id;
  to.recentAttackers = prependUnique(to.recentAttackers ?? [], from.id, 8);
  to.receivedGarbageThisRound = normalizeNonNegativeInteger((to.receivedGarbageThisRound ?? 0) + attack.lines);
  room.attacks = [...(room.attacks ?? []), attack].slice(-MAX_ATTACKS_PER_ROOM);
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}

async function eliminatePlayerOnce(
  store: RoomStore,
  request: EliminateRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await requireRoom(store, request.roomId);
  requireHostAuthority(room, request.authorityPlayerId);
  if (!requestMatchesRoomSeed(room, request.seed)) return room;
  const player = requirePlayer(room, request.playerId);
  if (player.status === 'winner' || room.winnerPlayerId === player.id) return room;
  if (player.status !== 'eliminated') {
    player.status = 'eliminated';
    player.ready = true;
    player.alive = false;
    player.eliminatedAtFrame = normalizeNonNegativeInteger(request.frame);
    player.eliminatedAtServerMs = nowMs;
    player.finishedAtServerMs = nowMs;
    // El KO se acredita solo la primera vez: los reintentos del reporte de
    // eliminación no deben inflar el contador del atacante.
    const lastAttackerId = player.recentAttackers[0];
    const lastAttacker = lastAttackerId ? room.players.find((candidate) => candidate.id === lastAttackerId) : null;
    if (lastAttacker && lastAttacker.id !== player.id) {
      lastAttacker.koCount = normalizeNonNegativeInteger((lastAttacker.koCount ?? 0) + 1);
    }
  }
  player.lines = normalizeNonNegativeInteger(request.lines);
  player.pieces = normalizeNonNegativeInteger(request.pieces);
  player.elapsedFrames = normalizeNonNegativeInteger(request.elapsedFrames);
  player.sentGarbage = normalizeNonNegativeInteger(request.sentGarbage ?? player.sentGarbage);
  player.receivedGarbage = normalizeNonNegativeInteger(request.receivedGarbage ?? player.receivedGarbage);
  player.pendingGarbage = normalizeNonNegativeInteger(request.pendingGarbage ?? player.pendingGarbage);
  player.game = request.game ?? null;
  player.dangerLevel = calculateDangerLevel(player.game, player.pendingGarbage);
  player.updatedAtServerMs = nowMs;
  finishRoomIfOnlyOneAlive(room, nowMs);
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}

export async function listPublicRooms(
  store: RoomStore,
  nowMs = Date.now(),
  filters: PublicRoomsFilters = {},
): Promise<OnlineRoomSummary[]> {
  const ids = await store.listPublicRoomIds();
  const rooms = await Promise.all(ids.map(async (id) => {
    const room = await store.getRoom(id);
    return room ? normalizeRoomShape(room) : null;
  }));
  const visible = rooms
    .filter((room): room is OnlineRoom => room !== null && room.visibility === 'public')
    .map((room) => applyStalePlayers(room, nowMs))
    .filter((room) => room.status === 'lobby' || room.status === 'countdown')
    .filter((room) => roomMatchesPublicFilters(room, filters));
  return visible
    .map(roomSummary)
    .sort((a, b) => b.createdAtServerMs - a.createdAtServerMs);
}

async function getRoomStateOnce(store: RoomStore, roomId: string, nowMs = Date.now()): Promise<OnlineRoom> {
  const room = await requireRoom(store, roomId);
  let changed = false;
  if (room.status === 'countdown' && room.startsAtServerMs !== null && nowMs >= room.startsAtServerMs) {
    room.status = 'playing';
    changed = true;
  }
  // El failover corre antes de marcar updatedAtServerMs: mide la inactividad del
  // host contra la última escritura real, no contra la transición de countdown.
  if (applyHostFailover(room, nowMs)) changed = true;
  if (changed) {
    room.updatedAtServerMs = nowMs;
    await persistRoom(store, room);
  }
  return applyStalePlayers(room, nowMs);
}

async function addPeerSignalOnce(
  store: RoomStore,
  request: PeerSignalRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await requireRoom(store, request.roomId);
  requirePlayer(room, request.fromPlayerId);
  requirePlayer(room, request.toPlayerId);
  const signal: OnlinePeerSignal = {
    id: `${nowMs}-${Math.random().toString(36).slice(2, 10)}`,
    roomId: room.id,
    fromPlayerId: request.fromPlayerId,
    toPlayerId: request.toPlayerId,
    type: normalizePeerSignalType(request.type),
    data: request.data,
    createdAtServerMs: nowMs,
  };
  room.peerSignals = [...(room.peerSignals ?? []), signal].slice(-MAX_PEER_SIGNALS_PER_ROOM);
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}

export function rankPlayers(players: OnlinePlayer[]): OnlinePlayer[] {
  return [...players].sort((a, b) => {
    const resultDelta = resultRank(a.status) - resultRank(b.status);
    if (resultDelta !== 0) return resultDelta;
    if (a.status === 'eliminated' && b.status === 'eliminated') {
      const frameDelta = (b.eliminatedAtFrame ?? b.elapsedFrames) - (a.eliminatedAtFrame ?? a.elapsedFrames);
      if (frameDelta !== 0) return frameDelta;
    }
    if (a.status === 'won' && b.status === 'won') return a.elapsedFrames - b.elapsedFrames;
    if (a.status === 'lost' && b.status === 'lost') return b.lines - a.lines;
    const finishedDelta = (a.finishedAtServerMs ?? Number.MAX_SAFE_INTEGER) - (b.finishedAtServerMs ?? Number.MAX_SAFE_INTEGER);
    if (finishedDelta !== 0) return finishedDelta;
    return a.name.localeCompare(b.name);
  });
}

function calculateDangerLevel(game: OnlineGameSnapshot | null, pendingGarbage: number): number {
  const pendingDanger = Math.min(10, Math.floor(normalizeNonNegativeInteger(pendingGarbage) / 2));
  if (!game || !Array.isArray(game.board) || game.board.length === 0) return pendingDanger;
  const visibleRows = Math.max(1, Math.min(normalizeNonNegativeInteger(game.visibleRows), game.board.length));
  const visibleBoard = game.board.slice(game.board.length - visibleRows);
  const firstOccupiedRow = visibleBoard.findIndex((row) => Array.isArray(row) && row.some((cell) => cell !== null));
  const heightDanger = firstOccupiedRow === -1
    ? 0
    : Math.ceil(((visibleRows - firstOccupiedRow) / visibleRows) * 10);
  return Math.min(10, Math.max(heightDanger, pendingDanger));
}

export async function generateUniqueRoomId(
  getExistingRoom: (id: string) => Promise<OnlineRoom | null>,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = createRoomCode();
    if (!(await getExistingRoom(id))) return id;
  }
  throw new OnlineRoomError('Could not allocate a room code.', 503);
}

export function createRoomCode(random = Math.random): string {
  let code = '';
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function enterExistingLunaNegraRoom(
  store: RoomStore,
  room: OnlineRoom,
  lunaPlayer: LunaNegraPlayer,
  nowMs: number,
): Promise<OnlineRoom> {
  const existing = room.players.find((candidate) => candidate.id === lunaPlayer.id);
  if (existing) {
    existing.name = normalizePlayerName(lunaPlayer.name);
    existing.avatarUrl = normalizeAvatarUrl(lunaPlayer.avatarUrl);
    if (lunaPlayer.npub) existing.npub = normalizeNpub(lunaPlayer.npub);
    existing.updatedAtServerMs = nowMs;
    if (room.status === 'lobby') existing.status = existing.ready ? 'ready' : 'joined';
    room.updatedAtServerMs = nowMs;
    return persistRoom(store, room).then(() => room);
  }
  if (room.status !== 'lobby') throw new OnlineRoomError('Room already started.', 409);
  room.players.push(createPlayer(lunaPlayer.id, lunaPlayer.name, nowMs, lunaPlayer.avatarUrl, lunaPlayer.npub));
  room.updatedAtServerMs = nowMs;
  return persistRoom(store, room).then(() => room);
}

export class MemoryRoomStore implements RoomStore {
  private rooms = new Map<string, OnlineRoom>();
  private publicIds: string[] = [];
  private presence: LunaPresenceRecord[] = [];

  async getRoom(id: string): Promise<OnlineRoom | null> {
    return cloneRoom(this.rooms.get(normalizeRoomId(id)) ?? null);
  }

  async saveRoom(room: OnlineRoom): Promise<void> {
    const normalized = cloneRoom(room);
    if (!normalized) return;
    const expectedVersion = normalized.version ?? 0;
    const currentVersion = this.rooms.get(normalized.id)?.version ?? 0;
    if (currentVersion !== expectedVersion) throw new RoomVersionConflictError();
    normalized.version = expectedVersion + 1;
    // El objeto del llamador queda apuntando a la revisión recién guardada,
    // así un save posterior sobre el mismo objeto no falla por versión vieja.
    room.version = expectedVersion + 1;
    this.rooms.set(normalized.id, normalized);
    if (normalized.visibility === 'public' && !this.publicIds.includes(normalized.id)) {
      this.publicIds = [normalized.id, ...this.publicIds];
    } else if (normalized.visibility !== 'public') {
      this.publicIds = this.publicIds.filter((roomId) => roomId !== normalized.id);
    }
  }

  async deleteRoom(id: string): Promise<void> {
    const normalized = normalizeRoomId(id);
    this.rooms.delete(normalized);
    this.publicIds = this.publicIds.filter((roomId) => roomId !== normalized);
  }

  async listPublicRoomIds(): Promise<string[]> {
    return [...this.publicIds];
  }

  async savePublicRoomIds(ids: string[]): Promise<void> {
    this.publicIds = [...new Set(ids.map(normalizeRoomId))];
  }

  async getPresenceRecords(): Promise<LunaPresenceRecord[]> {
    return this.presence.map((record) => ({ ...record }));
  }

  async savePresenceRecords(records: LunaPresenceRecord[]): Promise<void> {
    this.presence = records.map((record) => ({ ...record }));
  }

}

async function persistRoom(store: RoomStore, room: OnlineRoom): Promise<void> {
  await store.saveRoom(room, ROOM_TTL_SECONDS);
  const publicIds = await store.listPublicRoomIds();
  const nextPublicIds = room.visibility === 'public'
    ? [room.id, ...publicIds.filter((id) => id !== room.id)]
    : publicIds.filter((id) => id !== room.id);
  await store.savePublicRoomIds(nextPublicIds, ROOM_TTL_SECONDS);
}

async function requireRoom(store: RoomStore, roomId: string): Promise<OnlineRoom> {
  const room = await store.getRoom(normalizeRoomId(roomId));
  if (!room) throw new OnlineRoomError('Room not found.', 404);
  return normalizeRoomShape(room);
}

function requirePlayer(room: OnlineRoom, playerId: string): OnlinePlayer {
  const player = room.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new OnlineRoomError('Player is not in this room.', 403);
  return player;
}

function requireHostAuthority(room: OnlineRoom, authorityPlayerId: string): OnlinePlayer {
  const authority = requirePlayer(room, authorityPlayerId);
  if (authority.id !== room.hostPlayerId) {
    throw new OnlineRoomError('Only the host can authoritatively update the room.', 403);
  }
  return authority;
}

function requestMatchesRoomSeed(room: OnlineRoom, seed: number | undefined): boolean {
  return seed !== undefined && normalizeNonNegativeInteger(seed) === room.seed;
}

function createPlayer(id: string, name: string, nowMs: number, avatarUrl?: string | null, npub?: string | null): OnlinePlayer {
  const normalizedId = normalizePlayerId(id);
  const normalizedName = normalizePlayerName(name);
  return {
    id: normalizedId,
    npub: normalizeNpub(npub),
    name: normalizedName,
    avatarUrl: normalizeAvatarUrl(avatarUrl),
    ready: false,
    status: 'joined',
    lines: 0,
    pieces: 0,
    elapsedFrames: 0,
    sentGarbage: 0,
    receivedGarbage: 0,
    pendingGarbage: 0,
    alive: true,
    updatedAtServerMs: nowMs,
    finishedAtServerMs: null,
    eliminatedAtFrame: null,
    eliminatedAtServerMs: null,
    game: null,
    targetingMode: 'random',
    manualTargetPlayerId: null,
    currentTargetPlayerId: null,
    recentAttackers: [],
    koCount: 0,
    receivedGarbageThisRound: 0,
    dangerLevel: 0,
  };
}

function roomSummary(room: OnlineRoom): OnlineRoomSummary {
  const host = room.players.find((player) => player.id === room.hostPlayerId);
  return {
    id: room.id,
    hostName: host?.name ?? 'Host',
    hostAvatarUrl: host?.avatarUrl ?? null,
    playerCount: room.players.length,
    mode: room.mode,
    matchType: room.matchType,
    region: room.region,
    customPreset: room.matchType === 'custom' ? room.ruleset.rulesetId : null,
    ruleset: room.ruleset,
    status: room.status,
    createdAtServerMs: room.createdAtServerMs,
  };
}

function applyStalePlayers(room: OnlineRoom, nowMs: number): OnlineRoom {
  return {
    ...room,
    players: room.players.map((player) => {
      if (isTerminalPlayer(player)) return { ...player };
      if (nowMs - player.updatedAtServerMs <= PLAYER_STALE_MS) return { ...player };
      return { ...player, status: 'disconnected' };
    }),
    peerSignals: room.peerSignals ?? [],
    attacks: room.attacks ?? [],
  };
}

function normalizePeerSignalType(value: string): OnlinePeerSignal['type'] {
  if (value === 'offer' || value === 'answer' || value === 'ice') return value;
  throw new OnlineRoomError('Invalid peer signal type.');
}

function finishRoomIfOnlyOneAlive(room: OnlineRoom, nowMs: number): void {
  if (room.status !== 'playing' && room.status !== 'countdown') return;
  const alive = room.players.filter((player) => player.alive && player.status !== 'eliminated');
  if (alive.length !== 1 || room.players.length < 2) return;
  const winner = alive[0];
  winner.status = 'winner';
  winner.alive = true;
  winner.finishedAtServerMs = nowMs;
  winner.updatedAtServerMs = nowMs;
  room.winnerPlayerId = winner.id;
  room.status = 'finished';
  sealMatchResult(room, nowMs);
}

/**
 * Recupera una ronda cuyo host autoritativo dejó de actualizar la sala. Como
 * solo el host puede emitir progress/attack/eliminate/result, si cierra la
 * pestaña o pierde conexión sin llamar a /leave la sala quedaría atascada en
 * 'playing' para siempre. Lo detectamos al leer la sala (getRoomState, que
 * pollean todos los clientes): si `updatedAtServerMs` no se movió en
 * HOST_STALE_MS durante una ronda activa, sacamos al host de la ronda y migramos
 * la autoridad al siguiente jugador vivo. Los clientes releen `hostPlayerId` en
 * cada poll, así el sucesor asume el rol. Si no queda nadie vivo, anula la ronda
 * (finished sin ganador). Cada migración refresca `updatedAtServerMs`, dándole
 * al sucesor su propia ventana antes de que la falta de actividad lo migre de
 * nuevo en cascada. Devuelve true si mutó la sala.
 */
function applyHostFailover(room: OnlineRoom, nowMs: number): boolean {
  if (room.status !== 'playing' && room.status !== 'countdown') return false;
  if (nowMs - room.updatedAtServerMs <= HOST_STALE_MS) return false;

  let changed = false;
  const host = room.players.find((player) => player.id === room.hostPlayerId);
  if (host && !isTerminalPlayer(host)) {
    host.status = 'eliminated';
    host.alive = false;
    host.ready = true;
    host.finishedAtServerMs = nowMs;
    host.eliminatedAtServerMs = nowMs;
    host.eliminatedAtFrame = host.eliminatedAtFrame ?? normalizeNonNegativeInteger(host.elapsedFrames);
    host.updatedAtServerMs = nowMs;
    changed = true;
  }

  const successor = room.players.find(
    (player) => player.id !== room.hostPlayerId && player.alive && !isTerminalPlayer(player),
  );
  if (successor) {
    room.hostPlayerId = successor.id;
    changed = true;
  }

  finishRoomIfOnlyOneAlive(room, nowMs);
  // finishRoomIfOnlyOneAlive puede haber mutado el status a 'finished' (TS no lo
  // ve por el narrowing del guard inicial), así que lo releemos sin estrecharlo.
  const finishedByOneAlive = (room.status as OnlineRoomStatus) === 'finished';
  if (finishedByOneAlive) {
    changed = true;
  } else {
    const aliveCount = room.players.filter((player) => player.alive && !isTerminalPlayer(player)).length;
    if (aliveCount === 0) {
      // Nadie vivo a quien pasarle la autoridad: la ronda se anula (sin ganador).
      room.status = 'finished';
      room.winnerPlayerId = null;
      sealMatchResult(room, nowMs);
      changed = true;
    }
  }

  if (changed) room.updatedAtServerMs = nowMs;
  return changed;
}

function finishSprintRace(room: OnlineRoom, winner: OnlinePlayer, nowMs: number): void {
  room.status = 'finished';
  room.winnerPlayerId = winner.id;
  sealMatchResult(room, nowMs);
  winner.status = 'won';
  winner.alive = true;
  winner.ready = true;
  winner.finishedAtServerMs = nowMs;
  winner.updatedAtServerMs = nowMs;
  for (const player of room.players) {
    if (player.id === winner.id || isTerminalPlayer(player)) continue;
    player.status = 'lost';
    player.alive = false;
    player.ready = true;
    player.finishedAtServerMs = nowMs;
    player.updatedAtServerMs = nowMs;
  }
}

function sealMatchResult(room: OnlineRoom, nowMs: number): void {
  if (!room.matchResultId) room.matchResultId = `${room.id}:${room.seed}:${nowMs}`;
}

function prepareRoundCountdown(room: OnlineRoom, nowMs: number, reseed: boolean): void {
  room.status = 'countdown';
  room.startsAtServerMs = nowMs + ROOM_START_DELAY_MS;
  room.winnerPlayerId = null;
  if (reseed) room.seed = randomSeed();
  room.attacks = [];
  room.players.forEach((player) => {
    player.ready = true;
    player.status = 'ready';
    player.lines = 0;
    player.pieces = 0;
    player.elapsedFrames = 0;
    player.sentGarbage = 0;
    player.receivedGarbage = 0;
    player.pendingGarbage = 0;
    player.alive = true;
    player.finishedAtServerMs = null;
    player.eliminatedAtFrame = null;
    player.eliminatedAtServerMs = null;
    player.game = null;
    player.currentTargetPlayerId = null;
    player.recentAttackers = [];
    player.receivedGarbageThisRound = 0;
    player.dangerLevel = 0;
    player.updatedAtServerMs = nowMs;
  });
}

function isTerminalPlayer(player: OnlinePlayer): boolean {
  return player.status === 'winner'
    || player.status === 'eliminated'
    || player.status === 'won'
    || player.status === 'lost'
    || player.finishedAtServerMs !== null;
}

function normalizeAttackId(value: string): string {
  const normalized = value.trim().slice(0, 120);
  if (normalized.length < 4) throw new OnlineRoomError('Invalid attack id.');
  return normalized;
}

function resultRank(status: OnlinePlayer['status']): number {
  if (status === 'winner') return 0;
  if (status === 'won') return 0;
  if (status === 'eliminated') return 1;
  if (status === 'lost') return 1;
  return 2;
}

function normalizeVisibility(value: RoomVisibility): RoomVisibility {
  return value === 'public' ? 'public' : 'private';
}

function normalizeRegion(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_ONLINE_REGION;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16);
  return normalized || DEFAULT_ONLINE_REGION;
}

function normalizeRoomMode(value: unknown, strict = false): OnlineRoomMode {
  if (value === undefined || value === null || value === 'custom') return 'custom';
  if (!strict) return 'custom';
  throw new OnlineRoomError('Only custom online rooms are supported.');
}

function normalizeMatchType(value: unknown, mode: OnlineRoomMode, strict = false): OnlineMatchType {
  void mode;
  if (value === undefined || value === null || value === 'custom') return 'custom';
  if (value === 'battle') return 'battle';
  if (!strict) return 'custom';
  throw new OnlineRoomError('Only custom online rooms are supported.');
}

function normalizeRuleset(value: unknown, matchType: OnlineMatchType, strict = false): OnlineRuleset {
  const fallback = defaultRuleset(matchType);
  if (value === undefined || value === null) return fallback;
  if (!isObject(value)) {
    if (strict) throw new OnlineRoomError('Invalid ruleset.');
    return fallback;
  }
  const rulesetId = normalizeRulesetId(value.rulesetId, fallback.rulesetId, strict);
  const rulesetVersion = normalizeRulesetVersion(value.rulesetVersion, fallback.rulesetVersion, strict);
  const objective = normalizeObjective(value.objective, fallback.objective, strict);
  const attackTable = normalizeAttackTable(value.attackTable, fallback.attackTable, strict);
  const targeting = normalizeTargetingMode(value.targeting, strict, fallback.targeting);
  return { rulesetId, rulesetVersion, objective, attackTable, targeting };
}

function defaultRuleset(matchType: OnlineMatchType): OnlineRuleset {
  return {
    rulesetId: matchType === 'battle' ? 'battle-last-standing-simple' : 'custom-survival-simple',
    rulesetVersion: ONLINE_RULESET_VERSION,
    objective: { type: 'lastStanding' },
    attackTable: 'simple',
    targeting: 'random',
  };
}

function normalizeRulesetId(value: unknown, fallback: string, strict: boolean): string {
  if (typeof value === 'string') {
    const normalized = value.trim().slice(0, 64);
    if (/^[a-z0-9][a-z0-9-]*$/i.test(normalized)) return normalized;
  }
  if (strict) throw new OnlineRoomError('Invalid ruleset id.');
  return fallback;
}

function normalizeRulesetVersion(value: unknown, fallback: number, strict: boolean): number {
  const version = Number(value);
  if (Number.isInteger(version) && version >= 1 && version <= ONLINE_RULESET_VERSION) return version;
  if (strict) throw new OnlineRoomError('Invalid ruleset version.');
  return fallback;
}

function normalizeObjective(value: unknown, fallback: OnlineRuleset['objective'], strict: boolean): OnlineRuleset['objective'] {
  if (isObject(value)) {
    if (value.type === 'lastStanding') return { type: 'lastStanding' };
    if (value.type === 'sprint') {
      return { type: 'sprint', targetLines: normalizeObjectiveInteger(value.targetLines, 1, 200, fallback.type === 'sprint' ? fallback.targetLines : 40, strict) };
    }
    if (value.type === 'survivalScore') {
      const duration = value.durationSeconds === null
        ? null
        : normalizeObjectiveInteger(value.durationSeconds, 10, 3600, fallback.type === 'survivalScore' ? fallback.durationSeconds ?? 120 : 120, strict);
      return { type: 'survivalScore', durationSeconds: duration };
    }
  }
  if (strict) throw new OnlineRoomError('Invalid objective.');
  return fallback;
}

function normalizeObjectiveInteger(value: unknown, min: number, max: number, fallback: number, strict: boolean): number {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= min && numeric <= max) return numeric;
  if (strict) throw new OnlineRoomError('Invalid objective value.');
  return fallback;
}

function normalizeAttackTable(value: unknown, fallback: OnlineRuleset['attackTable'], strict: boolean): OnlineRuleset['attackTable'] {
  if (value === 'simple' || value === 'modern') return value;
  if (strict) throw new OnlineRoomError('Invalid attack table.');
  return fallback;
}

function normalizeTargetingMode(value: unknown, strict = false, fallback: TargetingMode = 'random'): TargetingMode {
  if (TARGETING_MODES.includes(value as TargetingMode)) return value as TargetingMode;
  if (strict) throw new OnlineRoomError('Invalid targeting mode.');
  return fallback;
}

function normalizeOptionalInteger(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return undefined;
  return Math.min(max, Math.max(min, numeric));
}

function roomMatchesPublicFilters(room: OnlineRoom, filters: PublicRoomsFilters): boolean {
  if (filters.matchType && room.matchType !== filters.matchType) return false;
  if (filters.status && room.status !== filters.status) return false;
  if (filters.region && room.region !== normalizeRegion(filters.region)) return false;
  if (filters.customPreset && room.ruleset.rulesetId !== filters.customPreset) return false;
  const minPlayers = normalizeOptionalInteger(filters.minPlayers, 1, 99);
  const maxPlayers = normalizeOptionalInteger(filters.maxPlayers, 1, 99);
  if (minPlayers !== undefined && room.players.length < minPlayers) return false;
  if (maxPlayers !== undefined && room.players.length > maxPlayers) return false;
  return true;
}

function normalizeManualTarget(room: OnlineRoom, playerId: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new OnlineRoomError('Invalid manual target.');
  const target = room.players.find((player) => player.id === value);
  if (!target || target.id === playerId || !target.alive || target.status === 'eliminated' || target.status === 'winner') {
    throw new OnlineRoomError('Invalid manual target.');
  }
  return target.id;
}

function normalizeRoomRules(value: unknown, mode: OnlineRoomMode, ruleset: OnlineRuleset): GameRules {
  const base = {
    ...cloneRules(BATTLE_RULES),
    attackTable: ruleset.attackTable,
    targetLines: targetLinesForObjective(ruleset.objective),
  };
  if (mode !== 'custom' || !isObject(value)) return base;
  return {
    ...base,
    boardWidth: normalizeFiniteRuleNumber(value.boardWidth, base.boardWidth, { min: 4, max: 16, integer: true }),
    visibleRows: normalizeFiniteRuleNumber(value.visibleRows, base.visibleRows, { min: 10, max: 40, integer: true }),
    hiddenRows: normalizeFiniteRuleNumber(value.hiddenRows, base.hiddenRows, { min: 0, max: 10, integer: true }),
    nextPreview: normalizeFiniteRuleNumber(value.nextPreview, base.nextPreview, { min: 0, max: 7, integer: true }),
    targetLines: base.targetLines,
    gravityCellsPerFrame: normalizeFiniteRuleNumber(value.gravityCellsPerFrame, base.gravityCellsPerFrame, { min: 0.001, max: 5 }),
    gravityIncreaseCellsPerLevel: normalizeFiniteRuleNumber(value.gravityIncreaseCellsPerLevel, base.gravityIncreaseCellsPerLevel, { min: 0, max: 2 }),
    gravityLevelLines: normalizeFiniteRuleNumber(value.gravityLevelLines, base.gravityLevelLines, { min: 0, max: 60, integer: true }),
    gravityLevelPieces: normalizeFiniteRuleNumber(value.gravityLevelPieces, base.gravityLevelPieces, { min: 0, max: 60, integer: true }),
    gravityStartingLevel: normalizeFiniteRuleNumber(value.gravityStartingLevel, base.gravityStartingLevel, { min: 1, max: 30, integer: true }),
    softDropCellsPerFrame: normalizeFiniteRuleNumber(value.softDropCellsPerFrame, base.softDropCellsPerFrame, { min: 0.001, max: 20 }),
    lockDelayFrames: normalizeFiniteRuleNumber(value.lockDelayFrames, base.lockDelayFrames, { min: 0, max: 300, integer: true }),
    dasFrames: normalizeFiniteRuleNumber(value.dasFrames, base.dasFrames, { min: 0, max: 60, integer: true }),
    arrFrames: normalizeFiniteRuleNumber(value.arrFrames, base.arrFrames, { min: 0, max: 60, integer: true }),
    garbageDelayFrames: normalizeFiniteRuleNumber(value.garbageDelayFrames, base.garbageDelayFrames, { min: 0, max: 600, integer: true }),
    garbageTravelFrames: normalizeFiniteRuleNumber(value.garbageTravelFrames, base.garbageTravelFrames, { min: 0, max: 600, integer: true }),
    garbageActivationFrames: normalizeFiniteRuleNumber(value.garbageActivationFrames, base.garbageActivationFrames, { min: 0, max: 600, integer: true }),
    garbageCap: normalizeFiniteRuleNumber(value.garbageCap, base.garbageCap, { min: 0, max: 40, integer: true }),
    garbageMessinessPercent: normalizeFiniteRuleNumber(value.garbageMessinessPercent, base.garbageMessinessPercent, { min: 0, max: 100, integer: true }),
    changeOnAttack: normalizeRuleBoolean(value.changeOnAttack, base.changeOnAttack),
    continuousGarbage: normalizeRuleBoolean(value.continuousGarbage, base.continuousGarbage),
    allowHardDrop: normalizeRuleBoolean(value.allowHardDrop, base.allowHardDrop),
    allowHold: normalizeRuleBoolean(value.allowHold, base.allowHold),
    showGhost: normalizeRuleBoolean(value.showGhost, base.showGhost),
    infiniteHold: normalizeRuleBoolean(value.infiniteHold, base.infiniteHold),
    infiniteMovement: normalizeRuleBoolean(value.infiniteMovement, base.infiniteMovement),
    lockResetLimit: normalizeFiniteRuleNumber(value.lockResetLimit, base.lockResetLimit, { min: 0, max: 99, integer: true }),
  };
}

function targetLinesForObjective(objective: OnlineRuleset['objective']): number | null {
  if (objective.type === 'sprint') return objective.targetLines;
  return null;
}

export function normalizeRoomId(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, ROOM_ID_MAX_LENGTH);
}

function normalizeRoomIdStrict(value: string): string {
  const normalized = normalizeRoomId(value);
  if (normalized.length < ROOM_ID_MIN_LENGTH) throw new OnlineRoomError('Invalid room id.');
  return normalized;
}

function normalizePlayerId(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 80) throw new OnlineRoomError('Invalid player id.');
  return normalized;
}

function normalizePlayerName(value: string): string {
  const normalized = value.trim().slice(0, 18);
  return normalized.length > 0 ? normalized : 'Player';
}

function normalizeAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeNpub(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return null;
  return trimmed;
}

const ROOM_BET_STATUSES: RoomBetStatus[] = [
  'pending_deposits',
  'funded',
  'settled',
  'cancelled',
  'expired',
  'refunded',
];

function normalizeBetStatus(value: unknown): RoomBetStatus {
  return ROOM_BET_STATUSES.includes(value as RoomBetStatus) ? value as RoomBetStatus : 'pending_deposits';
}

export function isTerminalRoomBetStatus(status: RoomBetStatus): boolean {
  return status === 'settled' || status === 'cancelled' || status === 'expired' || status === 'refunded';
}

function normalizeBetDepositStatus(value: unknown): RoomBetParticipant['depositStatus'] {
  if (value === 'paid' || value === 'refunded' || value === 'failed') return value;
  return 'pending';
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeNullableSats(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : null;
}

function normalizeBet(value: unknown): RoomBet | null {
  if (!isObject(value)) return null;
  const betId = normalizeNullableString(value.betId);
  if (!betId) return null;
  const participants = Array.isArray(value.participants)
    ? value.participants
      .filter((entry): entry is Record<string, unknown> => isObject(entry) && typeof entry.npub === 'string')
      .map((entry): RoomBetParticipant => ({
        npub: String(entry.npub),
        playerId: normalizeNullableString(entry.playerId),
        depositStatus: normalizeBetDepositStatus(entry.depositStatus),
        bolt11: normalizeNullableString(entry.bolt11),
        lnurl: normalizeNullableString(entry.lnurl),
        payUrl: normalizeNullableString(entry.payUrl),
        payoutSats: normalizeNullableSats(entry.payoutSats),
      }))
    : [];
  const winnerNpubs = Array.isArray(value.winnerNpubs)
    ? value.winnerNpubs.filter((item): item is string => typeof item === 'string')
    : null;
  return {
    betId,
    status: normalizeBetStatus(value.status),
    stakeSats: normalizeNonNegativeInteger(Number(value.stakeSats ?? 0)),
    potSats: normalizeNonNegativeInteger(Number(value.potSats ?? 0)),
    potTargetSats: normalizeNonNegativeInteger(Number(value.potTargetSats ?? 0)),
    feeSats: normalizeNonNegativeInteger(Number(value.feeSats ?? 0)),
    feePct: Number.isFinite(Number(value.feePct)) ? Number(value.feePct) : 0,
    netPayoutSats: normalizeNonNegativeInteger(Number(value.netPayoutSats ?? 0)),
    depositDeadline: normalizeNullableString(value.depositDeadline),
    depositsReceived: normalizeNonNegativeInteger(Number(value.depositsReceived ?? 0)),
    depositsTotal: normalizeNonNegativeInteger(Number(value.depositsTotal ?? participants.length)),
    participants,
    winnerNpubs,
    resultReported: value.resultReported === true,
    settlementError: normalizeNullableString(value.settlementError),
    createdByPlayerId: normalizeNullableString(value.createdByPlayerId) ?? '',
    createdAtServerMs: normalizeNonNegativeInteger(Number(value.createdAtServerMs ?? 0)),
    updatedAtServerMs: normalizeNonNegativeInteger(Number(value.updatedAtServerMs ?? 0)),
  };
}

/** Carga una sala normalizada (sin efectos de stale/countdown). Para orquestar apuestas. */
export async function loadRoom(store: RoomStore, roomId: string): Promise<OnlineRoom> {
  return requireRoom(store, roomId);
}

/** Persiste el estado de la apuesta sobre la sala. */
async function setRoomBetOnce(
  store: RoomStore,
  roomId: string,
  bet: RoomBet | null,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await requireRoom(store, roomId);
  room.bet = bet ? normalizeBet(bet) : null;
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}

/** npubs de los ganadores de la sala terminada (vacío = empate/anulación). */
export function winnerNpubsFromRoom(room: OnlineRoom): string[] {
  if (!room.winnerPlayerId) return [];
  const winner = room.players.find((player) => player.id === room.winnerPlayerId);
  return winner?.npub ? [winner.npub] : [];
}

function lunaNegraPlayerFromInvite(invite: VerifiedLunaNegraInvite): LunaNegraPlayer {
  const pubkey = normalizePlayerId(invite.pubkey);
  const npub = typeof invite.npub === 'string' ? invite.npub.trim() : '';
  return {
    id: pubkey,
    npub,
    pubkey,
    name: displayNameFromInvite(invite.displayName, npub),
    displayName: invite.displayName,
    avatarUrl: normalizeAvatarUrl(invite.avatarUrl),
    host: invite.host,
    hostPubkey: invite.hostPubkey,
    expiresAt: invite.expiresAt,
  };
}

function displayNameFromInvite(displayName: string | null, npub: string): string {
  const normalized = normalizePlayerName(displayName ?? '');
  if (normalized !== 'Player') return normalized;
  if (npub.length > 12) return `${npub.slice(0, 8)}...${npub.slice(-4)}`;
  return npub || 'Player';
}

function normalizeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeFiniteRuleNumber(
  value: unknown,
  fallback: number,
  options: { min: number; max: number; integer?: boolean },
): number {
  const numeric = typeof value === 'string' ? Number(value.trim().replace(',', '.')) : Number(value);
  const finite = Number.isFinite(numeric) ? numeric : fallback;
  const rounded = options.integer ? Math.round(finite) : finite;
  return Math.min(options.max, Math.max(options.min, rounded));
}

function normalizeRuleBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function cloneRules(rules: GameRules): GameRules {
  return { ...rules };
}

function prependUnique(values: string[], value: string, limit: number): string[] {
  return [value, ...values.filter((candidate) => candidate !== value)].slice(0, limit);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

function cloneRoom(room: OnlineRoom | null): OnlineRoom | null {
  return room ? JSON.parse(JSON.stringify(room)) as OnlineRoom : null;
}

function normalizeRoomShape(room: OnlineRoom): OnlineRoom {
  const mode = normalizeRoomMode(room.mode);
  const matchType = normalizeMatchType(room.matchType, mode);
  const ruleset = normalizeRuleset(room.ruleset, matchType);
  return {
    ...room,
    mode,
    matchType,
    region: normalizeRegion(room.region),
    ruleset,
    rules: normalizeRoomRules(room.rules, mode, ruleset),
    winnerPlayerId: room.winnerPlayerId ?? null,
    matchResultId: room.matchResultId ?? null,
    bet: normalizeBet(room.bet),
    lunaGameId: normalizeNullableString(room.lunaGameId),
    peerSignals: room.peerSignals ?? [],
    attacks: (room.attacks ?? []).map((attack) => ({
      ...attack,
      authorityPlayerId: attack.authorityPlayerId ?? room.hostPlayerId,
    })),
    players: room.players.map((player) => ({
      ...player,
      npub: normalizeNpub(player.npub),
      avatarUrl: normalizeAvatarUrl(player.avatarUrl),
      sentGarbage: player.sentGarbage ?? 0,
      receivedGarbage: player.receivedGarbage ?? 0,
      pendingGarbage: player.pendingGarbage ?? 0,
      alive: player.alive ?? !isTerminalPlayer(player),
      eliminatedAtFrame: player.eliminatedAtFrame ?? null,
      eliminatedAtServerMs: player.eliminatedAtServerMs ?? null,
      game: player.game ?? null,
      targetingMode: normalizeTargetingMode(player.targetingMode, false, ruleset.targeting),
      manualTargetPlayerId: player.manualTargetPlayerId ?? null,
      currentTargetPlayerId: player.currentTargetPlayerId ?? null,
      recentAttackers: Array.isArray(player.recentAttackers) ? player.recentAttackers.filter((id) => typeof id === 'string').slice(0, 8) : [],
      koCount: normalizeNonNegativeInteger(player.koCount ?? 0),
      receivedGarbageThisRound: normalizeNonNegativeInteger(player.receivedGarbageThisRound ?? 0),
      dangerLevel: normalizeNonNegativeInteger(player.dangerLevel ?? 0),
    })),
  };
}
