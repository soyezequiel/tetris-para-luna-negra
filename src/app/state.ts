import type { GameState } from '../game/types';

export type AppMode =
  | 'menu'
  | 'soloMenu'
  | 'multiplayerMenu'
  | 'historyMenu'
  | 'configMenu'
  | 'custom'
  | 'playing'
  | 'paused'
  | 'settings'
  | 'replayPlayback'
  | 'library'
  | 'onlineMenu'
  | 'roomLobby'
  | 'onlineCountdown'
  | 'onlinePlaying'
  | 'onlineResults'
  | 'soloCountdown';
export type DestructiveRunAction = 'restart' | 'main-menu' | 'import-replay' | 'online-leave';

export function canAdvanceGame(mode: AppMode, status: GameState['status']): boolean {
  return (mode === 'playing' || mode === 'onlinePlaying') && status === 'playing';
}

export function canCommitLocalOnlineTerminal(isHostAuthority: boolean): boolean {
  return isHostAuthority;
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
  settingsReturnMode: AppMode = 'menu',
): action is DestructiveRunAction {
  if (status !== 'playing') return false;
  if (
    mode === 'menu'
    || mode === 'soloMenu'
    || mode === 'multiplayerMenu'
    || mode === 'historyMenu'
    || mode === 'configMenu'
    || mode === 'custom'
    || mode === 'replayPlayback'
    || mode === 'library'
    || mode === 'onlineMenu'
    || mode === 'roomLobby'
    || mode === 'onlineCountdown'
    || mode === 'onlineResults'
    || mode === 'soloCountdown'
    || (mode === 'settings' && settingsReturnMode !== 'paused')
  ) return false;
  return action === 'restart' || action === 'main-menu' || action === 'import-replay' || action === 'online-leave';
}

export function terminalLabel(status: GameState['status']): string | null {
  if (status === 'finished') return 'CLEAR';
  if (status === 'gameover') return 'TOP OUT';
  return null;
}
