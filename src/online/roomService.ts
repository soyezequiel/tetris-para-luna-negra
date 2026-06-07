import type {
  AttackRequest,
  CreateRoomRequest,
  EnqueueMatchmakingRequest,
  EliminateRequest,
  JoinRoomRequest,
  LeaveMatchmakingRequest,
  LunaNegraPlayer,
  MatchmakingHeartbeatRequest,
  MatchmakingQueue,
  MatchmakingTicket,
  OnlineAttack,
  OnlineMatchResult,
  OnlineMatchType,
  OnlineGameSnapshot,
  OnlinePlayer,
  OnlinePeerSignal,
  OnlineProfile,
  OnlineRoom,
  OnlineRoomMode,
  OnlineRuleset,
  OnlineRoomSummary,
  OnlineSeriesState,
  PeerSignalRequest,
  ProgressRequest,
  PublicRoomsFilters,
  QuickPlayEnterRequest,
  QuickPlayLeaderboardEntry,
  ReadyRequest,
  RestartRoomRequest,
  ResultRequest,
  RoomVisibility,
  SetTargetingRequest,
  StartRoomRequest,
  TargetingMode,
} from './protocol';
import { BATTLE_RULES } from '../game/rules.js';
import type { GameRules } from '../game/types';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;
export const ROOM_ID_MIN_LENGTH = 4;
export const ROOM_ID_MAX_LENGTH = 64;
export const ROOM_START_DELAY_MS = 5_000;
export const PLAYER_STALE_MS = 10_000;
export const ROOM_TTL_SECONDS = 2 * 60 * 60;
export const MAX_PEER_SIGNALS_PER_ROOM = 200;
export const MAX_ATTACKS_PER_ROOM = 300;
export const ONLINE_RULESET_VERSION = 1;
export const TARGETING_MODES: TargetingMode[] = ['random', 'even', 'ko', 'attackers', 'leader', 'manual'];
export const DEFAULT_ONLINE_REGION = 'gru1';
export const MATCHMAKING_TICKET_TTL_MS = 30_000;
export const MATCHMAKING_TTL_SECONDS = 60;
export const QUICK_PLAY_DEFAULT_ROOM_ID = 'QPLY';

export interface RoomStore {
  getRoom(id: string): Promise<OnlineRoom | null>;
  saveRoom(room: OnlineRoom, ttlSeconds?: number): Promise<void>;
  listPublicRoomIds(): Promise<string[]>;
  savePublicRoomIds(ids: string[], ttlSeconds?: number): Promise<void>;
  getMatchmakingTicket(id: string): Promise<MatchmakingTicket | null>;
  saveMatchmakingTicket(ticket: MatchmakingTicket, ttlSeconds?: number): Promise<void>;
  listMatchmakingTicketIds(queue: MatchmakingQueue): Promise<string[]>;
  saveMatchmakingTicketIds(queue: MatchmakingQueue, ids: string[], ttlSeconds?: number): Promise<void>;
  getProfile(playerId: string): Promise<OnlineProfile | null>;
  saveProfile(profile: OnlineProfile, ttlSeconds?: number): Promise<void>;
  getMatchResult(id: string): Promise<OnlineMatchResult | null>;
  saveMatchResult(result: OnlineMatchResult, ttlSeconds?: number): Promise<void>;
  listMatchResultIds(playerId: string): Promise<string[]>;
  saveMatchResultIds(playerId: string, ids: string[], ttlSeconds?: number): Promise<void>;
  getQuickPlayLeaderboard(weekId: string): Promise<QuickPlayLeaderboardEntry[]>;
  saveQuickPlayLeaderboard(weekId: string, entries: QuickPlayLeaderboardEntry[], ttlSeconds?: number): Promise<void>;
}

export class OnlineRoomError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export async function createRoom(
  store: RoomStore,
  request: CreateRoomRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const player = createPlayer(request.playerId, request.name, nowMs, request.avatarUrl);
  const id = request.roomId
    ? normalizeRoomIdStrict(request.roomId)
    : await generateUniqueRoomId((candidate) => store.getRoom(candidate));
  if (await store.getRoom(id)) throw new OnlineRoomError('Room already exists.', 409);
  const mode = normalizeRoomMode(request.mode);
  const matchType = normalizeMatchType(request.matchType, mode);
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
    series: null,
    matchResultId: null,
    players: [player],
    peerSignals: [],
    attacks: [],
  };
  await persistRoom(store, room);
  return room;
}

export interface VerifiedLunaNegraInvite {
  npub: string;
  pubkey: string;
  displayName: string | null;
  avatarUrl: string | null;
  roomId: string;
  host: boolean;
  hostPubkey: string | null;
  expiresAt: string | null;
}

export async function enterLunaNegraRoom(
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
    const room = await enterExistingLunaNegraRoom(store, existing, player, nowMs);
    return { room, player };
  }

  if (!invite.host) {
    throw new OnlineRoomError('La sala todavia no fue abierta por el host.', 404);
  }

  const room = await createRoom(store, {
    roomId,
    playerId: player.id,
    name: player.name,
    avatarUrl: player.avatarUrl,
    visibility: 'private',
    mode: 'battle',
    matchType: 'battle',
    rules: BATTLE_RULES,
  }, nowMs);
  return { room, player };
}

export async function joinRoom(
  store: RoomStore,
  request: JoinRoomRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await requireRoom(store, request.roomId);
  if (room.status !== 'lobby') throw new OnlineRoomError('Room already started.', 409);
  const player = createPlayer(request.playerId, request.name, nowMs, request.avatarUrl);
  const existing = room.players.find((candidate) => candidate.id === player.id);
  if (existing) {
    existing.name = player.name;
    if (request.avatarUrl !== undefined) existing.avatarUrl = player.avatarUrl;
    existing.updatedAtServerMs = nowMs;
    existing.status = existing.ready ? 'ready' : 'joined';
  } else {
    room.players.push(player);
  }
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}

export async function setPlayerReady(
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

export async function startRoom(
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
  if (room.ruleset.objective.type === 'duelRounds') room.series = createSeriesState(room, nowMs);
  prepareRoundCountdown(room, nowMs, false);
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}

export async function restartRoom(
  store: RoomStore,
  request: RestartRoomRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await requireRoom(store, request.roomId);
  if (room.hostPlayerId !== request.playerId) throw new OnlineRoomError('Only the host can restart.', 403);
  if (room.status !== 'finished') return room;
  room.series = room.ruleset.objective.type === 'duelRounds'
    ? createSeriesState(room, nowMs)
    : null;
  room.matchResultId = null;
  prepareRoundCountdown(room, nowMs, true);
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}

export async function setPlayerTargeting(
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

export async function updateProgress(
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
  if (room.matchType === 'quickPlay') await updateQuickPlayLeaderboardEntry(store, room, player.id, nowMs);
  await persistRoom(store, room);
  return room;
}

export async function submitResult(
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
  }
  if (room.status === 'finished') await persistMatchResultIfNeeded(store, room, nowMs);
  await persistRoom(store, room);
  return room;
}

export async function addAttack(
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

export async function eliminatePlayer(
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
  const lastAttackerId = player.recentAttackers[0];
  const lastAttacker = lastAttackerId ? room.players.find((candidate) => candidate.id === lastAttackerId) : null;
  if (lastAttacker && lastAttacker.id !== player.id) {
    lastAttacker.koCount = normalizeNonNegativeInteger((lastAttacker.koCount ?? 0) + 1);
  }
  if (room.matchType === 'quickPlay') {
    await updateQuickPlayLeaderboardEntry(store, room, player.id, nowMs, true);
    if (lastAttacker) await updateQuickPlayLeaderboardEntry(store, room, lastAttacker.id, nowMs);
    ensureQuickPlayHost(room);
    room.updatedAtServerMs = nowMs;
    await persistRoom(store, room);
    return room;
  }
  finishRoomIfOnlyOneAlive(room, nowMs);
  room.updatedAtServerMs = nowMs;
  if (room.status === 'finished') await persistMatchResultIfNeeded(store, room, nowMs);
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

export async function enqueueMatchmaking(
  store: RoomStore,
  request: EnqueueMatchmakingRequest,
  nowMs = Date.now(),
): Promise<{ ticket: MatchmakingTicket; room: OnlineRoom | null }> {
  const queue = normalizeMatchmakingQueue(request.queue);
  const playerId = normalizePlayerId(request.playerId);
  const name = normalizePlayerName(request.name);
  const region = normalizeRegion(request.region);
  const profile = queue === 'league' ? await loadOrCreateProfile(store, playerId, name, nowMs) : null;
  const rating = profile?.rating.value ?? null;
  await cleanupMatchmakingQueue(store, queue, nowMs);
  const queuedTickets = await loadQueuedMatchmakingTickets(store, queue, nowMs);
  const opponent = queuedTickets.find((ticket) => ticket.playerId !== playerId && ticketsAreCompatible(ticket, queue, region, rating));
  const ticket = createMatchmakingTicket(queue, playerId, name, request.avatarUrl, region, rating, nowMs);

  if (!opponent) {
    await persistMatchmakingTicket(store, ticket);
    return { ticket, room: null };
  }

  const room = await createMatchedRoom(store, opponent, ticket, nowMs);
  opponent.status = 'matched';
  opponent.roomId = room.id;
  opponent.updatedAtServerMs = nowMs;
  ticket.status = 'matched';
  ticket.roomId = room.id;
  await persistMatchmakingTicket(store, opponent);
  await persistMatchmakingTicket(store, ticket);
  return { ticket, room };
}

export async function heartbeatMatchmaking(
  store: RoomStore,
  request: MatchmakingHeartbeatRequest,
  nowMs = Date.now(),
): Promise<{ ticket: MatchmakingTicket; room: OnlineRoom | null }> {
  const ticket = await requireMatchmakingTicket(store, request.ticketId, request.playerId, nowMs);
  if (ticket.status === 'queued') {
    ticket.updatedAtServerMs = nowMs;
    ticket.expiresAtServerMs = nowMs + MATCHMAKING_TICKET_TTL_MS;
    await persistMatchmakingTicket(store, ticket);
  }
  const room = ticket.roomId ? await store.getRoom(ticket.roomId).then((value) => value ? normalizeRoomShape(value) : null) : null;
  return { ticket, room };
}

export async function leaveMatchmaking(
  store: RoomStore,
  request: LeaveMatchmakingRequest,
  nowMs = Date.now(),
): Promise<{ ticket: MatchmakingTicket; room: OnlineRoom | null }> {
  const ticket = await requireMatchmakingTicket(store, request.ticketId, request.playerId, nowMs, false);
  ticket.status = ticket.status === 'matched' ? 'matched' : 'left';
  ticket.updatedAtServerMs = nowMs;
  await persistMatchmakingTicket(store, ticket);
  const room = ticket.roomId ? await store.getRoom(ticket.roomId).then((value) => value ? normalizeRoomShape(value) : null) : null;
  return { ticket, room };
}

export async function getMatchmakingTicket(
  store: RoomStore,
  ticketId: string,
  playerId: string,
  nowMs = Date.now(),
): Promise<{ ticket: MatchmakingTicket; room: OnlineRoom | null }> {
  const ticket = await requireMatchmakingTicket(store, ticketId, playerId, nowMs, false);
  const room = ticket.roomId ? await store.getRoom(ticket.roomId).then((value) => value ? normalizeRoomShape(value) : null) : null;
  return { ticket, room };
}

export async function getOnlineProfileState(
  store: RoomStore,
  playerId: string,
  displayName = 'Player',
  nowMs = Date.now(),
): Promise<{ profile: OnlineProfile; recentResults: OnlineMatchResult[] }> {
  const normalizedPlayerId = normalizePlayerId(playerId);
  const profile = await loadOrCreateProfile(store, normalizedPlayerId, displayName, nowMs);
  profile.displayName = normalizePlayerName(displayName);
  profile.updatedAtServerMs = nowMs;
  await store.saveProfile(profile);
  const resultIds = await store.listMatchResultIds(normalizedPlayerId);
  const recentResults = (await Promise.all(resultIds.slice(0, 10).map((id) => store.getMatchResult(id))))
    .filter((result): result is OnlineMatchResult => result !== null);
  return { profile, recentResults };
}

export async function enterQuickPlay(
  store: RoomStore,
  request: QuickPlayEnterRequest,
  nowMs = Date.now(),
): Promise<{ room: OnlineRoom; leaderboard: QuickPlayLeaderboardEntry[] }> {
  const region = normalizeRegion(request.region);
  const roomId = quickPlayRoomId(region);
  const player = createPlayer(request.playerId, request.name, nowMs, request.avatarUrl);
  player.ready = true;
  player.status = 'ready';
  let room = await store.getRoom(roomId).then((value) => value ? normalizeRoomShape(value) : null);

  if (!room || room.matchType !== 'quickPlay') {
    const ruleset = defaultRuleset('quickPlay');
    room = {
      id: roomId,
      visibility: 'public',
      mode: 'battle',
      matchType: 'quickPlay',
      region,
      ruleset,
      rules: normalizeRoomRules(undefined, 'battle', ruleset),
      status: 'countdown',
      hostPlayerId: player.id,
      createdAtServerMs: nowMs,
      updatedAtServerMs: nowMs,
      startsAtServerMs: nowMs + ROOM_START_DELAY_MS,
      seed: randomSeed(),
      winnerPlayerId: null,
      series: null,
      matchResultId: null,
      players: [player],
      peerSignals: [],
      attacks: [],
    };
  } else {
    const existing = room.players.find((candidate) => candidate.id === player.id);
    if (existing) resetQuickPlayPlayer(existing, player.name, nowMs, request.avatarUrl);
    else room.players.push(player);
    if (room.status === 'finished' || room.status === 'lobby') {
      room.status = 'countdown';
      room.startsAtServerMs = nowMs + ROOM_START_DELAY_MS;
      room.seed = randomSeed();
      room.winnerPlayerId = null;
      room.matchResultId = null;
      room.attacks = [];
    }
    ensureQuickPlayHost(room);
    room.updatedAtServerMs = nowMs;
  }

  await persistRoom(store, room);
  await updateQuickPlayLeaderboardEntry(store, room, player.id, nowMs);
  return {
    room,
    leaderboard: await getQuickPlayLeaderboard(store, weeklyLeaderboardId(nowMs)),
  };
}

export async function getQuickPlayLeaderboard(
  store: RoomStore,
  weekId = weeklyLeaderboardId(Date.now()),
): Promise<QuickPlayLeaderboardEntry[]> {
  return (await store.getQuickPlayLeaderboard(weekId))
    .sort((a, b) => b.score - a.score || b.koCount - a.koCount || b.lines - a.lines || a.displayName.localeCompare(b.displayName))
    .slice(0, 20);
}

export async function getRoomState(store: RoomStore, roomId: string, nowMs = Date.now()): Promise<OnlineRoom> {
  const room = await requireRoom(store, roomId);
  if (room.status === 'countdown' && room.startsAtServerMs !== null && nowMs >= room.startsAtServerMs) {
    room.status = 'playing';
    room.updatedAtServerMs = nowMs;
    await persistRoom(store, room);
  }
  return applyStalePlayers(room, nowMs);
}

export async function addPeerSignal(
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

async function persistMatchResultIfNeeded(store: RoomStore, room: OnlineRoom, nowMs: number): Promise<void> {
  if (room.matchResultId) return;
  const ranked = room.ruleset.ranked === true;
  const rankedLeagueSeries = ranked
    && room.matchType === 'league'
    && room.series?.objective === 'duelRounds'
    && room.series.completed;
  const rankedProfiles = rankedLeagueSeries
    ? await loadProfilesForRoom(store, room, nowMs)
    : new Map<string, OnlineProfile>();
  const ratingBefore = new Map<string, number>();
  const ratingAfter = new Map<string, number>();

  if (rankedLeagueSeries && room.players.length === 2 && room.winnerPlayerId) {
    for (const player of room.players) {
      const profile = rankedProfiles.get(player.id) ?? createProfile(player.id, player.name, nowMs);
      ratingBefore.set(player.id, profile.rating.value);
    }
    applyEloResult(rankedProfiles, room.winnerPlayerId);
    for (const profile of rankedProfiles.values()) ratingAfter.set(profile.playerId, profile.rating.value);
  }

  for (const player of room.players) {
    const profile = rankedProfiles.get(player.id) ?? await loadOrCreateProfile(store, player.id, player.name, nowMs);
    updateProfileFromFinishedRoom(profile, room, player, nowMs, rankedLeagueSeries);
    await store.saveProfile(profile);
  }

  const rankedPlayers = rankPlayers(room.players);
  const result: OnlineMatchResult = {
    id: `${room.id}-${nowMs}`,
    roomId: room.id,
    matchType: room.matchType,
    rulesetId: room.ruleset.rulesetId,
    rulesetVersion: room.ruleset.rulesetVersion,
    ranked: rankedLeagueSeries,
    seed: room.seed,
    winnerPlayerId: room.winnerPlayerId,
    participants: rankedPlayers.map((player, index) => ({
      playerId: player.id,
      name: player.name,
      result: player.id === room.winnerPlayerId ? 'won' : 'lost',
      placement: index + 1,
      ratingBefore: ratingBefore.get(player.id) ?? null,
      ratingAfter: ratingAfter.get(player.id) ?? null,
      lines: normalizeNonNegativeInteger(player.lines),
      pieces: normalizeNonNegativeInteger(player.pieces),
      sentGarbage: normalizeNonNegativeInteger(player.sentGarbage),
      receivedGarbage: normalizeNonNegativeInteger(player.receivedGarbage),
      elapsedFrames: normalizeNonNegativeInteger(player.elapsedFrames),
    })),
    series: room.series ? JSON.parse(JSON.stringify(room.series)) as OnlineSeriesState : null,
    createdAtServerMs: nowMs,
  };
  await store.saveMatchResult(result);
  for (const participant of result.participants) {
    const ids = await store.listMatchResultIds(participant.playerId);
    await store.saveMatchResultIds(participant.playerId, [result.id, ...ids.filter((id) => id !== result.id)].slice(0, 50));
  }
  room.matchResultId = result.id;
}

async function loadProfilesForRoom(store: RoomStore, room: OnlineRoom, nowMs: number): Promise<Map<string, OnlineProfile>> {
  const profiles = new Map<string, OnlineProfile>();
  for (const player of room.players) {
    profiles.set(player.id, await loadOrCreateProfile(store, player.id, player.name, nowMs));
  }
  return profiles;
}

async function loadOrCreateProfile(store: RoomStore, playerId: string, displayName: string, nowMs: number): Promise<OnlineProfile> {
  return await store.getProfile(playerId) ?? createProfile(playerId, displayName, nowMs);
}

function createProfile(playerId: string, displayName: string, nowMs: number): OnlineProfile {
  return {
    playerId,
    displayName,
    createdAtServerMs: nowMs,
    updatedAtServerMs: nowMs,
    rating: {
      system: 'elo-v1',
      value: 1000,
      deviation: 350,
      gamesPlayed: 0,
    },
    casualStats: emptyModeStats(),
    leagueStats: emptyModeStats(),
    quickPlayStats: emptyModeStats(),
  };
}

function emptyModeStats() {
  return {
    played: 0,
    wins: 0,
    losses: 0,
    sentGarbage: 0,
    receivedGarbage: 0,
  };
}

function updateProfileFromFinishedRoom(
  profile: OnlineProfile,
  room: OnlineRoom,
  player: OnlinePlayer,
  nowMs: number,
  rankedLeagueSeries: boolean,
): void {
  profile.displayName = player.name;
  profile.updatedAtServerMs = nowMs;
  const stats = room.matchType === 'quickPlay'
    ? profile.quickPlayStats
    : rankedLeagueSeries ? profile.leagueStats : profile.casualStats;
  stats.played += 1;
  if (player.id === room.winnerPlayerId) stats.wins += 1;
  else stats.losses += 1;
  stats.sentGarbage += normalizeNonNegativeInteger(player.sentGarbage);
  stats.receivedGarbage += normalizeNonNegativeInteger(player.receivedGarbage);
}

function applyEloResult(profiles: Map<string, OnlineProfile>, winnerPlayerId: string): void {
  const players = [...profiles.values()];
  if (players.length !== 2) return;
  const [first, second] = players;
  const firstScore = first.playerId === winnerPlayerId ? 1 : 0;
  const secondScore = second.playerId === winnerPlayerId ? 1 : 0;
  const firstRating = first.rating.value;
  const secondRating = second.rating.value;
  updateEloRating(first, secondRating, firstScore);
  updateEloRating(second, firstRating, secondScore);
}

function updateEloRating(profile: OnlineProfile, opponentRating: number, score: number): void {
  const expected = 1 / (1 + (10 ** ((opponentRating - profile.rating.value) / 400)));
  const next = profile.rating.value + 32 * (score - expected);
  profile.rating.value = Math.round(next);
  profile.rating.gamesPlayed += 1;
  profile.rating.deviation = Math.max(80, Math.round(profile.rating.deviation * 0.95));
}

async function updateQuickPlayLeaderboardEntry(
  store: RoomStore,
  room: OnlineRoom,
  playerId: string,
  nowMs: number,
  countFinishedRun = false,
): Promise<void> {
  const player = room.players.find((candidate) => candidate.id === playerId);
  if (!player) return;
  const weekId = weeklyLeaderboardId(nowMs);
  const entries = await store.getQuickPlayLeaderboard(weekId);
  const previous = entries.find((entry) => entry.playerId === player.id);
  const next: QuickPlayLeaderboardEntry = {
    playerId: player.id,
    displayName: player.name,
    weekId,
    score: quickPlayScore(player),
    lines: Math.max(previous?.lines ?? 0, normalizeNonNegativeInteger(player.lines)),
    koCount: Math.max(previous?.koCount ?? 0, normalizeNonNegativeInteger(player.koCount)),
    survivalFrames: Math.max(previous?.survivalFrames ?? 0, normalizeNonNegativeInteger(player.elapsedFrames)),
    sentGarbage: Math.max(previous?.sentGarbage ?? 0, normalizeNonNegativeInteger(player.sentGarbage)),
    receivedGarbage: Math.max(previous?.receivedGarbage ?? 0, normalizeNonNegativeInteger(player.receivedGarbage)),
    updatedAtServerMs: nowMs,
  };
  next.score = Math.max(previous?.score ?? 0, next.score);
  await store.saveQuickPlayLeaderboard(
    weekId,
    [next, ...entries.filter((entry) => entry.playerId !== player.id)]
      .sort((a, b) => b.score - a.score || b.koCount - a.koCount || b.lines - a.lines)
      .slice(0, 50),
  );

  if (countFinishedRun) {
    const profile = await loadOrCreateProfile(store, player.id, player.name, nowMs);
    profile.displayName = player.name;
    profile.updatedAtServerMs = nowMs;
    profile.quickPlayStats.played += 1;
    profile.quickPlayStats.losses += player.status === 'eliminated' ? 1 : 0;
    profile.quickPlayStats.wins += player.status === 'winner' ? 1 : 0;
    profile.quickPlayStats.sentGarbage += normalizeNonNegativeInteger(player.sentGarbage);
    profile.quickPlayStats.receivedGarbage += normalizeNonNegativeInteger(player.receivedGarbage);
    await store.saveProfile(profile);
  }
}

function quickPlayScore(player: OnlinePlayer): number {
  return normalizeNonNegativeInteger(player.lines) * 10
    + normalizeNonNegativeInteger(player.koCount) * 250
    + Math.floor(normalizeNonNegativeInteger(player.elapsedFrames) / 60)
    + normalizeNonNegativeInteger(player.sentGarbage) * 3;
}

function resetQuickPlayPlayer(player: OnlinePlayer, name: string, nowMs: number, avatarUrl?: string | null): void {
  player.name = normalizePlayerName(name);
  if (avatarUrl !== undefined) player.avatarUrl = normalizeAvatarUrl(avatarUrl);
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
}

function ensureQuickPlayHost(room: OnlineRoom): void {
  const host = room.players.find((player) => player.id === room.hostPlayerId);
  if (host && host.alive && host.status !== 'eliminated' && host.status !== 'disconnected') return;
  const replacement = room.players.find((player) => player.alive && player.status !== 'eliminated' && player.status !== 'disconnected');
  if (replacement) room.hostPlayerId = replacement.id;
}

function quickPlayRoomId(region: string): string {
  if (region === DEFAULT_ONLINE_REGION) return QUICK_PLAY_DEFAULT_ROOM_ID;
  let hash = 0;
  for (const char of region) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  return `QP${ROOM_CODE_ALPHABET[hash % ROOM_CODE_ALPHABET.length]}${ROOM_CODE_ALPHABET[(hash >>> 5) % ROOM_CODE_ALPHABET.length]}`;
}

function weeklyLeaderboardId(nowMs: number): string {
  const date = new Date(nowMs);
  const utcDate = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const day = new Date(utcDate).getUTCDay() || 7;
  const monday = utcDate - (day - 1) * 86_400_000;
  return new Date(monday).toISOString().slice(0, 10);
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
    existing.updatedAtServerMs = nowMs;
    if (room.status === 'lobby') existing.status = existing.ready ? 'ready' : 'joined';
    room.updatedAtServerMs = nowMs;
    return persistRoom(store, room).then(() => room);
  }
  if (room.status !== 'lobby') throw new OnlineRoomError('Room already started.', 409);
  room.players.push(createPlayer(lunaPlayer.id, lunaPlayer.name, nowMs, lunaPlayer.avatarUrl));
  room.updatedAtServerMs = nowMs;
  return persistRoom(store, room).then(() => room);
}

export class MemoryRoomStore implements RoomStore {
  private rooms = new Map<string, OnlineRoom>();
  private publicIds: string[] = [];
  private matchmakingTickets = new Map<string, MatchmakingTicket>();
  private matchmakingIds = new Map<MatchmakingQueue, string[]>();
  private profiles = new Map<string, OnlineProfile>();
  private matchResults = new Map<string, OnlineMatchResult>();
  private matchResultIds = new Map<string, string[]>();
  private quickPlayLeaderboards = new Map<string, QuickPlayLeaderboardEntry[]>();

  async getRoom(id: string): Promise<OnlineRoom | null> {
    return cloneRoom(this.rooms.get(normalizeRoomId(id)) ?? null);
  }

  async saveRoom(room: OnlineRoom): Promise<void> {
    const normalized = cloneRoom(room);
    if (!normalized) return;
    this.rooms.set(normalized.id, normalized);
    if (normalized.visibility === 'public' && !this.publicIds.includes(normalized.id)) {
      this.publicIds = [normalized.id, ...this.publicIds];
    }
  }

  async listPublicRoomIds(): Promise<string[]> {
    return [...this.publicIds];
  }

  async savePublicRoomIds(ids: string[]): Promise<void> {
    this.publicIds = [...new Set(ids.map(normalizeRoomId))];
  }

  async getMatchmakingTicket(id: string): Promise<MatchmakingTicket | null> {
    return cloneMatchmakingTicket(this.matchmakingTickets.get(id) ?? null);
  }

  async saveMatchmakingTicket(ticket: MatchmakingTicket): Promise<void> {
    const normalized = cloneMatchmakingTicket(ticket);
    if (!normalized) return;
    this.matchmakingTickets.set(normalized.id, normalized);
    if (normalized.status === 'queued') {
      const ids = this.matchmakingIds.get(normalized.queue) ?? [];
      if (!ids.includes(normalized.id)) this.matchmakingIds.set(normalized.queue, [normalized.id, ...ids]);
    }
  }

  async listMatchmakingTicketIds(queue: MatchmakingQueue): Promise<string[]> {
    return [...(this.matchmakingIds.get(queue) ?? [])];
  }

  async saveMatchmakingTicketIds(queue: MatchmakingQueue, ids: string[]): Promise<void> {
    this.matchmakingIds.set(queue, [...new Set(ids)]);
  }

  async getProfile(playerId: string): Promise<OnlineProfile | null> {
    return cloneProfile(this.profiles.get(playerId) ?? null);
  }

  async saveProfile(profile: OnlineProfile): Promise<void> {
    const normalized = cloneProfile(profile);
    if (normalized) this.profiles.set(normalized.playerId, normalized);
  }

  async getMatchResult(id: string): Promise<OnlineMatchResult | null> {
    return cloneMatchResult(this.matchResults.get(id) ?? null);
  }

  async saveMatchResult(result: OnlineMatchResult): Promise<void> {
    const normalized = cloneMatchResult(result);
    if (normalized) this.matchResults.set(normalized.id, normalized);
  }

  async listMatchResultIds(playerId: string): Promise<string[]> {
    return [...(this.matchResultIds.get(playerId) ?? [])];
  }

  async saveMatchResultIds(playerId: string, ids: string[]): Promise<void> {
    this.matchResultIds.set(playerId, [...new Set(ids)]);
  }

  async getQuickPlayLeaderboard(weekId: string): Promise<QuickPlayLeaderboardEntry[]> {
    return cloneQuickPlayLeaderboard(this.quickPlayLeaderboards.get(weekId) ?? []);
  }

  async saveQuickPlayLeaderboard(weekId: string, entries: QuickPlayLeaderboardEntry[]): Promise<void> {
    this.quickPlayLeaderboards.set(weekId, cloneQuickPlayLeaderboard(entries));
  }
}

async function persistRoom(store: RoomStore, room: OnlineRoom): Promise<void> {
  await store.saveRoom(room, ROOM_TTL_SECONDS);
  if (room.visibility === 'public') {
    const publicIds = await store.listPublicRoomIds();
    await store.savePublicRoomIds([room.id, ...publicIds.filter((id) => id !== room.id)], ROOM_TTL_SECONDS);
  }
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
  return seed === undefined || normalizeNonNegativeInteger(seed) === room.seed;
}

function createPlayer(id: string, name: string, nowMs: number, avatarUrl?: string | null): OnlinePlayer {
  const normalizedId = normalizePlayerId(id);
  const normalizedName = normalizePlayerName(name);
  return {
    id: normalizedId,
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
    ranked: room.ruleset.ranked,
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
  if (room.ruleset.objective.type === 'duelRounds') {
    finishDuelRound(room, alive[0], nowMs);
    return;
  }
  const winner = alive[0];
  winner.status = 'winner';
  winner.alive = true;
  winner.finishedAtServerMs = nowMs;
  winner.updatedAtServerMs = nowMs;
  room.winnerPlayerId = winner.id;
  room.status = 'finished';
}

function finishDuelRound(room: OnlineRoom, winner: OnlinePlayer, nowMs: number): void {
  const series = room.series?.objective === 'duelRounds'
    ? room.series
    : createSeriesState(room, nowMs);
  const score = series.scores.find((candidate) => candidate.playerId === winner.id);
  if (score) score.wins += 1;
  else series.scores.push({ playerId: winner.id, wins: 1 });
  series.rounds.push({
    round: series.currentRound,
    roundId: series.roundId,
    winnerPlayerId: winner.id,
    finishedAtServerMs: nowMs,
  });

  if ((score?.wins ?? 1) >= series.firstTo) {
    series.completed = true;
    series.winnerPlayerId = winner.id;
    winner.status = 'winner';
    winner.alive = true;
    winner.finishedAtServerMs = nowMs;
    winner.updatedAtServerMs = nowMs;
    room.series = series;
    room.winnerPlayerId = winner.id;
    room.status = 'finished';
    return;
  }

  series.currentRound += 1;
  series.roundId = createRoundId(room.id, series.currentRound, nowMs);
  series.completed = false;
  series.winnerPlayerId = null;
  room.series = series;
  prepareRoundCountdown(room, nowMs, true);
}

function finishSprintRace(room: OnlineRoom, winner: OnlinePlayer, nowMs: number): void {
  room.status = 'finished';
  room.winnerPlayerId = winner.id;
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

function createSeriesState(room: OnlineRoom, nowMs: number): OnlineSeriesState {
  const firstTo = room.ruleset.objective.type === 'duelRounds' ? room.ruleset.objective.firstTo : 1;
  return {
    objective: 'duelRounds',
    firstTo,
    currentRound: 1,
    roundId: createRoundId(room.id, 1, nowMs),
    scores: room.players.map((player) => ({ playerId: player.id, wins: 0 })),
    rounds: [],
    completed: false,
    winnerPlayerId: null,
  };
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

function createRoundId(roomId: string, round: number, nowMs: number): string {
  return `${roomId}-r${round}-${nowMs}`;
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

function normalizeRoomMode(value: unknown): OnlineRoomMode {
  return value === 'custom' ? 'custom' : 'battle';
}

function normalizeMatchType(value: unknown, mode: OnlineRoomMode): OnlineMatchType {
  if (
    value === 'battle'
    || value === 'duel'
    || value === 'league'
    || value === 'royale'
    || value === 'quickPlay'
    || value === 'custom'
    || value === 'sprintRace'
  ) {
    return value;
  }
  return mode === 'custom' ? 'custom' : 'battle';
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
  const ranked = typeof value.ranked === 'boolean' ? value.ranked : fallback.ranked;
  return { rulesetId, rulesetVersion, objective, attackTable, targeting, ranked };
}

function defaultRuleset(matchType: OnlineMatchType): OnlineRuleset {
  if (matchType === 'duel') {
    return {
      rulesetId: 'duel-ft3-simple',
      rulesetVersion: ONLINE_RULESET_VERSION,
      objective: { type: 'duelRounds', firstTo: 3 },
      attackTable: 'simple',
      targeting: 'random',
      ranked: false,
    };
  }
  if (matchType === 'league') {
    return {
      rulesetId: 'league-ft3-simple',
      rulesetVersion: ONLINE_RULESET_VERSION,
      objective: { type: 'duelRounds', firstTo: 3 },
      attackTable: 'simple',
      targeting: 'random',
      ranked: true,
    };
  }
  if (matchType === 'quickPlay') {
    return {
      rulesetId: 'quick-play-climb-simple',
      rulesetVersion: ONLINE_RULESET_VERSION,
      objective: { type: 'quickPlayClimb', floorSystem: 'weekly' },
      attackTable: 'simple',
      targeting: 'even',
      ranked: false,
    };
  }
  if (matchType === 'sprintRace') {
    return {
      rulesetId: 'sprint-40l-simple',
      rulesetVersion: ONLINE_RULESET_VERSION,
      objective: { type: 'sprint', targetLines: 40 },
      attackTable: 'simple',
      targeting: 'random',
      ranked: false,
    };
  }
  return {
    rulesetId: matchType === 'custom' ? 'custom-survival-simple' : 'battle-survival-simple',
    rulesetVersion: ONLINE_RULESET_VERSION,
    objective: { type: 'lastStanding' },
    attackTable: 'simple',
    targeting: 'random',
    ranked: false,
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
    if (value.type === 'duelRounds') {
      return { type: 'duelRounds', firstTo: normalizeObjectiveInteger(value.firstTo, 1, 15, fallback.type === 'duelRounds' ? fallback.firstTo : 3, strict) };
    }
    if (value.type === 'sprint') {
      return { type: 'sprint', targetLines: normalizeObjectiveInteger(value.targetLines, 1, 200, fallback.type === 'sprint' ? fallback.targetLines : 40, strict) };
    }
    if (value.type === 'survivalScore') {
      const duration = value.durationSeconds === null
        ? null
        : normalizeObjectiveInteger(value.durationSeconds, 10, 3600, fallback.type === 'survivalScore' ? fallback.durationSeconds ?? 120 : 120, strict);
      return { type: 'survivalScore', durationSeconds: duration };
    }
    if (value.type === 'quickPlayClimb') {
      const floorSystem = typeof value.floorSystem === 'string' && value.floorSystem.trim().length > 0
        ? value.floorSystem.trim().slice(0, 32)
        : fallback.type === 'quickPlayClimb' ? fallback.floorSystem : 'weekly';
      return { type: 'quickPlayClimb', floorSystem };
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

function normalizeMatchmakingQueue(value: unknown): MatchmakingQueue {
  if (value === undefined || value === null || value === 'quickDuel') return 'quickDuel';
  if (value === 'league') return 'league';
  throw new OnlineRoomError('Invalid matchmaking queue.');
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
  if (typeof filters.ranked === 'boolean' && room.ruleset.ranked !== filters.ranked) return false;
  if (filters.customPreset && room.ruleset.rulesetId !== filters.customPreset) return false;
  const minPlayers = normalizeOptionalInteger(filters.minPlayers, 1, 99);
  const maxPlayers = normalizeOptionalInteger(filters.maxPlayers, 1, 99);
  if (minPlayers !== undefined && room.players.length < minPlayers) return false;
  if (maxPlayers !== undefined && room.players.length > maxPlayers) return false;
  return true;
}

function createMatchmakingTicket(
  queue: MatchmakingQueue,
  playerId: string,
  name: string,
  avatarUrl: string | null | undefined,
  region: string,
  rating: number | null,
  nowMs: number,
): MatchmakingTicket {
  return {
    id: `${queue}-${nowMs}-${Math.random().toString(36).slice(2, 10)}`,
    queue,
    playerId,
    name,
    avatarUrl: normalizeAvatarUrl(avatarUrl),
    region,
    rating,
    status: 'queued',
    roomId: null,
    createdAtServerMs: nowMs,
    updatedAtServerMs: nowMs,
    expiresAtServerMs: nowMs + MATCHMAKING_TICKET_TTL_MS,
  };
}

function ticketsAreCompatible(ticket: MatchmakingTicket, queue: MatchmakingQueue, region: string, rating: number | null): boolean {
  if (ticket.region !== region) return false;
  if (queue !== 'league') return true;
  if (ticket.rating === null || rating === null) return true;
  return Math.abs(ticket.rating - rating) <= 400;
}

async function createMatchedRoom(
  store: RoomStore,
  first: MatchmakingTicket,
  second: MatchmakingTicket,
  nowMs: number,
): Promise<OnlineRoom> {
  const matchType: OnlineMatchType = first.queue === 'league' ? 'league' : 'duel';
  let room = await createRoom(store, {
    playerId: first.playerId,
    name: first.name,
    avatarUrl: first.avatarUrl,
    visibility: 'private',
    mode: 'battle',
    matchType,
    region: first.region,
  }, nowMs);
  room = await joinRoom(store, { roomId: room.id, playerId: second.playerId, name: second.name, avatarUrl: second.avatarUrl }, nowMs);
  room = await setPlayerReady(store, { roomId: room.id, playerId: first.playerId, ready: true }, nowMs);
  room = await setPlayerReady(store, { roomId: room.id, playerId: second.playerId, ready: true }, nowMs);
  return startRoom(store, { roomId: room.id, playerId: first.playerId }, nowMs);
}

async function loadQueuedMatchmakingTickets(
  store: RoomStore,
  queue: MatchmakingQueue,
  nowMs: number,
): Promise<MatchmakingTicket[]> {
  const ids = await store.listMatchmakingTicketIds(queue);
  const tickets = await Promise.all(ids.map((id) => store.getMatchmakingTicket(id)));
  return tickets
    .filter((ticket): ticket is MatchmakingTicket => ticket !== null)
    .map((ticket) => normalizeMatchmakingTicket(ticket, nowMs))
    .filter((ticket) => ticket.status === 'queued' && ticket.expiresAtServerMs > nowMs)
    .sort((a, b) => a.createdAtServerMs - b.createdAtServerMs);
}

async function cleanupMatchmakingQueue(store: RoomStore, queue: MatchmakingQueue, nowMs: number): Promise<void> {
  const ids = await store.listMatchmakingTicketIds(queue);
  const kept: string[] = [];
  for (const id of ids) {
    const ticket = await store.getMatchmakingTicket(id);
    if (!ticket) continue;
    const normalized = normalizeMatchmakingTicket(ticket, nowMs);
    if (normalized.status === 'queued' && normalized.expiresAtServerMs <= nowMs) {
      normalized.status = 'expired';
      normalized.updatedAtServerMs = nowMs;
      await store.saveMatchmakingTicket(normalized, MATCHMAKING_TTL_SECONDS);
      continue;
    }
    if (normalized.status === 'queued') kept.push(normalized.id);
  }
  await store.saveMatchmakingTicketIds(queue, kept, MATCHMAKING_TTL_SECONDS);
}

async function persistMatchmakingTicket(store: RoomStore, ticket: MatchmakingTicket): Promise<void> {
  await store.saveMatchmakingTicket(ticket, MATCHMAKING_TTL_SECONDS);
  if (ticket.status !== 'queued') return;
  const ids = await store.listMatchmakingTicketIds(ticket.queue);
  await store.saveMatchmakingTicketIds(ticket.queue, [ticket.id, ...ids.filter((id) => id !== ticket.id)], MATCHMAKING_TTL_SECONDS);
}

async function requireMatchmakingTicket(
  store: RoomStore,
  ticketId: string,
  playerId: string,
  nowMs: number,
  expireQueued = true,
): Promise<MatchmakingTicket> {
  const ticket = await store.getMatchmakingTicket(ticketId);
  if (!ticket) throw new OnlineRoomError('Matchmaking ticket not found.', 404);
  const normalized = normalizeMatchmakingTicket(ticket, nowMs);
  if (normalized.playerId !== playerId) throw new OnlineRoomError('Ticket belongs to another player.', 403);
  if (expireQueued && normalized.status === 'queued' && normalized.expiresAtServerMs <= nowMs) {
    normalized.status = 'expired';
    normalized.updatedAtServerMs = nowMs;
    await store.saveMatchmakingTicket(normalized, MATCHMAKING_TTL_SECONDS);
  }
  return normalized;
}

function normalizeMatchmakingTicket(ticket: MatchmakingTicket, nowMs: number): MatchmakingTicket {
  const status = ticket.status === 'matched' || ticket.status === 'left' || ticket.status === 'expired'
    ? ticket.status
    : ticket.expiresAtServerMs <= nowMs ? 'expired' : 'queued';
  return {
    ...ticket,
    queue: ticket.queue === 'league' ? 'league' : 'quickDuel',
    playerId: normalizePlayerId(ticket.playerId),
    name: normalizePlayerName(ticket.name),
    avatarUrl: normalizeAvatarUrl(ticket.avatarUrl),
    region: normalizeRegion(ticket.region),
    rating: typeof ticket.rating === 'number' && Number.isFinite(ticket.rating) ? Math.round(ticket.rating) : null,
    status,
    roomId: typeof ticket.roomId === 'string' ? normalizeRoomId(ticket.roomId) : null,
    createdAtServerMs: normalizeNonNegativeInteger(ticket.createdAtServerMs),
    updatedAtServerMs: normalizeNonNegativeInteger(ticket.updatedAtServerMs),
    expiresAtServerMs: normalizeNonNegativeInteger(ticket.expiresAtServerMs),
  };
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

function normalizeSeriesState(value: unknown, room: OnlineRoom, ruleset: OnlineRuleset): OnlineSeriesState | null {
  if (ruleset.objective.type !== 'duelRounds') return null;
  if (!isObject(value)) {
    if (room.status === 'lobby') return null;
    return createSeriesState({ ...room, ruleset }, room.createdAtServerMs);
  }
  const firstTo = normalizeObjectiveInteger(value.firstTo, 1, 15, ruleset.objective.firstTo, false);
  const currentRound = normalizeObjectiveInteger(value.currentRound, 1, 99, 1, false);
  const roundId = typeof value.roundId === 'string' && value.roundId.length > 0
    ? value.roundId.slice(0, 80)
    : createRoundId(room.id, currentRound, room.createdAtServerMs);
  const scores = Array.isArray(value.scores)
    ? value.scores
      .filter((score): score is Record<string, unknown> => isObject(score) && typeof score.playerId === 'string')
      .map((score) => ({
        playerId: String(score.playerId),
        wins: normalizeNonNegativeInteger(Number(score.wins ?? 0)),
      }))
    : [];
  const scoreIds = new Set(scores.map((score) => score.playerId));
  for (const player of room.players) {
    if (!scoreIds.has(player.id)) scores.push({ playerId: player.id, wins: 0 });
  }
  const rounds = Array.isArray(value.rounds)
    ? value.rounds
      .filter((round): round is Record<string, unknown> => isObject(round) && typeof round.winnerPlayerId === 'string')
      .map((round) => ({
        round: normalizeObjectiveInteger(round.round, 1, 99, 1, false),
        roundId: typeof round.roundId === 'string' && round.roundId.length > 0 ? round.roundId.slice(0, 80) : roundId,
        winnerPlayerId: String(round.winnerPlayerId),
        finishedAtServerMs: normalizeNonNegativeInteger(Number(round.finishedAtServerMs ?? room.updatedAtServerMs)),
      }))
    : [];
  const completed = value.completed === true;
  const winnerPlayerId = typeof value.winnerPlayerId === 'string' ? value.winnerPlayerId : null;
  return {
    objective: 'duelRounds',
    firstTo,
    currentRound,
    roundId,
    scores,
    rounds,
    completed,
    winnerPlayerId,
  };
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

function cloneMatchmakingTicket(ticket: MatchmakingTicket | null): MatchmakingTicket | null {
  return ticket ? JSON.parse(JSON.stringify(ticket)) as MatchmakingTicket : null;
}

function cloneProfile(profile: OnlineProfile | null): OnlineProfile | null {
  return profile ? JSON.parse(JSON.stringify(profile)) as OnlineProfile : null;
}

function cloneMatchResult(result: OnlineMatchResult | null): OnlineMatchResult | null {
  return result ? JSON.parse(JSON.stringify(result)) as OnlineMatchResult : null;
}

function cloneQuickPlayLeaderboard(entries: QuickPlayLeaderboardEntry[]): QuickPlayLeaderboardEntry[] {
  return JSON.parse(JSON.stringify(entries)) as QuickPlayLeaderboardEntry[];
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
    series: normalizeSeriesState(room.series, room, ruleset),
    matchResultId: room.matchResultId ?? null,
    peerSignals: room.peerSignals ?? [],
    attacks: (room.attacks ?? []).map((attack) => ({
      ...attack,
      authorityPlayerId: attack.authorityPlayerId ?? room.hostPlayerId,
    })),
    players: room.players.map((player) => ({
      ...player,
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
