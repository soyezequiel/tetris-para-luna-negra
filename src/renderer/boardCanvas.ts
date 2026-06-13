import { cellsFor, PIECE_COLORS, PIECE_COLORS_COLORBLIND } from '../game/pieces';
import type { GameState } from '../game/types';

// Renderer Canvas2D autónomo de un tablero, con el MISMO look que el juego real
// (bloques con relieve/bevel, ghost, grilla) — ver PixiGameRenderer.drawBlockAt.
// Pixi vive en una sola Application atada a la ventana; para el visor multi-tablero
// necesitamos N tableros chicos e independientes, así que replicamos el dibujo
// acá sin Pixi. Mismo algoritmo de paleta para que los colores coincidan.

const BOARD_BG = '#05070b';
const GRID_LINE = 'rgba(47, 51, 56, 0.55)';
const PANEL_LINE = 'rgba(247, 247, 242, 0.85)';
const GHOST_FILL = 'rgba(7, 9, 11, 0.84)';
const GHOST_LINE = 'rgba(82, 90, 96, 0.72)';
const GHOST_INNER = 'rgba(38, 44, 49, 0.78)';

interface BlockPalette {
  outerLine: string;
  bevelLight: string;
  bevelDark: string;
  innerFill: string;
  innerLine: string;
  innerGlow: string;
  innerShadow: string;
}

const paletteCache = new Map<number, BlockPalette>();

export interface BoardCanvasOptions {
  colorBlind?: boolean;
}

// Dibuja el estado en el canvas. Asume que el canvas ya tiene el tamaño en píxeles
// de dispositivo correcto (ver sizeBoardCanvas); escala el dibujo a sus dimensiones.
export function drawBoardToCanvas(canvas: HTMLCanvasElement, state: GameState, opts: BoardCanvasOptions = {}): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const columns = state.stats.boardWidth;
  const visibleRows = state.stats.visibleRows;
  const hiddenRows = state.stats.hiddenRows;
  const widthPx = canvas.width;
  const heightPx = canvas.height;
  const cell = Math.min(widthPx / columns, heightPx / visibleRows);
  const boardW = cell * columns;
  const boardH = cell * visibleRows;
  const originX = Math.round((widthPx - boardW) / 2);
  const originY = Math.round((heightPx - boardH) / 2);

  ctx.clearRect(0, 0, widthPx, heightPx);
  // Fondo y grilla del tablero.
  ctx.fillStyle = BOARD_BG;
  ctx.fillRect(originX, originY, boardW, boardH);
  ctx.strokeStyle = GRID_LINE;
  ctx.lineWidth = Math.max(1, cell * 0.03);
  ctx.beginPath();
  for (let c = 1; c < columns; c += 1) {
    const x = originX + c * cell;
    ctx.moveTo(x, originY);
    ctx.lineTo(x, originY + boardH);
  }
  for (let r = 1; r < visibleRows; r += 1) {
    const y = originY + r * cell;
    ctx.moveTo(originX, y);
    ctx.lineTo(originX + boardW, y);
  }
  ctx.stroke();

  const colors = opts.colorBlind ? PIECE_COLORS_COLORBLIND : PIECE_COLORS;
  const cellPx = (bx: number, by: number) => ({ x: originX + bx * cell, y: originY + by * cell });

  // Pila fija.
  for (let y = hiddenRows; y < state.board.length; y += 1) {
    const row = state.board[y];
    if (!row) continue;
    const boardY = y - hiddenRows;
    if (boardY >= visibleRows) continue;
    for (let x = 0; x < columns; x += 1) {
      const piece = row[x];
      if (piece) {
        const p = cellPx(x, boardY);
        drawBlock(ctx, p.x, p.y, cell, colors[piece]);
      }
    }
  }

  // Ghost.
  if (state.ghost) {
    for (const c of cellsFor(state.ghost.type, state.ghost.rotation)) {
      const boardY = state.ghost.y + c.y - hiddenRows;
      const boardX = state.ghost.x + c.x;
      if (boardY < 0 || boardY >= visibleRows || boardX < 0 || boardX >= columns) continue;
      const p = cellPx(boardX, boardY);
      drawGhost(ctx, p.x, p.y, cell);
    }
  }

  // Pieza activa.
  if (state.active) {
    for (const c of cellsFor(state.active.type, state.active.rotation)) {
      const boardY = state.active.y + c.y - hiddenRows;
      const boardX = state.active.x + c.x;
      if (boardY < 0 || boardY >= visibleRows || boardX < 0 || boardX >= columns) continue;
      const p = cellPx(boardX, boardY);
      drawBlock(ctx, p.x, p.y, cell, colors[state.active.type]);
    }
  }

  // Borde del tablero.
  ctx.strokeStyle = PANEL_LINE;
  ctx.lineWidth = Math.max(2, cell * 0.08);
  ctx.strokeRect(originX, originY, boardW, boardH);
}

// Réplica Canvas2D de PixiGameRenderer.drawBlockAt: relleno + línea exterior,
// bevel claro arriba/izquierda, bevel oscuro abajo/derecha, y núcleo interior.
function drawBlock(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: number): void {
  const palette = paletteFor(color);
  const pad = Math.max(1, size * 0.045);
  const outerX = x + pad;
  const outerY = y + pad;
  const outerSize = size - pad * 2;
  const bevel = Math.max(1, outerSize * 0.1);
  const inset = Math.max(3, size * 0.23);
  const innerX = x + inset;
  const innerY = y + inset;
  const innerSize = size - inset * 2;

  ctx.fillStyle = toHex(color);
  ctx.fillRect(outerX, outerY, outerSize, outerSize);
  ctx.lineWidth = Math.max(1, size * 0.04);
  ctx.strokeStyle = palette.outerLine;
  ctx.strokeRect(outerX, outerY, outerSize, outerSize);

  fillAlpha(ctx, palette.bevelLight, 0.42, () => {
    ctx.fillRect(outerX + bevel * 0.45, outerY + bevel * 0.45, outerSize - bevel * 0.9, bevel);
    ctx.fillRect(outerX + bevel * 0.45, outerY + bevel * 0.45, bevel, outerSize - bevel * 0.9);
  });
  fillAlpha(ctx, palette.bevelDark, 0.36, () => {
    ctx.fillRect(outerX + bevel * 0.45, outerY + outerSize - bevel * 1.45, outerSize - bevel * 0.9, bevel);
    ctx.fillRect(outerX + outerSize - bevel * 1.45, outerY + bevel * 0.45, bevel, outerSize - bevel * 0.9);
  });

  if (innerSize > 2) {
    const lineWidth = Math.max(1, size * 0.035);
    const innerBevel = Math.max(1, innerSize * 0.18);
    fillAlpha(ctx, palette.innerFill, 0.76, () => ctx.fillRect(innerX, innerY, innerSize, innerSize));
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = palette.innerLine;
    ctx.strokeRect(innerX, innerY, innerSize, innerSize);
    ctx.globalAlpha = 1;
    fillAlpha(ctx, palette.innerGlow, 0.44, () => {
      ctx.fillRect(innerX + lineWidth, innerY + lineWidth, innerSize - lineWidth * 2, innerBevel);
      ctx.fillRect(innerX + lineWidth, innerY + lineWidth, innerBevel, innerSize - lineWidth * 2);
    });
    fillAlpha(ctx, palette.innerShadow, 0.34, () => {
      ctx.fillRect(innerX + lineWidth, innerY + innerSize - innerBevel - lineWidth, innerSize - lineWidth * 2, innerBevel);
      ctx.fillRect(innerX + innerSize - innerBevel - lineWidth, innerY + lineWidth, innerBevel, innerSize - lineWidth * 2);
    });
  }
}

function drawGhost(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const pad = Math.max(1, size * 0.1);
  const inset = Math.max(4, size * 0.24);
  const outerSize = size - pad * 2;
  ctx.fillStyle = GHOST_FILL;
  ctx.fillRect(x + pad, y + pad, outerSize, outerSize);
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.strokeStyle = GHOST_LINE;
  ctx.strokeRect(x + pad, y + pad, outerSize, outerSize);
  ctx.lineWidth = Math.max(1, size * 0.045);
  ctx.strokeStyle = GHOST_INNER;
  ctx.strokeRect(x + inset, y + inset, size - inset * 2, size - inset * 2);
}

function fillAlpha(ctx: CanvasRenderingContext2D, style: string, alpha: number, draw: () => void): void {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = style;
  draw();
  ctx.globalAlpha = 1;
}

function paletteFor(color: number): BlockPalette {
  const cached = paletteCache.get(color);
  if (cached) return cached;
  const palette: BlockPalette = {
    outerLine: toHex(mix(color, 0xffffff, 0.22)),
    bevelLight: toHex(mix(color, 0xffffff, 0.28)),
    bevelDark: toHex(mix(color, 0x000000, 0.28)),
    innerFill: toHex(mix(color, 0xffffff, 0.08)),
    innerLine: toHex(mix(color, 0x000000, 0.18)),
    innerGlow: toHex(mix(color, 0xffffff, 0.34)),
    innerShadow: toHex(mix(color, 0x000000, 0.36)),
  };
  paletteCache.set(color, palette);
  return palette;
}

function mix(color: number, target: number, weight: number): number {
  const r = mixChannel((color >> 16) & 255, (target >> 16) & 255, weight);
  const g = mixChannel((color >> 8) & 255, (target >> 8) & 255, weight);
  const b = mixChannel(color & 255, target & 255, weight);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

function mixChannel(a: number, b: number, weight: number): number {
  return a + (b - a) * weight;
}

function toHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

// Ajusta el tamaño en píxeles de dispositivo del canvas para un dibujo nítido,
// dado el tamaño CSS (en px lógicos) deseado. Devuelve true si cambió.
export function sizeBoardCanvas(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): boolean {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(cssWidth * dpr);
  const h = Math.round(cssHeight * dpr);
  const cssChanged = canvas.style.width !== `${cssWidth}px` || canvas.style.height !== `${cssHeight}px`;
  if (cssChanged) {
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
  }
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return cssChanged;
}
