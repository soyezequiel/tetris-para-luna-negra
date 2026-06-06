import { createShuffledBag } from './bag';
import { calculateAttack, garbageHoleColumn, nextBackToBack, nextCombo, resolveAttack } from './attack';
import { addGarbageLines, clearCompletedLines, createBoard } from './board';
import { cellsFor, kicksFor, nextRotation } from './pieces';
import { SeededRng } from './rng';
import { DEFAULT_RULES } from './rules';
import type { ActivePiece, Cell, GameEngineSnapshot, GameEvent, GameInput, GameRules, GameState, InputAction, PendingGarbage, PieceType, SpinType, Vec2 } from './types';

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
  private sentGarbage = 0;
  private receivedGarbage = 0;
  private pendingGarbage: PendingGarbage[] = [];
  private combo = -1;
  private b2b = 0;
  private lastGarbageHoleColumn: number | null = null;
  private spinCandidate = false;
  private events: GameEvent[] = [];
  private fallAccumulator = 0;
  private lockFrames = 0;
  private lockResets = 0;

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
      ghost: this.rules.showGhost && this.active ? this.getGhost() : null,
      hold: this.rules.allowHold ? this.hold : null,
      canHold: this.rules.allowHold && this.canHold,
      next: this.next.slice(0, this.rules.nextPreview),
      stats: {
        boardWidth: this.rules.boardWidth,
        visibleRows: this.rules.visibleRows,
        hiddenRows: this.rules.hiddenRows,
        frame: this.frame,
        pieces: this.pieces,
        lines: this.lines,
        sentGarbage: this.sentGarbage,
        receivedGarbage: this.receivedGarbage,
        pendingGarbage: this.pendingGarbage.reduce((total, garbage) => total + garbage.lines, 0),
        combo: this.combo,
        b2b: this.b2b,
        targetLines: this.rules.targetLines,
        startFrame: this.startFrame,
        finishFrame: this.finishFrame,
        gameOverFrame: this.gameOverFrame,
      },
      status: this.status,
      seed: this.seed,
    };
  }

  createSnapshot(): GameEngineSnapshot {
    return {
      seed: this.seed,
      rngState: this.rng.getState(),
      board: this.board.map((row) => [...row]),
      active: this.active ? { ...this.active } : null,
      hold: this.hold,
      canHold: this.canHold,
      next: [...this.next],
      status: this.status,
      frame: this.frame,
      pieces: this.pieces,
      lines: this.lines,
      startFrame: this.startFrame,
      finishFrame: this.finishFrame,
      gameOverFrame: this.gameOverFrame,
      sentGarbage: this.sentGarbage,
      receivedGarbage: this.receivedGarbage,
      pendingGarbage: this.pendingGarbage.map((garbage) => ({ ...garbage })),
      combo: this.combo,
      b2b: this.b2b,
      lastGarbageHoleColumn: this.lastGarbageHoleColumn,
      spinCandidate: this.spinCandidate,
      fallAccumulator: this.fallAccumulator,
      lockFrames: this.lockFrames,
      lockResets: this.lockResets,
    };
  }

  restoreSnapshot(snapshot: GameEngineSnapshot): void {
    if ((snapshot.seed >>> 0) !== this.seed) throw new Error('Cannot restore a snapshot from a different seed.');
    this.rng.setState(snapshot.rngState);
    this.board = snapshot.board.map((row) => [...row]);
    this.active = snapshot.active ? { ...snapshot.active } : null;
    this.hold = snapshot.hold;
    this.canHold = snapshot.canHold;
    this.next = [...snapshot.next];
    this.status = snapshot.status;
    this.frame = snapshot.frame;
    this.pieces = snapshot.pieces;
    this.lines = snapshot.lines;
    this.startFrame = snapshot.startFrame;
    this.finishFrame = snapshot.finishFrame;
    this.gameOverFrame = snapshot.gameOverFrame;
    this.sentGarbage = snapshot.sentGarbage;
    this.receivedGarbage = snapshot.receivedGarbage;
    this.pendingGarbage = snapshot.pendingGarbage.map((garbage) => ({ ...garbage }));
    this.combo = Number.isFinite(snapshot.combo) ? snapshot.combo : -1;
    this.b2b = Number.isFinite(snapshot.b2b) ? snapshot.b2b : 0;
    this.lastGarbageHoleColumn = Number.isInteger(snapshot.lastGarbageHoleColumn)
      ? snapshot.lastGarbageHoleColumn
      : null;
    this.spinCandidate = snapshot.spinCandidate === true;
    this.events = [];
    this.fallAccumulator = snapshot.fallAccumulator;
    this.lockFrames = snapshot.lockFrames;
    this.lockResets = snapshot.lockResets;
  }

  tick(frame: number, inputs: GameInput[] = []): GameState {
    if (frame < this.frame) return this.getState();
    this.frame = frame;
    for (const input of inputs) this.applyInput(input.action);
    if (this.status === 'playing') this.applyPendingGarbage(frame);
    if (this.status === 'playing') this.applyGravity();
    return this.getState();
  }

  queueGarbage(lines: number, holeSeed: number, frame = this.frame, id = `${frame}-${holeSeed}-${lines}`): void {
    const normalizedLines = Math.max(0, Math.floor(lines));
    if (normalizedLines <= 0 || this.status !== 'playing') return;
    const pendingTotal = this.pendingGarbage.reduce((total, garbage) => total + garbage.lines, 0);
    const cap = Math.max(0, Math.floor(this.rules.garbageCap));
    const cappedLines = cap > 0 ? Math.max(0, Math.min(normalizedLines, cap - pendingTotal)) : normalizedLines;
    if (cappedLines <= 0) return;
    const pending: PendingGarbage = {
      id,
      lines: cappedLines,
      holeColumn: this.selectGarbageHole(holeSeed, frame, id),
      receivedFrame: frame,
      applyFrame: frame + this.garbageApplyDelayFrames(),
    };
    this.pendingGarbage.push(pending);
    this.receivedGarbage += cappedLines;
    this.events.push({ type: 'incomingGarbage', frame, lines: cappedLines });
  }

  drainEvents(): GameEvent[] {
    const drained = this.events;
    this.events = [];
    return drained;
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
    this.sentGarbage = 0;
    this.receivedGarbage = 0;
    this.pendingGarbage = [];
    this.combo = -1;
    this.b2b = 0;
    this.lastGarbageHoleColumn = null;
    this.spinCandidate = false;
    this.events = [];
    this.fallAccumulator = 0;
    this.lockFrames = 0;
    this.lockResets = 0;
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
    this.active = { type, rotation: 0, x: this.spawnX(), y: 0 };
    this.canHold = true;
    this.spinCandidate = false;
    this.lockFrames = 0;
    this.lockResets = 0;
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
    if (dx !== 0 || dy !== 0) this.spinCandidate = false;
    if (dx !== 0 || dy < 0) this.resetLockDelay();
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
        this.spinCandidate = this.active.type === 'T';
        this.resetLockDelay();
        return;
      }
    }
  }

  private softDrop(): void {
    let remaining = this.rules.softDropCellsPerFrame;
    while (remaining >= 1 && this.tryMove(0, 1)) remaining -= 1;
  }

  private hardDrop(): void {
    if (!this.rules.allowHardDrop) return;
    if (!this.active) return;
    this.active = this.getGhost();
    this.lockPiece();
  }

  private holdPiece(): void {
    if (!this.rules.allowHold) return;
    if (!this.active || !this.canHold) return;
    const current = this.active.type;
    if (this.hold) {
      const next = this.hold;
      this.hold = current;
      this.active = { type: next, rotation: 0, x: this.spawnX(), y: 0 };
      this.spinCandidate = false;
      if (this.collides(this.active)) {
        this.status = 'gameover';
        this.gameOverFrame = this.frame;
      }
    } else {
      this.hold = current;
      this.spawn();
    }
    this.canHold = this.rules.infiniteHold;
    this.spinCandidate = false;
    this.lockFrames = 0;
    this.lockResets = 0;
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
      this.lockResets = 0;
    }
  }

  private resetLockDelay(): void {
    if (!this.active || !this.isGrounded()) {
      this.lockFrames = 0;
      return;
    }
    if (this.rules.infiniteMovement || this.lockResets < this.rules.lockResetLimit) {
      this.lockFrames = 0;
      this.lockResets += 1;
    }
  }

  private spawnX(): number {
    return Math.max(0, Math.floor(this.rules.boardWidth / 2) - 2);
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
    const lockedPiece = this.active;
    for (const cell of this.occupied(this.active)) {
      if (cell.y < 0) {
        this.status = 'gameover';
        this.gameOverFrame = this.frame;
        return;
      }
      this.board[cell.y][cell.x] = cell.type;
    }
    this.pieces += 1;
    const spin = this.detectSpin(lockedPiece);
    this.clearLines(lockedPiece.type, spin);
    if (this.rules.targetLines !== null && this.lines >= this.rules.targetLines) {
      this.status = 'finished';
      this.finishFrame = this.frame;
      this.active = null;
      return;
    }
    this.spawn();
  }

  private clearLines(piece: PieceType, spin: SpinType): void {
    const result = clearCompletedLines(this.board, this.rules.boardWidth);
    const cleared = result.cleared;
    if (cleared === 0) {
      this.combo = nextCombo(this.combo, cleared);
      return;
    }
    this.board = result.board;
    this.lines += cleared;
    this.combo = nextCombo(this.combo, cleared);
    this.b2b = nextBackToBack(this.b2b, cleared, spin);
    const perfectClear = this.isPerfectClear();
    const attack = calculateAttack({
      table: this.rules.attackTable,
      cleared,
      combo: this.combo,
      b2b: this.b2b,
      spin,
      perfectClear,
    });
    const resolved = resolveAttack(attack.attackLines, this.pendingGarbage);
    this.pendingGarbage = resolved.remainingIncoming;
    this.sentGarbage += resolved.outgoingAfterCancel;
    this.events.push({
      type: 'lineClear',
      frame: this.frame,
      cleared,
      difficult: attack.difficult,
      spin,
      piece,
      perfectClear,
      combo: this.combo,
      b2b: this.b2b,
      attackLines: attack.attackLines,
      outgoingLines: resolved.outgoingAfterCancel,
    });
  }

  private isPerfectClear(): boolean {
    return this.board.every((row) => row.every((cell) => cell === null));
  }

  private detectSpin(piece: ActivePiece): SpinType {
    if (!this.spinCandidate || piece.type !== 'T') return 'none';
    const center = { x: piece.x + 1, y: piece.y + 1 };
    const corners = [
      { x: center.x - 1, y: center.y - 1 },
      { x: center.x + 1, y: center.y - 1 },
      { x: center.x - 1, y: center.y + 1 },
      { x: center.x + 1, y: center.y + 1 },
    ];
    const blockedCorners = corners.filter((corner) => this.isSpinCornerBlocked(corner.x, corner.y)).length;
    if (blockedCorners < 3) return 'none';
    const frontCorners = this.tSpinFrontCorners(piece.rotation, center.x, center.y);
    const blockedFrontCorners = frontCorners.filter((corner) => this.isSpinCornerBlocked(corner.x, corner.y)).length;
    return blockedFrontCorners >= 2 ? 'full' : 'mini';
  }

  private tSpinFrontCorners(rotation: ActivePiece['rotation'], centerX: number, centerY: number): Vec2[] {
    if (rotation === 1) return [{ x: centerX + 1, y: centerY - 1 }, { x: centerX + 1, y: centerY + 1 }];
    if (rotation === 2) return [{ x: centerX - 1, y: centerY + 1 }, { x: centerX + 1, y: centerY + 1 }];
    if (rotation === 3) return [{ x: centerX - 1, y: centerY - 1 }, { x: centerX - 1, y: centerY + 1 }];
    return [{ x: centerX - 1, y: centerY - 1 }, { x: centerX + 1, y: centerY - 1 }];
  }

  private isSpinCornerBlocked(x: number, y: number): boolean {
    if (x < 0 || x >= this.rules.boardWidth || y < 0 || y >= this.board.length) return true;
    return this.board[y][x] !== null;
  }

  private garbageApplyDelayFrames(): number {
    const legacyDelayFrames = Math.max(0, Math.floor(this.rules.garbageDelayFrames));
    const travelFrames = Math.max(0, Math.floor(this.rules.garbageTravelFrames));
    const activationFrames = Math.max(0, Math.floor(this.rules.garbageActivationFrames));
    const usesModernDelay = travelFrames !== DEFAULT_RULES.garbageTravelFrames
      || activationFrames !== DEFAULT_RULES.garbageActivationFrames
      || legacyDelayFrames === DEFAULT_RULES.garbageDelayFrames;
    return usesModernDelay ? travelFrames + activationFrames : legacyDelayFrames;
  }

  private selectGarbageHole(holeSeed: number, frame: number, id: string): number {
    const generatedHole = garbageHoleColumn(holeSeed, this.rules.boardWidth);
    const previousHole = this.lastGarbageHoleColumn;
    const messiness = Math.min(100, Math.max(0, Math.floor(this.rules.garbageMessinessPercent)));
    const shouldChange = previousHole === null
      || (this.rules.changeOnAttack && (
        messiness >= 100 || deterministicPercent(`${id}:${holeSeed}:${frame}`) < messiness
      ));
    const selectedHole = shouldChange ? generatedHole : previousHole;
    this.lastGarbageHoleColumn = selectedHole;
    return selectedHole;
  }

  private applyPendingGarbage(frame: number): void {
    const due = this.pendingGarbage.filter((garbage) => garbage.applyFrame <= frame);
    if (due.length === 0) return;
    const future = this.pendingGarbage.filter((garbage) => garbage.applyFrame > frame);
    let garbageToApply = due;
    const deferred: PendingGarbage[] = [];
    if (this.rules.continuousGarbage) {
      const [firstDue, ...remainingDue] = due;
      garbageToApply = [{ ...firstDue, lines: 1 }];
      if (firstDue.lines > 1) deferred.push({ ...firstDue, lines: firstDue.lines - 1, applyFrame: frame + 1 });
      deferred.push(...remainingDue.map((garbage) => ({ ...garbage, applyFrame: Math.max(garbage.applyFrame, frame + 1) })));
    }
    this.pendingGarbage = [...future, ...deferred];
    let appliedLines = 0;
    for (const garbage of garbageToApply) {
      const result = addGarbageLines(this.board, this.rules.boardWidth, garbage.lines, garbage.holeColumn);
      this.board = result.board;
      appliedLines += garbage.lines;
      if (result.toppedOut) {
        this.status = 'gameover';
        this.gameOverFrame = frame;
        this.active = null;
        break;
      }
    }
    if (this.status === 'playing' && this.active && this.collides(this.active)) {
      this.status = 'gameover';
      this.gameOverFrame = frame;
      this.active = null;
    }
    this.events.push({ type: 'appliedGarbage', frame, lines: appliedLines });
  }
}

function deterministicPercent(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}
