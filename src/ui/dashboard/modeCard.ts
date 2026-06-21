// Núcleo PURO del selector de modalidad: metadatos por modo, acento, ícono y la
// tarjeta. Lo usan tanto los orquestadores stateful del dashboard de escritorio
// (smart-play / mode-select stage, en main.ts) como el layout móvil. No lee
// ningún estado de módulo: todo entra por el `mode`.

import { tetrominoIcon } from '../icons';
import { escapeHtml } from '../format';
import type { PlayMode } from '../playMode';

export interface ModeMeta {
  // cardName/cardTag → tarjeta del selector; tag/name/desc → detalle; solo/sub → CTA.
  cardName: string;
  cardTag: string;
  tag: string;
  name: string;
  desc: string;
  solo: string;
  sub: string;
}

export function playModeMeta(mode: PlayMode): ModeMeta {
  if (mode === 'custom') {
    return {
      cardName: 'Custom',
      cardTag: 'Tus reglas',
      tag: 'Tus reglas',
      name: 'Partida custom',
      desc: 'Configurá gravedad, objetivo y reglas a tu gusto. Con sala, es una batalla online con tus propias reglas.',
      solo: 'JUGAR',
      sub: 'Con tu configuración',
    };
  }
  if (mode === 'local1v1') {
    return {
      cardName: 'Duelo 1v1',
      cardTag: 'Local',
      tag: '1v1 · misma pantalla',
      name: 'Duelo local',
      desc: 'Dos jugadores en la misma compu, misma semilla. Sin cuenta ni conexión, solo dos manos.',
      solo: 'INICIAR DUELO',
      sub: '2 jugadores · local',
    };
  }
  return {
    cardName: 'Supervivencia',
    cardTag: 'Resistencia',
    tag: 'Resistencia',
    name: 'Supervivencia',
    desc: 'Reglas fijas iguales para todos. Aguantá lo máximo posible y subí en el ranking de tiempo.',
    solo: 'JUGAR',
    sub: 'Al instante · sin configurar',
  };
}

export function modeAccent(mode: PlayMode): string {
  if (mode === 'custom') return '#9d4edd';
  if (mode === 'local1v1') return '#ff007f';
  return '#00f5ff';
}

// Ícono de tetrominó por modalidad (delega en el módulo de íconos con el acento).
export function modeTetrominoIcon(mode: PlayMode, size = 28): string {
  return tetrominoIcon(mode, modeAccent(mode), size);
}

export function renderModeCard(mode: PlayMode, active: boolean, action = 'select-play-mode'): string {
  const meta = playModeMeta(mode);
  return `
    <button class="dash-mode-card ${active ? 'is-active' : ''}" type="button" role="tab" aria-selected="${active}" data-ui-action="${action}" data-mode="${mode}" style="--card-accent: ${modeAccent(mode)};">
      <span class="dash-mode-card-icon" aria-hidden="true">${modeTetrominoIcon(mode)}</span>
      <span class="dash-mode-card-text"><strong>${meta.cardName}</strong><small>${escapeHtml(meta.cardTag)}</small></span>
    </button>`;
}
