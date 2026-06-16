import { describe, expect, it } from 'vitest';
import { PartyOnlineClient } from '../src/online/partyClient';

/**
 * Integración del cliente WebSocket contra un PartyKit dev real. Gateado: solo
 * corre con PARTY_E2E=1 y un `npx partykit dev --port 1999` levantado, porque
 * necesita el server vivo (la suite normal no debe depender de eso).
 *
 *   Terminal A:  npx partykit dev --port 1999
 *   Terminal B:  PARTY_E2E=1 npx vitest run tests/partyClient.integration.test.ts
 */
const RUN = process.env.PARTY_E2E === '1';
const HOST = process.env.PARTY_HOST ?? '127.0.0.1:1999';
const suite = RUN ? describe : describe.skip;

suite('PartyOnlineClient (integración WS)', () => {
  it('create → join → ready → start → state → leave, todo por WebSocket', async () => {
    const host = new PartyOnlineClient(HOST);
    const guest = new PartyOnlineClient(HOST);

    const created = await host.createRoom({ playerId: 'host-player-1', name: 'Host', visibility: 'public' });
    expect(created.room.id).toHaveLength(4);
    expect(created.room.hostPlayerId).toBe('host-player-1');
    const roomId = created.room.id;

    const joined = await guest.joinRoom({ roomId, playerId: 'guest-player-1', name: 'Guest' });
    expect(joined.room.players).toHaveLength(2);

    await host.setReady({ roomId, playerId: 'host-player-1', ready: true });
    await guest.setReady({ roomId, playerId: 'guest-player-1', ready: true });
    const started = await host.startRoom({ roomId, playerId: 'host-player-1' });
    expect(started.room.status).toBe('countdown');

    const state = await guest.getRoomState(roomId, 'guest-player-1');
    expect(state.room.id).toBe(roomId);
    expect(state.room.players).toHaveLength(2);

    const left = await guest.leaveRoom({ roomId, playerId: 'guest-player-1' });
    expect(left.room?.players).toHaveLength(1);
    await host.leaveRoom({ roomId, playerId: 'host-player-1' });
  });

  it('listPublicRooms recibe la sala pública por push del lobby', async () => {
    const host = new PartyOnlineClient(HOST);
    const browser = new PartyOnlineClient(HOST);

    const created = await host.createRoom({ playerId: 'host-player-2', name: 'Naranja', visibility: 'public' });
    const roomId = created.room.id;
    // pequeño respiro para que el RoomParty avise al lobby antes de listar
    await new Promise((resolve) => setTimeout(resolve, 400));

    const { rooms } = await browser.listPublicRooms();
    expect(rooms.some((room) => room.id === roomId)).toBe(true);

    await host.leaveRoom({ roomId, playerId: 'host-player-2' });
  });

  it('getRoomState contra una sala inexistente devuelve 404', async () => {
    const client = new PartyOnlineClient(HOST);
    await expect(client.getRoomState('ZZZZ', 'nobody-player-1')).rejects.toMatchObject({ status: 404 });
  });

  it('countdown→playing lo empuja el alarm del server, sin poll del cliente', async () => {
    const roomId = 'AL5M';
    const host = new PartyOnlineClient(HOST);
    const guest = new PartyOnlineClient(HOST);

    // Listener crudo: captura el broadcast 'room' que empuje el alarm autoritativo.
    const statuses: string[] = [];
    let resolvePlaying: (() => void) | null = null;
    const listener = new WebSocket(`ws://${HOST}/parties/main/${roomId}`);
    listener.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === 'room') {
        statuses.push(msg.room.status);
        if (msg.room.status === 'playing') resolvePlaying?.();
      }
    };
    await new Promise<void>((resolve, reject) => {
      listener.onopen = () => resolve();
      listener.onerror = () => reject(new Error('el listener no conectó'));
    });

    await host.createRoom({ playerId: 'host-player-7', name: 'Host', visibility: 'public', roomId });
    await guest.joinRoom({ roomId, playerId: 'guest-player-7', name: 'Guest' });
    await host.setReady({ roomId, playerId: 'host-player-7', ready: true });
    await guest.setReady({ roomId, playerId: 'guest-player-7', ready: true });
    const started = await host.startRoom({ roomId, playerId: 'host-player-7' });
    expect(started.room.status).toBe('countdown');

    // Nadie envía nada más: el alarm del Party debe flipear a 'playing' y empujarlo.
    await new Promise<void>((resolve, reject) => {
      if (statuses.includes('playing')) return resolve();
      resolvePlaying = resolve;
      setTimeout(() => reject(new Error(`no llegó 'playing'; vi: [${statuses.join(', ')}]`)), 8_000);
    });

    listener.close();
    await host.leaveRoom({ roomId, playerId: 'host-player-7' });
    await guest.leaveRoom({ roomId, playerId: 'guest-player-7' });
  }, 12_000);

  // Requiere el dev server con gracia corta: --var PARTY_ABANDON_GRACE_MS=1500
  it('al caer la última conexión, la sala se limpia del lobby tras la gracia', async () => {
    const roomId = 'GHJ4';
    // Conexión cruda para controlar el cierre del socket (simula cerrar la pestaña).
    const socket = new WebSocket(`ws://${HOST}/parties/main/${roomId}`);
    await new Promise<void>((resolve, reject) => {
      socket.onerror = () => reject(new Error('no conectó'));
      socket.onopen = () => {
        socket.onmessage = (event) => {
          const msg = JSON.parse(String(event.data));
          if (msg.type === 'reply' && msg.ok) resolve();
        };
        socket.send(JSON.stringify({ action: 'create', reqId: 'c', payload: { playerId: 'host-player-9', name: 'Naranja', visibility: 'public' } }));
      };
    });

    // La sala existe y está en el lobby.
    const before = await new PartyOnlineClient(HOST).listPublicRooms();
    expect(before.rooms.some((room) => room.id === roomId)).toBe(true);

    // Se cae la última conexión → tras la gracia el Party debe borrar la sala.
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 2200));

    const after = await new PartyOnlineClient(HOST).listPublicRooms();
    expect(after.rooms.some((room) => room.id === roomId)).toBe(false);
  });
});
