// Estado de los peers WebRTC en batallas online (broadcaster propio + estado y
// snapshots de display de cada rival). Sub-dominio del clúster online-net. Objeto
// mutable fuera de main.ts, igual que el resto de PR7.
import type { OnlinePeerBroadcaster } from '../online/peerBroadcast';
import type { OnlineGameSnapshot } from '../online/protocol';

export interface PeerState {
  // Difusor de mis mensajes a los peers (KO/replay/progreso), o null fuera de ronda.
  broadcaster: OnlinePeerBroadcaster | null;
  // Estado textual reportado por cada rival (playerId → estado).
  states: Map<string, string>;
  // Último snapshot de tablero de cada rival, para dibujar su mini-tablero.
  displaySnapshots: Map<string, OnlineGameSnapshot>;
}

export const peerState: PeerState = {
  broadcaster: null,
  states: new Map<string, string>(),
  displaySnapshots: new Map<string, OnlineGameSnapshot>(),
};
