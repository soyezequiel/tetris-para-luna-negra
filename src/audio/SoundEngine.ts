import { NeoSynth } from './NeoSynth';

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
const DEFAULT_MUSIC_VOLUME = 0.5;
const DEFAULT_REVERB_MODE: ReverbMode = 'medium';
const MUSIC_OUTPUT_GAIN = 0.34;

const REVERB_DECAY = 4; // curva de caída exponencial del impulso (más alto = se va más rápido)
const MUSIC_FADE_TIME = 0.18; // segundos en los que el dry baja a 0
const MUSIC_FADE_IN_TIME = 1.4; // efecto de entrada: segundos en los que el dry sube de silencio a pleno
const REVERB_WET_LEVEL = 0.8; // nivel del envío al reverb durante el apagado

export class SoundEngine {
  private context: AudioContext | null = null;
  // Síntesis de efectos: paleta "Neo" (modelado modal + crunch). Reemplaza los
  // osciladores crudos de antes; la música sigue por el grafo WebAudio de abajo.
  private readonly neo: NeoSynth;
  private readonly music: HTMLAudioElement;
  private musicTracks: MusicTrack[];
  private muted: boolean;
  // Silenciado por canal (independiente del mute maestro `muted`): permite apagar
  // sólo la música o sólo los efectos sin tocar el otro canal. El volumen guardado
  // se conserva mientras el canal está silenciado.
  private sfxMuted: boolean;
  private musicMuted: boolean;
  // Silencio TRANSITORIO de efectos con la pestaña en segundo plano. Es independiente
  // del mute persistido (`sfxMuted`): el bucle ahora sigue corriendo oculto (worker),
  // así que sin esto se oirían locks/line-clears desde otra pestaña. No se guarda.
  private sfxSuspended = false;
  private sfxVolume: number;
  private musicVolume: number;
  private currentMusicTrackIndex = 0;
  private musicStarted = false;
  private musicAllowed = true;

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
    sfxMuted = false,
    musicMuted = false,
  ) {
    this.muted = muted;
    this.sfxMuted = sfxMuted;
    this.musicMuted = musicMuted;
    this.musicTracks = musicTracks;
    this.sfxVolume = this.clampVolume(sfxVolume);
    this.musicVolume = this.clampVolume(musicVolume);
    this.reverbMode = reverbMode;
    this.neo = new NeoSynth(this.muted || this.sfxMuted, this.sfxVolume);
    this.music = new Audio();
    this.music.preload = 'metadata';
    this.applyMusicVolume();
    this.music.addEventListener('ended', this.handleMusicEnded);
    this.music.addEventListener('error', this.handleMusicError);
    this.loadMusicTrack(0);
    window.addEventListener('pointerdown', this.unlock);
    window.addEventListener('keydown', this.unlock);
  }

  // Diagnóstico de audio para el reporte (botón "Reportar" en resultados): junta el
  // estado del canal de música (su propio AudioContext) + el de los efectos (NeoSynth,
  // que trae el perfil móvil y el medidor de pico). Pensado para entender desde el
  // teléfono del jugador por qué "suena mal": si el perfil móvil se activó, si recorta,
  // qué volúmenes/mutes hay y si corre como PWA instalada (audio enrutado distinto).
  getAudioDiagnostics(): Record<string, unknown> {
    const ctx = this.context;
    let standalone: boolean | null = null;
    try {
      standalone = window.matchMedia?.('(display-mode: standalone)').matches
        || (navigator as unknown as { standalone?: boolean }).standalone
        || false;
    } catch { /* noop */ }
    return {
      muted: this.muted,
      sfxMuted: this.sfxMuted,
      musicMuted: this.musicMuted,
      sfxVolume: this.sfxVolume,
      musicVolume: this.musicVolume,
      reverbMode: this.reverbMode,
      standalone,
      music: {
        contextState: ctx?.state ?? 'none',
        sampleRate: ctx?.sampleRate ?? null,
        graphReady: this.musicGraphReady,
        playing: !this.music.paused,
        elementVolume: Math.round(this.music.volume * 1000) / 1000,
        track: this.getCurrentMusicTrack()?.title ?? null,
      },
      sfx: this.neo.getDiagnostics(),
    };
  }

  isMuted(): boolean {
    return this.muted;
  }

  toggleMuted(): boolean {
    this.muted = !this.muted;
    this.syncSfx();
    if (this.muted) this.fadeOutMusicWithReverb();
    else void this.unlock();
    return this.muted;
  }

  isSfxMuted(): boolean {
    return this.sfxMuted;
  }

  isMusicMuted(): boolean {
    return this.musicMuted;
  }

  setSfxMuted(muted: boolean): boolean {
    this.sfxMuted = muted;
    this.syncSfx();
    return this.sfxMuted;
  }

  toggleSfxMuted(): boolean {
    return this.setSfxMuted(!this.sfxMuted);
  }

  // Suspende/reanuda los efectos sin tocar la preferencia persistida. Lo usa el gate
  // de visibilidad para callar los SFX cuando la pestaña está en segundo plano.
  setSfxSuspended(suspended: boolean): void {
    if (this.sfxSuspended === suspended) return;
    this.sfxSuspended = suspended;
    this.syncSfx();
  }

  setMusicMuted(muted: boolean): boolean {
    if (this.musicMuted === muted) return this.musicMuted;
    this.musicMuted = muted;
    if (muted) {
      this.fadeOutMusicWithReverb();
      this.musicStarted = false;
    } else if (this.musicEnabled()) {
      void this.startMusic();
    }
    return this.musicMuted;
  }

  toggleMusicMuted(): boolean {
    return this.setMusicMuted(!this.musicMuted);
  }

  // ¿La música debería estar sonando ahora mismo? Compone el permiso de contexto
  // (menú vs partida), el mute maestro, el mute de canal y el volumen.
  private musicEnabled(): boolean {
    return this.musicAllowed && !this.muted && !this.musicMuted && this.musicVolume > 0;
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
    } else if (this.musicEnabled()) {
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
      this.syncSfx();
      return this.sfxVolume;
    }

    this.musicVolume = nextVolume;
    this.applyMusicVolume();
    if (!this.musicEnabled()) this.music.pause();
    else void this.unlock();
    return this.musicVolume;
  }

  nextMusicTrack(): MusicTrack | null {
    return this.advanceMusicTrack(this.musicEnabled() && this.musicStarted);
  }

  // Reemplaza la playlist en caliente (p. ej. al activar "sólo música libre de
  // derechos"). Si la pista actual sigue en la nueva lista se mantiene sonando;
  // si no, salta al primer tema de la lista nueva (y arranca si la música estaba
  // sonando). Con lista vacía, pausa.
  setMusicTracks(tracks: MusicTrack[]): void {
    const current = this.getCurrentMusicTrack();
    this.musicTracks = tracks;
    const keepIndex = current ? tracks.findIndex((track) => track.src === current.src) : -1;
    if (keepIndex >= 0) {
      this.currentMusicTrackIndex = keepIndex;
      return;
    }
    this.currentMusicTrackIndex = 0;
    if (!tracks.length) {
      this.music.pause();
      return;
    }
    this.loadMusicTrack(0);
    if (this.musicEnabled() && this.musicStarted) void this.startMusic();
  }

  // Sincroniza la playlist Y la pista actual con una sala online: todos los clientes
  // reciben la misma lista (filtro del host) y el mismo índice (derivado de la seed),
  // y la pista arranca desde el principio para sonar al unísono. A diferencia de
  // setMusicTracks(), acá NO intentamos conservar la pista que venía sonando: forzar
  // el índice es lo que mantiene a todos en el mismo tema. Respeta el mute/volumen
  // local: si la música está silenciada no suena, pero queda cargada y lista.
  setSyncedPlaylist(tracks: MusicTrack[], index: number): void {
    this.musicTracks = tracks;
    if (!tracks.length) {
      this.music.pause();
      this.musicStarted = false;
      return;
    }
    const i = ((Math.trunc(index) % tracks.length) + tracks.length) % tracks.length;
    // loadMusicTrack setea src + load(), lo que reinicia currentTime a 0: así la
    // pista suena desde el arranque en todos los clientes a la vez.
    this.loadMusicTrack(i);
    if (this.musicEnabled()) void this.startMusic();
  }

  // Los efectos los sintetiza NeoSynth (paleta Neo: modelado modal + crunch). El
  // gate de mute/volumen se mantiene aquí y se refleja en `neo` con syncSfx().
  // `gain` escala el volumen de esta emisión (1 = normal; <1 atenúa, >1 refuerza).
  play(cue: SoundCue, pan = 0, gain = 1): void {
    if (this.muted || this.sfxMuted || this.sfxSuspended || this.sfxVolume === 0) return;
    this.neo.play(cue, pan, gain);
  }

  // Refleja el estado de mute (maestro o de canal SFX) y el volumen SFX en el
  // motor Neo. Llamar tras cualquier cambio de muted/sfxMuted/sfxVolume.
  private syncSfx(): void {
    this.neo.setMuted(this.muted || this.sfxMuted || this.sfxSuspended);
    this.neo.setSfxVolume(this.sfxVolume);
  }

  private unlock = async (): Promise<void> => {
    const context = this.getContext();
    void this.neo.unlock();
    if (context?.state === 'suspended') await context.resume();
    if (this.musicEnabled()) await this.startMusic();
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

  private async startMusic(): Promise<void> {
    if (!this.musicTracks.length || !this.musicEnabled()) return;
    // Sólo aplicamos el efecto de entrada cuando la música realmente arranca (estaba
    // pausada). Si ya está sonando —p. ej. startMusic llamado de nuevo al ajustar el
    // volumen— no re-disparamos el fundido para no provocar un bajón audible.
    const wasPaused = this.music.paused;
    this.ensureMusicGraph();
    this.resetMusicMix();
    if (wasPaused) this.armMusicFadeIn();
    try {
      await this.music.play();
      this.musicStarted = true;
    } catch {
      this.musicStarted = false;
    }
  }

  // Efecto de entrada: en lugar de arrancar a pleno de golpe, la música entra con
  // un fundido suave subiendo el dry de silencio a 1 a lo largo de
  // MUSIC_FADE_IN_TIME. Se arma antes de play() para que no haya un click inicial.
  // Sin grafo WebAudio (fallback al HTMLAudioElement) no hay fundido posible.
  private armMusicFadeIn(): void {
    const context = this.context;
    if (!context || !this.musicGraphReady || !this.musicDryGain) return;
    const now = context.currentTime;
    const dry = this.musicDryGain.gain;
    dry.cancelScheduledValues(now);
    dry.setValueAtTime(0.0001, now);
    dry.exponentialRampToValueAtTime(1, now + MUSIC_FADE_IN_TIME);
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
    const tail = this.reverbDuration();
    const dry = this.musicDryGain.gain;
    const wet = this.musicWetGain.gain;
    dry.cancelScheduledValues(now);
    wet.cancelScheduledValues(now);
    // Sube el envío al reverb y desvanece la señal directa…
    wet.setValueAtTime(Math.max(wet.value, 0.0001), now);
    wet.linearRampToValueAtTime(REVERB_WET_LEVEL, now + 0.04);
    dry.setValueAtTime(Math.max(dry.value, 0.0001), now);
    dry.exponentialRampToValueAtTime(0.0001, now + MUSIC_FADE_TIME);
    // …y baja el propio envío a silencio a lo largo de la cola, así no queda
    // ese zumbido bajo y largo arrastrándose hasta cero (la "meseta" del piso).
    wet.exponentialRampToValueAtTime(0.0001, now + 0.04 + tail);

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
    this.advanceMusicTrack(this.musicEnabled());
  };

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
