/**
 * JuiceAudio — capa de sonido "feel" portada del prototipo Juice Lab.
 *
 * AudioContext propio, en paralelo al SoundEngine existente (que conserva sus cues
 * de input crujientes: move/rotate/lock/hardDrop...). Aquí viven los sonidos ricos
 * y por capas de los eventos grandes: line clears, combo, B2B, perfect clear,
 * ataque, garbage, latido de peligro, KO y victoria.
 *
 * Sincroniza mute/volumen desde main.ts con setMuted() y setSfxVolume() para que
 * respete los mismos controles que el SoundEngine. El contexto se desbloquea solo
 * (resume) en el primer sonido tras un gesto del usuario; llama unlock() desde el
 * handler de pointerdown/keydown si quieres adelantarlo.
 *
 * masterTarget baja en modo espectador (KO) para apagar la mezcla.
 */

type ToneSpec = {
  freq: number;
  dur: number;
  freqEnd?: number;
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  when?: number;
};

type NoiseSpec = {
  dur: number;
  freq?: number;
  gain?: number;
  filter?: BiquadFilterType;
  q?: number;
  attack?: number;
  when?: number;
};

export type AttackSize = 'S' | 'M' | 'L';

const MASTER_DEFAULT = 0.55;
const MASTER_SPECTATOR = 0.32;

export class JuiceAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private muted: boolean;
  private sfxVolume: number; // 0..1, espejo del SoundEngine
  private masterTarget = MASTER_DEFAULT;

  // latido de peligro
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatId = 0;
  private dangerLevel = 0;

  constructor(muted = false, sfxVolume = 1) {
    this.muted = muted;
    this.sfxVolume = clamp01(sfxVolume);
  }

  // ---------- control externo (sincronizar con SoundEngine) ----------
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stopHeartbeat();
  }
  setSfxVolume(volume: number): void {
    this.sfxVolume = clamp01(volume);
  }
  /** Llamar desde el primer gesto del usuario (pointerdown/keydown). */
  async unlock(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx?.state === 'suspended') await ctx.resume();
  }
  /** KO local -> baja la mezcla; reset -> vuelve a normal. */
  enterSpectator(): void {
    this.setMaster(MASTER_SPECTATOR);
    this.stopHeartbeat();
  }
  resetMix(): void {
    this.setMaster(MASTER_DEFAULT);
  }

  // ---------- API de eventos ----------
  clear(lines: number): void {
    const n = Math.max(1, lines);
    const base = 520 + n * 90;
    this.tone({ freq: base, freqEnd: base * 1.6, dur: 0.13, type: 'triangle', gain: 0.22 });
    this.tone({ freq: base * 2, dur: 0.08, type: 'sine', gain: 0.14, when: 0.01 });
    this.noise({ freq: 3200, dur: 0.09, gain: 0.12, filter: 'highpass' });
    if (n >= 3) this.tone({ freq: base * 0.5, dur: 0.18, type: 'sawtooth', gain: 0.12 });
  }

  tetris(): void {
    this.tone({ freq: 120, freqEnd: 42, dur: 0.5, type: 'sine', gain: 0.5 });
    this.tone({ freq: 80, freqEnd: 40, dur: 0.45, type: 'square', gain: 0.12 });
    [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone({ freq: f, dur: 0.16, type: 'square', gain: 0.16, when: i * 0.05 }));
    this.tone({ freq: 1568, freqEnd: 2600, dur: 0.4, type: 'triangle', gain: 0.14, when: 0.18 });
    this.noise({ freq: 2400, dur: 0.4, gain: 0.2, filter: 'bandpass', q: 0.7 });
    this.noise({ freq: 6000, dur: 0.12, gain: 0.14, filter: 'highpass', when: 0.24 });
  }

  combo(n: number): void {
    const f = 300 * Math.pow(2, Math.min(24, n) / 12);
    this.tone({ freq: f, freqEnd: f * 1.5, dur: 0.1, type: 'square', gain: 0.14 });
    this.tone({ freq: f * 2, dur: 0.06, type: 'sine', gain: 0.08, when: 0.02 });
  }
  comboBreak(): void {
    this.tone({ freq: 400, freqEnd: 90, dur: 0.28, type: 'sawtooth', gain: 0.16 });
    this.noise({ freq: 1400, dur: 0.22, gain: 0.12, filter: 'lowpass' });
  }
  b2b(): void {
    this.tone({ freq: 880, dur: 0.1, type: 'triangle', gain: 0.16 });
    this.tone({ freq: 1320, dur: 0.14, type: 'sine', gain: 0.12, when: 0.04 });
    this.noise({ freq: 5200, dur: 0.1, gain: 0.1, filter: 'highpass' });
  }
  perfectClear(): void {
    [784, 988, 1175, 1568].forEach((f, i) => this.tone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.18, when: i * 0.06 }));
    this.tone({ freq: 1568, freqEnd: 2600, dur: 0.5, type: 'sine', gain: 0.16, when: 0.22 });
    this.noise({ freq: 6000, dur: 0.4, gain: 0.16, filter: 'highpass', when: 0.05 });
  }

  attackLaunch(size: AttackSize): void {
    const g = { S: 0.16, M: 0.22, L: 0.3 }[size];
    this.noise({ freq: 1800, dur: 0.22, gain: g, filter: 'bandpass', q: 0.8 });
    this.tone({ freq: 700, freqEnd: 240, dur: 0.2, type: 'sawtooth', gain: g * 0.6 });
  }
  attackHit(size: AttackSize): void {
    const low = { S: 150, M: 110, L: 70 }[size];
    const g = { S: 0.3, M: 0.42, L: 0.55 }[size];
    const bp = { S: 2400, M: 1600, L: 900 }[size];
    this.tone({ freq: low, freqEnd: low * 0.5, dur: 0.22, type: 'sine', gain: g });
    this.noise({ freq: bp, dur: 0.14, gain: g * 0.5, filter: 'bandpass' });
  }

  garbageTelegraph(level: number): void {
    this.tone({ freq: 1400 + level * 600, dur: 0.05, type: 'square', gain: 0.1 });
  }
  garbageRise(): void {
    this.tone({ freq: 90, freqEnd: 200, dur: 0.25, type: 'sawtooth', gain: 0.2 });
    this.noise({ freq: 600, dur: 0.2, gain: 0.16, filter: 'lowpass' });
  }

  ko(): void {
    this.tone({ freq: 320, freqEnd: 40, dur: 0.7, type: 'sawtooth', gain: 0.4 });
    this.tone({ freq: 90, freqEnd: 30, dur: 0.6, type: 'sine', gain: 0.45 });
    this.noise({ freq: 800, dur: 0.6, gain: 0.3, filter: 'lowpass' });
  }
  win(): void {
    this.resetMix();
    [523, 659, 784, 1047].forEach((f, i) => this.tone({ freq: f, dur: 0.3, type: 'triangle', gain: 0.2, when: i * 0.08 }));
    this.tone({ freq: 1047, freqEnd: 1568, dur: 0.5, type: 'sine', gain: 0.18, when: 0.32 });
    this.noise({ freq: 5000, dur: 0.5, gain: 0.16, filter: 'highpass', when: 0.1 });
  }

  // ---------- latido de peligro (loop que acelera con la altura) ----------
  setDanger(level: number): void {
    this.dangerLevel = clamp01(level);
    if (this.dangerLevel > 0.02 && !this.muted) this.startHeartbeat();
    else this.stopHeartbeat();
  }
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const id = (this.heartbeatId += 1);
    const tick = () => {
      if (this.heartbeatId !== id || this.dangerLevel <= 0.02 || this.muted) {
        this.heartbeatTimer = null;
        return;
      }
      this.heart(this.dangerLevel);
      const period = 920 - this.dangerLevel * 540;
      this.heartbeatTimer = setTimeout(tick, period);
    };
    tick();
  }
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.heartbeatId += 1;
  }
  private heart(level: number): void {
    this.tone({ freq: 58, freqEnd: 40, dur: 0.14, type: 'sine', gain: 0.3 + level * 0.2 });
    this.tone({ freq: 52, freqEnd: 38, dur: 0.13, type: 'sine', gain: 0.22 + level * 0.18, when: 0.16 });
  }

  destroy(): void {
    this.stopHeartbeat();
    if (this.context) {
      try {
        void this.context.close();
      } catch {
        /* noop */
      }
    }
    this.context = null;
    this.master = null;
  }

  // ---------- primitivas de síntesis ----------
  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    this.context = new Ctor();
    this.master = this.context.createGain();
    this.master.gain.value = this.masterTarget;
    this.master.connect(this.context.destination);
    const len = this.context.sampleRate;
    this.noiseBuffer = this.context.createBuffer(1, len, this.context.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
    return this.context;
  }

  private setMaster(value: number): void {
    this.masterTarget = value;
    const ctx = this.context;
    if (ctx && this.master) this.master.gain.setTargetAtTime(value, ctx.currentTime, 0.15);
  }

  private gateOpen(): boolean {
    return !this.muted && this.sfxVolume > 0;
  }

  private tone(o: ToneSpec): void {
    if (!this.gateOpen()) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + (o.when ?? 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqEnd), t0 + o.dur);
    const peak = (o.gain ?? 0.3) * this.sfxVolume;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + (o.attack ?? 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.03);
  }

  private noise(o: NoiseSpec): void {
    if (!this.gateOpen()) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.master || !this.noiseBuffer) return;
    const t0 = ctx.currentTime + (o.when ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = o.filter ?? 'bandpass';
    f.frequency.value = o.freq ?? 1200;
    if (o.q != null) f.Q.value = o.q;
    const g = ctx.createGain();
    const peak = (o.gain ?? 0.25) * this.sfxVolume;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + (o.attack ?? 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t0);
    src.stop(t0 + o.dur + 0.02);
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
