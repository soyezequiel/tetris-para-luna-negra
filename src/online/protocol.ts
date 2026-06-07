import type { ActivePiece, AttackTableId, Cell, GameEngineSnapshot, GameRules } from '../game/types';

export type RoomVisibility = 'public' | 'private';
export type OnlineRoomMode = 'battle' | 'custom';
export type OnlineMatchType = 'battle' | 'duel' | 'league' | 'royale' | 'quickPlay' | 'custom' | 'sprintRace';
export type OnlineRoomStatus = 'lobby' | 'countdown' | 'playing' | 'finished';
export type OnlinePlayerStatus = 'joined' | 'ready' | 'playing' | 'eliminated' | 'winner' | 'won' | 'lost' | 'disconnected';
export type OnlineAttackTable = AttackTableId;
export type TargetingMode = 'random' | 'even' | 'ko' | 'attackers' | 'leader' | 'manual';

export type OnlineObjective =
  | { type: 'lastStanding' }
  | { type: 'duelRounds'; firstTo: number }
  | { type: 'sprint'; targetLines: number }
  | { type: 'survivalScore'; durationSeconds: number | null }
  | { type: 'quickPlayClimb'; floorSystem: string };

export interface OnlineRuleset {
  rulesetId: string;
  rulesetVersion: number;
  objective: OnlineObjective;
  attackTable: OnlineAttackTable;
  targeting: TargetingMode;
  ranked: boolean;
}

export interface OnlineSeriesScore {
  playerId: string;
  wins: number;
}

export interface OnlineRoundRecord {
  round: number;
  roundId: string;
  winnerPlayerId: string;
  finishedAtServerMs: number;
}

export interface OnlineSeriesState {
  objective: 'duelRounds';
  firstTo: number;
  currentRound: number;
  roundId: string;
  scores: OnlineSeriesScore[];
  rounds: OnlineRoundRecord[];
  completed: boolean;
  winnerPlayerId: string | null;
}

export interface OnlineRating {
  system: 'elo-v1';
  value: number;
  deviation: number;
  gamesPlayed: number;
}

export interface OnlineModeStats {
  played: number;
  wins: number;
  losses: number;
  sentGarbage: number;
  receivedGarbage: number;
}

export interface OnlineProfile {
  playerId: string;
  displayName: string;
  createdAtServerMs: number;
  updatedAtServerMs: number;
  rating: OnlineRating;
  casualStats: OnlineModeStats;
  leagueStats: OnlineModeStats;
  quickPlayStats: OnlineModeStats;
}

export interface OnlineMatchParticipantResult {
  playerId: string;
  name: string;
  result: 'won' | 'lost';
  placement: number;
  ratingBefore: number | null;
  ratingAfter: number | null;
  lines: number;
  pieces: number;
  sentGarbage: number;
  receivedGarbage: number;
  elapsedFrames: number;
}

export interface OnlineMatchResult {
  id: string;
  roomId: string;
  matchType: OnlineMatchType;
  rulesetId: string;
  rulesetVersion: number;
  ranked: boolean;
  seed: number;
  winnerPlayerId: string | null;
  participants: OnlineMatchParticipantResult[];
  series: OnlineSeriesState | null;
  createdAtServerMs: number;
}

export interface OnlineGameSnapshot {
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
  lines: number;
  holeSeed: number;
  frame: number;
  createdAtServerMs: number;
}

export interface OnlinePlayer {
  id: string;
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
  series: OnlineSeriesState | null;
  matchResultId: string | null;
  players: OnlinePlayer[];
  peerSignals: OnlinePeerSignal[];
  attacks: OnlineAttack[];
}

export interface OnlineRoomSummary {
  id: string;
  hostName: string;
  hostAvatarUrl: string | null;
  playerCount: number;
  mode: OnlineRoomMode;
  matchType: OnlineMatchType;
  region: string;
  ranked: boolean;
  customPreset: string | null;
  ruleset: OnlineRuleset;
  status: OnlineRoomStatus;
  createdAtServerMs: number;
}

export interface PublicRoomsFilters {
  matchType?: OnlineMatchType;
  status?: OnlineRoomStatus;
  region?: string;
  ranked?: boolean;
  customPreset?: string;
  minPlayers?: number;
  maxPlayers?: number;
}

export interface CreateRoomRequest {
  roomId?: string;
  playerId: string;
  name: string;
  avatarUrl?: string | null;
  visibility: RoomVisibility;
  mode?: OnlineRoomMode;
  matchType?: OnlineMatchType;
  region?: string;
  ruleset?: Partial<OnlineRuleset>;
  rules?: GameRules;
}

export interface JoinRoomRequest {
  roomId: string;
  playerId: string;
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

export interface PublicRoomsResponse {
  rooms: OnlineRoomSummary[];
  serverNowMs: number;
}

export type MatchmakingQueue = 'quickDuel' | 'league';

export type MatchmakingTicketStatus = 'queued' | 'matched' | 'left' | 'expired';

export interface MatchmakingTicket {
  id: string;
  queue: MatchmakingQueue;
  playerId: string;
  name: string;
  avatarUrl: string | null;
  region: string;
  rating: number | null;
  status: MatchmakingTicketStatus;
  roomId: string | null;
  createdAtServerMs: number;
  updatedAtServerMs: number;
  expiresAtServerMs: number;
}

export interface EnqueueMatchmakingRequest {
  queue?: MatchmakingQueue;
  playerId: string;
  name: string;
  avatarUrl?: string | null;
  region?: string;
}

export interface MatchmakingHeartbeatRequest {
  ticketId: string;
  playerId: string;
}

export interface LeaveMatchmakingRequest {
  ticketId: string;
  playerId: string;
}

export interface MatchmakingTicketResponse {
  ticket: MatchmakingTicket;
  room: OnlineRoom | null;
  serverNowMs: number;
}

export interface OnlineProfileResponse {
  profile: OnlineProfile;
  recentResults: OnlineMatchResult[];
  serverNowMs: number;
}

export interface QuickPlayEnterRequest {
  playerId: string;
  name: string;
  avatarUrl?: string | null;
  region?: string;
}

export interface QuickPlayLeaderboardEntry {
  playerId: string;
  displayName: string;
  weekId: string;
  score: number;
  lines: number;
  koCount: number;
  survivalFrames: number;
  sentGarbage: number;
  receivedGarbage: number;
  updatedAtServerMs: number;
}

export interface QuickPlayEnterResponse {
  room: OnlineRoom;
  leaderboard: QuickPlayLeaderboardEntry[];
  serverNowMs: number;
}

export interface QuickPlayLeaderboardResponse {
  weekId: string;
  entries: QuickPlayLeaderboardEntry[];
  serverNowMs: number;
}
