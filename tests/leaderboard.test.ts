import { describe, expect, it } from 'vitest';
import {
  getSprint40Leaderboard,
  LEADERBOARD_MAX_ENTRIES,
  MemoryLeaderboardStore,
  SPRINT40_MAX_FRAMES,
  SPRINT40_MIN_FRAMES,
  submitSprint40Score,
} from '../src/online/leaderboard';
import { OnlineRoomError } from '../src/online/roomService';

function baseInput(overrides: Partial<Parameters<typeof submitSprint40Score>[1]> = {}) {
  return {
    playerId: 'player-1',
    name: 'Ana',
    avatarUrl: null,
    npub: null,
    elapsedFrames: 1800,
    ...overrides,
  };
}

describe('submitSprint40Score', () => {
  it('rejects times below the minimum', async () => {
    const store = new MemoryLeaderboardStore();
    await expect(submitSprint40Score(store, baseInput({ elapsedFrames: SPRINT40_MIN_FRAMES - 1 })))
      .rejects.toBeInstanceOf(OnlineRoomError);
  });

  it('rejects times above the maximum', async () => {
    const store = new MemoryLeaderboardStore();
    await expect(submitSprint40Score(store, baseInput({ elapsedFrames: SPRINT40_MAX_FRAMES + 1 })))
      .rejects.toBeInstanceOf(OnlineRoomError);
  });

  it('rejects an empty playerId', async () => {
    const store = new MemoryLeaderboardStore();
    await expect(submitSprint40Score(store, baseInput({ playerId: '   ' })))
      .rejects.toBeInstanceOf(OnlineRoomError);
  });

  it('keeps only a player best time', async () => {
    const store = new MemoryLeaderboardStore();
    await submitSprint40Score(store, baseInput({ elapsedFrames: 2000 }));
    await submitSprint40Score(store, baseInput({ elapsedFrames: 1500 }));
    await submitSprint40Score(store, baseInput({ elapsedFrames: 1800 }));
    const top = await getSprint40Leaderboard(store);
    expect(top).toHaveLength(1);
    expect(top[0].elapsedFrames).toBe(1500);
  });

  it('orders players ascending by time (fastest first)', async () => {
    const store = new MemoryLeaderboardStore();
    await submitSprint40Score(store, baseInput({ playerId: 'a', name: 'A', elapsedFrames: 2400 }));
    await submitSprint40Score(store, baseInput({ playerId: 'b', name: 'B', elapsedFrames: 1200 }));
    await submitSprint40Score(store, baseInput({ playerId: 'c', name: 'C', elapsedFrames: 1800 }));
    const top = await getSprint40Leaderboard(store);
    expect(top.map((entry) => entry.playerId)).toEqual(['b', 'c', 'a']);
  });

  it('caps the stored entries at the maximum', async () => {
    const store = new MemoryLeaderboardStore();
    for (let i = 0; i < LEADERBOARD_MAX_ENTRIES + 25; i += 1) {
      await submitSprint40Score(store, baseInput({ playerId: `p-${i}`, elapsedFrames: SPRINT40_MIN_FRAMES + i }));
    }
    const top = await getSprint40Leaderboard(store, LEADERBOARD_MAX_ENTRIES + 50);
    expect(top.length).toBe(LEADERBOARD_MAX_ENTRIES);
    // Los más rápidos sobreviven a la poda.
    expect(top[0].elapsedFrames).toBe(SPRINT40_MIN_FRAMES);
  });

  it('defaults a blank name to Jugador', async () => {
    const store = new MemoryLeaderboardStore();
    await submitSprint40Score(store, baseInput({ name: '   ' }));
    const top = await getSprint40Leaderboard(store);
    expect(top[0].name).toBe('Jugador');
  });
});
