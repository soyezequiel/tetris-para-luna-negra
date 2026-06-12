import { Container } from '@pixi/display';
import { Graphics } from '@pixi/graphics';
import { Text, TextStyle } from '@pixi/text';

/**
 * JuiceFX — capa de "feel" sobre PixiJS portada del prototipo Juice Lab.
 *
 * Vive en su propio Container (no usa el effectLayer del renderer, que se limpia
 * cada frame en drawPanels). El renderer la crea, la añade al stage y llama a
 * update(geo) una vez por frame; JuiceFX calcula su propio dt.
 *
 * Coordenadas: todo se dibuja en el espacio del stage del renderer (mismo sistema
 * que boardX/boardY/cell), así que recibe la geometría del tablero cada frame.
 *
 * Intensidad: el prototipo está al máximo para demo. INTENSITY (~0.7) baja shake,
 * conteo de partículas y alpha de flashes para que el tablero siga legible. Subir
 * a 1 para igualar el prototipo; reducedMotion=true desactiva shake y reduce todo.
 */

export interface BoardGeometry {
  boardX: number;
  boardY: number;
  cell: number;
  columns: number;
  rows: number; // filas visibles
}

export interface JuiceFXOptions {
  intensity?: number;
  reducedMotion?: boolean;
}

const PALETTE = {
  cyan: 0x00f5ff,
  cyanSoft: 0xbfeeff,
  gold: 0xffcf4a,
  pink: 0xff2d8f,
  purple: 0xb06bff,
  warn: 0xffb24a,
  danger: 0xff3b52,
  red: 0xff5168,
  green: 0x39d49a,
  white: 0xffffff,
  ghost: 0x7a8794,
};

type Particle = {
  ring?: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: number;
  grav: number;
  shape: 'rect' | 'spark';
  rot: number;
  vr: number;
  // ring
  r?: number;
  rMax?: number;
  lw?: number;
};

type Projectile = {
  x: number;
  y: number;
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  t: number;
  dur: number;
  r: number;
  col: number;
  arc: number;
  trail: Array<{ x: number; y: number }>;
  onHit?: () => void;
};

type Popup = {
  text: Text;
  sub: Text;
  t: number;
  hold: number;
  inDur: number;
  outDur: number;
  baseSize: number;
  active: boolean;
};

type Point = { x: number; y: number };

const REF_CELL = 28; // celda de referencia del prototipo; escala velocidades/tamaños

export class JuiceFX {
  private readonly layer: Container;
  private readonly particleG = new Graphics(); // partículas + proyectiles (se limpia cada frame)
  private readonly overlayG = new Graphics(); // flash de tablero, glow, viñeta de peligro
  private readonly popup: Popup;

  private particles: Particle[] = [];
  private projectiles: Projectile[] = [];

  private last = performance.now();
  private shake = 0;
  private flash: { color: number; t: number; dur: number } | null = null;
  private glow: { color: number; t: number; dur: number; intensity: number } | null = null;
  private dangerLevel = 0;
  private dangerPhase = 0;
  private pendingGarbage = 0; // líneas de garbage entrante (telegraph en el borde)
  private garbagePhase = 0;
  // Countdown de top-out (pila sobre el techo): texto propio, separado del popup
  // para no pisar los carteles de combo/tetris.
  private readonly topOutText: Text;
  private topOutSeconds: number | null = null;
  private topOutPhase = 0;

  private intensity: number;
  private reducedMotion: boolean;
  private geo: BoardGeometry = { boardX: 0, boardY: 0, cell: REF_CELL, columns: 10, rows: 20 };

  constructor(layer: Container, options: JuiceFXOptions = {}) {
    this.layer = layer;
    this.intensity = options.intensity ?? 0.7;
    this.reducedMotion = options.reducedMotion ?? false;

    const mainStyle = new TextStyle({
      fill: 0xffffff,
      fontFamily: 'Arial Black, Arial, sans-serif',
      fontWeight: '900',
      fontSize: 64,
      letterSpacing: 1,
      dropShadow: true,
      dropShadowColor: 0x00f5ff,
      dropShadowBlur: 12,
      dropShadowDistance: 0,
      dropShadowAlpha: 0.9,
    });
    const subStyle = new TextStyle({
      fill: 0xffffff,
      fontFamily: 'Arial Black, Arial, sans-serif',
      fontWeight: '900',
      fontSize: 16,
      letterSpacing: 3,
    });
    const mainText = new Text('', mainStyle);
    const subText = new Text('', subStyle);
    mainText.anchor.set(0.5);
    subText.anchor.set(0.5);
    mainText.alpha = 0;
    subText.alpha = 0;
    this.popup = { text: mainText, sub: subText, t: 0, hold: 0, inDur: 0, outDur: 0, baseSize: 64, active: false };

    this.topOutText = new Text('', new TextStyle({
      fill: 0xff3b52,
      fontFamily: 'Arial Black, Arial, sans-serif',
      fontWeight: '900',
      fontSize: 56,
      letterSpacing: 2,
      dropShadow: true,
      dropShadowColor: 0xff3b52,
      dropShadowBlur: 14,
      dropShadowDistance: 0,
      dropShadowAlpha: 0.9,
    }));
    this.topOutText.anchor.set(0.5);
    this.topOutText.alpha = 0;

    this.layer.addChild(this.overlayG, this.particleG, mainText, subText, this.topOutText);
  }

  setIntensity(value: number): void {
    this.intensity = value;
  }
  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }

  /** Desplazamiento de shake que el renderer aplica a stage.position cada frame. */
  shakeOffset(): Point {
    if (this.reducedMotion || this.shake < 0.4) return { x: 0, y: 0 };
    const s = this.shake;
    return { x: (Math.random() * 2 - 1) * s, y: (Math.random() * 2 - 1) * s };
  }

  // ---------- lectores de geometría (para el conductor) ----------
  get columns(): number {
    return this.geo.columns;
  }
  get rows(): number {
    return this.geo.rows;
  }
  get cell(): number {
    return this.geo.cell;
  }

  // ---------- helpers de geometría ----------
  private get scale(): number {
    return this.geo.cell / REF_CELL;
  }
  private boardRect(): { x: number; y: number; w: number; h: number; cx: number; cy: number } {
    const w = this.geo.cell * this.geo.columns;
    const h = this.geo.cell * this.geo.rows;
    return { x: this.geo.boardX, y: this.geo.boardY, w, h, cx: this.geo.boardX + w / 2, cy: this.geo.boardY + h / 2 };
  }
  /** Punto en coordenadas de tablero (col, fila visible) -> pixeles del stage. */
  cellPoint(col: number, row: number): Point {
    return { x: this.geo.boardX + (col + 0.5) * this.geo.cell, y: this.geo.boardY + (row + 0.5) * this.geo.cell };
  }
  rightEdgePoint(): Point {
    const r = this.boardRect();
    return { x: r.x + r.w - 6, y: r.y + r.h * 0.4 };
  }

  // ---------- API pública de efectos ----------
  addShake(magnitude: number): void {
    if (this.reducedMotion) return;
    this.shake = Math.min(40, Math.max(this.shake, magnitude * this.intensity));
  }

  flashBoard(color: number, peak = 0.85, durSec = 0.36): void {
    this.flash = { color, t: 0, dur: durSec };
    this._flashPeak = peak * (this.reducedMotion ? 0.4 : this.intensity);
  }
  private _flashPeak = 0.85;

  boardGlow(color: number, intensity: number): void {
    this.glow = { color, t: 0, dur: 0.6, intensity };
  }

  setDanger(level: number): void {
    this.dangerLevel = Math.max(0, Math.min(1, level));
  }

  /** Garbage entrante pendiente (en líneas): dibuja un telegraph en el borde. */
  setPendingGarbage(lines: number): void {
    this.pendingGarbage = Math.max(0, Math.floor(lines));
  }

  /** Segundos restantes del timer de top-out (pila sobre el techo); null lo oculta. */
  setTopOutCountdown(secondsLeft: number | null): void {
    this.topOutSeconds = secondsLeft;
  }

  spawnBurst(
    x: number,
    y: number,
    n: number,
    color: number,
    opts: { spd?: number; life?: number; grav?: number; size?: number; up?: number; shape?: 'rect' | 'spark' } = {},
  ): void {
    const count = Math.max(1, Math.round(n * (this.reducedMotion ? 0.4 : this.intensity)));
    const sc = this.scale;
    const spd = (opts.spd ?? 240) * sc;
    const life = opts.life ?? 0.7;
    const grav = (opts.grav ?? 320) * sc;
    const size = (opts.size ?? 3.2) * sc;
    const up = (opts.up ?? 0) * sc;
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const s = spd * (0.3 + Math.random() * 0.9);
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - up,
        life: life * (0.6 + Math.random() * 0.7),
        max: life,
        size: size * (0.6 + Math.random() * 0.9),
        color,
        grav,
        shape: opts.shape ?? (Math.random() < 0.35 ? 'spark' : 'rect'),
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 12,
      });
    }
  }

  spawnLine(x: number, y: number, w: number, n: number, color: number): void {
    const count = Math.max(1, Math.round(n * (this.reducedMotion ? 0.4 : this.intensity)));
    const sc = this.scale;
    for (let i = 0; i < count; i += 1) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      const s = (160 + Math.random() * 360) * sc;
      this.particles.push({
        x: x + (Math.random() - 0.5) * w,
        y: y + (Math.random() - 0.5) * 8 * sc,
        vx: dir * s,
        vy: (Math.random() - 0.5) * 120 * sc,
        life: 0.5 + Math.random() * 0.5,
        max: 1,
        size: (2.5 + Math.random() * 3) * sc,
        color,
        grav: 120 * sc,
        shape: 'rect',
        rot: 0,
        vr: 0,
      });
    }
  }

  spawnRing(x: number, y: number, color: number, rMax: number): void {
    this.particles.push({ ring: true, x, y, r: 6, rMax: rMax * this.scale, life: 0.6, max: 0.6, color, lw: 4, vx: 0, vy: 0, size: 0, grav: 0, shape: 'rect', rot: 0, vr: 0 });
  }

  spawnProjectile(from: Point, to: Point, cfg: { r: number; col: number }, onHit?: () => void): void {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const dur = Math.max(0.16, Math.min(0.42, dist / 1700));
    this.projectiles.push({
      x: from.x,
      y: from.y,
      fx: from.x,
      fy: from.y,
      tx: to.x,
      ty: to.y,
      t: 0,
      dur,
      r: cfg.r * this.scale,
      col: cfg.col,
      arc: -Math.min(80, dist * 0.18),
      trail: [],
      onHit,
    });
  }

  showPopup(text: string, opts: { color?: number; sub?: string; big?: boolean; hold?: number } = {}): void {
    const col = opts.color ?? 0xffffff;
    const p = this.popup;
    p.baseSize = (opts.big ? 104 : 60) * Math.max(0.7, this.scale);
    p.text.text = text;
    p.text.style.fill = col;
    (p.text.style as TextStyle).dropShadowColor = col;
    p.sub.text = opts.sub ?? '';
    p.sub.style.fill = col;
    p.t = 0;
    p.inDur = 0.14;
    p.hold = opts.hold ?? (opts.big ? 0.48 : 0.28);
    p.outDur = 0.16;
    p.active = true;
  }

  reset(): void {
    this.particles = [];
    this.projectiles = [];
    this.shake = 0;
    this.flash = null;
    this.glow = null;
    this.dangerLevel = 0;
    this.dangerPhase = 0;
    this.pendingGarbage = 0;
    this.garbagePhase = 0;
    this.topOutSeconds = null;
    this.topOutText.alpha = 0;
    this.popup.active = false;
    this.popup.text.alpha = 0;
    this.popup.sub.alpha = 0;
    this.particleG.clear();
    this.overlayG.clear();
  }

  // ---------- bucle por frame ----------
  update(geo: BoardGeometry): void {
    this.geo = geo;
    const now = performance.now();
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.05) dt = 0.05;
    if (dt < 0) dt = 0;

    this.shake *= Math.exp(-dt * 9);

    this.particleG.clear();
    this.overlayG.clear();

    this.drawOverlays(dt);
    this.updateProjectiles(dt);
    this.updateParticles(dt);
    this.updatePopup(dt);
    this.updateTopOutCountdown(dt);
  }

  // Número rojo latiente sobre la parte alta del tablero mientras corre el timer
  // de gracia de top-out. Separado del popup para no pisar combos/tetris.
  private updateTopOutCountdown(dt: number): void {
    const t = this.topOutText;
    if (this.topOutSeconds === null) {
      t.alpha = 0;
      this.topOutPhase = 0;
      return;
    }
    const r = this.boardRect();
    this.topOutPhase += dt * 3;
    const beat = 0.72 + 0.28 * Math.abs(Math.sin(this.topOutPhase * Math.PI));
    t.text = `${this.topOutSeconds}`;
    t.position.set(r.cx, r.y + r.h * 0.16);
    t.scale.set(Math.max(0.7, this.scale) * beat);
    t.alpha = 0.9;
  }

  // ---------- internos ----------
  private drawOverlays(dt: number): void {
    const r = this.boardRect();
    const g = this.overlayG;

    // flash de tablero (sube y baja)
    if (this.flash) {
      this.flash.t += dt;
      const k = this.flash.t / this.flash.dur;
      if (k >= 1) {
        this.flash = null;
      } else {
        // pico al 15% como en el prototipo
        const a = k < 0.15 ? (k / 0.15) * this._flashPeak : (1 - (k - 0.15) / 0.85) * this._flashPeak;
        g.beginFill(this.flash.color, Math.max(0, a));
        g.drawRect(r.x, r.y, r.w, r.h);
        g.endFill();
      }
    }

    // glow de marco (borde brillante que late)
    if (this.glow) {
      this.glow.t += dt;
      const k = this.glow.t / this.glow.dur;
      if (k >= 1) {
        this.glow = null;
      } else {
        const a = Math.sin(Math.min(1, k) * Math.PI) * 0.8 * this.intensity;
        const lw = 2 + this.glow.intensity * 4;
        g.lineStyle(lw, this.glow.color, Math.max(0, a));
        g.drawRect(r.x, r.y, r.w, r.h);
        g.lineStyle(0, 0, 0);
      }
    }

    // viñeta de peligro: bordes rojos que laten, escala con la altura de la pila
    if (this.dangerLevel > 0.02 && !this.reducedMotion) {
      this.dangerPhase += dt * (1.0 + this.dangerLevel * 2.0);
      const beat = Math.pow(Math.max(0, Math.sin(this.dangerPhase * Math.PI * 2)), 1.6);
      const a = this.dangerLevel * 0.32 + this.dangerLevel * 0.52 * beat;
      const bands = 5;
      const band = this.geo.cell * 1.4;
      for (let i = 0; i < bands; i += 1) {
        const t = i / (bands - 1);
        const inset = t * band;
        const alpha = a * (1 - t) * 0.5;
        g.lineStyle(this.geo.cell * 0.4, PALETTE.danger, Math.max(0, alpha));
        g.drawRect(r.x + inset, r.y + inset, r.w - inset * 2, r.h - inset * 2);
      }
      g.lineStyle(2, 0xff3c50, a * 0.7);
      g.drawRect(r.x, r.y, r.w, r.h);
      g.lineStyle(0, 0, 0);
    }

    // telegraph de garbage entrante: barra vertical en el borde izquierdo del
    // tablero que crece con las líneas pendientes y late para avisar del ataque.
    if (this.pendingGarbage > 0) {
      this.garbagePhase += dt * 6;
      const cap = Math.max(1, this.geo.rows);
      const shown = Math.min(this.pendingGarbage, cap);
      const barW = Math.max(3, this.geo.cell * 0.26);
      const barH = (r.h * shown) / cap;
      const barY = r.y + r.h - barH;
      const pulse = 0.55 + 0.45 * Math.abs(Math.sin(this.garbagePhase));
      const col = this.pendingGarbage >= 4 ? PALETTE.danger : PALETTE.warn;
      g.beginFill(col, 0.5 * pulse);
      g.drawRect(r.x, barY, barW, barH);
      g.endFill();
      // separadores por línea pendiente + arista superior brillante
      g.lineStyle(Math.max(1, this.geo.cell * 0.04), 0x120608, 0.5);
      for (let i = 1; i < shown; i += 1) {
        const yy = r.y + r.h - (r.h * i) / cap;
        g.moveTo(r.x, yy);
        g.lineTo(r.x + barW, yy);
      }
      g.lineStyle(Math.max(1, this.geo.cell * 0.06), PALETTE.white, 0.7 * pulse);
      g.moveTo(r.x, barY);
      g.lineTo(r.x + barW, barY);
      g.lineStyle(0, 0, 0);
    }
  }

  private updateProjectiles(dt: number): void {
    const g = this.particleG;
    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const p = this.projectiles[i];
      p.t += dt / p.dur;
      const e = Math.min(1, p.t);
      const ee = e * e; // acelera
      p.x = p.fx + (p.tx - p.fx) * ee;
      p.y = p.fy + (p.ty - p.fy) * ee + p.arc * Math.sin(Math.PI * e);
      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > 14) p.trail.shift();

      for (let k = 0; k < p.trail.length; k += 1) {
        const tp = p.trail[k];
        const a = k / p.trail.length;
        g.beginFill(p.col, a * 0.6);
        g.drawCircle(tp.x, tp.y, Math.max(0.5, p.r * a * 0.8));
        g.endFill();
      }
      g.beginFill(PALETTE.white, 1);
      g.drawCircle(p.x, p.y, p.r);
      g.endFill();
      g.beginFill(p.col, 0.4);
      g.drawCircle(p.x, p.y, p.r * 1.5);
      g.endFill();

      if (p.t >= 1) {
        if (p.onHit) p.onHit();
        this.projectiles.splice(i, 1);
      }
    }
  }

  private updateParticles(dt: number): void {
    const g = this.particleG;
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      if (p.ring) {
        const k = 1 - p.life / p.max;
        p.r = 6 + ((p.rMax ?? 200) - 6) * (k * (2 - k));
        const alpha = (p.life / p.max) * 0.8;
        g.lineStyle((p.lw ?? 4) * (1 - k * 0.6), p.color, Math.max(0, alpha));
        g.drawCircle(p.x, p.y, p.r ?? 6);
        g.lineStyle(0, 0, 0);
        continue;
      }
      p.vx *= Math.exp(-dt * 1.6);
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const alpha = Math.min(1, Math.max(0, p.life / p.max) * 1.4);
      g.beginFill(p.color, alpha);
      if (p.shape === 'spark') {
        const ang = Math.atan2(p.vy, p.vx);
        this.drawRotatedRect(g, p.x, p.y, p.size * 4, p.size * 0.7, ang);
      } else {
        this.drawRotatedRect(g, p.x, p.y, p.size, p.size, p.rot);
      }
      g.endFill();
    }
  }

  private drawRotatedRect(g: Graphics, cx: number, cy: number, w: number, h: number, ang: number): void {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const hw = w / 2;
    const hh = h / 2;
    const pts = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ].map(([px, py]) => ({ x: cx + px * c - py * s, y: cy + px * s + py * c }));
    g.moveTo(pts[0].x, pts[0].y);
    g.lineTo(pts[1].x, pts[1].y);
    g.lineTo(pts[2].x, pts[2].y);
    g.lineTo(pts[3].x, pts[3].y);
    g.closePath();
  }

  private updatePopup(dt: number): void {
    const p = this.popup;
    if (!p.active) return;
    const r = this.boardRect();
    p.text.position.set(r.cx, r.cy);
    p.sub.position.set(r.cx, r.cy + p.baseSize * 0.65);
    p.t += dt;

    const total = p.inDur + p.hold + p.outDur;
    if (p.t >= total) {
      p.active = false;
      p.text.alpha = 0;
      p.sub.alpha = 0;
      return;
    }
    let scale: number;
    let alpha: number;
    if (p.t < p.inDur) {
      const k = p.t / p.inDur;
      // overshoot 0.4 -> 1.14 -> 1
      scale = k < 0.55 ? 0.4 + (1.14 - 0.4) * (k / 0.55) : 1.14 - (1.14 - 1) * ((k - 0.55) / 0.45);
      alpha = Math.min(1, k * 1.6);
    } else if (p.t < p.inDur + p.hold) {
      scale = 1;
      alpha = 1;
    } else {
      const k = (p.t - p.inDur - p.hold) / p.outDur;
      scale = 1 + 0.4 * k;
      alpha = 1 - k;
    }
    const s = (p.baseSize / 64) * scale;
    p.text.scale.set(s);
    // 50% de transparencia: los carteles no deben tapar el tablero.
    p.text.alpha = alpha * 0.5;
    p.sub.alpha = p.sub.text ? alpha * 0.5 : 0;
    const ss = (p.baseSize / 64) * (0.9 + 0.1 * scale);
    p.sub.scale.set(ss);
  }
}

export { PALETTE as JUICE_PALETTE };
