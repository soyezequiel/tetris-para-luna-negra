import { describe, expect, it } from 'vitest';
import {
  getSurvivalLeaderboard,
  SURVIVAL_MAX_ENTRIES,
  MemorySurvivalLeaderboardStore,
  submitSurvival,
} from '../src/online/survivalLeaderboard';
import { OnlineRoomError } from '../src/online/roomService';

function baseInput(overrides: Partial<Parameters<typeof submitSurvival>[1]> = {}) {
  return {
    playerId: 'player-1',
    name: 'Ana',
    avatarUrl: null,
    npub: null,
    durationMs: 10_000,
    ...overrides,
  };
}

describe('submitSurvival', () => {
  it('rejects an empty playerId', async () => {
    const store = new MemorySurvivalLeaderboardStore();
    await expect(submitSurvival(store, baseInput({ playerId: '   ' })))
      .rejects.toBeInstanceOf(OnlineRoomError);
  });

  it('rejects a non-positive or non-finite durationMs', async () => {
    const store = new MemorySurvivalLeaderboardStore();
    await expect(submitSurvival(store, baseInput({ durationMs: 0 }))).rejects.toBeInstanceOf(OnlineRoomError);
    await expect(submitSurvival(store, baseInput({ durationMs: -5 }))).rejects.toBeInstanceOf(OnlineRoomError);
    await expect(submitSurvival(store, baseInput({ durationMs: Number.NaN }))).rejects.toBeInstanceOf(OnlineRoomError);
  });

  it('keeps only the best (longest) time per player', async () => {
    const store = new MemorySurvivalLeaderboardStore();
    await submitSurvival(store, baseInput({ durationMs: 10_000 }));
    await submitSurvival(store, baseInput({ durationMs: 30_000 }));
    await submitSurvival(store, baseInput({ durationMs: 20_000 })); // peor: no baja el récord
    const top = await getSurvivalLeaderboard(store);
    expect(top).toHaveLength(1);
    expect(top[0].bestMs).toBe(30_000);
  });

  it('orders players descending by best time (longest first)', async () => {
    const store = new MemorySurvivalLeaderboardStore();
    await submitSurvival(store, baseInput({ playerId: 'a', name: 'A', durationMs: 5_000 }));
    await submitSurvival(store, baseInput({ playerId: 'b', name: 'B', durationMs: 30_000 }));
    await submitSurvival(store, baseInput({ playerId: 'c', name: 'C', durationMs: 15_000 }));
    const top = await getSurvivalLeaderboard(store);
    expect(top.map((entry) => entry.playerId)).toEqual(['b', 'c', 'a']);
    expect(top.map((entry) => entry.bestMs)).toEqual([30_000, 15_000, 5_000]);
  });

  it('breaks ties by who reached the time first', async () => {
    const store = new MemorySurvivalLeaderboardStore();
    await submitSurvival(store, baseInput({ playerId: 'early', name: 'Early', durationMs: 10_000 }), 1000);
    await submitSurvival(store, baseInput({ playerId: 'late', name: 'Late', durationMs: 10_000 }), 2000);
    const top = await getSurvivalLeaderboard(store);
    expect(top.map((entry) => entry.playerId)).toEqual(['early', 'late']);
  });

  it('caps the stored entries at the maximum, keeping the longest survivors', async () => {
    const store = new MemorySurvivalLeaderboardStore();
    // Un jugador destacado con un tiempo enorme debe sobrevivir a la poda.
    await submitSurvival(store, baseInput({ playerId: 'star', name: 'Star', durationMs: 999_000 }));
    for (let i = 0; i < SURVIVAL_MAX_ENTRIES + 25; i += 1) {
      await submitSurvival(store, baseInput({ playerId: `p-${i}`, name: `P${i}`, durationMs: 1_000 + i }));
    }
    const top = await getSurvivalLeaderboard(store, SURVIVAL_MAX_ENTRIES + 50);
    expect(top.length).toBe(SURVIVAL_MAX_ENTRIES);
    expect(top[0].playerId).toBe('star');
    expect(top[0].bestMs).toBe(999_000);
  });

  it('defaults a blank name to Jugador', async () => {
    const store = new MemorySurvivalLeaderboardStore();
    await submitSurvival(store, baseInput({ name: '   ' }));
    const top = await getSurvivalLeaderboard(store);
    expect(top[0].name).toBe('Jugador');
  });

  it('round-trips times through snapshot/hydrate (DO persistence)', async () => {
    const store = new MemorySurvivalLeaderboardStore();
    await submitSurvival(store, baseInput({ playerId: 'a', name: 'A', durationMs: 5_000 }));
    await submitSurvival(store, baseInput({ playerId: 'b', name: 'B', durationMs: 20_000 }));

    // Simula el reinicio del Durable Object: snapshot persistido → nueva instancia.
    const rehydrated = new MemorySurvivalLeaderboardStore();
    rehydrated.hydrate(store.snapshot());
    await submitSurvival(rehydrated, baseInput({ playerId: 'a', name: 'A', durationMs: 40_000 }));

    const top = await getSurvivalLeaderboard(rehydrated);
    expect(top.map((entry) => entry.playerId)).toEqual(['a', 'b']);
    expect(top.map((entry) => entry.bestMs)).toEqual([40_000, 20_000]);
  });
});
