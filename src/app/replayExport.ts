import type { ReplayLog } from '../game/replay';
import type { GameState } from '../game/types';
import { cloneInputSettings, type InputSettings } from '../input/settings';

export interface ExportedReplay {
  version: 1;
  game: 'stack40';
  createdAt: string;
  seed: number;
  rules: ReplayLog['rules'];
  inputSettings: InputSettings;
  result: {
    status: GameState['status'];
    lines: number;
    pieces: number;
    frame: number;
    finishFrame: number | null;
    gameOverFrame: number | null;
  };
  inputs: ReplayLog['inputs'];
}

export function createExportedReplay(
  log: ReplayLog,
  state: GameState,
  inputSettings: InputSettings,
  createdAt = new Date().toISOString(),
): ExportedReplay {
  return {
    version: 1,
    game: 'stack40',
    createdAt,
    seed: log.seed,
    rules: { ...log.rules },
    inputSettings: cloneInputSettings(inputSettings),
    result: {
      status: state.status,
      lines: state.stats.lines,
      pieces: state.stats.pieces,
      frame: state.stats.frame,
      finishFrame: state.stats.finishFrame,
      gameOverFrame: state.stats.gameOverFrame,
    },
    inputs: log.inputs.map((input) => ({ ...input })),
  };
}

export function replayFileName(replay: ExportedReplay): string {
  const time = replay.createdAt.replace(/[:.]/g, '-');
  const status = replay.result.status === 'finished' ? 'clear' : replay.result.status;
  return `stack40-${status}-${replay.seed}-${time}.json`;
}
