import type { SoundCue } from '../audio/SoundEngine';
import type { GameEvent, GameState } from '../game/types';

export function soundCueForRunProgress(
  state: GameState,
  events: readonly GameEvent[],
  lastLines: number,
  lastPieces: number,
): SoundCue | null {
  if (state.stats.lines > lastLines) {
    return events.some((event) => event.type === 'lineClear' && event.spin !== 'none') ? 'tSpin' : 'lineClear';
  }
  if (state.stats.pieces > lastPieces) return 'lock';
  return null;
}
