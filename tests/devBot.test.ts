import { describe, expect, it } from 'vitest';
import { DevBotOpponent, type DevBotAttackIntent, type DevBotConfig } from '../src/dev/devBotOpponent';
import type { OnlinePeerKoMessage, OnlinePeerReplayMessage } from '../src/online/peerBroadcast';
import type { JoinRoomRequest, OnlineAttack, OnlineGameSnapshot, OnlineRoom } from '../src/online/protocol';
import { createRoom, joinRoom, MemoryRoomStore, startRoom } from '../src/online/roomService';
import { MultiReplayPlayback } from '../src/app/multiReplayPlayback';

const HOST_ID = 'host-player-1';
const GAME_FRAME_MS = 1000 / 60;
// Tope de catch-up del bot por llamada a frame() (ver MAX_CATCHUP_FRAMES).
const FRAMES_PER_CALL = 120;

interface BotHarness {
  bot: DevBotOpponent;
  room: () => OnlineRoom;
  setRoom: (next: OnlineRoom) => void;
  intents: DevBotAttackIntent[];
  kos: Omit<OnlinePeerKoMessage, 'type'>[];
  snapshots: OnlineGameSnapshot[];
  replays: Omit<OnlinePeerReplayMessage, 'type'>[];
  /** Avanza el reloj del servidor y llama frame() las veces necesarias. */
  advance: (frames: number) => void;
  now: () => number;
}

// Sala REAL del roomService (mismo store en memoria que usa el server local) con
// el humano de host y el bot unido por su propio client stub, ya en countdown.
async function createBotHarness(config: Partial<DevBotConfig> = {}): Promise<BotHarness> {
  const store = new MemoryRoomStore();
  let room = await createRoom(store, { playerId: HOST_ID, name: 'Host', visibility: 'private' });
  let now = Date.now();
  const intents: DevBotAttackIntent[] = [];
  const kos: Omit<OnlinePeerKoMessage, 'type'>[] = [];
  const snapshots: OnlineGameSnapshot[] = [];
  const replays: Omit<OnlinePeerReplayMessage, 'type'>[] = [];
  const bot = new DevBotOpponent({
    getRoom: () => room,
    getNowMs: () => now,
    botRules: () => ({ ...room.rules, attackTable: room.ruleset.attackTable }),
    deliverAttackIntent: (intent) => intents.push(intent),
    deliverSnapshot: (_playerId, game) => snapshots.push(game),
    commitKo: (report) => kos.push(report),
    deliverReplay: (report) => replays.push(report),
  }, {
    joinRoom: async (request: JoinRoomRequest) => {
      room = await joinRoom(store, request);
      return { room, serverNowMs: now };
    },
    leaveRoom: async () => ({ room: null, hostMigratedTo: null, serverNowMs: now }),
  }, { inputCadenceFrames: 1, mistakeRate: 0, ...config });
  await bot.join(room.id);
  room = await startRoom(store, { roomId: room.id, playerId: HOST_ID });
  // Arrancamos el reloj un segundo ANTES del inicio de ronda: el bot debe
  // esperar el countdown igual que un cliente real.
  now = (room.startsAtServerMs ?? now) - 1000;
  return {
    bot,
    room: () => room,
    setRoom: (next) => { room = next; },
    intents,
    kos,
    snapshots,
    replays,
    advance: (frames) => {
      for (let advanced = 0; advanced < frames; advanced += FRAMES_PER_CALL) {
        now += Math.min(FRAMES_PER_CALL, frames - advanced) * GAME_FRAME_MS;
        bot.frame();
      }
    },
    now: () => now,
  };
}

function attackAgainstBot(harness: BotHarness, id: string, lines: number): OnlineAttack {
  const room = harness.room();
  return {
    id,
    roomId: room.id,
    authorityPlayerId: room.hostPlayerId,
    fromPlayerId: HOST_ID,
    toPlayerId: harness.bot.playerId,
    seed: room.seed,
    lines,
    holeSeed: 5,
    frame: 1,
    createdAtServerMs: harness.now(),
  };
}

describe('DevBotOpponent', () => {
  it('joins the room, plays on the server timeline and clears lines', async () => {
    const harness = await createBotHarness();
    expect(harness.room().players.some((player) => player.id === harness.bot.playerId)).toBe(true);

    // Antes de startsAtServerMs no debe simular nada.
    harness.bot.frame();
    expect(harness.bot.getState()).toBeNull();

    harness.advance(3600);
    const state = harness.bot.getState();
    expect(state).not.toBeNull();
    expect(state!.stats.pieces).toBeGreaterThan(10);
    expect(state!.stats.lines).toBeGreaterThan(0);
    expect(harness.snapshots.length).toBeGreaterThan(0);
    expect(harness.snapshots.at(-1)!.seed).toBe(harness.room().seed);
  });

  it('delivers a synthetic attack intent on forceAttack', async () => {
    const harness = await createBotHarness();
    harness.advance(FRAMES_PER_CALL);
    // El bot puede haber emitido intents orgánicos (combos) mientras jugaba.
    const organicIntents = harness.intents.length;
    harness.bot.forceAttack(2);
    expect(harness.intents.length).toBe(organicIntents + 1);
    expect(harness.intents.at(-1)).toMatchObject({ fromPlayerId: harness.bot.playerId, lines: 2 });
  });

  it('applies an incoming attack exactly once (dedupe by attack id)', async () => {
    const harness = await createBotHarness();
    harness.advance(FRAMES_PER_CALL);

    const attack = attackAgainstBot(harness, 'attack-1', 2);
    harness.setRoom({ ...harness.room(), attacks: [attack] });
    harness.advance(FRAMES_PER_CALL);
    expect(harness.bot.getState()!.stats.receivedGarbage).toBe(2);

    // El mismo ataque repetido en polls posteriores no se reaplica.
    harness.setRoom({ ...harness.room(), attacks: [attack, { ...attack }] });
    harness.advance(FRAMES_PER_CALL);
    expect(harness.bot.getState()!.stats.receivedGarbage).toBe(2);
  });

  it('reports its KO exactly once after forceTopOut', async () => {
    const harness = await createBotHarness();
    harness.advance(FRAMES_PER_CALL);
    harness.bot.forceTopOut();
    harness.advance(3600);
    expect(harness.bot.getState()!.status).toBe('gameover');
    expect(harness.kos.length).toBe(1);
    expect(harness.kos[0].playerId).toBe(harness.bot.playerId);
    expect(harness.kos[0].seed).toBe(harness.room().seed);

    harness.advance(600);
    expect(harness.kos.length).toBe(1);
  });

  it('delivers a replay log once that reproduces the bot board', async () => {
    const harness = await createBotHarness();
    harness.advance(FRAMES_PER_CALL);
    harness.bot.forceTopOut();
    harness.advance(3600);
    const dead = harness.bot.getState()!;
    expect(dead.status).toBe('gameover');

    // Entrega exactamente un log, con inputs y la basura del top-out grabados.
    expect(harness.replays.length).toBe(1);
    const report = harness.replays[0];
    expect(report.playerId).toBe(harness.bot.playerId);
    expect(report.seed).toBe(harness.room().seed);
    expect(report.inputs.length).toBeGreaterThan(0);
    expect(report.garbage.length).toBeGreaterThan(0);

    // El log reproduce el tablero final del bot al correrlo en el visor.
    const playback = new MultiReplayPlayback({
      version: 1, game: 'stack40', createdAt: 'x', roomId: harness.room().id,
      seed: report.seed,
      players: [{ playerId: report.playerId, name: report.name, seed: report.seed, rules: report.rules, inputs: report.inputs, garbage: report.garbage }],
    });
    let snap = playback.snapshot();
    while (!snap.done) snap = playback.tick();
    const board = snap.players[0].state;
    expect(board.status).toBe('gameover');
    expect(board.board).toEqual(dead.board);

    // No se reentrega en frames posteriores.
    harness.advance(600);
    expect(harness.replays.length).toBe(1);
  });

  it('starts a fresh engine when the room reopens with a new seed', async () => {
    const harness = await createBotHarness();
    harness.advance(FRAMES_PER_CALL);
    harness.bot.forceTopOut();
    harness.advance(3600);
    expect(harness.bot.getState()!.status).toBe('gameover');

    // Reopen + nueva ronda: seed nueva y countdown nuevo, como hace el server.
    const nextSeed = (harness.room().seed + 1) >>> 0;
    harness.setRoom({
      ...harness.room(),
      seed: nextSeed,
      status: 'countdown',
      startsAtServerMs: harness.now() + 1000,
      attacks: [],
    });
    harness.advance(600);
    const state = harness.bot.getState();
    expect(state).not.toBeNull();
    expect(state!.seed).toBe(nextSeed);
    expect(state!.status).toBe('playing');
    expect(state!.stats.receivedGarbage).toBe(0);
  });
});
