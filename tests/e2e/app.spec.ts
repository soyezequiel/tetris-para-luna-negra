import { expect, type Page, type Route, test } from '@playwright/test';
import { action, appMode, openFreshApp, writeReplayFixture } from './fixtures';

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

    await expect(action(page, 'start')).toHaveText('Start run');
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

  test('rebinds input settings and resets them to defaults', async ({ page }) => {
    await openFreshApp(page);

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

  test('shows public rooms, joins by listing, and keeps private rooms hidden', async ({ page }) => {
    await mockOnlineApi(page);
    await openFreshApp(page);

    await action(page, 'online-open').click();
    await expect.poll(() => appMode(page)).toBe('onlineMenu');
    await expect(page.getByText('PUB1')).toBeVisible();
    await expect(page.getByText('PRV1')).toBeHidden();

    await action(page, 'online-join-public').click();
    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await expect(page.getByRole('heading', { name: 'PUB1' })).toBeVisible();
  });

  test('keeps online text fields focused and treats R as text input', async ({ page }) => {
    await mockOnlineApi(page);
    await openFreshApp(page);

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

  test('creates an online room, readies, and starts countdown', async ({ page }) => {
    await mockOnlineApi(page);
    await openFreshApp(page);

    await action(page, 'online-open').click();
    await page.locator('[data-online-field="name"]').fill('Host');
    await action(page, 'online-create-private').click();
    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await expect(page.getByRole('heading', { name: 'ROOM' })).toBeVisible();

    await action(page, 'online-ready').click();
    await expect(page.locator('.online-lobby-player span')).toHaveText('Ready');

    await action(page, 'online-start').click();
    await expect.poll(() => appMode(page)).toBe('onlineCountdown');
    await expect(page.getByRole('heading', { name: /[1-5]/ })).toBeVisible();
  });
});

async function mockOnlineApi(page: Page): Promise<void> {
  const now = Date.now();
  let room = createMockRoom('ROOM', 'private', now);
  const publicRoom = createMockRoom('PUB1', 'public', now);

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
            status: 'lobby',
            createdAtServerMs: publicRoom.createdAtServerMs,
          }],
          serverNowMs: Date.now(),
        }),
      });
      return;
    }
    if (path.endsWith('/create')) {
      const body = route.request().postDataJSON() as { playerId: string; name: string; visibility: 'public' | 'private' };
      room = createMockRoom('ROOM', body.visibility, Date.now(), body.playerId, body.name);
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
    if (path.endsWith('/state')) {
      await fulfillRoom(route, room);
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not mocked.' }) });
  });
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
): MockRoom {
  return {
    id,
    visibility,
    status: 'lobby',
    hostPlayerId: playerId,
    createdAtServerMs: now,
    updatedAtServerMs: now,
    startsAtServerMs: null,
    seed: 12345,
    players: [createMockPlayer(playerId, name, now)],
  };
}

type MockRoom = {
  id: string;
  visibility: 'public' | 'private';
  status: string;
  hostPlayerId: string;
  createdAtServerMs: number;
  updatedAtServerMs: number;
  startsAtServerMs: number | null;
  seed: number;
  players: MockPlayer[];
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
    updatedAtServerMs: now,
    finishedAtServerMs: null,
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
  updatedAtServerMs: number;
  finishedAtServerMs: number | null;
};
