import type { ReverbMode } from './audio/SoundEngine';

// Esquema de control táctil elegido por el usuario.
export type TouchScheme = 'pro' | 'reduced' | 'dpad';
const TOUCH_SCHEMES: TouchScheme[] = ['pro', 'reduced', 'dpad'];

export interface LocalRecord {
  soundMuted: boolean;
  sfxMuted: boolean;
  musicMuted: boolean;
  sfxVolume: number;
  musicVolume: number;
  musicReverb: ReverbMode;
  touchControlsHidden: boolean;
  // Esquema de control táctil elegido por el usuario.
  touchScheme: TouchScheme;
  // Vibración (navigator.vibrate) al presionar / fijar piezas.
  touchHaptics: boolean;
  // Audio posicional: el paneo estéreo de cada sonido sigue la posición en pantalla
  // de su fuente (tu tablero centrado, los mini-tableros rivales de la grilla, etc.).
  positionalAudio: boolean;
  // Reproducir sólo temas libres de derechos (archivos cuyo nombre empieza con 'ncc').
  royaltyFreeOnly: boolean;
  // Movimiento del fondo dinámico (Aurora/Bruma/Marea). Si está off, el fondo queda
  // estático. Independiente de "reducir movimiento" del sistema, que solo lo ralentiza.
  backgroundMotion: boolean;
}

const KEY = 'stack40.records';
const DEFAULT_SFX_VOLUME = 1;
// La música arranca al 50% por defecto. Si el usuario la cambia, ese valor queda
// guardado en localStorage y este default ya no se usa para esa instalación.
const DEFAULT_MUSIC_VOLUME = 0.5;
const DEFAULT_REVERB_MODE: ReverbMode = 'medium';
const REVERB_MODES: ReverbMode[] = ['off', 'short', 'medium', 'long'];

export function loadRecord(): LocalRecord {
  try {
    const raw = localStorage.getItem(KEY);
    return normalizeRecord(raw ? (JSON.parse(raw) as Partial<LocalRecord>) : {});
  } catch {
    return normalizeRecord({});
  }
}

export function saveSoundMuted(soundMuted: boolean): LocalRecord {
  const record = { ...loadRecord(), soundMuted };
  localStorage.setItem(KEY, JSON.stringify(record));
  return record;
}

export function saveAudioMutes(sfxMuted: boolean, musicMuted: boolean): LocalRecord {
  const record = { ...loadRecord(), sfxMuted, musicMuted };
  localStorage.setItem(KEY, JSON.stringify(record));
  return record;
}

export function saveAudioVolumes(sfxVolume: number, musicVolume: number): LocalRecord {
  const record = {
    ...loadRecord(),
    sfxVolume: normalizeVolume(sfxVolume, DEFAULT_SFX_VOLUME),
    musicVolume: normalizeVolume(musicVolume, DEFAULT_MUSIC_VOLUME),
  };
  localStorage.setItem(KEY, JSON.stringify(record));
  return record;
}

export function saveMusicReverb(musicReverb: ReverbMode): LocalRecord {
  const record = { ...loadRecord(), musicReverb: normalizeReverb(musicReverb) };
  localStorage.setItem(KEY, JSON.stringify(record));
  return record;
}

export function saveTouchControlsHidden(touchControlsHidden: boolean): LocalRecord {
  const record = { ...loadRecord(), touchControlsHidden };
  localStorage.setItem(KEY, JSON.stringify(record));
  return record;
}

export function saveTouchScheme(touchScheme: TouchScheme): LocalRecord {
  const record = { ...loadRecord(), touchScheme };
  localStorage.setItem(KEY, JSON.stringify(record));
  return record;
}

export function saveTouchHaptics(touchHaptics: boolean): LocalRecord {
  const record = { ...loadRecord(), touchHaptics };
  localStorage.setItem(KEY, JSON.stringify(record));
  return record;
}

export function savePositionalAudio(positionalAudio: boolean): LocalRecord {
  const record = { ...loadRecord(), positionalAudio };
  localStorage.setItem(KEY, JSON.stringify(record));
  return record;
}

export function saveRoyaltyFreeOnly(royaltyFreeOnly: boolean): LocalRecord {
  const record = { ...loadRecord(), royaltyFreeOnly };
  localStorage.setItem(KEY, JSON.stringify(record));
  return record;
}

export function saveBackgroundMotion(backgroundMotion: boolean): LocalRecord {
  const record = { ...loadRecord(), backgroundMotion };
  localStorage.setItem(KEY, JSON.stringify(record));
  return record;
}

function normalizeRecord(record: Partial<LocalRecord>): LocalRecord {
  return {
    soundMuted: record.soundMuted ?? false,
    sfxMuted: record.sfxMuted ?? false,
    musicMuted: record.musicMuted ?? false,
    sfxVolume: normalizeVolume(record.sfxVolume, DEFAULT_SFX_VOLUME),
    musicVolume: normalizeVolume(record.musicVolume, DEFAULT_MUSIC_VOLUME),
    musicReverb: normalizeReverb(record.musicReverb),
    touchControlsHidden: record.touchControlsHidden ?? false,
    touchScheme: TOUCH_SCHEMES.includes(record.touchScheme as TouchScheme)
      ? (record.touchScheme as TouchScheme)
      : 'pro',
    touchHaptics: record.touchHaptics ?? true,
    positionalAudio: record.positionalAudio ?? true,
    royaltyFreeOnly: record.royaltyFreeOnly ?? false,
    backgroundMotion: record.backgroundMotion ?? true,
  };
}

function normalizeVolume(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function normalizeReverb(value: unknown): ReverbMode {
  return REVERB_MODES.includes(value as ReverbMode) ? (value as ReverbMode) : DEFAULT_REVERB_MODE;
}
