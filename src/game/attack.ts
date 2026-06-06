import type { AttackTableId, PendingGarbage, SpinType } from './types';

export interface AttackCalculationInput {
  table: AttackTableId;
  cleared: number;
  combo: number;
  b2b: number;
  spin?: SpinType;
  perfectClear?: boolean;
}

export interface AttackCalculation {
  table: AttackTableId;
  cleared: number;
  spin: SpinType;
  difficult: boolean;
  perfectClear: boolean;
  combo: number;
  b2b: number;
  baseLines: number;
  comboBonus: number;
  b2bBonus: number;
  perfectClearBonus: number;
  attackLines: number;
}

export function calculateAttack(input: AttackCalculationInput): AttackCalculation {
  const cleared = normalizeCleared(input.cleared);
  const spin = input.spin ?? 'none';
  const perfectClear = input.perfectClear === true;
  const combo = normalizeCounter(input.combo);
  const b2b = normalizeCounter(input.b2b);
  const difficult = isDifficultClear(cleared, spin);
  const baseLines = baseAttackLines(cleared, spin);

  if (input.table === 'simple') {
    return {
      table: 'simple',
      cleared,
      spin,
      difficult,
      perfectClear,
      combo,
      b2b,
      baseLines,
      comboBonus: 0,
      b2bBonus: 0,
      perfectClearBonus: 0,
      attackLines: baseLines,
    };
  }

  const comboBonus = comboBonusLines(combo);
  const b2bBonus = difficult && b2b > 1 ? 1 : 0;
  const perfectClearBonus = perfectClear && cleared > 0 ? 10 : 0;

  return {
    table: 'modern',
    cleared,
    spin,
    difficult,
    perfectClear,
    combo,
    b2b,
    baseLines,
    comboBonus,
    b2bBonus,
    perfectClearBonus,
    attackLines: baseLines + comboBonus + b2bBonus + perfectClearBonus,
  };
}

export function nextCombo(previousCombo: number, cleared: number): number {
  if (normalizeCleared(cleared) <= 0) return -1;
  if (!Number.isFinite(previousCombo) || previousCombo < 0) return 0;
  return Math.max(0, normalizeCounter(previousCombo) + 1);
}

export function nextBackToBack(previousB2b: number, cleared: number, spin: SpinType = 'none'): number {
  const normalizedCleared = normalizeCleared(cleared);
  if (normalizedCleared <= 0) return normalizeCounter(previousB2b);
  return isDifficultClear(normalizedCleared, spin) ? normalizeCounter(previousB2b) + 1 : 0;
}

export function isDifficultClear(cleared: number, spin: SpinType = 'none'): boolean {
  const normalizedCleared = normalizeCleared(cleared);
  if (normalizedCleared <= 0) return false;
  if (normalizedCleared >= 4) return true;
  return spin === 'full' || (spin === 'mini' && normalizedCleared > 0);
}

export function baseAttackLines(cleared: number, spin: SpinType = 'none'): number {
  const normalizedCleared = normalizeCleared(cleared);
  if (spin === 'full') {
    if (normalizedCleared === 1) return 2;
    if (normalizedCleared === 2) return 4;
    if (normalizedCleared >= 3) return 6;
  }
  if (spin === 'mini' && normalizedCleared > 0) return normalizedCleared;
  if (normalizedCleared <= 1) return 0;
  if (normalizedCleared === 2) return 1;
  if (normalizedCleared === 3) return 2;
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

function comboBonusLines(combo: number): number {
  if (combo <= 0) return 0;
  if (combo <= 2) return 1;
  if (combo <= 4) return 2;
  if (combo <= 6) return 3;
  return 4;
}

function normalizeCleared(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeCounter(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
