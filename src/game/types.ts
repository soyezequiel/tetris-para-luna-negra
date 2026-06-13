export type PieceType = 'I' | 'J' | 'L' | 'O' | 'S' | 'T' | 'Z';

export type Cell = PieceType | null;

export type Rotation = 0 | 1 | 2 | 3;

export type AttackTableId = 'simple' | 'modern';

export type SpinType = 'none' | 'mini' | 'full';

export type GameOverReason =
  | 'blockOut'
  | 'lockOut'
  | 'garbageTopOut'
  | 'garbageCollision'
  | 'holdBlockOut'
  | 'topOutTimer';

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
  | 'rotate180'
  | 'hold'
  | 'retry';

export interface GameInput {
  frame: number;
  action: InputAction;
  sequence?: number;
}

export interface GameRules {
  boardWidth: number;
  visibleRows: number;
  hiddenRows: number;
  nextPreview: number;
  targetLines: number | null;
  attackTable: AttackTableId;
  gravityCellsPerFrame: number;
  gravityIncreaseCellsPerLevel: number;
  gravityLevelLines: number;
  gravityLevelPieces: number;
  gravityStartingLevel: number;
  softDropCellsPerFrame: number;
  lockDelayFrames: number;
  dasFrames: number;
  arrFrames: number;
  garbageDelayFrames: number;
  garbageTravelFrames: number;
  garbageActivationFrames: number;
  garbageCap: number;
  garbageMessinessPercent: number;
  changeOnAttack: boolean;
  continuousGarbage: boolean;
  allowHardDrop: boolean;
  allowHold: boolean;
  showGhost: boolean;
  infiniteHold: boolean;
  infiniteMovement: boolean;
  lockResetLimit: number;
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
  difficult: boolean;
  spin: SpinType;
  piece: PieceType;
  perfectClear: boolean;
  combo: number;
  b2b: number;
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
  boardWidth: number;
  visibleRows: number;
  hiddenRows: number;
  frame: number;
  pieces: number;
  lines: number;
  sentGarbage: number;
  receivedGarbage: number;
  pendingGarbage: number;
  combo: number;
  b2b: number;
  targetLines: number | null;
  startFrame: number;
  finishFrame: number | null;
  gameOverFrame: number | null;
  gameOverReason: GameOverReason | null;
  /** Frames seguidos con la pila sobresaliendo del área visible (0 = dentro). */
  aboveFieldFrames: number;
  /** Informativo: ventana sobre la que la UI de peligro rampa estando arriba.
   * Ya NO es un umbral de muerte (estilo tetr.io: apilar en el buffer no mata). */
  topOutGraceFrames: number;
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

export interface GameEngineSnapshot {
  seed: number;
  rngState: number;
  board: Cell[][];
  active: ActivePiece | null;
  hold: PieceType | null;
  canHold: boolean;
  next: PieceType[];
  status: GameState['status'];
  frame: number;
  pieces: number;
  lines: number;
  startFrame: number;
  finishFrame: number | null;
  gameOverFrame: number | null;
  gameOverReason: GameOverReason | null;
  sentGarbage: number;
  receivedGarbage: number;
  pendingGarbage: PendingGarbage[];
  combo: number;
  b2b: number;
  lastGarbageHoleColumn: number | null;
  spinCandidate: boolean;
  fallAccumulator: number;
  lockFrames: number;
  lockResets: number;
  /** Frames seguidos con la pila sobresaliendo del área visible (tolerancia top-out). */
  aboveFieldFrames?: number;
}
