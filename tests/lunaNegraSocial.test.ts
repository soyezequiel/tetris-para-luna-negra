import { describe, expect, it } from 'vitest';
import { normalizeLaunchRequest } from '../src/online/lunaNegraSocial';

const baseRequest = {
  id: 'launch-1',
  roomId: 'ROOM1',
  inviteToken: 'token',
  slug: 'tetris',
  title: 'TETRA',
  gameUrl: 'https://tetris.example/',
};

describe('normalizeLaunchRequest', () => {
  it('recognizes a Luna Room Link launch request', () => {
    expect(normalizeLaunchRequest({ ...baseRequest, kind: 'room-link' })).toEqual({
      ...baseRequest,
      kind: 'room-link',
    });
  });

  it('keeps compatibility with launch requests created before kind existed', () => {
    expect(normalizeLaunchRequest(baseRequest)).toEqual({
      ...baseRequest,
      kind: 'luna-room',
    });
  });
});
