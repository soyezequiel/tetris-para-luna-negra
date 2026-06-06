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
import { createRunSummary, RunSplitTracker, type LineSplit, type RunSummary } from './app/runStats';
import { canAdvanceGame, requiresRunConfirmation, terminalLabel, togglePauseMode, type AppMode, type DestructiveRunAction } from './app/state';
import {
  CUSTOM_NUMBER_SETTING_META,
  CUSTOM_TABS,
  cloneCustomSettings,
  customRulesFromSettings,
  customSeed,
  formatCustomNumber,
  isCustomBooleanSetting,
  isCustomNumberSetting,
  loadCustomSettings,
  parseCustomSettingKey,
  parseCustomTab,
  resetCustomSettings,
  saveCustomSettings,
  updateCustomSetting,
  updateCustomSettingByDelta,
  type CustomSettings,
  type CustomTab,
} from './app/customSettings';
import { MUSIC_TRACKS } from './audio/music';
import { SoundEngine, type VolumeChannel } from './audio/SoundEngine';
import { GameEngine } from './game/engine';
import { cellsFor } from './game/pieces';
import { createReplayLog, recordInput } from './game/replay';
import { BATTLE_RULES, DEFAULT_RULES } from './game/rules';
import { displayedElapsedFrames } from './game/timing';
import type { GameEngineSnapshot, GameEvent, GameInput, GameRules, GameState, InputAction, LineClearEvent } from './game/types';
import { InputController, isBrowserShortcutKeyDown, isEditableKeyboardTarget, type ControlInput } from './input';
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
import { OnlineClient } from './online/client';
import { HostAuthoritySimulator, type HostSimulatedPlayer } from './online/hostAuthority';
import { loadOnlinePlayer, saveOnlinePlayer } from './online/playerIdentity';
import { OnlinePeerBroadcaster, type OnlinePeerKoMessage } from './online/peerBroadcast';
import { frameForPendingInputReplay, shouldReconcileLocalEngineSnapshot } from './online/reconciliation';
import { normalizeRoomId, rankPlayers } from './online/roomService';
import type { AttackRequest, OnlineAttack, OnlineGameSnapshot, OnlinePlayer, OnlineRoom, OnlineRoomSummary, ProgressRequest, RoomVisibility } from './online/protocol';
import { loadRecord, saveAudioVolumes, saveBest40LineFrames, saveSoundMuted, saveTouchControlsHidden } from './storage';
import { PixiGameRenderer } from './renderer/PixiGameRenderer';

const root = document.getElementById('game-root');
const overlay = document.getElementById('hud-overlay');

if (!root || !overlay) throw new Error('Missing application root.');

const overlayElement = overlay;
const VOLUME_WHEEL_STEP = 0.05;
const REPLAY_SPEEDS: PlaybackSpeed[] = [1, 2, 4];
const LIBRARY_FILTERS = ['all', 'clear', 'topout', 'best'] as const;
const ONLINE_POLL_MS = 1000;
const ONLINE_PEER_BROADCAST_MS = 100;
const ONLINE_BACKGROUND_SYNC_MS = 1000;
const GAME_FRAME_MS = 1000 / 60;

type LibraryFilter = typeof LIBRARY_FILTERS[number];
type RunKind = 'standard' | 'custom' | 'online';
type SequencedOnlineInput = GameInput & { sequence: number };

let inputSettings = loadInputSettings();
let customSettings = loadCustomSettings();
let gameRules = rulesFromSettings(inputSettings);
let seed = randomSeed();
let engine = new GameEngine(seed, gameRules);
let replay = createReplayLog(seed, gameRules);
const input = new InputController(inputSettings);
const renderer = new PixiGameRenderer(root);
const sound = new SoundEngine(loadRecord().soundMuted, MUSIC_TRACKS, loadRecord().sfxVolume, loadRecord().musicVolume);
const onlineClient = new OnlineClient();

let best = loadRecord();
let runHistory = loadRunHistory();
let appMode: AppMode = 'menu';
let settingsReturnMode: AppMode = 'menu';
let currentRunKind: RunKind = 'standard';
let customTab: CustomTab = 'game';
let gameFrame = 0;
let gameClockOriginMs = performance.now();
let savedFinish = false;
let savedRunHistoryEntry = false;
let runSplitTracker = new RunSplitTracker();
let lastPieces = 0;
let lastLines = 0;
let lastStatus = engine.getState().status;
let volumeFeedback: { channel: VolumeChannel; expiresAt: number } | null = null;
let bindingCapture: ControlAction | null = null;
let lastExportName: string | null = null;
let lastCustomExportName: string | null = null;
let lastOverlayHtml = '';
let playback: ReplayPlayback | null = null;
let importedReplayName: string | null = null;
let replayImportError: string | null = null;
let libraryFilter: LibraryFilter = 'all';
let selectedHistoryEntryId: string | null = null;
let libraryError: string | null = null;
let pendingConfirmAction: DestructiveRunAction | null = null;
let touchControlsHidden = best.touchControlsHidden;
let onlinePlayer = loadOnlinePlayer();
let onlineName = onlinePlayer.name;
let onlineJoinCode = '';
let onlineRoom: OnlineRoom | null = null;
let onlinePublicRooms: OnlineRoomSummary[] = [];
let onlineError: string | null = null;
let onlineBusy = false;
let onlinePollInFlight = false;
let onlineProgressInFlight = false;
let onlineLastPollAt = 0;
let onlineLastProgressAt = 0;
let onlineLastPeerBroadcastAt = 0;
let onlineServerOffsetMs = 0;
let onlineResultSubmitted = false;
let onlineRunStarted = false;
let onlinePeerBroadcaster: OnlinePeerBroadcaster | null = null;
let onlinePeerStates = new Map<string, string>();
let onlineAttackSequence = 0;
let onlineAppliedAttackIds = new Set<string>();
let onlineHostAuthority: HostAuthoritySimulator | null = null;
let onlineHostProgressInFlight = new Set<string>();
let onlineHostLastProgressAt = new Map<string, number>();
let onlineHostCommittedEliminations = new Set<string>();
let onlineLastAuthoritativeFrame = 0;
let onlineInputSequence = 0;
let onlineInputOutbox: SequencedOnlineInput[] = [];

const activeTouchInputs = new Map<number, { sourceId: string; control: HTMLElement }>();

const replayFileInput = document.createElement('input');
replayFileInput.type = 'file';
replayFileInput.accept = 'application/json,.json';
replayFileInput.hidden = true;
document.body.appendChild(replayFileInput);

window.addEventListener('keydown', handleGlobalKeyDown, { capture: true });
window.addEventListener('wheel', handleVolumeWheel, { passive: false });
window.setInterval(syncOnlineBackground, ONLINE_BACKGROUND_SYNC_MS);
document.addEventListener('visibilitychange', syncOnlineVisibilityChange);
replayFileInput.addEventListener('change', handleReplayFileChange);
overlayElement.addEventListener('click', handleOverlayClick);
overlayElement.addEventListener('input', handleOverlayInput);
overlayElement.addEventListener('change', handleOverlayInput);
overlayElement.addEventListener('pointerdown', handleTouchControlPointerDown);
overlayElement.addEventListener('pointerup', handleTouchControlPointerEnd);
overlayElement.addEventListener('pointercancel', handleTouchControlPointerEnd);
overlayElement.addEventListener('lostpointercapture', handleTouchControlPointerEnd);

function loop(): void {
  const beforeState = engine.getState();
  const canAdvanceThisLoop = !pendingConfirmAction && canAdvanceGame(appMode, beforeState.status);
  if (!canAdvanceThisLoop) syncGameplayClockToCurrentFrame();
  const candidateFrame = canAdvanceThisLoop ? targetGameplayFrame() : gameFrame;
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
    const beforeTickState = engine.getState();
    const gameInputs = toGameInputs(controlInputs, candidateFrame);
    sendOnlineInputsToHost(gameInputs);
    playImmediateInputSounds(gameInputs.map((event) => event.action));
    for (const event of gameInputs) recordInput(replay, event);
    state = advanceGameToFrame(candidateFrame, gameInputs);
    playAcceptedMoveSound(beforeTickState.active, state.active, gameInputs.map((event) => event.action));
  }

  syncOnline(state);
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
    getCustomSettings: () => cloneCustomSettings(customSettings),
    getTouchControlsHidden: () => touchControlsHidden,
    getRunHistory: () => runHistory,
    getOnlineRoom: () => onlineRoom,
    getOnlinePublicRooms: () => onlinePublicRooms,
    getOnlinePlayer: () => onlinePlayer,
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

function targetGameplayFrame(now = performance.now()): number {
  const elapsedFrames = Math.floor((now - gameClockOriginMs) / GAME_FRAME_MS);
  return Math.max(gameFrame + 1, elapsedFrames);
}

function syncGameplayClockToCurrentFrame(): void {
  gameClockOriginMs = performance.now() - gameFrame * GAME_FRAME_MS;
}

function advanceGameToFrame(targetFrame: number, finalFrameInputs: GameInput[]): GameState {
  let state = engine.getState();
  for (let frame = gameFrame + 1; frame <= targetFrame && canAdvanceGame(appMode, state.status); frame += 1) {
    const inputs = frame === targetFrame ? finalFrameInputs : [];
    state = engine.tick(frame, inputs);
    gameFrame = frame;
    syncRunEffects(state);
    syncOnlineBattleEvents(engine.drainEvents(), state);
  }
  return state;
}

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

  if (isEditableKeyboardTarget(event.target)) return;
  if (isBrowserShortcutKeyDown(event)) return;
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

function handleOverlayInput(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    const field = target.dataset.onlineField;
    if (field === 'name') onlineName = target.value;
    if (field === 'join-code') onlineJoinCode = normalizeRoomId(target.value);
    const customKey = parseCustomSettingKey(target.dataset.customSetting);
    if (customKey && target.value !== '') {
      customSettings = saveCustomSettings(updateCustomSetting(customSettings, customKey, target.type === 'checkbox' ? target.checked : target.value));
    }
    return;
  }
  if (target instanceof HTMLSelectElement) {
    const customKey = parseCustomSettingKey(target.dataset.customSetting);
    if (customKey) customSettings = saveCustomSettings(updateCustomSetting(customSettings, customKey, target.value));
  }
}

function handleOverlayClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const control = target.closest<HTMLElement>('[data-ui-action]');
  if (!control) return;

  const action = control.dataset.uiAction;
  if (action === 'toggle-touch-controls') {
    toggleTouchControls();
    return;
  }
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

  if (action === 'start') startNewRun();
  if (action === 'restart') restartCurrentRun();
  if (action === 'solo-menu') openModeMenu('soloMenu');
  if (action === 'multiplayer-menu') openModeMenu('multiplayerMenu');
  if (action === 'history-menu') openModeMenu('historyMenu');
  if (action === 'config-menu') openModeMenu('configMenu');
  if (action === 'custom-open') openCustomMode();
  if (action === 'custom-back') goToMenu();
  if (action === 'custom-start') startCustomRun();
  if (action === 'custom-reset') customSettings = resetCustomSettings();
  if (action === 'custom-export') lastCustomExportName = exportCustomSettings();
  if (action === 'custom-tab') {
    const nextTab = parseCustomTab(control.dataset.tab);
    if (nextTab) customTab = nextTab;
  }
  if (action === 'custom-toggle') {
    const setting = parseCustomSettingKey(control.dataset.setting);
    if (setting && isCustomBooleanSetting(setting)) {
      customSettings = saveCustomSettings(updateCustomSetting(customSettings, setting, !customSettings[setting]));
    }
  }
  if (action === 'custom-step') {
    const setting = parseCustomSettingKey(control.dataset.setting);
    const delta = Number(control.dataset.delta ?? 0);
    if (setting && Number.isFinite(delta)) {
      customSettings = saveCustomSettings(updateCustomSettingByDelta(customSettings, setting, delta));
    }
  }
  if (action === 'online-open') openOnlineMenu();
  if (action === 'online-refresh') refreshPublicRooms();
  if (action === 'online-create-public') createOnlineRoom('public');
  if (action === 'online-create-private') createOnlineRoom('private');
  if (action === 'online-join') joinOnlineRoom(onlineJoinCode);
  if (action === 'online-join-public') joinOnlineRoom(control.dataset.roomId ?? '');
  if (action === 'online-ready') setOnlineReady(true);
  if (action === 'online-unready') setOnlineReady(false);
  if (action === 'online-start') startOnlineRoom();
  if (action === 'online-leave') leaveOnlineRoom();
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

function handleTouchControlPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const control = target.closest<HTMLElement>('[data-touch-action]');
  const action = parseControlAction(control?.dataset.touchAction);
  if (!control || !action || (appMode !== 'playing' && appMode !== 'onlinePlaying') || touchControlsHidden || pendingConfirmAction) return;

  const sourceId = touchSourceId(event.pointerId);
  activeTouchInputs.set(event.pointerId, { sourceId, control });
  input.pressControl(sourceId, action);
  control.classList.add('touch-button-active');
  try {
    control.setPointerCapture(event.pointerId);
  } catch {
    // Some synthetic pointer events do not support capture; release still works through delegated events.
  }
  event.preventDefault();
}

function handleTouchControlPointerEnd(event: PointerEvent): void {
  const active = activeTouchInputs.get(event.pointerId);
  if (!active) return;
  activeTouchInputs.delete(event.pointerId);
  input.releaseControl(active.sourceId);
  active.control.classList.remove('touch-button-active');
  event.preventDefault();
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
    if (canAdvanceGame(appMode, engine.getState().status)) syncGameplayClockToCurrentFrame();
    input.releaseAll();
    return true;
  }

  if (appMode === 'replayPlayback' && inputs.some((event) => event.action === 'retry')) {
    playback?.restart();
    input.releaseAll();
    return true;
  }

  if (appMode === 'onlinePlaying' && inputs.some((event) => event.action === 'retry')) {
    onlineError = 'Retry is disabled during online races.';
    input.releaseAll();
    return true;
  }

  if (appMode !== 'settings' && inputs.some((event) => event.action === 'retry')) {
    if (requiresRunConfirmation('restart', appMode, engine.getState().status)) {
      requestRunConfirmation('restart');
      input.releaseAll();
      return true;
    }
    restartCurrentRun();
    return true;
  }

  return false;
}

function startNewRun(nextSeed = randomSeed(), nextMode: AppMode = 'playing', nextRunKind: RunKind = nextMode === 'onlinePlaying' ? 'online' : 'standard'): void {
  input.releaseAll();
  bindingCapture = null;
  pendingConfirmAction = null;
  lastExportName = null;
  lastCustomExportName = null;
  replayImportError = null;
  libraryError = null;
  importedReplayName = null;
  playback = null;
  currentRunKind = nextRunKind;
  gameRules = rulesForRun(nextMode, nextRunKind);
  seed = nextSeed;
  engine = new GameEngine(seed, gameRules);
  replay = createReplayLog(seed, gameRules);
  gameFrame = 0;
  gameClockOriginMs = performance.now();
  savedFinish = false;
  savedRunHistoryEntry = false;
  runSplitTracker = new RunSplitTracker();
  lastPieces = 0;
  lastLines = 0;
  lastStatus = engine.getState().status;
  appMode = nextMode;
  settingsReturnMode = 'menu';
  sound.play('retry');
}

function restartCurrentRun(): void {
  if (currentRunKind === 'custom') {
    if (!customSettings.allowRetry) return;
    startCustomRun();
    return;
  }
  startNewRun();
}

function startCustomRun(): void {
  startNewRun(customSeed(customSettings, randomSeed), 'playing', 'custom');
}

function openCustomMode(): void {
  bindingCapture = null;
  pendingConfirmAction = null;
  appMode = 'custom';
  settingsReturnMode = 'menu';
  input.releaseAll();
}

function openModeMenu(mode: AppMode): void {
  bindingCapture = null;
  pendingConfirmAction = null;
  appMode = mode;
  settingsReturnMode = 'menu';
  input.releaseAll();
}

function resumeGame(): void {
  if (engine.getState().status !== 'playing') return;
  bindingCapture = null;
  pendingConfirmAction = null;
  appMode = 'playing';
  syncGameplayClockToCurrentFrame();
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
  if (canAdvanceGame(appMode, engine.getState().status)) syncGameplayClockToCurrentFrame();
  input.releaseAll();
}

function goToMenu(): void {
  bindingCapture = null;
  pendingConfirmAction = null;
  appMode = 'menu';
  currentRunKind = 'standard';
  syncGameplayClockToCurrentFrame();
  settingsReturnMode = 'menu';
  playback = null;
  importedReplayName = null;
  libraryError = null;
  runHistory = loadRunHistory();
  input.releaseAll();
}

function toggleTouchControls(): void {
  touchControlsHidden = !touchControlsHidden;
  best = saveTouchControlsHidden(touchControlsHidden);
  for (const active of activeTouchInputs.values()) {
    input.releaseControl(active.sourceId);
    active.control.classList.remove('touch-button-active');
  }
  activeTouchInputs.clear();
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

function openOnlineMenu(): void {
  bindingCapture = null;
  pendingConfirmAction = null;
  onlineError = null;
  appMode = 'onlineMenu';
  settingsReturnMode = 'menu';
  input.releaseAll();
  refreshPublicRooms();
}

async function refreshPublicRooms(): Promise<void> {
  if (onlineBusy) return;
  onlineBusy = true;
  try {
    const response = await onlineClient.listPublicRooms();
    syncOnlineClock(response.serverNowMs);
    onlinePublicRooms = response.rooms;
    onlineError = null;
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlineBusy = false;
  }
}

async function createOnlineRoom(visibility: RoomVisibility): Promise<void> {
  if (onlineBusy) return;
  onlineBusy = true;
  try {
    onlinePlayer = saveOnlinePlayer({ ...onlinePlayer, name: onlineName });
    const response = await onlineClient.createRoom({
      playerId: onlinePlayer.id,
      name: onlinePlayer.name,
      visibility,
    });
    syncOnlineClock(response.serverNowMs);
    enterOnlineRoom(response.room, 'roomLobby');
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlineBusy = false;
  }
}

async function joinOnlineRoom(roomId: string): Promise<void> {
  const normalizedRoomId = normalizeRoomId(roomId);
  if (onlineBusy || normalizedRoomId.length !== 4) {
    onlineError = 'Enter a 4-character room code.';
    return;
  }
  onlineBusy = true;
  try {
    onlinePlayer = saveOnlinePlayer({ ...onlinePlayer, name: onlineName });
    const response = await onlineClient.joinRoom({
      roomId: normalizedRoomId,
      playerId: onlinePlayer.id,
      name: onlinePlayer.name,
    });
    syncOnlineClock(response.serverNowMs);
    enterOnlineRoom(response.room, 'roomLobby');
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlineBusy = false;
  }
}

async function setOnlineReady(ready: boolean): Promise<void> {
  if (!onlineRoom || onlineBusy) return;
  onlineBusy = true;
  try {
    const response = await onlineClient.setReady({ roomId: onlineRoom.id, playerId: onlinePlayer.id, ready });
    syncOnlineClock(response.serverNowMs);
    enterOnlineRoom(response.room, 'roomLobby');
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlineBusy = false;
  }
}

async function startOnlineRoom(): Promise<void> {
  if (!onlineRoom || onlineBusy) return;
  onlineBusy = true;
  try {
    const response = await onlineClient.startRoom({ roomId: onlineRoom.id, playerId: onlinePlayer.id });
    syncOnlineClock(response.serverNowMs);
    enterOnlineRoom(response.room, 'onlineCountdown');
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlineBusy = false;
  }
}

function leaveOnlineRoom(): void {
  onlinePeerBroadcaster?.close();
  onlinePeerBroadcaster = null;
  onlinePeerStates = new Map();
  onlineRoom = null;
  onlineError = null;
  onlineResultSubmitted = false;
  onlineRunStarted = false;
  onlineAttackSequence = 0;
  onlineAppliedAttackIds = new Set();
  onlineHostAuthority = null;
  onlineHostProgressInFlight = new Set();
  onlineHostLastProgressAt = new Map();
  onlineHostCommittedEliminations = new Set();
  onlineLastAuthoritativeFrame = 0;
  onlineInputSequence = 0;
  onlineInputOutbox = [];
  onlineLastPollAt = 0;
  onlineLastProgressAt = 0;
  onlineLastPeerBroadcastAt = 0;
  goToMenu();
}

function enterOnlineRoom(room: OnlineRoom, preferredMode: AppMode): void {
  onlineRoom = room;
  syncOnlinePeers(room);
  onlineError = null;
  onlineLastPollAt = 0;
  if (room.status === 'finished') appMode = 'onlineResults';
  else if (room.status === 'playing') appMode = onlineRunStarted ? 'onlinePlaying' : 'onlineCountdown';
  else if (room.status === 'countdown') appMode = 'onlineCountdown';
  else appMode = preferredMode;
}

function applyInputSettings(settings: InputSettings): void {
  bindingCapture = null;
  inputSettings = saveInputSettings(settings);
  input.updateSettings(inputSettings);
}

function exportReplay(): void {
  const state = engine.getState();
  const exported = createExportedReplay(replay, state, inputSettings, undefined, currentRunSummary(state));
  lastExportName = downloadReplayFile(exported);
}

function exportCustomSettings(): string {
  const fileName = `stack40-custom-settings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  downloadJsonFile(fileName, {
    version: 1,
    game: 'stack40',
    mode: 'custom',
    settings: customSettings,
  });
  return fileName;
}

function downloadReplayFile(exported: ExportedReplay): string {
  const fileName = replayFileName(exported);
  downloadJsonFile(fileName, exported);
  return fileName;
}

function downloadJsonFile(fileName: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
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
  runSplitTracker.record(state);
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
    const entry = createRunHistoryEntry(createExportedReplay(replay, state, inputSettings, undefined, currentRunSummary(state)));
    if (entry) runHistory = saveRunHistoryEntry(entry);
    savedRunHistoryEntry = true;
  }
}

function syncOnlineBattleEvents(events: GameEvent[], state: GameState): void {
  if (appMode !== 'onlinePlaying' || !onlineRoom) return;
  if (!isOnlineHost()) return;
  for (const event of events) {
    if (event.type === 'lineClear' && event.outgoingLines > 0) sendOnlineAttack(event, state);
  }
}

function sendOnlineInputsToHost(inputs: GameInput[]): void {
  if (inputs.length === 0 || appMode !== 'onlinePlaying' || !onlineRoom || isOnlineHost()) return;
  onlineInputOutbox.push(...inputs.map((input) => ({
    ...input,
    sequence: onlineInputSequence += 1,
  })));
  flushOnlineInputOutbox();
}

function flushOnlineInputOutbox(): void {
  if (onlineInputOutbox.length === 0 || !onlineRoom || isOnlineHost()) return;
  const sent = onlinePeerBroadcaster?.sendInputs(onlineRoom.hostPlayerId, onlineInputOutbox) ?? false;
  if (!sent) onlineError = 'Waiting for host connection to send inputs.';
}

function sendOnlineAttack(event: LineClearEvent, state: GameState): void {
  if (!onlineRoom || !isOnlineHost()) return;
  const attack = {
    attackId: `${onlinePlayer.id}-${gameFrame}-${onlineAttackSequence += 1}`,
    fromPlayerId: onlinePlayer.id,
    lines: event.outgoingLines,
    holeSeed: (onlineRoom.seed + gameFrame + onlineAttackSequence * 97) >>> 0,
    frame: displayedElapsedFrames(state.stats),
  };
  commitOnlineAttack(attack);
}

function commitOnlineAttack(request: {
  attackId: string;
  fromPlayerId: string;
  lines: number;
  holeSeed: number;
  frame: number;
}): void {
  if (!onlineRoom || !isOnlineHost()) return;
  const target = selectAttackTarget(request.fromPlayerId, request.attackId);
  if (!target) return;
  const attack: AttackRequest = {
    roomId: onlineRoom.id,
    authorityPlayerId: onlinePlayer.id,
    attackId: request.attackId,
    fromPlayerId: request.fromPlayerId,
    toPlayerId: target.id,
    lines: request.lines,
    holeSeed: request.holeSeed,
    frame: request.frame,
  };
  applyAttackToHostTruth(attack);
  onlinePeerBroadcaster?.sendAttack(target.id, {
    attackId: attack.attackId,
    authorityPlayerId: attack.authorityPlayerId,
    fromPlayerId: attack.fromPlayerId,
    lines: attack.lines,
    holeSeed: attack.holeSeed,
    frame: attack.frame,
  });
  void onlineClient.sendAttack(attack)
    .then((response) => {
      syncOnlineClock(response.serverNowMs);
      onlineRoom = response.room;
      applyRoomAttacks(response.room);
    })
    .catch((error) => {
      onlineError = onlineErrorText(error);
    });
}

function applyAttackToHostTruth(attack: AttackRequest): void {
  if (attack.toPlayerId === onlinePlayer.id) {
    applyOnlineAttack({
      id: attack.attackId,
      roomId: attack.roomId,
      authorityPlayerId: attack.authorityPlayerId,
      fromPlayerId: attack.fromPlayerId,
      toPlayerId: attack.toPlayerId,
      lines: attack.lines,
      holeSeed: attack.holeSeed,
      frame: attack.frame,
      createdAtServerMs: onlineNowMs(),
    });
    return;
  }
  onlineHostAuthority?.queueGarbage(attack.toPlayerId, attack.lines, attack.holeSeed, attack.attackId);
}

function selectAttackTarget(sourcePlayerId: string, attackId: string): OnlinePlayer | null {
  if (!onlineRoom) return null;
  const candidates = onlineRoom.players.filter((player) => (
    player.id !== sourcePlayerId
    && player.alive
    && player.status !== 'eliminated'
    && player.status !== 'winner'
    && player.status !== 'disconnected'
  ));
  if (candidates.length === 0) return null;
  return candidates[hashText(attackId) % candidates.length];
}

function advanceHostAuthority(targetFrame: number): void {
  if (!onlineRoom || !isOnlineHost() || !onlineHostAuthority) return;
  syncHostAuthorityPlayers();
  const updates = onlineHostAuthority.advanceAll(targetFrame);
  for (const update of updates) processHostSimulationUpdate(update);
}

function syncHostAuthorityPlayers(): void {
  if (!onlineRoom || !isOnlineHost() || !onlineHostAuthority) return;
  onlineHostAuthority.ensurePlayers(
    onlineRoom.players
      .map((player) => player.id)
      .filter((playerId) => playerId !== onlinePlayer.id),
  );
}

function processHostSimulationUpdate(update: HostSimulatedPlayer): void {
  if (!onlineRoom || !isOnlineHost()) return;
  const snapshot = createOnlineGameSnapshotFromState(
    update.state,
    update.snapshot,
    update.lastProcessedInputSequence,
  );
  applyPeerSnapshot(onlinePlayer.id, update.playerId, snapshot);
  postHostSimulatedProgress(update.playerId, update.state);
  for (const event of update.events) {
    if (event.type === 'lineClear' && event.outgoingLines > 0) {
      onlineAttackSequence += 1;
      commitOnlineAttack({
        attackId: `${update.playerId}-${event.frame}-${onlineAttackSequence}`,
        fromPlayerId: update.playerId,
        lines: event.outgoingLines,
        holeSeed: ((onlineRoom?.seed ?? 0) + event.frame + onlineAttackSequence * 97) >>> 0,
        frame: event.frame,
      });
    }
  }
  if (update.state.status === 'gameover' && !onlineHostCommittedEliminations.has(update.playerId)) {
    void commitOnlineElimination(createOnlineKoReportFromState(update.playerId, update.state));
  }
}

function syncOnline(state: GameState): void {
  if (!onlineRoom) return;
  const now = performance.now();
  if (shouldPollOnline(now)) pollOnlineRoom();
  if (appMode === 'onlineCountdown') maybeStartOnlineRun();
  if (appMode === 'onlinePlaying') {
    if (isOnlineHost()) advanceHostAuthority(gameFrame);
    else flushOnlineInputOutbox();
    applyRoomAttacks(onlineRoom);
    if (state.status === 'playing' && shouldBroadcastPeerSnapshot(now)) broadcastOnlineSnapshot(state);
    if (isOnlineHost() && state.status === 'playing' && shouldPostOnlineProgress(now)) postOnlineProgress(state);
    if (state.status === 'gameover' && !onlineResultSubmitted) postOnlineElimination(state);
  }
}

function shouldPollOnline(now: number): boolean {
  if (onlinePollInFlight) return false;
  if (!['roomLobby', 'onlineCountdown', 'onlinePlaying', 'onlineResults'].includes(appMode)) return false;
  return now - onlineLastPollAt >= ONLINE_POLL_MS;
}

function shouldPostOnlineProgress(now: number): boolean {
  if (onlineProgressInFlight) return false;
  return now - onlineLastProgressAt >= ONLINE_POLL_MS;
}

function shouldBroadcastPeerSnapshot(now: number): boolean {
  if (!onlinePeerBroadcaster) return false;
  return now - onlineLastPeerBroadcastAt >= ONLINE_PEER_BROADCAST_MS;
}

async function pollOnlineRoom(): Promise<void> {
  if (!onlineRoom) return;
  onlinePollInFlight = true;
  onlineLastPollAt = performance.now();
  try {
    const response = await onlineClient.getRoomState(onlineRoom.id);
    syncOnlineClock(response.serverNowMs);
    onlineRoom = response.room;
    syncOnlinePeers(onlineRoom);
    applyRoomAttacks(onlineRoom);
    if (onlineRoom.status === 'finished') appMode = 'onlineResults';
    if (onlineRoom.status === 'countdown' && appMode === 'roomLobby') appMode = 'onlineCountdown';
    if (onlineRoom.status === 'playing' && appMode === 'roomLobby') appMode = 'onlineCountdown';
    onlineError = null;
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlinePollInFlight = false;
  }
}

async function postOnlineProgress(state: GameState): Promise<void> {
  if (!onlineRoom || !isOnlineHost()) return;
  onlineProgressInFlight = true;
  onlineLastProgressAt = performance.now();
  try {
    const response = await onlineClient.updateProgress({
      roomId: onlineRoom.id,
      authorityPlayerId: onlinePlayer.id,
      playerId: onlinePlayer.id,
      lines: state.stats.lines,
      pieces: state.stats.pieces,
      elapsedFrames: displayedElapsedFrames(state.stats),
      sentGarbage: state.stats.sentGarbage,
      receivedGarbage: state.stats.receivedGarbage,
      pendingGarbage: state.stats.pendingGarbage,
      game: createOnlineGameSnapshot(state),
    });
    syncOnlineClock(response.serverNowMs);
    onlineRoom = response.room;
    syncOnlinePeers(onlineRoom);
    onlineError = null;
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlineProgressInFlight = false;
  }
}

async function postOnlineElimination(state: GameState): Promise<void> {
  if (!onlineRoom) return;
  onlineResultSubmitted = true;
  const report = createOnlineKoReport(onlinePlayer.id, state);
  onlinePeerBroadcaster?.broadcastKo(report);

  if (!isOnlineHost()) {
    markOnlinePlayerEliminated(report);
    appMode = 'onlineResults';
    onlineError = null;
    return;
  }

  await commitOnlineElimination(report, () => {
    onlineResultSubmitted = false;
  });
}

async function commitOnlineElimination(report: Omit<OnlinePeerKoMessage, 'type'>, onFailure?: () => void): Promise<void> {
  if (!onlineRoom || !isOnlineHost()) return;
  onlineHostCommittedEliminations.add(report.playerId);
  try {
    const response = await onlineClient.eliminatePlayer({
      roomId: onlineRoom.id,
      authorityPlayerId: onlinePlayer.id,
      playerId: report.playerId,
      frame: report.frame,
      lines: report.lines,
      pieces: report.pieces,
      elapsedFrames: report.elapsedFrames,
      sentGarbage: report.sentGarbage,
      receivedGarbage: report.receivedGarbage,
      pendingGarbage: report.pendingGarbage,
      game: report.game,
    });
    syncOnlineClock(response.serverNowMs);
    onlineRoom = response.room;
    syncOnlinePeers(onlineRoom);
    if (onlineRoom.status === 'finished' || report.playerId === onlinePlayer.id) appMode = 'onlineResults';
    onlineError = null;
  } catch (error) {
    onlineError = onlineErrorText(error);
    onlineHostCommittedEliminations.delete(report.playerId);
    onFailure?.();
  }
}

function maybeStartOnlineRun(): void {
  if (!onlineRoom?.startsAtServerMs || onlineRunStarted) return;
  if (onlineNowMs() < onlineRoom.startsAtServerMs) return;
  onlineRunStarted = true;
  onlineResultSubmitted = false;
  onlineAttackSequence = 0;
  onlineAppliedAttackIds = new Set();
  onlineHostAuthority = isOnlineHost() && onlineRoom
    ? new HostAuthoritySimulator(onlineRoom.seed, battleRulesFromSettings(inputSettings))
    : null;
  onlineHostProgressInFlight = new Set();
  onlineHostLastProgressAt = new Map();
  onlineHostCommittedEliminations = new Set();
  onlineLastAuthoritativeFrame = 0;
  onlineInputSequence = 0;
  onlineInputOutbox = [];
  onlineLastProgressAt = 0;
  onlineLastPeerBroadcastAt = 0;
  syncHostAuthorityPlayers();
  startNewRun(onlineRoom.seed, 'onlinePlaying');
}

function syncOnlinePeers(room: OnlineRoom): void {
  if (!('RTCPeerConnection' in window)) return;
  onlinePeerBroadcaster ??= new OnlinePeerBroadcaster({
    playerId: onlinePlayer.id,
    sendSignal: (signal) => {
      if (!onlineRoom) return;
      void onlineClient.sendPeerSignal({
        roomId: onlineRoom.id,
        fromPlayerId: onlinePlayer.id,
        toPlayerId: signal.toPlayerId,
        type: signal.type,
        data: signal.data,
      }).then((response) => {
        syncOnlineClock(response.serverNowMs);
        onlineRoom = response.room;
      }).catch((error) => {
        onlineError = onlineErrorText(error);
      });
    },
    onSnapshot: (remoteId, playerId, game) => applyAuthoritativeSnapshot(remoteId, playerId, game),
    onAttack: (remoteId, attack) => {
      if (!onlineRoom || remoteId !== onlineRoom.hostPlayerId || attack.authorityPlayerId !== onlineRoom.hostPlayerId) return;
      applyOnlineAttack({
        id: attack.attackId,
        roomId: onlineRoom.id,
        authorityPlayerId: attack.authorityPlayerId,
        fromPlayerId: attack.fromPlayerId,
        toPlayerId: attack.toPlayerId,
        lines: attack.lines,
        holeSeed: attack.holeSeed,
        frame: attack.frame,
        createdAtServerMs: onlineNowMs(),
      });
    },
    onInput: (remoteId, message) => {
      if (!isOnlineHost() || remoteId !== message.playerId) return;
      onlineHostAuthority?.pushInputs(message.playerId, message.inputs);
    },
    onKo: (remoteId, message) => {
      if (remoteId !== message.playerId) return;
      if (isOnlineHost()) return;
      if (!onlineRoom || remoteId !== onlineRoom.hostPlayerId) return;
      applyPeerKo(message);
    },
    onPeerState: (playerId, state) => {
      onlinePeerStates = new Map(onlinePeerStates).set(playerId, state);
    },
  });
  onlinePeerBroadcaster.syncRoom(room);
}

function broadcastOnlineSnapshot(state: GameState): void {
  if (!isOnlineHost()) return;
  const snapshot = createOnlineGameSnapshot(state);
  onlineLastPeerBroadcastAt = performance.now();
  onlinePeerBroadcaster?.broadcastSnapshot(onlinePlayer.id, snapshot);
  applyPeerSnapshot(onlinePlayer.id, onlinePlayer.id, snapshot);
  for (const player of onlineRoom?.players ?? []) {
    if (player.id === onlinePlayer.id) continue;
    const remoteState = onlineHostAuthority?.getState(player.id);
    const remoteSnapshot = onlineHostAuthority?.getSnapshot(player.id);
    if (remoteState && remoteSnapshot) {
      onlinePeerBroadcaster?.broadcastSnapshot(player.id, createOnlineGameSnapshotFromState(
        remoteState,
        remoteSnapshot,
        onlineHostAuthority?.getLastProcessedInputSequence(player.id) ?? 0,
      ));
    }
  }
}

function applyAuthoritativeSnapshot(remoteId: string, playerId: string, game: OnlineGameSnapshot): void {
  if (!onlineRoom) return;
  if (isOnlineHost()) return;
  if (remoteId !== onlineRoom.hostPlayerId) return;
  if (playerId === onlinePlayer.id) reconcileLocalEngine(game);
  applyPeerSnapshot(remoteId, playerId, game);
}

function reconcileLocalEngine(game: OnlineGameSnapshot): void {
  const snapshot = game.engine;
  if (!snapshot || appMode !== 'onlinePlaying') return;
  if (snapshot.frame <= onlineLastAuthoritativeFrame) return;

  const targetFrame = Math.max(gameFrame, snapshot.frame);
  const acknowledgedSequence = game.lastProcessedInputSequence ?? 0;
  onlineLastAuthoritativeFrame = snapshot.frame;
  onlineInputOutbox = onlineInputOutbox.filter((input) => input.sequence > acknowledgedSequence);
  if (!shouldReconcileLocalEngineSnapshot(engine.getState(), game, onlineInputOutbox.length)) return;

  try {
    engine.restoreSnapshot(snapshot);
  } catch (error) {
    onlineError = onlineErrorText(error);
    return;
  }

  gameFrame = snapshot.frame;
  resimulateLocalPrediction(targetFrame, acknowledgedSequence);
}

function resimulateLocalPrediction(targetFrame: number, acknowledgedSequence: number): void {
  const pendingInputs = onlineInputOutbox
    .filter((input) => input.sequence > acknowledgedSequence)
    .map((input) => ({
      ...input,
      frame: frameForPendingInputReplay(input, onlineLastAuthoritativeFrame),
    }));

  let state = engine.getState();
  for (let frame = gameFrame + 1; frame <= targetFrame && canAdvanceGame(appMode, state.status); frame += 1) {
    const inputs = pendingInputs.filter((input) => input.frame === frame);
    state = engine.tick(frame, inputs);
    engine.drainEvents();
    gameFrame = frame;
  }
  lastPieces = state.stats.pieces;
  lastLines = state.stats.lines;
  lastStatus = state.status;
}

function applyPeerSnapshot(_remoteId: string, playerId: string, game: OnlineGameSnapshot): void {
  if (!onlineRoom) return;
  onlineRoom = {
    ...onlineRoom,
    players: onlineRoom.players.map((player) => player.id === playerId ? { ...player, game } : player),
  };
}

function postHostSimulatedProgress(playerId: string, state: GameState): void {
  if (!onlineRoom || !isOnlineHost()) return;
  const now = performance.now();
  if (onlineHostProgressInFlight.has(playerId)) return;
  if (now - (onlineHostLastProgressAt.get(playerId) ?? 0) < ONLINE_POLL_MS) return;

  onlineHostProgressInFlight.add(playerId);
  onlineHostLastProgressAt.set(playerId, now);
  const progress = createProgressRequest(playerId, createOnlineGameSnapshotFromState(
    state,
    onlineHostAuthority?.getSnapshot(playerId) ?? undefined,
    onlineHostAuthority?.getLastProcessedInputSequence(playerId) ?? 0,
  ));
  void onlineClient.updateProgress(progress)
    .then((response) => {
      syncOnlineClock(response.serverNowMs);
      onlineRoom = response.room;
      syncOnlinePeers(onlineRoom);
      onlineError = null;
    })
    .catch((error) => {
      onlineError = onlineErrorText(error);
    })
    .finally(() => {
      onlineHostProgressInFlight.delete(playerId);
    });
}

function applyPeerKo(message: Pick<OnlinePeerKoMessage, 'playerId' | 'frame' | 'elapsedFrames' | 'game'>): void {
  const { playerId, frame } = message;
  if (!onlineRoom || playerId === onlinePlayer.id) return;
  onlineRoom = {
    ...onlineRoom,
    players: onlineRoom.players.map((player) => player.id === playerId
      ? {
        ...player,
        status: 'eliminated',
        alive: false,
        elapsedFrames: Math.max(player.elapsedFrames, message.elapsedFrames ?? frame),
        eliminatedAtFrame: frame,
        eliminatedAtServerMs: player.eliminatedAtServerMs ?? onlineNowMs(),
        game: message.game ?? player.game,
      }
      : player),
  };
}

function applyRoomAttacks(room: OnlineRoom): void {
  for (const attack of room.attacks ?? []) applyOnlineAttack(attack);
}

function applyOnlineAttack(attack: OnlineAttack): void {
  if (!onlineRoom || attack.authorityPlayerId !== onlineRoom.hostPlayerId) return;
  if (attack.toPlayerId !== onlinePlayer.id || onlineAppliedAttackIds.has(attack.id)) return;
  onlineAppliedAttackIds.add(attack.id);
  engine.queueGarbage(attack.lines, attack.holeSeed, gameFrame, attack.id);
}

function syncOnlineVisibilityChange(): void {
  if (document.hidden) {
    syncOnlineBackground();
    return;
  }
  if (!onlineRoom) return;
  syncOnline(engine.getState());
}

function syncOnlineBackground(): void {
  if (!document.hidden || !onlineRoom) return;
  if (!['roomLobby', 'onlineCountdown', 'onlinePlaying', 'onlineResults'].includes(appMode)) return;

  let state = engine.getState();
  if (appMode === 'onlinePlaying') {
    if (!pendingConfirmAction && canAdvanceGame(appMode, state.status)) {
      state = advanceGameToFrame(targetGameplayFrame(), []);
    } else {
      syncGameplayClockToCurrentFrame();
    }
  }
  syncOnline(state);
}

function createOnlineGameSnapshot(state: GameState): OnlineGameSnapshot {
  return createOnlineGameSnapshotFromState(state, engine.createSnapshot());
}

function createOnlineGameSnapshotFromState(
  state: GameState,
  engineSnapshot?: GameEngineSnapshot,
  lastProcessedInputSequence?: number,
): OnlineGameSnapshot {
  return {
    board: state.board.map((row) => [...row]),
    active: state.active ? { ...state.active } : null,
    visibleRows: Math.min(BATTLE_RULES.visibleRows, state.board.length),
    boardWidth: state.board[0]?.length ?? BATTLE_RULES.boardWidth,
    elapsedFrames: displayedElapsedFrames(state.stats),
    status: state.status,
    lines: state.stats.lines,
    pieces: state.stats.pieces,
    sentGarbage: state.stats.sentGarbage,
    receivedGarbage: state.stats.receivedGarbage,
    pendingGarbage: state.stats.pendingGarbage,
    engine: engineSnapshot,
    lastProcessedInputSequence,
  };
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
    ${appMode === 'onlinePlaying' ? renderOnlinePlayingOverlay() : ''}
    ${renderScreenOverlay(state)}
    ${renderTouchControls()}
  `;
  if (html !== lastOverlayHtml) {
    const focusSnapshot = captureOverlayFieldFocus();
    overlayElement.innerHTML = html;
    lastOverlayHtml = html;
    restoreOverlayFieldFocus(focusSnapshot);
  }
  if (appMode === 'replayPlayback' && playback) updateReplayOverlay(playback.snapshot());
}

type OverlayFieldFocusSnapshot = {
  source: 'online' | 'custom';
  field: string;
  selectionStart: number | null;
  selectionEnd: number | null;
};

function captureOverlayFieldFocus(): OverlayFieldFocusSnapshot | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) && !(active instanceof HTMLSelectElement)) return null;
  const onlineField = active.dataset.onlineField;
  const customField = active.dataset.customSetting;
  const source = onlineField ? 'online' : customField ? 'custom' : null;
  const field = onlineField ?? customField;
  if (!field || !source) return null;
  return {
    source,
    field,
    selectionStart: active instanceof HTMLInputElement ? active.selectionStart : null,
    selectionEnd: active instanceof HTMLInputElement ? active.selectionEnd : null,
  };
}

function restoreOverlayFieldFocus(snapshot: OverlayFieldFocusSnapshot | null): void {
  if (!snapshot) return;
  const field = Array.from(overlayElement.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-online-field], [data-custom-setting]'))
    .find((candidate) => (
      snapshot.source === 'online'
        ? candidate.dataset.onlineField === snapshot.field
        : candidate.dataset.customSetting === snapshot.field
    ));
  if (!field) return;
  field.focus({ preventScroll: true });
  if (field instanceof HTMLInputElement && snapshot.selectionStart !== null && snapshot.selectionEnd !== null) {
    field.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }
}

function renderScreenOverlay(state: GameState): string {
  if (pendingConfirmAction) return renderConfirmOverlay(pendingConfirmAction);
  if (appMode === 'replayPlayback') return renderReplayOverlayShell();
  if (appMode === 'custom') return renderCustomOverlay();
  if (appMode === 'settings') return renderSettingsOverlay();
  if (appMode === 'library') return renderLibraryOverlay();
  if (appMode === 'onlineMenu') return renderOnlineMenuOverlay();
  if (appMode === 'roomLobby') return renderOnlineLobbyOverlay();
  if (appMode === 'onlineCountdown') return renderOnlineCountdownOverlay();
  if (appMode === 'onlineResults') return renderOnlineResultsOverlay(state);
  if (appMode === 'menu') {
    return renderPanel({
      eyebrow: 'MENU',
      title: 'STACK/40',
      meta: 'Elegí dónde querés jugar, revisar o configurar.',
      actions: [
        ['solo-menu', 'SOLO'],
        ['multiplayer-menu', 'Multi jugador'],
        ['history-menu', 'Historial'],
        ['config-menu', 'config'],
      ],
      actionsClass: 'main-menu-actions',
    });
  }
  if (appMode === 'soloMenu') {
    return renderPanel({
      eyebrow: 'SOLO',
      title: 'Modos solo',
      meta: 'Todos los modos disponibles para jugar local.',
      actions: [
        ['start', '40 líneas'],
        ['custom-open', 'Custom'],
        ['main-menu', 'Volver'],
      ],
      actionsClass: 'mode-menu-actions',
    });
  }
  if (appMode === 'multiplayerMenu') {
    return renderPanel({
      eyebrow: 'MULTI JUGADOR',
      title: 'Multijugador',
      meta: 'Todos los modos disponibles para jugar con otras personas.',
      actions: [
        ['online-open', 'Salas online'],
        ['main-menu', 'Volver'],
      ],
      actionsClass: 'mode-menu-actions',
    });
  }
  if (appMode === 'historyMenu') {
    return renderPanel({
      eyebrow: 'HISTORIAL',
      title: 'Historial',
      meta: 'Replays guardados e importación de partidas.',
      actions: [
        ['replay-library', 'Replay library'],
        ['import-replay', 'Import replay'],
        ['main-menu', 'Volver'],
      ],
      actionsClass: 'mode-menu-actions',
    });
  }
  if (appMode === 'configMenu') {
    return renderPanel({
      eyebrow: 'CONFIG',
      title: 'config',
      meta: 'Configuración disponible del juego.',
      actions: [
        ['settings', 'Input settings'],
        ['main-menu', 'Volver'],
      ],
      actionsClass: 'mode-menu-actions',
    });
  }
  if (appMode === 'paused') {
    const actions: [string, string][] = [
      ['resume', 'Resume'],
      ...(canRetryCurrentRun() ? [['restart', 'Restart'] as [string, string]] : []),
      ['settings', 'Input settings'],
      ['import-replay', 'Import replay'],
      ['export-replay', 'Export replay'],
      ['main-menu', 'Main menu'],
    ];
    return renderPanel({
      eyebrow: 'PAUSED',
      title: formatRunSummary(state),
      meta: 'Run is frozen. Resume keeps the exact board and timer.',
      actions,
    });
  }

  const terminal = terminalLabel(state.status);
  if (!terminal) return '';
  const actions: [string, string][] = [
    ...(canRetryCurrentRun() ? [['restart', 'Restart'] as [string, string]] : []),
    ['export-replay', 'Export replay'],
    ['settings', 'Input settings'],
    ['main-menu', 'Main menu'],
  ];
  return renderPanel({
    eyebrow: terminal,
    title: formatRunSummary(state),
    meta: state.status === 'finished' ? 'Saved if this beats your local best.' : 'The stack topped out.',
    details: renderAdvancedRunStats(currentRunSummary(state)),
    actions,
  });
}

function canRetryCurrentRun(): boolean {
  return currentRunKind !== 'custom' || customSettings.allowRetry;
}

function renderTouchControls(): string {
  if ((appMode !== 'playing' && appMode !== 'onlinePlaying') || pendingConfirmAction) return '';
  if (touchControlsHidden) {
    return `
      <button class="touch-controls-toggle touch-controls-restore" type="button" data-ui-action="toggle-touch-controls">
        Touch controls
      </button>
    `;
  }

  return `
    <nav class="touch-controls" aria-label="Touch controls">
      <div class="touch-cluster touch-cluster-move">
        ${renderTouchButton('moveLeft', 'Left')}
        ${renderTouchButton('moveRight', 'Right')}
        ${renderTouchButton('softDrop', 'Down')}
      </div>
      <div class="touch-cluster touch-cluster-system">
        ${renderTouchButton('hold', 'Hold')}
        ${renderTouchButton('pause', 'Pause')}
        <button class="touch-controls-toggle" type="button" data-ui-action="toggle-touch-controls">Hide</button>
      </div>
      <div class="touch-cluster touch-cluster-actions">
        ${renderTouchButton('rotateCCW', 'CCW')}
        ${renderTouchButton('rotateCW', 'CW')}
        ${renderTouchButton('hardDrop', 'Drop')}
      </div>
    </nav>
  `;
}

function renderTouchButton(action: ControlAction, label: string): string {
  return `
    <button class="touch-button touch-button-${action}" type="button" data-touch-action="${action}" aria-label="${CONTROL_ACTION_LABELS[action]}">
      ${label}
    </button>
  `;
}

function requestRunConfirmation(action: DestructiveRunAction): void {
  pendingConfirmAction = action;
  bindingCapture = null;
  input.releaseAll();
}

function cancelPendingConfirmation(): void {
  pendingConfirmAction = null;
  bindingCapture = null;
  if (canAdvanceGame(appMode, engine.getState().status)) syncGameplayClockToCurrentFrame();
  input.releaseAll();
}

function confirmPendingAction(): void {
  const action = pendingConfirmAction;
  pendingConfirmAction = null;
  if (action === 'restart') restartCurrentRun();
  if (action === 'main-menu') goToMenu();
  if (action === 'import-replay') openReplayFilePicker();
  if (action === 'online-leave') leaveOnlineRoom();
  if (canAdvanceGame(appMode, engine.getState().status)) syncGameplayClockToCurrentFrame();
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

function renderOnlineMenuOverlay(): string {
  const publicRooms = onlinePublicRooms.length === 0
    ? '<div class="online-empty">No public rooms yet.</div>'
    : onlinePublicRooms.map((room) => `
      <article class="online-room-row">
        <div>
          <strong>${escapeHtml(room.id)}</strong>
          <span>${escapeHtml(room.hostName)} - ${room.playerCount} player${room.playerCount === 1 ? '' : 's'} - ${escapeHtml(room.status)}</span>
        </div>
        <button type="button" data-ui-action="online-join-public" data-room-id="${escapeHtml(room.id)}">Join</button>
      </article>
    `).join('');
  return `
    <div class="menu-scrim">
      <section class="menu-panel online-panel" aria-label="Online rooms">
        <div class="panel-eyebrow">ONLINE ROOMS</div>
        <h1>Rooms</h1>
        <p>Battle - last player standing. Clears send garbage; top out and you are eliminated.</p>
        ${renderOnlineError()}
        <label class="online-field">
          <span>Name</span>
          <input type="text" maxlength="18" value="${escapeHtml(onlineName)}" data-online-field="name" autocomplete="off" />
        </label>
        <div class="online-create-actions">
          <button type="button" data-ui-action="online-create-private"${onlineBusy ? ' disabled' : ''}>Create private</button>
          <button type="button" data-ui-action="online-create-public"${onlineBusy ? ' disabled' : ''}>Create public</button>
        </div>
        <div class="online-join-row">
          <label class="online-field">
            <span>Room code</span>
            <input type="text" maxlength="4" value="${escapeHtml(onlineJoinCode)}" data-online-field="join-code" autocomplete="off" />
          </label>
          <button type="button" data-ui-action="online-join"${onlineBusy ? ' disabled' : ''}>Join code</button>
        </div>
        <div class="online-public-heading">
          <span>Public rooms</span>
          <button type="button" data-ui-action="online-refresh"${onlineBusy ? ' disabled' : ''}>Refresh</button>
        </div>
        <div class="online-room-list">${publicRooms}</div>
        <div class="panel-actions">
          <button type="button" data-ui-action="main-menu">Back</button>
        </div>
      </section>
    </div>
  `;
}

function renderOnlineLobbyOverlay(): string {
  if (!onlineRoom) return renderOnlineMenuOverlay();
  const player = currentOnlinePlayer();
  const host = onlineRoom.hostPlayerId === onlinePlayer.id;
  const allReady = onlineRoom.players.length > 0 && onlineRoom.players.every((candidate) => candidate.ready);
  return `
    <div class="menu-scrim">
      <section class="menu-panel online-panel" aria-label="Online lobby">
        <div class="panel-eyebrow">${onlineRoom.visibility.toUpperCase()} ROOM</div>
        <h1>${escapeHtml(onlineRoom.id)}</h1>
        <p>${host ? 'You are host.' : 'Waiting for host.'} Battle mode: survive, send garbage, and be the last player standing.</p>
        ${renderOnlineError()}
        <div class="online-lobby-list">${onlineRoom.players.map(renderLobbyPlayer).join('')}</div>
        <div class="panel-actions">
          ${player?.ready
            ? '<button type="button" data-ui-action="online-unready">Unready</button>'
            : '<button type="button" data-ui-action="online-ready">Ready</button>'}
          ${host ? `<button type="button" data-ui-action="online-start"${allReady && !onlineBusy ? '' : ' disabled'}>Start</button>` : ''}
          <button type="button" data-ui-action="online-leave">Leave</button>
        </div>
      </section>
    </div>
  `;
}

function renderOnlineCountdownOverlay(): string {
  if (!onlineRoom?.startsAtServerMs) return renderOnlineLobbyOverlay();
  const remainingMs = Math.max(0, onlineRoom.startsAtServerMs - onlineNowMs());
  return `
    <div class="menu-scrim">
      <section class="menu-panel online-panel online-countdown" aria-label="Online countdown">
        <div class="panel-eyebrow">BATTLE START</div>
        <h1>${Math.ceil(remainingMs / 1000)}</h1>
        <p>Room ${escapeHtml(onlineRoom.id)} starts from seed ${onlineRoom.seed}. Last player standing wins.</p>
      </section>
    </div>
  `;
}

function renderOnlineResultsOverlay(state: GameState): string {
  const ownSummary = terminalLabel(state.status)
    ? `<div class="panel-note">${escapeHtml(formatRunSummary(state, appMode === 'onlineResults' || appMode === 'onlinePlaying'))}</div>`
    : '';
  const winner = onlineRoom?.players.find((player) => player.status === 'winner' || player.id === onlineRoom?.winnerPlayerId);
  return `
    <div class="menu-scrim">
      <section class="menu-panel online-panel" aria-label="Online results">
        <div class="panel-eyebrow">ONLINE RESULTS</div>
        <h1>${onlineRoom ? escapeHtml(onlineRoom.id) : 'Room'}</h1>
        <p>${winner ? `${escapeHtml(winner.name)} wins. ` : ''}Ranking is based on survival, then elapsed frames.</p>
        ${ownSummary}
        ${renderOnlineStandings()}
        <div class="panel-actions">
          <button type="button" data-ui-action="online-leave">Main menu</button>
        </div>
      </section>
    </div>
  `;
}

function renderOnlinePlayingOverlay(): string {
  if (!onlineRoom) return '';
  return `
    <aside class="online-race-panel" aria-label="Online race status">
      <div class="panel-eyebrow">ROOM ${escapeHtml(onlineRoom.id)}</div>
      <div class="online-battle-meta">${escapeHtml(onlineAliveText())}</div>
      ${renderIncomingGarbage()}
      ${renderOnlineStandings()}
      ${renderOnlinePeerBoards()}
      <button type="button" data-ui-action="online-leave">Leave</button>
    </aside>
  `;
}

function renderOnlineStandings(): string {
  if (!onlineRoom) return '<div class="online-empty">No room state.</div>';
  return `
    <div class="online-standings">
      ${rankPlayers(onlineRoom.players).map((player, index) => `
        <div class="online-standing-row ${player.id === onlinePlayer.id ? 'online-standing-self' : ''}">
          <span>${index + 1}</span>
          <strong>${escapeHtml(player.name)}</strong>
          <em>${escapeHtml(formatOnlinePlayerState(player))}</em>
          <b>${player.sentGarbage}G</b>
        </div>
      `).join('')}
    </div>
  `;
}

function onlineAliveText(): string {
  if (!onlineRoom) return 'Alive 0/0';
  const alive = onlineRoom.players.filter((player) => player.alive && player.status !== 'eliminated').length;
  return `Alive ${alive}/${onlineRoom.players.length}`;
}

function renderIncomingGarbage(): string {
  const pending = engine.getState().stats.pendingGarbage;
  const capped = Math.min(12, pending);
  return `
    <div class="online-garbage-meter" aria-label="Incoming garbage">
      <span>Incoming</span>
      <strong>${pending}</strong>
      <div>${Array.from({ length: 12 }, (_, index) => `<i class="${index < capped ? 'online-garbage-cell-active' : ''}"></i>`).join('')}</div>
    </div>
  `;
}

function renderLobbyPlayer(player: OnlinePlayer): string {
  return `
    <div class="online-lobby-player ${player.id === onlinePlayer.id ? 'online-standing-self' : ''}">
      <strong>${escapeHtml(player.name)}${player.id === onlineRoom?.hostPlayerId ? ' HOST' : ''}</strong>
      <span>${player.ready ? 'Ready' : 'Not ready'}</span>
    </div>
  `;
}

function renderOnlinePeerBoards(): string {
  if (!onlineRoom) return '';
  const remotePlayers = onlineRoom.players.filter((player) => player.id !== onlinePlayer.id);
  if (remotePlayers.length === 0) return '<div class="online-empty">Waiting for another board.</div>';
  return `
    <div class="online-peer-boards" aria-label="Remote player boards">
      ${remotePlayers.map(renderOnlinePeerBoard).join('')}
    </div>
  `;
}

function renderOnlinePeerBoard(player: OnlinePlayer): string {
  const peerState = onlinePeerStates.get(player.id) ?? 'server';
  const stateLabel = player.game ? `${formatFrames(player.game.elapsedFrames)} - ${peerState}` : peerState;
  return `
    <section class="online-peer-board">
      <div class="online-peer-board-head">
        <strong>${escapeHtml(player.name)}</strong>
        <span>${escapeHtml(stateLabel)}</span>
      </div>
      ${player.game ? renderOnlineMiniBoard(player.game) : '<div class="online-mini-board online-mini-board-empty">No board yet</div>'}
    </section>
  `;
}

function renderOnlineMiniBoard(snapshot: OnlineGameSnapshot): string {
  const cells = onlineVisibleCells(snapshot);
  const columns = Math.max(1, snapshot.boardWidth);
  return `
    <div class="online-mini-board" style="grid-template-columns: repeat(${columns}, minmax(0, 1fr));">
      ${cells.map((cell) => `<span class="online-mini-cell online-mini-cell-${cell ?? 'empty'}"></span>`).join('')}
    </div>
  `;
}

function onlineVisibleCells(snapshot: OnlineGameSnapshot): (string | null)[] {
  const hiddenRows = Math.max(0, snapshot.board.length - snapshot.visibleRows);
  const board = Array.from({ length: snapshot.visibleRows }, (_, y) => {
    const sourceRow = snapshot.board[y + hiddenRows] ?? [];
    return Array.from({ length: snapshot.boardWidth }, (_, x) => sourceRow[x] ?? null);
  });
  if (snapshot.active) {
    for (const cell of cellsFor(snapshot.active.type, snapshot.active.rotation)) {
      const x = snapshot.active.x + cell.x;
      const y = snapshot.active.y + cell.y - hiddenRows;
      if (y >= 0 && y < board.length && x >= 0 && x < snapshot.boardWidth) {
        board[y][x] = snapshot.active.type;
      }
    }
  }
  return board.flat();
}

function renderOnlineError(): string {
  return onlineError ? `<div class="panel-note panel-error">${escapeHtml(onlineError)}</div>` : '';
}

function confirmTitle(action: DestructiveRunAction): string {
  if (action === 'restart') return 'Restart run?';
  if (action === 'main-menu') return 'Exit run?';
  if (action === 'online-leave') return 'Leave online room?';
  return 'Import replay and abandon current run?';
}

function confirmMeta(action: DestructiveRunAction): string {
  if (action === 'import-replay') return 'The current board and timer will be discarded if a replay is loaded.';
  if (action === 'online-leave') return 'Your local online run will stop on this device.';
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
        <span>${entry.inputsPerPiece.toFixed(2)} IPP</span>
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
        <div><dt>LPM</dt><dd>${entry.linesPerMinute.toFixed(1)}</dd></div>
        <div><dt>Inputs</dt><dd>${entry.inputCount}</dd></div>
        <div><dt>IPP</dt><dd>${entry.inputsPerPiece.toFixed(2)}</dd></div>
      </dl>
      ${renderSplitList(entry.splits)}
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

function renderCustomOverlay(): string {
  const exported = lastCustomExportName ? `<div class="panel-note">Exported ${escapeHtml(lastCustomExportName)}</div>` : '';
  return `
    <div class="menu-scrim custom-scrim">
      <section class="menu-panel custom-panel" aria-label="Custom mode">
        <div class="custom-header">
          <div>
            <div class="panel-eyebrow">CUSTOM</div>
            <h1>Custom</h1>
            <p>PLAY AS YOU WISH. REPLAYS ARE NOT SUBMITTED.</p>
          </div>
          <button type="button" data-ui-action="custom-export">Export settings</button>
        </div>
        <div class="custom-start-row">
          <div class="custom-music">MUSIC RANDOM: CALM</div>
          <button class="custom-start-button" type="button" data-ui-action="custom-start">Start</button>
        </div>
        <div class="custom-tabs" aria-label="Custom sections">
          ${CUSTOM_TABS.map((tab) => `
            <button class="${customTab === tab ? 'custom-tab-active' : ''}" type="button" data-ui-action="custom-tab" data-tab="${tab}">
              ${tab.toUpperCase()}
            </button>
          `).join('')}
        </div>
        <div class="custom-tab-body">
          ${renderCustomTabBody()}
        </div>
        ${exported}
        <div class="panel-actions custom-actions">
          <button type="button" data-ui-action="custom-back">Back</button>
          <button type="button" data-ui-action="custom-reset">Reset defaults</button>
        </div>
      </section>
    </div>
  `;
}

function renderCustomTabBody(): string {
  if (customTab === 'objective') {
    return [
      renderCustomSection('OBJECTIVE', [
        renderCustomSelect('Mode', 'objectiveMode', [['none', 'NONE'], ['lines', 'LINES']]),
        renderCustomNumber('Line target', 'objectiveLineTarget'),
      ]),
    ].join('');
  }
  if (customTab === 'meta') {
    return [
      renderCustomSection('META', [
        renderCustomSelect('Music', 'musicMode', [['random-calm', 'RANDOM: CALM']]),
        renderCustomStaticRow('Replay submission', 'OFF'),
      ]),
    ].join('');
  }
  return [
    renderCustomSection('GENERAL', [
      renderCustomSelect('Random bag type', 'randomBagType', [['7-bag', '7-BAG']]),
      renderCustomSelect('Allowed spins', 'allowedSpins', [['all-mini-plus', 'ALL-MINI+']]),
      renderCustomSelect('Combo table', 'comboTable', [['multiplier', 'MULTIPLIER']]),
      renderCustomToggle('Enable all clears', 'enableAllClears'),
      renderCustomToggle('Use random seed', 'useRandomSeed'),
      renderCustomNumber('Seed', 'seed'),
      renderCustomToggle('Allow retry', 'allowRetry'),
      renderCustomNumber('Stock', 'stock'),
      renderCustomToggle('Enable clutch clears', 'enableClutchClears'),
      renderCustomToggle('Disable lockout', 'disableLockout'),
      renderCustomNumber('Board width', 'boardWidth'),
      renderCustomNumber('Board height', 'boardHeight'),
    ]),
    renderCustomSection('SURVIVAL', [
      renderCustomSelect('Mode', 'survivalMode', [['none', 'NONE']]),
      renderCustomNumber('Garbage messiness %', 'garbageMessinessPercent'),
      renderCustomNumber('Garbage cap', 'garbageCap'),
      renderCustomNumber('Layer height', 'layerHeight'),
      renderCustomToggle('Sticky layer', 'stickyLayer'),
      renderCustomNumber('Minimum layer height', 'minimumLayerHeight'),
      renderCustomNumber('Timer interval', 'timerIntervalSeconds'),
    ]),
    renderCustomSection('CONTROLS', [
      renderCustomToggle('Allow 180 spins', 'allow180Spins'),
      renderCustomSelect('Kick table', 'kickTable', [['srs-plus', 'SRS+']]),
      renderCustomToggle('Use hard drop', 'useHardDrop'),
      renderCustomToggle('Use next queue', 'useNextQueue'),
      renderCustomToggle('Use hold queue', 'useHoldQueue'),
      renderCustomNumber('Next pieces', 'nextPieces'),
      renderCustomToggle('Infinite movement', 'infiniteMovement'),
      renderCustomToggle('Infinite hold', 'infiniteHold'),
      renderCustomToggle('Show shadow piece', 'showShadowPiece'),
      renderCustomNumber('ARE', 'areFrames'),
      renderCustomNumber('Line clear ARE', 'lineClearAreFrames'),
    ]),
    renderCustomSection('GRAVITY & LEVELLING', [
      renderCustomNumber('Gravity', 'gravity'),
      renderCustomToggle('Use levelling', 'useLevelling'),
      renderCustomToggle('Use master levels', 'useMasterLevels'),
      renderCustomNumber('Starting level', 'startingLevel'),
      renderCustomNumber('Level speed', 'levelSpeed'),
      renderCustomToggle('Use static levelling', 'useStaticLevelling'),
      renderCustomNumber('Level static speed', 'levelStaticSpeed'),
      renderCustomNumber('Base gravity', 'baseGravity'),
      renderCustomNumber('Gravity increase', 'gravityIncrease'),
      renderCustomNumber('Lock delay', 'lockDelayFrames'),
    ]),
  ].join('');
}

function renderCustomSection(title: string, rows: string[]): string {
  return `
    <section class="custom-section" aria-label="${escapeHtml(title)}">
      <h2>${escapeHtml(title)}</h2>
      <div class="custom-rows">${rows.join('')}</div>
    </section>
  `;
}

function renderCustomSelect(
  label: string,
  key: keyof Pick<CustomSettings, 'randomBagType' | 'allowedSpins' | 'comboTable' | 'survivalMode' | 'kickTable' | 'objectiveMode' | 'musicMode'>,
  options: [string, string][],
): string {
  const value = String(customSettings[key]);
  return renderCustomRow(label, `
    <select data-custom-setting="${key}">
      ${options.map(([optionValue, optionLabel]) => `
        <option value="${escapeHtml(optionValue)}"${value === optionValue ? ' selected' : ''}>${escapeHtml(optionLabel)}</option>
      `).join('')}
    </select>
  `);
}

function renderCustomToggle(
  label: string,
  key: keyof Pick<CustomSettings,
    | 'enableAllClears'
    | 'useRandomSeed'
    | 'allowRetry'
    | 'enableClutchClears'
    | 'disableLockout'
    | 'stickyLayer'
    | 'allow180Spins'
    | 'useHardDrop'
    | 'useNextQueue'
    | 'useHoldQueue'
    | 'infiniteMovement'
    | 'infiniteHold'
    | 'showShadowPiece'
    | 'useLevelling'
    | 'useMasterLevels'
    | 'useStaticLevelling'
  >,
): string {
  const enabled = customSettings[key];
  return renderCustomRow(label, `
    <button class="custom-toggle ${enabled ? 'custom-toggle-on' : 'custom-toggle-off'}" type="button" data-ui-action="custom-toggle" data-setting="${key}">
      ${enabled ? 'ON' : 'OFF'}
    </button>
  `);
}

function renderCustomNumber(label: string, key: keyof CustomSettings): string {
  if (!isCustomNumberSetting(key)) return '';
  const meta = CUSTOM_NUMBER_SETTING_META[key];
  const value = customSettings[key];
  const step = formatCustomNumber(meta.step);
  return renderCustomRow(label, `
    <div class="custom-number-control">
      <button type="button" data-ui-action="custom-step" data-setting="${key}" data-delta="-${step}" aria-label="${escapeHtml(label)} down">-</button>
      <input type="number" data-custom-setting="${key}" value="${escapeHtml(formatCustomNumber(value))}" min="${formatCustomNumber(meta.min)}" max="${formatCustomNumber(meta.max)}" step="${step}" inputmode="decimal" />
      <button type="button" data-ui-action="custom-step" data-setting="${key}" data-delta="${step}" aria-label="${escapeHtml(label)} up">+</button>
    </div>
  `);
}

function renderCustomStaticRow(label: string, value: string): string {
  return renderCustomRow(label, `<strong class="custom-static-value">${escapeHtml(value)}</strong>`);
}

function renderCustomRow(label: string, control: string): string {
  return `
    <div class="custom-row">
      <label>${escapeHtml(label)}</label>
      <div class="custom-control">${control}</div>
    </div>
  `;
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
  details?: string;
  actions: [string, string][];
  actionsClass?: string;
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
        ${options.details ?? ''}
        ${exported}
        ${importError}
        <div class="panel-actions ${options.actionsClass ?? ''}">${actions}</div>
      </section>
    </div>
  `;
}

function currentRunSummary(state: GameState): RunSummary {
  return createRunSummary({
    result: {
      lines: state.stats.lines,
      pieces: state.stats.pieces,
      frame: state.stats.frame,
      finishFrame: state.stats.finishFrame,
      gameOverFrame: state.stats.gameOverFrame,
    },
    inputs: replay.inputs,
    splits: runSplitTracker.getSplits(),
  });
}

function renderAdvancedRunStats(summary: RunSummary): string {
  return `
    <div class="run-stats-grid" aria-label="Run stats">
      <div><span>PPS</span><strong>${summary.pps.toFixed(2)}</strong></div>
      <div><span>IPP</span><strong>${summary.inputsPerPiece.toFixed(2)}</strong></div>
      <div><span>LPM</span><strong>${summary.linesPerMinute.toFixed(1)}</strong></div>
      <div><span>Inputs</span><strong>${summary.inputCount}</strong></div>
    </div>
    ${renderSplitList(summary.splits)}
  `;
}

function renderSplitList(splits: LineSplit[]): string {
  if (splits.length === 0) return '<div class="split-list split-list-empty">No 10-line split yet.</div>';
  return `
    <div class="split-list" aria-label="Line splits">
      ${splits.map((split) => `
        <div>
          <span>${split.lines}L</span>
          <strong>${escapeHtml(formatFrames(split.elapsedFrames))}</strong>
        </div>
      `).join('')}
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

function formatRunSummary(state: GameState, battle = false): string {
  const elapsedFrames = displayedElapsedFrames(state.stats);
  if (battle) {
    return `${formatFrames(elapsedFrames)} survived - ${state.stats.lines} lines - ${state.stats.sentGarbage} sent`;
  }
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

function rulesForRun(mode: AppMode, runKind: RunKind): GameRules {
  if (mode === 'onlinePlaying') return battleRulesFromSettings(inputSettings);
  if (runKind === 'custom') return customRulesFromSettings(customSettings, inputSettings);
  return rulesFromSettings(inputSettings);
}

function battleRulesFromSettings(settings: InputSettings): GameRules {
  return {
    ...BATTLE_RULES,
    dasFrames: settings.dasFrames,
    arrFrames: settings.arrFrames,
  };
}

function parseControlAction(value: string | undefined): ControlAction | null {
  if (!value) return null;
  return CONTROL_ACTIONS.includes(value as ControlAction) ? value as ControlAction : null;
}

function touchSourceId(pointerId: number): string {
  return `touch:${pointerId}`;
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

function isOnlineHost(): boolean {
  return onlineRoom?.hostPlayerId === onlinePlayer.id;
}

function createProgressRequest(playerId: string, game: OnlineGameSnapshot): ProgressRequest {
  const player = onlineRoom?.players.find((candidate) => candidate.id === playerId);
  return {
    roomId: onlineRoom?.id ?? '',
    authorityPlayerId: onlinePlayer.id,
    playerId,
    lines: normalizeProgressInteger(game.lines, player?.lines ?? 0),
    pieces: normalizeProgressInteger(game.pieces, player?.pieces ?? 0),
    elapsedFrames: normalizeProgressInteger(game.elapsedFrames, player?.elapsedFrames ?? 0),
    sentGarbage: normalizeProgressInteger(game.sentGarbage, player?.sentGarbage ?? 0),
    receivedGarbage: normalizeProgressInteger(game.receivedGarbage, player?.receivedGarbage ?? 0),
    pendingGarbage: normalizeProgressInteger(game.pendingGarbage, player?.pendingGarbage ?? 0),
    game,
  };
}

function createOnlineKoReport(playerId: string, state: GameState): Omit<OnlinePeerKoMessage, 'type'> {
  return createOnlineKoReportFromState(playerId, state);
}

function createOnlineKoReportFromState(playerId: string, state: GameState): Omit<OnlinePeerKoMessage, 'type'> {
  const elapsedFrames = displayedElapsedFrames(state.stats);
  return {
    playerId,
    frame: elapsedFrames,
    lines: state.stats.lines,
    pieces: state.stats.pieces,
    elapsedFrames,
    sentGarbage: state.stats.sentGarbage,
    receivedGarbage: state.stats.receivedGarbage,
    pendingGarbage: state.stats.pendingGarbage,
    game: createOnlineGameSnapshotFromState(state),
  };
}

function markOnlinePlayerEliminated(report: Omit<OnlinePeerKoMessage, 'type'>): void {
  if (!onlineRoom) return;
  onlineRoom = {
    ...onlineRoom,
    players: onlineRoom.players.map((player) => player.id === report.playerId
      ? {
        ...player,
        status: 'eliminated',
        ready: true,
        alive: false,
        lines: report.lines,
        pieces: report.pieces,
        elapsedFrames: report.elapsedFrames,
        sentGarbage: report.sentGarbage,
        receivedGarbage: report.receivedGarbage,
        pendingGarbage: report.pendingGarbage,
        eliminatedAtFrame: report.frame,
        eliminatedAtServerMs: onlineNowMs(),
        finishedAtServerMs: onlineNowMs(),
        game: report.game,
      }
      : player),
  };
}

function currentOnlinePlayer(): OnlinePlayer | null {
  return onlineRoom?.players.find((player) => player.id === onlinePlayer.id) ?? null;
}

function formatOnlinePlayerState(player: OnlinePlayer): string {
  if (player.status === 'winner') return `${formatFrames(player.elapsedFrames)} winner`;
  if (player.status === 'eliminated') return `${formatFrames(player.elapsedFrames)} eliminated`;
  if (player.status === 'won') return `${formatFrames(player.elapsedFrames)} clear`;
  if (player.status === 'lost') return `${formatFrames(player.elapsedFrames)} top out`;
  if (player.status === 'disconnected') return 'stale';
  if (player.status === 'ready') return 'ready';
  if (player.status === 'playing') return `${formatFrames(player.elapsedFrames)} alive`;
  return 'joined';
}

function onlineErrorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Online request failed.';
}

function syncOnlineClock(serverNowMs: number): void {
  if (!Number.isFinite(serverNowMs)) return;
  onlineServerOffsetMs = serverNowMs - Date.now();
}

function onlineNowMs(): number {
  return Date.now() + onlineServerOffsetMs;
}

function normalizeProgressInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value as number));
}

function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
