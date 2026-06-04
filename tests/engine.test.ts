import { describe, expect, it } from 'vitest';
import { createExportedReplay } from '../src/app/replayExport';
import { canAdvanceGame, togglePauseMode } from '../src/app/state';
import { createShuffledBag } from '../src/game/bag';
import { clearCompletedLines, createBoard } from '../src/game/board';
import { GameEngine } from '../src/game/engine';
import { createReplayLog, recordInput } from '../src/game/replay';
import { SeededRng } from '../src/game/rng';
import { displayedElapsedFrames } from '../src/game/timing';
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
    expect(exported.inputs).toEqual([input]);
    expect(exported.inputs).not.toBe(log.inputs);
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
