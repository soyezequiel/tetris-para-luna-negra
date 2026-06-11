import './styles.css';
import QRCode from 'qrcode';
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
import { soundCueForRunProgress } from './app/runEffects';
import { nextAutoPlayInput } from './app/autoPlay'; // TRUCO AUTOPLAY
import { createRunSummary, RunSplitTracker, type LineSplit, type RunSummary } from './app/runStats';
import { canAdvanceGame, canCommitLocalOnlineTerminal, gameOverReasonMessage, requiresRunConfirmation, terminalLabel, togglePauseMode, type AppMode, type DestructiveRunAction } from './app/state';
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
  type CustomBooleanSettingKey,
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
import { OnlineApiError, OnlineClient } from './online/client';
import { LunaSocialClient } from './online/lunaNegraFriendsClient';
import { HostAuthoritySimulator, type HostSimulatedPlayer } from './online/hostAuthority';
import { loadOnlinePlayer, saveOnlinePlayer } from './online/playerIdentity';
import { decidePeerKoAction } from './online/peerKoAuthority';
import { OnlinePeerBroadcaster, type OnlinePeerKoMessage } from './online/peerBroadcast';
import { normalizeRoomId, rankPlayers, ROOM_ID_MIN_LENGTH, ROOM_ID_MAX_LENGTH, TARGETING_MODES } from './online/roomService';
import { selectAttackTarget as selectTargetForAttack } from './online/targeting';
import type { AttackRequest, LunaIdentity, LunaLaunchRequest, OnlineAttack, OnlineErrorResponse, OnlineGameSnapshot, OnlineMatchType, OnlinePlayer, OnlineRoom, OnlineRoomMode, OnlineRoomResponse, OnlineRoomSummary, ProgressRequest, PublicRoomsFilters, RoomBet, RoomBetParticipant, RoomVisibility, TargetingMode } from './online/protocol';
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
// Polls consecutivos con 404 (sala borrada del servidor) antes de abandonar la
// sala fantasma: corta el spam infinito de /state y /signal contra una sala que
// ya no existe y devuelve al jugador al menú con un aviso.
const ONLINE_ROOM_GONE_POLL_LIMIT = 5;
const ONLINE_BET_POLL_MS = 2000;
const ONLINE_BET_FAST_POLL_MS = 750;
// Ventana generosa: pagar copiando la invoice en otra app/billetera puede tardar
// minutos. Además, mientras MI depósito siga pendiente se pollea rápido siempre
// (ver maybeRefreshBet); esta ventana cubre los depósitos de los demás.
const ONLINE_BET_FAST_POLL_WINDOW_MS = 180_000;
const ONLINE_PEER_BROADCAST_MS = 100;
// Contenedores con scroll propio que se reconstruyen al regenerar el overlay.
// Sin esto, cada re-render (p. ej. polling de salas/apuestas) reinicia el scroll al tope.
// Debe declararse antes del primer render (loop() al final del módulo) para evitar TDZ.
const SCROLLABLE_OVERLAY_SELECTORS = ['.dash-room', '.dash-layout', '.menu-panel', '.persistent-room-panel'];
const ONLINE_KO_BROADCAST_RETRY_MS = 1000;
const ONLINE_BACKGROUND_SYNC_MS = 1000;
const GAME_FRAME_MS = 1000 / 60;
const AUTO_PLAY_ACCESS_STORAGE = 'stack40.autoplayAccess.v1'; // TRUCO AUTOPLAY

type LibraryFilter = typeof LIBRARY_FILTERS[number];
type RunKind = 'standard' | 'custom' | 'online';
type SequencedOnlineInput = GameInput & { sequence: number };
type PendingLunaLaunchRequest = LunaLaunchRequest & { normalizedRoomId: string };
type StoredOnlineRoomSession = {
  roomId: string;
  playerId: string;
};

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
const lunaSocialClient = new LunaSocialClient();

let best = loadRecord();
let runHistory = loadRunHistory();
let appMode: AppMode = 'menu';
let settingsReturnMode: AppMode = 'menu';
let soloCountdownStartsAtMs = 0;
let lastSoloCountdownSecondPlayed = -1;
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
let runMaxCombo = 0;
let runWasNewBest = false;
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
let autoPlayEnabled = false; // TRUCO AUTOPLAY: el bot juega solo al activarse
let autoPlayAccessGranted = false; // TRUCO AUTOPLAY: habilitado solo con llave local hasheada
let ignoreNextAutoPlayClick = false; // TRUCO AUTOPLAY: pointerdown ya hizo el toggle
let onlinePlayer = loadOnlinePlayer();
let onlineName = onlinePlayer.name;
let onlineJoinCode = '';
let onlineStakeInput = '';
let onlineBetBusy = false;
let onlineLastBetPollAt = 0;
let onlineBetFastPollUntil = 0;
let onlineBetRefreshQueued = false;
let onlineRoom: OnlineRoom | null = null;
let onlinePublicRooms: OnlineRoomSummary[] = [];
let localRunError: string | null = null;
let onlineError: string | null = null;
let onlineBusy = false;
let onlinePollInFlight = false;
let onlineProgressInFlight = false;
let onlineLastPollAt = 0;
let onlineLastProgressAt = 0;
let onlineLastPeerBroadcastAt = 0;
let onlineLastKoBroadcastAt = 0;
let onlineServerOffsetMs = 0;
let onlineResultSubmitted = false;
let onlineRunStarted = false;
let onlinePeerBroadcaster: OnlinePeerBroadcaster | null = null;
let onlinePeerStates = new Map<string, string>();
let onlinePeerDisplaySnapshots = new Map<string, OnlineGameSnapshot>();
let onlineAttackSequence = 0;
let onlineAppliedAttackIds = new Set<string>();
let onlineHostAuthority: HostAuthoritySimulator | null = null;
// true cuando el servidor me migró la autoridad a mitad de ronda (el host
// original se desconectó). Corro como host en "modo degradado": ver
// ensureMigratedHostAuthority().
let onlineHostMigrated = false;
let onlineHostProgressInFlight = new Set<string>();
let onlineHostLastProgressAt = new Map<string, number>();
let onlineHostCommittedEliminations = new Set<string>();
let onlineHostCommittedResults = new Set<string>();
let onlineLastAuthoritativeFrame = 0;
let onlineLastDiagLogAt = 0;
let onlineLastHostSimLogAt = new Map<string, number>();
let onlineInputOutbox: SequencedOnlineInput[] = [];
let onlineActiveRoundId: string | null = null;
let lunaIdentity: LunaIdentity | null = null;
let lunaInviteWindowBusy = false;
let lunaInviteNotice: string | null = null;
let trustedLunaOrigin: string | null = null;
let lunaLaunchPollInFlight = false;
let pendingLunaLaunchRequest: PendingLunaLaunchRequest | null = null;
let ignoredLunaLaunchRequestIds = new Set<string>();
let onlineRoomReopenInFlight = false;
let onlineRoomGonePolls = 0;
// QRs de invoices Lightning, cacheados por bolt11 (el overlay se regenera por HTML).
const betQrDataUrls = new Map<string, string>();
const betQrPending = new Set<string>();

const LUNA_IDENTITY_KEY = 'stack40.lunaIdentity.v1';
const LUNA_ORIGIN_KEY = 'stack40.lunaOrigin.v1';
const LUNA_ENTER_ROOM_MESSAGE_TYPE = 'luna-negra:enter-room';
const LUNA_LOGOUT_MESSAGE_TYPE = 'luna-negra:logout';
const ONLINE_ROOM_SESSION_KEY = 'stack40.onlineRoomSession.v1';
trustedLunaOrigin = loadTrustedLunaOrigin();
// La presencia caduca a los 20s sin heartbeat (ver docs/luna-negra-social-spec.md).
// Latimos cada 10s (la mitad del TTL) para que un jugador activo nunca expire,
// pero SOLO mientras la pestaña está visible: si el jugador cambia de app, minimiza
// o cierra el juego dejamos de latir y a los ~20s deja de figurar "jugando".
const LUNA_PRESENCE_TTL_MS = 20000;
const LUNA_PRESENCE_HEARTBEAT_MS = LUNA_PRESENCE_TTL_MS / 2;
const LUNA_LAUNCH_POLL_MS = 2_000;

const activeTouchInputs = new Map<number, { sourceId: string; control: HTMLElement }>();

const replayFileInput = document.createElement('input');
replayFileInput.type = 'file';
replayFileInput.accept = 'application/json,.json';
replayFileInput.hidden = true;
document.body.appendChild(replayFileInput);

window.addEventListener('keydown', handleGlobalKeyDown, { capture: true });
window.addEventListener('wheel', handleVolumeWheel, { passive: false });
window.addEventListener('message', handleLunaNegraWindowMessage);
window.addEventListener('beforeunload', handleBeforeUnload);
window.setInterval(syncOnlineBackground, ONLINE_BACKGROUND_SYNC_MS);
window.setInterval(() => {
  if (lunaIdentity && isPlayerActivelyPresent()) void syncLunaPresence();
}, LUNA_PRESENCE_HEARTBEAT_MS);
window.setInterval(() => {
  void syncLunaLaunchRequest();
}, LUNA_LAUNCH_POLL_MS);
document.addEventListener('visibilitychange', syncOnlineVisibilityChange);
window.addEventListener('focus', eagerRefreshBetIfPending);
replayFileInput.addEventListener('change', handleReplayFileChange);
overlayElement.addEventListener('click', handleOverlayClick);
overlayElement.addEventListener('input', handleOverlayInput);
overlayElement.addEventListener('change', handleOverlayInput);
overlayElement.addEventListener('pointerdown', handleOverlayPointerDown);
overlayElement.addEventListener('pointerdown', handleTouchControlPointerDown);
overlayElement.addEventListener('pointerup', handleTouchControlPointerEnd);
overlayElement.addEventListener('pointercancel', handleTouchControlPointerEnd);
overlayElement.addEventListener('lostpointercapture', handleTouchControlPointerEnd);

try { autoPlayAccessGranted = localStorage.getItem(AUTO_PLAY_ACCESS_STORAGE) === '1'; } catch { /* noop */ } // TRUCO AUTOPLAY
(window as unknown as Record<string, unknown>)['test'] = () => { // TRUCO AUTOPLAY
  try { localStorage.setItem(AUTO_PLAY_ACCESS_STORAGE, '1'); } catch { /* noop */ }
  autoPlayAccessGranted = true;
  lastOverlayHtml = '';
  console.log('autoplay unlocked');
};

function loop(): void {
  const beforeState = engine.getState();
  const canAdvanceThisLoop = !hasBlockingModal() && canAdvanceGame(appMode, beforeState.status);
  if (!canAdvanceThisLoop) syncGameplayClockToCurrentFrame();
  const candidateFrame = canAdvanceThisLoop ? targetGameplayFrame() : gameFrame;
  input.advanceFrame(candidateFrame);
  const controlInputs = input.collect(candidateFrame);
  const consumedByApp = handleControlInputs(controlInputs);

  if (appMode === 'soloCountdown') {
    updateSoloCountdown();
  }

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
    // TRUCO AUTOPLAY: inyecta la acción del bot como si fuera una tecla más.
    if (autoPlayEnabled) {
      const botAction = nextAutoPlayInput(state);
      if (botAction) gameInputs.push({ frame: candidateFrame, action: botAction });
    }
    sendOnlineInputsToHost(gameInputs);
    playImmediateInputSounds(gameInputs.map((event) => event.action));
    for (const event of gameInputs) recordInput(replay, event);
    state = advanceGameToFrame(candidateFrame, gameInputs);
    playAcceptedMoveSound(beforeTickState.active, state.active, gameInputs.map((event) => event.action));
  }

  syncOnline();
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
    getLunaIdentity: () => lunaIdentity,
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

void bootstrapOnlineStartup();

function targetGameplayFrame(now = performance.now()): number {
  // En online, host y cliente DEBEN compartir la misma línea de tiempo de frames:
  // el host resimula al cliente reproduciendo sus inputs (sellados con el frame del
  // cliente) y aplica garbage por frame. Si cada peer contara frames desde su propio
  // performance.now() local (gameClockOriginMs), el desfase entre relojes —que crece
  // durante la partida por drift entre performance.now() y Date.now()— haría que el
  // host aplicara los inputs en frames distintos a los que el cliente jugó, divergiendo
  // hasta toparlo falsamente y reemplazarle el tablero por reconciliación. Anclamos el
  // frame al reloj del servidor (startsAtServerMs) para que ambos avancen alineados.
  if (appMode === 'onlinePlaying' && onlineRoom?.startsAtServerMs) {
    const serverFrames = Math.floor((onlineNowMs() - onlineRoom.startsAtServerMs) / GAME_FRAME_MS);
    return Math.max(gameFrame + 1, serverFrames);
  }
  const elapsedFrames = Math.floor((now - gameClockOriginMs) / GAME_FRAME_MS);
  return Math.max(gameFrame + 1, elapsedFrames);
}

function syncGameplayClockToCurrentFrame(): void {
  gameClockOriginMs = performance.now() - gameFrame * GAME_FRAME_MS;
}

// Diagnóstico de partidas multijugador. Imprime en consola con prefijo [MP] para
// poder filtrar. Pensado para entender por qué un jugador "muere con espacio": al
// comparar el tablero local del cliente contra el autoritativo del host y el desfase
// de frames, se ve si el host está topando falsamente por divergencia de simulación.
function logMp(event: string, data: Record<string, unknown>): void {
  // Serializamos a string para que la consola imprima TODOS los campos en línea (los
  // objetos anidados se colapsan a "…" y se pierden al copiar/pegar).
  console.log(`[MP ${event}] ${JSON.stringify({ role: isOnlineHost() ? 'host' : 'guest', player: onlinePlayer.id.slice(0, 6), seed: onlineRoom?.seed, ...data })}`);
}

// Métricas baratas de un tablero para los logs: cuántas celdas ocupadas hay y a qué
// altura llega la pila (filas desde la primera fila ocupada hasta el fondo).
function boardMetrics(board: ReadonlyArray<ReadonlyArray<unknown>>): { filled: number; height: number; rows: number } {
  let filled = 0;
  let topRow = -1;
  for (let y = 0; y < board.length; y += 1) {
    const row = board[y];
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] !== null) {
        filled += 1;
        if (topRow === -1) topRow = y;
      }
    }
  }
  return { filled, height: topRow === -1 ? 0 : board.length - topRow, rows: board.length };
}

function advanceGameToFrame(targetFrame: number, finalFrameInputs: GameInput[]): GameState {
  let state = engine.getState();
  for (let frame = gameFrame + 1; frame <= targetFrame && canAdvanceGame(appMode, state.status); frame += 1) {
    const inputs = frame === targetFrame ? finalFrameInputs : [];
    state = engine.tick(frame, inputs);
    gameFrame = frame;
    const events = engine.drainEvents();
    syncRunEffects(state, events);
    syncOnlineBattleEvents(events, state);
  }
  return state;
}

function handleGlobalKeyDown(event: KeyboardEvent): void {
  if (hasBlockingModal() && event.code === 'Escape') {
    if (pendingLunaLaunchRequest) cancelPendingLunaLaunchRequest();
    else cancelPendingConfirmation();
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
    // El nombre ya no se edita acá: siempre se usa el que da Luna Negra.
    if (field === 'join-code') onlineJoinCode = normalizeRoomId(target.value);
    if (field === 'bet-stake') onlineStakeInput = target.value.replace(/[^0-9]/g, '').slice(0, 7);
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

function toggleAutoPlay(): void { // TRUCO AUTOPLAY
  if (!autoPlayAccessGranted) return;
  autoPlayEnabled = !autoPlayEnabled;
  input.releaseAll();
}

function handleOverlayPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const control = target.closest<HTMLElement>('[data-ui-action="toggle-autoplay"]');
  if (!control) return;
  toggleAutoPlay();
  ignoreNextAutoPlayClick = true;
  window.setTimeout(() => {
    ignoreNextAutoPlayClick = false;
  }, 500);
  event.preventDefault();
  event.stopPropagation();
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
  if (action === 'toggle-autoplay') { // TRUCO AUTOPLAY
    if (ignoreNextAutoPlayClick) {
      ignoreNextAutoPlayClick = false;
      return;
    }
    toggleAutoPlay();
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
  if (action === 'luna-launch-accept') {
    void acceptPendingLunaLaunchRequest();
    return;
  }
  if (action === 'luna-launch-cancel') {
    cancelPendingLunaLaunchRequest();
    return;
  }
  if (hasBlockingModal()) return;
  if (requiresRunConfirmation(action, appMode, engine.getState().status, settingsReturnMode)) {
    requestRunConfirmation(action);
    return;
  }

  if (action === 'sidebar-play') {
    if (!onlineRoom || !onlineRoomHasOtherPlayers()) {
      openCustomMode();
    } else {
      startOnlineRoom();
    }
    return;
  }

  if (action === 'start') startNewRun();
  if (action === 'restart') restartCurrentRun();
  if (action === 'solo-menu') openModeMenu('soloMenu');
  if (action === 'multiplayer-menu') openOnlineMenu();
  if (action === 'history-menu') openReplayLibrary();
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
  if (action === 'online-custom-open') openOnlineMenu();
  if (action === 'online-refresh') refreshPublicRooms();
  if (action === 'online-room-visibility') setOnlineRoomVisibility(control.dataset.visibility);
  if (action === 'online-visibility-toggle') {
    setOnlineRoomVisibility(onlineRoom?.visibility === 'public' ? 'private' : 'public');
  }
  if (action === 'online-results-menu') {
    closeOnlineResults();
  }
  if (action === 'online-create-public') createOnlineRoom('public');
  if (action === 'online-create-private') createOnlineRoom('private');
  if (action === 'online-join') joinOnlineRoom(onlineJoinCode);
  if (action === 'online-join-public') joinOnlineRoom(control.dataset.roomId ?? '');
  if (action === 'online-ready') setOnlineReady(true);
  if (action === 'online-unready') setOnlineReady(false);
  if (action === 'online-start') startOnlineRoom();
  if (action === 'online-restart') restartOnlineRoom();
  if (action === 'online-bet-create') createOnlineBet();
  if (action === 'online-bet-cancel') cancelOnlineBet();
  if (action === 'online-bet-settle') settleOnlineBet();
  if (action === 'online-bet-refresh') refreshOnlineBet(false);
  if (action === 'online-bet-pay') {
    wakeUpBetDetection();
  }
  if (action === 'online-bet-copy') {
    copyToClipboard(control.dataset.copy ?? '');
    wakeUpBetDetection();
  }
  if (action === 'online-targeting') setOnlineTargeting(control.dataset.targetingMode);
  if (action === 'online-manual-target') setOnlineTargeting('manual', control.dataset.targetPlayerId ?? null);
  if (action === 'online-leave') leaveOnlineRoom();
  if (action === 'online-kick') kickOnlinePlayer(control.dataset.targetPlayerId ?? '');
  if (action === 'online-open-invite') openLunaInviteWindow();
  if (action === 'luna-login') openLunaLogin();
  if (action === 'online-copy-code') {
    copyToClipboard(control.dataset.code ?? '');
  }
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
  if (!control || !action || (appMode !== 'playing' && appMode !== 'onlinePlaying') || touchControlsHidden || hasBlockingModal()) return;

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
  if (hasBlockingModal()) {
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
  if (nextRunKind !== 'online' && onlineRoomHasOtherPlayers()) {
    localRunError = 'No podés jugar modo solo mientras hay otras personas en la sala.';
    input.releaseAll();
    return;
  }
  input.releaseAll();
  bindingCapture = null;
  pendingConfirmAction = null;
  lastExportName = null;
  lastCustomExportName = null;
  replayImportError = null;
  libraryError = null;
  localRunError = null;
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
  runMaxCombo = 0;
  runWasNewBest = false;
  if (nextMode === 'playing') {
    const isE2E = !!(window as any).__E2E__ || navigator.webdriver;
    if (isE2E) {
      appMode = 'playing';
    } else {
      appMode = 'soloCountdown';
      soloCountdownStartsAtMs = performance.now() + 3000;
      lastSoloCountdownSecondPlayed = -1;
    }
  } else {
    appMode = nextMode;
  }
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

async function bootstrapLunaNegraEntry(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const inviteToken = params.get('inviteToken')?.trim() ?? '';
  if (!inviteToken) return;
  const roomId = params.get('room')?.trim() ?? '';
  await enterLunaNegraRoomFromInvite(inviteToken, roomId, { cleanUrl: true });
}

async function enterLunaNegraRoomFromInvite(
  inviteToken: string,
  roomId: string,
  options: { cleanUrl?: boolean } = {},
): Promise<void> {
  appMode = 'onlineMenu';
  settingsReturnMode = 'menu';
  input.releaseAll();
  if (!roomId) {
    onlineError = 'Missing Luna Negra room id.';
    return;
  }
  if (onlineBusy) {
    onlineError = 'Ya hay una acción online en curso.';
    return;
  }
  onlineBusy = true;
  onlineError = null;
  try {
    await leaveCurrentRoomBeforeNew(roomId);
    const response = await onlineClient.enterLunaNegraRoom({ inviteToken, roomId });
    onlinePlayer = saveOnlinePlayer({
      id: response.player.id,
      name: response.player.name,
      avatarUrl: response.player.avatarUrl,
    });
    onlineName = response.player.name;
    const identityFromInvite: LunaIdentity = {
      npub: response.player.npub,
      pubkey: response.player.pubkey,
      name: response.player.name,
      avatarUrl: response.player.avatarUrl,
      gameId: response.room.lunaGameId,
    };
    applyLunaIdentity(identityFromInvite);
    saveStoredLunaIdentity(identityFromInvite);
    syncOnlineClock(response.serverNowMs);
    enterOnlineRoom(response.room, 'roomLobby');
    if (options.cleanUrl) removeLunaNegraTokenFromUrl();
    void syncLunaPresence();
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlineBusy = false;
  }
}

function removeLunaNegraTokenFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('inviteToken');
  url.searchParams.delete('lnOrigin');
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
}

// ─────────────── Login SSO + amigos / presencia de Luna Negra ───────────────

// Orquesta el arranque online: primero resuelve la sesión de Luna Negra (login
// automático al abrir el juego desde Luna Negra), después atiende un invite token
// (sala privada) o un link de invitación de amigo (?join=).
async function bootstrapOnlineStartup(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  rememberTrustedLunaOriginFromStartup(params);
  await bootstrapLunaSession();
  const nextParams = new URLSearchParams(window.location.search);
  if (nextParams.get('inviteToken')?.trim()) {
    await bootstrapLunaNegraEntry();
    return;
  }
  if (nextParams.get('join')?.trim()) {
    await bootstrapJoinLink(nextParams.get('join')!.trim());
    return;
  }
  if (await restoreOnlineRoomSession()) return;
  void refreshPublicRooms();
}

// Login automático. El juego se abre desde Luna Negra con el entitlement JWT en
// ?lnToken= (en desarrollo, ?lnDemo=Nombre). Ese token EXPIRA a los ~5 min y solo
// sirve para canjearlo UNA vez al cargar: lo cambiamos por la identidad (npub,
// nombre, avatar) contra /api/luna-negra/session y PERSISTIMOS LA IDENTIDAD, no el
// token. En recargas posteriores sin token, restauramos la identidad guardada
// (presencia y amigos usan la API key del servidor, no el token del usuario).
async function bootstrapLunaSession(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  // Aceptamos varios nombres por las dudas; el contrato es ?lnToken=<entitlement>.
  const freshToken = (
    params.get('lnToken')?.trim()
    || params.get('entitlement')?.trim()
    || params.get('lnDemo')?.trim()
    || ''
  ).trim();
  if (freshToken) {
    try {
      const response = await lunaSocialClient.resolveSession(freshToken);
      applyLunaIdentity(response.identity);
      saveStoredLunaIdentity(response.identity);
    } catch {
      // Si Luna Negra rechaza un token fresco, la identidad cacheada ya no prueba sesión.
      clearLunaIdentity();
    } finally {
      removeLunaSessionParamsFromUrl();
    }
  } else {
    const stored = loadStoredLunaIdentity();
    if (stored) applyLunaIdentity(stored);
  }
  if (!lunaIdentity) return;
  await syncLunaPresence();
}

function applyLunaIdentity(identity: LunaIdentity): void {
  lunaIdentity = identity;
  onlinePlayer = saveOnlinePlayer({
    ...onlinePlayer,
    id: identity.pubkey || onlinePlayer.id,
    name: identity.name,
    avatarUrl: identity.avatarUrl ?? onlinePlayer.avatarUrl,
  });
  onlineName = onlinePlayer.name;
  void syncLunaLaunchRequest();
}

async function bootstrapJoinLink(roomId: string): Promise<void> {
  openOnlineMenu();
  await joinOnlineRoom(roomId);
  const url = new URL(window.location.href);
  url.searchParams.delete('join');
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
}

async function restoreOnlineRoomSession(): Promise<boolean> {
  const stored = loadOnlineRoomSession();
  if (!stored) return false;
  if (stored.playerId !== onlinePlayer.id) {
    clearOnlineRoomSession();
    return false;
  }

  try {
    const response = await onlineClient.getRoomState(stored.roomId);
    syncOnlineClock(response.serverNowMs);
    if (!response.room.players.some((player) => player.id === onlinePlayer.id)) {
      clearOnlineRoomSession();
      return false;
    }
    enterOnlineRoom(response.room, 'roomLobby');
    void syncLunaPresence();
    return true;
  } catch {
    return false;
  }
}

function loadOnlineRoomSession(): StoredOnlineRoomSession | null {
  try {
    const raw = sessionStorage.getItem(ONLINE_ROOM_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredOnlineRoomSession>;
    const roomId = typeof parsed.roomId === 'string' ? normalizeRoomId(parsed.roomId) : '';
    const playerId = typeof parsed.playerId === 'string' ? parsed.playerId.trim() : '';
    if (!roomId || !playerId) return null;
    return { roomId, playerId };
  } catch {
    return null;
  }
}

function saveOnlineRoomSession(room: OnlineRoom): void {
  if (!room.players.some((player) => player.id === onlinePlayer.id)) {
    clearOnlineRoomSession();
    return;
  }
  try {
    sessionStorage.setItem(ONLINE_ROOM_SESSION_KEY, JSON.stringify({
      roomId: room.id,
      playerId: onlinePlayer.id,
    }));
  } catch {
    // sessionStorage puede estar bloqueado; la sala sigue viva en memoria.
  }
}

function clearOnlineRoomSession(): void {
  try {
    sessionStorage.removeItem(ONLINE_ROOM_SESSION_KEY);
  } catch {
    // Sin sessionStorage no hay nada persistente que limpiar.
  }
}

function loadStoredLunaIdentity(): LunaIdentity | null {
  try {
    const raw = localStorage.getItem(LUNA_IDENTITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LunaIdentity>;
    if (typeof parsed.npub !== 'string' || !parsed.npub) return null;
    return {
      npub: parsed.npub,
      pubkey: typeof parsed.pubkey === 'string' ? parsed.pubkey : null,
      name: typeof parsed.name === 'string' && parsed.name ? parsed.name : parsed.npub.slice(0, 12),
      avatarUrl: typeof parsed.avatarUrl === 'string' ? parsed.avatarUrl : null,
      gameId: typeof parsed.gameId === 'string' ? parsed.gameId : null,
    };
  } catch {
    return null;
  }
}

function saveStoredLunaIdentity(identity: LunaIdentity): void {
  try {
    localStorage.setItem(LUNA_IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // localStorage puede estar bloqueado; la identidad vivirá solo en memoria.
  }
}

function clearStoredLunaIdentity(): void {
  try {
    localStorage.removeItem(LUNA_IDENTITY_KEY);
  } catch {
    // localStorage puede estar bloqueado; limpiamos al menos la identidad en memoria.
  }
}

function clearLunaIdentity(): void {
  lunaIdentity = null;
  lunaInviteNotice = null;
  pendingLunaLaunchRequest = null;
  clearStoredLunaIdentity();
  if (!onlineRoom) {
    onlinePlayer = saveOnlinePlayer({ id: '', name: 'Player', avatarUrl: null });
    onlineName = onlinePlayer.name;
  }
}

function loadTrustedLunaOrigin(): string | null {
  try {
    const origin = localStorage.getItem(LUNA_ORIGIN_KEY);
    return origin && isHttpOrigin(origin) ? origin : null;
  } catch {
    return null;
  }
}

function rememberTrustedLunaOriginFromStartup(params: URLSearchParams): void {
  const hasLunaEntry =
    Boolean(params.get('inviteToken')?.trim())
    || Boolean(params.get('lnToken')?.trim())
    || Boolean(params.get('entitlement')?.trim())
    || Boolean(params.get('lnDemo')?.trim());
  if (!hasLunaEntry) return;

  const origin =
    parseHttpOrigin(params.get('lnOrigin') ?? '')
    ?? parseHttpOrigin(document.referrer);
  if (!origin) return;
  trustedLunaOrigin = origin;
  try {
    localStorage.setItem(LUNA_ORIGIN_KEY, origin);
  } catch {
    // Sin localStorage, el origen queda en memoria para esta pestaña.
  }
}

function handleLunaNegraWindowMessage(event: MessageEvent): void {
  const message = parseLunaWindowMessage(event.data);
  if (!message) return;
  if (!trustedLunaOrigin || event.origin !== trustedLunaOrigin) return;
  if (message.type === LUNA_LOGOUT_MESSAGE_TYPE) {
    clearLunaIdentity();
    return;
  }
  void handleLunaLaunchRequest({
    id: `msg-${Date.now()}`,
    roomId: message.roomId,
    inviteToken: message.inviteToken,
    slug: 'TETRA',
    title: 'TETRA',
    gameUrl: window.location.href,
  });
}

function parseLunaWindowMessage(
  value: unknown,
): { type: typeof LUNA_LOGOUT_MESSAGE_TYPE } | ({ type: typeof LUNA_ENTER_ROOM_MESSAGE_TYPE } & { inviteToken: string; roomId: string }) | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.type === LUNA_LOGOUT_MESSAGE_TYPE) return { type: LUNA_LOGOUT_MESSAGE_TYPE };
  const enterRoom = parseLunaEnterRoomMessage(value);
  return enterRoom ? { type: LUNA_ENTER_ROOM_MESSAGE_TYPE, ...enterRoom } : null;
}

function parseLunaEnterRoomMessage(
  value: unknown,
): { inviteToken: string; roomId: string } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.type !== LUNA_ENTER_ROOM_MESSAGE_TYPE) return null;
  const inviteToken = typeof record.inviteToken === 'string' ? record.inviteToken.trim() : '';
  const roomId = typeof record.roomId === 'string' ? record.roomId.trim() : '';
  if (!inviteToken || !roomId) return null;
  return { inviteToken, roomId };
}

function parseHttpOrigin(value: string): string | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value);
    return isHttpOrigin(url.origin) ? url.origin : null;
  } catch {
    return null;
  }
}

function isHttpOrigin(origin: string): boolean {
  return /^https?:\/\//.test(origin);
}

function removeLunaSessionParamsFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('lnToken');
  url.searchParams.delete('entitlement');
  url.searchParams.delete('lnDemo');
  url.searchParams.delete('lnOrigin');
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
}

// El jugador "está jugando" solo si tiene el juego visible en primer plano. Si
// minimiza, cambia de pestaña/app o cierra el juego dejamos de latir, y al
// caducar el heartbeat (20s) Luna Negra lo deja de mostrar como jugando. Esto
// evita los falsos positivos de "Jugando Tetris" con el juego abierto de fondo.
function isPlayerActivelyPresent(): boolean {
  return document.visibilityState === 'visible';
}

// Reporta que este jugador tiene el juego abierto (online) o está en una sala
// (in-game). Alimenta el orden del panel de amigos de los demás.
async function syncLunaPresence(): Promise<void> {
  if (!lunaIdentity || !isPlayerActivelyPresent()) return;
  try {
    await lunaSocialClient.heartbeat({
      npub: lunaIdentity.npub,
      name: onlinePlayer.name,
      avatarUrl: onlinePlayer.avatarUrl,
      status: onlineRoom ? 'in-game' : 'online',
      roomId: onlineRoom?.id ?? null,
    });
  } catch {
    // La presencia es best-effort.
  }
}

async function syncLunaLaunchRequest(): Promise<void> {
  if (!lunaIdentity || onlineBusy || lunaLaunchPollInFlight || pendingLunaLaunchRequest) return;
  lunaLaunchPollInFlight = true;
  try {
    const response = await lunaSocialClient.launchRequest(lunaIdentity.npub);
    syncOnlineClock(response.serverNowMs);
    const request = response.request;
    if (!request) return;
    if (ignoredLunaLaunchRequestIds.has(request.id)) return;
    await handleLunaLaunchRequest(request);
  } catch {
    // La orden pendiente es best-effort; la UI de Luna conserva el fallback de abrir/navegar.
  } finally {
    lunaLaunchPollInFlight = false;
  }
}

async function handleLunaLaunchRequest(request: LunaLaunchRequest): Promise<void> {
  const normalizedRoomId = normalizeRoomId(request.roomId);
  if (!normalizedRoomId) return;
  if (onlineRoom && normalizeRoomId(onlineRoom.id) === normalizedRoomId) return;
  const pending = { ...request, normalizedRoomId };
  pendingLunaLaunchRequest = pending;
  bindingCapture = null;
  input.releaseAll();
}

async function acceptPendingLunaLaunchRequest(): Promise<void> {
  const request = pendingLunaLaunchRequest;
  if (!request) return;
  pendingLunaLaunchRequest = null;
  await enterLunaNegraRoomFromInvite(request.inviteToken, request.normalizedRoomId);
}

function cancelPendingLunaLaunchRequest(): void {
  const request = pendingLunaLaunchRequest;
  if (request) ignoredLunaLaunchRequestIds.add(request.id);
  pendingLunaLaunchRequest = null;
  bindingCapture = null;
  if (canAdvanceGame(appMode, engine.getState().status)) syncGameplayClockToCurrentFrame();
  input.releaseAll();
}

async function openLunaInviteWindow(): Promise<void> {
  if (lunaInviteWindowBusy) return;
  if (!lunaIdentity?.gameId) {
    onlineError = 'Abri el juego desde Luna Negra para invitar amigos.';
    return;
  }

  if (!onlineRoom) {
    await createOnlineRoom('private');
    if (!onlineRoom) return;
  }

  const popup = window.open('', 'luna-negra-invite', 'popup=yes,width=420,height=640');
  if (!popup) {
    onlineError = 'El navegador bloqueo la ventana de Luna Negra.';
    return;
  }

  try {
    popup.opener = null;
    popup.document.title = 'Luna Negra';
    popup.document.body.innerHTML = '<p style="font-family: system-ui; padding: 16px;">Abriendo Luna Negra...</p>';
  } catch {
    // Si el navegador no permite tocar about:blank, igual navegamos la ventana.
  }

  lunaInviteWindowBusy = true;
  lunaInviteNotice = null;
  try {
    const response = await lunaSocialClient.inviteWindow(lunaIdentity.gameId, onlineRoom.id, onlinePlayer.id);
    popup.location.href = response.url;
    lunaInviteNotice = 'Elegiste amigos desde Luna Negra.';
    onlineError = null;
  } catch (error) {
    popup.close();
    onlineError = onlineErrorText(error);
  } finally {
    lunaInviteWindowBusy = false;
  }
}

async function openLunaLogin(): Promise<void> {
  if (onlineBusy || lunaInviteWindowBusy) return;
  lunaInviteWindowBusy = true;
  onlineError = null;
  try {
    const response = await lunaSocialClient.loginUrl();
    window.location.href = response.url;
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    lunaInviteWindowBusy = false;
  }
}

async function kickOnlinePlayer(targetPlayerId: string): Promise<void> {
  if (!onlineRoom || onlineBusy || !targetPlayerId) return;
  if (targetPlayerId === onlinePlayer.id) return;
  onlineBusy = true;
  try {
    const response = await onlineClient.kickPlayer({
      roomId: onlineRoom.id,
      playerId: onlinePlayer.id,
      targetPlayerId,
    });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    onlineError = null;
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlineBusy = false;
  }
}

async function refreshPublicRooms(): Promise<void> {
  if (onlineBusy) return;
  onlineBusy = true;
  try {
    const response = await onlineClient.listPublicRooms(publicRoomFilters());
    syncOnlineClock(response.serverNowMs);
    onlinePublicRooms = response.rooms;
    onlineError = null;
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlineBusy = false;
  }
}

function publicRoomFilters(): PublicRoomsFilters {
  return {
    matchType: 'custom',
  };
}

async function setOnlineRoomVisibility(value: string | undefined): Promise<void> {
  if (!onlineRoom || onlineBusy) return;
  const visibility = value === 'public' ? 'public' : value === 'private' ? 'private' : null;
  if (!visibility || visibility === onlineRoom.visibility) return;
  if (onlineRoom.hostPlayerId !== onlinePlayer.id) {
    onlineError = 'Solo el host puede cambiar la visibilidad de la sala.';
    return;
  }
  if (onlineRoom.status !== 'lobby') {
    onlineError = 'La visibilidad solo se puede cambiar en el lobby.';
    return;
  }
  onlineBusy = true;
  try {
    // visibilityOnly: el toggle no reinicia reglas, jugadores ni la apuesta, y
    // no cambia la pantalla actual (se usa desde el panel persistente también).
    const response = await onlineClient.updateRoomSettings({
      roomId: onlineRoom.id,
      playerId: onlinePlayer.id,
      visibility,
      visibilityOnly: true,
      matchType: 'custom',
    });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
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
    // Una persona solo puede tener una sala a la vez: si ya estaba en otra, la deja.
    await leaveCurrentRoomBeforeNew();
    onlinePlayer = saveOnlinePlayer({ ...onlinePlayer, name: onlineName });
    const response = await onlineClient.createRoom({
      playerId: onlinePlayer.id,
      npub: lunaIdentity?.npub ?? null,
      lunaGameId: lunaIdentity?.gameId ?? null,
      name: onlinePlayer.name,
      avatarUrl: onlinePlayer.avatarUrl,
      visibility,
      mode: 'custom',
      matchType: 'custom',
      rules: onlineCustomRulesFromSettings(),
    });
    syncOnlineClock(response.serverNowMs);
    enterOnlineRoom(response.room, 'roomLobby');
    void syncLunaPresence();
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlineBusy = false;
  }
}

async function joinOnlineRoom(roomId: string): Promise<void> {
  const normalizedRoomId = normalizeRoomId(roomId);
  if (onlineBusy || normalizedRoomId.length < ROOM_ID_MIN_LENGTH) {
    onlineError = `Enter a room ID with at least ${ROOM_ID_MIN_LENGTH} characters.`;
    return;
  }
  onlineBusy = true;
  try {
    // Una persona solo puede tener una sala a la vez: si ya estaba en otra, la deja.
    await leaveCurrentRoomBeforeNew(normalizedRoomId);
    onlinePlayer = saveOnlinePlayer({ ...onlinePlayer, name: onlineName });
    const response = await onlineClient.joinRoom({
      roomId: normalizedRoomId,
      playerId: onlinePlayer.id,
      npub: lunaIdentity?.npub ?? null,
      name: onlinePlayer.name,
      avatarUrl: onlinePlayer.avatarUrl,
    });
    syncOnlineClock(response.serverNowMs);
    enterOnlineRoom(response.room, 'roomLobby');
    void syncLunaPresence();
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
  if (!onlineRoomHasOtherPlayers()) {
    startNewRun();
    return;
  }
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

// Después de ver los resultados se vuelve al menú principal SIN salir de la
// sala. Si soy el host, además reabro la sala al lobby para poder crear otra
// apuesta y lanzar la próxima ronda desde el panel.
function closeOnlineResults(): void {
  goToMenu();
  if (isOnlineHost()) void reopenOnlineRoom();
}

async function reopenOnlineRoom(): Promise<void> {
  if (!onlineRoom || !isOnlineHost() || onlineRoomReopenInFlight) return;
  if (onlineRoom.status !== 'finished') return;
  // No reabrimos hasta que la apuesta termine de liquidarse: el server la borra
  // al reabrir y se perdería el reintento de pago al ganador.
  if (onlineRoom.bet && !['settled', 'cancelled', 'expired', 'refunded'].includes(onlineRoom.bet.status)) return;
  onlineRoomReopenInFlight = true;
  try {
    const response = await onlineClient.reopenRoom({ roomId: onlineRoom.id, playerId: onlinePlayer.id });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
  } catch {
    // Best-effort: el próximo poll lo reintenta (ver pollOnlineRoom).
  } finally {
    onlineRoomReopenInFlight = false;
  }
}

async function restartOnlineRoom(): Promise<void> {
  if (!onlineRoom || onlineBusy) return;
  onlineBusy = true;
  try {
    const response = await onlineClient.restartRoom({ roomId: onlineRoom.id, playerId: onlinePlayer.id });
    syncOnlineClock(response.serverNowMs);
    enterOnlineRoom(response.room, 'onlineCountdown');
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlineBusy = false;
  }
}

async function createOnlineBet(): Promise<void> {
  if (!onlineRoom || onlineBusy || onlineBetBusy) return;
  const stakeSats = Number(onlineStakeInput);
  if (!Number.isInteger(stakeSats) || stakeSats <= 0) {
    onlineError = 'Ingresá un monto de apuesta válido (sats).';
    return;
  }
  onlineBetBusy = true;
  try {
    const response = await onlineClient.createBet({ roomId: onlineRoom.id, playerId: onlinePlayer.id, stakeSats });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    armOnlineBetFastPolling();
    onlineError = null;
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlineBetBusy = false;
  }
}

async function cancelOnlineBet(): Promise<void> {
  if (!onlineRoom || onlineBetBusy) return;
  onlineBetBusy = true;
  try {
    const response = await onlineClient.cancelBet({ roomId: onlineRoom.id, playerId: onlinePlayer.id });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    onlineError = null;
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlineBetBusy = false;
  }
}

async function settleOnlineBet(): Promise<void> {
  if (!onlineRoom || onlineBetBusy) return;
  onlineBetBusy = true;
  try {
    const response = await onlineClient.settleBet({ roomId: onlineRoom.id, playerId: onlinePlayer.id });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    onlineError = null;
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlineBetBusy = false;
  }
}

async function refreshOnlineBet(
  silent: boolean,
  options: { queueIfBusy?: boolean } = {},
): Promise<void> {
  if (!onlineRoom?.bet) return;
  if (onlineBetBusy) {
    if (options.queueIfBusy) onlineBetRefreshQueued = true;
    return;
  }
  const requestedRoomId = onlineRoom.id;
  onlineBetBusy = true;
  onlineLastBetPollAt = performance.now();
  try {
    const result = await requestOnlineBetRefresh(onlineRoom.id, onlinePlayer.id);
    syncOnlineClock(result.payload.serverNowMs);
    adoptOnlineRoom(result.payload.room);
    if (!silent) onlineError = null;
  } catch (error) {
    if (!silent) onlineError = onlineErrorText(error);
  } finally {
    onlineBetBusy = false;
    const shouldRefreshAgain = onlineBetRefreshQueued;
    onlineBetRefreshQueued = false;
    if (shouldRefreshAgain && onlineRoom?.id === requestedRoomId && isRefreshableRoomBet(onlineRoom.bet)) {
      void refreshOnlineBet(true, { queueIfBusy: true });
    }
  }
}

async function copyToClipboard(text: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard puede estar bloqueado; el usuario puede copiar manualmente.
  }
}

async function wakeUpServer(): Promise<void> {
  // Realiza un fetch simple a un endpoint ligero (/api/health) para despertar al servidor
  // si está en un entorno serverless o free hosting (como Render/Railway) que se va a dormir.
  try {
    await fetch('/api/health', { cache: 'no-store' });
  } catch {
    // El backend puede estar dormido o caído; el refresh posterior reportará el error.
  }
}

function wakeUpBetDetection(): void {
  armOnlineBetFastPolling();
  void (async () => {
    await wakeUpServer();
    await refreshOnlineBet(true, { queueIfBusy: true });
  })();
}

class OnlineBetDiagnosticError extends Error {
  constructor(message: string, readonly status: number | null, readonly elapsedMs: number | null) {
    super(message);
    this.name = 'OnlineBetDiagnosticError';
  }
}

async function requestOnlineBetRefresh(roomId: string, playerId: string): Promise<{ payload: OnlineRoomResponse; status: number; elapsedMs: number }> {
  const startedAt = performance.now();
  const response = await fetch('/api/bets/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, playerId }),
  });
  const elapsedMs = performance.now() - startedAt;
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new OnlineBetDiagnosticError(`Respuesta no JSON (${response.status}): ${text.slice(0, 120)}`, response.status, elapsedMs);
    }
  }
  if (!response.ok) {
    const message = isOnlineErrorResponse(payload) ? payload.error : 'Online bet refresh failed.';
    throw new OnlineBetDiagnosticError(message, response.status, elapsedMs);
  }
  if (!isOnlineRoomResponse(payload)) {
    throw new OnlineBetDiagnosticError('Respuesta sin room/serverNowMs.', response.status, elapsedMs);
  }
  return { payload, status: response.status, elapsedMs };
}

function isOnlineErrorResponse(value: unknown): value is OnlineErrorResponse {
  return typeof value === 'object' && value !== null && 'error' in value && typeof (value as OnlineErrorResponse).error === 'string';
}

function isOnlineRoomResponse(value: unknown): value is OnlineRoomResponse {
  return typeof value === 'object'
    && value !== null
    && 'room' in value
    && 'serverNowMs' in value
    && typeof (value as OnlineRoomResponse).serverNowMs === 'number';
}

async function setOnlineTargeting(mode: string | undefined, manualTargetPlayerId: string | null = null): Promise<void> {
  if (!onlineRoom || onlineBusy) return;
  const targetingMode = parseTargetingMode(mode);
  if (!targetingMode) return;
  onlineBusy = true;
  try {
    const response = await onlineClient.setTargeting({
      roomId: onlineRoom.id,
      playerId: onlinePlayer.id,
      targetingMode,
      manualTargetPlayerId,
    });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    syncOnlinePeers(response.room);
    onlineError = null;
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlineBusy = false;
  }
}

function leaveOnlineRoom(): void {
  // Avisamos al servidor para que migre el host (si yo era el host, se lo pasa al
  // siguiente que queda) o elimine la sala si queda vacía. No esperamos la
  // respuesta: la salida local es inmediata.
  const room = onlineRoom;
  if (room) {
    void onlineClient.leaveRoom({ roomId: room.id, playerId: onlinePlayer.id }).catch(() => {});
  }
  resetOnlineRoomState();
  goToMenu();
  void syncLunaPresence();
}

// Sale de la sala actual (si hay) antes de crear/unirse a otra, para que una
// persona nunca tenga dos salas a la vez. Espera el leave del servidor.
async function leaveCurrentRoomBeforeNew(targetRoomId?: string): Promise<void> {
  const room = onlineRoom;
  if (!room || room.id === targetRoomId) return;
  try {
    await onlineClient.leaveRoom({ roomId: room.id, playerId: onlinePlayer.id });
  } catch {
    // Si el leave falla seguimos: la sala vieja expira por TTL.
  }
  resetOnlineRoomState();
}

function resetOnlineRoomState(): void {
  clearOnlineRoomSession();
  onlinePeerBroadcaster?.close();
  onlinePeerBroadcaster = null;
  onlinePeerStates = new Map();
  onlinePeerDisplaySnapshots = new Map();
  onlineRoom = null;
  onlineError = null;
  onlineStakeInput = '';
  onlineBetBusy = false;
  onlineLastBetPollAt = 0;
  onlineBetFastPollUntil = 0;
  onlineBetRefreshQueued = false;
  onlineResultSubmitted = false;
  onlineRunStarted = false;
  onlineAttackSequence = 0;
  onlineAppliedAttackIds = new Set();
  onlineHostAuthority = null;
  onlineHostMigrated = false;
  onlineHostProgressInFlight = new Set();
  onlineHostLastProgressAt = new Map();
  onlineHostCommittedEliminations = new Set();
  onlineHostCommittedResults = new Set();
  onlineLastAuthoritativeFrame = 0;
  onlinePeerDisplaySnapshots = new Map();
  onlineInputOutbox = [];
  onlineLastPollAt = 0;
  onlineLastProgressAt = 0;
  onlineLastPeerBroadcastAt = 0;
  onlineLastKoBroadcastAt = 0;
  onlineActiveRoundId = null;
  pendingLunaLaunchRequest = null;
}

function enterOnlineRoom(room: OnlineRoom, preferredMode: AppMode): void {
  adoptOnlineRoom(room);
  syncOnlinePeers(room);
  onlineError = null;
  onlineLastPollAt = 0;
  if (room.status === 'finished') appMode = 'onlineResults';
  else if (room.status === 'playing') appMode = onlineRunStarted ? 'onlinePlaying' : 'onlineCountdown';
  else if (room.status === 'countdown') appMode = 'onlineCountdown';
  else appMode = preferredMode;
}

function adoptOnlineRoom(room: OnlineRoom): void {
  const previousRoom = onlineRoom;
  const previousRoundId = onlineActiveRoundId;
  if (previousRoom && room.updatedAtServerMs < previousRoom.updatedAtServerMs) return;
  const nextRoundId = onlineRoundKey(room);
  const roundChanged = previousRoundId !== null && nextRoundId !== null && previousRoundId !== nextRoundId;
  const roomRestarted = previousRoom?.status === 'finished' && room.status === 'countdown';
  onlineRoom = room;
  saveOnlineRoomSession(room);
  if (room.bet?.status !== 'pending_deposits') onlineBetFastPollUntil = 0;
  onlineActiveRoundId = nextRoundId;
  if (roundChanged || roomRestarted) resetOnlineRuntimeForNextRound();
}

function onlineRoundKey(room: OnlineRoom): string {
  return `seed:${room.seed}`;
}

function resetOnlineRuntimeForNextRound(): void {
  onlineRunStarted = false;
  onlineResultSubmitted = false;
  onlineAttackSequence = 0;
  onlineAppliedAttackIds = new Set();
  onlineHostAuthority = null;
  onlineHostMigrated = false;
  onlineHostProgressInFlight = new Set();
  onlineHostLastProgressAt = new Map();
  onlineHostCommittedEliminations = new Set();
  onlineHostCommittedResults = new Set();
  onlineLastAuthoritativeFrame = 0;
  onlinePeerDisplaySnapshots = new Map();
  onlineInputOutbox = [];
  onlineLastProgressAt = 0;
  onlineLastPeerBroadcastAt = 0;
  onlineLastKoBroadcastAt = 0;
  input.releaseAll();
  if (onlineRoom?.status === 'countdown' || onlineRoom?.status === 'playing') appMode = 'onlineCountdown';
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

function syncRunEffects(state: GameState, events: GameEvent[]): void {
  runSplitTracker.record(state);
  if (state.stats.combo > runMaxCombo) runMaxCombo = state.stats.combo;
  const progressCue = soundCueForRunProgress(state, events, lastLines, lastPieces);
  if (progressCue) sound.play(progressCue);
  if (state.status !== lastStatus) {
    if (state.status === 'finished') sound.play('finish');
    if (state.status === 'gameover') sound.play('gameOver');
  }
  lastPieces = state.stats.pieces;
  lastLines = state.stats.lines;
  lastStatus = state.status;
  if (state.status === 'finished' && state.stats.finishFrame !== null && !savedFinish) {
    const previousBest = best.best40LineFrames;
    runWasNewBest = currentRunKind === 'standard'
      && (previousBest === null || state.stats.finishFrame < previousBest);
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
  // Cliente-autoritativo: cada jugador (host o invitado) declara sus propios ataques a
  // partir de SUS líneas. Antes solo el host generaba ataques (los de los invitados los
  // derivaba de la simulación que divergía); ahora nacen del motor real de cada cliente.
  for (const event of events) {
    if (event.type === 'lineClear' && event.outgoingLines > 0) sendOnlineAttack(event, state);
  }
}

// Cliente-autoritativo: el host ya no re-simula a los invitados, así que sus inputs no
// se consumen en ningún lado. Dejamos estas funciones inertes (en vez de borrarlas y sus
// estructuras asociadas) para no reenviar inputs que nadie procesa ni hacer crecer el
// outbox sin tope (se reenvía completo cada frame).
function sendOnlineInputsToHost(_inputs: GameInput[]): void {
  // no-op: ver nota arriba.
}

function flushOnlineInputOutbox(): void {
  // no-op: ver nota arriba.
}

function sendOnlineAttack(event: LineClearEvent, state: GameState): void {
  if (!onlineRoom) return;
  onlineAttackSequence += 1;
  const attack = {
    attackId: `${onlinePlayer.id}-${gameFrame}-${onlineAttackSequence}`,
    fromPlayerId: onlinePlayer.id,
    lines: event.outgoingLines,
    holeSeed: (onlineRoom.seed + gameFrame + onlineAttackSequence * 97) >>> 0,
    frame: displayedElapsedFrames(state.stats),
  };
  // El host rutea sus propios ataques directo (es el único escritor del servidor). El
  // invitado manda una "intención" al host por peer y el host elige objetivo y la rutea.
  if (isOnlineHost()) {
    commitOnlineAttack(attack);
  } else {
    onlinePeerBroadcaster?.sendAttackIntent(onlineRoom.hostPlayerId, { ...attack, seed: onlineRoom.seed });
  }
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
    seed: onlineRoom.seed,
    lines: request.lines,
    holeSeed: request.holeSeed,
    frame: request.frame,
  };
  applyAttackToHostTruth(attack);
  onlinePeerBroadcaster?.sendAttack(target.id, {
    attackId: attack.attackId,
    authorityPlayerId: attack.authorityPlayerId,
    fromPlayerId: attack.fromPlayerId,
    seed: attack.seed,
    lines: attack.lines,
    holeSeed: attack.holeSeed,
    frame: attack.frame,
  });
  const requestSeed = attack.seed;
  void onlineClient.sendAttack(attack)
    .then((response) => {
      if (!isCurrentOnlineSeed(requestSeed)) return;
      syncOnlineClock(response.serverNowMs);
      adoptOnlineRoom(response.room);
      applyRoomAttacks(response.room);
    })
    .catch((error) => {
      onlineError = onlineErrorText(error);
    });
}

function applyAttackToHostTruth(attack: AttackRequest): void {
  rememberOnlineAttack(attack.fromPlayerId, attack.toPlayerId, attack.lines);
  if (attack.toPlayerId === onlinePlayer.id) {
    applyOnlineAttack({
      id: attack.attackId,
      roomId: attack.roomId,
      authorityPlayerId: attack.authorityPlayerId,
      fromPlayerId: attack.fromPlayerId,
      toPlayerId: attack.toPlayerId,
      seed: attack.seed,
      lines: attack.lines,
      holeSeed: attack.holeSeed,
      frame: attack.frame,
      createdAtServerMs: onlineNowMs(),
    });
    return;
  }
  onlineHostAuthority?.queueGarbage(attack.toPlayerId, attack.lines, attack.holeSeed, attack.attackId, attack.frame);
}

function selectAttackTarget(sourcePlayerId: string, attackId: string): OnlinePlayer | null {
  if (!onlineRoom) return null;
  const source = onlineRoom.players.find((player) => player.id === sourcePlayerId);
  return selectTargetForAttack({
    players: onlineRoom.players,
    sourcePlayerId,
    attackId,
    mode: source?.targetingMode ?? onlineRoom.ruleset.targeting,
    manualTargetPlayerId: source?.manualTargetPlayerId ?? null,
    recentAttackers: source?.recentAttackers ?? [],
  });
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
  const nowMs = performance.now();
  if (update.state.status === 'playing' && nowMs - (onlineLastHostSimLogAt.get(update.playerId) ?? 0) >= 2000) {
    onlineLastHostSimLogAt.set(update.playerId, nowMs);
    logMp('host-sim', {
      target: update.playerId.slice(0, 6),
      simFrame: update.state.stats.frame,
      pieces: update.state.stats.pieces,
      lines: update.state.stats.lines,
      consumedInputs: update.consumedInputCount,
      pendingInputs: update.pendingInputCount,
      board: boardMetrics(update.state.board),
    });
  }
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
    logMp('host-eliminate', {
      target: update.playerId.slice(0, 6),
      reason: update.state.stats.gameOverReason,
      gameOverFrame: update.state.stats.gameOverFrame,
      simFrame: update.state.stats.frame,
      hostFrame: gameFrame,
      lastInputSeq: update.lastProcessedInputSequence,
      consumedInputs: update.consumedInputCount,
      pendingInputs: update.pendingInputCount,
      pieces: update.state.stats.pieces,
      lines: update.state.stats.lines,
      board: boardMetrics(update.state.board),
      pendingGarbage: update.state.stats.pendingGarbage,
      receivedGarbage: update.state.stats.receivedGarbage,
    });
    void commitOnlineElimination(createOnlineKoReportFromState(update.playerId, update.state));
  }
  if (update.state.status === 'finished' && !onlineHostCommittedResults.has(update.playerId)) {
    void commitOnlineResult(update.playerId, update.state, 'won', snapshot);
  }
}

function syncOnline(): void {
  if (!onlineRoom) return;
  const now = performance.now();
  if (shouldPollOnline(now)) pollOnlineRoom();
  if (appMode === 'onlineCountdown') maybeStartOnlineRun();
  ensureMigratedHostAuthority();
  // maybeStartOnlineRun() pudo haber arrancado la ronda nueva (motor fresco vía
  // startNewRun) en esta misma vuelta. El `state` recibido se capturó en loop()
  // ANTES de ese reset, así que todavía refleja el estado terminal de la ronda
  // anterior. Si lo usáramos para reportar resultado/eliminación, cada perdedor
  // se autoeliminaría y el ganador re-enviaría su 'won' en la ronda nueva, que
  // terminaría al instante repitiendo al ganador. Releemos el estado vivo.
  const liveState = engine.getState();
  // El host sigue siendo la autoridad de la ronda aunque su propia partida haya
  // terminado y esté mirando los resultados: si dejara de simular, el resto de
  // los jugadores se quedaría sin garbage, sin snapshots y sin eliminaciones, y
  // la sala terminaría mal (o nunca).
  const roomStillRunning = onlineRoom.status === 'playing' || onlineRoom.status === 'countdown';
  const hostStillAuthority = isOnlineHost() && onlineRunStarted && appMode === 'onlineResults' && roomStillRunning;
  if (appMode === 'onlinePlaying' || hostStillAuthority) {
    if (appMode === 'onlinePlaying' && now - onlineLastDiagLogAt >= 2000) {
      onlineLastDiagLogAt = now;
      const serverFrame = onlineRoom.startsAtServerMs
        ? Math.floor((onlineNowMs() - onlineRoom.startsAtServerMs) / GAME_FRAME_MS)
        : null;
      logMp('heartbeat', {
        status: liveState.status,
        localFrame: gameFrame,
        serverFrame,
        frameSkew: serverFrame === null ? null : serverFrame - gameFrame,
        pieces: liveState.stats.pieces,
        lines: liveState.stats.lines,
        board: boardMetrics(liveState.board),
        pendingGarbage: liveState.stats.pendingGarbage,
        outbox: onlineInputOutbox.length,
        lastAuthFrame: onlineLastAuthoritativeFrame,
      });
    }
    if (isOnlineHost()) advanceHostAuthority(onlineAuthorityTargetFrame(liveState));
    else flushOnlineInputOutbox();
    applyRoomAttacks(onlineRoom);
    if (shouldBroadcastPeerSnapshot(now)) broadcastOnlineSnapshot(liveState);
    if (isOnlineHost()) relayPeerProgressToServer();
    // El host postea progreso mientras la sala siga en ronda AUNQUE su propia
    // partida haya terminado: es el único escritor del servidor, y si los canales
    // peer no traen snapshots para relayar (WebRTC caído), la sala quedaría
    // HOST_STALE_MS sin escrituras y applyHostFailover cortaría la ronda con
    // jugadores todavía vivos. El servidor trata el progreso de un jugador
    // terminal como keepalive (no toca sus stats).
    if (isOnlineHost() && roomStillRunning && shouldPostOnlineProgress(now)) postOnlineProgress(liveState);
    if (liveState.status === 'finished' && !onlineResultSubmitted) postOnlineResult(liveState);
    if (liveState.status === 'gameover') postOnlineElimination(liveState);
  }
}

// Mientras el host juega, la simulación autoritativa avanza con su gameFrame.
// Cuando su partida termina, gameFrame se congela (canAdvanceGame es false),
// así que derivamos el frame objetivo del reloj sincronizado con el servidor
// para que las partidas remotas sigan corriendo hasta que la sala termine.
function onlineAuthorityTargetFrame(state: GameState): number {
  if (state.status === 'playing' || !onlineRoom?.startsAtServerMs) return gameFrame;
  const elapsedFrames = Math.floor((onlineNowMs() - onlineRoom.startsAtServerMs) / GAME_FRAME_MS);
  return Math.max(gameFrame, elapsedFrames);
}

function shouldPollOnline(now: number): boolean {
  if (onlinePollInFlight) return false;
  if (!['menu', 'soloMenu', 'multiplayerMenu', 'historyMenu', 'configMenu', 'custom', 'roomLobby', 'onlineCountdown', 'onlinePlaying', 'onlineResults'].includes(appMode)) return false;
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
    // Si ya no estoy entre los jugadores y la sala sigue en lobby, me expulsaron.
    if (
      (appMode === 'roomLobby' || appMode === 'onlineCountdown')
      && response.room.status === 'lobby'
      && !response.room.players.some((player) => player.id === onlinePlayer.id)
    ) {
      resetOnlineRoomState();
      goToMenu();
      onlineError = 'Te sacaron de la sala.';
      void syncLunaPresence();
      return;
    }
    adoptOnlineRoom(response.room);
    syncOnlinePeers(response.room);
    applyRoomAttacks(response.room);
    if (
      response.room.status === 'finished'
      && (appMode === 'roomLobby' || appMode === 'onlineCountdown' || appMode === 'onlinePlaying' || appMode === 'onlineResults')
    ) appMode = 'onlineResults';
    if (response.room.status === 'countdown' && (appMode === 'roomLobby' || appMode === 'onlineResults')) appMode = 'onlineCountdown';
    if (response.room.status === 'playing' && appMode === 'roomLobby') appMode = 'onlineCountdown';
    // El host reabrió la sala al lobby: los demás vuelven al menú principal
    // (la sala sigue viva en el panel lateral).
    if (response.room.status === 'lobby' && appMode === 'onlineResults') goToMenu();
    // Host que ya está en el menú con la sala terminada: la reabre solo.
    if (response.room.status === 'finished' && isOnlineHost() && isPersistentRoomPanelMode(appMode)) {
      void reopenOnlineRoom();
    }
    onlineError = null;
    onlineRoomGonePolls = 0;
    maybeRefreshBet();
  } catch (error) {
    onlineError = onlineErrorText(error);
    if (error instanceof OnlineApiError && error.status === 404) {
      // La sala ya no existe en el servidor: tras varios polls seguidos dejamos
      // de insistir (cerramos peers, limpiamos sesión) y volvemos al menú, en
      // vez de quedar atascados polleando y señalizando una sala fantasma.
      onlineRoomGonePolls += 1;
      if (onlineRoomGonePolls >= ONLINE_ROOM_GONE_POLL_LIMIT) {
        onlineRoomGonePolls = 0;
        resetOnlineRoomState();
        goToMenu();
        onlineError = 'La sala ya no existe en el servidor.';
        void syncLunaPresence();
      }
    } else {
      onlineRoomGonePolls = 0;
    }
  } finally {
    onlinePollInFlight = false;
  }
}

function maybeRefreshBet(): void {
  // En el lobby seguimos los depósitos; en la pantalla de resultados seguimos
  // refrescando para reintentar la liquidación (reporte del ganador + pago) hasta
  // que la apuesta quede en estado terminal.
  if (appMode !== 'roomLobby' && appMode !== 'onlineResults') return;
  const bet = onlineRoom?.bet;
  if (!isRefreshableRoomBet(bet)) return;
  const now = performance.now();
  // Igual que la pantalla de pago por QR de Luna Negra: mientras MI depósito
  // siga pendiente se pollea rápido siempre, así un pago hecho por fuera
  // (invoice copiada a otra billetera) se detecta apenas Luna lo registra.
  const fastPoll = bet.status === 'pending_deposits'
    && (now < onlineBetFastPollUntil || hasOwnPendingDeposit(bet));
  const pollMs = fastPoll ? ONLINE_BET_FAST_POLL_MS : ONLINE_BET_POLL_MS;
  if (onlineBetBusy) {
    onlineBetRefreshQueued = true;
    return;
  }
  if (now - onlineLastBetPollAt < pollMs) return;
  void refreshOnlineBet(true, { queueIfBusy: true });
}

function isRefreshableRoomBet(bet: RoomBet | null | undefined): bet is RoomBet {
  return !!bet && (bet.status === 'pending_deposits' || bet.status === 'funded');
}

function hasOwnPendingDeposit(bet: RoomBet): boolean {
  const mine = currentOnlinePlayer();
  if (!mine?.npub) return false;
  return bet.participants.some((entry) => entry.npub === mine.npub && entry.depositStatus === 'pending');
}

function armOnlineBetFastPolling(): void {
  const bet = onlineRoom?.bet;
  if (!bet || bet.status !== 'pending_deposits') return;
  onlineBetFastPollUntil = Math.max(onlineBetFastPollUntil, performance.now() + ONLINE_BET_FAST_POLL_WINDOW_MS);
}

async function postOnlineProgress(state: GameState): Promise<void> {
  if (!onlineRoom || !isOnlineHost()) return;
  onlineProgressInFlight = true;
  onlineLastProgressAt = performance.now();
  const requestSeed = onlineRoom.seed;
  try {
    const response = await onlineClient.updateProgress({
      roomId: onlineRoom.id,
      authorityPlayerId: onlinePlayer.id,
      playerId: onlinePlayer.id,
      seed: onlineRoom.seed,
      lines: state.stats.lines,
      pieces: state.stats.pieces,
      elapsedFrames: displayedElapsedFrames(state.stats),
      sentGarbage: state.stats.sentGarbage,
      receivedGarbage: state.stats.receivedGarbage,
      pendingGarbage: state.stats.pendingGarbage,
      game: createOnlineGameSnapshot(state),
    });
    if (!isCurrentOnlineSeed(requestSeed)) return;
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    syncOnlinePeers(response.room);
    onlineError = null;
  } catch (error) {
    onlineError = onlineErrorText(error);
  } finally {
    onlineProgressInFlight = false;
  }
}

async function postOnlineResult(state: GameState): Promise<void> {
  if (!onlineRoom) return;
  onlineResultSubmitted = true;
  if (!canCommitLocalOnlineTerminal(isOnlineHost())) {
    onlineError = null;
    return;
  }

  const game = createOnlineGameSnapshot(state);
  await commitOnlineResult(onlinePlayer.id, state, 'won', game, () => {
    onlineResultSubmitted = false;
  });
}

async function commitOnlineResult(
  playerId: string,
  state: GameState,
  result: 'won' | 'lost',
  game: OnlineGameSnapshot,
  onFailure?: () => void,
): Promise<void> {
  if (!onlineRoom || !isOnlineHost()) return;
  onlineHostCommittedResults.add(playerId);
  const requestSeed = game.seed;
  try {
    const response = await onlineClient.submitResult({
      ...createProgressRequest(playerId, game),
      result,
      lines: state.stats.lines,
      pieces: state.stats.pieces,
      elapsedFrames: displayedElapsedFrames(state.stats),
      sentGarbage: state.stats.sentGarbage,
      receivedGarbage: state.stats.receivedGarbage,
      pendingGarbage: state.stats.pendingGarbage,
      game,
    });
    if (!isCurrentOnlineSeed(requestSeed)) return;
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    syncOnlinePeers(response.room);
    // Solo pasamos a resultados cuando la sala terminó: si perdí pero quedan
    // jugadores vivos, me quedo mirando sus partidas (modo espectador).
    if (response.room.status === 'finished') appMode = 'onlineResults';
    onlineError = null;
  } catch (error) {
    onlineError = onlineErrorText(error);
    onlineHostCommittedResults.delete(playerId);
    onFailure?.();
  }
}

async function postOnlineElimination(state: GameState): Promise<void> {
  if (!onlineRoom) return;
  const canCommit = canCommitLocalOnlineTerminal(isOnlineHost());
  if (!canCommit) {
    const now = performance.now();
    if (onlineResultSubmitted && now - onlineLastKoBroadcastAt < ONLINE_KO_BROADCAST_RETRY_MS) return;
    onlineResultSubmitted = true;
    onlineLastKoBroadcastAt = now;
    onlinePeerBroadcaster?.broadcastKo(createOnlineKoReport(onlinePlayer.id, state));
    onlineError = null;
    return;
  }

  if (onlineResultSubmitted) return;
  onlineResultSubmitted = true;
  const report = createOnlineKoReport(onlinePlayer.id, state);
  onlineLastKoBroadcastAt = performance.now();
  onlinePeerBroadcaster?.broadcastKo(report);

  await commitOnlineElimination(report, () => {
    onlineResultSubmitted = false;
  });
}

async function commitOnlineElimination(report: Omit<OnlinePeerKoMessage, 'type'>, onFailure?: () => void): Promise<void> {
  if (!onlineRoom || !isOnlineHost()) return;
  // Los KOs llegan repetidos (broadcast por peer con retry + simulación local):
  // un solo commit por jugador y por ronda.
  if (onlineHostCommittedEliminations.has(report.playerId)) return;
  const requestSeed = report.seed;
  onlineHostCommittedEliminations.add(report.playerId);
  try {
    const response = await onlineClient.eliminatePlayer({
      roomId: onlineRoom.id,
      authorityPlayerId: onlinePlayer.id,
      playerId: report.playerId,
      seed: report.seed,
      frame: report.frame,
      lines: report.lines,
      pieces: report.pieces,
      elapsedFrames: report.elapsedFrames,
      sentGarbage: report.sentGarbage,
      receivedGarbage: report.receivedGarbage,
      pendingGarbage: report.pendingGarbage,
      game: report.game,
    });
    if (!isCurrentOnlineSeed(requestSeed)) return;
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    syncOnlinePeers(response.room);
    // Igual que en commitOnlineResult: el eliminado queda de espectador hasta
    // que la sala entera termine.
    if (response.room.status === 'finished') appMode = 'onlineResults';
    onlineError = null;
  } catch (error) {
    onlineError = onlineErrorText(error);
    onlineHostCommittedEliminations.delete(report.playerId);
    onFailure?.();
  }
}

/**
 * El servidor migra la autoridad al siguiente jugador vivo cuando el host se
 * desconecta a mitad de ronda (ver getRoomState / HOST_STALE_MS en
 * roomService). Ese jugador se entera al releer `hostPlayerId` en el poll, pero
 * no tiene HostAuthoritySimulator: solo se crea al arrancar la ronda en
 * maybeStartOnlineRun, y reconstruirlo ahora resimularía a los demás desde el
 * frame 0 sin sus inputs (los dejaría reseteados y los eliminaría por error).
 *
 * Por eso el sucesor corre en "modo degradado", sin autorar los tableros
 * ajenos (onlineHostAuthority queda null, y todos los caminos que lo usan están
 * guardados). Igual recupera la ronda porque, ya reconocido como host:
 *  - mantiene viva la sala posteando su propio progreso (postOnlineProgress),
 *  - acredita los KO que los peers anuncian por broadcast
 *    (decidePeerKoAction -> 'commit' -> commitOnlineElimination), y
 *  - reporta su propio resultado/eliminación,
 * con lo que el servidor puede terminar la partida (finishRoomIfOnlyOneAlive).
 */
function ensureMigratedHostAuthority(): void {
  if (!onlineRoom || !onlineRunStarted || !isOnlineHost()) return;
  if (onlineHostAuthority || onlineHostMigrated) return;
  onlineHostMigrated = true;
}

function maybeStartOnlineRun(): void {
  if (!onlineRoom?.startsAtServerMs || onlineRunStarted) return;
  if (onlineNowMs() < onlineRoom.startsAtServerMs) return;
  onlineRunStarted = true;
  onlineResultSubmitted = false;
  onlineAttackSequence = 0;
  onlineAppliedAttackIds = new Set();
  // Modelo cliente-autoritativo: cada jugador simula su PROPIO tablero y reporta sus
  // líneas/ataques/KO por peer. El host ya NO re-simula a los demás (eso causaba
  // divergencias deterministas y top-outs falsos al recibir garbage). El host solo
  // rutea ataques y relaya progreso/KO al servidor, que es el único escritor autorizado.
  // onlineHostAuthority queda siempre null y todos los caminos de simulación quedan inertes.
  onlineHostAuthority = null;
  onlineHostMigrated = false;
  onlineHostProgressInFlight = new Set();
  onlineHostLastProgressAt = new Map();
  onlineHostCommittedEliminations = new Set();
  onlineHostCommittedResults = new Set();
  onlineLastAuthoritativeFrame = 0;
  onlineInputOutbox = [];
  onlineLastProgressAt = 0;
  onlineLastPeerBroadcastAt = 0;
  onlineLastKoBroadcastAt = 0;
  syncHostAuthorityPlayers();
  startNewRun(onlineRoom.seed, 'onlinePlaying');
}

function updateSoloCountdown(): void {
  const remainingMs = Math.max(0, soloCountdownStartsAtMs - performance.now());
  const seconds = Math.ceil(remainingMs / 1000);
  if (seconds !== lastSoloCountdownSecondPlayed) {
    lastSoloCountdownSecondPlayed = seconds;
    if (seconds > 0) {
      sound.play('lock');
    } else {
      sound.play('lineClear');
    }
  }
  if (remainingMs === 0) {
    appMode = 'playing';
    syncGameplayClockToCurrentFrame();
  }
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
        adoptOnlineRoom(response.room);
      }).catch((error) => {
        onlineError = onlineErrorText(error);
      });
    },
    onSnapshot: (remoteId, playerId, game) => applyAuthoritativeSnapshot(remoteId, playerId, game),
    onAttack: (remoteId, attack) => {
      if (!onlineRoom || remoteId !== onlineRoom.hostPlayerId || attack.authorityPlayerId !== onlineRoom.hostPlayerId) return;
      if (!isCurrentOnlineSeed(attack.seed)) return;
      applyOnlineAttack({
        id: attack.attackId,
        roomId: onlineRoom.id,
        authorityPlayerId: attack.authorityPlayerId,
        fromPlayerId: attack.fromPlayerId,
        toPlayerId: attack.toPlayerId,
        seed: attack.seed,
        lines: attack.lines,
        holeSeed: attack.holeSeed,
        frame: attack.frame,
        createdAtServerMs: onlineNowMs(),
      });
    },
    onAttackIntent: (remoteId, intent) => {
      // Solo el host rutea: elige objetivo según el targeting de la sala y emite el
      // ataque (aplica garbage local si el objetivo es el host, lo reenvía al peer
      // objetivo si es otro, y lo registra en el servidor).
      if (!onlineRoom || !isOnlineHost()) return;
      if (remoteId !== intent.fromPlayerId) return;
      if (!isCurrentOnlineSeed(intent.seed)) return;
      commitOnlineAttack({
        attackId: intent.attackId,
        fromPlayerId: intent.fromPlayerId,
        lines: intent.lines,
        holeSeed: intent.holeSeed,
        frame: intent.frame,
      });
    },
    onInput: (remoteId, message) => {
      if (!isOnlineHost() || remoteId !== message.playerId) return;
      if (!isCurrentOnlineSeed(message.seed)) return;
      onlineHostAuthority?.pushInputs(message.playerId, message.inputs);
    },
    onKo: (remoteId, message) => {
      if (!onlineRoom) return;
      const action = decidePeerKoAction({
        isHostAuthority: isOnlineHost(),
        localPlayerId: onlinePlayer.id,
        hostPlayerId: onlineRoom.hostPlayerId,
        remotePlayerId: remoteId,
        messagePlayerId: message.playerId,
        playerIsInRoom: onlineRoom.players.some((player) => player.id === remoteId),
        seedMatches: isCurrentOnlineSeed(message.seed),
      });
      if (action === 'ignore') return;
      applyPeerKo(message);
      if (action === 'commit') void commitOnlineElimination(message);
    },
    onPeerState: (playerId, state) => {
      onlinePeerStates = new Map(onlinePeerStates).set(playerId, state);
    },
  });
  onlinePeerBroadcaster.syncRoom(room);
  prunePeerDisplaySnapshots(room);
}

function broadcastOnlineSnapshot(state: GameState): void {
  onlineLastPeerBroadcastAt = performance.now();
  // El snapshot propio solo tiene sentido mientras se juega, pero el host debe
  // seguir retransmitiendo los tableros simulados de los demás aunque su propia
  // partida haya terminado.
  if (state.status === 'playing') {
    const snapshot = createOnlineGameSnapshot(state);
    onlinePeerBroadcaster?.broadcastSnapshot(onlinePlayer.id, snapshot);
    if (isOnlineHost()) applyPeerSnapshot(onlinePlayer.id, onlinePlayer.id, snapshot);
  }
  if (!isOnlineHost()) return;
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
  if (playerId === remoteId) rememberPeerDisplaySnapshot(playerId, game);
  if (isOnlineHost()) return;
  if (remoteId !== onlineRoom.hostPlayerId) return;
  if (!isCurrentOnlineGame(game)) return;
  // Cliente-autoritativo: cada quien es dueño de su propio motor. NO adoptamos el tablero
  // que el host tenga de nosotros (eso era lo que nos mataba con el mapa lleno cuando su
  // simulación divergía). Solo guardamos los tableros de OTROS para mostrarlos.
  if (playerId === onlinePlayer.id) return;
  applyPeerSnapshot(remoteId, playerId, game);
}

function isCurrentOnlineGame(game: OnlineGameSnapshot | null | undefined): boolean {
  return !!game && isCurrentOnlineSeed(game.seed);
}

function isCurrentOnlineSeed(seedValue: number | undefined): boolean {
  return !!onlineRoom && seedValue === onlineRoom.seed;
}

function applyPeerSnapshot(_remoteId: string, playerId: string, game: OnlineGameSnapshot): void {
  if (!onlineRoom) return;
  if (!isCurrentOnlineGame(game)) return;
  onlineRoom = {
    ...onlineRoom,
    players: onlineRoom.players.map((player) => player.id === playerId ? { ...player, game } : player),
  };
}

function rememberPeerDisplaySnapshot(playerId: string, game: OnlineGameSnapshot): void {
  if (!isCurrentOnlineGame(game)) return;
  onlinePeerDisplaySnapshots = new Map(onlinePeerDisplaySnapshots).set(playerId, game);
}

function prunePeerDisplaySnapshots(room: OnlineRoom): void {
  const playerIds = new Set(room.players.map((player) => player.id));
  onlinePeerDisplaySnapshots = new Map(
    [...onlinePeerDisplaySnapshots.entries()].filter(([playerId, game]) => (
      playerIds.has(playerId) && game.seed === room.seed
    )),
  );
}

function postHostSimulatedProgress(playerId: string, state: GameState): void {
  if (!onlineRoom || !isOnlineHost()) return;
  const now = performance.now();
  if (onlineHostProgressInFlight.has(playerId)) return;
  if (now - (onlineHostLastProgressAt.get(playerId) ?? 0) < ONLINE_POLL_MS) return;

  onlineHostProgressInFlight.add(playerId);
  onlineHostLastProgressAt.set(playerId, now);
  const requestSeed = onlineRoom.seed;
  const progress = createProgressRequest(playerId, createOnlineGameSnapshotFromState(
    state,
    onlineHostAuthority?.getSnapshot(playerId) ?? undefined,
    onlineHostAuthority?.getLastProcessedInputSequence(playerId) ?? 0,
  ));
  void onlineClient.updateProgress(progress)
    .then((response) => {
      if (!isCurrentOnlineSeed(requestSeed)) return;
      syncOnlineClock(response.serverNowMs);
      adoptOnlineRoom(response.room);
      syncOnlinePeers(response.room);
      onlineError = null;
    })
    .catch((error) => {
      onlineError = onlineErrorText(error);
    })
    .finally(() => {
      onlineHostProgressInFlight.delete(playerId);
    });
}

// Cliente-autoritativo: como el host ya no simula a los invitados, relaya al servidor el
// progreso de cada uno tomándolo de SU PROPIO broadcast por peer (onlinePeerDisplaySnapshots).
// El servidor solo acepta escrituras con authorityPlayerId = host, así que el host sigue
// siendo el único escritor; acá actúa de mero relay del estado real que reporta cada peer.
function relayPeerProgressToServer(): void {
  if (!onlineRoom || !isOnlineHost()) return;
  const now = performance.now();
  for (const player of onlineRoom.players) {
    if (player.id === onlinePlayer.id) continue;
    if (player.status === 'eliminated' || player.status === 'won' || player.status === 'lost') continue;
    const snapshot = onlinePeerDisplaySnapshots.get(player.id);
    if (!snapshot || !isCurrentOnlineGame(snapshot) || snapshot.status !== 'playing') continue;
    if (onlineHostProgressInFlight.has(player.id)) continue;
    if (now - (onlineHostLastProgressAt.get(player.id) ?? 0) < ONLINE_POLL_MS) continue;

    onlineHostProgressInFlight.add(player.id);
    onlineHostLastProgressAt.set(player.id, now);
    const requestSeed = onlineRoom.seed;
    void onlineClient.updateProgress(createProgressRequest(player.id, snapshot))
      .then((response) => {
        if (!isCurrentOnlineSeed(requestSeed)) return;
        syncOnlineClock(response.serverNowMs);
        adoptOnlineRoom(response.room);
        onlineError = null;
      })
      .catch((error) => {
        onlineError = onlineErrorText(error);
      })
      .finally(() => {
        onlineHostProgressInFlight.delete(player.id);
      });
  }
}

function applyPeerKo(message: Pick<OnlinePeerKoMessage, 'playerId' | 'seed' | 'frame' | 'elapsedFrames' | 'game'>): void {
  const { playerId, frame } = message;
  if (!onlineRoom || playerId === onlinePlayer.id) return;
  if (!isCurrentOnlineSeed(message.seed)) return;
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
  if (!isCurrentOnlineSeed(attack.seed)) return;
  if (attack.toPlayerId !== onlinePlayer.id || onlineAppliedAttackIds.has(attack.id)) return;
  onlineAppliedAttackIds.add(attack.id);
  rememberOnlineAttack(attack.fromPlayerId, attack.toPlayerId, attack.lines);
  const beforeGarbage = engine.getState();
  logMp('garbage-in', {
    from: attack.fromPlayerId.slice(0, 6),
    lines: attack.lines,
    attackFrame: attack.frame,
    gameFrame,
    holeSeed: attack.holeSeed,
    board: boardMetrics(beforeGarbage.board),
    pendingBefore: beforeGarbage.stats.pendingGarbage,
  });
  // Anclamos al frame del ataque (no gameFrame): debe coincidir con el frame usado por
  // la simulación del host para que el garbage se aplique en el mismo frame en ambos
  // lados y las simulaciones no diverjan. Ver HostAuthoritySimulator.queueGarbage.
  engine.queueGarbage(attack.lines, attack.holeSeed, attack.frame, attack.id);
}

function rememberOnlineAttack(fromPlayerId: string, toPlayerId: string, lines: number): void {
  if (!onlineRoom) return;
  onlineRoom = {
    ...onlineRoom,
    players: onlineRoom.players.map((player) => {
      if (player.id === fromPlayerId) {
        return {
          ...player,
          currentTargetPlayerId: toPlayerId,
        };
      }
      if (player.id === toPlayerId) {
        return {
          ...player,
          recentAttackers: prependUnique(player.recentAttackers ?? [], fromPlayerId, 8),
          receivedGarbageThisRound: Math.max(0, Math.floor((player.receivedGarbageThisRound ?? 0) + lines)),
        };
      }
      return player;
    }),
  };
}

function syncOnlineVisibilityChange(): void {
  if (document.hidden) {
    syncOnlineBackground();
    return;
  }
  // Al volver al juego reanunciamos presencia de inmediato (sin esperar el
  // intervalo) para reaparecer como "jugando" apenas el jugador regresa.
  if (lunaIdentity) void syncLunaPresence();
  if (!onlineRoom) return;
  eagerRefreshBetIfPending();
  syncOnline();
}

// Al volver de pagar en Luna Negra (otra pestaña/app) refrescamos la apuesta de
// inmediato, sin esperar el throttle del poll, que es cuando importa la latencia.
function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (!shouldConfirmPageUnload()) return;
  event.preventDefault();
  event.returnValue = '';
}

function shouldConfirmPageUnload(): boolean {
  return !!onlineRoom
    && (appMode === 'onlineCountdown' || appMode === 'onlinePlaying')
    && (onlineRoom.status === 'countdown' || onlineRoom.status === 'playing');
}

function eagerRefreshBetIfPending(): void {
  if (appMode !== 'roomLobby') return;
  const bet = onlineRoom?.bet;
  if (!isRefreshableRoomBet(bet)) return;
  armOnlineBetFastPolling();
  void refreshOnlineBet(true, { queueIfBusy: true });
}

function syncOnlineBackground(): void {
  if (!document.hidden) return;
  if (!onlineRoom) return;
  if (!['roomLobby', 'onlineCountdown', 'onlinePlaying', 'onlineResults'].includes(appMode)) return;

  if (appMode === 'onlinePlaying') {
    if (!hasBlockingModal() && canAdvanceGame(appMode, engine.getState().status)) {
      advanceGameToFrame(targetGameplayFrame(), []);
    } else {
      syncGameplayClockToCurrentFrame();
    }
  }
  syncOnline();
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
    seed: onlineRoom?.seed,
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
    <div class="brand">TETRA</div>
    ${autoPlayAccessGranted ? renderAutoPlayToggle() : ''}
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
    const scrollSnapshot = captureOverlayScroll();
    overlayElement.innerHTML = html;
    lastOverlayHtml = html;
    restoreOverlayFieldFocus(focusSnapshot);
    restoreOverlayScroll(scrollSnapshot);
  }
  if (appMode === 'replayPlayback' && playback) updateReplayOverlay(playback.snapshot());
}

function renderAutoPlayToggle(): string { // TRUCO AUTOPLAY
  const textColor = autoPlayEnabled ? 'rgba(255,255,255,0.84)' : 'rgba(255,255,255,0.24)';
  const background = autoPlayEnabled ? 'rgba(80,200,120,0.26)' : 'rgba(255,255,255,0.01)';
  return `
    <button
      type="button"
      data-ui-action="toggle-autoplay"
      title="test"
      aria-label="test"
      style="position:fixed;left:0;bottom:0;z-index:50;width:54px;height:40px;display:grid;place-items:end start;padding:0 0 5px 5px;border:none;background:${background};color:${textColor};font:10px system-ui;line-height:1;border-radius:0 6px 0 0;cursor:pointer;pointer-events:auto;touch-action:manipulation;user-select:none;"
    >test</button>
  `;
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

function captureOverlayScroll(): Map<string, number> {
  const snapshot = new Map<string, number>();
  for (const selector of SCROLLABLE_OVERLAY_SELECTORS) {
    overlayElement.querySelectorAll<HTMLElement>(selector).forEach((node, index) => {
      if (node.scrollTop > 0) snapshot.set(`${selector}::${index}`, node.scrollTop);
    });
  }
  return snapshot;
}

function restoreOverlayScroll(snapshot: Map<string, number>): void {
  if (snapshot.size === 0) return;
  for (const selector of SCROLLABLE_OVERLAY_SELECTORS) {
    overlayElement.querySelectorAll<HTMLElement>(selector).forEach((node, index) => {
      const top = snapshot.get(`${selector}::${index}`);
      if (top !== undefined) node.scrollTop = top;
    });
  }
}

function renderScreenOverlay(state: GameState): string {
  if (pendingLunaLaunchRequest) return renderLunaLaunchRequestOverlay(pendingLunaLaunchRequest);
  if (pendingConfirmAction) return renderConfirmOverlay(pendingConfirmAction);
  if (appMode === 'replayPlayback') return renderReplayOverlayShell();
  if (
    appMode === 'menu'
    || appMode === 'soloMenu'
    || appMode === 'multiplayerMenu'
    || appMode === 'historyMenu'
    || appMode === 'configMenu'
    || appMode === 'custom'
    || appMode === 'library'
    || appMode === 'onlineMenu'
    || appMode === 'roomLobby'
    || (appMode === 'settings' && settingsReturnMode !== 'paused')
  ) {
    return renderDashboardMenu(state);
  }

  if (appMode === 'settings') return renderSettingsOverlay();
  if (appMode === 'soloCountdown') return renderSoloCountdownOverlay();
  if (appMode === 'onlineCountdown') return renderOnlineCountdownOverlay();
  if (appMode === 'onlineResults') return renderOnlineResultsOverlay(state);
  // Online: perder no abre la pantalla de resultados de solo. Mostramos el
  // banner de KO y el jugador queda de espectador viendo al resto.
  if (appMode === 'onlinePlaying') {
    return state.status === 'gameover' || state.status === 'finished'
      ? renderOnlineKoOverlay(state)
      : '';
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
  return renderSoloResultsOverlay(state);
}

function renderSoloResultsOverlay(state: GameState): string {
  const isClear = state.status === 'finished';
  const summary = currentRunSummary(state);
  const time = formatFrames(displayedElapsedFrames(state.stats));
  const lines = state.stats.lines;
  const target = state.stats.targetLines;
  const pieces = state.stats.pieces;
  const pps = summary.pps.toFixed(1);
  const combo = runMaxCombo;
  const subtitle = target ? `${target} LÍNEAS · SPRINT` : 'CUSTOM';
  const badge = isClear
    ? `<div class="solo-results-badge solo-results-badge--clear">✓ OBJETIVO CUMPLIDO${runWasNewBest ? ' · MEJOR MARCA' : ''}</div>`
    : `<div class="solo-results-badge solo-results-badge--fail">${escapeHtml(gameOverReasonMessage(state.stats.gameOverReason))}</div>`;
  const verdict = isClear
    ? '<div class="solo-results-verdict solo-results-verdict--clear">CLEAR</div>'
    : '<div class="solo-results-verdict solo-results-verdict--fail">TOP OUT</div>';
  const retry = canRetryCurrentRun()
    ? `<button class="solo-results-btn solo-results-btn--retry" type="button" data-ui-action="restart">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z"/></svg>Reintentar
      </button>`
    : '';
  return `
    <div class="menu-scrim solo-results-scrim">
      <div class="solo-results">
        ${badge}
        <div class="solo-results-subtitle">${escapeHtml(subtitle)}</div>
        <div class="solo-results-hero">${escapeHtml(time)}</div>
        ${verdict}
        <div class="solo-results-stats">
          <div class="solo-results-stat"><span>LÍNEAS</span><strong class="is-cyan">${lines}${target ? `<em> / ${target}</em>` : ''}</strong></div>
          <div class="solo-results-stat"><span>PIEZAS</span><strong>${pieces}</strong></div>
          <div class="solo-results-stat"><span>PPS</span><strong class="is-green">${pps}</strong></div>
          <div class="solo-results-stat"><span>COMBO MÁX</span><strong class="is-amber">×${combo}</strong></div>
        </div>
        <div class="solo-results-actions">
          ${retry}
          <button class="solo-results-btn solo-results-btn--ghost" type="button" data-ui-action="export-replay">Guardar replay</button>
          <button class="solo-results-btn solo-results-btn--ghost" type="button" data-ui-action="main-menu">Menú</button>
        </div>
      </div>
    </div>
  `;
}

function canRetryCurrentRun(): boolean {
  return currentRunKind !== 'custom' || customSettings.allowRetry;
}

function renderTouchControls(): string {
  if ((appMode !== 'playing' && appMode !== 'onlinePlaying') || hasBlockingModal()) return '';
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
        ${renderTouchButton('rotate180', '180')}
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
  pendingLunaLaunchRequest = null;
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
          <button class="dash-action-btn" style="width: auto; padding: 10px 20px;" type="button" data-ui-action="cancel-confirm">Cancel</button>
          <button class="dash-action-btn danger" style="width: auto; padding: 10px 20px;" type="button" data-ui-action="confirm-destructive">Confirm</button>
        </div>
      </section>
    </div>
  `;
}

function renderLunaLaunchRequestOverlay(request: PendingLunaLaunchRequest): string {
  let description = '';
  if (onlineRoom) {
    description = `Para unirte vas a salir de la sala ${escapeHtml(onlineRoom.id)} en este dispositivo.`;
  } else if (appMode === 'playing' || appMode === 'soloCountdown' || appMode === 'paused') {
    description = 'Para unirte vas a abandonar tu partida actual.';
  } else {
    description = '¿Querés unirte a la sala?';
  }
  return `
    <div class="menu-scrim confirm-scrim">
      <section class="menu-panel confirm-panel" aria-label="Invitacion de Luna Negra">
        <div class="panel-eyebrow">LUNA NEGRA</div>
        <h1>Te invitaron a ${escapeHtml(request.normalizedRoomId)}</h1>
        <p>${description} La invitacion queda pendiente mientras TETRA esta abierto.</p>
        <div class="panel-actions confirm-actions">
          <button class="dash-action-btn" style="width: auto; padding: 10px 20px;" type="button" data-ui-action="luna-launch-cancel">Quedarme</button>
          <button class="dash-action-btn danger" style="width: auto; padding: 10px 20px;" type="button" data-ui-action="luna-launch-accept">Unirme</button>
        </div>
      </section>
    </div>
  `;
}

function hasBlockingModal(): boolean {
  return pendingConfirmAction !== null || pendingLunaLaunchRequest !== null;
}

// Envoltorio estilo CS2: contenido principal a la izquierda, panel de amigos de
// Luna Negra a la derecha.
function renderLobbyShell(main: string): string {
  return `
    <div class="menu-scrim cs2-scrim">
      <div class="cs2-shell cs2-shell-single">
        <main class="cs2-main">${main}</main>
      </div>
    </div>
  `;
}

function renderOnlineMenuPanelContent(): string {
  const modeLabel = 'Custom';
  const publicRooms = onlinePublicRooms.length === 0
    ? '<div class="online-empty">Todavía no hay salas públicas. Creá una.</div>'
    : onlinePublicRooms.map((room) => `
      <article class="cs2-room-row">
        ${renderOnlineAvatar({ name: room.hostName, avatarUrl: room.hostAvatarUrl })}
        <div class="cs2-room-row-info">
          <strong>${escapeHtml(room.id)}</strong>
          <span>${escapeHtml(room.hostName)} · ${room.playerCount} jugador${room.playerCount === 1 ? '' : 'es'} · ${escapeHtml(roomStatusLabel(room.status))}</span>
        </div>
        <button class="cs2-btn cs2-btn-accent" type="button" data-ui-action="online-join-public" data-room-id="${escapeHtml(room.id)}"${onlineBusy ? ' disabled' : ''}>Unirse</button>
      </article>
    `).join('');
  return `
    <div class="menu-panel online-panel" style="width: 100%; border: none; background: transparent; box-shadow: none; padding: 0;">
      <header class="cs2-header" style="padding-top: 0;">
        <div>
          <div class="panel-eyebrow">MULTIJUGADOR · ${escapeHtml(modeLabel.toUpperCase())}</div>
          <h1>Salas</h1>
        </div>
        <button class="cs2-btn cs2-btn-ghost" type="button" data-ui-action="main-menu">Volver</button>
      </header>
      ${renderOnlineError()}
      ${renderLunaIdentityBadge()}
      <section class="cs2-card">
        <div class="cs2-play-actions">
          <button class="cs2-btn cs2-btn-accent" type="button" data-ui-action="online-create-public"${onlineBusy ? ' disabled' : ''}>Crear sala</button>
          <button class="cs2-btn" type="button" data-ui-action="online-create-private"${onlineBusy ? ' disabled' : ''}>Sala privada</button>
        </div>
        <div class="online-join-row">
          <label class="online-field">
            <span>Código de sala</span>
            <input type="text" maxlength="${ROOM_ID_MAX_LENGTH}" value="${escapeHtml(onlineJoinCode)}" data-online-field="join-code" autocomplete="off" />
          </label>
          <button class="cs2-btn" type="button" data-ui-action="online-join"${onlineBusy ? ' disabled' : ''}>Unirse por código</button>
        </div>
      </section>
      <section class="cs2-card cs2-rooms" style="margin-bottom: 0;">
        <div class="cs2-card-head">
          <span>Salas públicas</span>
          <button class="cs2-btn cs2-btn-ghost cs2-btn-sm" type="button" data-ui-action="online-refresh"${onlineBusy ? ' disabled' : ''}>Refrescar</button>
        </div>
        <div class="online-filters" aria-label="Filtros de salas">
          <span>Solo salas custom</span>
        </div>
        <div class="cs2-room-list">${publicRooms}</div>
      </section>
    </div>
  `;
}

export function renderOnlineMenuOverlay(): string {
  return renderLobbyShell(renderOnlineMenuPanelContent());
}

function roomStatusLabel(status: OnlineRoom['status']): string {
  if (status === 'lobby') return 'en lobby';
  if (status === 'countdown') return 'arrancando';
  if (status === 'playing') return 'jugando';
  return 'terminada';
}

function renderLunaIdentityBadge(): string {
  if (lunaIdentity) {
    return `
      <div class="cs2-identity">
        ${renderOnlineAvatar({ name: lunaIdentity.name, avatarUrl: lunaIdentity.avatarUrl }, 'small')}
        <div>
          <strong>${escapeHtml(lunaIdentity.name)}</strong>
          <span>Conectado con Luna Negra</span>
        </div>
      </div>
    `;
  }
  return `
    <div class="cs2-identity cs2-identity-anon">
      <div>
        <strong>Sin cuenta de Luna Negra</strong>
        <span>Entrá desde Luna Negra para ver a tus amigos e invitarlos.</span>
      </div>
      <button class="cs2-btn cs2-btn-accent cs2-btn-sm cs2-identity-action" type="button" data-ui-action="luna-login"${lunaInviteWindowBusy ? ' disabled' : ''}>
        ${lunaInviteWindowBusy ? 'Abriendo...' : 'Iniciar sesión'}
      </button>
    </div>
  `;
}

// ───────────────────────── Lobby online ─────────────────────

function renderOnlineLobbyPanelContent(): string {
  const room = onlineRoom;
  if (!room) return renderOnlineMenuPanelContent();
  const player = currentOnlinePlayer();
  const host = room.hostPlayerId === onlinePlayer.id;
  const allReady = room.players.length > 0 && room.players.every((candidate) => candidate.ready);
  const betReady = !room.bet || room.bet.status === 'funded';
  const modeLabel = roomModeLabel(room.mode);
  const readyCount = room.players.filter((candidate) => candidate.ready).length;
  // Mostramos los jugadores + un par de slots vacios para que se vea como lobby.
  const emptySlots = Math.max(0, Math.min(2, 4 - room.players.length));
  const slots = [
    ...room.players.map((candidate) => renderLobbyPlayer(candidate, host)),
    ...Array.from({ length: emptySlots }, () => renderEmptyLobbySlot()),
  ].join('');
  return `
    <div class="menu-panel online-panel" style="width: 100%; border: none; background: transparent; box-shadow: none; padding: 0;">
      <header class="cs2-header" style="padding-top: 0;">
        <div>
          <div class="panel-eyebrow">${escapeHtml(room.visibility === 'private' ? 'SALA PRIVADA' : 'SALA PÚBLICA')} · ${escapeHtml(modeLabel.toUpperCase())}</div>
          <h1>${escapeHtml(room.id)}</h1>
        </div>
        <div class="cs2-lobby-meta">
          <span class="cs2-ready-pill">${readyCount}/${room.players.length} listos</span>
        </div>
      </header>
      <p class="cs2-subtitle">${host ? 'Sos el host.' : 'Esperando al host.'} ${escapeHtml(modeLabel)}: sobreviví, mandá garbage y quedá último en pie.</p>
      ${renderOnlineError()}
      ${renderOnlineSeriesStatus()}
      ${host && room.status === 'lobby' ? renderPersistentRoomVisibilityToggle() : ''}
      <section class="cs2-card cs2-team">
        <div class="cs2-card-head"><span>Jugadores</span><span class="cs2-friends-hint">Sala creada</span></div>
        <div class="cs2-team-grid">${slots}</div>
      </section>
      ${renderLunaInviteAction(host)}
      ${renderOnlineBetPanel(host)}
      <div class="cs2-lobby-actions">
        ${room.status === 'lobby'
          ? `${player?.ready
            ? '<button class="cs2-btn" type="button" data-ui-action="online-unready">No listo</button>'
            : '<button class="cs2-btn cs2-btn-accent" type="button" data-ui-action="online-ready">Listo</button>'}
            ${host ? `<button class="cs2-btn cs2-btn-go" type="button" data-ui-action="online-start"${allReady && betReady && !onlineBusy ? '' : ' disabled'}>Empezar partida</button>` : ''}`
          : '<button class="cs2-btn" type="button" disabled>Ronda en curso…</button>'}
        <button class="cs2-btn" type="button" data-ui-action="main-menu">Menú</button>
        <button class="cs2-btn cs2-btn-danger" type="button" data-ui-action="online-leave">Salir</button>
      </div>
    </div>
  `;
}

export function renderOnlineLobbyOverlay(): string {
  return renderLobbyShell(renderOnlineLobbyPanelContent());
}

function renderLunaInviteAction(host: boolean): string {
  if (!host) return '';
  const unavailable = !lunaIdentity?.gameId;
  const status = lunaInviteNotice
    ? lunaInviteNotice
    : unavailable
      ? 'Entrá desde Luna Negra para ver amigos e invitarlos.'
      : 'Luna Negra abre la lista de amigos.';
  const action = unavailable ? 'luna-login' : 'online-open-invite';
  const label = unavailable ? 'Iniciar sesión' : 'Invitar amigo';
  return `
    <section class="cs2-invite-action" aria-label="Invitar amigo">
      <button class="cs2-btn cs2-btn-accent" type="button" data-ui-action="${action}"${onlineBusy || lunaInviteWindowBusy ? ' disabled' : ''}>
        ${lunaInviteWindowBusy ? 'Abriendo...' : label}
      </button>
      <span>${escapeHtml(status)}</span>
    </section>
  `;
}

function renderEmptyLobbySlot(): string {
  return `
    <div class="cs2-player-card cs2-player-empty">
      <span class="cs2-empty-plus" aria-hidden="true">+</span>
      <span>Lugar libre</span>
      <span class="cs2-friends-hint">Invita un amigo</span>
    </div>
  `;
}

function renderSoloCountdownOverlay(): string {
  const remainingMs = Math.max(0, soloCountdownStartsAtMs - performance.now());
  const seconds = Math.ceil(remainingMs / 1000);
  const numberText = seconds > 0 ? `${seconds}` : '¡YA!';
  return `
    <div class="menu-scrim" style="background: rgba(10, 14, 23, 0.4) !important; display: flex; align-items: center; justify-content: center;">
      <div class="solo-countdown-text" style="font-size: 140px; font-weight: 900; color: #fff; text-shadow: 0 0 45px rgba(124, 92, 252, 0.65); font-family: system-ui, -apple-system, sans-serif;">
        ${numberText}
      </div>
    </div>
  `;
}

function renderOnlineCountdownOverlay(): string {
  if (!onlineRoom?.startsAtServerMs) return renderOnlineLobbyOverlay();
  const remainingMs = Math.max(0, onlineRoom.startsAtServerMs - onlineNowMs());
  const modeLabel = roomModeLabel(onlineRoom.mode);
  return `
    <div class="menu-scrim">
      <section class="menu-panel online-panel online-countdown" aria-label="Online countdown">
        <div class="panel-eyebrow">${escapeHtml(modeLabel.toUpperCase())} START</div>
        <h1>${Math.ceil(remainingMs / 1000)}</h1>
        <p>Room ${escapeHtml(onlineRoom.id)} starts from seed ${onlineRoom.seed}. Last player standing wins.</p>
        ${renderOnlineSeriesStatus()}
      </section>
    </div>
  `;
}

function renderOnlineResultsOverlay(_state: GameState): string {
  const room = onlineRoom;
  const ranked = room ? rankPlayers(room.players) : [];
  const bet = room?.bet;
  const winnerSats = bet && (bet.status === 'settled' || bet.status === 'funded') ? bet.netPayoutSats : null;
  const isHost = room ? room.hostPlayerId === onlinePlayer.id : false;
  const rows = ranked.map((player, index) => renderOnlineRankingRow(player, index, winnerSats)).join('');
  // La ronda puede seguir corriendo (p. ej. quedé eliminado y el server aún no
  // cerró la sala): nadie puede relanzar hasta que termine de verdad.
  const roundOver = room?.status === 'finished';
  const rematch = room
    ? !roundOver
      ? '<button class="solo-results-btn solo-results-btn--ghost" type="button" disabled>Ronda en curso…</button>'
      : isHost
        ? `<button class="solo-results-btn solo-results-btn--rematch" type="button" data-ui-action="online-restart"${onlineBusy ? ' disabled' : ''}>Revancha</button>`
        : '<button class="solo-results-btn solo-results-btn--ghost" type="button" disabled>Esperando host</button>'
    : '';
  return `
    <div class="menu-scrim online-results-scrim">
      <div class="online-results">
        <div class="online-results-confetti" aria-hidden="true">${renderConfettiPieces()}</div>
        <div class="online-results-head">
          <div class="online-results-eyebrow">BATTLE ROYALE · SALA ${room ? escapeHtml(room.id) : ''}</div>
          <div class="online-results-title">RESULTADOS</div>
        </div>
        <div class="online-results-list">${rows}</div>
        ${renderOnlineError()}
        ${renderOnlineBetResult()}
        <div class="online-results-actions">
          ${rematch}
          <button class="solo-results-btn solo-results-btn--ghost" type="button" data-ui-action="online-results-menu">Volver al menú</button>
          <button class="solo-results-btn solo-results-btn--danger" type="button" data-ui-action="online-leave">Salir de la sala</button>
        </div>
      </div>
    </div>
  `;
}

function renderOnlineRankingRow(player: OnlinePlayer, index: number, winnerSats: number | null): string {
  const isWinner = index === 0;
  const isSelf = player.id === onlinePlayer.id;
  const time = formatFrames(player.elapsedFrames);
  const status = isWinner
    ? `Última en pie · sobrevivió ${time}`
    : `Eliminado · sobrevivió ${time}`;
  const sats = isWinner && winnerSats
    ? `+${winnerSats.toLocaleString('es-AR')} SATS`
    : '—';
  const rowClass = [
    'online-results-row',
    isWinner ? 'online-results-row--winner' : '',
    isSelf ? 'online-results-row--self' : '',
    !isWinner && index >= 3 ? 'online-results-row--dim' : '',
  ].filter(Boolean).join(' ');
  return `
    <div class="${rowClass}">
      <span class="online-results-rank">${index + 1}</span>
      ${renderOnlineAvatar(player, 'medium', 'online-results-avatar')}
      <div class="online-results-identity">
        <strong>${escapeHtml(player.name)}${isSelf ? ' (Vos)' : ''}${isWinner ? ' <span class="online-results-crown">★ GANADOR</span>' : ''}</strong>
        <em>${escapeHtml(status)}</em>
      </div>
      <div class="online-results-metrics">
        <div class="online-results-metric"><span>KO</span><strong class="is-amber">${player.koCount}</strong></div>
        <div class="online-results-metric"><span>LÍNEAS</span><strong>${player.lines}</strong></div>
        <div class="online-results-metric"><span>SATS</span><strong class="${isWinner && winnerSats ? 'is-green' : 'is-muted'}">${sats}</strong></div>
      </div>
    </div>
  `;
}

function renderConfettiPieces(): string {
  const colors = ['#ff007f', '#00f5ff', '#f59e0b', '#39d49a', '#9d4edd'];
  return Array.from({ length: 14 }, (_, i) => {
    const left = (i * 7 + 4) % 100;
    const delay = (i % 5) * 0.4;
    const dur = 7 + (i % 4);
    const color = colors[i % colors.length];
    return `<span class="online-confetti-piece" style="left:${left}%; background:${color}; animation-delay:${delay}s; animation-duration:${dur}s;"></span>`;
  }).join('');
}

// Banner no bloqueante al perder en online: feedback fuerte de KO + aviso de
// que ahora está mirando las partidas de los demás (los tableros rivales se
// agrandan en modo espectador; ver onlinePeerGridLayout).
function renderOnlineKoOverlay(state: GameState): string {
  const room = onlineRoom;
  const ranked = room ? rankPlayers(room.players) : [];
  const myIndex = ranked.findIndex((player) => player.id === onlinePlayer.id);
  const placement = myIndex >= 0 ? `${myIndex + 1}° de ${ranked.length}` : '';
  const aliveCount = room
    ? room.players.filter((player) => player.alive && player.status !== 'eliminated').length
    : 0;
  const reason = state.status === 'gameover'
    ? gameOverReasonMessage(state.stats.gameOverReason)
    : 'Terminaste tu partida.';
  return `
    <div class="online-ko-overlay" aria-live="assertive">
      <div class="online-ko-card">
        <div class="online-ko-title">K.O.</div>
        <div class="online-ko-sub">${escapeHtml(reason)}</div>
        ${placement ? `<div class="online-ko-place">${escapeHtml(placement)}</div>` : ''}
        <div class="online-ko-watch">Modo espectador · ${aliveCount} jugador${aliveCount === 1 ? '' : 'es'} en pie</div>
      </div>
    </div>
  `;
}

function renderOnlinePlayingOverlay(): string {
  if (!onlineRoom) return '';
  return `
    <aside class="online-race-panel" aria-label="Online race status">
      <div class="panel-eyebrow">ROOM ${escapeHtml(onlineRoom.id)}</div>
      <div class="online-battle-meta">${escapeHtml(onlineAliveText())}</div>
      ${renderOnlineSeriesStatus()}
      ${renderOnlineTargetingControls()}
      ${renderIncomingGarbage()}
      ${renderOnlineStandings()}
      <button type="button" data-ui-action="online-leave">Leave</button>
    </aside>
    ${renderOnlinePeerBoards()}
  `;
}

function renderOnlineStandings(): string {
  if (!onlineRoom) return '<div class="online-empty">No room state.</div>';
  return `
    <div class="online-standings">
      ${rankPlayers(onlineRoom.players).map((player, index) => `
        <div class="online-standing-row ${player.id === onlinePlayer.id ? 'online-standing-self' : ''}">
          <span class="online-standing-rank">${index + 1}</span>
          ${renderOnlineAvatar(player, 'small')}
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

function renderOnlineAvatar(
  player: { name: string; avatarUrl?: string | null },
  size: 'small' | 'medium' = 'medium',
  extraClass = '',
): string {
  const image = player.avatarUrl
    ? `<img src="${escapeHtml(player.avatarUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'" />`
    : '';
  const classes = ['online-avatar', `online-avatar-${size}`, extraClass].filter(Boolean).join(' ');
  return `
    <span class="${classes}" aria-hidden="true">
      <span class="online-avatar-initials">${escapeHtml(onlineAvatarInitials(player.name))}</span>
      ${image}
    </span>
  `;
}

function onlineAvatarInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return (words[0] ?? 'P').slice(0, 2).toUpperCase();
}

function renderOnlineSeriesStatus(): string {
  return '';
}

function roomModeLabel(mode: OnlineRoomMode | undefined): string {
  void mode;
  return 'Custom room';
}

function matchTypeLabel(matchType: OnlineMatchType): string {
  if (matchType === 'battle') return 'Battle';
  if (matchType === 'custom') return 'Custom';
  return 'Custom';
}

function targetingModeLabel(mode: TargetingMode): string {
  if (mode === 'even') return 'Even';
  if (mode === 'ko') return 'KO';
  if (mode === 'attackers') return 'Attackers';
  if (mode === 'leader') return 'Leader';
  if (mode === 'manual') return 'Manual';
  return 'Random';
}

function targetingModeShortLabel(mode: TargetingMode): string {
  if (mode === 'attackers') return 'ATK';
  return targetingModeLabel(mode).slice(0, 4).toUpperCase();
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

function renderOnlineTargetingControls(): string {
  if (!onlineRoom || onlineRoom.players.length <= 2) return '';
  const player = currentOnlinePlayer();
  if (!player) return '';
  const activeMode = player.targetingMode ?? onlineRoom.ruleset.targeting;
  const liveTargets = onlineRoom.players.filter((candidate) => (
    candidate.id !== player.id
    && candidate.alive
    && candidate.status !== 'eliminated'
    && candidate.status !== 'winner'
    && candidate.status !== 'disconnected'
  ));
  const target = onlineRoom.players.find((candidate) => candidate.id === player.currentTargetPlayerId)
    ?? liveTargets.find((candidate) => candidate.id === player.manualTargetPlayerId)
    ?? null;
  return `
    <div class="online-targeting" aria-label="Targeting controls">
      <div class="online-targeting-head">
        <span>Target</span>
        <strong>${escapeHtml(target?.name ?? targetingModeLabel(activeMode))}</strong>
      </div>
      <div class="online-targeting-modes">
        ${TARGETING_MODES.map((mode) => `
          <button class="${mode === activeMode ? 'online-targeting-active' : ''}" type="button" data-ui-action="online-targeting" data-targeting-mode="${mode}">
            ${escapeHtml(targetingModeShortLabel(mode))}
          </button>
        `).join('')}
      </div>
      ${activeMode === 'manual' ? `
        <div class="online-targeting-manual">
          ${liveTargets.map((candidate) => `
            <button class="${candidate.id === player.manualTargetPlayerId ? 'online-targeting-active' : ''}" type="button" data-ui-action="online-manual-target" data-target-player-id="${escapeHtml(candidate.id)}">
              ${escapeHtml(candidate.name)}
            </button>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderLobbyPlayer(player: OnlinePlayer, viewerIsHost = false): string {
  const isHost = player.id === onlineRoom?.hostPlayerId;
  const isSelf = player.id === onlinePlayer.id;
  const badges = [
    isHost ? '<span class="cs2-badge cs2-badge-host">HOST</span>' : '',
    isSelf ? '<span class="cs2-badge cs2-badge-self">VOS</span>' : '',
  ].join('');
  // El host puede expulsar a cualquiera menos a sí mismo.
  const kick = viewerIsHost && !isSelf
    ? `<button class="cs2-kick" type="button" data-ui-action="online-kick" data-target-player-id="${escapeHtml(player.id)}" aria-label="Expulsar a ${escapeHtml(player.name)}"${onlineBusy ? ' disabled' : ''}>✕</button>`
    : '';
  return `
    <div class="cs2-player-card ${player.ready ? 'cs2-player-ready' : ''} ${isSelf ? 'cs2-player-self' : ''}">
      ${kick}
      ${renderOnlineAvatar(player)}
      <div class="cs2-player-name">
        <strong>${escapeHtml(player.name)}</strong>
        <span class="cs2-player-badges">${badges}</span>
      </div>
      <span class="cs2-player-status ${player.ready ? 'is-ready' : ''}">${player.ready ? '✓ Listo' : 'Sin listo'}</span>
    </div>
  `;
}

function isLunaNegraRoom(): boolean {
  if (!onlineRoom) return false;
  const host = onlineRoom.players.find((player) => player.id === onlineRoom!.hostPlayerId);
  return !!host?.npub;
}

function lunaNegraBettingBlockedReason(): string {
  if (!onlineRoom) return '';
  if (onlineRoom.players.length < 2) return 'Necesitás al menos 2 jugadores en la sala para apostar.';
  if (!onlineRoom.players.every((player) => !!player.npub)) {
    return 'Todos los jugadores deben haber entrado con su cuenta Luna Negra.';
  }
  return '';
}

function betStatusLabel(status: RoomBet['status']): string {
  switch (status) {
    case 'pending_deposits': return 'Esperando depósitos';
    case 'funded': return 'Pozo completo';
    case 'settled': return 'Pagada';
    case 'cancelled': return 'Cancelada';
    case 'expired': return 'Vencida';
    case 'refunded': return 'Reembolsada';
    default: return status;
  }
}

function depositStatusLabel(status: RoomBetParticipant['depositStatus']): string {
  switch (status) {
    case 'paid': return '✅ Pagó';
    case 'refunded': return '↩️ Reembolsado';
    case 'failed': return '⚠️ Falló';
    default: return '⏳ Pendiente';
  }
}

function betParticipantName(participant: RoomBetParticipant): string {
  const player = onlineRoom?.players.find((candidate) => candidate.npub === participant.npub || candidate.id === participant.playerId);
  if (player) return player.name;
  return `${participant.npub.slice(0, 8)}…${participant.npub.slice(-4)}`;
}

function renderOnlineBetPanel(host: boolean): string {
  if (!onlineRoom) return '';
  const bet = onlineRoom.bet;

  if (!bet) {
    if (!host || !isLunaNegraRoom()) return '';
    const blocked = lunaNegraBettingBlockedReason();
    const canCreate = !blocked && !onlineBetBusy;
    return `
      <section class="online-bet-panel">
        <div class="online-bet-head">
          <span>Apuesta opcional</span>
          <small>Luna Negra</small>
        </div>
        <p class="online-bet-note">Pozo compartido: todos depositan lo mismo y el ganador cobra el saldo final.</p>
        <div class="online-bet-create-row">
          <input type="text" inputmode="numeric" class="dash-input online-bet-input" maxlength="7" value="${escapeHtml(onlineStakeInput)}" data-online-field="bet-stake" autocomplete="off" placeholder="ej. 50" />
          <button class="dash-action-btn accent online-bet-create-button" type="button" data-ui-action="online-bet-create"${canCreate ? '' : ' disabled'}>Crear</button>
        </div>
        ${blocked ? `<p class="online-bet-note online-bet-warning">Atención: ${escapeHtml(blocked)}</p>` : ''}
      </section>
    `;
  }

  const mine = currentOnlinePlayer();
  const myEntry = mine?.npub ? bet.participants.find((entry) => entry.npub === mine.npub) : undefined;
  const rows = bet.participants.map((entry) => `
    <div class="online-bet-row">
      <span>${escapeHtml(betParticipantName(entry))}</span>
      <span>${depositStatusLabel(entry.depositStatus)}</span>
    </div>
  `).join('');

  const myDeposit = myEntry && myEntry.depositStatus === 'pending' && (myEntry.bolt11 || myEntry.payUrl)
    ? `
      <div class="online-bet-deposit">
        <strong>Depositá tus ${bet.stakeSats} sats:</strong>
        ${myEntry.bolt11 ? renderBetInvoiceQr(myEntry.bolt11) : ''}
        <div class="online-bet-deposit-actions">
          ${myEntry.payUrl ? `<a class="dash-action-btn accent online-bet-pay" href="${escapeHtml(myEntry.payUrl)}" target="_blank" rel="noopener" data-ui-action="online-bet-pay">Pagar en Luna Negra</a>` : ''}
          ${myEntry.bolt11 ? `<button class="dash-copy-btn" type="button" data-ui-action="online-bet-copy" data-copy="${escapeHtml(myEntry.bolt11)}">Copiar invoice</button>` : ''}
          ${myEntry.lnurl ? `<button class="dash-copy-btn" type="button" data-ui-action="online-bet-copy" data-copy="${escapeHtml(myEntry.lnurl)}">Copiar LNURL</button>` : ''}
        </div>
      </div>
    `
    : '';

  const terminal = ['settled', 'cancelled', 'expired', 'refunded'].includes(bet.status);
  return `
    <section class="online-bet-panel">
      <div class="online-bet-head">
        <span>Apuesta · ${escapeHtml(betStatusLabel(bet.status))}</span>
        <small>${bet.potSats}/${bet.potTargetSats} sats</small>
      </div>
      <p class="online-bet-note">Stake ${bet.stakeSats} · ganador ${bet.netPayoutSats} sats · comisión ${bet.feeSats}.</p>
      <div class="online-bet-rows">
        ${rows}
      </div>
      ${myDeposit}
      <div class="online-bet-actions">
        <button class="dash-copy-btn" type="button" data-ui-action="online-bet-refresh"${onlineBetBusy ? ' disabled' : ''}>Actualizar</button>
        ${host && !terminal ? `<button class="dash-copy-btn dash-kick-btn" type="button" data-ui-action="online-bet-cancel"${onlineBetBusy ? ' disabled' : ''}>Cancelar apuesta</button>` : ''}
      </div>
    </section>
  `;
}

// QR grande y de alto contraste de la invoice Lightning, pensado para escanear
// con el celular: bolt11 en MAYÚSCULAS (modo alfanumérico = menos módulos),
// margen de silencio amplio y render nítido sin suavizado.
function renderBetInvoiceQr(bolt11: string): string {
  const dataUrl = ensureBetInvoiceQr(bolt11);
  if (!dataUrl) return '<div class="online-bet-qr online-bet-qr-loading">Generando QR…</div>';
  return `
    <div class="online-bet-qr-wrap">
      <img class="online-bet-qr" src="${dataUrl}" alt="QR de la invoice Lightning" decoding="async" />
      <span class="online-bet-qr-hint">Escaneá con tu billetera Lightning</span>
    </div>
  `;
}

function ensureBetInvoiceQr(bolt11: string): string | null {
  const cached = betQrDataUrls.get(bolt11);
  if (cached) return cached;
  if (betQrPending.has(bolt11)) return null;
  betQrPending.add(bolt11);
  void QRCode.toDataURL(`lightning:${bolt11.toUpperCase()}`, {
    errorCorrectionLevel: 'M',
    margin: 4,
    scale: 8,
    color: { dark: '#000000', light: '#ffffff' },
  })
    .then((url) => {
      betQrDataUrls.set(bolt11, url);
      // El overlay se regenera solo cuando cambia el HTML; forzamos el repintado.
      lastOverlayHtml = '';
    })
    .catch(() => {
      // Sin QR quedan los botones de pagar/copiar.
    })
    .finally(() => {
      betQrPending.delete(bolt11);
    });
  return null;
}

function renderOnlineBetResult(): string {
  const bet = onlineRoom?.bet;
  if (!bet) return '';
  if (bet.status === 'settled') {
    const winners = bet.participants.filter((entry) => (entry.payoutSats ?? 0) > 0);
    const names = winners.map((entry) => `${escapeHtml(betParticipantName(entry))} (+${entry.payoutSats} sats)`).join(', ');
    return `<div class="panel-note">💰 Apuesta pagada. ${names || `${bet.netPayoutSats} sats al ganador.`}</div>`;
  }
  if (bet.status === 'refunded' || bet.status === 'cancelled' || bet.status === 'expired') {
    return `<div class="panel-note">↩️ Apuesta ${escapeHtml(betStatusLabel(bet.status).toLowerCase())}: se reembolsaron los depósitos.</div>`;
  }
  if (bet.status === 'funded') {
    if (bet.resultReported) {
      return `<div class="panel-note">✅ Ganador reportado a Luna Negra. El pago se está liquidando…</div>`;
    }
    const isHost = onlineRoom?.hostPlayerId === onlinePlayer.id;
    const settleAction = isHost
      ? `<div class="online-bet-deposit-actions"><button type="button" data-ui-action="online-bet-settle"${onlineBetBusy ? ' disabled' : ''}>Cobrar apuesta</button></div>`
      : '';
    const settlementError = bet.settlementError
      ? `<div class="panel-note panel-error">No se pudo avisar a Luna Negra: ${escapeHtml(bet.settlementError)}</div>`
      : '';
    return `<div class="panel-note">Apuesta fondeada · pozo ${bet.potSats} sats. Liquidando el pago al ganador…</div>${settlementError}${settleAction}`;
  }
  return `<div class="panel-note">Apuesta: ${escapeHtml(betStatusLabel(bet.status).toLowerCase())} · pozo ${bet.potSats} sats.</div>`;
}

function renderOnlinePeerBoards(): string {
  if (!onlineRoom) return '';
  const remotePlayers = onlineRoom.players.filter((player) => player.id !== onlinePlayer.id);
  if (remotePlayers.length === 0) {
    return `
      <aside class="online-versus-grid online-versus-grid-empty" aria-label="Remote player boards">
        <div class="online-versus-title">
          <span>Opponents</span>
          <strong>0</strong>
        </div>
        <div class="online-empty">Waiting for another board.</div>
      </aside>
    `;
  }
  const spectating = isOnlineSpectating();
  const layout = onlinePeerGridLayout(remotePlayers.length, spectating);
  return `
    <aside class="online-versus-grid ${spectating ? 'online-versus-grid--spectator' : ''}" aria-label="Remote player boards">
      <div class="online-versus-title">
        <span>${spectating ? 'Espectador' : 'Opponents'}</span>
        <strong>${remotePlayers.length}</strong>
      </div>
      <div
        class="online-peer-boards"
        data-peer-count="${remotePlayers.length}"
        style="--online-peer-columns: ${layout.columns}; --online-peer-card-width: ${layout.cardWidth}px;"
      >
        ${remotePlayers.map(renderOnlinePeerBoard).join('')}
      </div>
    </aside>
  `;
}

// El jugador local ya terminó su partida pero la ronda sigue: está mirando.
function isOnlineSpectating(): boolean {
  return appMode === 'onlinePlaying' && lastStatus !== 'playing';
}

// Tamaño automático de los tableros rivales: con pocos enemigos se agrandan,
// con muchos se achican hasta que entren todos. En modo espectador (ya perdí)
// ocupan mucho más ancho de pantalla.
function onlinePeerGridLayout(playerCount: number, spectating = false): { columns: number; cardWidth: number } {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const columns = onlinePeerGridColumns(playerCount, width);
  const rows = Math.ceil(playerCount / columns);
  const gap = width < 760 ? 6 : 8;
  const panelWidth = spectating
    ? Math.max(240, width * (width < 760 ? 0.92 : 0.55))
    : width < 760
      ? Math.max(240, width - 28)
      : width < 1120
        ? Math.max(176, width * 0.22)
        : Math.min(420, width * 0.32);
  const availableHeight = Math.max(240, height - (width < 760 ? 168 : 118));
  const widthBound = (panelWidth - gap * (columns - 1)) / columns;
  const heightBound = (availableHeight - gap * (rows - 1)) / rows / 2.42;
  const minWidth = width < 760 ? 44 : 54;
  const maxWidth = onlinePeerMaxCardWidth(playerCount, width, spectating);
  return {
    columns,
    cardWidth: Math.floor(Math.max(minWidth, Math.min(maxWidth, widthBound, heightBound))),
  };
}

function onlinePeerMaxCardWidth(playerCount: number, width: number, spectating: boolean): number {
  if (width < 760) {
    if (spectating) return playerCount <= 2 ? 160 : 110;
    return playerCount <= 2 ? 110 : 82;
  }
  if (spectating) return playerCount <= 2 ? 240 : playerCount <= 4 ? 200 : 160;
  if (playerCount <= 1) return 190;
  if (playerCount <= 2) return 165;
  if (playerCount <= 4) return 145;
  return 128;
}

function onlinePeerGridColumns(playerCount: number, width: number): number {
  if (width < 760) return Math.min(playerCount, playerCount <= 2 ? 2 : 4);
  if (playerCount <= 1) return 1;
  if (playerCount <= 4) return 2;
  if (playerCount <= 9) return 3;
  if (playerCount <= 16) return 4;
  if (playerCount <= 25) return 5;
  return 6;
}

function renderOnlinePeerBoard(player: OnlinePlayer): string {
  const peerState = onlinePeerStates.get(player.id) ?? 'server';
  const displayGame = displaySnapshotForPlayer(player);
  const stateLabel = displayGame ? `${formatFrames(displayGame.elapsedFrames)} - ${peerState}` : peerState;
  return `
    <section class="online-peer-board">
      <div class="online-peer-board-head">
        <div class="online-player-label">
          ${renderOnlineAvatar(player, 'small')}
          <strong>${escapeHtml(player.name)}</strong>
        </div>
        <span>${escapeHtml(stateLabel)}</span>
      </div>
      ${displayGame ? renderOnlineMiniBoard(displayGame) : '<div class="online-mini-board online-mini-board-empty">No board yet</div>'}
    </section>
  `;
}

function displaySnapshotForPlayer(player: OnlinePlayer): OnlineGameSnapshot | null {
  const displayGame = onlinePeerDisplaySnapshots.get(player.id);
  if (displayGame && isCurrentOnlineGame(displayGame)) return displayGame;
  return player.game ?? null;
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

function renderLibraryPanelContent(): string {
  syncLibrarySelection();
  const visibleEntries = getVisibleLibraryEntries();
  const selectedEntry = getSelectedLibraryEntry(visibleEntries);
  const rows = visibleEntries.length === 0
    ? `<div class="history-empty">${escapeHtml(libraryEmptyText())}</div>`
    : visibleEntries.map((entry) => renderLibraryRow(entry, selectedEntry?.id === entry.id)).join('');
  const exported = lastExportName ? `<div class="panel-note">Exported ${escapeHtml(lastExportName)}</div>` : '';
  const error = libraryError ? `<div class="panel-note panel-error">${escapeHtml(libraryError)}</div>` : '';
  return `
      <section class="menu-panel history-panel library-panel" aria-label="Replay library">
        <div class="panel-eyebrow">HISTORIAL DE PARTIDAS</div>
        <h1 style="font-size: 36px; margin: 8px 0 16px; font-family: inherit; font-weight: 800;">Runs</h1>
        <div class="library-toolbar" aria-label="Replay filters">
          ${renderLibraryFilterButton('all', 'Todos')}
          ${renderLibraryFilterButton('clear', 'Completadas')}
          ${renderLibraryFilterButton('topout', 'Derrotas')}
          ${renderLibraryFilterButton('best', 'Mejores tiempos')}
        </div>
        ${exported}
        ${error}
        <div class="library-layout">
          <div class="history-list">${rows}</div>
          ${renderLibraryDetails(selectedEntry)}
        </div>
        <div class="panel-actions" style="display: flex; gap: 12px; margin-top: 24px;">
          <button class="dash-action-btn" style="width: auto; padding: 10px 24px;" type="button" data-ui-action="library-back">Volver</button>
          <button class="dash-action-btn accent" style="width: auto; padding: 10px 24px;" type="button" data-ui-action="import-replay">Importar partida</button>
          <button class="dash-action-btn danger" style="width: auto; padding: 10px 24px;" type="button" data-ui-action="clear-history"${runHistory.length === 0 ? ' disabled' : ''}>Borrar historial</button>
        </div>
      </section>
  `;
}

export function renderLibraryOverlay(): string {
  return `
    <div class="menu-scrim">
      ${renderLibraryPanelContent()}
    </div>
  `;
}

function renderLibraryFilterButton(filter: LibraryFilter, label: string): string {
  const activeClass = libraryFilter === filter ? ' button-active' : '';
  return `<button class="${activeClass}" type="button" data-ui-action="library-filter" data-filter="${filter}">${label}</button>`;
}

function renderLibraryRow(entry: RunHistoryEntry, selected: boolean): string {
  const activeClass = selected ? 'dash-copy-btn--active' : '';
  return `
    <article class="history-row library-row ${selected ? 'library-row-selected' : ''}">
      <div>
        <strong>${escapeHtml(formatHistoryStatus(entry.status))} ${escapeHtml(formatFrames(entry.elapsedFrames))}</strong>
        <span>${escapeHtml(formatDateTime(entry.createdAt))} - seed ${entry.seed}</span>
      </div>
      <div class="history-stats">
        <span>${entry.lines}L</span>
        <span>${entry.pieces} piezas</span>
        <span>${entry.pps.toFixed(2)} PPS</span>
        <span>${entry.inputsPerPiece.toFixed(2)} IPP</span>
      </div>
      <button class="dash-copy-btn ${activeClass}" type="button" data-ui-action="select-history-entry" data-history-id="${escapeHtml(entry.id)}">${selected ? 'Seleccionado' : 'Detalles'}</button>
    </article>
  `;
}

function renderLibraryDetails(entry: RunHistoryEntry | null): string {
  if (!entry) {
    return `
      <aside class="library-details" style="display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 24px; color: var(--dash-text-dim);">
        <div class="panel-eyebrow" style="font-size: 11px; color: var(--dash-text-muted); font-weight: 800; letter-spacing: 1.5px;">SIN SELECCIÓN</div>
        <p style="font-size: 13px; line-height: 1.5; margin-top: 8px;">Seleccioná una partida para ver detalles y controles de replay.</p>
      </aside>
    `;
  }
  const id = escapeHtml(entry.id);
  return `
    <aside class="library-details">
      <div class="panel-eyebrow">DETALLES DE PARTIDA</div>
      <h2>${escapeHtml(formatHistoryStatus(entry.status))} ${escapeHtml(formatFrames(entry.elapsedFrames))}</h2>
      <dl>
        <div><dt>Fecha</dt><dd>${escapeHtml(formatDateTime(entry.createdAt))}</dd></div>
        <div><dt>Seed</dt><dd>${entry.seed}</dd></div>
        <div><dt>Líneas</dt><dd>${entry.lines}/40</dd></div>
        <div><dt>Piezas</dt><dd>${entry.pieces}</dd></div>
        <div><dt>PPS</dt><dd>${entry.pps.toFixed(2)}</dd></div>
        <div><dt>LPM</dt><dd>${entry.linesPerMinute.toFixed(1)}</dd></div>
        <div><dt>Inputs</dt><dd>${entry.inputCount}</dd></div>
        <div><dt>IPP</dt><dd>${entry.inputsPerPiece.toFixed(2)}</dd></div>
      </dl>
      ${renderSplitList(entry.splits)}
      <div class="panel-actions replay-actions" style="display: flex; flex-direction: column; gap: 8px; margin-top: 16px;">
        <button class="dash-action-btn accent" type="button" data-ui-action="play-history-replay" data-history-id="${id}">Play replay</button>
        <button class="dash-action-btn" type="button" data-ui-action="export-history-replay" data-history-id="${id}">Export</button>
        <button class="dash-action-btn danger" type="button" data-ui-action="delete-history-entry" data-history-id="${id}">Delete</button>
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

function renderCustomPanelContent(): string {
  const exported = lastCustomExportName ? `<div class="panel-note">Exported ${escapeHtml(lastCustomExportName)}</div>` : '';
  const runError = localRunError ? `<div class="panel-note panel-error">${escapeHtml(localRunError)}</div>` : '';
  return `
    <section class="menu-panel custom-panel" aria-label="Custom mode">
        <div class="custom-header">
          <div>
            <div class="panel-eyebrow">PARTIDA PERSONALIZADA</div>
            <h1>Custom</h1>
            <p>Jugá como quieras. Las repeticiones no se envían.</p>
          </div>
          <button type="button" data-ui-action="custom-export">Exportar ajustes</button>
        </div>
        <div class="custom-start-row">
          <div class="custom-music">Música aleatoria: tranquila</div>
          <button class="custom-start-button" type="button" data-ui-action="custom-start">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
            Empezar
          </button>
        </div>
        <div class="custom-tabs" aria-label="Secciones de custom">
          ${CUSTOM_TABS.map((tab) => `
            <button class="${customTab === tab ? 'custom-tab-active' : ''}" type="button" data-ui-action="custom-tab" data-tab="${tab}">
              ${CUSTOM_TAB_LABELS[tab]}
            </button>
          `).join('')}
        </div>
        <div class="custom-tab-body">
          ${renderCustomTabBody()}
        </div>
        ${exported}
        ${runError}
        <div class="panel-actions custom-actions" style="display: flex; gap: 12px; margin-top: 24px;">
          <button class="dash-action-btn" style="width: auto; padding: 10px 20px;" type="button" data-ui-action="custom-back">Volver</button>
          <button class="dash-action-btn accent" style="width: auto; padding: 10px 20px;" type="button" data-ui-action="start">Jugar 40 líneas</button>
          <button class="dash-action-btn danger" style="width: auto; padding: 10px 20px;" type="button" data-ui-action="custom-reset">Restablecer</button>
        </div>
      </section>
  `;
}

export function renderCustomOverlay(): string {
  return renderPersistentMenuShell(renderCustomPanelContent(), 'custom-scrim');
}

const CUSTOM_TAB_LABELS: Record<CustomTab, string> = {
  game: 'Juego',
  objective: 'Objetivo',
  meta: 'Meta',
};

function renderCustomTabBody(): string {
  if (customTab === 'objective') {
    return [
      renderCustomSection('Objetivo', [
        renderCustomSelect('Modo', 'objectiveMode', [['none', 'Ninguno'], ['lines', 'Líneas']]),
        renderCustomNumber('Objetivo de líneas', 'objectiveLineTarget'),
      ]),
    ].join('');
  }
  if (customTab === 'meta') {
    return [
      renderCustomSection('Meta', [
        renderCustomSelect('Música', 'musicMode', [['random-calm', 'Aleatoria: tranquila']]),
        renderCustomStaticRow('Envío de repeticiones', 'No'),
      ]),
    ].join('');
  }
  return [
    renderCustomSection('General', [
      renderCustomSelect('Tipo de bolsa', 'randomBagType', [['7-bag', '7-BAG']]),
      renderCustomSelect('Giros permitidos', 'allowedSpins', [['all-mini-plus', 'ALL-MINI+']]),
      renderCustomSelect('Tabla de combos', 'comboTable', [['multiplier', 'MULTIPLIER']]),
      renderCustomToggle('All clears', 'enableAllClears'),
      renderCustomToggle('Semilla aleatoria', 'useRandomSeed'),
      renderCustomNumber('Semilla', 'seed'),
      renderCustomToggle('Permitir reintento', 'allowRetry'),
      renderCustomNumber('Stock', 'stock'),
      renderCustomToggle('Clutch clears', 'enableClutchClears'),
      renderCustomToggle('Desactivar lockout', 'disableLockout'),
      renderCustomNumber('Ancho del tablero', 'boardWidth'),
      renderCustomNumber('Alto del tablero', 'boardHeight'),
    ]),
    renderCustomSection('Supervivencia', [
      renderCustomSelect('Modo', 'survivalMode', [['none', 'Ninguno']]),
      renderCustomNumber('Desorden de basura %', 'garbageMessinessPercent'),
      renderCustomNumber('Tope de basura', 'garbageCap'),
      renderCustomToggle('Cambiar al atacar', 'changeOnAttack'),
      renderCustomToggle('Basura continua', 'continuousGarbage'),
      renderCustomNumber('Altura de capa', 'layerHeight'),
      renderCustomToggle('Capa pegajosa', 'stickyLayer'),
      renderCustomNumber('Altura mínima de capa', 'minimumLayerHeight'),
      renderCustomNumber('Intervalo del temporizador', 'timerIntervalSeconds'),
    ]),
    renderCustomSection('Controles', [
      renderCustomToggle('Giros 180°', 'allow180Spins'),
      renderCustomSelect('Tabla de kicks', 'kickTable', [['srs-plus', 'SRS+']]),
      renderCustomToggle('Hard drop', 'useHardDrop'),
      renderCustomToggle('Cola next', 'useNextQueue'),
      renderCustomToggle('Cola hold', 'useHoldQueue'),
      renderCustomNumber('Piezas next', 'nextPieces'),
      renderCustomToggle('Movimiento infinito', 'infiniteMovement'),
      renderCustomToggle('Hold infinito', 'infiniteHold'),
      renderCustomToggle('Pieza fantasma', 'showShadowPiece'),
      renderCustomNumber('ARE (frames)', 'areFrames'),
      renderCustomNumber('ARE de line clear', 'lineClearAreFrames'),
    ]),
    renderCustomSection('Gravedad y niveles', [
      renderCustomNumber('Gravedad', 'gravity'),
      renderCustomToggle('Usar niveles', 'useLevelling'),
      renderCustomToggle('Niveles master', 'useMasterLevels'),
      renderCustomNumber('Nivel inicial', 'startingLevel'),
      renderCustomNumber('Velocidad de nivel', 'levelSpeed'),
      renderCustomToggle('Niveles estáticos', 'useStaticLevelling'),
      renderCustomNumber('Velocidad estática', 'levelStaticSpeed'),
      renderCustomNumber('Gravedad base', 'baseGravity'),
      renderCustomNumber('Incremento de gravedad', 'gravityIncrease'),
      renderCustomNumber('Lock delay (frames)', 'lockDelayFrames'),
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

function renderCustomToggle(label: string, key: CustomBooleanSettingKey): string {
  const enabled = customSettings[key];
  return renderCustomRow(label, `
    <button class="custom-toggle ${enabled ? 'custom-toggle-on' : 'custom-toggle-off'}" type="button" role="switch" aria-checked="${enabled}" aria-label="${escapeHtml(label)}" data-ui-action="custom-toggle" data-setting="${key}">
      <span class="custom-toggle-knob"></span>
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

function renderSettingsPanelContent(): string {
  const captureText = bindingCapture ? `Presiona una tecla para ${CONTROL_ACTION_LABELS[bindingCapture]}` : 'Ajustes de Controles';
  const bindingRows = CONTROL_ACTIONS.map((action) => `
    <div class="binding-row">
      <span>${CONTROL_ACTION_LABELS[action]}</span>
      <button class="binding-button ${bindingCapture === action ? 'binding-button-active' : ''}" type="button" data-ui-action="capture-binding" data-control-action="${action}">
        ${bindingCapture === action ? 'Escuchando...' : escapeHtml(formatActionBinding(action))}
      </button>
    </div>
  `).join('');

  return `
      <section class="menu-panel settings-panel" aria-label="Input settings">
        <div class="panel-eyebrow">${escapeHtml(captureText)}</div>
        <h1 style="font-size: 36px; margin: 8px 0 16px; font-family: inherit; font-weight: 800;">Controles</h1>
        <div class="settings-grid">${bindingRows}</div>
        <div class="timing-panel">
          ${renderTimingControl('DAS', 'dasFrames', inputSettings.dasFrames)}
          ${renderTimingControl('ARR', 'arrFrames', inputSettings.arrFrames)}
        </div>
        <div class="panel-actions" style="display: flex; gap: 12px; margin-top: 24px;">
          <button class="dash-action-btn" style="width: auto; padding: 10px 24px;" type="button" data-ui-action="settings-back">Volver</button>
          <button class="dash-action-btn danger" style="width: auto; padding: 10px 24px;" type="button" data-ui-action="settings-reset">Restablecer</button>
        </div>
      </section>
  `;
}

function renderSettingsOverlay(): string {
  return `
    <div class="menu-scrim">
      ${renderSettingsPanelContent()}
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
  const runError = localRunError ? `<div class="panel-note panel-error">${escapeHtml(localRunError)}</div>` : '';
  const actions = options.actions.map(([action, label]) => {
    const isPrimary = action === 'resume' || action === 'restart';
    const isDanger = action === 'main-menu' || action === 'online-leave';
    const btnClass = isPrimary ? 'dash-action-btn accent' : isDanger ? 'dash-action-btn danger' : 'dash-action-btn';
    return `<button class="${btnClass}" style="width: auto; padding: 10px 20px;" type="button" data-ui-action="${action}">${label}</button>`;
  }).join('');
  const panel = `
    <section class="menu-panel" aria-label="${escapeHtml(options.eyebrow)}">
        <div class="panel-eyebrow">${escapeHtml(options.eyebrow)}</div>
        <h1>${escapeHtml(options.title)}</h1>
        <p>${escapeHtml(options.meta)}</p>
        ${options.details ?? ''}
        ${exported}
        ${importError}
        ${runError}
        <div class="panel-actions ${options.actionsClass ?? ''}">${actions}</div>
      </section>
  `;
  if (!isPersistentRoomPanelMode(appMode)) {
    return `<div class="menu-scrim">${panel}</div>`;
  }
  return renderPersistentMenuShell(panel);
}

function renderPersistentMenuShell(panel: string, extraClass = ''): string {
  return `
    <div class="menu-scrim ${extraClass}">
      <div class="persistent-menu-shell">
        ${panel}
        ${renderPersistentRoomPanel()}
      </div>
    </div>
  `;
}

function isPersistentRoomPanelMode(mode: AppMode): boolean {
  return mode === 'menu'
    || mode === 'soloMenu'
    || mode === 'multiplayerMenu'
    || mode === 'historyMenu'
    || mode === 'configMenu'
    || mode === 'custom';
}

function renderPersistentRoomPanel(): string {
  return onlineRoom ? renderActivePersistentRoomPanel() : renderEmptyPersistentRoomPanel();
}

function renderFloatingParticles(): string {
  return `
    <div class="dash-particles" aria-hidden="true">
      <!-- T-Piece (purple) -->
      <svg class="dash-particle particle-1" viewBox="0 0 120 80" width="60" height="40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M40 0h40v40H40V0zM0 40h120v40H0V40z" fill="var(--dash-neon-purple)" fill-opacity="0.15" stroke="var(--dash-neon-purple)" stroke-width="2" />
      </svg>
      <!-- I-Piece (cyan) -->
      <svg class="dash-particle particle-2" viewBox="0 0 160 40" width="80" height="20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M0 0h160v40H0V0z" fill="var(--dash-neon-cyan)" fill-opacity="0.15" stroke="var(--dash-neon-cyan)" stroke-width="2" />
      </svg>
      <!-- O-Piece (yellow) -->
      <svg class="dash-particle particle-3" viewBox="0 0 80 80" width="40" height="40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M0 0h80v80H0V0z" fill="#f59e0b" fill-opacity="0.1" stroke="#f59e0b" stroke-width="2" />
      </svg>
      <!-- Z-Piece (pink) -->
      <svg class="dash-particle particle-4" viewBox="0 0 120 80" width="60" height="40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M0 0h80v40H0V0zm40 40h80v40H40V40z" fill="var(--dash-neon-pink)" fill-opacity="0.15" stroke="var(--dash-neon-pink)" stroke-width="2" />
      </svg>
      <!-- S-Piece (green) -->
      <svg class="dash-particle particle-5" viewBox="0 0 120 80" width="60" height="40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M40 0h80v40H40V0zM0 40h80v40H0V40z" fill="var(--dash-success)" fill-opacity="0.15" stroke="var(--dash-success)" stroke-width="2" />
      </svg>
      <!-- L-Piece (orange) -->
      <svg class="dash-particle particle-6" viewBox="0 0 120 80" width="60" height="40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M0 0h40v80H0V0zm40 40h80v40H40V40z" fill="#f97316" fill-opacity="0.15" stroke="#f97316" stroke-width="2" />
      </svg>
    </div>
  `;
}

function renderDashboardMenu(state: GameState): string {
  const userDisplayName = onlineName.trim() || 'Jugador';

  const isHomeActive = appMode === 'menu';
  const isPlayActive = appMode === 'soloMenu' || appMode === 'multiplayerMenu' || appMode === 'custom' || appMode === 'onlineMenu' || appMode === 'roomLobby';
  const isHistoryActive = appMode === 'historyMenu' || appMode === 'library';
  const isSettingsActive = appMode === 'configMenu' || (appMode === 'settings' && (settingsReturnMode === 'configMenu' || settingsReturnMode === 'menu'));

  const homeClass = isHomeActive ? 'dash-sidebar-btn--active' : '';
  const playClass = isPlayActive ? 'dash-topbar-play--active' : '';
  const historyClass = isHistoryActive ? 'dash-sidebar-btn--active' : '';
  const settingsClass = isSettingsActive ? 'dash-sidebar-btn--active' : '';

  const showRightRoomPanel = true;
  const layoutClass = '';

  return `
    <div class="dash-layout ${layoutClass}">
      ${renderFloatingParticles()}
      <!-- TOP BAR -->

      <header class="dash-topbar">
        <h1 class="dash-logo">TETRA</h1>
        
        <button class="dash-topbar-play ${playClass}" type="button" data-ui-action="sidebar-play" aria-label="Jugar">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>

        <div class="dash-user">
          ${renderOnlineAvatar({ name: userDisplayName, avatarUrl: onlinePlayer.avatarUrl }, 'small', 'dash-user-avatar')}
          <span class="dash-user-name">${escapeHtml(userDisplayName)}</span>
        </div>
      </header>
      
      <!-- SIDEBAR -->
      <nav class="dash-sidebar">
        <div class="dash-sidebar-nav">
          <button class="dash-sidebar-btn ${homeClass}" type="button" data-ui-action="main-menu">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
            Inicio
          </button>
          <button class="dash-sidebar-btn ${historyClass}" type="button" data-ui-action="history-menu">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
            Historial
          </button>
          <button class="dash-sidebar-btn ${settingsClass}" type="button" data-ui-action="settings">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
            Ajustes
          </button>
        </div>
      </nav>
      
      <!-- HERO CENTER -->
      <main class="dash-hero">
        ${renderDashboardCenterContent(state)}
      </main>
      
      <!-- ROOM PANEL (derecha) -->
      ${showRightRoomPanel ? `
        <aside class="dash-room">
          ${renderDashboardRoomPanel()}
        </aside>
      ` : ''}
    </div>
  `;
}

function renderDashboardCenterContent(_state: GameState): string {
  const mode = appMode;
  if (mode === 'menu' || mode === 'onlineMenu' || mode === 'roomLobby') {
    return `
      <div class="dash-hero-card">
        <img class="dash-hero-img" src="/tetris-hero.png" alt="40 líneas" />
        <div class="dash-hero-veil"></div>
        <div class="dash-hero-scan"></div>
        <div class="dash-hero-sheen"></div>
        <div class="dash-hero-content">
          <div class="dash-hero-eyebrow">SPRINT · OBJETIVO 40 LÍNEAS</div>
          <h2 class="dash-hero-title">40 LÍNEAS</h2>
          <p class="dash-hero-subtitle">Despejá 40 líneas lo antes posible. Termina con <strong>CLEAR</strong>.</p>
          <div class="dash-hero-cta">
            <button class="dash-hero-btn dash-hero-btn--play" type="button" data-ui-action="start" aria-label="Jugar 40 líneas">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="#05070f"><path d="M8 5v14l11-7z"/></svg>JUGAR
            </button>
            <button class="dash-hero-btn dash-hero-btn--ghost" type="button" data-ui-action="custom-open">Custom</button>
          </div>
        </div>
      </div>
    `;
  }
  if (mode === 'soloMenu') {
    return `
      <div class="menu-panel" style="width: 100%; max-width: 440px; border: none; background: transparent; box-shadow: none; padding: 0;">
        <div class="panel-eyebrow">SOLO</div>
        <h1 style="font-size: 36px; margin: 8px 0 16px; font-family: 'Arial Black', Arial, sans-serif;">Modos solo</h1>
        <p style="color: var(--dash-text-dim); margin-bottom: 24px; font-size: 14px; font-weight: 500;">Todos los modos disponibles para jugar local.</p>
        <div class="panel-actions mode-menu-actions" style="display: flex; flex-direction: column; gap: 12px; max-width: 320px;">
          <button class="dash-action-btn accent" type="button" data-ui-action="start">40 líneas</button>
          <button class="dash-action-btn" type="button" data-ui-action="custom-open">Custom</button>
          <button class="dash-action-btn danger" type="button" data-ui-action="main-menu">Volver</button>
        </div>
      </div>
    `;
  }
  if (mode === 'multiplayerMenu') {
    return `
      <div class="menu-panel" style="width: 100%; max-width: 440px; border: none; background: transparent; box-shadow: none; padding: 0;">
        <div class="panel-eyebrow">MULTI JUGADOR</div>
        <h1 style="font-size: 36px; margin: 8px 0 16px; font-family: 'Arial Black', Arial, sans-serif;">Multijugador</h1>
        <p style="color: var(--dash-text-dim); margin-bottom: 24px; font-size: 14px; font-weight: 500;">Crea una sala custom o unite por código para jugar con amigos.</p>
        <div class="panel-actions mode-menu-actions" style="display: flex; flex-direction: column; gap: 12px; max-width: 320px;">
          <button class="dash-action-btn accent" type="button" data-ui-action="online-open">Salas custom</button>
          <button class="dash-action-btn danger" type="button" data-ui-action="main-menu">Volver</button>
        </div>
      </div>
    `;
  }
  if (mode === 'historyMenu') {
    return `
      <div class="menu-panel" style="width: 100%; max-width: 440px; border: none; background: transparent; box-shadow: none; padding: 0;">
        <div class="panel-eyebrow">HISTORIAL</div>
        <h1 style="font-size: 36px; margin: 8px 0 16px; font-family: 'Arial Black', Arial, sans-serif;">Historial</h1>
        <p style="color: var(--dash-text-dim); margin-bottom: 24px; font-size: 14px; font-weight: 500;">Replays guardados e importación de partidas.</p>
        <div class="panel-actions mode-menu-actions" style="display: flex; flex-direction: column; gap: 12px; max-width: 320px;">
          <button class="dash-action-btn accent" type="button" data-ui-action="replay-library">Replay library</button>
          <button class="dash-action-btn" type="button" data-ui-action="import-replay">Import replay</button>
          <button class="dash-action-btn danger" type="button" data-ui-action="main-menu">Volver</button>
        </div>
      </div>
    `;
  }
  if (mode === 'configMenu') {
    return `
      <div class="menu-panel" style="width: 100%; max-width: 440px; border: none; background: transparent; box-shadow: none; padding: 0;">
        <div class="panel-eyebrow">AJUSTES</div>
        <h1 style="font-size: 36px; margin: 8px 0 16px; font-family: 'Arial Black', Arial, sans-serif;">Ajustes</h1>
        <p style="color: var(--dash-text-dim); margin-bottom: 24px; font-size: 14px; font-weight: 500;">Configuración disponible del juego.</p>
        <div class="panel-actions mode-menu-actions" style="display: flex; flex-direction: column; gap: 12px; max-width: 320px;">
          <button class="dash-action-btn accent" type="button" data-ui-action="settings">Input settings</button>
          <button class="dash-action-btn danger" type="button" data-ui-action="main-menu">Volver</button>
        </div>
      </div>
    `;
  }
  if (mode === 'custom') {
    return renderCustomPanelContent();
  }
  if (mode === 'library') {
    return renderLibraryPanelContent();
  }
  if (mode === 'settings') {
    return renderSettingsPanelContent();
  }
  return '';
}

function renderDashboardRoomPanel(): string {
  const room = onlineRoom;
  const inviteUnavailable = !lunaIdentity?.gameId;
  const inviteStatusText = lunaInviteNotice
    ? lunaInviteNotice
    : inviteUnavailable
      ? 'Entrá desde Luna Negra para ver amigos e invitarlos.'
      : 'Abre la lista de amigos en Luna Negra.';
  const inviteActionHtml = inviteUnavailable
    ? `<button class="dash-invite-btn" type="button" data-ui-action="luna-login"${onlineBusy || lunaInviteWindowBusy ? ' disabled' : ''}>
        ${lunaInviteWindowBusy ? 'Abriendo...' : 'Iniciar sesión'}
      </button>`
    : `<button class="dash-invite-btn" type="button" data-ui-action="online-open-invite"${onlineBusy || lunaInviteWindowBusy ? ' disabled' : ''}>
        ${lunaInviteWindowBusy ? 'Abriendo...' : 'Invitar amigos'}
      </button>`;

  const inviteSectionHtml = `
    <div class="dash-invite-section ${!room ? 'glow' : ''}">
      <div class="dash-invite-copy">
        <strong>Invitaciones</strong>
        <span class="dash-invite-text">${escapeHtml(inviteStatusText)}</span>
      </div>
      ${inviteActionHtml}
    </div>
  `;

  if (!room) {
    // Cuando no hay sala activa
    const publicRooms = onlinePublicRooms.length === 0
      ? '<div class="online-empty" style="font-size: 12px; color: var(--dash-text-muted); text-align: center; padding: 12px 0;">No hay salas públicas activas.</div>'
      : onlinePublicRooms.slice(0, 3).map((candidateRoom) => `
        <div class="dash-player-card" style="margin-bottom: 6px;">
          <div class="dash-public-room-info">
            ${renderOnlineAvatar({ name: candidateRoom.hostName, avatarUrl: candidateRoom.hostAvatarUrl }, 'small', 'dash-player-avatar-circle')}
            <div class="dash-public-room-copy">
              <span>${escapeHtml(candidateRoom.id)}</span>
              <small>${escapeHtml(candidateRoom.hostName)} · ${escapeHtml(matchTypeLabel(candidateRoom.matchType))} · ${candidateRoom.playerCount} jug.</small>
            </div>
          </div>
          <button class="dash-copy-btn" type="button" data-ui-action="online-join-public" data-room-id="${escapeHtml(candidateRoom.id)}"${onlineBusy ? ' disabled' : ''}>Unirse</button>
        </div>
      `).join('');

    return `
      <div class="dash-room-header">
        <div class="dash-room-title-area">
          <span class="dash-room-eyebrow">SALA ONLINE</span>
          <h2 style="margin: 0; font-size: 20px; font-weight: 800;">Disponible</h2>
        </div>
        <button class="dash-copy-btn" type="button" data-ui-action="online-refresh"${onlineBusy ? ' disabled' : ''}>Actualizar</button>
      </div>
      
      ${renderOnlineError()}
      
      ${inviteSectionHtml}

      <div class="dash-empty-state">
        <div class="dash-field-group">
          <label>Crear Sala</label>
          <div class="dash-buttons-row">
            <button class="dash-action-btn accent" type="button" data-ui-action="online-create-private"${onlineBusy ? ' disabled' : ''}>Privada</button>
            <button class="dash-action-btn" type="button" data-ui-action="online-create-public"${onlineBusy ? ' disabled' : ''}>Pública</button>
          </div>
        </div>
        
        <div class="dash-field-group">
          <label for="dash-code-input">Unirse con código</label>
          <div class="dash-join-row">
            <input id="dash-code-input" class="dash-input" type="text" style="text-transform: uppercase;" placeholder="CÓDIGO" maxlength="${ROOM_ID_MAX_LENGTH}" value="${escapeHtml(onlineJoinCode)}" data-online-field="join-code" autocomplete="off" />
            <button class="dash-action-btn accent" type="button" style="width: auto; padding: 8px 16px;" data-ui-action="online-join"${onlineBusy ? ' disabled' : ''}>Unirse</button>
          </div>
        </div>
      </div>

      <div class="dash-field-group" style="margin-top: 10px;">
        <label>Salas Públicas</label>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;">
          ${publicRooms}
        </div>
      </div>
    `;
  }

  // Cuando hay una sala activa
  const host = room.hostPlayerId === onlinePlayer.id;
  const player = currentOnlinePlayer();
  const allReady = room.players.length > 0 && room.players.every((candidate) => candidate.ready);
  const betReady = !room.bet || room.bet.status === 'funded';
  const readyCount = room.players.filter((candidate) => candidate.ready).length;
  const matchText = matchTypeLabel(room.matchType);
  const statusText = roomStatusLabel(room.status);
  const visibilityText = room.visibility === 'private' ? 'Privada' : 'Pública';
  const speedLevelText = `Nivel ${room.rules?.gravityStartingLevel ?? 1}`;
  
  const playersHtml = room.players.map((candidate) => {
    const isHost = candidate.id === room.hostPlayerId;
    const isSelf = candidate.id === onlinePlayer.id;
    const isReady = candidate.ready;
    return `
      <div class="dash-player-card ${isSelf ? 'is-self' : ''} ${isReady ? 'is-ready' : ''}">
        <div class="dash-player-info">
          <div class="dash-player-avatar-wrap">
            ${renderOnlineAvatar(candidate, 'medium', 'dash-player-avatar-circle')}
          </div>
          <div class="dash-player-copy">
            <span class="dash-player-name">${escapeHtml(candidate.name)}${isSelf ? ' (Tú)' : ''}</span>
            <span class="dash-player-role">${isHost ? 'Anfitrión' : isSelf ? 'Tu jugador' : 'Invitado'}</span>
          </div>
        </div>
        <div class="dash-player-actions">
          ${isReady 
            ? '<span class="dash-player-ready-indicator ready">Listo</span>' 
            : '<span class="dash-player-ready-indicator waiting">Sin listo</span>'}
          ${host && !isSelf 
            ? `<button class="dash-copy-btn dash-kick-btn" type="button" data-ui-action="online-kick" data-target-player-id="${escapeHtml(candidate.id)}">Sacar</button>`
            : ''}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="dash-room-header dash-room-header-active">
      <div class="dash-room-title-area">
        <div class="dash-room-code-wrapper">
          <div class="dash-room-identity-line">
            <span class="dash-room-eyebrow">${escapeHtml(room.visibility === 'private' ? 'SALA PRIVADA' : 'SALA PÚBLICA')}</span>
            <h2 class="dash-room-code">${escapeHtml(room.id)}</h2>
          </div>
          <button class="dash-copy-btn" type="button" data-ui-action="online-copy-code" data-code="${escapeHtml(room.id)}">Copiar</button>
        </div>
      </div>
      <div class="dash-ready-stack">
        <span class="dash-player-ready-indicator ready">${readyCount}/${room.players.length}</span>
        <span>listos</span>
      </div>
    </div>

    <div class="dash-room-status-line">
      <span>${escapeHtml(matchText)}</span>
      <span>${escapeHtml(statusText)}</span>
    </div>

    <div class="dash-room-summary" aria-label="Configuración de sala">
      <div class="dash-room-summary-item">
        <span>Tipo</span>
        <strong>${escapeHtml(matchText)}</strong>
      </div>
      <div class="dash-room-summary-item">
        <span>Visibilidad</span>
        <strong>${escapeHtml(visibilityText)}</strong>
      </div>
      <div class="dash-room-summary-item">
        <span>Velocidad</span>
        <strong>${escapeHtml(speedLevelText)}</strong>
      </div>
    </div>
    
    ${renderOnlineError()}

    ${host && room.status === 'lobby' ? renderPersistentRoomVisibilityToggle() : ''}

    <section class="dash-room-section">
      <div class="dash-section-header">
        <span>Jugadores</span>
        <small>${readyCount}/${room.players.length} listos</small>
      </div>
      <div class="dash-player-list">
        ${playersHtml}
      </div>
    </section>

    ${inviteSectionHtml}

    ${renderOnlineBetPanel(host)}

    <div class="dash-room-actions-group">
      ${room.status === 'lobby'
        ? `${player?.ready
          ? '<button class="dash-action-btn" type="button" data-ui-action="online-unready">No listo</button>'
          : '<button class="dash-action-btn accent" type="button" data-ui-action="online-ready">Listo</button>'}
          ${host ? `<button class="dash-action-btn success" type="button" data-ui-action="online-start"${allReady && betReady && !onlineBusy ? '' : ' disabled'}>Empezar juego</button>` : ''}`
        : '<button class="dash-action-btn" type="button" disabled>Ronda en curso…</button>'}
      <button class="dash-action-btn danger" type="button" data-ui-action="online-leave">Salir de la sala</button>
    </div>
  `;
}


function renderEmptyPersistentRoomPanel(): string {
  const publicRooms = onlinePublicRooms.length === 0
    ? '<div class="online-empty">No hay salas públicas.</div>'
    : onlinePublicRooms.slice(0, 4).map((room) => `
      <article class="persistent-room-row">
        <div>
          <strong>${escapeHtml(room.id)}</strong>
          <span>${escapeHtml(room.hostName)} · ${escapeHtml(matchTypeLabel(room.matchType))} · ${room.playerCount}</span>
        </div>
        <button class="cs2-btn cs2-btn-sm" type="button" data-ui-action="online-join-public" data-room-id="${escapeHtml(room.id)}"${onlineBusy ? ' disabled' : ''}>Unirse</button>
      </article>
    `).join('');
  return `
    <aside class="persistent-room-panel" aria-label="Sala">
      <div class="persistent-room-head">
        <div>
          <span class="panel-eyebrow">SALA</span>
          <h2>Disponible</h2>
        </div>
        <button class="cs2-btn cs2-btn-ghost cs2-btn-sm" type="button" data-ui-action="online-refresh"${onlineBusy ? ' disabled' : ''}>Refresh</button>
      </div>
      ${renderOnlineError()}
      ${renderLunaIdentityBadge()}
      <div class="persistent-room-actions">
        <button class="cs2-btn cs2-btn-accent" type="button" data-ui-action="online-create-public"${onlineBusy ? ' disabled' : ''}>Crear pública</button>
        <button class="cs2-btn" type="button" data-ui-action="online-create-private"${onlineBusy ? ' disabled' : ''}>Crear privada</button>
      </div>
      <div class="online-join-row">
        <label class="online-field">
          <span>Código</span>
          <input type="text" maxlength="${ROOM_ID_MAX_LENGTH}" value="${escapeHtml(onlineJoinCode)}" data-online-field="join-code" autocomplete="off" />
        </label>
        <button class="cs2-btn" type="button" data-ui-action="online-join"${onlineBusy ? ' disabled' : ''}>Unirse</button>
      </div>
      <div class="persistent-room-public">
        <div class="cs2-card-head"><span>Públicas</span></div>
        <div class="persistent-room-list">${publicRooms}</div>
      </div>
    </aside>
  `;
}

function renderActivePersistentRoomPanel(): string {
  if (!onlineRoom) return '';
  const host = onlineRoom.hostPlayerId === onlinePlayer.id;
  const player = currentOnlinePlayer();
  const allReady = onlineRoom.players.length > 0 && onlineRoom.players.every((candidate) => candidate.ready);
  const betReady = !onlineRoom.bet || onlineRoom.bet.status === 'funded';
  const readyCount = onlineRoom.players.filter((candidate) => candidate.ready).length;
  const visibilityActions = host && onlineRoom.status === 'lobby' ? renderPersistentRoomVisibilityToggle() : '';
  return `
    <aside class="persistent-room-panel" aria-label="Sala actual">
      <div class="persistent-room-head">
        <div>
          <span class="panel-eyebrow">${escapeHtml(onlineRoom.visibility === 'private' ? 'SALA PRIVADA' : 'SALA PÚBLICA')}</span>
          <h2>${escapeHtml(onlineRoom.id)}</h2>
        </div>
        <span class="cs2-ready-pill">${readyCount}/${onlineRoom.players.length}</span>
      </div>
      <p class="persistent-room-status">${escapeHtml(matchTypeLabel(onlineRoom.matchType))} · ${escapeHtml(roomStatusLabel(onlineRoom.status))}</p>
      ${renderOnlineError()}
      ${visibilityActions}
      <div class="persistent-room-players">
        ${onlineRoom.players.map((candidate) => renderLobbyPlayer(candidate, host)).join('')}
      </div>
      ${renderLunaInviteAction(host)}
      <div class="cs2-lobby-actions">
        ${onlineRoom.status === 'lobby'
          ? `${player?.ready
            ? '<button class="cs2-btn" type="button" data-ui-action="online-unready">No listo</button>'
            : '<button class="cs2-btn cs2-btn-accent" type="button" data-ui-action="online-ready">Listo</button>'}
            ${host ? `<button class="cs2-btn cs2-btn-go" type="button" data-ui-action="online-start"${allReady && betReady && !onlineBusy ? '' : ' disabled'}>Empezar</button>` : ''}`
          : '<button class="cs2-btn" type="button" disabled>Ronda en curso…</button>'}
        <button class="cs2-btn cs2-btn-danger" type="button" data-ui-action="online-leave">Salir</button>
      </div>
    </aside>
  `;
}

// Toggle compacto pública/privada: un switch que alterna la visibilidad de la
// sala sin tocar nada más (solo lo ve el host y solo en el lobby).
function renderPersistentRoomVisibilityToggle(): string {
  if (!onlineRoom) return '';
  const isPublic = onlineRoom.visibility === 'public';
  return `
    <div class="room-visibility-toggle" aria-label="Visibilidad de sala">
      <span class="room-visibility-label ${isPublic ? '' : 'is-active'}">Privada</span>
      <button
        class="custom-toggle ${isPublic ? 'custom-toggle-on' : 'custom-toggle-off'}"
        type="button"
        role="switch"
        aria-checked="${isPublic}"
        aria-label="Sala pública"
        data-ui-action="online-visibility-toggle"${onlineBusy ? ' disabled' : ''}
      >
        <span class="custom-toggle-knob"></span>
      </button>
      <span class="room-visibility-label ${isPublic ? 'is-active' : ''}">Pública</span>
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
  return `Move ${formatActionBinding('moveLeft')}/${formatActionBinding('moveRight')} - Rotate ${formatActionBinding('rotateCW')}/${formatActionBinding('rotateCCW')}/${formatActionBinding('rotate180')} - Drop ${formatActionBinding('softDrop')}/${formatActionBinding('hardDrop')} - Hold ${formatActionBinding('hold')} - Pause ${formatActionBinding('pause')} - Retry ${formatActionBinding('retry')} - M sound - N music`;
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
    if (action === 'rotateCW' || action === 'rotateCCW' || action === 'rotate180') sound.play('rotate');
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
  if (mode === 'onlinePlaying') return onlineRulesFromRoom();
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

function onlineCustomRulesFromSettings(): GameRules {
  return {
    ...customRulesFromSettings(customSettings, inputSettings),
    targetLines: null,
  };
}

function onlineRulesFromRoom(room = onlineRoom): GameRules {
  const sharedRules = room?.rules ?? battleRulesFromSettings(inputSettings);
  return {
    ...sharedRules,
    attackTable: room?.ruleset.attackTable ?? sharedRules.attackTable,
    dasFrames: inputSettings.dasFrames,
    arrFrames: inputSettings.arrFrames,
  };
}

function parseControlAction(value: string | undefined): ControlAction | null {
  if (!value) return null;
  return CONTROL_ACTIONS.includes(value as ControlAction) ? value as ControlAction : null;
}

function onlineRoomHasOtherPlayers(): boolean {
  return !!onlineRoom && onlineRoom.players.some((player) => player.id !== onlinePlayer.id);
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
    seed: onlineRoom?.seed,
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
    seed: onlineRoom?.seed,
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

function currentOnlinePlayer(): OnlinePlayer | null {
  return onlineRoom?.players.find((player) => player.id === onlinePlayer.id) ?? null;
}

function parseTargetingMode(value: string | undefined): TargetingMode | null {
  return TARGETING_MODES.includes(value as TargetingMode) ? value as TargetingMode : null;
}

function prependUnique(values: string[], value: string, limit: number): string[] {
  return [value, ...values.filter((candidate) => candidate !== value)].slice(0, limit);
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
