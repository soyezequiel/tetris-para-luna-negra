// Vista "Inicio" del dashboard (pantalla de bienvenida sin sala): saludo + CTA
// hacia Jugar + 3 stats locales. Vista PURA: recibe los datos ya derivados por
// parámetro (no lee globals del shell); la derivación vive en main.ts.

import { playIcon } from '../icons';
import { formatFrames } from '../format';

export interface WelcomeData {
  /** Mejor tiempo histórico en frames (60fps), o null si no hay runs. */
  bestFrames: number | null;
  /** PPS promedio histórico, o null si no hay runs. */
  avgPps: number | null;
  /** Victorias MP del jugador según el leaderboard, o null si no cargó. */
  myWins: number | null;
}

export function renderWelcome({ bestFrames, avgPps, myWins }: WelcomeData): string {
  const stat = (value: string, label: string, accent: string) =>
    `<div class="dash-welcome-stat" style="--stat-accent: ${accent};"><div class="dash-welcome-stat-value">${value}</div><div class="dash-welcome-stat-label">${label}</div></div>`;
  return `
    <div class="dash-welcome">
      <div class="dash-welcome-eyebrow">Bienvenido de nuevo</div>
      <h1 class="dash-welcome-title">TETRA</h1>
      <p class="dash-welcome-subtitle">Tu stacker competitivo. Elegí un modo, jugá solo al instante o armá una sala con amigos.</p>
      <button class="dash-welcome-cta" type="button" data-ui-action="play-menu">${playIcon({ size: 18, ariaHidden: true })}<span>Empezar a jugar</span></button>
      <div class="dash-welcome-stats">
        ${stat(bestFrames !== null ? formatFrames(bestFrames, false) : '—', 'Mejor tiempo', '#00f5ff')}
        ${stat(myWins !== null ? String(myWins) : '—', 'Victorias', '#9d4edd')}
        ${stat(avgPps !== null ? avgPps.toFixed(1) : '—', 'PPS prom.', '#ff007f')}
      </div>
    </div>
  `;
}
