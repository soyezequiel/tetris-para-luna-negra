import type { GameRules } from './types';

export const DEFAULT_RULES: GameRules = {
  boardWidth: 10,
  visibleRows: 20,
  hiddenRows: 2,
  nextPreview: 5,
  targetLines: 40,
  gravityCellsPerFrame: 1 / 60,
  softDropCellsPerFrame: 1,
  lockDelayFrames: 30,
  dasFrames: 9,
  arrFrames: 1,
  garbageDelayFrames: 90,
  allowHardDrop: true,
  allowHold: true,
  showGhost: true,
  infiniteHold: false,
  infiniteMovement: true,
  lockResetLimit: 15,
};

export const BATTLE_RULES: GameRules = {
  ...DEFAULT_RULES,
  targetLines: null,
};
