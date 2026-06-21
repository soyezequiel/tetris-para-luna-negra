import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LUNA_BOARD_SURVIVAL,
  LUNA_BOARD_WINS,
  mirrorLunaScore,
} from '../src/online/lunaNegraLeaderboard';

function setEnv(): void {
  process.env.LUNA_NEGRA_BASE_URL = 'https://luna.example';
  process.env.LUNA_NEGRA_API_KEY = 'ln_sk_test';
  process.env.LUNA_NEGRA_GAME_ID = 'game-x';
}

function clearEnv(): void {
  delete process.env.LUNA_NEGRA_BASE_URL;
  delete process.env.LUNA_NEGRA_API_KEY;
  delete process.env.LUNA_NEGRA_GAME_ID;
}

describe('mirrorLunaScore', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearEnv();
  });

  it('posts the score with API key, gameId and npub to the right board', async () => {
    setEnv();
    const fetchMock = vi.fn(async () => Response.json({ score: 5, rank: 1, improved: true }));
    vi.stubGlobal('fetch', fetchMock);

    const ok = await mirrorLunaScore(LUNA_BOARD_WINS, 'npub1abc', 5);

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://luna.example/api/v1/leaderboards/victorias/scores');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ln_sk_test');
    expect(JSON.parse(init.body as string)).toEqual({ gameId: 'game-x', npub: 'npub1abc', score: 5 });
  });

  it('does nothing without Luna config', async () => {
    clearEnv();
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetchMock);

    const ok = await mirrorLunaScore(LUNA_BOARD_SURVIVAL, 'npub1abc', 1000);

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips guests (no npub) and invalid npubs', async () => {
    setEnv();
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetchMock);

    expect(await mirrorLunaScore(LUNA_BOARD_WINS, null, 5)).toBe(false);
    expect(await mirrorLunaScore(LUNA_BOARD_WINS, 'deadbeef', 5)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clamps the score to Luna Negra max and floors it', async () => {
    setEnv();
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetchMock);

    await mirrorLunaScore(LUNA_BOARD_SURVIVAL, 'npub1abc', 5_000_000_000.7);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).score).toBe(1_000_000_000);
  });

  it('swallows non-2xx and network errors (best-effort)', async () => {
    setEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    expect(await mirrorLunaScore(LUNA_BOARD_WINS, 'npub1abc', 5)).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    expect(await mirrorLunaScore(LUNA_BOARD_WINS, 'npub1abc', 5)).toBe(false);
  });
});
