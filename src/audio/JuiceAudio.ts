/**
 * JuiceAudio — capa de sonido "feel" de los eventos grandes (line clears, combo,
 * B2B, perfect clear, ataque, garbage, latido de peligro, KO y victoria).
 *
 * La SÍNTESIS la provee NeoSynth (paleta "Neo": modelado modal + crunch); esta
 * clase es la fachada que conserva la API que ya usa JuiceConductor/main.ts y la
 * orquestación que NeoSynth no cubre: el loop del latido de peligro (setDanger) y
 * el atenuado de mezcla en modo espectador (enterSpectator/resetMix).
 *
 * AudioContext propio, en paralelo al SoundEngine. Sincroniza mute/volumen desde
 * main.ts con setMuted()/setSfxVolume(). El contexto se desbloquea con unlock() en
 * el primer gesto del usuario.
 */

import { NeoSynth, type AttackSize } from './NeoSynth';

export type { AttackSize };

// Atenuación de la mezcla al pasar a espectador (KO). Equivale al viejo
// MASTER_SPECTATOR/MASTER_DEFAULT (0.32/0.55) de la implementación por osciladores.
const SPECTATOR_DUCK = 0.58;

export class JuiceAudio {
  private readonly neo: NeoSynth;

  private muted: boolean;

  // latido de peligro
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatId = 0;
  private dangerLevel = 0;

  constructor(muted = false, sfxVolume = 1) {
    this.muted = muted;
    this.neo = new NeoSynth(muted, sfxVolume);
  }

  // ---------- control externo (sincronizar con SoundEngine) ----------
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.neo.setMuted(muted);
    if (muted) this.stopHeartbeat();
  }
  setSfxVolume(volume: number): void {
    this.neo.setSfxVolume(volume);
  }
  /** Llamar desde el primer gesto del usuario (pointerdown/keydown). */
  async unlock(): Promise<void> {
    await this.neo.unlock();
  }
  /** KO local -> baja la mezcla; reset -> vuelve a normal. */
  enterSpectator(): void {
    this.neo.setDuck(SPECTATOR_DUCK);
    this.stopHeartbeat();
  }
  resetMix(): void {
    this.neo.setDuck(1);
  }

  // ---------- API de eventos (delegada a la paleta Neo) ----------
  clear(lines: number): void {
    this.neo.clear(lines);
  }
  tetris(): void {
    this.neo.tetris();
  }
  combo(n: number): void {
    this.neo.combo(n);
  }
  comboBreak(): void {
    this.neo.comboBreak();
  }
  b2b(): void {
    this.neo.b2b();
  }
  perfectClear(): void {
    this.neo.perfectClear();
  }
  attackLaunch(size: AttackSize): void {
    this.neo.attackLaunch(size);
  }
  attackHit(size: AttackSize): void {
    this.neo.attackHit(size);
  }
  garbageTelegraph(level: number): void {
    this.neo.garbageTelegraph(level);
  }
  garbageRise(): void {
    this.neo.garbageRise();
  }
  ko(): void {
    this.neo.ko();
  }
  win(): void {
    this.resetMix();
    this.neo.win();
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
      this.neo.heart(this.dangerLevel);
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

  destroy(): void {
    this.stopHeartbeat();
    this.neo.destroy();
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}
