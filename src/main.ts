import './styles.css';
import QRCode from 'qrcode';
import { gearOutlineIcon, historyClockIcon, homeIcon, playIcon, settingsGearIcon, speakerIcon } from './ui/icons';
import { formatFrames, escapeHtml } from './ui/format';
import { renderWelcome } from './ui/dashboard/welcome';
import { renderModeSelectStage as renderModeSelectStageView, renderSmartPlayStage as renderSmartPlayStageView } from './ui/dashboard/smartPlay';
import { renderRoomPanelEmpty, renderRoomPanelActive } from './ui/dashboard/roomPanel';
import { renderLeaderboardBody, renderLeaderboardPanel, renderSurvivalTopsEmbed as renderSurvivalTopsEmbedView } from './ui/dashboard/leaderboard';
import { renderHistory } from './ui/dashboard/history';
import { renderControls } from './ui/dashboard/controls';
import type { PlayMode } from './ui/playMode';
import { modeAccent, modeTetrominoIcon, playModeMeta, renderModeCard } from './ui/dashboard/modeCard';
import { leaderboardState } from './state/leaderboardState';
import { betState, DEFAULT_ONLINE_BET_STAKE_SATS } from './state/betState';
import { lunaState, type PendingLunaLaunchRequest } from './state/lunaState';
import { spectatorState } from './state/spectatorState';
import { replayState, multiReplayState, type MultiReplayCard } from './state/replayState';
import { onlineNetState, onlineClockState, onlineFailoverState } from './state/onlineNetState';
import { hostAuthorityState } from './state/hostAuthorityState';
import { roundState } from './state/roundState';
import { attackState } from './state/attackState';
import { identityState } from './state/identityState';
import { peerState } from './state/peerState';
import { roomState } from './state/roomState';
import { deathState } from './state/deathState';
import { libraryState, LIBRARY_FILTERS, type LibraryFilter } from './state/libraryState';
import { reportState } from './state/reportState';
import { overlayState } from './state/overlayState';
import { autoPlayState } from './state/autoPlayState';
import { runState, type RunKind } from './state/runState';
import { uiSelectionState } from './state/uiSelectionState';
import { mpLogEnabled } from './debugFlags';
import { getPerfMarks, recordTask } from './perfMarks';
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
import { canAdvanceGame, canCommitLocalOnlineTerminal, gameOverReasonMessage, requiresRunConfirmation, shouldPlayMusic, terminalLabel, togglePauseMode, type AppMode, type DestructiveRunAction } from './app/state';
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
import { HAS_ROYALTY_FREE_TRACKS, musicTracksFor } from './audio/music';
import { SoundEngine, type ReverbMode, type VolumeChannel } from './audio/SoundEngine';
import { GameEngine } from './game/engine';
import { cellsFor } from './game/pieces';
import { createReplayLog, recordGarbage, recordInput } from './game/replay';
import { BATTLE_RULES, softDropCellsPerFrameForFactor } from './game/rules';
import { resolveGameplayFrame } from './game/frameClock';
import { currentGravityCellsPerFrame } from './game/gravity';
import { displayedElapsedFrames } from './game/timing';
import type { ActivePiece, GameEngineSnapshot, GameEvent, GameInput, GameRules, GameState, InputAction, LineClearEvent } from './game/types';
import { InputController, isBrowserShortcutKeyDown, isEditableKeyboardTarget, type ControlInput } from './input';
import { GamepadController } from './gamepad';
import { startLocalVersus, type LocalVersusSession } from './app/localVersus';
import { BoardAudio } from './audio/BoardAudio';
import {
  applyHandlingPreset,
  CONTROL_ACTION_LABELS,
  CONTROL_ACTIONS,
  cloneInputSettings,
  HANDLING_PRESET_ORDER,
  HANDLING_PRESETS,
  type HandlingPreset,
  type InputTimingKey,
  isGameAction,
  keyLabel,
  loadInputSettings,
  matchHandlingPreset,
  resetInputSettings,
  saveInputSettings,
  type ControlAction,
  type InputSettings,
  updateBinding,
  updateInputTiming,
} from './input/settings';
import { INSTANT_SOFT_DROP_FACTOR } from './game/rules';
import { OnlineApiError } from './online/client';
import { createOnlineClient } from './online/partyClient';
import { LunaSocialClient } from './online/lunaNegraFriendsClient';
import type { HostSimulatedPlayer } from './online/hostAuthority';
import { saveOnlinePlayer } from './online/playerIdentity';
import { decidePeerKoAction } from './online/peerKoAuthority';
import { OnlinePeerBroadcaster, type OnlinePeerKoMessage, type OnlinePeerReplayMessage } from './online/peerBroadcast';
import { OnlineReplayCollector } from './app/multiplayerReplay';
import { MultiReplayPlayback, type MultiPlaybackSpeed, type MultiReplayPlaybackSnapshot, type MultiReplayPlayerSnapshot } from './app/multiReplayPlayback';
import { drawBoardToCanvas, sizeBoardCanvas } from './renderer/boardCanvas';
import { hasUnresolvedRoomBetPayout, normalizeRoomId, rankPlayers, ROOM_ID_MIN_LENGTH, ROOM_ID_MAX_LENGTH, TARGETING_MODES } from './online/roomService';
import { selectAttackTarget as selectTargetForAttack } from './online/targeting';
import type { AttackRequest, LunaIdentity, LunaLaunchRequest, OnlineAttack, OnlineErrorResponse, OnlineGameSnapshot, OnlineMatchType, OnlinePlayer, OnlineRoom, OnlineRoomMode, OnlineRoomResponse, OnlineRuleset, ProgressRequest, PublicRoomsFilters, RoomBet, RoomBetParticipant, RoomVisibility, TargetingMode } from './online/protocol';
import { loadRecord, saveAudioMutes, saveAudioVolumes, saveBackgroundMotion, saveMusicReverb, savePositionalAudio, saveRoyaltyFreeOnly, saveSoundMuted, saveTouchScheme, saveTouchHaptics, type TouchScheme } from './storage';
import { isPositionalAudio, panForPlayerBoard, panForScreenX, setPositionalAudio } from './audio/spatial';
import { PixiGameRenderer } from './renderer/PixiGameRenderer';
import { JuiceAudio } from './audio/JuiceAudio';
import { JuiceConductor } from './effects/JuiceConductor';
import { celebratePayout } from './effects/PayoutCelebration';

const root = document.getElementById('game-root');
const overlay = document.getElementById('hud-overlay');

if (!root || !overlay) throw new Error('Missing application root.');

const overlayElement = overlay;
// Capa propia para el banner de KO online (ver overlayState.lastKo). Vive fuera del
// overlay general para que el redibujo por frame de los tableros rivales no
// recree su nodo y reinicie sus animaciones.
const koOverlayElement = document.createElement('div');
(overlay.parentElement ?? document.body).appendChild(koOverlayElement);
// Capa propia para el HUD online (garbage + objetivo + salir). Igual que el KO
// overlay, vive fuera del overlay general: éste se reescribe cada frame por el
// cronómetro vivo de los tableros rivales, así que si el HUD estuviera ahí sus
// botones se recrearían 60 veces por segundo y el hover titilaría. Aparte, solo
// se redibuja cuando cambia su contenido (ver overlayState.lastHud).
const hudOverlayElement = document.createElement('div');
(overlay.parentElement ?? document.body).appendChild(hudOverlayElement);
hudOverlayElement.addEventListener('click', handleOverlayClick);
// Capa propia para el toast de invitación durante partida (no invasivo): vive
// fuera del overlay general por la misma razón que el HUD online — sus botones
// no deben recrearse cada frame (hover) — y porque el overlay puede repintarse
// con el cronómetro vivo de los tableros rivales.
const inviteOverlayElement = document.createElement('div');
(overlay.parentElement ?? document.body).appendChild(inviteOverlayElement);
inviteOverlayElement.addEventListener('click', handleOverlayClick);
// BOT DEV: capa propia para el panel de control del bot, fuera del overlay
// general (que se reescribe cada frame durante la partida online) para que sus
// botones no se recreen a 60fps y los clicks/hover funcionen.
const devBotOverlayElement = import.meta.env.DEV ? document.createElement('div') : null;
if (devBotOverlayElement) {
  (overlay.parentElement ?? document.body).appendChild(devBotOverlayElement);
  devBotOverlayElement.addEventListener('click', handleOverlayClick);
}
// Capa propia para el visor multi-tablero (appMode 'onlineReplay'). A diferencia
// del overlay general, sus canvas son persistentes: se crean una vez al abrir y
// se redibujan por frame sin recrear el DOM (innerHTML cada frame rompería el
// contexto 2D de cada canvas y haría flicker).
const multiReplayOverlayElement = document.createElement('div');
(overlay.parentElement ?? document.body).appendChild(multiReplayOverlayElement);
multiReplayOverlayElement.addEventListener('click', handleOverlayClick);
// Capa propia para el aviso de conexión/desconexión de mandos. Vive fuera del
// overlay general (que se reescribe por frame) para que su animación no se reinicie.
const gamepadToastElement = document.createElement('div');
(overlay.parentElement ?? document.body).appendChild(gamepadToastElement);
const VOLUME_WHEEL_STEP = 0.05;
// Tope de cambio de volumen por evento de rueda: una muesca de mouse puede
// reportar deltaY enorme; sin tope, un solo notch saltaría medio volumen.
const VOLUME_WHEEL_MAX_STEP = 0.08;
const REPLAY_SPEEDS: PlaybackSpeed[] = [1, 2, 4];
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
// Si mi canal WebRTC al host no abre en esta ventana durante una ronda activa,
// el invitado postea su propio progreso al servidor (self-report) para que el
// resto lo vea igual vía player.game. Rompe el Catch-22 del relay del host.
const ONLINE_SELF_REPORT_GRACE_MS = 3000;
// Si mi canal al host lleva caído al menos esto durante una ronda activa y sigo
// vivo, le pido al servidor que migre la autoridad (requestHostFailover) en vez de
// esperar el failover pasivo (HOST_STALE_MS, 15s). Clave en 1v1: el sobreviviente
// no puede eliminar al host ausente por su cuenta. El servidor igual confirma que
// el host dejó de escribir (HOST_UNREACHABLE_MS) antes de migrar.
const ONLINE_HOST_FAILOVER_REQUEST_GRACE_MS = 4000;
// Contenedores con scroll propio que se reconstruyen al regenerar el overlay.
// Sin esto, cada re-render (p. ej. polling de salas/apuestas) reinicia el scroll al tope.
// Debe declararse antes del primer render (loop() al final del módulo) para evitar TDZ.
const SCROLLABLE_OVERLAY_SELECTORS = ['.dash-room', '.dash-layout', '.menu-panel', '.persistent-room-panel'];
const ONLINE_KO_BROADCAST_RETRY_MS = 1000;
const ONLINE_BACKGROUND_SYNC_MS = 1000;
// Refresco automático de la lista de salas públicas mientras el jugador navega el
// dashboard sin estar en una sala: así aparecen las salas nuevas sin recargar.
const ONLINE_ROOMS_AUTO_REFRESH_MS = 5000;
// Al morir en online seguimos dibujando MI tablero esta ventana para que corra la
// animación de derrota (estilo tetr.io); luego se oculta y paso a espectador.
const ONLINE_DEATH_ANIM_MS = 2000;
// Igual que en solo, al perder (top out) congelamos el tablero esta ventana ANTES del
// colapso para que veas cómo quedó; recién después corre la animación de derrota. Más
// corto que en solo: en online conviene pasar pronto a ver a los rivales.
const ONLINE_DEATH_STUDY_MS = 1600;
// En solo/offline la derrota tiene dos fases antes de mostrar el panel de TOP OUT:
//  1) ESTUDIO: el tablero queda congelado tal cual quedó al perder, para que puedas
//     ver POR QUÉ perdiste (sin colapso todavía). Solo se ve un cartel discreto.
//  2) COLAPSO: recién entonces corre la animación de derrota (colapso + "GAME!"),
//     igual que online. Al terminar aparecen los resultados.
const SOLO_DEATH_STUDY_MS = 2600;
const SOLO_DEATH_COLLAPSE_MS = 1600;
// Reproducción opcional de "los últimos 5 segundos" desde el panel de resultados.
const DEATH_REPLAY_SECONDS = 5;
const GAME_FRAME_MS = 1000 / 60;
// Umbral de catch-up en solo/offline: por encima de ~0.5 s de frames acumulados
// asumimos que la pestaña estuvo en segundo plano (rAF congelado) y reanclamos el
// reloj en vez de fast-forwardear la gravedad. Un hitch normal queda por debajo.
const MAX_OFFLINE_RESUME_FRAMES = 30;
const AUTO_PLAY_ACCESS_STORAGE = 'stack40.autoplayAccess.v1'; // TRUCO AUTOPLAY
type StoredOnlineRoomSession = {
  roomId: string;
  playerId: string;
};

let inputSettings = loadInputSettings();
let customSettings = loadCustomSettings();
let gameRules = customRulesFromSettings(customSettings, inputSettings);
let seed = randomSeed();
let engine = new GameEngine(seed, gameRules);
let replay = createReplayLog(seed, gameRules);
const input = new InputController(inputSettings);
// Mandos (PlayStation / Xbox / Steam Controller / Switch) alimentan el mismo
// InputController que el teclado vía la Gamepad API; ver src/gamepad.ts.
const gamepad = new GamepadController(input, {
  onConnectionChange: (count, name, change) => {
    const friendly = friendlyGamepadName(name);
    if (change === 'connected') {
      console.info(`[gamepad] mando conectado (${count}): ${name ?? 'desconocido'}`);
      showGamepadToast(`${friendly} conectado`, 'connected');
    } else {
      console.info(`[gamepad] mando desconectado (${count} restantes)`);
      showGamepadToast(`${friendly} desconectado`, 'disconnected');
    }
  },
});
const renderer = new PixiGameRenderer(root);
renderer.setColorBlind(customSettings.colorBlindMode);
renderer.setBackgroundMotion(loadRecord().backgroundMotion);
const sound = new SoundEngine(
  loadRecord().soundMuted,
  musicTracksFor(loadRecord().royaltyFreeOnly),
  loadRecord().sfxVolume,
  loadRecord().musicVolume,
  loadRecord().musicReverb,
  loadRecord().sfxMuted,
  loadRecord().musicMuted,
);
// Capa de "feel" (partículas, audio rico, danger, KO/win). Es aditiva: AudioContext
// propio en paralelo al SoundEngine, sincronizando mute/volumen (ver setMuted/setSfxVolume).
// Es 100% efectos, así que también se calla con el mute de canal SFX.
const juiceAudio = new JuiceAudio(loadRecord().soundMuted || loadRecord().sfxMuted, loadRecord().sfxVolume);
const juice = new JuiceConductor(renderer.getJuice(), juiceAudio);
// Capa de audio dedicada al "latido de peligro" (Danger / latido que acelera) de los
// rivales en la vista de enemigos. Va aparte de juiceAudio porque el latido es un
// único loop por instancia y juice.frame ya usa el de juiceAudio para TU tablero;
// compartirlo lo pisaría cada frame. Como espectador no se usa (el latido del rival
// enfocado lo dispara driveSpectatorJuice sobre juiceAudio).
const rivalDangerAudio = new JuiceAudio(loadRecord().soundMuted || loadRecord().sfxMuted, loadRecord().sfxVolume);
// Audio posicional: el paneo estéreo de cada sonido sigue la posición en pantalla de
// su fuente. El interruptor vive en spatial.ts; lo inicializamos desde el ajuste guardado.
setPositionalAudio(loadRecord().positionalAudio);
// Mantiene las dos capas juice en el mismo estado de mute/volumen.
const juiceLayers = [juiceAudio, rivalDangerAudio];
const setJuiceMuted = (muted: boolean): void => { for (const layer of juiceLayers) layer.setMuted(muted); };
const setJuiceSfxVolume = (volume: number): void => { for (const layer of juiceLayers) layer.setSfxVolume(volume); };
// Umbrales (sobre dangerLevel 0..10 de la sala) para los efectos de "rival al borde
// de perder": WARN enciende el aviso suave + latido, CRITICAL los efectos fuertes.
const RIVAL_DANGER_WARN = 5;
const RIVAL_DANGER_CRITICAL = 7;
// Desbloquea el AudioContext de las capas juice en el primer gesto del usuario.
const unlockJuiceAudio = (): void => { void juiceAudio.unlock(); void rivalDangerAudio.unlock(); };
window.addEventListener('pointerdown', unlockJuiceAudio, { once: true });
window.addEventListener('keydown', unlockJuiceAudio, { once: true });
const onlineClient = createOnlineClient();
const lunaSocialClient = new LunaSocialClient();

let best = loadRecord();
let runHistory = loadRunHistory();
let appMode: AppMode = 'menu';
let settingsReturnMode: AppMode = 'menu';
// El estado de la partida en curso (runState.gameFrame/runState.gameClockOriginMs/countdown/runState.currentRunKind/
// runState.savedRunHistoryEntry/splitTracker/runState.lastPieces/runState.lastLines/maxCombo) vive ahora en
// ./state/runState (runState; ver imports).
let lastStatus = engine.getState().status;
let volumeFeedback: { channel: VolumeChannel; expiresAt: number } | null = null;
let bindingCapture: ControlAction | null = null;
let lastExportName: string | null = null;
let lastCustomExportName: string | null = null;
// Cachés del último HTML por overlay (last/lastKo/lastHud/lastInvite/lastDevBot) viven
// ahora en ./state/overlayState; se diffean para no recrear el DOM cada frame.
// Las secuencias de muerte (online + solo) viven en ./state/deathState.
// El estado del visor de repetición de una partida vive en ./state/replayState.
// El estado de la biblioteca de repeticiones vive en ./state/libraryState.
let pendingConfirmAction: DestructiveRunAction | null = null;
// "Ocultar controles" se quitó de la UI: los controles táctiles ahora se muestran
// siempre durante la partida (el esquema/vibración se ajustan desde Configuración).
let touchControlsHidden = false;
let touchScheme: TouchScheme = best.touchScheme;        // 'pro' | 'reduced' | 'dpad'
let touchHapticsEnabled: boolean = best.touchHaptics;   // navigator.vibrate on/off
// El estado del TRUCO AUTOPLAY (enabled/accessGranted/ignoreNextClick) vive ahora en
// ./state/autoPlayState (autoPlayState; ver imports).
// BOT DEV: oponente simulado para ver el flujo multijugador completo en modo dev
// (ver src/dev/devBotOpponent.ts). Solo existe detrás de import.meta.env.DEV.
let devBotMatch: import('./dev/devBotOpponent').DevBotOpponent | null = null;
// DUELO LOCAL: sesión del modo 1v1 en la misma compu (overlay propio). Mientras
// está activa, el loop principal queda en pausa (ver loopBody).
let localVersusSession: LocalVersusSession | null = null;
// La identidad online (player/name/joinCode) vive ahora en ./state/identityState
// (identityState; ver imports).
// El estado del flujo de apuesta online (stake input, flags busy/paying/creating,
// timers de poll, guard de festejo) vive ahora en ./state/betState → ver betState
// en los imports.
// El estado de la sala online (current + publicRooms) vive ahora en
// ./state/roomState (roomState; ver imports).
// El estado del "Top mundial" (rankings de victorias y supervivencia) vive ahora
// en ./state/leaderboardState — ver leaderboardState más abajo en los imports.
// La selección de UI del dashboard (playMode de "Jugar" + uiSelectionState.customTab del config) vive
// ahora en ./state/uiSelectionState (uiSelectionState; ver imports).
let localRunError: string | null = null;
// El "cableado" de red online (locks/timestamps de poll·progress·report, reloj del
// server, y failover de host) vive ahora en ./state/onlineNetState como 3 objetos:
// onlineNetState · onlineClockState · onlineFailoverState (ver imports).
// Desfase (ms) a partir del cual snapeamos en vez de suavizar (pestaña en segundo plano,
// reanudación tras congelarse rAF): por debajo, slew exponencial suave.
const ONLINE_CLOCK_SNAP_MS = 150;
const ONLINE_CLOCK_SMOOTH_TAU_MS = 250; // constante de tiempo del slew (~0.25s)
// El estado del ciclo de ronda online (resultSubmitted/runStarted/spectatorRound/
// activeRoundId/winSubmittedRoundId/roomReopenInFlight/roomGonePolls) vive ahora en
// ./state/roundState (roundState; ver imports).
// El estado de peers WebRTC (broadcaster/states/displaySnapshots) vive ahora en
// ./state/peerState (peerState; ver imports).
// Recolector de replays multi-tablero: junta el log de cada jugador de la ronda
// (el propio + los que llegan por WebRTC) para reproducir la partida completa.
const onlineReplayCollector = new OnlineReplayCollector();
// El estado del visor multi-tablero (appMode 'onlineReplay') vive ahora en
// ./state/replayState (multiReplayState + tipo MultiReplayCard; ver imports).
// Espectador: a qué rival estoy mirando en el tablero principal. null = automático
// (sigo al líder de la ronda). El motor de espectador reconstruye su GameState a
// partir del engine snapshot que difunde por WebRTC, para dibujarlo en el canvas
// como si estuviera jugando esa partida.
// El estado del dominio "espectador" (focus/engine/juice del rival enfocado) vive
// ahora en ./state/spectatorState (ver spectatorState en los imports).
// Rivales cuya derrota ya sonó. Evita repetir el jingle si vuelvo a enfocar a un
// muerto; se limpia al revivir (reopen de ronda) en syncRivalDeathSounds.
const spectatorDeathAnnounced = new Set<string>();
// Estado previo de la pieza activa de cada rival (mientras JUEGO), para deducir
// mover/girar/fijar por diff entre sus snapshots y reproducir esos sonidos atenuados
// y paneados desde su mini-tablero (syncRivalPieceSounds). Se olvida cuando un rival
// muere o desaparece para que su próxima pieza re-sincronice sin sonar.
const rivalPieceSnapshots = new Map<string, { pieces: number; type: string; x: number; rotation: number }>();
// Volumen relativo de los sonidos de pieza de los rivales (mover/girar/fijar) mientras
// jugás: se oyen para sentir su actividad pero muy por debajo de los tuyos, sin tapar
// tu propio juego.
const RIVAL_PIECE_GAIN = 0.26;
// Refuerzo del jingle de derrota de un rival: a volumen normal quedaba demasiado bajo
// y se perdía bajo el resto de la mezcla.
const RIVAL_DEATH_GAIN = 1.7;
// El pipeline de input/ataques online (sequence/appliedIds/inputOutbox) vive ahora
// en ./state/attackState (attackState; ver imports).
// El estado de la autoridad de host vive en ./state/hostAuthorityState.
// El ciclo de ronda online vive en ./state/roundState.
// El dominio Luna Negra / invitaciones / launch vive en ./state/lunaState.
// onlineNetState.lastDiagLogAt + onlineNetState.rulesSyncTimer viven ahora en onlineNetState.
// QRs de invoices Lightning, cacheados por bolt11 (el overlay se regenera por HTML).
const betQrDataUrls = new Map<string, string>();
const betQrPending = new Set<string>();

const LUNA_IDENTITY_KEY = 'stack40.lunaState.identity.v1';
const LUNA_ORIGIN_KEY = 'stack40.lunaOrigin.v1';
const LUNA_ENTER_ROOM_MESSAGE_TYPE = 'luna-negra:enter-room';
const LUNA_LOGOUT_MESSAGE_TYPE = 'luna-negra:logout';
const ONLINE_ROOM_SESSION_KEY = 'stack40.onlineRoomSession.v1';
lunaState.trustedOrigin = loadTrustedLunaOrigin();
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
  if (lunaState.identity && isPlayerActivelyPresent()) void syncLunaPresence();
}, LUNA_PRESENCE_HEARTBEAT_MS);
window.setInterval(() => {
  if (shouldAutoRefreshPublicRooms()) void refreshPublicRooms({ silent: true });
}, ONLINE_ROOMS_AUTO_REFRESH_MS);
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

try { autoPlayState.accessGranted = localStorage.getItem(AUTO_PLAY_ACCESS_STORAGE) === '1'; } catch { /* noop */ } // TRUCO AUTOPLAY
(window as unknown as Record<string, unknown>)['test'] = () => { // TRUCO AUTOPLAY
  try { localStorage.setItem(AUTO_PLAY_ACCESS_STORAGE, '1'); } catch { /* noop */ }
  autoPlayState.accessGranted = true;
  overlayState.last = '';
  console.log('autoplay unlocked');
};

// Scheduler del bucle principal. Por defecto se ancla a requestAnimationFrame,
// pero es intercambiable: en DEV (stack40.useTimerLoop) se cambia a un timer para
// poder correr/observar el flujo —incluido el multijugador vs bot— en una pestaña
// en segundo plano o headless, donde el navegador congela rAF.
let scheduleNextFrame: (cb: FrameRequestCallback) => void = (cb) => {
  requestAnimationFrame(cb);
};

// Probe de performance: cada ~1s loguea en la consola del navegador FPS real, frames de
// motor por segundo, y el costo en ms del frame completo y del render. Pero el promedio de
// 1s ESCONDE el jank puntual: a 180fps un único frame congelado de 150ms se diluye y "todo
// se ve excelente" aunque los rivales sientan tirones específicos. Por eso el probe además:
//  - lleva un HISTOGRAMA de cola (frames >33/>50/>100/>200ms) que el avg no muestra;
//  - loguea CADA pico al instante (`[perf:spike]`) con el desglose de en qué se fue el
//    frame (sync/red vs render) y qué pasó (poll, snap de reloj, catch-up de N frames);
//  - observa `longtask` del navegador (`[perf:longtask]`): bloqueos del main thread >50ms
//    vengan de donde vengan (GC, parseo del poll, layout), INCLUSO entre frames de rAF, que
//    el cronómetro del propio loop nunca ve.
const PERF_SPIKE_MS = 50; // un frame ≥50ms (<20fps instantáneo) = tirón perceptible
// Breakdown del frame en curso: lo llena loopBody/syncOnline para atribuir los picos.
interface PerfFrame {
  syncMs: number;      // costo de syncOnline() (red / host-authority / attacks)
  renderMs: number;    // costo de renderer.render() (0 si se saltó el rebuild)
  engineMs: number;    // costo de advanceGameToFrame() (motor; 0 si no ticó este loop)
  ticks: number;       // frames de motor avanzados este loop (>1 = catch-up de golpe)
  polled: boolean;     // se disparó un poll HTTP este frame
  clockSnapMs: number; // snap del reloj online este frame (0 = no hubo)
  // Intervalo de pared desde el ARRANQUE del loop anterior (cadencia real de rAF). A 60Hz
  // debería ser ~16.7ms parejo; gaps de ~33ms = vsync perdido = jitter que el cronómetro
  // del propio frame (dur) NUNCA ve, porque el tiempo se fue ENTRE callbacks (GC, paint,
  // el rAF paralelo de BackgroundFX, throttle del navegador). 0 en el primer frame.
  gapMs: number;
}
// IMPORTANTE: la CAPTURA de datos de perf (perfSession/perfEvents/errores) está SIEMPRE
// activa — el overhead es trivial (unos performance.now() por frame) y así el botón
// "Reportar" de la pantalla de resultados tiene datos de jank completos AUNQUE el jugador
// no haya entrado con ?perf=1. Lo único que el flag controla es si además se IMPRIME en la
// consola (`[perf:spike]`/`[perf:longtask]`), para no ensuciarle la consola al usuario común.
// Activo en DEV siempre; en PRODUCCIÓN bajo demanda con `?perf=1` (persiste en localStorage
// 'stack40.perf'; `?perf=0` lo apaga).
const perfLogEnabled = ((): boolean => {
  if (import.meta.env.DEV) return true;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has('perf')) {
      const on = params.get('perf') !== '0';
      localStorage.setItem('stack40.perf', on ? '1' : '0');
      return on;
    }
    return localStorage.getItem('stack40.perf') === '1';
  } catch { return false; }
})();
// Desglose del frame en curso (reiniciado al arranque de cada loop()).
let perfFrame: PerfFrame | null = null;
function freshPerfFrame(): PerfFrame {
  return { syncMs: 0, renderMs: 0, engineMs: 0, ticks: 0, polled: false, clockSnapMs: 0, gapMs: 0 };
}

// Buffer circular de eventos de jank + totales acumulados de TODA la sesión. Es la ÚNICA
// contabilidad del probe: ya no hay log periódico `[perf]`; el diagnóstico sale de los
// `[perf:spike]`/`[perf:longtask]` inmediatos y del reporte on-demand `tetra.perfReport()`,
// que un amigo con ?perf=1 manda sin tener que copiar la consola a mano.
interface PerfEvent {
  t: number;        // ms desde la carga de la página (performance.now redondeado)
  kind: 'spike' | 'longtask';
  mode: string;
  ms: number;       // duración del frame (spike) o del longtask
  sync?: number; render?: number; engine?: number; ticks?: number; poll?: boolean; snapMs?: number; gap?: number; attr?: string;
}
const PERF_EVENTS_MAX = 80; // últimos N eventos (anti-spam de memoria en sesiones largas)
const perfEvents: PerfEvent[] = [];
interface PerfSession {
  startedAt: number; frames: number; spikes: number; longtasks: number; snaps: number;
  b33: number; b50: number; b100: number; b200: number;
  maxLoopMs: number; maxLongtaskMs: number; maxSnapMs: number; maxEngineMs: number;
  // Histograma de cadencia de rAF (gapMs): frames cuyo INTERVALO desde el anterior superó el
  // umbral. gap33 ≈ un vsync de 60Hz perdido. Si gap33/frames es alto pero los spikes (dur≥50)
  // son pocos, el problema es jitter de pacing (se siente "laggeado") y NO picos de CPU.
  gap33: number; gap50: number; gap100: number; maxGapMs: number;
  // Peor frame de toda la sesión, con su desglose (aunque no haya llegado a spike).
  worst: (PerfFrame & { dur: number; mode: string }) | null;
}
// Siempre activa (ver perfLogEnabled): el reporte necesita estos totales aunque no haya logging.
const perfSession: PerfSession = { startedAt: Date.now(), frames: 0, spikes: 0, longtasks: 0, snaps: 0, b33: 0, b50: 0, b100: 0, b200: 0, maxLoopMs: 0, maxLongtaskMs: 0, maxSnapMs: 0, maxEngineMs: 0, gap33: 0, gap50: 0, gap100: 0, maxGapMs: 0, worst: null };
function pushPerfEvent(event: PerfEvent): void {
  perfEvents.push(event);
  if (perfEvents.length > PERF_EVENTS_MAX) perfEvents.shift();
}

// Captura de ERRORES en runtime para el reporte: errores no atrapados, promesas rechazadas y
// los errores por-frame que el loop ya traga. Siempre activa (no depende de ?perf=1) porque el
// botón "Reportar" debe incluir "si detecta algún error" para cualquier jugador.
interface PerfErrorEntry {
  t: number;            // ms desde la carga de la página
  kind: 'error' | 'unhandledrejection' | 'loop' | 'console';
  message: string;
  source?: string;      // archivo:línea:columna cuando lo da el navegador
  stack?: string;       // recortado, para no inflar el reporte
  mode: string;         // appMode al momento del error
}
const PERF_ERRORS_MAX = 30;
const perfErrors: PerfErrorEntry[] = [];
function recordPerfError(kind: PerfErrorEntry['kind'], message: string, opts: { source?: string; stack?: unknown } = {}): void {
  const stack = typeof opts.stack === 'string' ? opts.stack.slice(0, 1200) : undefined;
  perfErrors.push({ t: Math.round(performance.now()), kind, message: String(message).slice(0, 500), source: opts.source, stack, mode: appMode });
  if (perfErrors.length > PERF_ERRORS_MAX) perfErrors.shift();
}
function installErrorCapture(): void {
  try {
    window.addEventListener('error', (e) => {
      const where = e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined;
      recordPerfError('error', e.message || 'Error', { source: where, stack: e.error instanceof Error ? e.error.stack : undefined });
    });
    window.addEventListener('unhandledrejection', (e) => {
      const reason = e.reason;
      const msg = reason instanceof Error ? reason.message : String(reason);
      recordPerfError('unhandledrejection', msg, { stack: reason instanceof Error ? reason.stack : undefined });
    });
    // Envolvemos console.error para que cualquier error que el código ya loguea (p. ej. el
    // `[loop]`, reintentos de fetch de Luna Negra, fallos de red online) quede en el reporte.
    // Best-effort y acotado: si recordPerfError fallara, NO debemos romper el console.error real.
    const nativeError = console.error.bind(console);
    console.error = (...args: unknown[]): void => {
      try {
        const msg = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeStringify(a))).join(' ');
        const stack = args.find((a): a is Error => a instanceof Error)?.stack;
        recordPerfError('console', msg, { stack });
      } catch { /* no romper el log real */ }
      nativeError(...args);
    };
  } catch { /* sin window: nada que capturar */ }
}
function safeStringify(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

// El estado del botón "Reportar" de resultados (comment/buttonState) vive ahora en
// ./state/reportState (reportState; ver imports).
type BetWithdrawalTraceSource =
  | 'room-action'
  | 'room-poll'
  | 'bet-refresh'
  | 'bet-refresh-error'
  | 'withdraw-render'
  | 'withdraw-regression'
  | 'withdraw-resolved';
interface BetWithdrawalTraceEvent {
  t: number;
  source: BetWithdrawalTraceSource;
  note: string | null;
  roomId: string | null;
  roomStatus: string | null;
  roomUpdatedAt: number | null;
  betId: string | null;
  betStatus: string | null;
  payoutStatus: string | null;
  payoutSats: number | null;
  hasWithdrawLnurl: boolean;
  withdrawHandleVersion: number;
}
const BET_WITHDRAWAL_TRACE_MAX = 80;
const betWithdrawalTrace: BetWithdrawalTraceEvent[] = [];
const lastWithdrawalTraceSignatureBySource = new Map<BetWithdrawalTraceSource, string>();
let lastObservedWithdrawHandle: string | null = null;
let withdrawHandleVersion = 0;

function roomBetEntryForLocalPlayer(room: OnlineRoom | null): RoomBetParticipant | undefined {
  const bet = room?.bet;
  if (!bet) return undefined;
  const byPlayer = bet.participants.find((entry) => entry.playerId === identityState.player.id);
  if (byPlayer) return byPlayer;
  const npub = room.players.find((player) => player.id === identityState.player.id)?.npub;
  return npub ? bet.participants.find((entry) => entry.npub === npub) : undefined;
}

function recordBetWithdrawalTrace(
  source: BetWithdrawalTraceSource,
  room: OnlineRoom | null = roomState.current,
  note: string | null = null,
): void {
  const entry = roomBetEntryForLocalPlayer(room);
  const handle = entry?.withdrawLnurl ?? null;
  if (handle && handle !== lastObservedWithdrawHandle) {
    lastObservedWithdrawHandle = handle;
    withdrawHandleVersion += 1;
  }
  const event: BetWithdrawalTraceEvent = {
    t: Math.round(performance.now()),
    source,
    note,
    roomId: room?.id ?? null,
    roomStatus: room?.status ?? null,
    roomUpdatedAt: room?.updatedAtServerMs ?? null,
    betId: room?.bet?.betId ?? null,
    betStatus: room?.bet?.status ?? null,
    payoutStatus: entry?.payoutStatus ?? null,
    payoutSats: entry?.payoutSats ?? null,
    hasWithdrawLnurl: !!handle,
    withdrawHandleVersion,
  };
  const signature = JSON.stringify({ ...event, t: 0, note: null });
  if (!note && signature === lastWithdrawalTraceSignatureBySource.get(source)) return;
  lastWithdrawalTraceSignatureBySource.set(source, signature);
  betWithdrawalTrace.push(event);
  if (betWithdrawalTrace.length > BET_WITHDRAWAL_TRACE_MAX) betWithdrawalTrace.shift();
}

// Observa longtasks del navegador: tareas que bloquearon el main thread ≥50ms, las reporte
// quien las reporte (GC, microtask del poll, parseo JSON, layout). Son la causa más probable
// de "momentos de lag muy específicos" en MP que el avg de fps no detecta, porque pueden
// caer ENTRE dos rAF (no dentro del cronómetro de loop()). Best-effort: no todos los
// navegadores soportan 'longtask'.
function installLongTaskObserver(): void {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const ms = entry.duration;
        perfSession.longtasks += 1;
        if (ms > perfSession.maxLongtaskMs) perfSession.maxLongtaskMs = ms;
        pushPerfEvent({ t: Math.round(entry.startTime), kind: 'longtask', mode: appMode, ms: Math.round(ms), attr: entry.name });
        if (perfLogEnabled) {
          // eslint-disable-next-line no-console
          console.warn(`[perf:longtask] ${appMode} ${ms.toFixed(0)}ms bloqueó el main thread (atribución=${entry.name})`);
        }
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch { /* longtask no soportado: seguimos con el resto del probe */ }
}

// Cierra la contabilidad del frame: totales de sesión, peor frame y log inmediato del pico.
function perfEndFrame(dur: number, frame: PerfFrame): void {
  perfSession.frames += 1;
  if (dur > perfSession.maxLoopMs) perfSession.maxLoopMs = dur;
  if (dur > 200) perfSession.b200 += 1;
  else if (dur > 100) perfSession.b100 += 1;
  else if (dur > 50) perfSession.b50 += 1;
  else if (dur > 33) perfSession.b33 += 1;
  if (frame.clockSnapMs > 0) { perfSession.snaps += 1; if (frame.clockSnapMs > perfSession.maxSnapMs) perfSession.maxSnapMs = frame.clockSnapMs; }
  if (frame.engineMs > perfSession.maxEngineMs) perfSession.maxEngineMs = frame.engineMs;
  // Cadencia de rAF: ignoramos gaps enormes (>1000ms = pestaña en segundo plano / suspensión,
  // no jitter de juego) para no inflar el histograma ni el máximo con pausas del navegador.
  const g = frame.gapMs;
  if (g > 0 && g <= 1000) {
    if (g > perfSession.maxGapMs) perfSession.maxGapMs = g;
    if (g > 100) perfSession.gap100 += 1;
    else if (g > 50) perfSession.gap50 += 1;
    else if (g > 33) perfSession.gap33 += 1;
  }
  if (!perfSession.worst || dur > perfSession.worst.dur) perfSession.worst = { ...frame, dur, mode: appMode };
  // Pico perceptible: lo logueamos AL INSTANTE, con la atribución, para correlacionarlo con
  // lo que el jugador sintió. Un snap grande de reloj también cuenta como tirón aunque el
  // frame en sí haya sido barato.
  if (dur >= PERF_SPIKE_MS || frame.clockSnapMs >= ONLINE_CLOCK_SNAP_MS) {
    perfSession.spikes += 1;
    pushPerfEvent({
      t: Math.round(performance.now()), kind: 'spike', mode: appMode, ms: Math.round(dur),
      sync: Math.round(frame.syncMs), render: Math.round(frame.renderMs), engine: Math.round(frame.engineMs), ticks: frame.ticks,
      poll: frame.polled || undefined, snapMs: frame.clockSnapMs ? Math.round(frame.clockSnapMs) : undefined,
      gap: frame.gapMs ? Math.round(frame.gapMs) : undefined,
    });
    if (perfLogEnabled) {
      // eslint-disable-next-line no-console
      console.warn(
        `[perf:spike] ${appMode} frame=${dur.toFixed(0)}ms `
        + `sync=${frame.syncMs.toFixed(1)} render=${frame.renderMs.toFixed(1)} engine=${frame.engineMs.toFixed(1)} ticks=${frame.ticks}`
        + `${frame.polled ? ' poll' : ''}${frame.clockSnapMs ? ` clockSnap=${frame.clockSnapMs.toFixed(0)}ms` : ''}`
        + `${frame.gapMs ? ` gap=${frame.gapMs.toFixed(0)}ms` : ''}`,
      );
    }
  }
}

// Reporte de perf exportable: lo arma `tetra.perfReport()`. Devuelve un objeto JSON-able
// con device + totales de sesión + los últimos eventos de jank. La idea es que un amigo con
// ?perf=1 lo llame, se copie al portapapeles, y te lo pegue — sin tener que leer la consola.
// Etiqueta de transporte online para el reporte (sin acoplar a partyClient): el override de
// runtime ?transport= manda; si no, el default de build VITE_ONLINE_TRANSPORT.
function perfTransportLabel(): string {
  try {
    const override = new URLSearchParams(window.location.search).get('transport');
    if (override) return `${override}(override)`;
  } catch { /* sin window.location */ }
  return import.meta.env.VITE_ONLINE_TRANSPORT ?? 'default';
}
// Arma el reporte, lo copia al portapapeles y lo devuelve. Lo expone tetra.perfReport().
function runPerfReport(): Record<string, unknown> {
  const report = buildPerfReport();
  const json = JSON.stringify(report, null, 2);
  // Siempre dejamos el JSON crudo accesible: si el copiado falla (típico al llamarlo desde la
  // consola de DevTools, que le saca el foco al documento → clipboard.writeText rechaza), el
  // usuario puede recuperarlo con `copy(tetra.lastReportJson)` (helper `copy` de DevTools).
  try { (window as unknown as { tetra?: { lastReportJson?: string } }).tetra!.lastReportJson = json; } catch { /* sin namespace aún */ }
  const n = perfEvents.length;
  const clip = navigator.clipboard;
  if (clip?.writeText) {
    // writeText es async y rechaza por promesa (no por throw): hay que manejar el rejection o
    // queda un "Uncaught (in promise) NotAllowedError" en consola.
    void clip.writeText(json).then(
      // eslint-disable-next-line no-console
      () => console.log(`[perf] reporte copiado al portapapeles (${n} eventos de jank). Pegámelo.`),
      // eslint-disable-next-line no-console
      () => console.log(`[perf] no pude copiar al portapapeles (consola sin foco). Corré: copy(tetra.lastReportJson) — o copiá el objeto de arriba.`),
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(`[perf] portapapeles no disponible. Corré: copy(tetra.lastReportJson) para copiar el reporte (${n} eventos).`);
  }
  return report;
}

// Envía el reporte al backend (/api/report → webhook de Discord del dev). Lo dispara el botón
// "Reportar" de la pantalla de resultados. El estado (reportState.buttonState) lo refleja el render
// del overlay, que se reconstruye cada frame. No relanzamos si ya está en vuelo o ya se envió.
async function sendPerfReport(): Promise<void> {
  if (reportState.buttonState === 'sending' || reportState.buttonState === 'sent') return;
  reportState.buttonState = 'sending';
  try {
    const report = buildPerfReport();
    const response = await fetch('/api/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
    reportState.buttonState = response.ok ? 'sent' : 'error';
    if (!response.ok) {
      console.error(`[report] el server rechazó el reporte (HTTP ${response.status})`);
    }
  } catch (error) {
    reportState.buttonState = 'error';
    console.error('[report] no se pudo enviar el reporte', error);
  }
}
function buildPerfReport(): Record<string, unknown> {
  const nav = navigator;
  const localBetEntry = roomBetEntryForLocalPlayer(roomState.current);
  const withdrawQr = overlayElement.querySelector<HTMLImageElement>('img[alt="QR de retiro Lightning"]');
  return {
    generatedAt: new Date().toISOString(),
    perfLogEnabled,
    comment: reportState.comment.trim() ? reportState.comment.trim().slice(0, 400) : null,
    url: (() => { try { return window.location.href; } catch { return null; } })(),
    device: {
      userAgent: nav.userAgent,
      cores: nav.hardwareConcurrency ?? null,
      dpr: window.devicePixelRatio || 1,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      transport: perfTransportLabel(),
    },
    context: {
      appMode,
      roomId: roomState.current?.id ?? null,
      players: roomState.current?.players?.length ?? null,
      isHost: roomState.current ? isOnlineHost() : null,
    },
    betWithdrawal: {
      roomStatus: roomState.current?.status ?? null,
      roomUpdatedAtServerMs: roomState.current?.updatedAtServerMs ?? null,
      betId: roomState.current?.bet?.betId ?? null,
      betStatus: roomState.current?.bet?.status ?? null,
      payoutStatus: localBetEntry?.payoutStatus ?? null,
      payoutSats: localBetEntry?.payoutSats ?? null,
      hasWithdrawLnurl: !!localBetEntry?.withdrawLnurl,
      withdrawHandleVersion,
      qrInDom: !!withdrawQr,
      qrConnected: withdrawQr?.isConnected ?? false,
      qrComplete: withdrawQr?.complete ?? false,
      qrCacheEntries: betQrDataUrls.size,
      betBusy: betState.busy,
      betPaying: betState.paying,
      roomReopenInFlight: roundState.roomReopenInFlight,
      lastBetPollAt: Math.round(betState.lastPollAt),
      trace: betWithdrawalTrace.slice(),
    },
    // Diagnóstico de audio: para entender el "se escucha mal en el celular" (perfil
    // móvil activo o no, recorte real medido, volúmenes/mutes, PWA). Ver SoundEngine.
    audio: sound.getAudioDiagnostics(),
    session: { ...perfSession, durationMs: Date.now() - perfSession.startedAt },
    events: perfEvents.slice(),
    errors: perfErrors.slice(),
    // Atribución del trabajo fuera de rAF (mensajes peer / poll de sala): la pista para cazar
    // los longtasks "self" del cliente invitado. Ver perfMarks.ts.
    marks: getPerfMarks(),
  };
}

// Envoltorio resiliente: si un frame lanza, lo registramos pero SIEMPRE volvemos a
// agendar el siguiente. Antes, una excepción en cualquier paso por-frame mataba el
// bucle entero de forma permanente y silenciosa (juego congelado, sin error visible).
// DUELO LOCAL: monta el overlay del modo 1v1 local. El módulo es autocontenido
// (motores, input, render); acá sólo le pasamos los sonidos compartidos y el
// colorblind, y soltamos el input del juego principal mientras dure.
// Drivers de audio por asiento del duelo local. Reusan las dos capas JuiceAudio del
// juego principal (que están ociosas mientras dura el duelo): juiceAudio para el
// asiento 1, rivalDangerAudio para el 2, así cada tablero tiene su propio latido de
// peligro (un único loop por instancia). Se recrean en cada matchStart con el paneo
// según la posición del tablero (izquierda/derecha) y el ajuste de audio posicional.
let localVersusAudio: { seat1: BoardAudio; seat2: BoardAudio } | null = null;

function startLocalVersusMode(): void {
  if (localVersusSession) return;
  input.releaseAll();
  gamepad.releaseAll();
  localVersusSession = startLocalVersus({
    colorBlind: customSettings.colorBlindMode,
    onExit: () => {
      // Al cerrar, el loop principal retoma el render del menú en el próximo frame.
      localVersusSession = null;
      localVersusAudio = null;
      input.releaseAll();
    },
    audio: {
      countdownTick: () => sound.play('countdownTick'),
      countdownGo: () => sound.play('countdownGo'),
      gameOver: () => sound.play('gameOver'),
      win: () => sound.play('finish'),
      matchStart: (state1, state2) => {
        // Desbloquea las capas JuiceAudio (el SoundEngine ya se desbloqueó con el
        // gesto que abrió el duelo) y crea los drivers con el paneo del tablero
        // (J1 a la izquierda, J2 a la derecha).
        unlockJuiceAudio();
        const pan = isPositionalAudio() ? 0.6 : 0;
        localVersusAudio = {
          seat1: new BoardAudio(sound, juiceAudio, -pan),
          seat2: new BoardAudio(sound, rivalDangerAudio, pan),
        };
        localVersusAudio.seat1.reset(state1);
        localVersusAudio.seat2.reset(state2);
      },
      seatFrame: (seat, state, events, inputs) => {
        const driver = seat === 1 ? localVersusAudio?.seat1 : localVersusAudio?.seat2;
        driver?.frame(state, events, inputs, true);
      },
      matchEnd: () => {
        // Corta los latidos de peligro (el tablero del ganador queda congelado en
        // 'playing') y deshace el atenuado que el KO del perdedor dejó en las capas
        // JuiceAudio compartidas, que el juego principal vuelve a usar al salir.
        for (const layer of juiceLayers) { layer.setDanger(0); layer.resetMix(); }
      },
    },
  });
}

let lastLoopStartMs = 0; // arranque del loop anterior, para medir la cadencia real de rAF (gapMs)
function loop(): void {
  const t0 = performance.now();
  perfFrame = freshPerfFrame();
  // Intervalo de pared desde el frame anterior: la cadencia REAL con que el navegador nos
  // llama. A 60Hz parejo ≈ 16.7ms; lo de más es jitter (vsync perdido) que dur no captura.
  if (lastLoopStartMs > 0) perfFrame.gapMs = t0 - lastLoopStartMs;
  lastLoopStartMs = t0;
  onlineClockState.snapMsThisFrame = 0;
  try {
    loopBody();
  } catch (error) {
    console.error('[loop] error en el frame; continúo con el siguiente', error);
    recordPerfError('loop', error instanceof Error ? error.message : String(error), { stack: error instanceof Error ? error.stack : undefined });
  } finally {
    if (perfFrame) perfEndFrame(performance.now() - t0, perfFrame);
    scheduleNextFrame(loop);
  }
}

function loopBody(): void {
  if (localVersusSession) {
    // DUELO LOCAL: corre su propio loop/overlay y motores. El juego principal queda
    // en pausa total (sin avanzar, sin recolectar input ni redibujar) hasta que el
    // overlay se cierra. Su propio InputController/GamepadController maneja a los dos
    // jugadores. La música SÍ suena durante el duelo (cuenta regresiva + partida); el
    // overlay decide cuándo vía wantsMusic() (silencio en setup/depósito/resultados).
    sound.setMusicAllowed(!document.hidden && localVersusSession.wantsMusic());
    return;
  }
  // La música sólo suena en partida/repetición; los menús (incluido el principal)
  // quedan en silencio. setMusicAllowed es idempotente, así que llamarlo cada frame
  // sólo dispara play/pause en la transición real de modo.
  sound.setMusicAllowed(shouldPlayMusic(appMode));
  const beforeState = engine.getState();
  // Un espectador de la ronda no tiene tablero propio: aunque el motor heredado
  // quede en 'playing', no debe avanzar (solo mira a los rivales).
  const canAdvanceThisLoop = !hasBlockingModal() && !roundState.spectatorRound && canAdvanceGame(appMode, beforeState.status);
  if (!canAdvanceThisLoop) syncGameplayClockToCurrentFrame();
  const candidateFrame = canAdvanceThisLoop ? targetGameplayFrame() : runState.gameFrame;
  // P2: con el frame anclado al reloj real, un rAF de un monitor >60Hz puede no
  // producir un frame de engine nuevo (candidateFrame === runState.gameFrame). En ese caso NO
  // recolectamos inputs: quedan en la cola del InputController hasta el próximo tick
  // real, para no perder taps ni doble-contar repeats de DAS/ARR (collect corre así
  // exactamente una vez por frame de engine). En menús/gameover canAdvanceThisLoop es
  // false y candidateFrame también queda en runState.gameFrame, pero ahí SÍ seguimos
  // recolectando para que la navegación responda en cada rAF.
  const skipInputThisLoop = canAdvanceThisLoop && candidateFrame === runState.gameFrame;
  // Leemos los mandos cada rAF (la Gamepad API se sondea, no emite eventos por botón).
  // pressControl sólo encola; los repeats DAS/ARR los gobierna input.collect() abajo.
  gamepad.poll();
  if (!skipInputThisLoop) input.advanceFrame(candidateFrame);
  const controlInputs = skipInputThisLoop ? [] : input.collect(candidateFrame);
  const consumedByApp = handleControlInputs(controlInputs);

  if (appMode === 'soloCountdown') {
    updateSoloCountdown();
  }

  if (appMode === 'replayPlayback' && replayState.playback) {
    let snapshot = replayState.playback.snapshot();
    for (let i = replayFramesDueThisLoop(); i > 0; i -= 1) snapshot = replayState.playback.tick();
    renderer.render(snapshot.state);
    renderOverlay(snapshot.state);
    // "Ver últimos 5s": al terminar la reproducción vuelve solo a los resultados
    // (replayState.returnMode != null distingue este caso del replay importado/historial,
    // donde el usuario se queda en la pantalla "Complete").
    if (snapshot.done && replayState.returnMode !== null) exitReplayPlayback();
    return;
  }

  if (appMode === 'onlineReplay' && multiReplayState.playback) {
    // Visor multi-tablero: corre N motores y dibuja cada GameState en su canvas
    // (look real del juego). Vive en su capa persistente, no en el overlay general.
    let snapshot = multiReplayState.playback.snapshot();
    for (let i = replayFramesDueThisLoop(); i > 0; i -= 1) snapshot = multiReplayState.playback.tick();
    drawMultiReplayFrame(snapshot);
    return;
  }

  let state = engine.getState();
  // Frame del motor ANTES del posible tick de abajo: si no cambia, este rAF no produjo
  // un frame nuevo (típico en monitores >60Hz, ~2 de cada 3 rAF) y el tablero es idéntico
  // al ya dibujado → el renderer puede saltarse la reconstrucción completa (ver render()).
  const frameBefore = runState.gameFrame;
  // candidateFrame > runState.gameFrame garantiza que advanceGameToFrame ticará al menos un
  // frame: en un rAF sin frame nuevo (skipInputThisLoop) el for de catch-up no
  // iteraría, pero evitamos igual el autoplay/bot/sendOnline/recordInput con inputs
  // vacíos o sellados a un frame ya pasado (rompería el determinismo del replay).
  if (!consumedByApp && canAdvanceGame(appMode, state.status) && candidateFrame > runState.gameFrame) {
    const beforeTickState = engine.getState();
    const gameInputs = toGameInputs(controlInputs, candidateFrame);
    // TRUCO AUTOPLAY: inyecta la acción del bot como si fuera una tecla más.
    if (autoPlayState.enabled) {
      // BOT DEV: en una partida vs bot el autoplay local se frena al mismo ritmo
      // del oponente (a toda velocidad la ronda dura ~10s y no se ve nada).
      const devBotPaced = import.meta.env.DEV && devBotMatch
        ? candidateFrame % devBotMatch.getConfig().inputCadenceFrames === 0
        : true;
      const botAction = devBotPaced ? nextAutoPlayInput(state) : null;
      if (botAction) gameInputs.push({ frame: candidateFrame, action: botAction });
    }
    sendOnlineInputsToHost(gameInputs);
    playImmediateInputSounds(gameInputs.map((event) => event.action));
    for (const event of gameInputs) recordInput(replay, event);
    const engineStart = performance.now();
    state = advanceGameToFrame(candidateFrame, gameInputs);
    if (perfFrame) perfFrame.engineMs = performance.now() - engineStart;
    const tickActions = gameInputs.map((event) => event.action);
    playAcceptedMoveSound(beforeTickState.active, state.active, tickActions);
    triggerWallImpact(beforeTickState.active, state.active, tickActions, state.board[0]?.length ?? 10);
    // Micro-feel al fijar pieza: el hard drop ya dispara su propio efecto en
    // playImmediateInputSounds, así que aquí solo el lock "natural".
    const lockedPiece = state.stats.pieces > beforeTickState.stats.pieces;
    const didHardDrop = gameInputs.some((event) => event.action === 'hardDrop');
    // Line clear = patrón propio (más fuerte que el lock). Tiene prioridad sobre el
    // lock simple para que limpiar líneas se sienta distinto a solo fijar la pieza.
    if (state.stats.lines > beforeTickState.stats.lines) vibrate([20, 40, 25]);
    else if (lockedPiece) vibrate(didHardDrop ? 45 : 22); // "lock distinto" marcado
    if (lockedPiece && !didHardDrop) juice.onLock();
    // Estela vertical de neón del hard drop: de donde estaba la pieza (active) a
    // donde aterriza (su ghost, en la misma columna/rotación), por cada columna.
    if (didHardDrop && beforeTickState.active && beforeTickState.ghost) {
      const piece = beforeTickState.active;
      const land = beforeTickState.ghost;
      const cells = cellsFor(piece.type, piece.rotation);
      const hidden = beforeTickState.stats.hiddenRows;
      const cols = [...new Set(cells.map((c) => piece.x + c.x))];
      const top = piece.y + Math.min(...cells.map((c) => c.y)) - hidden;
      const bottom = land.y + Math.max(...cells.map((c) => c.y)) - hidden;
      juice.onHardDropTrail(cols, top, bottom);
    }
    // Estela sutil de caída normal/soft-drop: misma pieza que descendió fila(s)
    // sin fijarse ni hacer hard drop. Rastro tenue de neón detrás de la pieza.
    if (!didHardDrop && !lockedPiece && beforeTickState.active && state.active
        && state.active.y > beforeTickState.active.y) {
      const piece = state.active;
      const cells = cellsFor(piece.type, piece.rotation);
      const hidden = state.stats.hiddenRows;
      const cols = [...new Set(cells.map((c) => piece.x + c.x))];
      const top = beforeTickState.active.y + Math.min(...cells.map((c) => c.y)) - hidden;
      const bottom = piece.y + Math.max(...cells.map((c) => c.y)) - hidden;
      juice.onFallTrail(cols, top, bottom);
    }
  }

  const syncStart = performance.now();
  syncOnline();
  if (perfFrame) {
    perfFrame.syncMs = performance.now() - syncStart;
    // syncOnlineClock() corre dentro de syncOnline(); recogemos el snap que haya disparado.
    perfFrame.clockSnapMs = onlineClockState.snapMsThisFrame;
  }
  if (import.meta.env.DEV) devBotMatch?.frame(); // BOT DEV: avanza al oponente simulado
  syncRivalDangerCues(); // sonido cuando un rival vivo entra en peligro crítico
  syncRivalDeathSounds(); // sonido de derrota de un rival (espectador y en juego)
  syncRivalPieceSounds(); // sonidos atenuados de pieza de los rivales mientras juego
  syncOnlineDeathPhase(state);
  syncSoloDeathPhase(state);
  // Perfil móvil de render: durante el juego activo congela el repintado del fondo (no-op en
  // desktop). Atacar el costo de composición es lo que reduce el jitter de pacing en celular.
  renderer.setGameplayActive(appMode === 'playing' || appMode === 'onlinePlaying');
  // Ya morí y terminó la animación de derrota: paso a espectador. En vez de ocultar
  // el canvas dibujo en él la partida del rival enfocado (líder o el que elija), así
  // se ve como si siguiera jugando una partida normal en vez de una vista aparte.
  // Durante la animación de derrota sigo dibujando MI tablero para que se vea morir.
  if (isOnlineSpectating()) {
    const focus = spectatorFocusPlayer();
    const focusState = focus ? spectatorFocusState(focus) : null;
    if (focus && focusState) {
      // Render primero (refresca la geometría del tablero), luego el juice del rival
      // observado: partículas/flashes/popups/sonido como si fuera su propia partida.
      const specRenderStart = performance.now();
      renderer.render(focusState);
      if (perfFrame) perfFrame.renderMs = performance.now() - specRenderStart;
      driveSpectatorJuice(focusState, focus.id);
    }
  } else {
    // En monitores >60Hz solo ~1 de cada 3 rAF produce frame de motor; los demás
    // mostrarían un tablero idéntico. Reconstruir todo igual desperdicia main thread y
    // puede tirar el framerate por debajo del refresco (input se siente con retraso).
    // Reconstrucción completa solo cuando hay frame nuevo o no estamos jugando (banner
    // de resultados, animación de muerte, cuenta regresiva). El juice/shake igual corren
    // a tasa de refresco dentro de render() para que partículas y temblor sigan suaves.
    const boardChanged = runState.gameFrame !== frameBefore || state.status !== 'playing';
    const renderStart = performance.now();
    renderer.render(state, boardChanged);
    if (perfFrame) {
      // ticks del motor (>1 = catch-up de varios frames de golpe = posible pico) y costo del
      // render, para atribuir el spike en perfEndFrame.
      perfFrame.ticks = Math.max(0, runState.gameFrame - frameBefore);
      perfFrame.renderMs = performance.now() - renderStart;
    }
    // `live` solo en juego real: en lobby/resultados/pausa el motor puede quedar
    // congelado en 'playing' (el ganador online conserva ese status) y, con la pila
    // alta, el latido de peligro seguiría sonando fuera de la partida.
    const live = appMode === 'playing' || appMode === 'onlinePlaying';
    juice.frame(state, live); // peligro por altura de pila + transiciones KO/Win
  }
  renderOverlay(state);
}

// Arranca/limpia la fase de muerte online. Congela los datos del toast de KO en
// el instante de morir y marca el inicio de la ventana de animación de derrota.
function syncOnlineDeathPhase(state: GameState): void {
  // La ventana arranca jugando, pero DEBE sobrevivir a que la sala pase a
  // 'finished' (appMode 'onlineResults'): en un 1v1 tu muerte cierra la ronda en el
  // mismo frame, y si cortáramos la ventana ahí el panel de resultados taparía la
  // animación al instante. La mantenemos viva durante onlineResults; el timer
  // (ONLINE_DEATH_ANIM_MS) decide cuándo deja de animar, no la transición de modo.
  const inOnlineRound = appMode === 'onlinePlaying' || appMode === 'onlineResults';
  const dead = inOnlineRound
    && (state.status === 'gameover' || state.status === 'finished');
  if (!dead) {
    deathState.onlineAnimStartedAt = null;
    deathState.onlineCollapseStarted = false;
    deathState.onlineLostByTopOut = false;
    deathState.onlineKoBanner = null;
    return;
  }
  if (deathState.onlineAnimStartedAt === null) {
    deathState.onlineAnimStartedAt = performance.now();
    deathState.onlineLostByTopOut = state.status === 'gameover';
    // Ganar (finished) no congela ni colapsa: marcamos el colapso como ya hecho.
    deathState.onlineCollapseStarted = !deathState.onlineLostByTopOut;
    deathState.onlineKoBanner = {
      placement: onlineLocalPlacementLabel(),
      won: state.status === 'finished',
    };
  }
  // Top out: primero la fase de estudio (tablero congelado), luego el colapso.
  if (deathState.onlineLostByTopOut && !deathState.onlineCollapseStarted
    && performance.now() - deathState.onlineAnimStartedAt >= ONLINE_DEATH_STUDY_MS) {
    deathState.onlineCollapseStarted = true;
    renderer.playDeathAnimation();
  }
}

function isOnlineDeathAnimating(): boolean {
  if (deathState.onlineAnimStartedAt === null) return false;
  // Al perder la ventana cubre estudio + colapso; al ganar solo la animación normal.
  const windowMs = deathState.onlineLostByTopOut ? ONLINE_DEATH_STUDY_MS + ONLINE_DEATH_ANIM_MS : ONLINE_DEATH_ANIM_MS;
  return performance.now() - deathState.onlineAnimStartedAt < windowMs;
}

// True solo durante la fase de estudio online (tablero congelado, sin colapso aún).
function isOnlineDeathStudying(): boolean {
  return deathState.onlineAnimStartedAt !== null && deathState.onlineLostByTopOut && !deathState.onlineCollapseStarted;
}

// Maneja la secuencia de muerte en solo (no online): primero congela el tablero para
// estudiarlo (fase ESTUDIO), después dispara el colapso (fase COLAPSO) y al terminar
// deja aparecer el panel de resultados. La marca de "terminado" sobrevive a entrar y
// salir de la repetición, para no re-animar al volver de "ver últimos 5s".
function syncSoloDeathPhase(state: GameState): void {
  if (state.status !== 'gameover') {
    // Nueva partida / reset: limpiamos toda la secuencia.
    deathState.soloStartedAt = null;
    deathState.soloCollapseStarted = false;
    deathState.soloSequenceDone = false;
    return;
  }
  const soloContext = appMode === 'playing' || appMode === 'paused';
  // En gameover pero fuera del contexto solo (p. ej. mirando la repetición) no
  // tocamos el estado: preservamos la secuencia para retomarla al volver.
  if (!soloContext || deathState.soloSequenceDone) return;
  if (deathState.soloStartedAt === null) deathState.soloStartedAt = performance.now();
  const elapsed = performance.now() - deathState.soloStartedAt;
  if (!deathState.soloCollapseStarted && elapsed >= SOLO_DEATH_STUDY_MS) {
    deathState.soloCollapseStarted = true;
    renderer.playDeathAnimation(); // colapso del tablero, igual que online
  }
  if (elapsed >= SOLO_DEATH_STUDY_MS + SOLO_DEATH_COLLAPSE_MS) deathState.soloSequenceDone = true;
}

// True mientras la derrota en solo sigue su secuencia (estudio o colapso): difiere el
// panel de resultados hasta que termine.
function isSoloDeathAnimating(): boolean {
  return deathState.soloStartedAt !== null && !deathState.soloSequenceDone;
}

// True solo durante la fase de estudio (tablero congelado, sin colapso aún).
function isSoloDeathStudying(): boolean {
  return deathState.soloStartedAt !== null && !deathState.soloCollapseStarted && !deathState.soloSequenceDone;
}

function onlineLocalPlacementLabel(): string {
  const room = roomState.current;
  if (!room) return '';
  const ranked = rankPlayers(room.players);
  const myIndex = ranked.findIndex((player) => player.id === identityState.player.id);
  return myIndex >= 0 ? `${myIndex + 1}° de ${ranked.length}` : '';
}

// Calidad gráfica adaptada al dispositivo: el `backdrop-filter: blur` de los scrims (menús,
// lobby, resultados) se recalcula cada frame sobre el canvas animado y cuesta ~60ms en GPUs
// flojas —los longtasks de paint "self" que cazamos en reportes de invitados con pocos núcleos—.
// En esas máquinas marcamos `low-gfx` y el CSS desactiva el blur (el scrim queda semi-opaco, ya
// casi no se ve la diferencia). Heurística por núcleos; override con ?lowgfx=1 / ?lowgfx=0 para probar.
applyGraphicsQualityClass();
function applyGraphicsQualityClass(): void {
  try {
    const override = new URLSearchParams(window.location.search).get('lowgfx');
    const lowGfx = override !== null ? override !== '0' : (navigator.hardwareConcurrency ?? 8) <= 4;
    if (lowGfx) document.documentElement.classList.add('low-gfx');
  } catch { /* sin window/navigator: dejamos la calidad alta por defecto */ }
}

installErrorCapture();
installLongTaskObserver();
loop();

Object.assign(window, {
  stack40: {
    getState: () => engine.getState(),
    getReplay: () => replay,
    getPlayback: () => replayState.playback?.snapshot() ?? null,
    getMultiReplay: () => multiReplayState.playback?.snapshot() ?? null,
    openMultiReplay: () => openMultiReplay(),
    // Solo test/preview: abre el visor multi-tablero con datos sintéticos para
    // poder verlo sin una partida online completa.
    openSampleMultiReplay: () => {
      const mkInputs = (period: number, count: number) =>
        Array.from({ length: count }, (_, i) => ({ frame: (i + 1) * period, action: 'hardDrop' as const }));
      multiReplayState.playback = new MultiReplayPlayback({
        version: 1, game: 'stack40', createdAt: new Date().toISOString(), roomId: 'DEMO', seed: 11,
        players: [
          { playerId: 'a', name: 'Ada', seed: 11, rules: gameRules, inputs: mkInputs(14, 8), garbage: [] },
          { playerId: 'b', name: 'Boris', seed: 22, rules: gameRules, inputs: mkInputs(11, 12), garbage: [] },
          { playerId: 'c', name: 'Cleo', seed: 33, rules: gameRules, inputs: mkInputs(9, 16), garbage: [] },
        ],
      });
      multiReplayState.returnRoomId = 'DEMO';
      resetReplayClock();
      buildMultiReplayDom(multiReplayState.playback.snapshot());
      appMode = 'onlineReplay';
      return multiReplayState.playback.snapshot();
    },
    getAppMode: () => appMode,
    // Reporte de lag exportable: copia el JSON al portapapeles y lo devuelve. Para que un
    // amigo con ?perf=1 lo mande sin leer la consola: jugar → sentir el lag → tetra.perfReport().
    // `perReport` es alias por si se tipea sin la 'f'.
    perfReport: () => runPerfReport(),
    perReport: () => runPerfReport(),
    getPendingConfirmAction: () => pendingConfirmAction,
    getInputSettings: () => cloneInputSettings(inputSettings),
    getCustomSettings: () => cloneCustomSettings(customSettings),
    getTouchControlsHidden: () => touchControlsHidden,
    getRunHistory: () => runHistory,
    getOnlineRoom: () => roomState.current,
    getOnlinePublicRooms: () => roomState.publicRooms,
    getOnlinePlayer: () => identityState.player,
    getLunaIdentity: () => lunaState.identity,
    clearRunHistory: () => {
      clearStoredRunHistory();
      runHistory = [];
      libraryState.selectedHistoryEntryId = null;
      return runHistory;
    },
    isSoundMuted: () => sound.isMuted(),
    toggleSound: () => {
      best = saveSoundMuted(sound.toggleMuted());
      setJuiceMuted(sound.isMuted());
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
      if (channel === 'sfx') setJuiceSfxVolume(sound.getSfxVolume());
      return nextVolume;
    },
    startNewRun,
    exportReplay,
    importReplayText,
    ...(import.meta.env.DEV ? { // BOT DEV
      getDevBot: () => devBotMatch,
      // Cambia el bucle a un timer en vez de requestAnimationFrame para poder correr
      // y observar el flujo (incluido el multijugador vs bot) en una pestaña en
      // segundo plano/headless, donde el navegador congela rAF. Arranca un frame
      // de inmediato para reanimar el bucle si el rAF pendiente quedó congelado.
      useTimerLoop: () => {
        scheduleNextFrame = (cb) => { window.setTimeout(() => cb(performance.now()), 16); };
        scheduleNextFrame(loop);
        return 'loop sobre setTimeout';
      },
    } : {}),
  },
});

// `tetra` es el namespace de debug de cara al usuario (ej. tetra.perfReport() para exportar
// el reporte de lag). Apunta al MISMO objeto que `stack40` —el nombre histórico que usan los
// tests/e2e—, así ambos quedan disponibles sin duplicar API.
(window as unknown as { tetra: unknown; stack40: unknown }).tetra =
  (window as unknown as { stack40: unknown }).stack40;

void bootstrapOnlineStartup();

function targetGameplayFrame(now = performance.now()): number {
  // DESACOPLE TOTAL (online + solo): el frame de juego se ancla al reloj LOCAL monotónico
  // (runState.gameClockOriginMs), NO al del servidor. Antes online se anclaba a startsAtServerMs para que
  // el host resimulara reproduciendo los inputs del cliente —pero el host ya NO resimula (modelo
  // cliente-autoritativo: sendOnlineInputsToHost es no-op)—, así que ese anclaje solo lograba que
  // la red metiera tirones en tu propia partida: un snap de reloj (conexión mala / segundo plano)
  // saltaba tu gravedad de golpe. Corriendo en reloj local, tu gravedad/DAS/ARR/lock-delay nunca
  // dependen de la red. El garbage se telegrafía desde que lo recibís (ver applyOnlineAttack), así
  // que tampoco necesita una línea de frames compartida.
  //
  // P2 (game feel): NUNCA forzamos runState.gameFrame+1 (eso obligaba un frame de engine por rAF y aceleraba
  // el juego ~3× en monitores >60Hz). Un rAF puede no producir frame nuevo (resolveGameplayFrame(f,f)
  // === f); loop() detecta ese caso y conserva los inputs recolectados hasta el próximo tick real.
  const elapsedFrames = Math.floor((now - runState.gameClockOriginMs) / GAME_FRAME_MS);
  const target = resolveGameplayFrame(runState.gameFrame, elapsedFrames);
  // Si la pestaña estuvo en segundo plano o hubo un stall grande, NO simulamos cientos de frames de
  // golpe (fast-forward violento de la gravedad + pico): reanclamos el reloj al frame actual y
  // seguimos suave. Un hitch normal (GC, <0.5 s) sí se recupera. Vale para solo y online por igual
  // ("confiar en el cliente": tu juego nunca se teletransporta, ni por la red ni por un freeze).
  if (target - runState.gameFrame > MAX_OFFLINE_RESUME_FRAMES) {
    runState.gameClockOriginMs = now - runState.gameFrame * GAME_FRAME_MS;
    return runState.gameFrame;
  }
  return target;
}

function syncGameplayClockToCurrentFrame(): void {
  runState.gameClockOriginMs = performance.now() - runState.gameFrame * GAME_FRAME_MS;
}

// Reancla el reloj del visor de repeticiones. Se llama al abrir cualquier visor
// (single o multi) para que el primer loop no avance de golpe el tiempo previo.
function resetReplayClock(): void {
  replayState.clockOriginMs = performance.now();
  replayState.framesAdvanced = 0;
}

// Cuántas veces hay que llamar a tick() del visor en este loop, según el tiempo
// real transcurrido a 60 fps (cada tick avanza `speed` frames del motor). En la
// mayoría de los rAF de un monitor >60 Hz devuelve 0 y solo se redibuja el frame
// actual; así la repetición corre a velocidad real en lugar de acelerarse.
function replayFramesDueThisLoop(): number {
  const targetFrames = Math.floor((performance.now() - replayState.clockOriginMs) / GAME_FRAME_MS);
  const due = targetFrames - replayState.framesAdvanced;
  if (due <= 0) return 0;
  // Tope de catch-up: tras una pausa o la pestaña en segundo plano (rAF congelado)
  // no descargamos cientos de frames de golpe; reanclamos y seguimos suave.
  if (due > 4) {
    replayState.framesAdvanced = targetFrames;
    return 1;
  }
  replayState.framesAdvanced = targetFrames;
  return due;
}

// Diagnóstico de partidas multijugador. Imprime en consola con prefijo [MP] para
// poder filtrar. Pensado para entender por qué un jugador "muere con espacio": al
// comparar el tablero local del cliente contra el autoritativo del host y el desfase
// de frames, se ve si el host está topando falsamente por divergencia de simulación.
function logMp(event: string, data: Record<string, unknown>): void {
  if (!mpLogEnabled) return; // apagado por defecto; prender con ?mplog=1
  // Serializamos a string para que la consola imprima TODOS los campos en línea (los
  // objetos anidados se colapsan a "…" y se pierden al copiar/pegar).
  console.log(`[MP ${event}] ${JSON.stringify({ role: isOnlineHost() ? 'host' : 'guest', player: identityState.player.id.slice(0, 6), seed: roomState.current?.seed, ...data })}`);
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
  for (let frame = runState.gameFrame + 1; frame <= targetFrame && canAdvanceGame(appMode, state.status); frame += 1) {
    const inputs = frame === targetFrame ? finalFrameInputs : [];
    state = engine.tick(frame, inputs);
    runState.gameFrame = frame;
    const events = engine.drainEvents();
    syncRunEffects(state, events);
    syncOnlineBattleEvents(events, state);
    juice.handleEvents(state, events);
  }
  return state;
}

function handleGlobalKeyDown(event: KeyboardEvent): void {
  if (hasBlockingModal() && event.code === 'Escape') {
    if (lunaState.pendingLaunchRequest) cancelPendingLunaLaunchRequest();
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
    syncSfxMuteToJuice();
  }
  if (event.code === 'KeyN') {
    event.preventDefault();
    sound.nextMusicTrack();
  }
  // Espectador: cambiar de tablero enfocado con las flechas izquierda/derecha
  // (ya no estoy jugando, así que no interfieren con el control de la pieza).
  if (isOnlineSpectating() && (event.code === 'ArrowLeft' || event.code === 'ArrowRight')) {
    event.preventDefault();
    cycleSpectatorFocus(event.code === 'ArrowLeft' ? -1 : 1);
    return;
  }
  // Teclas 1–5 (fila numérica o numpad) eligen la estrategia de objetivo
  // durante una batalla online de 3+ jugadores, al estilo tetr.io.
  if (appMode === 'onlinePlaying' && roomState.current && roomState.current.players.length > 2) {
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
    if (digit) {
      const index = Number(digit[1]) - 1;
      if (index >= 0 && index < TARGETING_MODES.length) {
        event.preventDefault();
        void setOnlineTargeting(TARGETING_MODES[index]);
      }
    }
  }
}

function handleOverlayInput(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    const field = target.dataset.onlineField;
    // El nombre ya no se edita acá: siempre se usa el que da Luna Negra.
    if (field === 'join-code') identityState.joinCode = normalizeRoomId(target.value);
    if (field === 'bet-stake') betState.stakeInput = target.value.replace(/[^0-9]/g, '').slice(0, 7);
    if (field === 'report-comment') reportState.comment = target.value.slice(0, 400);
    const customKey = parseCustomSettingKey(target.dataset.customSetting);
    if (customKey && target.value !== '') {
      customSettings = saveCustomSettings(updateCustomSetting(customSettings, customKey, target.type === 'checkbox' ? target.checked : target.value));
      scheduleOnlineRoomRulesSync();
    }
    return;
  }
  if (target instanceof HTMLSelectElement) {
    const customKey = parseCustomSettingKey(target.dataset.customSetting);
    if (customKey) {
      customSettings = saveCustomSettings(updateCustomSetting(customSettings, customKey, target.value));
      scheduleOnlineRoomRulesSync();
    }
  }
}

function toggleAutoPlay(): void { // TRUCO AUTOPLAY
  if (!autoPlayState.accessGranted) return;
  autoPlayState.enabled = !autoPlayState.enabled;
  input.releaseAll();
}

function handleOverlayPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  // Cambiar de tablero en espectador: se resuelve en pointerdown, no en click,
  // porque la grilla lateral se reconstruye cada snapshot (~10 Hz) y el nodo se
  // reemplaza entre el mousedown y el mouseup, así que el 'click' casi nunca llega.
  const spectate = target.closest<HTMLElement>('[data-ui-action="spectate-focus"]');
  if (spectate) {
    const id = spectate.dataset.playerId;
    if (id) spectatorState.focusId = id;
    event.preventDefault();
    return;
  }
  const control = target.closest<HTMLElement>('[data-ui-action="toggle-autoplay"]');
  if (!control) return;
  toggleAutoPlay();
  autoPlayState.ignoreNextClick = true;
  window.setTimeout(() => {
    autoPlayState.ignoreNextClick = false;
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
  if (action === 'cycle-touch-scheme') {
    cycleTouchScheme();
    return;
  }
  if (action === 'toggle-touch-haptics') {
    toggleTouchHaptics();
    return;
  }
  if (action === 'toggle-autoplay') { // TRUCO AUTOPLAY
    if (autoPlayState.ignoreNextClick) {
      autoPlayState.ignoreNextClick = false;
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
  if (action === 'report-perf') {
    void sendPerfReport();
    return;
  }
  if (hasBlockingModal()) return;
  if (requiresRunConfirmation(action, appMode, engine.getState().status, settingsReturnMode)) {
    requestRunConfirmation(action);
    return;
  }

  if (import.meta.env.DEV) { // BOT DEV: acciones del panel de control
    if (action === 'dev-bot-match') {
      void startDevBotMatch();
      return;
    }
    if (action === 'dev-bot-attack') {
      devBotMatch?.forceAttack(Number(control.dataset.lines ?? '2'));
      return;
    }
    if (action === 'dev-bot-topout') {
      devBotMatch?.forceTopOut();
      return;
    }
    if (action === 'dev-bot-cadence') {
      devBotMatch?.setConfig({ inputCadenceFrames: Math.max(1, Number(control.dataset.value ?? '6')) });
      overlayState.lastDevBot = '';
      return;
    }
    if (action === 'dev-bot-next-round') {
      void startOnlineRoom();
      return;
    }
  }

  if (action === 'sidebar-play') {
    // Botón principal inteligente:
    // - solo o sin sala → partida de un jugador con la config custom (honra el seed).
    // - con rivales en la sala → alterna el estado "listo" (host e invitado por igual).
    if (roomState.current && onlineRoomHasOtherPlayers()) {
      // Host e invitado: este botón alterna "listo". El host arranca la ronda
      // con la acción 'online-start' del botón central.
      void setOnlineReady(!currentOnlinePlayer()?.ready);
    } else if (uiSelectionState.playMode === 'local1v1') {
      startLocalVersusMode();
    } else if (uiSelectionState.playMode === 'survival') {
      startSurvivalRun();
    } else {
      startCustomRun();
    }
    return;
  }

  if (action === 'local-versus') { startLocalVersusMode(); return; }
  if (action === 'play-menu') openPlayMenu();
  if (action === 'select-play-mode') {
    const next = parsePlayMode(control.dataset.mode);
    if (next) {
      uiSelectionState.playMode = next;
      if (next === 'survival') ensureSurvivalTopsLoaded();
    }
  }
  if (action === 'select-room-mode') {
    const next = parsePlayMode(control.dataset.mode);
    if (next) void switchOnlineRoomMode(next);
    return;
  }
  if (action === 'start') startCustomRun();
  if (action === 'restart') restartCurrentRun();
  if (action === 'solo-menu') openModeMenu('soloMenu');
  if (action === 'multiplayer-menu') openOnlineMenu();
  if (action === 'history-menu') openHistoryMenu();
  if (action === 'leaderboard-open') openLeaderboard();
  if (action === 'leaderboard-refresh') void refreshActiveLeaderboard();
  if (action === 'leaderboard-tab-wins') setLeaderboardTab('wins');
  if (action === 'leaderboard-tab-survival') setLeaderboardTab('survival');
  if (action === 'survival-top-open') openLeaderboard('survival');
  if (action === 'survival-start') startSurvivalRun();
  if (action === 'config-menu') openSettingsTab();
  if (action === 'custom-open') openCustomMode();
  if (action === 'custom-back') goToMenu();
  if (action === 'custom-start') startCustomRun();
  if (action === 'custom-reset') {
    customSettings = resetCustomSettings();
    renderer.setColorBlind(customSettings.colorBlindMode);
    scheduleOnlineRoomRulesSync();
  }
  if (action === 'custom-export') lastCustomExportName = exportCustomSettings();
  if (action === 'custom-tab') {
    const nextTab = parseCustomTab(control.dataset.tab);
    if (nextTab) uiSelectionState.customTab = nextTab;
  }
  if (action === 'custom-toggle') {
    const setting = parseCustomSettingKey(control.dataset.setting);
    if (setting && isCustomBooleanSetting(setting)) {
      customSettings = saveCustomSettings(updateCustomSetting(customSettings, setting, !customSettings[setting]));
      if (setting === 'colorBlindMode') renderer.setColorBlind(customSettings.colorBlindMode);
      scheduleOnlineRoomRulesSync();
    }
  }
  if (action === 'custom-step') {
    const setting = parseCustomSettingKey(control.dataset.setting);
    const delta = Number(control.dataset.delta ?? 0);
    if (setting && Number.isFinite(delta)) {
      customSettings = saveCustomSettings(updateCustomSettingByDelta(customSettings, setting, delta));
      scheduleOnlineRoomRulesSync();
    }
  }
  if (action === 'online-open') openOnlineMenu();
  if (action === 'online-custom-open') openOnlineMenu();
  if (action === 'online-refresh') refreshPublicRooms();
  if (action === 'online-room-visibility') setOnlineRoomVisibility(control.dataset.visibility);
  if (action === 'online-visibility-toggle') {
    setOnlineRoomVisibility(roomState.current?.visibility === 'public' ? 'private' : 'public');
  }
  if (action === 'online-results-menu') {
    closeOnlineResults();
  }
  if (action === 'online-create') createOnlineRoom('private');
  if (action === 'online-create-public') createOnlineRoom('public');
  if (action === 'online-create-private') createOnlineRoom('private');
  if (action === 'online-join') joinOnlineRoom(identityState.joinCode);
  if (action === 'online-join-public') joinOnlineRoom(control.dataset.roomId ?? '');
  if (action === 'online-ready') setOnlineReady(true);
  if (action === 'online-unready') setOnlineReady(false);
  if (action === 'online-start') startOnlineRoom();
  if (action === 'online-restart') restartOnlineRoom();
  if (action === 'online-bet-create') createOnlineBet();
  if (action === 'online-bet-cancel') cancelOnlineBet();
  if (action === 'online-bet-retry') retryOnlineBetInvoiceGeneration();
  if (action === 'online-bet-settle') settleOnlineBet();
  if (action === 'online-bet-refresh') refreshOnlineBet(false);
  if (action === 'online-bet-pay') {
    wakeUpBetDetection();
  }
  if (action === 'online-bet-webln') {
    void payOnlineBetWithExtension(control.dataset.invoice ?? '');
  }
  if (action === 'online-bet-claim-webln') {
    void claimOnlineBetWithExtension(control.dataset.lnurl ?? '');
  }
  if (action === 'online-bet-open-wallet') {
    openLightningWallet(control.dataset.lightning ?? control.dataset.lnurl ?? '');
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
  if (action === 'online-copy-invite-link') {
    shareRoomInviteLink();
  }
  if (action === 'resume') resumeGame();
  if (action === 'settings') openSettings();
  if (action === 'settings-back') closeSettings();
  if (action === 'settings-reset') applyInputSettings(resetInputSettings());
  if (action === 'export-replay') exportReplay();
  if (action === 'replay-last-seconds') startDeathReplay();
  if (action === 'import-replay') openReplayFilePicker();
  if (action === 'replay-library' || action === 'run-history') openHistoryMenu();
  if (action === 'library-back' || action === 'history-back') goToMenu();
  if (action === 'library-filter') setLibraryFilter(control.dataset.filter);
  if (action === 'select-history-entry') selectHistoryEntry(control.dataset.historyId);
  if (action === 'clear-history') {
    clearStoredRunHistory();
    runHistory = [];
    libraryState.selectedHistoryEntryId = null;
    libraryState.error = null;
  }
  if (action === 'play-history-replay') {
    const entry = findHistoryEntry(control.dataset.historyId);
    if (entry) startReplayPlayback(entry.replay, `History ${formatDateTime(entry.createdAt)}`);
    else libraryState.error = 'Replay entry was not found.';
  }
  if (action === 'export-history-replay') {
    const entry = findHistoryEntry(control.dataset.historyId);
    if (entry) {
      lastExportName = downloadReplayFile(entry.replay);
      libraryState.error = null;
    } else {
      libraryState.error = 'Replay entry was not found.';
    }
  }
  if (action === 'delete-history-entry') {
    const entry = findHistoryEntry(control.dataset.historyId);
    if (entry) {
      runHistory = deleteRunHistoryEntry(entry.id);
      libraryState.selectedHistoryEntryId = libraryState.selectedHistoryEntryId === entry.id ? null : libraryState.selectedHistoryEntryId;
      syncLibrarySelection();
      libraryState.error = null;
      lastExportName = null;
    } else {
      libraryState.error = 'Replay entry was not found.';
    }
  }
  if (action === 'replay-toggle') replayState.playback?.togglePaused();
  if (action === 'replay-restart') replayState.playback?.restart();
  if (action === 'replay-exit') exitReplayPlayback();
  if (action === 'replay-speed') {
    const speed = Number(control.dataset.speed);
    if (REPLAY_SPEEDS.includes(speed as PlaybackSpeed)) replayState.playback?.setSpeed(speed as PlaybackSpeed);
  }
  if (action === 'online-replay-open') openMultiReplay();
  if (action === 'multi-replay-toggle') multiReplayState.playback?.togglePaused();
  if (action === 'multi-replay-restart') multiReplayState.playback?.restart();
  if (action === 'multi-replay-exit') exitMultiReplay();
  if (action === 'multi-replay-speed') {
    const speed = Number(control.dataset.speed);
    if (REPLAY_SPEEDS.includes(speed as PlaybackSpeed)) multiReplayState.playback?.setSpeed(speed as MultiPlaybackSpeed);
  }
  if (action === 'main-menu') goToMenu();
  if (action === 'toggle-sound') {
    best = saveSoundMuted(sound.toggleMuted());
    syncSfxMuteToJuice();
  }
  if (action === 'toggle-sfx') {
    sound.toggleSfxMuted();
    best = saveAudioMutes(sound.isSfxMuted(), sound.isMusicMuted());
    syncSfxMuteToJuice();
  }
  if (action === 'toggle-music') {
    sound.toggleMusicMuted();
    best = saveAudioMutes(sound.isSfxMuted(), sound.isMusicMuted());
  }
  if (action === 'next-music') sound.nextMusicTrack();
  if (action === 'cycle-reverb') best = saveMusicReverb(sound.cycleReverbMode());
  if (action === 'toggle-positional') {
    setPositionalAudio(!isPositionalAudio());
    best = savePositionalAudio(isPositionalAudio());
  }
  if (action === 'toggle-royalty-free') {
    best = saveRoyaltyFreeOnly(!loadRecord().royaltyFreeOnly);
    sound.setMusicTracks(musicTracksFor(best.royaltyFreeOnly));
    // Si soy el host y estoy en el lobby, propago la preferencia a la sala para que
    // todos reproduzcan la misma música en la partida.
    void syncOnlineRoomMusicPref();
  }
  if (action === 'toggle-bg-motion') {
    best = saveBackgroundMotion(!loadRecord().backgroundMotion);
    renderer.setBackgroundMotion(best.backgroundMotion);
  }
  if (action === 'capture-binding') {
    const controlAction = parseControlAction(control.dataset.controlAction);
    if (controlAction) bindingCapture = controlAction;
  }
  if (action === 'timing') {
    const setting = parseTimingKey(control.dataset.setting);
    const delta = Number(control.dataset.delta ?? 0);
    applyInputSettings(updateInputTiming(inputSettings, setting, delta));
  }
  if (action === 'handling-preset') {
    const preset = parseHandlingPreset(control.dataset.preset);
    if (preset) applyInputSettings(applyHandlingPreset(inputSettings, preset));
  }
  if (action === 'volume-adjust') {
    const channel: VolumeChannel = control.dataset.volumeChannel === 'music' ? 'music' : 'sfx';
    const delta = Number(control.dataset.delta ?? 0);
    sound.adjustVolume(channel, delta);
    best = saveAudioVolumes(sound.getSfxVolume(), sound.getMusicVolume());
    if (channel === 'sfx') setJuiceSfxVolume(sound.getSfxVolume());
    volumeFeedback = { channel, expiresAt: performance.now() + 900 };
  }
}

function parseTimingKey(value: string | undefined): InputTimingKey {
  if (value === 'arrFrames') return 'arrFrames';
  if (value === 'softDropFactor') return 'softDropFactor';
  return 'dasFrames';
}

function parseHandlingPreset(value: string | undefined): HandlingPreset | null {
  return HANDLING_PRESET_ORDER.find((preset) => preset === value) ?? null;
}

// Intensidad de vibración MARCADA POR ACCIÓN: mover = toque suave, rotar = medio,
// hard drop = fuerte, 180° = doble pulso. lock/clear se disparan aparte (en el tick).
//
// IMPORTANTE: los motores hápticos de los teléfonos (ERM/LRA) tardan ~15-25ms en
// arrancar, así que pulsos < ~15ms son imperceptibles (no llega a moverse el motor).
// Por eso las duraciones cortas se sentían como "no vibra". Acá usamos un piso de
// ~14ms y escalamos hacia arriba; la API básica no controla amplitud, así que la
// "intensidad" se logra con más duración / patrones de varios pulsos.
const TOUCH_HAPTICS: Record<ControlAction, number | number[]> = {
  moveLeft: 16,
  moveRight: 16,
  softDrop: 14,
  rotateCW: 22,
  rotateCCW: 22,
  rotate180: [18, 30, 18],
  hardDrop: 40,
  hold: 20,
  retry: 0,
  pause: 0,
};

// Vibra respetando el toggle y la disponibilidad del API (silencioso en desktop).
// `navigator.vibrate` devuelve false si el navegador/SO la rechazó (config del sistema,
// modo silencio, falta de gesto). Guardamos el último resultado para el diagnóstico.
let lastVibrateResult: boolean | null = null;
function vibrate(pattern: number | number[]): boolean {
  if (!touchHapticsEnabled) return false;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
    lastVibrateResult = null;
    return false;
  }
  try {
    lastVibrateResult = navigator.vibrate(pattern);
    return lastVibrateResult;
  } catch {
    // Algunos navegadores bloquean vibrate sin gesto de usuario; lo ignoramos.
    lastVibrateResult = false;
    return false;
  }
}

function triggerTouchHaptic(action: ControlAction): void {
  const p = TOUCH_HAPTICS[action];
  if (Array.isArray(p) ? p.length > 0 : p > 0) vibrate(p);
}

// Esquemas de control táctil intercambiables (chip en la fila de utilidades).
const TOUCH_SCHEME_ORDER: TouchScheme[] = ['pro', 'reduced', 'dpad'];
const TOUCH_SCHEME_LABELS: Record<TouchScheme, string> = {
  pro: 'Pro',
  reduced: 'Simple',
  dpad: 'D-pad',
};

function releaseActiveTouches(): void {
  for (const active of activeTouchInputs.values()) {
    input.releaseControl(active.sourceId);
    active.control.classList.remove('touch-button-active');
  }
  activeTouchInputs.clear();
}

function cycleTouchScheme(): void {
  const i = TOUCH_SCHEME_ORDER.indexOf(touchScheme);
  touchScheme = TOUCH_SCHEME_ORDER[(i + 1) % TOUCH_SCHEME_ORDER.length];
  best = saveTouchScheme(touchScheme);
  releaseActiveTouches(); // evita botones "pegados" al recambiar el layout
  // El nuevo esquema reacomoda los botones (alto distinto) sin disparar un resize de
  // ventana: invalidamos el inset cacheado para que el tablero se reajuste enseguida.
  renderer.markLayoutDirty();
  vibrate(20);
}

function toggleTouchHaptics(): void {
  touchHapticsEnabled = !touchHapticsEnabled;
  best = saveTouchHaptics(touchHapticsEnabled);
  // Confirmación bien notoria al encender: doble pulso. Si NO se siente esto, el
  // problema no son las duraciones sino el SO/navegador (config de vibración, modo
  // silencio o contexto no seguro), no el código.
  if (touchHapticsEnabled) vibrate([30, 40, 30]);
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
  triggerTouchHaptic(action);
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
      replayState.playback?.togglePaused();
      input.releaseAll();
      return true;
    }
    appMode = togglePauseMode(appMode, engine.getState().status, settingsReturnMode);
    if (canAdvanceGame(appMode, engine.getState().status)) syncGameplayClockToCurrentFrame();
    input.releaseAll();
    return true;
  }

  if (appMode === 'replayPlayback' && inputs.some((event) => event.action === 'retry')) {
    replayState.playback?.restart();
    input.releaseAll();
    return true;
  }

  if (appMode === 'onlinePlaying' && inputs.some((event) => event.action === 'retry')) {
    onlineNetState.error = 'Retry is disabled during online races.';
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

function startNewRun(nextSeed = randomSeed(), nextMode: AppMode = 'playing', nextRunKind: RunKind = nextMode === 'onlinePlaying' ? 'online' : 'custom'): void {
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
  replayState.importError = null;
  libraryState.error = null;
  localRunError = null;
  replayState.importedName = null;
  replayState.playback = null;
  runState.currentRunKind = nextRunKind;
  // Online: main.ts conoce los tableros rivales y enruta el proyectil de ataque
  // hacia ellos (ver flyOnlineAttackProjectile). En solo, retroceso en tu borde.
  juice.setAttackRouting(nextRunKind === 'online' ? 'external' : 'auto');
  gameRules = rulesForRun(nextMode);
  seed = nextSeed;
  engine = new GameEngine(seed, gameRules);
  replay = createReplayLog(seed, gameRules);
  // Replay multi-tablero: nueva ronda = nueva semilla; reseteamos la recolección.
  onlineReplayCollector.reset(seed);
  multiReplayState.broadcast = false;
  runState.gameFrame = 0;
  runState.gameClockOriginMs = performance.now();
  runState.savedRunHistoryEntry = false;
  leaderboardState.submittedSurvivalRun = false;
  leaderboardState.survivalRunRank = null;
  runState.splitTracker = new RunSplitTracker();
  runState.lastPieces = 0;
  runState.lastLines = 0;
  lastStatus = engine.getState().status;
  runState.maxCombo = 0;
  // Reseteamos el botón "Reportar" de la pantalla de resultados para la ronda nueva: así se
  // puede mandar un reporte fresco cada partida (y no queda pegado en "enviado"). El comentario
  // SÍ se conserva entre rondas a propósito (el jugador puede tipearlo mientras juega).
  reportState.buttonState = 'idle';
  if (nextMode === 'playing') {
    const isE2E = !!(window as any).__E2E__ || navigator.webdriver;
    if (isE2E) {
      appMode = 'playing';
    } else {
      appMode = 'soloCountdown';
      runState.soloCountdownStartsAtMs = performance.now() + 3000;
      runState.lastCountdownSecondPlayed = -1;
    }
  } else {
    appMode = nextMode;
  }
  settingsReturnMode = 'menu';
  sound.play('retry');
}

function restartCurrentRun(): void {
  if (runState.currentRunKind === 'survival') {
    startSurvivalRun();
    return;
  }
  if (runState.currentRunKind === 'custom') {
    if (!customSettings.allowRetry) return;
    startCustomRun();
    return;
  }
  startNewRun();
}

function startCustomRun(): void {
  startNewRun(customSeed(customSettings, randomSeed), 'playing', 'custom');
}

// Modo Supervivencia: semilla aleatoria (no se comparte config), reglas fijas iguales
// para todos. Arranca con la cuenta regresiva 3·2·1 como el solo normal.
function startSurvivalRun(): void {
  startNewRun(randomSeed(), 'playing', 'survival');
}

function openCustomMode(): void {
  bindingCapture = null;
  pendingConfirmAction = null;
  // Configurar una partida custom implica elegir la modalidad Custom: así el botón ▶
  // arranca custom (no survival) al volver del editor.
  uiSelectionState.playMode = 'custom';
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

// Tab "Ajustes" del dashboard: abre DIRECTO los ajustes completos (bindings,
// presets, timing, accesibilidad, audio, touch). Antes había una vista compacta
// 'configMenu' (DAS/ARR/Soft drop) con un botón "Ajustes de controles" que recién
// llevaba acá; se fusionó para no tener dos pantallas redundantes. returnMode
// 'menu' hace que renderice como panel del dashboard (no como overlay de pausa).
function openSettingsTab(): void {
  bindingCapture = null;
  pendingConfirmAction = null;
  appMode = 'settings';
  settingsReturnMode = 'menu';
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
  runState.currentRunKind = 'custom';
  syncGameplayClockToCurrentFrame();
  settingsReturnMode = 'menu';
  replayState.playback = null;
  replayState.importedName = null;
  libraryState.error = null;
  runHistory = loadRunHistory();
  input.releaseAll();
}

// Vista "Historial" del dashboard: lista ÚNICA de replays (diseño "Tus replays")
// con filtros y acciones por fila (Ver/Exportar/Borrar) + Borrar historial. Antes
// había una segunda pantalla 'library' con todo esto; se fusionó acá para no tener
// dos vistas redundantes. syncLibrarySelection mantiene coherente el filtro activo.
function openHistoryMenu(): void {
  bindingCapture = null;
  pendingConfirmAction = null;
  runHistory = loadRunHistory();
  appMode = 'historyMenu';
  settingsReturnMode = 'menu';
  libraryState.error = null;
  syncLibrarySelection();
  input.releaseAll();
}

function openOnlineMenu(): void {
  bindingCapture = null;
  pendingConfirmAction = null;
  onlineNetState.error = null;
  appMode = 'onlineMenu';
  settingsReturnMode = 'menu';
  input.releaseAll();
  // Refresco silencioso: NO tomar el lock onlineNetState.busy. Si lo tomara, un join
  // inmediato (p. ej. bootstrapJoinLink al abrir un ?join=) abortaría con "Enter a
  // room ID…" porque joinOnlineRoom corta cuando onlineNetState.busy está en true, y el que
  // abre el link nunca entraría a la sala.
  void refreshPublicRooms({ silent: true });
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
  pendingConfirmAction = null;
  lunaState.pendingLaunchRequest = null;
  bindingCapture = null;
  appMode = 'onlineMenu';
  settingsReturnMode = 'menu';
  input.releaseAll();
  if (!roomId) {
    onlineNetState.error = 'Missing Luna Negra room id.';
    return;
  }
  if (onlineNetState.busy) {
    onlineNetState.error = 'Ya hay una acción online en curso.';
    return;
  }
  onlineNetState.busy = true;
  onlineNetState.error = null;
  try {
    await leaveCurrentRoomBeforeNew(roomId);
    const response = await onlineClient.enterLunaNegraRoom({ inviteToken, roomId });
    identityState.player = saveOnlinePlayer({
      id: response.player.id,
      name: response.player.name,
      avatarUrl: response.player.avatarUrl,
    });
    identityState.name = response.player.name;
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
    onlineNetState.error = onlineErrorText(error);
  } finally {
    onlineNetState.busy = false;
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
    } catch (error) {
      // Si Luna Negra rechaza un token fresco, la identidad cacheada ya no prueba sesión.
      console.warn('[luna-negra] No se pudo resolver la sesión desde el token; entrando como invitado.', error);
      clearLunaIdentity();
    } finally {
      removeLunaSessionParamsFromUrl();
    }
  } else {
    const stored = loadStoredLunaIdentity();
    if (stored) applyLunaIdentity(stored);
  }
  if (!lunaState.identity) return;
  await syncLunaPresence();
}

function applyLunaIdentity(identity: LunaIdentity): void {
  lunaState.identity = identity;
  identityState.player = saveOnlinePlayer({
    ...identityState.player,
    id: identity.pubkey || identityState.player.id,
    name: identity.name,
    avatarUrl: identity.avatarUrl ?? identityState.player.avatarUrl,
  });
  identityState.name = identityState.player.name;
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
  if (stored.playerId !== identityState.player.id) {
    clearOnlineRoomSession();
    return false;
  }

  try {
    const response = await onlineClient.getRoomState(stored.roomId, identityState.player.id);
    syncOnlineClock(response.serverNowMs);
    if (!response.room.players.some((player) => player.id === identityState.player.id)) {
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
  if (!room.players.some((player) => player.id === identityState.player.id)) {
    clearOnlineRoomSession();
    return;
  }
  try {
    sessionStorage.setItem(ONLINE_ROOM_SESSION_KEY, JSON.stringify({
      roomId: room.id,
      playerId: identityState.player.id,
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
  lunaState.identity = null;
  lunaState.inviteNotice = null;
  lunaState.pendingLaunchRequest = null;
  clearStoredLunaIdentity();
  if (!roomState.current) {
    identityState.player = saveOnlinePlayer({ id: '', name: 'Player', avatarUrl: null });
    identityState.name = identityState.player.name;
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
  lunaState.trustedOrigin = origin;
  try {
    localStorage.setItem(LUNA_ORIGIN_KEY, origin);
  } catch {
    // Sin localStorage, el origen queda en memoria para esta pestaña.
  }
}

function handleLunaNegraWindowMessage(event: MessageEvent): void {
  const message = parseLunaWindowMessage(event.data);
  if (!message) return;
  if (!lunaState.trustedOrigin || event.origin !== lunaState.trustedOrigin) return;
  if (message.type === LUNA_LOGOUT_MESSAGE_TYPE) {
    clearLunaIdentity();
    return;
  }
  void enterLunaNegraRoomFromInvite(message.inviteToken, normalizeRoomId(message.roomId));
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
  if (!lunaState.identity || !isPlayerActivelyPresent()) return;
  try {
    await lunaSocialClient.heartbeat({
      npub: lunaState.identity.npub,
      name: identityState.player.name,
      avatarUrl: identityState.player.avatarUrl,
      status: roomState.current ? 'in-game' : 'online',
      roomId: roomState.current?.id ?? null,
    });
  } catch {
    // La presencia es best-effort.
  }
}

async function syncLunaLaunchRequest(): Promise<void> {
  if (!lunaState.identity || onlineNetState.busy || lunaState.launchPollInFlight || lunaState.pendingLaunchRequest) return;
  lunaState.launchPollInFlight = true;
  try {
    const response = await lunaSocialClient.launchRequest(lunaState.identity.npub);
    syncOnlineClock(response.serverNowMs);
    const request = response.request;
    if (!request) return;
    if (lunaState.ignoredLaunchRequestIds.has(request.id)) return;
    await handleLunaLaunchRequest(request);
  } catch {
    // La orden pendiente es best-effort; la UI de Luna conserva el fallback de abrir/navegar.
  } finally {
    lunaState.launchPollInFlight = false;
  }
}

async function handleLunaLaunchRequest(request: LunaLaunchRequest): Promise<void> {
  const normalizedRoomId = normalizeRoomId(request.roomId);
  if (!normalizedRoomId) return;
  if (roomState.current && normalizeRoomId(roomState.current.id) === normalizedRoomId) return;
  const pending = { ...request, normalizedRoomId };
  lunaState.pendingLaunchRequest = pending;
  bindingCapture = null;
  // En partida la invitación es un toast: no soltamos los inputs ni robamos el
  // control. Solo el modal (en menús) limpia el estado de teclado.
  if (!lunaInviteShowsAsToast()) input.releaseAll();
}

async function acceptPendingLunaLaunchRequest(): Promise<void> {
  const request = lunaState.pendingLaunchRequest;
  if (!request) return;
  lunaState.pendingLaunchRequest = null;
  await enterLunaNegraRoomFromInvite(request.inviteToken, request.normalizedRoomId);
}

function cancelPendingLunaLaunchRequest(): void {
  const request = lunaState.pendingLaunchRequest;
  const wasToast = request !== null && lunaInviteShowsAsToast();
  if (request) lunaState.ignoredLaunchRequestIds.add(request.id);
  lunaState.pendingLaunchRequest = null;
  bindingCapture = null;
  // Si era toast, el juego nunca se pausó: no hay que resincronizar el reloj ni
  // soltar las teclas que el jugador tiene apretadas.
  if (wasToast) return;
  if (canAdvanceGame(appMode, engine.getState().status)) syncGameplayClockToCurrentFrame();
  input.releaseAll();
}

async function openLunaInviteWindow(): Promise<void> {
  if (lunaState.inviteWindowBusy) return;
  if (!lunaState.identity?.gameId) {
    onlineNetState.error = 'Abri el juego desde Luna Negra para invitar amigos.';
    return;
  }

  if (!roomState.current) {
    await createOnlineRoom('private');
    if (!roomState.current) return;
  }

  const popup = window.open('', 'luna-negra-invite', 'popup=yes,width=420,height=640');
  if (!popup) {
    onlineNetState.error = 'El navegador bloqueo la ventana de Luna Negra.';
    return;
  }

  try {
    popup.opener = null;
    popup.document.title = 'Luna Negra';
    popup.document.body.innerHTML = '<p style="font-family: system-ui; padding: 16px;">Abriendo Luna Negra...</p>';
  } catch {
    // Si el navegador no permite tocar about:blank, igual navegamos la ventana.
  }

  lunaState.inviteWindowBusy = true;
  lunaState.inviteNotice = null;
  try {
    const response = await lunaSocialClient.inviteWindow(lunaState.identity.gameId, roomState.current.id, identityState.player.id);
    popup.location.href = response.url;
    lunaState.inviteNotice = 'Elegiste amigos desde Luna Negra.';
    onlineNetState.error = null;
  } catch (error) {
    popup.close();
    onlineNetState.error = onlineErrorText(error);
  } finally {
    lunaState.inviteWindowBusy = false;
  }
}

async function openLunaLogin(): Promise<void> {
  if (onlineNetState.busy || lunaState.inviteWindowBusy) return;
  lunaState.inviteWindowBusy = true;
  onlineNetState.error = null;
  try {
    const response = await lunaSocialClient.loginUrl();
    window.location.href = response.url;
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    lunaState.inviteWindowBusy = false;
  }
}

async function kickOnlinePlayer(targetPlayerId: string): Promise<void> {
  if (!roomState.current || onlineNetState.busy || !targetPlayerId) return;
  if (targetPlayerId === identityState.player.id) return;
  onlineNetState.busy = true;
  try {
    const response = await onlineClient.kickPlayer({
      roomId: roomState.current.id,
      playerId: identityState.player.id,
      targetPlayerId,
    });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    onlineNetState.error = null;
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    onlineNetState.busy = false;
  }
}

// La lista de salas públicas solo se auto-refresca cuando el jugador la está
// mirando (dashboard/menú online, sin sala propia y con la pestaña al frente).
// Así ve salas nuevas sin recargar, sin pegarle a la API jugando o en segundo plano.
const ROOM_BROWSER_APP_MODES: AppMode[] = ['menu', 'multiplayerMenu', 'onlineMenu'];

function shouldAutoRefreshPublicRooms(): boolean {
  if (document.hidden) return false;
  if (roomState.current || onlineNetState.busy) return false;
  return ROOM_BROWSER_APP_MODES.includes(appMode);
}

// El refresco automático de salas (cada ONLINE_ROOMS_AUTO_REFRESH_MS) corre en
// segundo plano y NO debe togglear `onlineNetState.busy`: ese flag deshabilita los botones
// del panel, así que prenderlo/apagarlo en cada ciclo cambia el HTML del overlay
// y fuerza un repintado completo (recreando los <img> de avatar) → el panel
// "SALA ONLINE" parpadea. El modo silencioso usa su propio guard de concurrencia
// para no tocar el HTML renderizado; solo repinta si los datos realmente cambian.
let publicRoomsRefreshInFlight = false;

async function refreshPublicRooms(options: { silent?: boolean } = {}): Promise<void> {
  const silent = options.silent === true;
  if (silent) {
    if (onlineNetState.busy || publicRoomsRefreshInFlight) return;
    publicRoomsRefreshInFlight = true;
  } else {
    if (onlineNetState.busy) return;
    onlineNetState.busy = true;
  }
  try {
    const response = await onlineClient.listPublicRooms(publicRoomFilters());
    syncOnlineClock(response.serverNowMs);
    roomState.publicRooms = response.rooms;
    onlineNetState.error = null;
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    if (silent) publicRoomsRefreshInFlight = false;
    else onlineNetState.busy = false;
  }
}

function publicRoomFilters(): PublicRoomsFilters {
  // Sin filtro de matchType: listamos salas de ambas modalidades (Custom y
  // Supervivencia/battle). Cada tarjeta muestra su etiqueta para distinguirlas.
  return {};
}

async function setOnlineRoomVisibility(value: string | undefined): Promise<void> {
  if (!roomState.current || onlineNetState.busy) return;
  const visibility = value === 'public' ? 'public' : value === 'private' ? 'private' : null;
  if (!visibility || visibility === roomState.current.visibility) return;
  if (roomState.current.hostPlayerId !== identityState.player.id) {
    onlineNetState.error = 'Solo el host puede cambiar la visibilidad de la sala.';
    return;
  }
  if (roomState.current.status !== 'lobby') {
    onlineNetState.error = 'La visibilidad solo se puede cambiar en el lobby.';
    return;
  }
  onlineNetState.busy = true;
  try {
    // visibilityOnly: el toggle no reinicia reglas, jugadores ni la apuesta, y
    // no cambia la pantalla actual (se usa desde el panel persistente también).
    const response = await onlineClient.updateRoomSettings({
      roomId: roomState.current.id,
      playerId: identityState.player.id,
      visibility,
      visibilityOnly: true,
      matchType: 'custom',
    });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    onlineNetState.error = null;
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    onlineNetState.busy = false;
  }
}

// Sync de reglas en vivo: si el host edita la config custom estando en el lobby,
// re-enviamos las reglas a la sala (debounced) para que apliquen al instante en
// todos los clientes. Reusa el path completo de updateRoomSettings del server.
// onlineNetState.rulesSyncTimer vive ahora en onlineNetState (ver imports).

function canSyncOnlineRoomRules(): boolean {
  if (!roomState.current || !isOnlineHost() || roomState.current.status !== 'lobby') return false;
  // Supervivencia (battle) tiene reglas fijas: no se sincroniza la config custom
  // (además, hacerlo convertiría la sala a 'custom' en el server).
  if (roomState.current.matchType === 'battle') return false;
  // El server rechaza cambios de reglas con una apuesta activa; no spameamos.
  if (roomState.current.bet && !['settled', 'cancelled', 'expired', 'refunded'].includes(roomState.current.bet.status)) return false;
  return true;
}

function scheduleOnlineRoomRulesSync(): void {
  if (!canSyncOnlineRoomRules()) return;
  if (onlineNetState.rulesSyncTimer) clearTimeout(onlineNetState.rulesSyncTimer);
  onlineNetState.rulesSyncTimer = setTimeout(() => {
    onlineNetState.rulesSyncTimer = null;
    void syncOnlineRoomRules();
  }, 350);
}

async function syncOnlineRoomRules(): Promise<void> {
  if (!canSyncOnlineRoomRules() || !roomState.current) return;
  if (onlineNetState.busy) {
    // Otra operación online en curso: reintentar sin perder el cambio.
    scheduleOnlineRoomRulesSync();
    return;
  }
  const room = roomState.current;
  onlineNetState.busy = true;
  try {
    const response = await onlineClient.updateRoomSettings({
      roomId: room.id,
      playerId: identityState.player.id,
      visibility: room.visibility,
      mode: 'custom',
      matchType: 'custom',
      ruleset: onlineRulesetPatch(),
      rules: onlineCustomRulesFromSettings(),
    });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    onlineNetState.error = null;
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    onlineNetState.busy = false;
  }
}

// El host cambió su preferencia de música libre-de-derechos estando en el lobby:
// la re-enviamos a la sala (preservando matchType y reglas) para que la próxima
// partida suene igual en todos los clientes. Sirve tanto para salas Custom como
// Supervivencia/battle. Silencioso: si no soy host o no estoy en lobby, no hace nada.
async function syncOnlineRoomMusicPref(): Promise<void> {
  const room = roomState.current;
  if (!room || !isOnlineHost() || room.status !== 'lobby' || onlineNetState.busy) return;
  // El server rechaza cambios de ajustes con una apuesta activa: no insistimos.
  if (room.bet && !['settled', 'cancelled', 'expired', 'refunded'].includes(room.bet.status)) return;
  onlineNetState.busy = true;
  try {
    const rules = room.matchType === 'battle' ? battleRulesFromSettings(inputSettings) : onlineCustomRulesFromSettings();
    const response = await onlineClient.updateRoomSettings({
      roomId: room.id,
      playerId: identityState.player.id,
      visibility: room.visibility,
      mode: 'custom',
      matchType: room.matchType,
      ruleset: onlineRulesetPatch(),
      rules,
    });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    onlineNetState.error = null;
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    onlineNetState.busy = false;
  }
}

// La modalidad activa decide el tipo de sala: Supervivencia → 'battle' (reglas
// fijas, top justo); Custom → 'custom' (reglas editables). 1v1 local no es una sala
// online (tiene su propio botón), así que cae a 'custom'.
function roomMatchTypeForSelectedMode(): OnlineMatchType {
  return uiSelectionState.playMode === 'survival' ? 'battle' : 'custom';
}

// Modo actual de la sala derivado de su matchType (para resaltar la tarjeta activa
// en el lobby). 'battle' = Supervivencia; 'custom' = Custom.
function roomPlayMode(): PlayMode {
  return roomState.current?.matchType === 'battle' ? 'survival' : 'custom';
}

// El host puede cambiar la modalidad SIN salir de la sala: re-configura el
// matchType (y por ende las reglas) en el server. Reusa el mismo updateRoomSettings
// que la sincronización de reglas custom. 1v1 local no es online → sale de la sala
// y arranca el duelo local.
// Sale de la sala online y arranca el duelo local. Es la acción que confirma el
// usuario al elegir "Duelo local" desde dentro de una sala.
function leaveRoomAndStartLocalVersus(): void {
  uiSelectionState.playMode = 'local1v1';
  leaveOnlineRoom();
  startLocalVersusMode();
}

async function switchOnlineRoomMode(mode: PlayMode): Promise<void> {
  if (mode === 'local1v1') {
    // El duelo local no es una sala online: pasar a él te saca de la sala. Si hay
    // sala, pedimos confirmación antes (la acción confirma con leaveRoomAndStartLocalVersus).
    if (roomState.current) { requestRunConfirmation('leave-room-for-local'); return; }
    leaveRoomAndStartLocalVersus();
    return;
  }
  if (!roomState.current || !isOnlineHost() || roomState.current.status !== 'lobby') return;
  uiSelectionState.playMode = mode;
  if (mode === 'survival') ensureSurvivalTopsLoaded();
  const targetMatchType: OnlineMatchType = mode === 'survival' ? 'battle' : 'custom';
  if (roomState.current.matchType === targetMatchType) return; // ya está en ese modo
  if (roomState.current.bet && !['settled', 'cancelled', 'expired', 'refunded'].includes(roomState.current.bet.status)) {
    onlineNetState.error = 'No se puede cambiar de modo con una apuesta activa.';
    return;
  }
  if (onlineNetState.busy) return;
  const room = roomState.current;
  onlineNetState.busy = true;
  try {
    const rules = targetMatchType === 'battle' ? battleRulesFromSettings(inputSettings) : onlineCustomRulesFromSettings();
    const response = await onlineClient.updateRoomSettings({
      roomId: room.id,
      playerId: identityState.player.id,
      visibility: room.visibility,
      mode: 'custom',
      matchType: targetMatchType,
      ruleset: onlineRulesetPatch(),
      rules,
    });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    onlineNetState.error = null;
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    onlineNetState.busy = false;
  }
}

async function createOnlineRoom(
  visibility: RoomVisibility,
  matchType: OnlineMatchType = roomMatchTypeForSelectedMode(),
): Promise<void> {
  if (onlineNetState.busy) return;
  onlineNetState.busy = true;
  try {
    // Una persona solo puede tener una sala a la vez: si ya estaba en otra, la deja.
    await leaveCurrentRoomBeforeNew();
    identityState.player = saveOnlinePlayer({ ...identityState.player, name: identityState.name });
    // Supervivencia online = reglas fijas (BATTLE_RULES); todos compiten igual.
    const rules = matchType === 'battle' ? battleRulesFromSettings(inputSettings) : onlineCustomRulesFromSettings();
    const response = await onlineClient.createRoom({
      playerId: identityState.player.id,
      npub: lunaState.identity?.npub ?? null,
      lunaGameId: lunaState.identity?.gameId ?? null,
      name: identityState.player.name,
      avatarUrl: identityState.player.avatarUrl,
      visibility,
      mode: 'custom',
      matchType,
      ruleset: onlineRulesetPatch(),
      rules,
    });
    syncOnlineClock(response.serverNowMs);
    enterOnlineRoom(response.room, 'roomLobby');
    void syncLunaPresence();
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    onlineNetState.busy = false;
  }
}

// BOT DEV: lanza una partida multijugador completa contra el oponente simulado.
// Crea una sala privada REAL en el API local, une al bot como segundo cliente,
// activa el autoplay local (la partida corre sola de ambos lados) y arranca la
// ronda por el flujo normal del host. El bridge conecta los hooks del bot a los
// mismos handlers que usaría el peer broadcast WebRTC.
async function startDevBotMatch(): Promise<void> {
  if (!import.meta.env.DEV || devBotMatch) return;
  await createOnlineRoom('private');
  if (!roomState.current) return;
  const { DevBotOpponent } = await import('./dev/devBotOpponent');
  const bot = new DevBotOpponent({
    getRoom: () => roomState.current,
    getNowMs: onlineNowMs,
    botRules: () => onlineRulesFromRoom(roomState.current),
    deliverAttackIntent: (intent) => {
      // Mismo camino que onAttackIntent del peer broadcast: el host rutea.
      if (roomState.current && isOnlineHost()) commitOnlineAttack(intent);
    },
    deliverSnapshot: (playerId, game) => {
      // Mismo camino que el snapshot por peer: display local + relay del host
      // al servidor vía relayPeerProgressToServer (mantiene fresco al bot).
      rememberPeerDisplaySnapshot(playerId, game);
      applyPeerSnapshot(playerId, playerId, game);
    },
    commitKo: (report) => {
      void commitOnlineElimination(report);
    },
    deliverReplay: (report) => {
      // Mismo camino que onReplay del peer real: el bot no es un peer WebRTC, así
      // que entrega su log por acá para aparecer en la repetición multi-tablero.
      collectPeerReplay(report.playerId, { type: 'replay', ...report });
    },
  }, onlineClient);
  try {
    await bot.join(roomState.current.id);
  } catch (error) {
    bot.dispose();
    onlineNetState.error = onlineErrorText(error);
    return;
  }
  devBotMatch = bot;
  autoPlayState.accessGranted = true; // TRUCO AUTOPLAY: el jugador local también se automatiza
  autoPlayState.enabled = true;
  // startOnlineRoom exige ver a otro jugador en la sala (si no, arranca una run
  // solo): refrescamos la sala para que incluya al bot antes de arrancar.
  await pollOnlineRoom();
  await startOnlineRoom();
}

async function joinOnlineRoom(roomId: string): Promise<void> {
  const normalizedRoomId = normalizeRoomId(roomId);
  if (onlineNetState.busy || normalizedRoomId.length < ROOM_ID_MIN_LENGTH) {
    onlineNetState.error = `Enter a room ID with at least ${ROOM_ID_MIN_LENGTH} characters.`;
    return;
  }
  onlineNetState.busy = true;
  try {
    // Una persona solo puede tener una sala a la vez: si ya estaba en otra, la deja.
    await leaveCurrentRoomBeforeNew(normalizedRoomId);
    identityState.player = saveOnlinePlayer({ ...identityState.player, name: identityState.name });
    const response = await onlineClient.joinRoom({
      roomId: normalizedRoomId,
      playerId: identityState.player.id,
      npub: lunaState.identity?.npub ?? null,
      name: identityState.player.name,
      avatarUrl: identityState.player.avatarUrl,
    });
    syncOnlineClock(response.serverNowMs);
    enterOnlineRoom(response.room, 'roomLobby');
    void syncLunaPresence();
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    onlineNetState.busy = false;
  }
}

async function setOnlineReady(ready: boolean): Promise<void> {
  if (!roomState.current || onlineNetState.busy) return;
  onlineNetState.busy = true;
  try {
    const response = await onlineClient.setReady({ roomId: roomState.current.id, playerId: identityState.player.id, ready });
    syncOnlineClock(response.serverNowMs);
    enterOnlineRoom(response.room, 'roomLobby');
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    onlineNetState.busy = false;
  }
}

// Marca ready/no-ready en el servidor SIN tocar appMode ni el lock onlineNetState.busy: lo
// usa el visor de repeticiones para "frenar" la sala mientras alguien mira el replay
// (no listo) y volver a listo al salir, sin sacarlo del visor. Best-effort: si la
// sala todavía no está en lobby (status finished/countdown) el server lo rechaza y
// lo ignoramos; el poll de la repetición lo reintenta cuando la sala reabre.
async function setOnlineReadyQuiet(ready: boolean): Promise<void> {
  if (!roomState.current) return;
  try {
    const response = await onlineClient.setReady({ roomId: roomState.current.id, playerId: identityState.player.id, ready });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
  } catch {
    // La sala puede no estar en lobby todavía; el reintento vive en el poll.
  }
}

// Al abrir una repetición dentro de una sala online me marco NO listo, para que el
// host no arranque la próxima ronda mientras la estoy viendo. Fuera de una sala no
// hace nada (setOnlineReadyQuiet corta si no hay roomState.current).
function beginReplayReadyHold(): void {
  if (!roomState.current) return;
  multiReplayState.holdNotReady = true;
  void setOnlineReadyQuiet(false);
}

// Al salir de la repetición vuelvo a listo (solo si lo había puesto en no-listo).
function endReplayReadyHold(): void {
  if (!multiReplayState.holdNotReady) return;
  multiReplayState.holdNotReady = false;
  void setOnlineReadyQuiet(true);
}

async function startOnlineRoom(): Promise<void> {
  if (!roomState.current || onlineNetState.busy) return;
  if (!onlineRoomHasOtherPlayers()) {
    startNewRun();
    return;
  }
  onlineNetState.busy = true;
  try {
    const response = await onlineClient.startRoom({ roomId: roomState.current.id, playerId: identityState.player.id });
    syncOnlineClock(response.serverNowMs);
    enterOnlineRoom(response.room, 'onlineCountdown');
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    onlineNetState.busy = false;
  }
}

// ─────────────────────────── Top mundial (leaderboard) ───────────────────────────

function openLeaderboard(tab: 'wins' | 'survival' = 'wins'): void {
  leaderboardState.tab = tab;
  openModeMenu('leaderboard');
  // El Top está unificado: precargamos ambos rankings así cambiar de pestaña es
  // instantáneo (cada uno tiene su propio loading/error).
  void refreshLeaderboard();
  void refreshSurvivalTop();
}

// Hub "Jugar": las tarjetas de modalidad. Si la modalidad activa es Supervivencia
// precargamos los tops (se ven embebidos en su tarjeta).
function openPlayMenu(): void {
  openModeMenu('playMenu');
  if (uiSelectionState.playMode === 'survival') ensureSurvivalTopsLoaded();
}

// Carga los dos rankings (victorias + tiempo) que se muestran dentro de la tarjeta
// Supervivencia. Cada refresh ya se autoprotege contra llamadas concurrentes.
function ensureSurvivalTopsLoaded(): void {
  void refreshLeaderboard();
  void refreshSurvivalTop();
}

function parsePlayMode(value: string | undefined): PlayMode | null {
  return value === 'survival' || value === 'custom' || value === 'local1v1' ? value : null;
}

function setLeaderboardTab(tab: 'wins' | 'survival'): void {
  leaderboardState.tab = tab;
  if (tab === 'wins' && leaderboardState.entries.length === 0) void refreshLeaderboard();
  if (tab === 'survival' && leaderboardState.survivalEntries.length === 0) void refreshSurvivalTop();
}

// Actualiza solo el ranking de la pestaña visible (botón "Actualizar" del Top).
function refreshActiveLeaderboard(): Promise<void> {
  return leaderboardState.tab === 'survival' ? refreshSurvivalTop() : refreshLeaderboard();
}

async function refreshLeaderboard(): Promise<void> {
  if (leaderboardState.loading) return;
  leaderboardState.loading = true;
  leaderboardState.error = null;
  try {
    const response = await onlineClient.getLeaderboard(50);
    leaderboardState.entries = response.entries;
  } catch (error) {
    leaderboardState.error = onlineErrorText(error);
  } finally {
    leaderboardState.loading = false;
  }
}

// Suma una victoria multijugador del jugador al ranking mundial.
// Best-effort: el tablero global es secundario, nunca corta el juego local.
async function submitLeaderboardWin(): Promise<void> {
  try {
    await onlineClient.submitScore({
      playerId: identityState.player.id,
      name: identityState.name.trim() || identityState.player.name,
      avatarUrl: identityState.player.avatarUrl,
      npub: lunaState.identity?.npub ?? null,
    });
  } catch {
    // Silencioso: un fallo del ranking no debe afectar la partida.
  }
}

// ─────────────────────── Top de supervivencia (por tiempo) ───────────────────────

async function refreshSurvivalTop(): Promise<void> {
  if (leaderboardState.survivalLoading) return;
  leaderboardState.survivalLoading = true;
  leaderboardState.survivalError = null;
  try {
    const response = await onlineClient.getSurvivalLeaderboard(50);
    leaderboardState.survivalEntries = response.entries;
  } catch (error) {
    leaderboardState.survivalError = onlineErrorText(error);
  } finally {
    leaderboardState.survivalLoading = false;
  }
}

// Registra el tiempo de supervivencia del jugador en el top mundial y luego calcula
// en qué puesto quedó (para mostrarlo en la pantalla de resultados).
// Best-effort: el ranking es secundario, nunca corta el juego local.
async function submitSurvivalTime(durationMs: number): Promise<void> {
  // El top mundial solo admite jugadores con sesión de Luna Negra. Sin npub no tiene
  // sentido enviar el tiempo (el server lo descarta): mostramos un estado que invita a
  // iniciar sesión en vez de un "fuera del top" engañoso.
  const npub = lunaState.identity?.npub ?? null;
  if (!npub) {
    leaderboardState.survivalRunRank = { status: 'guest' };
    return;
  }
  leaderboardState.survivalRunRank = { status: 'loading' };
  try {
    await onlineClient.submitSurvival({
      playerId: identityState.player.id,
      name: identityState.name.trim() || identityState.player.name,
      avatarUrl: identityState.player.avatarUrl,
      npub,
      durationMs,
    });
    // Tras registrar (el server guarda el MÁXIMO por jugador), releemos el ranking
    // y buscamos mi posición. Pedimos un tope amplio para ubicarme aunque no esté
    // entre los primeros; si ni así aparezco, quedo "fuera del top".
    const response = await onlineClient.getSurvivalLeaderboard(200);
    leaderboardState.survivalEntries = response.entries;
    const index = response.entries.findIndex((entry) => entry.playerId === identityState.player.id);
    leaderboardState.survivalRunRank = index >= 0
      ? { status: 'ranked', rank: index + 1, total: response.entries.length }
      : { status: 'unranked' };
  } catch {
    // Silencioso: un fallo del ranking no debe afectar la partida.
    leaderboardState.survivalRunRank = { status: 'error' };
  }
}

// Cuando la sala termina conmigo coronado ganador, sumo una victoria al ranking
// mundial — una sola vez por ronda (la clave de ronda evita el doble conteo del
// polling). El TOP de victorias solo cuenta salas 'battle' (modalidad
// Supervivencia online, reglas fijas): así el ranking es justo. Las salas 'custom'
// (reglas configurables) son casuales y NO suman al top global.
function maybeSubmitOnlineWin(room: OnlineRoom): void {
  if (room.status !== 'finished' || room.winnerPlayerId !== identityState.player.id) return;
  const roundId = onlineRoundKey(room);
  if (roundState.winSubmittedRoundId === roundId) return;
  roundState.winSubmittedRoundId = roundId;
  // Sonido de victoria: el ganador online sobrevive (último en pie), así que su
  // motor local sigue en 'playing' y nunca pasa a 'finished' — la transición que
  // dispara juice.onWin() en solo. Lo gatillamos acá, donde la SALA me corona,
  // para que suene igual que ganar en solo (una sola vez por ronda). Esto suena en
  // toda victoria; lo que se gatea por modalidad es solo el registro en el ranking.
  juiceAudio.win();
  sound.play('finish');
  if (room.matchType === 'battle') void submitLeaderboardWin();
}

// Después de ver los resultados se vuelve al menú principal SIN salir de la
// sala. Si soy el host, además reabro la sala al lobby para poder crear otra
// apuesta y lanzar la próxima ronda desde el panel.
function closeOnlineResults(): void {
  goToMenu();
  if (isOnlineHost()) void reopenOnlineRoom();
}

async function reopenOnlineRoom(): Promise<void> {
  if (!roomState.current || !isOnlineHost() || roundState.roomReopenInFlight) return;
  if (roomState.current.status !== 'finished') return;
  // No reabrimos hasta que la apuesta y sus pagos terminen. `settled` puede incluir
  // un ganador invitado con retiro pendiente; borrar la apuesta haría desaparecer
  // su QR. El servidor repite esta validación para proteger contra otros clientes.
  if (roomState.current.bet && !['settled', 'cancelled', 'expired', 'refunded'].includes(roomState.current.bet.status)) return;
  if (roomState.current.bet && hasUnresolvedRoomBetPayout(roomState.current.bet)) return;
  roundState.roomReopenInFlight = true;
  try {
    const response = await onlineClient.reopenRoom({ roomId: roomState.current.id, playerId: identityState.player.id });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
  } catch {
    // Best-effort: el próximo poll lo reintenta (ver pollOnlineRoom).
  } finally {
    roundState.roomReopenInFlight = false;
  }
}

async function restartOnlineRoom(): Promise<void> {
  if (!roomState.current || onlineNetState.busy) return;
  onlineNetState.busy = true;
  try {
    const response = await onlineClient.restartRoom({ roomId: roomState.current.id, playerId: identityState.player.id });
    syncOnlineClock(response.serverNowMs);
    enterOnlineRoom(response.room, 'onlineCountdown');
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    onlineNetState.busy = false;
  }
}

async function createOnlineBet(): Promise<void> {
  if (!roomState.current || betState.busy) return;
  const stakeSats = Number(readOnlineStakeInput());
  if (!Number.isInteger(stakeSats) || stakeSats <= 0) {
    onlineNetState.error = 'Ingresá un monto de apuesta válido (sats).';
    return;
  }
  betState.busy = true;
  betState.creating = true;
  try {
    const response = await onlineClient.createBet({ roomId: roomState.current.id, playerId: identityState.player.id, stakeSats });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    armOnlineBetFastPolling();
    onlineNetState.error = null;
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    betState.busy = false;
    betState.creating = false;
  }
}

function readOnlineStakeInput(): string {
  const field = overlayElement.querySelector<HTMLInputElement>('[data-online-field="bet-stake"]');
  const value = (field?.value ?? betState.stakeInput).replace(/[^0-9]/g, '').slice(0, 7);
  betState.stakeInput = value;
  if (field && field.value !== value) field.value = value;
  return value;
}

async function cancelOnlineBet(): Promise<void> {
  if (!roomState.current || betState.busy) return;
  betState.busy = true;
  try {
    const response = await onlineClient.cancelBet({ roomId: roomState.current.id, playerId: identityState.player.id });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    onlineNetState.error = null;
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    betState.busy = false;
  }
}

async function retryOnlineBetInvoiceGeneration(): Promise<void> {
  if (!roomState.current || betState.busy) return;
  betState.busy = true;
  try {
    const response = await onlineClient.retryBet({ roomId: roomState.current.id, playerId: identityState.player.id });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    armOnlineBetFastPolling();
    onlineNetState.error = null;
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    betState.busy = false;
  }
}

async function settleOnlineBet(): Promise<void> {
  if (!roomState.current || betState.busy) return;
  betState.busy = true;
  try {
    const response = await onlineClient.settleBet({ roomId: roomState.current.id, playerId: identityState.player.id });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    onlineNetState.error = null;
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    betState.busy = false;
  }
}

async function refreshOnlineBet(
  silent: boolean,
  options: { queueIfBusy?: boolean } = {},
): Promise<void> {
  if (!roomState.current?.bet) return;
  if (betState.busy) {
    if (options.queueIfBusy) betState.refreshQueued = true;
    return;
  }
  const requestedRoomId = roomState.current.id;
  betState.busy = true;
  betState.lastPollAt = performance.now();
  try {
    const result = await requestOnlineBetRefresh(roomState.current.id, identityState.player.id);
    syncOnlineClock(result.payload.serverNowMs);
    adoptOnlineRoom(result.payload.room, 'bet-refresh');
    if (!silent) onlineNetState.error = null;
  } catch (error) {
    recordBetWithdrawalTrace(
      'bet-refresh-error',
      roomState.current,
      error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    );
    if (!silent) onlineNetState.error = onlineErrorText(error);
  } finally {
    betState.busy = false;
    const shouldRefreshAgain = betState.refreshQueued;
    betState.refreshQueued = false;
    if (shouldRefreshAgain && roomState.current?.id === requestedRoomId && isRefreshableRoomBet(roomState.current.bet)) {
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

// Proveedor WebLN inyectado por extensiones como Alby (alby-extension). Permite
// pagar un invoice Lightning con un click, sin escanear el QR ni salir del juego.
interface WebLNProvider {
  enable(): Promise<void>;
  sendPayment(bolt11: string): Promise<{ preimage: string }>;
  // LNURL-withdraw (cobro del ganador invitado). Alby lo implementa como webln.lnurl().
  lnurl?(lnurl: string): Promise<unknown>;
}

function getWebLNProvider(): WebLNProvider | null {
  const provider = (window as unknown as { webln?: WebLNProvider }).webln;
  return provider && typeof provider.sendPayment === 'function' ? provider : null;
}

// Paga el depósito de la apuesta con la extensión WebLN (Alby u otra). El éxito
// se confirma por el polling normal del estado de la apuesta (depositStatus →
// paid); acá solo disparamos el pago y aceleramos la detección.
async function payOnlineBetWithExtension(bolt11: string): Promise<void> {
  if (!bolt11 || betState.paying) return;
  const provider = getWebLNProvider();
  if (!provider) {
    onlineNetState.error = 'No se detectó una extensión Lightning (instalá Alby) o habilitá WebLN.';
    return;
  }
  betState.paying = true;
  try {
    await provider.enable();
    await provider.sendPayment(bolt11);
    onlineNetState.error = null;
    wakeUpBetDetection();
  } catch (error) {
    // El usuario pudo cancelar el popup de la extensión, o el pago falló.
    onlineNetState.error = error instanceof Error && error.message
      ? `No se pudo pagar con la extensión: ${error.message}`
      : 'No se pudo pagar con la extensión.';
  } finally {
    betState.paying = false;
  }
}

// Cobra el pozo del ganador invitado con la extensión WebLN (LNURL-withdraw). El
// éxito se confirma por el polling normal (payoutStatus → claimed); acá solo
// disparamos el retiro y aceleramos la detección.
async function claimOnlineBetWithExtension(lnurl: string): Promise<void> {
  if (!lnurl || betState.paying) return;
  const provider = getWebLNProvider();
  if (!provider || typeof provider.lnurl !== 'function') {
    onlineNetState.error = 'No se detectó una extensión Lightning (instalá Alby) o no soporta LNURL-withdraw.';
    return;
  }
  betState.paying = true;
  try {
    await provider.enable();
    await provider.lnurl(lnurl);
    onlineNetState.error = null;
    wakeUpBetDetection();
  } catch (error) {
    onlineNetState.error = error instanceof Error && error.message
      ? `No se pudo cobrar con la extensión: ${error.message}`
      : 'No se pudo cobrar con la extensión.';
  } finally {
    betState.paying = false;
  }
}

// Abre el handler `lightning:` del sistema. En Android/iOS permite elegir una
// wallet instalada compatible con LNURL-withdraw (por ejemplo Wallet of Satoshi)
// sin necesitar extensión WebLN ni otro dispositivo para escanear el QR.
function openLightningWallet(lightningPayload: string): void {
  const normalized = lightningPayload.trim();
  if (!normalized) return;
  recordBetWithdrawalTrace('withdraw-render', roomState.current, 'open-mobile-wallet');
  window.location.href = `lightning:${normalized.toUpperCase()}`;
}

// Link de invitación universal: cualquiera que lo abra cae en ?join=<sala> y
// bootstrapJoinLink lo mete directo a la sala (sirve para públicas y privadas,
// mientras estén en lobby). Limpiamos query/hash para no arrastrar tokens previos.
function buildRoomInviteLink(roomId: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('join', roomId);
  return url.toString();
}

function roomInviteLinkRecentlyCopied(): boolean {
  return Date.now() - lunaState.roomInviteLinkCopiedAt < 2200;
}

// Copia el link de invitación de la sala activa al portapapeles. Sin diálogo de
// "compartir" del sistema: copia directo y muestra el feedback en el botón.
function shareRoomInviteLink(): void {
  if (!roomState.current) return;
  lunaState.roomInviteLinkCopiedAt = Date.now();
  void copyToClipboard(buildRoomInviteLink(roomState.current.id));
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
  if (!roomState.current || onlineNetState.busy) return;
  const targetingMode = parseTargetingMode(mode);
  if (!targetingMode) return;
  onlineNetState.busy = true;
  try {
    const response = await onlineClient.setTargeting({
      roomId: roomState.current.id,
      playerId: identityState.player.id,
      targetingMode,
      manualTargetPlayerId,
    });
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
    syncOnlinePeers(response.room);
    onlineNetState.error = null;
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    onlineNetState.busy = false;
  }
}

function leaveOnlineRoom(): void {
  // Avisamos al servidor para que migre el host (si yo era el host, se lo pasa al
  // siguiente que queda) o elimine la sala si queda vacía. No esperamos la
  // respuesta: la salida local es inmediata.
  const room = roomState.current;
  if (room) {
    void onlineClient.leaveRoom({ roomId: room.id, playerId: identityState.player.id }).catch(() => {});
  }
  resetOnlineRoomState();
  goToMenu();
  void syncLunaPresence();
}

// Sale de la sala actual (si hay) antes de crear/unirse a otra, para que una
// persona nunca tenga dos salas a la vez. Espera el leave del servidor.
async function leaveCurrentRoomBeforeNew(targetRoomId?: string): Promise<void> {
  const room = roomState.current;
  if (!room || room.id === targetRoomId) return;
  try {
    await onlineClient.leaveRoom({ roomId: room.id, playerId: identityState.player.id });
  } catch {
    // Si el leave falla seguimos: la sala vieja expira por TTL.
  }
  resetOnlineRoomState();
}

function resetOnlineRoomState(): void {
  if (import.meta.env.DEV) { // BOT DEV: salir de la sala mata al bot (antes de perder roomState.current)
    devBotMatch?.dispose();
    devBotMatch = null;
  }
  clearOnlineRoomSession();
  restoreLocalMusicPlaylist();
  peerState.broadcaster?.close();
  peerState.broadcaster = null;
  peerState.states = new Map();
  peerState.displaySnapshots = new Map();
  resetSpectatorFocus();
  roomState.current = null;
  onlineNetState.error = null;
  betState.stakeInput = String(DEFAULT_ONLINE_BET_STAKE_SATS);
  betState.busy = false;
  betState.paying = false;
  betState.lastPollAt = 0;
  betState.fastPollUntil = 0;
  betState.refreshQueued = false;
  betState.celebratedBetId = null;
  roundState.resultSubmitted = false;
  roundState.runStarted = false;
  roundState.spectatorRound = false;
  attackState.sequence = 0;
  attackState.appliedIds = new Set();
  hostAuthorityState.simulator = null;
  hostAuthorityState.migrated = false;
  hostAuthorityState.progressInFlight = new Set();
  hostAuthorityState.lastProgressAt = new Map();
  hostAuthorityState.committedEliminations = new Set();
  hostAuthorityState.committedResults = new Set();
  hostAuthorityState.lastAuthoritativeFrame = 0;
  peerState.displaySnapshots = new Map();
  resetSpectatorFocus();
  attackState.inputOutbox = [];
  onlineNetState.lastPollAt = 0;
  onlineNetState.lastProgressAt = 0;
  onlineNetState.lastSelfReportAt = 0;
  onlineFailoverState.hostChannelDownSince = 0;
  onlineNetState.lastPeerBroadcastAt = 0;
  onlineNetState.lastKoBroadcastAt = 0;
  roundState.activeRoundId = null;
  lunaState.pendingLaunchRequest = null;
}

function enterOnlineRoom(room: OnlineRoom, preferredMode: AppMode): void {
  adoptOnlineRoom(room);
  syncOnlinePeers(room);
  onlineNetState.error = null;
  onlineNetState.lastPollAt = 0;
  if (room.status === 'finished') appMode = 'onlineResults';
  else if (room.status === 'playing') appMode = roundState.runStarted ? 'onlinePlaying' : 'onlineCountdown';
  else if (room.status === 'countdown') appMode = 'onlineCountdown';
  else appMode = preferredMode;
}

function preserveVisiblePendingWithdrawal(previousRoom: OnlineRoom | null, incomingRoom: OnlineRoom): OnlineRoom {
  const previousBet = previousRoom?.bet;
  const previousEntry = roomBetEntryForLocalPlayer(previousRoom);
  if (
    !previousRoom
    || previousRoom.id !== incomingRoom.id
    || !previousBet
    || previousEntry?.payoutStatus !== 'withdraw_pending'
    || !previousEntry.withdrawLnurl
  ) return incomingRoom;

  const incomingBet = incomingRoom.bet;
  const incomingEntry = roomBetEntryForLocalPlayer(incomingRoom);
  if (
    incomingBet?.betId === previousBet.betId
    && incomingEntry
    && (
      incomingEntry.payoutStatus === 'claimed'
      || incomingEntry.payoutStatus === 'paid'
      || incomingEntry.payoutStatus === 'forfeited'
    )
  ) {
    recordBetWithdrawalTrace('withdraw-resolved', incomingRoom, incomingEntry.payoutStatus);
    return incomingRoom;
  }

  if (incomingBet?.betId === previousBet.betId) {
    const participants = incomingBet.participants.map((entry) => (
      entry.playerId === previousEntry.playerId || entry.npub === previousEntry.npub
        ? {
            ...entry,
            payoutSats: entry.payoutSats ?? previousEntry.payoutSats,
            payoutStatus: 'withdraw_pending' as const,
            withdrawLnurl: entry.withdrawLnurl || previousEntry.withdrawLnurl,
            withdrawUrl: entry.withdrawUrl || previousEntry.withdrawUrl,
          }
        : entry
    ));
    if (incomingEntry?.payoutStatus !== 'withdraw_pending' || !incomingEntry.withdrawLnurl) {
      recordBetWithdrawalTrace('withdraw-regression', incomingRoom, 'same-bet-withdraw-state-regressed');
    }
    return { ...incomingRoom, bet: { ...incomingBet, participants } };
  }

  // Defensa ante un backend/cliente viejo que reabre la sala y borra `room.bet`
  // mientras el QR ya estaba visible. Conservamos resultados + apuesta localmente:
  // perder sincronía de la próxima ronda es preferible a perder un cobro real.
  recordBetWithdrawalTrace('withdraw-regression', incomingRoom, incomingBet ? 'bet-id-changed' : 'bet-removed');
  return {
    ...previousRoom,
    // Avanzamos solo el sello monotónico para no aceptar después una respuesta
    // realmente vieja; el estado de ronda/apuesta permanece congelado con el QR.
    updatedAtServerMs: Math.max(previousRoom.updatedAtServerMs, incomingRoom.updatedAtServerMs),
  };
}

function adoptOnlineRoom(room: OnlineRoom, source: 'room-action' | 'room-poll' | 'bet-refresh' = 'room-action'): void {
  const previousRoom = roomState.current;
  const previousRoundId = roundState.activeRoundId;
  const previousEntry = roomBetEntryForLocalPlayer(previousRoom);
  const incomingEntry = roomBetEntryForLocalPlayer(room);
  const resolvesPendingWithdrawal = previousRoom?.bet?.betId === room.bet?.betId
    && previousEntry?.payoutStatus === 'withdraw_pending'
    && !!previousEntry.withdrawLnurl
    && (
      incomingEntry?.payoutStatus === 'claimed'
      || incomingEntry?.payoutStatus === 'paid'
      || incomingEntry?.payoutStatus === 'forfeited'
    );
  if (previousRoom && room.updatedAtServerMs < previousRoom.updatedAtServerMs && !resolvesPendingWithdrawal) {
    recordBetWithdrawalTrace(source, room, 'ignored-older-room');
    return;
  }
  const protectedRoom = preserveVisiblePendingWithdrawal(previousRoom, room);
  recordBetWithdrawalTrace(source, protectedRoom);
  const nextRoundId = onlineRoundKey(protectedRoom);
  const roundChanged = previousRoundId !== null && nextRoundId !== null && previousRoundId !== nextRoundId;
  const roomRestarted = previousRoom?.status === 'finished' && protectedRoom.status === 'countdown';
  roomState.current = protectedRoom;
  saveOnlineRoomSession(protectedRoom);
  if (protectedRoom.bet?.status !== 'pending_deposits') betState.fastPollUntil = 0;
  roundState.activeRoundId = nextRoundId;
  if (roundChanged || roomRestarted) resetOnlineRuntimeForNextRound();
  maybeSubmitOnlineWin(protectedRoom);
  maybeCelebratePayout();
}

// Festejo de "cobraste el pozo": solo cuando el pago realmente terminó. Un
// `withdraw_pending` ya tiene monto asignado, pero todavía necesita que el ganador
// abra su wallet y reclame; festejar antes bloquea justamente esos controles.
function maybeCelebratePayout(): void {
  const bet = roomState.current?.bet;
  if (!bet || bet.status !== 'settled') return;
  if (betState.celebratedBetId === bet.betId) return;
  const myEntry = myBetEntry(bet);
  const myPayout = myEntry?.payoutSats ?? 0;
  if (myPayout <= 0 || (myEntry?.payoutStatus !== 'paid' && myEntry?.payoutStatus !== 'claimed')) return;
  betState.celebratedBetId = bet.betId;
  celebratePayout({ sats: myPayout });
}

function onlineRoundKey(room: OnlineRoom): string {
  return `seed:${room.seed}`;
}

function resetOnlineRuntimeForNextRound(): void {
  roundState.runStarted = false;
  roundState.spectatorRound = false;
  roundState.resultSubmitted = false;
  attackState.sequence = 0;
  attackState.appliedIds = new Set();
  hostAuthorityState.simulator = null;
  hostAuthorityState.migrated = false;
  hostAuthorityState.progressInFlight = new Set();
  hostAuthorityState.lastProgressAt = new Map();
  hostAuthorityState.committedEliminations = new Set();
  hostAuthorityState.committedResults = new Set();
  hostAuthorityState.lastAuthoritativeFrame = 0;
  peerState.displaySnapshots = new Map();
  resetSpectatorFocus();
  attackState.inputOutbox = [];
  onlineNetState.lastProgressAt = 0;
  onlineNetState.lastSelfReportAt = 0;
  onlineFailoverState.hostChannelDownSince = 0;
  onlineNetState.lastPeerBroadcastAt = 0;
  onlineNetState.lastKoBroadcastAt = 0;
  input.releaseAll();
  runState.lastCountdownSecondPlayed = -1;
  if (roomState.current?.status === 'countdown' || roomState.current?.status === 'playing') appMode = 'onlineCountdown';
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
    replayState.importError = 'Replay file could not be read.';
    appMode = 'menu';
  }
}

function importReplayText(raw: string, fileName = 'Imported replay.json'): boolean {
  const result = importReplayJson(raw);
  if (!result.ok) {
    replayState.importError = result.error;
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
  replayState.importError = null;
  replayState.returnMode = null; // replay importado/historial: al salir vuelvo al menú
  replayState.importedName = fileName;
  replayState.playback = new ReplayPlayback(importedReplay);
  resetReplayClock();
  appMode = 'replayPlayback';
  settingsReturnMode = 'menu';
}

// Frame final de la partida actual (gameover o clear). Sirve para recortar la
// reproducción de "los últimos N segundos".
function terminalRunFrame(state: GameState): number {
  return state.stats.gameOverFrame ?? state.stats.finishFrame ?? state.stats.frame;
}

// La repetición de los últimos segundos necesita inputs grabados; en custom las
// repeticiones están deshabilitadas, así que no ofrecemos el botón.
function canReplayLastSeconds(state: GameState): boolean {
  return runState.currentRunKind !== 'custom' && replay.inputs.length > 0 && terminalRunFrame(state) > 0;
}

// Reproduce solo los últimos DEATH_REPLAY_SECONDS de la partida recién terminada,
// reutilizando el motor de repetición (arranca el dibujo en startFrame). Al salir
// se vuelve a la pantalla de resultados, no al menú.
function startDeathReplay(): void {
  const state = engine.getState();
  if (!canReplayLastSeconds(state)) return;
  const endFrame = terminalRunFrame(state);
  const startFrame = Math.max(0, endFrame - DEATH_REPLAY_SECONDS * 60);
  const exported = createExportedReplay(replay, state, inputSettings, undefined, currentRunSummary(state));
  input.releaseAll();
  bindingCapture = null;
  pendingConfirmAction = null;
  replayState.importError = null;
  replayState.importedName = `Últimos ${DEATH_REPLAY_SECONDS} segundos`;
  replayState.playback = new ReplayPlayback(exported, { startFrame });
  resetReplayClock();
  replayState.returnMode = appMode; // vuelvo a la pantalla de resultados de esta partida
  appMode = 'replayPlayback';
  settingsReturnMode = 'menu';
  beginReplayReadyHold();
}

// Salida de la reproducción. Si vino de "ver últimos 5s" vuelve a los resultados de
// la partida (el motor principal sigue intacto en gameover); si no, va al menú.
function exitReplayPlayback(): void {
  endReplayReadyHold();
  if (replayState.returnMode === null) {
    goToMenu();
    return;
  }
  const returnMode = replayState.returnMode;
  replayState.returnMode = null;
  replayState.playback = null;
  replayState.importedName = null;
  input.releaseAll();
  appMode = returnMode;
}

function toGameInputs(inputs: ControlInput[], frame: number): GameInput[] {
  return inputs
    .filter((event): event is ControlInput & { action: InputAction } => isGameAction(event.action) && event.action !== 'retry')
    .map((event) => ({ frame, action: event.action }));
}

function syncRunEffects(state: GameState, events: GameEvent[]): void {
  runState.splitTracker.record(state);
  if (state.stats.combo > runState.maxCombo) runState.maxCombo = state.stats.combo;
  const progressCue = soundCueForRunProgress(state, events, runState.lastLines, runState.lastPieces);
  if (progressCue) sound.play(progressCue);
  if (state.status !== lastStatus) {
    if (state.status === 'finished') sound.play('finish');
    if (state.status === 'gameover') sound.play('gameOver');
  }
  runState.lastPieces = state.stats.pieces;
  runState.lastLines = state.stats.lines;
  lastStatus = state.status;
  if ((state.status === 'finished' || state.status === 'gameover') && !runState.savedRunHistoryEntry) {
    const entry = createRunHistoryEntry(createExportedReplay(replay, state, inputSettings, undefined, currentRunSummary(state)));
    if (entry) runHistory = saveRunHistoryEntry(entry);
    runState.savedRunHistoryEntry = true;
  }
  // Modo Supervivencia: al perder, mandamos cuánto duró la partida al top mundial
  // (una sola vez por partida). El endless solo termina en 'gameover' (no hay meta).
  if (runState.currentRunKind === 'survival' && state.status === 'gameover' && !leaderboardState.submittedSurvivalRun) {
    leaderboardState.submittedSurvivalRun = true;
    const durationMs = Math.round(terminalRunFrame(state) * GAME_FRAME_MS);
    if (durationMs > 0) void submitSurvivalTime(durationMs);
  }
}

function syncOnlineBattleEvents(events: GameEvent[], state: GameState): void {
  if (appMode !== 'onlinePlaying' || !roomState.current) return;
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
  if (!roomState.current) return;
  attackState.sequence += 1;
  const attack = {
    attackId: `${identityState.player.id}-${runState.gameFrame}-${attackState.sequence}`,
    fromPlayerId: identityState.player.id,
    lines: event.outgoingLines,
    holeSeed: (roomState.current.seed + runState.gameFrame + attackState.sequence * 97) >>> 0,
    frame: displayedElapsedFrames(state.stats),
  };
  // Autoridad descentralizada: cada jugador rutea su PROPIO ataque (elige objetivo
  // con el targeting de la sala, lo manda al peer víctima y lo registra en el
  // servidor firmándolo como propio). Antes solo el host podía y su caída cortaba
  // el flujo de ataques de todos.
  commitOnlineAttack(attack);
  // Efecto visual: el proyectil vuela hacia el tablero del rival objetivo. El host
  // ya conoce el objetivo; el invitado lo predice localmente con su mismo modo de
  // targeting (el host puede decidir distinto, pero para el FX la predicción basta).
  flyOnlineAttackProjectile(attack.attackId, attack.lines);
}

// Lanza el proyectil de ataque de la capa juice hacia el tablero rival objetivo.
// Si no hay coordenadas (sin DOM del rival aún), cae al retroceso en tu borde.
function flyOnlineAttackProjectile(attackId: string, lines: number): void {
  const target = selectAttackTarget(identityState.player.id, attackId);
  const point = target ? onlinePeerBoardScreenPoint(target.id) : null;
  if (point) juice.onAttackToward(point, lines);
  else juice.onAttackOutgoing(lines);
}

// Centro en píxeles de viewport del mini-tablero de un rival. El canvas de Pixi
// cubre toda la ventana sin escala, así que estas coords coinciden con el espacio
// del stage que usa JuiceFX para dibujar el proyectil.
function onlinePeerBoardScreenPoint(playerId: string): { x: number; y: number } | null {
  const section = Array.from(document.querySelectorAll<HTMLElement>('.online-peer-board[data-player-id]'))
    .find((node) => node.dataset.playerId === playerId);
  if (!section) return null;
  const board = section.querySelector<HTMLElement>('.online-mini-board') ?? section;
  const rect = board.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function commitOnlineAttack(request: {
  attackId: string;
  fromPlayerId: string;
  lines: number;
  holeSeed: number;
  frame: number;
}): void {
  // Solo ruteo ataques que yo origino (o, si soy host, también los que me llegan
  // como intención de un peer por compatibilidad). authorityPlayerId queda como yo.
  if (!roomState.current) return;
  if (!isOnlineHost() && request.fromPlayerId !== identityState.player.id) return;
  const target = selectAttackTarget(request.fromPlayerId, request.attackId);
  if (!target) return;
  const attack: AttackRequest = {
    roomId: roomState.current.id,
    authorityPlayerId: identityState.player.id,
    attackId: request.attackId,
    fromPlayerId: request.fromPlayerId,
    toPlayerId: target.id,
    seed: roomState.current.seed,
    lines: request.lines,
    holeSeed: request.holeSeed,
    frame: request.frame,
  };
  applyAttackToHostTruth(attack);
  peerState.broadcaster?.sendAttack(target.id, {
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
      onlineNetState.error = onlineErrorText(error);
    });
}

function applyAttackToHostTruth(attack: AttackRequest): void {
  rememberOnlineAttack(attack.fromPlayerId, attack.toPlayerId, attack.lines);
  if (attack.toPlayerId === identityState.player.id) {
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
  hostAuthorityState.simulator?.queueGarbage(attack.toPlayerId, attack.lines, attack.holeSeed, attack.attackId, attack.frame);
}

function selectAttackTarget(sourcePlayerId: string, attackId: string): OnlinePlayer | null {
  if (!roomState.current) return null;
  const source = roomState.current.players.find((player) => player.id === sourcePlayerId);
  return selectTargetForAttack({
    players: roomState.current.players,
    sourcePlayerId,
    attackId,
    mode: source?.targetingMode ?? roomState.current.ruleset.targeting,
    manualTargetPlayerId: source?.manualTargetPlayerId ?? null,
    recentAttackers: source?.recentAttackers ?? [],
  });
}

function advanceHostAuthority(targetFrame: number): void {
  if (!roomState.current || !isOnlineHost() || !hostAuthorityState.simulator) return;
  syncHostAuthorityPlayers();
  const updates = hostAuthorityState.simulator.advanceAll(targetFrame);
  for (const update of updates) processHostSimulationUpdate(update);
}

function syncHostAuthorityPlayers(): void {
  if (!roomState.current || !isOnlineHost() || !hostAuthorityState.simulator) return;
  hostAuthorityState.simulator.ensurePlayers(
    roomState.current.players
      .map((player) => player.id)
      .filter((playerId) => playerId !== identityState.player.id),
  );
}

function processHostSimulationUpdate(update: HostSimulatedPlayer): void {
  if (!roomState.current || !isOnlineHost()) return;
  const snapshot = createOnlineGameSnapshotFromState(
    update.state,
    update.snapshot,
    update.lastProcessedInputSequence,
  );
  applyPeerSnapshot(identityState.player.id, update.playerId, snapshot);
  postHostSimulatedProgress(update.playerId, update.state);
  const nowMs = performance.now();
  if (update.state.status === 'playing' && nowMs - (hostAuthorityState.lastSimLogAt.get(update.playerId) ?? 0) >= 2000) {
    hostAuthorityState.lastSimLogAt.set(update.playerId, nowMs);
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
      attackState.sequence += 1;
      commitOnlineAttack({
        attackId: `${update.playerId}-${event.frame}-${attackState.sequence}`,
        fromPlayerId: update.playerId,
        lines: event.outgoingLines,
        holeSeed: ((roomState.current?.seed ?? 0) + event.frame + attackState.sequence * 97) >>> 0,
        frame: event.frame,
      });
    }
  }
  if (update.state.status === 'gameover' && !hostAuthorityState.committedEliminations.has(update.playerId)) {
    logMp('host-eliminate', {
      target: update.playerId.slice(0, 6),
      reason: update.state.stats.gameOverReason,
      gameOverFrame: update.state.stats.gameOverFrame,
      simFrame: update.state.stats.frame,
      hostFrame: runState.gameFrame,
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
  if (update.state.status === 'finished' && !hostAuthorityState.committedResults.has(update.playerId)) {
    void commitOnlineResult(update.playerId, update.state, 'won', snapshot);
  }
}

function syncOnline(): void {
  if (!roomState.current) return;
  const now = performance.now();
  // Suaviza el reloj del server cada frame (el frame del motor se ancla a él en online).
  slewOnlineClock();
  if (shouldPollOnline(now)) { if (perfFrame) perfFrame.polled = true; pollOnlineRoom(); }
  if (appMode === 'onlineCountdown') {
    // Mismo sonido de cuenta regresiva que el solo, dirigido por el reloj del
    // servidor (compartido por todos los jugadores de la sala).
    if (roomState.current.startsAtServerMs) {
      playCountdownAudio(Math.max(0, roomState.current.startsAtServerMs - onlineNowMs()));
    }
    maybeStartOnlineRun();
  }
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
  const roomStillRunning = roomState.current.status === 'playing' || roomState.current.status === 'countdown';
  const hostStillAuthority = isOnlineHost() && roundState.runStarted && appMode === 'onlineResults' && roomStillRunning;
  // Un espectador de la ronda (no estaba listo al arrancar) no tiene tablero
  // propio: no simula, no reporta ni difunde nada. Solo mira a los rivales con los
  // snapshots que llegan por WebRTC. El host nunca es espectador (debe estar listo
  // para arrancar), así que la autoridad/relay no se ve afectada.
  if ((appMode === 'onlinePlaying' || hostStillAuthority) && !roundState.spectatorRound) {
    if (appMode === 'onlinePlaying' && now - onlineNetState.lastDiagLogAt >= 2000) {
      onlineNetState.lastDiagLogAt = now;
      const serverFrame = roomState.current.startsAtServerMs
        ? Math.floor((onlineNowMs() - roomState.current.startsAtServerMs) / GAME_FRAME_MS)
        : null;
      logMp('heartbeat', {
        status: liveState.status,
        localFrame: runState.gameFrame,
        serverFrame,
        frameSkew: serverFrame === null ? null : serverFrame - runState.gameFrame,
        pieces: liveState.stats.pieces,
        lines: liveState.stats.lines,
        board: boardMetrics(liveState.board),
        pendingGarbage: liveState.stats.pendingGarbage,
        outbox: attackState.inputOutbox.length,
        lastAuthFrame: hostAuthorityState.lastAuthoritativeFrame,
      });
    }
    if (isOnlineHost()) advanceHostAuthority(onlineAuthorityTargetFrame(liveState));
    else { flushOnlineInputOutbox(); maybePostSelfProgressFallback(now, liveState); maybeRequestHostFailover(now, liveState); }
    applyRoomAttacks(roomState.current);
    if (shouldBroadcastPeerSnapshot(now)) broadcastOnlineSnapshot(liveState);
    if (isOnlineHost()) relayPeerProgressToServer();
    // El host postea progreso mientras la sala siga en ronda AUNQUE su propia
    // partida haya terminado: es el único escritor del servidor, y si los canales
    // peer no traen snapshots para relayar (WebRTC caído), la sala quedaría
    // HOST_STALE_MS sin escrituras y applyHostFailover cortaría la ronda con
    // jugadores todavía vivos. El servidor trata el progreso de un jugador
    // terminal como keepalive (no toca sus stats).
    if (isOnlineHost() && roomStillRunning && shouldPostOnlineProgress(now)) postOnlineProgress(liveState);
    if (liveState.status === 'finished' && !roundState.resultSubmitted) postOnlineResult(liveState);
    if (liveState.status === 'gameover') postOnlineElimination(liveState);
  }
  // FUERA del bloque anterior: un cliente NO-host que muere y pasa a 'onlineResults'
  // deja de entrar ahí, pero su partida ya terminó y todavía sigue conectado como
  // espectador. Difundimos su replay igual (idempotente por flag) para que el host
  // y el resto lo reciban; si no, solo se vería el tablero del host.
  if (!roundState.spectatorRound) maybeBroadcastOwnReplay(liveState);
}

// Mientras el host juega, la simulación autoritativa avanza con su runState.gameFrame.
// Cuando su partida termina, runState.gameFrame se congela (canAdvanceGame es false),
// así que derivamos el frame objetivo del reloj sincronizado con el servidor
// para que las partidas remotas sigan corriendo hasta que la sala termine.
function onlineAuthorityTargetFrame(state: GameState): number {
  if (state.status === 'playing' || !roomState.current?.startsAtServerMs) return runState.gameFrame;
  const elapsedFrames = Math.floor((onlineNowMs() - roomState.current.startsAtServerMs) / GAME_FRAME_MS);
  return Math.max(runState.gameFrame, elapsedFrames);
}

function shouldPollOnline(now: number): boolean {
  if (onlineNetState.pollInFlight) return false;
  if (!['menu', 'playMenu', 'soloMenu', 'multiplayerMenu', 'historyMenu', 'configMenu', 'custom', 'leaderboard', 'survivalTop', 'roomLobby', 'onlineCountdown', 'onlinePlaying', 'onlineResults', 'onlineReplay', 'replayPlayback'].includes(appMode)) return false;
  return now - onlineNetState.lastPollAt >= ONLINE_POLL_MS;
}

function shouldPostOnlineProgress(now: number): boolean {
  if (onlineNetState.progressInFlight) return false;
  return now - onlineNetState.lastProgressAt >= ONLINE_POLL_MS;
}

function shouldBroadcastPeerSnapshot(now: number): boolean {
  if (!peerState.broadcaster) return false;
  return now - onlineNetState.lastPeerBroadcastAt >= ONLINE_PEER_BROADCAST_MS;
}

async function pollOnlineRoom(): Promise<void> {
  if (!roomState.current) return;
  onlineNetState.pollInFlight = true;
  onlineNetState.lastPollAt = performance.now();
  try {
    const response = await onlineClient.getRoomState(roomState.current.id, identityState.player.id);
    syncOnlineClock(response.serverNowMs);
    // Si ya no estoy entre los jugadores y la sala sigue en lobby, me expulsaron.
    if (
      (appMode === 'roomLobby' || appMode === 'onlineCountdown')
      && response.room.status === 'lobby'
      && !response.room.players.some((player) => player.id === identityState.player.id)
    ) {
      resetOnlineRoomState();
      goToMenu();
      onlineNetState.error = 'Te sacaron de la sala.';
      void syncLunaPresence();
      return;
    }
    // Procesamiento sincrónico de la respuesta del poll: corre fuera del loop()/rAF (post-await),
    // así que el cronómetro por-frame no lo ve. Lo medimos aparte para atribuir el jank del cliente.
    const pollProcessStart = performance.now();
    adoptOnlineRoom(response.room, 'room-poll');
    syncOnlinePeers(response.room);
    applyRoomAttacks(response.room);
    recordTask('poll:process', performance.now() - pollProcessStart);
    // Estoy mirando una repetición y la sala reabrió al lobby readyeando a todos:
    // re-afirmo el NO listo para que el host no arranque sin mí mientras la veo.
    if (multiReplayState.holdNotReady && response.room.status === 'lobby'
      && response.room.players.find((player) => player.id === identityState.player.id)?.ready) {
      void setOnlineReadyQuiet(false);
    }
    if (
      response.room.status === 'finished'
      && (appMode === 'roomLobby' || appMode === 'onlineCountdown' || appMode === 'onlinePlaying' || appMode === 'onlineResults')
    ) appMode = 'onlineResults';
    // El host arrancó la próxima ronda: se suma cualquiera que siga en la sala,
    // incluso si volvió al menú tras la ronda anterior y la está siguiendo desde
    // el panel lateral (modos persistentes). Antes solo entraban quienes estaban
    // en el lobby o en resultados, así que los demás se quedaban en el menú
    // mientras el host jugaba solo.
    const followsRoomFromMenu = appMode === 'roomLobby'
      || appMode === 'onlineResults'
      || isPersistentRoomPanelMode(appMode);
    if (response.room.status === 'countdown' && followsRoomFromMenu) appMode = 'onlineCountdown';
    if (response.room.status === 'playing' && followsRoomFromMenu) appMode = 'onlineCountdown';
    // El host reabrió la sala al lobby: los demás vuelven al menú principal
    // (la sala sigue viva en el panel lateral).
    if (response.room.status === 'lobby' && appMode === 'onlineResults') goToMenu();
    // Host que ya está en el menú con la sala terminada: la reabre solo.
    if (response.room.status === 'finished' && isOnlineHost() && isPersistentRoomPanelMode(appMode)) {
      void reopenOnlineRoom();
    }
    onlineNetState.error = null;
    roundState.roomGonePolls = 0;
    maybeRefreshBet();
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
    if (error instanceof OnlineApiError && error.status === 404) {
      // La sala ya no existe en el servidor: tras varios polls seguidos dejamos
      // de insistir (cerramos peers, limpiamos sesión) y volvemos al menú, en
      // vez de quedar atascados polleando y señalizando una sala fantasma.
      roundState.roomGonePolls += 1;
      if (roundState.roomGonePolls >= ONLINE_ROOM_GONE_POLL_LIMIT) {
        roundState.roomGonePolls = 0;
        resetOnlineRoomState();
        goToMenu();
        onlineNetState.error = 'La sala ya no existe en el servidor.';
        void syncLunaPresence();
      }
    } else {
      roundState.roomGonePolls = 0;
    }
  } finally {
    onlineNetState.pollInFlight = false;
  }
}

function maybeRefreshBet(): void {
  // En el lobby seguimos los depósitos; en la pantalla de resultados seguimos
  // refrescando para reintentar la liquidación (reporte del ganador + pago) hasta
  // que la apuesta quede en estado terminal.
  if (appMode !== 'roomLobby' && appMode !== 'onlineResults') return;
  const bet = roomState.current?.bet;
  if (!isRefreshableRoomBet(bet)) return;
  const now = performance.now();
  // Igual que la pantalla de pago por QR de Luna Negra: mientras MI depósito
  // siga pendiente se pollea rápido siempre, así un pago hecho por fuera
  // (invoice copiada a otra billetera) se detecta apenas Luna lo registra.
  const fastPoll = bet.status === 'pending_deposits'
    && (now < betState.fastPollUntil || hasOwnPendingDeposit(bet));
  const pollMs = fastPoll ? ONLINE_BET_FAST_POLL_MS : ONLINE_BET_POLL_MS;
  if (betState.busy) {
    betState.refreshQueued = true;
    return;
  }
  if (now - betState.lastPollAt < pollMs) return;
  void refreshOnlineBet(true, { queueIfBusy: true });
}

function isRefreshableRoomBet(bet: RoomBet | null | undefined): bet is RoomBet {
  return !!bet && (
    bet.status === 'pending_deposits'
    || bet.status === 'funded'
    // Después de resolver seguimos consultando mientras haya un retiro/pago
    // pendiente, para detectar `claimed` sin que el usuario recargue la página.
    || hasUnresolvedRoomBetPayout(bet)
  );
}

function hasOwnPendingDeposit(bet: RoomBet): boolean {
  return myBetEntry(bet)?.depositStatus === 'pending';
}

function armOnlineBetFastPolling(): void {
  const bet = roomState.current?.bet;
  if (!bet || bet.status !== 'pending_deposits') return;
  betState.fastPollUntil = Math.max(betState.fastPollUntil, performance.now() + ONLINE_BET_FAST_POLL_WINDOW_MS);
}

async function postOnlineProgress(state: GameState): Promise<void> {
  if (!roomState.current || !isOnlineHost()) return;
  onlineNetState.progressInFlight = true;
  onlineNetState.lastProgressAt = performance.now();
  const requestSeed = roomState.current.seed;
  try {
    const response = await onlineClient.updateProgress({
      roomId: roomState.current.id,
      authorityPlayerId: identityState.player.id,
      playerId: identityState.player.id,
      seed: roomState.current.seed,
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
    onlineNetState.error = null;
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
  } finally {
    onlineNetState.progressInFlight = false;
  }
}

// ¿Tengo abierto el canal de datos hacia el host? (El host siempre "se ve" a sí
// mismo.) Si no, los snapshots peer no llegan y dependo del fallback por servidor.
function isHostChannelOpen(): boolean {
  if (!roomState.current) return false;
  if (isOnlineHost()) return true;
  return peerState.states.get(roomState.current.hostPlayerId) === 'open';
}

// Fallback del invitado: si el canal al host lleva caído ONLINE_SELF_REPORT_GRACE_MS
// durante una ronda activa, posteo mi propio progreso al servidor (self-report) para
// que los demás me vean vía player.game. No mueve room.updatedAtServerMs (el server
// lo trata como self-report; ver updateProgressOnce).
function maybePostSelfProgressFallback(now: number, state: GameState): void {
  if (!roomState.current || isOnlineHost()) return;
  if (state.status !== 'playing') { onlineFailoverState.hostChannelDownSince = 0; return; }
  if (isHostChannelOpen()) { onlineFailoverState.hostChannelDownSince = 0; return; }
  if (onlineFailoverState.hostChannelDownSince === 0) { onlineFailoverState.hostChannelDownSince = now; return; }
  if (now - onlineFailoverState.hostChannelDownSince < ONLINE_SELF_REPORT_GRACE_MS) return;
  if (onlineNetState.selfReportInFlight || now - onlineNetState.lastSelfReportAt < ONLINE_POLL_MS) return;
  void postSelfProgress(state);
}

// Si sigo vivo y mi canal al host lleva caído un rato, le pido al servidor que
// migre la autoridad en vez de esperar el failover pasivo (HOST_STALE_MS, 15s).
// El servidor confirma que el host realmente dejó de escribir antes de migrar, así
// que llamarlo de más es inocuo (devuelve la sala sin cambios). Resuelve el 1v1:
// el sobreviviente no puede eliminar al host ausente por su cuenta.
function maybeRequestHostFailover(now: number, state: GameState): void {
  if (!roomState.current || isOnlineHost()) return;
  if (roomState.current.status !== 'playing' && roomState.current.status !== 'countdown') return;
  if (state.status !== 'playing') return; // solo un jugador vivo lo pide
  if (isHostChannelOpen()) return;
  if (onlineFailoverState.hostChannelDownSince === 0) return; // aún sin medir el corte (lo setea el self-report)
  if (now - onlineFailoverState.hostChannelDownSince < ONLINE_HOST_FAILOVER_REQUEST_GRACE_MS) return;
  if (onlineFailoverState.requestInFlight || now - onlineFailoverState.lastRequestAt < ONLINE_POLL_MS) return;
  void requestHostFailover();
}

async function requestHostFailover(): Promise<void> {
  if (!roomState.current) return;
  onlineFailoverState.requestInFlight = true;
  onlineFailoverState.lastRequestAt = performance.now();
  const requestSeed = roomState.current.seed;
  try {
    const response = await onlineClient.requestHostFailover({
      roomId: roomState.current.id,
      playerId: identityState.player.id,
    });
    if (!isCurrentOnlineSeed(requestSeed)) return;
    syncOnlineClock(response.serverNowMs);
    adoptOnlineRoom(response.room);
  } catch {
    // Best-effort: si falla, el failover pasivo del servidor sigue como red de seguridad.
  } finally {
    onlineFailoverState.requestInFlight = false;
  }
}

async function postSelfProgress(state: GameState): Promise<void> {
  if (!roomState.current || isOnlineHost()) return;
  onlineNetState.selfReportInFlight = true;
  onlineNetState.lastSelfReportAt = performance.now();
  const requestSeed = roomState.current.seed;
  try {
    const response = await onlineClient.updateProgress({
      roomId: roomState.current.id,
      authorityPlayerId: identityState.player.id, // no soy host: el server lo trata como self-report
      playerId: identityState.player.id,
      seed: roomState.current.seed,
      lines: state.stats.lines,
      pieces: state.stats.pieces,
      elapsedFrames: displayedElapsedFrames(state.stats),
      sentGarbage: state.stats.sentGarbage,
      receivedGarbage: state.stats.receivedGarbage,
      pendingGarbage: state.stats.pendingGarbage,
      game: createOnlineGameSnapshot(state),
    });
    if (!isCurrentOnlineSeed(requestSeed)) return;
    adoptOnlineRoom(response.room);
  } catch {
    // Best-effort: el fallback no debe romper el loop ni spamear errores.
  } finally {
    onlineNetState.selfReportInFlight = false;
  }
}

async function postOnlineResult(state: GameState): Promise<void> {
  if (!roomState.current) return;
  roundState.resultSubmitted = true;
  if (!canCommitLocalOnlineTerminal(isOnlineHost())) {
    onlineNetState.error = null;
    return;
  }

  const game = createOnlineGameSnapshot(state);
  await commitOnlineResult(identityState.player.id, state, 'won', game, () => {
    roundState.resultSubmitted = false;
  });
}

async function commitOnlineResult(
  playerId: string,
  state: GameState,
  result: 'won' | 'lost',
  game: OnlineGameSnapshot,
  onFailure?: () => void,
): Promise<void> {
  // Cada cliente reporta su propio resultado ('won' del sobreviviente/sprint); el
  // host queda como respaldo. Ya no es el único escritor del servidor.
  if (!roomState.current) return;
  if (!isOnlineHost() && playerId !== identityState.player.id) return;
  hostAuthorityState.committedResults.add(playerId);
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
    onlineNetState.error = null;
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
    hostAuthorityState.committedResults.delete(playerId);
    onFailure?.();
  }
}

async function postOnlineElimination(state: GameState): Promise<void> {
  if (!roomState.current) return;
  const canCommit = canCommitLocalOnlineTerminal(isOnlineHost());
  if (!canCommit) {
    const now = performance.now();
    if (roundState.resultSubmitted && now - onlineNetState.lastKoBroadcastAt < ONLINE_KO_BROADCAST_RETRY_MS) return;
    roundState.resultSubmitted = true;
    onlineNetState.lastKoBroadcastAt = now;
    peerState.broadcaster?.broadcastKo(createOnlineKoReport(identityState.player.id, state));
    onlineNetState.error = null;
    return;
  }

  if (roundState.resultSubmitted) return;
  roundState.resultSubmitted = true;
  const report = createOnlineKoReport(identityState.player.id, state);
  onlineNetState.lastKoBroadcastAt = performance.now();
  peerState.broadcaster?.broadcastKo(report);

  await commitOnlineElimination(report, () => {
    roundState.resultSubmitted = false;
  });
}

async function commitOnlineElimination(report: Omit<OnlinePeerKoMessage, 'type'>, onFailure?: () => void): Promise<void> {
  // Cada quien commitea SU PROPIA muerte; el host además puede commitear la de un
  // peer que se cayó justo después de anunciar su KO (respaldo idempotente).
  if (!roomState.current) return;
  if (!isOnlineHost() && report.playerId !== identityState.player.id) return;
  // Los KOs llegan repetidos (broadcast por peer con retry + simulación local):
  // un solo commit por jugador y por ronda.
  if (hostAuthorityState.committedEliminations.has(report.playerId)) return;
  const requestSeed = report.seed;
  hostAuthorityState.committedEliminations.add(report.playerId);
  try {
    const response = await onlineClient.eliminatePlayer({
      roomId: roomState.current.id,
      authorityPlayerId: identityState.player.id,
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
    onlineNetState.error = null;
  } catch (error) {
    onlineNetState.error = onlineErrorText(error);
    hostAuthorityState.committedEliminations.delete(report.playerId);
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
 * ajenos (hostAuthorityState.simulator queda null, y todos los caminos que lo usan están
 * guardados). Igual recupera la ronda porque, ya reconocido como host:
 *  - mantiene viva la sala posteando su propio progreso (postOnlineProgress),
 *  - acredita los KO que los peers anuncian por broadcast
 *    (decidePeerKoAction -> 'commit' -> commitOnlineElimination), y
 *  - reporta su propio resultado/eliminación,
 * con lo que el servidor puede terminar la partida (finishRoomIfOnlyOneAlive).
 */
function ensureMigratedHostAuthority(): void {
  if (!roomState.current || !roundState.runStarted || !isOnlineHost()) return;
  if (hostAuthorityState.simulator || hostAuthorityState.migrated) return;
  hostAuthorityState.migrated = true;
}

function maybeStartOnlineRun(): void {
  if (!roomState.current?.startsAtServerMs || roundState.runStarted) return;
  if (onlineNowMs() < roomState.current.startsAtServerMs) return;
  roundState.runStarted = true;
  // Música de sala: todos los clientes (jugadores y espectadores) saltan a la misma
  // pista, elegida con el filtro libre-de-derechos del host y la seed compartida, así
  // suena lo mismo en todas las pantallas durante la partida.
  applyOnlineRoomMusic(roomState.current);
  // No estaba listo cuando arrancó la ronda: el servidor me dejó como espectador
  // (alive=false). No simulo tablero propio ni reporto nada; solo miro a los
  // rivales. Ver isOnlineSpectating() y los guards de syncOnline().
  const me = roomState.current.players.find((player) => player.id === identityState.player.id);
  if (me && !me.alive) {
    roundState.spectatorRound = true;
    appMode = 'onlinePlaying';
    resetSpectatorFocus();
    return;
  }
  roundState.spectatorRound = false;
  roundState.resultSubmitted = false;
  attackState.sequence = 0;
  attackState.appliedIds = new Set();
  // Modelo cliente-autoritativo: cada jugador simula su PROPIO tablero y reporta sus
  // líneas/ataques/KO por peer. El host ya NO re-simula a los demás (eso causaba
  // divergencias deterministas y top-outs falsos al recibir garbage). El host solo
  // rutea ataques y relaya progreso/KO al servidor, que es el único escritor autorizado.
  // hostAuthorityState.simulator queda siempre null y todos los caminos de simulación quedan inertes.
  hostAuthorityState.simulator = null;
  hostAuthorityState.migrated = false;
  hostAuthorityState.progressInFlight = new Set();
  hostAuthorityState.lastProgressAt = new Map();
  hostAuthorityState.committedEliminations = new Set();
  hostAuthorityState.committedResults = new Set();
  hostAuthorityState.lastAuthoritativeFrame = 0;
  attackState.inputOutbox = [];
  onlineNetState.lastProgressAt = 0;
  onlineNetState.lastSelfReportAt = 0;
  onlineFailoverState.hostChannelDownSince = 0;
  onlineNetState.lastPeerBroadcastAt = 0;
  onlineNetState.lastKoBroadcastAt = 0;
  syncHostAuthorityPlayers();
  startNewRun(roomState.current.seed, 'onlinePlaying');
}

// Sonido de cuenta regresiva compartido por solo y online: un beep por cada
// segundo (3, 2, 1) y un acorde de arranque al llegar a cero. Idempotente dentro
// de un mismo segundo gracias a runState.lastCountdownSecondPlayed.
function playCountdownAudio(remainingMs: number): void {
  const seconds = Math.ceil(remainingMs / 1000);
  if (seconds === runState.lastCountdownSecondPlayed) return;
  runState.lastCountdownSecondPlayed = seconds;
  if (seconds > 0) sound.play('countdownTick');
  else sound.play('countdownGo');
}

function updateSoloCountdown(): void {
  const remainingMs = Math.max(0, runState.soloCountdownStartsAtMs - performance.now());
  playCountdownAudio(remainingMs);
  if (remainingMs === 0) {
    appMode = 'playing';
    syncGameplayClockToCurrentFrame();
  }
}

function syncOnlinePeers(room: OnlineRoom): void {
  if (!('RTCPeerConnection' in window)) return;
  peerState.broadcaster ??= new OnlinePeerBroadcaster({
    playerId: identityState.player.id,
    sendSignal: (signal) => {
      if (!roomState.current) return;
      void onlineClient.sendPeerSignal({
        roomId: roomState.current.id,
        fromPlayerId: identityState.player.id,
        toPlayerId: signal.toPlayerId,
        type: signal.type,
        data: signal.data,
      }).then((response) => {
        syncOnlineClock(response.serverNowMs);
        adoptOnlineRoom(response.room);
      }).catch((error) => {
        onlineNetState.error = onlineErrorText(error);
      });
    },
    onSnapshot: (remoteId, playerId, game) => applyAuthoritativeSnapshot(remoteId, playerId, game),
    onAttack: (remoteId, attack) => {
      // Acepto el ataque de cualquier peer que lo firme como propio (el emisor es el
      // autor y la fuente). Antes solo se aceptaban los del host.
      if (!roomState.current || attack.authorityPlayerId !== remoteId || attack.fromPlayerId !== remoteId) return;
      if (!isCurrentOnlineSeed(attack.seed)) return;
      applyOnlineAttack({
        id: attack.attackId,
        roomId: roomState.current.id,
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
      if (!roomState.current || !isOnlineHost()) return;
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
      hostAuthorityState.simulator?.pushInputs(message.playerId, message.inputs);
    },
    onKo: (remoteId, message) => {
      if (!roomState.current) return;
      const action = decidePeerKoAction({
        isHostAuthority: isOnlineHost(),
        localPlayerId: identityState.player.id,
        hostPlayerId: roomState.current.hostPlayerId,
        remotePlayerId: remoteId,
        messagePlayerId: message.playerId,
        playerIsInRoom: roomState.current.players.some((player) => player.id === remoteId),
        seedMatches: isCurrentOnlineSeed(message.seed),
      });
      if (action === 'ignore') return;
      applyPeerKo(message);
      if (action === 'commit') void commitOnlineElimination(message);
    },
    onReplay: (remoteId, message) => collectPeerReplay(remoteId, message),
    onPeerState: (playerId, state) => {
      peerState.states = new Map(peerState.states).set(playerId, state);
    },
  });
  peerState.broadcaster.syncRoom(room);
  prunePeerDisplaySnapshots(room);
}

function broadcastOnlineSnapshot(state: GameState): void {
  onlineNetState.lastPeerBroadcastAt = performance.now();
  // El snapshot propio solo tiene sentido mientras se juega, pero el host debe
  // seguir retransmitiendo los tableros simulados de los demás aunque su propia
  // partida haya terminado.
  if (state.status === 'playing') {
    const snapshot = createOnlineGameSnapshot(state);
    peerState.broadcaster?.broadcastSnapshot(identityState.player.id, snapshot);
    if (isOnlineHost()) applyPeerSnapshot(identityState.player.id, identityState.player.id, snapshot);
  }
  if (!isOnlineHost()) return;
  for (const player of roomState.current?.players ?? []) {
    if (player.id === identityState.player.id) continue;
    const remoteState = hostAuthorityState.simulator?.getState(player.id);
    const remoteSnapshot = hostAuthorityState.simulator?.getSnapshot(player.id);
    if (remoteState && remoteSnapshot) {
      peerState.broadcaster?.broadcastSnapshot(player.id, createOnlineGameSnapshotFromState(
        remoteState,
        remoteSnapshot,
        hostAuthorityState.simulator?.getLastProcessedInputSequence(player.id) ?? 0,
      ));
    }
  }
}

// Difunde mi log de replay una sola vez por ronda. Se dispara cuando mi partida
// termina (KO/victoria propia) O cuando la sala cierra: el ÚLTIMO en pie gana por
// supervivencia y su status local sigue 'playing' (nunca topó ni completó), así
// que sin el caso "sala finished" el ganador jamás grabaría su propio tablero y
// solo se vería el del perdedor. Los canales peer siguen abiertos hasta que la
// sala cierra, así que muertos/espectadores también lo reciben.
function maybeBroadcastOwnReplay(state: GameState): void {
  if (runState.currentRunKind !== 'online' || multiReplayState.broadcast) return;
  const localTerminal = state.status === 'gameover' || state.status === 'finished';
  const roundOver = roomState.current?.status === 'finished';
  if (!localTerminal && !roundOver) return;
  multiReplayState.broadcast = true;
  const report: Omit<OnlinePeerReplayMessage, 'type'> = {
    playerId: identityState.player.id,
    name: identityState.player.name,
    seed: replay.seed,
    rules: replay.rules,
    inputs: replay.inputs,
    garbage: replay.garbage,
  };
  peerState.broadcaster?.broadcastReplay(report);
  // El propio log se suma localmente; el resto llega por WebRTC.
  collectPeerReplay(identityState.player.id, { type: 'replay', ...report });
}

function collectPeerReplay(remoteId: string, message: OnlinePeerReplayMessage): void {
  if (message.playerId !== remoteId) return;
  if (!isCurrentOnlineSeed(message.seed)) return;
  onlineReplayCollector.add({
    playerId: message.playerId,
    name: message.name,
    seed: message.seed,
    rules: message.rules,
    inputs: message.inputs,
    garbage: message.garbage,
  });
}

function applyAuthoritativeSnapshot(remoteId: string, playerId: string, game: OnlineGameSnapshot): void {
  if (!roomState.current) return;
  if (playerId === remoteId) rememberPeerDisplaySnapshot(playerId, game);
  if (isOnlineHost()) return;
  if (remoteId !== roomState.current.hostPlayerId) return;
  if (!isCurrentOnlineGame(game)) return;
  // Cliente-autoritativo: cada quien es dueño de su propio motor. NO adoptamos el tablero
  // que el host tenga de nosotros (eso era lo que nos mataba con el mapa lleno cuando su
  // simulación divergía). Solo guardamos los tableros de OTROS para mostrarlos.
  if (playerId === identityState.player.id) return;
  applyPeerSnapshot(remoteId, playerId, game);
}

function isCurrentOnlineGame(game: OnlineGameSnapshot | null | undefined): boolean {
  return !!game && isCurrentOnlineSeed(game.seed);
}

function isCurrentOnlineSeed(seedValue: number | undefined): boolean {
  return !!roomState.current && seedValue === roomState.current.seed;
}

function applyPeerSnapshot(_remoteId: string, playerId: string, game: OnlineGameSnapshot): void {
  if (!roomState.current) return;
  if (!isCurrentOnlineGame(game)) return;
  roomState.current = {
    ...roomState.current,
    players: roomState.current.players.map((player) => player.id === playerId ? { ...player, game } : player),
  };
}

function rememberPeerDisplaySnapshot(playerId: string, game: OnlineGameSnapshot): void {
  if (!isCurrentOnlineGame(game)) return;
  peerState.displaySnapshots = new Map(peerState.displaySnapshots).set(playerId, game);
}

function prunePeerDisplaySnapshots(room: OnlineRoom): void {
  const playerIds = new Set(room.players.map((player) => player.id));
  peerState.displaySnapshots = new Map(
    [...peerState.displaySnapshots.entries()].filter(([playerId, game]) => (
      playerIds.has(playerId) && game.seed === room.seed
    )),
  );
}

function postHostSimulatedProgress(playerId: string, state: GameState): void {
  if (!roomState.current || !isOnlineHost()) return;
  const now = performance.now();
  if (hostAuthorityState.progressInFlight.has(playerId)) return;
  if (now - (hostAuthorityState.lastProgressAt.get(playerId) ?? 0) < ONLINE_POLL_MS) return;

  hostAuthorityState.progressInFlight.add(playerId);
  hostAuthorityState.lastProgressAt.set(playerId, now);
  const requestSeed = roomState.current.seed;
  const progress = createProgressRequest(playerId, createOnlineGameSnapshotFromState(
    state,
    hostAuthorityState.simulator?.getSnapshot(playerId) ?? undefined,
    hostAuthorityState.simulator?.getLastProcessedInputSequence(playerId) ?? 0,
  ));
  void onlineClient.updateProgress(progress)
    .then((response) => {
      if (!isCurrentOnlineSeed(requestSeed)) return;
      syncOnlineClock(response.serverNowMs);
      adoptOnlineRoom(response.room);
      syncOnlinePeers(response.room);
      onlineNetState.error = null;
    })
    .catch((error) => {
      onlineNetState.error = onlineErrorText(error);
    })
    .finally(() => {
      hostAuthorityState.progressInFlight.delete(playerId);
    });
}

// Cliente-autoritativo: como el host ya no simula a los invitados, relaya al servidor el
// progreso de cada uno tomándolo de SU PROPIO broadcast por peer (peerState.displaySnapshots).
// El servidor solo acepta escrituras con authorityPlayerId = host, así que el host sigue
// siendo el único escritor; acá actúa de mero relay del estado real que reporta cada peer.
function relayPeerProgressToServer(): void {
  if (!roomState.current || !isOnlineHost()) return;
  const now = performance.now();
  for (const player of roomState.current.players) {
    if (player.id === identityState.player.id) continue;
    if (player.status === 'eliminated' || player.status === 'won' || player.status === 'lost') continue;
    const snapshot = peerState.displaySnapshots.get(player.id);
    if (!snapshot || !isCurrentOnlineGame(snapshot) || snapshot.status !== 'playing') continue;
    if (hostAuthorityState.progressInFlight.has(player.id)) continue;
    if (now - (hostAuthorityState.lastProgressAt.get(player.id) ?? 0) < ONLINE_POLL_MS) continue;

    hostAuthorityState.progressInFlight.add(player.id);
    hostAuthorityState.lastProgressAt.set(player.id, now);
    const requestSeed = roomState.current.seed;
    void onlineClient.updateProgress(createProgressRequest(player.id, snapshot))
      .then((response) => {
        if (!isCurrentOnlineSeed(requestSeed)) return;
        syncOnlineClock(response.serverNowMs);
        adoptOnlineRoom(response.room);
        onlineNetState.error = null;
      })
      .catch((error) => {
        onlineNetState.error = onlineErrorText(error);
      })
      .finally(() => {
        hostAuthorityState.progressInFlight.delete(player.id);
      });
  }
}

function applyPeerKo(message: Pick<OnlinePeerKoMessage, 'playerId' | 'seed' | 'frame' | 'elapsedFrames' | 'game'>): void {
  const { playerId, frame } = message;
  if (!roomState.current || playerId === identityState.player.id) return;
  if (!isCurrentOnlineSeed(message.seed)) return;
  roomState.current = {
    ...roomState.current,
    players: roomState.current.players.map((player) => player.id === playerId
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
  // Cada ataque va firmado por su fuente (authorityPlayerId === fromPlayerId), tanto
  // si llega por peer como del fallback por servidor (applyRoomAttacks).
  if (!roomState.current || attack.authorityPlayerId !== attack.fromPlayerId) return;
  if (!isCurrentOnlineSeed(attack.seed)) return;
  if (attack.toPlayerId !== identityState.player.id || attackState.appliedIds.has(attack.id)) return;
  attackState.appliedIds.add(attack.id);
  rememberOnlineAttack(attack.fromPlayerId, attack.toPlayerId, attack.lines);
  const beforeGarbage = engine.getState();
  logMp('garbage-in', {
    from: attack.fromPlayerId.slice(0, 6),
    lines: attack.lines,
    attackFrame: attack.frame,
    gameFrame: runState.gameFrame,
    holeSeed: attack.holeSeed,
    board: boardMetrics(beforeGarbage.board),
    pendingBefore: beforeGarbage.stats.pendingGarbage,
  });
  // Telegrafiamos el garbage desde el frame LOCAL en que lo recibimos (runState.gameFrame), NO desde el
  // frame del atacante. Con relojes desacoplados (ver targetGameplayFrame) el frame del atacante no
  // significa nada en tu línea de tiempo; anclarlo a tu recepción da una ventana de reacción
  // CONSTANTE (applyFrame = runState.gameFrame + delay) sin importar la latencia —en vez de una ventana que
  // se acortaba cuanto peor la conexión—. El host ya no resimula, así que no hace falta que el
  // garbage caiga en el mismo frame en ambos lados.
  engine.queueGarbage(attack.lines, attack.holeSeed, runState.gameFrame, attack.id);
  // Registramos los valores REALES usados para que el replay reproduzca idéntico: queuedAtFrame =
  // runState.gameFrame en que se encoló (cuándo reaplicar), frame = misma ancla local que fija el applyFrame.
  recordGarbage(replay, {
    queuedAtFrame: runState.gameFrame,
    frame: runState.gameFrame,
    lines: attack.lines,
    holeSeed: attack.holeSeed,
    id: attack.id,
  });
}

function rememberOnlineAttack(fromPlayerId: string, toPlayerId: string, lines: number): void {
  if (!roomState.current) return;
  roomState.current = {
    ...roomState.current,
    players: roomState.current.players.map((player) => {
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
  // La música se silencia cuando la pestaña pasa a segundo plano (estilo TETR.IO).
  // El bucle rAF se congela al ocultarse, así que loopBody() no llega a aplicar el
  // gate: lo hacemos acá explícitamente. Al volver, el primer frame lo restaura.
  sound.setMusicAllowed(!document.hidden && shouldPlayMusic(appMode));
  if (document.hidden) {
    syncOnlineBackground();
    return;
  }
  // Al volver al juego reanunciamos presencia de inmediato (sin esperar el
  // intervalo) para reaparecer como "jugando" apenas el jugador regresa.
  if (lunaState.identity) void syncLunaPresence();
  if (!roomState.current) return;
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
  return !!roomState.current
    && (appMode === 'onlineCountdown' || appMode === 'onlinePlaying')
    && (roomState.current.status === 'countdown' || roomState.current.status === 'playing');
}

function eagerRefreshBetIfPending(): void {
  if (appMode !== 'roomLobby') return;
  const bet = roomState.current?.bet;
  if (!isRefreshableRoomBet(bet)) return;
  armOnlineBetFastPolling();
  void refreshOnlineBet(true, { queueIfBusy: true });
}

function syncOnlineBackground(): void {
  if (!document.hidden) return;
  if (!roomState.current) return;
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
    seed: roomState.current?.seed,
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

// BOT DEV: panel de control fijo para provocar cada efecto del multijugador a
// demanda (ataques entrantes, top-out del bot, velocidad) y encadenar rondas.
// Vive en su propia capa (devBotOverlayElement) y solo se redibuja al cambiar.
function renderDevBotOverlay(): void {
  if (!devBotOverlayElement) return;
  const html = devBotMatch ? renderDevBotPanel() : '';
  if (html === overlayState.lastDevBot) return;
  overlayState.lastDevBot = html;
  devBotOverlayElement.innerHTML = html;
}

function renderDevBotPanel(): string {
  const cadence = devBotMatch?.getConfig().inputCadenceFrames ?? 6;
  const buttonStyle = 'pointer-events:auto;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.85);border:1px solid rgba(255,255,255,0.18);border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;';
  const activeStyle = 'background:rgba(80,200,120,0.3);';
  const speedButton = (value: number, label: string) =>
    `<button type="button" style="${buttonStyle}${cadence === value ? activeStyle : ''}" data-ui-action="dev-bot-cadence" data-value="${value}">${label}</button>`;
  const botState = devBotMatch?.getState();
  const statusLine = botState
    ? `${botState.status} · ${botState.stats.lines} líneas · ${botState.stats.pendingGarbage} pend.`
    : 'esperando ronda';
  const nextRoundHtml = roomState.current?.status === 'lobby'
    ? `<button type="button" style="${buttonStyle}${activeStyle}" data-ui-action="dev-bot-next-round">Siguiente ronda</button>`
    : '';
  return `
    <div style="position:fixed;left:12px;bottom:12px;z-index:80;display:flex;flex-direction:column;gap:6px;background:rgba(10,12,18,0.82);border:1px solid rgba(255,255,255,0.14);border-radius:10px;padding:10px;font-family:monospace;pointer-events:auto;">
      <div style="font-size:10px;letter-spacing:1px;color:rgba(255,255,255,0.5);">BOT DEV · ${statusLine}</div>
      <div style="display:flex;gap:6px;">
        <button type="button" style="${buttonStyle}" data-ui-action="dev-bot-attack" data-lines="1">Ataca 1</button>
        <button type="button" style="${buttonStyle}" data-ui-action="dev-bot-attack" data-lines="2">Ataca 2</button>
        <button type="button" style="${buttonStyle}" data-ui-action="dev-bot-attack" data-lines="4">Ataca 4</button>
        <button type="button" style="${buttonStyle}" data-ui-action="dev-bot-topout">Top-out</button>
      </div>
      <div style="display:flex;gap:6px;">
        ${speedButton(12, 'Lento')}
        ${speedButton(6, 'Normal')}
        ${speedButton(2, 'Rápido')}
        ${nextRoundHtml}
      </div>
    </div>
  `;
}

function renderOverlay(state: GameState): void {
  if (import.meta.env.DEV) renderDevBotOverlay(); // BOT DEV
  const currentMusicTrack = sound.getCurrentMusicTrack()?.title ?? 'No music';
  // Modo solo "relax" (40 líneas): muestra subtítulo + engranaje de ajustes.
  const soloRelax = appMode === 'playing' || appMode === 'paused' || appMode === 'soloCountdown';
  const gearIcon = gearOutlineIcon({ size: 20 });
  const html = `
    <div class="brand">TETRA${soloRelax ? '<span class="brand-sub">MODO RELAX</span>' : ''}</div>
    ${soloRelax ? `<button class="gear-btn" type="button" data-ui-action="settings" aria-label="Ajustes" title="Ajustes">${gearIcon}</button>` : ''}
    ${soloRelax ? renderRelaxAudio() : ''}
    ${autoPlayState.accessGranted ? renderAutoPlayToggle() : ''}
    <div class="help">${escapeHtml(helpText())}</div>
    ${soloRelax ? '' : (appMode === 'onlinePlaying' ? `<div class="audio-panel audio-panel--online">
      ${renderVolumeChannelRow('sfx')}
      ${renderVolumeChannelRow('music')}
    </div>` : `<div class="audio-panel">
      <button class="hud-action sound" type="button" data-ui-action="toggle-sound">${sound.isMuted() ? 'Sound off' : 'Sound on'}</button>
      ${renderVolumeChannelRow('sfx')}
      ${renderVolumeChannelRow('music')}
      <button class="hud-action music" type="button" data-ui-action="next-music">${escapeHtml(sound.isMuted() || sound.isMusicMuted() || sound.getMusicVolume() === 0 ? 'Music paused' : currentMusicTrack)}</button>
      <button class="hud-action reverb" type="button" data-ui-action="cycle-reverb" title="Cola de reverb al apagar la música">Reverb: ${reverbLabel(sound.getReverbMode())}</button>
      <button class="hud-action positional" type="button" data-ui-action="toggle-positional" title="El paneo estéreo de cada sonido sigue su posición en pantalla">Posicional: ${isPositionalAudio() ? 'on' : 'off'}</button>
      <button class="hud-action royalty-free" type="button" data-ui-action="toggle-royalty-free" title="${HAS_ROYALTY_FREE_TRACKS ? 'Reproducir sólo temas libres de derechos (archivos con prefijo ncc)' : 'No hay temas libres de derechos cargados (archivos con prefijo ncc). Activarlo dejará la música en silencio.'}">Libre de derechos: ${loadRecord().royaltyFreeOnly ? 'on' : 'off'}</button>
      <button class="hud-action bg-motion" type="button" data-ui-action="toggle-bg-motion" title="Movimiento del fondo dinámico. Si tu sistema tiene activado 'reducir movimiento', el fondo se mueve más lento; apágalo aquí para dejarlo estático.">Fondo animado: ${loadRecord().backgroundMotion ? 'on' : 'off'}</button>
    </div>`)}
    ${appMode === 'onlinePlaying' && !hasBlockingModal() ? renderOnlinePlayingOverlay() : ''}
    ${renderScreenOverlay(state)}
    ${renderTouchControls(state)}
  `;
  if (html !== overlayState.last) {
    const focusSnapshot = captureOverlayFieldFocus();
    const scrollSnapshot = captureOverlayScroll();
    overlayElement.innerHTML = html;
    overlayState.last = html;
    restoreOverlayFieldFocus(focusSnapshot);
    restoreOverlayScroll(scrollSnapshot);
  }
  maybeScrollDepositIntoView();
  // Toast compacto de KO: aparece arriba cuando paso a espectador (ya terminó la
  // animación de derrota, mi tablero está oculto) y se desvanece solo por CSS.
  // Contenido congelado (deathState.onlineKoBanner) → se dibuja una vez y no parpadea.
  const koHtml = deathState.onlineKoBanner && isOnlineSpectating()
    ? renderOnlineKoToast(deathState.onlineKoBanner)
    : '';
  if (koHtml !== overlayState.lastKo) {
    koOverlayElement.innerHTML = koHtml;
    overlayState.lastKo = koHtml;
  }
  // HUD online en su propia capa: solo se repinta cuando cambia (garbage,
  // estrategia u objetivo), no cada frame, así el hover de los botones no titila.
  const hudHtml = appMode === 'onlinePlaying' ? renderOnlineHud() : '';
  if (hudHtml !== overlayState.lastHud) {
    hudOverlayElement.innerHTML = hudHtml;
    overlayState.lastHud = hudHtml;
  }
  // Toast de invitación durante partida: capa propia con caché para que los
  // botones no se recreen cada frame (el juego sigue corriendo detrás).
  const inviteHtml = lunaState.pendingLaunchRequest && lunaInviteShowsAsToast()
    ? renderLunaInviteToast(lunaState.pendingLaunchRequest)
    : '';
  if (inviteHtml !== overlayState.lastInvite) {
    inviteOverlayElement.innerHTML = inviteHtml;
    overlayState.lastInvite = inviteHtml;
  }
  document.body.classList.toggle('online-spectating', isOnlineSpectating());
  if (appMode === 'replayPlayback' && replayState.playback) updateReplayOverlay(replayState.playback.snapshot());
}

function renderAutoPlayToggle(): string { // TRUCO AUTOPLAY
  const textColor = autoPlayState.enabled ? 'rgba(255,255,255,0.84)' : 'rgba(255,255,255,0.24)';
  const background = autoPlayState.enabled ? 'rgba(80,200,120,0.26)' : 'rgba(255,255,255,0.01)';
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

// Cuando aparece el bloque de depósito (QR de pago), lo traemos a la vista dentro
// de su panel scrolleable: antes el QR quedaba por debajo del borde y había que
// scrollear a mano para verlo completo. Solo en la transición a visible para no
// pelear con el scroll manual del usuario en renders posteriores.
function maybeScrollDepositIntoView(): void {
  const deposit = overlayElement.querySelector<HTMLElement>('[data-bet-deposit]');
  const visible = deposit !== null;
  if (visible && !lunaState.depositWasVisible) {
    deposit.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  lunaState.depositWasVisible = visible;
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
  if (lunaState.pendingLaunchRequest && !lunaInviteShowsAsToast()) return renderLunaLaunchRequestOverlay(lunaState.pendingLaunchRequest);
  if (pendingConfirmAction) return renderConfirmOverlay(pendingConfirmAction);
  if (appMode === 'replayPlayback') return renderReplayOverlayShell();
  // El visor multi-tablero vive en su capa propia (multiReplayOverlayElement),
  // no en el overlay general; aquí no aporta nada.
  if (appMode === 'onlineReplay') return '';
  if (
    appMode === 'menu'
    || appMode === 'playMenu'
    || appMode === 'soloMenu'
    || appMode === 'multiplayerMenu'
    || appMode === 'historyMenu'
    || appMode === 'configMenu'
    || appMode === 'custom'
    || appMode === 'library'
    || appMode === 'leaderboard'
    || appMode === 'survivalTop'
    || appMode === 'onlineMenu'
    || appMode === 'roomLobby'
    || (appMode === 'settings' && settingsReturnMode !== 'paused')
  ) {
    return renderDashboardMenu(state);
  }

  if (appMode === 'settings') return renderSettingsOverlay();
  if (appMode === 'soloCountdown') return renderSoloCountdownOverlay();
  if (appMode === 'onlineCountdown') return renderOnlineCountdownOverlay();
  if (appMode === 'onlineResults') {
    // Mientras corre la ventana de muerte, el tablero local sigue dibujándose: primero
    // congelado (fase de estudio, con cartel) para ver por qué perdiste, luego la
    // animación de derrota ("GAME!" + colapso); recién después aparecen los resultados.
    if (isOnlineDeathAnimating()) return isOnlineDeathStudying() ? renderDeathStudyHint() : '';
    return renderOnlineResultsOverlay(state);
  }
  // Online: perder no abre la pantalla de resultados de solo. El banner de KO se
  // dibuja en su propia capa persistente (koOverlayElement) para que no parpadee
  // con el redibujo por frame de los tableros rivales. Durante la fase de estudio sí
  // mostramos el cartel discreto sobre el tablero congelado.
  if (appMode === 'onlinePlaying') {
    return isOnlineDeathStudying() ? renderDeathStudyHint() : '';
  }

  if (appMode === 'paused') {
    return renderPausePanel(state);
  }

  const terminal = terminalLabel(state.status);
  if (!terminal) return '';
  // Perder en solo no abre el panel al instante. Primero el tablero queda congelado
  // (fase de estudio, con un cartel discreto para que veas por qué perdiste), luego
  // corre el colapso ("GAME!") y recién ahí aparecen los resultados. Ganar (finished)
  // no se difiere: la celebración ya es la pantalla.
  if (state.status === 'gameover' && isSoloDeathAnimating()) {
    return isSoloDeathStudying() ? renderDeathStudyHint() : '';
  }
  return renderSoloResultsOverlay(state);
}

// Cartel discreto durante la fase de estudio: no tapa el tablero, solo avisa que
// quedó congelado a propósito para que veas cómo perdiste. Compartido solo/online.
function renderDeathStudyHint(): string {
  return `
    <div class="death-study-hint">
      <span class="death-study-hint-tag">TOP OUT</span>
      <span class="death-study-hint-text">Observá tu tablero — así quedó al perder</span>
    </div>
  `;
}

function renderSoloResultsOverlay(state: GameState): string {
  const isClear = state.status === 'finished';
  const summary = currentRunSummary(state);
  const time = formatFrames(displayedElapsedFrames(state.stats));
  const lines = state.stats.lines;
  const target = state.stats.targetLines;
  const pieces = state.stats.pieces;
  const pps = summary.pps.toFixed(1);
  const combo = runState.maxCombo;
  const isSurvival = runState.currentRunKind === 'survival';
  const subtitle = isSurvival ? 'SUPERVIVENCIA' : target ? `OBJETIVO ${target} LÍNEAS` : 'CUSTOM';
  const badge = isClear
    ? '<div class="solo-results-badge solo-results-badge--clear">✓ OBJETIVO CUMPLIDO</div>'
    : `<div class="solo-results-badge solo-results-badge--fail">${escapeHtml(gameOverReasonMessage(state.stats.gameOverReason))}</div>`;
  const verdict = isClear
    ? '<div class="solo-results-verdict solo-results-verdict--clear">CLEAR</div>'
    : '<div class="solo-results-verdict solo-results-verdict--fail">TOP OUT</div>';
  return `
    <div class="menu-scrim solo-results-scrim">
      <div class="solo-results">
        ${badge}
        <div class="solo-results-subtitle">${escapeHtml(subtitle)}</div>
        <div class="solo-results-hero">${escapeHtml(time)}</div>
        ${verdict}
        ${isSurvival ? renderSurvivalRankBlock() : ''}
        <div class="solo-results-stats">
          <div class="solo-results-stat"><span>LÍNEAS</span><strong class="is-cyan">${lines}${target ? `<em> / ${target}</em>` : ''}</strong></div>
          <div class="solo-results-stat"><span>PIEZAS</span><strong>${pieces}</strong></div>
          <div class="solo-results-stat"><span>PPS</span><strong class="is-green">${pps}</strong></div>
          <div class="solo-results-stat"><span>COMBO MÁX</span><strong class="is-amber">×${combo}</strong></div>
        </div>
        <div class="solo-results-actions">
          ${canReplayLastSeconds(state) ? `<button class="solo-results-btn solo-results-btn--ghost" type="button" data-ui-action="replay-last-seconds">Ver últimos ${DEATH_REPLAY_SECONDS}s</button>` : ''}
        </div>
        <div class="solo-results-actions solo-results-actions--next">
          <button class="solo-results-btn solo-results-btn--next" type="button" data-ui-action="main-menu">Siguiente</button>
        </div>
        ${renderReportBlock()}
      </div>
    </div>
  `;
}

// Puesto del jugador en el top de supervivencia, calculado al terminar la partida.
// Mientras se calcula muestra un estado de carga; si el jugador no entra en el top
// consultado, lo indica con un mensaje alentador.
function renderSurvivalRankBlock(): string {
  const r = leaderboardState.survivalRunRank;
  if (!r || r.status === 'loading') {
    return '<div class="solo-results-rank">Calculando tu puesto en el mundo…</div>';
  }
  if (r.status === 'guest') {
    return '<div class="solo-results-rank">Iniciá sesión en Luna Negra para competir en el top mundial</div>';
  }
  if (r.status === 'unranked') {
    return '<div class="solo-results-rank">Todavía fuera del top mundial — ¡seguí intentando!</div>';
  }
  if (r.status === 'error') {
    return '<div class="solo-results-rank">No se pudo calcular tu puesto</div>';
  }
  // Ranqueado: en vez de una sola frase, mostramos una mini-tabla con tu vecindario
  // del ranking (hasta 3 arriba y 3 abajo) y tu fila resaltada. Da contexto de un
  // vistazo —a quién le ganás y a quién perseguís— sin abrir el top completo.
  return renderSurvivalRankWindow(r.rank, r.total);
}

// Mini-tabla del top centrada en el jugador: tu fila + vecinos inmediatos.
function renderSurvivalRankWindow(rank: number, total: number): string {
  const myIndex = rank - 1;
  // 2 arriba + vos + 2 abajo: suficiente contexto de vecinos sin que la pantalla
  // de resultados crezca de más y obligue a scrollear.
  const start = Math.max(0, myIndex - 2);
  const end = Math.min(leaderboardState.survivalEntries.length, myIndex + 3);
  const myId = identityState.player.id;
  const rows = leaderboardState.survivalEntries.slice(start, end).map((entry, i) => {
    const position = start + i + 1;
    const mine = entry.playerId === myId;
    const pos = position === 1 ? '🥇' : position === 2 ? '🥈' : position === 3 ? '🥉' : `#${position}`;
    const time = formatFrames(Math.round(entry.bestMs / GAME_FRAME_MS));
    const name = mine ? 'Vos' : entry.name;
    return `
      <div class="rankwin-row${mine ? ' rankwin-row--me' : ''}">
        <span class="rankwin-pos">${escapeHtml(pos)}</span>
        <span class="rankwin-name">${escapeHtml(name)}</span>
        <span class="rankwin-time">${escapeHtml(time)}</span>
      </div>`;
  }).join('');
  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
  return `
    <div class="solo-results-rankwin">
      <div class="rankwin-head">${medal ? `${medal} ` : ''}Puesto #${rank} <span>de ${total} en el mundo</span></div>
      <div class="rankwin-sub">Ordenado por la mejor marca de cada jugador</div>
      <div class="rankwin-list">${rows}</div>
    </div>`;
}

function canRetryCurrentRun(): boolean {
  return runState.currentRunKind !== 'custom' || customSettings.allowRetry;
}

function renderTouchControls(state: GameState): string {
  if ((appMode !== 'playing' && appMode !== 'onlinePlaying') || hasBlockingModal()) return '';
  // Al terminar la partida solo (game over / clear) la pantalla de resultados se dibuja
  // todavía en appMode 'playing'. Los controles táctiles ya no sirven y su barra fija
  // tapaba el botón "Reportar" abajo; los ocultamos en cuanto la corrida es terminal.
  if (appMode === 'playing' && terminalLabel(state.status)) return '';

  // El esquema (Pro/Simple/D-pad), la vibración y la pausa ya no viven en una barra
  // sobre los botones: el esquema y la vibración se ajustan desde Configuración
  // (engranaje) y la pausa en solo es el propio engranaje. Así el tablero gana alto.
  return `
    <nav class="touch-controls touch-scheme-${touchScheme}" aria-label="Controles táctiles">
      <div class="touch-main">
        ${touchScheme === 'pro' ? renderProScheme()
          : touchScheme === 'reduced' ? renderReducedScheme()
          : renderDpadScheme()}
      </div>
    </nav>
  `;
}

// Un botón táctil con su acento por acción (mantiene el contrato data-touch-action).
function renderTouchButton(action: ControlAction, glyph: string, extra = ''): string {
  return `
    <button class="touch-button touch-button-${action} ${extra}" type="button"
            data-touch-action="${action}" aria-label="${CONTROL_ACTION_LABELS[action]}">
      ${glyph}
    </button>
  `;
}

// Pro: ergonomía a dos pulgares, hard drop primario. (recomendado)
function renderProScheme(): string {
  return `
    <div class="touch-side touch-side-left">
      ${renderTouchButton('hold', 'HOLD', 'touch-wide')}
      <div class="touch-pair">
        ${renderTouchButton('moveLeft', '◀')}
        ${renderTouchButton('moveRight', '▶')}
      </div>
      ${renderTouchButton('softDrop', 'SOFT ▾', 'touch-wide')}
    </div>
    <div class="touch-side touch-side-right">
      <div class="touch-pair touch-pair-rot">
        ${renderTouchButton('rotateCCW', '↺')}
        ${renderTouchButton('rotateCW', '↻', 'touch-big')}
      </div>
      ${renderTouchButton('hardDrop', '⤓ DROP', 'touch-wide touch-drop')}
    </div>
  `;
}

// Simple: mínima carga cognitiva. Un solo botón de rotación, sin 180.
function renderReducedScheme(): string {
  return `
    <div class="touch-side touch-side-left">
      <div class="touch-pair">
        ${renderTouchButton('moveLeft', '◀')}
        ${renderTouchButton('moveRight', '▶')}
      </div>
      ${renderTouchButton('softDrop', '▾ SOFT', 'touch-wide')}
    </div>
    <div class="touch-side touch-side-right">
      <div class="touch-pair">
        ${renderTouchButton('rotateCW', '↻<small>ROTAR</small>', 'touch-rotate-main')}
        ${renderTouchButton('hold', 'HOLD')}
      </div>
      ${renderTouchButton('hardDrop', '⤓ DROP', 'touch-wide touch-drop')}
    </div>
  `;
}

// D-pad: cruceta de movimiento + abanico de acciones redondas.
function renderDpadScheme(): string {
  return `
    <div class="touch-dpad">
      ${renderTouchButton('moveLeft', '◀', 'dpad-left')}
      ${renderTouchButton('moveRight', '▶', 'dpad-right')}
      ${renderTouchButton('softDrop', '▼', 'dpad-down')}
      <span class="dpad-hub">MOVE</span>
    </div>
    <div class="touch-side touch-side-right touch-fan">
      <div class="touch-pair touch-pair-rot">
        ${renderTouchButton('rotateCCW', '↺', 'touch-round')}
        ${renderTouchButton('rotateCW', '↻', 'touch-round touch-big')}
      </div>
      <div class="touch-pair">
        ${renderTouchButton('hold', 'HOLD', 'touch-round')}
        ${renderTouchButton('hardDrop', '⤓', 'touch-round touch-drop')}
      </div>
    </div>
  `;
}

function requestRunConfirmation(action: DestructiveRunAction): void {
  pendingConfirmAction = action;
  lunaState.pendingLaunchRequest = null;
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
  if (action === 'leave-room-for-local') leaveRoomAndStartLocalVersus();
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
  if (roomState.current) {
    description = `Para unirte vas a salir de la sala ${escapeHtml(roomState.current.id)} en este dispositivo.`;
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
  // La invitación de Luna durante una partida NO bloquea: se muestra como toast
  // clicable (ver renderLunaInviteToast) y el juego sigue corriendo.
  return pendingConfirmAction !== null || (lunaState.pendingLaunchRequest !== null && !lunaInviteShowsAsToast());
}

// Con el juego corriendo (o pausado), la invitación se presenta como toast no
// invasivo en vez del modal de pantalla completa. En menús se mantiene el modal.
function lunaInviteShowsAsToast(): boolean {
  return appMode === 'playing'
    || appMode === 'soloCountdown'
    || appMode === 'paused'
    || appMode === 'onlinePlaying'
    || appMode === 'onlineCountdown';
}

function renderLunaInviteToast(request: PendingLunaLaunchRequest): string {
  return `
    <div class="luna-invite-toast" role="status" aria-live="polite">
      <div class="luna-invite-toast-body">
        <span class="luna-invite-toast-eyebrow">LUNA NEGRA</span>
        <strong>Te invitaron a ${escapeHtml(request.normalizedRoomId)}</strong>
      </div>
      <div class="luna-invite-toast-actions">
        <button class="luna-invite-toast-btn luna-invite-toast-btn-accept" type="button" data-ui-action="luna-launch-accept">Unirme</button>
        <button class="luna-invite-toast-btn" type="button" data-ui-action="luna-launch-cancel">Ignorar</button>
      </div>
    </div>
  `;
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
  const publicRooms = roomState.publicRooms.length === 0
    ? '<div class="online-empty">Todavía no hay salas públicas. Creá una.</div>'
    : roomState.publicRooms.map((room) => `
      <article class="cs2-room-row">
        ${renderOnlineAvatar({ name: room.hostName, avatarUrl: room.hostAvatarUrl })}
        <div class="cs2-room-row-info">
          <strong>${escapeHtml(room.id)}</strong>
          <span>${escapeHtml(room.hostName)} · ${room.playerCount} jugador${room.playerCount === 1 ? '' : 'es'} · ${escapeHtml(roomStatusLabel(room.status))}</span>
        </div>
        <button class="cs2-btn cs2-btn-accent" type="button" data-ui-action="online-join-public" data-room-id="${escapeHtml(room.id)}"${onlineNetState.busy ? ' disabled' : ''}>Unirse</button>
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
          <button class="cs2-btn cs2-btn-accent" type="button" data-ui-action="online-create-public"${onlineNetState.busy ? ' disabled' : ''}>Crear sala</button>
          <button class="cs2-btn" type="button" data-ui-action="online-create-private"${onlineNetState.busy ? ' disabled' : ''}>Sala privada</button>
        </div>
        <div class="online-join-row">
          <label class="online-field">
            <span>Código de sala</span>
            <input type="text" maxlength="${ROOM_ID_MAX_LENGTH}" value="${escapeHtml(identityState.joinCode)}" data-online-field="join-code" autocomplete="off" />
          </label>
          <button class="cs2-btn" type="button" data-ui-action="online-join"${onlineNetState.busy ? ' disabled' : ''}>Unirse por código</button>
        </div>
      </section>
      <section class="cs2-card cs2-rooms" style="margin-bottom: 0;">
        <div class="cs2-card-head">
          <span>Salas públicas</span>
          <button class="cs2-btn cs2-btn-ghost cs2-btn-sm" type="button" data-ui-action="online-refresh"${onlineNetState.busy ? ' disabled' : ''}>Refrescar</button>
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
  if (lunaState.identity) {
    return `
      <div class="cs2-identity">
        ${renderOnlineAvatar({ name: lunaState.identity.name, avatarUrl: lunaState.identity.avatarUrl }, 'small')}
        <div>
          <strong>${escapeHtml(lunaState.identity.name)}</strong>
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
      <button class="cs2-btn cs2-btn-accent cs2-btn-sm cs2-identity-action" type="button" data-ui-action="luna-login"${lunaState.inviteWindowBusy ? ' disabled' : ''}>
        ${lunaState.inviteWindowBusy ? 'Abriendo...' : 'Iniciar sesión'}
      </button>
    </div>
  `;
}

// ───────────────────────── Lobby online ─────────────────────

function renderOnlineLobbyPanelContent(): string {
  const room = roomState.current;
  if (!room) return renderOnlineMenuPanelContent();
  const player = currentOnlinePlayer();
  const host = room.hostPlayerId === identityState.player.id;
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
            ${host ? `<span class="cs2-start-hint">El host arranca con ▶ arriba</span>` : ''}`
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
  const unavailable = !lunaState.identity?.gameId;
  const status = lunaState.inviteNotice
    ? lunaState.inviteNotice
    : unavailable
      ? 'Entrá desde Luna Negra para ver amigos e invitarlos.'
      : 'Luna Negra abre la lista de amigos.';
  const action = unavailable ? 'luna-login' : 'online-open-invite';
  const label = unavailable ? 'Iniciar sesión' : 'Invitar amigo';
  return `
    <section class="cs2-invite-action" aria-label="Invitar amigo">
      <button class="cs2-btn cs2-btn-accent" type="button" data-ui-action="${action}"${onlineNetState.busy || lunaState.inviteWindowBusy ? ' disabled' : ''}>
        ${lunaState.inviteWindowBusy ? 'Abriendo...' : label}
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
  const remainingMs = Math.max(0, runState.soloCountdownStartsAtMs - performance.now());
  return renderCountdownStage(remainingMs, '');
}

// Cuenta regresiva animada compartida (solo + online). Dirigida por frame (el
// overlay se reconstruye cada frame): el número entra grande y se asienta mientras
// un anillo se expande detrás; ambos se desvanecen al final del segundo. La leyenda
// opcional aparece debajo (p. ej. la sala en multijugador).
function renderCountdownStage(remainingMs: number, caption: string): string {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const numberText = `${seconds}`;
  const elapsed = seconds * 1000 - remainingMs; // 0 al aparecer -> 1000 al irse
  const appear = Math.min(1, elapsed / 220);
  const ease = 1 - Math.pow(1 - appear, 3);
  const fadeOut = Math.max(0, Math.min(1, (elapsed - 820) / 180));
  const numScale = (1.45 - 0.45 * ease) * (1 - 0.05 * appear);
  const numOpacity = Math.min(1, appear * 1.4) * (1 - fadeOut);
  const ringScale = 0.55 + ease * 1.05;
  const ringOpacity = (1 - appear) * 0.55;
  return `
    <div class="menu-scrim" style="background: radial-gradient(circle at center, rgba(12, 18, 30, 0.45), rgba(6, 9, 16, 0.7)) !important; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;">
      <div style="position: relative; display: flex; align-items: center; justify-content: center; width: 280px; height: 280px;">
        <div style="position: absolute; width: 220px; height: 220px; border-radius: 50%; border: 4px solid rgba(0, 245, 255, ${ringOpacity.toFixed(3)}); box-shadow: 0 0 40px rgba(0, 245, 255, ${(ringOpacity * 0.8).toFixed(3)}); transform: scale(${ringScale.toFixed(3)});"></div>
        <div style="font-size: 180px; font-weight: 900; font-family: 'Arial Black', system-ui, sans-serif; line-height: 1; color: #eafdff; text-shadow: 0 0 45px rgba(0, 245, 255, 0.75), 0 0 18px rgba(176, 107, 255, 0.65); transform: scale(${numScale.toFixed(3)}); opacity: ${numOpacity.toFixed(3)};">${numberText}</div>
      </div>
      ${caption ? `<div style="color: rgba(234, 253, 255, 0.78); font-family: system-ui, -apple-system, sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 2px;">${caption}</div>` : ''}
    </div>
  `;
}

function renderOnlineCountdownOverlay(): string {
  if (!roomState.current?.startsAtServerMs) return renderOnlineLobbyOverlay();
  // Reloj del servidor (compartido por todos), no el reloj local del solo.
  const remainingMs = Math.max(0, roomState.current.startsAtServerMs - onlineNowMs());
  return renderCountdownStage(remainingMs, `SALA ${escapeHtml(roomState.current.id)} · ÚLTIMO EN PIE GANA`);
}

function renderOnlineResultsOverlay(state: GameState): string {
  const room = roomState.current;
  const ranked = room ? rankPlayers(room.players) : [];
  const bet = room?.bet;
  const mustClaimBeforeLeaving = bet
    ? myBetEntry(bet)?.payoutStatus === 'withdraw_pending'
    : false;
  const winnerSats = bet && (bet.status === 'settled' || bet.status === 'funded') ? bet.netPayoutSats : null;
  // Frame en que terminó la partida = el del último rival eliminado. El ganador sigue
  // vivo, así que su elapsedFrames quedó congelado en su último snapshot y puede ser
  // MENOR al de quien eliminó; mostrarlo crudo hacía que el "último en pie" figurara
  // sobreviviendo menos que su víctima. El ganador sobrevivió hasta este frame.
  const survivalFrameOf = (p: OnlinePlayer) => p.eliminatedAtFrame ?? p.elapsedFrames;
  const matchEndFrame = ranked.reduce((max, p) => Math.max(max, survivalFrameOf(p)), 0);
  const survivedFramesByIndex = ranked.map((player, index) =>
    index === 0
      ? Math.max(matchEndFrame, player.elapsedFrames)
      : survivalFrameOf(player),
  );
  // Los ms solo aportan cuando dos jugadores caen en el mismo segundo (mismo mm:ss):
  // ahí distinguen quién sobrevivió más. Si cada uno tiene su propio segundo, son ruido.
  const countBySecond = new Map<number, number>();
  for (const frames of survivedFramesByIndex) {
    const whole = Math.floor(frames / 60);
    countBySecond.set(whole, (countBySecond.get(whole) ?? 0) + 1);
  }
  const rows = ranked
    .map((player, index) => {
      const survivedFrames = survivedFramesByIndex[index];
      const showMillis = (countBySecond.get(Math.floor(survivedFrames / 60)) ?? 0) > 1;
      return renderOnlineRankingRow(player, index, winnerSats, survivedFrames, showMillis);
    })
    .join('');
  // La ronda puede seguir corriendo (p. ej. quedé eliminado y el server aún no
  // cerró la sala): nadie puede relanzar hasta que termine de verdad.
  const roundOver = room?.status === 'finished';
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
          ${onlineReplayCollector.size() > 0
            ? '<button class="solo-results-btn solo-results-btn--ghost" type="button" data-ui-action="online-replay-open">Ver repetición</button>'
            : ''}
          ${roundOver && canReplayLastSeconds(state)
            ? `<button class="solo-results-btn solo-results-btn--ghost" type="button" data-ui-action="replay-last-seconds">Ver mis últimos ${DEATH_REPLAY_SECONDS}s</button>`
            : ''}
        </div>
        ${renderReportBlock()}
        <div class="online-results-next">
          ${mustClaimBeforeLeaving
            ? '<button class="solo-results-btn solo-results-btn--next" type="button" disabled title="Cobrá el retiro antes de continuar">Cobrá antes de continuar</button>'
            : '<button class="solo-results-btn solo-results-btn--next" type="button" data-ui-action="online-results-menu">Siguiente</button>'}
        </div>
      </div>
    </div>
  `;
}

// Bloque "Reportar problema" de las pantallas de resultados (solo + online). Siempre visible.
// Manda al dev un reporte de performance completo (jank/lag/snaps/longtasks + errores de runtime
// + device + contexto de sala) con un comentario opcional del jugador. El estado del botón refleja
// el envío en curso/hecho/fallido; el overlay se reconstruye cada frame, así que se actualiza solo.
function renderReportBlock(): string {
  const sending = reportState.buttonState === 'sending';
  const sent = reportState.buttonState === 'sent';
  const includesWithdrawDiagnostics = roomBetEntryForLocalPlayer(roomState.current)?.payoutStatus === 'withdraw_pending';
  const label = sent ? '✓ ¡Gracias! Reporte enviado'
    : sending ? 'Enviando…'
    : reportState.buttonState === 'error' ? '⚠ No se pudo enviar — reintentar'
    : '📨 Reportar problema';
  const btnClass = `solo-results-btn solo-results-btn--ghost report-block-btn${sent ? ' is-sent' : ''}${reportState.buttonState === 'error' ? ' is-error' : ''}`;
  const disabledAttr = sending || sent ? ' disabled' : '';
  return `
    <div class="report-block">
      <input type="text" class="report-comment" maxlength="400" value="${escapeHtml(reportState.comment)}"
        data-online-field="report-comment" autocomplete="off"
        placeholder="¿Qué pasó? (lag, tirones…) — opcional"${sent ? ' disabled' : ''} />
      <button class="${btnClass}" type="button" data-ui-action="report-perf"${disabledAttr}>${label}</button>
      ${includesWithdrawDiagnostics
        ? '<small class="bet-settle-hint">El reporte incluye el historial del QR, retiro y fuentes de actualización.</small>'
        : ''}
    </div>
  `;
}

// Abre el visor multi-tablero con los logs recolectados de la ronda. Lo dispara
// el botón "Ver repetición" de los resultados (solo aparece si hay logs).
function openMultiReplay(): void {
  const roomId = roomState.current?.id ?? 'sala';
  const pkg = onlineReplayCollector.build(roomId);
  if (!pkg) {
    onlineNetState.error = 'No hay repeticiones disponibles para esta ronda.';
    return;
  }
  multiReplayState.playback = new MultiReplayPlayback(pkg);
  resetReplayClock();
  multiReplayState.returnRoomId = roomId;
  onlineNetState.error = null;
  buildMultiReplayDom(multiReplayState.playback.snapshot());
  appMode = 'onlineReplay';
  beginReplayReadyHold();
}

function exitMultiReplay(): void {
  endReplayReadyHold();
  multiReplayState.playback = null;
  multiReplayState.cards = [];
  multiReplayOverlayElement.innerHTML = '';
  appMode = 'onlineResults';
}

// Construye una sola vez el DOM del visor: scrim + grilla con una tarjeta (canvas
// + placa) por jugador + controles. Los canvas se conservan y se redibujan por
// frame en drawMultiReplayFrame (no se recrea el DOM, ver multiReplayOverlayElement).
function buildMultiReplayDom(snapshot: MultiReplayPlaybackSnapshot): void {
  const speedButtons = REPLAY_SPEEDS.map((speed) => (
    `<button class="solo-results-btn solo-results-btn--ghost" type="button" data-ui-action="multi-replay-speed" data-speed="${speed}">${speed}x</button>`
  )).join('');
  const cards = snapshot.players.map((player) => `
    <section class="multi-replay-card" data-mr-player="${escapeHtml(player.playerId)}">
      <div class="multi-replay-stage">
        <canvas data-mr-canvas></canvas>
        <div class="multi-replay-tag" data-mr-tag></div>
      </div>
      <div class="multi-replay-plate">
        <strong>${escapeHtml(player.name)}</strong>
        <span data-mr-stat></span>
      </div>
    </section>
  `).join('');
  multiReplayOverlayElement.innerHTML = `
    <div class="menu-scrim multi-replay-scrim">
      <div class="multi-replay-shell">
        <div class="multi-replay-head">
          <div class="online-results-eyebrow">REPETICIÓN · SALA ${escapeHtml(multiReplayState.returnRoomId ?? '')}</div>
          <div class="multi-replay-clock" data-mr-clock></div>
        </div>
        <div class="multi-replay-grid" data-mr-grid>${cards}</div>
        <div class="online-results-actions multi-replay-controls">
          <button class="solo-results-btn solo-results-btn--ghost" type="button" data-ui-action="multi-replay-toggle" data-mr-toggle></button>
          <button class="solo-results-btn solo-results-btn--ghost" type="button" data-ui-action="multi-replay-restart">Reiniciar</button>
          ${speedButtons}
          <button class="solo-results-btn solo-results-btn--danger" type="button" data-ui-action="multi-replay-exit">Cerrar</button>
        </div>
      </div>
    </div>
  `;
  multiReplayState.cards = snapshot.players.map((player) => {
    const card = multiReplayOverlayElement.querySelector<HTMLElement>(`[data-mr-player="${cssAttrEscape(player.playerId)}"]`)!;
    return {
      playerId: player.playerId,
      card,
      canvas: card.querySelector<HTMLCanvasElement>('[data-mr-canvas]')!,
      tag: card.querySelector<HTMLElement>('[data-mr-tag]')!,
      stat: card.querySelector<HTMLElement>('[data-mr-stat]')!,
    };
  });
}

// Tamaño de cada tablero para que entren todos en pantalla, respetando el aspecto
// 1:2 (ancho:alto) de un tablero estándar. Reusa la lógica de columnas del modo
// espectador para que la grilla se sienta igual que en vivo.
function multiReplayLayout(count: number): { columns: number; boardW: number; boardH: number } {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const columns = onlinePeerGridColumns(count, width);
  const rows = Math.ceil(count / columns);
  const gap = 14;
  const plateH = 30;
  const availW = width * 0.96 - gap * (columns - 1);
  const availH = height - 150 - gap * (rows - 1);
  const cell = Math.max(6, Math.floor(Math.min((availW / columns) / 10, (availH / rows - plateH) / 20)));
  return { columns, boardW: cell * 10, boardH: cell * 20 };
}

function drawMultiReplayFrame(snapshot: MultiReplayPlaybackSnapshot): void {
  if (multiReplayState.cards.length === 0) return;
  const layout = multiReplayLayout(snapshot.players.length);
  const grid = multiReplayOverlayElement.querySelector<HTMLElement>('[data-mr-grid]');
  if (grid) grid.style.gridTemplateColumns = `repeat(${layout.columns}, max-content)`;
  setMrText('[data-mr-clock]', `${formatFrames(snapshot.frame)} / ${formatFrames(snapshot.targetFrame)}`);
  setMrText('[data-mr-toggle]', snapshot.paused ? 'Reanudar' : 'Pausa');
  for (const button of multiReplayOverlayElement.querySelectorAll<HTMLElement>('[data-ui-action="multi-replay-speed"]')) {
    button.classList.toggle('button-active', Number(button.dataset.speed) === snapshot.speed);
  }
  const byId = new Map(snapshot.players.map((player) => [player.playerId, player]));
  for (const entry of multiReplayState.cards) {
    const player = byId.get(entry.playerId);
    if (!player) continue;
    sizeBoardCanvas(entry.canvas, layout.boardW, layout.boardH);
    drawBoardToCanvas(entry.canvas, player.state, { colorBlind: customSettings.colorBlindMode });
    setMrCardState(entry, player);
  }
}

function setMrCardState(entry: MultiReplayCard, player: MultiReplayPlayerSnapshot): void {
  const dead = player.state.status === 'gameover';
  const won = player.state.status === 'finished';
  const tagText = dead ? 'K.O.' : won ? 'FINISH' : '';
  if (entry.tag.textContent !== tagText) entry.tag.textContent = tagText;
  entry.tag.className = `multi-replay-tag${dead ? ' multi-replay-tag--ko' : won ? ' multi-replay-tag--win' : ''}`;
  entry.card.classList.toggle('is-dead', dead);
  const stat = `${player.state.stats.lines} L · ${formatFrames(player.state.stats.frame)}`;
  if (entry.stat.textContent !== stat) entry.stat.textContent = stat;
}

function setMrText(selector: string, value: string): void {
  const el = multiReplayOverlayElement.querySelector(selector);
  if (el && el.textContent !== value) el.textContent = value;
}

// Escapa un valor para usarlo dentro de un selector de atributo CSS.
function cssAttrEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function renderOnlineRankingRow(
  player: OnlinePlayer,
  index: number,
  winnerSats: number | null,
  survivedFrames: number,
  showMillis: boolean,
): string {
  const isWinner = index === 0;
  const isSelf = player.id === identityState.player.id;
  const time = formatFrames(survivedFrames, showMillis);
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
        <div class="online-results-metric" title="Rivales que eliminaste"><span>KO</span><strong class="is-amber">${player.koCount}</strong></div>
        <div class="online-results-metric" title="Líneas que completaste"><span>LÍNEAS</span><strong>${player.lines}</strong></div>
        <div class="online-results-metric" title="Líneas de basura que enviaste a tus rivales"><span>ATAQUE</span><strong>${player.sentGarbage}</strong></div>
        <div class="online-results-metric" title="Sats que ganaste"><span>SATS</span><strong class="${isWinner && winnerSats ? 'is-green' : 'is-muted'}">${sats}</strong></div>
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

// Toast compacto y no bloqueante al perder en online: aparece arriba del todo,
// poco texto, y se desvanece solo (animación CSS). Nunca tapa los tableros: vive
// por encima de la grilla de espectador (que arranca más abajo).
function renderOnlineKoToast(banner: { placement: string; won: boolean }): string {
  const tag = banner.won ? 'FINISH' : 'K.O.';
  return `
    <div class="online-ko-toast ${banner.won ? 'online-ko-toast--win' : ''}" aria-live="assertive">
      <span class="online-ko-toast-tag">${tag}</span>
      ${banner.placement ? `<span class="online-ko-toast-place">${escapeHtml(banner.placement)}</span>` : ''}
    </div>
  `;
}

// Aviso de conexión/desconexión de mandos. Vive en su propia capa persistente
// (gamepadToastElement) y se desvanece solo por CSS; el setTimeout limpia el nodo
// al terminar para que un mando reconectado vuelva a animar desde cero.
let gamepadToastTimer: ReturnType<typeof setTimeout> | null = null;
function showGamepadToast(message: string, change: 'connected' | 'disconnected'): void {
  if (gamepadToastTimer) clearTimeout(gamepadToastTimer);
  const icon = change === 'connected' ? '🎮' : '⚠️';
  gamepadToastElement.innerHTML = `
    <div class="gamepad-toast gamepad-toast--${change}" role="status" aria-live="polite">
      <span class="gamepad-toast-icon" aria-hidden="true">${icon}</span>
      <span class="gamepad-toast-text">${escapeHtml(message)}</span>
    </div>
  `;
  gamepadToastTimer = setTimeout(() => {
    gamepadToastElement.innerHTML = '';
    gamepadToastTimer = null;
  }, 3200);
}

// El id del Gamepad API es ruidoso ("Xbox 360 Controller (XInput STANDARD GAMEPAD)",
// pares vendor/product en hex, etc.). Detectamos la familia por palabras clave para
// un aviso amable; si no reconocemos nada, caemos a un genérico.
function friendlyGamepadName(id: string | null): string {
  const text = (id ?? '').toLowerCase();
  if (/dualsense|0ce6|playstation 5|ps5/.test(text)) return 'Mando de PlayStation 5';
  if (/dualshock|0[59]c4|playstation|ps[34]|054c/.test(text)) return 'Mando de PlayStation';
  if (/xbox|xinput|045e/.test(text)) return 'Mando de Xbox';
  if (/switch|joy-con|pro controller|057e|nintendo/.test(text)) return 'Mando de Nintendo Switch';
  if (/steam|valve|28de/.test(text)) return 'Steam Controller';
  return 'Mando';
}

// Solo los tableros rivales viven en el overlay general (se redibujan cada frame
// por el cronómetro vivo). El HUD interactivo se pinta en su propia capa, ver
// renderOverlay/hudOverlayElement.
function renderOnlinePlayingOverlay(): string {
  if (!roomState.current) return '';
  return renderOnlinePeerBoards();
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
  // 'battle' = la modalidad Supervivencia online (reglas fijas, top justo).
  if (matchType === 'battle') return 'Supervivencia';
  if (matchType === 'custom') return 'Custom';
  return 'Custom';
}

// Etiquetas en español de las estrategias de objetivo de tetr.io.
function targetingModeLabel(mode: TargetingMode): string {
  if (mode === 'manual') return 'Manual';
  if (mode === 'even') return 'Parejo';
  if (mode === 'ko') return 'Eliminación';
  if (mode === 'attackers') return 'Contraataque';
  return 'Aleatorio';
}

// Descripción de una línea para la barra de objetivo.
function targetingModeHint(mode: TargetingMode): string {
  if (mode === 'manual') return 'Elegís vos';
  if (mode === 'even') return 'Reparte parejo';
  if (mode === 'ko') return 'Al que va a morir';
  if (mode === 'attackers') return 'A quien te ataca';
  return 'Al azar';
}

// HUD inferior compacto de una sola fila: garbage entrante + estrategias de
// objetivo (teclas 1–5, estilo tetr.io) + salir. Reemplaza al panel lateral
// grande y se mantiene fino para no tapar el tablero.
function renderOnlineHud(): string {
  if (!roomState.current) return '';
  const player = currentOnlinePlayer();
  const activeMode = player?.targetingMode ?? roomState.current.ruleset.targeting;
  const showTargeting = roomState.current.players.length > 2 && !!player;
  const pending = engine.getState().stats.pendingGarbage;
  const liveTargets = showTargeting
    ? roomState.current.players.filter((candidate) => (
        candidate.id !== player!.id
        && candidate.alive
        && candidate.status !== 'eliminated'
        && candidate.status !== 'winner'
        && candidate.status !== 'disconnected'
      ))
    : [];
  const target = roomState.current.players.find((candidate) => candidate.id === player?.currentTargetPlayerId)
    ?? liveTargets.find((candidate) => candidate.id === player?.manualTargetPlayerId)
    ?? null;
  return `
    <div class="online-hud" aria-label="HUD online">
      <span class="online-hud-incoming${pending > 0 ? ' is-hot' : ''}" title="Garbage entrante" aria-label="Garbage entrante: ${pending}">
        <i aria-hidden="true"></i>${pending}
      </span>
      ${showTargeting ? `
        <div class="online-target-chips">
          ${TARGETING_MODES.map((mode, index) => `
            <button class="online-target-chip ${mode === activeMode ? 'is-active' : ''}" type="button" title="${escapeHtml(targetingModeHint(mode))}" data-ui-action="online-targeting" data-targeting-mode="${mode}">
              <span class="online-target-key">${index + 1}</span><span class="online-target-name">${escapeHtml(targetingModeLabel(mode))}</span>
            </button>
          `).join('')}
        </div>
        ${activeMode === 'manual' ? `
          <div class="online-target-manual">
            ${liveTargets.length === 0 ? '<em>sin rivales</em>' : liveTargets.map((candidate) => `
              <button class="online-target-manual-chip ${candidate.id === player!.manualTargetPlayerId ? 'is-active' : ''}" type="button" data-ui-action="online-manual-target" data-target-player-id="${escapeHtml(candidate.id)}">${escapeHtml(candidate.name)}</button>
            `).join('')}
          </div>
        ` : `<span class="online-target-now" title="Apuntando a">→ ${escapeHtml(target?.name ?? '—')}</span>`}
      ` : ''}
      <button type="button" class="online-hud-leave" data-ui-action="online-leave">Leave</button>
    </div>
  `;
}

function renderLobbyPlayer(player: OnlinePlayer, viewerIsHost = false): string {
  const isHost = player.id === roomState.current?.hostPlayerId;
  const isSelf = player.id === identityState.player.id;
  const badges = [
    isHost ? '<span class="cs2-badge cs2-badge-host">HOST</span>' : '',
    isSelf ? '<span class="cs2-badge cs2-badge-self">VOS</span>' : '',
  ].join('');
  // El host puede expulsar a cualquiera menos a sí mismo.
  const kick = viewerIsHost && !isSelf
    ? `<button class="cs2-kick" type="button" data-ui-action="online-kick" data-target-player-id="${escapeHtml(player.id)}" aria-label="Expulsar a ${escapeHtml(player.name)}"${onlineNetState.busy ? ' disabled' : ''}>✕</button>`
    : '';
  // Durante una ronda activa, quien no estaba listo (alive=false sin ser eliminado)
  // la juega de espectador: lo etiquetamos así en vez de "Sin listo", que en mitad
  // de la partida confunde.
  const roundActive = roomState.current?.status === 'playing' || roomState.current?.status === 'countdown';
  const spectating = roundActive && !player.alive && player.status !== 'eliminated' && player.status !== 'lost';
  const statusLabel = spectating ? '👁 Espectador' : player.ready ? '✓ Listo' : 'Sin listo';
  return `
    <div class="cs2-player-card ${player.ready ? 'cs2-player-ready' : ''} ${isSelf ? 'cs2-player-self' : ''}">
      ${kick}
      ${renderOnlineAvatar(player)}
      <div class="cs2-player-name">
        <strong>${escapeHtml(player.name)}</strong>
        <span class="cs2-player-badges">${badges}</span>
      </div>
      <span class="cs2-player-status ${player.ready ? 'is-ready' : ''}">${statusLabel}</span>
    </div>
  `;
}

function lunaNegraBettingBlockedReason(): string {
  if (!roomState.current) return '';
  if (roomState.current.players.length < 2) return 'Necesitás al menos 2 jugadores en la sala para apostar.';
  // Ya no hace falta que todos tengan cuenta: los invitados depositan por QR y, si
  // ganan, cobran por LNURL-withdraw (los que tienen cuenta cobran a su billetera).
  return '';
}

// Mi participante en la apuesta. Mapeo por playerId (estable en pozos mixtos: el
// invitado tiene un npub efímero ≠ al suyo), con fallback a npub para apuestas
// 100% con cuenta y compatibilidad con estados viejos sin playerId.
function myBetEntry(bet: RoomBet): RoomBetParticipant | undefined {
  const mine = currentOnlinePlayer();
  const byPlayer = bet.participants.find((entry) => entry.playerId && entry.playerId === identityState.player.id);
  if (byPlayer) return byPlayer;
  return mine?.npub ? bet.participants.find((entry) => entry.npub === mine.npub) : undefined;
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
  const player = roomState.current?.players.find((candidate) => candidate.npub === participant.npub || candidate.id === participant.playerId);
  if (player) return player.name;
  return `${participant.npub.slice(0, 8)}…${participant.npub.slice(-4)}`;
}

function canRetryBetInvoiceGeneration(bet: RoomBet, host: boolean): boolean {
  if (!host || bet.status !== 'pending_deposits') return false;
  if (bet.depositsReceived > 0) return false;
  if (bet.participants.some((entry) => entry.depositStatus === 'paid')) return false;
  return bet.participants.some((entry) => (
    entry.depositStatus === 'pending'
    && !!entry.depositError
    && !entry.bolt11
    && !entry.lnurl
    && !entry.payUrl
  ));
}

function renderOnlineBetPanel(host: boolean): string {
  if (!roomState.current) return '';
  const bet = roomState.current.bet;

  if (!bet) {
    // La apuesta pertenece a la sala, no a la identidad Nostr del host. Un host
    // anónimo también puede crearla: Luna Negra asigna identidades efímeras a
    // todos los jugadores sin npub y luego les ofrece retiro por LNURL.
    if (!host) return '';
    // No mostramos el panel de crear apuesta hasta que haya con quién apostar:
    // con una sola persona en la sala no tiene sentido ofrecer el pozo.
    if (roomState.current.players.length < 2) return '';
    const blocked = lunaNegraBettingBlockedReason();
    const canCreate = !blocked && !betState.busy && !betState.creating;
    return `
      <section class="online-bet-panel${betState.creating ? ' online-bet-panel--creating' : ''}">
        <div class="online-bet-head">
          <span>Apuesta opcional</span>
          <small>Luna Negra</small>
        </div>
        <p class="online-bet-note">Pozo compartido: todos depositan lo mismo y el ganador cobra el saldo final.</p>
        <div class="online-bet-create-row">
          <input type="text" inputmode="numeric" class="dash-input online-bet-input" maxlength="7" value="${escapeHtml(betState.stakeInput)}" data-online-field="bet-stake" autocomplete="off" placeholder="ej. 50"${betState.creating ? ' disabled' : ''} />
          <button class="dash-action-btn accent online-bet-create-button" type="button" data-ui-action="online-bet-create"${canCreate ? '' : ' disabled'}>${betState.creating ? `${BET_SPINNER}<span>Creando…</span>` : 'Crear'}</button>
        </div>
        ${betState.creating
          ? '<p class="online-bet-note">⏳ Generando los invoices de pago en Luna Negra… puede tardar unos segundos.</p>'
          : ''}
        ${blocked ? `<p class="online-bet-note online-bet-warning">Atención: ${escapeHtml(blocked)}</p>` : ''}
      </section>
    `;
  }

  const myEntry = myBetEntry(bet);
  const rows = bet.participants.map((entry) => `
    <div class="online-bet-row">
      <span>${escapeHtml(betParticipantName(entry))}</span>
      <span>${depositStatusLabel(entry.depositStatus)}</span>
    </div>
  `).join('');

  const myDepositPending = !!myEntry && myEntry.depositStatus === 'pending';
  const myHasPayHandles = !!(myEntry && (myEntry.bolt11 || myEntry.lnurl || myEntry.payUrl));
  const myLightningDepositPayload = myEntry?.bolt11 || myEntry?.lnurl || '';
  const myDeposit = myDepositPending && myHasPayHandles
    ? `
      <div class="online-bet-deposit" data-bet-deposit>
        <strong>Depositá tus ${bet.stakeSats} sats:</strong>
        ${myLightningDepositPayload
          ? `<button class="dash-action-btn success online-bet-wallet-link" type="button" data-ui-action="online-bet-open-wallet" data-lightning="${escapeHtml(myLightningDepositPayload)}">📱 Abrir wallet Lightning</button>`
          : ''}
        ${myEntry!.bolt11 ? renderBetInvoiceQr(myEntry!.bolt11) : ''}
        <div class="online-bet-deposit-actions">
          ${myEntry!.bolt11 ? `<button class="dash-action-btn accent online-bet-webln" type="button" data-ui-action="online-bet-webln" data-invoice="${escapeHtml(myEntry!.bolt11)}"${betState.paying ? ' disabled' : ''}>⚡ Pagar con extensión</button>` : ''}
          ${myEntry!.payUrl ? `<a class="dash-action-btn accent online-bet-pay" href="${escapeHtml(myEntry!.payUrl)}" target="_blank" rel="noopener" data-ui-action="online-bet-pay">Pagar en Luna Negra</a>` : ''}
          ${myEntry!.bolt11 ? `<button class="dash-copy-btn" type="button" data-ui-action="online-bet-copy" data-copy="${escapeHtml(myEntry!.bolt11)}">Copiar invoice</button>` : ''}
          ${myEntry!.lnurl ? `<button class="dash-copy-btn" type="button" data-ui-action="online-bet-copy" data-copy="${escapeHtml(myEntry!.lnurl)}">Copiar LNURL</button>` : ''}
        </div>
      </div>
    `
    : myDepositPending
      // Depósito pendiente pero Luna Negra todavía no devolvió los handles de pago
      // (bolt11/payUrl). Si vino `depositError`, mostramos el motivo real (NWC sin
      // permiso make-invoice, budget agotado, relay caído); si no, asumimos que se
      // está generando. En ambos casos el polling reintenta solo y ofrecemos un
      // reintento manual, en vez de un panel mudo sin forma de pagar.
      ? `
      <div class="online-bet-deposit" data-bet-deposit>
        <strong>Depositá tus ${bet.stakeSats} sats:</strong>
        ${myEntry!.depositError
          ? `<p class="online-bet-note online-bet-warning">⚠️ No se pudo generar el invoice de pago: ${escapeHtml(myEntry!.depositError)}. Reintentando…</p>`
          : `<p class="online-bet-note">⏳ Generando el invoice de pago… Si tarda, tocá «Actualizar».</p>`}
        <div class="online-bet-deposit-actions">
          <button class="dash-copy-btn" type="button" data-ui-action="online-bet-refresh"${betState.busy ? ' disabled' : ''}>Actualizar</button>
        </div>
      </div>
    `
      : '';

  const terminal = ['settled', 'cancelled', 'expired', 'refunded'].includes(bet.status);
  const retryInvoice = canRetryBetInvoiceGeneration(bet, host)
    ? `<button class="dash-copy-btn" type="button" data-ui-action="online-bet-retry"${betState.busy ? ' disabled' : ''}>Reintentar invoice</button>`
    : '';

  // Barra de progreso del pozo: cuántos depósitos entraron sobre el total. Da una
  // lectura de un vistazo de "cuánto falta para arrancar" sin leer cada fila.
  const potPct = bet.potTargetSats > 0 ? Math.min(100, Math.round((bet.potSats / bet.potTargetSats) * 100)) : 0;
  const progress = !terminal
    ? `
      <div class="bet-pot">
        <div class="bet-pot-bar"><span style="width:${potPct}%"></span></div>
        <div class="bet-pot-meta">
          <span>${bet.potSats}/${bet.potTargetSats} sats</span>
          <span>${bet.depositsReceived}/${bet.depositsTotal} depósitos</span>
        </div>
      </div>
    `
    : '';

  // Confirmación personal calma: una vez que pagué, no quiero seguir viendo el QR ni
  // dudar si entró. `myDeposit` ya devuelve '' si mi depósito no está pendiente.
  const myPaidConfirm = myEntry?.depositStatus === 'paid' && bet.status === 'pending_deposits'
    ? `<p class="online-bet-note bet-paid-ok">✅ Pagaste tus ${bet.stakeSats} sats. Esperando a los demás…</p>`
    : '';

  return `
    <section class="online-bet-panel">
      <div class="online-bet-head">
        <span>Apuesta · ${escapeHtml(betStatusLabel(bet.status))}</span>
        <small>${bet.feePct ? `comisión ${bet.feePct}%` : `comisión ${bet.feeSats} sats`}</small>
      </div>
      <p class="online-bet-note">Apostás <strong>${bet.stakeSats} sats</strong> · ganás <strong>${bet.netPayoutSats} sats</strong> si quedás último en pie.</p>
      ${progress}
      <div class="online-bet-rows">
        ${rows}
      </div>
      ${myPaidConfirm}
      ${myDeposit}
      <div class="online-bet-actions">
        <button class="dash-copy-btn" type="button" data-ui-action="online-bet-refresh"${betState.busy ? ' disabled' : ''}>Actualizar</button>
        ${retryInvoice}
        ${host && !terminal ? `<button class="dash-copy-btn dash-kick-btn" type="button" data-ui-action="online-bet-cancel"${betState.busy ? ' disabled' : ''}>Cancelar apuesta</button>` : ''}
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
  return ensureBetQr(bolt11, `lightning:${bolt11.toUpperCase()}`);
}

// QR del LNURL-withdraw del ganador invitado: lo escanea con su billetera para
// llevarse el pozo (no tiene wallet asociada a la que pagarle automático).
function renderBetWithdrawQr(lnurl: string): string {
  recordBetWithdrawalTrace('withdraw-render');
  const dataUrl = ensureBetQr(lnurl, lnurl.toUpperCase());
  if (!dataUrl) return '<div class="online-bet-qr online-bet-qr-loading">Generando QR…</div>';
  return `
    <div class="online-bet-qr-wrap">
      <img class="online-bet-qr" src="${dataUrl}" alt="QR de retiro Lightning" decoding="async" />
      <span class="online-bet-qr-hint">Escaneá con tu billetera Lightning para cobrar</span>
    </div>
  `;
}

// Genera (y cachea) el QR de un payload Lightning. `key` identifica el handle
// (bolt11/lnurl) para cachear; `payload` es lo que se codifica en el QR.
function ensureBetQr(key: string, payload: string): string | null {
  const cached = betQrDataUrls.get(key);
  if (cached) return cached;
  if (betQrPending.has(key)) return null;
  betQrPending.add(key);
  void QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 4,
    scale: 8,
    color: { dark: '#000000', light: '#ffffff' },
  })
    .then((url) => {
      betQrDataUrls.set(key, url);
      // El overlay se regenera solo cuando cambia el HTML; forzamos el repintado.
      overlayState.last = '';
    })
    .catch(() => {
      // Sin QR quedan los botones de cobrar/copiar.
    })
    .finally(() => {
      betQrPending.delete(key);
    });
  return null;
}

// Spinner inline de un solo elemento (CSS lo anima); seguro para reusar varias veces.
const BET_SPINNER = '<span class="bet-spinner" aria-hidden="true"></span>';

// ¿El jugador local es el ganador del pozo? Antes de liquidar nos basamos en el
// ranking de la sala; ya liquidada, en quién recibió payout (fuente de verdad).
// Un ganador invitado puede tener payoutSats=null con cobro `withdraw_pending`,
// así que también cuenta como ganador si su payout está en curso de retiro.
function amILocalBetWinner(bet: RoomBet): boolean {
  if (bet.status === 'settled') {
    const myEntry = myBetEntry(bet);
    if (!myEntry) return false;
    return (myEntry.payoutSats ?? 0) > 0
      || myEntry.payoutStatus === 'withdraw_pending'
      || myEntry.payoutStatus === 'claimed';
  }
  const winner = roomState.current ? rankPlayers(roomState.current.players)[0] : null;
  return !!winner && winner.id === identityState.player.id;
}

// Cobro del ganador INVITADO (sin billetera): QR de retiro LNURL + botón de
// extensión, espejando el modo local 1v1. El que tiene cuenta cobra automático.
function renderOnlineBetWithdraw(entry: RoomBetParticipant, bet: RoomBet): string {
  const amount = entry.payoutSats ?? bet.netPayoutSats;
  const lnurl = entry.withdrawLnurl!;
  return `
    <div class="bet-settle bet-settle--paid">
      <div class="bet-settle-title bet-settle-title--win"><span>💰 ¡Ganaste el pozo!</span></div>
      <div class="bet-settle-amount">+${amount.toLocaleString('es-AR')} <small>sats</small></div>
      <p class="bet-settle-hint">En el celular, abrí tu wallet Lightning. También podés escanear el QR desde otro dispositivo.</p>
      <button class="dash-action-btn success online-bet-wallet-link" type="button" data-ui-action="online-bet-open-wallet" data-lnurl="${escapeHtml(lnurl)}">📱 Abrir wallet Lightning</button>
      ${renderBetWithdrawQr(lnurl)}
      <div class="online-bet-deposit-actions">
        <button class="dash-action-btn accent online-bet-webln" type="button" data-ui-action="online-bet-claim-webln" data-lnurl="${escapeHtml(lnurl)}"${betState.paying ? ' disabled' : ''}>⚡ Cobrar con extensión</button>
        <button class="dash-copy-btn" type="button" data-ui-action="online-bet-copy" data-copy="${escapeHtml(lnurl)}">Copiar LNURL</button>
      </div>
      <p class="bet-settle-hint">Compatible con Wallet of Satoshi y otras wallets que acepten enlaces Lightning/LNURL.</p>
    </div>
  `;
}

// Card de liquidación: dos pasos (reportar → liquidar) con el activo animado y el
// hecho tildado, más una expectativa de tiempo. El pago Lightning puede tardar y
// el card lo comunica para que "esto sigue andando", no "se colgó".
function renderBetSettlementCard(reportDone: boolean, errorHtml: string): string {
  const step = (done: boolean, active: boolean, label: string) => {
    const cls = done ? 'is-done' : active ? 'is-active' : 'is-todo';
    const mark = done ? '✓' : active ? BET_SPINNER : '';
    return `<li class="bet-settle-step ${cls}"><span class="bet-settle-dot">${mark}</span><span>${label}</span></li>`;
  };
  return `
    <div class="bet-settle">
      <div class="bet-settle-title">${BET_SPINNER}<span>Pagando al ganador…</span></div>
      <ol class="bet-settle-steps">
        ${step(reportDone, !reportDone, 'Reportando el resultado')}
        ${step(false, reportDone, 'Liquidando el pago Lightning')}
      </ol>
      <p class="bet-settle-hint">El pago se completa solo. Por la red Lightning puede tardar hasta ~1 minuto.</p>
      ${errorHtml}
    </div>
  `;
}

function renderOnlineBetResult(): string {
  const bet = roomState.current?.bet;
  if (!bet) return '';
  const myEntry = myBetEntry(bet);
  const amIWinner = amILocalBetWinner(bet);
  const myAmount = (myEntry?.payoutSats ?? bet.netPayoutSats).toLocaleString('es-AR');

  // Cobro del ganador, decidido por SU payoutStatus (no por payoutSats: un retiro
  // pendiente, fallido o caducado también lleva payoutMsat). Así no le decimos
  // "acreditado a tu billetera" a quien en realidad todavía no cobró. Se limita
  // a apuestas resueltas y ganadas: los reembolsos usan los mismos payoutStatus.
  if (bet.status === 'settled' && amIWinner) {
    switch (myEntry?.payoutStatus) {
      case 'withdraw_pending':
        // Invitado sin billetera: cobra por LNURL-withdraw. Con handle → QR +
        // extensión; sin handle todavía (deploy/relay) → aviso para reintentar.
        if (myEntry.withdrawLnurl) return renderOnlineBetWithdraw(myEntry, bet);
        return `
          <div class="bet-settle">
            <div class="bet-settle-title">${BET_SPINNER}<span>¡Ganaste el pozo!</span></div>
            <div class="bet-settle-amount bet-settle-amount--pending">+${myAmount} <small>sats</small></div>
            <p class="bet-settle-hint">Tu retiro está pendiente, pero el QR todavía no está disponible. Tocá «Actualizar».</p>
            <div class="online-bet-deposit-actions"><button class="dash-copy-btn" type="button" data-ui-action="online-bet-refresh"${betState.busy ? ' disabled' : ''}>Actualizar</button></div>
          </div>
        `;
      case 'paid':
        return `
          <div class="bet-settle bet-settle--paid">
            <div class="bet-settle-title bet-settle-title--win"><span>💰 ¡Cobraste el pozo!</span></div>
            <div class="bet-settle-amount">+${myAmount} <small>sats</small></div>
            <p class="bet-settle-hint">Acreditados en tu billetera Lightning.</p>
          </div>
        `;
      case 'claimed':
        return `
          <div class="bet-settle bet-settle--paid">
            <div class="bet-settle-title bet-settle-title--win"><span>💰 ¡Cobraste el pozo!</span></div>
            <div class="bet-settle-amount">+${myAmount} <small>sats</small></div>
            <p class="bet-settle-hint">Retiro cobrado.</p>
          </div>
        `;
      case 'forfeited':
        return `<div class="panel-note bet-settle-muted">⌛ Ganaste, pero venció el plazo de 60 min para cobrar el retiro y el pozo se perdió.</div>`;
      case 'failed':
        return `
          <div class="bet-settle">
            <div class="bet-settle-title bet-settle-title--win"><span>Ganaste el pozo (+${myAmount} sats)</span></div>
            <p class="bet-settle-error">⚠️ El pago falló y Luna Negra lo reintentará automáticamente. Los sats siguen retenidos mientras tanto.</p>
            <div class="online-bet-deposit-actions"><button class="dash-copy-btn" type="button" data-ui-action="online-bet-refresh"${betState.busy ? ' disabled' : ''}>Actualizar</button></div>
          </div>
        `;
      case 'pending':
      case 'none':
      default:
        return `
          <div class="bet-settle">
            <div class="bet-settle-title">${BET_SPINNER}<span>Procesando tu cobro…</span></div>
            <div class="bet-settle-amount bet-settle-amount--pending">+${myAmount} <small>sats</small></div>
            <p class="bet-settle-hint">Todavía no figura como pagado. Tocá «Actualizar» para consultar el estado.</p>
            <div class="online-bet-deposit-actions"><button class="dash-copy-btn" type="button" data-ui-action="online-bet-refresh"${betState.busy ? ' disabled' : ''}>Actualizar</button></div>
          </div>
        `;
    }
  }

  if (bet.status === 'settled') {
    const winners = bet.participants.filter((entry) => (entry.payoutSats ?? 0) > 0);
    const names = winners.map((entry) => `${escapeHtml(betParticipantName(entry))} (+${entry.payoutSats!.toLocaleString('es-AR')} sats)`).join(', ');
    return `<div class="panel-note bet-settle-muted">💰 Apuesta pagada a ${names || `el ganador (${bet.netPayoutSats} sats)`}. Perdiste tu apuesta de ${bet.stakeSats} sats.</div>`;
  }

  if (bet.status === 'refunded' || bet.status === 'cancelled' || bet.status === 'expired') {
    return `<div class="panel-note">↩️ Apuesta ${escapeHtml(betStatusLabel(bet.status).toLowerCase())}: se reembolsaron los depósitos a todos.</div>`;
  }

  if (bet.status === 'funded') {
    const isHost = roomState.current?.hostPlayerId === identityState.player.id;
    // NOT_READY no es un fallo: significa que otro `/result` ya tomó la apuesta y la
    // está liquidando (o todavía no quedó lista). Es transitorio y se auto-cura al
    // pasar a `settled`, así que lo absorbemos en el paso "Liquidando" en vez de un
    // error rojo. Solo los códigos genuinos (CONTRACT_MISMATCH, BAD_WINNERS…) se ven.
    const isTransientSettlement = !bet.settlementError || /^NOT_READY\b/.test(bet.settlementError);
    const errorHtml = bet.settlementError && !isTransientSettlement
      ? `<p class="bet-settle-error">⚠️ Luna Negra rechazó el cobro: ${escapeHtml(bet.settlementError)}.${isHost ? ' Probá «Reintentar cobro».' : ''}</p>`
      : '';
    // El host tiene un empujón manual por si el reporte automático no progresa.
    const settleAction = isHost
      ? `<div class="online-bet-deposit-actions"><button type="button" data-ui-action="online-bet-settle"${betState.busy ? ' disabled' : ''}>Reintentar cobro</button></div>`
      : '';
    const winnerBadge = amIWinner
      ? `<div class="bet-settle-amount bet-settle-amount--pending">Ganás +${bet.netPayoutSats.toLocaleString('es-AR')} <small>sats</small></div>`
      : '';
    return `${renderBetSettlementCard(!!bet.resultReported, errorHtml)}${winnerBadge}${settleAction}`;
  }

  return `<div class="panel-note">Apuesta: ${escapeHtml(betStatusLabel(bet.status).toLowerCase())} · pozo ${bet.potSats} sats.</div>`;
}

function renderOnlinePeerBoards(): string {
  if (!roomState.current) return '';
  const remotePlayers = roomState.current.players.filter((player) => player.id !== identityState.player.id);
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
  const aliveCount = roomState.current.players.filter((candidate) => (
    candidate.alive
    && candidate.status !== 'eliminated'
    && candidate.status !== 'lost'
    && candidate.status !== 'disconnected'
  )).length;
  // Espectador: el rival enfocado ya ocupa el canvas principal (como si jugara yo),
  // así que la grilla lateral conserva la posición y el estilo de la partida en vivo
  // y solo lista a los DEMÁS, en mini. Cada tarjeta es clickeable para cambiar el
  // foco. Sin overlay a pantalla completa ni encabezado aparte.
  if (isOnlineSpectating()) {
    const focus = spectatorFocusPlayer();
    const sidePlayers = remotePlayers.filter((player) => player.id !== focus?.id);
    const layout = onlinePeerGridLayout(Math.max(1, sidePlayers.length));
    const sideHtml = sidePlayers.length > 0
      ? sidePlayers
          .map((player) => `
            <div class="online-spec-pick" data-ui-action="spectate-focus" data-player-id="${escapeHtml(player.id)}" role="button" tabindex="0" title="Ver a ${escapeHtml(player.name)}">
              ${renderOnlinePeerBoard(player)}
            </div>
          `)
          .join('')
      : '<div class="online-empty">Sin otros rivales.</div>';
    return `
      <aside class="online-versus-grid online-versus-grid--watching" aria-label="Remote player boards">
        <div class="online-versus-title online-versus-title--spectating">
          <span>Viendo</span>
          <strong>${escapeHtml(focus?.name ?? '—')}</strong>
          <span class="online-spec-alive">${aliveCount} en pie</span>
        </div>
        <div
          class="online-peer-boards"
          data-peer-count="${sidePlayers.length}"
          style="--online-peer-columns: ${layout.columns}; --online-peer-card-width: ${layout.cardWidth}px;"
        >
          ${sideHtml}
        </div>
      </aside>
    `;
  }
  const layout = onlinePeerGridLayout(remotePlayers.length);
  return `
    <aside class="online-versus-grid" aria-label="Remote player boards">
      <div class="online-versus-title">
        <span>Opponents</span>
        <strong>${remotePlayers.length}</strong>
      </div>
      <div
        class="online-peer-boards"
        data-peer-count="${remotePlayers.length}"
        style="--online-peer-columns: ${layout.columns}; --online-peer-card-width: ${layout.cardWidth}px;"
      >
        ${remotePlayers.map((player) => renderOnlinePeerBoard(player)).join('')}
      </div>
    </aside>
  `;
}

// El jugador local ya terminó su partida pero la ronda sigue: está mirando.
// Durante la animación de derrota todavía NO es espectador: se sigue viendo su
// tablero (muriendo, a tamaño completo) y los rivales quedan al costado.
function isOnlineSpectating(): boolean {
  if (appMode !== 'onlinePlaying') return false;
  // Espectador de toda la ronda (no estaba listo al arrancar): no tengo tablero
  // propio, miro a los rivales desde el primer frame.
  if (roundState.spectatorRound) return true;
  return lastStatus !== 'playing' && !isOnlineDeathAnimating();
}

// Rivales que puedo mirar como espectador (todos menos yo). El orden es el de
// rankPlayers: los que siguen en pie/mejor posicionados primero, así el foco
// automático arranca en el líder.
function spectatorPeers(): OnlinePlayer[] {
  if (!roomState.current) return [];
  return rankPlayers(roomState.current.players).filter((player) => player.id !== identityState.player.id);
}

// Rival enfocado en el tablero principal. Respeta la elección manual mientras
// ese jugador siga en la sala; si no, sigue al líder (primer ranking).
function spectatorFocusPlayer(): OnlinePlayer | null {
  const peers = spectatorPeers();
  if (peers.length === 0) return null;
  if (spectatorState.focusId) {
    const manual = peers.find((player) => player.id === spectatorState.focusId);
    if (manual) return manual;
  }
  return peers[0];
}

// Cambia el foco al siguiente/anterior rival (flechas o click). Fija el id manual
// para que deje de auto-seguir al líder hasta que ese jugador se vaya.
function cycleSpectatorFocus(direction: 1 | -1): void {
  const peers = spectatorPeers();
  if (peers.length <= 1) return;
  const current = spectatorFocusPlayer();
  const index = current ? peers.findIndex((player) => player.id === current.id) : -1;
  const base = index >= 0 ? index : 0;
  const next = peers[(base + direction + peers.length) % peers.length];
  spectatorState.focusId = next.id;
}

// Olvida la elección manual de foco y el motor de reconstrucción al cerrar/reabrir
// la ronda, para no arrastrar a un jugador de la ronda anterior.
function resetSpectatorFocus(): void {
  spectatorState.focusId = null;
  spectatorState.engine = null;
  spectatorState.engineSeed = null;
  spectatorState.juice = null;
  spectatorState.juiceId = null;
  spectatorState.juicePrev = null;
  spectatorDeathAnnounced.clear();
}

// Dispara el sonido de derrota de un rival al caer, usando el estado autoritativo de
// la sala (alive/status), no el snapshot reconstruido: el que muere deja de mandar
// snapshots y el foco salta a otro, así que la transición a 'gameover' del motor del
// rival casi nunca se observa y el KO de spectatorState.juice.frame no dispara. Suena tanto
// mientras juego (cualquier rival que caiga) como mirando como espectador (solo el
// rival ENFOCADO: el foco salta y no queremos sonar una muerte vieja al re-enfocar).
// Marca a todos los muertos como "anunciados" aunque no suenen, para no repetir; al
// revivir un jugador (reopen de ronda) se borra su marca para que su próxima caída suene.
function syncRivalDeathSounds(): void {
  if (!roomState.current || appMode !== 'onlinePlaying') return;
  const spectating = isOnlineSpectating();
  const focus = spectating ? spectatorFocusPlayer() : null;
  for (const player of roomState.current.players) {
    if (player.id === identityState.player.id) continue;
    const dead = !player.alive || player.status === 'eliminated' || player.status === 'lost';
    if (!dead) {
      spectatorDeathAnnounced.delete(player.id);
      continue;
    }
    if (spectatorDeathAnnounced.has(player.id)) continue;
    spectatorDeathAnnounced.add(player.id);
    // Jugando: la muerte del rival suena desde su mini-tablero en la grilla. Como
    // espectador solo suena el rival ENFOCADO, que está centrado → paneo neutro.
    // Reforzado (RIVAL_DEATH_GAIN) para que no se pierda bajo el resto de la mezcla.
    if (!spectating) sound.play('gameOver', panForPlayerBoard(player.id), RIVAL_DEATH_GAIN);
    else if (focus && player.id === focus.id) sound.play('gameOver', 0, RIVAL_DEATH_GAIN);
  }
}

// Sonidos de pieza de los rivales mientras JUEGO (no como espectador): mover/girar/
// fijar deducidos por diff entre los snapshots de cada rival vivo, reproducidos
// atenuados (RIVAL_PIECE_GAIN) y paneados desde su mini-tablero, para sentir su
// actividad sin tapar mi propio juego. Como espectador no corre: el rival enfocado ya
// suena a volumen pleno vía driveSpectatorJuice. Los snapshots llegan espaciados, así
// que cada cue suena una vez por actualización (más esporádico que el propio, justo lo
// buscado). Mismo criterio de diff que el espectador: lock por aumento de piezas, y
// si la pieza es la misma, giro con prioridad sobre desplazamiento.
function syncRivalPieceSounds(): void {
  if (!roomState.current || appMode !== 'onlinePlaying' || isOnlineSpectating()) {
    if (rivalPieceSnapshots.size) rivalPieceSnapshots.clear();
    return;
  }
  const live = new Set<string>();
  for (const player of roomState.current.players) {
    if (player.id === identityState.player.id) continue;
    const alive = player.alive
      && player.status !== 'eliminated'
      && player.status !== 'lost'
      && player.status !== 'disconnected'
      && player.status !== 'winner'
      && player.status !== 'won';
    if (!alive) continue;
    const snapshot = displaySnapshotForPlayer(player);
    const active = snapshot?.active;
    if (!snapshot || !active) continue;
    live.add(player.id);
    const curr = {
      pieces: snapshot.pieces ?? 0,
      type: active.type as string,
      x: active.x,
      rotation: active.rotation as number,
    };
    const prev = rivalPieceSnapshots.get(player.id);
    rivalPieceSnapshots.set(player.id, curr);
    if (!prev) continue; // primer snapshot del rival: sólo re-sincroniza, sin sonar
    const pan = panForPlayerBoard(player.id);
    if (curr.pieces > prev.pieces) {
      // Pieza fijada: golpe de colocación. 'lock' (no 'hardDrop') porque desde el
      // snapshot no sabemos si fue hard drop, igual que en driveSpectatorJuice.
      sound.play('lock', pan, RIVAL_PIECE_GAIN);
    } else if (curr.type === prev.type) {
      if (curr.rotation !== prev.rotation) sound.play('rotate', pan, RIVAL_PIECE_GAIN);
      else if (curr.x !== prev.x) sound.play('move', pan, RIVAL_PIECE_GAIN);
    }
  }
  // Olvido a los rivales que ya no están vivos/visibles para que su próxima pieza
  // re-sincronice sin disparar un sonido viejo al reaparecer.
  for (const id of [...rivalPieceSnapshots.keys()]) {
    if (!live.has(id)) rivalPieceSnapshots.delete(id);
  }
}

// Latido de peligro (Danger / latido que acelera) de los rivales. En la VISTA DE
// ENEMIGOS late por el rival más al borde de la derrota, en su capa de audio aparte
// (rivalDangerAudio) para no pisar el latido de TU propio tablero. Como ESPECTADOR no
// hace nada: el latido del rival enfocado ya lo dispara driveSpectatorJuice sobre
// juiceAudio. El efecto VISUAL lo dibuja el CSS del mini-tablero (clases --warn/--peril
// en renderOnlinePeerBoard); esto solo aporta el audio.
function syncRivalDangerCues(): void {
  if (!roomState.current || appMode !== 'onlinePlaying' || isOnlineSpectating()) {
    rivalDangerAudio.setDanger(0);
    return;
  }
  let level = 0;
  let dangerPlayerId: string | null = null;
  for (const player of roomState.current.players) {
    if (player.id === identityState.player.id) continue;
    const alive = player.alive
      && player.status !== 'eliminated'
      && player.status !== 'lost'
      && player.status !== 'disconnected'
      && player.status !== 'winner';
    if (!alive) continue;
    const dl = rivalDangerLevel(player); // 0..10, misma escala que el panel
    if (dl <= RIVAL_DANGER_WARN) continue;
    // Mapeo el tramo WARN..10 a 0..1: el latido arranca recién en lo alto (igual que
    // el propio) y acelera al máximo al borde del top-out. Sin `critical` para que sea
    // solo el latido, sin la sirena de alarma.
    const mapped = (dl - RIVAL_DANGER_WARN) / (10 - RIVAL_DANGER_WARN);
    if (mapped > level) { level = mapped; dangerPlayerId = player.id; }
  }
  // El latido suena desde el mini-tablero del rival más al borde (grilla lateral).
  rivalDangerAudio.setDanger(level, false, dangerPlayerId ? panForPlayerBoard(dangerPlayerId) : 0);
}

// Reconstruye el GameState del rival enfocado a partir de su engine snapshot, para
// dibujarlo en el canvas principal igual que una partida en vivo (tablero, hold,
// next, ghost y stats). Devuelve null si todavía no llegó un snapshot con motor.
function spectatorFocusState(player: OnlinePlayer): GameState | null {
  const engineSnapshot = displaySnapshotForPlayer(player)?.engine;
  if (!engineSnapshot) return null;
  try {
    if (!spectatorState.engine || spectatorState.engineSeed !== engineSnapshot.seed) {
      // Las dimensiones (boardWidth/visibleRows/hiddenRows) y opciones (ghost/hold/
      // next) las define la sala, no BATTLE_RULES: usar las reglas de la sala —igual
      // que mi propio motor online— para que el piso del tablero quede a la altura
      // correcta. Con BATTLE_RULES (hiddenRows 20 vs 10 de la sala) el piso subía.
      spectatorState.engine = new GameEngine(engineSnapshot.seed, onlineRulesFromRoom());
      spectatorState.engineSeed = engineSnapshot.seed;
    }
    spectatorState.engine.restoreSnapshot(engineSnapshot);
    return spectatorState.engine.getState();
  } catch {
    return null;
  }
}

// Reproduce el juice (partículas, flashes, popups, sonido) del tablero observado.
// Los snapshots del rival NO traen eventos, así que se infieren por diff contra el
// snapshot anterior: líneas borradas → line-clear (con TETRIS/combo/ataque según
// stats), pieza nueva → lock (visual + sonido), garbage pendiente que sube → telegrafía entrante;
// el peligro por altura y las transiciones KO/Win las saca frame() del estado.
// Entre snapshots el estado no cambia (mismo snapshot reconstruido), así que no se
// generan eventos falsos; solo el peligro se actualiza suave cada frame.
function driveSpectatorJuice(focusState: GameState, focusId: string): void {
  if (!spectatorState.juice) {
    spectatorState.juice = new JuiceConductor(renderer.getJuice(), juiceAudio);
    spectatorState.juice.setAttackRouting('auto');
  }
  const stats = focusState.stats;
  const activeNow = focusState.active
    ? { type: focusState.active.type as string, x: focusState.active.x, rotation: focusState.active.rotation as number }
    : null;
  // Cambié de tablero (o primer frame): re-sincronizo sin disparar efectos.
  if (focusId !== spectatorState.juiceId) {
    spectatorState.juiceId = focusId;
    spectatorState.juice.prime(focusState);
    spectatorState.juicePrev = { lines: stats.lines, pieces: stats.pieces, pending: stats.pendingGarbage, sent: stats.sentGarbage, active: activeNow };
    spectatorState.juice.frame(focusState);
    return;
  }
  const prev = spectatorState.juicePrev ?? { lines: stats.lines, pieces: stats.pieces, pending: stats.pendingGarbage, sent: stats.sentGarbage, active: activeNow };
  const events: GameEvent[] = [];
  const clearedDelta = stats.lines - prev.lines;
  if (clearedDelta > 0) {
    const cleared = Math.max(1, Math.min(4, clearedDelta));
    const outgoing = Math.max(0, stats.sentGarbage - prev.sent);
    const filled = focusState.board.reduce((total, row) => total + row.reduce((n, cell) => n + (cell ? 1 : 0), 0), 0);
    const lineClear: LineClearEvent = {
      type: 'lineClear',
      frame: stats.frame,
      cleared,
      difficult: stats.b2b > 0 || cleared >= 4,
      spin: 'none',
      piece: focusState.active?.type ?? 'I',
      perfectClear: filled === 0,
      combo: Math.max(0, stats.combo),
      b2b: Math.max(0, stats.b2b),
      attackLines: outgoing,
      outgoingLines: outgoing,
    };
    events.push(lineClear);
  }
  const pendingDelta = stats.pendingGarbage - prev.pending;
  if (pendingDelta > 0) events.push({ type: 'incomingGarbage', frame: stats.frame, lines: pendingDelta });
  spectatorState.juice.handleEvents(focusState, events);
  // Paneo del tablero enfocado: también está centrado en el canvas, así que sigue la
  // columna de su pieza activa igual que el tablero propio.
  const focusPan = panForBoardColumn(focusState.active?.x);
  if (stats.pieces > prev.pieces) {
    spectatorState.juice.onLock();
    // Sonido de pieza colocada del rival observado. En la partida propia este "thud"
    // sale del handler de input (playImmediateInputSounds), que no corre para el
    // espectador; sin esto solo se oirían los eventos grandes (clears/ataques/KO) y
    // el tablero se sentiría mudo pieza a pieza. Usamos 'lock' (no 'hardDrop') porque
    // desde snapshots no sabemos si fue hard drop y es un golpe de colocación neutro.
    sound.play('lock', focusPan);
  } else if (activeNow && prev.active && activeNow.type === prev.active.type) {
    // Misma pieza entre snapshots (no se fijó ninguna): deduzco mover/girar por diff
    // contra el snapshot anterior, igual que en la partida propia. Los snapshots
    // llegan espaciados, así que esto suena una vez por actualización (no por input),
    // pero da el feedback de que la pieza se está moviendo. El giro tiene prioridad
    // sobre el desplazamiento si ambos cambiaron en el mismo salto de snapshot.
    if (activeNow.rotation !== prev.active.rotation) sound.play('rotate', focusPan);
    else if (activeNow.x !== prev.active.x) sound.play('move', focusPan);
  }
  spectatorState.juice.frame(focusState);
  spectatorState.juicePrev = { lines: stats.lines, pieces: stats.pieces, pending: stats.pendingGarbage, sent: stats.sentGarbage, active: activeNow };
}

// Tamaño automático de los tableros rivales (grilla lateral): con pocos enemigos se
// agrandan, con muchos se achican hasta que entren todos. El mismo cálculo sirve
// jugando y como espectador, porque la grilla conserva su posición lateral.
function onlinePeerGridLayout(playerCount: number): { columns: number; cardWidth: number } {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const columns = onlinePeerGridColumns(playerCount, width);
  const rows = Math.ceil(playerCount / columns);
  const gap = width < 760 ? 6 : 8;
  const panelWidth = width < 760
    ? Math.max(240, width - 28)
    : width < 1120
      ? Math.max(176, width * 0.22)
      : Math.min(420, width * 0.32);
  const availableHeight = Math.max(240, height - (width < 760 ? 168 : 118));
  const widthBound = (panelWidth - gap * (columns - 1)) / columns;
  const heightBound = (availableHeight - gap * (rows - 1)) / rows / 2.42;
  const minWidth = width < 760 ? 44 : 54;
  const maxWidth = onlinePeerMaxCardWidth(playerCount, width);
  return {
    columns,
    cardWidth: Math.floor(Math.max(minWidth, Math.min(maxWidth, widthBound, heightBound))),
  };
}

function onlinePeerMaxCardWidth(playerCount: number, width: number): number {
  if (width < 760) return playerCount <= 2 ? 110 : 82;
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
  const peerStateLabel = peerState.states.get(player.id) ?? 'server';
  const displayGame = displaySnapshotForPlayer(player);
  const outcome = onlinePeerOutcome(player, displayGame);
  // Un jugador eliminado debe verse muerto aunque su peer siga "connecting" o
  // no haya llegado snapshot: la autoridad es el estado de la sala (alive/status).
  const stateLabel = outcome
    ? outcome.label
    : displayGame
      ? `${formatFrames(displayGame.elapsedFrames)} - ${peerStateLabel}`
      : peerStateLabel;
  const boardHtml = displayGame
    ? renderOnlineMiniBoard(displayGame)
    : '<div class="online-mini-board online-mini-board-empty">No board yet</div>';
  // Rival vivo al borde de la derrota: clases que disparan los efectos especiales
  // (borde rojo latiendo + sacudida + destello), sin texto. dangerLevel es 0..10.
  const dangerLevel = rivalDangerLevel(player);
  const dangerClass = !outcome
    ? dangerLevel >= RIVAL_DANGER_CRITICAL
      ? ' online-peer-board--peril'
      : dangerLevel >= RIVAL_DANGER_WARN
        ? ' online-peer-board--warn'
        : ''
    : '';
  return `
    <section class="online-peer-board${outcome ? ` online-peer-board--${outcome.kind}` : ''}${dangerClass}" data-player-id="${escapeHtml(player.id)}">
      <div class="online-peer-board-head">
        <div class="online-player-label">
          ${renderOnlineAvatar(player, 'small')}
          <strong>${escapeHtml(player.name)}</strong>
        </div>
        <span>${escapeHtml(stateLabel)}</span>
      </div>
      <div class="online-peer-board-body">
        ${boardHtml}
        ${outcome ? `<div class="online-peer-board-tag online-peer-board-tag--${outcome.kind}">${escapeHtml(outcome.tag)}</div>` : ''}
      </div>
    </section>
  `;
}

// Desenlace de un rival según el estado autoritativo de la sala (y, como señal
// temprana, el status de su último snapshot). Devuelve null mientras sigue vivo.
// "Ganó" solo lo decide la sala (winnerPlayerId / status 'winner'): un snapshot
// 'finished' o un status 'won' (sprint completado) significan "terminó", no
// necesariamente ganador — antes etiquetaban WIN a ambos finishers.
function onlinePeerOutcome(
  player: OnlinePlayer,
  snapshot: OnlineGameSnapshot | null,
): { kind: 'ko' | 'win' | 'done'; label: string; tag: string } | null {
  const crowned = player.status === 'winner' || roomState.current?.winnerPlayerId === player.id;
  if (crowned) return { kind: 'win', label: 'Ganó', tag: 'WIN' };
  const finished = player.status === 'won' || snapshot?.status === 'finished';
  if (finished) return { kind: 'done', label: 'Terminó', tag: 'FIN' };
  const ko = !player.alive
    || player.status === 'eliminated'
    || player.status === 'lost'
    || snapshot?.status === 'gameover';
  if (ko) return { kind: 'ko', label: 'Eliminado', tag: 'KO' };
  return null;
}

function displaySnapshotForPlayer(player: OnlinePlayer): OnlineGameSnapshot | null {
  const displayGame = peerState.displaySnapshots.get(player.id);
  if (displayGame && isCurrentOnlineGame(displayGame)) return displayGame;
  return player.game ?? null;
}

// Peligro de un rival (0..10) derivado del MISMO snapshot que se dibuja en su
// mini-tablero, recalculado por frame. No usamos solo player.dangerLevel porque en
// cliente-autoritativo ese campo llega por polling de getRoomState y casi nunca
// capta la ventana de peligro alto (el rival "salta" de medio a eliminado entre
// dos polls). Tomamos el máximo entre lo derivado y el valor sincronizado (que ya
// incorpora el garbage pendiente). Misma fórmula que calculateDangerLevel.
function rivalDangerLevel(player: OnlinePlayer): number {
  const synced = Math.max(0, Math.floor(player.dangerLevel ?? 0));
  const snapshot = displaySnapshotForPlayer(player);
  const field = snapshot?.board;
  if (!Array.isArray(field) || field.length === 0) return synced;
  const visibleRows = Math.max(1, Math.min(snapshot!.visibleRows, field.length));
  const visibleBoard = field.slice(field.length - visibleRows);
  const firstOccupiedRow = visibleBoard.findIndex(
    (row) => Array.isArray(row) && row.some((cell) => cell !== null),
  );
  const heightDanger = firstOccupiedRow === -1
    ? 0
    : Math.ceil(((visibleRows - firstOccupiedRow) / visibleRows) * 10);
  return Math.min(10, Math.max(heightDanger, synced));
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
  return onlineNetState.error ? `<div class="panel-note panel-error">${escapeHtml(onlineNetState.error)}</div>` : '';
}

function confirmTitle(action: DestructiveRunAction): string {
  if (action === 'restart') return 'Restart run?';
  if (action === 'main-menu') return 'Exit run?';
  if (action === 'online-leave') return 'Leave online room?';
  if (action === 'leave-room-for-local') return '¿Pasar al duelo local?';
  return 'Import replay and abandon current run?';
}

function confirmMeta(action: DestructiveRunAction): string {
  if (action === 'import-replay') return 'The current board and timer will be discarded if a replay is loaded.';
  if (action === 'online-leave') return 'Your local online run will stop on this device.';
  if (action === 'leave-room-for-local') return 'El duelo local es en esta misma compu: esta acción te sacará de la sala online.';
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
  const error = libraryState.error ? `<div class="panel-note panel-error">${escapeHtml(libraryState.error)}</div>` : '';
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
  const activeClass = libraryState.filter === filter ? ' button-active' : '';
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
      <section class="replay-panel" aria-label="Replay replayState.playback">
        <div class="panel-eyebrow">REPLAY PLAYBACK</div>
        <h1 data-replay-title>Playback</h1>
        <p>${escapeHtml(replayState.importedName ?? 'Imported replay')} - seed ${replayState.playback?.getReplay().seed ?? 0}</p>
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
  const title = snapshot.paused ? 'Paused' : snapshot.done ? 'Complete' : `${snapshot.speed}x replayState.playback`;
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
          <button class="dash-action-btn accent custom-start-btn" type="button" data-ui-action="sidebar-play" aria-label="Jugar custom">▶ Jugar</button>
        </div>
        <div class="custom-tabs" aria-label="Secciones de custom">
          ${CUSTOM_TABS.map((tab) => `
            <button class="${uiSelectionState.customTab === tab ? 'custom-tab-active' : ''}" type="button" data-ui-action="custom-tab" data-tab="${tab}">
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
  if (uiSelectionState.customTab === 'objective') {
    return [
      renderCustomSection('Objetivo', [
        renderCustomSelect('Modo', 'objectiveMode', [['none', 'Ninguno'], ['lines', 'Líneas']]),
        renderCustomNumber('Objetivo de líneas', 'objectiveLineTarget'),
      ]),
    ].join('');
  }
  if (uiSelectionState.customTab === 'meta') {
    return [
      renderCustomSection('Meta', [
        renderCustomStaticRow('Envío de repeticiones', 'No'),
      ]),
    ].join('');
  }
  return [
    renderCustomSection('General', [
      renderCustomToggle('Semilla aleatoria', 'useRandomSeed'),
      renderCustomNumber('Semilla', 'seed'),
      renderCustomToggle('Permitir reintento', 'allowRetry'),
      renderCustomNumber('Ancho del tablero', 'boardWidth'),
      renderCustomNumber('Alto del tablero', 'boardHeight'),
    ]),
    renderCustomSection('Basura', [
      renderCustomNumber('Desorden de basura %', 'garbageMessinessPercent'),
      renderCustomNumber('Tope de basura', 'garbageCap'),
      renderCustomToggle('Cambiar al atacar', 'changeOnAttack'),
      renderCustomToggle('Basura continua', 'continuousGarbage'),
    ]),
    renderCustomSection('Controles', [
      renderCustomToggle('Hard drop', 'useHardDrop'),
      renderCustomToggle('Cola next', 'useNextQueue'),
      renderCustomToggle('Cola hold', 'useHoldQueue'),
      renderCustomNumber('Piezas next', 'nextPieces'),
      renderCustomToggle('Movimiento infinito', 'infiniteMovement'),
      renderCustomToggle('Hold infinito', 'infiniteHold'),
      renderCustomToggle('Pieza fantasma', 'showShadowPiece'),
    ]),
    renderCustomSection('Gravedad y niveles', renderGravityRows()),
  ].join('');
}

function renderGravityRows(): string[] {
  // En modo 'guideline' (estilo TETR.IO) la gravedad sale de la curva por nivel, así
  // que los sliders manuales (gravedad fija / base / incremento) no aplican y se ocultan
  // para no confundir; en 'linear' se muestran todos.
  const linear = customSettings.gravityModel === 'linear';
  return [
    renderCustomSelect('Modelo de gravedad', 'gravityModel', [
      ['guideline', 'Guideline (TETR.IO)'],
      ['linear', 'Lineal (manual)'],
    ]),
    ...(linear ? [renderCustomNumber('Gravedad', 'gravity')] : []),
    renderCustomToggle('Usar niveles', 'useLevelling'),
    renderCustomNumber('Nivel inicial', 'startingLevel'),
    renderCustomToggle('Niveles estáticos', 'useStaticLevelling'),
    renderCustomNumber('Velocidad estática', 'levelStaticSpeed'),
    renderCustomNumber('Velocidad de nivel', 'levelSpeed'),
    ...(linear
      ? [
          renderCustomNumber('Gravedad base', 'baseGravity'),
          renderCustomNumber('Incremento de gravedad', 'gravityIncrease'),
        ]
      : []),
    renderCustomNumber('Lock delay (frames)', 'lockDelayFrames'),
  ];
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
  key: keyof Pick<CustomSettings, 'objectiveMode' | 'gravityModel'>,
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
        <div class="handling-presets">${renderHandlingPresets()}</div>
        <div class="timing-panel">
          ${renderTimingControl('DAS', 'dasFrames', inputSettings.dasFrames)}
          ${renderTimingControl('ARR', 'arrFrames', inputSettings.arrFrames)}
          ${renderTimingControl('Soft drop', 'softDropFactor', inputSettings.softDropFactor)}
        </div>
        ${renderCustomSection('Accesibilidad', [
          renderCustomToggle('Modo daltónico', 'colorBlindMode'),
        ])}
        <section class="custom-section settings-audio" aria-label="Audio">
          <h2>Audio</h2>
          <div class="custom-rows">
            ${renderVolumeSettingRow('sfx')}
            ${renderVolumeSettingRow('music')}
            ${renderRoyaltyFreeToggleRow()}
          </div>
        </section>
        ${renderTouchSettingsSection()}
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

function renderTimingControl(label: string, setting: InputTimingKey, value: number): string {
  const display = setting === 'softDropFactor'
    ? (value >= INSTANT_SOFT_DROP_FACTOR ? '∞' : String(value))
    : `${value}f`;
  return `
    <div class="timing-row">
      <span>${label}</span>
      <button type="button" data-ui-action="timing" data-setting="${setting}" data-delta="-1">-</button>
      <strong>${display}</strong>
      <button type="button" data-ui-action="timing" data-setting="${setting}" data-delta="1">+</button>
    </div>
  `;
}

function renderHandlingPresets(): string {
  const active = matchHandlingPreset(inputSettings);
  const buttons = HANDLING_PRESET_ORDER.map((preset) => {
    const def = HANDLING_PRESETS[preset];
    const isActive = preset === active;
    return `
      <button
        type="button"
        class="handling-preset-btn${isActive ? ' is-active' : ''}"
        data-ui-action="handling-preset"
        data-preset="${preset}"
        aria-pressed="${isActive}"
      >${escapeHtml(def.label)}</button>
    `;
  }).join('');
  return `<span class="handling-presets-label">Preset</span>${buttons}`;
}

function renderPausePanel(state: GameState): string {
  const lines = state.stats.lines;
  const time = formatFrames(displayedElapsedFrames(state.stats));
  const pieces = state.stats.pieces;
  const canRetry = canRetryCurrentRun();

  const exported = lastExportName
    ? `<div class="panel-note">Exported ${escapeHtml(lastExportName)}</div>` : '';
  const importError = replayState.importError
    ? `<div class="panel-note panel-error">${escapeHtml(replayState.importError)}</div>` : '';
  const runError = localRunError
    ? `<div class="panel-note panel-error">${escapeHtml(localRunError)}</div>` : '';

  const restartBtn = canRetry
    ? `<button class="pause-btn pause-btn--ghost" type="button" data-ui-action="restart">
         <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
         <span>Restart</span>
       </button>`
    : '';

  const panel = `
    <section class="menu-panel pause-panel" aria-label="Paused">
      <div class="pause-aura" aria-hidden="true"></div>
      <header class="pause-head">
        <div class="pause-badge">
          <span class="pause-badge-glyph" aria-hidden="true"><i></i><i></i></span>
          <span class="pause-badge-text">Paused</span>
        </div>
        <p class="pause-sub">Run frozen — Resume keeps the exact board and timer.</p>
      </header>
      <div class="pause-stats" role="group" aria-label="Run progress">
        <div class="pause-stat">
          <span class="pause-stat-label">Lines</span>
          <strong class="pause-stat-value">${lines}<small>/40</small></strong>
        </div>
        <div class="pause-stat">
          <span class="pause-stat-label">Time</span>
          <strong class="pause-stat-value">${escapeHtml(time)}</strong>
        </div>
        <div class="pause-stat">
          <span class="pause-stat-label">Pieces</span>
          <strong class="pause-stat-value">${pieces}</strong>
        </div>
      </div>
      <div class="pause-actions">
        <button class="pause-btn pause-btn--resume" type="button" data-ui-action="resume" autofocus>
          ${playIcon({ size: 18, ariaHidden: true })}
          <span>Resume</span>
        </button>
        <div class="pause-grid">
          ${restartBtn}
          <button class="pause-btn pause-btn--ghost" type="button" data-ui-action="settings">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>
            <span>Controls</span>
          </button>
          <button class="pause-btn pause-btn--ghost" type="button" data-ui-action="import-replay">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
            <span>Import replay</span>
          </button>
          <button class="pause-btn pause-btn--ghost" type="button" data-ui-action="export-replay">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>
            <span>Export replay</span>
          </button>
        </div>
        <button class="pause-btn pause-btn--danger" type="button" data-ui-action="main-menu">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>
          <span>Main menu</span>
        </button>
      </div>
      ${exported}
      ${importError}
      ${runError}
    </section>
  `;
  return `<div class="menu-scrim pause-scrim">${panel}</div>`;
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
    || mode === 'playMenu'
    || mode === 'soloMenu'
    || mode === 'multiplayerMenu'
    || mode === 'historyMenu'
    || mode === 'configMenu'
    || mode === 'custom'
    || mode === 'leaderboard'
    || mode === 'survivalTop';
}

function renderPersistentRoomPanel(): string {
  return roomState.current ? renderActivePersistentRoomPanel() : renderEmptyPersistentRoomPanel();
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
  // Móvil (< 760px): layout dedicado de pantalla completa con nav inferior y, en
  // sala, un gestor de 3 zonas donde solo la lista de jugadores scrollea (las
  // acciones Marcar listo / Empezar / Salir quedan SIEMPRE visibles). El loop
  // recomputa este string cada frame, así que cruzar el breakpoint reconstruye el
  // DOM solo (renderOverlay difea contra overlayState.last).
  if (isMobileDashboard()) return renderMobileDashboard(state);

  const userDisplayName = identityState.name.trim() || 'Jugador';

  const isHomeActive = appMode === 'menu';
  // "Jugar" es el hub de modalidades; queda activo también en sus sub-vistas
  // (config custom y los tops de supervivencia, que viven dentro de la modalidad).
  const isPlayActive = appMode === 'playMenu' || appMode === 'custom' || appMode === 'leaderboard' || appMode === 'survivalTop';
  const isHistoryActive = appMode === 'historyMenu' || appMode === 'library';
  const isSettingsActive = appMode === 'configMenu' || (appMode === 'settings' && (settingsReturnMode === 'configMenu' || settingsReturnMode === 'menu'));

  const homeClass = isHomeActive ? 'dash-sidebar-btn--active' : '';
  const playClass = isPlayActive ? 'dash-sidebar-btn--active' : '';
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

        <div class="dash-user">
          ${renderOnlineAvatar({ name: userDisplayName, avatarUrl: identityState.player.avatarUrl }, 'small', 'dash-user-avatar')}
          <span class="dash-user-name">${escapeHtml(userDisplayName)}</span>
        </div>
      </header>
      
      <!-- SIDEBAR -->
      <nav class="dash-sidebar">
        <div class="dash-sidebar-nav">
          <button class="dash-sidebar-btn ${homeClass}" type="button" data-ui-action="main-menu">
            ${homeIcon({ size: 18, fill: false })}
            Inicio
          </button>
          <button class="dash-sidebar-btn ${playClass}" type="button" data-ui-action="play-menu">
            ${playIcon({ size: 18, fill: false })}
            Jugar
          </button>
          <button class="dash-sidebar-btn ${historyClass}" type="button" data-ui-action="history-menu">
            ${historyClockIcon({ size: 18, fill: false })}
            Historial
          </button>
          <button class="dash-sidebar-btn ${settingsClass}" type="button" data-ui-action="config-menu">
            ${settingsGearIcon({ size: 18, fill: false })}
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

// Orquestador stateful de la etapa "Jugar": deriva los datos del estado del shell
// y delega el markup en la vista pura (src/ui/dashboard/smartPlay.ts).
function renderSmartPlayStage(): string {
  // Sin sala: selector de modalidad (tarjetas). El modo elegido decide qué arranca
  // el botón ▶ en solo y, al crear sala, su matchType. Los tops de Supervivencia
  // solo se derivan en esta rama (no hay sala) para no hacer trabajo de más.
  if (!roomState.current) {
    return renderModeSelectStageView({
      mode: uiSelectionState.playMode,
      customChips: customConfigChips(),
      survivalTopsHtml: renderSurvivalTopsEmbed(),
    });
  }

  const hasOthers = onlineRoomHasOtherPlayers();
  const host = isOnlineHost();
  const ready = !!currentOnlinePlayer()?.ready;
  // Contexto = exactamente la lógica del botón inteligente (sidebar-play).
  const ctx: 'waiting' | 'host' | 'guest' =
    !hasOthers ? 'waiting' : host ? 'host' : 'guest';

  return renderSmartPlayStageView({
    ctx,
    // En sala la modalidad ya quedó fijada por la sala (matchType): la mostramos en
    // el eyebrow para que se entienda bajo qué reglas se va a jugar.
    roomModeName: matchTypeLabel(roomState.current.matchType).toUpperCase(),
    ready,
    readyCount: roomState.current.players.filter((p) => p.ready).length,
    total: roomState.current.players.length,
    // El host puede cambiar la modalidad sin salir de la sala (en el lobby). Para los
    // invitados la modalidad la fija el host, así que solo ven el eyebrow.
    modeCardsHtml: host && roomState.current.status === 'lobby' ? renderRoomModeCards() : '',
  });
}

// Datos de los chips de la config custom (Gravedad · Objetivo · Hold · Next). Los
// consume tanto el selector de modalidad (vista smart-play) como el dashboard móvil.
function customConfigChips(): Array<{ k: string; v: string }> {
  return [
    { k: 'Gravedad', v: roomSpeedLabel(gameRules) },
    { k: 'Objetivo', v: customSettings.objectiveMode === 'lines' && customSettings.objectiveLineTarget > 0 ? `${customSettings.objectiveLineTarget} líneas` : 'Sin fin' },
    { k: 'Hold', v: customSettings.useHoldQueue ? 'Sí' : 'No' },
    { k: 'Next', v: String(customSettings.nextPieces) },
  ];
}

// Tarjetas de modalidad dentro de la sala (solo host, en lobby): cambiar de tarjeta
// re-configura el matchType de la sala vía switchOnlineRoomMode. La tarjeta activa
// refleja el matchType actual de la sala (no uiSelectionState.playMode).
function renderRoomModeCards(): string {
  const current = roomPlayMode();
  const cards = (['survival', 'custom', 'local1v1'] as PlayMode[])
    .map((m) => renderModeCard(m, m === current, 'select-room-mode'))
    .join('');
  return `<div class="dash-mode-cards" role="tablist">${cards}</div>`;
}

// Pantalla de bienvenida (tab Inicio, sin sala): saludo + CTA hacia Jugar + 3
// stats con datos reales locales (mejor tiempo y PPS desde el historial; victorias
// desde el leaderboard si está cargado). Donde no hay dato se muestra "—".
function renderWelcomeStage(): string {
  const runs = runHistory;
  const bestFrames = runs.length ? Math.max(...runs.map((r) => r.elapsedFrames)) : null;
  const avgPps = runs.length ? runs.reduce((sum, r) => sum + r.pps, 0) / runs.length : null;
  const myWins = leaderboardState.entries.find((e) => e.playerId === identityState.player.id)?.wins ?? null;
  return renderWelcome({ bestFrames, avgPps, myWins });
}

// ─────────────────────────────────────────────────────────────────────────────
// MÓVIL — layout dedicado (< 760px)
// El dashboard de 3 columnas no se usa en móvil; lo reemplaza una sola columna a
// pantalla completa (100dvh, overflow oculto) con nav inferior fija. En sala, el
// gestor parte MAIN en 3 zonas: header fijo + jugadores (único scroll) + acciones
// ancladas, para no scrollear nunca y poder marcarse listo / empezar / salir.
// ─────────────────────────────────────────────────────────────────────────────

function isMobileDashboard(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < 760;
}


type DashTab = 'inicio' | 'jugar' | 'historial' | 'ajustes';

function dashboardActiveTab(): DashTab {
  if (appMode === 'historyMenu' || appMode === 'library') return 'historial';
  if (appMode === 'configMenu' || appMode === 'settings') return 'ajustes';
  if (appMode === 'playMenu' || appMode === 'custom' || appMode === 'leaderboard' || appMode === 'survivalTop') return 'jugar';
  // Con sala activa el hub ES el contexto de Jugar (ahí vive el gestor de sala y el
  // punto verde de la nav): resaltamos Jugar aunque appMode haya quedado en 'menu'.
  if (roomState.current && isPlayHubMode()) return 'jugar';
  return 'inicio';
}

// El hub de juego (selector de modo / gestor de sala) vive bajo estos appModes;
// el resto (custom, tops, historial, ajustes) se rinde como contenido scrollable
// reutilizando el centro de desktop.
function isPlayHubMode(): boolean {
  return appMode === 'menu' || appMode === 'playMenu' || appMode === 'onlineMenu' || appMode === 'roomLobby';
}

// Función (no const) para evitar el TDZ del primer render: loop() corre al cargar
// el módulo y este ícono está en el path de render (ver memoria main-ts-first-render-tdz).
function mdashNavIcon(tab: DashTab): string {
  if (tab === 'inicio') return homeIcon({ size: 21 });
  if (tab === 'jugar') return playIcon({ size: 21 });
  if (tab === 'historial') return historyClockIcon({ size: 21 });
  return settingsGearIcon({ size: 21 });
}

function renderMobileNavButton(tab: DashTab, active: DashTab, action: string, label: string, dot: boolean): string {
  return `
    <button class="mdash-nav-btn ${tab === active ? 'is-active' : ''}" type="button" data-ui-action="${action}">
      <span class="mdash-nav-icon">${mdashNavIcon(tab)}${dot ? '<span class="mdash-nav-dot" aria-hidden="true"></span>' : ''}</span>
      <span class="mdash-nav-label">${label}</span>
    </button>`;
}

function renderMobileDashboard(state: GameState): string {
  const userDisplayName = identityState.name.trim() || 'Jugador';
  const tab = dashboardActiveTab();
  const hasRoom = !!roomState.current;
  return `
    <div class="mdash">
      ${renderFloatingParticles()}
      <header class="mdash-header">
        <span class="mdash-logo">TETRA</span>
        <span class="mdash-user">
          ${renderOnlineAvatar({ name: userDisplayName, avatarUrl: identityState.player.avatarUrl }, 'small', 'mdash-user-avatar')}
          <span class="mdash-user-name">${escapeHtml(userDisplayName)}</span>
        </span>
      </header>
      <main class="mdash-main">
        ${renderMobileMain(state)}
      </main>
      <nav class="mdash-nav" aria-label="Navegación">
        ${renderMobileNavButton('inicio', tab, 'main-menu', 'Inicio', false)}
        ${renderMobileNavButton('jugar', tab, 'play-menu', 'Jugar', hasRoom)}
        ${renderMobileNavButton('historial', tab, 'history-menu', 'Historial', false)}
        ${renderMobileNavButton('ajustes', tab, 'config-menu', 'Ajustes', false)}
      </nav>
    </div>
  `;
}

function renderMobileMain(state: GameState): string {
  // Tab Inicio (sin sala): bienvenida. Con sala, Inicio comparte el contexto de
  // Jugar, así que cae al gestor de sala de abajo.
  if (appMode === 'menu' && !roomState.current) {
    return `<div class="mdash-scroll mdash-center">${renderWelcomeStage()}</div>`;
  }
  if (isPlayHubMode()) {
    return roomState.current ? renderMobileRoomManager() : renderMobileModeSelect();
  }
  // Inicio / Historial / Ajustes / Custom / Tops: una sola columna scrollable
  // reutilizando el contenido del centro de desktop (estas vistas SÍ pueden scrollear).
  return `<div class="mdash-scroll mdash-center">${renderDashboardCenterContent(state)}</div>`;
}

// Chips compactos de la config custom (Gravedad · Objetivo · Hold · Next).
function renderMobileCustomChips(): string {
  return `
    <div class="mdash-chips">
      ${customConfigChips().map((c) => `<span class="mdash-chip"><strong>${c.k}</strong><span>${escapeHtml(c.v)}</span></span>`).join('')}
    </div>`;
}

// Tops embebidos compactos para Supervivencia en móvil (mismas pestañas/acciones).
function renderMobileTopsEmbed(): string {
  const onSurvival = leaderboardState.tab === 'survival';
  const body = onSurvival ? renderSurvivalLeaderboardBody() : renderWinsLeaderboardBody();
  return `
    <div class="mdash-tops">
      <div class="mdash-tops-title">Top mundial</div>
      <div class="leaderboard-tabs" role="tablist">
        <button class="leaderboard-tab ${!onSurvival ? 'leaderboard-tab--active' : ''}" type="button" role="tab" aria-selected="${!onSurvival}" data-ui-action="leaderboard-tab-wins">🏆 Multi</button>
        <button class="leaderboard-tab ${onSurvival ? 'leaderboard-tab--active' : ''}" type="button" role="tab" aria-selected="${onSurvival}" data-ui-action="leaderboard-tab-survival">⏱️ Surv</button>
      </div>
      ${body}
    </div>`;
}

// Sin sala: pills de modo (fila compacta) + detalle scrollable + acciones ancladas.
function renderMobileModeSelect(): string {
  const mode = uiSelectionState.playMode;
  const meta = playModeMeta(mode);
  const pills = (['survival', 'custom', 'local1v1'] as PlayMode[]).map((m) => {
    const pm = playModeMeta(m);
    return `
      <button class="mdash-mode-pill ${m === mode ? 'is-active' : ''}" type="button" data-ui-action="select-play-mode" data-mode="${m}" style="--pill-accent: ${modeAccent(m)};">
        <span class="mdash-mode-pill-icon" aria-hidden="true">${modeTetrominoIcon(m, 24)}</span>
        <span class="mdash-mode-pill-label">${pm.cardName}</span>
      </button>`;
  }).join('');

  const extra = mode === 'survival' ? renderMobileTopsEmbed() : '';
  const customChips = mode === 'custom' ? renderMobileCustomChips() : '';
  const primaryAction = mode === 'local1v1' ? 'local-versus' : 'sidebar-play';
  const primaryLabel = meta.solo;
  const primarySub = meta.sub;

  return `
    <div class="mdash-jugar" style="--mode-accent: ${modeAccent(mode)};">
      <div class="mdash-scroll mdash-jugar-scroll">
        <div class="mdash-eyebrow mdash-eyebrow--cyan">Elegí cómo jugar</div>
        <div class="mdash-mode-pills" role="tablist">${pills}</div>
        <div class="mdash-eyebrow">${escapeHtml(meta.tag)}</div>
        <h2 class="mdash-mode-title">${meta.name}</h2>
        <p class="mdash-mode-desc">${meta.desc}</p>
        ${customChips}
        ${mode === 'custom' ? `<button class="mdash-btn mdash-btn--ghost-purple mdash-config-btn" type="button" data-ui-action="custom-open">⚙ Configurar partida</button>` : ''}
        ${extra}
      </div>
      <div class="mdash-actions">
        <button class="mdash-cta" type="button" data-ui-action="${primaryAction}" aria-label="${escapeHtml(primaryLabel)}">
          ${playIcon({ size: 20 })}
          <span class="mdash-cta-text"><span class="mdash-cta-label">${escapeHtml(primaryLabel)}</span><span class="mdash-cta-sub">${escapeHtml(primarySub)}</span></span>
        </button>
        <button class="mdash-btn mdash-btn--create" type="button" data-ui-action="online-create"${onlineNetState.busy ? ' disabled' : ''}>+ Crear sala con amigos</button>
      </div>
    </div>`;
}

// Con sala: gestor "Control de anfitrión" sin scroll de página.
function renderMobileRoomManager(): string {
  const room = roomState.current!;
  const host = isOnlineHost();
  const player = currentOnlinePlayer();
  const ready = !!player?.ready;
  const readyCount = room.players.filter((p) => p.ready).length;
  const total = room.players.length;
  const isPublic = room.visibility === 'public';
  const isLobby = room.status === 'lobby';
  const canStart = ready && readyCount >= 2;
  const startReason = !ready
    ? 'Marcate listo para poder empezar'
    : (readyCount < 2 ? 'Necesitás al menos 2 jugadores listos' : 'Todo listo · arrancá la partida');
  const inviteUnavailable = !lunaState.identity?.gameId;

  const playersHtml = room.players.map((candidate) => {
    const isSelf = candidate.id === identityState.player.id;
    const isHost = candidate.id === room.hostPlayerId;
    const roleLabel = isHost ? 'Anfitrión' : isSelf ? 'Tu jugador' : 'Invitado';
    return `
      <div class="mdash-player">
        ${renderOnlineAvatar(candidate, 'medium', 'mdash-player-avatar')}
        <span class="mdash-player-copy">
          <span class="mdash-player-name">${escapeHtml(candidate.name)}${isSelf ? ' (Tú)' : ''}</span>
          <span class="mdash-player-role">${roleLabel}</span>
        </span>
        ${candidate.ready ? '<span class="mdash-player-ready">Listo ✓</span>' : ''}
      </div>`;
  }).join('');

  const inviteBtn = inviteUnavailable
    ? `<button class="mdash-add-friend" type="button" data-ui-action="luna-login"${onlineNetState.busy || lunaState.inviteWindowBusy ? ' disabled' : ''}>${lunaState.inviteWindowBusy ? 'Abriendo…' : 'Iniciar sesión para invitar'}</button>`
    : `<button class="mdash-add-friend" type="button" data-ui-action="online-open-invite"${onlineNetState.busy || lunaState.inviteWindowBusy ? ' disabled' : ''}>${lunaState.inviteWindowBusy ? 'Abriendo…' : '+ Invitar amigos'}</button>`;

  const visToggle = host && isLobby
    ? `<button class="mdash-vis-toggle ${isPublic ? 'is-public' : ''}" type="button" role="switch" aria-checked="${isPublic}" aria-label="${isPublic ? 'Sala pública' : 'Sala privada'}" data-ui-action="online-visibility-toggle"${onlineNetState.busy ? ' disabled' : ''}>
        <span class="mdash-vis-knob"></span>
      </button>`
    : '';

  return `
    <div class="mdash-room">
      <!-- HEADER (fijo) -->
      <div class="mdash-room-head">
        <div class="mdash-room-head-top">
          <div class="mdash-room-id">
            <div class="mdash-room-eyebrow">${isPublic ? 'SALA PÚBLICA' : 'SALA PRIVADA'}</div>
            <div class="mdash-room-code">${escapeHtml(room.id)}</div>
            <div class="mdash-room-status"><strong>${escapeHtml(matchTypeLabel(room.matchType))}</strong><span class="mdash-dot"></span><span>${escapeHtml(roomStatusLabel(room.status))}</span></div>
          </div>
          <span class="mdash-ready-badge">
            <span class="mdash-ready-count">${readyCount}/${total}</span>
            <span class="mdash-ready-label">LISTOS</span>
          </span>
        </div>
        <div class="mdash-room-quick">
          <button class="mdash-quick-btn" type="button" data-ui-action="online-copy-code" data-code="${escapeHtml(room.id)}">Copiar</button>
          <button class="mdash-quick-btn" type="button" data-ui-action="online-copy-invite-link">${roomInviteLinkRecentlyCopied() ? '¡Link copiado!' : 'Copiar link'}</button>
          ${visToggle}
        </div>
      </div>
      <!-- JUGADORES (único scroll) -->
      <div class="mdash-room-players mdash-scroll">
        <div class="mdash-room-players-head"><span>Jugadores</span><span>${readyCount}/${total} listos</span></div>
        ${renderOnlineError()}
        <div class="mdash-player-list">
          ${playersHtml}
          ${inviteBtn}
        </div>
      </div>
      <!-- ACCIONES (ancladas, siempre visibles) -->
      <div class="mdash-room-actions">
        ${isLobby && host
          ? `<button class="mdash-start" type="button" data-ui-action="online-start"${canStart ? '' : ' disabled'}>🚀 Empezar partida</button>
             <p class="mdash-start-reason">${startReason}</p>`
          : (!isLobby ? '<p class="mdash-start-reason">Ronda en curso…</p>' : '')}
        <div class="mdash-action-row">
          ${isLobby
            ? `<button class="mdash-ready ${ready ? 'is-ready' : ''}" type="button" data-ui-action="${ready ? 'online-unready' : 'online-ready'}">${ready ? '✓ Listo' : 'Marcarme listo'}</button>`
            : ''}
          <button class="mdash-leave" type="button" data-ui-action="online-leave">Salir</button>
        </div>
      </div>
    </div>`;
}

// Tops embebidos en la tarjeta Supervivencia: reusa las pestañas y los cuerpos del
// Top unificado (victorias + tiempo) sin el marco/acciones de la pantalla completa.
function renderSurvivalTopsEmbed(): string {
  const onSurvival = leaderboardState.tab === 'survival';
  return renderSurvivalTopsEmbedView({
    onSurvival,
    loading: onSurvival ? leaderboardState.survivalLoading : leaderboardState.loading,
    bodyHtml: onSurvival ? renderSurvivalLeaderboardBody() : renderWinsLeaderboardBody(),
  });
}

function renderDashboardCenterContent(_state: GameState): string {
  const mode = appMode;
  // Inicio (sin sala) = pantalla de bienvenida; con sala, el contexto pasa a ser el
  // hub de Jugar (gestor de sala), así que rendimos el smart-play stage.
  if (mode === 'menu') {
    return roomState.current ? renderSmartPlayStage() : renderWelcomeStage();
  }
  if (mode === 'playMenu' || mode === 'onlineMenu' || mode === 'roomLobby') {
    return renderSmartPlayStage();
  }
  if (mode === 'soloMenu') {
    return `
      <div class="menu-panel" style="width: 100%; max-width: 440px; border: none; background: transparent; box-shadow: none; padding: 0;">
        <div class="panel-eyebrow">SOLO</div>
        <h1 style="font-size: 36px; margin: 8px 0 16px; font-family: 'Arial Black', Arial, sans-serif;">Modos solo</h1>
        <p style="color: var(--dash-text-dim); margin-bottom: 24px; font-size: 14px; font-weight: 500;">Todos los modos disponibles para jugar local.</p>
        <div class="panel-actions mode-menu-actions" style="display: flex; flex-direction: column; gap: 12px; max-width: 320px;">
          <button class="dash-action-btn accent" type="button" data-ui-action="start">Jugar custom</button>
          <button class="dash-action-btn" type="button" data-ui-action="custom-open">Configurar custom</button>
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
    return renderHistory(getVisibleLibraryEntries(), { filter: libraryState.filter, totalRuns: runHistory.length });
  }
  if (mode === 'configMenu') {
    const softDrop = inputSettings.softDropFactor >= INSTANT_SOFT_DROP_FACTOR
      ? '∞'
      : `${inputSettings.softDropFactor} G`;
    return renderControls({
      das: `${inputSettings.dasFrames} f`,
      arr: `${inputSettings.arrFrames} f`,
      softDrop,
    });
  }
  if (mode === 'leaderboard' || mode === 'survivalTop') {
    return renderLeaderboardPanelContent();
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

// Top mundial UNIFICADO: una sola pantalla con dos pestañas — victorias de
// multijugador y tiempo de supervivencia — para que el ranking esté concentrado en
// un único lugar y quede claro cuál es cada uno.
// Orquestador del panel "Top mundial": elige la pestaña activa y delega el markup
// en la vista pura (src/ui/dashboard/leaderboard.ts).
function renderLeaderboardPanelContent(): string {
  const onSurvival = leaderboardState.tab === 'survival';
  return renderLeaderboardPanel({
    onSurvival,
    loading: onSurvival ? leaderboardState.survivalLoading : leaderboardState.loading,
    bodyHtml: onSurvival ? renderSurvivalLeaderboardBody() : renderWinsLeaderboardBody(),
  });
}

// Filas del top de victorias multijugador.
// Top de victorias multijugador: arma las filas desde leaderboardState y delega el
// markup en la vista pura renderLeaderboardBody.
function renderWinsLeaderboardBody(): string {
  const myId = identityState.player.id;
  return renderLeaderboardBody({
    loading: leaderboardState.loading,
    error: leaderboardState.error,
    rows: leaderboardState.entries.map((entry) => ({
      isMe: entry.playerId === myId,
      avatarHtml: renderOnlineAvatar({ name: entry.name, avatarUrl: entry.avatarUrl }, 'small', 'leaderboard-avatar'),
      name: entry.name,
      valueText: entry.wins === 1 ? '1 victoria' : `${entry.wins} victorias`,
    })),
    emptyMessage: 'Todavía no hay victorias registradas. ¡Ganá una partida multijugador y aparecé acá!',
  });
}

// Top de supervivencia (mayor tiempo sobrevivido, formatFrames).
function renderSurvivalLeaderboardBody(): string {
  const myId = identityState.player.id;
  return renderLeaderboardBody({
    loading: leaderboardState.survivalLoading,
    error: leaderboardState.survivalError,
    rows: leaderboardState.survivalEntries.map((entry) => ({
      isMe: entry.playerId === myId,
      avatarHtml: renderOnlineAvatar({ name: entry.name, avatarUrl: entry.avatarUrl }, 'small', 'leaderboard-avatar'),
      name: entry.name,
      valueText: formatFrames(Math.round(entry.bestMs / GAME_FRAME_MS)),
    })),
    emptyMessage: 'Todavía no hay tiempos registrados. ¡Jugá Supervivencia y aguantá lo más posible para aparecer acá!',
  });
}

// Orquestador stateful del panel de sala: deriva del estado del shell (roomState,
// lunaState, onlineNetState, identityState) y delega el markup en la vista pura
// (src/ui/dashboard/roomPanel.ts). Los sub-paneles con estado (error, toggle de
// visibilidad, apuesta) y los avatares se pre-renderizan acá.
function renderDashboardRoomPanel(): string {
  const room = roomState.current;
  const inviteUnavailable = !lunaState.identity?.gameId;

  if (!room) {
    return renderRoomPanelEmpty({
      publicRooms: roomState.publicRooms.slice(0, 4).map((candidateRoom) => ({
        id: candidateRoom.id,
        hostName: candidateRoom.hostName,
        avatarHtml: renderOnlineAvatar({ name: candidateRoom.hostName, avatarUrl: candidateRoom.hostAvatarUrl }, 'small', 'dash-public-room-avatar'),
        playerCount: candidateRoom.playerCount,
      })),
      joinCode: identityState.joinCode,
      busy: onlineNetState.busy,
      isDev: import.meta.env.DEV,
      onlineErrorHtml: renderOnlineError(),
      roomIdMaxLength: ROOM_ID_MAX_LENGTH,
    });
  }

  const host = room.hostPlayerId === identityState.player.id;
  const inLobby = room.status === 'lobby';
  return renderRoomPanelActive({
    roomId: room.id,
    isPrivate: room.visibility === 'private',
    host,
    inLobby,
    readyCount: room.players.filter((candidate) => candidate.ready).length,
    playerCount: room.players.length,
    matchText: matchTypeLabel(room.matchType),
    statusText: roomStatusLabel(room.status),
    visibilityText: room.visibility === 'private' ? 'Privada' : 'Pública',
    speedLevelText: roomSpeedLabel(room.rules),
    roomPurposeText: host
      ? 'Gestioná jugadores, invitaciones y listos desde este panel. Cuando estén listos, el botón central empieza la partida.'
      : 'Marcá tu estado desde el botón central y seguí la sala desde este panel mientras el anfitrión prepara la partida.',
    players: room.players.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      avatarHtml: renderOnlineAvatar(candidate, 'medium', 'dash-player-avatar-circle'),
      isHost: candidate.id === room.hostPlayerId,
      isSelf: candidate.id === identityState.player.id,
      isReady: candidate.ready,
    })),
    inviteLinkCopied: roomInviteLinkRecentlyCopied(),
    inviteUnavailable,
    inviteWindowBusy: lunaState.inviteWindowBusy,
    busy: onlineNetState.busy,
    onlineErrorHtml: renderOnlineError(),
    visibilityToggleHtml: host && inLobby ? renderPersistentRoomVisibilityToggle() : '',
    betPanelHtml: renderOnlineBetPanel(host),
  });
}


function renderEmptyPersistentRoomPanel(): string {
  const publicRooms = roomState.publicRooms.length === 0
    ? '<div class="online-empty">No hay salas públicas.</div>'
    : roomState.publicRooms.slice(0, 4).map((room) => `
      <article class="persistent-room-row">
        <div>
          <strong>${escapeHtml(room.id)}</strong>
          <span>${escapeHtml(room.hostName)} · ${escapeHtml(matchTypeLabel(room.matchType))} · ${room.playerCount}</span>
        </div>
        <button class="cs2-btn cs2-btn-sm" type="button" data-ui-action="online-join-public" data-room-id="${escapeHtml(room.id)}"${onlineNetState.busy ? ' disabled' : ''}>Unirse</button>
      </article>
    `).join('');
  return `
    <aside class="persistent-room-panel" aria-label="Sala">
      <div class="persistent-room-head">
        <div>
          <span class="panel-eyebrow">SALA</span>
          <h2>Disponible</h2>
        </div>
        <button class="cs2-btn cs2-btn-ghost cs2-btn-sm" type="button" data-ui-action="online-refresh"${onlineNetState.busy ? ' disabled' : ''}>Refresh</button>
      </div>
      ${renderOnlineError()}
      ${renderLunaIdentityBadge()}
      <div class="persistent-room-actions">
        <button class="cs2-btn cs2-btn-accent" type="button" data-ui-action="online-create-public"${onlineNetState.busy ? ' disabled' : ''}>Crear pública</button>
        <button class="cs2-btn" type="button" data-ui-action="online-create-private"${onlineNetState.busy ? ' disabled' : ''}>Crear privada</button>
      </div>
      <div class="online-join-row">
        <label class="online-field">
          <span>Código</span>
          <input type="text" maxlength="${ROOM_ID_MAX_LENGTH}" value="${escapeHtml(identityState.joinCode)}" data-online-field="join-code" autocomplete="off" />
        </label>
        <button class="cs2-btn" type="button" data-ui-action="online-join"${onlineNetState.busy ? ' disabled' : ''}>Unirse</button>
      </div>
      <div class="persistent-room-public">
        <div class="cs2-card-head"><span>Públicas</span></div>
        <div class="persistent-room-list">${publicRooms}</div>
      </div>
    </aside>
  `;
}

function renderActivePersistentRoomPanel(): string {
  if (!roomState.current) return '';
  const host = roomState.current.hostPlayerId === identityState.player.id;
  const player = currentOnlinePlayer();
  const readyCount = roomState.current.players.filter((candidate) => candidate.ready).length;
  const visibilityActions = host && roomState.current.status === 'lobby' ? renderPersistentRoomVisibilityToggle() : '';
  return `
    <aside class="persistent-room-panel" aria-label="Sala actual">
      <div class="persistent-room-head">
        <div>
          <span class="panel-eyebrow">${escapeHtml(roomState.current.visibility === 'private' ? 'SALA PRIVADA' : 'SALA PÚBLICA')}</span>
          <h2>${escapeHtml(roomState.current.id)}</h2>
        </div>
        <span class="cs2-ready-pill">${readyCount}/${roomState.current.players.length}</span>
      </div>
      <p class="persistent-room-status">${escapeHtml(matchTypeLabel(roomState.current.matchType))} · ${escapeHtml(roomStatusLabel(roomState.current.status))}</p>
      ${renderOnlineError()}
      ${visibilityActions}
      <div class="persistent-room-players">
        ${roomState.current.players.map((candidate) => renderLobbyPlayer(candidate, host)).join('')}
      </div>
      ${renderLunaInviteAction(host)}
      <div class="cs2-lobby-actions">
        ${roomState.current.status === 'lobby'
          ? `${player?.ready
            ? '<button class="cs2-btn" type="button" data-ui-action="online-unready">No listo</button>'
            : '<button class="cs2-btn cs2-btn-accent" type="button" data-ui-action="online-ready">Listo</button>'}
            ${host ? `<span class="cs2-start-hint">El host arranca con ▶ arriba</span>` : ''}`
          : '<button class="cs2-btn" type="button" disabled>Ronda en curso…</button>'}
        <button class="cs2-btn cs2-btn-danger" type="button" data-ui-action="online-leave">Salir</button>
      </div>
    </aside>
  `;
}

// Toggle compacto pública/privada: un switch que alterna la visibilidad de la
// sala sin tocar nada más (solo lo ve el host y solo en el lobby).
function renderPersistentRoomVisibilityToggle(): string {
  if (!roomState.current) return '';
  const isPublic = roomState.current.visibility === 'public';
  return `
    <div class="room-visibility-toggle" aria-label="Visibilidad de sala">
      <span class="room-visibility-label ${isPublic ? '' : 'is-active'}">Privada</span>
      <button
        class="custom-toggle ${isPublic ? 'custom-toggle-on' : 'custom-toggle-off'}"
        type="button"
        role="switch"
        aria-checked="${isPublic}"
        aria-label="Sala pública"
        data-ui-action="online-visibility-toggle"${onlineNetState.busy ? ' disabled' : ''}
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
    splits: runState.splitTracker.getSplits(),
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
  if (appMode === 'replayPlayback') {
    return `${primaryKey('pause')} Pausa · ${primaryKey('retry')} Reiniciar · M Sonido · N Música`;
  }
  return [
    `Mover ${primaryKey('moveLeft')} ${primaryKey('moveRight')}`,
    `Rotar ${primaryKey('rotateCW')}`,
    `Bajar ${primaryKey('softDrop')}`,
    `Soltar ${primaryKey('hardDrop')}`,
    `Guardar ${primaryKey('hold')}`,
    `Pausa ${primaryKey('pause')}`,
    `Reiniciar ${primaryKey('retry')}`,
    `Sonido M`,
    `Música N`,
  ].join('  ·  ');
}

// Para bajar la carga cognitiva mostramos sólo la tecla principal de cada acción
// (no todas las alternativas) y usamos flechas en vez de "Left/Right/Up/Down".
function primaryKey(action: ControlAction): string {
  const bindings = inputSettings.bindings[action];
  if (bindings.length === 0) return '—';
  return helpKeyGlyph(bindings[0]);
}

function helpKeyGlyph(code: string): string {
  switch (code) {
    case 'ArrowLeft': return '←';
    case 'ArrowRight': return '→';
    case 'ArrowUp': return '↑';
    case 'ArrowDown': return '↓';
    case 'Space': return 'Espacio';
    default: return keyLabel(code);
  }
}

function formatActionBinding(action: ControlAction): string {
  const bindings = inputSettings.bindings[action];
  return bindings.length > 0 ? bindings.map(keyLabel).join('/') : 'Unbound';
}

// La capa Juice es 100% efectos: se calla con el mute maestro o con el mute de SFX.
function syncSfxMuteToJuice(): void {
  setJuiceMuted(sound.isMuted() || sound.isSfxMuted());
}

// Normaliza el delta de la rueda a píxeles. deltaMode 1 = líneas (algunos mouse),
// 2 = páginas; los convertimos para que mouse y touchpad se comporten parecido.
function wheelDeltaToPixels(event: WheelEvent): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * window.innerHeight;
  return event.deltaY;
}

function handleVolumeWheel(event: WheelEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const control = target.closest<HTMLElement>('[data-volume-channel]');
  if (!control) return;
  const channel: VolumeChannel = control.dataset.volumeChannel === 'music' ? 'music' : 'sfx';
  const pixels = wheelDeltaToPixels(event);
  if (pixels === 0) return;
  // Cambio proporcional al desplazamiento (estilo tetr.io). El mouse manda
  // "muescas" grandes (~100px ⇒ un paso completo); el touchpad manda muchos
  // eventos chiquitos que suman de a poco, en vez de saltar un paso fijo por
  // evento. El tope por evento evita brincos con muescas enormes. Scroll
  // arriba (deltaY < 0) sube el volumen.
  let change = -pixels * (VOLUME_WHEEL_STEP / 100);
  change = Math.max(-VOLUME_WHEEL_MAX_STEP, Math.min(VOLUME_WHEEL_MAX_STEP, change));
  sound.adjustVolume(channel, change);
  best = saveAudioVolumes(sound.getSfxVolume(), sound.getMusicVolume());
  if (channel === 'sfx') setJuiceSfxVolume(sound.getSfxVolume());
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

// Ícono de altavoz (encendido / silenciado) para los botones de mute por canal.
// Fila de un canal de audio (SFX o BGM): botón de mute + etiqueta + porcentaje.
// El contenedor lleva data-volume-channel para que la rueda del mouse/touchpad
// lo ajuste (ver handleVolumeWheel). Compartida por el HUD y la tarjeta relax.
function renderVolumeChannelRow(channel: VolumeChannel): string {
  const isMusic = channel === 'music';
  const label = isMusic ? 'BGM' : 'SFX';
  const muted = isMusic ? sound.isMusicMuted() : sound.isSfxMuted();
  const volume = isMusic ? sound.getMusicVolume() : sound.getSfxVolume();
  const toggleAction = isMusic ? 'toggle-music' : 'toggle-sfx';
  const classes = [
    'volume-control',
    getActiveVolumeChannel() === channel ? 'volume-control-active' : '',
    muted ? 'volume-control-muted' : '',
  ].filter(Boolean).join(' ');
  return `
    <div class="${classes}" data-volume-channel="${channel}" title="Rueda del mouse o touchpad para ajustar">
      <button class="volume-mute" type="button" data-ui-action="${toggleAction}" aria-pressed="${muted}" aria-label="${muted ? 'Activar' : 'Silenciar'} ${label}" title="${muted ? 'Activar' : 'Silenciar'} ${label}">${speakerIcon(muted)}</button>
      <span class="volume-label">${label}</span>
      <span class="volume-value">${formatPercent(volume)}%</span>
    </div>`;
}

// Fila de volumen para el panel de Configuración: botón de mute + etiqueta +
// botones −/+ (paso de 10%) + porcentaje. El contenedor lleva data-volume-channel
// para que también responda a la rueda del mouse/touchpad (ver handleVolumeWheel).
function renderVolumeSettingRow(channel: VolumeChannel): string {
  const isMusic = channel === 'music';
  const label = isMusic ? 'Música' : 'Efectos';
  const muted = isMusic ? sound.isMusicMuted() : sound.isSfxMuted();
  const volume = isMusic ? sound.getMusicVolume() : sound.getSfxVolume();
  const toggleAction = isMusic ? 'toggle-music' : 'toggle-sfx';
  return `
    <div class="volume-setting-row${muted ? ' is-muted' : ''}" data-volume-channel="${channel}" title="También podés usar la rueda del mouse">
      <button class="volume-mute" type="button" data-ui-action="${toggleAction}" aria-pressed="${muted}" aria-label="${muted ? 'Activar' : 'Silenciar'} ${label}" title="${muted ? 'Activar' : 'Silenciar'} ${label}">${speakerIcon(muted)}</button>
      <span class="volume-setting-label">${label}</span>
      <button type="button" data-ui-action="volume-adjust" data-volume-channel="${channel}" data-delta="-0.1" aria-label="Bajar ${label}">−</button>
      <span class="volume-setting-value">${Math.round(volume * 100)}%</span>
      <button type="button" data-ui-action="volume-adjust" data-volume-channel="${channel}" data-delta="0.1" aria-label="Subir ${label}">+</button>
    </div>`;
}

// Fila de ajuste "sólo música libre de derechos" (temas cuyo archivo empieza con
// 'ncc'). Siempre visible para que se pueda encontrar; si no hay ninguno cargado,
// el título avisa que activarlo deja la música en silencio.
function renderRoyaltyFreeToggleRow(): string {
  const on = loadRecord().royaltyFreeOnly;
  const hint = HAS_ROYALTY_FREE_TRACKS
    ? 'Reproducí sólo temas cuyo archivo empieza con ncc.'
    : 'No hay temas libres de derechos cargados (archivos con prefijo ncc). Activarlo dejará la música en silencio.';
  return renderCustomRow('Sólo música libre de derechos', `
    <button class="custom-toggle ${on ? 'custom-toggle-on' : 'custom-toggle-off'}" type="button" role="switch" aria-checked="${on}" aria-label="Sólo música libre de derechos" title="${hint}" data-ui-action="toggle-royalty-free">
      <span class="custom-toggle-knob"></span>
    </button>
  `);
}

// Sección "Controles táctiles" del panel de Configuración: selector de esquema
// (Pro/Simple/D-pad) + vibración. Antes vivían en una barra de chips sobre los
// botones táctiles; se movieron acá para liberar alto de tablero en celular. Sólo
// tiene sentido en dispositivos táctiles, así que se omite con puntero fino.
function renderTouchSettingsSection(): string {
  if (typeof window === 'undefined' || !window.matchMedia('(pointer: coarse)').matches) return '';
  const hapticsOn = touchHapticsEnabled;
  return renderCustomSection('Controles táctiles', [
    renderCustomRow('Esquema', `
      <button class="binding-button" type="button" data-ui-action="cycle-touch-scheme" aria-label="Cambiar esquema de control táctil">${TOUCH_SCHEME_LABELS[touchScheme]}</button>
    `),
    renderCustomRow('Vibración', `
      <button class="custom-toggle ${hapticsOn ? 'custom-toggle-on' : 'custom-toggle-off'}" type="button" role="switch" aria-checked="${hapticsOn}" aria-label="Vibración" data-ui-action="toggle-touch-haptics">
        <span class="custom-toggle-knob"></span>
      </button>
    `),
  ]);
}

// Tarjeta compacta de volumen para el modo relax (arriba a la derecha, bajo el
// engranaje): muteo y ajuste por canal sin pausar la partida.
function renderRelaxAudio(): string {
  return `
    <div class="relax-audio" aria-label="Volumen">
      ${renderVolumeChannelRow('sfx')}
      ${renderVolumeChannelRow('music')}
    </div>`;
}

// Paneo posicional de un sonido del tablero CENTRADO (el tuyo o el enfocado como
// espectador), a partir de la columna donde ocurre. Como el tablero está centrado en
// pantalla, el efecto es leve y sigue a la pieza activa de un borde al otro.
function panForBoardColumn(col: number | null | undefined): number {
  if (col == null || !isPositionalAudio()) return 0;
  const rect = renderer.boardGeometry();
  if (!rect || rect.cell <= 0) return 0;
  const screenX = rect.boardX + (col + 0.5) * rect.cell;
  return panForScreenX(screenX);
}

// Paneo de la pieza activa de TU motor local (cues de input move/rotate/hardDrop/...).
function localPiecePan(): number {
  try {
    return panForBoardColumn(engine.getState().active?.x);
  } catch {
    return 0;
  }
}

function playImmediateInputSounds(actions: InputAction[]): void {
  const pan = localPiecePan();
  for (const action of actions) {
    if (action === 'rotateCW' || action === 'rotateCCW' || action === 'rotate180') sound.play('rotate', pan);
    if (action === 'softDrop') sound.play('softDrop', pan);
    if (action === 'hardDrop') {
      sound.play('hardDrop', pan);
      juice.onHardDrop();
    }
    if (action === 'hold') sound.play('hold', pan);
  }
}

function playAcceptedMoveSound(before: { type: string; x: number } | null, after: { type: string; x: number } | null, actions: InputAction[]): void {
  const requestedHorizontalMove = actions.some((action) => action === 'moveLeft' || action === 'moveRight');
  if (!requestedHorizontalMove || !before || !after) return;
  if (before.type === after.type && before.x !== after.x) sound.play('move', panForBoardColumn(after.x));
}

// Disparo por flanco del bump de pared: 0 = sin contacto, -1/1 = pared ya tocada
// de ese lado. Evita que el tablero rebote en cada frame mientras se mantiene la
// tecla contra la pared (DAS/ARR); solo en el frame del impacto.
let lastWallImpactDir: -1 | 0 | 1 = 0;

/** Empuja el tablero hacia la pared cuando la pieza choca contra el borde izq/der
 * (estilo tetr.io). Solo cuenta el borde del tablero, no la pila. */
function triggerWallImpact(
  before: ActivePiece | null,
  after: ActivePiece | null,
  actions: InputAction[],
  boardWidth: number,
): void {
  // Pieza nueva/cambiada, o se movió de columna: el flanco se rearma para que el
  // próximo bloqueo contra la pared dispare el bump. Importante: NO rearmar en los
  // huecos de ARR (ticks sin acción horizontal mientras se mantiene la tecla), o el
  // tablero rebotaría en cada repetición en vez de una sola vez por contacto.
  if (!after || !before || before.type !== after.type || before.x !== after.x) {
    lastWallImpactDir = 0;
    return;
  }
  const wantsLeft = actions.includes('moveLeft');
  const wantsRight = actions.includes('moveRight');
  // Dirección inequívoca: si se pidieron ambos lados en el mismo tick, se ignora.
  const dir: -1 | 1 | 0 = wantsLeft && !wantsRight ? -1 : wantsRight && !wantsLeft ? 1 : 0;
  if (dir === 0) return; // tick sin intento horizontal claro: preserva el flanco
  // El movimiento se bloqueó (x no cambió). ¿Es contra la PARED (no contra la pila)?
  const cols = cellsFor(after.type, after.rotation).map((c) => after.x + c.x);
  const atWall = dir === -1 ? Math.min(...cols) === 0 : Math.max(...cols) === boardWidth - 1;
  if (!atWall) return;
  if (lastWallImpactDir !== dir) {
    juice.onWallHit(dir);
    lastWallImpactDir = dir;
  }
}

function rulesForRun(mode: AppMode): GameRules {
  if (mode === 'onlinePlaying') return onlineRulesFromRoom();
  if (runState.currentRunKind === 'survival') return survivalRulesFromSettings(inputSettings);
  return customRulesFromSettings(customSettings, inputSettings);
}

// Supervivencia sube un nivel de gravedad cada N segundos pase lo que pase. Sin esto
// la velocidad solo subía limpiando líneas, así que estancarse en nivel 1 dejaba
// sobrevivir indefinidamente y el ranking medía aguante, no skill. Con la rampa por
// tiempo la partida converge (~10-12 min para los mejores) y el tiempo mide cuánta
// velocidad bancás. Tuneable: bajarlo = partidas más cortas/agresivas.
const SURVIVAL_GRAVITY_SECONDS_PER_LEVEL = 30;

// Reglas FIJAS del modo Supervivencia: iguales para todos para que los tiempos sean
// comparables. Sin meta de líneas (endless), gravedad guideline que sube con las
// líneas Y con el tiempo (hasta que perdés). Solo el handling (DAS/ARR/soft drop)
// sigue la preferencia del jugador, igual que en las batallas online (no afecta la
// dificultad).
function survivalRulesFromSettings(settings: InputSettings): GameRules {
  return {
    ...BATTLE_RULES,
    // Sin rivales no hay basura entrante; la tabla de ataque es irrelevante en solo.
    attackTable: 'simple',
    gravityLevelSeconds: SURVIVAL_GRAVITY_SECONDS_PER_LEVEL,
    dasFrames: settings.dasFrames,
    arrFrames: settings.arrFrames,
    softDropCellsPerFrame: softDropCellsPerFrameForFactor(settings.softDropFactor),
  };
}

function battleRulesFromSettings(settings: InputSettings): GameRules {
  return {
    ...BATTLE_RULES,
    dasFrames: settings.dasFrames,
    arrFrames: settings.arrFrames,
    softDropCellsPerFrame: softDropCellsPerFrameForFactor(settings.softDropFactor),
  };
}

function onlineCustomRulesFromSettings(): GameRules {
  return {
    ...customRulesFromSettings(customSettings, inputSettings),
    targetLines: null,
  };
}

// Parche de ruleset que el HOST adjunta al crear o re-configurar la sala: lleva su
// preferencia de música libre de derechos para que todos los clientes reproduzcan la
// misma playlist durante la partida (ver maybeStartOnlineRun / applyOnlineRoomMusic).
// Es un parche PARCIAL: el server completa el resto del ruleset con sus defaults.
function onlineRulesetPatch(): Partial<OnlineRuleset> {
  return { royaltyFreeOnly: loadRecord().royaltyFreeOnly };
}

// true mientras la playlist está reemplazada por la de la sala online. Al salir de la
// sala restauramos la preferencia local del cliente (ver restoreLocalMusicPlaylist).
let onlineMusicOverrideActive = false;

// Aplica la música compartida de la sala: filtra la playlist por la preferencia del
// HOST (royaltyFreeOnly del ruleset, no la del cliente) y fuerza la MISMA pista en
// todos arrancándola desde el principio. El índice deriva de la seed de la sala, que
// es idéntica en todos los clientes, así el tema coincide. Respeta el mute/volumen
// local: si el cliente tiene la música silenciada, no suena (pero queda sincronizada).
function applyOnlineRoomMusic(room: OnlineRoom): void {
  const tracks = musicTracksFor(room.ruleset.royaltyFreeOnly);
  if (!tracks.length) return; // host pidió libre-de-derechos pero no hay temas 'ncc'
  const index = Math.abs(Math.trunc(room.seed)) % tracks.length;
  sound.setSyncedPlaylist(tracks, index);
  onlineMusicOverrideActive = true;
}

// Devuelve la playlist a la preferencia LOCAL del cliente tras dejar la sala online.
function restoreLocalMusicPlaylist(): void {
  if (!onlineMusicOverrideActive) return;
  onlineMusicOverrideActive = false;
  sound.setMusicTracks(musicTracksFor(loadRecord().royaltyFreeOnly));
}

function onlineRulesFromRoom(room = roomState.current): GameRules {
  const sharedRules = room?.rules ?? battleRulesFromSettings(inputSettings);
  return {
    ...sharedRules,
    attackTable: room?.ruleset.attackTable ?? sharedRules.attackTable,
    dasFrames: inputSettings.dasFrames,
    arrFrames: inputSettings.arrFrames,
    softDropCellsPerFrame: softDropCellsPerFrameForFactor(inputSettings.softDropFactor),
  };
}

// Etiqueta de la tarjeta "Velocidad" del panel de sala. Refleja la gravedad real
// configurada, no solo el nivel inicial: en modo guideline la gravedad la define el
// nivel (mostramos "Nivel X"); en modo lineal mostramos la gravedad efectiva de
// arranque (en G o celdas/seg). El "↑" indica que la velocidad sube en la partida.
function roomSpeedLabel(rules: GameRules | undefined): string {
  if (!rules) return 'Nivel 1';
  const climbsLevels = rules.gravityLevelLines > 0 || rules.gravityLevelPieces > 0;
  if (rules.gravityCurve === 'guideline') {
    const level = Math.max(1, Math.floor(rules.gravityStartingLevel));
    return `Nivel ${level}${climbsLevels ? ' ↑' : ''}`;
  }
  const ramps = climbsLevels && rules.gravityIncreaseCellsPerLevel > 0;
  const startG = currentGravityCellsPerFrame(rules, { lines: 0, pieces: 0 });
  return `${formatGravitySpeed(startG)}${ramps ? ' ↑' : ''}`;
}

// Gravedad (celdas por frame) a texto legible: 1G = 1 celda/frame (60 celdas/seg).
function formatGravitySpeed(cellsPerFrame: number): string {
  if (cellsPerFrame >= 20) return 'Instantánea';
  if (cellsPerFrame >= 1) return `${formatCustomNumber(Number(cellsPerFrame.toFixed(2)))}G`;
  return `${formatCustomNumber(Number((cellsPerFrame * 60).toFixed(2)))} cel/s`;
}

function parseControlAction(value: string | undefined): ControlAction | null {
  if (!value) return null;
  return CONTROL_ACTIONS.includes(value as ControlAction) ? value as ControlAction : null;
}

function onlineRoomHasOtherPlayers(): boolean {
  return !!roomState.current && roomState.current.players.some((player) => player.id !== identityState.player.id);
}

function touchSourceId(pointerId: number): string {
  return `touch:${pointerId}`;
}

function setLibraryFilter(value: string | undefined): void {
  if (!isLibraryFilter(value)) return;
  libraryState.filter = value;
  libraryState.error = null;
  syncLibrarySelection();
}

function selectHistoryEntry(id: string | undefined): void {
  const entry = findHistoryEntry(id);
  if (!entry) {
    libraryState.error = 'Replay entry was not found.';
    return;
  }
  libraryState.selectedHistoryEntryId = entry.id;
  libraryState.error = null;
}

function findHistoryEntry(id: string | undefined): RunHistoryEntry | null {
  if (!id) return null;
  return runHistory.find((entry) => entry.id === id) ?? null;
}

function syncLibrarySelection(): void {
  const visibleEntries = getVisibleLibraryEntries();
  if (visibleEntries.length === 0) {
    libraryState.selectedHistoryEntryId = null;
    return;
  }
  if (!visibleEntries.some((entry) => entry.id === libraryState.selectedHistoryEntryId)) {
    libraryState.selectedHistoryEntryId = visibleEntries[0].id;
  }
}

function getSelectedLibraryEntry(visibleEntries = getVisibleLibraryEntries()): RunHistoryEntry | null {
  return visibleEntries.find((entry) => entry.id === libraryState.selectedHistoryEntryId) ?? visibleEntries[0] ?? null;
}

function getVisibleLibraryEntries(): RunHistoryEntry[] {
  const entries = runHistory.filter((entry) => {
    if (libraryState.filter === 'clear' || libraryState.filter === 'best') return entry.status === 'finished';
    if (libraryState.filter === 'topout') return entry.status === 'gameover';
    return true;
  });
  if (libraryState.filter === 'best') {
    return [...entries].sort((a, b) => a.elapsedFrames - b.elapsedFrames || a.createdAt.localeCompare(b.createdAt));
  }
  return entries;
}

function libraryEmptyText(): string {
  if (runHistory.length === 0) return 'No saved runs yet.';
  if (libraryState.filter === 'clear' || libraryState.filter === 'best') return 'No clears saved yet.';
  if (libraryState.filter === 'topout') return 'No top outs saved yet.';
  return 'No matching replays.';
}

function isLibraryFilter(value: string | undefined): value is LibraryFilter {
  return LIBRARY_FILTERS.includes(value as LibraryFilter);
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

function replayProgressPercent(snapshot: ReplayPlaybackSnapshot): string {
  if (snapshot.targetFrame <= 0) return '100';
  return Math.min(100, Math.max(0, (snapshot.frame / snapshot.targetFrame) * 100)).toFixed(2);
}

function formatPercent(volume: number): string {
  return Math.round(volume * 100).toString().padStart(3, ' ');
}

function reverbLabel(mode: ReverbMode): string {
  const labels: Record<ReverbMode, string> = {
    off: 'Off',
    short: 'Corto',
    medium: 'Medio',
    long: 'Largo',
  };
  return labels[mode];
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
  return roomState.current?.hostPlayerId === identityState.player.id;
}

function createProgressRequest(playerId: string, game: OnlineGameSnapshot): ProgressRequest {
  const player = roomState.current?.players.find((candidate) => candidate.id === playerId);
  return {
    roomId: roomState.current?.id ?? '',
    authorityPlayerId: identityState.player.id,
    playerId,
    seed: roomState.current?.seed,
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
    seed: roomState.current?.seed,
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
  return roomState.current?.players.find((player) => player.id === identityState.player.id) ?? null;
}

function parseTargetingMode(value: string | undefined): TargetingMode | null {
  return TARGETING_MODES.includes(value as TargetingMode) ? value as TargetingMode : null;
}

function prependUnique(values: string[], value: string, limit: number): string[] {
  return [value, ...values.filter((candidate) => candidate !== value)].slice(0, limit);
}

function onlineErrorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Online request failed.';
}

function syncOnlineClock(serverNowMs: number): void {
  if (!Number.isFinite(serverNowMs)) return;
  // Offset relativo al reloj monotónico local. Cada poll (~750ms) lo recalcula con la
  // latencia de red del momento: NO lo aplicamos de golpe (eso congelaba/adelantaba el
  // motor a tirones), solo movemos el objetivo y dejamos que slewOnlineClock() lo alcance.
  onlineClockState.serverOffsetTargetMs = serverNowMs - performance.now();
  // Primer sync, o desfase grande (segundo plano / reanudación): snap directo, sin slew.
  const snapDelta = Math.abs(onlineClockState.serverOffsetTargetMs - onlineClockState.serverOffsetMs);
  if (!onlineClockState.synced || snapDelta > ONLINE_CLOCK_SNAP_MS) {
    // Solo cuentan como "lag" los snaps en marcha (no el primer sync, que es esperable).
    if (onlineClockState.synced) onlineClockState.snapMsThisFrame = snapDelta;
    onlineClockState.serverOffsetMs = onlineClockState.serverOffsetTargetMs;
    onlineClockState.synced = true;
    onlineClockState.lastSlewAt = performance.now();
  }
}

// Acerca suavemente el offset efectivo al objetivo (slew exponencial ~0.25s). Se llama
// cada frame mientras hay sala (ver syncOnline). Mantiene el promedio del reloj del server
// (host y cliente siguen alineados, frameSkew≈0) pero elimina los saltos por-poll que
// hacían avanzar el motor a tirones → input parejo en multijugador.
function slewOnlineClock(): void {
  const now = performance.now();
  const dt = onlineClockState.lastSlewAt > 0 ? now - onlineClockState.lastSlewAt : 0;
  onlineClockState.lastSlewAt = now;
  const diff = onlineClockState.serverOffsetTargetMs - onlineClockState.serverOffsetMs;
  if (dt <= 0 || diff === 0) return;
  const factor = 1 - Math.exp(-dt / ONLINE_CLOCK_SMOOTH_TAU_MS);
  onlineClockState.serverOffsetMs += diff * factor;
}

function onlineNowMs(): number {
  return performance.now() + onlineClockState.serverOffsetMs;
}

function normalizeProgressInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value as number));
}

