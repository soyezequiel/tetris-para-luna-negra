import { cellsFor, PIECE_COLORS, PIECE_COLORS_COLORBLIND } from '../game/pieces';
import type { GameState, PieceType } from '../game/types';

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
  // Dibuja los paneles laterales del juego real (HOLD a la izquierda, NEXT a la
  // derecha) y la barra de basura entrante pegada al tablero. Cuando está activo el
  // canvas debe ser más ancho (≈18 celdas de ancho × 20 de alto) para que entren.
  panels?: boolean;
  // Cuántas piezas de la cola NEXT mostrar (default: las que traiga el estado).
  nextCount?: number;
}

const LABEL_COLOR = 'rgba(247, 247, 242, 0.66)';
const CARD_BG = 'rgba(255, 255, 255, 0.035)';
const CARD_LINE = 'rgba(255, 255, 255, 0.10)';
const NEXT_ACCENT = 'rgba(0, 245, 255, 0.45)';
const GARBAGE_BAR = '#ff4d4d';

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
  // Con paneles reservamos un canalón a cada lado (HOLD izq, NEXT der). El cálculo
  // de la celda incluye esos canalones para que el tablero no se desborde.
  const sideUnits = opts.panels ? 4.4 : 0;
  const totalCols = columns + sideUnits * 2;
  const cell = Math.min(widthPx / totalCols, heightPx / visibleRows);
  const boardW = cell * columns;
  const boardH = cell * visibleRows;
  const totalW = cell * totalCols;
  const originX = Math.round((widthPx - totalW) / 2 + sideUnits * cell);
  const originY = Math.round((heightPx - boardH) / 2);

  ctx.clearRect(0, 0, widthPx, heightPx);
  if (opts.panels) {
    const colors = opts.colorBlind ? PIECE_COLORS_COLORBLIND : PIECE_COLORS;
    const nextCount = opts.nextCount ?? state.next.length;
    drawSidePanels(ctx, state, colors, { cell, sideUnits, originX, originY, boardW, boardH }, nextCount);
  }
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

interface PanelGeom {
  cell: number;
  sideUnits: number;
  originX: number;
  originY: number;
  boardW: number;
  boardH: number;
}

// Dibuja las tarjetas HOLD (izquierda) y NEXT (derecha) más la barra de basura
// entrante pegada al borde izquierdo del tablero, replicando el look de
// PixiGameRenderer (drawCard / drawCenteredPiece) pero en Canvas2D para que el
// visor multi-tablero comparta la misma interfaz que el juego real.
function drawSidePanels(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  colors: Record<PieceType, number>,
  g: PanelGeom,
  nextCount: number,
): void {
  const { cell, sideUnits, originX, originY, boardW, boardH } = g;
  const cardW = (sideUnits - 0.8) * cell;
  const radius = Math.max(4, cell * 0.18);

  // HOLD: tarjeta arriba a la izquierda con la pieza centrada.
  const holdH = cell * 3.6;
  const holdX = originX - 0.4 * cell - cardW;
  drawCard(ctx, holdX, originY, cardW, holdH, radius);
  drawCardLabel(ctx, 'HOLD', holdX + cell * 0.45, originY + cell * 0.6, cell);
  if (state.hold) {
    drawPreviewPiece(ctx, state.hold, colors[state.hold], holdX + cardW / 2, originY + holdH * 0.62, cell * 0.7);
  }

  // NEXT: tarjeta a la derecha; la primera pieza va resaltada en una sub-celda turquesa.
  const count = Math.max(1, Math.min(nextCount, state.next.length));
  const nextX = originX + boardW + 0.4 * cell;
  const nextH = Math.min(cell * (1.5 + count * 2.25), boardH);
  drawCard(ctx, nextX, originY, cardW, nextH, radius);
  drawCardLabel(ctx, 'NEXT', nextX + cell * 0.45, originY + cell * 0.6, cell);
  const previewSize = cell * 0.7;
  for (let i = 0; i < count; i += 1) {
    const piece = state.next[i];
    if (!piece) break;
    const cy = originY + cell * (1.95 + i * 2.25);
    if (cy + cell > originY + nextH) break;
    if (i === 0) {
      const hx = nextX + cell * 0.35;
      const hw = cardW - cell * 0.7;
      const hy = originY + cell * 1.0;
      const hh = cell * 1.9;
      roundRectPath(ctx, hx, hy, hw, hh, Math.max(4, cell * 0.28));
      ctx.fillStyle = 'rgba(0, 245, 255, 0.07)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, cell * 0.04);
      ctx.strokeStyle = NEXT_ACCENT;
      ctx.stroke();
    }
    drawPreviewPiece(ctx, piece, colors[piece], nextX + cardW / 2, cy, previewSize);
  }

  // Basura entrante: barra roja vertical pegada al borde izquierdo del tablero,
  // creciendo desde abajo (estilo TETR.IO) según las líneas pendientes.
  const pending = state.stats.pendingGarbage;
  if (pending > 0) {
    const barW = Math.max(3, cell * 0.28);
    const barX = originX - barW - cell * 0.06;
    const filled = Math.min(pending, state.stats.visibleRows);
    const barH = (filled / state.stats.visibleRows) * boardH;
    ctx.fillStyle = GARBAGE_BAR;
    ctx.fillRect(barX, originY + boardH - barH, barW, barH);
  }
}

function drawCard(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = CARD_BG;
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.2);
  ctx.strokeStyle = CARD_LINE;
  ctx.stroke();
}

// Cabecera de tarjeta: puntito turquesa + etiqueta en gris (HOLD / NEXT).
function drawCardLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, cell: number): void {
  const dot = Math.max(2, cell * 0.11);
  ctx.fillStyle = NEXT_ACCENT;
  ctx.beginPath();
  ctx.arc(x + dot, y, dot, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = LABEL_COLOR;
  ctx.font = `600 ${Math.round(cell * 0.42)}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, x + dot * 2 + cell * 0.18, y + dot * 0.1);
}

// Dibuja una pieza centrada (horizontal y vertical) alrededor de (centerX, centerY).
function drawPreviewPiece(
  ctx: CanvasRenderingContext2D,
  piece: PieceType,
  color: number,
  centerX: number,
  centerY: number,
  size: number,
): void {
  const cells = cellsFor(piece, 0);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of cells) {
    minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
    minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
  }
  const wCells = maxX - minX + 1, hCells = maxY - minY + 1;
  const ox = centerX - (wCells * size) / 2 - minX * size;
  const oy = centerY - (hCells * size) / 2 - minY * size;
  for (const c of cells) drawBlock(ctx, ox + c.x * size, oy + c.y * size, size, color);
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
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
