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

export function addGarbageLines(board: Cell[][], width: number, lines: number, holeColumn: number): { board: Cell[][]; toppedOut: boolean } {
  const count = Math.max(0, Math.floor(lines));
  if (count === 0) return { board: board.map((row) => [...row]), toppedOut: false };
  const height = board.length;
  const removed = board.slice(0, Math.min(count, height));
  const toppedOut = removed.some((row) => row.some((cell) => cell !== null)) || count > height;
  const kept = board.slice(Math.min(count, height)).map((row) => [...row]);
  const hole = Math.max(0, Math.min(width - 1, Math.floor(holeColumn)));
  const garbage = Array.from({ length: Math.min(count, height) }, () => (
    Array.from({ length: width }, (_, index): Cell => index === hole ? null : 'Z')
  ));
  return {
    board: [...kept, ...garbage].slice(-height),
    toppedOut,
  };
}
