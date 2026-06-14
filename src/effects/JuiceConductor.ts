import type { GameEvent, GameState, LineClearEvent } from '../game/types';
import { JuiceFX, JUICE_PALETTE as P } from '../renderer/JuiceFX';
import { JuiceAudio, type AttackSize } from '../audio/JuiceAudio';

/**
 * JuiceConductor — traduce el estado y los eventos del motor real a llamadas de
 * JuiceFX (visual) + JuiceAudio (sonido). Es el ÚNICO punto que main.ts toca:
 *
 *   const juice = new JuiceConductor(renderer.getJuice(), juiceAudio);
 *   ...
 *   juice.handleEvents(state, events);  // dentro de advanceGameToFrame, tras drainEvents
 *   juice.frame(state);                 // una vez por frame, junto a renderer.render(state)
 *
 * El motor NO emite eventos de hard drop / lock (son inputs), así que esos dos se
 * disparan con onHardDrop()/onLock() desde el mismo sitio donde main.ts ya suena
 * sound.play('hardDrop' | 'lock'). Igual los KO/Win salen de transiciones de status.
 *
 * Ataque: este renderer dibuja solo el tablero local, no los tableros rivales. Por
 * eso, por defecto, un ataque saliente se siente como un fogonazo + retroceso en el
 * borde del tablero local. Si tienes coordenadas de pantalla del rival, pásalas a
 * onAttackToward(point, size) para lanzar el proyectil real hacia él.
 */

const ATTACK_BY_LINES = (lines: number): AttackSize => (lines >= 4 ? 'L' : lines >= 2 ? 'M' : 'S');

export interface JuiceConductorOptions {
  /** Umbral de altura (0..1) a partir del cual empieza el peligro. Default 0.6. */
  dangerStart?: number;
}

export class JuiceConductor {
  private readonly fx: JuiceFX;
  private readonly audio: JuiceAudio;
  private readonly dangerStart: number;

  private lastCombo = 0;
  private lastStatus: GameState['status'] = 'ready';
  private alive = true;
  // 'auto': el ataque saliente se siente como retroceso en tu propio borde.
  // 'external': main.ts conoce el tablero rival y dispara el proyectil con
  // onAttackToward(); aquí se omite el retroceso automático para no duplicarlo.
  private attackRouting: 'auto' | 'external' = 'auto';

  constructor(fx: JuiceFX, audio: JuiceAudio, options: JuiceConductorOptions = {}) {
    this.fx = fx;
    this.audio = audio;
    this.dangerStart = options.dangerStart ?? 0.6;
  }

  /** 'external' cuando main.ts enruta el proyectil al rival (online); 'auto' en solo. */
  setAttackRouting(mode: 'auto' | 'external'): void {
    this.attackRouting = mode;
  }

  /** Eventos drenados del motor en un tick (line clears, garbage entrante/aplicada). */
  handleEvents(state: GameState, events: readonly GameEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'lineClear':
          this.onLineClear(state, event);
          break;
        case 'incomingGarbage':
          this.onIncomingGarbage(event.lines);
          break;
        case 'appliedGarbage':
          this.onAppliedGarbage(event.lines);
          break;
      }
    }
  }

  /** Una vez por frame: peligro por altura de pila + transiciones de status. */
  frame(state: GameState): void {
    // peligro
    if (this.alive && state.status === 'playing') {
      const ratio = stackHeightRatio(state);
      let level = ratio > this.dangerStart ? Math.min(1, (ratio - this.dangerStart) / (1 - this.dangerStart - 0.08)) : 0;
      // Pila por encima del área visible (dentro del buffer, estilo tetr.io): no
      // hay muerte por tiempo, así que en vez de un countdown subimos el peligro
      // visual al máximo mientras estás topeado. La rampa usa los primeros frames
      // arriba para que el aviso crezca rápido pero no salte de golpe.
      const above = state.stats.aboveFieldFrames;
      if (above > 0) {
        const progress = Math.min(1, above / 30);
        level = Math.max(level, 0.6 + 0.4 * progress);
      }
      this.fx.setTopOutCountdown(null);
      this.fx.setDanger(level);
      this.audio.setDanger(level);
      this.fx.setPendingGarbage(state.stats.pendingGarbage);
    } else {
      this.fx.setDanger(0);
      this.audio.setDanger(0);
      this.fx.setPendingGarbage(0);
      this.fx.setTopOutCountdown(null);
    }

    // transiciones de status
    if (state.status !== this.lastStatus) {
      if (state.status === 'gameover') this.onTopOut(state);
      else if (state.status === 'finished') this.onWin();
      else if (state.status === 'playing' && (this.lastStatus === 'ready' || this.lastStatus === 'gameover' || this.lastStatus === 'finished')) {
        this.onNewRun();
      }
      this.lastStatus = state.status;
    }
  }

  // ---------- line clears ----------
  private onLineClear(state: GameState, e: LineClearEvent): void {
    const n = e.cleared;
    if (n <= 0) {
      // pieza colocada sin limpiar: rompe combo si lo había
      if (this.lastCombo >= 2) {
        const c = this.boardCenterRow();
        this.fx.spawnBurst(c.x, c.y, 14, P.ghost, { spd: 120, life: 0.5, grav: 200, size: 2.4 });
        this.audio.comboBreak();
      }
      this.lastCombo = 0;
      return;
    }

    const tiers: Record<number, { shake: number; parts: number; col: number }> = {
      1: { shake: 5, parts: 16, col: P.cyan },
      2: { shake: 9, parts: 26, col: P.cyan },
      3: { shake: 15, parts: 46, col: P.gold },
      4: { shake: 32, parts: 120, col: P.cyan },
    };
    const tier = tiers[Math.min(4, n)];
    const r = this.boardCenterRow();

    this.fx.addShake(tier.shake);
    this.fx.boardGlow(tier.col, n / 4);

    // Flash acotado a las filas borradas: convierte índices de tablero completo a
    // filas visibles y destella solo esas bandas (no todo el tablero).
    if (e.clearedRows && e.clearedRows.length > 0) {
      const hidden = state.stats.hiddenRows;
      const visibleRows = e.clearedRows
        .map((row) => row - hidden)
        .filter((row) => row >= 0 && row < this.fx.rows);
      if (visibleRows.length > 0) this.fx.flashRows(visibleRows);
    }

    // partículas en cada fila limpiada (las n inferiores, espacio visible)
    const bottom = this.fx.rows;
    for (let row = bottom - n; row < bottom; row += 1) {
      const pt = this.fx.cellPoint((this.fx.columns - 1) / 2, row);
      this.fx.spawnLine(pt.x, pt.y, this.fx.columns * this.fx.cell, Math.ceil(tier.parts / n), tier.col);
    }

    if (n >= 4) {
      this.audio.tetris();
      this.fx.flashBoard(P.cyan);
      this.fx.spawnRing(r.x, r.y, P.cyan, 260);
      this.fx.spawnRing(r.x, r.y, P.cyanSoft, 200);
      this.fx.spawnBurst(r.x, r.y + this.fx.cell * 4, 60, P.cyan, { spd: 360, life: 0.9, up: 120, size: 3.6 });
      const b2bActive = e.b2b > 1;
      this.fx.showPopup('TETRIS', { color: P.cyan, sub: b2bActive ? 'BACK-TO-BACK' : '', big: true });
      if (b2bActive) this.audio.b2b();
    } else if (n === 3) {
      this.audio.clear(3);
      this.fx.flashBoard(P.gold);
      this.fx.spawnBurst(r.x, r.y + this.fx.cell * 4, 24, P.gold, { spd: 240, life: 0.7 });
      this.fx.showPopup('TRIPLE', { color: P.gold });
    } else {
      this.audio.clear(n);
      if (n === 2) this.fx.showPopup('DOUBLE', { color: P.cyanSoft });
    }

    // spin (T-spin u otros): subraya con popup + sonido brillante
    if (e.spin !== 'none') {
      this.audio.b2b();
      this.fx.showPopup(e.spin === 'mini' ? 'T-SPIN MINI' : 'T-SPIN', { color: P.purple, sub: n > 0 ? `${n} LINE${n > 1 ? 'S' : ''}` : '' });
    }

    // perfect clear: capa extra de celebración
    if (e.perfectClear) {
      this.audio.perfectClear();
      this.fx.flashBoard(P.green, 0.7);
      this.fx.spawnRing(r.x, r.y, P.green, 300);
      this.fx.showPopup('PERFECT', { color: P.green, sub: 'ALL CLEAR', big: true });
      this.fx.addShake(14);
    }

    // combo
    this.onCombo(e.combo);

    // ataque saliente (lo que TÚ sientes al mandar líneas). En modo 'external'
    // lo dispara main.ts con onAttackToward() hacia el tablero rival.
    if (e.outgoingLines > 0 && this.attackRouting === 'auto') this.onAttackOutgoing(e.outgoingLines);
  }

  private onCombo(combo: number): void {
    // combo del motor: 0 en la primera limpieza, sube con limpiezas consecutivas
    if (combo >= 1) {
      this.audio.combo(combo);
      if (combo >= 3) this.fx.addShake(2 + Math.min(1, (combo - 2) / 8) * 4);
      const col = combo >= 9 ? P.cyan : combo >= 5 ? P.gold : P.pink;
      this.fx.showPopup(`${combo}× COMBO`, { color: col });
    }
    this.lastCombo = combo;
  }

  // ---------- ataque ----------
  /** Retroceso/fogonazo en tu propio borde. Público para usarlo como fallback
   * cuando main.ts no tiene coordenadas del rival (ver onAttackToward). */
  onAttackOutgoing(lines: number): void {
    const size = ATTACK_BY_LINES(lines);
    this.audio.attackLaunch(size);
    this.fx.addShake({ S: 6, M: 11, L: 18 }[size] * 0.25);
    const from = this.fx.rightEdgePoint();
    const col = { S: P.cyan, M: P.pink, L: P.purple }[size];
    this.fx.spawnBurst(from.x, from.y, 10, col, { spd: 160, life: 0.4 });
  }

  /** Llamar si tienes coordenadas de pantalla del tablero rival objetivo. */
  onAttackToward(point: { x: number; y: number }, lines: number): void {
    const size = ATTACK_BY_LINES(lines);
    const col = { S: P.cyan, M: P.pink, L: P.purple }[size];
    const r = { S: 7, M: 11, L: 17 }[size];
    const from = this.fx.rightEdgePoint();
    this.audio.attackLaunch(size);
    this.fx.spawnProjectile(from, point, { r, col }, () => {
      this.audio.attackHit(size);
      this.fx.spawnBurst(point.x, point.y, { S: 20, M: 38, L: 70 }[size], col, { spd: 220, life: 0.7 });
    });
  }

  // ---------- garbage entrante ----------
  private onIncomingGarbage(lines: number): void {
    this.audio.garbageTelegraph(Math.min(1, lines / 6));
  }
  private onAppliedGarbage(lines: number): void {
    this.fx.flashBoard(0xff7a3a, 0.6);
    this.fx.addShake(lines * 1.6);
    this.audio.garbageRise();
  }

  // ---------- hooks de input (disparar desde main.ts) ----------
  /** Junto a sound.play('hardDrop'). Destello en el marco (no en todo el tablero,
   * que resultaba molesto) + ráfaga de impacto en el piso + shake corto. */
  onHardDrop(): void {
    const r = this.boardCenterRow();
    this.fx.boardGlow(P.cyanSoft, 0.55);
    this.fx.addShake(6);
    this.fx.spawnBurst(r.x, this.boardBottom(), 16, P.cyanSoft, { spd: 200, life: 0.4, up: -40, grav: 200 });
  }
  /** Estela vertical de neón del hard drop. cols = columnas ocupadas; top/bottom =
   * filas VISIBLES de inicio (donde estaba la pieza) y aterrizaje. */
  onHardDropTrail(cols: number[], top: number, bottom: number): void {
    this.fx.spawnDropTrail(cols, top, bottom, P.cyan);
  }
  /** Junto a sound.play('lock'). Ilumina el marco (sin flash de tablero, que
   * saturaba la pantalla en cada pieza) + micro-shake. */
  onLock(): void {
    this.fx.boardGlow(0xdfe7ee, 0.35);
    this.fx.addShake(2.2);
  }

  /** La pieza chocó contra la pared izq (-1) o der (1): el tablero rebota hacia
   * ese lado, como el impacto de tetr.io. Lo dispara main.ts por flanco (un bump
   * por contacto, no continuo mientras se mantiene la tecla contra la pared). */
  onWallHit(dir: -1 | 1): void {
    this.fx.addBump(dir, 260);
  }

  // ---------- KO / Win / reset ----------
  private onTopOut(_state: GameState): void {
    this.alive = false;
    this.audio.ko();
    this.fx.setDanger(0);
    this.fx.addShake(30);
    // Destello cálido + marco dorado encendido: el momento de derrota se celebra
    // en oro, no en rojo de error (estilo "GAME!" del final de ronda).
    this.fx.flashBoard(P.warn, 0.75, 0.7);
    this.fx.boardGlow(P.gold, 1);
    const r = this.boardCenterRow();
    // Confeti central + anillos de onda expansiva.
    this.fx.spawnBurst(r.x, r.y, 90, P.gold, { spd: 320, life: 1.2, size: 3.4, up: 40 });
    this.fx.spawnRing(r.x, r.y, P.gold, 300);
    this.fx.spawnRing(r.x, r.y, P.warn, 230);
    // Chorros de fuego en las 4 esquinas del tablero (escalonados ~0.7s).
    this.fireCornerFountains();
    // Cartel dorado "GAME!" a alpha pleno, con golpe de entrada y hold largo.
    this.fx.showPopup('GAME!', { color: P.gold, big: true, hold: 2.0, fullAlpha: true });
    this.audio.enterSpectator();
  }

  /** Fuentes de chispas cálidas saliendo de las 4 esquinas del tablero, en
   * pulsos escalonados, como los flares del final de ronda del video. */
  private fireCornerFountains(): void {
    const cols = this.fx.columns;
    const rows = this.fx.rows;
    const corners = [
      this.fx.cellPoint(-0.5, rows - 0.5), // inferior izquierda
      this.fx.cellPoint(cols - 0.5, rows - 0.5), // inferior derecha
      this.fx.cellPoint(-0.5, -0.5), // superior izquierda
      this.fx.cellPoint(cols - 0.5, -0.5), // superior derecha
    ];
    const warm = [P.gold, P.warn, P.red, 0xffe08a];
    const pulses = 6;
    for (let i = 0; i < pulses; i += 1) {
      window.setTimeout(() => {
        for (const c of corners) {
          const col = warm[(Math.random() * warm.length) | 0];
          this.fx.spawnBurst(c.x, c.y, 14, col, {
            spd: 200,
            life: 0.9,
            up: 240,
            grav: 420,
            size: 3,
            shape: 'spark',
          });
        }
      }, i * 110);
    }
  }

  private onWin(): void {
    this.audio.win();
    const r = this.boardCenterRow();
    this.fx.flashBoard(P.green, 0.7);
    this.fx.boardGlow(P.green, 1);
    this.fx.addShake(10);
    this.fx.spawnRing(r.x, r.y, P.green, 300);
    this.fx.spawnRing(r.x, r.y, P.gold, 240);
    this.fx.spawnBurst(r.x, this.boardTop(), 90, P.gold, { spd: 280, life: 1.4, up: -60, grav: 260, size: 3.4 });
    this.fx.showPopup('CLEAR', { color: P.green, sub: 'YOU WIN', big: true });
  }

  private onNewRun(): void {
    this.alive = true;
    this.lastCombo = 0;
    this.audio.resetMix();
    this.fx.reset();
    this.fx.flashBoard(P.white, 0.4);
  }

  // ---------- geometría derivada de JuiceFX ----------
  private boardCenterRow(): { x: number; y: number } {
    return this.fx.cellPoint((this.fx.columns - 1) / 2, (this.fx.rows - 1) / 2);
  }
  private boardBottom(): number {
    return this.fx.cellPoint(0, this.fx.rows - 0.5).y;
  }
  private boardTop(): number {
    return this.fx.cellPoint(0, -0.5).y;
  }
}

/** Altura de la pila (0..1): de la primera fila ocupada al fondo, sobre filas visibles. */
function stackHeightRatio(state: GameState): number {
  const board = state.board;
  const total = board.length;
  const hidden = state.stats.hiddenRows;
  const visible = state.stats.visibleRows;
  let topRow = total;
  for (let y = 0; y < total; y += 1) {
    if (board[y].some((c) => c !== null)) {
      topRow = y;
      break;
    }
  }
  if (topRow >= total) return 0;
  const filledFromTop = total - topRow; // filas (incl. ocultas) con contenido por debajo
  const visibleFilled = Math.max(0, filledFromTop - hidden);
  return Math.min(1, visibleFilled / visible);
}
