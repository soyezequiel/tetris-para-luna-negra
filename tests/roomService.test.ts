import { describe, expect, it } from 'vitest';
import {
  addAttack,
  createRoom,
  eliminatePlayer,
  getRoomState,
  HOST_STALE_MS,
  joinRoom,
  MemoryRoomStore,
  ROOM_START_DELAY_MS,
  RoomVersionConflictError,
  setPlayerReady,
  startRoom,
  updateProgress,
  type RoomStore,
} from '../src/online/roomService';
import type { EliminateRequest, OnlineRoom, ProgressRequest } from '../src/online/protocol';

const HOST_ID = 'host-player-1';
const GUEST_ID = 'guest-player-1';
const THIRD_ID = 'third-player-1';

async function createPlayingRoom(store: RoomStore, playerIds = [HOST_ID, GUEST_ID]): Promise<OnlineRoom> {
  const [hostId, ...guestIds] = playerIds;
  const created = await createRoom(store, {
    playerId: hostId,
    name: 'Host',
    visibility: 'private',
  });
  for (const guestId of guestIds) {
    await joinRoom(store, { roomId: created.id, playerId: guestId, name: guestId });
  }
  for (const playerId of playerIds) {
    await setPlayerReady(store, { roomId: created.id, playerId, ready: true });
  }
  const room = await startRoom(store, { roomId: created.id, playerId: hostId });
  return room;
}

function eliminateRequest(room: OnlineRoom, playerId: string): EliminateRequest {
  return {
    roomId: room.id,
    authorityPlayerId: HOST_ID,
    playerId,
    seed: room.seed,
    frame: 100,
    lines: 5,
    pieces: 20,
    elapsedFrames: 100,
  };
}

describe('room store optimistic locking', () => {
  it('rejects a save based on a stale read', async () => {
    const store = new MemoryRoomStore();
    const room = await createPlayingRoom(store);
    const staleCopy = await store.getRoom(room.id);
    const freshCopy = await store.getRoom(room.id);
    if (!staleCopy || !freshCopy) throw new Error('room should exist');

    await store.saveRoom(freshCopy);
    await expect(store.saveRoom(staleCopy)).rejects.toBeInstanceOf(RoomVersionConflictError);
  });

  it('does not lose an elimination to a concurrent progress update', async () => {
    const store = new MemoryRoomStore();
    const room = await createPlayingRoom(store);

    // Simula el caso real: el server lee la sala para un updateProgress y, antes
    // de guardar, otro request elimina al guest y termina la partida. El store
    // con CAS obliga a reintentar el progress sobre la sala ya terminada.
    const slowStore: RoomStore = {
      getRoom: (id) => store.getRoom(id),
      saveRoom: (value) => store.saveRoom(value),
      deleteRoom: (id) => store.deleteRoom(id),
      listPublicRoomIds: () => store.listPublicRoomIds(),
      savePublicRoomIds: (ids) => store.savePublicRoomIds(ids),
      getPresenceRecords: () => store.getPresenceRecords(),
      savePresenceRecords: (records) => store.savePresenceRecords(records),
    };
    let interleaved = false;
    slowStore.getRoom = async (id) => {
      const value = await store.getRoom(id);
      if (!interleaved) {
        interleaved = true;
        await eliminatePlayer(store, eliminateRequest(room, GUEST_ID));
      }
      return value;
    };

    const result = await updateProgress(slowStore, {
      roomId: room.id,
      authorityPlayerId: HOST_ID,
      playerId: HOST_ID,
      seed: room.seed,
      lines: 3,
      pieces: 10,
      elapsedFrames: 90,
    });

    expect(result.status).toBe('finished');
    expect(result.winnerPlayerId).toBe(HOST_ID);
    const guest = result.players.find((player) => player.id === GUEST_ID);
    expect(guest?.status).toBe('eliminated');

    const persisted = await store.getRoom(room.id);
    expect(persisted?.status).toBe('finished');
    expect(persisted?.winnerPlayerId).toBe(HOST_ID);
  });
});

/**
 * Lleva una sala recién creada a estado 'playing' en un instante controlado y
 * deja `updatedAtServerMs` en `startedAtMs` (último latido del host), para poder
 * medir la inactividad del host de forma determinística.
 */
async function buildPlayingRoom(
  store: RoomStore,
  playerIds: string[],
  startedAtMs: number,
): Promise<OnlineRoom> {
  const [hostId, ...guestIds] = playerIds;
  const createdAt = startedAtMs - ROOM_START_DELAY_MS - 1;
  const created = await createRoom(store, { playerId: hostId, name: 'Host', visibility: 'private' }, createdAt);
  for (const guestId of guestIds) {
    await joinRoom(store, { roomId: created.id, playerId: guestId, name: guestId }, createdAt);
  }
  for (const playerId of playerIds) {
    await setPlayerReady(store, { roomId: created.id, playerId, ready: true }, createdAt);
  }
  const countdown = await startRoom(store, { roomId: created.id, playerId: hostId }, createdAt);
  // El primer progreso del host pasa la sala de countdown a playing y fija el
  // último latido del host en `startedAtMs`.
  const progress: ProgressRequest = {
    roomId: countdown.id,
    authorityPlayerId: hostId,
    playerId: hostId,
    seed: countdown.seed,
    lines: 0,
    pieces: 1,
    elapsedFrames: 1,
  };
  const room = await updateProgress(store, progress, startedAtMs);
  expect(room.status).toBe('playing');
  return room;
}

describe('host failover on disconnect', () => {
  it('migrates authority to a surviving player when the host goes stale', async () => {
    const store = new MemoryRoomStore();
    const startedAtMs = 1_000_000;
    const room = await buildPlayingRoom(store, [HOST_ID, GUEST_ID, THIRD_ID], startedAtMs);

    const recovered = await getRoomState(store, room.id, startedAtMs + HOST_STALE_MS + 1);

    // El host original sale de la ronda y la autoridad pasa al siguiente vivo.
    expect(recovered.hostPlayerId).not.toBe(HOST_ID);
    expect([GUEST_ID, THIRD_ID]).toContain(recovered.hostPlayerId);
    const oldHost = recovered.players.find((player) => player.id === HOST_ID);
    expect(oldHost?.status).toBe('eliminated');
    expect(oldHost?.alive).toBe(false);
    // Con dos jugadores vivos restantes, la ronda sigue.
    expect(recovered.status).toBe('playing');

    const persisted = await store.getRoom(room.id);
    expect(persisted?.hostPlayerId).toBe(recovered.hostPlayerId);
  });

  it('finishes the round when only one player survives the host disconnect', async () => {
    const store = new MemoryRoomStore();
    const startedAtMs = 2_000_000;
    const room = await buildPlayingRoom(store, [HOST_ID, GUEST_ID], startedAtMs);

    const recovered = await getRoomState(store, room.id, startedAtMs + HOST_STALE_MS + 1);

    expect(recovered.status).toBe('finished');
    expect(recovered.winnerPlayerId).toBe(GUEST_ID);
    expect(recovered.players.find((player) => player.id === HOST_ID)?.status).toBe('eliminated');
  });

  it('does not migrate while the host keeps the room fresh', async () => {
    const store = new MemoryRoomStore();
    const startedAtMs = 3_000_000;
    const room = await buildPlayingRoom(store, [HOST_ID, GUEST_ID, THIRD_ID], startedAtMs);

    const fresh = await getRoomState(store, room.id, startedAtMs + HOST_STALE_MS - 1);

    expect(fresh.hostPlayerId).toBe(HOST_ID);
    expect(fresh.status).toBe('playing');
    expect(fresh.players.find((player) => player.id === HOST_ID)?.alive).toBe(true);
  });

  it('migrates again in cascade when the new host is also gone', async () => {
    const store = new MemoryRoomStore();
    const startedAtMs = 4_000_000;
    const room = await buildPlayingRoom(store, [HOST_ID, GUEST_ID, THIRD_ID], startedAtMs);

    // El host original se cae: la autoridad migra al primer sucesor vivo y la
    // ronda sigue porque todavía quedan dos jugadores.
    const afterFirst = await getRoomState(store, room.id, startedAtMs + HOST_STALE_MS + 1);
    expect(afterFirst.status).toBe('playing');
    expect(afterFirst.hostPlayerId).toBe(GUEST_ID);

    // El sucesor tampoco actualiza la sala: la autoridad migra al último vivo y,
    // al quedar uno solo, la ronda termina con él como ganador.
    const afterSecond = await getRoomState(store, room.id, startedAtMs + HOST_STALE_MS * 2 + 2);
    expect(afterSecond.status).toBe('finished');
    expect(afterSecond.winnerPlayerId).toBe(THIRD_ID);
    expect(afterSecond.players.find((player) => player.id === GUEST_ID)?.status).toBe('eliminated');
  });

  it('treats the dead authority progress post as a room keepalive', async () => {
    const store = new MemoryRoomStore();
    const startedAtMs = 6_000_000;
    const room = await buildPlayingRoom(store, [HOST_ID, GUEST_ID, THIRD_ID], startedAtMs);

    // El host muere (espectador) pero sigue siendo la autoridad de la ronda.
    const eliminatedAtMs = startedAtMs + 1_000;
    await eliminatePlayer(store, eliminateRequest(room, HOST_ID), eliminatedAtMs);

    // Su cliente sigue posteando progreso como keepalive aunque ya esté terminal.
    const keepaliveAtMs = eliminatedAtMs + 10_000;
    const afterKeepalive = await updateProgress(store, {
      roomId: room.id,
      authorityPlayerId: HOST_ID,
      playerId: HOST_ID,
      seed: room.seed,
      lines: 5,
      pieces: 20,
      elapsedFrames: 100,
    }, keepaliveAtMs);

    // El keepalive no resucita ni pisa las stats del jugador terminal.
    const deadHost = afterKeepalive.players.find((player) => player.id === HOST_ID);
    expect(deadHost?.status).toBe('eliminated');
    expect(deadHost?.alive).toBe(false);

    // Sin el keepalive, la última escritura habría sido la eliminación y este
    // poll dispararía el failover (migración + fin de ronda anticipado).
    const polled = await getRoomState(store, room.id, eliminatedAtMs + HOST_STALE_MS + 1);
    expect(polled.status).toBe('playing');
    expect(polled.hostPlayerId).toBe(HOST_ID);
    const guest = polled.players.find((player) => player.id === GUEST_ID);
    const third = polled.players.find((player) => player.id === THIRD_ID);
    expect(guest?.alive).toBe(true);
    expect(third?.alive).toBe(true);
  });

  it('voids the round when the stale host has no surviving successor', async () => {
    const store = new MemoryRoomStore();
    const startedAtMs = 5_000_000;
    // Sala de un solo jugador (host): si se desconecta no hay sucesor vivo.
    const room = await buildPlayingRoom(store, [HOST_ID], startedAtMs);

    const recovered = await getRoomState(store, room.id, startedAtMs + HOST_STALE_MS + 1);

    expect(recovered.status).toBe('finished');
    expect(recovered.winnerPlayerId).toBeNull();
    expect(recovered.players.find((player) => player.id === HOST_ID)?.status).toBe('eliminated');
  });
});

describe('eliminatePlayer idempotency', () => {
  it('credits the KO to the last attacker only once', async () => {
    const store = new MemoryRoomStore();
    const room = await createPlayingRoom(store, [HOST_ID, GUEST_ID, THIRD_ID]);

    await updateProgress(store, {
      roomId: room.id,
      authorityPlayerId: HOST_ID,
      playerId: HOST_ID,
      seed: room.seed,
      lines: 0,
      pieces: 1,
      elapsedFrames: 10,
    });

    await addAttack(store, {
      roomId: room.id,
      authorityPlayerId: HOST_ID,
      attackId: 'attack-1',
      fromPlayerId: HOST_ID,
      toPlayerId: GUEST_ID,
      seed: room.seed,
      lines: 2,
      holeSeed: 7,
      frame: 50,
    });

    await eliminatePlayer(store, eliminateRequest(room, GUEST_ID));
    const repeated = await eliminatePlayer(store, eliminateRequest(room, GUEST_ID));

    const host = repeated.players.find((player) => player.id === HOST_ID);
    expect(host?.koCount).toBe(1);
    // Con un tercero vivo, la ronda sigue tras una sola eliminación.
    expect(repeated.status).not.toBe('finished');
  });
});
