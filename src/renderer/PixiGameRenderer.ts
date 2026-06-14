import { Application } from '@pixi/app';
import { Container } from '@pixi/display';
import { Graphics } from '@pixi/graphics';
import { Text, TextStyle } from '@pixi/text';
import { JuiceFX, type BoardGeometry } from './JuiceFX';
import { BackgroundFX } from './BackgroundFX';
import { cellsFor, PIECE_COLORS, PIECE_COLORS_COLORBLIND } from '../game/pieces';
import { DEFAULT_RULES } from '../game/rules';
import { displayedElapsedFrames } from '../game/timing';
import type { GameState, PieceType } from '../game/types';

const GRID_LINE = 0x2f3338;
const GHOST_FILL = 0x07090b;
const GHOST_LINE = 0x525a60;
const GHOST_INSET_LINE = 0x262c31;
// Animación de derrota (top out) estilo tetr.io: la pila se vuelve gris y colapsa
// fila por fila de arriba hacia abajo mientras cae y se desvanece.
const DEATH_TOTAL_FRAMES = 104;
const DEATH_BLOCK = 0x5b626b;
const DEATH_BLOCK_LIGHT = 0x868d96;
const DEATH_BLOCK_DARK = 0x2c3036;

// Paleta del rediseño "Modo Relax": tarjetas redondeadas oscuras, acento turquesa
// y tipografía clara/gris. Sustituye a los paneles angulares de borde blanco.
const CARD_FILL = 0x0c121c;       // relleno translúcido de las tarjetas
const CARD_BORDER = 0x9fb2c6;     // borde fino (se dibuja con alpha bajo)
const CARD_ACCENT = 0x35d6c6;     // turquesa de los puntitos y la barra de progreso
const CARD_LABEL = 0x8c98a6;      // etiquetas en gris (HOLD, NEXT, LINES…)
const CARD_VALUE = 0xf2f5f8;      // valores principales en blanco hueso
const CARD_TRACK = 0x1b2533;      // fondo de la barra de progreso
const BOARD_FRAME = 0xaebccb;     // marco fino del tablero
const FONT_UI = 'Exo 2, Arial, Helvetica, sans-serif';

type BlockPalette = {
  outerLine: number;
  bevelLight: number;
  bevelDark: number;
  innerFill: number;
  innerLine: number;
  innerGlow: number;
  innerShadow: number;
};

const blockPaletteCache = new Map<number, BlockPalette>();

export class PixiGameRenderer {
  private readonly app: Application;
  private readonly stage = new Container();
  private readonly bg = new Graphics();
  private readonly boardLayer = new Graphics();
  private readonly sideLayer = new Graphics();
  private readonly pieceLayer = new Graphics();
  private readonly effectLayer = new Graphics();
  private readonly juiceLayer = new Container();
  private readonly juice = new JuiceFX(this.juiceLayer);
  private readonly backgroundFX: BackgroundFX;
  private readonly labelLayer = new Container();
  private readonly hudText: Text;
  private readonly holdLabel: Text;
  private readonly nextLabel: Text;
  // Tarjeta de estadísticas (estilo "Modo Relax"): cada dato es su propio Text
  // porque Pixi no mezcla tamaños/colores dentro de un mismo bloque.
  private readonly linesLabel: Text;
  private readonly linesValue: Text;
  private readonly pcsLabel: Text;
  private readonly pcsValue: Text;
  private readonly pcsSub: Text;
  private readonly timeLabel: Text;
  private readonly timeValue: Text;
  private readonly timeSub: Text;
  private readonly bannerText: Text; // CLEAR / TOP OUT centrado sobre el tablero
  // Geometría de las tarjetas izquierda (HOLD + stats), recalculada en layout().
  private statsY = 0;
  private statsH = 0;
  private holdH = 0;
  // PIECES/TIME en dos columnas si la tarjeta es ancha; si no, apiladas.
  private statsTwoCol = true;
  private width = 1;
  private height = 1;
  private cell = 24;
  private boardX = 0;
  private boardY = 0;
  private boardColumns = DEFAULT_RULES.boardWidth;
  private visibleRows = DEFAULT_RULES.visibleRows;
  private hiddenRows = DEFAULT_RULES.hiddenRows;
  // Geometría de los paneles laterales (HOLD/NEXT), en celdas. Se recalcula en layout()
  // para que el tablero + ambos paneles entren siempre dentro del viewport.
  private sideUnits = 5.2;
  private gapUnits = 0.7;
  private sideW = 0;
  private holdX = 0;
  private nextX = 0;
  private lastLines = 0;
  private shakeFrames = 0;
  // Animación de derrota: -1 = inactiva; si no, frames transcurridos desde el top out.
  // La dispara main.ts al morir (playDeathAnimation), tanto en online como en solo.
  private deathFrame = -1;
  // Modo daltónico: cambia a la paleta Okabe–Ito, con tonos distinguibles entre
  // sí en los tipos de daltonismo más comunes. Lo sincroniza main.ts.
  private colorBlind = false;

  constructor(root: HTMLElement) {
    this.app = new Application({
      resizeTo: window,
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(devicePixelRatio, 2),
      autoDensity: true,
      powerPreference: 'high-performance',
    });
    root.appendChild(this.app.view as HTMLCanvasElement);
    const view = this.app.view as HTMLCanvasElement;
    view.style.position = 'relative';
    view.style.zIndex = '1';
    this.backgroundFX = new BackgroundFX(root);
    this.hudText = new Text('', new TextStyle({
      fill: 0xf7f7f2,
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: 18,
      fontWeight: '700',
      letterSpacing: 1,
      dropShadow: true,
      dropShadowAlpha: 0.4,
      dropShadowDistance: 2,
    }));
    // El bloque de texto antiguo (PIECES/LINES/TIME en una columna) se reemplaza
    // por la tarjeta de stats; se conserva el objeto pero oculto.
    this.hudText.visible = false;

    const cardLabelStyle = new TextStyle({
      fill: CARD_LABEL,
      fontFamily: FONT_UI,
      fontSize: 13,
      fontWeight: '700',
      letterSpacing: 2,
    });
    this.holdLabel = new Text('HOLD', cardLabelStyle.clone());
    this.nextLabel = new Text('NEXT', cardLabelStyle.clone());
    this.linesLabel = new Text('LINES', cardLabelStyle.clone());
    this.pcsLabel = new Text('PIECES', cardLabelStyle.clone());
    this.timeLabel = new Text('TIME', cardLabelStyle.clone());

    this.linesValue = new Text('0', new TextStyle({
      fill: CARD_VALUE, fontFamily: FONT_UI, fontSize: 30, fontWeight: '800', letterSpacing: 1,
    }));
    const valueStyle = new TextStyle({
      fill: CARD_VALUE, fontFamily: FONT_UI, fontSize: 22, fontWeight: '800',
    });
    this.pcsValue = new Text('0', valueStyle.clone());
    this.timeValue = new Text('0:00', valueStyle.clone());
    const subStyle = new TextStyle({
      fill: CARD_LABEL, fontFamily: FONT_UI, fontSize: 11, fontWeight: '700', letterSpacing: 1,
    });
    this.pcsSub = new Text('0.00 PPS', subStyle.clone());
    this.pcsSub.style.fill = CARD_ACCENT;
    this.timeSub = new Text('.000', subStyle.clone());

    this.bannerText = new Text('', new TextStyle({
      fill: CARD_VALUE, fontFamily: FONT_UI, fontSize: 22, fontWeight: '900', letterSpacing: 2,
      align: 'center', dropShadow: true, dropShadowAlpha: 0.6, dropShadowDistance: 2,
    }));
    this.bannerText.anchor.set(0.5, 0.5);

    this.labelLayer.addChild(
      this.holdLabel, this.nextLabel,
      this.linesLabel, this.linesValue,
      this.pcsLabel, this.pcsValue, this.pcsSub,
      this.timeLabel, this.timeValue, this.timeSub,
      this.bannerText,
    );
    this.stage.addChild(this.bg, this.sideLayer, this.boardLayer, this.pieceLayer, this.effectLayer, this.juiceLayer, this.labelLayer, this.hudText);
    this.app.stage.addChild(this.stage);
    window.addEventListener('resize', () => this.layout());
    this.layout();
  }

  destroy(): void {
    this.backgroundFX.destroy();
    this.app.destroy(true, true);
  }

  // Dispara la animación de derrota estilo tetr.io sobre el tablero local. La usa
  // main.ts al morir, tanto en online como en solo (el tablero colapsa).
  playDeathAnimation(): void {
    if (this.deathFrame >= 0) return;
    this.deathFrame = 0;
    this.shakeFrames = 18;
  }

  setColorBlind(enabled: boolean): void {
    this.colorBlind = enabled;
  }

  setBackgroundMotion(enabled: boolean): void { this.backgroundFX.setMotion(enabled); }

  setBackgroundEnabled(enabled: boolean): void { this.backgroundFX.setEnabled(enabled); }

  getJuice(): JuiceFX {
    return this.juice;
  }

  boardGeometry(): BoardGeometry {
    return { boardX: this.boardX, boardY: this.boardY, cell: this.cell, columns: this.boardColumns, rows: this.visibleRows };
  }

  render(state: GameState): void {
    // El shake por line-clear ahora lo gestiona JuiceFX (vía el conductor); aquí
    // solo se mantiene el conteo de líneas por si algo más lo consulta.
    if (state.stats.lines !== this.lastLines) {
      this.lastLines = state.stats.lines;
    }
    // Si volvió a jugar (retry / nueva ronda), se cancela la animación de derrota.
    if (state.status === 'playing') this.deathFrame = -1;

    this.layout(state);
    this.juice.update(this.boardGeometry()); // partículas, overlays, popups
    // El shake legacy se conserva SOLO para playDeathAnimation(); el de gameplay
    // fluye por JuiceFX.
    const legacy = this.shakeFrames > 0 ? Math.sin(this.shakeFrames * 2.3) * 5 : 0;
    const js = this.juice.shakeOffset();
    this.stage.position.set(legacy + js.x, js.y);
    this.shakeFrames = Math.max(0, this.shakeFrames - 1);

    this.backgroundFX.setSeed(state.seed);
    this.drawBackground();
    this.drawPanels();
    if (this.deathFrame >= 0) {
      this.drawDeathBoard(state);
    } else {
      this.drawBoard(state);
    }
    this.drawSidePieces(state);
    this.drawHud(state);
  }

  // Pila gris que colapsa de arriba hacia abajo: cada fila se desvanece y cae con
  // un retardo según su altura (las de arriba primero), más un flash inicial.
  private drawDeathBoard(state: GameState): void {
    this.pieceLayer.clear();
    const progress = Math.min(1, this.deathFrame / DEATH_TOTAL_FRAMES);
    if (this.deathFrame < DEATH_TOTAL_FRAMES) this.deathFrame += 1;

    state.board.forEach((row, y) => {
      if (y < this.hiddenRows) return;
      const boardY = y - this.hiddenRows;
      // Las filas superiores empiezan a colapsar antes que las inferiores.
      const rowStart = (boardY / this.visibleRows) * 0.5;
      const rowP = clamp01((progress - rowStart) / 0.5);
      if (rowP >= 1) return;
      const alpha = 1 - rowP;
      const drop = rowP * rowP * this.cell * 7;
      row.forEach((cell, x) => {
        if (cell && this.isVisibleCell(x, boardY)) this.drawDeathBlock(x, boardY, drop, alpha);
      });
    });

    // Flash blanco breve sobre el tablero al momento del impacto.
    if (progress < 0.2) {
      const flash = (1 - progress / 0.2) * 0.5;
      this.effectLayer.beginFill(0xffffff, flash);
      this.effectLayer.drawRect(this.boardX, this.boardY, this.cell * this.boardColumns, this.cell * this.visibleRows);
      this.effectLayer.endFill();
    }
  }

  private drawDeathBlock(boardX: number, boardY: number, dropPx: number, alpha: number): void {
    const x = this.boardX + boardX * this.cell;
    const y = this.boardY + boardY * this.cell + dropPx;
    const size = this.cell;
    const pad = Math.max(1, size * 0.045);
    const inner = size - pad * 2;
    const bevel = Math.max(1, inner * 0.16);

    this.pieceLayer.beginFill(DEATH_BLOCK, alpha);
    this.pieceLayer.lineStyle(Math.max(1, size * 0.04), DEATH_BLOCK_DARK, alpha);
    this.pieceLayer.drawRect(x + pad, y + pad, inner, inner);
    this.pieceLayer.endFill();

    this.pieceLayer.lineStyle(0, 0, 0);
    this.pieceLayer.beginFill(DEATH_BLOCK_LIGHT, alpha * 0.5);
    this.pieceLayer.drawRect(x + pad, y + pad, inner, bevel);
    this.pieceLayer.drawRect(x + pad, y + pad, bevel, inner);
    this.pieceLayer.endFill();
  }

  private layout(state?: GameState): void {
    this.boardColumns = state?.stats.boardWidth ?? this.boardColumns;
    this.visibleRows = state?.stats.visibleRows ?? this.visibleRows;
    this.hiddenRows = state?.stats.hiddenRows ?? this.hiddenRows;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    const touchControlsInset = window.matchMedia('(pointer: coarse)').matches
      ? this.width > this.height ? 96 : 164
      : 0;
    const availableHeight = Math.max(360, this.height - touchControlsInset);

    // En pantallas angostas los paneles laterales se compactan para dejar más espacio al tablero.
    const compact = this.width < 640;
    this.sideUnits = compact ? 3.6 : 5.2;
    this.gapUnits = compact ? 0.5 : 0.7;

    // El presupuesto horizontal debe contener el tablero MÁS los dos paneles laterales,
    // de lo contrario HOLD/NEXT se salen del viewport (se recortaban en móvil).
    const totalUnits = this.boardColumns + 2 * (this.sideUnits + this.gapUnits);
    const horizMargin = this.width < 760 ? 0.99 : 0.94;
    const horizontalCell = (this.width * horizMargin) / totalUnits;
    const verticalCell = availableHeight * 0.86 / this.visibleRows;
    this.cell = Math.max(12, Math.min(34, horizontalCell, verticalCell));

    this.sideW = this.cell * this.sideUnits;
    const boardW = this.cell * this.boardColumns;
    const boardH = this.cell * this.visibleRows;
    this.boardX = Math.round(this.width / 2 - boardW / 2);
    this.boardY = Math.round(availableHeight / 2 - boardH / 2 + 8);
    this.holdX = this.boardX - this.sideW - this.cell * this.gapUnits;
    this.nextX = this.boardX + boardW + this.cell * this.gapUnits;

    // Columna izquierda apilada: tarjeta HOLD arriba, tarjeta de stats debajo.
    this.statsTwoCol = this.sideW > this.cell * 4.3;
    this.holdH = this.cell * 3.6;
    this.statsY = this.boardY + this.holdH + this.cell * 0.55;
    this.statsH = this.cell * (this.statsTwoCol ? 5.1 : 6.7);
  }

  private drawBackground(): void {
    // El fondo de ventana ahora lo dibuja BackgroundFX (Canvas2D, detrás de Pixi).
    this.bg.clear();
  }

  private drawPanels(): void {
    this.boardLayer.clear();
    this.sideLayer.clear();
    this.effectLayer.clear();
    const radius = Math.max(6, this.cell * 0.42);
    const boardW = this.cell * this.boardColumns;
    const boardH = this.cell * this.visibleRows;

    // Marco del tablero: relleno oscuro translúcido + borde fino redondeado.
    this.boardLayer.lineStyle(Math.max(1.5, this.cell * 0.055), BOARD_FRAME, 0.5);
    this.boardLayer.beginFill(0x070b12, 0.5);
    this.boardLayer.drawRoundedRect(this.boardX, this.boardY, boardW, boardH, radius * 0.6);
    this.boardLayer.endFill();
    this.boardLayer.lineStyle(0, 0, 0);
    this.drawGrid();

    // Columna izquierda: tarjeta HOLD arriba, tarjeta de stats debajo.
    this.drawCard(this.sideLayer, this.holdX, this.boardY, this.sideW, this.holdH, radius);
    this.drawCard(this.sideLayer, this.holdX, this.statsY, this.sideW, this.statsH, radius);
    // Columna derecha: tarjeta NEXT.
    const nextH = this.cell * Math.max(3.8, 1.7 + Math.max(1, DEFAULT_RULES.nextPreview) * 2.3);
    this.drawCard(this.sideLayer, this.nextX, this.boardY, this.sideW, nextH, radius);

    // Cabeceras con puntito turquesa (HOLD / NEXT / LINES).
    this.drawCardHeader(this.holdLabel, this.holdX, this.boardY);
    this.drawCardHeader(this.nextLabel, this.nextX, this.boardY);
    this.drawCardHeader(this.linesLabel, this.holdX, this.statsY);
  }

  // Tarjeta redondeada del estilo "Modo Relax": relleno oscuro + borde fino claro.
  private drawCard(g: Graphics, x: number, y: number, w: number, h: number, radius: number): void {
    g.lineStyle(Math.max(1, this.cell * 0.04), CARD_BORDER, 0.16);
    g.beginFill(CARD_FILL, 0.72);
    g.drawRoundedRect(x, y, w, h, radius);
    g.endFill();
    g.lineStyle(0, 0, 0);
  }

  // Punto turquesa + etiqueta de la cabecera de una tarjeta.
  private drawCardHeader(label: Text, cardX: number, cardY: number): void {
    const pad = this.cell * 0.5;
    const dotR = Math.max(2.5, this.cell * 0.11);
    const cy = cardY + pad + dotR;
    this.sideLayer.beginFill(CARD_ACCENT, 0.95);
    this.sideLayer.drawCircle(cardX + pad + dotR, cy, dotR);
    this.sideLayer.endFill();
    label.style.fontSize = Math.max(11, this.cell * 0.46);
    label.anchor.set(0, 0.5);
    label.position.set(cardX + pad + dotR * 2 + this.cell * 0.28, cy);
  }

  private drawGrid(): void {
    this.boardLayer.lineStyle(1, GRID_LINE, 0.4);
    for (let x = 1; x < this.boardColumns; x += 1) {
      this.boardLayer.moveTo(this.boardX + x * this.cell, this.boardY);
      this.boardLayer.lineTo(this.boardX + x * this.cell, this.boardY + this.cell * this.visibleRows);
    }
    for (let y = 1; y < this.visibleRows; y += 1) {
      this.boardLayer.moveTo(this.boardX, this.boardY + y * this.cell);
      this.boardLayer.lineTo(this.boardX + this.cell * this.boardColumns, this.boardY + y * this.cell);
    }
    this.boardLayer.lineStyle(0, 0, 0);
  }

  private drawBoard(state: GameState): void {
    this.pieceLayer.clear();
    state.board.forEach((row, y) => {
      if (y < this.hiddenRows) return;
      row.forEach((cell, x) => {
        if (cell) this.drawVisibleBlock(x, y - this.hiddenRows, cell, 1);
      });
    });

    if (state.ghost) {
      for (const cell of cellsFor(state.ghost.type, state.ghost.rotation)) {
        this.drawVisibleGhostBlock(state.ghost.x + cell.x, state.ghost.y + cell.y - this.hiddenRows);
      }
    }

    if (state.active) {
      for (const cell of cellsFor(state.active.type, state.active.rotation)) {
        this.drawVisibleBlock(state.active.x + cell.x, state.active.y + cell.y - this.hiddenRows, state.active.type, 1);
      }
    }
  }

  private drawSidePieces(state: GameState): void {
    const playing = state.status === 'playing';
    const scale = this.sideUnits < 4 ? 0.5 : 0.58;
    const size = this.cell * scale;
    // HOLD centrado en su tarjeta.
    if (playing && state.hold) {
      this.drawCenteredPiece(state.hold, this.holdX, this.sideW, this.boardY + this.holdH * 0.62, size);
    }
    // NEXT: la primera pieza va resaltada en una sub-celda turquesa; el resto, apiladas.
    if (!playing) return;
    state.next.forEach((piece, index) => {
      const cy = this.boardY + this.cell * (1.95 + index * 2.25);
      if (index === 0) {
        const r = Math.max(5, this.cell * 0.32);
        const hx = this.nextX + this.cell * 0.4;
        const hw = this.sideW - this.cell * 0.8;
        const hy = this.boardY + this.cell * 1.0;
        const hh = this.cell * 1.95;
        this.sideLayer.lineStyle(Math.max(1, this.cell * 0.04), CARD_ACCENT, 0.45);
        this.sideLayer.beginFill(CARD_ACCENT, 0.08);
        this.sideLayer.drawRoundedRect(hx, hy, hw, hh, r);
        this.sideLayer.endFill();
        this.sideLayer.lineStyle(0, 0, 0);
      }
      this.drawCenteredPiece(piece, this.nextX, this.sideW, cy, size);
    });
  }

  // Dibuja una pieza centrada (horizontal y vertical) alrededor de (cardX+cardW/2, centerY).
  private drawCenteredPiece(piece: PieceType, cardX: number, cardW: number, centerY: number, size: number): void {
    const cells = cellsFor(piece, 0);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of cells) {
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
      minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
    }
    const wCells = maxX - minX + 1, hCells = maxY - minY + 1;
    const ox = cardX + cardW / 2 - (wCells * size) / 2 - minX * size;
    const oy = centerY - (hCells * size) / 2 - minY * size;
    for (const c of cells) this.drawBlockAt(this.sideLayer, ox + c.x * size, oy + c.y * size, size, piece, 0.95);
  }

  // Tarjeta de stats (estilo "Modo Relax"): valor grande de LINES con barra de
  // progreso, y fila inferior con PIECES (+ PPS) y TIME (+ milisegundos).
  private drawHud(state: GameState): void {
    const elapsedFrames = displayedElapsedFrames(state.stats);
    const seconds = elapsedFrames / 60;
    const pps = seconds > 0 ? state.stats.pieces / seconds : 0;
    const hasTarget = state.stats.targetLines !== null;
    const px = this.holdX + this.cell * 0.55;
    const rightX = this.statsTwoCol ? this.holdX + this.sideW * 0.54 : px;
    const labelSize = Math.max(10, this.cell * 0.42);
    const subSize = Math.max(9, this.cell * 0.38);

    // Valor grande: LINES (con objetivo) o GARBAGE (online sin objetivo).
    this.linesLabel.text = hasTarget ? 'LINES' : 'GARBAGE';
    this.linesValue.style.fontSize = Math.max(20, this.cell * 0.98);
    this.linesValue.anchor.set(0, 0);
    this.linesValue.position.set(px, this.statsY + this.cell * 1.05);
    this.linesValue.text = hasTarget
      ? `${state.stats.lines} / ${state.stats.targetLines}`
      : `${state.stats.pendingGarbage}▾ ${state.stats.sentGarbage}▴`;

    // Barra de progreso (solo en modo con objetivo de líneas).
    if (hasTarget) {
      const target = state.stats.targetLines ?? 1;
      const frac = clamp01(state.stats.lines / Math.max(1, target));
      const barX = px;
      const barY = this.statsY + this.cell * 2.18;
      const barW = this.sideW - this.cell * 1.1;
      const barH = Math.max(4, this.cell * 0.26);
      const barR = barH / 2;
      this.sideLayer.beginFill(CARD_TRACK, 1);
      this.sideLayer.drawRoundedRect(barX, barY, barW, barH, barR);
      this.sideLayer.endFill();
      if (frac > 0) {
        this.sideLayer.beginFill(CARD_ACCENT, 0.95);
        this.sideLayer.drawRoundedRect(barX, barY, Math.max(barH, barW * frac), barH, barR);
        this.sideLayer.endFill();
      }
    }

    // Fila inferior: PIECES y TIME. En dos columnas si la tarjeta es ancha; si no,
    // TIME se apila debajo de PIECES para no solaparse en pantallas angostas.
    const valueSize = Math.max(16, this.cell * 0.72);
    const pcsLabelY = this.statsY + this.cell * 2.95;
    const pcsValueY = this.statsY + this.cell * 3.45;
    const pcsSubY = this.statsY + this.cell * 4.2;
    const rowGap = this.cell * 1.75;
    const timeLabelY = this.statsTwoCol ? pcsLabelY : pcsLabelY + rowGap;
    const timeValueY = this.statsTwoCol ? pcsValueY : pcsValueY + rowGap;
    const timeSubY = this.statsTwoCol ? pcsSubY : pcsSubY + rowGap;
    this.placeStat(this.pcsLabel, px, pcsLabelY, labelSize);
    this.placeStat(this.pcsValue, px, pcsValueY, valueSize);
    this.placeStat(this.pcsSub, px, pcsSubY, subSize);
    this.placeStat(this.timeLabel, rightX, timeLabelY, labelSize);
    this.placeStat(this.timeValue, rightX, timeValueY, valueSize);
    this.placeStat(this.timeSub, rightX, timeSubY, subSize);

    this.pcsValue.text = `${state.stats.pieces}`;
    this.pcsSub.text = `${pps.toFixed(2)} PPS`;
    const total = formatTime(seconds);
    const dot = total.indexOf('.');
    this.timeValue.text = dot >= 0 ? total.slice(0, dot) : total;
    this.timeSub.text = dot >= 0 ? total.slice(dot) : '';

    // Banner central de fin de partida.
    const banner = state.status === 'finished'
      ? 'CLEAR · R PARA REINTENTAR'
      : state.status === 'gameover' ? 'TOP OUT · R PARA REINTENTAR' : '';
    this.bannerText.text = banner;
    this.bannerText.visible = banner !== '';
    if (banner) {
      this.bannerText.style.fontSize = Math.max(15, this.cell * 0.62);
      this.bannerText.position.set(
        this.boardX + this.cell * this.boardColumns / 2,
        this.boardY + this.cell * this.visibleRows / 2,
      );
    }
  }

  private placeStat(t: Text, x: number, y: number, fontSize: number): void {
    t.style.fontSize = fontSize;
    t.anchor.set(0, 0);
    t.position.set(x, y);
  }

  private drawVisibleBlock(boardX: number, boardY: number, piece: PieceType, alpha: number): void {
    if (!this.isVisibleCell(boardX, boardY)) return;
    this.drawBlock(this.pieceLayer, boardX, boardY, piece, alpha);
  }

  private drawVisibleGhostBlock(boardX: number, boardY: number): void {
    if (!this.isVisibleCell(boardX, boardY)) return;
    this.drawGhostBlock(this.pieceLayer, boardX, boardY);
  }

  private isVisibleCell(boardX: number, boardY: number): boolean {
    return boardX >= 0 && boardX < this.boardColumns && boardY >= -this.hiddenRows && boardY < this.visibleRows;
  }


  private drawBlock(g: Graphics, boardX: number, boardY: number, piece: PieceType, alpha: number): void {
    if (boardY < -this.hiddenRows) return;
    const x = this.boardX + boardX * this.cell;
    const y = this.boardY + boardY * this.cell;
    this.drawBlockAt(g, x, y, this.cell, piece, alpha);
  }

  private drawGhostBlock(g: Graphics, boardX: number, boardY: number): void {
    if (boardY < -this.hiddenRows) return;
    const x = this.boardX + boardX * this.cell;
    const y = this.boardY + boardY * this.cell;
    const pad = Math.max(1, this.cell * 0.1);
    const inset = Math.max(4, this.cell * 0.24);
    const outerSize = this.cell - pad * 2;
    const lineWidth = Math.max(1, this.cell * 0.06);

    g.beginFill(GHOST_FILL, 0.84);
    g.lineStyle(lineWidth, GHOST_LINE, 0.72);
    g.drawRect(x + pad, y + pad, outerSize, outerSize);
    g.endFill();

    g.beginFill(0x000000, 0.12);
    g.lineStyle(Math.max(1, lineWidth * 0.72), GHOST_INSET_LINE, 0.78);
    g.drawRect(x + inset, y + inset, this.cell - inset * 2, this.cell - inset * 2);
    g.endFill();
  }

  private drawBlockAt(g: Graphics, x: number, y: number, size: number, piece: PieceType, alpha: number): void {
    const color = (this.colorBlind ? PIECE_COLORS_COLORBLIND : PIECE_COLORS)[piece];
    const palette = blockPaletteFor(color);
    const pad = Math.max(1, size * 0.045);
    const outerX = x + pad;
    const outerY = y + pad;
    const outerSize = size - pad * 2;
    const bevel = Math.max(1, outerSize * 0.1);
    const inset = Math.max(3, size * 0.23);
    const innerX = x + inset;
    const innerY = y + inset;
    const innerSize = size - inset * 2;

    g.beginFill(color, alpha);
    g.lineStyle(Math.max(1, size * 0.04), palette.outerLine, alpha);
    g.drawRect(outerX, outerY, outerSize, outerSize);
    g.endFill();

    g.lineStyle(0, 0x000000, 0);
    g.beginFill(palette.bevelLight, alpha * 0.42);
    g.drawRect(outerX + bevel * 0.45, outerY + bevel * 0.45, outerSize - bevel * 0.9, bevel);
    g.drawRect(outerX + bevel * 0.45, outerY + bevel * 0.45, bevel, outerSize - bevel * 0.9);
    g.endFill();

    g.beginFill(palette.bevelDark, alpha * 0.36);
    g.drawRect(outerX + bevel * 0.45, outerY + outerSize - bevel * 1.45, outerSize - bevel * 0.9, bevel);
    g.drawRect(outerX + outerSize - bevel * 1.45, outerY + bevel * 0.45, bevel, outerSize - bevel * 0.9);
    g.endFill();

    if (innerSize > 2) {
      const lineWidth = Math.max(1, size * 0.035);
      const innerBevel = Math.max(1, innerSize * 0.18);

      g.beginFill(palette.innerFill, alpha * 0.76);
      g.lineStyle(lineWidth, palette.innerLine, alpha * 0.8);
      g.drawRect(innerX, innerY, innerSize, innerSize);
      g.endFill();

      g.lineStyle(0, 0x000000, 0);
      g.beginFill(palette.innerGlow, alpha * 0.44);
      g.drawRect(innerX + lineWidth, innerY + lineWidth, innerSize - lineWidth * 2, innerBevel);
      g.drawRect(innerX + lineWidth, innerY + lineWidth, innerBevel, innerSize - lineWidth * 2);
      g.endFill();

      g.beginFill(palette.innerShadow, alpha * 0.34);
      g.drawRect(innerX + lineWidth, innerY + innerSize - innerBevel - lineWidth, innerSize - lineWidth * 2, innerBevel);
      g.drawRect(innerX + innerSize - innerBevel - lineWidth, innerY + lineWidth, innerBevel, innerSize - lineWidth * 2);
      g.endFill();
    }
  }
}

function blockPaletteFor(color: number): BlockPalette {
  const cached = blockPaletteCache.get(color);
  if (cached) return cached;

  const palette = {
    outerLine: mixColor(color, 0xffffff, 0.22),
    bevelLight: mixColor(color, 0xffffff, 0.28),
    bevelDark: mixColor(color, 0x000000, 0.28),
    innerFill: mixColor(color, 0xffffff, 0.08),
    innerLine: mixColor(color, 0x000000, 0.18),
    innerGlow: mixColor(color, 0xffffff, 0.34),
    innerShadow: mixColor(color, 0x000000, 0.36),
  };
  blockPaletteCache.set(color, palette);
  return palette;
}

function mixColor(color: number, target: number, weight: number): number {
  const r = mixChannel((color >> 16) & 255, (target >> 16) & 255, weight);
  const g = mixChannel((color >> 8) & 255, (target >> 8) & 255, weight);
  const b = mixChannel(color & 255, target & 255, weight);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

function mixChannel(channel: number, target: number, weight: number): number {
  return channel + (target - channel) * weight;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  const millis = Math.floor((seconds % 1) * 1000).toString().padStart(3, '0');
  return `${minutes}:${secs}.${millis}`;
}
