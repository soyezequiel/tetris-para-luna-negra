import { expect, type Page, type Route, test } from '@playwright/test';
import { action, appMode, openFreshApp, writeReplayFixture } from './fixtures';
import { BATTLE_RULES } from '../../src/game/rules';
import type { Cell, GameRules, PieceType } from '../../src/game/types';
import type { OnlineGameSnapshot, OnlineMatchType, OnlineRoomMode, OnlineRuleset, RoomBet, TargetingMode, UpdateRoomSettingsRequest } from '../../src/online/protocol';

test.describe('TETRA browser flows', () => {
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
    const requests = await mockOnlineApi(page);
    await openFreshApp(page);

    await expect.poll(() => appMode(page)).toBe('menu');
    await expect(page.getByRole('heading', { name: 'Disponible' })).toBeVisible();
    await expect(page.getByText('PUB1')).toBeVisible();
    await expect(page.getByText('PRV1')).toBeHidden();
    expect(requests.lastCreate).toBeNull();

    await action(page, 'online-join-public').click();
    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await expect(page.getByRole('heading', { name: 'PUB1' })).toBeVisible();
  });

  test('opens custom online rooms directly from multiplayer', async ({ page }) => {
    await mockOnlineApi(page);
    await openFreshApp(page);

    await action(page, 'multiplayer-menu').click();

    await expect.poll(() => appMode(page)).toBe('onlineMenu');
    await expect(page.getByRole('heading', { name: 'Salas' })).toBeVisible();
    await expect(action(page, 'online-create-public')).toBeVisible();
    await expect(action(page, 'online-create-private')).toBeVisible();
    await expect(page.getByText('Quick Duel')).toHaveCount(0);
    await expect(page.getByText('League')).toHaveCount(0);
    await expect(page.getByText('Quick Play')).toHaveCount(0);
    await expect(page.getByText('Royale')).toHaveCount(0);
    await expect(page.getByText('Sprint Race')).toHaveCount(0);
    await expect(page.getByText(/ranking/i)).toHaveCount(0);
  });

  test('keeps online text fields focused and treats R as text input', async ({ page }) => {
    await mockOnlineApi(page);
    await openFreshApp(page);

    await expect.poll(() => appMode(page)).toBe('menu');

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
    await expect.poll(() => appMode(page)).toBe('menu');
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

    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('TETRA');
  });

  test('creates an online room, readies, and starts countdown', async ({ page }) => {
    await mockOnlineApi(page);
    await openFreshApp(page);

    await page.locator('[data-online-field="name"]').fill('Host');
    await action(page, 'online-create-private').click();
    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await expect(page.getByRole('heading', { name: 'ROOM' })).toBeVisible();
    await expect(page.getByText(/Custom room/)).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.matchType)).toBe('custom');

    await action(page, 'online-ready').click();
    await expect(page.locator('.cs2-player-status').first()).toContainText('Listo');

    await action(page, 'online-start').click();
    await expect.poll(() => appMode(page)).toBe('onlineCountdown');
    await expect(page.getByRole('heading', { name: /[1-5]/ })).toBeVisible();
    await expect(page.getByText('Last player standing wins')).toBeVisible();
  });

  test('starts a new online game from online results', async ({ page }) => {
    const requests = await mockOnlineApi(page, { finishedCreatedRoom: true });
    await openFreshApp(page);

    await page.locator('[data-online-field="name"]').fill('Host');
    await action(page, 'online-create-private').click();
    await expect.poll(() => appMode(page)).toBe('onlineResults');
    await expect(action(page, 'online-restart')).toHaveText('Nueva partida');

    await action(page, 'online-restart').click();

    await expect.poll(() => appMode(page)).toBe('onlineCountdown');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.status)).toBe('countdown');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.seed)).toBe(12346);
    expect(requests.restartCount).toBe(1);
  });

  test('keeps the online room when returning from results to the main menu', async ({ page }) => {
    await mockOnlineApi(page, { finishedCreatedRoom: true });
    await openFreshApp(page);

    await page.locator('[data-online-field="name"]').fill('Host');
    await action(page, 'online-create-private').click();
    await expect.poll(() => appMode(page)).toBe('onlineResults');

    await action(page, 'main-menu').click();

    await expect.poll(() => appMode(page)).toBe('menu');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.id ?? null)).toBe('ROOM');
    await expect(action(page, 'online-leave')).toContainText('Salir');
  });

  test('restores the current online room after a page reload', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__E2E__ = true;
    });
    await mockOnlineApi(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'TETRA' })).toBeVisible();
    await expect.poll(() => appMode(page)).toBe('menu');

    await page.locator('[data-online-field="name"]').fill('Host');
    await action(page, 'online-create-private').click();
    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.id ?? null)).toBe('ROOM');

    await page.reload();

    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.id ?? null)).toBe('ROOM');
  });

  test('blocks page unload confirmation during an active online game', async ({ page }) => {
    await mockOnlineApi(page, { largePlayingRoom: true, createdLobbyGuestRoom: true });
    await openFreshApp(page);

    await page.locator('[data-online-field="name"]').fill('Host');
    await action(page, 'online-create-private').click();
    await action(page, 'online-ready').click();
    await action(page, 'online-start').click();
    await expect.poll(() => appMode(page)).toBe('onlinePlaying');

    const result = await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
      const dispatched = window.dispatchEvent(event);
      return {
        defaultPrevented: event.defaultPrevented,
        dispatched,
        returnValue: event.returnValue,
      };
    });

    expect(result.defaultPrevented).toBe(true);
    expect(result.dispatched).toBe(false);
  });

  test('adopts a restarted online round even if the local room is still playing', async ({ page }) => {
    const requests = await mockOnlineApi(page, { largePlayingRoom: true });
    await openFreshApp(page);

    await page.locator('[data-online-field="name"]').fill('Host');
    await action(page, 'online-create-private').click();
    await action(page, 'online-ready').click();
    await action(page, 'online-start').click();
    await expect.poll(() => appMode(page)).toBe('onlinePlaying');
    await expect.poll(() => page.evaluate(() => window.stack40.getReplay().seed)).toBe(12345);

    requests.restartOnNextState = true;

    await expect.poll(() => page.evaluate(() => window.stack40.getReplay().seed), { timeout: 3000 }).toBe(12346);
    await expect.poll(() => appMode(page)).toBe('onlinePlaying');
  });

  test('keeps a guest in the online round when its local prediction reaches gameover first', async ({ page }) => {
    await mockOnlineApi(page, { createdPlayingGuestRoom: true });
    await openFreshApp(page);

    await page.locator('[data-online-field="name"]').fill('Guest');
    await action(page, 'online-create-private').click();
    await expect.poll(() => appMode(page)).toBe('onlinePlaying');
    await expect.poll(() => page.evaluate(() => {
      const room = window.stack40.getOnlineRoom();
      const player = window.stack40.getOnlinePlayer();
      return !!room && room.hostPlayerId !== player.id;
    })).toBe(true);

    for (let index = 0; index < 140; index += 1) {
      await page.keyboard.press('Space');
      if (await page.evaluate(() => window.stack40.getState().status !== 'playing')) break;
      await page.waitForTimeout(10);
    }

    await expect.poll(() => page.evaluate(() => window.stack40.getState().status), { timeout: 5000 }).toBe('gameover');
    await expect.poll(() => appMode(page), { timeout: 1000 }).toBe('onlinePlaying');
    await expect(page.getByRole('heading', { name: 'ONLINE RESULTS' })).toBeHidden();
  });

  test('shows many online opponents to the right with auto-sized boards', async ({ page }) => {
    await page.setViewportSize({ width: 1365, height: 768 });
    await mockOnlineApi(page, { largePlayingRoom: true });
    await openFreshApp(page);

    await page.locator('[data-online-field="name"]').fill('Host');
    await action(page, 'online-create-private').click();
    await expect.poll(() => appMode(page)).toBe('roomLobby');

    await action(page, 'online-ready').click();
    await action(page, 'online-start').click();
    await expect.poll(() => appMode(page)).toBe('onlinePlaying');

    const layout = await page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>('.online-versus-grid');
      const boards = Array.from(document.querySelectorAll<HTMLElement>('.online-versus-grid .online-peer-board'));
      const board = boards[0]?.getBoundingClientRect();
      const gridRect = grid?.getBoundingClientRect();
      const boardList = document.querySelector<HTMLElement>('.online-peer-boards');
      const style = boardList ? getComputedStyle(boardList) : null;
      return {
        count: boards.length,
        columns: style?.getPropertyValue('--online-peer-columns').trim() ?? '',
        cardWidth: Number.parseFloat(style?.getPropertyValue('--online-peer-card-width') ?? '0'),
        firstBoardWidth: board?.width ?? 0,
        firstBoardHeight: board?.height ?? 0,
        gridLeft: gridRect?.left ?? 0,
        leftPanelBoards: document.querySelectorAll('.online-race-panel .online-peer-board').length,
      };
    });

    expect(layout.count).toBe(7);
    expect(layout.columns).toBe('3');
    expect(layout.cardWidth).toBeGreaterThanOrEqual(70);
    expect(layout.cardWidth).toBeLessThanOrEqual(100);
    expect(layout.firstBoardWidth).toBeGreaterThanOrEqual(70);
    expect(layout.firstBoardHeight).toBeGreaterThan(150);
    expect(layout.gridLeft).toBeGreaterThan(980);
    expect(layout.leftPanelBoards).toBe(0);
  });

  test('enters a Luna Negra room from invite query and cleans the token', async ({ page }) => {
    await mockOnlineApi(page);
    await page.addInitScript(() => {
      window.localStorage.clear();
    });

    await page.goto('/?inviteToken=fake-token&room=abc12345');

    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.id)).toBe('ABC12345');
    await expect(page.getByText('SALA PRIVADA ABC12345')).toBeVisible();
    await expect(page.getByText('Nostr Host', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlinePlayer())).toEqual({
      id: 'pubkey-host-luna',
      name: 'Nostr Host',
      avatarUrl: 'https://example.com/nostr-host.png',
    });
    await expect.poll(() => page.evaluate(() => window.stack40.getLunaIdentity())).toEqual({
      npub: 'npub-host-luna',
      pubkey: 'pubkey-host-luna',
      name: 'Nostr Host',
      avatarUrl: 'https://example.com/nostr-host.png',
      gameId: 'tetra-game',
    });
    await expect.poll(() => page.evaluate(() => window.location.search.includes('inviteToken'))).toBe(false);
  });

  test('wakes and refreshes the bet backend after opening payment', async ({ page }) => {
    const requests = await mockOnlineApi(page, { lunaBetRoom: true });
    await page.addInitScript(() => {
      window.localStorage.clear();
    });

    await page.goto('/?inviteToken=fake-token&room=bet12345');
    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await expect(action(page, 'online-bet-pay')).toBeVisible();
    await expect(action(page, 'online-bet-copy').first()).toBeVisible();

    requests.healthCount = 0;
    requests.betRefreshCount = 0;
    const popupPromise = page.waitForEvent('popup');
    await action(page, 'online-bet-pay').click();
    const popup = await popupPromise;
    await popup.close();

    await expect.poll(() => requests.healthCount).toBeGreaterThanOrEqual(1);
    await expect.poll(() => requests.betRefreshCount).toBeGreaterThanOrEqual(1);
    await expect(page.getByText(/Backend despierto: \/api\/health 200/)).toBeVisible();
    await expect(page.getByText(/Verificacion OK: \/api\/bets\/refresh 200/).first()).toBeVisible();
    await expect(page.getByText(/depositos 0\/2/).first()).toBeVisible();
  });

  test('explains bet refresh failures after opening payment', async ({ page }) => {
    await mockOnlineApi(page, { lunaBetRoom: true, failBetRefresh: true });
    await page.addInitScript(() => {
      window.localStorage.clear();
    });

    await page.goto('/?inviteToken=fake-token&room=fail1234');
    await expect.poll(() => appMode(page)).toBe('roomLobby');

    const popupPromise = page.waitForEvent('popup');
    await action(page, 'online-bet-pay').click();
    const popup = await popupPromise;
    await popup.close();

    await expect(page.getByText(/Backend despierto: \/api\/health 200/)).toBeVisible();
    await expect(page.getByText(/Fallo verificacion: \/api\/bets\/refresh HTTP 503/)).toBeVisible();
    await expect(page.getByText(/Luna refresh timeout/)).toBeVisible();
  });

  test('enters a Luna Negra room from an accepted invite message in the open game', async ({ page }) => {
    await mockOnlineApi(page);
    await page.addInitScript(() => {
      window.localStorage.clear();
    });

    await page.goto('/?lnToken=fake-session&lnOrigin=https%3A%2F%2Fluna.example');
    await expect.poll(() => appMode(page)).toBe('menu');
    await expect.poll(() => page.evaluate(() => window.location.search.includes('lnOrigin'))).toBe(false);

    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'https://luna.example',
        data: {
          type: 'luna-negra:enter-room',
          inviteToken: 'fake-invite-token',
          roomId: 'abc12345',
        },
      }));
    });

    await expect(page.getByRole('heading', { name: 'Te invitaron a ABC12345' })).toBeVisible();
    await page.getByRole('button', { name: 'Unirme' }).click();

    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.id)).toBe('ABC12345');
    await expect(page.getByText('SALA PRIVADA ABC12345')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlinePlayer().id)).toBe('pubkey-host-luna');
  });

  test('enters a Luna Negra room from a pending launch request in the open game', async ({ page }) => {
    await mockOnlineApi(page);
    let deliveredLaunch = false;
    await page.route('**/api/luna-negra/launch-request**', async (route) => {
      const body = deliveredLaunch
        ? { request: null, source: 'luna-negra', serverNowMs: Date.now() }
        : {
          request: {
            id: 'launch-1',
            roomId: 'abc12345',
            inviteToken: 'fake-invite-token',
            slug: 'TETRA',
            title: 'TETRA',
            gameUrl: 'http://127.0.0.1:5173/',
          },
          source: 'luna-negra',
          serverNowMs: Date.now(),
        };
      deliveredLaunch = true;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.addInitScript(() => {
      window.localStorage.clear();
    });

    await page.goto('/?lnDemo=AlreadyOpen');

    await expect(page.getByRole('heading', { name: 'Te invitaron a ABC12345' })).toBeVisible({ timeout: 7000 });
    await page.getByRole('button', { name: 'Unirme' }).click();

    await expect.poll(() => appMode(page), { timeout: 7000 }).toBe('roomLobby');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.id)).toBe('ABC12345');
    await expect(page.getByText('SALA PRIVADA ABC12345')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlinePlayer().id)).toBe('pubkey-host-luna');
  });

  test('enters a Luna Negra room from a pending launch request with stored identity', async ({ page }) => {
    await mockOnlineApi(page);
    let deliveredLaunch = false;
    await page.route('**/api/luna-negra/launch-request**', async (route) => {
      const body = deliveredLaunch
        ? { request: null, source: 'luna-negra', serverNowMs: Date.now() }
        : lunaLaunchResponse('launch-stored', 'abc12345');
      deliveredLaunch = true;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await addStoredLunaIdentity(page);

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Te invitaron a ABC12345' })).toBeVisible({ timeout: 7000 });
    await page.getByRole('button', { name: 'Unirme' }).click();

    await expect.poll(() => appMode(page), { timeout: 7000 }).toBe('roomLobby');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.id)).toBe('ABC12345');
    await expect(page.getByText('SALA PRIVADA ABC12345')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlinePlayer().id)).toBe('pubkey-host-luna');
  });

  test('asks before leaving the current room for a Luna Negra launch request', async ({ page }) => {
    await mockOnlineApi(page);
    let launchEnabled = false;
    await page.route('**/api/luna-negra/launch-request**', async (route) => {
      const body = launchEnabled
        ? lunaLaunchResponse('launch-switch', 'abc12345')
        : { request: null, source: 'luna-negra', serverNowMs: Date.now() };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await addStoredLunaIdentity(page);

    await page.goto('/');
    await expect.poll(() => appMode(page)).toBe('menu');
    await action(page, 'online-create-private').click();
    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.id)).toBe('ROOM');

    launchEnabled = true;

    await expect(page.getByRole('heading', { name: 'Te invitaron a ABC12345' })).toBeVisible({ timeout: 7000 });
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.id)).toBe('ROOM');

    await page.getByRole('button', { name: 'Unirme' }).click();

    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.id)).toBe('ABC12345');
    await expect(page.getByText('SALA PRIVADA ABC12345')).toBeVisible();
  });

  test('keeps the current room after declining a Luna Negra launch request', async ({ page }) => {
    await mockOnlineApi(page);
    let launchEnabled = false;
    await page.route('**/api/luna-negra/launch-request**', async (route) => {
      const body = launchEnabled
        ? lunaLaunchResponse('launch-decline', 'abc12345')
        : { request: null, source: 'luna-negra', serverNowMs: Date.now() };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await addStoredLunaIdentity(page);

    await page.goto('/');
    await expect.poll(() => appMode(page)).toBe('menu');
    await action(page, 'online-create-private').click();
    await expect.poll(() => appMode(page)).toBe('roomLobby');

    launchEnabled = true;
    await expect(page.getByRole('heading', { name: 'Te invitaron a ABC12345' })).toBeVisible({ timeout: 7000 });
    await page.getByRole('button', { name: 'Quedarme' }).click();

    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.id)).toBe('ROOM');
    await expect(page.getByRole('heading', { name: 'Te invitaron a ABC12345' })).toBeHidden();
    await page.waitForTimeout(2500);
    await expect(page.getByRole('heading', { name: 'Te invitaron a ABC12345' })).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.id)).toBe('ROOM');
  });

  test('keeps the main menu after declining a Luna Negra launch request when offline', async ({ page }) => {
    await mockOnlineApi(page);
    let launchEnabled = false;
    await page.route('**/api/luna-negra/launch-request**', async (route) => {
      const body = launchEnabled
        ? lunaLaunchResponse('launch-decline-offline', 'abc12345')
        : { request: null, source: 'luna-negra', serverNowMs: Date.now() };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await addStoredLunaIdentity(page);

    await page.goto('/');
    await expect.poll(() => appMode(page)).toBe('menu');

    launchEnabled = true;
    await expect(page.getByRole('heading', { name: 'Te invitaron a ABC12345' })).toBeVisible({ timeout: 7000 });
    await page.getByRole('button', { name: 'Quedarme' }).click();

    await expect(page.getByRole('heading', { name: 'Te invitaron a ABC12345' })).toBeHidden();
    await page.waitForTimeout(2500);
    await expect(page.getByRole('heading', { name: 'Te invitaron a ABC12345' })).toBeHidden();
    await expect.poll(() => appMode(page)).toBe('menu');
  });

  test('changes custom room visibility from the lobby', async ({ page }) => {
    const requests = await mockOnlineApi(page);
    await openFreshApp(page);

    await action(page, 'online-create-private').click();
    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.id)).toBe('ROOM');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.visibility)).toBe('private');

    await page.locator('[data-ui-action="online-room-visibility"][data-visibility="public"]').click();

    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.visibility)).toBe('public');
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.rules.gravityCellsPerFrame)).toBe(0.02);
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.id)).toBe('ROOM');
    expect(requests.lastCreate?.mode).toBe('custom');
    expect(requests.lastCreate?.matchType).toBe('custom');
    expect(requests.lastSettings?.visibility).toBe('public');
    expect(requests.lastSettings?.matchType).toBe('custom');
    expect(requests.lastSettings?.rules?.targetLines).toBeNull();

    await page.locator('[data-ui-action="online-room-visibility"][data-visibility="private"]').click();
    await expect.poll(() => page.evaluate(() => window.stack40.getOnlineRoom()?.visibility)).toBe('private');
    expect(requests.lastSettings?.visibility).toBe('private');
  });

  test('blocks solo mode while other players are in the current room', async ({ page }) => {
    await mockOnlineApi(page, { createdLobbyGuestRoom: true });
    await openFreshApp(page);

    await action(page, 'online-create-private').click();
    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await action(page, 'main-menu').click();
    await expect.poll(() => appMode(page)).toBe('menu');

    await action(page, 'solo-menu').click();
    await action(page, 'start').click();

    await expect.poll(() => appMode(page)).toBe('soloMenu');
    await expect(page.getByText('No podés jugar modo solo mientras hay otras personas en la sala.')).toBeVisible();
  });

  test('allows solo mode while the current room only has this player', async ({ page }) => {
    await mockOnlineApi(page);
    await openFreshApp(page);

    await action(page, 'online-create-private').click();
    await expect.poll(() => appMode(page)).toBe('roomLobby');
    await action(page, 'main-menu').click();
    await action(page, 'solo-menu').click();
    await action(page, 'start').click();

    await expect.poll(() => appMode(page)).toBe('playing');
  });
});

async function addStoredLunaIdentity(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem('stack40.lunaIdentity.v1', JSON.stringify({
      npub: 'npub-already-open',
      pubkey: 'pubkey-already-open',
      name: 'Already Open',
      avatarUrl: null,
      gameId: 'tetra-game',
    }));
  });
}

function lunaLaunchResponse(id: string, roomId: string): unknown {
  return {
    request: {
      id,
      roomId,
      inviteToken: 'fake-invite-token',
      slug: 'TETRA',
      title: 'TETRA',
      gameUrl: 'http://127.0.0.1:5173/',
    },
    source: 'luna-negra',
    serverNowMs: Date.now(),
  };
}

async function mockOnlineApi(page: Page, options: MockOnlineApiOptions = {}): Promise<MockOnlineApiRequests> {
  const now = Date.now();
  const requests: MockOnlineApiRequests = {
    lastCreate: null,
    lastSettings: null,
    restartCount: 0,
    restartOnNextState: false,
    healthCount: 0,
    betRefreshCount: 0,
  };
  let room = createMockRoom('ROOM', 'private', now);
  const publicRoom = createMockRoom('PUB1', 'public', now);

  await page.route('**/api/health', async (route) => {
    requests.healthCount += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/api/bets/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/create')) {
      room = { ...room, bet: createMockBet(room, Date.now()) };
      await fulfillRoom(route, room);
      return;
    }
    if (path.endsWith('/refresh')) {
      requests.betRefreshCount += 1;
      if (options.failBetRefresh) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Luna refresh timeout' }),
        });
        return;
      }
      await fulfillRoom(route, room);
      return;
    }
    if (path.endsWith('/cancel')) {
      room = { ...room, bet: null };
      await fulfillRoom(route, room);
      return;
    }
    if (path.endsWith('/settle')) {
      room = room.bet ? { ...room, bet: { ...room.bet, status: 'settled' } } : room;
      await fulfillRoom(route, room);
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not mocked.' }) });
  });

  await page.route('**/api/rooms/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/luna-negra/enter')) {
      const body = route.request().postDataJSON() as { roomId: string };
      const serverNowMs = Date.now();
      const player = {
        id: 'pubkey-host-luna',
        npub: 'npub-host-luna',
        pubkey: 'pubkey-host-luna',
        name: 'Nostr Host',
        displayName: 'Nostr Host',
        avatarUrl: 'https://example.com/nostr-host.png',
        host: true,
        hostPubkey: 'pubkey-host-luna',
        expiresAt: '2026-06-06T21:00:00.000Z',
      };
      let lunaRoom = {
        ...createMockRoom(body.roomId.toUpperCase(), 'private', serverNowMs, player.id, player.name, undefined, undefined, undefined, player.avatarUrl),
        lunaGameId: 'tetra-game',
      };
      const host = { ...lunaRoom.players[0], npub: player.npub };
      const players = options.lunaBetRoom
        ? [host, { ...createMockPlayer('pubkey-guest-luna', 'Nostr Guest', serverNowMs), npub: 'npub-guest-luna' }]
        : [host];
      lunaRoom = {
        ...lunaRoom,
        players,
      };
      room = {
        ...lunaRoom,
        bet: options.lunaBetRoom ? createMockBet(lunaRoom, serverNowMs) : null,
      };
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ room, player, serverNowMs }),
      });
      return;
    }
    if (path.endsWith('/public')) {
      const publicRooms = [publicRoom, room]
        .filter((candidate) => candidate.visibility === 'public')
        .filter((candidate, index, all) => all.findIndex((other) => other.id === candidate.id) === index);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          rooms: publicRooms.map((candidate) => ({
            id: candidate.id,
            hostName: candidate.players[0]?.name ?? 'Host',
            hostAvatarUrl: candidate.players[0]?.avatarUrl ?? null,
            playerCount: candidate.players.length,
            mode: candidate.mode,
            matchType: candidate.matchType,
            region: candidate.region,
            customPreset: candidate.ruleset.rulesetId,
            ruleset: candidate.ruleset,
            status: candidate.status,
            createdAtServerMs: candidate.createdAtServerMs,
          })),
          serverNowMs: Date.now(),
        }),
      });
      return;
    }
    if (path.endsWith('/create')) {
      const body = route.request().postDataJSON() as MockCreateRequest;
      requests.lastCreate = body;
      room = createMockRoom('ROOM', body.visibility, Date.now(), body.playerId, body.name, body.mode, body.rules, body.matchType, body.avatarUrl ?? null);
      if (options.createdLobbyGuestRoom) {
        room = {
          ...room,
          players: [
            room.players[0],
            createMockPlayer('player-lobby-guest', 'Guest', Date.now()),
          ],
        };
      }
      if (options.createdPlayingGuestRoom) room = createMockPlayingGuestRoom(room, Date.now());
      if (options.finishedCreatedRoom) room = createMockFinishedRoom(room, Date.now());
      await fulfillRoom(route, room);
      return;
    }
    if (path.endsWith('/join')) {
      const body = route.request().postDataJSON() as { playerId: string; name: string; avatarUrl?: string | null };
      room = {
        ...publicRoom,
        players: [{ ...publicRoom.players[0] }, createMockPlayer(body.playerId, body.name, Date.now(), body.avatarUrl ?? null)],
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
      if (options.largePlayingRoom) {
        room = createMockLargePlayingRoom(room, Date.now());
        await fulfillRoom(route, room);
        return;
      }
      room = {
        ...room,
        status: 'countdown',
        startsAtServerMs: Date.now() + 5000,
      };
      await fulfillRoom(route, room);
      return;
    }
    if (path.endsWith('/restart')) {
      requests.restartCount += 1;
      room = restartMockRoom(room, Date.now());
      await fulfillRoom(route, room);
      return;
    }
    if (path.endsWith('/settings')) {
      const body = route.request().postDataJSON() as UpdateRoomSettingsRequest;
      requests.lastSettings = body;
      room = {
        ...room,
        visibility: body.visibility ?? room.visibility,
        mode: 'custom',
        matchType: 'custom',
        ruleset: defaultMockRuleset(),
        rules: normalizeMockRulesForMatchType(body.rules ?? BATTLE_RULES),
        updatedAtServerMs: Date.now(),
        players: room.players.map((player) => ({ ...player, ready: false, status: 'joined' })),
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
      if (requests.restartOnNextState) {
        requests.restartOnNextState = false;
        room = restartMockRoom(room, Date.now(), true);
      }
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

type MockOnlineApiOptions = {
  largePlayingRoom?: boolean;
  finishedCreatedRoom?: boolean;
  createdPlayingGuestRoom?: boolean;
  createdLobbyGuestRoom?: boolean;
  lunaBetRoom?: boolean;
  failBetRefresh?: boolean;
};

type MockOnlineApiRequests = {
  lastCreate: MockCreateRequest | null;
  lastSettings: UpdateRoomSettingsRequest | null;
  restartCount: number;
  restartOnNextState: boolean;
  healthCount: number;
  betRefreshCount: number;
};

function createMockRoom(
  id: string,
  visibility: 'public' | 'private',
  now: number,
  playerId = 'player-host-mock',
  name = 'Host',
  mode: OnlineRoomMode = 'custom',
  rules: GameRules = BATTLE_RULES,
  matchType: OnlineMatchType = 'custom',
  avatarUrl: string | null = null,
): MockRoom {
  const normalizedRules = normalizeMockRulesForMatchType(rules);
  return {
    id,
    visibility,
    mode,
    matchType,
    region: 'gru1',
    ruleset: defaultMockRuleset(),
    rules: normalizedRules,
    status: 'lobby',
    hostPlayerId: playerId,
    createdAtServerMs: now,
    updatedAtServerMs: now,
    startsAtServerMs: null,
    seed: 12345,
    winnerPlayerId: null,
    matchResultId: null,
    players: [createMockPlayer(playerId, name, now, avatarUrl)],
    peerSignals: [],
    attacks: [],
    bet: null,
    lunaGameId: null,
  };
}

function createMockBet(room: MockRoom, now: number): RoomBet {
  const participants = room.players
    .filter((player) => player.npub)
    .map((player) => ({
      npub: player.npub ?? '',
      playerId: player.id,
      depositStatus: 'pending' as const,
      bolt11: `lnbc${player.id}`,
      lnurl: null,
      payUrl: `https://pay.example/${player.id}`,
      payoutSats: null,
    }));
  const stakeSats = 10;
  const potTargetSats = stakeSats * participants.length;
  const feeSats = Math.floor(potTargetSats * 0.05);
  return {
    betId: 'bet-mock',
    status: 'pending_deposits',
    stakeSats,
    potSats: 0,
    potTargetSats,
    feeSats,
    feePct: 5,
    netPayoutSats: potTargetSats - feeSats,
    depositDeadline: null,
    depositsReceived: 0,
    depositsTotal: participants.length,
    participants,
    winnerNpubs: null,
    resultReported: false,
    settlementError: null,
    createdByPlayerId: room.hostPlayerId,
    createdAtServerMs: now,
    updatedAtServerMs: now,
  };
}

function createMockLargePlayingRoom(room: MockRoom, now: number): MockRoom {
  const host = {
    ...room.players[0],
    ready: true,
    status: 'playing',
    game: createMockGameSnapshot(0),
  };
  const opponents = Array.from({ length: 7 }, (_, index) => ({
    ...createMockPlayer(`player-opponent-${index + 1}`, `P${index + 2}`, now),
    ready: true,
    status: 'playing',
    lines: index * 2,
    pieces: 20 + index * 4,
    elapsedFrames: 600 + index * 60,
    sentGarbage: index,
    game: createMockGameSnapshot(index + 1),
  }));
  return {
    ...room,
    status: 'playing',
    startsAtServerMs: now - 1,
    updatedAtServerMs: now,
    players: [host, ...opponents],
  };
}

function createMockPlayingGuestRoom(room: MockRoom, now: number): MockRoom {
  const guest = {
    ...room.players[0],
    ready: true,
    status: 'playing',
    game: createMockGameSnapshot(0),
  };
  const host = {
    ...createMockPlayer('player-host-authority', 'Host Authority', now),
    ready: true,
    status: 'playing',
    game: createMockGameSnapshot(1),
  };
  return {
    ...room,
    status: 'playing',
    hostPlayerId: host.id,
    startsAtServerMs: now - 1,
    updatedAtServerMs: now,
    players: [host, guest],
  };
}

function createMockFinishedRoom(room: MockRoom, now: number): MockRoom {
  return {
    ...room,
    status: 'finished',
    startsAtServerMs: null,
    updatedAtServerMs: now,
    winnerPlayerId: room.hostPlayerId,
    matchResultId: `${room.id}-${now}`,
    players: room.players.map((player) => ({
      ...player,
      ready: true,
      status: player.id === room.hostPlayerId ? 'winner' : 'eliminated',
      lines: player.id === room.hostPlayerId ? 12 : 8,
      pieces: player.id === room.hostPlayerId ? 40 : 38,
      elapsedFrames: player.id === room.hostPlayerId ? 900 : 840,
      alive: player.id === room.hostPlayerId,
      updatedAtServerMs: now,
      finishedAtServerMs: now,
      eliminatedAtFrame: player.id === room.hostPlayerId ? null : 840,
      eliminatedAtServerMs: player.id === room.hostPlayerId ? null : now,
      game: createMockGameSnapshot(0),
    })),
  };
}

function restartMockRoom(room: MockRoom, now: number, startImmediately = false): MockRoom {
  return {
    ...room,
    status: 'countdown',
    startsAtServerMs: startImmediately ? now - 1 : now + 5000,
    updatedAtServerMs: now,
    seed: room.seed + 1,
    winnerPlayerId: null,
    matchResultId: null,
    attacks: [],
    players: room.players.map((player) => ({
      ...player,
      ready: true,
      status: 'ready',
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
      currentTargetPlayerId: null,
      recentAttackers: [],
      receivedGarbageThisRound: 0,
      dangerLevel: 0,
    })),
  };
}

function createMockGameSnapshot(seedOffset: number): OnlineGameSnapshot {
  const pieces: PieceType[] = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
  const board: Cell[][] = Array.from({ length: BATTLE_RULES.visibleRows }, (_, y) => (
    Array.from({ length: BATTLE_RULES.boardWidth }, (_, x) => {
      const stackHeight = 2 + ((x + seedOffset) % 5);
      if (y < BATTLE_RULES.visibleRows - stackHeight) return null;
      return pieces[(x + y + seedOffset) % pieces.length];
    })
  ));
  return {
    board,
    active: null,
    visibleRows: BATTLE_RULES.visibleRows,
    boardWidth: BATTLE_RULES.boardWidth,
    elapsedFrames: 600 + seedOffset * 60,
    status: 'playing',
    lines: seedOffset * 2,
    pieces: 20 + seedOffset * 3,
    sentGarbage: seedOffset,
    receivedGarbage: Math.max(0, seedOffset - 1),
    pendingGarbage: seedOffset % 3,
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
  matchResultId: string | null;
  players: MockPlayer[];
  peerSignals: unknown[];
  attacks: unknown[];
  bet: RoomBet | null;
  lunaGameId: string | null;
};

function createMockPlayer(id: string, name: string, now: number, avatarUrl: string | null = null): MockPlayer {
  return {
    id,
    npub: null,
    name,
    avatarUrl,
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

type MockPlayer = {
  id: string;
  npub: string | null;
  name: string;
  avatarUrl: string | null;
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
  game: OnlineGameSnapshot | null;
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
  avatarUrl?: string | null;
  visibility: 'public' | 'private';
  mode: OnlineRoomMode;
  matchType?: OnlineMatchType;
  ruleset?: Partial<OnlineRuleset>;
  rules?: GameRules;
};

function defaultMockRuleset(): OnlineRuleset {
  return {
    rulesetId: 'custom-survival-simple',
    rulesetVersion: 1,
    objective: { type: 'lastStanding' },
    attackTable: 'simple',
    targeting: 'random',
  };
}

function normalizeMockRulesForMatchType(rules: GameRules): GameRules {
  return {
    ...rules,
    targetLines: null,
  };
}
