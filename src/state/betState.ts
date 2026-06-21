// Estado del dominio "apuesta online" (flujo de creación/depósito/cobro de la
// apuesta Lightning de una sala). Igual que leaderboardState, vive fuera de
// main.ts como objeto mutable para que la UI del panel de apuesta pueda leerlo por
// parámetro sin circular dep. Parte de PR7 (encapsular los globals de main.ts).

// Stake por defecto (en sats) al crear una apuesta.
export const DEFAULT_ONLINE_BET_STAKE_SATS = 50;

export interface BetState {
  // Valor del input de monto al crear la apuesta (string crudo del campo).
  stakeInput: string;
  // El polling de la apuesta lo pone en true cada ~750ms; sirve para deshabilitar
  // acciones mientras hay un request en vuelo.
  busy: boolean;
  // Bandera dedicada al pago WebLN iniciado por el usuario. Separada de `busy`
  // (que el polling alterna) para que el botón "Pagar con extensión" no quede
  // deshabilitado tragando clicks cada vez que hay un poll en vuelo.
  paying: boolean;
  // Bandera dedicada a la creación de la apuesta disparada por el host. Separada de
  // `busy` para mostrar "Creando apuesta…" sin parpadear con cada poll. Crear tarda
  // varios segundos: Luna Negra genera un invoice Lightning por jugador (NWC).
  creating: boolean;
  lastPollAt: number;
  fastPollUntil: number;
  refreshQueued: boolean;
  // Guard de "festejo de pago una sola vez por apuesta": renderOnlineBetResult corre
  // en cada render, así que el festejo se dispara vía maybeCelebratePayout() desde
  // adoptOnlineRoom, marcando acá el betId ya festejado.
  celebratedBetId: string | null;
}

export const betState: BetState = {
  stakeInput: String(DEFAULT_ONLINE_BET_STAKE_SATS),
  busy: false,
  paying: false,
  creating: false,
  lastPollAt: 0,
  fastPollUntil: 0,
  refreshQueued: false,
  celebratedBetId: null,
};
