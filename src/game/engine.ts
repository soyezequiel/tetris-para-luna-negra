import { createShuffledBag } from './bag';
import { clearCompletedLines, createBoard } from './board';
import { cellsFor, kicksFor, nextRotation } from './pieces';
import { SeededRng } from './rng';
import { DEFAULT_RULES } from './rules';
import type { ActivePiece, Cell, GameInput, GameRules, GameState, InputAction, PieceType } from './types';

export class GameEngine {
  private readonly rules: GameRules;
  private rng: SeededRng;
  private readonly seed: number;
  private board: Cell[][];
  private active: ActivePiece | null = null;
  private hold: PieceType | null = null;
  private canHold = true;
  private next: PieceType[] = [];
  private status: GameState['status'] = 'ready';
  private frame = 0;
  private pieces = 0;
  private lines = 0;
  private startFrame = 0;
  private finishFrame: number | null = null;
  private gameOverFrame: number | null = null;
  private fallAccumulator = 0;
  private lockFrames = 0;

  constructor(seed = Date.now(), rules: GameRules = DEFAULT_RULES) {
    this.seed = seed >>> 0;
    this.rules = rules;
    this.rng = new SeededRng(this.seed);
    this.board = this.createBoard();
    this.fillNext();
    this.spawn();
    this.status = 'playing';
  }

  getState(): GameState {
    return {
      board: this.board.map((row) => [...row]),
      active: this.active ? { ...this.active } : null,
      ghost: this.active ? this.getGhost() : null,
      hold: this.hold,
      canHold: this.canHold,
      next: this.next.slice(0, this.rules.nextPreview),
      stats: {
        frame: this.frame,
        pieces: this.pieces,
        lines: this.lines,
        startFrame: this.startFrame,
        finishFrame: this.finishFrame,
        gameOverFrame: this.gameOverFrame,
      },
      status: this.status,
      seed: this.seed,
    };
  }

  tick(frame: number, inputs: GameInput[] = []): GameState {
    if (frame < this.frame) return this.getState();
    this.frame = frame;
    for (const input of inputs) this.applyInput(input.action);
    if (this.status === 'playing') this.applyGravity();
    return this.getState();
  }

  applyInput(action: InputAction): void {
    if (action === 'retry') return this.retry();
    if (this.status !== 'playing' || !this.active) return;
    switch (action) {
      case 'moveLeft':
        this.tryMove(-1, 0);
        break;
      case 'moveRight':
        this.tryMove(1, 0);
        break;
      case 'softDrop':
        this.softDrop();
        break;
      case 'hardDrop':
        this.hardDrop();
        break;
      case 'rotateCW':
        this.rotate(1);
        break;
      case 'rotateCCW':
        this.rotate(-1);
        break;
      case 'hold':
        this.holdPiece();
        break;
    }
  }

  private retry(): void {
    this.board = this.createBoard();
    this.active = null;
    this.hold = null;
    this.canHold = true;
    this.next.length = 0;
    this.status = 'playing';
    this.frame = 0;
    this.pieces = 0;
    this.lines = 0;
    this.startFrame = 0;
    this.finishFrame = null;
    this.gameOverFrame = null;
    this.fallAccumulator = 0;
    this.lockFrames = 0;
    this.rng = new SeededRng(this.seed);
    this.fillNext();
    this.spawn();
  }

  private createBoard(): Cell[][] {
    return createBoard(this.rules.boardWidth, this.rules.visibleRows + this.rules.hiddenRows);
  }

  private fillNext(): void {
    while (this.next.length < this.rules.nextPreview + 7) {
      this.next.push(...createShuffledBag(this.rng));
    }
  }

  private spawn(type = this.next.shift()): void {
    if (!type) throw new Error('Cannot spawn without a piece.');
    this.fillNext();
    this.active = { type, rotation: 0, x: 3, y: 0 };
    this.canHold = true;
    this.lockFrames = 0;
    this.fallAccumulator = 0;
    if (this.collides(this.active)) {
      this.status = 'gameover';
      this.gameOverFrame = this.frame;
    }
  }

  private occupied(piece: ActivePiece): { x: number; y: number; type: PieceType }[] {
    return cellsFor(piece.type, piece.rotation).map((cell) => ({
      x: piece.x + cell.x,
      y: piece.y + cell.y,
      type: piece.type,
    }));
  }

  private collides(piece: ActivePiece): boolean {
    return this.occupied(piece).some(({ x, y }) => {
      if (x < 0 || x >= this.rules.boardWidth || y >= this.board.length) return true;
      if (y < 0) return false;
      return this.board[y][x] !== null;
    });
  }

  private tryMove(dx: number, dy: number): boolean {
    if (!this.active) return false;
    const moved = { ...this.active, x: this.active.x + dx, y: this.active.y + dy };
    if (this.collides(moved)) return false;
    this.active = moved;
    if (dx !== 0 || dy < 0) this.lockFrames = 0;
    return true;
  }

  private rotate(dir: 1 | -1): void {
    if (!this.active) return;
    const to = nextRotation(this.active.rotation, dir);
    for (const kick of kicksFor(this.active.type, this.active.rotation, to)) {
      const rotated = {
        ...this.active,
        rotation: to,
        x: this.active.x + kick.x,
        y: this.active.y - kick.y,
      };
      if (!this.collides(rotated)) {
        this.active = rotated;
        this.lockFrames = 0;
        return;
      }
    }
  }

  private softDrop(): void {
    let remaining = this.rules.softDropCellsPerFrame;
    while (remaining >= 1 && this.tryMove(0, 1)) remaining -= 1;
  }

  private hardDrop(): void {
    if (!this.active) return;
    this.active = this.getGhost();
    this.lockPiece();
  }

  private holdPiece(): void {
    if (!this.active || !this.canHold) return;
    const current = this.active.type;
    if (this.hold) {
      const next = this.hold;
      this.hold = current;
      this.active = { type: next, rotation: 0, x: 3, y: 0 };
      if (this.collides(this.active)) {
        this.status = 'gameover';
        this.gameOverFrame = this.frame;
      }
    } else {
      this.hold = current;
      this.spawn();
    }
    this.canHold = false;
    this.lockFrames = 0;
  }

  private applyGravity(): void {
    if (!this.active) return;
    this.fallAccumulator += this.rules.gravityCellsPerFrame;
    while (this.fallAccumulator >= 1) {
      this.fallAccumulator -= 1;
      if (!this.tryMove(0, 1)) break;
    }
    if (this.isGrounded()) {
      this.lockFrames += 1;
      if (this.lockFrames >= this.rules.lockDelayFrames) this.lockPiece();
    } else {
      this.lockFrames = 0;
    }
  }

  private isGrounded(): boolean {
    return this.active ? this.collides({ ...this.active, y: this.active.y + 1 }) : false;
  }

  private getGhost(): ActivePiece {
    if (!this.active) throw new Error('Cannot calculate ghost without an active piece.');
    let ghost = { ...this.active };
    while (!this.collides({ ...ghost, y: ghost.y + 1 })) ghost = { ...ghost, y: ghost.y + 1 };
    return ghost;
  }

  private lockPiece(): void {
    if (!this.active) return;
    for (const cell of this.occupied(this.active)) {
      if (cell.y < 0) {
        this.status = 'gameover';
        this.gameOverFrame = this.frame;
        return;
      }
      this.board[cell.y][cell.x] = cell.type;
    }
    this.pieces += 1;
    this.clearLines();
    if (this.lines >= this.rules.targetLines) {
      this.status = 'finished';
      this.finishFrame = this.frame;
      this.active = null;
      return;
    }
    this.spawn();
  }

  private clearLines(): void {
    const result = clearCompletedLines(this.board, this.rules.boardWidth);
    const cleared = result.cleared;
    if (cleared === 0) return;
    this.board = result.board;
    this.lines += cleared;
  }
}
