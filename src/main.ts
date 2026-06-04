import './styles.css';
import { importReplayJson } from './app/replayImport';
import { createExportedReplay, replayFileName, type ExportedReplay } from './app/replayExport';
import { ReplayPlayback, type PlaybackSpeed, type ReplayPlaybackSnapshot } from './app/replayPlayback';
import {
  clearRunHistory as clearStoredRunHistory,
  createRunHistoryEntry,
  deleteRunHistoryEntry,
  loadRunHistory,
  saveRunHistoryEntry,
  type RunHistoryEntry,
} from './app/runHistory';
import { canAdvanceGame, requiresRunConfirmation, terminalLabel, togglePauseMode, type AppMode, type DestructiveRunAction } from './app/state';
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
const REPLAY_SPEEDS: PlaybackSpeed[] = [1, 2, 4];
const LIBRARY_FILTERS = ['all', 'clear', 'topout', 'best'] as const;

type LibraryFilter = typeof LIBRARY_FILTERS[number];

let inputSettings = loadInputSettings();
let gameRules = rulesFromSettings(inputSettings);
let seed = randomSeed();
let engine = new GameEngine(seed, gameRules);
let replay = createReplayLog(seed, gameRules);
const input = new InputController(inputSettings);
const renderer = new PixiGameRenderer(root);
const sound = new SoundEngine(loadRecord().soundMuted, MUSIC_TRACKS, loadRecord().sfxVolume, loadRecord().musicVolume);

let best = loadRecord();
let runHistory = loadRunHistory();
let appMode: AppMode = 'menu';
let settingsReturnMode: AppMode = 'menu';
let gameFrame = 0;
let savedFinish = false;
let savedRunHistoryEntry = false;
let lastPieces = 0;
let lastLines = 0;
let lastStatus = engine.getState().status;
let volumeFeedback: { channel: VolumeChannel; expiresAt: number } | null = null;
let bindingCapture: ControlAction | null = null;
let lastExportName: string | null = null;
let lastOverlayHtml = '';
let playback: ReplayPlayback | null = null;
let importedReplayName: string | null = null;
let replayImportError: string | null = null;
let libraryFilter: LibraryFilter = 'all';
let selectedHistoryEntryId: string | null = null;
let libraryError: string | null = null;
let pendingConfirmAction: DestructiveRunAction | null = null;

const replayFileInput = document.createElement('input');
replayFileInput.type = 'file';
replayFileInput.accept = 'application/json,.json';
replayFileInput.hidden = true;
document.body.appendChild(replayFileInput);

window.addEventListener('keydown', handleGlobalKeyDown, { capture: true });
window.addEventListener('wheel', handleVolumeWheel, { passive: false });
replayFileInput.addEventListener('change', handleReplayFileChange);
overlayElement.addEventListener('click', handleOverlayClick);

function loop(): void {
  const beforeState = engine.getState();
  const candidateFrame = !pendingConfirmAction && canAdvanceGame(appMode, beforeState.status) ? gameFrame + 1 : gameFrame;
  input.advanceFrame(candidateFrame);
  const controlInputs = input.collect(candidateFrame);
  const consumedByApp = handleControlInputs(controlInputs);

  if (appMode === 'replayPlayback' && playback) {
    const snapshot = playback.tick();
    renderer.render(snapshot.state);
    renderOverlay(snapshot.state);
    requestAnimationFrame(loop);
    return;
  }

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
    getPlayback: () => playback?.snapshot() ?? null,
    getAppMode: () => appMode,
    getPendingConfirmAction: () => pendingConfirmAction,
    getInputSettings: () => cloneInputSettings(inputSettings),
    getRunHistory: () => runHistory,
    clearRunHistory: () => {
      clearStoredRunHistory();
      runHistory = [];
      selectedHistoryEntryId = null;
      return runHistory;
    },
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
    importReplayText,
  },
});

function handleGlobalKeyDown(event: KeyboardEvent): void {
  if (pendingConfirmAction && event.code === 'Escape') {
    cancelPendingConfirmation();
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }

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
  if (action === 'confirm-destructive') {
    confirmPendingAction();
    return;
  }
  if (action === 'cancel-confirm') {
    cancelPendingConfirmation();
    return;
  }
  if (pendingConfirmAction) return;
  if (requiresRunConfirmation(action, appMode, engine.getState().status)) {
    requestRunConfirmation(action);
    return;
  }

  if (action === 'start' || action === 'restart') startNewRun();
  if (action === 'resume') resumeGame();
  if (action === 'settings') openSettings();
  if (action === 'settings-back') closeSettings();
  if (action === 'settings-reset') applyInputSettings(resetInputSettings());
  if (action === 'export-replay') exportReplay();
  if (action === 'import-replay') openReplayFilePicker();
  if (action === 'replay-library' || action === 'run-history') openReplayLibrary();
  if (action === 'library-back' || action === 'history-back') goToMenu();
  if (action === 'library-filter') setLibraryFilter(control.dataset.filter);
  if (action === 'select-history-entry') selectHistoryEntry(control.dataset.historyId);
  if (action === 'clear-history') {
    clearStoredRunHistory();
    runHistory = [];
    selectedHistoryEntryId = null;
    libraryError = null;
  }
  if (action === 'play-history-replay') {
    const entry = findHistoryEntry(control.dataset.historyId);
    if (entry) startReplayPlayback(entry.replay, `History ${formatDateTime(entry.createdAt)}`);
    else libraryError = 'Replay entry was not found.';
  }
  if (action === 'export-history-replay') {
    const entry = findHistoryEntry(control.dataset.historyId);
    if (entry) {
      lastExportName = downloadReplayFile(entry.replay);
      libraryError = null;
    } else {
      libraryError = 'Replay entry was not found.';
    }
  }
  if (action === 'delete-history-entry') {
    const entry = findHistoryEntry(control.dataset.historyId);
    if (entry) {
      runHistory = deleteRunHistoryEntry(entry.id);
      selectedHistoryEntryId = selectedHistoryEntryId === entry.id ? null : selectedHistoryEntryId;
      syncLibrarySelection();
      libraryError = null;
      lastExportName = null;
    } else {
      libraryError = 'Replay entry was not found.';
    }
  }
  if (action === 'replay-toggle') playback?.togglePaused();
  if (action === 'replay-restart') playback?.restart();
  if (action === 'replay-exit') goToMenu();
  if (action === 'replay-speed') {
    const speed = Number(control.dataset.speed);
    if (REPLAY_SPEEDS.includes(speed as PlaybackSpeed)) playback?.setSpeed(speed as PlaybackSpeed);
  }
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
  if (pendingConfirmAction) {
    input.releaseAll();
    return true;
  }

  if (inputs.some((event) => event.action === 'pause')) {
    if (appMode === 'replayPlayback') {
      playback?.togglePaused();
      input.releaseAll();
      return true;
    }
    appMode = togglePauseMode(appMode, engine.getState().status, settingsReturnMode);
    input.releaseAll();
    return true;
  }

  if (appMode === 'replayPlayback' && inputs.some((event) => event.action === 'retry')) {
    playback?.restart();
    input.releaseAll();
    return true;
  }

  if (appMode !== 'settings' && inputs.some((event) => event.action === 'retry')) {
    if (requiresRunConfirmation('restart', appMode, engine.getState().status)) {
      requestRunConfirmation('restart');
      input.releaseAll();
      return true;
    }
    startNewRun();
    return true;
  }

  return false;
}

function startNewRun(): void {
  input.releaseAll();
  bindingCapture = null;
  pendingConfirmAction = null;
  lastExportName = null;
  replayImportError = null;
  libraryError = null;
  importedReplayName = null;
  playback = null;
  gameRules = rulesFromSettings(inputSettings);
  seed = randomSeed();
  engine = new GameEngine(seed, gameRules);
  replay = createReplayLog(seed, gameRules);
  gameFrame = 0;
  savedFinish = false;
  savedRunHistoryEntry = false;
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
  pendingConfirmAction = null;
  appMode = 'playing';
  input.releaseAll();
}

function openSettings(): void {
  bindingCapture = null;
  pendingConfirmAction = null;
  settingsReturnMode = appMode === 'playing' && engine.getState().status === 'playing' ? 'paused' : appMode;
  if (appMode === 'playing' && engine.getState().status === 'playing') appMode = 'paused';
  appMode = 'settings';
  input.releaseAll();
}

function closeSettings(): void {
  bindingCapture = null;
  pendingConfirmAction = null;
  appMode = settingsReturnMode;
  input.releaseAll();
}

function goToMenu(): void {
  bindingCapture = null;
  pendingConfirmAction = null;
  appMode = 'menu';
  settingsReturnMode = 'menu';
  playback = null;
  importedReplayName = null;
  libraryError = null;
  runHistory = loadRunHistory();
  input.releaseAll();
}

function openReplayLibrary(): void {
  bindingCapture = null;
  pendingConfirmAction = null;
  runHistory = loadRunHistory();
  appMode = 'library';
  settingsReturnMode = 'menu';
  libraryError = null;
  lastExportName = null;
  syncLibrarySelection();
  input.releaseAll();
}

function applyInputSettings(settings: InputSettings): void {
  bindingCapture = null;
  inputSettings = saveInputSettings(settings);
  input.updateSettings(inputSettings);
}

function exportReplay(): void {
  const exported = createExportedReplay(replay, engine.getState(), inputSettings);
  lastExportName = downloadReplayFile(exported);
}

function downloadReplayFile(exported: ExportedReplay): string {
  const fileName = replayFileName(exported);
  const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return fileName;
}

function openReplayFilePicker(): void {
  bindingCapture = null;
  pendingConfirmAction = null;
  replayFileInput.value = '';
  replayFileInput.click();
}

async function handleReplayFileChange(): Promise<void> {
  const file = replayFileInput.files?.[0];
  if (!file) return;
  try {
    importReplayText(await file.text(), file.name);
  } catch {
    replayImportError = 'Replay file could not be read.';
    appMode = 'menu';
  }
}

function importReplayText(raw: string, fileName = 'Imported replay.json'): boolean {
  const result = importReplayJson(raw);
  if (!result.ok) {
    replayImportError = result.error;
    appMode = 'menu';
    return false;
  }
  startReplayPlayback(result.replay, fileName);
  return true;
}

function startReplayPlayback(importedReplay: ExportedReplay, fileName: string): void {
  input.releaseAll();
  bindingCapture = null;
  pendingConfirmAction = null;
  lastExportName = null;
  replayImportError = null;
  importedReplayName = fileName;
  playback = new ReplayPlayback(importedReplay);
  appMode = 'replayPlayback';
  settingsReturnMode = 'menu';
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
  if ((state.status === 'finished' || state.status === 'gameover') && !savedRunHistoryEntry) {
    const entry = createRunHistoryEntry(createExportedReplay(replay, state, inputSettings));
    if (entry) runHistory = saveRunHistoryEntry(entry);
    savedRunHistoryEntry = true;
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
  if (appMode === 'replayPlayback' && playback) updateReplayOverlay(playback.snapshot());
}

function renderScreenOverlay(state: GameState): string {
  if (pendingConfirmAction) return renderConfirmOverlay(pendingConfirmAction);
  if (appMode === 'replayPlayback') return renderReplayOverlayShell();
  if (appMode === 'settings') return renderSettingsOverlay();
  if (appMode === 'library') return renderLibraryOverlay();
  if (appMode === 'menu') {
    return renderPanel({
      eyebrow: '40 LINES',
      title: 'STACK/40',
      meta: `${formatActionBinding('pause')} pause - ${formatActionBinding('hardDrop')} hard drop`,
      actions: [
        ['start', 'Start run'],
        ['replay-library', 'Replay library'],
        ['import-replay', 'Import replay'],
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
        ['import-replay', 'Import replay'],
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

function requestRunConfirmation(action: DestructiveRunAction): void {
  pendingConfirmAction = action;
  bindingCapture = null;
  input.releaseAll();
}

function cancelPendingConfirmation(): void {
  pendingConfirmAction = null;
  bindingCapture = null;
  input.releaseAll();
}

function confirmPendingAction(): void {
  const action = pendingConfirmAction;
  pendingConfirmAction = null;
  if (action === 'restart') startNewRun();
  if (action === 'main-menu') goToMenu();
  if (action === 'import-replay') openReplayFilePicker();
}

function renderConfirmOverlay(action: DestructiveRunAction): string {
  return `
    <div class="menu-scrim confirm-scrim">
      <section class="menu-panel confirm-panel" aria-label="Confirm destructive action">
        <div class="panel-eyebrow">CONFIRM</div>
        <h1>${escapeHtml(confirmTitle(action))}</h1>
        <p>${escapeHtml(confirmMeta(action))}</p>
        <div class="panel-actions confirm-actions">
          <button type="button" data-ui-action="cancel-confirm">Cancel</button>
          <button class="danger-action" type="button" data-ui-action="confirm-destructive">Confirm</button>
        </div>
      </section>
    </div>
  `;
}

function confirmTitle(action: DestructiveRunAction): string {
  if (action === 'restart') return 'Restart run?';
  if (action === 'main-menu') return 'Exit run?';
  return 'Import replay and abandon current run?';
}

function confirmMeta(action: DestructiveRunAction): string {
  if (action === 'import-replay') return 'The current board and timer will be discarded if a replay is loaded.';
  return 'The current board and timer will be discarded.';
}

function renderLibraryOverlay(): string {
  syncLibrarySelection();
  const visibleEntries = getVisibleLibraryEntries();
  const selectedEntry = getSelectedLibraryEntry(visibleEntries);
  const rows = visibleEntries.length === 0
    ? `<div class="history-empty">${escapeHtml(libraryEmptyText())}</div>`
    : visibleEntries.map((entry) => renderLibraryRow(entry, selectedEntry?.id === entry.id)).join('');
  const exported = lastExportName ? `<div class="panel-note">Exported ${escapeHtml(lastExportName)}</div>` : '';
  const error = libraryError ? `<div class="panel-note panel-error">${escapeHtml(libraryError)}</div>` : '';
  return `
    <div class="menu-scrim">
      <section class="menu-panel history-panel library-panel" aria-label="Replay library">
        <div class="panel-eyebrow">REPLAY LIBRARY</div>
        <h1>Runs</h1>
        <div class="library-toolbar" aria-label="Replay filters">
          ${renderLibraryFilterButton('all', 'All')}
          ${renderLibraryFilterButton('clear', 'Clears')}
          ${renderLibraryFilterButton('topout', 'Top outs')}
          ${renderLibraryFilterButton('best', 'Best times')}
        </div>
        ${exported}
        ${error}
        <div class="library-layout">
          <div class="history-list">${rows}</div>
          ${renderLibraryDetails(selectedEntry)}
        </div>
        <div class="panel-actions">
          <button type="button" data-ui-action="library-back">Back</button>
          <button type="button" data-ui-action="clear-history"${runHistory.length === 0 ? ' disabled' : ''}>Clear</button>
        </div>
      </section>
    </div>
  `;
}

function renderLibraryFilterButton(filter: LibraryFilter, label: string): string {
  const activeClass = libraryFilter === filter ? ' button-active' : '';
  return `<button class="${activeClass}" type="button" data-ui-action="library-filter" data-filter="${filter}">${label}</button>`;
}

function renderLibraryRow(entry: RunHistoryEntry, selected: boolean): string {
  return `
    <article class="history-row library-row ${selected ? 'library-row-selected' : ''}">
      <div>
        <strong>${escapeHtml(formatHistoryStatus(entry.status))} ${escapeHtml(formatFrames(entry.elapsedFrames))}</strong>
        <span>${escapeHtml(formatDateTime(entry.createdAt))} - seed ${entry.seed}</span>
      </div>
      <div class="history-stats">
        <span>${entry.lines}L</span>
        <span>${entry.pieces} pieces</span>
        <span>${entry.pps.toFixed(2)} PPS</span>
        <span>${entry.inputCount} inputs</span>
      </div>
      <button type="button" data-ui-action="select-history-entry" data-history-id="${escapeHtml(entry.id)}">${selected ? 'Selected' : 'Details'}</button>
    </article>
  `;
}

function renderLibraryDetails(entry: RunHistoryEntry | null): string {
  if (!entry) {
    return `
      <aside class="library-details">
        <div class="panel-eyebrow">NO REPLAY</div>
        <p>Saved terminal runs will appear here after a clear or top out.</p>
      </aside>
    `;
  }
  const id = escapeHtml(entry.id);
  return `
    <aside class="library-details">
      <div class="panel-eyebrow">SELECTED REPLAY</div>
      <h2>${escapeHtml(formatHistoryStatus(entry.status))} ${escapeHtml(formatFrames(entry.elapsedFrames))}</h2>
      <dl>
        <div><dt>Date</dt><dd>${escapeHtml(formatDateTime(entry.createdAt))}</dd></div>
        <div><dt>Seed</dt><dd>${entry.seed}</dd></div>
        <div><dt>Lines</dt><dd>${entry.lines}/40</dd></div>
        <div><dt>Pieces</dt><dd>${entry.pieces}</dd></div>
        <div><dt>PPS</dt><dd>${entry.pps.toFixed(2)}</dd></div>
        <div><dt>Inputs</dt><dd>${entry.inputCount}</dd></div>
      </dl>
      <div class="panel-actions replay-actions">
        <button type="button" data-ui-action="play-history-replay" data-history-id="${id}">Play replay</button>
        <button type="button" data-ui-action="export-history-replay" data-history-id="${id}">Export</button>
        <button type="button" data-ui-action="delete-history-entry" data-history-id="${id}">Delete</button>
      </div>
    </aside>
  `;
}

function renderReplayOverlayShell(): string {
  const speedButtons = REPLAY_SPEEDS.map((speed) => (
    `<button type="button" data-ui-action="replay-speed" data-speed="${speed}">${speed}x</button>`
  )).join('');
  return `
    <div class="replay-strip">
      <div>
        <span>REPLAY</span>
        <strong data-replay-time>0:00.000 / 0:00.000</strong>
      </div>
      <div data-replay-validation>Validation pending</div>
    </div>
      <section class="replay-panel" aria-label="Replay playback">
        <div class="panel-eyebrow">REPLAY PLAYBACK</div>
        <h1 data-replay-title>Playback</h1>
        <p>${escapeHtml(importedReplayName ?? 'Imported replay')} - seed ${playback?.getReplay().seed ?? 0}</p>
        <div class="replay-progress" aria-hidden="true">
          <div data-replay-progress></div>
        </div>
        <div class="panel-note" data-replay-panel-validation>Validation pending</div>
        <div class="panel-actions replay-actions">
          <button type="button" data-ui-action="replay-toggle" data-replay-toggle-label>Pause</button>
          <button type="button" data-ui-action="replay-restart">Restart replay</button>
          ${speedButtons}
          <button type="button" data-ui-action="replay-exit">Exit</button>
        </div>
      </section>
  `;
}

function updateReplayOverlay(snapshot: ReplayPlaybackSnapshot): void {
  const validationText = replayValidationText(snapshot);
  const title = snapshot.paused ? 'Paused' : snapshot.done ? 'Complete' : `${snapshot.speed}x playback`;
  setText('[data-replay-time]', `${formatFrames(snapshot.frame)} / ${formatFrames(snapshot.targetFrame)}`);
  setText('[data-replay-validation]', validationText);
  setText('[data-replay-title]', title);
  setText('[data-replay-panel-validation]', validationText);
  setText('[data-replay-toggle-label]', snapshot.paused ? 'Resume' : 'Pause');

  const progress = overlayElement.querySelector<HTMLElement>('[data-replay-progress]');
  if (progress) progress.style.width = `${replayProgressPercent(snapshot)}%`;

  const validation = overlayElement.querySelector<HTMLElement>('[data-replay-panel-validation]');
  validation?.classList.toggle('panel-error', snapshot.validation === 'mismatch');

  for (const button of overlayElement.querySelectorAll<HTMLElement>('[data-ui-action="replay-speed"]')) {
    button.classList.toggle('button-active', button.dataset.speed === String(snapshot.speed));
  }
}

function replayValidationText(snapshot: ReplayPlaybackSnapshot): string {
  if (snapshot.validation === 'pending') return 'Validation pending';
  return snapshot.validation === 'match' ? 'Replay matches result' : 'Replay mismatch';
}

function setText(selector: string, value: string): void {
  const element = overlayElement.querySelector(selector);
  if (element && element.textContent !== value) element.textContent = value;
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
  const importError = replayImportError ? `<div class="panel-note panel-error">${escapeHtml(replayImportError)}</div>` : '';
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
        ${importError}
        <div class="panel-actions">${actions}</div>
      </section>
    </div>
  `;
}

function helpText(): string {
  if (appMode === 'replayPlayback') return `${formatActionBinding('pause')} pause replay - ${formatActionBinding('retry')} restart replay - M sound - N music`;
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

function setLibraryFilter(value: string | undefined): void {
  if (!isLibraryFilter(value)) return;
  libraryFilter = value;
  libraryError = null;
  syncLibrarySelection();
}

function selectHistoryEntry(id: string | undefined): void {
  const entry = findHistoryEntry(id);
  if (!entry) {
    libraryError = 'Replay entry was not found.';
    return;
  }
  selectedHistoryEntryId = entry.id;
  libraryError = null;
}

function findHistoryEntry(id: string | undefined): RunHistoryEntry | null {
  if (!id) return null;
  return runHistory.find((entry) => entry.id === id) ?? null;
}

function syncLibrarySelection(): void {
  const visibleEntries = getVisibleLibraryEntries();
  if (visibleEntries.length === 0) {
    selectedHistoryEntryId = null;
    return;
  }
  if (!visibleEntries.some((entry) => entry.id === selectedHistoryEntryId)) {
    selectedHistoryEntryId = visibleEntries[0].id;
  }
}

function getSelectedLibraryEntry(visibleEntries = getVisibleLibraryEntries()): RunHistoryEntry | null {
  return visibleEntries.find((entry) => entry.id === selectedHistoryEntryId) ?? visibleEntries[0] ?? null;
}

function getVisibleLibraryEntries(): RunHistoryEntry[] {
  const entries = runHistory.filter((entry) => {
    if (libraryFilter === 'clear' || libraryFilter === 'best') return entry.status === 'finished';
    if (libraryFilter === 'topout') return entry.status === 'gameover';
    return true;
  });
  if (libraryFilter === 'best') {
    return [...entries].sort((a, b) => a.elapsedFrames - b.elapsedFrames || a.createdAt.localeCompare(b.createdAt));
  }
  return entries;
}

function libraryEmptyText(): string {
  if (runHistory.length === 0) return 'No saved runs yet.';
  if (libraryFilter === 'clear' || libraryFilter === 'best') return 'No clears saved yet.';
  if (libraryFilter === 'topout') return 'No top outs saved yet.';
  return 'No matching replays.';
}

function isLibraryFilter(value: string | undefined): value is LibraryFilter {
  return LIBRARY_FILTERS.includes(value as LibraryFilter);
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

function replayProgressPercent(snapshot: ReplayPlaybackSnapshot): string {
  if (snapshot.targetFrame <= 0) return '100';
  return Math.min(100, Math.max(0, (snapshot.frame / snapshot.targetFrame) * 100)).toFixed(2);
}

function formatPercent(volume: number): string {
  return Math.round(volume * 100).toString().padStart(3, ' ');
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatHistoryStatus(status: RunHistoryEntry['status']): string {
  return status === 'finished' ? 'CLEAR' : 'TOP OUT';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
