import type { GameRules } from './types';

const DEFAULT_GRAVITY_CELLS_PER_FRAME = 1 / 60;
const DEFAULT_SOFT_DROP_FACTOR = 20;

export const DEFAULT_RULES: GameRules = {
  boardWidth: 10,
  visibleRows: 20,
  hiddenRows: 2,
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
};
