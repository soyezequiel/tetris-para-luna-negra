import { describe, expect, it } from 'vitest';
import {
  OnlineReplayCollector,
  type MultiplayerReplay,
  type MultiplayerReplayPlayer,
} from '../src/app/multiplayerReplay';
import { MultiReplayPlayback } from '../src/app/multiReplayPlayback';
import { createExportedReplay } from '../src/app/replayExport';
import { importReplayValue } from '../src/app/replayImport';
import { ReplayPlayback } from '../src/app/replayPlayback';
import { createReplayLog, recordGarbage, recordInput } from '../src/game/replay';
import { GameEngine } from '../src/game/engine';
import { DEFAULT_RULES } from '../src/game/rules';
import { DEFAULT_INPUT_SETTINGS } from '../src/input/settings';
import type { GameInput } from '../src/game/types';

// Corre un motor con los inputs dados hasta `frames`, devolviendo el tablero
// final — la referencia "en vivo" contra la que validar el visor multi-tablero.
function runEngine(seed: number, inputs: GameInput[], frames: number): GameEngine {
  const engine = new GameEngine(seed);
  let index = 0;
  for (let frame = 1; frame <= frames; frame += 1) {
    const frameInputs: GameInput[] = [];
    while (index < inputs.length && inputs[index].frame === frame) {
      frameInputs.push(inputs[index]);
      index += 1;
    }
    engine.tick(frame, frameInputs);
  }
  return engine;
}

function buildPlayer(overrides: Partial<MultiplayerReplayPlayer> = {}): MultiplayerReplayPlayer {
  return {
    playerId: 'p1',
    name: 'Player One',
    seed: 100,
    rules: DEFAULT_RULES,
    inputs: [],
    garbage: [],
    ...overrides,
  };
}

describe('OnlineReplayCollector', () => {
  it('collects one log per player for the active seed', () => {
    const collector = new OnlineReplayCollector();
    collector.reset(100);

    expect(collector.add(buildPlayer({ playerId: 'a' }))).toBe(true);
    expect(collector.add(buildPlayer({ playerId: 'b' }))).toBe(true);
    expect(collector.size()).toBe(2);
    expect(collector.has('a')).toBe(true);
  });

  it('keeps the first log and ignores duplicate resends for a player', () => {
    const collector = new OnlineReplayCollector();
    collector.reset(100);

    expect(collector.add(buildPlayer({ playerId: 'a', name: 'First' }))).toBe(true);
    expect(collector.add(buildPlayer({ playerId: 'a', name: 'Resend' }))).toBe(false);

    const built = collector.build('room-1', '2026-01-01T00:00:00.000Z');
    expect(built?.players).toHaveLength(1);
    expect(built?.players[0].name).toBe('First');
  });

  it('rejects logs whose seed does not match the round', () => {
    const collector = new OnlineReplayCollector();
    collector.reset(100);

    expect(collector.add(buildPlayer({ playerId: 'a', seed: 999 }))).toBe(false);
    expect(collector.size()).toBe(0);
  });

  it('drops stale logs after a reset to a new round seed', () => {
    const collector = new OnlineReplayCollector();
    collector.reset(100);
    collector.add(buildPlayer({ playerId: 'a' }));

    collector.reset(200);
    expect(collector.size()).toBe(0);
    expect(collector.add(buildPlayer({ playerId: 'a', seed: 200 }))).toBe(true);
  });

  it('builds a self-contained package and clones nested arrays', () => {
    const collector = new OnlineReplayCollector();
    collector.reset(100);
    const inputs: GameInput[] = [{ frame: 1, action: 'hardDrop' }];
    collector.add(buildPlayer({ playerId: 'a', inputs }));

    const built = collector.build('room-1', '2026-01-01T00:00:00.000Z');
    expect(built).toMatchObject({ version: 1, game: 'stack40', roomId: 'room-1', seed: 100 });
    expect(built?.players[0].inputs).toEqual(inputs);
    expect(built?.players[0].inputs).not.toBe(inputs);
  });

  it('returns null when there is nothing to build', () => {
    const collector = new OnlineReplayCollector();
    collector.reset(100);
    expect(collector.build('room-1')).toBeNull();
  });
});

describe('replay garbage determinism', () => {
  it('round-trips garbage events through export and import', () => {
    const log = createReplayLog(123);
    recordGarbage(log, { queuedAtFrame: 10, frame: 8, lines: 4, holeSeed: 3, id: 'g1' });
    const exported = createExportedReplay(
      log,
      new GameEngine(123).getState(),
      DEFAULT_INPUT_SETTINGS,
      '2026-01-01T00:00:00.000Z',
    );

    expect(exported.version).toBe(2);
    expect(exported.garbage).toEqual([{ queuedAtFrame: 10, frame: 8, lines: 4, holeSeed: 3, id: 'g1' }]);

    const imported = importReplayValue(JSON.parse(JSON.stringify(exported)));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.replay.garbage).toEqual(exported.garbage);
  });

  it('imports a v1 replay (no garbage field) as garbage-free', () => {
    const log = createReplayLog(55);
    const exported = createExportedReplay(
      log,
      new GameEngine(55).getState(),
      DEFAULT_INPUT_SETTINGS,
      '2026-01-01T00:00:00.000Z',
    );
    const legacy = JSON.parse(JSON.stringify(exported)) as Record<string, unknown>;
    legacy.version = 1;
    delete legacy.garbage;

    const imported = importReplayValue(legacy);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.replay.garbage).toEqual([]);
  });

  it('reproduces the exact board when replaying recorded garbage', () => {
    const seed = 777;
    const live = new GameEngine(seed);
    const log = createReplayLog(seed);
    const FRAMES = 200;

    for (let frame = 1; frame <= FRAMES; frame += 1) {
      const frameInputs: GameInput[] = [];
      if (frame % 20 === 0) frameInputs.push({ frame, action: 'hardDrop' });
      for (const event of frameInputs) recordInput(log, event);
      live.tick(frame, frameInputs);
      // La basura se encola DESPUÉS del tick, igual que en vivo (applyOnlineAttack).
      if (frame === 30) {
        live.queueGarbage(2, 5, frame, 'g1');
        recordGarbage(log, { queuedAtFrame: frame, frame, lines: 2, holeSeed: 5, id: 'g1' });
      }
    }

    const exported = createExportedReplay(log, live.getState(), DEFAULT_INPUT_SETTINGS, '2026-01-01T00:00:00.000Z');
    const playback = new ReplayPlayback(exported);
    let snapshot = playback.snapshot();
    while (!snapshot.done) snapshot = playback.tick();

    const liveState = live.getState();
    expect(snapshot.frame).toBe(FRAMES);
    expect(snapshot.state.board).toEqual(liveState.board);
    expect(snapshot.state.stats.receivedGarbage).toBe(liveState.stats.receivedGarbage);
    expect(liveState.stats.receivedGarbage).toBeGreaterThan(0);
  });
});

describe('MultiReplayPlayback', () => {
  function buildInputs(period: number, count: number): GameInput[] {
    const inputs: GameInput[] = [];
    for (let i = 1; i <= count; i += 1) inputs.push({ frame: i * period, action: 'hardDrop' });
    return inputs;
  }

  const playerA: MultiplayerReplayPlayer = {
    playerId: 'a', name: 'Ada', seed: 11, rules: DEFAULT_RULES,
    inputs: buildInputs(15, 6), garbage: [],
  };
  const playerB: MultiplayerReplayPlayer = {
    playerId: 'b', name: 'Boris', seed: 22, rules: DEFAULT_RULES,
    inputs: buildInputs(12, 10), garbage: [],
  };
  const replay: MultiplayerReplay = {
    version: 1, game: 'stack40', createdAt: '2026-01-01T00:00:00.000Z',
    roomId: 'room-1', seed: 11, players: [playerA, playerB],
  };

  it('reproduces each player board in sync and ends on the longest run', () => {
    const playback = new MultiReplayPlayback(replay);
    let snapshot = playback.snapshot();
    while (!snapshot.done) snapshot = playback.tick();

    // El timeline corre hasta que todos los tableros se asientan: el último input
    // de B es 120, y B se congela el frame siguiente (sin garbage pendiente).
    expect(snapshot.targetFrame).toBe(121);
    expect(snapshot.frame).toBe(121);
    expect(snapshot.done).toBe(true);

    const boardA = snapshot.players.find((p) => p.playerId === 'a')!;
    const boardB = snapshot.players.find((p) => p.playerId === 'b')!;
    // Cada tablero, en su endFrame, coincide con un motor corrido por separado.
    expect(boardA.state.board).toEqual(runEngine(11, playerA.inputs, 90).getState().board);
    expect(boardB.state.board).toEqual(runEngine(22, playerB.inputs, 120).getState().board);
  });

  it('freezes a finished board while the timeline keeps running', () => {
    const playback = new MultiReplayPlayback(replay);
    // Avanza más allá del endFrame de A (90) pero antes del de B (120).
    let snapshot = playback.snapshot();
    while (snapshot.frame < 105) snapshot = playback.tick();

    const frozen = snapshot.players.find((p) => p.playerId === 'a')!;
    expect(frozen.finished).toBe(true);
    const boardAtFreeze = frozen.state.board;

    // Seguir avanzando no debe mover el tablero congelado de A.
    while (!snapshot.done) snapshot = playback.tick();
    const stillFrozen = snapshot.players.find((p) => p.playerId === 'a')!;
    expect(stillFrozen.state.board).toEqual(boardAtFreeze);
  });

  it('restart returns every board to the initial frame', () => {
    const playback = new MultiReplayPlayback(replay);
    let snapshot = playback.tick();
    while (!snapshot.done) snapshot = playback.tick();
    expect(snapshot.frame).toBeGreaterThan(0);

    playback.restart();
    const reset = playback.snapshot();
    expect(reset.frame).toBe(0);
    expect(reset.paused).toBe(false);
    for (const player of reset.players) expect(player.state.stats.frame).toBe(0);
  });
});
