import { describe, expect, it, vi } from 'vitest';
import { importReplayJson, importReplayValue } from '../src/app/replayImport';
import { createExportedReplay, replayFileName } from '../src/app/replayExport';
import { ReplayPlayback } from '../src/app/replayPlayback';
import {
  CUSTOM_DEFAULT_SETTINGS,
  customRulesFromSettings,
  normalizeCustomSettings,
} from '../src/app/customSettings';
import { soundCueForRunProgress } from '../src/app/runEffects';
import {
  createRunHistoryEntry,
  deleteRunHistoryEntry,
  loadRunHistory,
  MAX_RUN_HISTORY_ENTRIES,
  saveRunHistoryEntry,
  type HistoryStorage,
} from '../src/app/runHistory';
import { canAdvanceGame, canCommitLocalOnlineTerminal, requiresRunConfirmation, togglePauseMode } from '../src/app/state';
import { createShuffledBag } from '../src/game/bag';
import { calculateAttack, nextBackToBack, nextCombo } from '../src/game/attack';
import { attackLinesForClear, garbageHoleColumn, resolveAttack } from '../src/game/battle';
import { addGarbageLines, clearCompletedLines, createBoard } from '../src/game/board';
import { GameEngine } from '../src/game/engine';
import { currentGravityCellsPerFrame } from '../src/game/gravity';
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
  enterLunaNegraRoom,
  getRoomState,
  eliminatePlayer,
  joinRoom,
  kickPlayer,
  leaveRoom,
  listPublicRooms,
  MemoryRoomStore,
  normalizeRoomId,
  rankPlayers,
  reopenRoom,
  restartRoom,
  setPlayerTargeting,
  setPlayerReady,
  startRoom,
  submitResult,
  updateRoomSettings,
  updateProgress,
} from '../src/online/roomService';
import { listLunaFriends } from '../src/online/lunaNegraSocial';
import { maybeReportRoomBetResult, settleRoomBet } from '../src/online/lunaNegraBets';
import { POST as enterLunaNegraRoomApi } from '../api/rooms/luna-negra/enter';
import { GET as lunaNegraApiGet } from '../api/luna-negra/[action]';
import { decidePeerKoAction } from '../src/online/peerKoAuthority';
import { selectAttackTarget } from '../src/online/targeting';
import { InputController } from '../src/input';
import { HostAuthoritySimulator } from '../src/online/hostAuthority';
import { frameForPendingInputReplay, shouldReconcileLocalEngineSnapshot } from '../src/online/reconciliation';
import {
  actionForCode,
  DEFAULT_INPUT_SETTINGS,
  loadInputSettings,
  normalizeInputSettings,
  updateBinding,
  updateInputTiming,
} from '../src/input/settings';
import type { ActivePiece, Cell, GameEvent, GameInput, PendingGarbage } from '../src/game/types';
import type { OnlineGameSnapshot, OnlinePlayer, OnlinePlayerStatus, RoomBet } from '../src/online/protocol';

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

  it('uses base gravity when custom levelling is enabled', () => {
    const settings = normalizeCustomSettings({
      gravity: 0.02,
      useLevelling: true,
      baseGravity: 0.05,
      gravityIncrease: 0.01,
    });
    const rules = customRulesFromSettings(settings, DEFAULT_INPUT_SETTINGS);

    expect(rules.gravityCellsPerFrame).toBe(0.05);
  });

  it('uses fixed gravity when custom levelling is disabled', () => {
    const settings = normalizeCustomSettings({
      gravity: 0.04,
      useLevelling: false,
      baseGravity: 0.2,
      gravityIncrease: 0.01,
    });
    const rules = customRulesFromSettings(settings, DEFAULT_INPUT_SETTINGS);

    expect(rules.gravityCellsPerFrame).toBe(0.04);
  });

  it('increases custom gravity by cleared-line levels', () => {
    const settings = normalizeCustomSettings({
      useLevelling: true,
      useStaticLevelling: true,
      startingLevel: 2,
      levelStaticSpeed: 2,
      baseGravity: 0.05,
      gravityIncrease: 0.01,
    });
    const rules = customRulesFromSettings(settings, DEFAULT_INPUT_SETTINGS);

    expect(rules).toMatchObject({
      gravityCellsPerFrame: 0.05,
      gravityIncreaseCellsPerLevel: 0.01,
      gravityLevelLines: 2,
      gravityLevelPieces: 0,
      gravityStartingLevel: 2,
    });
    expect(currentGravityCellsPerFrame(rules, { lines: 0, pieces: 0 })).toBeCloseTo(0.06);
    expect(currentGravityCellsPerFrame(rules, { lines: 4, pieces: 0 })).toBeCloseTo(0.08);
  });

  it('increases custom gravity by placed-piece levels when static levelling is disabled', () => {
    const settings = normalizeCustomSettings({
      useLevelling: true,
      useStaticLevelling: false,
      startingLevel: 1,
      levelSpeed: 3,
      baseGravity: 0.04,
      gravityIncrease: 0.02,
    });
    const rules = customRulesFromSettings(settings, DEFAULT_INPUT_SETTINGS);

    expect(rules).toMatchObject({
      gravityCellsPerFrame: 0.04,
      gravityIncreaseCellsPerLevel: 0.02,
      gravityLevelLines: 0,
      gravityLevelPieces: 3,
      gravityStartingLevel: 1,
    });
    expect(currentGravityCellsPerFrame(rules, { lines: 0, pieces: 2 })).toBeCloseTo(0.04);
    expect(currentGravityCellsPerFrame(rules, { lines: 0, pieces: 6 })).toBeCloseTo(0.08);
  });

  it('applies gravity increases during engine ticks', () => {
    const engine = new GameEngine(123, {
      ...DEFAULT_RULES,
      gravityCellsPerFrame: 0,
      gravityIncreaseCellsPerLevel: 1,
      gravityLevelLines: 0,
      gravityLevelPieces: 1,
      gravityStartingLevel: 1,
      softDropCellsPerFrame: 0,
    });

    // La pieza aparece justo encima del área visible (hiddenRows - 2).
    const spawnY = DEFAULT_RULES.hiddenRows - 2;
    expect(engine.tick(1).active?.y).toBe(spawnY);

    const afterLock = engine.tick(2, [{ frame: 2, action: 'hardDrop' }]);
    expect(afterLock.stats.pieces).toBe(1);
    expect(afterLock.active?.y).toBe(spawnY + 1);
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

  it('matches TETR.IO-style move-reset lock delay for grounded rotations', () => {
    const engine = new GameEngine(2026);
    const unsafe = engine as unknown as {
      active: ActivePiece;
      lockFrames: number;
      lockResets: number;
      fallAccumulator: number;
    };
    unsafe.active = {
      type: 'O',
      rotation: 0,
      x: 3,
      y: DEFAULT_RULES.visibleRows + DEFAULT_RULES.hiddenRows - 2,
    };
    unsafe.lockFrames = 0;
    unsafe.lockResets = 0;
    unsafe.fallAccumulator = 0;

    let state = engine.getState();
    for (let frame = 1; frame <= DEFAULT_RULES.lockResetLimit; frame += 1) {
      state = engine.tick(frame, [{ frame, action: 'rotateCW' }]);
    }

    expect(state.stats.pieces).toBe(0);
    expect(unsafe.lockResets).toBe(DEFAULT_RULES.lockResetLimit);

    const maxFrames = DEFAULT_RULES.lockResetLimit + DEFAULT_RULES.lockDelayFrames + 1;
    for (let frame = DEFAULT_RULES.lockResetLimit + 1; frame <= maxFrames && state.stats.pieces === 0; frame += 1) {
      state = engine.tick(frame, [{ frame, action: 'rotateCW' }]);
    }

    expect(state.stats.pieces).toBe(1);
  });

  it('does not restore the lock reset budget after a floor kick lifts the piece', () => {
    const engine = new GameEngine(2027, {
      ...DEFAULT_RULES,
      gravityCellsPerFrame: 1,
    });
    const unsafe = engine as unknown as {
      active: ActivePiece;
      lockFrames: number;
      lockResets: number;
      fallAccumulator: number;
    };
    unsafe.active = {
      type: 'O',
      rotation: 0,
      x: 3,
      y: DEFAULT_RULES.visibleRows + DEFAULT_RULES.hiddenRows - 4,
    };
    unsafe.lockFrames = 0;
    unsafe.lockResets = DEFAULT_RULES.lockResetLimit;
    unsafe.fallAccumulator = 0;

    let state = engine.tick(1);

    expect(state.active?.y).toBe(DEFAULT_RULES.visibleRows + DEFAULT_RULES.hiddenRows - 3);
    expect(unsafe.lockResets).toBe(DEFAULT_RULES.lockResetLimit);

    const maxFrames = DEFAULT_RULES.lockDelayFrames + 5;
    for (let frame = 2; frame <= maxFrames && state.stats.pieces === 0; frame += 1) {
      state = engine.tick(frame, [{ frame, action: 'rotateCW' }]);
    }

    expect(state.stats.pieces).toBe(1);
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
      // Tabla simple a propósito: este test cubre el evento, no los bonus.
      attackTable: 'simple',
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

  it('uses a distinct sound cue for T-Spin line clears', () => {
    const state = createSplitState(1, 30);
    const spinEvent: GameEvent = {
      type: 'lineClear',
      frame: 30,
      cleared: 1,
      difficult: true,
      spin: 'full',
      piece: 'T',
      perfectClear: false,
      combo: 0,
      b2b: 1,
      attackLines: 2,
      outgoingLines: 2,
    };

    expect(soundCueForRunProgress(state, [spinEvent], 0, 0)).toBe('tSpin');
    expect(soundCueForRunProgress(state, [{ ...spinEvent, spin: 'none', difficult: false }], 0, 0)).toBe('lineClear');
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
    const clamped = normalizeInputSettings({ dasFrames: 999, arrFrames: -5 });
    expect(clamped.dasFrames).toBe(30);
    expect(clamped.arrFrames).toBe(0); // ARR 0 ("instantáneo a la pared") ya es válido

    // ARR 0 es un valor aceptado, no se sube a 1.
    expect(normalizeInputSettings({ arrFrames: 0 }).arrFrames).toBe(0);

    const rebound = updateBinding(DEFAULT_INPUT_SETTINGS, 'rotateCW', 'KeyA');
    expect(rebound.bindings.rotateCW).toEqual(['KeyA']);
    expect(actionForCode(rebound, 'KeyA')).toBe('rotateCW');

    const slower = updateInputTiming(DEFAULT_INPUT_SETTINGS, 'dasFrames', 2);
    expect(slower.dasFrames).toBe(DEFAULT_INPUT_SETTINGS.dasFrames + 2);
  });

  it('defaults to responsive horizontal handling', () => {
    expect(DEFAULT_INPUT_SETTINGS.dasFrames).toBe(8);
    expect(DEFAULT_INPUT_SETTINGS.arrFrames).toBe(2);
  });

  it.each([
    { dasFrames: 9, arrFrames: 1 },
    { dasFrames: 12, arrFrames: 2 },
  ])('migrates saved default input timing $dasFrames/$arrFrames to the current baseline', (stored) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => JSON.stringify(stored),
      },
    });

    try {
      expect(loadInputSettings()).toMatchObject({ dasFrames: 8, arrFrames: 2 });
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it('defaults to a responsive soft drop speed', () => {
    expect(DEFAULT_RULES.softDropCellsPerFrame + DEFAULT_RULES.gravityCellsPerFrame).toBeCloseTo(40 / 60);
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

  it('keeps held soft drop independent from horizontal DAS and ARR', () => {
    const input = new InputController({
      ...DEFAULT_INPUT_SETTINGS,
      dasFrames: 12,
      arrFrames: 2,
    }, null);

    input.pressControl('key:ArrowDown', 'softDrop');
    input.advanceFrame(1);
    expect(input.collect(1)).toEqual([{ frame: 0, action: 'softDrop' }]);

    input.advanceFrame(2);
    expect(input.collect(2)).toEqual([{ frame: 2, action: 'softDrop' }]);

    input.advanceFrame(3);
    expect(input.collect(3)).toEqual([{ frame: 3, action: 'softDrop' }]);
  });

  it('accumulates fractional soft drop speed across frames', () => {
    const engine = new GameEngine(123, {
      ...DEFAULT_RULES,
      gravityCellsPerFrame: 0,
      softDropCellsPerFrame: 0.5,
    });
    const startY = engine.getState().active?.y;

    engine.tick(1, [{ frame: 1, action: 'softDrop' }]);
    expect(engine.getState().active?.y).toBe(startY);

    engine.tick(2, [{ frame: 2, action: 'softDrop' }]);
    expect(engine.getState().active?.y).toBe((startY ?? 0) + 1);
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

  it('only lets the host commit local terminal states in online play', () => {
    expect(canCommitLocalOnlineTerminal(true)).toBe(true);
    expect(canCommitLocalOnlineTerminal(false)).toBe(false);
  });

  it('lets the host commit a remote player self-KO', () => {
    expect(decidePeerKoAction({
      isHostAuthority: true,
      localPlayerId: 'host',
      hostPlayerId: 'host',
      remotePlayerId: 'guest',
      messagePlayerId: 'guest',
      playerIsInRoom: true,
      seedMatches: true,
    })).toBe('commit');
  });

  it('ignores forged or stale peer KO messages', () => {
    expect(decidePeerKoAction({
      isHostAuthority: true,
      localPlayerId: 'host',
      hostPlayerId: 'host',
      remotePlayerId: 'guest',
      messagePlayerId: 'other-player',
      playerIsInRoom: true,
      seedMatches: true,
    })).toBe('ignore');

    expect(decidePeerKoAction({
      isHostAuthority: true,
      localPlayerId: 'host',
      hostPlayerId: 'host',
      remotePlayerId: 'guest',
      messagePlayerId: 'guest',
      playerIsInRoom: true,
      seedMatches: false,
    })).toBe('ignore');
  });

  it('only applies host KO messages on non-host clients', () => {
    expect(decidePeerKoAction({
      isHostAuthority: false,
      localPlayerId: 'guest-a',
      hostPlayerId: 'host',
      remotePlayerId: 'host',
      messagePlayerId: 'host',
      playerIsInRoom: true,
      seedMatches: true,
    })).toBe('apply');

    expect(decidePeerKoAction({
      isHostAuthority: false,
      localPlayerId: 'guest-a',
      hostPlayerId: 'host',
      remotePlayerId: 'guest-b',
      messagePlayerId: 'guest-b',
      playerIsInRoom: true,
      seedMatches: true,
    })).toBe('ignore');
  });

  it('requires confirmation only for destructive actions during active runs', () => {
    expect(requiresRunConfirmation('restart', 'playing', 'playing')).toBe(true);
    expect(requiresRunConfirmation('main-menu', 'paused', 'playing')).toBe(true);
    expect(requiresRunConfirmation('import-replay', 'settings', 'playing', 'paused')).toBe(true);
    expect(requiresRunConfirmation('import-replay', 'settings', 'playing', 'menu')).toBe(false);

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

    expect(exported.version).toBe(2);
    expect(exported.seed).toBe(314);
    expect(exported.result.pieces).toBe(1);
    expect(exported.summary.inputCount).toBe(1);
    expect(exported.inputs).toEqual([input]);
    expect(exported.inputs).not.toBe(log.inputs);
    expect(exported.garbage).toEqual([]);
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

  it('normalizes long Luna Negra room ids while preserving manual short code generation', () => {
    expect(normalizeRoomId('abc12345')).toBe('ABC12345');
    expect(normalizeRoomId('room_1-abc')).toBe('ROOM_1-ABC');
    expect(normalizeRoomId('a'.repeat(80))).toHaveLength(64);
    expect(createRoomCode(() => 0.25)).toHaveLength(4);
  });

  it('creates a Luna Negra host room with the verified pubkey as host authority', async () => {
    const store = new MemoryRoomStore();
    const host = await enterLunaNegraRoom(store, {
      npub: 'npub-host-player',
      pubkey: 'pubkey-host-player',
      gameId: null,
      displayName: 'Nostr Host',
      avatarUrl: 'https://example.com/host.png',
      roomId: 'lnroom123',
      host: true,
      hostPubkey: 'pubkey-host-player',
      expiresAt: '2026-06-06T21:00:00.000Z',
    }, 1000);

    expect(host.player).toMatchObject({
      id: 'pubkey-host-player',
      name: 'Nostr Host',
      avatarUrl: 'https://example.com/host.png',
      host: true,
    });
    expect(host.room.players[0].avatarUrl).toBe('https://example.com/host.png');
    expect(host.room.id).toBe('LNROOM123');
    expect(host.room.hostPlayerId).toBe('pubkey-host-player');
    expect(host.room.visibility).toBe('private');
    expect(host.room.matchType).toBe('battle');
  });

  it('joins a Luna Negra guest using the verified pubkey and display name', async () => {
    const store = new MemoryRoomStore();
    await enterLunaNegraRoom(store, {
      npub: 'npub-host-player',
      pubkey: 'pubkey-host-player',
      gameId: null,
      displayName: 'Nostr Host',
      avatarUrl: null,
      roomId: 'lnroom124',
      host: true,
      hostPubkey: 'pubkey-host-player',
      expiresAt: null,
    }, 1000);

    const guest = await enterLunaNegraRoom(store, {
      npub: 'npub-guest-player',
      pubkey: 'pubkey-guest-player',
      gameId: null,
      displayName: 'Guest Name',
      avatarUrl: 'https://example.com/guest.png',
      roomId: 'lnroom124',
      host: false,
      hostPubkey: 'pubkey-host-player',
      expiresAt: null,
    }, 1100);

    expect(guest.player.id).toBe('pubkey-guest-player');
    expect(guest.room.players.map((player) => [player.id, player.name, player.avatarUrl])).toEqual([
      ['pubkey-host-player', 'Nostr Host', null],
      ['pubkey-guest-player', 'Guest Name', 'https://example.com/guest.png'],
    ]);
  });

  it('lets a Luna Negra guest materialize the room before the host opens the game', async () => {
    const store = new MemoryRoomStore();

    const guest = await enterLunaNegraRoom(store, {
      npub: 'npub-guest-player',
      pubkey: 'pubkey-guest-player',
      gameId: 'tetra-game',
      displayName: 'Guest Name',
      avatarUrl: 'https://example.com/guest.png',
      roomId: 'lnroom-prehost',
      host: false,
      hostPubkey: 'pubkey-host-player',
      expiresAt: null,
    }, 1000);

    expect(guest.player.id).toBe('pubkey-guest-player');
    expect(guest.room.id).toBe('LNROOM-PREHOST');
    expect(guest.room.hostPlayerId).toBe('pubkey-host-player');
    expect(guest.room.lunaGameId).toBe('tetra-game');
    expect(guest.room.players.map((player) => [player.id, player.name, player.status, player.npub])).toEqual([
      ['pubkey-host-player', 'Host', 'disconnected', null],
      // Auto-ready: todo el que entra a una sala queda listo por defecto.
      ['pubkey-guest-player', 'Guest Name', 'ready', 'npub-guest-player'],
    ]);

    const host = await enterLunaNegraRoom(store, {
      npub: 'npub-host-player',
      pubkey: 'pubkey-host-player',
      gameId: 'tetra-game',
      displayName: 'Nostr Host',
      avatarUrl: 'https://example.com/host.png',
      roomId: 'lnroom-prehost',
      host: true,
      hostPubkey: 'pubkey-host-player',
      expiresAt: null,
    }, 1100);

    expect(host.room.hostPlayerId).toBe('pubkey-host-player');
    expect(host.room.players.map((player) => [player.id, player.name, player.status, player.npub, player.avatarUrl])).toEqual([
      ['pubkey-host-player', 'Nostr Host', 'ready', 'npub-host-player', 'https://example.com/host.png'],
      ['pubkey-guest-player', 'Guest Name', 'ready', 'npub-guest-player', 'https://example.com/guest.png'],
    ]);
  });

  it('rejects Luna Negra guests when the verified host does not match the room host', async () => {
    const store = new MemoryRoomStore();
    await enterLunaNegraRoom(store, {
      npub: 'npub-host-player',
      pubkey: 'pubkey-host-player',
      gameId: null,
      displayName: 'Nostr Host',
      avatarUrl: null,
      roomId: 'lnroom125',
      host: true,
      hostPubkey: 'pubkey-host-player',
      expiresAt: null,
    }, 1000);

    await expect(enterLunaNegraRoom(store, {
      npub: 'npub-guest-player',
      pubkey: 'pubkey-guest-player',
      gameId: null,
      displayName: 'Guest Name',
      avatarUrl: null,
      roomId: 'lnroom125',
      host: false,
      hostPubkey: 'different-host-pubkey',
      expiresAt: null,
    }, 1100)).rejects.toThrow('Luna Negra host does not match this room.');
  });

  it('migrates the host to the next player when the host leaves the room', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, { playerId: 'host-player-1', name: 'Host', visibility: 'public' }, 1000);
    await joinRoom(store, { roomId: room.id, playerId: 'guest-player-2', name: 'Guest2' }, 1010);
    await joinRoom(store, { roomId: room.id, playerId: 'guest-player-3', name: 'Guest3' }, 1020);

    const result = await leaveRoom(store, { roomId: room.id, playerId: 'host-player-1' }, 1030);

    expect(result.room).not.toBeNull();
    expect(result.hostMigratedTo).toBe('guest-player-2');
    expect(result.room?.hostPlayerId).toBe('guest-player-2');
    expect(result.room?.players.map((player) => player.id)).toEqual(['guest-player-2', 'guest-player-3']);
  });

  it('deletes the room when the last player leaves', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, { playerId: 'solo-player-1', name: 'Solo', visibility: 'public' }, 1000);

    const result = await leaveRoom(store, { roomId: room.id, playerId: 'solo-player-1' }, 1010);

    expect(result.room).toBeNull();
    expect(await store.getRoom(room.id)).toBeNull();
    expect(await store.listPublicRoomIds()).not.toContain(room.id);
  });

  it('finishes the game and declares the remaining player as winner when a player leaves during an active game', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, { playerId: 'host-player-w', name: 'Host', visibility: 'public' }, 1000);
    await joinRoom(store, { roomId: room.id, playerId: 'guest-player-l', name: 'Guest' }, 1010);

    await setPlayerReady(store, { roomId: room.id, playerId: 'host-player-w', ready: true }, 1020);
    await setPlayerReady(store, { roomId: room.id, playerId: 'guest-player-l', ready: true }, 1030);
    await startRoom(store, { roomId: room.id, playerId: 'host-player-w' }, 1040);

    const result = await leaveRoom(store, { roomId: room.id, playerId: 'guest-player-l' }, 1050);

    expect(result.room).not.toBeNull();
    expect(result.room?.status).toBe('finished');
    expect(result.room?.winnerPlayerId).toBe('host-player-w');
    const winner = result.room?.players.find((p) => p.id === 'host-player-w');
    expect(winner?.status).toBe('winner');
  });

  it('lets the host kick a player but rejects non-hosts and self-kicks', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, { playerId: 'host-player-k', name: 'Host', visibility: 'public' }, 1000);
    await joinRoom(store, { roomId: room.id, playerId: 'guest-player-k', name: 'Guest' }, 1010);

    await expect(kickPlayer(store, { roomId: room.id, playerId: 'guest-player-k', targetPlayerId: 'host-player-k' }, 1020))
      .rejects.toThrow('Solo el host puede expulsar jugadores.');
    await expect(kickPlayer(store, { roomId: room.id, playerId: 'host-player-k', targetPlayerId: 'host-player-k' }, 1020))
      .rejects.toThrow('El host no puede expulsarse a sí mismo.');

    const kicked = await kickPlayer(store, { roomId: room.id, playerId: 'host-player-k', targetPlayerId: 'guest-player-k' }, 1030);
    expect(kicked.players.map((player) => player.id)).toEqual(['host-player-k']);
  });

  it('persists winnerNpubs on the bet when the game finishes so they are preserved even if players leave', async () => {
    const store = new MemoryRoomStore();
    let room = await createRoom(store, { playerId: 'host-player-p', npub: 'npub-host', name: 'Host', visibility: 'public' }, 1000);
    room = await joinRoom(store, { roomId: room.id, playerId: 'guest-player-p', npub: 'npub-guest', name: 'Guest' }, 1010);
    
    room.bet = {
      betId: 'bet-persistence-test',
      status: 'funded',
      stakeSats: 50,
      potSats: 100,
      potTargetSats: 100,
      feeSats: 1,
      feePct: 1,
      netPayoutSats: 99,
      depositDeadline: null,
      depositsReceived: 2,
      depositsTotal: 2,
      participants: [],
      winnerNpubs: null,
      resultReported: false,
      settlementError: null,
      createdByPlayerId: 'host-player-p',
      createdAtServerMs: 1000,
      updatedAtServerMs: 1000,
    };
    room.status = 'finished';
    room.winnerPlayerId = 'host-player-p';
    await store.saveRoom(room);

    process.env.LUNA_NEGRA_BASE_URL = 'https://luna.example';
    process.env.LUNA_NEGRA_API_KEY = 'ln_sk_test';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'settled', payoutSats: 99 })));

    const updated = await maybeReportRoomBetResult(store, room, 1050);

    expect(updated).not.toBeNull();
    expect(updated?.bet?.winnerNpubs).toEqual(['npub-host']);

    await leaveRoom(store, { roomId: room.id, playerId: 'host-player-p' }, 1060);
    const roomAfterLeave = await store.getRoom(room.id);
    expect(roomAfterLeave?.players.find((p) => p.id === 'host-player-p')).toBeUndefined();
    // Los ganadores quedan registrados en la apuesta aunque el ganador ya no
    // esté en la sala.
    expect(roomAfterLeave?.bet?.winnerNpubs).toEqual(['npub-host']);

    vi.unstubAllGlobals();
    delete process.env.LUNA_NEGRA_BASE_URL;
    delete process.env.LUNA_NEGRA_API_KEY;
  });

  it('keeps result reporting retryable when Luna Negra has not accepted the winner yet', async () => {
    const store = new MemoryRoomStore();
    let room = await createRoom(store, { playerId: 'host-player-r', npub: 'npub-host-r', name: 'Host', visibility: 'public' }, 1000);
    room = await joinRoom(store, { roomId: room.id, playerId: 'guest-player-r', npub: 'npub-guest-r', name: 'Guest' }, 1010);

    room.bet = {
      betId: 'bet-retry-test',
      status: 'funded',
      stakeSats: 50,
      potSats: 100,
      potTargetSats: 100,
      feeSats: 1,
      feePct: 1,
      netPayoutSats: 99,
      depositDeadline: null,
      depositsReceived: 2,
      depositsTotal: 2,
      participants: [
        {
          npub: 'npub-host-r',
          playerId: 'host-player-r',
          depositStatus: 'paid',
          bolt11: null,
          lnurl: null,
          payUrl: null,
          payoutSats: null,
        },
        {
          npub: 'npub-guest-r',
          playerId: 'guest-player-r',
          depositStatus: 'paid',
          bolt11: null,
          lnurl: null,
          payUrl: null,
          payoutSats: null,
        },
      ],
      winnerNpubs: null,
      resultReported: false,
      settlementError: null,
      createdByPlayerId: 'host-player-r',
      createdAtServerMs: 1000,
      updatedAtServerMs: 1000,
    };
    room.status = 'finished';
    room.winnerPlayerId = 'host-player-r';
    await store.saveRoom(room);

    process.env.LUNA_NEGRA_BASE_URL = 'https://luna.example';
    process.env.LUNA_NEGRA_API_KEY = 'ln_sk_test';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/result')) {
        return Response.json(
          { error: { code: 'NOT_READY', message: 'The bet is not ready to resolve.' } },
          { status: 409 },
        );
      }
      return Response.json({
        betId: 'bet-retry-test',
        status: 'funded',
        participants: [
          { npub: 'npub-host-r', depositStatus: 'paid', payoutSats: null },
          { npub: 'npub-guest-r', depositStatus: 'paid', payoutSats: null },
        ],
      });
    }));

    const updated = await maybeReportRoomBetResult(store, room, 1050);
    const stored = await store.getRoom(room.id);

    expect(updated?.bet?.settlementError).toContain('NOT_READY');
    expect(stored?.bet?.winnerNpubs).toEqual(['npub-host-r']);
    expect(stored?.bet?.resultReported).toBe(false);
    expect(stored?.bet?.settlementError).toContain('NOT_READY');

    vi.unstubAllGlobals();
    delete process.env.LUNA_NEGRA_BASE_URL;
    delete process.env.LUNA_NEGRA_API_KEY;
  });

  it('surfaces Luna Negra settlement errors from the manual settle action', async () => {
    const store = new MemoryRoomStore();
    let room = await createRoom(store, { playerId: 'host-player-s', npub: 'npub-host-s', name: 'Host', visibility: 'public' }, 1000);
    room = await joinRoom(store, { roomId: room.id, playerId: 'guest-player-s', npub: 'npub-guest-s', name: 'Guest' }, 1010);

    room.bet = {
      betId: 'bet-manual-settle-test',
      status: 'funded',
      stakeSats: 50,
      potSats: 100,
      potTargetSats: 100,
      feeSats: 1,
      feePct: 1,
      netPayoutSats: 99,
      depositDeadline: null,
      depositsReceived: 2,
      depositsTotal: 2,
      participants: [
        {
          npub: 'npub-host-s',
          playerId: 'host-player-s',
          depositStatus: 'paid',
          bolt11: null,
          lnurl: null,
          payUrl: null,
          payoutSats: null,
        },
        {
          npub: 'npub-guest-s',
          playerId: 'guest-player-s',
          depositStatus: 'paid',
          bolt11: null,
          lnurl: null,
          payUrl: null,
          payoutSats: null,
        },
      ],
      winnerNpubs: null,
      resultReported: false,
      settlementError: null,
      createdByPlayerId: 'host-player-s',
      createdAtServerMs: 1000,
      updatedAtServerMs: 1000,
    };
    room.status = 'finished';
    room.winnerPlayerId = 'host-player-s';
    await store.saveRoom(room);

    process.env.LUNA_NEGRA_BASE_URL = 'https://luna.example';
    process.env.LUNA_NEGRA_API_KEY = 'ln_sk_test';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/result')) {
        return Response.json(
          { error: { code: 'NOT_READY', message: 'The bet is not ready to resolve.' } },
          { status: 409 },
        );
      }
      return Response.json({
        betId: 'bet-manual-settle-test',
        status: 'funded',
        participants: [
          { npub: 'npub-host-s', depositStatus: 'paid', payoutSats: null },
          { npub: 'npub-guest-s', depositStatus: 'paid', payoutSats: null },
        ],
      });
    }));

    await expect(settleRoomBet(store, room.id, 'host-player-s', 1050)).rejects.toThrow('not ready');
    const stored = await store.getRoom(room.id);
    expect(stored?.bet?.resultReported).toBe(false);
    expect(stored?.bet?.settlementError).toContain('NOT_READY');

    vi.unstubAllGlobals();
    delete process.env.LUNA_NEGRA_BASE_URL;
    delete process.env.LUNA_NEGRA_API_KEY;
  });

  it('parses the Luna Negra friends response and reports source luna-negra', async () => {
    const previousBaseUrl = process.env.LUNA_NEGRA_BASE_URL;
    const previousApiKey = process.env.LUNA_NEGRA_API_KEY;
    process.env.LUNA_NEGRA_BASE_URL = 'https://luna.example';
    process.env.LUNA_NEGRA_API_KEY = 'ln_sk_test';
    // apiOk devuelve el objeto crudo (sin envelope { data }).
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      friends: [
        { npub: 'npub-online', displayName: 'Online', presence: 'online', roomId: null },
        { npub: 'npub-ingame', displayName: 'InGame', presence: 'in-game', roomId: 'AB12' },
      ],
    })));

    const { friends, source } = await listLunaFriends('npub-self');

    expect(source).toBe('luna-negra');
    expect(friends.map((friend) => [friend.npub, friend.presence])).toEqual([
      ['npub-ingame', 'in-game'],
      ['npub-online', 'online'],
    ]);

    vi.unstubAllGlobals();
    if (previousBaseUrl === undefined) delete process.env.LUNA_NEGRA_BASE_URL;
    else process.env.LUNA_NEGRA_BASE_URL = previousBaseUrl;
    if (previousApiKey === undefined) delete process.env.LUNA_NEGRA_API_KEY;
    else process.env.LUNA_NEGRA_API_KEY = previousApiKey;
  });

  it('returns clear Luna Negra API errors for missing config and invalid tokens', async () => {
    const previousBaseUrl = process.env.LUNA_NEGRA_BASE_URL;
    delete process.env.LUNA_NEGRA_BASE_URL;

    const missingConfig = await enterLunaNegraRoomApi(new Request('http://local/api/rooms/luna-negra/enter', {
      method: 'POST',
      body: JSON.stringify({ inviteToken: 'token', roomId: 'lnroom126' }),
    }));
    expect(missingConfig.status).toBe(500);
    expect(await missingConfig.json()).toEqual({ error: 'LUNA_NEGRA_BASE_URL is not configured.' });

    process.env.LUNA_NEGRA_BASE_URL = 'https://luna.example';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ valid: false })));
    const invalidToken = await enterLunaNegraRoomApi(new Request('http://local/api/rooms/luna-negra/enter', {
      method: 'POST',
      body: JSON.stringify({ inviteToken: 'token', roomId: 'lnroom126' }),
    }));
    expect(invalidToken.status).toBe(401);
    expect(await invalidToken.json()).toEqual({ error: 'Luna Negra invite token is invalid or expired.' });
    vi.unstubAllGlobals();

    if (previousBaseUrl === undefined) delete process.env.LUNA_NEGRA_BASE_URL;
    else process.env.LUNA_NEGRA_BASE_URL = previousBaseUrl;
  });

  it('builds the Luna Negra game login URL from backend config', async () => {
    const previousBaseUrl = process.env.LUNA_NEGRA_BASE_URL;
    const previousSlug = process.env.LUNA_NEGRA_GAME_SLUG;
    try {
      process.env.LUNA_NEGRA_BASE_URL = 'https://luna.example/';
      delete process.env.LUNA_NEGRA_GAME_SLUG;

      const defaultUrl = await lunaNegraApiGet(new Request('http://local/api/luna-negra/login-url'));
      expect(defaultUrl.status).toBe(200);
      expect(await defaultUrl.json()).toMatchObject({ url: 'https://luna.example/game/tetris-beta' });

      process.env.LUNA_NEGRA_GAME_SLUG = 'tetra-test';
      const customUrl = await lunaNegraApiGet(new Request('http://local/api/luna-negra/login-url'));
      expect(customUrl.status).toBe(200);
      expect(await customUrl.json()).toMatchObject({ url: 'https://luna.example/game/tetra-test' });
    } finally {
      if (previousBaseUrl === undefined) delete process.env.LUNA_NEGRA_BASE_URL;
      else process.env.LUNA_NEGRA_BASE_URL = previousBaseUrl;
      if (previousSlug === undefined) delete process.env.LUNA_NEGRA_GAME_SLUG;
      else process.env.LUNA_NEGRA_GAME_SLUG = previousSlug;
    }
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

  it('creates custom online rooms by default', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-default-custom',
      name: 'Host',
      visibility: 'private',
    }, 1000);

    expect(room.mode).toBe('custom');
    expect(room.matchType).toBe('custom');
    expect(room.ruleset.rulesetId).toBe('custom-survival-modern');
    expect(room.ruleset.objective).toEqual({ type: 'lastStanding' });
    expect(room.rules.targetLines).toBeNull();
  });

  it('lists public custom rooms but keeps private rooms hidden', async () => {
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
    expect(rooms[0].matchType).toBe('custom');
    expect(rooms[0].customPreset).toBe('custom-survival-modern');
  });

  it('lets the lobby host toggle custom room visibility', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-visibility-host',
      name: 'Host',
      visibility: 'private',
    }, 1000);
    await joinRoom(store, { roomId: room.id, playerId: 'player-visibility-guest', name: 'Guest' }, 1100);

    await expect(updateRoomSettings(store, {
      roomId: room.id,
      playerId: 'player-visibility-guest',
      matchType: 'custom',
      visibility: 'public',
    }, 1200)).rejects.toThrow('Only the host can change room settings.');

    const published = await updateRoomSettings(store, {
      roomId: room.id,
      playerId: 'player-visibility-host',
      matchType: 'custom',
      visibility: 'public',
    }, 1300);

    expect(published.visibility).toBe('public');
    expect(published.mode).toBe('custom');
    expect(published.matchType).toBe('custom');
    // Auto-ready: cambiar ajustes ya no des-marca a los jugadores.
    expect(published.players.every((player) => player.ready && player.status === 'ready')).toBe(true);
    expect((await listPublicRooms(store, 1400)).map((summary) => summary.id)).toEqual([room.id]);

    const hidden = await updateRoomSettings(store, {
      roomId: room.id,
      playerId: 'player-visibility-host',
      matchType: 'custom',
      visibility: 'private',
    }, 1500);

    expect(hidden.visibility).toBe('private');
    expect(await listPublicRooms(store, 1600)).toEqual([]);
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

  it('rejects removed online match types', async () => {
    const store = new MemoryRoomStore();

    await expect(createRoom(store, {
      playerId: 'player-old-mode-create',
      name: 'Old',
      visibility: 'private',
      matchType: 'duel' as unknown as 'custom',
    }, 1000)).rejects.toThrow('Only custom online rooms are supported.');

    const room = await createRoom(store, {
      playerId: 'player-old-mode-host',
      name: 'Host',
      visibility: 'private',
    }, 1100);

    await expect(updateRoomSettings(store, {
      roomId: room.id,
      playerId: 'player-old-mode-host',
      matchType: 'sprintRace' as unknown as 'custom',
    }, 1200)).rejects.toThrow('Only custom online rooms are supported.');
  });

  it('blocks custom room visibility changes when an active bet exists', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-bet-mode-host',
      npub: 'npub-host',
      name: 'Host',
      visibility: 'private',
    }, 1000);
    room.bet = {
      betId: 'bet-mode-1',
      status: 'funded',
      stakeSats: 50,
      potSats: 100,
      potTargetSats: 100,
      feeSats: 1,
      feePct: 1,
      netPayoutSats: 99,
      depositDeadline: null,
      depositsReceived: 2,
      depositsTotal: 2,
      participants: [],
      winnerNpubs: null,
      resultReported: false,
      settlementError: null,
      createdByPlayerId: 'player-bet-mode-host',
      createdAtServerMs: 1000,
      updatedAtServerMs: 1000,
    } satisfies RoomBet;
    await store.saveRoom(room);

    await expect(updateRoomSettings(store, {
      roomId: room.id,
      playerId: 'player-bet-mode-host',
      matchType: 'custom',
      visibility: 'public',
    }, 1100)).rejects.toThrow('No se puede cambiar el modo con una apuesta activa.');
  });

  it('blocks custom room visibility changes after the lobby starts', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-started-visibility-host',
      name: 'Host',
      visibility: 'private',
    }, 1000);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-started-visibility-host', ready: true }, 1100);
    await startRoom(store, { roomId: room.id, playerId: 'player-started-visibility-host' }, 1200);

    await expect(updateRoomSettings(store, {
      roomId: room.id,
      playerId: 'player-started-visibility-host',
      matchType: 'custom',
      visibility: 'public',
    }, 1300)).rejects.toThrow('Room settings can only change in the lobby.');
  });

  it('rejects invalid explicit online rulesets', async () => {
    const store = new MemoryRoomStore();
    await expect(createRoom(store, {
      playerId: 'player-bad-ruleset',
      name: 'Bad',
      visibility: 'private',
      matchType: 'custom',
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
      seed: room.seed,
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
      seed: room.seed,
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

  it('lets only the host restart a finished online room with a fresh countdown', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-host-restart',
      name: 'Host',
      visibility: 'private',
    }, 1000);
    await joinRoom(store, { roomId: room.id, playerId: 'player-guest-restart', name: 'Guest' }, 1100);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-host-restart', ready: true }, 1200);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-guest-restart', ready: true }, 1200);
    await startRoom(store, { roomId: room.id, playerId: 'player-host-restart' }, 1300);
    const playing = await getRoomState(store, room.id, 7000);

    const finished = await eliminatePlayer(store, {
      roomId: room.id,
      authorityPlayerId: 'player-host-restart',
      playerId: 'player-guest-restart',
      seed: playing.seed,
      frame: 300,
      lines: 8,
      pieces: 18,
      elapsedFrames: 300,
    }, 7100);
    const previousResultId = finished.matchResultId;

    expect(finished.status).toBe('finished');
    expect(previousResultId).not.toBeNull();
    await expect(restartRoom(store, {
      roomId: room.id,
      playerId: 'player-guest-restart',
    }, 7200)).rejects.toThrow('Only the host can restart.');

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValueOnce(0.25);
    try {
      const restarted = await restartRoom(store, {
        roomId: room.id,
        playerId: 'player-host-restart',
      }, 7300);

      expect(restarted.status).toBe('countdown');
      expect(restarted.startsAtServerMs).toBe(12300);
      expect(restarted.seed).toBe(1073741823);
      expect(restarted.winnerPlayerId).toBeNull();
      expect(restarted.matchResultId).toBeNull();
      expect(restarted.players.every((player) => player.ready && player.alive && player.status === 'ready')).toBe(true);
      expect(restarted.players.every((player) => player.lines === 0 && player.pieces === 0 && player.game === null)).toBe(true);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('clears terminal bets on restart and blocks active bet restarts', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-host-bet-restart',
      npub: 'npub-host-bet-restart',
      name: 'Host',
      visibility: 'private',
    }, 1000);
    await joinRoom(store, {
      roomId: room.id,
      playerId: 'player-guest-bet-restart',
      npub: 'npub-guest-bet-restart',
      name: 'Guest',
    }, 1100);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-host-bet-restart', ready: true }, 1200);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-guest-bet-restart', ready: true }, 1200);
    const started = await startRoom(store, { roomId: room.id, playerId: 'player-host-bet-restart' }, 1300);
    await getRoomState(store, room.id, 7000);
    await eliminatePlayer(store, {
      roomId: room.id,
      authorityPlayerId: 'player-host-bet-restart',
      playerId: 'player-guest-bet-restart',
      seed: started.seed,
      frame: 300,
      lines: 8,
      pieces: 18,
      elapsedFrames: 300,
    }, 7100);

    const activeBetRoom = await store.getRoom(room.id);
    if (!activeBetRoom) throw new Error('Expected active bet test room');
    activeBetRoom.bet = {
      betId: 'bet-active-restart',
      status: 'funded',
      stakeSats: 50,
      potSats: 100,
      potTargetSats: 100,
      feeSats: 1,
      feePct: 1,
      netPayoutSats: 99,
      depositDeadline: null,
      depositsReceived: 2,
      depositsTotal: 2,
      participants: [],
      winnerNpubs: null,
      resultReported: false,
      settlementError: null,
      createdByPlayerId: 'player-host-bet-restart',
      createdAtServerMs: 1000,
      updatedAtServerMs: 1000,
    };
    await store.saveRoom(activeBetRoom);

    await expect(restartRoom(store, {
      roomId: room.id,
      playerId: 'player-host-bet-restart',
    }, 7200)).rejects.toThrow('todavía no terminó de liquidarse');

    activeBetRoom.bet = {
      ...activeBetRoom.bet,
      status: 'settled',
      resultReported: true,
      winnerNpubs: ['npub-host-bet-restart'],
    };
    await store.saveRoom(activeBetRoom);

    const restarted = await restartRoom(store, {
      roomId: room.id,
      playerId: 'player-host-bet-restart',
    }, 7300);

    expect(restarted.status).toBe('countdown');
    expect(restarted.bet).toBeNull();
    expect(restarted.winnerPlayerId).toBeNull();
  });

  it('ignores terminal updates from the previous online seed after a restart', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-host-stale',
      name: 'Host',
      visibility: 'private',
    }, 1000);
    await joinRoom(store, { roomId: room.id, playerId: 'player-guest-stale', name: 'Guest' }, 1100);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-host-stale', ready: true }, 1200);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-guest-stale', ready: true }, 1200);
    const started = await startRoom(store, { roomId: room.id, playerId: 'player-host-stale' }, 1300);
    await getRoomState(store, room.id, 7000);

    await eliminatePlayer(store, {
      roomId: room.id,
      authorityPlayerId: 'player-host-stale',
      playerId: 'player-guest-stale',
      seed: started.seed,
      frame: 300,
      lines: 8,
      pieces: 18,
      elapsedFrames: 300,
    }, 7100);
    const restarted = await restartRoom(store, {
      roomId: room.id,
      playerId: 'player-host-stale',
    }, 7300);

    expect(restarted.status).toBe('countdown');
    expect(restarted.seed).not.toBe(started.seed);

    const afterStaleElimination = await eliminatePlayer(store, {
      roomId: room.id,
      authorityPlayerId: 'player-host-stale',
      playerId: 'player-guest-stale',
      seed: started.seed,
      frame: 320,
      lines: 9,
      pieces: 20,
      elapsedFrames: 320,
    }, 7400);

    expect(afterStaleElimination.status).toBe('countdown');
    expect(afterStaleElimination.players.every((player) => player.alive && player.status === 'ready')).toBe(true);
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
      seed: room.seed,
      result: 'won',
      lines: 40,
      pieces: 100,
      elapsedFrames: 3600,
    }, 5000);
    await updateProgress(store, {
      roomId: room.id,
      authorityPlayerId: 'player-host-2',
      playerId: 'player-host-2',
      seed: room.seed,
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
    const playing = await getRoomState(store, room.id, 7000);

    // Self-report: un invitado SÍ puede postear su PROPIO progreso (fallback
    // cuando su canal al host está caído), pero no debe mover el reloj de
    // actividad de la sala (alimenta el failover del host).
    const selfReported = await updateProgress(store, {
      roomId: room.id,
      authorityPlayerId: 'player-guest-auth',
      playerId: 'player-guest-auth',
      seed: playing.seed,
      lines: 8,
      pieces: 24,
      elapsedFrames: 600,
    }, 7100);
    expect(selfReported.players.find((player) => player.id === 'player-guest-auth')?.lines).toBe(8);
    expect(selfReported.updatedAtServerMs).toBe(playing.updatedAtServerMs);

    // Pero un invitado NO puede actualizar el progreso de OTRO jugador.
    await expect(updateProgress(store, {
      roomId: room.id,
      authorityPlayerId: 'player-guest-auth',
      playerId: 'player-host-auth',
      seed: playing.seed,
      lines: 3,
      pieces: 5,
      elapsedFrames: 100,
    }, 7150)).rejects.toThrow('Only the host');

    await expect(addAttack(store, {
      roomId: room.id,
      attackId: 'guest-attack-1',
      authorityPlayerId: 'player-guest-auth',
      fromPlayerId: 'player-guest-auth',
      toPlayerId: 'player-host-auth',
      seed: playing.seed,
      lines: 2,
      holeSeed: 99,
      frame: 600,
    }, 7200)).rejects.toThrow('Only the host');

    await expect(eliminatePlayer(store, {
      roomId: room.id,
      authorityPlayerId: 'player-guest-auth',
      playerId: 'player-host-auth',
      seed: playing.seed,
      frame: 620,
      lines: 9,
      pieces: 26,
      elapsedFrames: 620,
    }, 7300)).rejects.toThrow('Only the host');

    const updated = await updateProgress(store, {
      roomId: room.id,
      authorityPlayerId: 'player-host-auth',
      playerId: 'player-guest-auth',
      seed: playing.seed,
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
    const started = await startRoom(store, { roomId: room.id, playerId: 'player-host-4' }, 1400);

    const request = {
      roomId: room.id,
      attackId: 'attack-1',
      authorityPlayerId: 'player-host-4',
      fromPlayerId: 'player-host-4',
      toPlayerId: 'player-guest-4',
      seed: started.seed,
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
    const playing = await getRoomState(store, room.id, 7000);

    const finished = await eliminatePlayer(store, {
      roomId: room.id,
      authorityPlayerId: 'player-host-5',
      playerId: 'player-guest-5',
      seed: playing.seed,
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
    const playing = await getRoomState(store, room.id, 7000);

    const updated = await eliminatePlayer(store, {
      roomId: room.id,
      authorityPlayerId: 'player-host-6',
      playerId: 'player-guest-6a',
      seed: playing.seed,
      frame: 300,
      lines: 6,
      pieces: 20,
      elapsedFrames: 300,
    }, 7100);

    expect(updated.status).toBe('playing');
    expect(updated.winnerPlayerId).toBeNull();
    expect(updated.players.filter((player) => player.alive)).toHaveLength(2);
  });

  it('crowns the faster finisher when two players report a win in the same round', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'co-host-1',
      name: 'Host',
      visibility: 'private',
    }, 1000);
    await joinRoom(store, { roomId: room.id, playerId: 'co-guest-1', name: 'Guest' }, 1100);
    for (const playerId of ['co-host-1', 'co-guest-1']) {
      await setPlayerReady(store, { roomId: room.id, playerId, ready: true }, 1200);
    }
    await startRoom(store, { roomId: room.id, playerId: 'co-host-1' }, 1300);
    const playing = await getRoomState(store, room.id, 7000);

    // El más LENTO reporta primero. El ganador debe salir del ranking (menos
    // frames), no del orden de llegada al servidor.
    await submitResult(store, {
      roomId: room.id,
      authorityPlayerId: 'co-host-1',
      playerId: 'co-host-1',
      seed: playing.seed,
      result: 'won',
      lines: 40,
      pieces: 100,
      elapsedFrames: 5000,
    }, 7100);
    const finished = await submitResult(store, {
      roomId: room.id,
      authorityPlayerId: 'co-host-1',
      playerId: 'co-guest-1',
      seed: playing.seed,
      result: 'won',
      lines: 40,
      pieces: 98,
      elapsedFrames: 3600,
    }, 7200);

    expect(finished.status).toBe('finished');
    expect(finished.winnerPlayerId).toBe('co-guest-1');
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

  it('scales the back-to-back bonus with the chain length', () => {
    const attackAt = (b2b: number) => calculateAttack({ table: 'modern', cleared: 4, combo: 0, b2b }).attackLines;
    expect(attackAt(1)).toBe(4);
    expect(attackAt(2)).toBe(5);
    expect(attackAt(4)).toBe(6);
    expect(attackAt(8)).toBe(8);
  });

  it('lets the stack live above the visible field indefinitely (no top-out timer)', () => {
    const engine = new GameEngine(99, {
      ...DEFAULT_RULES,
      gravityCellsPerFrame: 0,
      softDropCellsPerFrame: 0,
      lockDelayFrames: 10_000,
    });
    const unsafe = engine as unknown as { board: Cell[][] };
    // Una celda en las filas ocultas: la pila sobresale del área visible.
    unsafe.board[0][0] = 'I';

    // Estilo tetr.io: apilar en el buffer no mata por tiempo. Corremos muy por
    // encima de la antigua ventana de gracia y la partida sigue viva.
    let state = engine.getState();
    const frames = state.stats.topOutGraceFrames * 3;
    for (let frame = 1; frame <= frames; frame += 1) {
      state = engine.tick(frame);
    }
    expect(state.status).toBe('playing');
    expect(state.stats.aboveFieldFrames).toBe(frames);
  });

  it('still tops out when a new piece cannot spawn (block out)', () => {
    const engine = new GameEngine(123, {
      ...DEFAULT_RULES,
      gravityCellsPerFrame: 0,
      softDropCellsPerFrame: 0,
    });
    const unsafe = engine as unknown as { board: Cell[][] };
    // Ocupamos las columnas del spawn (3..6) en las dos filas donde nace la pieza,
    // sin completar la fila (cols 0..2 y 7..9 vacías) para no disparar un line clear.
    // La pieza activa actual se fija y la siguiente no entra → block-out.
    const spawnRow = DEFAULT_RULES.hiddenRows - 2;
    for (let x = 3; x <= 6; x += 1) {
      unsafe.board[spawnRow][x] = 'I';
      unsafe.board[spawnRow + 1][x] = 'I';
    }

    const state = engine.tick(1, [{ frame: 1, action: 'hardDrop' }]);
    expect(state.status).toBe('gameover');
    expect(state.stats.gameOverReason).toBe('blockOut');
  });

  it('lifts the active piece when incoming garbage rises into it instead of killing', () => {
    const engine = new GameEngine(7, {
      ...BATTLE_RULES,
      boardWidth: 4,
      visibleRows: 6,
      hiddenRows: 2,
      nextPreview: 1,
      gravityCellsPerFrame: 0,
      softDropCellsPerFrame: 0,
      lockDelayFrames: 10_000,
      garbageTravelFrames: 0,
      garbageActivationFrames: 0,
    });
    const unsafe = engine as unknown as { active: ActivePiece };
    unsafe.active = { type: 'O', x: 0, y: 6, rotation: 0 };

    engine.queueGarbage(4, 1, 0);
    const state = engine.tick(1);

    expect(state.status).toBe('playing');
    expect(state.active).not.toBeNull();
    expect(state.active!.y).toBeLessThan(6);
  });

  it('reopens a finished room back to the lobby with a fresh seed and ready players', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-reopen-host',
      name: 'Host',
      visibility: 'private',
      mode: 'custom',
      matchType: 'custom',
    }, 1000);
    await joinRoom(store, { roomId: room.id, playerId: 'player-reopen-guest', name: 'Guest' }, 1100);
    const started = await startRoom(store, { roomId: room.id, playerId: 'player-reopen-host' }, 1200);
    const finished = await eliminatePlayer(store, {
      roomId: room.id,
      authorityPlayerId: 'player-reopen-host',
      playerId: 'player-reopen-guest',
      seed: started.seed,
      frame: 600,
      lines: 3,
      pieces: 9,
      elapsedFrames: 600,
    }, 1300);
    expect(finished.status).toBe('finished');

    const reopened = await reopenRoom(store, { roomId: room.id, playerId: 'player-reopen-host' }, 1400);
    expect(reopened.status).toBe('lobby');
    expect(reopened.seed).not.toBe(started.seed);
    expect(reopened.winnerPlayerId).toBeNull();
    expect(reopened.bet).toBeNull();
    expect(reopened.players.every((player) => player.ready && player.status === 'ready' && player.alive)).toBe(true);
  });

  it('changes only the visibility with a visibilityOnly settings update', async () => {
    const store = new MemoryRoomStore();
    const room = await createRoom(store, {
      playerId: 'player-visonly-host',
      name: 'Host',
      visibility: 'private',
      mode: 'custom',
      matchType: 'custom',
    }, 1000);
    await joinRoom(store, { roomId: room.id, playerId: 'player-visonly-guest', name: 'Guest' }, 1100);
    await setPlayerReady(store, { roomId: room.id, playerId: 'player-visonly-guest', ready: false }, 1200);

    const updated = await updateRoomSettings(store, {
      roomId: room.id,
      playerId: 'player-visonly-host',
      visibility: 'public',
      visibilityOnly: true,
      matchType: 'custom',
    }, 1300);

    expect(updated.visibility).toBe('public');
    const guest = updated.players.find((player) => player.id === 'player-visonly-guest');
    expect(guest?.ready).toBe(false);
    expect((await listPublicRooms(store, 1400)).map((summary) => summary.id)).toEqual([room.id]);
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
    npub: null,
    name: id,
    avatarUrl: null,
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
