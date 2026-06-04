import type { GameStats } from './types';

export function displayedElapsedFrames(stats: GameStats): number {
  const terminalFrame = stats.finishFrame ?? stats.gameOverFrame ?? stats.frame;
  return Math.max(0, terminalFrame - stats.startFrame);
}
