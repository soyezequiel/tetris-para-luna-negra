// Estado de la PARTIDA en curso (solo/offline y la parte local de online): frame del
// motor, reloj de la partida, cuenta regresiva, tipo de run, y los "últimos" valores
// con los que se diffea el progreso. Objeto mutable fuera de main.ts, igual que el
// resto de PR7. (lastStatus queda en main: su init depende del engine; customTab es
// estado de UI del config, no de la partida.)
import { RunSplitTracker } from '../app/runStats';

// Qué clase de partida está activa.
export type RunKind = 'custom' | 'online' | 'survival';

export interface RunState {
  gameFrame: number;
  gameClockOriginMs: number;
  soloCountdownStartsAtMs: number;
  // Último segundo de la cuenta regresiva cuyo beep ya sonó (no repetir en el mismo
  // segundo). Compartido por la cuenta solo y online.
  lastCountdownSecondPlayed: number;
  currentRunKind: RunKind;
  savedRunHistoryEntry: boolean;
  splitTracker: RunSplitTracker;
  // "Últimos" valores para diffear el progreso entre frames.
  lastPieces: number;
  lastLines: number;
  maxCombo: number;
}

export const runState: RunState = {
  gameFrame: 0,
  gameClockOriginMs: performance.now(),
  soloCountdownStartsAtMs: 0,
  lastCountdownSecondPlayed: -1,
  currentRunKind: 'custom',
  savedRunHistoryEntry: false,
  splitTracker: new RunSplitTracker(),
  lastPieces: 0,
  lastLines: 0,
  maxCombo: 0,
};
