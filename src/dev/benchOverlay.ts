// Bench de rendimiento SIN manos (?bench=1): arranca una partida solo con el autoplay
// puesto y muestra un marcador gigante de FPS/jank arriba a la izquierda. Sirve para
// medir el juego en un navegador donde no se puede interactuar (p. ej. leerlo por
// captura de pantalla en un Firefox real) o para comparar navegadores A/B con la
// misma carga. No toca nada si la URL no trae bench=1.
//
// Qué muestra (ventana rodante de ~2s + acumulado de sesión):
//   FPS   frames de rAF por segundo (≈ refresco del monitor si va fluido)
//   p95   gap entre rAF en ms (95° percentil de la ventana)
//   max   peor gap de la ventana
//   >33   total de gaps >33ms de la sesión (vsync de 60Hz perdido)
//   >100  total de gaps >100ms de la sesión (tirón grosero)

import { autoPlayState } from '../state/autoPlayState';

interface BenchDeps {
  startNewRun: () => void;
  getAppMode: () => string;
}

export function installBenchMode(deps: BenchDeps): void {
  let enabled = false;
  try { enabled = new URLSearchParams(window.location.search).get('bench') === '1'; } catch { /* sin window */ }
  if (!enabled) return;

  autoPlayState.accessGranted = true;
  autoPlayState.enabled = true;

  // Overlay de lectura: texto enorme y monoespaciado, legible en una captura.
  const el = document.createElement('div');
  el.id = 'bench-overlay';
  const s = el.style;
  s.position = 'fixed';
  s.top = '8px';
  s.left = '8px';
  s.zIndex = '99999';
  s.pointerEvents = 'none';
  s.font = '700 26px/1.35 Consolas, monospace';
  s.color = '#7CFC00';
  s.background = 'rgba(0,0,0,0.72)';
  s.padding = '10px 14px';
  s.borderRadius = '8px';
  s.whiteSpace = 'pre';
  s.textShadow = '0 1px 2px #000';
  document.body.appendChild(el);

  // Arranque y re-arranque: si la partida termina (top out del autoplay), reinicia.
  // Ojo: la cuenta regresiva ('soloCountdown') YA es una partida en curso — reiniciar
  // ahí la relanzaría en bucle y nunca se llegaría a jugar.
  const LIVE_MODES = new Set(['playing', 'soloCountdown', 'paused']);
  window.setTimeout(() => { try { deps.startNewRun(); } catch { /* menú raro: reintenta el watchdog */ } }, 800);
  window.setInterval(() => {
    try { if (!LIVE_MODES.has(deps.getAppMode())) deps.startNewRun(); } catch { /* noop */ }
  }, 3000);

  // Medidor de cadencia de rAF, independiente del loop del juego (mide lo que el
  // usuario VE: si el compositor se atasa, esto se atasa igual).
  const gaps: number[] = [];
  let last = performance.now();
  let over33 = 0;
  let over100 = 0;
  let lastPaint = 0;
  const t0 = last;
  function tick(now: number): void {
    const gap = now - last;
    last = now;
    gaps.push(gap);
    if (gaps.length > 240) gaps.shift();
    if (gap > 33) over33 += 1;
    if (gap > 100) over100 += 1;
    if (now - lastPaint > 250 && gaps.length >= 3) {
      lastPaint = now;
      const sorted = [...gaps].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      const fps = Math.round(1000 / (sum / sorted.length));
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const max = sorted[sorted.length - 1];
      el.textContent = `BENCH ${deps.getAppMode()}  t=${Math.round((now - t0) / 1000)}s`
        + `\nFPS ${fps}   p95 ${p95.toFixed(1)}ms   max ${max.toFixed(1)}ms`
        + `\n>33ms ${over33}   >100ms ${over100}`;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
