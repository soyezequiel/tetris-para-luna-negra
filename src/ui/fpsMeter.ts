// Contador de FPS opcional (Configuración → Rendimiento → "Contador de FPS").
//
// Vive en su PROPIO nodo pegado a <body>, no dentro del overlay del HUD: ese overlay se
// reconstruye por innerHTML cuando su HTML cambia, y el contador (que cambia solo, varias
// veces por segundo) lo forzaría a reconstruirse entero en cada actualización.
//
// Mide la CADENCIA REAL de requestAnimationFrame, que es lo que el jugador ve: si el
// compositor se atrasa, esto se atrasa igual. Además del promedio muestra el peor frame
// de la ventana, porque un promedio alto esconde los tirones puntuales (a 165Hz un frame
// congelado de 100ms se diluye en el promedio y "todo se ve bien" aunque se haya sentido).
//
// Cuando está apagado no hay bucle de rAF ni nodo visible: cuesta exactamente cero.

const WINDOW_MS = 1000;   // ventana rodante sobre la que se promedia
const REPAINT_MS = 250;   // no reescribimos el texto más seguido que esto

export class FpsMeter {
  private readonly el: HTMLElement;
  private rafId = 0;
  private enabled = false;
  private readonly gaps: number[] = [];
  private last = 0;
  private lastPaint = 0;
  private lastText = '';

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'fps-meter';
    this.el.setAttribute('aria-hidden', 'true'); // dato de diagnóstico, no contenido
    this.el.hidden = true;
    document.body.appendChild(this.el);
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.el.hidden = !enabled;
    if (!enabled) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
      this.gaps.length = 0;
      this.lastText = '';
      return;
    }
    this.last = performance.now();
    this.lastPaint = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.el.remove();
  }

  private readonly tick = (now: number): void => {
    const gap = now - this.last;
    this.last = now;
    // El primer frame tras encender (y cualquier vuelta desde una pestaña oculta, donde el
    // navegador congela rAF) trae un hueco enorme que no es un tirón real: se descarta.
    if (gap > 0 && gap < 1000) this.gaps.push(gap);

    let total = 0;
    for (let i = this.gaps.length - 1; i >= 0; i -= 1) {
      total += this.gaps[i];
      if (total > WINDOW_MS) { this.gaps.splice(0, i); break; }
    }

    if (now - this.lastPaint >= REPAINT_MS && this.gaps.length >= 3) {
      this.lastPaint = now;
      let sum = 0;
      let worst = 0;
      for (const g of this.gaps) { sum += g; if (g > worst) worst = g; }
      const avg = sum / this.gaps.length;
      const fps = Math.round(1000 / avg);
      const text = `${fps} FPS · ${avg.toFixed(1)} ms · pico ${worst.toFixed(0)} ms`;
      // Escribir en el DOM invalida estilo/layout: sólo si el texto cambió de verdad.
      if (text !== this.lastText) {
        this.lastText = text;
        this.el.textContent = text;
        // Verde si el peor frame de la ventana se mantiene cerca del promedio (cadencia
        // pareja); ámbar si hubo un frame el doble de largo; rojo si hubo un tirón franco.
        this.el.dataset.health = worst > Math.max(50, avg * 3) ? 'bad'
          : worst > avg * 2 ? 'warn'
          : 'good';
      }
    }
    this.rafId = requestAnimationFrame(this.tick);
  };
}
