import { describe, expect, it } from 'vitest';
import { renderWelcome } from '../src/ui/dashboard/welcome';
import { renderHistory } from '../src/ui/dashboard/history';
import { renderControls } from '../src/ui/dashboard/controls';
import { modeAccent, playModeMeta, renderModeCard } from '../src/ui/dashboard/modeCard';
import type { RunHistoryEntry } from '../src/app/runHistory';

// Construye una entrada de historial con solo los campos que la vista lee; el
// resto se castea (no afectan el render).
const histEntry = (over: Partial<RunHistoryEntry>): RunHistoryEntry =>
  ({ id: 'r1', createdAt: '2026-06-21T00:00:00.000Z', status: 'finished', lines: 40, elapsedFrames: 3600, ...over } as unknown as RunHistoryEntry);

// Red de regresión para las vistas del dashboard extraídas de main.ts (PR4).
// Al ser módulos puros se pueden renderizar y verificar de forma aislada: estos
// tests congelan el HTML/estructura para que futuras extracciones o refactors no
// cambien el render sin que nos demos cuenta.

describe('renderWelcome', () => {
  it('renderiza la estructura de la pantalla de bienvenida', () => {
    const html = renderWelcome({ bestFrames: null, avgPps: null, myWins: null });
    expect(html).toContain('class="dash-welcome"');
    expect(html).toContain('<h1 class="dash-welcome-title">TETRA</h1>');
    expect(html).toContain('data-ui-action="play-menu"');
    // 3 tarjetas de stats
    expect(html.match(/class="dash-welcome-stat"/g)).toHaveLength(3);
  });

  it('formatea los datos provistos y usa "—" cuando faltan', () => {
    const html = renderWelcome({ bestFrames: 3600, avgPps: 2.345, myWins: 5 });
    expect(html).toContain('>1:00<'); // 3600 frames @60fps = 1:00 (sin millis)
    expect(html).toContain('>5<'); // victorias
    expect(html).toContain('>2.3<'); // pps con 1 decimal

    const empty = renderWelcome({ bestFrames: null, avgPps: null, myWins: null });
    expect(empty.match(/>—</g)).toHaveLength(3);
  });
});

describe('renderHistory', () => {
  it('muestra el estado vacío sin filas, filtros ni botón de borrar', () => {
    const html = renderHistory([]);
    expect(html).toContain('class="dash-history-empty"');
    expect(html).not.toContain('dash-history-row');
    expect(html).not.toContain('dash-history-filters');
    expect(html).not.toContain('Borrar historial');
  });

  it('renderiza una fila por entrada con tiempo, estado y acciones', () => {
    const html = renderHistory([
      histEntry({ id: 'a', status: 'finished', elapsedFrames: 3600, lines: 40 }),
      histEntry({ id: 'b', status: 'gameover', elapsedFrames: 1800, lines: 12 }),
    ], { filter: 'all', totalRuns: 2 });
    expect(html.match(/class="dash-history-row"/g)).toHaveLength(2);
    expect(html).toContain('1:00.000'); // 3600 frames con millis
    expect(html).toContain('is-clear'); // finished
    expect(html).toContain('is-topout'); // gameover
    // Filtros + acciones por fila (la antigua "biblioteca completa" ahora vive acá)
    expect(html).toContain('dash-history-filters');
    expect(html).toContain('data-ui-action="play-history-replay"');
    expect(html).toContain('data-ui-action="export-history-replay"');
    expect(html).toContain('data-ui-action="delete-history-entry"');
    expect(html).toContain('Borrar historial');
  });

  it('con runs pero filtro sin coincidencias muestra vacío conservando filtros', () => {
    const html = renderHistory([], { filter: 'topout', totalRuns: 5 });
    expect(html).toContain('class="dash-history-empty"');
    expect(html).toContain('dash-history-filters');
    expect(html).toContain('Borrar historial');
  });
});

describe('renderControls', () => {
  it('renderiza las filas DAS/ARR/Soft drop con los valores provistos', () => {
    const html = renderControls({ das: '10 f', arr: '2 f', softDrop: '∞' });
    expect(html).toContain('<h1 class="dash-controls-title">Controles</h1>');
    expect(html.match(/class="dash-controls-row"/g)).toHaveLength(3);
    expect(html).toContain('>10 f<');
    expect(html).toContain('>2 f<');
    expect(html).toContain('>∞<');
  });
});

describe('modeCard (núcleo puro del selector de modalidad)', () => {
  it('modeAccent da el hex por modo', () => {
    expect(modeAccent('survival')).toBe('#00f5ff');
    expect(modeAccent('custom')).toBe('#9d4edd');
    expect(modeAccent('local1v1')).toBe('#ff007f');
  });

  it('playModeMeta da los metadatos por modo', () => {
    expect(playModeMeta('survival').cardName).toBe('Supervivencia');
    expect(playModeMeta('custom').cardName).toBe('Custom');
    expect(playModeMeta('local1v1').cardName).toBe('Duelo 1v1');
  });

  it('renderModeCard refleja modo, estado activo y acento', () => {
    const active = renderModeCard('custom', true);
    expect(active).toContain('data-mode="custom"');
    expect(active).toContain('is-active');
    expect(active).toContain('--card-accent: #9d4edd');
    expect(active).toContain('aria-selected="true"');
    expect(active).toContain('<strong>Custom</strong>');

    const inactive = renderModeCard('survival', false, 'select-room-mode');
    expect(inactive).not.toContain('is-active');
    expect(inactive).toContain('data-ui-action="select-room-mode"');
  });
});
