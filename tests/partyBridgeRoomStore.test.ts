import { afterEach, describe, expect, it, vi } from 'vitest';
import { PartyBridgeRoomStore } from '../src/online/vercelApi';
import {
  ROOM_VERSION_CONFLICT_MESSAGE,
  RoomVersionConflictError,
  setRoomBet,
} from '../src/online/roomService';
import type { OnlineRoom } from '../src/online/protocol';

// El store del bridge habla HTTP con el Durable Object; mockeamos `fetch` para
// simular las respuestas del bridge (party/index.ts → RoomServer.bridgeSaveRoom).
function bridgeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeRoom(overrides: Partial<OnlineRoom> = {}): OnlineRoom {
  return { id: 'ewj5', players: [], bet: null, version: 3, ...overrides } as unknown as OnlineRoom;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PartyBridgeRoomStore conflict recognition', () => {
  it('re-throws a bridge version conflict (409) as RoomVersionConflictError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bridgeResponse(409, { error: ROOM_VERSION_CONFLICT_MESSAGE })),
    );
    const store = new PartyBridgeRoomStore('https://bridge.example', 'tok');
    // Sin la conversión, esto sería un OnlineRoomError plano y el retry NO lo
    // reconocería (ese era el bug de bet:create en production).
    await expect(store.saveRoom(makeRoom())).rejects.toBeInstanceOf(RoomVersionConflictError);
  });

  it('re-throws a conflict even if the bridge reports it with another status (500)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bridgeResponse(500, { error: ROOM_VERSION_CONFLICT_MESSAGE })),
    );
    const store = new PartyBridgeRoomStore('https://bridge.example', 'tok');
    await expect(store.saveRoom(makeRoom())).rejects.toBeInstanceOf(RoomVersionConflictError);
  });

  it('leaves a genuine bridge error as a non-conflict error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bridgeResponse(404, { error: 'Room not found.' })),
    );
    const store = new PartyBridgeRoomStore('https://bridge.example', 'tok');
    await expect(store.saveRoom(makeRoom())).rejects.not.toBeInstanceOf(RoomVersionConflictError);
  });
});

describe('setRoomBet over the bridge retries on a concurrent write', () => {
  it('re-reads and succeeds after a version conflict (regression: bet:create)', async () => {
    // Sala "detrás" del bridge. El primer PUT simula un choque con una escritura
    // concurrente al Durable Object; el segundo, ya releyendo, entra.
    const roomState = makeRoom({ visibility: 'private' });
    let putCount = 0;
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') return bridgeResponse(200, { room: roomState });
      putCount += 1;
      if (putCount === 1) return bridgeResponse(409, { error: ROOM_VERSION_CONFLICT_MESSAGE });
      const body = JSON.parse(String(init?.body ?? '{}')) as { room: OnlineRoom };
      Object.assign(roomState, body.room); // persistimos el bet en la sala del bridge
      return bridgeResponse(200, { room: roomState });
    });
    vi.stubGlobal('fetch', fetchMock);

    const store = new PartyBridgeRoomStore('https://bridge.example', 'tok');
    const bet = { betId: 'b1', status: 'pending_deposits' } as unknown as OnlineRoom['bet'];
    const room = await setRoomBet(store, roomState.id, bet);

    expect(room.bet).not.toBeNull();
    expect(putCount).toBe(2); // reintentó exactamente una vez tras el conflicto
  });
});
