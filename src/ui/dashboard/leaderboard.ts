// Panel "Top mundial" del dashboard. Vista PURA: no lee estado de módulo — todo
// entra por parámetro. Tiene dos pestañas (Multijugador / Supervivencia) que
// comparten exactamente la misma estructura de filas; la diferencia (qué slice de
// estado, el texto del valor y el mensaje vacío) la resuelve main.ts al armar las
// filas. Los avatares entran ya renderizados como fragmentos HTML.

import { escapeHtml } from '../format';

export interface LeaderboardRow {
  /** ¿Es la fila del jugador local? (resalta con .leaderboard-row--me) */
  isMe: boolean;
  /** Avatar ya renderizado (renderOnlineAvatar). */
  avatarHtml: string;
  name: string;
  /** Texto del valor de la fila: "3 victorias" o un tiempo formateado. */
  valueText: string;
}

export interface LeaderboardBodyData {
  loading: boolean;
  error: string | null | undefined;
  /** Filas ya ordenadas por ranking; vacío muestra el mensaje vacío. */
  rows: LeaderboardRow[];
  /** Mensaje cuando no hay datos (ni cargando ni error). HTML-safe (literal). */
  emptyMessage: string;
}

// Filas del ranking (compartidas por ambas pestañas): nota de carga/error/vacío o
// la lista de filas con medalla (oro/plata/bronce o número) + avatar + nombre + valor.
export function renderLeaderboardBody({ loading, error, rows, emptyMessage }: LeaderboardBodyData): string {
  if (loading && rows.length === 0) {
    return '<p class="leaderboard-note">Cargando ranking…</p>';
  }
  if (error && rows.length === 0) {
    return `<p class="leaderboard-note leaderboard-note--error">${escapeHtml(error)}</p>`;
  }
  if (rows.length === 0) {
    return `<p class="leaderboard-note">${emptyMessage}</p>`;
  }
  const rowsHtml = rows.map((entry, index) => {
    const rank = index + 1;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}`;
    const mine = entry.isMe ? ' leaderboard-row--me' : '';
    return `
      <div class="leaderboard-row${mine}">
        <span class="leaderboard-rank">${escapeHtml(medal)}</span>
        ${entry.avatarHtml}
        <span class="leaderboard-name">${escapeHtml(entry.name)}</span>
        <span class="leaderboard-time">${escapeHtml(entry.valueText)}</span>
      </div>
    `;
  }).join('');
  return `<div class="leaderboard-rows">${rowsHtml}</div>`;
}

export interface LeaderboardPanelData {
  /** ¿Pestaña Supervivencia activa? (vs Multijugador) */
  onSurvival: boolean;
  /** ¿La pestaña activa está actualizando? (deshabilita "Actualizar") */
  loading: boolean;
  /** Filas de la pestaña activa ya renderizadas (renderLeaderboardBody). */
  bodyHtml: string;
}

export function renderLeaderboardPanel({ onSurvival, loading, bodyHtml }: LeaderboardPanelData): string {
  const tabs = `
    <div class="leaderboard-tabs" role="tablist">
      <button class="leaderboard-tab ${!onSurvival ? 'leaderboard-tab--active' : ''}" type="button" role="tab" aria-selected="${!onSurvival}" data-ui-action="leaderboard-tab-wins">🏆 Multijugador</button>
      <button class="leaderboard-tab ${onSurvival ? 'leaderboard-tab--active' : ''}" type="button" role="tab" aria-selected="${onSurvival}" data-ui-action="leaderboard-tab-survival">⏱️ Supervivencia</button>
    </div>
  `;

  const desc = onSurvival
    ? 'Modo de 1 jugador igual para todos: aguantá lo más posible. El ranking ordena por quién duró más tiempo.'
    : 'Victorias en partidas multijugador. Ganá batallas online para subir en el ranking.';
  const playBtn = onSurvival
    ? '<button class="dash-action-btn primary" type="button" data-ui-action="survival-start">Jugar Supervivencia</button>'
    : '';

  return `
    <div class="menu-panel" style="width: 100%; max-width: 480px; border: none; background: transparent; box-shadow: none; padding: 0;">
      <div class="panel-eyebrow">TOP MUNDIAL</div>
      <h1 style="font-size: 36px; margin: 8px 0 16px; font-family: 'Arial Black', Arial, sans-serif;">Top mundial</h1>
      ${tabs}
      <p style="color: var(--dash-text-dim); margin: 4px 0 20px; font-size: 14px; font-weight: 500;">${desc}</p>
      ${bodyHtml}
      <div class="panel-actions mode-menu-actions" style="display: flex; flex-direction: column; gap: 12px; max-width: 320px; margin-top: 20px;">
        ${playBtn}
        <button class="dash-action-btn" type="button" data-ui-action="leaderboard-refresh"${loading ? ' disabled' : ''}>${loading ? 'Actualizando…' : 'Actualizar'}</button>
        <button class="dash-action-btn danger" type="button" data-ui-action="main-menu">Volver</button>
      </div>
    </div>
  `;
}
