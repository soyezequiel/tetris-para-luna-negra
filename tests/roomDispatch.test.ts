import { describe, expect, it } from 'vitest';
import { MemoryRoomStore } from '../src/online/roomService';
import { dispatchRoomAction, lobbyUpdateForRoom, lobbyUpdateKey } from '../src/online/roomDispatch';

const PARTY_ID = 'ABCD';
const HOST_ID = 'host-player-1';
const GUEST_ID = 'guest-player-1';

describe('dispatchRoomAction', () => {
  it('crea la sala usando el id del Party, ignorando cualquier roomId del payload', async () => {
    const store = new MemoryRoomStore();
    const { room } = await dispatchRoomAction(store, PARTY_ID, 'create', {
      roomId: 'OTHER', // debe ignorarse: la sala vive en el Party PARTY_ID
      playerId: HOST_ID,
      name: 'Host',
      visibility: 'private',
    });
    expect(room?.id).toBe(PARTY_ID);
    expect(room?.hostPlayerId).toBe(HOST_ID);
  });

  it('corre el ciclo lobby completo: create → join → ready → start', async () => {
    const store = new MemoryRoomStore();
    await dispatchRoomAction(store, PARTY_ID, 'create', { playerId: HOST_ID, name: 'Host', visibility: 'private' });
    await dispatchRoomAction(store, PARTY_ID, 'join', { playerId: GUEST_ID, name: 'Guest' });
    await dispatchRoomAction(store, PARTY_ID, 'ready', { playerId: HOST_ID, ready: true });
    await dispatchRoomAction(store, PARTY_ID, 'ready', { playerId: GUEST_ID, ready: true });
    const { room } = await dispatchRoomAction(store, PARTY_ID, 'start', { playerId: HOST_ID });
    expect(room?.players).toHaveLength(2);
    expect(room?.status).toBe('countdown');
  });

  it('join-or-create crea o une dentro de una única acción del Party', async () => {
    const store = new MemoryRoomStore();
    const first = await dispatchRoomAction(store, PARTY_ID, 'join-or-create', {
      playerId: HOST_ID,
      name: 'Host',
      visibility: 'private',
    });
    const second = await dispatchRoomAction(store, PARTY_ID, 'join-or-create', {
      playerId: GUEST_ID,
      name: 'Guest',
      visibility: 'private',
    });

    expect(first.room?.hostPlayerId).toBe(HOST_ID);
    expect(second.room?.players.map((player) => player.id)).toEqual([HOST_ID, GUEST_ID]);
  });

  it('responde state con el room actual y refresca presencia del que pollea', async () => {
    const store = new MemoryRoomStore();
    await dispatchRoomAction(store, PARTY_ID, 'create', { playerId: HOST_ID, name: 'Host', visibility: 'private' });
    const { room, serverNowMs } = await dispatchRoomAction(store, PARTY_ID, 'state', { playerId: HOST_ID });
    expect(room?.id).toBe(PARTY_ID);
    expect(typeof serverNowMs).toBe('number');
  });

  it('leave devuelve hostMigratedTo', async () => {
    const store = new MemoryRoomStore();
    await dispatchRoomAction(store, PARTY_ID, 'create', { playerId: HOST_ID, name: 'Host', visibility: 'private' });
    await dispatchRoomAction(store, PARTY_ID, 'join', { playerId: GUEST_ID, name: 'Guest' });
    const result = await dispatchRoomAction(store, PARTY_ID, 'leave', { playerId: HOST_ID });
    expect(result).toHaveProperty('hostMigratedTo');
    expect(result.room?.hostPlayerId).toBe(GUEST_ID);
  });

  it('una acción desconocida lanza error 400', async () => {
    const store = new MemoryRoomStore();
    await expect(dispatchRoomAction(store, PARTY_ID, 'nope', {})).rejects.toMatchObject({ status: 400 });
  });
});

describe('lobbyUpdateForRoom', () => {
  it('una sala pública en lobby es listable (upsert)', async () => {
    const store = new MemoryRoomStore();
    const { room } = await dispatchRoomAction(store, PARTY_ID, 'create', { playerId: HOST_ID, name: 'Host', visibility: 'public' });
    const update = lobbyUpdateForRoom(PARTY_ID, room);
    expect(update.op).toBe('upsert');
    if (update.op === 'upsert') expect(update.summary.id).toBe(PARTY_ID);
  });

  it('una sala privada no se lista (remove)', async () => {
    const store = new MemoryRoomStore();
    const { room } = await dispatchRoomAction(store, PARTY_ID, 'create', { playerId: HOST_ID, name: 'Host', visibility: 'private' });
    expect(lobbyUpdateForRoom(PARTY_ID, room)).toEqual({ op: 'remove', roomId: PARTY_ID });
  });

  it('una sala borrada (room null) se remueve del lobby', () => {
    expect(lobbyUpdateForRoom(PARTY_ID, null)).toEqual({ op: 'remove', roomId: PARTY_ID });
  });

  it('countdown sigue siendo listable; playing sale del listado', async () => {
    const store = new MemoryRoomStore();
    await dispatchRoomAction(store, PARTY_ID, 'create', { playerId: HOST_ID, name: 'Host', visibility: 'public' });
    await dispatchRoomAction(store, PARTY_ID, 'join', { playerId: GUEST_ID, name: 'Guest' });
    await dispatchRoomAction(store, PARTY_ID, 'ready', { playerId: HOST_ID, ready: true });
    await dispatchRoomAction(store, PARTY_ID, 'ready', { playerId: GUEST_ID, ready: true });
    const { room: countdown } = await dispatchRoomAction(store, PARTY_ID, 'start', { playerId: HOST_ID });
    expect(countdown?.status).toBe('countdown');
    expect(lobbyUpdateForRoom(PARTY_ID, countdown).op).toBe('upsert');

    const playing = countdown ? { ...countdown, status: 'playing' as const } : null;
    expect(lobbyUpdateForRoom(PARTY_ID, playing)).toEqual({ op: 'remove', roomId: PARTY_ID });
  });

  it('la clave de dedup es estable para la misma sala y cambia con los jugadores', async () => {
    const store = new MemoryRoomStore();
    const { room: a } = await dispatchRoomAction(store, PARTY_ID, 'create', { playerId: HOST_ID, name: 'Host', visibility: 'public' });
    const keyA = lobbyUpdateKey(lobbyUpdateForRoom(PARTY_ID, a));
    expect(lobbyUpdateKey(lobbyUpdateForRoom(PARTY_ID, a))).toBe(keyA);
    const { room: b } = await dispatchRoomAction(store, PARTY_ID, 'join', { playerId: GUEST_ID, name: 'Guest' });
    expect(lobbyUpdateKey(lobbyUpdateForRoom(PARTY_ID, b))).not.toBe(keyA);
  });

  it('arm-removal y cancel-removal tienen claves distintas y propias', () => {
    const armKey = lobbyUpdateKey({ op: 'arm-removal', roomId: PARTY_ID, graceMs: 1500 });
    const cancelKey = lobbyUpdateKey({ op: 'cancel-removal', roomId: PARTY_ID });
    expect(armKey).not.toBe(cancelKey);
    // No colisionan con upsert/remove de la misma sala.
    expect(armKey).not.toBe(lobbyUpdateKey({ op: 'remove', roomId: PARTY_ID }));
    expect(cancelKey).not.toBe(lobbyUpdateKey({ op: 'remove', roomId: PARTY_ID }));
    // La gracia forma parte de la clave del arm (distinta gracia, distinta clave).
    expect(armKey).not.toBe(lobbyUpdateKey({ op: 'arm-removal', roomId: PARTY_ID, graceMs: 3000 }));
  });
});
