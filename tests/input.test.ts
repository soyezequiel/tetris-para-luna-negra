import { describe, expect, it } from 'vitest';
import { InputController, type ControlInput } from '../src/input';
import {
  applyHandlingPreset,
  DEFAULT_INPUT_SETTINGS,
  matchHandlingPreset,
  normalizeInputSettings,
  type InputSettings,
} from '../src/input/settings';
import {
  DEFAULT_SOFT_DROP_FACTOR,
  INSTANT_SOFT_DROP_FACTOR,
  softDropCellsPerFrameForFactor,
} from '../src/game/rules';

function makeController(overrides: Partial<InputSettings> = {}): InputController {
  // eventTarget null => no se enganchan listeners de teclado; manejamos todo a mano.
  return new InputController({ ...DEFAULT_INPUT_SETTINGS, ...overrides }, null);
}

// Simula un frame del loop: ancla las teclas nuevas y recolecta los inputs.
function tick(controller: InputController, frame: number): ControlInput[] {
  controller.advanceFrame(frame);
  return controller.collect(frame);
}

function countAction(inputs: ControlInput[], action: string): number {
  return inputs.filter((input) => input.action === action).length;
}

describe('InputController DAS/ARR', () => {
  it('un tap mueve exactamente una celda', () => {
    const controller = makeController({ dasFrames: 8, arrFrames: 2 });
    controller.pressControl('key:ArrowLeft', 'moveLeft');
    expect(countAction(tick(controller, 1), 'moveLeft')).toBe(1);
    controller.releaseControl('key:ArrowLeft');
    expect(countAction(tick(controller, 2), 'moveLeft')).toBe(0);
    expect(countAction(tick(controller, 3), 'moveLeft')).toBe(0);
  });

  it('mantener dispara el primer repeat tras DAS y luego cada ARR', () => {
    const controller = makeController({ dasFrames: 8, arrFrames: 2 });
    controller.pressControl('key:ArrowLeft', 'moveLeft');
    expect(countAction(tick(controller, 1), 'moveLeft')).toBe(1); // tap inicial (ancla en frame 1)

    const fired: number[] = [];
    for (let frame = 2; frame <= 16; frame += 1) {
      if (countAction(tick(controller, frame), 'moveLeft') > 0) fired.push(frame);
    }
    // startFrame = 1, primer repeat en 1 + DAS(8) = 9, luego cada ARR(2): 9, 11, 13, 15.
    expect(fired).toEqual([9, 11, 13, 15]);
  });

  it('no pierde repeats cuando el loop saltea frames (acumulador)', () => {
    const controller = makeController({ dasFrames: 8, arrFrames: 2 });
    controller.pressControl('key:ArrowLeft', 'moveLeft');
    tick(controller, 1); // ancla startFrame = 1

    // Salto directo al frame 20 sin recolectar los intermedios (jitter / GC).
    controller.advanceFrame(20);
    const burst = controller.collect(20);
    // Repeats vencidos: 9, 11, 13, 15, 17, 19 -> 6 movimientos acumulados, no 1.
    expect(countAction(burst, 'moveLeft')).toBe(6);
  });

  it('ARR 0 emite una ráfaga a la pared en un solo frame', () => {
    const controller = makeController({ dasFrames: 8, arrFrames: 0 });
    controller.pressControl('key:ArrowRight', 'moveRight');
    tick(controller, 1); // ancla startFrame = 1

    for (let frame = 2; frame <= 8; frame += 1) {
      expect(countAction(tick(controller, frame), 'moveRight')).toBe(0);
    }
    // En el frame 9 (startFrame + DAS) ya supera el ancho de cualquier tablero.
    expect(countAction(tick(controller, 9), 'moveRight')).toBeGreaterThanOrEqual(10);
  });

  it('soft drop repite cada frame mientras se mantiene', () => {
    const controller = makeController();
    controller.pressControl('key:ArrowDown', 'softDrop');
    expect(countAction(tick(controller, 1), 'softDrop')).toBe(1); // tap inicial
    expect(countAction(tick(controller, 2), 'softDrop')).toBe(1);
    expect(countAction(tick(controller, 3), 'softDrop')).toBe(1);
  });
});

describe('InputController prioridad last-key-wins', () => {
  it('al mantener ambas direcciones solo repite la última pulsada', () => {
    const controller = makeController({ dasFrames: 8, arrFrames: 2 });
    controller.pressControl('key:ArrowLeft', 'moveLeft');
    tick(controller, 1); // tap left, ancla left en frame 1

    controller.pressControl('key:ArrowRight', 'moveRight');
    tick(controller, 2); // tap right, ancla right en frame 2; right pasa a dominar

    // Right carga DAS desde el frame 2 -> primer repeat en 2 + 8 = 10.
    let leftRepeats = 0;
    let rightRepeats = 0;
    for (let frame = 3; frame <= 12; frame += 1) {
      const inputs = tick(controller, frame);
      leftRepeats += countAction(inputs, 'moveLeft');
      rightRepeats += countAction(inputs, 'moveRight');
    }
    expect(leftRepeats).toBe(0); // left queda suprimida aunque tenga el DAS más viejo
    expect(rightRepeats).toBeGreaterThan(0);
  });

  it('al soltar la dirección activa la otra retoma con el DAS ya cargado', () => {
    const controller = makeController({ dasFrames: 8, arrFrames: 2 });
    controller.pressControl('key:ArrowLeft', 'moveLeft');
    tick(controller, 1);
    controller.pressControl('key:ArrowRight', 'moveRight');
    for (let frame = 2; frame <= 12; frame += 1) tick(controller, frame);

    controller.releaseControl('key:ArrowRight');
    // Left venía mantenida desde el frame 1 (DAS sobradamente cargado): dispara ya.
    expect(countAction(tick(controller, 13), 'moveLeft')).toBeGreaterThan(0);
  });
});

describe('soft drop configurable', () => {
  it('mapea el factor a celdas por frame y soporta instantáneo', () => {
    expect(softDropCellsPerFrameForFactor(DEFAULT_SOFT_DROP_FACTOR)).toBeCloseTo(39 / 60, 6);
    expect(softDropCellsPerFrameForFactor(20)).toBeCloseTo(19 / 60, 6);
    // Instantáneo: cae lo suficiente para cruzar cualquier tablero en un frame.
    expect(softDropCellsPerFrameForFactor(INSTANT_SOFT_DROP_FACTOR)).toBeGreaterThanOrEqual(30);
  });
});

describe('normalizeInputSettings', () => {
  it('permite ARR 0 y completa softDropFactor por defecto', () => {
    const normalized = normalizeInputSettings({ arrFrames: 0 });
    expect(normalized.arrFrames).toBe(0);
    expect(normalized.softDropFactor).toBe(DEFAULT_SOFT_DROP_FACTOR);
  });

  it('clampea softDropFactor al rango válido', () => {
    expect(normalizeInputSettings({ softDropFactor: 1 }).softDropFactor).toBe(5);
    expect(normalizeInputSettings({ softDropFactor: 999 }).softDropFactor).toBe(INSTANT_SOFT_DROP_FACTOR);
  });
});

describe('presets de handling', () => {
  it('Competitivo aplica DAS 6 / ARR 0 / soft drop instantáneo sin tocar bindings', () => {
    const next = applyHandlingPreset(DEFAULT_INPUT_SETTINGS, 'competitive');
    expect(next.dasFrames).toBe(6);
    expect(next.arrFrames).toBe(0);
    expect(next.softDropFactor).toBe(INSTANT_SOFT_DROP_FACTOR);
    expect(next.bindings).toEqual(DEFAULT_INPUT_SETTINGS.bindings);
  });

  it('los settings por defecto coinciden con el preset "Actual"', () => {
    expect(matchHandlingPreset(DEFAULT_INPUT_SETTINGS)).toBe('default');
  });
});
