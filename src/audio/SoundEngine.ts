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

const DEFAULT_SFX_VOLUME = 1;
const DEFAULT_MUSIC_VOLUME = 1;
const MUSIC_OUTPUT_GAIN = 0.34;

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

  constructor(
    muted: boolean,
    musicTracks: MusicTrack[] = [],
    sfxVolume = DEFAULT_SFX_VOLUME,
    musicVolume = DEFAULT_MUSIC_VOLUME,
  ) {
    this.muted = muted;
    this.musicTracks = musicTracks;
    this.sfxVolume = this.clampVolume(sfxVolume);
    this.musicVolume = this.clampVolume(musicVolume);
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
    if (this.muted) this.music.pause();
    else void this.unlock();
    return this.muted;
  }

  // Permite/silencia la música de fondo según el contexto (p. ej. apagada en el
  // menú principal, encendida durante la partida). Idempotente: sólo actúa al
  // cambiar de estado para no relanzar la pista en cada frame del loop.
  setMusicAllowed(allowed: boolean): void {
    if (this.musicAllowed === allowed) return;
    this.musicAllowed = allowed;
    if (!allowed) {
      this.music.pause();
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
    try {
      await this.music.play();
      this.musicStarted = true;
    } catch {
      this.musicStarted = false;
    }
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
