import type { ExportedReplay } from './replayExport';
import type { GameInput, GameRules, InputAction } from '../game/types';
import { GAME_ACTIONS, normalizeInputSettings } from '../input/settings';

export type ReplayImportResult =
  | { ok: true; replay: ExportedReplay }
  | { ok: false; error: string };

export function importReplayJson(raw: string): ReplayImportResult {
  try {
    return importReplayValue(JSON.parse(raw));
  } catch {
    return { ok: false, error: 'Replay file is not valid JSON.' };
  }
}

export function importReplayValue(value: unknown): ReplayImportResult {
  if (!isObject(value)) return { ok: false, error: 'Replay file must contain an object.' };
  if (value.version !== 1) return { ok: false, error: 'Replay version is not supported.' };
  if (value.game !== 'stack40') return { ok: false, error: 'Replay belongs to another game.' };
  if (!isUnsignedInteger(value.seed)) return { ok: false, error: 'Replay seed is missing or invalid.' };

  const rules = parseRules(value.rules);
  if (!rules) return { ok: false, error: 'Replay rules are missing or invalid.' };

  const result = parseResult(value.result);
  if (!result) return { ok: false, error: 'Replay result is missing or invalid.' };

  const inputs = parseInputs(value.inputs);
  if (!inputs) return { ok: false, error: 'Replay inputs are missing or invalid.' };

  const createdAt = typeof value.createdAt === 'string' && value.createdAt.length > 0
    ? value.createdAt
    : new Date(0).toISOString();

  return {
    ok: true,
    replay: {
      version: 1,
      game: 'stack40',
      createdAt,
      seed: value.seed,
      rules,
      inputSettings: normalizeInputSettings(value.inputSettings),
      result,
      inputs,
    },
  };
}

function parseRules(value: unknown): GameRules | null {
  if (!isObject(value)) return null;
  const boardWidth = readPositiveInteger(value.boardWidth);
  const visibleRows = readPositiveInteger(value.visibleRows);
  const hiddenRows = readNonNegativeInteger(value.hiddenRows);
  const nextPreview = readPositiveInteger(value.nextPreview);
  const targetLines = readPositiveInteger(value.targetLines);
  const gravityCellsPerFrame = readPositiveNumber(value.gravityCellsPerFrame);
  const softDropCellsPerFrame = readPositiveNumber(value.softDropCellsPerFrame);
  const lockDelayFrames = readPositiveInteger(value.lockDelayFrames);
  const dasFrames = readNonNegativeInteger(value.dasFrames);
  const arrFrames = readPositiveInteger(value.arrFrames);
  if (
    boardWidth === null
    || visibleRows === null
    || hiddenRows === null
    || nextPreview === null
    || targetLines === null
    || gravityCellsPerFrame === null
    || softDropCellsPerFrame === null
    || lockDelayFrames === null
    || dasFrames === null
    || arrFrames === null
  ) return null;
  return {
    boardWidth,
    visibleRows,
    hiddenRows,
    nextPreview,
    targetLines,
    gravityCellsPerFrame,
    softDropCellsPerFrame,
    lockDelayFrames,
    dasFrames,
    arrFrames,
  };
}

function parseResult(value: unknown): ExportedReplay['result'] | null {
  if (!isObject(value)) return null;
  const status = value.status;
  if (status !== 'ready' && status !== 'playing' && status !== 'finished' && status !== 'gameover') return null;
  const lines = readNonNegativeInteger(value.lines);
  const pieces = readNonNegativeInteger(value.pieces);
  const frame = readNonNegativeInteger(value.frame);
  const finishFrame = readNullableNonNegativeInteger(value.finishFrame);
  const gameOverFrame = readNullableNonNegativeInteger(value.gameOverFrame);
  if (lines === null || pieces === null || frame === null || finishFrame === undefined || gameOverFrame === undefined) return null;
  return { status, lines, pieces, frame, finishFrame, gameOverFrame };
}

function parseInputs(value: unknown): GameInput[] | null {
  if (!Array.isArray(value)) return null;
  const inputs: GameInput[] = [];
  for (const item of value) {
    if (!isObject(item)) return null;
    const frame = readNonNegativeInteger(item.frame);
    const action = item.action;
    if (frame === null || !GAME_ACTIONS.includes(action as InputAction)) return null;
    inputs.push({ frame, action: action as InputAction });
  }
  return inputs.sort((a, b) => a.frame - b.frame);
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readNullableNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  return readNonNegativeInteger(value) ?? undefined;
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function isUnsignedInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
