import type { GameRules } from './types';

const DEFAULT_GRAVITY_CELLS_PER_FRAME = 1 / 60;
// Soft drop más rápido (40x gravedad) para que bajar piezas se sienta inmediato.
const DEFAULT_SOFT_DROP_FACTOR = 40;

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
  softDropCellsPerFrame: DEFAULT_GRAVITY_CELLS_PER_FRAME * (DEFAULT_SOFT_DROP_FACTOR - 1),
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
