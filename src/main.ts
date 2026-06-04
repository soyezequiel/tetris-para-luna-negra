import './styles.css';
import { createExportedReplay, replayFileName } from './app/replayExport';
import { canAdvanceGame, terminalLabel, togglePauseMode, type AppMode } from './app/state';
import { MUSIC_TRACKS } from './audio/music';
import { SoundEngine, type VolumeChannel } from './audio/SoundEngine';
import { GameEngine } from './game/engine';
import { createReplayLog, recordInput } from './game/replay';
import { DEFAULT_RULES } from './game/rules';
import { displayedElapsedFrames } from './game/timing';
import type { GameInput, GameRules, GameState, InputAction } from './game/types';
import { InputController, type ControlInput } from './input';
import {
  CONTROL_ACTION_LABELS,
  CONTROL_ACTIONS,
  cloneInputSettings,
  isGameAction,
  keyLabel,
  loadInputSettings,
  resetInputSettings,
  saveInputSettings,
  type ControlAction,
  type InputSettings,
  updateBinding,
  updateInputTiming,
} from './input/settings';
import { loadRecord, saveAudioVolumes, saveBest40LineFrames, saveSoundMuted } from './storage';
import { PixiGameRenderer } from './renderer/PixiGameRenderer';

const root = document.getElementById('game-root');
const overlay = document.getElementById('hud-overlay');

if (!root || !overlay) throw new Error('Missing application root.');

const overlayElement = overlay;
const VOLUME_WHEEL_STEP = 0.05;

let inputSettings = loadInputSettings();
let gameRules = rulesFromSettings(inputSettings);
let seed = randomSeed();
let engine = new GameEngine(seed, gameRules);
let replay = createReplayLog(seed, gameRules);
const input = new InputController(inputSettings);
const renderer = new PixiGameRenderer(root);
const sound = new SoundEngine(loadRecord().soundMuted, MUSIC_TRACKS, loadRecord().sfxVolume, loadRecord().musicVolume);

let best = loadRecord();
let appMode: AppMode = 'menu';
let settingsReturnMode: AppMode = 'menu';
let gameFrame = 0;
let savedFinish = false;
let lastPieces = 0;
let lastLines = 0;
let lastStatus = engine.getState().status;
let volumeFeedback: { channel: VolumeChannel; expiresAt: number } | null = null;
let bindingCapture: ControlAction | null = null;
let lastExportName: string | null = null;
let lastOverlayHtml = '';

window.addEventListener('keydown', handleGlobalKeyDown, { capture: true });
window.addEventListener('wheel', handleVolumeWheel, { passive: false });
overlayElement.addEventListener('click', handleOverlayClick);

function loop(): void {
  const beforeState = engine.getState();
  const candidateFrame = canAdvanceGame(appMode, beforeState.status) ? gameFrame + 1 : gameFrame;
  input.advanceFrame(candidateFrame);
  const controlInputs = input.collect(candidateFrame);
  const consumedByApp = handleControlInputs(controlInputs);

  let state = engine.getState();
  if (!consumedByApp && canAdvanceGame(appMode, state.status)) {
    gameFrame = candidateFrame;
    const beforeTickState = engine.getState();
    const gameInputs = toGameInputs(controlInputs, gameFrame);
    playImmediateInputSounds(gameInputs.map((event) => event.action));
    for (const event of gameInputs) recordInput(replay, event);
    state = engine.tick(gameFrame, gameInputs);
    playAcceptedMoveSound(beforeTickState.active, state.active, gameInputs.map((event) => event.action));
    syncRunEffects(state);
  }

  renderer.render(state);
  renderOverlay(state);
  requestAnimationFrame(loop);
}

loop();

Object.assign(window, {
  stack40: {
    getState: () => engine.getState(),
    getReplay: () => replay,
    getAppMode: () => appMode,
    getInputSettings: () => cloneInputSettings(inputSettings),
    isSoundMuted: () => sound.isMuted(),
    toggleSound: () => {
      best = saveSoundMuted(sound.toggleMuted());
      return sound.isMuted();
    },
    getCurrentMusicTrack: () => sound.getCurrentMusicTrack(),
    nextMusicTrack: () => sound.nextMusicTrack(),
    getAudioVolumes: () => ({
      sfx: sound.getSfxVolume(),
      music: sound.getMusicVolume(),
    }),
    setAudioVolume: (channel: VolumeChannel, volume: number) => {
      const nextVolume = sound.setVolume(channel, volume);
      best = saveAudioVolumes(sound.getSfxVolume(), sound.getMusicVolume());
      return nextVolume;
    },
    startNewRun,
    exportReplay,
  },
});

function handleGlobalKeyDown(event: KeyboardEvent): void {
  if (bindingCapture) {
    applyInputSettings(updateBinding(inputSettings, bindingCapture, event.code));
    bindingCapture = null;
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }

  if (event.repeat) return;
  if (event.code === 'KeyM') {
    event.preventDefault();
    best = saveSoundMuted(sound.toggleMuted());
  }
  if (event.code === 'KeyN') {
    event.preventDefault();
    sound.nextMusicTrack();
  }
}

function handleOverlayClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const control = target.closest<HTMLElement>('[data-ui-action]');
  if (!control) return;

  const action = control.dataset.uiAction;
  if (action === 'start' || action === 'restart') startNewRun();
  if (action === 'resume') resumeGame();
  if (action === 'settings') openSettings();
  if (action === 'settings-back') closeSettings();
  if (action === 'settings-reset') applyInputSettings(resetInputSettings());
  if (action === 'export-replay') exportReplay();
  if (action === 'main-menu') goToMenu();
  if (action === 'toggle-sound') best = saveSoundMuted(sound.toggleMuted());
  if (action === 'next-music') sound.nextMusicTrack();
  if (action === 'capture-binding') {
    const controlAction = parseControlAction(control.dataset.controlAction);
    if (controlAction) bindingCapture = controlAction;
  }
  if (action === 'timing') {
    const setting = control.dataset.setting === 'arrFrames' ? 'arrFrames' : 'dasFrames';
    const delta = Number(control.dataset.delta ?? 0);
    applyInputSettings(updateInputTiming(inputSettings, setting, delta));
  }
}

function handleControlInputs(inputs: ControlInput[]): boolean {
  if (inputs.some((event) => event.action === 'pause')) {
    appMode = togglePauseMode(appMode, engine.getState().status, settingsReturnMode);
    input.releaseAll();
    return true;
  }

  if (appMode !== 'settings' && inputs.some((event) => event.action === 'retry')) {
    startNewRun();
    return true;
  }

  return false;
}

function startNewRun(): void {
  input.releaseAll();
  bindingCapture = null;
  lastExportName = null;
  gameRules = rulesFromSettings(inputSettings);
  seed = randomSeed();
  engine = new GameEngine(seed, gameRules);
  replay = createReplayLog(seed, gameRules);
  gameFrame = 0;
  savedFinish = false;
  lastPieces = 0;
  lastLines = 0;
  lastStatus = engine.getState().status;
  appMode = 'playing';
  settingsReturnMode = 'menu';
  sound.play('retry');
}

function resumeGame(): void {
  if (engine.getState().status !== 'playing') return;
  bindingCapture = null;
  appMode = 'playing';
  input.releaseAll();
}

function openSettings(): void {
  bindingCapture = null;
  settingsReturnMode = appMode === 'playing' && engine.getState().status === 'playing' ? 'paused' : appMode;
  if (appMode === 'playing' && engine.getState().status === 'playing') appMode = 'paused';
  appMode = 'settings';
  input.releaseAll();
}

function closeSettings(): void {
  bindingCapture = null;
  appMode = settingsReturnMode;
  input.releaseAll();
}

function goToMenu(): void {
  bindingCapture = null;
  appMode = 'menu';
  settingsReturnMode = 'menu';
  input.releaseAll();
}

function applyInputSettings(settings: InputSettings): void {
  bindingCapture = null;
  inputSettings = saveInputSettings(settings);
  input.updateSettings(inputSettings);
}

function exportReplay(): void {
  const exported = createExportedReplay(replay, engine.getState(), inputSettings);
  const fileName = replayFileName(exported);
  const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  lastExportName = fileName;
}

function toGameInputs(inputs: ControlInput[], frame: number): GameInput[] {
  return inputs
    .filter((event): event is ControlInput & { action: InputAction } => isGameAction(event.action) && event.action !== 'retry')
    .map((event) => ({ frame, action: event.action }));
}

function syncRunEffects(state: GameState): void {
  if (state.stats.lines > lastLines) sound.play('lineClear');
  else if (state.stats.pieces > lastPieces) sound.play('lock');
  if (state.status !== lastStatus) {
    if (state.status === 'finished') sound.play('finish');
    if (state.status === 'gameover') sound.play('gameOver');
  }
  lastPieces = state.stats.pieces;
  lastLines = state.stats.lines;
  lastStatus = state.status;
  if (state.status === 'finished' && state.stats.finishFrame !== null && !savedFinish) {
    best = saveBest40LineFrames(state.stats.finishFrame);
    savedFinish = true;
  }
}

function renderOverlay(state: GameState): void {
  const currentMusicTrack = sound.getCurrentMusicTrack()?.title ?? 'No music';
  const activeVolumeChannel = getActiveVolumeChannel();
  const html = `
    <div class="brand">STACK/40</div>
    <div class="help">${escapeHtml(helpText())}</div>
    <div class="best">Best ${best.best40LineFrames === null ? '--:--.---' : formatFrames(best.best40LineFrames)}</div>
    <div class="audio-panel">
      <button class="hud-action sound" type="button" data-ui-action="toggle-sound">${sound.isMuted() ? 'Sound off' : 'Sound on'}</button>
      <div class="volume-control ${activeVolumeChannel === 'sfx' ? 'volume-control-active' : ''}" data-volume-channel="sfx">
        <span>SFX</span>
        <span>${formatPercent(sound.getSfxVolume())}%</span>
      </div>
      <div class="volume-control ${activeVolumeChannel === 'music' ? 'volume-control-active' : ''}" data-volume-channel="music">
        <span>BGM</span>
        <span>${formatPercent(sound.getMusicVolume())}%</span>
      </div>
      <button class="hud-action music" type="button" data-ui-action="next-music">${escapeHtml(sound.isMuted() || sound.getMusicVolume() === 0 ? 'Music paused' : currentMusicTrack)}</button>
    </div>
    ${renderScreenOverlay(state)}
  `;
  if (html !== lastOverlayHtml) {
    overlayElement.innerHTML = html;
    lastOverlayHtml = html;
  }
}

function renderScreenOverlay(state: GameState): string {
  if (appMode === 'settings') return renderSettingsOverlay();
  if (appMode === 'menu') {
    return renderPanel({
      eyebrow: '40 LINES',
      title: 'STACK/40',
      meta: `${formatActionBinding('pause')} pause - ${formatActionBinding('hardDrop')} hard drop`,
      actions: [
        ['start', 'Start run'],
        ['settings', 'Input settings'],
      ],
    });
  }
  if (appMode === 'paused') {
    return renderPanel({
      eyebrow: 'PAUSED',
      title: formatRunSummary(state),
      meta: 'Run is frozen. Resume keeps the exact board and timer.',
      actions: [
        ['resume', 'Resume'],
        ['restart', 'Restart'],
        ['settings', 'Input settings'],
        ['export-replay', 'Export replay'],
        ['main-menu', 'Main menu'],
      ],
    });
  }

  const terminal = terminalLabel(state.status);
  if (!terminal) return '';
  return renderPanel({
    eyebrow: terminal,
    title: formatRunSummary(state),
    meta: state.status === 'finished' ? 'Saved if this beats your local best.' : 'The stack topped out.',
    actions: [
      ['restart', 'Restart'],
      ['export-replay', 'Export replay'],
      ['settings', 'Input settings'],
      ['main-menu', 'Main menu'],
    ],
  });
}

function renderSettingsOverlay(): string {
  const captureText = bindingCapture ? `Press a key for ${CONTROL_ACTION_LABELS[bindingCapture]}` : 'Input settings';
  const bindingRows = CONTROL_ACTIONS.map((action) => `
    <div class="binding-row">
      <span>${CONTROL_ACTION_LABELS[action]}</span>
      <button class="binding-button ${bindingCapture === action ? 'binding-button-active' : ''}" type="button" data-ui-action="capture-binding" data-control-action="${action}">
        ${bindingCapture === action ? 'Listening...' : escapeHtml(formatActionBinding(action))}
      </button>
    </div>
  `).join('');

  return `
    <div class="menu-scrim">
      <section class="menu-panel settings-panel" aria-label="Input settings">
        <div class="panel-eyebrow">${escapeHtml(captureText)}</div>
        <h1>Controls</h1>
        <div class="settings-grid">${bindingRows}</div>
        <div class="timing-panel">
          ${renderTimingControl('DAS', 'dasFrames', inputSettings.dasFrames)}
          ${renderTimingControl('ARR', 'arrFrames', inputSettings.arrFrames)}
        </div>
        <div class="panel-actions">
          <button type="button" data-ui-action="settings-back">Back</button>
          <button type="button" data-ui-action="settings-reset">Reset</button>
        </div>
      </section>
    </div>
  `;
}

function renderTimingControl(label: string, setting: 'dasFrames' | 'arrFrames', value: number): string {
  return `
    <div class="timing-row">
      <span>${label}</span>
      <button type="button" data-ui-action="timing" data-setting="${setting}" data-delta="-1">-</button>
      <strong>${value}f</strong>
      <button type="button" data-ui-action="timing" data-setting="${setting}" data-delta="1">+</button>
    </div>
  `;
}

function renderPanel(options: {
  eyebrow: string;
  title: string;
  meta: string;
  actions: [string, string][];
}): string {
  const exported = lastExportName ? `<div class="panel-note">Exported ${escapeHtml(lastExportName)}</div>` : '';
  const actions = options.actions.map(([action, label]) => (
    `<button type="button" data-ui-action="${action}">${label}</button>`
  )).join('');
  return `
    <div class="menu-scrim">
      <section class="menu-panel" aria-label="${escapeHtml(options.eyebrow)}">
        <div class="panel-eyebrow">${escapeHtml(options.eyebrow)}</div>
        <h1>${escapeHtml(options.title)}</h1>
        <p>${escapeHtml(options.meta)}</p>
        ${exported}
        <div class="panel-actions">${actions}</div>
      </section>
    </div>
  `;
}

function helpText(): string {
  return `Move ${formatActionBinding('moveLeft')}/${formatActionBinding('moveRight')} - Rotate ${formatActionBinding('rotateCW')}/${formatActionBinding('rotateCCW')} - Drop ${formatActionBinding('softDrop')}/${formatActionBinding('hardDrop')} - Hold ${formatActionBinding('hold')} - Pause ${formatActionBinding('pause')} - Retry ${formatActionBinding('retry')} - M sound - N music`;
}

function formatActionBinding(action: ControlAction): string {
  const bindings = inputSettings.bindings[action];
  return bindings.length > 0 ? bindings.map(keyLabel).join('/') : 'Unbound';
}

function formatRunSummary(state: GameState): string {
  const elapsedFrames = displayedElapsedFrames(state.stats);
  return `${state.stats.lines}/40 - ${formatFrames(elapsedFrames)} - ${state.stats.pieces} pieces`;
}

function handleVolumeWheel(event: WheelEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const control = target.closest<HTMLElement>('[data-volume-channel]');
  if (!control) return;
  const channel = control.dataset.volumeChannel === 'music' ? 'music' : 'sfx';
  const direction = event.deltaY < 0 ? 1 : -1;
  sound.adjustVolume(channel, direction * VOLUME_WHEEL_STEP);
  best = saveAudioVolumes(sound.getSfxVolume(), sound.getMusicVolume());
  volumeFeedback = { channel, expiresAt: performance.now() + 900 };
  event.preventDefault();
}

function getActiveVolumeChannel(): VolumeChannel | null {
  if (!volumeFeedback) return null;
  if (performance.now() > volumeFeedback.expiresAt) {
    volumeFeedback = null;
    return null;
  }
  return volumeFeedback.channel;
}

function playImmediateInputSounds(actions: InputAction[]): void {
  for (const action of actions) {
    if (action === 'rotateCW' || action === 'rotateCCW') sound.play('rotate');
    if (action === 'softDrop') sound.play('softDrop');
    if (action === 'hardDrop') sound.play('hardDrop');
    if (action === 'hold') sound.play('hold');
  }
}

function playAcceptedMoveSound(before: { type: string; x: number } | null, after: { type: string; x: number } | null, actions: InputAction[]): void {
  const requestedHorizontalMove = actions.some((action) => action === 'moveLeft' || action === 'moveRight');
  if (!requestedHorizontalMove || !before || !after) return;
  if (before.type === after.type && before.x !== after.x) sound.play('move');
}

function rulesFromSettings(settings: InputSettings): GameRules {
  return {
    ...DEFAULT_RULES,
    dasFrames: settings.dasFrames,
    arrFrames: settings.arrFrames,
  };
}

function parseControlAction(value: string | undefined): ControlAction | null {
  if (!value) return null;
  return CONTROL_ACTIONS.includes(value as ControlAction) ? value as ControlAction : null;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

function formatFrames(frames: number): string {
  const seconds = frames / 60;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  const millis = Math.floor((seconds % 1) * 1000).toString().padStart(3, '0');
  return `${minutes}:${secs}.${millis}`;
}

function formatPercent(volume: number): string {
  return Math.round(volume * 100).toString().padStart(3, ' ');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
