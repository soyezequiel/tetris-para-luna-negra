import { describe, expect, it } from 'vitest';
import { importReplayJson, importReplayValue } from '../src/app/replayImport';
import { createExportedReplay, replayFileName } from '../src/app/replayExport';
import { ReplayPlayback } from '../src/app/replayPlayback';
import {
  CUSTOM_DEFAULT_SETTINGS,
  customRulesFromSettings,
  normalizeCustomSettings,
} from '../src/app/customSettings';
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
import { calculateAttack, nextBackToBack, nextCombo } from '../src/game/attack';
import { attackLinesForClear, garbageHoleColumn, resolveAttack } from '../src/game/battle';
import { addGarbageLines, clearCompletedLines, createBoard } from '../src/game/board';
import { GameEngine } from '../src/game/engine';
import { createReplayLog, recordInput } from '../src/game/replay';
import { SeededRng } from '../src/game/rng';
import { BATTLE_RULES, DEFAULT_RULES } from '../src/game/rules';
import { displayedElapsedFrames } from '../src/game/timing';
import { createRunSummary, RunSplitTracker } from '../src/app/runStats';
import {
  addPeerSignal,
  addAttack,
  createRoom,
  createRoomCode,
  enqueueMatchmaking,
  enterQuickPlay,
  getQuickPlayLeaderboard,
  getRoomState,
  getOnlineProfileState,
  heartbeatMatchmaking,
  eliminatePlayer,
  joinRoom,
  listPublicRooms,
  MemoryRoomStore,
  rankPlayers,
  setPlayerTargeting,
  setPlayerReady,
  startRoom,
  submitResult,
  updateProgress,
} from '../src/online/roomService';
import { selectAttackTarget } from '../src/online/targeting';
import { InputController } from '../src/input';
import { HostAuthoritySimulator } from '../src/online/hostAuthority';
import { frameForPendingInputReplay, shouldReconcileLocalEngineSnapshot } from '../src/online/reconciliation';
import {
  actionForCode,
  DEFAULT_INPUT_SETTINGS,
  normalizeInputSettings,
  updateBinding,
  updateInputTiming,
} from '../src/input/settings';
import type { Cell, GameInput, PendingGarbage } from '../src/game/types';
import type { OnlineGameSnapshot, OnlinePlayer, OnlinePlayerStatus } from '../src/online/protocol';

describe('core stacker engine', () => {
  it('creates deterministic 7-bags with all pieces once', () => {
    const bagA = createShuffledBag(new SeededRng(1234));
    const bagB = createShuffledBag(new SeededRng(1234));
    expect(bagA).toEqual(bagB);
    expect(new Set(bagA).size).toBe(7);
    expect([...bagA].sort()).toEqual(['I', 'J', 'L', 'O', 'S', 'T', 'Z']);
  });

  it('maps the custom default preset into playable rules', () => {
    const settings = normalizeCustomSettings({});
    const rules = customRulesFromSettings(settings, DEFAULT_INPUT_SETTINGS);

    expect(settings).toMatchObject({
      ...CUSTOM_DEFAULT_SETTINGS,
      useRandomSeed: true,
      seed: 0,
      boardWidth: 10,
      boardHeight: 20,
      gravity: 0.02,
      lockDelayFrames: 30,
    });
    expect(rules).toMatchObject({
      boardWidth: 10,
      visibleRows: 20,
      nextPreview: 5,
      targetLines: null,
      gravityCellsPerFrame: 0.02,
      lockDelayFrames: 30,
      allowHardDrop: true,
      allowHold: true,
      showGhost: true,
      infiniteHold: false,
      infiniteMovement: false,
    });
  });

  it('applies custom control toggles inside the engine', () => {
    const custom = normalizeCustomSettings({
      useHardDrop: false,
      useHoldQueue: false,
      showShadowPiece: false,
    });
    const engine = new GameEngine(9, customRulesFromSettings(custom, DEFAULT_INPUT_SETTINGS));
    const state = engine.tick(1, [
      { frame: 1, action: 'hardDrop' },
      { frame: 1, action: 'hold' },
    ]);

    expect(state.stats.pieces).toBe(0);
    expect(state.hold).toBeNull();
    expect(state.canHold).toBe(false);
    expect(state.ghost).toBeNull();
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

  it('restores an engine snapshot and continues deterministically', () => {
    const inputs: GameInput[] = [
      { frame: 1, action: 'hardDrop' },
      { frame: 2, action: 'moveLeft' },
      { frame: 3, action: 'rotateCW' },
      { frame: 4, action: 'hardDrop' },
    ];
    const source = new GameEngine(2026, BATTLE_RULES);
    source.tick(1, [inputs[0]]);
    source.tick(2, [inputs[1]]);
    const snapshot = source.createSnapshot();
    const expected = source.tick(3, [inputs[2]]);
    const expectedFinal = source.tick(4, [inputs[3]]);

    const restored = new GameEngine(2026, BATTLE_RULES);
    restored.restoreSnapshot(snapshot);
    expect(restored.tick(3, [inputs[2]])).toEqual(expected);
    expect(restored.tick(4, [inputs[3]])).toEqual(expectedFinal);
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

  it('keeps battle mode alive beyond 40 lines', () => {
    const engine = new GameEngine(99, BATTLE_RULES);
    const unsafe = engine as unknown as { lines: number; active: { type: 'O'; x: number; y: number; rotation: 0 }; lockPiece: () => void };
    unsafe.lines = 40;
    unsafe.active = { type: 'O', x: 3, y: 10, rotation: 0 };
    unsafe.lockPiece();

    const state = engine.getState();
    expect(state.stats.lines).toBeGreaterThanOrEqual(40);
    expect(state.stats.targetLines).toBeNull();
    expect(state.status).toBe('playing');
  });

  it('adds garbage rows with a hole and preserves board height', () => {
    const board = createBoard(4, 4);
    board[3][0] = 'I';
    const result = addGarbageLines(board, 4, 2, 1);

    expect(result.toppedOut).toBe(false);
    expect(result.board).toHaveLength(4);
    expect(result.board[2]).toEqual(['Z', null, 'Z', 'Z']);
    expect(result.board[3]).toEqual(['Z', null, 'Z', 'Z']);
  });

  it('tops out when garbage pushes blocks out of the board', () => {
    const engine = new GameEngine(7, { ...BATTLE_RULES, garbageDelayFrames: 0 });
    const unsafe = engine as unknown as { board: Cell[][]; active: null };
    unsafe.active = null;
    unsafe.board[0][0] = 'T';

    engine.queueGarbage(1, 4, 1, 'topout-test');
    const state = engine.tick(1);

    expect(state.status).toBe('gameover');
    expect(state.stats.gameOverFrame).toBe(1);
  });

  it('calculates basic battle attacks from line clears', () => {
    expect(attackLinesForClear(1)).toBe(0);
    expect(attackLinesForClear(2)).toBe(1);
    expect(attackLinesForClear(3)).toBe(2);
    expect(attackLinesForClear(4)).toBe(4);
  });

  it('keeps the simple attack table compatible with current battle damage', () => {
    expect(calculateAttack({
      table: 'simple',
      cleared: 4,
      combo: 6,
      b2b: 3,
      perfectClear: true,
    })).toMatchObject({
      attackLines: 4,
      comboBonus: 0,
      b2bBonus: 0,
      perfectClearBonus: 0,
    });
  });

  it('calculates modern combo, B2B, and perfect clear bonuses', () => {
    expect(calculateAttack({
      table: 'modern',
      cleared: 4,
      combo: 2,
      b2b: 2,
      perfectClear: true,
    })).toMatchObject({
      baseLines: 4,
      comboBonus: 1,
      b2bBonus: 1,
      perfectClearBonus: 10,
      attackLines: 16,
    });
  });

  it('increments combo on consecutive clears and cuts it on empty locks', () => {
    expect(nextCombo(-1, 2)).toBe(0);
    expect(nextCombo(0, 1)).toBe(1);
    expect(nextCombo(1, 0)).toBe(-1);
    expect(nextCombo(-1, 4)).toBe(0);
  });

  it('increments B2B on quads and cuts it on easy line clears', () => {
    expect(nextBackToBack(0, 4)).toBe(1);
    expect(nextBackToBack(1, 4)).toBe(2);
    expect(nextBackToBack(2, 0)).toBe(2);
    expect(nextBackToBack(2, 2)).toBe(0);
  });

  it('emits one line clear event with outgoing attack lines', () => {
    const engine = new GameEngine(11, {
      ...BATTLE_RULES,
      boardWidth: 4,
      visibleRows: 4,
      hiddenRows: 0,
      nextPreview: 1,
    });
    const unsafe = engine as unknown as {
      board: Cell[][];
      active: { type: 'O'; x: number; y: number; rotation: 0 };
      lockPiece: () => void;
    };
    unsafe.board = createBoard(4, 4);
    unsafe.board[2] = ['I', null, null, 'I'];
    unsafe.board[3] = ['I', null, null, 'I'];
    unsafe.active = { type: 'O', x: 0, y: 2, rotation: 0 };

    unsafe.lockPiece();
    const events = engine.drainEvents();

    expect(events).toEqual([{
      type: 'lineClear',
      frame: 0,
      cleared: 2,
      difficult: false,
      spin: 'none',
      piece: 'O',
      perfectClear: true,
      combo: 0,
      b2b: 0,
      attackLines: 1,
      outgoingLines: 1,
    }]);
    expect(engine.drainEvents()).toEqual([]);
  });

  it('emits modern combo and B2B attack lines from consecutive quads', () => {
    const engine = new GameEngine(12, {
      ...BATTLE_RULES,
      attackTable: 'modern',
      boardWidth: 4,
      visibleRows: 5,
      hiddenRows: 0,
      nextPreview: 1,
    });
    const unsafe = engine as unknown as {
      board: Cell[][];
      active: { type: 'I'; x: number; y: number; rotation: 1 };
      lockPiece: () => void;
    };
    const prepareQuad = () => {
      unsafe.board = createBoard(4, 5);
      unsafe.board[0] = [null, 'Z', null, null];
      unsafe.board[1] = [null, 'Z', 'Z', 'Z'];
      unsafe.board[2] = [null, 'Z', 'Z', 'Z'];
      unsafe.board[3] = [null, 'Z', 'Z', 'Z'];
      unsafe.board[4] = [null, 'Z', 'Z', 'Z'];
      unsafe.active = { type: 'I', x: -2, y: 1, rotation: 1 };
    };

    prepareQuad();
    unsafe.lockPiece();
    prepareQuad();
    unsafe.lockPiece();

    expect(engine.drainEvents()).toEqual([
      {
        type: 'lineClear',
        frame: 0,
        cleared: 4,
        difficult: true,
        spin: 'none',
        piece: 'I',
        perfectClear: false,
        combo: 0,
        b2b: 1,
        attackLines: 4,
        outgoingLines: 4,
      },
      {
        type: 'lineClear',
        frame: 0,
        cleared: 4,
        difficult: true,
        spin: 'none',
        piece: 'I',
        perfectClear: false,
        combo: 1,
        b2b: 2,
        attackLines: 6,
        outgoingLines: 6,
      },
    ]);
    expect(engine.getState().stats.sentGarbage).toBe(10);
    expect(engine.getState().stats.combo).toBe(1);
    expect(engine.getState().stats.b2b).toBe(2);
  });

  it('detects a full T-Spin line clear after a rotation candidate', () => {
    const engine = new GameEngine(15, {
      ...BATTLE_RULES,
      attackTable: 'modern',
      boardWidth: 4,
      visibleRows: 4,
      hiddenRows: 0,
      nextPreview: 1,
    });
    const unsafe = engine as unknown as {
      board: Cell[][];
      active: { type: 'T'; x: number; y: number; rotation: 0 };
      spinCandidate: boolean;
      lockPiece: () => void;
    };
    unsafe.board = createBoard(4, 4);
    unsafe.board[1] = ['Z', null, 'Z', null];
    unsafe.board[2] = [null, null, null, 'Z'];
    unsafe.board[3] = ['Z', null, null, null];
    unsafe.active = { type: 'T', x: 0, y: 1, rotation: 0 };
    unsafe.spinCandidate = true;

    unsafe.lockPiece();

    expect(engine.drainEvents()).toEqual([{
      type: 'lineClear',
      frame: 0,
      cleared: 1,
      difficult: true,
      spin: 'full',
      piece: 'T',
      perfectClear: false,
      combo: 0,
      b2b: 1,
      attackLines: 2,
      outgoingLines: 2,
    }]);
  });

  it('adds the modern perfect clear bonus when the board empties after a clear', () => {
    const engine = new GameEngine(13, {
      ...BATTLE_RULES,
      attackTable: 'modern',
      boardWidth: 4,
      visibleRows: 2,
      hiddenRows: 0,
      nextPreview: 1,
    });
    const unsafe = engine as unknown as {
      board: Cell[][];
      active: { type: 'O'; x: number; y: number; rotation: 0 };
      lockPiece: () => void;
    };
    unsafe.board = createBoard(4, 2);
    unsafe.board[0] = [null, null, 'Z', 'Z'];
    unsafe.board[1] = [null, null, 'Z', 'Z'];
    unsafe.active = { type: 'O', x: -1, y: 0, rotation: 0 };

    unsafe.lockPiece();

    expect(engine.drainEvents()).toEqual([{
      type: 'lineClear',
      frame: 0,
      cleared: 2,
      difficult: false,
      spin: 'none',
      piece: 'O',
      perfectClear: true,
      combo: 0,
      b2b: 0,
      attackLines: 11,
      outgoingLines: 11,
    }]);
  });

  it('cancels incoming garbage before sending outgoing attack', () => {
    const resolved = resolveAttack(4, [{
      id: 'incoming-1',
      lines: 3,
      holeColumn: 2,
      receivedFrame: 10,
      applyFrame: 100,
    }]);

    expect(resolved.cancelledLines).toBe(3);
    expect(resolved.outgoingAfterCancel).toBe(1);
    expect(resolved.remainingIncoming).toEqual([]);
  });

  it('caps pending garbage when garbageCap is configured', () => {
    const engine = new GameEngine(14, {
      ...BATTLE_RULES,
      garbageCap: 5,
      garbageDelayFrames: 90,
    });

    engine.queueGarbage(4, 1, 1, 'cap-a');
    engine.queueGarbage(4, 2, 2, 'cap-b');
    const events = engine.drainEvents();

    expect(engine.getState().stats.pendingGarbage).toBe(5);
    expect(engine.getState().stats.receivedGarbage).toBe(5);
    expect(events).toEqual([
      { type: 'incomingGarbage', frame: 1, lines: 4 },
      { type: 'incomingGarbage', frame: 2, lines: 1 },
    ]);
  });

  it('keeps clean garbage holes when messiness is zero', () => {
    const engine = new GameEngine(14, {
      ...BATTLE_RULES,
      garbageMessinessPercent: 0,
      changeOnAttack: true,
    });

    engine.queueGarbage(2, 1, 1, 'clean-a');
    engine.queueGarbage(2, 2, 2, 'clean-b');
    const pending = (engine as unknown as { pendingGarbage: PendingGarbage[] }).pendingGarbage;

    expect(pending).toHaveLength(2);
    expect(pending[1].holeColumn).toBe(pending[0].holeColumn);
  });

  it('changes garbage holes by attack when changeOnAttack is enabled', () => {
    const engine = new GameEngine(14, {
      ...BATTLE_RULES,
      garbageMessinessPercent: 100,
      changeOnAttack: true,
    });
    const firstSeed = 1;
    let secondSeed = 2;
    while (garbageHoleColumn(secondSeed, BATTLE_RULES.boardWidth) === garbageHoleColumn(firstSeed, BATTLE_RULES.boardWidth)) {
      secondSeed += 1;
    }

    engine.queueGarbage(2, firstSeed, 1, 'messy-a');
    engine.queueGarbage(2, secondSeed, 2, 'messy-b');
    const pending = (engine as unknown as { pendingGarbage: PendingGarbage[] }).pendingGarbage;

    expect(pending).toHaveLength(2);
    expect(pending[1].holeColumn).not.toBe(pending[0].holeColumn);
  });

  it('applies continuous garbage one line per frame', () => {
    const engine = new GameEngine(14, {
      ...BATTLE_RULES,
      garbageDelayFrames: 0,
      garbageTravelFrames: 0,
      garbageActivationFrames: 0,
      continuousGarbage: true,
    });

    engine.queueGarbage(3, 1, 0, 'continuous-a');
    engine.drainEvents();
    engine.tick(0);
    const firstFrameEvents = engine.drainEvents();
    engine.tick(1);
    const secondFrameEvents = engine.drainEvents();

    expect(firstFrameEvents).toContainEqual({ type: 'appliedGarbage', frame: 0, lines: 1 });
    expect(engine.getState().stats.pendingGarbage).toBe(1);
    expect(secondFrameEvents).toContainEqual({ type: 'appliedGarbage', frame: 1, lines: 1 });
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

  it('reuses DAS and ARR timing for held touch controls', () => {
    const input = new InputController({
      ...DEFAULT_INPUT_SETTINGS,
      dasFrames: 2,
      arrFrames: 1,
    }, null);

    input.pressControl('touch:1', 'moveLeft');
    input.advanceFrame(1);
    expect(input.collect(1)).toEqual([{ frame: 0, action: 'moveLeft' }]);

    input.advanceFrame(2);
    expect(input.collect(2)).toEqual([]);

    input.advanceFrame(3);
    expect(input.collect(3)).toEqual([{ frame: 3, action: 'moveLeft' }]);

    input.advanceFrame(4);
    expect(input.collect(4)).toEqual([{ frame: 4, action: 'moveLeft' }]);
  });

  it('processes repeatable controls on press and again after the held debounce', () => {
    const input = new InputController({
      ...DEFAULT_INPUT_SETTINGS,
      dasFrames: 2,
      arrFrames: 2,
    }, null);

    input.pressControl('key:ArrowLeft', 'moveLeft');
    input.advanceFrame(1);
    expect(input.collect(1)).toEqual([{ frame: 0, action: 'moveLeft' }]);

    input.advanceFrame(2);
    expect(input.collect(2)).toEqual([]);

    input.advanceFrame(3);
    expect(input.collect(3)).toEqual([{ frame: 3, action: 'moveLeft' }]);

    input.advanceFrame(4);
    expect(input.collect(4)).toEqual([]);

    input.advanceFrame(5);
    expect(input.collect(5)).toEqual([{ frame: 5, action: 'moveLeft' }]);
  });

  it('keeps rotation controls from repeating while held', () => {
    const input = new InputController({
      ...DEFAULT_INPUT_SETTINGS,
      dasFrames: 1,
      arrFrames: 1,
    }, null);

    input.pressControl('key:ArrowUp', 'rotateCW');
    input.advanceFrame(1);
    expect(input.collect(1)).toEqual([{ frame: 0, action: 'rotateCW' }]);

    input.advanceFrame(2);
    expect(input.collect(2)).toEqual([]);

    input.advanceFrame(3);
    expect(input.collect(3)).toEqual([]);
  });

  it('keeps one-shot controls from repeating while held', () => {
    const input = new InputController({
      ...DEFAULT_INPUT_SETTINGS,
      dasFrames: 1,
      arrFrames: 1,
    }, null);

    input.pressControl('key:Space', 'hardDrop');
    input.advanceFrame(1);
    expect(input.collect(1)).toEqual([{ frame: 0, action: 'hardDrop' }]);

    input.advanceFrame(2);
    expect(input.collect(2)).toEqual([]);

    input.advanceFrame(3);
    expect(input.collect(3)).toEqual([]);
  });

  it('stops held touch controls on release or pointer cancel', () => {
    const input = new InputController({
      ...DEFAULT_INPUT_SETTINGS,
      dasFrames: 1,
      arrFrames: 1,
    }, null);

    input.pressControl('touch:7', 'moveRight');
    input.advanceFrame(1);
    expect(input.collect(1)).toEqual([{ frame: 0, action: 'moveRight' }]);

    input.releaseControl('touch:7');
    input.advanceFrame(2);
    expect(input.collect(2)).toEqual([]);
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

  it('creates short readable online room codes', () => {
    expect(createRoomCode(() => 0)).toBe('AAAA');
    expect(createRoomCode(() => 0.999)).toHaveLength(4);
    expect(createRoomCode(() => 0.5)).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
  });

  it('simulates remote player inputs on the host authority engine', () => {
    const simulator = new HostAuthoritySimulator(1234, BATTLE_RULES);
    simulator.ensurePlayers(['player-guest-sim']);
    simulator.pushInputs('player-guest-sim', [{ frame: 1, action: 'hardDrop' }]);

    const [update] = simulator.advanceAll(1);

    expect(update.playerId).toBe('player-guest-sim');
    expect(update.state.stats.pieces).toBe(1);
    expect(simulator.getState('player-guest-sim')?.stats.pieces).toBe(1);
  });

  it('applies late remote inputs on the next host-authoritative frame', () => {
    const simulator = new HostAuthoritySimulator(1234, BATTLE_RULES);
    simulator.ensurePlayers(['player-guest-late']);
    simulator.advanceAll(10);
    simulator.pushInputs('player-guest-late', [{ frame: 1, action: 'hardDrop' }]);

    simulator.advanceAll(10);
    expect(simulator.getState('player-guest-late')?.stats.pieces).toBe(0);

    simulator.advanceAll(11);
    expect(simulator.getState('player-guest-late')?.stats.pieces).toBe(1);
  });

  it('reports the last processed remote input sequence from the host simulation', () => {
    const simulator = new HostAuthoritySimulator(1234, BATTLE_RULES);
    simulator.ensurePlayers(['player-guest-seq']);
    simulator.pushInputs('player-guest-seq', [{ frame: 1, action: 'hardDrop', sequence: 7 }]);

    const [update] = simulator.advanceAll(1);

    expect(update.lastProcessedInputSequence).toBe(7);
    expect(simulator.getLastProcessedInputSequence('player-guest-seq')).toBe(7);
  });

  it('keeps local prediction while own online inputs are still pending', () => {
    const local = new GameEngine(321, BATTLE_RULES);
    const snapshot = local.createSnapshot();

    expect(shouldReconcileLocalEngineSnapshot(local.getState(), {
      ...createOnlineGameSnapshotFixture(local),
      engine: snapshot,
      status: 'playing',
    }, 1)).toBe(false);

    expect(shouldReconcileLocalEngineSnapshot(local.getState(), {
      ...createOnlineGameSnapshotFixture(local),
      engine: snapshot,
      status: 'gameover',
    }, 1)).toBe(true);
  });

  it('preserves pending input timing when replaying after reconciliation', () => {
    expect(frameForPendingInputReplay({ frame: 24, action: 'moveLeft', sequence: 1 }, 10)).toBe(24);
    expect(frameForPendingInputReplay({ frame: 4, action: 'moveLeft', sequence: 2 }, 10)).toBe(11);
  });

  it('lists public online rooms but keeps private rooms hidden', async () => {
    const store = new MemoryRoomStore();
    const publicRoom = await createRoom(store, {
      playerId: 'player-public-1',
      name: 'Public',
      visibility: 'public',
    }, 1000);
    await createRoom(store, {
      playerId: 'player-private-1',
      name: 'Private',
      visibility: 'private',
    }, 2000);

    const rooms = await listPublicRooms(store, 2500);

    expect(rooms).toHaveLength(1);
    expect(rooms[0].id).toBe(publicRoom.id);
    expect(rooms[0].hostName).toBe('Public');
    expect(rooms[0].region).toBe('gru1');
    expect(rooms[0].ranked).toBe(false);
    expect(rooms[0].customPreset).toBeNull();
  });

  it('filters public online rooms by match type and ranked flag', async () => {
    const store = new MemoryRoomStore();
    await createRoom(store, {
      playerId: 'player-filter-battle',
      name: 'Battle',
      visibility: 'public',
      matchType: 'battle',
    }, 1000);
    const league = await createRoom(store, {
      playerId: 'player-filter-league',
      name: 'League',
      visibility: 'public',
      matchType: 'league',
    }, 1100);

    const rankedRooms = await listPublicRooms(store, 1200, { ranked: true });
    const leagueRooms = await listPublicRooms(store, 1200, { matchType: 'league' });

    expect(rankedRooms.map((room) => room.id)).toEqual([league.id]);
    expect(leagueRooms.map((room) => room.id)).toEqual([league.id]);
    expect(leagueRooms[0].matchType).toBe('league');
    expect(leagueRooms[0].ranked).toBe(true);
  });

  it('matches two players through Quick Duel into a private duel countdown room', async () => {
    const store = new MemoryRoomStore();
    const first = await enqueueMatchmaking(store, {
      playerId: 'player-quick-duel-a',
      name: 'A',
    }, 1000);
    const second = await enqueueMatchmaking(store, {
      playerId: 'player-quick-duel-b',
      name: 'B',
    }, 1500);

    expect(first.room).toBeNull();
    expect(first.ticket.status).toBe('queued');
    expect(second.ticket.status).toBe('matched');
    expect(second.room).not.toBeNull();
    expect(second.room?.visibility).toBe('private');
    expect(second.room?.matchType).toBe('duel');
    expect(second.room?.status).toBe('countdown');
    expect(second.room?.players.map((player) => player.ready)).toEqual([true, true]);

    const firstTicket = await heartbeatMatchmaking(store, {
      ticketId: first.ticket.id,
      playerId: 'player-quick-duel-a',
    }, 1600);
    expect(firstTicket.ticket.status).toBe('matched');
    expect(firstTicket.room?.id).toBe(second.room?.id);
  });

  it('matches two players through League matchmaking into a ranked league room', async () => {
    const store = new MemoryRoomStore();
    const first = await enqueueMatchmaking(store, {
      queue: 'league',
      playerId: 'player-league-queue-a',
      name: 'A',
    }, 1000);
    const second = await enqueueMatchmaking(store, {
      queue: 'league',
      playerId: 'player-league-queue-b',
      name: 'B',
    }, 1500);

    expect(first.ticket.rating).toBe(1000);
    expect(second.ticket.status).toBe('matched');
    expect(second.room?.matchType).toBe('league');
    expect(second.room?.ruleset.ranked).toBe(true);
    expect(second.room?.series?.firstTo).toBe(3);
  });

  it('lets players enter and reenter the persistent Quick Play lobby', async () => {
    const store = new MemoryRoomStore();
    const first = await enterQuickPlay(store, {
      playerId: 'player-quickplay-a',
      name: 'A',
    }, 1000);
    const second = await enterQuickPlay(store, {
      playerId: 'player-quickplay-b',
      name: 'B',
    }, 1100);

    expect(first.room.id).toBe('QPLY');
    expect(second.room.id).toBe(first.room.id);
    expect(second.room.matchType).toBe('quickPlay');
    expect(second.room.players.map((player) => player.id)).toEqual(['player-quickplay-a', 'player-quickplay-b']);

    await getRoomState(store, first.room.id, 7000);
    const eliminated = await eliminatePlayer(store, {
      roomId: first.room.id,
      authorityPlayerId: 'player-quickplay-a',
      playerId: 'player-quickplay-b',
      frame: 360,
      lines: 12,
      pieces: 30,
      elapsedFrames: 360,
      sentGarbage: 4,
      receivedGarbage: 8,
    }, 7100);

    expect(eliminated.status).toBe('playing');
    expect(eliminated.winnerPlayerId).toBeNull();
    expect(eliminated.players.find((player) => player.id === 'player-quickplay-b')?.status).toBe('eliminated');

    const reentered = await enterQuickPlay(store, {
      playerId: 'player-quickplay-b',
      name: 'B Again',
    }, 7200);
    const player = reentered.room.players.find((candidate) => candidate.id === 'player-quickplay-b');
    expect(reentered.room.id).toBe(first.room.id);
    expect(player).toMatchObject({
      name: 'B Again',
      alive: true,
      status: 'ready',
      lines: 0,
    });
  });

  it('updates the weekly Quick Play leaderboard from progress and eliminations', async () => {
    const store = new MemoryRoomStore();
    const joined = await enterQuickPlay(store, {
      playerId: 'player-quickplay-score',
      name: 'Scorer',
    }, Date.UTC(2026, 5, 6));
    await getRoomState(store, joined.room.id, Date.UTC(2026, 5, 6) + 6000);
    await updateProgress(store, {
      roomId: joined.room.id,
      authorityPlayerId: 'player-quickplay-score',
      playerId: 'player-quickplay-score',
      lines: 20,
      pieces: 50,
      elapsedFrames: 1800,
      sentGarbage: 10,
      receivedGarbage: 5,
    }, Date.UTC(2026, 5, 6) + 7000);

    const leaderboard = await getQuickPlayLeaderboard(store, '2026-06-01');

    expect(leaderboard[0]).toMatchObject({
      playerId: 'player-quickplay-score',
      displayName: 'Scorer',
      lines: 20,
      sentGarbage: 10,
    });
    expect(leaderboard[0].score).toBeGreaterThan(0);
  });

  it('stores custom online room rules while keeping online survival as the objective', async () => {
    const store = new MemoryRoomStore();
    const rules = {
      ...BATTLE_RULES,
      boardWidth: 12,
      visibleRows: 22,
      gravityCellsPerFrame: 0.02,
      targetLines: 40,
    };

    const room = await createRoom(store, {
      playerId: 'player-custom-1',
      name: 'Custom',
      visibility: 'private',
      mode: 'custom',
      rules,
    }, 1000);

    expect(room.mode).toBe('custom');
    expect(room.rules.boardWidth).toBe(12);
    expect(room.rules.visibleRows).toBe(22);
    expect(room.rules.gravityCellsPerFrame).toBe(0.02);
    expect(room.rules.targetLines).toBeNull();
  });

  it('creates versioned online rulesets for new match types', async () => {
    const store = new MemoryRoomStore();
    const duel = await createRoom(store, {
      playerId: 'player-duel-1',
      name: 'Duel',
      visibility: 'private',
      matchType: 'duel',
    }, 1000);
    const league = await createRoom(store, {
      playerId: 'player-league-1',
      name: 'League',
      visibility: 'private',
      matchType: 'league',
    }, 1100);

    expect(duel.mode).toBe('battle');
    expect(duel.matchType).toBe('duel');
    expect(duel.ruleset).toMatchObject({
      rulesetId: 'duel-ft3-simple',
      rulesetVersion: 1,
      objective: { type: 'duelRounds', firstTo: 3 },
      attackTable: 'simple',
      targeting: 'random',
      ranked: false,
    });
    expect(league.ruleset.ranked).toBe(true);
    expect(league.ruleset.objective).toEqual({ type: 'duelRounds', firstTo: 3 });
  });

  it('maps online objectives to engine target lines only for sprint races', async () => {
    const store = new MemoryRoomStore();
    const sprint = await createRoom(store, {
      playerId: 'player-sprint-1',
      name: 'Sprint',
      visibility: 'public',
      matchType: 'sprintRace',
    }, 1000);
    const royale = await createRoom(store, {
      playerId: 'player-royale-1',
      name: 'Royale',
      visibility: 'public',
      matchType: 'royale',
    }, 1100);

    expect(sprint.ruleset.objective).toEqual({ type: 'sprint', targetLines: 40 });
    expect(sprint.rules.targetLines).toBe(40);
    expect(royale.ruleset.objective).toEqual({ type: 'lastStanding' });
    expect(royale.rules.targetLines).toBeNull();
  });

  it('finishes a sprint race when the first player submits a clear result', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-sprint-host',
      name: 'Host',
      visibility: 'private',
      matchType: 'sprintRace',
    }, 1000);
    await joinRoom(store, { roomId: room.id, playerId: 'player-sprint-guest', name: 'Guest' }, 1100);

    const finished = await submitResult(store, {
      roomId: room.id,
      authorityPlayerId: 'player-sprint-host',
      playerId: 'player-sprint-guest',
      result: 'won',
      lines: 40,
      pieces: 101,
      elapsedFrames: 3200,
    }, 5000);

    expect(finished.status).toBe('finished');
    expect(finished.winnerPlayerId).toBe('player-sprint-guest');
    expect(finished.players.find((player) => player.id === 'player-sprint-guest')?.status).toBe('won');
    expect(finished.players.find((player) => player.id === 'player-sprint-host')?.status).toBe('lost');
  });

  it('accumulates duel rounds in the same room until first-to is reached', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-duel-host',
      name: 'Host',
      visibility: 'private',
      matchType: 'duel',
    }, 1000);
    await joinRoom(store, { roomId: room.id, playerId: 'player-duel-guest', name: 'Guest' }, 1100);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-duel-host', ready: true }, 1200);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-duel-guest', ready: true }, 1200);
    const started = await startRoom(store, { roomId: room.id, playerId: 'player-duel-host' }, 1300);

    expect(started.series).toMatchObject({
      objective: 'duelRounds',
      firstTo: 3,
      currentRound: 1,
      completed: false,
    });

    let playing = await getRoomState(store, room.id, 7000);
    const firstRound = await eliminatePlayer(store, {
      roomId: room.id,
      authorityPlayerId: 'player-duel-host',
      playerId: 'player-duel-guest',
      frame: 300,
      lines: 10,
      pieces: 20,
      elapsedFrames: 300,
    }, 7100);

    expect(playing.status).toBe('playing');
    expect(firstRound.status).toBe('countdown');
    expect(firstRound.winnerPlayerId).toBeNull();
    expect(firstRound.series?.currentRound).toBe(2);
    expect(firstRound.series?.scores.find((score) => score.playerId === 'player-duel-host')?.wins).toBe(1);
    expect(firstRound.series?.rounds).toHaveLength(1);
    expect(firstRound.players.every((player) => player.alive && player.status === 'ready')).toBe(true);

    playing = await getRoomState(store, room.id, 13000);
    const secondRound = await eliminatePlayer(store, {
      roomId: room.id,
      authorityPlayerId: 'player-duel-host',
      playerId: 'player-duel-guest',
      frame: 280,
      lines: 12,
      pieces: 18,
      elapsedFrames: 280,
    }, 13100);

    expect(playing.status).toBe('playing');
    expect(secondRound.status).toBe('countdown');
    expect(secondRound.series?.currentRound).toBe(3);
    expect(secondRound.series?.scores.find((score) => score.playerId === 'player-duel-host')?.wins).toBe(2);

    await getRoomState(store, room.id, 19000);
    const finished = await eliminatePlayer(store, {
      roomId: room.id,
      authorityPlayerId: 'player-duel-host',
      playerId: 'player-duel-guest',
      frame: 260,
      lines: 14,
      pieces: 16,
      elapsedFrames: 260,
    }, 19100);

    expect(finished.status).toBe('finished');
    expect(finished.winnerPlayerId).toBe('player-duel-host');
    expect(finished.series).toMatchObject({
      completed: true,
      winnerPlayerId: 'player-duel-host',
    });
    expect(finished.series?.rounds).toHaveLength(3);
  });

  it('stores casual duel results without changing rating', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-casual-host',
      name: 'Host',
      visibility: 'private',
      matchType: 'duel',
      ruleset: {
        rulesetId: 'duel-ft1-simple',
        rulesetVersion: 1,
        objective: { type: 'duelRounds', firstTo: 1 },
        attackTable: 'simple',
        targeting: 'random',
        ranked: false,
      },
    }, 1000);
    await joinRoom(store, { roomId: room.id, playerId: 'player-casual-guest', name: 'Guest' }, 1100);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-casual-host', ready: true }, 1200);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-casual-guest', ready: true }, 1200);
    await startRoom(store, { roomId: room.id, playerId: 'player-casual-host' }, 1300);
    await getRoomState(store, room.id, 7000);

    const finished = await eliminatePlayer(store, {
      roomId: room.id,
      authorityPlayerId: 'player-casual-host',
      playerId: 'player-casual-guest',
      frame: 240,
      lines: 8,
      pieces: 16,
      elapsedFrames: 240,
    }, 7100);

    const hostProfile = await store.getProfile('player-casual-host');
    const [resultId] = await store.listMatchResultIds('player-casual-host');
    const result = await store.getMatchResult(resultId);

    expect(finished.matchResultId).toBe(resultId);
    expect(hostProfile?.rating.value).toBe(1000);
    expect(hostProfile?.casualStats.played).toBe(1);
    expect(hostProfile?.leagueStats.played).toBe(0);
    expect(result?.ranked).toBe(false);
    expect(result?.participants.find((participant) => participant.playerId === 'player-casual-host')?.ratingAfter).toBeNull();
  });

  it('updates league Elo only when the ranked series completes', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-league-host',
      name: 'Host',
      visibility: 'private',
      matchType: 'league',
      ruleset: {
        rulesetId: 'league-ft1-simple',
        rulesetVersion: 1,
        objective: { type: 'duelRounds', firstTo: 1 },
        attackTable: 'simple',
        targeting: 'random',
        ranked: true,
      },
    }, 1000);
    await joinRoom(store, { roomId: room.id, playerId: 'player-league-guest', name: 'Guest' }, 1100);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-league-host', ready: true }, 1200);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-league-guest', ready: true }, 1200);
    await startRoom(store, { roomId: room.id, playerId: 'player-league-host' }, 1300);
    await getRoomState(store, room.id, 7000);

    const finished = await eliminatePlayer(store, {
      roomId: room.id,
      authorityPlayerId: 'player-league-host',
      playerId: 'player-league-guest',
      frame: 240,
      lines: 8,
      pieces: 16,
      elapsedFrames: 240,
    }, 7100);

    const hostProfile = await store.getProfile('player-league-host');
    const guestProfile = await store.getProfile('player-league-guest');
    const [resultId] = await store.listMatchResultIds('player-league-host');
    const result = await store.getMatchResult(resultId);

    expect(finished.matchResultId).toBe(resultId);
    expect(hostProfile?.rating.value).toBe(1016);
    expect(guestProfile?.rating.value).toBe(984);
    expect(hostProfile?.leagueStats.played).toBe(1);
    expect(hostProfile?.casualStats.played).toBe(0);
    expect(result?.ranked).toBe(true);
    expect(result?.participants.find((participant) => participant.playerId === 'player-league-host')).toMatchObject({
      ratingBefore: 1000,
      ratingAfter: 1016,
    });
  });

  it('returns online profile state with recent persisted match results', async () => {
    const store = new MemoryRoomStore();
    const profileState = await getOnlineProfileState(store, 'player-profile-state', 'Profile', 1000);

    expect(profileState.profile.rating.value).toBe(1000);
    expect(profileState.profile.displayName).toBe('Profile');
    expect(profileState.recentResults).toEqual([]);
  });

  it('rejects invalid explicit online rulesets', async () => {
    const store = new MemoryRoomStore();
    await expect(createRoom(store, {
      playerId: 'player-bad-ruleset',
      name: 'Bad',
      visibility: 'private',
      matchType: 'duel',
      ruleset: {
        rulesetId: 'bad ruleset',
        rulesetVersion: 999,
      },
    }, 1000)).rejects.toThrow('Invalid ruleset id');
  });

  it('lets each player set targeting without gaining host authority', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-target-host',
      name: 'Host',
      visibility: 'private',
    }, 1000);
    await joinRoom(store, { roomId: room.id, playerId: 'player-target-a', name: 'A' }, 1100);
    await joinRoom(store, { roomId: room.id, playerId: 'player-target-b', name: 'B' }, 1200);

    const updated = await setPlayerTargeting(store, {
      roomId: room.id,
      playerId: 'player-target-a',
      targetingMode: 'manual',
      manualTargetPlayerId: 'player-target-b',
    }, 1300);
    const player = updated.players.find((candidate) => candidate.id === 'player-target-a');

    expect(player?.targetingMode).toBe('manual');
    expect(player?.manualTargetPlayerId).toBe('player-target-b');
    await expect(setPlayerTargeting(store, {
      roomId: room.id,
      playerId: 'player-target-a',
      targetingMode: 'manual',
      manualTargetPlayerId: 'player-target-a',
    }, 1400)).rejects.toThrow('Invalid manual target');
  });

  it('updates player danger level from board height and pending garbage', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-danger-host',
      name: 'Host',
      visibility: 'private',
    }, 1000);
    await joinRoom(store, { roomId: room.id, playerId: 'player-danger-target', name: 'Target' }, 1100);
    const board = createBoard(4, 4);
    board[1][0] = 'T';
    board[2][1] = 'T';
    board[3][2] = 'T';
    const game: OnlineGameSnapshot = {
      board,
      active: null,
      visibleRows: 4,
      boardWidth: 4,
      elapsedFrames: 300,
      status: 'playing',
      lines: 4,
      pieces: 12,
      sentGarbage: 0,
      receivedGarbage: 0,
      pendingGarbage: 6,
    };

    const updated = await updateProgress(store, {
      roomId: room.id,
      authorityPlayerId: 'player-danger-host',
      playerId: 'player-danger-target',
      lines: 4,
      pieces: 12,
      elapsedFrames: 300,
      pendingGarbage: 6,
      game,
    }, 1500);

    expect(updated.players.find((player) => player.id === 'player-danger-target')?.dangerLevel).toBeGreaterThanOrEqual(8);
  });

  it('allows only the host to start an online room and keeps the start timestamp fixed', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-host-1',
      name: 'Host',
      visibility: 'public',
    }, 1000);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-host-1', ready: true }, 1200);

    await expect(startRoom(store, { roomId: room.id, playerId: 'player-other-1' }, 1300)).rejects.toThrow('Only the host');

    const started = await startRoom(store, { roomId: room.id, playerId: 'player-host-1' }, 1400);
    const startedAgain = await startRoom(store, { roomId: room.id, playerId: 'player-host-1' }, 9000);

    expect(started.status).toBe('countdown');
    expect(started.startsAtServerMs).toBe(6400);
    expect(startedAgain.startsAtServerMs).toBe(6400);
  });

  it('does not overwrite final online results with late progress', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-host-2',
      name: 'Host',
      visibility: 'private',
    }, 1000);

    await submitResult(store, {
      roomId: room.id,
      authorityPlayerId: 'player-host-2',
      playerId: 'player-host-2',
      result: 'won',
      lines: 40,
      pieces: 100,
      elapsedFrames: 3600,
    }, 5000);
    await updateProgress(store, {
      roomId: room.id,
      authorityPlayerId: 'player-host-2',
      playerId: 'player-host-2',
      lines: 4,
      pieces: 10,
      elapsedFrames: 9999,
    }, 6000);

    const state = await getRoomState(store, room.id, 7000);
    expect(state.players[0].status).toBe('won');
    expect(state.players[0].lines).toBe(40);
    expect(state.players[0].elapsedFrames).toBe(3600);
  });

  it('stores peer connection signals between room players', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-host-3',
      name: 'Host',
      visibility: 'private',
    }, 1000);
    await joinRoom(store, {
      roomId: room.id,
      playerId: 'player-guest-3',
      name: 'Guest',
    }, 1200);

    const signaled = await addPeerSignal(store, {
      roomId: room.id,
      fromPlayerId: 'player-host-3',
      toPlayerId: 'player-guest-3',
      type: 'offer',
      data: { type: 'offer', sdp: 'test' },
    }, 1300);

    expect(signaled.peerSignals).toHaveLength(1);
    expect(signaled.peerSignals[0]).toMatchObject({
      roomId: room.id,
      fromPlayerId: 'player-host-3',
      toPlayerId: 'player-guest-3',
      type: 'offer',
      data: { type: 'offer', sdp: 'test' },
    });
  });

  it('requires host authority for competitive online room updates', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-host-auth',
      name: 'Host',
      visibility: 'private',
    }, 1000);
    await joinRoom(store, {
      roomId: room.id,
      playerId: 'player-guest-auth',
      name: 'Guest',
    }, 1100);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-host-auth', ready: true }, 1200);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-guest-auth', ready: true }, 1200);
    await startRoom(store, { roomId: room.id, playerId: 'player-host-auth' }, 1300);
    await getRoomState(store, room.id, 7000);

    await expect(updateProgress(store, {
      roomId: room.id,
      authorityPlayerId: 'player-guest-auth',
      playerId: 'player-guest-auth',
      lines: 8,
      pieces: 24,
      elapsedFrames: 600,
    }, 7100)).rejects.toThrow('Only the host');

    await expect(addAttack(store, {
      roomId: room.id,
      attackId: 'guest-attack-1',
      authorityPlayerId: 'player-guest-auth',
      fromPlayerId: 'player-guest-auth',
      toPlayerId: 'player-host-auth',
      lines: 2,
      holeSeed: 99,
      frame: 600,
    }, 7200)).rejects.toThrow('Only the host');

    await expect(eliminatePlayer(store, {
      roomId: room.id,
      authorityPlayerId: 'player-guest-auth',
      playerId: 'player-host-auth',
      frame: 620,
      lines: 9,
      pieces: 26,
      elapsedFrames: 620,
    }, 7300)).rejects.toThrow('Only the host');

    const updated = await updateProgress(store, {
      roomId: room.id,
      authorityPlayerId: 'player-host-auth',
      playerId: 'player-guest-auth',
      lines: 8,
      pieces: 24,
      elapsedFrames: 600,
    }, 7400);

    expect(updated.players.find((player) => player.id === 'player-guest-auth')?.lines).toBe(8);
  });

  it('stores attacks once and ignores duplicate attack ids', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-host-4',
      name: 'Host',
      visibility: 'private',
    }, 1000);
    await joinRoom(store, {
      roomId: room.id,
      playerId: 'player-guest-4',
      name: 'Guest',
    }, 1200);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-host-4', ready: true }, 1300);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-guest-4', ready: true }, 1300);
    await startRoom(store, { roomId: room.id, playerId: 'player-host-4' }, 1400);

    const request = {
      roomId: room.id,
      attackId: 'attack-1',
      authorityPlayerId: 'player-host-4',
      fromPlayerId: 'player-host-4',
      toPlayerId: 'player-guest-4',
      lines: 2,
      holeSeed: 99,
      frame: 42,
    };
    const attacked = await addAttack(store, request, 1500);
    const duplicate = await addAttack(store, request, 1600);

    expect(attacked.attacks).toHaveLength(1);
    expect(duplicate.attacks).toHaveLength(1);
    expect(duplicate.attacks[0]).toMatchObject({
      id: 'attack-1',
      authorityPlayerId: 'player-host-4',
      fromPlayerId: 'player-host-4',
      toPlayerId: 'player-guest-4',
      lines: 2,
      holeSeed: 99,
    });
  });

  it('finishes an online battle when only one player remains alive', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-host-5',
      name: 'Host',
      visibility: 'private',
    }, 1000);
    await joinRoom(store, {
      roomId: room.id,
      playerId: 'player-guest-5',
      name: 'Guest',
    }, 1200);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-host-5', ready: true }, 1300);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-guest-5', ready: true }, 1300);
    await startRoom(store, { roomId: room.id, playerId: 'player-host-5' }, 1400);
    await getRoomState(store, room.id, 7000);

    const finished = await eliminatePlayer(store, {
      roomId: room.id,
      authorityPlayerId: 'player-host-5',
      playerId: 'player-guest-5',
      frame: 360,
      lines: 12,
      pieces: 40,
      elapsedFrames: 360,
    }, 7100);

    expect(finished.status).toBe('finished');
    expect(finished.winnerPlayerId).toBe('player-host-5');
    expect(finished.players.find((player) => player.id === 'player-host-5')?.status).toBe('winner');
    expect(finished.players.find((player) => player.id === 'player-guest-5')?.status).toBe('eliminated');
  });

  it('keeps a battle running after one elimination when multiple players remain alive', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-host-6',
      name: 'Host',
      visibility: 'private',
    }, 1000);
    await joinRoom(store, { roomId: room.id, playerId: 'player-guest-6a', name: 'Guest A' }, 1100);
    await joinRoom(store, { roomId: room.id, playerId: 'player-guest-6b', name: 'Guest B' }, 1200);
    for (const playerId of ['player-host-6', 'player-guest-6a', 'player-guest-6b']) {
      await setPlayerReady(store, { roomId: room.id, playerId, ready: true }, 1300);
    }
    await startRoom(store, { roomId: room.id, playerId: 'player-host-6' }, 1400);
    await getRoomState(store, room.id, 7000);

    const updated = await eliminatePlayer(store, {
      roomId: room.id,
      authorityPlayerId: 'player-host-6',
      playerId: 'player-guest-6a',
      frame: 300,
      lines: 6,
      pieces: 20,
      elapsedFrames: 300,
    }, 7100);

    expect(updated.status).toBe('playing');
    expect(updated.winnerPlayerId).toBeNull();
    expect(updated.players.filter((player) => player.alive)).toHaveLength(2);
  });

  it('selects battle targets by explicit targeting mode', () => {
    const source = createOnlinePlayerFixture('source', 'playing', 10, 1000, 0);
    const lowGarbage = {
      ...createOnlinePlayerFixture('low-garbage', 'playing', 4, 900, 0),
      receivedGarbageThisRound: 1,
      receivedGarbage: 3,
    };
    const danger = {
      ...createOnlinePlayerFixture('danger', 'playing', 8, 1100, 0),
      dangerLevel: 9,
      pendingGarbage: 6,
      receivedGarbageThisRound: 6,
    };
    const leader = {
      ...createOnlinePlayerFixture('leader', 'playing', 20, 1200, 0),
      koCount: 2,
      sentGarbage: 12,
      receivedGarbageThisRound: 8,
    };
    const players = [source, lowGarbage, danger, leader];

    expect(selectAttackTarget({
      players,
      sourcePlayerId: 'source',
      attackId: 'attack-even',
      mode: 'even',
    })?.id).toBe('low-garbage');
    expect(selectAttackTarget({
      players,
      sourcePlayerId: 'source',
      attackId: 'attack-ko',
      mode: 'ko',
    })?.id).toBe('danger');
    expect(selectAttackTarget({
      players,
      sourcePlayerId: 'source',
      attackId: 'attack-leader',
      mode: 'leader',
    })?.id).toBe('leader');
    expect(selectAttackTarget({
      players,
      sourcePlayerId: 'source',
      attackId: 'attack-manual',
      mode: 'manual',
      manualTargetPlayerId: 'danger',
    })?.id).toBe('danger');
    expect(selectAttackTarget({
      players,
      sourcePlayerId: 'source',
      attackId: 'attack-attackers',
      mode: 'attackers',
      recentAttackers: ['low-garbage', 'leader'],
    })?.id).toBe('leader');
  });

  it('ranks online players by result, elapsed frames, lines, and finish timestamp', () => {
    const ranked = rankPlayers([
      createOnlinePlayerFixture('lost-low', 'lost', 18, 5000, 10_000),
      createOnlinePlayerFixture('won-slow', 'won', 40, 4200, 9000),
      createOnlinePlayerFixture('won-fast', 'won', 40, 3600, 8000),
      createOnlinePlayerFixture('lost-high', 'lost', 24, 6200, 11_000),
    ]);

    expect(ranked.map((player) => player.id)).toEqual(['won-fast', 'won-slow', 'lost-high', 'lost-low']);
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

function createOnlineGameSnapshotFixture(engine: GameEngine) {
  const state = engine.getState();
  return {
    board: state.board,
    active: state.active,
    visibleRows: BATTLE_RULES.visibleRows,
    boardWidth: BATTLE_RULES.boardWidth,
    elapsedFrames: displayedElapsedFrames(state.stats),
  };
}

function createOnlinePlayerFixture(
  id: string,
  status: OnlinePlayerStatus,
  lines: number,
  elapsedFrames: number,
  finishedAtServerMs: number,
): OnlinePlayer {
  return {
    id,
    name: id,
    ready: true,
    status,
    lines,
    pieces: 100,
    elapsedFrames,
    sentGarbage: 0,
    receivedGarbage: 0,
    pendingGarbage: 0,
    alive: status !== 'lost' && status !== 'eliminated',
    updatedAtServerMs: finishedAtServerMs,
    finishedAtServerMs,
    eliminatedAtFrame: status === 'lost' || status === 'eliminated' ? elapsedFrames : null,
    eliminatedAtServerMs: status === 'lost' || status === 'eliminated' ? finishedAtServerMs : null,
    game: null,
    targetingMode: 'random',
    manualTargetPlayerId: null,
    currentTargetPlayerId: null,
    recentAttackers: [],
    koCount: 0,
    receivedGarbageThisRound: 0,
    dangerLevel: 0,
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
