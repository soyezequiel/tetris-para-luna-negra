// Fondo dinámico y relajante de la zona de juego (Aurora / Bruma / Marea).
//
// Vive en su PROPIO <canvas> 2D detrás del canvas de Pixi (que es transparente,
// backgroundAlpha: 0). Pixi no dibuja gradientes radiales en Graphics, así que
// resolvemos los fondos suaves en Canvas2D y dejamos que se vean a través.
//
// El estilo de cada partida se deriva de la SEMILLA del juego (state.seed):
//   - Solo: la semilla es aleatoria por partida  => el fondo varía cada juego.
//   - Multi: la semilla es la de la sala (room.seed), igual para todos los
//            jugadores => todos ven EXACTAMENTE el mismo fondo, sin enviar nada.
// Como el estilo es función pura de la semilla, es determinista entre clientes.
//
// Integración: ver PixiGameRenderer (construir, render -> setSeed, destroy).

export type BgStyle = 'aurora' | 'bruma' | 'marea';

const STYLES: BgStyle[] = ['aurora', 'bruma', 'marea'];
const TRANSITION_SECONDS = 0.9; // crossfade entre fondos al cambiar de partida

interface Blob {
  color: [number, number, number];
  x: number; y: number; r: number;
  sx: number; sy: number; px: number; py: number;
}
interface Particle { x: number; y: number; r: number; speed: number; tw: number; }

export class BackgroundFX {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;

  private seed = -1;
  private curStyle: BgStyle = 'aurora';
  private transStyle: BgStyle | null = null;
  private transP = 0;
  private hasSeed = false;

  private t = 0;
  private last = 0;
  private lastDraw = 0;
  private rafId = 0;
  private enabled = true;
  private motion = true;
  private reducedMotion = false;
  // El fondo es difuso y "relax": no necesita 60fps. Limitarlo a ~30fps libera el
  // main thread para el loop de Pixi del juego (clave en Firefox, cuyo Canvas2D con
  // gradientes radiales + composición 'screen' es mucho más caro que en Chrome).
  private readonly drawInterval = 1000 / 30;
  // Gradientes que solo dependen del tamaño del viewport: se construyen una vez por
  // resize en lugar de recrearse cada frame (crear un CanvasGradient no es gratis).
  private baseGrad: CanvasGradient | null = null;
  private vignette: CanvasGradient | null = null;

  private blobs: Blob[] = [];
  private particles: Particle[] = [];

  // Peligro (0..1): oscurece el fondo de la página conforme sube la pila. Se
  // suaviza hacia el objetivo para que el cambio sea gradual, no un parpadeo.
  private danger = 0;
  private dangerTarget = 0;
  private dangerCritical = false;

  private readonly onResize = () => this.resize();

  constructor(root: HTMLElement) {
    this.canvas = document.createElement('canvas');
    const s = this.canvas.style;
    s.position = 'absolute';
    s.inset = '0';
    s.width = '100%';
    s.height = '100%';
    s.display = 'block';
    s.zIndex = '0';            // detrás del canvas de Pixi (al que le ponemos z-index 1)
    s.pointerEvents = 'none';  // no roba input
    // Se inserta como primer hijo para quedar por debajo del view de Pixi.
    root.insertBefore(this.canvas, root.firstChild);
    this.ctx = this.canvas.getContext('2d')!;

    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = mq.matches;
    mq.addEventListener?.('change', (e) => { this.reducedMotion = e.matches; });

    this.initScene();
    window.addEventListener('resize', this.onResize);
    this.resize();
    this.last = performance.now();
    this.loop();
  }

  // Llamar una vez por frame con state.seed. Si la semilla cambió (partida nueva),
  // elige el fondo determinista y hace crossfade.
  setSeed(seed: number): void {
    const s = seed >>> 0;
    if (s === this.seed) return;
    this.seed = s;
    const next = this.styleForSeed(s);
    if (!this.hasSeed || this.reducedMotion) {
      // Primera partida o "reducir movimiento": sin crossfade.
      this.hasSeed = true;
      this.curStyle = next;
      this.transStyle = null;
      this.transP = 0;
      return;
    }
    if (next === this.curStyle) { this.transStyle = null; this.transP = 0; return; }
    this.transStyle = next;
    this.transP = 0.0001;
  }

  // Función PURA de la semilla => mismo resultado en todos los clientes.
  private styleForSeed(seed: number): BgStyle {
    const rng = mulberry32(seed >>> 0);
    return STYLES[Math.floor(rng() * STYLES.length)];
  }

  // Nivel de peligro del tablero local (0..1). El renderer lo reenvía cada frame
  // desde JuiceFX. El fondo se oscurece de forma proporcional.
  setDanger(level: number, critical = false): void {
    this.dangerTarget = Math.max(0, Math.min(1, level));
    this.dangerCritical = critical;
  }

  setMotion(enabled: boolean): void { this.motion = enabled; }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.canvas.style.display = enabled ? 'block' : 'none';
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResize);
    this.canvas.remove();
  }

  private initScene(): void {
    const blobCols: [number, number, number][] = [
      [46, 150, 150], [60, 110, 180], [86, 80, 170], [120, 90, 165], [40, 120, 140],
    ];
    this.blobs = blobCols.map((c, i) => ({
      color: c,
      x: 0.18 + i * 0.17, y: 0.22 + (i % 3) * 0.26,
      r: 0.42 + (i % 3) * 0.12,
      sx: 0.05 + i * 0.013, sy: 0.04 + i * 0.011, px: i * 1.7, py: i * 2.3,
    }));
    this.particles = Array.from({ length: 30 }, (_, i) => ({
      x: (i * 0.137 + 0.05) % 1, y: (i * 0.211) % 1,
      r: 1.6 + (i % 4) * 1.4, speed: 0.012 + (i % 5) * 0.004, tw: i * 0.9,
    }));
  }

  private resize(): void {
    // El fondo es difuso: rendea por debajo de la resolución del viewport y se
    // estira por CSS. No se nota (son gradientes suaves) y reduce linealmente el
    // costo de pintado, que es lo que ahoga a Firefox.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.25) * 0.75;
    const w = window.innerWidth, h = window.innerHeight;
    this.width = w; this.height = h;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.buildGradients();
  }

  // Gradientes dependientes solo del tamaño: se cachean por resize.
  private buildGradients(): void {
    const ctx = this.ctx, { width: W, height: H } = this;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#080d16'); g.addColorStop(0.55, '#0a111c'); g.addColorStop(1, '#05090f');
    this.baseGrad = g;
    const v = ctx.createRadialGradient(W / 2, H * 0.46, Math.min(W, H) * 0.18, W / 2, H * 0.5, Math.max(W, H) * 0.72);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(2,4,8,0.62)');
    this.vignette = v;
  }

  private loop(): void {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    // El usuario puede apagar el movimiento del fondo del todo (this.motion=false).
    // Si solo está activo "reducir movimiento" del sistema, NO lo congelamos: el fondo
    // es difuso y lento (no es el tipo de animación que marea), así que lo dejamos
    // derivar a una fracción de la velocidad en vez de quedar estático.
    if (this.motion) this.t += this.reducedMotion ? dt * 0.3 : dt;
    // Suavizado del peligro hacia su objetivo (~constante de tiempo de ~0.25s).
    this.danger += (this.dangerTarget - this.danger) * Math.min(1, dt * 4);
    if (this.transStyle) {
      this.transP += dt / TRANSITION_SECONDS;
      if (this.transP >= 1) { this.curStyle = this.transStyle; this.transStyle = null; this.transP = 0; }
    }
    // Throttle del fondo a ~30fps (ver drawInterval). El loop de rAF sigue a 60 para
    // mantener this.t suave, pero solo repintamos cada ~33ms.
    if (this.enabled && now - this.lastDraw >= this.drawInterval - 4) {
      this.lastDraw = now;
      this.draw();
    }
    this.rafId = requestAnimationFrame(() => this.loop());
  }

  private draw(): void {
    const ctx = this.ctx, { width: W, height: H } = this;
    if (!this.baseGrad || !this.vignette) this.buildGradients();
    ctx.fillStyle = this.baseGrad!; ctx.fillRect(0, 0, W, H);

    ctx.globalCompositeOperation = 'screen';
    if (this.transStyle) {
      const f = Math.min(1, this.transP);
      this.runBg(this.curStyle, 1 - f);
      this.runBg(this.transStyle, f);
    } else {
      this.runBg(this.curStyle, 1);
    }
    ctx.globalCompositeOperation = 'source-over';

    // Viñeta: concentra la mirada en el tablero (gradiente cacheado).
    ctx.fillStyle = this.vignette!; ctx.fillRect(0, 0, W, H);

    // Peligro: oscurece el fondo de la página (no el tablero, que lo tapa Pixi por
    // encima). Casi negro con un punto de rojo para dar clima; en crítico late suave.
    if (this.danger > 0.01) {
      const crit = this.dangerCritical;
      const pulse = crit ? 0.06 * (0.5 + 0.5 * Math.sin(this.t * 4.2)) : 0;
      const a = Math.min(0.7, this.danger * (crit ? 0.62 : 0.48) + pulse);
      ctx.fillStyle = `rgba(8,2,4,${a.toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  private runBg(style: BgStyle, a: number): void {
    if (a <= 0) return;
    const ctx = this.ctx;
    ctx.globalAlpha = a;
    if (style === 'aurora') this.bgAurora();
    else if (style === 'bruma') this.bgBruma();
    else this.bgMarea();
    ctx.globalAlpha = 1;
  }

  private bgAurora(): void {
    const ctx = this.ctx, { width: W, height: H, t } = this, m = Math.min(W, H);
    for (const b of this.blobs) {
      const x = b.x * W + Math.sin(t * b.sx * 6.28 + b.px) * W * 0.13;
      const y = b.y * H + Math.cos(t * b.sy * 6.28 + b.py) * H * 0.11;
      const r = b.r * m * (0.92 + 0.08 * Math.sin(t * 0.4 + b.px));
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      const [cr, cg, cb] = b.color;
      rg.addColorStop(0, `rgba(${cr},${cg},${cb},0.20)`);
      rg.addColorStop(0.5, `rgba(${cr},${cg},${cb},0.08)`);
      rg.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      // El gradiente es 0 fuera del radio: rellenar solo su bounding box en vez de
      // toda la pantalla recorta drásticamente el área pintada (clave en Firefox).
      ctx.fillStyle = rg; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }

  private bgBruma(): void {
    const ctx = this.ctx, { width: W, height: H, t } = this;
    const halos: [number, number, number, number, number, number][] = [
      [60, 150, 160, 0.16, 0.3, 0.35], [110, 90, 160, 0.14, 0.72, 0.6],
    ];
    for (const [cr, cg, cb, a, hx, hy] of halos) {
      const x = hx * W + Math.sin(t * 0.12 + hx * 4) * W * 0.05, y = hy * H, r = Math.min(W, H) * 0.6;
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`); rg.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = rg; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (const p of this.particles) {
      const py = (((p.y - t * p.speed) % 1) + 1) % 1, x = p.x * W, y = py * H;
      const tw = 0.5 + 0.5 * Math.sin(t * 0.8 + p.tw), a = 0.05 + 0.07 * tw, r = p.r * (1 + 0.2 * tw);
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
      rg.addColorStop(0, `rgba(170,210,220,${a})`); rg.addColorStop(1, 'rgba(170,210,220,0)');
      ctx.fillStyle = rg; ctx.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);
    }
  }

  private bgMarea(): void {
    const ctx = this.ctx, { width: W, height: H, t } = this;
    const bands: [number, number, number, number, number, number][] = [
      [50, 150, 142, 0.30, 0.05, 1.0], [90, 84, 168, 0.38, 0.10, 0.8],
      [126, 88, 158, 0.55, 0.07, 1.3], [44, 118, 134, 0.72, 0.06, 0.65],
    ];
    for (const [cr, cg, cb, baseY, amp, spd] of bands) {
      const by = baseY * H, a = amp * H;
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 14) {
        const y = by + Math.sin((x / W) * 6.28 * 1.4 + t * spd) * a + Math.sin((x / W) * 6.28 * 0.5 - t * spd * 0.6) * a * 0.5;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H); ctx.closePath();
      const lg = ctx.createLinearGradient(0, by - a, 0, H);
      lg.addColorStop(0, `rgba(${cr},${cg},${cb},0.16)`); lg.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = lg; ctx.fill();
    }
  }
}

// PRNG determinista pequeño (mismo número => misma secuencia en todo cliente).
function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
