import type { GameInput, GameState } from '../game/types';
import type { OnlineGameSnapshot } from './protocol';

export function shouldReconcileLocalEngineSnapshot(
  localState: GameState,
  authoritative: OnlineGameSnapshot,
  pendingInputCount: number,
): boolean {
  if (!authoritative.engine) return false;
  if (authoritative.status === 'gameover' || authoritative.status === 'finished') return true;
  if (localState.status !== 'playing') return true;
  if (pendingInputCount > 0) return false;
  return true;
}

export function frameForPendingInputReplay(input: GameInput, authoritativeFrame: number): number {
  return Math.max(input.frame, authoritativeFrame + 1);
}
