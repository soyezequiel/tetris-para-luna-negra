// Vista "Historial" del dashboard: eyebrow + "Tus replays" + filtros + filas de
// TODAS las runs (o estado vacío), cada una con acciones Ver/Exportar/Borrar.
// Vista PURA: recibe las entradas ya filtradas/ordenadas por parámetro; el shell
// (main.ts) decide el filtro activo y cuántas runs hay en total. Reemplaza a la
// antigua "biblioteca completa": acá vive todo, sin pantalla aparte.

import { importIcon } from '../icons';
import { escapeHtml, formatFrames, formatHistoryDate } from '../format';
import type { RunHistoryEntry } from '../../app/runHistory';
import { LIBRARY_FILTERS, type LibraryFilter } from '../../state/libraryState';

const FILTER_LABELS: Record<LibraryFilter, string> = {
  all: 'Todos',
  clear: 'Completadas',
  topout: 'Derrotas',
  best: 'Mejores tiempos',
};

function renderFilters(active: LibraryFilter): string {
  const buttons = LIBRARY_FILTERS.map((filter) => {
    const activeClass = filter === active ? ' is-active' : '';
    return `<button class="dash-history-filter${activeClass}" type="button" data-ui-action="library-filter" data-filter="${filter}">${FILTER_LABELS[filter]}</button>`;
  }).join('');
  return `<div class="dash-history-filters" role="group" aria-label="Filtros de historial">${buttons}</div>`;
}

function renderRow(entry: RunHistoryEntry): string {
  const won = entry.status === 'finished';
  const id = escapeHtml(entry.id);
  return `
            <div class="dash-history-row">
              <span class="dash-history-time ${won ? 'is-clear' : 'is-topout'}">${escapeHtml(formatFrames(entry.elapsedFrames))}</span>
              <span class="dash-history-label">${entry.lines}L · ${won ? 'clear' : 'top out'}</span>
              <span class="dash-history-date">${escapeHtml(formatHistoryDate(entry.createdAt))}</span>
              <div class="dash-history-actions">
                <button class="dash-history-view" type="button" data-ui-action="play-history-replay" data-history-id="${id}">Ver</button>
                <button class="dash-history-view" type="button" data-ui-action="export-history-replay" data-history-id="${id}">Exportar</button>
                <button class="dash-history-view is-danger" type="button" data-ui-action="delete-history-entry" data-history-id="${id}">Borrar</button>
              </div>
            </div>`;
}

export function renderHistory(
  entries: RunHistoryEntry[],
  opts: { filter?: LibraryFilter; totalRuns?: number } = {},
): string {
  const filter = opts.filter ?? 'all';
  const totalRuns = opts.totalRuns ?? entries.length;
  const hasRuns = totalRuns > 0;

  let list: string;
  if (!hasRuns) {
    list = `<p class="dash-history-empty">Todavía no tenés replays guardados. Jugá una partida o importá un replay para verlo acá.</p>`;
  } else if (entries.length === 0) {
    list = `<p class="dash-history-empty">No hay partidas que coincidan con este filtro.</p>`;
  } else {
    list = entries.map(renderRow).join('');
  }

  return `
      <div class="dash-history" style="width: 100%; max-width: 520px;">
        <div class="panel-eyebrow">HISTORIAL</div>
        <div class="dash-history-head">
          <h1 class="dash-history-title">Tus replays</h1>
          <button class="dash-history-import" type="button" data-ui-action="import-replay">${importIcon({ size: 15 })}Importar<span class="dash-history-import-extra"> replay</span></button>
        </div>
        ${hasRuns ? renderFilters(filter) : ''}
        <div class="dash-history-list">${list}</div>
        ${hasRuns ? '<button class="dash-history-clear" type="button" data-ui-action="clear-history">Borrar historial</button>' : ''}
      </div>
    `;
}
