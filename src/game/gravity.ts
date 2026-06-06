import type { GameRules } from './types';

const MAX_GRAVITY_CELLS_PER_FRAME = 20;

export interface GravityProgress {
  lines: number;
  pieces: number;
}

export function currentGravityCellsPerFrame(rules: GameRules, progress: GravityProgress): number {
  const startingLevelOffset = Math.max(0, Math.floor(rules.gravityStartingLevel) - 1);
  const lineInterval = Math.max(0, Math.floor(rules.gravityLevelLines));
  const pieceInterval = Math.max(0, Math.floor(rules.gravityLevelPieces));
  const lineLevels = lineInterval > 0 ? Math.floor(nonNegative(progress.lines) / lineInterval) : 0;
  const pieceLevels = pieceInterval > 0 ? Math.floor(nonNegative(progress.pieces) / pieceInterval) : 0;
  const increase = Math.max(0, rules.gravityIncreaseCellsPerLevel);
  const gravity = rules.gravityCellsPerFrame + (startingLevelOffset + lineLevels + pieceLevels) * increase;
  return Math.min(MAX_GRAVITY_CELLS_PER_FRAME, Math.max(0, gravity));
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
