import { describe, expect, it } from 'vitest';
import {
  getWinsLeaderboard,
  LEADERBOARD_MAX_ENTRIES,
  MemoryLeaderboardStore,
  submitWin,
} from '../src/online/leaderboard';
import { OnlineRoomError } from '../src/online/roomService';

function baseInput(overrides: Partial<Parameters<typeof submitWin>[1]> = {}) {
  return {
    playerId: 'player-1',
    name: 'Ana',
    avatarUrl: null,
    npub: null,
    ...overrides,
  };
}

describe('submitWin', () => {
  it('rejects an empty playerId', async () => {
    const store = new MemoryLeaderboardStore();
    await expect(submitWin(store, baseInput({ playerId: '   ' })))
      .rejects.toBeInstanceOf(OnlineRoomError);
  });

  it('accumulates a player wins across submissions', async () => {
    const store = new MemoryLeaderboardStore();
    await submitWin(store, baseInput());
    await submitWin(store, baseInput());
    await submitWin(store, baseInput());
    const top = await getWinsLeaderboard(store);
    expect(top).toHaveLength(1);
    expect(top[0].wins).toBe(3);
  });

  it('orders players descending by wins (most wins first)', async () => {
    const store = new MemoryLeaderboardStore();
    await submitWin(store, baseInput({ playerId: 'a', name: 'A' })); // 1
    await submitWin(store, baseInput({ playerId: 'b', name: 'B' })); // 1
    await submitWin(store, baseInput({ playerId: 'b', name: 'B' })); // 2
    await submitWin(store, baseInput({ playerId: 'b', name: 'B' })); // 3
    await submitWin(store, baseInput({ playerId: 'c', name: 'C' })); // 1
    await submitWin(store, baseInput({ playerId: 'c', name: 'C' })); // 2
    const top = await getWinsLeaderboard(store);
    expect(top.map((entry) => entry.playerId)).toEqual(['b', 'c', 'a']);
    expect(top.map((entry) => entry.wins)).toEqual([3, 2, 1]);
  });

  it('breaks ties by who reached the count first', async () => {
    const store = new MemoryLeaderboardStore();
    await submitWin(store, baseInput({ playerId: 'early', name: 'Early' }), 1000);
    await submitWin(store, baseInput({ playerId: 'late', name: 'Late' }), 2000);
    const top = await getWinsLeaderboard(store);
    expect(top.map((entry) => entry.playerId)).toEqual(['early', 'late']);
  });

  it('caps the stored entries at the maximum, keeping the winningest', async () => {
    const store = new MemoryLeaderboardStore();
    // Un jugador destacado con varias victorias debe sobrevivir a la poda.
    for (let i = 0; i < 5; i += 1) await submitWin(store, baseInput({ playerId: 'star', name: 'Star' }));
    for (let i = 0; i < LEADERBOARD_MAX_ENTRIES + 25; i += 1) {
      await submitWin(store, baseInput({ playerId: `p-${i}`, name: `P${i}` }));
    }
    const top = await getWinsLeaderboard(store, LEADERBOARD_MAX_ENTRIES + 50);
    expect(top.length).toBe(LEADERBOARD_MAX_ENTRIES);
    expect(top[0].playerId).toBe('star');
    expect(top[0].wins).toBe(5);
  });

  it('defaults a blank name to Jugador', async () => {
    const store = new MemoryLeaderboardStore();
    await submitWin(store, baseInput({ name: '   ' }));
    const top = await getWinsLeaderboard(store);
    expect(top[0].name).toBe('Jugador');
  });
});
