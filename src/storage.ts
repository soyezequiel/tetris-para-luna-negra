export interface LocalRecord {
  best40LineFrames: number | null;
  soundMuted: boolean;
  sfxVolume: number;
  musicVolume: number;
}

const KEY = 'stack40.records';
const DEFAULT_SFX_VOLUME = 1;
const DEFAULT_MUSIC_VOLUME = 1;

export function loadRecord(): LocalRecord {
  try {
    const raw = localStorage.getItem(KEY);
    return normalizeRecord(raw ? (JSON.parse(raw) as Partial<LocalRecord>) : {});
  } catch {
    return normalizeRecord({});
  }
}

export function saveBest40LineFrames(frames: number): LocalRecord {
  const record = loadRecord();
  if (record.best40LineFrames === null || frames < record.best40LineFrames) {
    record.best40LineFrames = frames;
    localStorage.setItem(KEY, JSON.stringify(record));
  }
  return record;
}

export function saveSoundMuted(soundMuted: boolean): LocalRecord {
  const record = { ...loadRecord(), soundMuted };
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

function normalizeRecord(record: Partial<LocalRecord>): LocalRecord {
  return {
    best40LineFrames: record.best40LineFrames ?? null,
    soundMuted: record.soundMuted ?? false,
    sfxVolume: normalizeVolume(record.sfxVolume, DEFAULT_SFX_VOLUME),
    musicVolume: normalizeVolume(record.musicVolume, DEFAULT_MUSIC_VOLUME),
  };
}

function normalizeVolume(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}
