// PayoutCelebration — festejo de "pago recibido" para TETRA.
//
// Overlay full-screen, sin dependencias, vanilla TS. Lluvia de monedas de
// satoshi (escalada al monto), contador con roll-up, luces de fondo y un
// sonido sci-fi mayor/triunfal (Web Audio, sin archivos). Pensado para
// dispararse cuando una apuesta se liquida a favor del jugador local.
//
// Uso:
//   import { celebratePayout } from './effects/PayoutCelebration';
//   const fx = celebratePayout({ sats: myPayout });
//   // fx.close() para cerrarlo programáticamente.
//
// El sprite de la moneda se sirve desde public/: coinSrc por defecto
// '/moneda-satoshi.png'. Copiá moneda-satoshi.png a tetris/public/.

export interface PayoutCelebrationOptions {
  /** Monto ganado en sats — controla cuántas monedas caen y la intensidad. */
  sats: number;
  /** Sats que "llenan la pantalla" (intensidad máxima). Default 50 000. */
  satsForMax?: number;
  /** Tope duro de monedas, para no reventar el rendimiento. Default 220. */
  maxCoins?: number;
  /** Reproducir sonido. Default true. */
  sound?: boolean;
  /** Texto grande. Default '¡GANASTE!'. */
  headline?: string;
  /** Badge superior. Default 'Pago recibido'. */
  badgeLabel?: string;
  /** Botón de cierre. Default 'Continuar'. */
  continueLabel?: string;
  /** URL del sprite de moneda. Default '/moneda-satoshi.png'. */
  coinSrc?: string;
  /** Dónde montar el overlay. Default document.body. */
  mount?: HTMLElement;
  /** z-index del overlay. Default 9999. */
  zIndex?: number;
  /** Callback al cerrar (botón, click fuera o cierre programático). */
  onClose?: () => void;
}

export interface PayoutCelebrationHandle {
  /** Cierra y limpia el festejo. */
  close: () => void;
}

interface Part {
  kind: 'coin' | 'conf' | 'orb';
  x: number; y: number; vx: number; vy: number;
  delay: number; born: boolean;
  // coin / conf
  r?: number; spin?: number; spinV?: number; tilt?: number;
  w?: number; h?: number; col?: string;
  // orb
  ph?: number; phV?: number;
}

const KEYFRAMES_ID = 'tetra-payout-keyframes';
const KEYFRAMES = `
@keyframes tetra-spin { from { transform: translate(-50%,-50%) rotate(0deg); } to { transform: translate(-50%,-50%) rotate(360deg); } }
@keyframes tetra-spinrev { from { transform: translate(-50%,-50%) rotate(360deg); } to { transform: translate(-50%,-50%) rotate(0deg); } }
@keyframes tetra-glowpulse { 0%,100% { opacity:.5; transform:scale(1);} 50% { opacity:.9; transform:scale(1.08);} }
@keyframes tetra-badgepulse { 0%,100% { opacity:.85; transform:translateX(-50%) scale(1);} 50% { opacity:1; transform:translateX(-50%) scale(1.05);} }
@keyframes tetra-btnglow { 0%,100% { box-shadow:0 0 0 0 rgba(34,211,238,0), 0 8px 24px rgba(0,0,0,.5);} 50% { box-shadow:0 0 26px 2px rgba(34,211,238,.55), 0 8px 24px rgba(0,0,0,.5);} }
@keyframes tetra-headshine { 0% { background-position:-160% 0;} 100% { background-position:260% 0;} }
@keyframes tetra-fadein { from { opacity:0;} to { opacity:1;} }
`;

function ensureKeyframes(): void {
  if (document.getElementById(KEYFRAMES_ID)) return;
  const style = document.createElement('style');
  style.id = KEYFRAMES_ID;
  style.textContent = KEYFRAMES;
  document.head.appendChild(style);
}

export class PayoutCelebration implements PayoutCelebrationHandle {
  private readonly opts: Required<Omit<PayoutCelebrationOptions, 'onClose' | 'mount'>> & {
    onClose?: () => void; mount: HTMLElement;
  };
  private root!: HTMLDivElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private cardEl!: HTMLElement;
  private counterEl!: HTMLElement;
  private raysEl!: HTMLElement;
  private rays2El!: HTMLElement;
  private glowEl!: HTMLElement;
  private bloomEl!: HTMLElement;
  private flashEl!: HTMLElement;

  private coinImg: HTMLImageElement;
  private coinReady = false;
  private soundOn: boolean;

  private parts: Part[] = [];
  private raf = 0;
  private t0 = 0;
  private last = 0;
  private duration = 0;
  private intensity = 0;
  private W = 0;
  private H = 0;
  private closed = false;

  // audio
  private actx?: AudioContext;
  private master?: GainNode;
  private busIn?: GainNode;
  private reverbIn?: ConvolverNode;
  private resumeHandler = (): void => {
    if (this.actx && this.actx.state === 'suspended') void this.actx.resume();
  };
  private onResize = (): void => this.layout();

  constructor(options: PayoutCelebrationOptions) {
    this.opts = {
      sats: options.sats,
      satsForMax: options.satsForMax ?? 50_000,
      maxCoins: options.maxCoins ?? 220,
      sound: options.sound ?? true,
      headline: options.headline ?? '¡GANASTE!',
      badgeLabel: options.badgeLabel ?? 'Pago recibido',
      continueLabel: options.continueLabel ?? 'Continuar',
      coinSrc: options.coinSrc ?? '/moneda-satoshi.png',
      zIndex: options.zIndex ?? 9999,
      onClose: options.onClose,
      mount: options.mount ?? document.body,
    };
    this.soundOn = this.opts.sound;

    this.coinImg = new Image();
    this.coinImg.onload = () => { this.coinReady = true; };
    this.coinImg.src = this.opts.coinSrc;

    ensureKeyframes();
    this.build();
    window.addEventListener('pointerdown', this.resumeHandler);
    window.addEventListener('resize', this.onResize);
    // arranca tras un par de frames para que el layout esté listo
    requestAnimationFrame(() => requestAnimationFrame(() => this.run()));
  }

  // ---------------------------------------------------------------- DOM
  private build(): void {
    const root = document.createElement('div');
    root.setAttribute('data-tetra-payout', '');
    root.style.cssText = `position:fixed; inset:0; z-index:${this.opts.zIndex}; overflow:hidden;
      font-family:'Exo 2', system-ui, sans-serif; animation:tetra-fadein .25s ease both;
      background:radial-gradient(120% 120% at 50% -10%, rgba(11,18,32,.62) 0%, rgba(5,8,12,.82) 60%, rgba(3,5,10,.9) 100%);`;

    root.innerHTML = `
      <div data-glow style="position:absolute; inset:0; pointer-events:none; opacity:0; mix-blend-mode:screen; background:
        radial-gradient(40% 50% at 18% 24%, rgba(34,211,238,.5) 0%, rgba(34,211,238,0) 60%),
        radial-gradient(42% 52% at 84% 30%, rgba(192,132,252,.5) 0%, rgba(192,132,252,0) 60%),
        radial-gradient(46% 54% at 26% 82%, rgba(244,114,182,.42) 0%, rgba(244,114,182,0) 62%),
        radial-gradient(44% 52% at 80% 80%, rgba(255,152,0,.42) 0%, rgba(255,152,0,0) 62%);
        animation:tetra-glowpulse 2.6s ease-in-out infinite;"></div>
      <div data-bloom style="position:absolute; top:60%; left:50%; width:120vmax; height:120vmax; transform:translate(-50%,-50%); pointer-events:none; opacity:0; mix-blend-mode:screen; background:radial-gradient(circle, rgba(255,210,120,.55) 0%, rgba(255,170,40,.18) 22%, rgba(255,170,40,0) 50%);"></div>
      <canvas data-canvas style="position:absolute; inset:0; width:100%; height:100%; display:block;"></canvas>
      <div data-rays style="position:absolute; top:46%; left:50%; width:170vmax; height:170vmax; transform:translate(-50%,-50%); pointer-events:none; opacity:0; mix-blend-mode:screen; background:conic-gradient(from 0deg, rgba(247,201,72,0) 0deg, rgba(247,201,72,.2) 5deg, rgba(247,201,72,0) 11deg, rgba(34,211,238,0) 28deg, rgba(34,211,238,.17) 34deg, rgba(34,211,238,0) 40deg, rgba(192,132,252,0) 58deg, rgba(192,132,252,.17) 64deg, rgba(192,132,252,0) 70deg); animation:tetra-spin 20s linear infinite;"></div>
      <div data-rays2 style="position:absolute; top:46%; left:50%; width:150vmax; height:150vmax; transform:translate(-50%,-50%); pointer-events:none; opacity:0; mix-blend-mode:screen; background:conic-gradient(from 18deg, rgba(244,114,182,0) 0deg, rgba(244,114,182,.14) 4deg, rgba(244,114,182,0) 9deg, rgba(127,233,255,0) 24deg, rgba(127,233,255,.14) 29deg, rgba(127,233,255,0) 34deg); animation:tetra-spinrev 26s linear infinite;"></div>
      <div data-flash style="position:absolute; inset:0; pointer-events:none; opacity:0; background:radial-gradient(circle at 50% 58%, rgba(255,255,255,.9), rgba(255,236,180,.6) 35%, rgba(255,236,180,0) 70%);"></div>
      <div data-card style="position:absolute; top:46%; left:50%; transform:translate(-50%,-50%); width:min(86%,560px); padding:38px 30px 30px; text-align:center; opacity:0;">
        <div style="position:absolute; inset:-12% -8%; z-index:-1; background:radial-gradient(60% 55% at 50% 48%, rgba(5,8,12,.82) 0%, rgba(5,8,12,.6) 45%, rgba(5,8,12,0) 78%); pointer-events:none;"></div>
        <div style="position:absolute; top:-16px; left:50%; transform:translateX(-50%); padding:7px 18px; border-radius:999px; background:linear-gradient(180deg,#12203a,#0a1326); border:1px solid rgba(34,211,238,.5); color:#7fe9ff; font-weight:800; font-size:13px; letter-spacing:.28em; text-transform:uppercase; white-space:nowrap; animation:tetra-badgepulse 1.8s ease-in-out infinite; box-shadow:0 0 18px rgba(34,211,238,.25);">${escapeHtml(this.opts.badgeLabel)}</div>
        <h1 style="margin:14px 0 6px; font-family:'Arial Black','Exo 2',sans-serif; font-weight:900; font-style:italic; font-size:clamp(46px,8.5vw,86px); line-height:.92; letter-spacing:-.01em; text-transform:uppercase; background:linear-gradient(110deg,#f7c948 0%,#fff6cf 22%,#f7c948 40%,#ffe79a 60%,#f7c948 100%); background-size:220% 100%; -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; filter:drop-shadow(0 4px 18px rgba(247,201,72,.35)); animation:tetra-headshine 3.4s linear infinite;">${escapeHtml(this.opts.headline)}</h1>
        <div style="display:flex; align-items:baseline; justify-content:center; gap:14px; margin-top:10px;">
          <img src="${escapeAttr(this.opts.coinSrc)}" alt="satoshi" style="width:clamp(46px,6.4vw,64px); height:clamp(46px,6.4vw,64px); flex:none; filter:drop-shadow(0 0 16px rgba(255,152,0,.55));">
          <span data-counter style="font-family:'Arial Black','Exo 2',sans-serif; font-weight:900; font-variant-numeric:tabular-nums; font-size:clamp(52px,10vw,108px); line-height:1; color:#fff; text-shadow:0 0 24px rgba(247,201,72,.45);">0</span>
        </div>
        <div style="margin-top:8px; font-size:clamp(13px,1.6vw,17px); font-weight:600; letter-spacing:.34em; text-transform:uppercase; color:rgba(247,237,242,.62);">satoshis</div>
        <button type="button" data-continue style="margin-top:30px; padding:15px 50px; border:none; border-radius:12px; cursor:pointer; font-family:'Exo 2',sans-serif; font-weight:800; font-size:17px; letter-spacing:.06em; text-transform:uppercase; color:#04121a; background:linear-gradient(180deg,#7fe9ff,#22d3ee); animation:tetra-btnglow 2.4s ease-in-out infinite;">${escapeHtml(this.opts.continueLabel)}</button>
      </div>
      <button type="button" data-mute aria-label="Sonido" style="position:absolute; top:16px; right:16px; z-index:5; width:42px; height:42px; border-radius:10px; cursor:pointer; border:1px solid rgba(127,233,255,.35); background:rgba(8,16,28,.7); color:#7fe9ff; font-size:18px; line-height:1; display:flex; align-items:center; justify-content:center;">${this.soundOn ? '♪' : '✕'}</button>
    `;

    this.opts.mount.appendChild(root);
    this.root = root;
    this.canvas = root.querySelector('[data-canvas]') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    this.cardEl = root.querySelector('[data-card]') as HTMLElement;
    this.counterEl = root.querySelector('[data-counter]') as HTMLElement;
    this.raysEl = root.querySelector('[data-rays]') as HTMLElement;
    this.rays2El = root.querySelector('[data-rays2]') as HTMLElement;
    this.glowEl = root.querySelector('[data-glow]') as HTMLElement;
    this.bloomEl = root.querySelector('[data-bloom]') as HTMLElement;
    this.flashEl = root.querySelector('[data-flash]') as HTMLElement;

    (root.querySelector('[data-continue]') as HTMLButtonElement).addEventListener('click', () => this.close());
    const muteBtn = root.querySelector('[data-mute]') as HTMLButtonElement;
    muteBtn.addEventListener('click', () => {
      this.soundOn = !this.soundOn;
      muteBtn.textContent = this.soundOn ? '♪' : '✕';
      if (!this.soundOn && this.master) this.master.gain.value = 0;
      else if (this.master) this.master.gain.value = 0.42;
    });
  }

  private layout(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.W = rect.width || 900;
    this.H = rect.height || 560;
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('pointerdown', this.resumeHandler);
    window.removeEventListener('resize', this.onResize);
    this.root.style.transition = 'opacity .3s ease';
    this.root.style.opacity = '0';
    window.setTimeout(() => {
      this.root.remove();
      if (this.actx) { try { void this.actx.close(); } catch { /* noop */ } }
    }, 320);
    this.opts.onClose?.();
  }

  // ------------------------------------------------------------ animation
  private coin(x: number, y: number, vx: number, vy: number, delay: number): Part {
    return {
      kind: 'coin', x, y, vx, vy,
      r: 14 + Math.random() * 13,
      spin: Math.random() * Math.PI * 2,
      spinV: (Math.random() - 0.5) * 0.48,
      tilt: (Math.random() - 0.5) * 0.4,
      delay, born: false,
    };
  }

  private run(): void {
    if (this.closed) return;
    this.layout();
    const W = this.W, H = this.H;

    // escalado por sats: proporcional, con tope maxCoins
    const sats = Math.max(0, Math.round(Number(this.opts.sats) || 0));
    const minCoins = 22;
    const maxCoins = Math.max(minCoins + 4, Math.round(this.opts.maxCoins));
    const satsForMax = Math.max(500, this.opts.satsForMax);
    const ratio = Math.min(1, sats / satsForMax);
    const coinCount = Math.round(minCoins + (maxCoins - minCoins) * ratio);
    this.intensity = ratio;

    this.parts = [];
    const cx = W / 2, cy = H * 0.6;
    const fountainN = Math.round(coinCount * 0.45);
    for (let i = 0; i < fountainN; i++) {
      const ang = (-Math.PI / 2) + (Math.random() - 0.5) * 1.85;
      const spd = 11 + Math.random() * (11 + ratio * 9);
      this.parts.push(this.coin(
        cx + (Math.random() - 0.5) * 120,
        cy + (Math.random() - 0.5) * 36,
        Math.cos(ang) * spd, Math.sin(ang) * spd - 3,
        Math.random() * 420));
    }
    const rainN = coinCount - fountainN;
    const rainDur = 700 + ratio * 2200;
    for (let i = 0; i < rainN; i++) {
      this.parts.push(this.coin(
        Math.random() * W, -30 - Math.random() * H * 0.6,
        (Math.random() - 0.5) * 3, 3 + Math.random() * 4,
        100 + Math.random() * rainDur));
    }
    const confCount = Math.round(24 + ratio * 70);
    const cols = ['#22d3ee', '#c084fc', '#f472b6', '#7fe9ff'];
    for (let i = 0; i < confCount; i++) {
      this.parts.push({
        kind: 'conf',
        x: cx + (Math.random() - 0.5) * 200, y: cy + (Math.random() - 0.5) * 50,
        vx: (Math.random() - 0.5) * 17, vy: -7 - Math.random() * (7 + ratio * 8),
        w: 3 + Math.random() * 3, h: 11 + Math.random() * 12,
        spin: Math.random() * Math.PI, spinV: (Math.random() - 0.5) * 0.45,
        col: cols[(Math.random() * cols.length) | 0],
        delay: Math.random() * 500, born: false,
      });
    }
    const orbCount = Math.round(10 + ratio * 26);
    const orbCols = ['rgba(34,211,238,', 'rgba(192,132,252,', 'rgba(244,114,182,', 'rgba(255,180,60,', 'rgba(127,233,255,'];
    for (let i = 0; i < orbCount; i++) {
      this.parts.push({
        kind: 'orb',
        x: Math.random() * W, y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.8, vy: -0.3 - Math.random() * 0.7,
        r: 16 + Math.random() * 46, col: orbCols[(Math.random() * orbCols.length) | 0],
        ph: Math.random() * Math.PI * 2, phV: 0.04 + Math.random() * 0.05,
        delay: Math.random() * 300, born: false,
      });
    }

    this.raysEl.style.opacity = String(0.4 + ratio * 0.55);
    this.rays2El.style.opacity = String(0.3 + ratio * 0.45);
    this.glowEl.style.opacity = String(0.55 + ratio * 0.4);

    // flash blanco + bloom dorado en el golpe
    this.flashEl.style.transition = 'none';
    this.flashEl.style.opacity = String(0.7 + ratio * 0.3);
    requestAnimationFrame(() => {
      this.flashEl.style.transition = 'opacity .5s ease-out';
      this.flashEl.style.opacity = '0';
    });

    this.playFanfare();
    const rollDur = 1100 + ratio * 700;
    this.rollCounter(sats, rollDur);
    this.playTally(rollDur);

    this.t0 = performance.now();
    this.last = this.t0;
    this.duration = (4 + ratio * 3) * 1000;
    cancelAnimationFrame(this.raf);
    this.loop();
  }

  private loop(): void {
    if (this.closed) return;
    const ctx = this.ctx;
    const now = performance.now();
    const dt = Math.min(2.4, (now - this.last) / 16.67);
    this.last = now;
    const elapsed = now - this.t0;
    const W = this.W, H = this.H;

    // card pop + shake
    const pe = elapsed - 120;
    let s: number;
    if (pe <= 0) s = 0.4;
    else if (pe < 700) {
      const u = pe / 700, c1 = 1.70158, c3 = c1 + 1;
      s = 0.4 + 0.6 * (1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2));
    } else s = 1;
    this.cardEl.style.opacity = String(Math.max(0, Math.min(1, pe / 220)));
    const shakeT = Math.max(0, 1 - elapsed / 500);
    const sh = shakeT * (3 + this.intensity * 9);
    const dx = (Math.random() - 0.5) * sh, dy = (Math.random() - 0.5) * sh;
    this.cardEl.style.transform = `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px)) scale(${s.toFixed(3)})`;

    const b = Math.max(0, 1 - elapsed / 1300);
    this.bloomEl.style.opacity = String((0.4 + this.intensity * 0.5) * b);

    ctx.clearRect(0, 0, W, H);
    const g = 0.42;

    // orbes (glow aditivo, detrás)
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.parts) {
      if (p.kind !== 'orb' || elapsed < p.delay) continue;
      p.born = true;
      p.x += p.vx * dt; p.y += p.vy * dt; p.ph! += p.phV! * dt;
      if (p.y < -(p.r ?? 0)) { p.y = H + (p.r ?? 0); p.x = Math.random() * W; }
      const a = 0.18 + 0.16 * Math.sin(p.ph!);
      const rg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r ?? 1);
      rg.addColorStop(0, p.col! + Math.max(0, a) + ')');
      rg.addColorStop(1, p.col! + '0)');
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r ?? 1, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    for (const p of this.parts) {
      if (p.kind === 'orb' || elapsed < p.delay) continue;
      p.born = true;
      p.vy += g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.spin! += p.spinV! * dt;
      if (p.kind === 'coin') this.drawCoin(ctx, p);
      else {
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.spin!);
        ctx.globalAlpha = 0.92; ctx.fillStyle = p.col!;
        ctx.fillRect(-(p.w!) / 2, -(p.h!) / 2, p.w!, p.h!);
        ctx.restore();
      }
    }

    if (elapsed > 700) this.parts = this.parts.filter((p) => p.kind === 'orb' || p.y < H + 90);
    const fallersLeft = this.parts.some((p) => p.kind !== 'orb' && p.born && p.y < H + 90);
    if (elapsed < this.duration || fallersLeft) {
      this.raf = requestAnimationFrame(() => this.loop());
    } else {
      ctx.clearRect(0, 0, W, H);
      this.glowEl.style.opacity = '0';
      this.cardEl.style.opacity = '1';
      this.cardEl.style.transform = 'translate(-50%,-50%) scale(1)';
    }
  }

  private drawCoin(ctx: CanvasRenderingContext2D, p: Part): void {
    const r = p.r ?? 16;
    const face = Math.abs(Math.cos(p.spin ?? 0));
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.tilt ?? 0);
    ctx.globalAlpha = 0.22; ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(r * 0.16, r * 0.18, r * Math.max(0.12, face), r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (face < 0.08) {
      const eg = ctx.createLinearGradient(-r * 0.2, 0, r * 0.2, 0);
      eg.addColorStop(0, '#b35e00'); eg.addColorStop(0.5, '#ffb13d'); eg.addColorStop(1, '#b35e00');
      ctx.fillStyle = eg; ctx.fillRect(-r * 0.16, -r, r * 0.32, r * 2);
      ctx.restore(); return;
    }
    ctx.scale(face, 1);
    if (this.coinReady) {
      ctx.drawImage(this.coinImg, -r, -r, r * 2, r * 2);
      ctx.globalAlpha = 0.34 * face;
      const hi = ctx.createLinearGradient(-r, -r, r * 0.3, r * 0.3);
      hi.addColorStop(0, 'rgba(255,255,255,.85)'); hi.addColorStop(0.45, 'rgba(255,255,255,0)');
      ctx.beginPath(); ctx.arc(0, 0, r * 0.96, 0, Math.PI * 2); ctx.fillStyle = hi; ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = '#ff9800'; ctx.fill();
    }
    ctx.restore();
  }

  private rollCounter(target: number, dur: number): void {
    const el = this.counterEl;
    const t0 = performance.now();
    const fmt = new Intl.NumberFormat('es-AR');
    const step = (): void => {
      if (this.closed) return;
      const t = Math.min(1, (performance.now() - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      el.textContent = fmt.format(Math.round(target * e));
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = fmt.format(target);
    };
    requestAnimationFrame(step);
  }

  // --------------------------------------------------------------- audio
  private ac(): AudioContext | null {
    if (!this.soundOn) return null;
    if (!this.actx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.actx = new AC();
      this.master = this.actx.createGain();
      this.master.gain.value = 0.42;
      this.master.connect(this.actx.destination);

      const bright = this.actx.createBiquadFilter();
      bright.type = 'highshelf'; bright.frequency.value = 2400; bright.gain.value = 3;
      const drive = this.actx.createGain(); drive.gain.value = 1;
      drive.connect(bright); bright.connect(this.master);
      this.busIn = drive;

      const reverb = this.actx.createConvolver();
      const rate = this.actx.sampleRate, len = Math.floor(rate * 2.6);
      const irBuf = this.actx.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch++) {
        const d = irBuf.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4);
      }
      reverb.buffer = irBuf;
      const revDamp = this.actx.createBiquadFilter(); revDamp.type = 'lowpass'; revDamp.frequency.value = 3200;
      const revGain = this.actx.createGain(); revGain.gain.value = 0.9;
      reverb.connect(revDamp); revDamp.connect(revGain); revGain.connect(this.master);
      this.reverbIn = reverb;
      drive.connect(reverb);
    }
    if (this.actx.state === 'suspended') void this.actx.resume();
    return this.actx;
  }

  private synth(freq: number, t: number, dur: number, vol: number, opts: { detune?: number; type?: OscillatorType; send?: number; clean?: boolean } = {}): void {
    const ac = this.ac();
    if (!ac || !this.master) return;
    const det = opts.detune ?? 11;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(freq * 6, 7000), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.4, 220), t + dur);
    lp.Q.value = 7;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.setValueAtTime(vol, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const d of [-det, det]) {
      const o = ac.createOscillator();
      o.type = opts.type ?? 'sawtooth';
      o.frequency.setValueAtTime(freq, t);
      o.detune.value = d;
      o.connect(lp); o.start(t); o.stop(t + dur + 0.03);
    }
    lp.connect(g);
    g.connect(opts.clean ? this.master : (this.busIn ?? this.master));
    if (this.reverbIn) { const sg = ac.createGain(); sg.gain.value = opts.send ?? 0.5; g.connect(sg); sg.connect(this.reverbIn); }
  }

  private drone(t: number, dur: number): void {
    const ac = this.ac();
    if (!ac || !this.master) return;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.2, t + 0.2);
    g.gain.setValueAtTime(0.2, t + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    [73.42, 110.0, 146.83].forEach((f, i) => {
      const o = ac.createOscillator();
      o.type = i === 2 ? 'sawtooth' : 'sine';
      o.frequency.value = f; o.detune.value = (i - 1) * 5;
      o.connect(g); o.start(t); o.stop(t + dur + 0.05);
    });
    g.connect(this.busIn ?? this.master);
  }

  private sparkle(freq: number, t: number, dur: number, vol: number): void {
    const ac = this.ac();
    if (!ac || !this.master) return;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    [1, 2.01, 3.0].forEach((m, i) => {
      const o = ac.createOscillator();
      o.type = i === 0 ? 'triangle' : 'sine';
      o.frequency.value = freq * m;
      const pg = ac.createGain();
      pg.gain.value = i === 0 ? 1 : (i === 1 ? 0.35 : 0.18);
      o.connect(pg); pg.connect(g); o.start(t); o.stop(t + dur + 0.03);
    });
    g.connect(this.master);
    if (this.reverbIn) { const sg = ac.createGain(); sg.gain.value = 0.7; g.connect(sg); sg.connect(this.reverbIn); }
  }

  private playFanfare(): void {
    const ac = this.ac();
    if (!ac) return;
    const t = ac.currentTime + 0.03;
    this.drone(t, 3.4);
    const mel: Array<[number, number, number]> = [
      [293.66, 0, 0.14], [440, 0.12, 0.14], [587.33, 0.24, 0.14], [739.99, 0.36, 0.16], [880, 0.5, 0.5],
    ];
    for (const [f, dt, dur] of mel) this.synth(f, t + dt, dur, 0.2, { send: 0.4 });
    const top = t + 0.64;
    [146.83, 220, 293.66, 369.99, 440, 587.33].forEach((f, i) => this.synth(f, top + i * 0.018, 1.4, 0.15, { detune: 10, send: 0.6 }));
    [1174.66, 1479.98, 1760].forEach((f, i) => this.sparkle(f, top + 0.04 + i * 0.07, 1.1, 0.16));
    this.sparkle(2349.32, top + 0.28, 1.3, 0.12);
  }

  private playTally(dur: number): void {
    const ac = this.ac();
    if (!ac) return;
    const t0 = ac.currentTime + 0.04;
    const scale = [293.66, 329.63, 440, 493.88, 587.33, 659.25, 880, 987.77, 1174.66, 1318.51, 1760];
    const total = dur / 1000;
    let acc = 0, i = 0;
    while (acc < total && i < 28) {
      const step = 0.11 - 0.06 * (acc / total);
      this.ping(scale[Math.min(scale.length - 1, i)], t0 + acc);
      acc += step; i++;
    }
    const end = t0 + acc + 0.02;
    [587.33, 739.99, 880].forEach((f, k) => this.synth(f, end + k * 0.012, 0.5, 0.15, { send: 0.55 }));
    this.sparkle(1760, end + 0.02, 0.9, 0.16);
  }

  private ping(freq: number, t: number): void {
    const ac = this.actx;
    if (!ac || !this.master) return;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 6;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.15, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = freq;
    const o2 = ac.createOscillator(); o2.type = 'square'; o2.frequency.value = freq * 2;
    const o2g = ac.createGain(); o2g.gain.value = 0.3;
    o.connect(bp); o2.connect(o2g); o2g.connect(bp); bp.connect(g);
    g.connect(this.master);
    if (this.reverbIn) { const sg = ac.createGain(); sg.gain.value = 0.5; g.connect(sg); sg.connect(this.reverbIn); }
    o.start(t); o2.start(t); o.stop(t + 0.2); o2.stop(t + 0.2);
  }
}

/** Atajo: crea, monta y arranca el festejo. Devuelve un handle con close(). */
export function celebratePayout(options: PayoutCelebrationOptions): PayoutCelebrationHandle {
  return new PayoutCelebration(options);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}
function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}
