import type { RoomServer } from './room.js';
import type { LobbyServer } from './lobby.js';
import type { LeaderboardServer } from './leaderboard.js';

/**
 * Bindings del Worker. Los nombres `Main`/`Lobby` mapean (kebab-case) a los party
 * names que usa el cliente: `Main`→`main`, `Lobby`→`lobby` (ver routePartykitRequest
 * en party/index.ts). PARTY_ABANDON_GRACE_MS override la gracia de abandono.
 * PARTY_BRIDGE_TOKEN protege el bridge server-to-server usado por apuestas.
 */
export interface Env {
  Main: DurableObjectNamespace<RoomServer>;
  Lobby: DurableObjectNamespace<LobbyServer>;
  Leaderboard: DurableObjectNamespace<LeaderboardServer>;
  PARTY_ABANDON_GRACE_MS?: string;
  PARTY_BRIDGE_TOKEN?: string;
}
