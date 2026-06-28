import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createRoom,
  eliminatePlayer,
  getRoomState,
  HOST_STALE_MS,
  joinRoom,
  leaveRoom,
  loadRoom,
  MemoryRoomStore,
  PLAYER_ABANDON_MS,
  ROOM_START_DELAY_MS,
  setPlayerReady,
  startRoom,
  updateProgress,
  type RoomStore,
} from '../src/online/roomService';
import type { EliminateRequest, OnlineRoom, ProgressRequest } from '../src/online/protocol';
import { createBetForRoom, settleRoomBet, syncBetParticipantsWithRoom } from '../src/online/lunaNegraBets';
import { resetLunaMock, setLunaMockEnabled } from '../src/online/lunaNegraMock';
import { evaluateHardTest, type HardTestConfig, type HardTestEvidence } from '../src/dev/hardTestReport';

// 8 jugadores: el host + 7 invitados, igual que el hard test interactivo (vos + 7 bots).
// Los ids deben tener 8-80 chars (normalizePlayerId), por eso el prefijo largo.
const PLAYER_IDS = Array.from({ length: 8 }, (_, i) => `hardtest-player-${i}`);
const HOST_ID = PLAYER_IDS[0];
const P = (i: number): string => PLAYER_IDS[i];

const baseConfig: HardTestConfig = {
  playerCount: 8,
  scenarios: { hostDisconnect: false, playerAbandon: false, doubleKo: false },
  withMockedBet: false,
  stakeSats: 10,
};

/** Lleva una sala de N jugadores a 'playing' con el último latido del host en startedAtMs. */
async function buildPlayingRoom(store: RoomStore, playerIds: string[], startedAtMs: number): Promise<OnlineRoom> {
  const [hostId, ...guestIds] = playerIds;
  const createdAt = startedAtMs - ROOM_START_DELAY_MS - 1;
  const created = await createRoom(store, { playerId: hostId, name: hostId, visibility: 'private' }, createdAt);
  for (const guestId of guestIds) {
    await joinRoom(store, { roomId: created.id, playerId: guestId, name: guestId }, createdAt);
  }
  for (const playerId of playerIds) {
    await setPlayerReady(store, { roomId: created.id, playerId, ready: true }, createdAt);
  }
  await startRoom(store, { roomId: created.id, playerId: hostId }, createdAt);
  // El primer progreso del host pasa countdown→playing y fija su último latido.
  let room = await updateProgress(store, progressOf(created.id, hostId, created.seed), startedAtMs);
  expect(room.status).toBe('playing');
  // Cada invitado muestra presencia al arranque (refresca su timestamp sin mover el reloj del room).
  for (const guestId of guestIds) {
    room = await updateProgress(store, progressOf(room.id, guestId, room.seed), startedAtMs);
  }
  return room;
}

function progressOf(roomId: string, playerId: string, seed: number, elapsedFrames = 1): ProgressRequest {
  return { roomId, authorityPlayerId: playerId, playerId, seed, lines: 0, pieces: 1, elapsedFrames };
}

function eliminateReq(room: OnlineRoom, playerId: string, frame: number): EliminateRequest {
  return {
    roomId: room.id,
    authorityPlayerId: HOST_ID,
    playerId,
    seed: room.seed,
    frame,
    lines: 1,
    pieces: 10,
    elapsedFrames: frame,
  };
}

function evidenceFrom(room: OnlineRoom, overrides: Partial<HardTestEvidence> = {}): HardTestEvidence {
  return {
    config: baseConfig,
    originalHostId: HOST_ID,
    suppressedPlayerId: null,
    doubleKoPlayerIds: [],
    finalRoom: room,
    reachedFinished: room.status === 'finished',
    timeline: [],
    errors: [],
    startedAtMs: 0,
    endedAtMs: 1000,
    ...overrides,
  };
}

describe('hard test: caminos no felices a nivel roomService', () => {
  it('abandono silencioso: el jugador ausente sale de la ronda sin colgar la sala', async () => {
    const store = new MemoryRoomStore();
    const startedAtMs = 1_000_000;
    const room = await buildPlayingRoom(store, PLAYER_IDS, startedAtMs);

    // Host y todos menos P(3) siguen presentes justo antes del barrido; P(3) se quedó en startedAtMs.
    const sweepAt = startedAtMs + PLAYER_ABANDON_MS + 2_000;
    for (const id of PLAYER_IDS) {
      if (id === P(3)) continue;
      await updateProgress(store, progressOf(room.id, id, room.seed, 50), sweepAt - 1);
    }
    const recovered = await getRoomState(store, room.id, sweepAt);

    const p3 = recovered.players.find((p) => p.id === P(3));
    expect(p3?.status).toBe('eliminated');
    expect(p3?.alive).toBe(false);
    // Quedan 7 vivos: la ronda sigue, no se cuelga.
    expect(recovered.status).toBe('playing');
    expect(recovered.players.filter((p) => p.alive)).toHaveLength(7);
  });

  it('host se cae: la autoridad migra a un jugador vivo y el host queda eliminado', async () => {
    const store = new MemoryRoomStore();
    const startedAtMs = 2_000_000;
    const room = await buildPlayingRoom(store, PLAYER_IDS, startedAtMs);

    // Nadie escribe: el room queda stale → manda el host failover.
    const recovered = await getRoomState(store, room.id, startedAtMs + HOST_STALE_MS + 1);

    expect(recovered.hostPlayerId).not.toBe(HOST_ID);
    expect(PLAYER_IDS.slice(1)).toContain(recovered.hostPlayerId);
    const oldHost = recovered.players.find((p) => p.id === HOST_ID);
    expect(oldHost?.status).toBe('eliminated');
    expect(oldHost?.alive).toBe(false);

    const result = evaluateHardTest(evidenceFrom(recovered, {
      config: { ...baseConfig, scenarios: { ...baseConfig.scenarios, hostDisconnect: true } },
    }));
    expect(result.checks.find((c) => c.name === 'hostFailover')?.pass).toBe(true);
  });

  it('doble-KO con KO tardío: re-corona al verdadero último en pie, no al del paquete que llegó primero', async () => {
    const store = new MemoryRoomStore();
    const startedAtMs = 3_000_000;
    const room = await buildPlayingRoom(store, PLAYER_IDS, startedAtMs);

    // Eliminamos a 6 jugadores temprano; quedan P(1) y P(2).
    let atMs = startedAtMs + 1_000;
    for (const id of [P(3), P(4), P(5), P(6), P(7), HOST_ID]) {
      await eliminatePlayer(store, eliminateReq(room, id, 200), atMs);
      atMs += 10;
    }
    // P(2) muere a frame 1000. Como queda P(1) vivo, el server corona a P(1).
    let recovered = await eliminatePlayer(store, eliminateReq(room, P(2), 1000), atMs);
    expect(recovered.winnerPlayerId).toBe(P(1));

    // Pero el KO de P(1) llega tarde: murió a frame 500 (antes que P(2)). Re-coronación → P(2).
    recovered = await eliminatePlayer(store, eliminateReq(room, P(1), 500), atMs + 50);
    expect(recovered.winnerPlayerId).toBe(P(2));
    expect(recovered.players.find((p) => p.id === P(1))?.status).toBe('eliminated');

    const result = evaluateHardTest(evidenceFrom(recovered, {
      config: { ...baseConfig, scenarios: { ...baseConfig.scenarios, doubleKo: true } },
      doubleKoPlayerIds: [P(1), P(2)],
    }));
    expect(result.checks.find((c) => c.name === 'recrown')?.pass).toBe(true);
  });
});

describe('hard test: apuesta mockeada (money-path)', () => {
  beforeEach(() => {
    setLunaMockEnabled(true);
    resetLunaMock();
    process.env.LUNA_NEGRA_GAME_ID = 'test-game';
  });
  afterEach(() => {
    setLunaMockEnabled(false);
    delete process.env.LUNA_NEGRA_GAME_ID;
  });

  async function lobbyRoom(store: RoomStore): Promise<OnlineRoom> {
    const created = await createRoom(store, { playerId: HOST_ID, name: HOST_ID, visibility: 'private' });
    for (const id of PLAYER_IDS.slice(1)) {
      await joinRoom(store, { roomId: created.id, playerId: id, name: id });
    }
    return loadRoom(store, created.id);
  }

  it('crea y fondea la apuesta (mock auto-funded) con un asiento por jugador', async () => {
    const store = new MemoryRoomStore();
    const lobby = await lobbyRoom(store);
    const room = await createBetForRoom(store, { roomId: lobby.id, playerId: HOST_ID, stakeSats: 10 });
    expect(room.bet?.status).toBe('funded');
    expect(room.bet?.participants).toHaveLength(8);
    expect(room.bet?.participants.every((p) => p.depositStatus === 'paid')).toBe(true);
  });

  it('reembolso a todos cuando un fundeador deja la sala en el lobby', async () => {
    const store = new MemoryRoomStore();
    const lobby = await lobbyRoom(store);
    await createBetForRoom(store, { roomId: lobby.id, playerId: HOST_ID, stakeSats: 10 });
    // Un participante con depósito se va: sync cancela y reembolsa todo el pozo.
    await leaveRoom(store, { roomId: lobby.id, playerId: P(5) });
    const room = await syncBetParticipantsWithRoom(store, lobby.id);
    expect(['cancelled', 'refunded']).toContain(room.bet?.status);
    expect(room.bet?.participants.every((p) => p.depositStatus !== 'paid')).toBe(true);
  });

  it('liquida y paga al ganador cuando la sala termina', async () => {
    const store = new MemoryRoomStore();
    const lobby = await lobbyRoom(store);
    await createBetForRoom(store, { roomId: lobby.id, playerId: HOST_ID, stakeSats: 10 });

    // Llevamos la sala a 'playing' y coronamos a p1 eliminando a los otros 7.
    for (const id of PLAYER_IDS) {
      await setPlayerReady(store, { roomId: lobby.id, playerId: id, ready: true });
    }
    await startRoom(store, { roomId: lobby.id, playerId: HOST_ID });
    let room = await updateProgress(store, progressOf(lobby.id, HOST_ID, lobby.seed), Date.now());
    for (const id of PLAYER_IDS) {
      if (id === P(1)) continue;
      room = await eliminatePlayer(store, eliminateReq(room, id, 300));
    }
    expect(room.status).toBe('finished');
    expect(room.winnerPlayerId).toBe(P(1));

    const settled = await settleRoomBet(store, room.id, HOST_ID);
    expect(settled.bet?.status).toBe('settled');
    const winnerEntry = settled.bet?.participants.find((p) => p.playerId === P(1));
    expect(winnerEntry?.payoutSats ?? 0).toBeGreaterThan(0);

    const result = evaluateHardTest(evidenceFrom(settled, {
      config: { ...baseConfig, withMockedBet: true },
    }));
    expect(result.checks.find((c) => c.name === 'betConserved')?.pass).toBe(true);
    expect(result.checks.find((c) => c.name === 'singleWinner')?.pass).toBe(true);
    expect(result.checks.find((c) => c.name === 'noHang')?.pass).toBe(true);
  });
});

describe('hard test: checker de invariantes', () => {
  it('falla cuando la sala quedó colgada (no llegó a finished)', () => {
    const fakeRoom = {
      id: 'r', status: 'playing', hostPlayerId: HOST_ID, winnerPlayerId: null,
      players: [], bet: null,
    } as unknown as OnlineRoom;
    const result = evaluateHardTest(evidenceFrom(fakeRoom, { reachedFinished: false }));
    expect(result.pass).toBe(false);
    expect(result.checks.find((c) => c.name === 'noHang')?.pass).toBe(false);
  });

  it('marca como error global cualquier excepción capturada durante la corrida', () => {
    const fakeRoom = {
      id: 'r', status: 'finished', hostPlayerId: HOST_ID, winnerPlayerId: 'p1',
      players: [{ id: 'p1', name: 'p1', status: 'won', alive: true, elapsedFrames: 100, eliminatedAtFrame: null }],
      bet: null,
    } as unknown as OnlineRoom;
    const result = evaluateHardTest(evidenceFrom(fakeRoom, { errors: ['boom'] }));
    expect(result.checks.find((c) => c.name === 'noErrors')?.pass).toBe(false);
    expect(result.pass).toBe(false);
  });
});
