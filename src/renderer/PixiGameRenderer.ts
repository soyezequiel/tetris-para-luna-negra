import { Application } from '@pixi/app';
import { Container } from '@pixi/display';
import { Graphics } from '@pixi/graphics';
import { Text, TextStyle } from '@pixi/text';
import { cellsFor, PIECE_COLORS } from '../game/pieces';
import { DEFAULT_RULES } from '../game/rules';
import { displayedElapsedFrames } from '../game/timing';
import type { GameState, PieceType } from '../game/types';

const PANEL_LINE = 0xf7f7f2;
const PANEL_FILL = 0x040507;
const GRID_LINE = 0x2f3338;
const GHOST_FILL = 0x07090b;
const GHOST_LINE = 0x525a60;
const GHOST_INSET_LINE = 0x262c31;

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
  private readonly labelLayer = new Container();
  private readonly hudText: Text;
  private readonly holdLabel: Text;
  private readonly nextLabel: Text;
  private width = 1;
  private height = 1;
  private cell = 24;
  private boardX = 0;
  private boardY = 0;
  private lastLines = 0;
  private shakeFrames = 0;

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
    const sideLabelStyle = new TextStyle({
      fill: PANEL_LINE,
      fontFamily: 'Arial Black, Arial, sans-serif',
      fontSize: 18,
      fontWeight: '900',
    });
    this.holdLabel = new Text('HOLD', sideLabelStyle);
    this.nextLabel = new Text('NEXT', sideLabelStyle);
    this.labelLayer.addChild(this.holdLabel, this.nextLabel);
    this.stage.addChild(this.bg, this.sideLayer, this.boardLayer, this.pieceLayer, this.effectLayer, this.labelLayer, this.hudText);
    this.app.stage.addChild(this.stage);
    window.addEventListener('resize', () => this.layout());
    this.layout();
  }

  destroy(): void {
    this.app.destroy(true, true);
  }

  render(state: GameState): void {
    if (state.stats.lines !== this.lastLines) {
      this.shakeFrames = 10;
      this.lastLines = state.stats.lines;
    }
    this.layout();
    const shake = this.shakeFrames > 0 ? Math.sin(this.shakeFrames * 2.3) * 5 : 0;
    this.stage.position.set(shake, 0);
    this.shakeFrames = Math.max(0, this.shakeFrames - 1);

    this.drawBackground();
    this.drawPanels();
    this.drawBoard(state);
    this.drawSidePieces(state);
    this.drawHud(state);
  }

  private layout(): void {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    const touchControlsInset = window.matchMedia('(pointer: coarse)').matches
      ? this.width > this.height ? 96 : 164
      : 0;
    const availableHeight = Math.max(360, this.height - touchControlsInset);
    const horizontalBudget = this.width < 760 ? this.width * 0.58 : this.width * 0.2;
    const verticalBudget = availableHeight * 0.86 / DEFAULT_RULES.visibleRows;
    this.cell = Math.max(15, Math.min(34, horizontalBudget / DEFAULT_RULES.boardWidth, verticalBudget));
    const boardW = this.cell * DEFAULT_RULES.boardWidth;
    const boardH = this.cell * DEFAULT_RULES.visibleRows;
    this.boardX = Math.round(this.width / 2 - boardW / 2);
    this.boardY = Math.round(availableHeight / 2 - boardH / 2 + 8);
  }

  private drawBackground(): void {
    this.bg.clear();
    this.bg.beginFill(0x0b1015, 1);
    this.bg.drawRect(0, 0, this.width, this.height);
    this.bg.endFill();

    for (let i = 0; i < 7; i += 1) {
      const y = this.height * (0.15 + i * 0.11);
      const alpha = 0.08 + i * 0.015;
      this.bg.beginFill(i % 2 ? 0x9b6b46 : 0x20374a, alpha);
      this.bg.drawEllipse(this.width * (0.15 + i * 0.13), y, this.width * 0.22, this.height * 0.16);
      this.bg.endFill();
    }

    this.bg.beginFill(0xc9d2d7, 0.17);
    this.bg.drawRect(0, this.height * 0.67, this.width, this.height * 0.18);
    this.bg.endFill();
    this.bg.beginFill(0xf8f8f5, 0.92);
    this.bg.drawRect(0, this.height * 0.88, this.width, this.height * 0.12);
    this.bg.endFill();
    this.bg.beginFill(0x020509, 0.42);
    this.bg.drawRect(0, 0, this.width, this.height);
    this.bg.endFill();
  }

  private drawPanels(): void {
    this.boardLayer.clear();
    this.sideLayer.clear();
    this.effectLayer.clear();
    this.drawAngledPanel(this.boardLayer, this.boardX, this.boardY, this.cell * 10, this.cell * 20, 0);
    this.drawGrid();

    const sideW = this.cell * 5.2;
    const holdX = this.boardX - sideW - this.cell * 0.7;
    const nextX = this.boardX + this.cell * 10 + this.cell * 0.7;
    this.drawLabelPanel(this.sideLayer, 'HOLD', holdX, this.boardY, sideW, this.cell * 3.8);
    this.drawLabelPanel(this.sideLayer, 'NEXT', nextX, this.boardY, sideW, this.cell * 14.5);
    this.positionLabel(this.holdLabel, holdX, this.boardY);
    this.positionLabel(this.nextLabel, nextX, this.boardY);
  }

  private drawGrid(): void {
    this.boardLayer.lineStyle(1, GRID_LINE, 0.58);
    for (let x = 1; x < DEFAULT_RULES.boardWidth; x += 1) {
      this.boardLayer.moveTo(this.boardX + x * this.cell, this.boardY);
      this.boardLayer.lineTo(this.boardX + x * this.cell, this.boardY + this.cell * DEFAULT_RULES.visibleRows);
    }
    for (let y = 1; y < DEFAULT_RULES.visibleRows; y += 1) {
      this.boardLayer.moveTo(this.boardX, this.boardY + y * this.cell);
      this.boardLayer.lineTo(this.boardX + this.cell * DEFAULT_RULES.boardWidth, this.boardY + y * this.cell);
    }
  }

  private drawBoard(state: GameState): void {
    this.pieceLayer.clear();
    state.board.forEach((row, y) => {
      if (y < DEFAULT_RULES.hiddenRows) return;
      row.forEach((cell, x) => {
        if (cell) this.drawBlock(this.pieceLayer, x, y - DEFAULT_RULES.hiddenRows, cell, 1);
      });
    });

    if (state.ghost) {
      for (const cell of cellsFor(state.ghost.type, state.ghost.rotation)) {
        this.drawGhostBlock(this.pieceLayer, state.ghost.x + cell.x, state.ghost.y + cell.y - DEFAULT_RULES.hiddenRows);
      }
    }

    if (state.active) {
      for (const cell of cellsFor(state.active.type, state.active.rotation)) {
        this.drawBlock(this.pieceLayer, state.active.x + cell.x, state.active.y + cell.y - DEFAULT_RULES.hiddenRows, state.active.type, 1);
      }
    }
  }

  private drawSidePieces(state: GameState): void {
    const sideW = this.cell * 5.2;
    const holdX = this.boardX - sideW - this.cell * 0.7;
    const nextX = this.boardX + this.cell * 10 + this.cell * 0.7;
    if (state.status !== 'playing') return;
    if (state.hold) this.drawMiniPiece(this.sideLayer, state.hold, holdX + this.cell * 1.1, this.boardY + this.cell * 1.25, 0.62);
    state.next.forEach((piece, index) => {
      this.drawMiniPiece(this.sideLayer, piece, nextX + this.cell * 1.05, this.boardY + this.cell * (1.3 + index * 2.45), 0.58);
    });
  }

  private drawHud(state: GameState): void {
    const elapsedFrames = displayedElapsedFrames(state.stats);
    const seconds = elapsedFrames / 60;
    const pps = seconds > 0 ? state.stats.pieces / seconds : 0;
    const finish = state.status === 'finished' ? '\nCLEAR - R TO RETRY' : state.status === 'gameover' ? '\nTOP OUT - R TO RETRY' : '';
    this.hudText.text = `PIECES\n${state.stats.pieces}  ${pps.toFixed(2)}/S\n\nLINES\n${state.stats.lines}/40\n\nTIME\n${formatTime(seconds)}${finish}`;
    this.hudText.style.fontSize = Math.max(14, Math.min(22, this.cell * 0.68));
    this.hudText.style.align = 'right';
    this.hudText.anchor.set(1, 1);
    this.hudText.position.set(this.boardX - this.cell * 0.35, this.boardY + this.cell * 19.8);
  }

  private drawAngledPanel(g: Graphics, x: number, y: number, w: number, h: number, labelHeight: number): void {
    g.beginFill(PANEL_FILL, 0.78);
    g.lineStyle(Math.max(3, this.cell * 0.1), PANEL_LINE, 1);
    g.moveTo(x, y + labelHeight);
    g.lineTo(x + w, y + labelHeight);
    g.lineTo(x + w, y + h);
    g.lineTo(x, y + h);
    g.closePath();
    g.endFill();
  }

  private drawLabelPanel(g: Graphics, _label: string, x: number, y: number, w: number, h: number): void {
    const cut = this.cell * 0.55;
    g.beginFill(PANEL_FILL, 0.74);
    g.lineStyle(Math.max(3, this.cell * 0.09), PANEL_LINE, 1);
    g.moveTo(x, y);
    g.lineTo(x + w, y);
    g.lineTo(x + w, y + h - cut);
    g.lineTo(x + w - cut, y + h);
    g.lineTo(x + cut, y + h);
    g.lineTo(x, y + h - cut);
    g.closePath();
    g.endFill();

  }

  private positionLabel(label: Text, x: number, y: number): void {
    label.style.fontSize = Math.max(14, this.cell * 0.72);
    label.position.set(x + this.cell * 0.16, y - this.cell * 0.95);
  }

  private drawBlock(g: Graphics, boardX: number, boardY: number, piece: PieceType, alpha: number): void {
    if (boardY < 0) return;
    const x = this.boardX + boardX * this.cell;
    const y = this.boardY + boardY * this.cell;
    this.drawBlockAt(g, x, y, this.cell, piece, alpha);
  }

  private drawGhostBlock(g: Graphics, boardX: number, boardY: number): void {
    if (boardY < 0) return;
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

  private drawMiniPiece(g: Graphics, piece: PieceType, x: number, y: number, scale: number): void {
    const size = this.cell * scale;
    for (const cell of cellsFor(piece, 0)) {
      this.drawBlockAt(g, x + cell.x * size, y + cell.y * size, size, piece, 0.95);
    }
  }

  private drawBlockAt(g: Graphics, x: number, y: number, size: number, piece: PieceType, alpha: number): void {
    const color = PIECE_COLORS[piece];
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

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  const millis = Math.floor((seconds % 1) * 1000).toString().padStart(3, '0');
  return `${minutes}:${secs}.${millis}`;
}
