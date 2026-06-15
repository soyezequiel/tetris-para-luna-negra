import type { GameRules } from './types';

const MAX_GRAVITY_CELLS_PER_FRAME = 20;
const FRAMES_PER_SECOND = 60;

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
  const levelOffset = startingLevelOffset + lineLevels + pieceLevels;
  const gravity = rules.gravityCurve === 'guideline'
    ? guidelineCellsPerFrame(levelOffset + 1)
    : rules.gravityCellsPerFrame + levelOffset * Math.max(0, rules.gravityIncreaseCellsPerLevel);
  return Math.min(MAX_GRAVITY_CELLS_PER_FRAME, Math.max(0, gravity));
}

// Curva del Tetris Guideline (la que usa TETR.IO para sus modos con niveles):
// segundos por celda = (0.8 - (nivel - 1) * 0.007) ^ (nivel - 1). Nivel 1 = 1 s/celda
// (≈ 1/60 celdas por frame); a partir de ahí la caída se acelera de forma exponencial
// hasta saturar el tope de 20G en niveles altos.
function guidelineCellsPerFrame(level: number): number {
  const safeLevel = Math.max(1, Math.floor(level));
  // El factor base se mantiene positivo para que el exponente entero no produzca NaN
  // ni oscilaciones en niveles extremos (>115).
  const base = Math.max(0.0001, 0.8 - (safeLevel - 1) * 0.007);
  const secondsPerCell = Math.pow(base, safeLevel - 1);
  return 1 / (secondsPerCell * FRAMES_PER_SECOND);
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
