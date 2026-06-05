import type { PendingGarbage } from './types';

export function attackLinesForClear(cleared: number): number {
  if (cleared <= 1) return 0;
  if (cleared === 2) return 1;
  if (cleared === 3) return 2;
  return 4;
}

export function garbageHoleColumn(seed: number, width: number): number {
  if (width <= 0) return 0;
  const mixed = (seed >>> 0) * 1664525 + 1013904223;
  return Math.abs(mixed >>> 0) % width;
}

export function resolveAttack(outgoingLines: number, pendingIncoming: PendingGarbage[]): {
  remainingIncoming: PendingGarbage[];
  outgoingAfterCancel: number;
  cancelledLines: number;
} {
  let attack = Math.max(0, Math.floor(outgoingLines));
  let cancelledLines = 0;
  const remainingIncoming: PendingGarbage[] = [];

  for (const garbage of pendingIncoming) {
    if (attack <= 0) {
      remainingIncoming.push(garbage);
      continue;
    }
    const cancelled = Math.min(attack, garbage.lines);
    attack -= cancelled;
    cancelledLines += cancelled;
    const remainingLines = garbage.lines - cancelled;
    if (remainingLines > 0) remainingIncoming.push({ ...garbage, lines: remainingLines });
  }

  return {
    remainingIncoming,
    outgoingAfterCancel: attack,
    cancelledLines,
  };
}
