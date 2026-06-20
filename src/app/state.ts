import type { GameOverReason, GameState } from '../game/types';

export type AppMode =
  | 'menu'
  | 'playMenu'
  | 'soloMenu'
  | 'multiplayerMenu'
  | 'historyMenu'
  | 'configMenu'
  | 'custom'
  | 'playing'
  | 'paused'
  | 'settings'
  | 'replayPlayback'
  | 'onlineReplay'
  | 'library'
  | 'leaderboard'
  | 'survivalTop'
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

// Modos donde suena la música de fondo. Los menús (menu principal, solo,
// multijugador, config, custom, librería, leaderboard, lobby online, settings)
// quedan en silencio; la música arranca al entrar en una partida o repetición.
const MUSIC_MODES: readonly AppMode[] = [
  'playing',
  'paused',
  'soloCountdown',
  'onlineCountdown',
  'onlinePlaying',
  'onlineResults',
  'onlineReplay',
  'replayPlayback',
];

export function shouldPlayMusic(mode: AppMode): boolean {
  return MUSIC_MODES.includes(mode);
}

// Autoridad descentralizada: cada cliente es dueño de su propio tablero y muerte,
// así que cualquiera puede commitear SU PROPIO estado terminal (KO/resultado)
// directo al servidor, sin pasar por el host. Antes solo el host podía, y su
// caída a mitad de ronda dejaba las muertes sin registrar hasta el failover.
export function canCommitLocalOnlineTerminal(_isHostAuthority: boolean): boolean {
  return true;
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
    || mode === 'playMenu'
    || mode === 'soloMenu'
    || mode === 'multiplayerMenu'
    || mode === 'historyMenu'
    || mode === 'configMenu'
    || mode === 'custom'
    || mode === 'replayPlayback'
    || mode === 'library'
    || mode === 'leaderboard'
    || mode === 'survivalTop'
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

export function gameOverReasonMessage(reason: GameOverReason | null | undefined): string {
  switch (reason) {
    case 'blockOut':
      return 'La pieza no pudo aparecer — la pila llegó al tope.';
    case 'lockOut':
      return 'La pieza se trabó por encima del área visible.';
    case 'garbageTopOut':
      return 'Las líneas de basura empujaron tus bloques más allá del tope.';
    case 'garbageCollision':
      return 'Las líneas de basura aplastaron tu pieza activa.';
    case 'holdBlockOut':
      return 'La pieza del hold no pudo aparecer — no hay espacio.';
    case 'topOutTimer':
      return 'La pila quedó por encima del mapa demasiado tiempo.';
    default:
      return 'La pila superó el tope.';
  }
}
