// Cachés del último HTML renderizado de cada overlay, para diffear y NO recrearlos en
// cada frame (evita titileo del hover en sus botones). Objeto mutable fuera de
// main.ts, igual que el resto de PR7.

export interface OverlayState {
  last: string;
  lastKo: string;
  lastHud: string;
  lastInvite: string;
  lastDevBot: string;
}

export const overlayState: OverlayState = {
  last: '',
  lastKo: '',
  lastHud: '',
  lastInvite: '',
  lastDevBot: '',
};
