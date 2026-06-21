// Estado del TRUCO AUTOPLAY (el bot juega solo): habilitado, acceso concedido por la
// llave local hasheada, y guard del toggle por pointerdown. Objeto mutable fuera de
// main.ts, igual que el resto de PR7.

export interface AutoPlayState {
  // El bot juega solo al activarse.
  enabled: boolean;
  // Habilitado solo con la llave local hasheada.
  accessGranted: boolean;
  // pointerdown ya hizo el toggle (no repetir en el click).
  ignoreNextClick: boolean;
}

export const autoPlayState: AutoPlayState = {
  enabled: false,
  accessGranted: false,
  ignoreNextClick: false,
};
