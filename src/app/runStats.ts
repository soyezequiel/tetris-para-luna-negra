import type { GameInput, GameState } from '../game/types';

export interface LineSplit {
  lines: number;
  frame: number;
  elapsedFrames: number;
}

export interface RunSummary {
  elapsedFrames: number;
  pps: number;
  inputCount: number;
  inputsPerPiece: number;
  linesPerMinute: number;
  splits: LineSplit[];
}

export interface RunStatsSource {
  result: {
    lines: number;
    pieces: number;
    frame: number;
    finishFrame: number | null;
    gameOverFrame: number | null;
  };
  inputs: readonly GameInput[];
  splits?: readonly LineSplit[];
}

export const DEFAULT_SPLIT_LINES = [10, 20, 30, 40] as const;

export class RunSplitTracker {
  private readonly thresholds: readonly number[];
  private readonly splits: LineSplit[] = [];
  private nextThresholdIndex = 0;

  constructor(thresholds: readonly number[] = DEFAULT_SPLIT_LINES) {
    this.thresholds = [...thresholds].filter((lines) => Number.isInteger(lines) && lines > 0).sort((a, b) => a - b);
  }

  record(state: GameState): void {
    while (
      this.nextThresholdIndex < this.thresholds.length
      && state.stats.lines >= this.thresholds[this.nextThresholdIndex]
    ) {
      this.splits.push({
        lines: this.thresholds[this.nextThresholdIndex],
        frame: state.stats.frame,
        elapsedFrames: Math.max(0, state.stats.frame - state.stats.startFrame),
      });
      this.nextThresholdIndex += 1;
    }
  }

  getSplits(): LineSplit[] {
    return this.splits.map((split) => ({ ...split }));
  }
}

export function createRunSummary(source: RunStatsSource): RunSummary {
  const elapsedFrames = terminalElapsedFrames(source.result);
  const seconds = elapsedFrames / 60;
  const minutes = seconds / 60;
  const inputCount = source.inputs.length;
  const pieces = source.result.pieces;
  return {
    elapsedFrames,
    pps: seconds > 0 ? pieces / seconds : 0,
    inputCount,
    inputsPerPiece: pieces > 0 ? inputCount / pieces : 0,
    linesPerMinute: minutes > 0 ? source.result.lines / minutes : 0,
    splits: normalizeSplits(source.splits),
  };
}

function terminalElapsedFrames(result: RunStatsSource['result']): number {
  return Math.max(0, result.finishFrame ?? result.gameOverFrame ?? result.frame);
}

function normalizeSplits(splits: readonly LineSplit[] | undefined): LineSplit[] {
  if (!splits) return [];
  return splits
    .filter((split) => (
      Number.isInteger(split.lines)
      && split.lines > 0
      && Number.isInteger(split.frame)
      && split.frame >= 0
      && Number.isInteger(split.elapsedFrames)
      && split.elapsedFrames >= 0
    ))
    .map((split) => ({ ...split }))
    .sort((a, b) => a.lines - b.lines || a.frame - b.frame);
}
