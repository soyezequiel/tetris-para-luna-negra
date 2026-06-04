import { PIECES } from './pieces';
import type { SeededRng } from './rng';
import type { PieceType } from './types';

export function createShuffledBag(rng: SeededRng): PieceType[] {
  const bag = [...PIECES];
  for (let i = bag.length - 1; i > 0; i -= 1) {
    const j = rng.integer(i + 1);
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}
