export type PieceType = 'I' | 'J' | 'L' | 'O' | 'S' | 'T' | 'Z';

export type Cell = PieceType | null;

export type Rotation = 0 | 1 | 2 | 3;

export interface Vec2 {
  x: number;
  y: number;
}

export interface ActivePiece {
  type: PieceType;
  x: number;
  y: number;
  rotation: Rotation;
}

export type InputAction =
  | 'moveLeft'
  | 'moveRight'
  | 'softDrop'
  | 'hardDrop'
  | 'rotateCW'
  | 'rotateCCW'
  | 'hold'
  | 'retry';

export interface GameInput {
  frame: number;
  action: InputAction;
}

export interface GameRules {
  boardWidth: number;
  visibleRows: number;
  hiddenRows: number;
  nextPreview: number;
  targetLines: number | null;
  gravityCellsPerFrame: number;
  softDropCellsPerFrame: number;
  lockDelayFrames: number;
  dasFrames: number;
  arrFrames: number;
  garbageDelayFrames: number;
}

export interface PendingGarbage {
  id: string;
  lines: number;
  holeColumn: number;
  receivedFrame: number;
  applyFrame: number;
}

export interface LineClearEvent {
  type: 'lineClear';
  frame: number;
  cleared: number;
  attackLines: number;
  outgoingLines: number;
}

export interface IncomingGarbageEvent {
  type: 'incomingGarbage';
  frame: number;
  lines: number;
}

export interface AppliedGarbageEvent {
  type: 'appliedGarbage';
  frame: number;
  lines: number;
}

export type GameEvent = LineClearEvent | IncomingGarbageEvent | AppliedGarbageEvent;

export interface GameStats {
  frame: number;
  pieces: number;
  lines: number;
  sentGarbage: number;
  receivedGarbage: number;
  pendingGarbage: number;
  targetLines: number | null;
  startFrame: number;
  finishFrame: number | null;
  gameOverFrame: number | null;
}

export interface GameState {
  board: Cell[][];
  active: ActivePiece | null;
  ghost: ActivePiece | null;
  hold: PieceType | null;
  canHold: boolean;
  next: PieceType[];
  stats: GameStats;
  status: 'ready' | 'playing' | 'finished' | 'gameover';
  seed: number;
}
