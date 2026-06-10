// ───────────────────────────── TRUCO AUTOPLAY ─────────────────────────────
// Bot de colocación que juega solo para que una partida (sobre todo online)
// dure lo más posible. Es 100% autocontenido: para quitar el truco basta con
// borrar este archivo y las pocas líneas marcadas con "TRUCO AUTOPLAY" en
// src/main.ts. No toca el motor del juego: solo mira el GameState y devuelve
// la siguiente InputAction, igual que si las teclas las pulsara una persona.

import { cellsFor } from '../game/pieces';
import type { Cell, GameState, InputAction, PieceType, Rotation } from '../game/types';

const ROTATIONS: Rotation[] = [0, 1, 2, 3];

// Pesos heurísticos estilo "El-Tetris": sobreviven muchísimas piezas.
const WEIGHT_AGGREGATE_HEIGHT = -0.510066;
const WEIGHT_COMPLETE_LINES = 0.760666;
const WEIGHT_HOLES = -0.35663;
const WEIGHT_BUMPINESS = -0.184483;

interface Placement {
  rotation: Rotation;
  x: number;
}

// Réplica de la colisión del motor (engine.collides): fuera del tablero por los
// lados o por abajo choca; por arriba (y < 0) se ignora.
function collides(board: Cell[][], type: PieceType, rotation: Rotation, x: number, y: number): boolean {
  const width = board[0]?.length ?? 0;
  const height = board.length;
  for (const cell of cellsFor(type, rotation)) {
    const cx = x + cell.x;
    const cy = y + cell.y;
    if (cx < 0 || cx >= width || cy >= height) return true;
    if (cy < 0) continue;
    if (board[cy][cx] !== null) return true;
  }
  return false;
}

// Altura de caída final (hard drop) de la pieza en una columna/rotación dadas.
function restingY(board: Cell[][], type: PieceType, rotation: Rotation, x: number): number | null {
  const height = board.length;
  let y = -4;
  while (y <= height && collides(board, type, rotation, x, y)) y += 1;
  if (y > height) return null; // columna imposible para esta rotación
  while (!collides(board, type, rotation, x, y + 1)) y += 1;
  return y;
}

function scoreBoard(grid: Cell[][]): number {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;
  const columnHeights = new Array<number>(width).fill(0);
  let holes = 0;
  for (let col = 0; col < width; col += 1) {
    let seenBlock = false;
    for (let row = 0; row < height; row += 1) {
      if (grid[row][col] !== null) {
        if (!seenBlock) columnHeights[col] = height - row;
        seenBlock = true;
      } else if (seenBlock) {
        holes += 1;
      }
    }
  }
  let aggregateHeight = 0;
  let bumpiness = 0;
  for (let col = 0; col < width; col += 1) {
    aggregateHeight += columnHeights[col];
    if (col < width - 1) bumpiness += Math.abs(columnHeights[col] - columnHeights[col + 1]);
  }
  let completeLines = 0;
  for (let row = 0; row < height; row += 1) {
    if (grid[row].every((cell) => cell !== null)) completeLines += 1;
  }
  return (
    WEIGHT_AGGREGATE_HEIGHT * aggregateHeight +
    WEIGHT_COMPLETE_LINES * completeLines +
    WEIGHT_HOLES * holes +
    WEIGHT_BUMPINESS * bumpiness
  );
}

function bestPlacement(board: Cell[][], type: PieceType): Placement | null {
  const width = board[0]?.length ?? 0;
  let best: Placement | null = null;
  let bestScore = -Infinity;
  for (const rotation of ROTATIONS) {
    for (let x = -3; x <= width; x += 1) {
      const y = restingY(board, type, rotation, x);
      if (y === null) continue;
      let lockedAboveCeiling = false;
      const grid = board.map((row) => row.slice());
      for (const cell of cellsFor(type, rotation)) {
        const cy = y + cell.y;
        const cx = x + cell.x;
        if (cy < 0) {
          lockedAboveCeiling = true;
          continue;
        }
        grid[cy][cx] = type;
      }
      // Si la pieza queda apoyada con celdas por encima del techo es un top-out:
      // lo evitamos salvo que no haya otra opción.
      const score = lockedAboveCeiling ? -1e6 + scoreBoard(grid) : scoreBoard(grid);
      if (score > bestScore) {
        bestScore = score;
        best = { rotation, x };
      }
    }
  }
  return best;
}

// Devuelve la siguiente acción para acercar la pieza activa a su mejor destino.
// Una acción por frame: rota primero, luego se alinea y por último deja caer.
// Releer el estado real cada frame absorbe los desplazamientos de los kicks.
export function nextAutoPlayInput(state: GameState): InputAction | null {
  if (state.status !== 'playing' || !state.active) return null;
  const active = state.active;
  const target = bestPlacement(state.board, active.type);
  if (!target) return 'hardDrop';
  if (active.rotation !== target.rotation) {
    const diff = (target.rotation - active.rotation + 4) % 4;
    return diff === 3 ? 'rotateCCW' : 'rotateCW';
  }
  if (active.x < target.x) return 'moveRight';
  if (active.x > target.x) return 'moveLeft';
  return 'hardDrop';
}
