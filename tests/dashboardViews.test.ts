import { describe, expect, it } from 'vitest';
import { renderWelcome } from '../src/ui/dashboard/welcome';

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
