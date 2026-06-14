/**
 * NeoSynth — motor de efectos "Neo" (modelado físico modal + crunch) para Tetris.
 *
 * Reemplaza la síntesis por osciladores de SoundEngine.ts y los eventos de
 * JuiceAudio.ts con la paleta Neo aprobada en el Sound Lab:
 *   · cuerpos tonales por MODELADO MODAL (banco de resonadores inarmónicos que
 *     decaen a distinta velocidad — suena a objeto real golpeado, no a beep);
 *   · transientes "crunch" (ruido saturado con waveshaper) para el ataque;
 *   · sub-bass con armónico de octava (retumba en auriculares, audible en laptop);
 *   · bus maestro: saturador suave → compresor → destino, con envío a reverb por
 *     convolución (impulso oscurecido con un polo, suena a sala y no a "fizz").
 *
 * AudioContext propio (igual patrón que JuiceAudio). Sincronizá mute/volumen con
 * setMuted()/setSfxVolume(); el sub-bass se dosifica con setBass(0..1). Desbloqueá
 * el contexto en el primer gesto del usuario con unlock().
 *
 *   const neo = new NeoSynth(initialMuted, initialSfxVolume);
 *   window.addEventListener('pointerdown', () => void neo.unlock(), { once: true });
 *   neo.play('hardDrop');            // cues de input
 *   neo.clear(2);                    // 1..3 líneas; 4 = tetris()
 *   neo.tetris(); neo.perfectClear(); neo.combo(5); neo.win();
 */

export type SfxCue =
  | 'move' | 'rotate' | 'softDrop' | 'hardDrop' | 'hold' | 'lock'
  | 'lineClear' | 'tSpin' | 'finish' | 'gameOver' | 'retry'
  | 'countdownTick' | 'countdownGo';

export type AttackSize = 'S' | 'M' | 'L';

// ---- Paleta Neo (constantes horneadas) -------------------------------------
const REVERB = 1.0;   // multiplicador global de envío a reverb
const DRIVE = 1.7;    // saturación (waveshaper) de cuerpos y transientes
const CRUNCH = 0.9;   // peso de las capas de grano crujiente
const BRIGHT = 1.0;   // brillo de los transientes de aire
const SUBW = 1.0;     // peso del sub-bass de la paleta
// Material modal: barra/struck "campana limpia". Modos inarmónicos + decaimientos.
const MAT = { ratios: [1, 2, 3, 4.2, 5.4], gains: [1, 0.45, 0.3, 0.17, 0.1], decay: 0.5, falloff: 0.6, q: 20 };

const OUTPUT_TRIM = 0.95;        // trim de salida antes del compresor
const REVERB_SECONDS = 2.4;
const REVERB_DECAY = 3.0;

interface VoiceOpts {
  type?: OscillatorType; freq: number; freqEnd?: number; glide?: 'exp' | 'lin'; glideDur?: number;
  dur: number; attack?: number; hold?: number; gain?: number; when?: number; detune?: number;
  pan?: number; reverb?: number; drive?: number; unison?: number; spread?: number;
}
interface NoiseOpts {
  filter?: BiquadFilterType; freq?: number; freqEnd?: number; q?: number; dur: number;
  gain?: number; attack?: number; when?: number; pan?: number; reverb?: number; drive?: number;
}
interface SubOpts { type?: OscillatorType; freq: number; freqEnd?: number; glide?: 'exp' | 'lin'; glideDur?: number; dur: number; gain?: number; attack?: number; when?: number; reverb?: number; harm?: boolean; }
interface PluckOpts { freq: number; q?: number; dur: number; gain?: number; attack?: number; when?: number; pan?: number; reverb?: number; drive?: number; }
interface CrunchOpts { filter?: BiquadFilterType; freq?: number; freqEnd?: number; q?: number; dur?: number; gain?: number; attack?: number; when?: number; pan?: number; reverb?: number; drive?: number; rate?: number; }
interface ModalOpts { freq: number; ratios?: number[]; gains?: number[]; decay?: number; falloff?: number; q?: number; burst?: number; gain?: number; when?: number; pan?: number; reverb?: number; drive?: number; }

export class NeoSynth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private driveCurves: Record<string, Float32Array<ArrayBuffer>> = {};

  private muted: boolean;
  private vol: number;   // 0..1 volumen SFX
  private bass: number;  // 0..1 intensidad de sub-bass
  private duck = 1;      // 0..1 atenuación de mezcla (modo espectador tras KO)
  private lastSoftDropAt = 0;

  constructor(muted = false, sfxVolume = 1, bass = 0.75) {
    this.muted = muted;
    this.vol = clamp01(sfxVolume);
    this.bass = clamp01(bass);
  }

  // ---------- control externo ----------
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.gate(), this.ctx.currentTime, 0.02);
  }
  setSfxVolume(v: number): void {
    this.vol = clamp01(v);
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.gate(), this.ctx.currentTime, 0.02);
  }
  /** 0 = sutil · 1 = retumba. Afecta a todos los sub-bass. */
  setBass(v: number): void { this.bass = clamp01(v); }
  /** Atenúa la mezcla maestra. 1 = normal; <1 baja el volumen (p. ej. KO → espectador). */
  setDuck(factor: number): void {
    this.duck = clamp01(factor);
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.gate(), this.ctx.currentTime, 0.15);
  }
  /** Llamar en el primer gesto del usuario (pointerdown/keydown). */
  async unlock(): Promise<void> {
    const ctx = this.ensure();
    if (ctx?.state === 'suspended') await ctx.resume();
  }

  // ---------- API de cues de input ----------
  play(cue: SfxCue): void {
    if (!this.open()) return;
    const ctx = this.ensure(); if (!ctx) return;
    if (cue === 'softDrop') {
      if (ctx.currentTime - this.lastSoftDropAt < 0.045) return;
      this.lastSoftDropAt = ctx.currentTime;
    }
    switch (cue) {
      case 'move': {
        const pan = rp();
        this.crunch({ filter: 'highpass', freq: 4400, q: 0.7, dur: 0.01, gain: 0.08 * BRIGHT * CRUNCH, drive: DRIVE * 0.6, pan });
        this.sub({ freq: 190, freqEnd: 52, glide: 'exp', dur: 0.07, gain: 0.30, attack: 0.001, harm: false });
        this.voice({ type: 'triangle', freq: 130, freqEnd: 48, glide: 'exp', dur: 0.03, gain: 0.08, attack: 0.001, drive: DRIVE });
        break;
      }
      case 'rotate':
        this.crunch({ freq: 1400, freqEnd: 3200, q: 1.0, dur: 0.04, gain: 0.10 * CRUNCH, drive: DRIVE });
        this.voice({ type: 'triangle', freq: 440, freqEnd: 560, dur: 0.05, gain: 0.09, attack: 0.003, reverb: REVERB * 0.06, drive: DRIVE });
        this.pluck({ freq: 760, q: 7, dur: 0.05, gain: 0.06 * CRUNCH, reverb: REVERB * 0.2 });
        break;
      case 'softDrop':
        this.voice({ type: 'sine', freq: 130, dur: 0.02, gain: 0.05, attack: 0.002 });
        this.crunch({ filter: 'highpass', freq: 3200, q: 0.6, dur: 0.012, gain: 0.03 * CRUNCH, drive: DRIVE * 0.6 });
        break;
      case 'hardDrop':
        this.crunch({ freq: 2200, freqEnd: 600, q: 0.8, dur: 0.06, gain: 0.24 * BRIGHT * CRUNCH, drive: DRIVE * 1.3 });
        this.noise({ filter: 'lowpass', freq: 1500, freqEnd: 280, dur: 0.11, gain: 0.20, q: 0.7, drive: DRIVE, reverb: REVERB * 0.05 });
        this.modal({ freq: 150, ratios: [1, 2, 3.2], gains: [1, 0.4, 0.2], decay: 0.12, falloff: 0.5, q: 6, gain: 0.12 * CRUNCH, drive: DRIVE });
        this.sub({ freq: 150, freqEnd: 44, dur: 0.22, gain: 0.58, attack: 0.002, reverb: REVERB * 0.06 });
        this.voice({ type: 'triangle', freq: 92, freqEnd: 50, dur: 0.09, gain: 0.10, drive: DRIVE });
        break;
      case 'hold':
        this.noise({ filter: 'bandpass', freq: 600, freqEnd: 2800, dur: 0.16, gain: 0.10, q: 0.8, drive: DRIVE * 0.6 });
        this.noteP(392, 0.06, 0.08, 0, REVERB * 0.1);
        this.noteP(587, 0.07, 0.07, 0.03, REVERB * 0.1);
        break;
      case 'lock':
        this.crunch({ freq: 1800, freqEnd: 500, q: 1.0, dur: 0.04, gain: 0.16 * BRIGHT * CRUNCH, drive: DRIVE * 1.2 });
        this.modal({ freq: 180, ratios: [1, 2.1, 3.3], gains: [1, 0.4, 0.18], decay: 0.1, falloff: 0.5, q: 7, gain: 0.13 * CRUNCH, drive: DRIVE });
        this.voice({ type: 'triangle', freq: 180, freqEnd: 150, dur: 0.045, gain: 0.09, attack: 0.001, drive: DRIVE });
        this.sub({ freq: 120, dur: 0.05, gain: 0.18, harm: false });
        break;
      case 'lineClear': return void this.clearN(1);
      case 'tSpin': return void this.tSpin();
      case 'finish':
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.noteP(f, 0.16, 0.14, i * 0.06, REVERB * 0.5));
        this.sub({ freq: 120, dur: 0.20, gain: 0.25 });
        break;
      case 'gameOver':
        [392, 311.1, 261.6, 196].forEach((f, i) => this.noteP(f, 0.22, 0.13, i * 0.12, REVERB * 0.4));
        this.sub({ freq: 90, freqEnd: 50, dur: 0.50, gain: 0.30, when: 0.10 });
        break;
      case 'retry':
        this.noteP(330, 0.06, 0.11, 0, REVERB * 0.2);
        this.noteP(494, 0.07, 0.10, 0.05, REVERB * 0.2);
        this.crunch({ filter: 'highpass', freq: 4000, q: 0.6, dur: 0.02, gain: 0.06 * CRUNCH, drive: DRIVE * 0.6 });
        break;
      case 'countdownTick':
        this.voice({ type: 'square', freq: 680, dur: 0.16, gain: 0.13, attack: 0.002, reverb: REVERB * 0.15, drive: DRIVE });
        this.crunch({ filter: 'highpass', freq: 5000, q: 0.6, dur: 0.012, gain: 0.05 * CRUNCH, drive: DRIVE * 0.6 });
        break;
      case 'countdownGo':
        [784, 1046.5, 1568].forEach((f, i) => this.noteP(f, 0.18, 0.16, i * 0.05, REVERB * 0.4));
        this.sub({ freq: 110, dur: 0.20, gain: 0.30 });
        this.crunch({ filter: 'highpass', freq: 6000, q: 0.5, dur: 0.15, gain: 0.08 * CRUNCH, drive: DRIVE * 0.6 });
        break;
    }
  }

  // ---------- API de eventos grandes (mapea a JuiceAudio) ----------
  /** 1..3 líneas; 4+ dispara tetris(). */
  clear(lines: number): void {
    const n = Math.max(1, Math.floor(lines));
    if (n >= 4) return this.tetris();
    this.clearN(Math.min(3, n));
  }

  tetris(): void {
    if (!this.open()) return;
    this.sub({ freq: 130, freqEnd: 42, dur: 0.55, gain: 0.64, attack: 0.003, reverb: REVERB * 0.1 });
    this.voice({ type: 'triangle', freq: 82, freqEnd: 41, dur: 0.45, gain: 0.11, drive: DRIVE });
    this.crunch({ freq: 700, freqEnd: 5200, q: 0.7, dur: 0.4, gain: 0.16 * CRUNCH, drive: DRIVE });
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => this.noteP(f, 0.18, 0.16, i * 0.06, REVERB * 0.5));
    this.voice({ type: 'triangle', freq: 1568, freqEnd: 2637, dur: 0.4, gain: 0.11, when: 0.20, reverb: REVERB * 0.6, drive: DRIVE * 0.6 });
    this.crunch({ filter: 'highpass', freq: 6000, q: 0.5, dur: 0.35, gain: 0.10 * BRIGHT * CRUNCH, when: 0.22, drive: DRIVE * 0.7 });
    this.noteP(2093, 0.4, 0.10, 0.42, REVERB * 0.7);
  }

  tSpin(): void {
    if (!this.open()) return;
    this.sub({ freq: 160, freqEnd: 55, dur: 0.30, gain: 0.52, reverb: REVERB * 0.1 });
    this.crunch({ freq: 3000, freqEnd: 1000, q: 3.0, dur: 0.18, gain: 0.16 * CRUNCH, drive: DRIVE * 1.2 });
    [740, 932.3, 1174.7, 1480].forEach((f, i) => this.noteP(f, 0.13, 0.15, i * 0.045, REVERB * 0.5));
    this.voice({ type: 'sine', freq: 1864, freqEnd: 2489, dur: 0.35, gain: 0.09, when: 0.18, reverb: REVERB * 0.6 });
    this.noteP(1244, 0.20, 0.07, 0.10, REVERB * 0.5);
    this.crunch({ filter: 'highpass', freq: 7000, q: 0.6, dur: 0.25, gain: 0.09 * BRIGHT * CRUNCH, when: 0.05, drive: DRIVE * 0.7 });
  }

  perfectClear(): void {
    if (!this.open()) return;
    this.sub({ freq: 120, freqEnd: 60, dur: 0.70, gain: 0.62, reverb: REVERB * 0.15 });
    [523.25, 659.25, 783.99, 987.77, 1174.7, 1568].forEach((f, i) => this.noteP(f, 0.28, 0.15, i * 0.06, REVERB * 0.7));
    this.voice({ type: 'sine', freq: 1568, freqEnd: 3136, dur: 0.70, gain: 0.11, when: 0.30, reverb: REVERB * 0.9 });
    this.crunch({ filter: 'highpass', freq: 6000, q: 0.5, dur: 0.6, gain: 0.12 * BRIGHT * CRUNCH, when: 0.10, drive: DRIVE * 0.6, reverb: REVERB * 0.5 });
    [2093, 2637, 3136].forEach((f, i) => this.noteP(f, 0.5, 0.08, 0.40 + i * 0.05, REVERB * 0.9));
    this.noteP(2093, 0.80, 0.10, 0.50, REVERB);
  }

  combo(n: number): void {
    if (!this.open()) return;
    const step = Math.max(0, Math.min(12, Math.floor(n)));
    const f = 300 * Math.pow(2, step / 12);
    this.voice({ type: 'triangle', freq: f, freqEnd: f * 1.5, dur: 0.10, gain: 0.12, reverb: REVERB * 0.2, drive: DRIVE });
    this.pluck({ freq: f, q: 8, dur: 0.08, gain: 0.07 * CRUNCH, reverb: REVERB * 0.2, drive: DRIVE * 0.5 });
    this.crunch({ filter: 'highpass', freq: 5200, q: 0.6, dur: 0.02, gain: 0.04 * CRUNCH, drive: DRIVE * 0.6 });
  }

  comboBreak(): void {
    if (!this.open()) return;
    this.voice({ type: 'sawtooth', freq: 420, freqEnd: 90, dur: 0.26, gain: 0.13, glide: 'lin', drive: DRIVE });
    this.noise({ filter: 'lowpass', freq: 1400, freqEnd: 400, dur: 0.22, gain: 0.12, drive: DRIVE * 0.7 });
  }

  b2b(): void {
    if (!this.open()) return;
    this.noteP(880, 0.10, 0.13, 0, REVERB * 0.3);
    this.noteP(1320, 0.14, 0.10, 0.04, REVERB * 0.4);
    this.voice({ type: 'sine', freq: 1760, dur: 0.12, gain: 0.06, when: 0.08, reverb: REVERB * 0.4 });
    this.crunch({ filter: 'highpass', freq: 6000, q: 0.6, dur: 0.10, gain: 0.08 * BRIGHT * CRUNCH, drive: DRIVE * 0.6 });
    this.sub({ freq: 110, dur: 0.12, gain: 0.20 });
  }

  attackLaunch(size: AttackSize = 'M'): void {
    if (!this.open()) return;
    const g = { S: 0.14, M: 0.18, L: 0.24 }[size];
    this.crunch({ freq: 1400, freqEnd: 3800, q: 0.9, dur: 0.22, gain: g * CRUNCH, drive: DRIVE });
    this.voice({ type: 'sawtooth', freq: 700, freqEnd: 240, dur: 0.20, gain: g * 0.62, reverb: REVERB * 0.2, drive: DRIVE });
  }

  attackHit(size: AttackSize = 'M'): void {
    if (!this.open()) return;
    const low = { S: 140, M: 120, L: 95 }[size];
    const g = { S: 0.42, M: 0.52, L: 0.62 }[size];
    this.sub({ freq: low, freqEnd: low * 0.46, dur: 0.24, gain: g, reverb: REVERB * 0.15 });
    this.crunch({ freq: 1500, freqEnd: 700, q: 1.2, dur: 0.14, gain: 0.18 * CRUNCH, drive: DRIVE * 1.2 });
    this.modal({ freq: low * 1.16, ratios: [1, 2, 3.2], gains: [1, 0.4, 0.2], decay: 0.14, falloff: 0.5, q: 6, gain: 0.10 * CRUNCH, drive: DRIVE });
  }

  garbageTelegraph(level: number): void {
    if (!this.open()) return;
    this.crunch({ filter: 'highpass', freq: 1400 + level * 600, q: 0.8, dur: 0.04, gain: 0.07 * CRUNCH, drive: DRIVE * 0.6 });
  }

  garbageRise(): void {
    if (!this.open()) return;
    this.voice({ type: 'sawtooth', freq: 90, freqEnd: 220, dur: 0.28, gain: 0.15, glide: 'lin', reverb: REVERB * 0.1, drive: DRIVE });
    this.noise({ filter: 'lowpass', freq: 500, freqEnd: 1400, dur: 0.26, gain: 0.16, drive: DRIVE * 0.8 });
    this.sub({ freq: 60, freqEnd: 130, dur: 0.28, gain: 0.30, glide: 'lin' });
  }

  /** Un latido. Llamalo desde tu loop de "peligro" (level 0..1). */
  heart(level = 0.5): void {
    if (!this.open()) return;
    const l = clamp01(level);
    this.sub({ freq: 58, freqEnd: 40, dur: 0.14, gain: 0.34 + l * 0.18, harm: false });
    this.sub({ freq: 52, freqEnd: 38, dur: 0.13, gain: 0.26 + l * 0.16, when: 0.16, harm: false });
  }

  ko(): void {
    if (!this.open()) return;
    this.sub({ freq: 320, freqEnd: 38, dur: 0.70, gain: 0.55, reverb: REVERB * 0.2 });
    this.voice({ type: 'sawtooth', freq: 300, freqEnd: 40, dur: 0.60, gain: 0.15, reverb: REVERB * 0.2, drive: DRIVE });
    this.noise({ filter: 'lowpass', freq: 1300, freqEnd: 200, dur: 0.60, gain: 0.22, drive: DRIVE });
    this.crunch({ filter: 'highpass', freq: 2500, q: 0.6, dur: 0.14, gain: 0.12 * CRUNCH, drive: DRIVE });
  }

  win(): void {
    if (!this.open()) return;
    this.sub({ freq: 120, freqEnd: 80, dur: 0.60, gain: 0.52, reverb: REVERB * 0.15 });
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.noteP(f, 0.32, 0.16, i * 0.08, REVERB * 0.6));
    this.voice({ type: 'sine', freq: 1046.5, freqEnd: 1568, dur: 0.50, gain: 0.12, when: 0.32, reverb: REVERB * 0.8 });
    this.crunch({ filter: 'highpass', freq: 5000, q: 0.5, dur: 0.50, gain: 0.11 * BRIGHT * CRUNCH, when: 0.10, drive: DRIVE * 0.6 });
    [1568, 2093].forEach((f, i) => this.noteP(f, 0.5, 0.08, 0.40 + i * 0.06, REVERB * 0.8));
  }

  destroy(): void {
    if (this.ctx) { try { void this.ctx.close(); } catch { /* noop */ } }
    this.ctx = null; this.master = null; this.reverb = null; this.noiseBuf = null;
  }

  // ---------- helpers de diseño ----------
  private clearN(n: number): void {
    if (!this.open()) return;
    const roots = [523.25, 587.33, 659.25];
    const r = roots[n - 1];
    const ms = [[1, 1.5], [1, 1.25, 1.5], [1, 1.25, 1.5, 2]][n - 1];
    ms.forEach((m, i) => this.noteP(r * m, 0.13, 0.12, i * 0.045, REVERB * 0.3));
    this.noteP(r * 2, 0.10, 0.05 + 0.012 * n, 0.04, REVERB * 0.35);
    this.crunch({ filter: 'highpass', freq: 4200, q: 0.6, dur: 0.08 + 0.02 * n, gain: 0.08 * BRIGHT * CRUNCH, when: 0.02, drive: DRIVE * 0.8 });
    this.sub({ freq: 120, freqEnd: 70, dur: 0.16 + 0.03 * n, gain: 0.16 + 0.035 * n });
  }

  /** Nota con cuerpo modal (material Neo) + refuerzo tonal mínimo. */
  private noteP(f: number, dur: number, gain: number, when = 0, rev = 0): void {
    const dec = Math.max(0.08, Math.min(MAT.decay, dur * 1.8));
    this.modal({ freq: f, ratios: MAT.ratios, gains: MAT.gains, decay: dec, falloff: MAT.falloff, q: MAT.q, gain, when, reverb: rev, drive: DRIVE * 0.5, burst: 0.005 });
    this.voice({ type: 'sine', freq: f, dur: dur * 0.5, gain: gain * 0.16, when, attack: 0.002 });
  }

  // ---------- primitivas de síntesis ----------
  private bassMul(): number { return 0.45 + this.bass * 1.25; }

  private voice(o: VoiceOpts): void {
    const ctx = this.ctx; if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + (o.when || 0);
    const g = ctx.createGain();
    const peak = o.gain == null ? 0.3 : o.gain;
    const atk = (o.attack == null ? 0.004 : o.attack) * (0.85 + Math.random() * 0.3);
    const hold = o.hold || 0;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + atk);
    if (hold) g.gain.setValueAtTime(Math.max(0.0002, peak), t0 + atk + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + atk + hold + o.dur);
    let node: AudioNode = g;
    if (o.drive) { const sh = ctx.createWaveShaper(); sh.curve = this.driveCurve(o.drive); sh.oversample = '2x'; sh.connect(g); node = sh; }
    const n = 1 + (o.unison || 0);
    for (let i = 0; i < n; i++) {
      const osc = ctx.createOscillator();
      osc.type = o.type || 'sine';
      const spread = n > 1 ? ((i / (n - 1)) - 0.5) * 2 * (o.spread || 8) : 0;
      osc.detune.setValueAtTime((o.detune || 0) + spread + (Math.random() * 8 - 4), t0);
      osc.frequency.setValueAtTime(Math.max(1, o.freq), t0);
      if (o.freqEnd) {
        const te = t0 + (o.glideDur || o.dur);
        if (o.glide === 'lin') osc.frequency.linearRampToValueAtTime(Math.max(1, o.freqEnd), te);
        else osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqEnd), te);
      }
      osc.connect(node);
      osc.start(t0); osc.stop(t0 + atk + hold + o.dur + 0.06);
    }
    let out: AudioNode = g;
    if (o.pan) { const p = ctx.createStereoPanner(); p.pan.value = o.pan; g.connect(p); out = p; }
    out.connect(this.master);
    if (o.reverb && this.reverb) { const s = ctx.createGain(); s.gain.value = o.reverb; out.connect(s); s.connect(this.reverb); }
  }

  private noise(o: NoiseOpts): void {
    const ctx = this.ctx; if (!ctx || !this.master || !this.noiseBuf) return;
    const t0 = ctx.currentTime + (o.when || 0);
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = o.filter || 'bandpass';
    f.frequency.setValueAtTime(Math.max(20, o.freq || 1500), t0);
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t0 + o.dur);
    if (o.q != null) f.Q.value = o.q;
    const g = ctx.createGain();
    const peak = o.gain == null ? 0.2 : o.gain;
    const atk = o.attack == null ? 0.003 : o.attack;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + atk + o.dur);
    let node: AudioNode = f;
    if (o.drive) { const sh = ctx.createWaveShaper(); sh.curve = this.driveCurve(o.drive); f.connect(sh); node = sh; }
    let out: AudioNode = g;
    if (o.pan) { const p = ctx.createStereoPanner(); p.pan.value = o.pan; g.connect(p); out = p; }
    src.connect(f); node.connect(g); out.connect(this.master);
    if (o.reverb && this.reverb) { const s = ctx.createGain(); s.gain.value = o.reverb; out.connect(s); s.connect(this.reverb); }
    src.start(t0); src.stop(t0 + atk + o.dur + 0.06);
  }

  private sub(o: SubOpts): void {
    const g = (o.gain == null ? 0.5 : o.gain) * this.bassMul() * SUBW;
    this.voice({ type: o.type || 'sine', freq: o.freq, freqEnd: o.freqEnd, glide: o.glide || 'exp', glideDur: o.glideDur, dur: o.dur, gain: g, attack: o.attack == null ? 0.003 : o.attack, when: o.when || 0, reverb: o.reverb || 0 });
    if (o.harm !== false) this.voice({ type: 'triangle', freq: o.freq * 2, freqEnd: o.freqEnd ? o.freqEnd * 2 : undefined, glide: o.glide || 'exp', dur: o.dur * 0.8, gain: g * 0.13, attack: 0.004, when: o.when || 0 });
  }

  private pluck(o: PluckOpts): void {
    const ctx = this.ctx; if (!ctx || !this.master || !this.noiseBuf) return;
    const t0 = ctx.currentTime + (o.when || 0);
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.playbackRate.value = 0.7 + Math.random() * 0.5;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.setValueAtTime(Math.max(20, o.freq), t0); f.Q.value = o.q || 9;
    const g = ctx.createGain();
    const peak = o.gain == null ? 0.2 : o.gain, atk = o.attack == null ? 0.002 : o.attack;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + atk + o.dur);
    let node: AudioNode = f; src.connect(f);
    if (o.drive) { const sh = ctx.createWaveShaper(); sh.curve = this.driveCurve(o.drive); f.connect(sh); node = sh; }
    let out: AudioNode = g; node.connect(g);
    if (o.pan) { const p = ctx.createStereoPanner(); p.pan.value = o.pan; g.connect(p); out = p; }
    out.connect(this.master);
    if (o.reverb && this.reverb) { const s = ctx.createGain(); s.gain.value = o.reverb; out.connect(s); s.connect(this.reverb); }
    src.start(t0); src.stop(t0 + atk + o.dur + 0.06);
  }

  private crunch(o: CrunchOpts): void {
    const ctx = this.ctx; if (!ctx || !this.master || !this.noiseBuf) return;
    const t0 = ctx.currentTime + (o.when || 0), dur = o.dur || 0.05;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.playbackRate.value = o.rate || (0.55 + Math.random() * 0.5);
    const f = ctx.createBiquadFilter();
    f.type = o.filter || 'bandpass';
    f.frequency.setValueAtTime(Math.max(40, o.freq || 1800), t0);
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(40, o.freqEnd), t0 + dur);
    f.Q.value = o.q == null ? 1.2 : o.q;
    const sh = ctx.createWaveShaper(); sh.curve = this.driveCurve(o.drive || 4); sh.oversample = '4x';
    const g = ctx.createGain();
    const peak = o.gain == null ? 0.18 : o.gain, atk = o.attack == null ? 0.001 : o.attack;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + atk + dur);
    src.connect(f); f.connect(sh); sh.connect(g);
    let out: AudioNode = g;
    if (o.pan) { const p = ctx.createStereoPanner(); p.pan.value = o.pan; g.connect(p); out = p; }
    out.connect(this.master);
    if (o.reverb && this.reverb) { const s = ctx.createGain(); s.gain.value = o.reverb; out.connect(s); s.connect(this.reverb); }
    src.start(t0); src.stop(t0 + atk + dur + 0.05);
  }

  // Modelado físico modal: golpe de ruido → banco de resonadores inarmónicos con
  // decaimientos distintos por modo. Suena a objeto real golpeado.
  private modal(o: ModalOpts): void {
    const ctx = this.ctx; if (!ctx || !this.master || !this.noiseBuf) return;
    const t0 = ctx.currentTime + (o.when || 0);
    const f = Math.max(40, o.freq);
    const ratios = o.ratios || [1, 2.76, 5.40, 8.93];
    const gains = o.gains || [1, 0.5, 0.25, 0.12];
    const decay = o.decay || 0.25;
    const falloff = o.falloff == null ? 0.55 : o.falloff;
    const q = o.q || 18;
    const burst = o.burst || 0.004;
    const peak = o.gain == null ? 0.2 : o.gain;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const ex = ctx.createGain();
    ex.gain.setValueAtTime(1, t0);
    ex.gain.setValueAtTime(1, t0 + burst);
    ex.gain.exponentialRampToValueAtTime(0.001, t0 + burst + 0.004);
    src.connect(ex);
    const mix = ctx.createGain(); mix.gain.value = peak;
    ratios.forEach((r, i) => {
      if (f * r > 18000) return;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.setValueAtTime(f * r, t0); bp.Q.value = q * (1 + i * 0.3);
      const env = ctx.createGain();
      const d = decay * Math.pow(falloff, i);
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gains[i] == null ? 0.1 : gains[i]), t0 + 0.001);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.001 + d);
      ex.connect(bp); bp.connect(env); env.connect(mix);
    });
    let node: AudioNode = mix;
    if (o.drive) { const sh = ctx.createWaveShaper(); sh.curve = this.driveCurve(o.drive); mix.connect(sh); node = sh; }
    let out: AudioNode = node;
    if (o.pan) { const p = ctx.createStereoPanner(); p.pan.value = o.pan; node.connect(p); out = p; }
    out.connect(this.master);
    if (o.reverb && this.reverb) { const s = ctx.createGain(); s.gain.value = o.reverb; out.connect(s); s.connect(this.reverb); }
    src.start(t0); src.stop(t0 + burst + 0.02);
  }

  // ---------- infraestructura ----------
  private open(): boolean { return !this.muted && this.vol > 0; }
  private gate(): number { return this.muted ? 0.0001 : this.vol * OUTPUT_TRIM * this.duck; }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    const master = ctx.createGain(); master.gain.value = this.gate();
    const sat = ctx.createWaveShaper(); sat.curve = this.makeSatCurve(2.4); sat.oversample = '2x';
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 18; comp.ratio.value = 3.2; comp.attack.value = 0.003; comp.release.value = 0.18;
    const reverb = ctx.createConvolver(); reverb.buffer = this.makeImpulse(ctx, REVERB_SECONDS, REVERB_DECAY);
    const reverbReturn = ctx.createGain(); reverbReturn.gain.value = 0.9;
    master.connect(sat); sat.connect(comp); comp.connect(ctx.destination);
    reverb.connect(reverbReturn); reverbReturn.connect(sat);
    this.noiseBuf = this.makeNoise(ctx, 1.0);
    this.ctx = ctx; this.master = master; this.reverb = reverb;
    return ctx;
  }

  private driveCurve(a: number): Float32Array<ArrayBuffer> {
    const key = a.toFixed(2); if (this.driveCurves[key]) return this.driveCurves[key];
    const n = 1024, c = new Float32Array(n), d = Math.tanh(a) || 1;
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(a * x) / d; }
    this.driveCurves[key] = c; return c;
  }
  private makeSatCurve(k: number): Float32Array<ArrayBuffer> {
    const n = 1024, c = new Float32Array(n), d = Math.tanh(k) || 1;
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / d; }
    return c;
  }
  private makeImpulse(ctx: AudioContext, dur: number, decay: number): AudioBuffer {
    const rate = ctx.sampleRate, len = Math.max(1, Math.floor(rate * dur));
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0; const a = 0.22; // un polo: oscurece la cola (sala real, no fizz)
      for (let i = 0; i < len; i++) {
        const w = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        last = last + a * (w - last);
        d[i] = last * 1.7;
      }
    }
    return buf;
  }
  private makeNoise(ctx: AudioContext, dur: number): AudioBuffer {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** Pan estéreo aleatorio y sutil (random pan) para los ticks de movimiento. */
function rp(): number {
  return (Math.random() * 2 - 1) * 0.55;
}

declare global {
  interface Window { webkitAudioContext?: typeof AudioContext; }
}
