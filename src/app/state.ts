import type { GameState } from '../game/types';

export type AppMode = 'menu' | 'playing' | 'paused' | 'settings' | 'replayPlayback' | 'library';
export type DestructiveRunAction = 'restart' | 'main-menu' | 'import-replay';

export function canAdvanceGame(mode: AppMode, status: GameState['status']): boolean {
  return mode === 'playing' && status === 'playing';
}

export function togglePauseMode(mode: AppMode, status: GameState['status'], settingsReturnMode: AppMode): AppMode {
  if (mode === 'settings') return settingsReturnMode;
  if (mode === 'paused' && status === 'playing') return 'playing';
  if (mode === 'playing' && status === 'playing') return 'paused';
  return mode;
}

export function requiresRunConfirmation(
  action: string | undefined,
  mode: AppMode,
  status: GameState['status'],
): action is DestructiveRunAction {
  if (status !== 'playing') return false;
  if (mode === 'menu' || mode === 'replayPlayback' || mode === 'library') return false;
  return action === 'restart' || action === 'main-menu' || action === 'import-replay';
}

export function terminalLabel(status: GameState['status']): string | null {
  if (status === 'finished') return 'CLEAR';
  if (status === 'gameover') return 'TOP OUT';
  return null;
}
