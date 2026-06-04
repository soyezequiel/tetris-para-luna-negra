import type { Cell } from './types';

export function createBoard(width: number, height: number): Cell[][] {
  return Array.from({ length: height }, () => Array<Cell>(width).fill(null));
}

export function clearCompletedLines(board: Cell[][], width: number): { board: Cell[][]; cleared: number } {
  const kept = board.filter((row) => row.some((cell) => cell === null));
  const cleared = board.length - kept.length;
  return {
    board: [...createBoard(width, cleared), ...kept],
    cleared,
  };
}
