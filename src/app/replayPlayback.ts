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

export interface ReplayPlaybackOptions {
  // Frame desde el cual mostrar la reproducción. La simulación SIEMPRE corre desde
  // el frame 0 (es determinista a partir de la semilla), pero los frames previos a
  // startFrame se avanzan de golpe sin dibujarse. Sirve para ver "los últimos N
  // segundos" de una partida sin reproducirla entera.
  startFrame?: number;
}

export class ReplayPlayback {
  private engine: GameEngine;
  private frame = 0;
  private inputIndex = 0;
  private garbageIndex = 0;
  private paused = false;
  private speed: PlaybackSpeed = 1;
  private validation: PlaybackValidation = 'pending';
  private readonly startFrame: number;

  constructor(private readonly replay: ExportedReplay, options: ReplayPlaybackOptions = {}) {
    this.engine = new GameEngine(replay.seed, replay.rules);
    this.startFrame = Math.max(0, Math.min(options.startFrame ?? 0, this.targetFrame()));
    this.seekToStartFrame();
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
    this.seekToStartFrame();
  }

  // Avanza la simulación (sin dibujar) hasta startFrame para arrancar la
  // reproducción ahí. Con startFrame = 0 no hace nada (reproducción completa).
  private seekToStartFrame(): void {
    while (this.frame < this.startFrame) this.advanceOneFrame();
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
    // Encolamos todo lo vencido (queuedAtFrame <= frame), no solo lo exacto: nada se
    // pierde si quedó por debajo del primer frame. applyFrame es absoluto.
    while (this.garbageIndex < garbage.length && garbage[this.garbageIndex].queuedAtFrame <= frame) {
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
