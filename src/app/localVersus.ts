import { GameEngine } from '../game/engine';
import { BATTLE_RULES } from '../game/rules';
import { InputController } from '../input';
import { GamepadController } from '../gamepad';
import {
  cloneInputSettings,
  loadInputSettings,
  type ControlAction,
  type InputBindings,
  type InputSettings,
} from '../input/settings';
import { drawBoardToCanvas, sizeBoardCanvas } from '../renderer/boardCanvas';
import type { GameInput, GameState, InputAction } from '../game/types';

// ─────────────────────────────────────────────────────────────────────────────
// DUELO LOCAL (1 vs 1 en la misma computadora)
//
// Modo pensado para un stand de conferencia: dos personas en una sola pantalla,
// dos tableros lado a lado, cada una con su teclado o su mando. Reusa el motor
// real (GameEngine + reglas de batalla), el InputController/GamepadController y el
// dibujo Canvas2D autónomo (boardCanvas) que ya alimenta el visor multi-tablero.
//
// Es 100% local: no toca la red ni el flujo online. Corre su propio loop a 60Hz,
// con dos motores que intercambian basura en el mismo frame (sin latencia). La
// apuesta por QR (depósito + retiro LNURL) se engancha aparte; este archivo es
// solo el juego.
// ─────────────────────────────────────────────────────────────────────────────

const FRAME_MS = 1000 / 60;
const COUNTDOWN_SECONDS = 3;

export type SeatDevice = 'keyboard' | `gamepad:${number}`;

export interface LocalVersusSeatConfig {
  device: SeatDevice;
}

export interface LocalVersusAudioHooks {
  countdownTick?(): void;
  countdownGo?(): void;
  gameOver?(seat: 1 | 2): void;
  win?(seat: 1 | 2): void;
}

export interface LocalVersusOptions {
  colorBlind?: boolean;
  onExit: () => void;
  audio?: LocalVersusAudioHooks;
}

type Phase = 'seatSetup' | 'countdown' | 'playing' | 'finished';
type Outcome = 'playing' | 'seat1' | 'seat2' | 'draw';

// ── Lógica pura (testeable sin DOM) ──────────────────────────────────────────

// Intercambio de basura: cada asiento ataca al otro por la diferencia de su
// `sentGarbage` acumulado desde el frame anterior (mismo patrón que el host
// online, pero acá la víctima es el motor local del rival, sin red de por medio).
export function pendingAttacks(
  prevSent: { seat1: number; seat2: number },
  sent1: number,
  sent2: number,
): { toSeat1: number; toSeat2: number; next: { seat1: number; seat2: number } } {
  return {
    toSeat2: Math.max(0, sent1 - prevSent.seat1),
    toSeat1: Math.max(0, sent2 - prevSent.seat2),
    next: { seat1: sent1, seat2: sent2 },
  };
}

// Quién ganó según el estado de cada motor. Empate si ambos topan el mismo frame
// (puede pasar cuando la basura recíproca mata a los dos a la vez).
export function decideOutcome(status1: GameState['status'], status2: GameState['status']): Outcome {
  const dead1 = status1 === 'gameover';
  const dead2 = status2 === 'gameover';
  if (dead1 && dead2) return 'draw';
  if (dead2) return 'seat1';
  if (dead1) return 'seat2';
  return 'playing';
}

// Bindings de teclado disjuntos por asiento, para que dos jugadores compartan el
// mismo teclado sin pisarse. El mando es el camino preferido en el stand; esto es
// el respaldo. Asiento 1 = mano izquierda (WASD + cluster derecho IJKL); asiento 2
// = flechas + cluster numérico/puntuación.
const SEAT1_BINDINGS: InputBindings = {
  moveLeft: ['KeyA'],
  moveRight: ['KeyD'],
  softDrop: ['KeyS'],
  hardDrop: ['KeyW'],
  rotateCCW: ['KeyJ'],
  rotateCW: ['KeyL'],
  rotate180: ['KeyK'],
  hold: ['KeyI', 'Tab'],
  retry: [],
  pause: [],
};

const SEAT2_BINDINGS: InputBindings = {
  moveLeft: ['ArrowLeft'],
  moveRight: ['ArrowRight'],
  softDrop: ['ArrowDown'],
  hardDrop: ['ArrowUp'],
  rotateCCW: ['Comma', 'Numpad1'],
  rotateCW: ['Period', 'Numpad3'],
  rotate180: ['Slash', 'Numpad2'],
  hold: ['ShiftRight', 'Numpad0'],
  retry: [],
  pause: [],
};

function seatInputSettings(seat: 1 | 2): InputSettings {
  const base = loadInputSettings();
  return {
    ...cloneInputSettings(base),
    bindings: cloneBindings(seat === 1 ? SEAT1_BINDINGS : SEAT2_BINDINGS),
  };
}

function cloneBindings(bindings: InputBindings): InputBindings {
  const out = {} as InputBindings;
  for (const action of Object.keys(bindings) as (keyof InputBindings)[]) {
    out[action] = [...bindings[action]];
  }
  return out;
}

const SEAT_STORAGE_KEY = 'tetra:localVersus:seats:v1';

function loadSeatConfig(): { seat1: LocalVersusSeatConfig; seat2: LocalVersusSeatConfig } {
  const fallback = {
    seat1: { device: 'keyboard' as SeatDevice },
    seat2: { device: 'keyboard' as SeatDevice },
  };
  try {
    const raw = localStorage.getItem(SEAT_STORAGE_KEY);
    if (!raw) return autoAssignSeats(fallback);
    const parsed = JSON.parse(raw) as { seat1?: LocalVersusSeatConfig; seat2?: LocalVersusSeatConfig };
    return {
      seat1: parsed.seat1?.device ? { device: parsed.seat1.device } : fallback.seat1,
      seat2: parsed.seat2?.device ? { device: parsed.seat2.device } : fallback.seat2,
    };
  } catch {
    return autoAssignSeats(fallback);
  }
}

function saveSeatConfig(config: { seat1: LocalVersusSeatConfig; seat2: LocalVersusSeatConfig }): void {
  try {
    localStorage.setItem(SEAT_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // best-effort; el stand puede correr en modo privado sin localStorage.
  }
}

// Sin config guardada: si hay ≥2 mandos, cada asiento toma uno; con 1 mando, el
// asiento 2 lo usa y el 1 queda en teclado.
function autoAssignSeats(
  fallback: { seat1: LocalVersusSeatConfig; seat2: LocalVersusSeatConfig },
): { seat1: LocalVersusSeatConfig; seat2: LocalVersusSeatConfig } {
  const pads = connectedPads();
  if (pads.length >= 2) {
    return { seat1: { device: `gamepad:${pads[0].index}` }, seat2: { device: `gamepad:${pads[1].index}` } };
  }
  if (pads.length === 1) {
    return { seat1: { device: 'keyboard' }, seat2: { device: `gamepad:${pads[0].index}` } };
  }
  return fallback;
}

function connectedPads(): Array<{ index: number; id: string }> {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
  const out: Array<{ index: number; id: string }> = [];
  for (const pad of navigator.getGamepads()) {
    if (pad) out.push({ index: pad.index, id: pad.id });
  }
  return out;
}

function toGameInputs(inputs: { frame: number; action: ControlAction }[]): GameInput[] {
  // 'pause' no es una acción de juego; 'retry' reiniciaría un tablero a mitad de
  // duelo. En este modo ambas se ignoran (la salida/pausa la maneja el overlay).
  return inputs
    .filter((input) => input.action !== 'pause' && input.action !== 'retry')
    .map((input) => ({ frame: input.frame, action: input.action as InputAction }));
}

// Un asiento: motor + entrada (teclado y/o un mando filtrado por índice).
class Seat {
  readonly engine: GameEngine;
  readonly input: InputController;
  readonly gamepad: GamepadController;
  state: GameState;

  constructor(seat: 1 | 2, seed: number, device: SeatDevice) {
    this.engine = new GameEngine(seed, BATTLE_RULES);
    this.state = this.engine.getState();
    this.input = new InputController(seatInputSettings(seat));
    const padIndex = device.startsWith('gamepad:') ? Number(device.slice('gamepad:'.length)) : null;
    this.gamepad = new GamepadController(this.input, {
      // Cada asiento escucha SOLO su mando. Con teclado, padIndex === null y el
      // filtro descarta todos los mandos (el asiento juega con sus teclas).
      padFilter: (pad) => padIndex !== null && pad.index === padIndex,
    });
  }

  pollGamepad(): void {
    this.gamepad.poll();
  }

  advance(frame: number): void {
    this.input.advanceFrame(frame);
    const inputs = this.input.collect(frame);
    this.state = this.engine.tick(frame, toGameInputs(inputs));
  }

  destroy(): void {
    this.input.destroy();
    this.gamepad.destroy();
  }
}

export interface LocalVersusSession {
  destroy(): void;
}

export function startLocalVersus(options: LocalVersusOptions): LocalVersusSession {
  const match = new LocalVersusMatch(options);
  return { destroy: () => match.destroy() };
}

class LocalVersusMatch {
  private readonly options: LocalVersusOptions;
  private readonly overlay: HTMLElement;
  private phase: Phase = 'seatSetup';
  private seatConfig = loadSeatConfig();
  private seats: { seat1: Seat; seat2: Seat } | null = null;
  private prevSent = { seat1: 0, seat2: 0 };
  private outcome: Outcome = 'playing';

  private rafId = 0;
  private startTime = 0;
  private frame = 0;
  private countdownStart = 0;
  private lastCountdownNumber = COUNTDOWN_SECONDS + 1;

  // Elementos persistentes del escenario de juego (no se recrean por frame).
  private canvas1: HTMLCanvasElement | null = null;
  private canvas2: HTMLCanvasElement | null = null;
  private hudEl: HTMLElement | null = null;
  private destroyed = false;

  constructor(options: LocalVersusOptions) {
    this.options = options;
    this.overlay = document.createElement('div');
    this.overlay.className = 'lv-overlay';
    ensureStyles();
    document.body.appendChild(this.overlay);
    this.overlay.addEventListener('keydown', this.onKeyDown);
    this.overlay.tabIndex = -1;
    this.renderSeatSetup();
    this.overlay.focus();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
    this.overlay.removeEventListener('keydown', this.onKeyDown);
    this.teardownSeats();
    this.overlay.remove();
  }

  private teardownSeats(): void {
    this.seats?.seat1.destroy();
    this.seats?.seat2.destroy();
    this.seats = null;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Escape') {
      event.preventDefault();
      if (this.phase === 'seatSetup') this.exit();
      else this.backToSeatSetup();
    }
  };

  private exit(): void {
    this.options.onExit();
    this.destroy();
  }

  private backToSeatSetup(): void {
    cancelAnimationFrame(this.rafId);
    this.teardownSeats();
    this.phase = 'seatSetup';
    this.renderSeatSetup();
    this.overlay.focus();
  }

  // ── Fase 1: configuración de asientos ──────────────────────────────────────

  private renderSeatSetup(): void {
    const pads = connectedPads();
    this.overlay.innerHTML = `
      <div class="lv-setup">
        <h1 class="lv-title">Duelo local</h1>
        <p class="lv-sub">1 contra 1 en esta misma computadora. Elegí el control de cada jugador.</p>
        <div class="lv-setup-seats">
          ${this.renderSeatPicker(1, pads)}
          ${this.renderSeatPicker(2, pads)}
        </div>
        <div class="lv-setup-actions">
          <button class="lv-btn lv-btn--ghost" type="button" data-lv="exit">Salir</button>
          <button class="lv-btn lv-btn--primary" type="button" data-lv="start"${this.seatsValid() ? '' : ' disabled'}>Comenzar</button>
        </div>
        <p class="lv-hint">Mandos PlayStation, Xbox, Switch o Steam. Si compartís teclado: J1 = WASD + IJKL · J2 = Flechas + , . /</p>
      </div>
    `;
    this.overlay.querySelectorAll<HTMLElement>('[data-lv]').forEach((el) => {
      el.addEventListener('click', () => this.onSetupClick(el.dataset.lv ?? '', el.dataset.seat, el.dataset.device));
    });
  }

  private renderSeatPicker(seat: 1 | 2, pads: Array<{ index: number; id: string }>): string {
    const current = seat === 1 ? this.seatConfig.seat1.device : this.seatConfig.seat2.device;
    const option = (device: SeatDevice, label: string) => `
      <button class="lv-device ${current === device ? 'is-active' : ''}" type="button"
        data-lv="device" data-seat="${seat}" data-device="${device}">${label}</button>`;
    const padOptions = pads.map((pad) => option(`gamepad:${pad.index}`, `🎮 Mando ${pad.index + 1}`)).join('');
    return `
      <div class="lv-seat-card lv-seat-card--${seat}">
        <span class="lv-seat-label">Jugador ${seat}</span>
        <div class="lv-device-list">
          ${option('keyboard', '⌨️ Teclado')}
          ${padOptions || '<span class="lv-no-pad">Conectá un mando para usarlo</span>'}
        </div>
      </div>
    `;
  }

  private seatsValid(): boolean {
    // Dos asientos no pueden compartir el mismo mando; el teclado sí se comparte
    // (las teclas de cada asiento son disjuntas).
    const d1 = this.seatConfig.seat1.device;
    const d2 = this.seatConfig.seat2.device;
    if (d1.startsWith('gamepad:') && d1 === d2) return false;
    return true;
  }

  private onSetupClick(action: string, seat?: string, device?: string): void {
    if (action === 'exit') return this.exit();
    if (action === 'start') {
      if (this.seatsValid()) this.beginCountdown();
      return;
    }
    if (action === 'device' && seat && device) {
      const cfg = { device: device as SeatDevice };
      if (seat === '1') this.seatConfig.seat1 = cfg;
      else this.seatConfig.seat2 = cfg;
      saveSeatConfig(this.seatConfig);
      this.renderSeatSetup();
    }
  }

  // ── Fase 2-3: cuenta regresiva y partida ───────────────────────────────────

  private beginCountdown(): void {
    // Misma semilla para ambos = mismas piezas = duelo justo.
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.seats = {
      seat1: new Seat(1, seed, this.seatConfig.seat1.device),
      seat2: new Seat(2, seed, this.seatConfig.seat2.device),
    };
    this.prevSent = { seat1: 0, seat2: 0 };
    this.outcome = 'playing';
    this.frame = 0;
    this.phase = 'countdown';
    this.countdownStart = performance.now();
    this.lastCountdownNumber = COUNTDOWN_SECONDS + 1;
    this.renderStage();
    this.loop();
  }

  private loop = (): void => {
    if (this.destroyed) return;
    const now = performance.now();
    if (this.phase === 'countdown') this.updateCountdown(now);
    if (this.phase === 'playing') this.updatePlaying(now);
    this.draw();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private updateCountdown(now: number): void {
    const elapsed = now - this.countdownStart;
    const remaining = COUNTDOWN_SECONDS * 1000 - elapsed;
    const number = Math.ceil(remaining / 1000);
    if (number < this.lastCountdownNumber) {
      this.lastCountdownNumber = number;
      if (number > 0) this.options.audio?.countdownTick?.();
      else this.options.audio?.countdownGo?.();
    }
    if (remaining <= 0) {
      this.phase = 'playing';
      this.startTime = now;
      this.frame = 0;
    }
  }

  private updatePlaying(now: number): void {
    if (!this.seats) return;
    // Los mandos se sondean una vez por rAF (la Gamepad API no emite eventos).
    this.seats.seat1.pollGamepad();
    this.seats.seat2.pollGamepad();

    const target = Math.max(this.frame, Math.floor((now - this.startTime) / FRAME_MS));
    while (this.frame < target && this.outcome === 'playing') {
      this.frame += 1;
      this.advanceOneFrame(this.frame);
    }
  }

  private advanceOneFrame(frame: number): void {
    if (!this.seats) return;
    const { seat1, seat2 } = this.seats;
    seat1.advance(frame);
    seat2.advance(frame);

    // Intercambio de basura: lo que cada uno mandó este frame le cae al rival.
    const attacks = pendingAttacks(this.prevSent, seat1.state.stats.sentGarbage, seat2.state.stats.sentGarbage);
    this.prevSent = attacks.next;
    if (attacks.toSeat2 > 0) {
      seat2.engine.queueGarbage(attacks.toSeat2, randomHoleSeed(), frame);
    }
    if (attacks.toSeat1 > 0) {
      seat1.engine.queueGarbage(attacks.toSeat1, randomHoleSeed(), frame);
    }
    // Refrescamos el estado tras encolar basura para que el HUD de "entrante" no
    // vaya un frame atrasado.
    seat1.state = seat1.engine.getState();
    seat2.state = seat2.engine.getState();

    const outcome = decideOutcome(seat1.state.status, seat2.state.status);
    if (outcome !== 'playing') this.finishMatch(outcome);
  }

  private finishMatch(outcome: Outcome): void {
    this.outcome = outcome;
    this.phase = 'finished';
    if (outcome === 'seat1') { this.options.audio?.gameOver?.(2); this.options.audio?.win?.(1); }
    else if (outcome === 'seat2') { this.options.audio?.gameOver?.(1); this.options.audio?.win?.(2); }
    this.renderFinished();
  }

  // ── Render del escenario (canvases persistentes + HUD reescribible) ─────────

  private renderStage(): void {
    this.overlay.innerHTML = `
      <div class="lv-stage">
        <section class="lv-board lv-board--1">
          <header class="lv-board-name">Jugador 1</header>
          <canvas class="lv-canvas" data-lv-canvas="1"></canvas>
          <div class="lv-pending" data-lv-pending="1"></div>
        </section>
        <div class="lv-center" data-lv-center></div>
        <section class="lv-board lv-board--2">
          <header class="lv-board-name">Jugador 2</header>
          <canvas class="lv-canvas" data-lv-canvas="2"></canvas>
          <div class="lv-pending" data-lv-pending="2"></div>
        </section>
      </div>
    `;
    this.canvas1 = this.overlay.querySelector('[data-lv-canvas="1"]');
    this.canvas2 = this.overlay.querySelector('[data-lv-canvas="2"]');
    this.hudEl = this.overlay.querySelector('[data-lv-center]');
  }

  private draw(): void {
    if (!this.seats || !this.canvas1 || !this.canvas2) return;
    const colorBlind = this.options.colorBlind ?? false;
    this.sizeCanvas(this.canvas1);
    this.sizeCanvas(this.canvas2);
    drawBoardToCanvas(this.canvas1, this.seats.seat1.state, { colorBlind });
    drawBoardToCanvas(this.canvas2, this.seats.seat2.state, { colorBlind });
    this.drawPending(1, this.seats.seat1.state);
    this.drawPending(2, this.seats.seat2.state);
    this.drawCenter();
  }

  private sizeCanvas(canvas: HTMLCanvasElement): void {
    // El tablero es 10×20; mantenemos esa proporción dentro del alto disponible.
    const stageHeight = this.overlay.clientHeight || window.innerHeight;
    const cssHeight = Math.max(240, Math.min(stageHeight * 0.78, 760));
    const cssWidth = cssHeight / 2;
    sizeBoardCanvas(canvas, cssWidth, cssHeight);
  }

  private drawPending(seat: 1 | 2, state: GameState): void {
    const el = this.overlay.querySelector<HTMLElement>(`[data-lv-pending="${seat}"]`);
    if (!el) return;
    const pending = state.stats.pendingGarbage;
    el.textContent = pending > 0 ? `⚠ Basura entrante: ${pending}` : '';
    el.classList.toggle('is-danger', pending >= 4);
  }

  private drawCenter(): void {
    if (!this.hudEl) return;
    if (this.phase === 'countdown') {
      const n = this.lastCountdownNumber;
      this.hudEl.innerHTML = `<div class="lv-count">${n > 0 ? n : '¡YA!'}</div>`;
      return;
    }
    if (this.phase === 'playing' && this.seats) {
      const t = ((this.frame / 60) | 0);
      this.hudEl.innerHTML = `
        <div class="lv-vs">VS</div>
        <div class="lv-clock">${formatClock(t)}</div>
        <div class="lv-lines">
          <span>${this.seats.seat1.state.stats.lines} líneas</span>
          <span>${this.seats.seat2.state.stats.lines} líneas</span>
        </div>`;
      return;
    }
  }

  private renderFinished(): void {
    cancelAnimationFrame(this.rafId);
    const winner = this.outcome === 'seat1' ? 'Jugador 1'
      : this.outcome === 'seat2' ? 'Jugador 2'
      : null;
    const heading = winner ? `🏆 ${winner} gana` : '🤝 Empate';
    this.overlay.innerHTML = `
      <div class="lv-finished">
        <h1 class="lv-win-title">${heading}</h1>
        <div class="lv-win-actions">
          <button class="lv-btn lv-btn--primary" type="button" data-lv="rematch">Revancha</button>
          <button class="lv-btn lv-btn--ghost" type="button" data-lv="setup">Cambiar controles</button>
          <button class="lv-btn lv-btn--ghost" type="button" data-lv="exit">Salir</button>
        </div>
      </div>
    `;
    this.overlay.querySelectorAll<HTMLElement>('[data-lv]').forEach((el) => {
      el.addEventListener('click', () => {
        const action = el.dataset.lv;
        if (action === 'exit') this.exit();
        else if (action === 'setup') this.backToSeatSetup();
        else if (action === 'rematch') { this.teardownSeats(); this.beginCountdown(); }
      });
    });
    this.overlay.focus();
  }
}

function randomHoleSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// CSS inyectado una sola vez. Se mantiene acotado al prefijo `lv-` para no chocar
// con styles.css, y así el modo queda autocontenido en este módulo.
let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .lv-overlay { position: fixed; inset: 0; z-index: 60; background: radial-gradient(circle at 50% 0%, #0b1220, #04060a 70%); color: #f7f7f2; display: flex; align-items: center; justify-content: center; font-family: inherit; outline: none; }
    .lv-setup, .lv-finished { text-align: center; max-width: 880px; padding: 32px; }
    .lv-title { font-size: clamp(28px, 5vw, 52px); margin: 0 0 8px; letter-spacing: 1px; }
    .lv-sub { opacity: .8; margin: 0 0 28px; }
    .lv-setup-seats { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .lv-seat-card { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.1); border-radius: 14px; padding: 20px; }
    .lv-seat-card--1 { border-top: 3px solid #00f5ff; }
    .lv-seat-card--2 { border-top: 3px solid #ff5d8f; }
    .lv-seat-label { display: block; font-weight: 700; margin-bottom: 14px; font-size: 18px; }
    .lv-device-list { display: flex; flex-direction: column; gap: 8px; }
    .lv-device { padding: 10px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,.16); background: transparent; color: inherit; cursor: pointer; font-size: 15px; transition: all .12s; }
    .lv-device:hover { border-color: rgba(255,255,255,.4); }
    .lv-device.is-active { background: #00f5ff; color: #04060a; border-color: #00f5ff; font-weight: 700; }
    .lv-seat-card--2 .lv-device.is-active { background: #ff5d8f; border-color: #ff5d8f; }
    .lv-no-pad { font-size: 13px; opacity: .55; }
    .lv-setup-actions, .lv-win-actions { display: flex; gap: 12px; justify-content: center; margin-top: 28px; flex-wrap: wrap; }
    .lv-btn { padding: 12px 26px; border-radius: 10px; border: 1px solid rgba(255,255,255,.2); background: transparent; color: inherit; cursor: pointer; font-size: 16px; font-weight: 600; }
    .lv-btn--primary { background: #00f5ff; color: #04060a; border-color: #00f5ff; }
    .lv-btn--primary:disabled { opacity: .4; cursor: not-allowed; }
    .lv-btn--ghost:hover { border-color: rgba(255,255,255,.5); }
    .lv-hint { margin-top: 22px; font-size: 13px; opacity: .6; }
    .lv-stage { display: flex; align-items: center; justify-content: center; gap: clamp(16px, 4vw, 64px); width: 100%; height: 100%; padding: 24px; box-sizing: border-box; }
    .lv-board { display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .lv-board-name { font-weight: 700; font-size: clamp(16px, 2vw, 22px); letter-spacing: .5px; }
    .lv-board--1 .lv-board-name { color: #00f5ff; }
    .lv-board--2 .lv-board-name { color: #ff5d8f; }
    .lv-canvas { display: block; image-rendering: auto; }
    .lv-pending { min-height: 22px; font-weight: 700; font-size: 14px; color: #ffb627; }
    .lv-pending.is-danger { color: #ff4d4d; animation: lv-pulse .5s infinite alternate; }
    @keyframes lv-pulse { to { opacity: .45; } }
    .lv-center { display: flex; flex-direction: column; align-items: center; gap: 14px; min-width: 120px; }
    .lv-vs { font-size: clamp(28px, 4vw, 44px); font-weight: 800; opacity: .9; }
    .lv-clock { font-variant-numeric: tabular-nums; font-size: 22px; opacity: .85; }
    .lv-lines { display: flex; flex-direction: column; gap: 4px; font-size: 13px; opacity: .7; text-align: center; }
    .lv-count { font-size: clamp(64px, 14vw, 160px); font-weight: 900; line-height: 1; text-shadow: 0 0 40px rgba(0,245,255,.6); }
    .lv-win-title { font-size: clamp(32px, 6vw, 64px); margin: 0; }
  `;
  document.head.appendChild(style);
}
