// Estado del dominio "espectador" (mirar el tablero de un rival en una sala online:
// sigo al líder de la ronda). El motor de espectador reconstruye su GameState a
// partir del engine snapshot que el rival difunde por WebRTC, y un conductor de
// juice aparte deduce partículas/sonido por diff entre snapshots. Objeto mutable
// fuera de main.ts, igual que el resto de PR7.
import type { GameEngine } from '../game/engine';
import type { JuiceConductor } from '../effects/JuiceConductor';

// Snapshot previo del tablero enfocado, para deducir eventos por diff (líneas →
// line-clear, pending → garbage entrante, piezas → lock, pieza activa → mover/girar).
export interface SpectatorJuicePrev {
  lines: number;
  pieces: number;
  pending: number;
  sent: number;
  active: { type: string; x: number; rotation: number } | null;
}

export interface SpectatorState {
  // Id del rival que estoy mirando (null = no estoy espectando).
  focusId: string | null;
  // Motor que reconstruye el GameState del rival enfocado a partir de sus snapshots.
  engine: GameEngine | null;
  engineSeed: number | null;
  // Conductor de juice del tablero enfocado (mismo JuiceFX del canvas + mismo audio).
  juice: JuiceConductor | null;
  juiceId: string | null;
  juicePrev: SpectatorJuicePrev | null;
}

export const spectatorState: SpectatorState = {
  focusId: null,
  engine: null,
  engineSeed: null,
  juice: null,
  juiceId: null,
  juicePrev: null,
};
