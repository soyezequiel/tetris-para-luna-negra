import type { SoundCue, SoundEngine } from './SoundEngine';
import type { AttackSize, JuiceAudio } from './JuiceAudio';
import type { GameEvent, GameState, InputAction, LineClearEvent } from '../game/types';
import { soundCueForRunProgress } from '../app/runEffects';

/**
 * BoardAudio — manejador de sonido SOLO-audio para un tablero, derivado del estado
 * y los eventos reales del motor. Reúne las dos capas que el modo de un jugador usa
 * por separado:
 *
 *   - SoundEngine: cues de input (move/rotate/softDrop/hardDrop/hold) y de progreso
 *     (lock / lineClear / tSpin), exactamente las mismas que dispara el solo
 *     (playImmediateInputSounds + soundCueForRunProgress).
 *   - JuiceAudio: la capa "rica" (tetris/combo/B2B/perfect/ataque/garbage) y el
 *     latido de peligro por altura de pila, sin la parte VISUAL de JuiceConductor.
 *
 * Pensado para escenarios con varios tableros a la vez (p. ej. el duelo local 1v1),
 * donde cada tablero necesita su propio paneo y su propio latido. Por eso recibe un
 * `pan` fijo y una instancia de JuiceAudio propia (el latido es un único loop por
 * instancia; compartirla entre tableros lo pisaría).
 */

const ATTACK_BY_LINES = (lines: number): AttackSize => (lines >= 4 ? 'L' : lines >= 2 ? 'M' : 'S');
// Mismo umbral de peligro que JuiceConductor (dangerStart por defecto).
const DANGER_START = 0.6;

export class BoardAudio {
  private lastLines = 0;
  private lastPieces = 0;
  private lastCombo = 0;
  private lastStatus: GameState['status'] = 'ready';
  private lastActive: { type: string; x: number } | null = null;
  private alive = true;

  constructor(
    private readonly sound: SoundEngine,
    private readonly juice: JuiceAudio,
    private readonly pan: number,
  ) {}

  /** Sincroniza los baselines con un tablero recién creado SIN disparar sonidos
   * (igual que JuiceConductor.prime: evita un lock/clear/KO falso por el salto). */
  reset(state: GameState): void {
    this.lastLines = state.stats.lines;
    this.lastPieces = state.stats.pieces;
    this.lastCombo = Math.max(0, state.stats.combo);
    this.lastStatus = state.status;
    this.lastActive = activeOf(state);
    this.alive = state.status !== 'gameover' && state.status !== 'finished';
    this.juice.setDanger(0, false, this.pan);
  }

  /** Una vez por frame de motor: cues de input + progreso, capa rica de eventos,
   * peligro por altura y transiciones KO/Win. */
  frame(state: GameState, events: readonly GameEvent[], inputs: readonly InputAction[], live: boolean): void {
    this.playInputCues(state, inputs);

    // Cue de colocación/limpieza: misma fuente que el solo (lock / lineClear / tSpin).
    const cue: SoundCue | null = soundCueForRunProgress(state, events, this.lastLines, this.lastPieces);
    if (cue) this.sound.play(cue, this.pan);

    // Capa rica (tetris/combo/B2B/perfect/ataque + garbage), espejo del audio de
    // JuiceConductor.handleEvents pero sin la parte visual.
    for (const event of events) {
      if (event.type === 'lineClear') this.onLineClear(event);
      else if (event.type === 'incomingGarbage') this.juice.garbageTelegraph(Math.min(1, event.lines / 6), this.pan);
      else if (event.type === 'appliedGarbage') this.juice.garbageRise(this.pan);
    }

    this.lastLines = state.stats.lines;
    this.lastPieces = state.stats.pieces;
    this.lastActive = activeOf(state);

    this.updateDanger(state, live);

    if (state.status !== this.lastStatus) {
      if (state.status === 'gameover') {
        this.alive = false;
        this.juice.ko(this.pan);
        this.juice.enterSpectator();
      } else if (state.status === 'finished') {
        this.juice.win(this.pan);
      }
      this.lastStatus = state.status;
    }
  }

  private playInputCues(state: GameState, inputs: readonly InputAction[]): void {
    for (const action of inputs) {
      if (action === 'rotateCW' || action === 'rotateCCW' || action === 'rotate180') this.sound.play('rotate', this.pan);
      else if (action === 'softDrop') this.sound.play('softDrop', this.pan);
      else if (action === 'hardDrop') this.sound.play('hardDrop', this.pan);
      else if (action === 'hold') this.sound.play('hold', this.pan);
    }
    // 'move' solo si una pieza efectivamente se desplazó horizontal este frame (igual
    // que playAcceptedMoveSound: evita el "tic" repetido al chocar contra la pared).
    const requestedMove = inputs.some((a) => a === 'moveLeft' || a === 'moveRight');
    const now = activeOf(state);
    if (requestedMove && now && this.lastActive && now.type === this.lastActive.type && now.x !== this.lastActive.x) {
      this.sound.play('move', this.pan);
    }
  }

  private onLineClear(e: LineClearEvent): void {
    const n = e.cleared;
    if (n <= 0) {
      if (this.lastCombo >= 2) this.juice.comboBreak(this.pan);
      this.lastCombo = 0;
      return;
    }
    if (n >= 4) {
      this.juice.tetris(this.pan);
      if (e.b2b > 1) this.juice.b2b(this.pan);
    } else {
      this.juice.clear(n, this.pan);
    }
    if (e.spin !== 'none') this.juice.b2b(this.pan);
    if (e.perfectClear) this.juice.perfectClear(this.pan);
    if (e.combo >= 1) this.juice.combo(e.combo, this.pan);
    this.lastCombo = e.combo;
    if (e.outgoingLines > 0) this.juice.attackLaunch(ATTACK_BY_LINES(e.outgoingLines), this.pan);
  }

  private updateDanger(state: GameState, live: boolean): void {
    if (!live || !this.alive || state.status !== 'playing') {
      this.juice.setDanger(0, false, this.pan);
      return;
    }
    const ratio = stackHeightRatio(state);
    let level = ratio > DANGER_START ? Math.min(1, (ratio - DANGER_START) / (1 - DANGER_START - 0.08)) : 0;
    const rows = rowsUntilTopOut(state);
    level = Math.max(level, Math.max(0, Math.min(1, (5 - rows) / 5)));
    if (state.stats.aboveFieldFrames > 0) level = 1;
    const critical = state.stats.aboveFieldFrames > 0 || rows <= 3;
    this.juice.setDanger(level, critical, this.pan);
  }
}

function activeOf(state: GameState): { type: string; x: number } | null {
  return state.active ? { type: state.active.type as string, x: state.active.x } : null;
}

// Réplica acotada de los helpers privados de JuiceConductor (no exportados). Se
// duplican aquí para no acoplar este módulo de audio al renderer visual.
function rowsUntilTopOut(state: GameState): number {
  const board = state.board;
  const total = board.length;
  let topRow = total;
  for (let y = 0; y < total; y += 1) {
    if (board[y].some((c) => c !== null)) { topRow = y; break; }
  }
  if (topRow >= total) return total;
  const spawnRow = Math.max(0, state.stats.hiddenRows - 2);
  return topRow - spawnRow;
}

function stackHeightRatio(state: GameState): number {
  const board = state.board;
  const total = board.length;
  const hidden = state.stats.hiddenRows;
  const visible = state.stats.visibleRows;
  let topRow = total;
  for (let y = 0; y < total; y += 1) {
    if (board[y].some((c) => c !== null)) { topRow = y; break; }
  }
  if (topRow >= total) return 0;
  const filledFromTop = total - topRow;
  const visibleFilled = Math.max(0, filledFromTop - hidden);
  return Math.min(1, visibleFilled / visible);
}
