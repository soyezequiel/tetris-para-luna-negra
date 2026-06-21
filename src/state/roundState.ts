// Estado del ciclo de RONDA online (lifecycle de cada partida dentro de una sala:
// arranque, reporte de resultado, espectador, reopen). Sub-dominio del clúster
// online-net. Objeto mutable fuera de main.ts, igual que el resto de PR7.

export interface RoundState {
  // Ya reporté mi resultado de esta ronda (evita doble envío).
  resultSubmitted: boolean;
  runStarted: boolean;
  // La ronda arrancó pero yo no estaba listo (o cerré la pestaña): entro de espectador,
  // sin tablero propio ni reportes. Miro a los rivales hasta que la sala termine. Se
  // limpia entre rondas (resetOnlineRuntimeForNextRound).
  spectatorRound: boolean;
  activeRoundId: string | null;
  // Ronda cuya victoria ya reporté al ranking mundial (evita doble conteo).
  winSubmittedRoundId: string | null;
  roomReopenInFlight: boolean;
  roomGonePolls: number;
}

export const roundState: RoundState = {
  resultSubmitted: false,
  runStarted: false,
  spectatorRound: false,
  activeRoundId: null,
  winSubmittedRoundId: null,
  roomReopenInFlight: false,
  roomGonePolls: 0,
};
