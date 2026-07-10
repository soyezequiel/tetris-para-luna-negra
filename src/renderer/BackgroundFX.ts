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

import { benchTime } from '../dev/benchCounters';

export type BgStyle = 'aurora' | 'bruma' | 'marea';

const STYLES: BgStyle[] = ['aurora', 'bruma', 'marea'];
const TRANSITION_SECONDS = 0.9; // crossfade entre fondos al cambiar de partida

interface Blob {
  color: [number, number, number];
  x: number; y: number; r: number;
  sx: number; sy: number; px: number; py: number;
  sprite: HTMLCanvasElement;
}
interface Halo { x: number; y: number; sprite: HTMLCanvasElement; }
interface Particle { x: number; y: number; r: number; speed: number; tw: number; }

// r,g,b, alpha del centro, x, y (fracciones del viewport) de los halos del estilo "bruma".
const HALO_SPECS: [number, number, number, number, number, number][] = [
  [60, 150, 160, 0.16, 0.3, 0.35], [110, 90, 160, 0.14, 0.72, 0.6],
];

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
  // main thread para el loop de Pixi del juego.
  private readonly drawInterval = 1000 / 30;
  // Capas HORNEADAS. Rasterizar un gradiente es caro en Firefox (lo hace en CPU, mientras
  // que Chrome lo resuelve en GPU): medido, un draw() con gradientes en vivo costaba ~6ms de
  // main thread en Firefox contra ~0.05ms en Chrome, y 6ms > el frame entero de un monitor
  // de 180Hz. La solución es rasterizar CADA gradiente UNA vez (a un canvas offscreen) y
  // luego solo blittear esas imágenes con drawImage, que sí es rápido en ambos.
  //   - baseLayer/vignetteLayer: dependen solo del tamaño → se rehornean por resize.
  //   - blobSprites/haloSprites/particleSprite: dependen solo del color → se hornean una vez
  //     y se estiran con drawImage (son manchas difusas: el escalado no se nota).
  private baseLayer: HTMLCanvasElement | null = null;
  private vignetteLayer: HTMLCanvasElement | null = null;
  private particleSprite: HTMLCanvasElement | null = null;
  private readonly mareaGrads = new Map<string, CanvasGradient>();
  // Alpha del crossfade en curso: los sprites que además modulan su propio alpha (partículas)
  // deben multiplicarlo, porque drawImage no compone dos globalAlpha.
  private layerAlpha = 1;
  // Repintar solo cuando el cuadro cambia de verdad. Con el movimiento apagado y sin
  // peligro/transición el fondo es estático: repintarlo 30×/s sería costo puro tirado.
  // Eventos puntuales (resize, semilla nueva, (re)activar) marcan dirty para un repinte.
  private dirty = true;

  private blobs: Blob[] = [];
  private halos: Halo[] = [];
  private particles: Particle[] = [];

  // Peligro (0..1): oscurece el fondo de la página conforme sube la pila. Se
  // suaviza hacia el objetivo para que el cambio sea gradual, no un parpadeo.
  private danger = 0;
  private dangerTarget = 0;
  private dangerCritical = false;
  // Freeze de perf (móvil en juego): congela el repintado por movimiento ambiente. Ver setPerfFreeze.
  private perfFreeze = false;

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
    this.dirty = true;
    const next = this.styleForSeed(s);
    if (!this.hasSeed || this.reducedMotion) {
      // Primera partida o "reducir movimiento": sin crossfade.
      this.hasSeed = true;
      this.curStyle = next;
      this.transStyle = null;
      this.transP = 0;
      return;
    }
    this.dirty = true;
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
    const target = Math.max(0, Math.min(1, level));
    if (target !== this.dangerTarget || critical !== this.dangerCritical) this.dirty = true;
    this.dangerTarget = target;
    this.dangerCritical = critical;
  }

  setMotion(enabled: boolean): void { this.motion = enabled; this.dirty = true; }

  // Congela el MOVIMIENTO ambiente a un cuadro estático (sin avanzar this.t ni repintar por
  // animación). Para móvil en juego activo: un canvas estático se re-compone barato (textura
  // cacheada en GPU); lo caro es re-rasterizar+subir el fondo fullscreen ~30×/s, y eso es lo
  // que atrasa el rAF/compositor → jitter de pacing. El crossfade de semilla (partida nueva)
  // y el oscurecido por peligro NO se congelan: son transiciones puntuales y relevantes.
  setPerfFreeze(freeze: boolean): void {
    if (freeze === this.perfFreeze) return;
    this.perfFreeze = freeze;
    this.dirty = true; // un último repintado para asentar el cuadro al entrar/salir del freeze
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.dirty = true;
    this.canvas.style.display = enabled ? 'block' : 'none';
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResize);
    this.canvas.remove();
  }

  // Escena + sprites. Cada mancha se rasteriza UNA vez a una textura; el bucle de dibujo solo
  // hace drawImage, que es lo que mantiene barato el fondo (ver comentario de baseLayer).
  private initScene(): void {
    const blobCols: [number, number, number][] = [
      [46, 150, 150], [60, 110, 180], [86, 80, 170], [120, 90, 165], [40, 120, 140],
    ];
    this.blobs = blobCols.map((c, i) => ({
      color: c,
      x: 0.18 + i * 0.17, y: 0.22 + (i % 3) * 0.26,
      r: 0.42 + (i % 3) * 0.12,
      sx: 0.05 + i * 0.013, sy: 0.04 + i * 0.011, px: i * 1.7, py: i * 2.3,
      sprite: radialSprite([
        [0, `rgba(${c[0]},${c[1]},${c[2]},0.20)`],
        [0.5, `rgba(${c[0]},${c[1]},${c[2]},0.08)`],
        [1, `rgba(${c[0]},${c[1]},${c[2]},0)`],
      ]),
    }));
    this.halos = HALO_SPECS.map(([cr, cg, cb, a, x, y]) => ({
      x, y,
      sprite: radialSprite([
        [0, `rgba(${cr},${cg},${cb},${a})`],
        [1, `rgba(${cr},${cg},${cb},0)`],
      ]),
    }));
    this.particleSprite = radialSprite([
      [0, 'rgba(170,210,220,1)'],
      [1, 'rgba(170,210,220,0)'],
    ]);
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
    const pxW = Math.max(1, Math.round(w * dpr));
    const pxH = Math.max(1, Math.round(h * dpr));
    // Rehornear las capas aloca dos canvas del tamaño del viewport, y `resize` llega en ráfaga
    // mientras se arrastra el borde de la ventana: sólo rehorneamos si el tamaño en píxeles
    // del canvas cambió de verdad (asignar canvas.width lo limpia aunque el valor sea el mismo).
    const sameSize = pxW === this.canvas.width && pxH === this.canvas.height && this.baseLayer !== null;
    this.width = w; this.height = h;
    if (sameSize) return;
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.buildGradients();
    this.dirty = true;
  }

  // Capas de fondo/viñeta: dependen solo del tamaño, así que se rasterizan una vez por resize
  // a un canvas offscreen y después se blittean. Se hornean a la resolución REAL del canvas
  // (device px) para que el blit sea 1:1 y no reescale.
  private buildGradients(): void {
    const { width: W, height: H } = this;
    this.mareaGrads.clear(); // dependen del alto del viewport
    const scaleX = this.canvas.width / Math.max(1, W);
    const scaleY = this.canvas.height / Math.max(1, H);

    this.baseLayer = bakeLayer(this.canvas.width, this.canvas.height, (c) => {
      c.setTransform(scaleX, 0, 0, scaleY, 0, 0);
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#080d16'); g.addColorStop(0.55, '#0a111c'); g.addColorStop(1, '#05090f');
      c.fillStyle = g; c.fillRect(0, 0, W, H);
    });

    this.vignetteLayer = bakeLayer(this.canvas.width, this.canvas.height, (c) => {
      c.setTransform(scaleX, 0, 0, scaleY, 0, 0);
      const v = c.createRadialGradient(W / 2, H * 0.46, Math.min(W, H) * 0.18, W / 2, H * 0.5, Math.max(W, H) * 0.72);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(2,4,8,0.62)');
      c.fillStyle = v; c.fillRect(0, 0, W, H);
    });
  }


  private loop(): void {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    // El usuario puede apagar el movimiento del fondo del todo (this.motion=false).
    // Si solo está activo "reducir movimiento" del sistema, NO lo congelamos: el fondo
    // es difuso y lento (no es el tipo de animación que marea), así que lo dejamos
    // derivar a una fracción de la velocidad en vez de quedar estático.
    // perfFreeze (móvil en juego) congela SOLO el movimiento ambiente: no avanza this.t ni
    // dispara repintados por animación. El crossfade de semilla y el peligro siguen vivos.
    const motionLive = this.motion && !this.perfFreeze;
    if (motionLive) this.t += this.reducedMotion ? dt * 0.3 : dt;
    // Suavizado del peligro hacia su objetivo (~constante de tiempo de ~0.25s).
    this.danger += (this.dangerTarget - this.danger) * Math.min(1, dt * 4);
    if (this.transStyle) {
      this.transP += dt / TRANSITION_SECONDS;
      if (this.transP >= 1) { this.curStyle = this.transStyle; this.transStyle = null; this.transP = 0; }
    }
    // ¿El cuadro cambia respecto del anterior? Solo entonces vale la pena repintar.
    //  - motion: el fondo se está animando (this.t avanzó).
    //  - transStyle: crossfade entre estilos en curso.
    //  - danger asentándose, o latido crítico (que usa this.t, solo vivo con motion).
    // Con el movimiento apagado y sin peligro el fondo es estático: repintarlo a pantalla
    // completa 30×/s sería costo puro tirado.
    const dangerLive = Math.abs(this.dangerTarget - this.danger) > 0.002
      || (this.danger > 0.01 && this.dangerCritical && motionLive);
    const animating = motionLive || this.transStyle !== null || dangerLive;
    // Throttle del fondo a ~30fps (ver drawInterval). El loop de rAF sigue a 60 para
    // mantener this.t suave, pero solo repintamos cada ~33ms.
    if (this.enabled && (this.dirty || animating) && now - this.lastDraw >= this.drawInterval - 4) {
      this.lastDraw = now;
      this.dirty = false;
      benchTime('bg:draw', () => this.draw());
    }
    this.rafId = requestAnimationFrame(() => this.loop());
  }

  private draw(): void {
    const ctx = this.ctx, { width: W, height: H } = this;
    if (!this.baseLayer || !this.vignetteLayer) this.buildGradients();
    ctx.drawImage(this.baseLayer!, 0, 0, W, H);

    ctx.globalCompositeOperation = 'screen';
    if (this.transStyle) {
      const f = Math.min(1, this.transP);
      this.runBg(this.curStyle, 1 - f);
      this.runBg(this.transStyle, f);
    } else {
      this.runBg(this.curStyle, 1);
    }
    ctx.globalCompositeOperation = 'source-over';

    // Viñeta: concentra la mirada en el tablero (capa horneada).
    ctx.drawImage(this.vignetteLayer!, 0, 0, W, H);

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
    this.layerAlpha = a;
    ctx.globalAlpha = a;
    if (style === 'aurora') this.bgAurora();
    else if (style === 'bruma') this.bgBruma();
    else this.bgMarea();
    ctx.globalAlpha = 1;
    this.layerAlpha = 1;
  }

  private bgAurora(): void {
    const ctx = this.ctx, { width: W, height: H, t } = this, m = Math.min(W, H);
    for (const b of this.blobs) {
      const x = b.x * W + Math.sin(t * b.sx * 6.28 + b.px) * W * 0.13;
      const y = b.y * H + Math.cos(t * b.sy * 6.28 + b.py) * H * 0.11;
      const r = b.r * m * (0.92 + 0.08 * Math.sin(t * 0.4 + b.px));
      ctx.drawImage(b.sprite, x - r, y - r, r * 2, r * 2);
    }
  }

  private bgBruma(): void {
    const ctx = this.ctx, { width: W, height: H, t } = this;
    for (const h of this.halos) {
      const x = h.x * W + Math.sin(t * 0.12 + h.x * 4) * W * 0.05, y = h.y * H, r = Math.min(W, H) * 0.6;
      ctx.drawImage(h.sprite, x - r, y - r, r * 2, r * 2);
    }
    // Las partículas comparten un único sprite (mismo color); su alpha variable se aplica con
    // globalAlpha, multiplicado por el del crossfade en curso.
    const glow = this.particleSprite!;
    for (const p of this.particles) {
      const py = (((p.y - t * p.speed) % 1) + 1) % 1, x = p.x * W, y = py * H;
      const tw = 0.5 + 0.5 * Math.sin(t * 0.8 + p.tw), a = 0.05 + 0.07 * tw, r = p.r * (1 + 0.2 * tw);
      ctx.globalAlpha = a * this.layerAlpha;
      ctx.drawImage(glow, x - r * 4, y - r * 4, r * 8, r * 8);
    }
    ctx.globalAlpha = this.layerAlpha;
  }

  private bgMarea(): void {
    const ctx = this.ctx, { width: W, height: H, t } = this;
    for (const [cr, cg, cb, baseY, amp, spd] of MAREA_BANDS) {
      const by = baseY * H, a = amp * H;
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 14) {
        const y = by + Math.sin((x / W) * 6.28 * 1.4 + t * spd) * a + Math.sin((x / W) * 6.28 * 0.5 - t * spd * 0.6) * a * 0.5;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H); ctx.closePath();
      // La onda cambia cada frame, pero su gradiente vertical no: se cachea por banda+alto.
      const key = `marea:${cr},${cg},${cb}:${by.toFixed(0)}:${a.toFixed(0)}:${H.toFixed(0)}`;
      let lg = this.mareaGrads.get(key);
      if (!lg) {
        lg = ctx.createLinearGradient(0, by - a, 0, H);
        lg.addColorStop(0, `rgba(${cr},${cg},${cb},0.16)`); lg.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        this.mareaGrads.set(key, lg);
      }
      ctx.fillStyle = lg; ctx.fill();
    }
  }
}

// Lado en píxeles de los sprites horneados. Son manchas difusas: 256 alcanza de sobra aunque
// se estiren a media pantalla, y mantiene la textura chica (rápida de subir a GPU).
const SPRITE_PX = 256;

const MAREA_BANDS: [number, number, number, number, number, number][] = [
  [50, 150, 142, 0.30, 0.05, 1.0], [90, 84, 168, 0.38, 0.10, 0.8],
  [126, 88, 158, 0.55, 0.07, 1.3], [44, 118, 134, 0.72, 0.06, 0.65],
];

// Rasteriza `paint` una vez a un canvas offscreen reutilizable.
function bakeLayer(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  paint(canvas.getContext('2d')!);
  return canvas;
}

// Mancha circular con un gradiente radial horneado. Se dibuja centrada en una textura cuadrada
// de SPRITE_PX y después se estira al radio que toque: como es una mancha difusa de alpha bajo,
// el reescalado no se nota (verificado contra el render con gradientes en vivo).
function radialSprite(stops: [number, string][]): HTMLCanvasElement {
  return bakeLayer(SPRITE_PX, SPRITE_PX, (c) => {
    const r = SPRITE_PX / 2;
    const g = c.createRadialGradient(r, r, 0, r, r, r);
    for (const [offset, color] of stops) g.addColorStop(offset, color);
    c.fillStyle = g; c.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
  });
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
