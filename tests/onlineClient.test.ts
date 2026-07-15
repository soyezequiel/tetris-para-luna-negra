import { describe, expect, it, vi } from 'vitest';
import {
  isUnknownJoinOrCreateAction,
  joinOrCreateRoomCompat,
  OnlineApiError,
} from '../src/online/client';
import type {
  JoinOrCreateRoomRequest,
  OnlineRoomResponse,
} from '../src/online/protocol';

const request: JoinOrCreateRoomRequest = {
  roomId: 'LINK',
  playerId: 'player-1',
  name: 'Player',
  visibility: 'private',
};

const response = { room: { id: 'LINK' }, serverNowMs: 1 } as OnlineRoomResponse;

describe('joinOrCreateRoomCompat', () => {
  it('reconoce sólo la respuesta de incompatibilidad del Party anterior', () => {
    expect(isUnknownJoinOrCreateAction(
      new OnlineApiError('Unknown room action: join-or-create', 400),
    )).toBe(true);
    expect(isUnknownJoinOrCreateAction(
      new OnlineApiError('Invalid room id.', 400),
    )).toBe(false);
  });

  it('usa join/create sólo cuando el Worker declara desconocida la acción atómica', async () => {
    const atomic = vi.fn(async () => { throw new OnlineApiError('Unknown room action: join-or-create', 400); });
    const join = vi.fn()
      .mockRejectedValueOnce(new OnlineApiError('Room not found.', 404))
      .mockResolvedValue(response);
    const create = vi.fn(async () => response);

    await expect(joinOrCreateRoomCompat(request, {
      atomic,
      join,
      create,
      isAtomicUnsupported: (error) => error instanceof OnlineApiError && error.status === 400,
    })).resolves.toBe(response);
    expect(atomic).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('resuelve la carrera del protocolo viejo con un join final tras 409', async () => {
    const join = vi.fn()
      .mockRejectedValueOnce(new OnlineApiError('Room not found.', 404))
      .mockResolvedValueOnce(response);
    const create = vi.fn(async () => { throw new OnlineApiError('Room already exists.', 409); });

    await expect(joinOrCreateRoomCompat(request, {
      atomic: async () => { throw new OnlineApiError('Unknown room action: join-or-create', 400); },
      join,
      create,
      isAtomicUnsupported: () => true,
    })).resolves.toBe(response);
    expect(join).toHaveBeenCalledTimes(2);
  });

  it('no convierte un error real de sala en fallback', async () => {
    const actual = new OnlineApiError('Room already started.', 409);
    const join = vi.fn();
    const create = vi.fn();

    await expect(joinOrCreateRoomCompat(request, {
      atomic: async () => { throw actual; },
      join,
      create,
      isAtomicUnsupported: () => false,
    })).rejects.toBe(actual);
    expect(join).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
