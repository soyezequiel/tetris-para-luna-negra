// Estado del pipeline de mensajería de input/ataques online (secuenciado de inputs
// propios + dedup de ataques recibidos). Sub-dominio del clúster online-net. Objeto
// mutable fuera de main.ts, igual que el resto de PR7.
import type { GameInput } from '../game/types';

// Un input propio con número de secuencia, para mandarlo ordenado por el outbox.
export type SequencedOnlineInput = GameInput & { sequence: number };

export interface AttackState {
  // Secuencia creciente de ataques propios.
  sequence: number;
  // Ids de ataques ya aplicados, para no aplicar el mismo dos veces.
  appliedIds: Set<string>;
  // Cola de inputs propios pendientes de difundir, en orden de secuencia.
  inputOutbox: SequencedOnlineInput[];
}

export const attackState: AttackState = {
  sequence: 0,
  appliedIds: new Set<string>(),
  inputOutbox: [],
};
