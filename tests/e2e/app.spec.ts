import { expect, test } from '@playwright/test';
import { action, appMode, openFreshApp, writeReplayFixture } from './fixtures';

test.describe('STACK/40 browser flows', () => {
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
});
