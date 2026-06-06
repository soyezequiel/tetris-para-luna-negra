import { calculateAttack, garbageHoleColumn, resolveAttack } from './attack';

export { garbageHoleColumn, resolveAttack };

export function attackLinesForClear(cleared: number): number {
  return calculateAttack({
    table: 'simple',
    cleared,
    combo: 0,
    b2b: 0,
    spin: 'none',
    perfectClear: false,
  }).attackLines;
}
