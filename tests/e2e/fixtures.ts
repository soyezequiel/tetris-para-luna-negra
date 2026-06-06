import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { createExportedReplay } from '../../src/app/replayExport';
import type { CustomSettings } from '../../src/app/customSettings';
import { GameEngine } from '../../src/game/engine';
import { createReplayLog, recordInput } from '../../src/game/replay';
import { DEFAULT_RULES } from '../../src/game/rules';
import type { GameInput, GameState } from '../../src/game/types';
import { DEFAULT_INPUT_SETTINGS, type InputSettings } from '../../src/input/settings';
import type { OnlineRoom } from '../../src/online/protocol';

export type AppMode =
  | 'menu'
  | 'soloMenu'
  | 'multiplayerMenu'
  | 'historyMenu'
  | 'configMenu'
  | 'custom'
  | 'playing'
  | 'paused'
  | 'settings'
  | 'library'
  | 'replayPlayback'
  | 'onlineMenu'
  | 'roomLobby'
  | 'onlineCountdown'
  | 'onlinePlaying'
  | 'onlineResults';

export type PlaybackSnapshot = {
  frame: number;
  targetFrame: number;
  paused: boolean;
  speed: number;
  done: boolean;
  validation: string;
};

export type Stack40Api = {
  getState: () => GameState;
  getAppMode: () => AppMode;
  getCustomSettings: () => CustomSettings;
  getInputSettings: () => InputSettings;
  getReplay: () => { seed: number; inputs: GameInput[] };
  getTouchControlsHidden: () => boolean;
  getPlayback: () => PlaybackSnapshot | null;
  getOnlineRoom: () => OnlineRoom | null;
  getOnlinePlayer: () => { id: string; name: string };
};

declare global {
  interface Window {
    stack40: Stack40Api;
  }
}

export async function openFreshApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'STACK/40' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.stack40.getAppMode())).toBe('menu');
}

export function action(page: Page, uiAction: string) {
  return page.locator(`[data-ui-action="${uiAction}"]`);
}

export async function appMode(page: Page): Promise<AppMode> {
  return page.evaluate(() => window.stack40.getAppMode());
}

export async function writeReplayFixture(name: string): Promise<string> {
  const outputDir = path.resolve('.codex-output', 'e2e-replays');
  await mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, name);
  await writeFile(filePath, JSON.stringify(createReplayFixture(), null, 2), 'utf8');
  return filePath;
}

function createReplayFixture() {
  const seed = 20260604;
  const inputs: GameInput[] = [{ frame: 1, action: 'hardDrop' }];
  const targetFrame = 600;
  const engine = new GameEngine(seed, DEFAULT_RULES);
  const log = createReplayLog(seed, DEFAULT_RULES);
  let state = engine.getState();

  for (let frame = 1; frame <= targetFrame; frame += 1) {
    const frameInputs = inputs.filter((input) => input.frame === frame);
    for (const input of frameInputs) recordInput(log, input);
    state = engine.tick(frame, frameInputs);
  }

  return createExportedReplay(log, state, DEFAULT_INPUT_SETTINGS, '2026-06-04T21:00:00.000Z');
}
