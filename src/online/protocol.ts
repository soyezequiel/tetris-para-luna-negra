import type { ActivePiece, Cell } from '../game/types';

export type RoomVisibility = 'public' | 'private';
export type OnlineRoomStatus = 'lobby' | 'countdown' | 'playing' | 'finished';
export type OnlinePlayerStatus = 'joined' | 'ready' | 'playing' | 'won' | 'lost' | 'disconnected';

export interface OnlineGameSnapshot {
  board: Cell[][];
  active: ActivePiece | null;
  visibleRows: number;
  boardWidth: number;
  elapsedFrames: number;
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

export interface OnlinePlayer {
  id: string;
  name: string;
  ready: boolean;
  status: OnlinePlayerStatus;
  lines: number;
  pieces: number;
  elapsedFrames: number;
  updatedAtServerMs: number;
  finishedAtServerMs: number | null;
  game: OnlineGameSnapshot | null;
}

export interface OnlineRoom {
  id: string;
  visibility: RoomVisibility;
  status: OnlineRoomStatus;
  hostPlayerId: string;
  createdAtServerMs: number;
  updatedAtServerMs: number;
  startsAtServerMs: number | null;
  seed: number;
  players: OnlinePlayer[];
  peerSignals: OnlinePeerSignal[];
}

export interface OnlineRoomSummary {
  id: string;
  hostName: string;
  playerCount: number;
  status: OnlineRoomStatus;
  createdAtServerMs: number;
}

export interface CreateRoomRequest {
  playerId: string;
  name: string;
  visibility: RoomVisibility;
}

export interface JoinRoomRequest {
  roomId: string;
  playerId: string;
  name: string;
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

export interface ProgressRequest {
  roomId: string;
  playerId: string;
  lines: number;
  pieces: number;
  elapsedFrames: number;
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

export interface OnlineErrorResponse {
  error: string;
}

export interface OnlineRoomResponse {
  room: OnlineRoom;
  serverNowMs: number;
}

export interface PublicRoomsResponse {
  rooms: OnlineRoomSummary[];
  serverNowMs: number;
}
