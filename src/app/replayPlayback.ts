import type { ExportedReplay } from './replayExport';
import { GameEngine } from '../game/engine';
import type { GameInput, GameState } from '../game/types';

export type PlaybackSpeed = 1 | 2 | 4;
export type PlaybackValidation = 'pending' | 'match' | 'mismatch';

export interface ReplayPlaybackSnapshot {
  state: GameState;
  frame: number;
  targetFrame: number;
  paused: boolean;
  speed: PlaybackSpeed;
  done: boolean;
  validation: PlaybackValidation;
}

export class ReplayPlayback {
  private engine: GameEngine;
  private frame = 0;
  private inputIndex = 0;
  private garbageIndex = 0;
  private paused = false;
  private speed: PlaybackSpeed = 1;
  private validation: PlaybackValidation = 'pending';

  constructor(private readonly replay: ExportedReplay) {
    this.engine = new GameEngine(replay.seed, replay.rules);
  }

  tick(): ReplayPlaybackSnapshot {
    if (!this.paused && !this.isDone()) {
      for (let i = 0; i < this.speed && !this.isDone(); i += 1) this.advanceOneFrame();
    }
    this.validateIfDone();
    return this.snapshot();
  }

  togglePaused(): void {
    this.paused = !this.paused;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  setSpeed(speed: PlaybackSpeed): void {
    this.speed = speed;
  }

  restart(): void {
    this.engine = new GameEngine(this.replay.seed, this.replay.rules);
    this.frame = 0;
    this.inputIndex = 0;
    this.garbageIndex = 0;
    this.paused = false;
    this.validation = 'pending';
  }

  snapshot(): ReplayPlaybackSnapshot {
    this.validateIfDone();
    return {
      state: this.engine.getState(),
      frame: this.frame,
      targetFrame: this.targetFrame(),
      paused: this.paused,
      speed: this.speed,
      done: this.isDone(),
      validation: this.validation,
    };
  }

  getReplay(): ExportedReplay {
    return this.replay;
  }

  private advanceOneFrame(): void {
    this.frame += 1;
    const inputs = this.inputsForFrame(this.frame);
    this.engine.tick(this.frame, inputs);
    // Igual que en vivo: la basura se encola DESPUÉS del tick, en el frame en que
    // llegó (queuedAtFrame). Su applyFrame = frame + delay la aplicará en un tick
    // posterior, reproduciendo el mismo momento que la partida real.
    this.queueGarbageForFrame(this.frame);
    this.validateIfDone();
  }

  private queueGarbageForFrame(frame: number): void {
    const garbage = this.replay.garbage;
    while (this.garbageIndex < garbage.length && garbage[this.garbageIndex].queuedAtFrame < frame) {
      this.garbageIndex += 1;
    }
    while (this.garbageIndex < garbage.length && garbage[this.garbageIndex].queuedAtFrame === frame) {
      const event = garbage[this.garbageIndex];
      this.engine.queueGarbage(event.lines, event.holeSeed, event.frame, event.id);
      this.garbageIndex += 1;
    }
  }

  private inputsForFrame(frame: number): GameInput[] {
    const inputs: GameInput[] = [];
    while (this.inputIndex < this.replay.inputs.length && this.replay.inputs[this.inputIndex].frame === frame) {
      inputs.push(this.replay.inputs[this.inputIndex]);
      this.inputIndex += 1;
    }
    while (this.inputIndex < this.replay.inputs.length && this.replay.inputs[this.inputIndex].frame < frame) {
      this.inputIndex += 1;
    }
    return inputs;
  }

  private targetFrame(): number {
    return this.replay.result.finishFrame ?? this.replay.result.gameOverFrame ?? this.replay.result.frame;
  }

  private isDone(): boolean {
    return this.frame >= this.targetFrame();
  }

  private matchesExpectedResult(state: GameState): boolean {
    return (
      state.status === this.replay.result.status
      && state.stats.lines === this.replay.result.lines
      && state.stats.pieces === this.replay.result.pieces
      && state.stats.finishFrame === this.replay.result.finishFrame
      && state.stats.gameOverFrame === this.replay.result.gameOverFrame
    );
  }

  private validateIfDone(): void {
    if (this.validation === 'pending' && this.isDone()) {
      this.validation = this.matchesExpectedResult(this.engine.getState()) ? 'match' : 'mismatch';
    }
  }
}
