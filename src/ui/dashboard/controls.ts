// Vista "Controles" (tab Ajustes) del dashboard: filas DAS/ARR/Soft drop con el
// valor en Orbitron. Vista PURA: recibe los valores ya formateados por parámetro
// (el shell deriva softDrop con INSTANT_SOFT_DROP_FACTOR).

import { escapeHtml } from '../format';

export interface ControlsData {
  /** DAS ya formateado, ej. "10 f". */
  das: string;
  /** ARR ya formateado, ej. "2 f". */
  arr: string;
  /** Soft drop ya formateado, ej. "40 G" o "∞". */
  softDrop: string;
}

export function renderControls({ das, arr, softDrop }: ControlsData): string {
  const row = (label: string, value: string) =>
    `<div class="dash-controls-row"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`;
  return `
      <div class="dash-controls" style="width: 100%; max-width: 460px;">
        <div class="panel-eyebrow">AJUSTES</div>
        <h1 class="dash-controls-title">Controles</h1>
        <div class="dash-controls-list">
          ${row('DAS', das)}
          ${row('ARR', arr)}
          ${row('Soft drop', softDrop)}
        </div>
        <button class="dash-controls-edit" type="button" data-ui-action="settings">Ajustes de controles</button>
      </div>
    `;
}
