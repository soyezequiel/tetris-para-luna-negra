import type { GameRules } from './types';

export const DEFAULT_RULES: GameRules = {
  boardWidth: 10,
  visibleRows: 20,
  hiddenRows: 2,
  nextPreview: 5,
  targetLines: 40,
  attackTable: 'simple',
  gravityCellsPerFrame: 1 / 60,
  softDropCellsPerFrame: 1,
  lockDelayFrames: 30,
  dasFrames: 9,
  arrFrames: 1,
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
