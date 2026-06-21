// Estado de las secuencias de muerte/derrota (animación de colapso del tablero +
// banners), tanto en solo como en online. Objeto mutable fuera de main.ts, igual que
// el resto de PR7.

export interface DeathState {
  // Banner de KO online (lugar en que quedé + si gané), o null si no corresponde.
  onlineKoBanner: { placement: string; won: boolean } | null;
  // Inicio de la animación de muerte online (performance.now()), o null.
  onlineAnimStartedAt: number | null;
  onlineCollapseStarted: boolean;
  onlineLostByTopOut: boolean;
  // Equivalentes para la muerte en modo solo.
  soloStartedAt: number | null;
  soloCollapseStarted: boolean;
  soloSequenceDone: boolean;
}

export const deathState: DeathState = {
  onlineKoBanner: null,
  onlineAnimStartedAt: null,
  onlineCollapseStarted: false,
  onlineLostByTopOut: false,
  soloStartedAt: null,
  soloCollapseStarted: false,
  soloSequenceDone: false,
};
