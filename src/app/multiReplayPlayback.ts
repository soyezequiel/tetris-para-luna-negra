import { GameEngine } from '../game/engine';
import type { GameInput, GameState } from '../game/types';
import type { MultiplayerReplay, MultiplayerReplayPlayer } from './multiplayerReplay';

export type MultiPlaybackSpeed = 1 | 2 | 4;

export interface MultiReplayPlayerSnapshot {
  playerId: string;
  name: string;
  state: GameState;
  // Frame en que la partida de este jugador terminó (su tablero queda congelado).
  endFrame: number;
  finished: boolean;
}

export interface MultiReplayPlaybackSnapshot {
  frame: number;
  targetFrame: number;
  paused: boolean;
  speed: MultiPlaybackSpeed;
  done: boolean;
  players: MultiReplayPlayerSnapshot[];
}

// Corre un GameEngine por jugador en paralelo, sincronizados por frame global,
// reproduciendo la ronda multijugador completa (tetr.io). Cada motor avanza con
// los inputs grabados de ese jugador y reaplica su basura entrante en el mismo
// queuedAtFrame que la partida real (ver ReplayGarbageEvent). Determinismo:
// mismo seed + mismos inputs + misma basura ⇒ mismos tableros.
class PlayerRunner {
  readonly engine: GameEngine;
  readonly player: MultiplayerReplayPlayer;
  readonly endFrame: number;
  private inputIndex = 0;
  private garbageIndex = 0;

  constructor(player: MultiplayerReplayPlayer) {
    this.player = player;
    this.engine = new GameEngine(player.seed, player.rules);
    this.endFrame = computeEndFrame(player);
  }

  reset(): PlayerRunner {
    return new PlayerRunner(this.player);
  }

  // Avanza este motor al frame global dado, si aún no terminó. Más allá de su
  // endFrame o al tocar estado terminal, se congela: el tablero queda fijo.
  advanceTo(frame: number): void {
    if (this.isFrozen(frame)) return;
    const inputs = this.inputsForFrame(frame);
    this.engine.tick(frame, inputs);
    this.queueGarbageForFrame(frame);
  }

  private isFrozen(frame: number): boolean {
    return frame > this.endFrame || this.engine.getState().status !== 'playing';
  }

  private inputsForFrame(frame: number): GameInput[] {
    const inputs: GameInput[] = [];
    const list = this.player.inputs;
    while (this.inputIndex < list.length && list[this.inputIndex].frame < frame) this.inputIndex += 1;
    while (this.inputIndex < list.length && list[this.inputIndex].frame === frame) {
      inputs.push(list[this.inputIndex]);
      this.inputIndex += 1;
    }
    return inputs;
  }

  private queueGarbageForFrame(frame: number): void {
    const list = this.player.garbage;
    while (this.garbageIndex < list.length && list[this.garbageIndex].queuedAtFrame < frame) this.garbageIndex += 1;
    while (this.garbageIndex < list.length && list[this.garbageIndex].queuedAtFrame === frame) {
      const event = list[this.garbageIndex];
      this.engine.queueGarbage(event.lines, event.holeSeed, event.frame, event.id);
      this.garbageIndex += 1;
    }
  }

  snapshot(globalFrame: number): MultiReplayPlayerSnapshot {
    const state = this.engine.getState();
    return {
      playerId: this.player.playerId,
      name: this.player.name,
      state,
      endFrame: this.endFrame,
      finished: state.status !== 'playing' || globalFrame >= this.endFrame,
    };
  }
}

// El log no guarda el frame exacto de muerte: lo derivamos del último evento
// grabado (input o basura). El motor llega a su terminal de forma determinista
// dentro de esa ventana; pasado ese frame el tablero se congela.
function computeEndFrame(player: MultiplayerReplayPlayer): number {
  let end = 0;
  for (const input of player.inputs) end = Math.max(end, input.frame);
  for (const event of player.garbage) end = Math.max(end, event.queuedAtFrame, event.frame);
  return end;
}

export class MultiReplayPlayback {
  private runners: PlayerRunner[];
  private frame = 0;
  private readonly target: number;
  private paused = false;
  private speed: MultiPlaybackSpeed = 1;

  constructor(private readonly replay: MultiplayerReplay) {
    this.runners = replay.players.map((player) => new PlayerRunner(player));
    // La línea de tiempo cubre al jugador que más duró.
    this.target = this.runners.reduce((max, runner) => Math.max(max, runner.endFrame), 0);
  }

  tick(): MultiReplayPlaybackSnapshot {
    if (!this.paused && !this.isDone()) {
      for (let i = 0; i < this.speed && !this.isDone(); i += 1) this.advanceOneFrame();
    }
    return this.snapshot();
  }

  togglePaused(): void {
    this.paused = !this.paused;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  setSpeed(speed: MultiPlaybackSpeed): void {
    this.speed = speed;
  }

  restart(): void {
    this.runners = this.runners.map((runner) => runner.reset());
    this.frame = 0;
    this.paused = false;
  }

  snapshot(): MultiReplayPlaybackSnapshot {
    return {
      frame: this.frame,
      targetFrame: this.target,
      paused: this.paused,
      speed: this.speed,
      done: this.isDone(),
      players: this.runners.map((runner) => runner.snapshot(this.frame)),
    };
  }

  getReplay(): MultiplayerReplay {
    return this.replay;
  }

  private advanceOneFrame(): void {
    this.frame += 1;
    for (const runner of this.runners) runner.advanceTo(this.frame);
  }

  private isDone(): boolean {
    return this.frame >= this.target;
  }
}
