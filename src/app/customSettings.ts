import { DEFAULT_RULES } from '../game/rules';
import type { GameRules } from '../game/types';
import type { InputSettings } from '../input/settings';

export type CustomTab = 'game' | 'objective' | 'meta';

export const CUSTOM_TABS: CustomTab[] = ['game', 'objective', 'meta'];

export type RandomBagType = '7-bag';
export type AllowedSpins = 'all-mini-plus';
export type ComboTable = 'multiplier';
export type SurvivalMode = 'none';
export type KickTable = 'srs-plus';
export type ObjectiveMode = 'none' | 'lines';
export type MusicMode = 'random-calm';

export interface CustomSettings {
  randomBagType: RandomBagType;
  allowedSpins: AllowedSpins;
  comboTable: ComboTable;
  enableAllClears: boolean;
  useRandomSeed: boolean;
  seed: number;
  allowRetry: boolean;
  stock: number;
  enableClutchClears: boolean;
  disableLockout: boolean;
  boardWidth: number;
  boardHeight: number;
  survivalMode: SurvivalMode;
  garbageMessinessPercent: number;
  garbageCap: number;
  changeOnAttack: boolean;
  continuousGarbage: boolean;
  layerHeight: number;
  stickyLayer: boolean;
  minimumLayerHeight: number;
  timerIntervalSeconds: number;
  allow180Spins: boolean;
  kickTable: KickTable;
  useHardDrop: boolean;
  useNextQueue: boolean;
  useHoldQueue: boolean;
  nextPieces: number;
  infiniteMovement: boolean;
  infiniteHold: boolean;
  showShadowPiece: boolean;
  areFrames: number;
  lineClearAreFrames: number;
  gravity: number;
  useLevelling: boolean;
  useMasterLevels: boolean;
  startingLevel: number;
  levelSpeed: number;
  useStaticLevelling: boolean;
  levelStaticSpeed: number;
  baseGravity: number;
  gravityIncrease: number;
  lockDelayFrames: number;
  objectiveMode: ObjectiveMode;
  objectiveLineTarget: number;
  musicMode: MusicMode;
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
  randomBagType: '7-bag',
  allowedSpins: 'all-mini-plus',
  comboTable: 'multiplier',
  enableAllClears: true,
  useRandomSeed: true,
  seed: 0,
  allowRetry: true,
  stock: 0,
  enableClutchClears: true,
  disableLockout: true,
  boardWidth: 10,
  boardHeight: 20,
  survivalMode: 'none',
  garbageMessinessPercent: 100,
  garbageCap: 0,
  changeOnAttack: true,
  continuousGarbage: false,
  layerHeight: 9,
  stickyLayer: true,
  minimumLayerHeight: 3,
  timerIntervalSeconds: 60,
  allow180Spins: true,
  kickTable: 'srs-plus',
  useHardDrop: true,
  useNextQueue: true,
  useHoldQueue: true,
  nextPieces: 5,
  infiniteMovement: false,
  infiniteHold: false,
  showShadowPiece: true,
  areFrames: 0,
  lineClearAreFrames: 0,
  gravity: 0.02,
  useLevelling: true,
  useMasterLevels: false,
  startingLevel: 1,
  levelSpeed: 1,
  useStaticLevelling: true,
  levelStaticSpeed: 10,
  baseGravity: 0.02,
  gravityIncrease: 0.007,
  lockDelayFrames: 30,
  objectiveMode: 'none',
  objectiveLineTarget: 0,
  musicMode: 'random-calm',
};

export const CUSTOM_NUMBER_SETTING_META: Record<CustomNumberSettingKey, NumberSettingMeta> = {
  seed: { min: 0, max: MAX_UINT32, step: 1, integer: true },
  stock: { min: 0, max: 99, step: 1, integer: true },
  boardWidth: { min: 4, max: 16, step: 1, integer: true },
  boardHeight: { min: 10, max: 30, step: 1, integer: true },
  garbageMessinessPercent: { min: 0, max: 100, step: 5, integer: true },
  garbageCap: { min: 0, max: 40, step: 1, integer: true },
  layerHeight: { min: 1, max: 20, step: 1, integer: true },
  minimumLayerHeight: { min: 0, max: 20, step: 1, integer: true },
  timerIntervalSeconds: { min: 1, max: 600, step: 1, integer: true },
  nextPieces: { min: 0, max: 7, step: 1, integer: true },
  areFrames: { min: 0, max: 120, step: 1, integer: true },
  lineClearAreFrames: { min: 0, max: 120, step: 1, integer: true },
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
  'enableAllClears',
  'useRandomSeed',
  'allowRetry',
  'enableClutchClears',
  'disableLockout',
  'changeOnAttack',
  'continuousGarbage',
  'stickyLayer',
  'allow180Spins',
  'useHardDrop',
  'useNextQueue',
  'useHoldQueue',
  'infiniteMovement',
  'infiniteHold',
  'showShadowPiece',
  'useLevelling',
  'useMasterLevels',
  'useStaticLevelling',
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
    randomBagType: normalizeLiteral(source.randomBagType, ['7-bag'], CUSTOM_DEFAULT_SETTINGS.randomBagType),
    allowedSpins: normalizeLiteral(source.allowedSpins, ['all-mini-plus'], CUSTOM_DEFAULT_SETTINGS.allowedSpins),
    comboTable: normalizeLiteral(source.comboTable, ['multiplier'], CUSTOM_DEFAULT_SETTINGS.comboTable),
    enableAllClears: normalizeBoolean(source.enableAllClears, CUSTOM_DEFAULT_SETTINGS.enableAllClears),
    useRandomSeed: normalizeBoolean(source.useRandomSeed, CUSTOM_DEFAULT_SETTINGS.useRandomSeed),
    seed: normalizeNumber(source.seed, 'seed'),
    allowRetry: normalizeBoolean(source.allowRetry, CUSTOM_DEFAULT_SETTINGS.allowRetry),
    stock: normalizeNumber(source.stock, 'stock'),
    enableClutchClears: normalizeBoolean(source.enableClutchClears, CUSTOM_DEFAULT_SETTINGS.enableClutchClears),
    disableLockout: normalizeBoolean(source.disableLockout, CUSTOM_DEFAULT_SETTINGS.disableLockout),
    boardWidth: normalizeNumber(source.boardWidth, 'boardWidth'),
    boardHeight: normalizeNumber(source.boardHeight, 'boardHeight'),
    survivalMode: normalizeLiteral(source.survivalMode, ['none'], CUSTOM_DEFAULT_SETTINGS.survivalMode),
    garbageMessinessPercent: normalizeNumber(source.garbageMessinessPercent, 'garbageMessinessPercent'),
    garbageCap: normalizeNumber(source.garbageCap, 'garbageCap'),
    changeOnAttack: normalizeBoolean(source.changeOnAttack, CUSTOM_DEFAULT_SETTINGS.changeOnAttack),
    continuousGarbage: normalizeBoolean(source.continuousGarbage, CUSTOM_DEFAULT_SETTINGS.continuousGarbage),
    layerHeight: normalizeNumber(source.layerHeight, 'layerHeight'),
    stickyLayer: normalizeBoolean(source.stickyLayer, CUSTOM_DEFAULT_SETTINGS.stickyLayer),
    minimumLayerHeight: normalizeNumber(source.minimumLayerHeight, 'minimumLayerHeight'),
    timerIntervalSeconds: normalizeNumber(source.timerIntervalSeconds, 'timerIntervalSeconds'),
    allow180Spins: normalizeBoolean(source.allow180Spins, CUSTOM_DEFAULT_SETTINGS.allow180Spins),
    kickTable: normalizeLiteral(source.kickTable, ['srs-plus'], CUSTOM_DEFAULT_SETTINGS.kickTable),
    useHardDrop: normalizeBoolean(source.useHardDrop, CUSTOM_DEFAULT_SETTINGS.useHardDrop),
    useNextQueue: normalizeBoolean(source.useNextQueue, CUSTOM_DEFAULT_SETTINGS.useNextQueue),
    useHoldQueue: normalizeBoolean(source.useHoldQueue, CUSTOM_DEFAULT_SETTINGS.useHoldQueue),
    nextPieces: normalizeNumber(source.nextPieces, 'nextPieces'),
    infiniteMovement: normalizeBoolean(source.infiniteMovement, CUSTOM_DEFAULT_SETTINGS.infiniteMovement),
    infiniteHold: normalizeBoolean(source.infiniteHold, CUSTOM_DEFAULT_SETTINGS.infiniteHold),
    showShadowPiece: normalizeBoolean(source.showShadowPiece, CUSTOM_DEFAULT_SETTINGS.showShadowPiece),
    areFrames: normalizeNumber(source.areFrames, 'areFrames'),
    lineClearAreFrames: normalizeNumber(source.lineClearAreFrames, 'lineClearAreFrames'),
    gravity: normalizeNumber(source.gravity, 'gravity'),
    useLevelling: normalizeBoolean(source.useLevelling, CUSTOM_DEFAULT_SETTINGS.useLevelling),
    useMasterLevels: normalizeBoolean(source.useMasterLevels, CUSTOM_DEFAULT_SETTINGS.useMasterLevels),
    startingLevel: normalizeNumber(source.startingLevel, 'startingLevel'),
    levelSpeed: normalizeNumber(source.levelSpeed, 'levelSpeed'),
    useStaticLevelling: normalizeBoolean(source.useStaticLevelling, CUSTOM_DEFAULT_SETTINGS.useStaticLevelling),
    levelStaticSpeed: normalizeNumber(source.levelStaticSpeed, 'levelStaticSpeed'),
    baseGravity: normalizeNumber(source.baseGravity, 'baseGravity'),
    gravityIncrease: normalizeNumber(source.gravityIncrease, 'gravityIncrease'),
    lockDelayFrames: normalizeNumber(source.lockDelayFrames, 'lockDelayFrames'),
    objectiveMode: normalizeLiteral(source.objectiveMode, ['none', 'lines'], CUSTOM_DEFAULT_SETTINGS.objectiveMode),
    objectiveLineTarget: normalizeNumber(source.objectiveLineTarget, 'objectiveLineTarget'),
    musicMode: normalizeLiteral(source.musicMode, ['random-calm'], CUSTOM_DEFAULT_SETTINGS.musicMode),
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
  return {
    ...DEFAULT_RULES,
    boardWidth: normalized.boardWidth,
    visibleRows: normalized.boardHeight,
    hiddenRows: DEFAULT_RULES.hiddenRows,
    nextPreview: normalized.useNextQueue ? normalized.nextPieces : 0,
    targetLines: normalized.objectiveMode === 'lines' && normalized.objectiveLineTarget > 0
      ? normalized.objectiveLineTarget
      : null,
    gravityCellsPerFrame: usesLevelling ? normalized.baseGravity : normalized.gravity,
    gravityIncreaseCellsPerLevel: usesLevelling ? normalized.gravityIncrease : 0,
    gravityLevelLines: usesLevelling && normalized.useStaticLevelling ? normalized.levelStaticSpeed : 0,
    gravityLevelPieces: usesLevelling && !normalized.useStaticLevelling ? normalized.levelSpeed : 0,
    gravityStartingLevel: usesLevelling ? normalized.startingLevel : 1,
    lockDelayFrames: normalized.lockDelayFrames,
    dasFrames: inputSettings.dasFrames,
    arrFrames: inputSettings.arrFrames,
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
