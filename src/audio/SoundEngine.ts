export type SoundCue =
  | 'move'
  | 'rotate'
  | 'softDrop'
  | 'hardDrop'
  | 'hold'
  | 'lock'
  | 'lineClear'
  | 'tSpin'
  | 'finish'
  | 'gameOver'
  | 'retry'
  | 'countdownTick'
  | 'countdownGo';

export interface MusicTrack {
  title: string;
  src: string;
}

export type VolumeChannel = 'sfx' | 'music';

// Cola de reverb al apagar/silenciar la música: en vez de cortar en seco, la
// pista se difumina (dry→0) mientras un convolver deja resonar las últimas
// notas. El modo controla el on/off y el largo de la cola.
export type ReverbMode = 'off' | 'short' | 'medium' | 'long';

export const REVERB_MODES: ReverbMode[] = ['off', 'short', 'medium', 'long'];

// Segundos de la respuesta al impulso (largo de la cola) por modo.
const REVERB_DURATIONS: Record<ReverbMode, number> = {
  off: 0,
  short: 0.7,
  medium: 1.2,
  long: 2,
};

const DEFAULT_SFX_VOLUME = 1;
const DEFAULT_MUSIC_VOLUME = 1;
const DEFAULT_REVERB_MODE: ReverbMode = 'medium';
const MUSIC_OUTPUT_GAIN = 0.34;

const REVERB_DECAY = 4; // curva de caída exponencial del impulso (más alto = se va más rápido)
const MUSIC_FADE_TIME = 0.18; // segundos en los que el dry baja a 0
const REVERB_WET_LEVEL = 0.8; // nivel del envío al reverb durante el apagado

export class SoundEngine {
  private context: AudioContext | null = null;
  private readonly music: HTMLAudioElement;
  private readonly musicTracks: MusicTrack[];
  private muted: boolean;
  private sfxVolume: number;
  private musicVolume: number;
  private currentMusicTrackIndex = 0;
  private musicStarted = false;
  private musicAllowed = true;
  private lastSoftDropAt = 0;

  // Grafo WebAudio de la música (creado de forma perezosa una sola vez): permite
  // aplicar la cola de reverb al apagar. Si no hay AudioContext, la música suena
  // directo por el HTMLAudioElement como fallback.
  private musicDryGain: GainNode | null = null;
  private musicWetGain: GainNode | null = null;
  private reverbConvolver: ConvolverNode | null = null;
  private musicGraphReady = false;
  private musicTailTimer = 0;
  private reverbMode: ReverbMode;

  constructor(
    muted: boolean,
    musicTracks: MusicTrack[] = [],
    sfxVolume = DEFAULT_SFX_VOLUME,
    musicVolume = DEFAULT_MUSIC_VOLUME,
    reverbMode: ReverbMode = DEFAULT_REVERB_MODE,
  ) {
    this.muted = muted;
    this.musicTracks = musicTracks;
    this.sfxVolume = this.clampVolume(sfxVolume);
    this.musicVolume = this.clampVolume(musicVolume);
    this.reverbMode = reverbMode;
    this.music = new Audio();
    this.music.preload = 'metadata';
    this.applyMusicVolume();
    this.music.addEventListener('ended', this.handleMusicEnded);
    this.music.addEventListener('error', this.handleMusicError);
    this.loadMusicTrack(0);
    window.addEventListener('pointerdown', this.unlock);
    window.addEventListener('keydown', this.unlock);
  }

  isMuted(): boolean {
    return this.muted;
  }

  toggleMuted(): boolean {
    this.muted = !this.muted;
    if (this.muted) this.fadeOutMusicWithReverb();
    else void this.unlock();
    return this.muted;
  }

  getReverbMode(): ReverbMode {
    return this.reverbMode;
  }

  // Avanza al siguiente modo de reverb (off → short → medium → long → off) y
  // regenera la respuesta al impulso si el grafo ya existe. Devuelve el nuevo modo.
  cycleReverbMode(): ReverbMode {
    const nextIndex = (REVERB_MODES.indexOf(this.reverbMode) + 1) % REVERB_MODES.length;
    this.reverbMode = REVERB_MODES[nextIndex];
    this.refreshReverbImpulse();
    return this.reverbMode;
  }

  setReverbMode(mode: ReverbMode): ReverbMode {
    this.reverbMode = mode;
    this.refreshReverbImpulse();
    return this.reverbMode;
  }

  // Permite/silencia la música de fondo según el contexto (p. ej. apagada en el
  // menú principal, encendida durante la partida). Idempotente: sólo actúa al
  // cambiar de estado para no relanzar la pista en cada frame del loop.
  setMusicAllowed(allowed: boolean): void {
    if (this.musicAllowed === allowed) return;
    this.musicAllowed = allowed;
    if (!allowed) {
      this.fadeOutMusicWithReverb();
      this.musicStarted = false;
    } else if (!this.muted) {
      void this.startMusic();
    }
  }

  getCurrentMusicTrack(): MusicTrack | null {
    return this.musicTracks[this.currentMusicTrackIndex] ?? null;
  }

  getSfxVolume(): number {
    return this.sfxVolume;
  }

  getMusicVolume(): number {
    return this.musicVolume;
  }

  adjustVolume(channel: VolumeChannel, delta: number): number {
    const currentVolume = channel === 'sfx' ? this.sfxVolume : this.musicVolume;
    return this.setVolume(channel, currentVolume + delta);
  }

  setVolume(channel: VolumeChannel, volume: number): number {
    const nextVolume = this.clampVolume(volume);
    if (channel === 'sfx') {
      this.sfxVolume = nextVolume;
      return this.sfxVolume;
    }

    this.musicVolume = nextVolume;
    this.applyMusicVolume();
    if (this.musicVolume === 0) this.music.pause();
    else if (!this.muted) void this.unlock();
    return this.musicVolume;
  }

  nextMusicTrack(): MusicTrack | null {
    return this.advanceMusicTrack(!this.muted && this.musicStarted);
  }

  play(cue: SoundCue): void {
    if (this.muted || this.sfxVolume === 0) return;
    const context = this.getContext();
    if (!context) return;
    const now = context.currentTime;
    if (cue === 'softDrop') {
      if (now - this.lastSoftDropAt < 0.045) return;
      this.lastSoftDropAt = now;
    }

    switch (cue) {
      case 'move':
        // Tick crujiente: chasquido de ruido filtrado + cuerpo corto cuadrado.
        this.noise(0.024, 0.05, 3200);
        this.tone(190, 0.003, 0.026, 'square', 0.05);
        break;
      case 'rotate':
        this.tone(480, 0.022, 0.04, 'triangle', 0.09);
        break;
      case 'softDrop':
        this.tone(120, 0.01, 0.018, 'sine', 0.045);
        break;
      case 'hardDrop':
        this.noise(0.08, 0.12, 900);
        this.tone(90, 0.04, 0.08, 'sawtooth', 0.12);
        break;
      case 'hold':
        this.chord([330, 415], 0.045, 0.08);
        break;
      case 'lock':
        this.tone(150, 0.025, 0.05, 'square', 0.08);
        break;
      case 'lineClear':
        this.arpeggio([420, 560, 760, 980], 0.035, 0.09);
        break;
      case 'tSpin':
        this.noise(0.035, 0.045, 1800);
        this.arpeggio([740, 932, 1175, 1480], 0.03, 0.13);
        break;
      case 'finish':
        this.arpeggio([523, 659, 784, 1046], 0.08, 0.12);
        break;
      case 'gameOver':
        this.arpeggio([240, 180, 130], 0.11, 0.12);
        break;
      case 'retry':
        this.chord([220, 440], 0.035, 0.07);
        break;
      case 'countdownTick':
        // Beep arcade nítido por cada segundo (3, 2, 1).
        this.tone(680, 0.006, 0.16, 'square', 0.11);
        break;
      case 'countdownGo':
        // Acorde ascendente de arranque (¡YA!).
        this.arpeggio([784, 1046, 1568], 0.05, 0.16);
        break;
    }
  }

  private unlock = async (): Promise<void> => {
    const context = this.getContext();
    if (context?.state === 'suspended') await context.resume();
    if (!this.muted) await this.startMusic();
    if (context?.state !== 'suspended') {
      window.removeEventListener('pointerdown', this.unlock);
      window.removeEventListener('keydown', this.unlock);
    }
  };

  private getContext(): AudioContext | null {
    if (this.context) return this.context;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    this.context = new AudioCtor();
    return this.context;
  }

  private tone(frequency: number, attack: number, release: number, type: OscillatorType, volume: number): void {
    const context = this.getContext();
    if (!context) return;
    const adjustedVolume = volume * this.sfxVolume;
    if (adjustedVolume <= 0) return;
    const osc = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(adjustedVolume, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + release);
    osc.connect(gain);
    gain.connect(context.destination);
    osc.start(now);
    osc.stop(now + attack + release + 0.02);
  }

  private chord(frequencies: number[], duration: number, volume: number): void {
    frequencies.forEach((frequency, index) => {
      window.setTimeout(() => this.tone(frequency, 0.015, duration, 'triangle', volume), index * 10);
    });
  }

  private arpeggio(frequencies: number[], step: number, volume: number): void {
    frequencies.forEach((frequency, index) => {
      window.setTimeout(() => this.tone(frequency, 0.012, step, 'triangle', volume), index * step * 1000);
    });
  }

  private async startMusic(): Promise<void> {
    if (!this.musicAllowed || !this.musicTracks.length || this.musicVolume === 0) return;
    this.ensureMusicGraph();
    this.resetMusicMix();
    try {
      await this.music.play();
      this.musicStarted = true;
    } catch {
      this.musicStarted = false;
    }
  }

  // Enruta el <audio> por el grafo WebAudio una sola vez:
  //   source ─┬─► dryGain ──────────────► destination
  //           └─► convolver ─► wetGain ─► destination
  // En reproducción normal wet=0 (señal limpia); al apagar, dry baja a 0 y wet
  // sube para dejar resonar la cola del convolver.
  private ensureMusicGraph(): void {
    if (this.musicGraphReady) return;
    const context = this.getContext();
    if (!context) return;
    try {
      const source = context.createMediaElementSource(this.music);
      const dryGain = context.createGain();
      const wetGain = context.createGain();
      const convolver = context.createConvolver();
      convolver.buffer = this.createReverbImpulse(context, this.reverbDuration(), REVERB_DECAY);
      this.reverbConvolver = convolver;
      dryGain.gain.setValueAtTime(1, context.currentTime);
      wetGain.gain.setValueAtTime(0, context.currentTime);
      source.connect(dryGain);
      source.connect(convolver);
      convolver.connect(wetGain);
      dryGain.connect(context.destination);
      wetGain.connect(context.destination);
      this.musicDryGain = dryGain;
      this.musicWetGain = wetGain;
      this.musicGraphReady = true;
    } catch {
      // Sin WebAudio para la música: se reproduce directo por el elemento.
      this.musicGraphReady = false;
    }
  }

  // Vuelve a la mezcla limpia (dry pleno, sin reverb) y cancela cualquier cola
  // pendiente. Se llama antes de (re)arrancar una pista.
  private resetMusicMix(): void {
    if (this.musicTailTimer) {
      window.clearTimeout(this.musicTailTimer);
      this.musicTailTimer = 0;
    }
    const context = this.context;
    if (!context || !this.musicDryGain || !this.musicWetGain) return;
    const now = context.currentTime;
    this.musicDryGain.gain.cancelScheduledValues(now);
    this.musicWetGain.gain.cancelScheduledValues(now);
    this.musicDryGain.gain.setValueAtTime(1, now);
    this.musicWetGain.gain.setValueAtTime(0, now);
  }

  // Apaga la música con una cola de reverb: difumina el dry mientras el
  // convolver deja resonar las últimas notas, y recién entonces pausa el audio.
  private fadeOutMusicWithReverb(): void {
    if (this.music.paused) return;
    const context = this.context;
    if (
      this.reverbMode === 'off' ||
      !context ||
      !this.musicGraphReady ||
      !this.musicDryGain ||
      !this.musicWetGain
    ) {
      // Reverb desactivado o sin grafo: corte directo como antes.
      this.music.pause();
      return;
    }

    const now = context.currentTime;
    const dry = this.musicDryGain.gain;
    const wet = this.musicWetGain.gain;
    dry.cancelScheduledValues(now);
    wet.cancelScheduledValues(now);
    // Sube el envío al reverb y desvanece la señal directa.
    wet.setValueAtTime(Math.max(wet.value, 0.0001), now);
    wet.linearRampToValueAtTime(REVERB_WET_LEVEL, now + 0.04);
    dry.setValueAtTime(Math.max(dry.value, 0.0001), now);
    dry.exponentialRampToValueAtTime(0.0001, now + MUSIC_FADE_TIME);

    if (this.musicTailTimer) window.clearTimeout(this.musicTailTimer);
    // Pausa el audio tras el fundido (deja de alimentar al convolver), pero la
    // cola del reverb sigue sonando hasta que se agota la respuesta al impulso.
    this.musicTailTimer = window.setTimeout(() => {
      this.music.pause();
      this.musicTailTimer = 0;
      this.resetMusicMix();
    }, (MUSIC_FADE_TIME + this.reverbDuration()) * 1000);
  }

  private reverbDuration(): number {
    return REVERB_DURATIONS[this.reverbMode];
  }

  // Regenera la respuesta al impulso del convolver tras cambiar el modo, para
  // que el nuevo largo de cola aplique sin tener que recrear el grafo.
  private refreshReverbImpulse(): void {
    const context = this.context;
    if (!context || !this.reverbConvolver || this.reverbMode === 'off') return;
    this.reverbConvolver.buffer = this.createReverbImpulse(context, this.reverbDuration(), REVERB_DECAY);
  }

  // Genera una respuesta al impulso estéreo procedural (ruido con caída
  // exponencial): evita depender de un archivo de IR externo.
  private createReverbImpulse(context: AudioContext, duration: number, decay: number): AudioBuffer {
    const rate = context.sampleRate;
    const length = Math.max(1, Math.floor(rate * duration));
    const impulse = context.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }

  private loadMusicTrack(index: number): void {
    const track = this.musicTracks[index];
    if (!track) return;
    this.currentMusicTrackIndex = index;
    this.music.src = track.src;
    this.applyMusicVolume();
    this.music.load();
  }

  private advanceMusicTrack(autoplay: boolean): MusicTrack | null {
    if (!this.musicTracks.length) return null;
    const nextIndex = (this.currentMusicTrackIndex + 1) % this.musicTracks.length;
    this.loadMusicTrack(nextIndex);
    if (autoplay) void this.startMusic();
    return this.getCurrentMusicTrack();
  }

  private handleMusicEnded = (): void => {
    this.advanceMusicTrack(true);
  };

  private handleMusicError = (): void => {
    this.advanceMusicTrack(!this.muted);
  };

  private noise(duration: number, volume: number, cutoff: number): void {
    const context = this.getContext();
    if (!context) return;
    const adjustedVolume = volume * this.sfxVolume;
    if (adjustedVolume <= 0) return;
    const buffer = context.createBuffer(1, Math.max(1, context.sampleRate * duration), context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    const now = context.currentTime;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, now);
    gain.gain.setValueAtTime(adjustedVolume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.buffer = buffer;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(context.destination);
    source.start(now);
  }

  private applyMusicVolume(): void {
    this.music.volume = this.clampVolume(this.musicVolume * MUSIC_OUTPUT_GAIN);
  }

  private clampVolume(volume: number): number {
    if (!Number.isFinite(volume)) return 0;
    return Math.min(1, Math.max(0, volume));
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
