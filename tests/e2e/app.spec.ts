import { expect, type Page, type Route, test } from '@playwright/test';
import { action, appMode, openFreshApp, writeReplayFixture } from './fixtures';
import { BATTLE_RULES } from '../../src/game/rules';
import type { GameRules } from '../../src/game/types';
import type { MatchmakingTicket, OnlineMatchType, OnlineRoomMode, OnlineRuleset, OnlineSeriesState, QuickPlayLeaderboardEntry, TargetingMode } from '../../src/online/protocol';

test.describe('STACK/40 browser flows', () => {
  test('serves online API during local Vite dev', async ({ page }) => {
    await openFreshApp(page);
    const health = await page.request.get('/api/health');
    expect(health.ok()).toBe(true);
    expect((await health.json() as { ok?: boolean }).ok).toBe(true);

    const response = await page.request.get('/api/rooms/public');
    expect(response.ok()).toBe(true);
    expect((await response.json() as { rooms?: unknown[] }).rooms).toEqual([]);
  });

  test('starts a run and pauses/resumes from the HUD', async ({ page }) => {
    await openFreshApp(page);

    await expect(action(page, 'solo-menu')).toHaveText('SOLO');
    await action(page, 'solo-menu').click();
    await expect.poll(() => appMode(page)).toBe('soloMenu');
    await expect(action(page, 'start')).toHaveText('40 líneas');
    await action(page, 'start').click();
    await expect.poll(() => appMode(page)).toBe('playing');

    await page.keyboard.press('Escape');
    await expect.poll(() => appMode(page)).toBe('paused');
    await expect(page.locator('.panel-eyebrow')).toHaveText('PAUSED');
    await expect(action(page, 'resume')).toBeVisible();

    await action(page, 'resume').click();
    await expect.poll(() => appMode(page)).toBe('playing');
    await expect(action(page, 'resume')).toBeHidden();
  });

  test('configures and starts a custom run from the visible menu', async ({ page }) => {
    await openFreshApp(page);

    await action(page, 'solo-menu').click();
    await expect.poll(() => appMode(page)).toBe('soloMenu');
    await action(page, 'custom-open').click();
    await expect.poll(() => appMode(page)).toBe('custom');
    await expect(page.getByRole('heading', { name: 'Custom' })).toBeVisible();
    await expect(page.locator('[data-custom-setting="gravity"]')).toHaveValue('0.02');
    await expect(page.locator('[data-custom-setting="lockDelayFrames"]')).toHaveValue('30');
    await expect(page.locator('[data-custom-setting="boardWidth"]')).toHaveValue('10');

    await page.locator('[data-ui-action="custom-toggle"][data-setting="useRandomSeed"]').click();
    await page.locator('[data-custom-setting="boardWidth"]').fill('12');
    await expect.poll(() => page.evaluate(() => window.stack40.getCustomSettings().boardWidth)).toBe(12);
    await expect.poll(() => page.evaluate(() => window.stack40.getCustomSettings().useRandomSeed)).toBe(false);

    await action(page, 'custom-start').click();
    await expect.poll(() => appMode(page)).toBe('playing');
    await expect.poll(() => page.evaluate(() => window.stack40.getReplay().seed)).toBe(0);
    await expect.poll(() => page.evaluate(() => window.stack40.getState().stats.boardWidth)).toBe(12);
    await expect.poll(() => page.evaluate(() => window.stack40.getState().stats.targetLines)).toBeNull();
  });

  test('rebinds input settings and resets them to defaults', async ({ page }) => {
    await openFreshApp(page);

    await action(page, 'config-menu').click();
    await expect.poll(() => appMode(page)).toBe('configMenu');
    await action(page, 'settings').click();
    await expect.poll(() => appMode(page)).toBe('settings');
    await expect(page.getByRole('heading', { name: 'Controls' })).toBeVisible();

    const moveLeftRow = page.locator('.binding-row').filter({ hasText: 'Move left' });
    await moveLeftRow.getByRole('button').click();
    await expect(moveLeftRow.getByRole('button')).toHaveText('Listening...');

    await page.keyboard.press('a');
    await expect(moveLeftRow.getByRole('button')).toHaveText('A');
    await expect.poll(() => page.evaluate(() => window.stack40.getInputSettings().bindings.moveLeft)).toEqual(['KeyA']);

    await action(page, 'settings-reset').click();
    await expect(moveLeftRow.getByRole('button')).toHaveText('Left');
    await expect.poll(() => page.evaluate(() => window.stack40.getInputSettings().bindings.moveLeft)).toEqual(['ArrowLeft']);
  });

  test('exports a replay, imports a replay file, and pauses/resumes playback', async ({ page }) => {
    const replayPath = await writeReplayFixture('imported-replay.json');
    await openFreshApp(page);

    await action(page, 'solo-menu').click();
    await action(page, 'start').click();
    await expect.poll(() => appMode(page)).toBe('playing');
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await expect.poll(() => appMode(page)).toBe('paused');

    const downloadPromise = page.waitForEvent('download');
    await action(page, 'export-replay').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^stack40-playing-\d+-.*\.json$/);

    await action(page, 'main-menu').click();
    await expect(action(page, 'confirm-destructive')).toBeVisible();
    await action(page, 'confirm-destructive').click();
    await expect.poll(() => appMode(page)).toBe('menu');

    await action(page, 'history-menu').click();
    await expect.poll(() => appMode(page)).toBe('historyMenu');
    const fileChooserPromise = page.waitForEvent('filechooser');
    await action(page, 'import-replay').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(replayPath);

    await expect.poll(() => appMode(page)).toBe('replayPlayback');
    await expect(page.getByRole('heading', { name: /playback/i })).toBeVisible();
    await expect(page.locator('[data-replay-title]')).toContainText(/playback/i);

    await action(page, 'replay-toggle').click();
    await expect.poll(() => page.evaluate(() => window.stack40.getPlayback()?.paused)).toBe(true);
    await expect(action(page, 'replay-toggle')).toHaveText('Resume');

    await action(page, 'replay-toggle').click();
    await expect.poll(() => page.evaluate(() => window.stack40.getPlayback()?.paused)).toBe(false);
    await expect(action(page, 'replay-toggle')).toHaveText('Pause');
  });

  test('maps touch buttons to gameplay input and clears held state on pointer cancel', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFreshApp(page);

    await action(page, 'solo-menu').click();
    await action(page, 'start').click();
    await expect.poll(() => appMode(page)).toBe('playing');

    const moveLeft = page.locator('[data-touch-action="moveLeft"]');
    await expect(moveLeft).toBeVisible();
    const box = await moveLeft.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();

    await expect.poll(
      () => page.evaluate(() => window.stack40.getReplay().inputs.filter((input) => input.action === 'moveLeft').length),
      { timeout: 1000 },
    ).toBeGreaterThan(1);

    await moveLeft.dispatchEvent('pointercancel', {
      pointerId: 1,
      pointerType: 'mouse',
      bubbles: true,
      cancelable: true,
    });
    await page.mouse.up();

    const countAfterCancel = await page.evaluate(() => (
      window.stack40.getReplay().inputs.filter((input) => input.action === 'moveLeft').length
    ));
    await page.waitForTimeout(180);
    await expect.poll(() => page.evaluate(() => (
      window.stack40.getReplay().inputs.filter((input) => input.action === 'moveLeft').length
    ))).toBe(countAfterCancel);
  });

  test('repeats held keyboard controls after the input debounce', async ({ page }) => {
    await openFreshApp(page);

    await action(page, 'solo-menu').click();
    await action(page, 'start').click();
    await expect.poll(() => appMode(page)).toBe('playing');

    await page.keyboard.down('ArrowLeft');
    await expect.poll(
      () => page.evaluate(() => window.stack40.getReplay().inputs.filter((input) => input.action === 'moveLeft').length),
      { timeout: 1000 },
    ).toBeGreaterThan(1);

    await page.keyboard.up('ArrowLeft');
    const countAfterRelease = await page.evaluate(() => (
      window.stack40.getReplay().inputs.filter((input) => input.action === 'moveLeft').length
    ));
    await page.waitForTimeout(180);
    await expect.poll(() => page.evaluate(() => (
      window.stack40.getReplay().inputs.filter((input) => input.action === 'moveLeft').length
    ))).toBe(countAfterRelease);
  });

  test('does not repeat held rotation controls', async ({ page }) => {
    await openFreshApp(page);

    await action(page, 'solo-menu').click();
    await action(page, 'start').click();
    await expect.poll(() => appMode(page)).toBe('playing');

    await page.keyboard.down('ArrowUp');
    await expect.poll(
      () => page.evaluate(() => window.stack40.getReplay().inputs.filter((input) => input.action === 'rotateCW').length),
      { timeout: 1000 },
    ).toBe(1);

    await page.waitForTimeout(220);
    await expect.poll(() => page.evaluate(() => (
      window.stack40.getReplay().inputs.filter((input) => input.action === 'rotateCW').length
    ))).toBe(1);

    await page.keyboard.up('ArrowUp');
  });

  test('shows public rooms, joins by listing, and keeps private rooms hidden', async ({ page }) => {
    await mockOnlineApi(page);
    await openFreshApp(page);

    await action(page, 'multiplayer-menu').click();
    await expect.poll(() => appMode(page)).toBe('multiplayerMenu');
    await action(page, 'online-open').click();
    await expect.poll(() => appMode(page)).toBe('onlineMenu');
    await expect(page.getByText('PUB1')).toBeVisible();
    await expect(page.getByText('PRV1')).toBeHidden();

    await action(page, 'online-join-public').click();
    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await expect(page.getByRole('heading', { name: 'PUB1' })).toBeVisible();
  });

  test('enters a matched Quick Duel room from matchmaking', async ({ page }) => {
    await mockOnlineApi(page);
    await openFreshApp(page);

    await action(page, 'multiplayer-menu').click();
    await action(page, 'online-open').click();
    await page.locator('[data-online-field="name"]').fill('Duelist');
    await action(page, 'online-quick-duel').click();

    await expect.poll(() => appMode(page)).toBe('onlineCountdown');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.matchType)).toBe('duel');
    await expect(page.getByText(/Room DUEL starts/)).toBeVisible();
    await expect(page.getByText('Round 1 - FT3')).toBeVisible();
  });

  test('enters a matched League room from ranked matchmaking', async ({ page }) => {
    await mockOnlineApi(page);
    await openFreshApp(page);

    await action(page, 'multiplayer-menu').click();
    await action(page, 'online-open').click();
    await page.locator('[data-online-field="name"]').fill('Ranked');
    await action(page, 'online-league').click();

    await expect.poll(() => appMode(page)).toBe('onlineCountdown');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.matchType)).toBe('league');
    await expect(page.getByText(/Room LEAG starts/)).toBeVisible();
    await expect(page.getByText('Round 1 - FT3')).toBeVisible();
  });

  test('enters persistent Quick Play without creating a manual room', async ({ page }) => {
    await mockOnlineApi(page);
    await openFreshApp(page);

    await action(page, 'multiplayer-menu').click();
    await action(page, 'online-open').click();
    await page.locator('[data-online-field="name"]').fill('Climber');
    await action(page, 'online-quick-play').click();

    await expect.poll(() => appMode(page)).toBe('onlineCountdown');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.matchType)).toBe('quickPlay');
    await expect(page.getByText(/Room QPLY starts/)).toBeVisible();
  });

  test('keeps online text fields focused and treats R as text input', async ({ page }) => {
    await mockOnlineApi(page);
    await openFreshApp(page);

    await action(page, 'multiplayer-menu').click();
    await action(page, 'online-open').click();
    await expect.poll(() => appMode(page)).toBe('onlineMenu');

    const nameField = page.locator('[data-online-field="name"]');
    await nameField.fill('');
    await nameField.click();
    await page.keyboard.type('ar', { delay: 50 });

    await expect(nameField).toHaveValue('ar');
    await expect.poll(() => page.evaluate(() => (
      document.activeElement instanceof HTMLInputElement
        ? document.activeElement.dataset.onlineField ?? null
        : null
    ))).toBe('name');
    await expect.poll(() => appMode(page)).toBe('onlineMenu');
  });

  test('allows browser copy shortcut when UI text is selected', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFreshApp(page);

    await page.locator('section h1').evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.keyboard.press('Control+C');

    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('STACK/40');
  });

  test('creates an online room, readies, and starts countdown', async ({ page }) => {
    await mockOnlineApi(page);
    await openFreshApp(page);

    await action(page, 'multiplayer-menu').click();
    await action(page, 'online-open').click();
    await page.locator('[data-online-field="name"]').fill('Host');
    await expect(page.getByText('Battle room - last player standing')).toBeVisible();
    await action(page, 'online-create-private').click();
    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await expect(page.getByRole('heading', { name: 'ROOM' })).toBeVisible();
    await expect(page.getByText('Battle room: survive')).toBeVisible();

    await action(page, 'online-ready').click();
    await expect(page.locator('.online-lobby-player span')).toHaveText('Ready');

    await action(page, 'online-start').click();
    await expect.poll(() => appMode(page)).toBe('onlineCountdown');
    await expect(page.getByRole('heading', { name: /[1-5]/ })).toBeVisible();
    await expect(page.getByText('Last player standing wins')).toBeVisible();
  });

  test('creates a custom online room from the multiplayer menu', async ({ page }) => {
    const requests = await mockOnlineApi(page);
    await openFreshApp(page);

    await action(page, 'multiplayer-menu').click();
    await expect(action(page, 'online-custom-open')).toHaveText('Custom room');
    await action(page, 'online-custom-open').click();
    await expect.poll(() => appMode(page)).toBe('onlineMenu');
    await expect(page.getByRole('heading', { name: 'Custom room' })).toBeVisible();
    await expect(page.getByText('Custom room - usa la configuracion custom del host')).toBeVisible();

    await action(page, 'online-create-private').click();
    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await expect(page.getByText('Custom room: survive')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.mode)).toBe('custom');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.rules.gravityCellsPerFrame)).toBe(0.02);
    expect(requests.lastCreate?.mode).toBe('custom');
    expect(requests.lastCreate?.rules?.targetLines).toBeNull();
  });
});

async function mockOnlineApi(page: Page): Promise<{ lastCreate: MockCreateRequest | null }> {
  const now = Date.now();
  const requests: { lastCreate: MockCreateRequest | null } = { lastCreate: null };
  let room = createMockRoom('ROOM', 'private', now);
  const publicRoom = createMockRoom('PUB1', 'public', now);
  const quickPlayLeaderboard = [createMockQuickPlayLeaderboardEntry('player-leader', 'Leader', now)];

  await page.route('**/api/quickplay/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const serverNowMs = Date.now();
    if (path.endsWith('/enter')) {
      const body = route.request().postDataJSON() as { playerId: string; name: string };
      room = createMockRoom('QPLY', 'public', serverNowMs, body.playerId, body.name, 'battle', BATTLE_RULES, 'quickPlay');
      room = {
        ...room,
        status: 'countdown',
        startsAtServerMs: serverNowMs + 5000,
        players: [{ ...room.players[0], ready: true, status: 'ready' }],
      };
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ room, leaderboard: quickPlayLeaderboard, serverNowMs }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ weekId: quickPlayLeaderboard[0].weekId, entries: quickPlayLeaderboard, serverNowMs }),
    });
  });

  await page.route('**/api/matchmaking/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const serverNowMs = Date.now();
    if (path.endsWith('/enqueue')) {
      const body = route.request().postDataJSON() as { playerId: string; name: string; queue?: 'quickDuel' | 'league' };
      const matchType: OnlineMatchType = body.queue === 'league' ? 'league' : 'duel';
      room = createMockRoom(matchType === 'league' ? 'LEAG' : 'DUEL', 'private', serverNowMs, body.playerId, body.name, 'battle', BATTLE_RULES, matchType);
      room = {
        ...room,
        status: 'countdown',
        startsAtServerMs: serverNowMs + 5000,
        players: [
          { ...room.players[0], ready: true, status: 'ready' },
          { ...createMockPlayer('player-duel-opponent', 'Opponent', serverNowMs), ready: true, status: 'ready' },
        ],
      };
      room = { ...room, series: createMockSeries(room, serverNowMs) };
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ticket: createMockMatchmakingTicket('matched', body.playerId, body.name, serverNowMs, room.id),
          room,
          serverNowMs,
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ticket: createMockMatchmakingTicket('queued', 'player-host-mock', 'Host', serverNowMs, null),
        room: null,
        serverNowMs,
      }),
    });
  });

  await page.route('**/api/rooms/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/public')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          rooms: [{
            id: publicRoom.id,
            hostName: 'Public host',
            playerCount: 1,
            mode: publicRoom.mode,
            matchType: publicRoom.matchType,
            region: publicRoom.region,
            ranked: publicRoom.ruleset.ranked,
            customPreset: publicRoom.matchType === 'custom' ? publicRoom.ruleset.rulesetId : null,
            ruleset: publicRoom.ruleset,
            status: 'lobby',
            createdAtServerMs: publicRoom.createdAtServerMs,
          }],
          serverNowMs: Date.now(),
        }),
      });
      return;
    }
    if (path.endsWith('/create')) {
      const body = route.request().postDataJSON() as MockCreateRequest;
      requests.lastCreate = body;
      room = createMockRoom('ROOM', body.visibility, Date.now(), body.playerId, body.name, body.mode, body.rules, body.matchType);
      await fulfillRoom(route, room);
      return;
    }
    if (path.endsWith('/join')) {
      const body = route.request().postDataJSON() as { playerId: string; name: string };
      room = {
        ...publicRoom,
        players: [{ ...publicRoom.players[0] }, createMockPlayer(body.playerId, body.name, Date.now())],
      };
      await fulfillRoom(route, room);
      return;
    }
    if (path.endsWith('/ready')) {
      room = {
        ...room,
        players: room.players.map((player) => ({ ...player, ready: true, status: 'ready' })),
      };
      await fulfillRoom(route, room);
      return;
    }
    if (path.endsWith('/start')) {
      room = {
        ...room,
        status: 'countdown',
        startsAtServerMs: Date.now() + 5000,
      };
      await fulfillRoom(route, room);
      return;
    }
    if (path.endsWith('/targeting')) {
      const body = route.request().postDataJSON() as { playerId: string; targetingMode: TargetingMode; manualTargetPlayerId?: string | null };
      room = {
        ...room,
        players: room.players.map((player) => player.id === body.playerId
          ? {
            ...player,
            targetingMode: body.targetingMode,
            manualTargetPlayerId: body.targetingMode === 'manual' ? body.manualTargetPlayerId ?? null : null,
          }
          : player),
      };
      await fulfillRoom(route, room);
      return;
    }
    if (path.endsWith('/state')) {
      await fulfillRoom(route, room);
      return;
    }
    if (path.endsWith('/signal')) {
      await fulfillRoom(route, room);
      return;
    }
    if (path.endsWith('/progress')) {
      const body = route.request().postDataJSON() as Partial<MockPlayer> & { playerId: string };
      room = {
        ...room,
        players: room.players.map((player) => player.id === body.playerId ? { ...player, ...body, status: 'playing' } : player),
      };
      await fulfillRoom(route, room);
      return;
    }
    if (path.endsWith('/attack')) {
      await fulfillRoom(route, room);
      return;
    }
    if (path.endsWith('/eliminate')) {
      const body = route.request().postDataJSON() as { playerId: string; frame: number };
      room = {
        ...room,
        players: room.players.map((player) => player.id === body.playerId
          ? { ...player, status: 'eliminated', alive: false, eliminatedAtFrame: body.frame, eliminatedAtServerMs: Date.now(), finishedAtServerMs: Date.now() }
          : { ...player, status: 'winner', alive: true, finishedAtServerMs: Date.now() }),
        status: 'finished',
        winnerPlayerId: room.players.find((player) => player.id !== body.playerId)?.id ?? null,
      };
      await fulfillRoom(route, room);
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not mocked.' }) });
  });
  return requests;
}

async function fulfillRoom(route: Route, room: MockRoom): Promise<void> {
  await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ room, serverNowMs: Date.now() }),
  });
}

function createMockRoom(
  id: string,
  visibility: 'public' | 'private',
  now: number,
  playerId = 'player-host-mock',
  name = 'Host',
  mode: OnlineRoomMode = 'battle',
  rules: GameRules = BATTLE_RULES,
  matchType: OnlineMatchType = mode === 'custom' ? 'custom' : 'battle',
): MockRoom {
  return {
    id,
    visibility,
    mode,
    matchType,
    region: 'gru1',
    ruleset: defaultMockRuleset(matchType),
    rules: { ...rules, targetLines: null },
    status: 'lobby',
    hostPlayerId: playerId,
    createdAtServerMs: now,
    updatedAtServerMs: now,
    startsAtServerMs: null,
    seed: 12345,
    winnerPlayerId: null,
    series: null,
    matchResultId: null,
    players: [createMockPlayer(playerId, name, now)],
    peerSignals: [],
    attacks: [],
  };
}

type MockRoom = {
  id: string;
  visibility: 'public' | 'private';
  mode: OnlineRoomMode;
  matchType: OnlineMatchType;
  region: string;
  ruleset: OnlineRuleset;
  rules: GameRules;
  status: string;
  hostPlayerId: string;
  createdAtServerMs: number;
  updatedAtServerMs: number;
  startsAtServerMs: number | null;
  seed: number;
  winnerPlayerId: string | null;
  series: OnlineSeriesState | null;
  matchResultId: string | null;
  players: MockPlayer[];
  peerSignals: unknown[];
  attacks: unknown[];
};

function createMockPlayer(id: string, name: string, now: number): MockPlayer {
  return {
    id,
    name,
    ready: false,
    status: 'joined',
    lines: 0,
    pieces: 0,
    elapsedFrames: 0,
    sentGarbage: 0,
    receivedGarbage: 0,
    pendingGarbage: 0,
    alive: true,
    updatedAtServerMs: now,
    finishedAtServerMs: null,
    eliminatedAtFrame: null,
    eliminatedAtServerMs: null,
    game: null,
    targetingMode: 'random',
    manualTargetPlayerId: null,
    currentTargetPlayerId: null,
    recentAttackers: [],
    koCount: 0,
    receivedGarbageThisRound: 0,
    dangerLevel: 0,
  };
}

function createMockMatchmakingTicket(
  status: MatchmakingTicket['status'],
  playerId: string,
  name: string,
  now: number,
  roomId: string | null,
): MatchmakingTicket {
  return {
    id: `ticket-${playerId}`,
    queue: 'quickDuel',
    playerId,
    name,
    region: 'gru1',
    rating: 1000,
    status,
    roomId,
    createdAtServerMs: now,
    updatedAtServerMs: now,
    expiresAtServerMs: now + 30000,
  };
}

function createMockSeries(room: MockRoom, now: number): OnlineSeriesState {
  return {
    objective: 'duelRounds',
    firstTo: room.ruleset.objective.type === 'duelRounds' ? room.ruleset.objective.firstTo : 3,
    currentRound: 1,
    roundId: `${room.id}-r1-${now}`,
    scores: room.players.map((player) => ({ playerId: player.id, wins: 0 })),
    rounds: [],
    completed: false,
    winnerPlayerId: null,
  };
}

function createMockQuickPlayLeaderboardEntry(playerId: string, displayName: string, now: number): QuickPlayLeaderboardEntry {
  return {
    playerId,
    displayName,
    weekId: '2026-06-01',
    score: 420,
    lines: 24,
    koCount: 1,
    survivalFrames: 1800,
    sentGarbage: 12,
    receivedGarbage: 8,
    updatedAtServerMs: now,
  };
}

type MockPlayer = {
  id: string;
  name: string;
  ready: boolean;
  status: string;
  lines: number;
  pieces: number;
  elapsedFrames: number;
  sentGarbage: number;
  receivedGarbage: number;
  pendingGarbage: number;
  alive: boolean;
  updatedAtServerMs: number;
  finishedAtServerMs: number | null;
  eliminatedAtFrame: number | null;
  eliminatedAtServerMs: number | null;
  game: unknown;
  targetingMode: TargetingMode;
  manualTargetPlayerId: string | null;
  currentTargetPlayerId: string | null;
  recentAttackers: string[];
  koCount: number;
  receivedGarbageThisRound: number;
  dangerLevel: number;
};

type MockCreateRequest = {
  playerId: string;
  name: string;
  visibility: 'public' | 'private';
  mode: OnlineRoomMode;
  matchType?: OnlineMatchType;
  ruleset?: Partial<OnlineRuleset>;
  rules?: GameRules;
};

function defaultMockRuleset(matchType: OnlineMatchType): OnlineRuleset {
  if (matchType === 'duel' || matchType === 'league') {
    return {
      rulesetId: matchType === 'league' ? 'league-ft3-simple' : 'duel-ft3-simple',
      rulesetVersion: 1,
      objective: { type: 'duelRounds', firstTo: 3 },
      attackTable: 'simple',
      targeting: 'random',
      ranked: matchType === 'league',
    };
  }
  if (matchType === 'quickPlay') {
    return {
      rulesetId: 'quick-play-climb-simple',
      rulesetVersion: 1,
      objective: { type: 'quickPlayClimb', floorSystem: 'weekly' },
      attackTable: 'simple',
      targeting: 'even',
      ranked: false,
    };
  }
  return {
    rulesetId: matchType === 'custom' ? 'custom-survival-simple' : 'battle-survival-simple',
    rulesetVersion: 1,
    objective: { type: 'lastStanding' },
    attackTable: 'simple',
    targeting: 'random',
    ranked: false,
  };
}
