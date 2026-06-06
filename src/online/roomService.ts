import type {
  AttackRequest,
  CreateRoomRequest,
  EliminateRequest,
  JoinRoomRequest,
  OnlineAttack,
  OnlinePlayer,
  OnlinePeerSignal,
  OnlineRoom,
  OnlineRoomSummary,
  PeerSignalRequest,
  ProgressRequest,
  ReadyRequest,
  ResultRequest,
  RoomVisibility,
  StartRoomRequest,
} from './protocol';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;
export const ROOM_START_DELAY_MS = 5_000;
export const PLAYER_STALE_MS = 10_000;
export const ROOM_TTL_SECONDS = 2 * 60 * 60;
export const MAX_PEER_SIGNALS_PER_ROOM = 200;
export const MAX_ATTACKS_PER_ROOM = 300;

export interface RoomStore {
  getRoom(id: string): Promise<OnlineRoom | null>;
  saveRoom(room: OnlineRoom, ttlSeconds?: number): Promise<void>;
  listPublicRoomIds(): Promise<string[]>;
  savePublicRoomIds(ids: string[], ttlSeconds?: number): Promise<void>;
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
  const player = createPlayer(request.playerId, request.name, nowMs);
  const id = await generateUniqueRoomId((candidate) => store.getRoom(candidate));
  const room: OnlineRoom = {
    id,
    visibility: normalizeVisibility(request.visibility),
    status: 'lobby',
    hostPlayerId: player.id,
    createdAtServerMs: nowMs,
    updatedAtServerMs: nowMs,
    startsAtServerMs: null,
    seed: randomSeed(),
    winnerPlayerId: null,
    players: [player],
    peerSignals: [],
    attacks: [],
  };
  await persistRoom(store, room);
  return room;
}

export async function joinRoom(
  store: RoomStore,
  request: JoinRoomRequest,
  nowMs = Date.now(),
): Promise<OnlineRoom> {
  const room = await requireRoom(store, request.roomId);
  if (room.status !== 'lobby') throw new OnlineRoomError('Room already started.', 409);
  const player = createPlayer(request.playerId, request.name, nowMs);
  const existing = room.players.find((candidate) => candidate.id === player.id);
  if (existing) {
    existing.name = player.name;
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
  room.status = 'countdown';
  room.startsAtServerMs = nowMs + ROOM_START_DELAY_MS;
  room.winnerPlayerId = null;
  room.players.forEach((player) => {
    player.alive = true;
    player.eliminatedAtFrame = null;
    player.eliminatedAtServerMs = null;
    player.finishedAtServerMs = null;
  });
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
  player.updatedAtServerMs = nowMs;
  room.updatedAtServerMs = nowMs;
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
  player.updatedAtServerMs = nowMs;
  player.finishedAtServerMs = nowMs;
  room.updatedAtServerMs = nowMs;
  if (room.players.every((candidate) => candidate.status === 'won' || candidate.status === 'lost')) {
    room.status = 'finished';
    room.winnerPlayerId = room.players.find((candidate) => candidate.status === 'won')?.id ?? null;
  }
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
    lines: normalizeNonNegativeInteger(request.lines),
    holeSeed: normalizeNonNegativeInteger(request.holeSeed),
    frame: normalizeNonNegativeInteger(request.frame),
    createdAtServerMs: nowMs,
  };
  if (attack.lines <= 0) return room;
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
  player.updatedAtServerMs = nowMs;
  finishRoomIfOnlyOneAlive(room, nowMs);
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}

export async function listPublicRooms(store: RoomStore, nowMs = Date.now()): Promise<OnlineRoomSummary[]> {
  const ids = await store.listPublicRoomIds();
  const rooms = await Promise.all(ids.map(async (id) => {
    const room = await store.getRoom(id);
    return room ? normalizeRoomShape(room) : null;
  }));
  const visible = rooms
    .filter((room): room is OnlineRoom => room !== null && room.visibility === 'public')
    .map((room) => applyStalePlayers(room, nowMs))
    .filter((room) => room.status === 'lobby' || room.status === 'countdown');
  return visible
    .map(roomSummary)
    .sort((a, b) => b.createdAtServerMs - a.createdAtServerMs);
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

export class MemoryRoomStore implements RoomStore {
  private rooms = new Map<string, OnlineRoom>();
  private publicIds: string[] = [];

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

function createPlayer(id: string, name: string, nowMs: number): OnlinePlayer {
  const normalizedId = normalizePlayerId(id);
  const normalizedName = normalizePlayerName(name);
  return {
    id: normalizedId,
    name: normalizedName,
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
  };
}

function roomSummary(room: OnlineRoom): OnlineRoomSummary {
  const host = room.players.find((player) => player.id === room.hostPlayerId);
  return {
    id: room.id,
    hostName: host?.name ?? 'Host',
    playerCount: room.players.length,
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

export function normalizeRoomId(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
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

function normalizeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

function cloneRoom(room: OnlineRoom | null): OnlineRoom | null {
  return room ? JSON.parse(JSON.stringify(room)) as OnlineRoom : null;
}

function normalizeRoomShape(room: OnlineRoom): OnlineRoom {
  return {
    ...room,
    winnerPlayerId: room.winnerPlayerId ?? null,
    peerSignals: room.peerSignals ?? [],
    attacks: (room.attacks ?? []).map((attack) => ({
      ...attack,
      authorityPlayerId: attack.authorityPlayerId ?? room.hostPlayerId,
    })),
    players: room.players.map((player) => ({
      ...player,
      sentGarbage: player.sentGarbage ?? 0,
      receivedGarbage: player.receivedGarbage ?? 0,
      pendingGarbage: player.pendingGarbage ?? 0,
      alive: player.alive ?? !isTerminalPlayer(player),
      eliminatedAtFrame: player.eliminatedAtFrame ?? null,
      eliminatedAtServerMs: player.eliminatedAtServerMs ?? null,
      game: player.game ?? null,
    })),
  };
}
