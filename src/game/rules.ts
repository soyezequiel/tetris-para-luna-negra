import type { GameRules } from './types';

const DEFAULT_GRAVITY_CELLS_PER_FRAME = 1 / 60;
// Soft drop más rápido (40x gravedad) para que bajar piezas se sienta inmediato.
export const DEFAULT_SOFT_DROP_FACTOR = 40;
export const MIN_SOFT_DROP_FACTOR = 5;
// Sentinel: a partir de este factor el soft drop es "instantáneo" (la pieza cae
// al piso en un frame sin lockear, estilo SDF infinito de TETR.IO).
export const INSTANT_SOFT_DROP_FACTOR = 41;
// Suficiente para cruzar cualquier tablero en un frame; applyAccumulatedFall frena
// al tocar el piso, así que no lockea por sí solo.
const INSTANT_SOFT_DROP_CELLS = 60;

// Convierte el "factor" que ve el jugador (≈ celdas por segundo) en celdas por
// frame de soft drop. Es el único lugar que conoce el mapeo, así se testea solo.
export function softDropCellsPerFrameForFactor(factor: number): number {
  if (factor >= INSTANT_SOFT_DROP_FACTOR) return INSTANT_SOFT_DROP_CELLS;
  return DEFAULT_GRAVITY_CELLS_PER_FRAME * (factor - 1);
}

export const DEFAULT_RULES: GameRules = {
  boardWidth: 10,
  visibleRows: 20,
  // Buffer estilo tetr.io: 6 filas ocultas arriba del área visible. La pila puede
  // sobresalir del mapa sin morir al instante; ver topOutGraceFrames en el engine.
  hiddenRows: 6,
  nextPreview: 5,
  targetLines: 40,
  attackTable: 'simple',
  gravityCellsPerFrame: DEFAULT_GRAVITY_CELLS_PER_FRAME,
  gravityIncreaseCellsPerLevel: 0,
  gravityLevelLines: 0,
  gravityLevelPieces: 0,
  gravityStartingLevel: 1,
  softDropCellsPerFrame: softDropCellsPerFrameForFactor(DEFAULT_SOFT_DROP_FACTOR),
  lockDelayFrames: 30,
  dasFrames: 8,
  arrFrames: 2,
  garbageDelayFrames: 90,
  garbageTravelFrames: 0,
  garbageActivationFrames: 90,
  garbageCap: 0,
  garbageMessinessPercent: 100,
  changeOnAttack: true,
  continuousGarbage: false,
  allowHardDrop: true,
  allowHold: true,
  showGhost: true,
  infiniteHold: false,
  infiniteMovement: false,
  lockResetLimit: 15,
};

export const BATTLE_RULES: GameRules = {
  ...DEFAULT_RULES,
  targetLines: null,
  // En batallas online los combos, B2B y spins suman ataque (tabla moderna).
  attackTable: 'modern',
};
