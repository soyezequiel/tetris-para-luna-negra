import { describe, expect, it } from 'vitest';
import {
  addAttack,
  createRoom,
  eliminatePlayer,
  joinRoom,
  MemoryRoomStore,
  RoomVersionConflictError,
  setPlayerReady,
  startRoom,
  updateProgress,
  type RoomStore,
} from '../src/online/roomService';
import type { EliminateRequest, OnlineRoom } from '../src/online/protocol';

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
