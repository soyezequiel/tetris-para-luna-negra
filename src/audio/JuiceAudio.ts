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
  private dangerCritical = false;
  // Paneo posicional del peligro (-1..1): el latido y la sirena suenan desde donde
  // está la fuente en pantalla (tu tablero centrado ≈ 0; un rival en la grilla, a su lado).
  private dangerPan = 0;

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
  // El `pan` opcional (-1..1) posiciona cada evento según dónde ocurre en pantalla.
  clear(lines: number, pan = 0): void {
    this.neo.clear(lines, pan);
  }
  tetris(pan = 0): void {
    this.neo.tetris(pan);
  }
  combo(n: number, pan = 0): void {
    this.neo.combo(n, pan);
  }
  comboBreak(pan = 0): void {
    this.neo.comboBreak(pan);
  }
  b2b(pan = 0): void {
    this.neo.b2b(pan);
  }
  perfectClear(pan = 0): void {
    this.neo.perfectClear(pan);
  }
  attackLaunch(size: AttackSize, pan = 0): void {
    this.neo.attackLaunch(size, pan);
  }
  attackHit(size: AttackSize, pan = 0): void {
    this.neo.attackHit(size, pan);
  }
  garbageTelegraph(level: number, pan = 0): void {
    this.neo.garbageTelegraph(level, pan);
  }
  garbageRise(pan = 0): void {
    this.neo.garbageRise(pan);
  }
  ko(pan = 0): void {
    this.neo.ko(pan);
  }
  /** Sirena de top-out inminente (tu propia muerte a punto de pasar). */
  alarm(pan = 0): void {
    this.neo.alarm(pan);
  }
  /** Un rival está al borde de la derrota: barrido predador + campanazo. */
  rivalDanger(pan = 0): void {
    this.neo.rivalCrit(pan);
  }
  win(pan = 0): void {
    this.resetMix();
    this.neo.win(pan);
  }

  // ---------- latido de peligro (loop que acelera con la altura) ----------
  // `critical` = top-out inminente: dispara la sirena al cruzar el umbral (flanco
  // de subida) y, mientras dure, el latido se acelera al máximo.
  setDanger(level: number, critical = false, pan = 0): void {
    this.dangerLevel = clamp01(level);
    this.dangerPan = pan;
    if (critical && !this.dangerCritical && !this.muted) this.neo.alarm(this.dangerPan);
    this.dangerCritical = critical;
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
      this.neo.heart(this.dangerCritical ? 1 : this.dangerLevel, this.dangerPan);
      const eff = this.dangerCritical ? 1 : this.dangerLevel;
      const period = 920 - eff * 540;
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
