import { DEFAULT_RULES, softDropCellsPerFrameForFactor } from '../game/rules';
import type { GameRules } from '../game/types';
import type { InputSettings } from '../input/settings';

export type CustomTab = 'game' | 'objective' | 'meta';

export const CUSTOM_TABS: CustomTab[] = ['game', 'objective', 'meta'];

export type ObjectiveMode = 'none' | 'lines';
// 'guideline' = curva exponencial estilo TETR.IO (ignora base/incremento, sube de
// nivel cada N líneas/piezas). 'linear' = modelo manual con base + incremento.
export type GravityModel = 'guideline' | 'linear';

export interface CustomSettings {
  useRandomSeed: boolean;
  seed: number;
  allowRetry: boolean;
  boardWidth: number;
  boardHeight: number;
  garbageMessinessPercent: number;
  garbageCap: number;
  changeOnAttack: boolean;
  continuousGarbage: boolean;
  useHardDrop: boolean;
  useNextQueue: boolean;
  useHoldQueue: boolean;
  nextPieces: number;
  infiniteMovement: boolean;
  infiniteHold: boolean;
  showShadowPiece: boolean;
  gravity: number;
  gravityModel: GravityModel;
  useLevelling: boolean;
  startingLevel: number;
  levelSpeed: number;
  useStaticLevelling: boolean;
  levelStaticSpeed: number;
  baseGravity: number;
  gravityIncrease: number;
  lockDelayFrames: number;
  objectiveMode: ObjectiveMode;
  objectiveLineTarget: number;
  colorBlindMode: boolean;
}

export type CustomSettingKey = keyof CustomSettings;

type CustomNumberSettingKey = {
  [Key in keyof CustomSettings]: CustomSettings[Key] extends number ? Key : never;
}[keyof CustomSettings];

export type CustomBooleanSettingKey = {
  [Key in keyof CustomSettings]: CustomSettings[Key] extends boolean ? Key : never;
}[keyof CustomSettings];

type NumberSettingMeta = {
  min: number;
  max: number;
  step: number;
  integer?: boolean;
};

const STORAGE_KEY = 'stack40.customSettings.v1';
const MAX_UINT32 = 0xffffffff;
const LOCK_RESET_LIMIT = 15;

export const CUSTOM_DEFAULT_SETTINGS: CustomSettings = {
  useRandomSeed: true,
  seed: 0,
  allowRetry: true,
  boardWidth: 10,
  boardHeight: 20,
  garbageMessinessPercent: 100,
  garbageCap: 0,
  changeOnAttack: true,
  continuousGarbage: false,
  useHardDrop: true,
  useNextQueue: true,
  useHoldQueue: true,
  nextPieces: 5,
  infiniteMovement: false,
  infiniteHold: false,
  showShadowPiece: true,
  gravity: 0.02,
  gravityModel: 'guideline',
  useLevelling: true,
  startingLevel: 1,
  levelSpeed: 1,
  useStaticLevelling: true,
  levelStaticSpeed: 10,
  baseGravity: 0.02,
  gravityIncrease: 0.007,
  lockDelayFrames: 30,
  objectiveMode: 'none',
  objectiveLineTarget: 0,
  colorBlindMode: false,
};

export const CUSTOM_NUMBER_SETTING_META: Record<CustomNumberSettingKey, NumberSettingMeta> = {
  seed: { min: 0, max: MAX_UINT32, step: 1, integer: true },
  boardWidth: { min: 4, max: 16, step: 1, integer: true },
  boardHeight: { min: 10, max: 30, step: 1, integer: true },
  garbageMessinessPercent: { min: 0, max: 100, step: 5, integer: true },
  garbageCap: { min: 0, max: 40, step: 1, integer: true },
  nextPieces: { min: 0, max: 7, step: 1, integer: true },
  gravity: { min: 0.001, max: 20, step: 0.01 },
  startingLevel: { min: 1, max: 30, step: 1, integer: true },
  levelSpeed: { min: 1, max: 60, step: 1, integer: true },
  levelStaticSpeed: { min: 1, max: 60, step: 1, integer: true },
  baseGravity: { min: 0.001, max: 20, step: 0.01 },
  gravityIncrease: { min: 0, max: 2, step: 0.001 },
  lockDelayFrames: { min: 1, max: 300, step: 1, integer: true },
  objectiveLineTarget: { min: 0, max: 999, step: 1, integer: true },
};

const BOOLEAN_SETTING_KEYS: CustomBooleanSettingKey[] = [
  'useRandomSeed',
  'allowRetry',
  'changeOnAttack',
  'continuousGarbage',
  'useHardDrop',
  'useNextQueue',
  'useHoldQueue',
  'infiniteMovement',
  'infiniteHold',
  'showShadowPiece',
  'useLevelling',
  'useStaticLevelling',
  'colorBlindMode',
];

const SETTING_KEYS = Object.keys(CUSTOM_DEFAULT_SETTINGS) as CustomSettingKey[];

export function loadCustomSettings(storage = defaultStorage()): CustomSettings {
  if (!storage) return cloneCustomSettings(CUSTOM_DEFAULT_SETTINGS);
  try {
    return normalizeCustomSettings(JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}'));
  } catch {
    return cloneCustomSettings(CUSTOM_DEFAULT_SETTINGS);
  }
}

export function saveCustomSettings(settings: CustomSettings, storage = defaultStorage()): CustomSettings {
  const normalized = normalizeCustomSettings(settings);
  storage?.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function resetCustomSettings(storage = defaultStorage()): CustomSettings {
  const defaults = cloneCustomSettings(CUSTOM_DEFAULT_SETTINGS);
  storage?.setItem(STORAGE_KEY, JSON.stringify(defaults));
  return defaults;
}

export function normalizeCustomSettings(value: unknown): CustomSettings {
  const source = isObject(value) ? value : {};
  return {
    useRandomSeed: normalizeBoolean(source.useRandomSeed, CUSTOM_DEFAULT_SETTINGS.useRandomSeed),
    seed: normalizeNumber(source.seed, 'seed'),
    allowRetry: normalizeBoolean(source.allowRetry, CUSTOM_DEFAULT_SETTINGS.allowRetry),
    boardWidth: normalizeNumber(source.boardWidth, 'boardWidth'),
    boardHeight: normalizeNumber(source.boardHeight, 'boardHeight'),
    garbageMessinessPercent: normalizeNumber(source.garbageMessinessPercent, 'garbageMessinessPercent'),
    garbageCap: normalizeNumber(source.garbageCap, 'garbageCap'),
    changeOnAttack: normalizeBoolean(source.changeOnAttack, CUSTOM_DEFAULT_SETTINGS.changeOnAttack),
    continuousGarbage: normalizeBoolean(source.continuousGarbage, CUSTOM_DEFAULT_SETTINGS.continuousGarbage),
    useHardDrop: normalizeBoolean(source.useHardDrop, CUSTOM_DEFAULT_SETTINGS.useHardDrop),
    useNextQueue: normalizeBoolean(source.useNextQueue, CUSTOM_DEFAULT_SETTINGS.useNextQueue),
    useHoldQueue: normalizeBoolean(source.useHoldQueue, CUSTOM_DEFAULT_SETTINGS.useHoldQueue),
    nextPieces: normalizeNumber(source.nextPieces, 'nextPieces'),
    infiniteMovement: normalizeBoolean(source.infiniteMovement, CUSTOM_DEFAULT_SETTINGS.infiniteMovement),
    infiniteHold: normalizeBoolean(source.infiniteHold, CUSTOM_DEFAULT_SETTINGS.infiniteHold),
    showShadowPiece: normalizeBoolean(source.showShadowPiece, CUSTOM_DEFAULT_SETTINGS.showShadowPiece),
    gravity: normalizeNumber(source.gravity, 'gravity'),
    gravityModel: normalizeLiteral(source.gravityModel, ['guideline', 'linear'], CUSTOM_DEFAULT_SETTINGS.gravityModel),
    useLevelling: normalizeBoolean(source.useLevelling, CUSTOM_DEFAULT_SETTINGS.useLevelling),
    startingLevel: normalizeNumber(source.startingLevel, 'startingLevel'),
    levelSpeed: normalizeNumber(source.levelSpeed, 'levelSpeed'),
    useStaticLevelling: normalizeBoolean(source.useStaticLevelling, CUSTOM_DEFAULT_SETTINGS.useStaticLevelling),
    levelStaticSpeed: normalizeNumber(source.levelStaticSpeed, 'levelStaticSpeed'),
    baseGravity: normalizeNumber(source.baseGravity, 'baseGravity'),
    gravityIncrease: normalizeNumber(source.gravityIncrease, 'gravityIncrease'),
    lockDelayFrames: normalizeNumber(source.lockDelayFrames, 'lockDelayFrames'),
    objectiveMode: normalizeLiteral(source.objectiveMode, ['none', 'lines'], CUSTOM_DEFAULT_SETTINGS.objectiveMode),
    objectiveLineTarget: normalizeNumber(source.objectiveLineTarget, 'objectiveLineTarget'),
    colorBlindMode: normalizeBoolean(source.colorBlindMode, CUSTOM_DEFAULT_SETTINGS.colorBlindMode),
  };
}

export function cloneCustomSettings(settings: CustomSettings): CustomSettings {
  return { ...settings };
}

export function parseCustomTab(value: string | undefined): CustomTab | null {
  if (!value) return null;
  return CUSTOM_TABS.includes(value as CustomTab) ? value as CustomTab : null;
}

export function parseCustomSettingKey(value: string | undefined): CustomSettingKey | null {
  if (!value) return null;
  return SETTING_KEYS.includes(value as CustomSettingKey) ? value as CustomSettingKey : null;
}

export function isCustomBooleanSetting(key: CustomSettingKey): key is CustomBooleanSettingKey {
  return BOOLEAN_SETTING_KEYS.includes(key as CustomBooleanSettingKey);
}

export function isCustomNumberSetting(key: CustomSettingKey): key is CustomNumberSettingKey {
  return Object.prototype.hasOwnProperty.call(CUSTOM_NUMBER_SETTING_META, key);
}

export function updateCustomSetting(
  settings: CustomSettings,
  key: CustomSettingKey,
  value: string | boolean,
): CustomSettings {
  const next = { ...settings, [key]: value };
  return normalizeCustomSettings(next);
}

export function updateCustomSettingByDelta(
  settings: CustomSettings,
  key: CustomSettingKey,
  delta: number,
): CustomSettings {
  if (!isCustomNumberSetting(key) || !Number.isFinite(delta)) return normalizeCustomSettings(settings);
  return normalizeCustomSettings({
    ...settings,
    [key]: settings[key] + delta,
  });
}

export function customRulesFromSettings(settings: CustomSettings, inputSettings: InputSettings): GameRules {
  const normalized = normalizeCustomSettings(settings);
  const usesLevelling = normalized.useLevelling;
  // 'guideline' replica la curva exponencial de Sprint/online (estilo TETR.IO): la
  // gravedad sale del nivel alcanzado e ignora base/incremento. 'linear' usa los
  // sliders manuales (base + incremento por nivel).
  const usesGuideline = normalized.gravityModel === 'guideline';
  return {
    ...DEFAULT_RULES,
    boardWidth: normalized.boardWidth,
    visibleRows: normalized.boardHeight,
    hiddenRows: DEFAULT_RULES.hiddenRows,
    nextPreview: normalized.useNextQueue ? normalized.nextPieces : 0,
    targetLines: normalized.objectiveMode === 'lines' && normalized.objectiveLineTarget > 0
      ? normalized.objectiveLineTarget
      : null,
    gravityCurve: usesGuideline ? 'guideline' : 'linear',
    gravityCellsPerFrame: usesLevelling ? normalized.baseGravity : normalized.gravity,
    gravityIncreaseCellsPerLevel: usesLevelling ? normalized.gravityIncrease : 0,
    gravityLevelLines: usesLevelling && normalized.useStaticLevelling ? normalized.levelStaticSpeed : 0,
    gravityLevelPieces: usesLevelling && !normalized.useStaticLevelling ? normalized.levelSpeed : 0,
    gravityStartingLevel: usesLevelling ? normalized.startingLevel : 1,
    lockDelayFrames: normalized.lockDelayFrames,
    dasFrames: inputSettings.dasFrames,
    arrFrames: inputSettings.arrFrames,
    softDropCellsPerFrame: softDropCellsPerFrameForFactor(inputSettings.softDropFactor),
    garbageCap: normalized.garbageCap,
    garbageMessinessPercent: normalized.garbageMessinessPercent,
    changeOnAttack: normalized.changeOnAttack,
    continuousGarbage: normalized.continuousGarbage,
    allowHardDrop: normalized.useHardDrop,
    allowHold: normalized.useHoldQueue,
    showGhost: normalized.showShadowPiece,
    infiniteHold: normalized.infiniteHold,
    infiniteMovement: normalized.infiniteMovement,
    lockResetLimit: LOCK_RESET_LIMIT,
  };
}

export function customSeed(settings: CustomSettings, randomSeed: () => number): number {
  const normalized = normalizeCustomSettings(settings);
  return normalized.useRandomSeed ? randomSeed() : normalized.seed;
}

export function formatCustomNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(4))).replace(/\.?0+$/, '');
}

function normalizeNumber(value: unknown, key: CustomNumberSettingKey): number {
  const meta = CUSTOM_NUMBER_SETTING_META[key];
  const fallback = CUSTOM_DEFAULT_SETTINGS[key];
  const numeric = typeof value === 'string'
    ? Number(value.trim().replace(',', '.'))
    : Number(value);
  const finite = Number.isFinite(numeric) ? numeric : fallback;
  const rounded = meta.integer ? Math.round(finite) : roundToStep(finite, meta.step);
  return Math.min(meta.max, Math.max(meta.min, rounded)) as CustomSettings[typeof key];
}

function roundToStep(value: number, step: number): number {
  const decimals = (String(step).split('.')[1] ?? '').length;
  return Number(value.toFixed(Math.max(decimals, 4)));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function normalizeLiteral<const T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

function defaultStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
