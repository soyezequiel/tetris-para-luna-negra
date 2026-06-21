// Estado del dominio "Top mundial" (rankings de victorias multijugador y de
// tiempo de supervivencia). Vive en su propio módulo, fuera de main.ts, para que
// las vistas pesadas del dashboard (leaderboard, survival-tops) puedan leerlo por
// parámetro sin dependencia circular con el shell. Es un objeto mutable: main.ts
// reasigna sus campos (antes eran `let` de nivel de módulo) y las vistas los leen.
//
// Parte de PR7 (encapsular los globals de main.ts por dominio).
import type { LeaderboardEntry, SurvivalEntry } from '../online/protocol';

// Puesto del jugador en el top de supervivencia tras la última partida (se calcula
// al terminar, en game over, y se muestra en la pantalla de resultados).
export type SurvivalRunRank =
  | { status: 'loading' }
  | { status: 'ranked'; rank: number; total: number }
  | { status: 'unranked' }
  | { status: 'guest' }
  | { status: 'error' };

export interface LeaderboardState {
  // Ranking mundial de victorias multijugador (pestaña "Victorias").
  entries: LeaderboardEntry[];
  loading: boolean;
  error: string | null;
  // Top de supervivencia (modo "igual para todos"): mayor tiempo por jugador.
  survivalEntries: SurvivalEntry[];
  survivalLoading: boolean;
  survivalError: string | null;
  // Guard: cada partida de supervivencia envía su tiempo al top una sola vez.
  submittedSurvivalRun: boolean;
  // Pestaña activa del Top mundial unificado: victorias o tiempo de supervivencia.
  // Ambos rankings viven en la misma pantalla 'leaderboard'.
  tab: 'wins' | 'survival';
  survivalRunRank: SurvivalRunRank | null;
}

export const leaderboardState: LeaderboardState = {
  entries: [],
  loading: false,
  error: null,
  survivalEntries: [],
  survivalLoading: false,
  survivalError: null,
  submittedSurvivalRun: false,
  tab: 'wins',
  survivalRunRank: null,
};
