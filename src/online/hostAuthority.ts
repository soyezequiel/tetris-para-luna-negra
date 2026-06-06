import { GameEngine } from '../game/engine';
import type { GameEngineSnapshot, GameEvent, GameInput, GameRules, GameState } from '../game/types';

export interface HostSimulatedPlayer {
  playerId: string;
  state: GameState;
  snapshot: GameEngineSnapshot;
  lastProcessedInputSequence: number;
  events: GameEvent[];
}

interface PlayerSimulation {
  engine: GameEngine;
  frame: number;
  pendingInputs: GameInput[];
  seenInputKeys: Set<string>;
  appliedAttackIds: Set<string>;
  lastProcessedInputSequence: number;
}

export class HostAuthoritySimulator {
  private readonly simulations = new Map<string, PlayerSimulation>();

  constructor(
    private readonly seed: number,
    private readonly rules: GameRules,
  ) {}

  ensurePlayers(playerIds: string[]): void {
    const expected = new Set(playerIds);
    for (const playerId of expected) {
      if (!this.simulations.has(playerId)) {
        this.simulations.set(playerId, {
          engine: new GameEngine(this.seed, this.rules),
          frame: 0,
          pendingInputs: [],
          seenInputKeys: new Set(),
          appliedAttackIds: new Set(),
          lastProcessedInputSequence: 0,
        });
      }
    }
    for (const playerId of this.simulations.keys()) {
      if (!expected.has(playerId)) this.simulations.delete(playerId);
    }
  }

  pushInputs(playerId: string, inputs: GameInput[]): void {
    const simulation = this.simulations.get(playerId);
    if (!simulation) return;
    for (const input of inputs) {
      if (!isAuthoritativeInput(input)) continue;
      const key = input.sequence ? `seq:${input.sequence}` : `${input.frame}:${input.action}`;
      if (simulation.seenInputKeys.has(key)) continue;
      simulation.seenInputKeys.add(key);
      simulation.pendingInputs.push({
        ...input,
        frame: Math.max(input.frame, simulation.frame + 1),
      });
    }
    simulation.pendingInputs.sort((a, b) => a.frame - b.frame);
  }

  queueGarbage(playerId: string, lines: number, holeSeed: number, attackId: string): void {
    const simulation = this.simulations.get(playerId);
    if (!simulation || simulation.appliedAttackIds.has(attackId)) return;
    simulation.appliedAttackIds.add(attackId);
    simulation.engine.queueGarbage(lines, holeSeed, simulation.frame, attackId);
  }

  advanceAll(targetFrame: number): HostSimulatedPlayer[] {
    const updates: HostSimulatedPlayer[] = [];
    for (const [playerId, simulation] of this.simulations.entries()) {
      const update = this.advancePlayer(playerId, simulation, targetFrame);
      if (update) updates.push(update);
    }
    return updates;
  }

  getState(playerId: string): GameState | null {
    return this.simulations.get(playerId)?.engine.getState() ?? null;
  }

  getSnapshot(playerId: string): GameEngineSnapshot | null {
    return this.simulations.get(playerId)?.engine.createSnapshot() ?? null;
  }

  getLastProcessedInputSequence(playerId: string): number {
    return this.simulations.get(playerId)?.lastProcessedInputSequence ?? 0;
  }

  private advancePlayer(
    playerId: string,
    simulation: PlayerSimulation,
    targetFrame: number,
  ): HostSimulatedPlayer | null {
    let state = simulation.engine.getState();
    const events: GameEvent[] = [];
    for (let frame = simulation.frame + 1; frame <= targetFrame && state.status === 'playing'; frame += 1) {
      const inputs = this.consumeInputs(simulation, frame);
      state = simulation.engine.tick(frame, inputs);
      events.push(...simulation.engine.drainEvents());
      simulation.frame = frame;
    }
    return {
      playerId,
      state,
      snapshot: simulation.engine.createSnapshot(),
      lastProcessedInputSequence: simulation.lastProcessedInputSequence,
      events,
    };
  }

  private consumeInputs(simulation: PlayerSimulation, frame: number): GameInput[] {
    const inputs = simulation.pendingInputs.filter((input) => input.frame <= frame);
    simulation.pendingInputs = simulation.pendingInputs.filter((input) => input.frame > frame);
    for (const input of inputs) {
      simulation.lastProcessedInputSequence = Math.max(
        simulation.lastProcessedInputSequence,
        input.sequence ?? simulation.lastProcessedInputSequence,
      );
    }
    return inputs.map((input) => ({ ...input, frame }));
  }
}

function isAuthoritativeInput(input: GameInput): boolean {
  return Number.isFinite(input.frame) && input.frame >= 0 && input.action !== 'retry';
}
