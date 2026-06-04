import { importReplayValue } from './replayImport';
import type { ExportedReplay } from './replayExport';
import { createRunSummary, type LineSplit } from './runStats';

export interface RunHistoryEntry {
  id: string;
  createdAt: string;
  seed: number;
  status: 'finished' | 'gameover';
  lines: number;
  pieces: number;
  elapsedFrames: number;
  pps: number;
  inputCount: number;
  inputsPerPiece: number;
  linesPerMinute: number;
  splits: LineSplit[];
  replay: ExportedReplay;
}

interface RunHistoryDocument {
  version: 1;
  entries: RunHistoryEntry[];
}

export interface HistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_KEY = 'stack40.runHistory.v1';
export const MAX_RUN_HISTORY_ENTRIES = 50;

export function createRunHistoryEntry(replay: ExportedReplay): RunHistoryEntry | null {
  if (replay.result.status !== 'finished' && replay.result.status !== 'gameover') return null;
  const summary = createRunSummary({ result: replay.result, inputs: replay.inputs, splits: replay.summary?.splits });
  return {
    id: `${replay.seed}-${replay.result.status}-${summary.elapsedFrames}-${replay.inputs.length}`,
    createdAt: replay.createdAt,
    seed: replay.seed,
    status: replay.result.status,
    lines: replay.result.lines,
    pieces: replay.result.pieces,
    elapsedFrames: summary.elapsedFrames,
    pps: summary.pps,
    inputCount: summary.inputCount,
    inputsPerPiece: summary.inputsPerPiece,
    linesPerMinute: summary.linesPerMinute,
    splits: summary.splits,
    replay,
  };
}

export function loadRunHistory(storage = defaultStorage()): RunHistoryEntry[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return normalizeDocument(parsed).entries;
  } catch {
    return [];
  }
}

export function saveRunHistoryEntry(entry: RunHistoryEntry, storage = defaultStorage()): RunHistoryEntry[] {
  const entries = [
    entry,
    ...loadRunHistory(storage).filter((candidate) => candidate.id !== entry.id),
  ].slice(0, MAX_RUN_HISTORY_ENTRIES);
  return saveRunHistoryEntries(entries, storage);
}

export function deleteRunHistoryEntry(id: string, storage = defaultStorage()): RunHistoryEntry[] {
  const entries = loadRunHistory(storage).filter((entry) => entry.id !== id);
  return saveRunHistoryEntries(entries, storage);
}

function saveRunHistoryEntries(entries: RunHistoryEntry[], storage: HistoryStorage): RunHistoryEntry[] {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries } satisfies RunHistoryDocument));
  } catch {
    return loadRunHistory(storage);
  }
  return entries;
}

export function clearRunHistory(storage = defaultStorage()): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Storage failures should not break gameplay.
  }
}

function normalizeDocument(value: unknown): RunHistoryDocument {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    return { version: 1, entries: [] };
  }
  return {
    version: 1,
    entries: value.entries.map(normalizeEntry).filter((entry): entry is RunHistoryEntry => entry !== null).slice(0, MAX_RUN_HISTORY_ENTRIES),
  };
}

function normalizeEntry(value: unknown): RunHistoryEntry | null {
  if (!isObject(value)) return null;
  const replayResult = importReplayValue(value.replay);
  if (!replayResult.ok) return null;
  const entry = createRunHistoryEntry(replayResult.replay);
  if (!entry) return null;
  return {
    ...entry,
    id: typeof value.id === 'string' && value.id.length > 0 ? value.id : entry.id,
  };
}

function defaultStorage(): HistoryStorage {
  return localStorage;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
