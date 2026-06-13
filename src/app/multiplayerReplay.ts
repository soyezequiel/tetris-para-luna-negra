import type { ReplayGarbageEvent } from '../game/replay';
import type { GameInput, GameRules } from '../game/types';

// Replay multi-tablero tipo tetr.io: el log determinista de cada jugador de una
// misma ronda. Cada cliente graba el suyo y, al terminar su partida, lo difunde
// por WebRTC; todos acumulan los del resto y arman este paquete con la ronda
// completa. `seed` es la semilla compartida de la sala (misma secuencia de piezas
// para todos); cada jugador trae igual su seed/rules para ser reconstruible solo.
export interface MultiplayerReplayPlayer {
  playerId: string;
  name: string;
  seed: number;
  rules: GameRules;
  inputs: GameInput[];
  garbage: ReplayGarbageEvent[];
}

export interface MultiplayerReplay {
  version: 1;
  game: 'stack40';
  createdAt: string;
  roomId: string;
  // Semilla compartida de la ronda. Los jugadores cuyo seed no coincide se
  // descartan al recolectar, así que todos los entries comparten esta semilla.
  seed: number;
  players: MultiplayerReplayPlayer[];
}

// Acumula los logs de cada jugador de una ronda online. Se resetea por ronda con
// la seed compartida; descarta lo que no coincide (rondas viejas, seeds cruzadas)
// y guarda un solo log por jugador (el primero que llega; los KO se reenvían).
export class OnlineReplayCollector {
  private seed: number | null = null;
  private readonly players = new Map<string, MultiplayerReplayPlayer>();

  reset(seed: number): void {
    this.seed = seed;
    this.players.clear();
  }

  // Devuelve true si se agregó (seed correcta y aún no estaba). Idempotente por
  // jugador: el primer log gana, así un reenvío posterior no lo pisa.
  add(player: MultiplayerReplayPlayer): boolean {
    if (this.seed === null || player.seed !== this.seed) return false;
    if (this.players.has(player.playerId)) return false;
    this.players.set(player.playerId, player);
    return true;
  }

  has(playerId: string): boolean {
    return this.players.has(playerId);
  }

  size(): number {
    return this.players.size;
  }

  // Arma el paquete final. Devuelve null si no hay ningún log (nada que ver).
  build(roomId: string, createdAt: string = new Date().toISOString()): MultiplayerReplay | null {
    if (this.seed === null || this.players.size === 0) return null;
    return {
      version: 1,
      game: 'stack40',
      createdAt,
      roomId,
      seed: this.seed,
      players: [...this.players.values()].map((player) => ({
        ...player,
        inputs: player.inputs.map((input) => ({ ...input })),
        garbage: player.garbage.map((event) => ({ ...event })),
      })),
    };
  }
}
