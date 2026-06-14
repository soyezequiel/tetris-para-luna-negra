import { describe, expect, it } from 'vitest';
import { InputController, type ControlInput } from '../src/input';
import { GamepadController } from '../src/gamepad';
import { DEFAULT_INPUT_SETTINGS } from '../src/input/settings';

// Construye un Gamepad-like mínimo con el "standard mapping". Pasá índices de botón
// pulsados y/o ejes para simular el estado del mando en un poll.
function makePad(opts: { buttons?: Record<number, number>; axes?: number[] } = {}): Gamepad {
  const buttonValues = opts.buttons ?? {};
  const buttons = Array.from({ length: 17 }, (_unused, index) => {
    const value = buttonValues[index] ?? 0;
    return { pressed: value >= 0.5, touched: value > 0, value } as GamepadButton;
  });
  const axes = [0, 0, 0, 0];
  (opts.axes ?? []).forEach((value, index) => { axes[index] = value; });
  return { buttons, axes, connected: true, id: 'test-pad', index: 0, mapping: 'standard', timestamp: 0 } as unknown as Gamepad;
}

function makeRig(initialPad: Gamepad | null = null): {
  input: InputController;
  pad: GamepadController;
  setPad: (pad: Gamepad | null) => void;
} {
  let current: Gamepad | null = initialPad;
  const input = new InputController(DEFAULT_INPUT_SETTINGS, null);
  const pad = new GamepadController(input, {
    getGamepads: () => [current],
    eventTarget: null,
  });
  return { input, pad, setPad: (next) => { current = next; } };
}

// Un frame del loop: poll del mando + collect del InputController.
function tick(rig: ReturnType<typeof makeRig>, frame: number): ControlInput[] {
  rig.pad.poll();
  rig.input.advanceFrame(frame);
  return rig.input.collect(frame);
}

function actions(inputs: ControlInput[]): string[] {
  return inputs.map((input) => input.action);
}

describe('GamepadController mapeo estándar', () => {
  it('el botón de abajo (0) rota CW; el de la derecha (1) rota CCW', () => {
    const rig = makeRig();
    rig.setPad(makePad({ buttons: { 0: 1 } }));
    expect(actions(tick(rig, 1))).toContain('rotateCW');

    rig.setPad(makePad({ buttons: { 1: 1 } }));
    expect(actions(tick(rig, 2))).toContain('rotateCCW');
  });

  it('D-pad arriba/abajo/izq/der mapean a hardDrop/softDrop/move', () => {
    const rig = makeRig();
    rig.setPad(makePad({ buttons: { 12: 1 } }));
    expect(actions(tick(rig, 1))).toContain('hardDrop');
    rig.setPad(makePad({ buttons: { 14: 1 } }));
    expect(actions(tick(rig, 2))).toContain('moveLeft');
    rig.setPad(makePad({ buttons: { 15: 1 } }));
    expect(actions(tick(rig, 3))).toContain('moveRight');
  });

  it('Start (9) pausa y Select (8) reinicia', () => {
    const rig = makeRig();
    rig.setPad(makePad({ buttons: { 9: 1 } }));
    expect(actions(tick(rig, 1))).toContain('pause');
    rig.setPad(makePad({ buttons: { 8: 1 } }));
    expect(actions(tick(rig, 2))).toContain('retry');
  });

  it('los gatillos analógicos L2/R2 cuentan como pulsados sobre el umbral', () => {
    const rig = makeRig();
    rig.setPad(makePad({ buttons: { 7: 0.6 } })); // R2 a medio recorrido
    expect(actions(tick(rig, 1))).toContain('hold');
  });

  it('el stick izquierdo mueve por encima de la zona muerta', () => {
    const rig = makeRig();
    rig.setPad(makePad({ axes: [-0.9, 0] }));
    expect(actions(tick(rig, 1))).toContain('moveLeft');
    rig.setPad(makePad({ axes: [0.9, 0] }));
    expect(actions(tick(rig, 2))).toContain('moveRight');
    rig.setPad(makePad({ axes: [0, 0.9] }));
    expect(actions(tick(rig, 3))).toContain('softDrop');
  });

  it('un stick dentro de la zona muerta no genera movimiento', () => {
    const rig = makeRig();
    rig.setPad(makePad({ axes: [0.2, 0.2] }));
    expect(tick(rig, 1)).toHaveLength(0);
  });

  it('emite el tap una sola vez mientras se mantiene el botón (no repite rotación)', () => {
    const rig = makeRig();
    const held = makePad({ buttons: { 0: 1 } });
    rig.setPad(held);
    expect(actions(tick(rig, 1)).filter((a) => a === 'rotateCW')).toHaveLength(1);
    // Sigue pulsado en frames siguientes: rotateCW no es repetible, no debe re-emitirse.
    expect(actions(tick(rig, 2))).not.toContain('rotateCW');
    expect(actions(tick(rig, 3))).not.toContain('rotateCW');
  });

  it('mantener el stick repite el movimiento según DAS/ARR', () => {
    const rig = makeRig();
    rig.setPad(makePad({ axes: [-0.9, 0] }));
    // tap inicial en frame 1
    expect(actions(tick(rig, 1))).toContain('moveLeft');
    let repeats = 0;
    for (let frame = 2; frame <= 40; frame += 1) {
      repeats += actions(tick(rig, frame)).filter((a) => a === 'moveLeft').length;
    }
    expect(repeats).toBeGreaterThan(0); // el DAS/ARR del InputController dispara repeticiones
  });

  it('soltar el D-pad libera la acción (deja de moverse)', () => {
    const rig = makeRig();
    rig.setPad(makePad({ buttons: { 15: 1 } }));
    tick(rig, 1); // press
    rig.setPad(makePad()); // todo suelto
    tick(rig, 2);
    // tras soltar, ningún frame siguiente debe emitir moveRight
    for (let frame = 3; frame <= 30; frame += 1) {
      expect(actions(tick(rig, frame))).not.toContain('moveRight');
    }
  });

  it('al desconectar el mando se sueltan las acciones mantenidas', () => {
    const rig = makeRig();
    rig.setPad(makePad({ buttons: { 15: 1 } }));
    tick(rig, 1);
    rig.setPad(null); // sin mandos
    tick(rig, 2);
    for (let frame = 3; frame <= 20; frame += 1) {
      expect(actions(tick(rig, frame))).not.toContain('moveRight');
    }
  });
});
