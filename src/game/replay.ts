import { DEFAULT_RULES } from './rules';
import type { GameInput, GameRules } from './types';

// Basura entrante registrada para reproducir fielmente una partida online. En
// solo este arreglo queda vacío. En vivo, applyOnlineAttack llama a
// engine.queueGarbage(lines, holeSeed, frame=attack.frame, id) DESPUÉS del tick,
// con el motor en su gameFrame actual. La aplicación real (applyFrame = frame +
// delay) depende tanto del ancla `frame` como del frame en que se encoló, que por
// latencia pueden diferir. Guardamos ambos para reaplicar en el mismo orden:
//  - queuedAtFrame: gameFrame del motor cuando se encoló (= cuándo reaplicar).
//  - frame: ancla pasada a queueGarbage (fija applyFrame).
export interface ReplayGarbageEvent {
  queuedAtFrame: number;
  frame: number;
  lines: number;
  holeSeed: number;
  id: string;
}

export interface ReplayLog {
  seed: number;
  rules: GameRules;
  inputs: GameInput[];
  garbage: ReplayGarbageEvent[];
}

export function createReplayLog(seed: number, rules: GameRules = DEFAULT_RULES): ReplayLog {
  return {
    seed,
    rules: { ...rules },
    inputs: [],
    garbage: [],
  };
}

export function recordInput(log: ReplayLog, input: GameInput): void {
  log.inputs.push(input);
}

export function recordGarbage(log: ReplayLog, event: ReplayGarbageEvent): void {
  log.garbage.push({ ...event });
}
