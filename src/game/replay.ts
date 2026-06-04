import { DEFAULT_RULES } from './rules';
import type { GameInput, GameRules } from './types';

export interface ReplayLog {
  seed: number;
  rules: GameRules;
  inputs: GameInput[];
}

export function createReplayLog(seed: number, rules: GameRules = DEFAULT_RULES): ReplayLog {
  return {
    seed,
    rules: { ...rules },
    inputs: [],
  };
}

export function recordInput(log: ReplayLog, input: GameInput): void {
  log.inputs.push(input);
}
