import {
  DEFAULT_RULES,
  DEFAULT_SOFT_DROP_FACTOR,
  INSTANT_SOFT_DROP_FACTOR,
  MIN_SOFT_DROP_FACTOR,
} from '../game/rules';
import type { InputAction } from '../game/types';

export type ControlAction = InputAction | 'pause';

export const GAME_ACTIONS: InputAction[] = [
  'moveLeft',
  'moveRight',
  'softDrop',
  'hardDrop',
  'rotateCW',
  'rotateCCW',
  'rotate180',
  'hold',
  'retry',
];

export const CONTROL_ACTIONS: ControlAction[] = [...GAME_ACTIONS, 'pause'];

export const CONTROL_ACTION_LABELS: Record<ControlAction, string> = {
  moveLeft: 'Mover izquierda',
  moveRight: 'Mover derecha',
  softDrop: 'Bajar suave',
  hardDrop: 'Caída rápida',
  rotateCW: 'Girar a la derecha',
  rotateCCW: 'Girar a la izquierda',
  rotate180: 'Media vuelta (180°)',
  hold: 'Guardar pieza',
  retry: 'Reiniciar',
  pause: 'Pausar',
};

export type InputBindings = Record<ControlAction, string[]>;

export interface InputSettings {
  bindings: InputBindings;
  dasFrames: number;
  arrFrames: number;
  // Velocidad de soft drop (≈ celdas/seg). INSTANT_SOFT_DROP_FACTOR = instantáneo.
  softDropFactor: number;
}

export const DEFAULT_BINDINGS: InputBindings = {
  moveLeft: ['ArrowLeft'],
  moveRight: ['ArrowRight'],
  softDrop: ['ArrowDown'],
  hardDrop: ['Space'],
  rotateCW: ['ArrowUp', 'KeyX'],
  rotateCCW: ['KeyZ'],
  rotate180: ['KeyA'],
  hold: ['KeyC', 'ShiftLeft', 'ShiftRight'],
  retry: ['KeyR'],
  pause: ['Escape'],
};

export const DEFAULT_INPUT_SETTINGS: InputSettings = {
  bindings: cloneBindings(DEFAULT_BINDINGS),
  dasFrames: DEFAULT_RULES.dasFrames,
  arrFrames: DEFAULT_RULES.arrFrames,
  softDropFactor: DEFAULT_SOFT_DROP_FACTOR,
};

// Presets de handling de un click. Sólo tocan timing; respetan los bindings.
export type HandlingPreset = 'classic' | 'default' | 'agile' | 'competitive';

export interface HandlingPresetDef {
  label: string;
  dasFrames: number;
  arrFrames: number;
  softDropFactor: number;
}

export const HANDLING_PRESETS: Record<HandlingPreset, HandlingPresetDef> = {
  classic: { label: 'Clásico', dasFrames: 10, arrFrames: 2, softDropFactor: 20 },
  default: { label: 'Actual', dasFrames: 8, arrFrames: 2, softDropFactor: 40 },
  agile: { label: 'Ágil', dasFrames: 7, arrFrames: 1, softDropFactor: 40 },
  competitive: { label: 'Competitivo', dasFrames: 6, arrFrames: 0, softDropFactor: INSTANT_SOFT_DROP_FACTOR },
};

export const HANDLING_PRESET_ORDER: HandlingPreset[] = ['classic', 'default', 'agile', 'competitive'];

const STORAGE_KEY = 'stack40.inputSettings';
const LEGACY_DEFAULT_TIMINGS = [
  { dasFrames: 9, arrFrames: 1 },
  { dasFrames: 12, arrFrames: 2 },
];
const MIN_DAS_FRAMES = 0;
const MAX_DAS_FRAMES = 30;
const MIN_ARR_FRAMES = 0;
const MAX_ARR_FRAMES = 10;

export function loadInputSettings(): InputSettings {
  try {
    return normalizeInputSettings(migrateStoredInputSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')));
  } catch {
    return normalizeInputSettings({});
  }
}

export function saveInputSettings(settings: InputSettings): InputSettings {
  const normalized = normalizeInputSettings(settings);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function normalizeInputSettings(value: unknown): InputSettings {
  const partial = isObject(value) ? value : {};
  const bindings = normalizeBindings(partial.bindings);
  return {
    bindings,
    dasFrames: normalizeInteger(partial.dasFrames, DEFAULT_INPUT_SETTINGS.dasFrames, MIN_DAS_FRAMES, MAX_DAS_FRAMES),
    arrFrames: normalizeInteger(partial.arrFrames, DEFAULT_INPUT_SETTINGS.arrFrames, MIN_ARR_FRAMES, MAX_ARR_FRAMES),
    softDropFactor: normalizeInteger(
      partial.softDropFactor,
      DEFAULT_INPUT_SETTINGS.softDropFactor,
      MIN_SOFT_DROP_FACTOR,
      INSTANT_SOFT_DROP_FACTOR,
    ),
  };
}

export function updateBinding(settings: InputSettings, action: ControlAction, code: string): InputSettings {
  const normalized = normalizeInputSettings(settings);
  const nextBindings = cloneBindings(normalized.bindings);
  for (const candidate of CONTROL_ACTIONS) {
    nextBindings[candidate] = nextBindings[candidate].filter((binding) => binding !== code);
  }
  nextBindings[action] = [code];
  return normalizeInputSettings({ ...normalized, bindings: nextBindings });
}

export type InputTimingKey = 'dasFrames' | 'arrFrames' | 'softDropFactor';

export function updateInputTiming(
  settings: InputSettings,
  key: InputTimingKey,
  delta: number,
): InputSettings {
  const normalized = normalizeInputSettings(settings);
  return normalizeInputSettings({
    ...normalized,
    [key]: normalized[key] + delta,
  });
}

export function applyHandlingPreset(settings: InputSettings, preset: HandlingPreset): InputSettings {
  const normalized = normalizeInputSettings(settings);
  const def = HANDLING_PRESETS[preset];
  return normalizeInputSettings({
    ...normalized,
    dasFrames: def.dasFrames,
    arrFrames: def.arrFrames,
    softDropFactor: def.softDropFactor,
  });
}

// Devuelve el preset cuyos timings coinciden exactamente con los settings (para
// resaltar el activo en la UI), o null si están personalizados.
export function matchHandlingPreset(settings: InputSettings): HandlingPreset | null {
  const normalized = normalizeInputSettings(settings);
  return HANDLING_PRESET_ORDER.find((preset) => {
    const def = HANDLING_PRESETS[preset];
    return normalized.dasFrames === def.dasFrames
      && normalized.arrFrames === def.arrFrames
      && normalized.softDropFactor === def.softDropFactor;
  }) ?? null;
}

export function resetInputSettings(): InputSettings {
  return normalizeInputSettings(DEFAULT_INPUT_SETTINGS);
}

export function actionForCode(settings: InputSettings, code: string): ControlAction | null {
  for (const action of CONTROL_ACTIONS) {
    if (settings.bindings[action].includes(code)) return action;
  }
  return null;
}

export function isGameAction(action: ControlAction): action is InputAction {
  return GAME_ACTIONS.includes(action as InputAction);
}

export function cloneInputSettings(settings: InputSettings): InputSettings {
  const normalized = normalizeInputSettings(settings);
  return {
    bindings: cloneBindings(normalized.bindings),
    dasFrames: normalized.dasFrames,
    arrFrames: normalized.arrFrames,
    softDropFactor: normalized.softDropFactor,
  };
}

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return code.slice(5);
  if (code === 'Space') return 'Space';
  if (code === 'Escape') return 'Esc';
  if (code === 'ShiftLeft') return 'L Shift';
  if (code === 'ShiftRight') return 'R Shift';
  if (code === 'ControlLeft') return 'L Ctrl';
  if (code === 'ControlRight') return 'R Ctrl';
  if (code === 'AltLeft') return 'L Alt';
  if (code === 'AltRight') return 'R Alt';
  return code;
}

function normalizeBindings(value: unknown): InputBindings {
  const source = isObject(value) ? value : {};
  const usedCodes = new Set<string>();
  const bindings = cloneBindings(DEFAULT_BINDINGS);

  for (const action of CONTROL_ACTIONS) {
    const hasExplicitBinding = Object.prototype.hasOwnProperty.call(source, action);
    const candidate = source[action];
    const normalized = hasExplicitBinding && Array.isArray(candidate)
      ? candidate.filter((code): code is string => typeof code === 'string' && code.length > 0)
      : [];
    const deduped = normalized.filter((code) => {
      if (usedCodes.has(code)) return false;
      usedCodes.add(code);
      return true;
    });
    bindings[action] = hasExplicitBinding ? deduped : DEFAULT_BINDINGS[action].filter((code) => !usedCodes.has(code));
    for (const code of bindings[action]) usedCodes.add(code);
  }

  return bindings;
}

function cloneBindings(bindings: InputBindings): InputBindings {
  return CONTROL_ACTIONS.reduce((acc, action) => {
    acc[action] = [...bindings[action]];
    return acc;
  }, {} as InputBindings);
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function migrateStoredInputSettings(value: unknown): unknown {
  if (!isObject(value)) return value;
  if (LEGACY_DEFAULT_TIMINGS.some((timing) => (
    value.dasFrames === timing.dasFrames && value.arrFrames === timing.arrFrames
  ))) {
    return {
      ...value,
      dasFrames: DEFAULT_INPUT_SETTINGS.dasFrames,
      arrFrames: DEFAULT_INPUT_SETTINGS.arrFrames,
    };
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
