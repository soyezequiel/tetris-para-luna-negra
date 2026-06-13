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

  // Avanza este motor al frame global dado, si aún no terminó. Se congela al tocar
  // estado terminal (KO/clear). El sobreviviente nunca llega a terminal por sus
  // inputs (ganó por aguante), así que también se congela pasado su último evento
  // —pero solo cuando ya no le queda garbage pendiente, para no cortar el top-out
  // antes de que la basura encolada caiga (applyFrame = frame + delay).
  advanceTo(frame: number): void {
    if (this.isFrozen(frame)) return;
    const inputs = this.inputsForFrame(frame);
    this.engine.tick(frame, inputs);
    this.queueGarbageForFrame(frame);
  }

  private isFrozen(frame: number): boolean {
    const state = this.engine.getState();
    if (state.status !== 'playing') return true;
    return frame > this.endFrame && state.stats.pendingGarbage === 0;
  }

  isFrozenAt(frame: number): boolean {
    return this.isFrozen(frame);
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
    // Encolamos todo lo vencido (queuedAtFrame <= frame), no solo lo exacto: si un
    // evento quedó por debajo del primer frame reproducido (p. ej. queuedAtFrame 0)
    // igual entra. applyFrame = anchor.frame + delay es absoluto, así que encolarlo
    // un toque tarde no cambia cuándo cae.
    while (this.garbageIndex < list.length && list[this.garbageIndex].queuedAtFrame <= frame) {
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
      finished: this.isFrozenAt(globalFrame),
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
    // El fin real no es el último input: la basura entrante se aplica unos frames
    // después (applyFrame = frame + delay) y el top-out resultante cae todavía más
    // tarde. Simulamos hasta que TODOS los tableros se asientan (terminal o
    // sobreviviente sin garbage pendiente) y usamos ese frame como objetivo; luego
    // reconstruimos los motores para reproducir desde cero.
    this.target = this.computeTarget();
    this.runners = replay.players.map((player) => new PlayerRunner(player));
  }

  private computeTarget(): number {
    const lastEvent = this.runners.reduce((max, runner) => Math.max(max, runner.endFrame), 0);
    // Tope duro por si algún tablero nunca se asienta (no debería): evita un bucle
    // infinito. 10s de cola alcanza de sobra para que caiga el garbage y el top-out.
    const hardCap = lastEvent + 600;
    let frame = 0;
    while (frame < hardCap && !this.runners.every((runner) => runner.isFrozenAt(frame))) {
      frame += 1;
      for (const runner of this.runners) runner.advanceTo(frame);
    }
    return frame;
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
