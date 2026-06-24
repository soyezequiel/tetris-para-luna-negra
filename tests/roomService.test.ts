import { describe, expect, it } from 'vitest';
import {
  addAttack,
  canStartRoom,
  createRoom,
  eliminatePlayer,
  getRoomState,
  HOST_STALE_MS,
  HOST_UNREACHABLE_MS,
  isRoundReady,
  joinRoom,
  leaveRoom,
  listPublicRooms,
  MemoryRoomStore,
  PLAYER_ABANDON_MS,
  PLAYER_STALE_MS,
  requestHostFailover,
  ROOM_ABANDONED_MS,
  ROOM_START_DELAY_MS,
  RoomVersionConflictError,
  setPlayerReady,
  setRoomBet,
  startRoom,
  updateProgress,
  updateRoomSettings,
  type RoomStore,
} from '../src/online/roomService';
import type { EliminateRequest, OnlineRoom, ProgressRequest, RoomBet, RoomBetPayoutStatus } from '../src/online/protocol';

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
  // Los invitados muestran presencia al arranque (self-report: refresca su
  // updatedAtServerMs sin mover el reloj del room), reflejando que pollean. Sin
  // esto el harness los dejaría "ausentes" desde createdAt y el barrido de
  // abandono (applyAbandonedPlayers) los sacaría sin que se hayan ido.
  let latest = room;
  for (const guestId of guestIds) {
    latest = await updateProgress(store, {
      roomId: room.id,
      authorityPlayerId: guestId,
      playerId: guestId,
      seed: room.seed,
      lines: 0,
      pieces: 1,
      elapsedFrames: 1,
    }, startedAtMs);
  }
  return latest;
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

describe('non-host player abandonment during a round', () => {
  // Mantiene el room "fresco" simulando que el host sigue escribiendo (progreso de
  // autoridad mueve room.updatedAtServerMs), así el barrido de abandono corre.
  const hostKeepalive = (store: RoomStore, room: OnlineRoom, atMs: number) =>
    updateProgress(store, {
      roomId: room.id,
      authorityPlayerId: HOST_ID,
      playerId: HOST_ID,
      seed: room.seed,
      lines: 0,
      pieces: 5,
      elapsedFrames: 50,
    }, atMs);

  // Self-report de un invitado: refresca SU presencia sin mover el reloj del room.
  const guestPresence = (store: RoomStore, room: OnlineRoom, playerId: string, atMs: number) =>
    updateProgress(store, {
      roomId: room.id,
      authorityPlayerId: playerId,
      playerId,
      seed: room.seed,
      lines: 0,
      pieces: 5,
      elapsedFrames: 50,
    }, atMs);

  it('crowns the host when the lone guest abandons mid-round (1v1)', async () => {
    const store = new MemoryRoomStore();
    const startedAtMs = 8_000_000;
    const room = await buildPlayingRoom(store, [HOST_ID, GUEST_ID], startedAtMs);

    // El invitado dejó de pollear en `startedAtMs`. El host sigue escribiendo justo
    // antes del poll, así el room está fresco (no es un caso de host failover) pero
    // el invitado ya superó su gracia de ausencia.
    const sweepAt = startedAtMs + PLAYER_ABANDON_MS + 2_000;
    await hostKeepalive(store, room, sweepAt - 1);
    const recovered = await getRoomState(store, room.id, sweepAt);

    expect(recovered.status).toBe('finished');
    expect(recovered.winnerPlayerId).toBe(HOST_ID);
    const guest = recovered.players.find((player) => player.id === GUEST_ID);
    expect(guest?.status).toBe('eliminated');
    expect(guest?.alive).toBe(false);
  });

  it('drops the absent guest but keeps the round going with the survivors', async () => {
    const store = new MemoryRoomStore();
    const startedAtMs = 9_000_000;
    const room = await buildPlayingRoom(store, [HOST_ID, GUEST_ID, THIRD_ID], startedAtMs);

    // Host y THIRD siguen presentes (escriben justo antes del poll); GUEST se fue.
    const sweepAt = startedAtMs + PLAYER_ABANDON_MS + 2_000;
    await hostKeepalive(store, room, sweepAt - 1);
    await guestPresence(store, room, THIRD_ID, sweepAt - 1);
    const recovered = await getRoomState(store, room.id, sweepAt);

    expect(recovered.status).toBe('playing');
    expect(recovered.players.find((player) => player.id === GUEST_ID)?.status).toBe('eliminated');
    expect(recovered.players.find((player) => player.id === THIRD_ID)?.alive).toBe(true);
    expect(recovered.players.find((player) => player.id === HOST_ID)?.alive).toBe(true);
  });

  it('does not drop a guest that keeps showing presence', async () => {
    const store = new MemoryRoomStore();
    const startedAtMs = 10_000_000;
    const room = await buildPlayingRoom(store, [HOST_ID, GUEST_ID], startedAtMs);

    // Mismo instante de barrido, pero el invitado refrescó su presencia recién: no
    // debe salir de la ronda.
    const sweepAt = startedAtMs + PLAYER_ABANDON_MS + 2_000;
    await hostKeepalive(store, room, sweepAt - 1);
    await guestPresence(store, room, GUEST_ID, sweepAt - 1);
    const recovered = await getRoomState(store, room.id, sweepAt);

    expect(recovered.status).toBe('playing');
    expect(recovered.players.find((player) => player.id === GUEST_ID)?.alive).toBe(true);
  });

  it('defers to host failover instead of sweeping when the whole room is stale', async () => {
    const store = new MemoryRoomStore();
    const startedAtMs = 11_000_000;
    const room = await buildPlayingRoom(store, [HOST_ID, GUEST_ID, THIRD_ID], startedAtMs);

    // Nadie escribe: el room queda stale. El barrido de abandono NO debe correr
    // (timestamps por-jugador igual de viejos); manda el host failover, que migra
    // la autoridad y mantiene la ronda con dos jugadores.
    const recovered = await getRoomState(store, room.id, startedAtMs + HOST_STALE_MS + 1);

    expect(recovered.status).toBe('playing');
    expect(recovered.hostPlayerId).not.toBe(HOST_ID);
    const survivors = recovered.players.filter((player) => player.alive);
    expect(survivors).toHaveLength(2);
  });
});

describe('client-requested host failover', () => {
  it('migrates on demand once the host is unreachable, well before HOST_STALE_MS', async () => {
    const store = new MemoryRoomStore();
    const startedAtMs = 7_000_000;
    const room = await buildPlayingRoom(store, [HOST_ID, GUEST_ID], startedAtMs);

    // El sobreviviente pide la migración apenas pasa HOST_UNREACHABLE_MS (muy por
    // debajo de HOST_STALE_MS): en 1v1 la ronda termina coronándolo de inmediato.
    const requestedAtMs = startedAtMs + HOST_UNREACHABLE_MS + 1;
    expect(requestedAtMs).toBeLessThan(startedAtMs + HOST_STALE_MS);
    const recovered = await requestHostFailover(store, { roomId: room.id, playerId: GUEST_ID }, requestedAtMs);

    expect(recovered.status).toBe('finished');
    expect(recovered.winnerPlayerId).toBe(GUEST_ID);
    expect(recovered.players.find((player) => player.id === HOST_ID)?.status).toBe('eliminated');
  });

  it('does not migrate while the host is still fresh', async () => {
    const store = new MemoryRoomStore();
    const startedAtMs = 8_000_000;
    const room = await buildPlayingRoom(store, [HOST_ID, GUEST_ID, THIRD_ID], startedAtMs);

    const stillFresh = await requestHostFailover(
      store,
      { roomId: room.id, playerId: GUEST_ID },
      startedAtMs + HOST_UNREACHABLE_MS - 1,
    );

    expect(stillFresh.hostPlayerId).toBe(HOST_ID);
    expect(stillFresh.status).toBe('playing');
    expect(stillFresh.players.find((player) => player.id === HOST_ID)?.alive).toBe(true);
  });

  it('ignores requests from the host or from a terminal player', async () => {
    const store = new MemoryRoomStore();
    const startedAtMs = 9_000_000;
    const room = await buildPlayingRoom(store, [HOST_ID, GUEST_ID, THIRD_ID], startedAtMs);
    const lateMs = startedAtMs + HOST_UNREACHABLE_MS + 1;

    // El propio host no puede pedir su baja.
    const fromHost = await requestHostFailover(store, { roomId: room.id, playerId: HOST_ID }, lateMs);
    expect(fromHost.hostPlayerId).toBe(HOST_ID);
    expect(fromHost.status).toBe('playing');

    // Un jugador terminal (ya eliminado) tampoco.
    await eliminatePlayer(store, eliminateRequest(room, GUEST_ID), startedAtMs + 500);
    const fromDead = await requestHostFailover(store, { roomId: room.id, playerId: GUEST_ID }, lateMs);
    expect(fromDead.hostPlayerId).toBe(HOST_ID);
    expect(fromDead.players.find((player) => player.id === HOST_ID)?.alive).toBe(true);
  });
});

describe('room abandonment cleanup', () => {
  it('deletes a room that nobody polled within ROOM_ABANDONED_MS', async () => {
    const store = new MemoryRoomStore();
    const created = await createRoom(store, { playerId: HOST_ID, name: 'Host', visibility: 'private' }, 1_000_000);

    await expect(
      getRoomState(store, created.id, 1_000_000 + ROOM_ABANDONED_MS + 1),
    ).rejects.toMatchObject({ status: 404 });
    expect(await store.getRoom(created.id)).toBeNull();
  });

  it('keeps the room alive while a member keeps polling (presence)', async () => {
    const store = new MemoryRoomStore();
    const created = await createRoom(store, { playerId: HOST_ID, name: 'Host', visibility: 'private' }, 1_000_000);

    // Poll con presencia justo antes de expirar: refresca al host, sigue conectado.
    const refreshed = await getRoomState(store, created.id, 1_000_000 + ROOM_ABANDONED_MS - 1, HOST_ID);
    expect(refreshed.players.find((player) => player.id === HOST_ID)?.status).not.toBe('disconnected');

    // Otro poll dentro de ROOM_ABANDONED_MS desde el anterior: la sala sigue viva.
    const stillThere = await getRoomState(store, created.id, 1_000_000 + ROOM_ABANDONED_MS + 5, HOST_ID);
    expect(stillThere.id).toBe(created.id);
  });

  // Una apuesta liquidada cuyo ganador (invitado) todavía no reclamó su retiro:
  // el QR vive en room.bet y NO debe borrarse por abandono. Ver roomHasPendingPayout.
  function pendingPayoutBet(payoutStatus: RoomBetPayoutStatus, winnerPlayerId = GUEST_ID): RoomBet {
    return {
      betId: 'bet-1',
      status: 'settled',
      stakeSats: 10,
      potSats: 20,
      potTargetSats: 20,
      feeSats: 1,
      feePct: 0,
      netPayoutSats: 19,
      depositDeadline: null,
      depositsReceived: 2,
      depositsTotal: 2,
      participants: [{
        npub: 'guest-ephemeral-npub',
        playerId: winnerPlayerId,
        depositStatus: 'paid',
        bolt11: null,
        lnurl: null,
        payUrl: null,
        depositError: null,
        payoutSats: 19,
        payoutStatus,
        withdrawLnurl: 'lnurl1withdrawqr',
        withdrawUrl: null,
      }],
      winnerNpubs: ['guest-ephemeral-npub'],
      resultReported: true,
      settlementError: null,
      createdByPlayerId: HOST_ID,
      createdAtServerMs: 0,
      updatedAtServerMs: 0,
    };
  }

  it('keeps an abandoned room alive while a winner withdraw is pending', async () => {
    const store = new MemoryRoomStore();
    const t = 1_000_000;
    const created = await createRoom(store, { playerId: HOST_ID, name: 'Host', visibility: 'private' }, t);
    await setRoomBet(store, created.id, pendingPayoutBet('withdraw_pending'), t);

    const room = await getRoomState(store, created.id, t + ROOM_ABANDONED_MS + 1);
    expect(room.id).toBe(created.id);
    expect(room.bet?.participants[0]?.withdrawLnurl).toBe('lnurl1withdrawqr');
    expect(await store.getRoom(created.id)).not.toBeNull();
  });

  it('deletes the abandoned room once the withdraw is claimed', async () => {
    const store = new MemoryRoomStore();
    const t = 1_000_000;
    const created = await createRoom(store, { playerId: HOST_ID, name: 'Host', visibility: 'private' }, t);
    await setRoomBet(store, created.id, pendingPayoutBet('claimed'), t);

    await expect(
      getRoomState(store, created.id, t + ROOM_ABANDONED_MS + 1),
    ).rejects.toMatchObject({ status: 404 });
    expect(await store.getRoom(created.id)).toBeNull();
  });

  it('keeps the empty room when the last player leaves with a withdraw pending', async () => {
    const store = new MemoryRoomStore();
    const t = 1_000_000;
    const created = await createRoom(store, { playerId: HOST_ID, name: 'Host', visibility: 'private' }, t);
    await setRoomBet(store, created.id, pendingPayoutBet('withdraw_pending', HOST_ID), t);

    const { room } = await leaveRoom(store, { roomId: created.id, playerId: HOST_ID }, t);
    expect(room).not.toBeNull();
    expect(room?.players).toHaveLength(0);
    expect(room?.bet?.participants[0]?.withdrawLnurl).toBe('lnurl1withdrawqr');
    expect(await store.getRoom(created.id)).not.toBeNull();
  });

  it('removes abandoned public rooms from the listing', async () => {
    const store = new MemoryRoomStore();
    const fresh = await createRoom(store, { playerId: HOST_ID, name: 'Host', visibility: 'public' }, 1_030_000);
    const stale = await createRoom(store, { playerId: GUEST_ID, name: 'Guest', visibility: 'public' }, 1_000_000);

    const listed = await listPublicRooms(store, 1_000_000 + ROOM_ABANDONED_MS + 1, { matchType: 'custom' });

    expect(listed.map((room) => room.id)).toContain(fresh.id);
    expect(listed.map((room) => room.id)).not.toContain(stale.id);
    expect(await store.getRoom(stale.id)).toBeNull();
  });
});

describe('spectators when not everyone is ready', () => {
  /**
   * Arma una sala en lobby con una lista de jugadores y marca listos solo a
   * `readyIds`. Todos los latidos quedan fijados en `nowMs` para poder medir la
   * presencia de forma determinística.
   */
  async function buildLobby(
    store: RoomStore,
    playerIds: string[],
    readyIds: string[],
    nowMs: number,
  ): Promise<OnlineRoom> {
    const [hostId, ...guestIds] = playerIds;
    const created = await createRoom(store, { playerId: hostId, name: 'Host', visibility: 'private' }, nowMs);
    for (const guestId of guestIds) {
      await joinRoom(store, { roomId: created.id, playerId: guestId, name: guestId }, nowMs);
    }
    // Todos entran listos por defecto (createPlayer); des-marcamos a mano a los
    // que no deben jugar la ronda para que entren de espectadores.
    for (const playerId of playerIds) {
      if (!readyIds.includes(playerId)) {
        await setPlayerReady(store, { roomId: created.id, playerId, ready: false }, nowMs);
      }
    }
    return (await store.getRoom(created.id))!;
  }

  it('lets the host start with a non-ready guest, who joins as a spectator', async () => {
    const store = new MemoryRoomStore();
    const t = 1_000_000;
    const room = await buildLobby(store, [HOST_ID, GUEST_ID, THIRD_ID], [HOST_ID, GUEST_ID], t);
    expect(canStartRoom(room, t)).toBe(true);

    const started = await startRoom(store, { roomId: room.id, playerId: HOST_ID }, t);
    expect(started.status).toBe('countdown');

    // Los listos juegan; el que no estaba listo entra de espectador (alive=false).
    const host = started.players.find((player) => player.id === HOST_ID)!;
    const guest = started.players.find((player) => player.id === GUEST_ID)!;
    const third = started.players.find((player) => player.id === THIRD_ID)!;
    expect(host.alive).toBe(true);
    expect(guest.alive).toBe(true);
    expect(third.alive).toBe(false);
    expect(third.ready).toBe(false);
    expect(third.status).toBe('joined');
  });

  it('refuses to start when the host is not ready', async () => {
    const store = new MemoryRoomStore();
    const t = 2_000_000;
    const room = await buildLobby(store, [HOST_ID, GUEST_ID], [GUEST_ID], t);
    expect(canStartRoom(room, t)).toBe(false);
    await expect(
      startRoom(store, { roomId: room.id, playerId: HOST_ID }, t),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to start a multiplayer room with only the host ready', async () => {
    const store = new MemoryRoomStore();
    const t = 3_000_000;
    const room = await buildLobby(store, [HOST_ID, GUEST_ID], [HOST_ID], t);
    expect(canStartRoom(room, t)).toBe(false);
    await expect(
      startRoom(store, { roomId: room.id, playerId: HOST_ID }, t),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('lets a solo room start with just the host ready', async () => {
    const store = new MemoryRoomStore();
    const t = 4_000_000;
    const room = await buildLobby(store, [HOST_ID], [HOST_ID], t);
    expect(canStartRoom(room, t)).toBe(true);
    const started = await startRoom(store, { roomId: room.id, playerId: HOST_ID }, t);
    expect(started.status).toBe('countdown');
  });

  it('unmarks ready for a player who closed the tab (stale presence) in the lobby', async () => {
    const store = new MemoryRoomStore();
    const t = 5_000_000;
    const room = await buildLobby(store, [HOST_ID, GUEST_ID], [HOST_ID, GUEST_ID], t);

    // El host sigue presente (poll con presencia); el guest dejó de pollear.
    const later = t + PLAYER_STALE_MS + 1;
    const polled = await getRoomState(store, room.id, later, HOST_ID);

    const guest = polled.players.find((player) => player.id === GUEST_ID)!;
    expect(guest.ready).toBe(false);
    // La proyección de lectura lo muestra desconectado (sin presencia); lo que
    // importa es que ya no cuenta como listo.
    expect(guest.status).toBe('disconnected');
    expect(isRoundReady(guest, later)).toBe(false);
    // Con el guest des-marcado solo queda el host listo: no se puede arrancar (1v1).
    expect(canStartRoom(polled, later)).toBe(false);
  });

  it('does not turn a spectator into a loser when the round finishes', async () => {
    const store = new MemoryRoomStore();
    const t = 6_000_000;
    const room = await buildLobby(store, [HOST_ID, GUEST_ID, THIRD_ID], [HOST_ID, GUEST_ID], t);
    const started = await startRoom(store, { roomId: room.id, playerId: HOST_ID }, t);

    // El host arranca la ronda (countdown → playing) y luego elimina al guest:
    // como el tercero es espectador (alive=false), solo queda el host vivo y gana.
    await updateProgress(store, {
      roomId: started.id,
      authorityPlayerId: HOST_ID,
      playerId: HOST_ID,
      seed: started.seed,
      lines: 0,
      pieces: 1,
      elapsedFrames: 1,
    }, t + 100);
    const finished = await eliminatePlayer(store, eliminateRequest(started, GUEST_ID), t + 200);

    expect(finished.status).toBe('finished');
    expect(finished.winnerPlayerId).toBe(HOST_ID);
    const third = finished.players.find((player) => player.id === THIRD_ID)!;
    expect(third.status).toBe('joined');
    expect(third.alive).toBe(false);
    expect(third.ready).toBe(false);
  });
});

describe('custom rules live update in the lobby', () => {
  // El host edita la config custom estando en el lobby: el cliente re-envía las
  // reglas vía updateRoomSettings (sin visibilityOnly) y deben aplicarse a la sala
  // para que el resto de los jugadores las reciba.
  it('applies host custom rules to the room', async () => {
    const store = new MemoryRoomStore();
    const created = await createRoom(store, {
      playerId: HOST_ID,
      name: 'Host',
      visibility: 'private',
      mode: 'custom',
      matchType: 'custom',
    });

    const updated = await updateRoomSettings(store, {
      roomId: created.id,
      playerId: HOST_ID,
      mode: 'custom',
      matchType: 'custom',
      rules: { ...created.rules, boardWidth: 7, gravityCurve: 'linear', allowHold: false },
    });

    expect(updated.rules.boardWidth).toBe(7);
    expect(updated.rules.gravityCurve).toBe('linear');
    expect(updated.rules.allowHold).toBe(false);

    const persisted = await store.getRoom(created.id);
    expect(persisted?.rules.boardWidth).toBe(7);
    expect(persisted?.rules.gravityCurve).toBe('linear');
  });

  it('refuses rule changes from a non-host', async () => {
    const store = new MemoryRoomStore();
    const created = await createRoom(store, {
      playerId: HOST_ID,
      name: 'Host',
      visibility: 'private',
      mode: 'custom',
      matchType: 'custom',
    });
    await joinRoom(store, { roomId: created.id, playerId: GUEST_ID, name: 'Guest' });

    await expect(
      updateRoomSettings(store, {
        roomId: created.id,
        playerId: GUEST_ID,
        mode: 'custom',
        matchType: 'custom',
        rules: { ...created.rules, boardWidth: 5 },
      }),
    ).rejects.toMatchObject({ status: 403 });

    const persisted = await store.getRoom(created.id);
    expect(persisted?.rules.boardWidth).toBe(created.rules.boardWidth);
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

describe('double-KO winner determinism', () => {
  // Cada jugador reporta SU PROPIA muerte (authorityPlayerId === playerId) con su
  // frame de muerte; así modelamos el doble-KO con reportes que llegan en cierto orden.
  function selfEliminate(room: OnlineRoom, playerId: string, frame: number): EliminateRequest {
    return {
      roomId: room.id,
      authorityPlayerId: playerId,
      playerId,
      seed: room.seed,
      frame,
      lines: 5,
      pieces: 20,
      elapsedFrames: frame,
    };
  }

  it('re-crowns the longer survivor when the loser death is reported first', async () => {
    const store = new MemoryRoomStore();
    const room = await createPlayingRoom(store);

    // HOST aguantó MÁS (murió en el frame 100) pero su paquete llega PRIMERO por lag,
    // así que GUEST queda coronado como único vivo.
    const afterFirst = await eliminatePlayer(store, selfEliminate(room, HOST_ID, 100));
    expect(afterFirst.status).toBe('finished');
    expect(afterFirst.winnerPlayerId).toBe(GUEST_ID);

    // Llega tarde la muerte de GUEST (murió antes, frame 90): aguantó menos → se
    // re-corona a HOST, que sobrevivió hasta el frame 100.
    const afterSecond = await eliminatePlayer(store, selfEliminate(room, GUEST_ID, 90));
    expect(afterSecond.winnerPlayerId).toBe(HOST_ID);
    expect(afterSecond.players.find((player) => player.id === HOST_ID)?.status).toBe('winner');
    expect(afterSecond.players.find((player) => player.id === GUEST_ID)?.status).toBe('eliminated');
  });

  it('keeps the crowned winner when they legitimately survived longer', async () => {
    const store = new MemoryRoomStore();
    const room = await createPlayingRoom(store);

    // HOST murió antes (frame 90) y su muerte llega primero → GUEST coronado.
    await eliminatePlayer(store, selfEliminate(room, HOST_ID, 90));
    // GUEST reporta su muerte tarde, pero aguantó MÁS (frame 100): NO se destrona.
    const afterSecond = await eliminatePlayer(store, selfEliminate(room, GUEST_ID, 100));
    expect(afterSecond.winnerPlayerId).toBe(GUEST_ID);
    expect(afterSecond.players.find((player) => player.id === GUEST_ID)?.status).toBe('winner');
  });

  it('keeps the crowned winner on an exact frame tie (deterministic)', async () => {
    const store = new MemoryRoomStore();
    const room = await createPlayingRoom(store);

    await eliminatePlayer(store, selfEliminate(room, HOST_ID, 100));
    // Empate exacto de frame: un paquete tardío no destrona al ganador ya coronado.
    const afterSecond = await eliminatePlayer(store, selfEliminate(room, GUEST_ID, 100));
    expect(afterSecond.winnerPlayerId).toBe(GUEST_ID);
  });
});
