import { describe, expect, it } from 'vitest';
import { importReplayJson, importReplayValue } from '../src/app/replayImport';
import { createExportedReplay, replayFileName } from '../src/app/replayExport';
import { ReplayPlayback } from '../src/app/replayPlayback';
import {
  createRunHistoryEntry,
  deleteRunHistoryEntry,
  loadRunHistory,
  MAX_RUN_HISTORY_ENTRIES,
  saveRunHistoryEntry,
  type HistoryStorage,
} from '../src/app/runHistory';
import { canAdvanceGame, requiresRunConfirmation, togglePauseMode } from '../src/app/state';
import { createShuffledBag } from '../src/game/bag';
import { clearCompletedLines, createBoard } from '../src/game/board';
import { GameEngine } from '../src/game/engine';
import { createReplayLog, recordInput } from '../src/game/replay';
import { SeededRng } from '../src/game/rng';
import { DEFAULT_RULES } from '../src/game/rules';
import { displayedElapsedFrames } from '../src/game/timing';
import { createRunSummary, RunSplitTracker } from '../src/app/runStats';
import {
  actionForCode,
  DEFAULT_INPUT_SETTINGS,
  normalizeInputSettings,
  updateBinding,
  updateInputTiming,
} from '../src/input/settings';
import type { GameInput } from '../src/game/types';

describe('core stacker engine', () => {
  it('creates deterministic 7-bags with all pieces once', () => {
    const bagA = createShuffledBag(new SeededRng(1234));
    const bagB = createShuffledBag(new SeededRng(1234));
    expect(bagA).toEqual(bagB);
    expect(new Set(bagA).size).toBe(7);
    expect([...bagA].sort()).toEqual(['I', 'J', 'L', 'O', 'S', 'T', 'Z']);
  });

  it('clears completed lines and preserves row order', () => {
    const board = createBoard(4, 4);
    board[1] = ['I', 'I', 'I', 'I'];
    board[2][0] = 'T';
    board[3] = ['O', 'O', 'O', 'O'];
    const result = clearCompletedLines(board, 4);
    expect(result.cleared).toBe(2);
    expect(result.board[0]).toEqual([null, null, null, null]);
    expect(result.board[1]).toEqual([null, null, null, null]);
    expect(result.board[3]).toEqual(['T', null, null, null]);
  });

  it('hard drops, locks, and spawns the next piece', () => {
    const engine = new GameEngine(99);
    const before = engine.getState().active?.type;
    const state = engine.tick(1, [{ frame: 1, action: 'hardDrop' }]);
    expect(state.stats.pieces).toBe(1);
    expect(state.active?.type).not.toBe(before);
    expect(state.board.some((row) => row.some(Boolean))).toBe(true);
  });

  it('allows holding once per active piece', () => {
    const engine = new GameEngine(2024);
    const first = engine.getState().active?.type;
    const afterHold = engine.tick(1, [{ frame: 1, action: 'hold' }]);
    expect(afterHold.hold).toBe(first);
    expect(afterHold.canHold).toBe(false);
    const afterSecondHold = engine.tick(2, [{ frame: 2, action: 'hold' }]);
    expect(afterSecondHold.hold).toBe(first);
  });

  it('replays the same input log deterministically', () => {
    const inputs: GameInput[] = [
      { frame: 1, action: 'moveLeft' },
      { frame: 2, action: 'rotateCW' },
      { frame: 3, action: 'hardDrop' },
      { frame: 4, action: 'hold' },
      { frame: 5, action: 'moveRight' },
      { frame: 6, action: 'hardDrop' },
    ];
    const a = runReplay(inputs);
    const b = runReplay(inputs);
    expect(a.board).toEqual(b.board);
    expect(a.active).toEqual(b.active);
    expect(a.hold).toEqual(b.hold);
    expect(a.next).toEqual(b.next);
    expect(a.stats).toEqual(b.stats);
  });

  it('freezes displayed time on terminal frames', () => {
    expect(displayedElapsedFrames({
      frame: 900,
      pieces: 102,
      lines: 40,
      startFrame: 0,
      finishFrame: 600,
      gameOverFrame: null,
    })).toBe(600);

    expect(displayedElapsedFrames({
      frame: 900,
      pieces: 12,
      lines: 4,
      startFrame: 120,
      finishFrame: null,
      gameOverFrame: 500,
    })).toBe(380);
  });

  it('normalizes input settings and resolves custom bindings', () => {
    const clamped = normalizeInputSettings({ dasFrames: 999, arrFrames: 0 });
    expect(clamped.dasFrames).toBe(30);
    expect(clamped.arrFrames).toBe(1);

    const rebound = updateBinding(DEFAULT_INPUT_SETTINGS, 'rotateCW', 'KeyA');
    expect(rebound.bindings.rotateCW).toEqual(['KeyA']);
    expect(actionForCode(rebound, 'KeyA')).toBe('rotateCW');

    const slower = updateInputTiming(DEFAULT_INPUT_SETTINGS, 'dasFrames', 2);
    expect(slower.dasFrames).toBe(DEFAULT_INPUT_SETTINGS.dasFrames + 2);
  });

  it('keeps app pause state separate from engine status', () => {
    expect(canAdvanceGame('playing', 'playing')).toBe(true);
    expect(canAdvanceGame('paused', 'playing')).toBe(false);
    expect(canAdvanceGame('playing', 'finished')).toBe(false);
    expect(togglePauseMode('playing', 'playing', 'menu')).toBe('paused');
    expect(togglePauseMode('paused', 'playing', 'menu')).toBe('playing');
    expect(togglePauseMode('settings', 'playing', 'paused')).toBe('paused');
  });

  it('requires confirmation only for destructive actions during active runs', () => {
    expect(requiresRunConfirmation('restart', 'playing', 'playing')).toBe(true);
    expect(requiresRunConfirmation('main-menu', 'paused', 'playing')).toBe(true);
    expect(requiresRunConfirmation('import-replay', 'settings', 'playing')).toBe(true);

    expect(requiresRunConfirmation('restart', 'menu', 'playing')).toBe(false);
    expect(requiresRunConfirmation('restart', 'playing', 'finished')).toBe(false);
    expect(requiresRunConfirmation('restart', 'paused', 'gameover')).toBe(false);
    expect(requiresRunConfirmation('export-replay', 'paused', 'playing')).toBe(false);
  });

  it('exports replay metadata without mutating the replay log', () => {
    const engine = new GameEngine(314);
    const input: GameInput = { frame: 1, action: 'hardDrop' };
    const log = createReplayLog(314);
    recordInput(log, input);
    const state = engine.tick(1, [input]);
    const exported = createExportedReplay(log, state, DEFAULT_INPUT_SETTINGS, '2026-06-04T21:00:00.000Z');

    expect(exported.version).toBe(1);
    expect(exported.seed).toBe(314);
    expect(exported.result.pieces).toBe(1);
    expect(exported.summary.inputCount).toBe(1);
    expect(exported.inputs).toEqual([input]);
    expect(exported.inputs).not.toBe(log.inputs);
  });

  it('calculates advanced run summary metrics over elapsed frames', () => {
    const summary = createRunSummary({
      result: {
        lines: 40,
        pieces: 100,
        frame: 1200,
        finishFrame: 1200,
        gameOverFrame: null,
      },
      inputs: [
        { frame: 1, action: 'moveLeft' },
        { frame: 2, action: 'hardDrop' },
        { frame: 3, action: 'hold' },
      ],
      splits: [{ lines: 10, frame: 300, elapsedFrames: 300 }],
    });

    expect(summary.elapsedFrames).toBe(1200);
    expect(summary.pps).toBe(5);
    expect(summary.inputCount).toBe(3);
    expect(summary.inputsPerPiece).toBe(0.03);
    expect(summary.linesPerMinute).toBe(120);
    expect(summary.splits).toEqual([{ lines: 10, frame: 300, elapsedFrames: 300 }]);
  });

  it('handles inputs per piece when no pieces were placed', () => {
    const summary = createRunSummary({
      result: {
        lines: 0,
        pieces: 0,
        frame: 0,
        finishFrame: null,
        gameOverFrame: null,
      },
      inputs: [{ frame: 0, action: 'hold' }],
    });

    expect(summary.pps).toBe(0);
    expect(summary.inputsPerPiece).toBe(0);
    expect(summary.linesPerMinute).toBe(0);
  });

  it('records 10-line splits when line thresholds are crossed', () => {
    const tracker = new RunSplitTracker([10, 20, 30, 40]);

    tracker.record(createSplitState(9, 120));
    expect(tracker.getSplits()).toEqual([]);

    tracker.record(createSplitState(12, 180));
    tracker.record(createSplitState(21, 360));
    tracker.record(createSplitState(40, 720));

    expect(tracker.getSplits()).toEqual([
      { lines: 10, frame: 180, elapsedFrames: 180 },
      { lines: 20, frame: 360, elapsedFrames: 360 },
      { lines: 30, frame: 720, elapsedFrames: 720 },
      { lines: 40, frame: 720, elapsedFrames: 720 },
    ]);
  });

  it('imports exported replay JSON and rejects incompatible files', () => {
    const exported = createReplayFixture(314, [{ frame: 1, action: 'hardDrop' }], 1);
    const imported = importReplayJson(JSON.stringify(exported));
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.replay.seed).toBe(314);
      expect(imported.replay.inputs).toEqual(exported.inputs);
    }

    expect(importReplayJson('{nope').ok).toBe(false);
    expect(importReplayValue({ ...exported, game: 'other' }).ok).toBe(false);
  });

  it('plays imported replays deterministically and supports speed and restart', () => {
    const exported = createReplayFixture(2718, [{ frame: 1, action: 'hardDrop' }], 4);
    const playback = new ReplayPlayback(exported);

    playback.setSpeed(2);
    expect(playback.tick().frame).toBe(2);
    const done = playback.tick();
    expect(done.frame).toBe(4);
    expect(done.done).toBe(true);
    expect(done.validation).toBe('match');

    playback.restart();
    expect(playback.snapshot().frame).toBe(0);
    expect(playback.snapshot().validation).toBe('pending');
  });

  it('normalizes corrupt run history storage', () => {
    const storage = new MemoryStorage();
    storage.setItem('stack40.runHistory.v1', '{nope');
    expect(loadRunHistory(storage)).toEqual([]);

    storage.setItem('stack40.runHistory.v1', JSON.stringify({ version: 1, entries: [{ replay: { version: 1 } }] }));
    expect(loadRunHistory(storage)).toEqual([]);
  });

  it('saves terminal runs with embedded replays and derived stats', () => {
    const storage = new MemoryStorage();
    const replay = createTerminalReplayFixture('finished', 1200);
    const entry = createRunHistoryEntry(replay);

    expect(entry).not.toBeNull();
    if (!entry) return;
    const history = saveRunHistoryEntry(entry, storage);

    expect(history).toHaveLength(1);
    expect(history[0].seed).toBe(replay.seed);
    expect(history[0].status).toBe('finished');
    expect(history[0].elapsedFrames).toBe(1200);
    expect(history[0].pps).toBe(5);
    expect(history[0].inputCount).toBe(replay.inputs.length);
    expect(history[0].inputsPerPiece).toBe(replay.inputs.length / 100);
    expect(history[0].linesPerMinute).toBe(120);
    expect(history[0].replay).toEqual(replay);
  });

  it('limits run history and replaces duplicate entries', () => {
    const storage = new MemoryStorage();
    const firstReplay = createTerminalReplayFixture('finished', 600);
    const firstEntry = createRunHistoryEntry(firstReplay);
    expect(firstEntry).not.toBeNull();
    if (!firstEntry) return;

    saveRunHistoryEntry(firstEntry, storage);
    saveRunHistoryEntry(firstEntry, storage);
    expect(loadRunHistory(storage)).toHaveLength(1);

    for (let index = 0; index < MAX_RUN_HISTORY_ENTRIES + 5; index += 1) {
      const replay = createTerminalReplayFixture('gameover', 900 + index, 1000 + index);
      const entry = createRunHistoryEntry(replay);
      expect(entry).not.toBeNull();
      if (entry) saveRunHistoryEntry(entry, storage);
    }

    const history = loadRunHistory(storage);
    expect(history).toHaveLength(MAX_RUN_HISTORY_ENTRIES);
    expect(history[0].seed).toBe(1000 + MAX_RUN_HISTORY_ENTRIES + 4);
  });

  it('deletes one run history entry without breaking the others', () => {
    const storage = new MemoryStorage();
    const firstEntry = createRunHistoryEntry(createTerminalReplayFixture('finished', 600, 1));
    const secondEntry = createRunHistoryEntry(createTerminalReplayFixture('gameover', 900, 2));
    expect(firstEntry).not.toBeNull();
    expect(secondEntry).not.toBeNull();
    if (!firstEntry || !secondEntry) return;

    saveRunHistoryEntry(firstEntry, storage);
    saveRunHistoryEntry(secondEntry, storage);
    const history = deleteRunHistoryEntry(firstEntry.id, storage);

    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(secondEntry.id);
    expect(loadRunHistory(storage)).toEqual(history);
  });

  it('exports a historical replay without changing seed, rules, or inputs', () => {
    const replay = createTerminalReplayFixture('finished', 720, 444);
    const entry = createRunHistoryEntry(replay);
    expect(entry).not.toBeNull();
    if (!entry) return;

    const fileName = replayFileName(entry.replay);
    const imported = importReplayJson(JSON.stringify(entry.replay));

    expect(fileName).toContain(`-${replay.seed}-`);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.replay.seed).toBe(replay.seed);
    expect(imported.replay.rules).toEqual(replay.rules);
    expect(imported.replay.inputs).toEqual(replay.inputs);
  });

  it('plays a replay loaded from local history to the recorded result', () => {
    const storage = new MemoryStorage();
    const replay = createRecordedTerminalReplay(2026);
    const entry = createRunHistoryEntry(replay);
    expect(entry).not.toBeNull();
    if (!entry) return;

    saveRunHistoryEntry(entry, storage);
    const [loadedEntry] = loadRunHistory(storage);
    const playback = new ReplayPlayback(loadedEntry.replay);
    let snapshot = playback.snapshot();
    while (!snapshot.done) snapshot = playback.tick();

    expect(snapshot.validation).toBe('match');
    expect(snapshot.state.status).toBe(loadedEntry.replay.result.status);
    expect(snapshot.state.stats.lines).toBe(loadedEntry.replay.result.lines);
    expect(snapshot.state.stats.pieces).toBe(loadedEntry.replay.result.pieces);
  });
});

function runReplay(inputs: GameInput[]) {
  const engine = new GameEngine(777);
  let state = engine.getState();
  for (const input of inputs) {
    state = engine.tick(input.frame, [input]);
  }
  return state;
}

function createReplayFixture(seed: number, inputs: GameInput[], targetFrame: number) {
  const engine = new GameEngine(seed, DEFAULT_RULES);
  const log = createReplayLog(seed, DEFAULT_RULES);
  let state = engine.getState();
  for (let frame = 1; frame <= targetFrame; frame += 1) {
    const frameInputs = inputs.filter((input) => input.frame === frame);
    for (const input of frameInputs) recordInput(log, input);
    state = engine.tick(frame, frameInputs);
  }
  return createExportedReplay(log, state, DEFAULT_INPUT_SETTINGS, '2026-06-04T21:00:00.000Z');
}

function createTerminalReplayFixture(status: 'finished' | 'gameover', terminalFrame: number, seed = 314) {
  const replay = createReplayFixture(seed, [{ frame: 1, action: 'hardDrop' }], 1);
  return {
    ...replay,
    createdAt: `2026-06-04T21:00:${String(seed % 60).padStart(2, '0')}.000Z`,
    result: {
      ...replay.result,
      status,
      lines: status === 'finished' ? 40 : 12,
      pieces: status === 'finished' ? 100 : 24,
      frame: terminalFrame,
      finishFrame: status === 'finished' ? terminalFrame : null,
      gameOverFrame: status === 'gameover' ? terminalFrame : null,
    },
  };
}

function createRecordedTerminalReplay(seed: number) {
  const engine = new GameEngine(seed, DEFAULT_RULES);
  const log = createReplayLog(seed, DEFAULT_RULES);
  let state = engine.getState();
  for (let frame = 1; frame <= 5000 && state.status === 'playing'; frame += 1) {
    const input: GameInput = { frame, action: 'hardDrop' };
    recordInput(log, input);
    state = engine.tick(frame, [input]);
  }
  expect(state.status === 'finished' || state.status === 'gameover').toBe(true);
  return createExportedReplay(log, state, DEFAULT_INPUT_SETTINGS, '2026-06-04T21:00:00.000Z');
}

function createSplitState(lines: number, frame: number) {
  const state = new GameEngine(123).getState();
  return {
    ...state,
    stats: {
      ...state.stats,
      lines,
      frame,
    },
  };
}

class MemoryStorage implements HistoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}
