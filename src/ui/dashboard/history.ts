// Vista "Historial" del dashboard: eyebrow + "Tus replays" + filas de runs
// recientes (o estado vacío). Vista PURA: recibe las entradas ya recortadas por
// parámetro; el shell (main.ts) decide cuántas y de dónde.

import { importIcon } from '../icons';
import { escapeHtml, formatFrames, formatHistoryDate } from '../format';
import type { RunHistoryEntry } from '../../app/runHistory';

export function renderHistory(entries: RunHistoryEntry[]): string {
  const list = entries.length === 0
    ? `<p class="dash-history-empty">Todavía no tenés replays guardados. Jugá una partida o importá un replay para verlo acá.</p>`
    : entries.map((entry) => {
        const won = entry.status === 'finished';
        return `
            <div class="dash-history-row">
              <span class="dash-history-time ${won ? 'is-clear' : 'is-topout'}">${escapeHtml(formatFrames(entry.elapsedFrames))}</span>
              <span class="dash-history-label">${entry.lines}L · ${won ? 'clear' : 'top out'}</span>
              <span class="dash-history-date">${escapeHtml(formatHistoryDate(entry.createdAt))}</span>
              <button class="dash-history-view" type="button" data-ui-action="play-history-replay" data-history-id="${escapeHtml(entry.id)}">Ver</button>
            </div>`;
        }).join('');
  return `
      <div class="dash-history" style="width: 100%; max-width: 520px;">
        <div class="panel-eyebrow">HISTORIAL</div>
        <div class="dash-history-head">
          <h1 class="dash-history-title">Tus replays</h1>
          <button class="dash-history-import" type="button" data-ui-action="import-replay">${importIcon({ size: 15 })}Importar<span class="dash-history-import-extra"> replay</span></button>
        </div>
        <div class="dash-history-list">${list}</div>
        ${entries.length > 0 ? '<button class="dash-history-library" type="button" data-ui-action="replay-library">Ver biblioteca completa</button>' : ''}
      </div>
    `;
}
