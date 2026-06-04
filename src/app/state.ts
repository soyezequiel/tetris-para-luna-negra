import type { GameState } from '../game/types';

export type AppMode = 'menu' | 'playing' | 'paused' | 'settings' | 'replayPlayback';

export function canAdvanceGame(mode: AppMode, status: GameState['status']): boolean {
  return mode === 'playing' && status === 'playing';
}

export function togglePauseMode(mode: AppMode, status: GameState['status'], settingsReturnMode: AppMode): AppMode {
  if (mode === 'settings') return settingsReturnMode;
  if (mode === 'paused' && status === 'playing') return 'playing';
  if (mode === 'playing' && status === 'playing') return 'paused';
  return mode;
}

export function terminalLabel(status: GameState['status']): string | null {
  if (status === 'finished') return 'CLEAR';
  if (status === 'gameover') return 'TOP OUT';
  return null;
}
