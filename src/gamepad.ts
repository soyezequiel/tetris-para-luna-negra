import type { InputController } from './input';
import type { ControlAction } from './input/settings';

// Soporte de mandos vía la Gamepad API estándar del navegador. Cubre PlayStation
// (DualShock 4 / DualSense), Xbox (360 / One / Series), Steam Controller (vía Steam
// Input, que lo presenta como un Xbox) y Nintendo Switch (Pro Controller / Joy-Con).
// Todos exponen el "standard mapping" en Chromium/Edge cuando están emparejados,
// así que mapeamos por POSICIÓN de botón (índice estándar), no por etiqueta — de ese
// modo "el botón de abajo" rota igual sin importar si dice A, ✕ o B.
//
// En vez de reimplementar DAS/ARR/soft-drop, traducimos el estado del mando a las
// mismas llamadas pressControl/releaseControl que usa el teclado. Así el mando hereda
// todo el handling (last-key-wins, ráfaga ARR 0, repetición de soft drop) sin duplicar
// nada. La fuente (sourceId) es estable por acción para que el D-pad y el stick en la
// misma dirección no cuenten doble.

// Índices del "standard gamepad mapping" (https://w3c.github.io/gamepad/#remapping).
const BUTTON = {
  faceDown: 0, // A / ✕ / B(switch)
  faceRight: 1, // B / ○ / A(switch)
  faceLeft: 2, // X / □ / Y(switch)
  faceUp: 3, // Y / △ / X(switch)
  l1: 4, // LB / L1 / L
  r1: 5, // RB / R1 / R
  l2: 6, // LT / L2 / ZL
  r2: 7, // RT / R2 / ZR
  select: 8, // Back / Share / -
  start: 9, // Start / Options / +
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
} as const;

// Mapa botón → acción. Varios botones pueden compartir acción (rotar con el botón
// de abajo o con el gatillo derecho) y eso es deseado.
const BUTTON_ACTIONS: ReadonlyArray<readonly [number, ControlAction]> = [
  [BUTTON.faceDown, 'rotateCW'],
  [BUTTON.faceRight, 'rotateCCW'],
  [BUTTON.faceLeft, 'hold'],
  [BUTTON.faceUp, 'rotate180'],
  [BUTTON.l1, 'rotateCCW'],
  [BUTTON.r1, 'rotateCW'],
  [BUTTON.l2, 'hold'],
  [BUTTON.r2, 'hold'],
  [BUTTON.select, 'retry'],
  [BUTTON.start, 'pause'],
  [BUTTON.dpadUp, 'hardDrop'],
  [BUTTON.dpadDown, 'softDrop'],
  [BUTTON.dpadLeft, 'moveLeft'],
  [BUTTON.dpadRight, 'moveRight'],
];

// Umbral para considerar pulsado un gatillo analógico (L2/R2 reportan value 0..1).
const TRIGGER_THRESHOLD = 0.4;
// Zona muerta del stick: entra como dirección a 0.5, sale a 0.35 (histéresis para
// que un stick que tiembla cerca del umbral no genere parpadeo de pulsaciones).
const AXIS_ENTER = 0.5;
const AXIS_EXIT = 0.35;

export interface GamepadControllerOptions {
  // Permite inyectar un navigator de prueba (tests / SSR). Por defecto, el global.
  getGamepads?: () => Array<Gamepad | null>;
  eventTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  onConnectionChange?: (connectedCount: number, lastName: string | null) => void;
}

export class GamepadController {
  private readonly input: InputController;
  private readonly getGamepads: () => Array<Gamepad | null>;
  private readonly eventTarget: GamepadControllerOptions['eventTarget'];
  private readonly onConnectionChange?: GamepadControllerOptions['onConnectionChange'];
  // Acciones activas en el último poll (para detectar flancos: nueva = press, ida = release).
  private active = new Set<ControlAction>();
  private connectedCount = 0;

  constructor(input: InputController, options: GamepadControllerOptions = {}) {
    this.input = input;
    this.getGamepads = options.getGamepads
      ?? (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'
        ? () => navigator.getGamepads()
        : () => []);
    this.eventTarget = options.eventTarget === undefined
      ? (typeof window === 'undefined' ? null : window)
      : options.eventTarget;
    this.onConnectionChange = options.onConnectionChange;
    this.eventTarget?.addEventListener('gamepadconnected', this.onConnected as EventListener);
    this.eventTarget?.addEventListener('gamepaddisconnected', this.onDisconnected as EventListener);
  }

  destroy(): void {
    this.eventTarget?.removeEventListener('gamepadconnected', this.onConnected as EventListener);
    this.eventTarget?.removeEventListener('gamepaddisconnected', this.onDisconnected as EventListener);
    this.releaseAll();
  }

  // Llamar una vez por frame del loop, antes de input.collect(). Lee el estado de
  // todos los mandos y emite press/release sólo en los flancos.
  poll(): void {
    const next = this.computeActiveActions();
    for (const action of next) {
      if (!this.active.has(action)) this.input.pressControl(`pad:${action}`, action);
    }
    for (const action of this.active) {
      if (!next.has(action)) this.input.releaseControl(`pad:${action}`);
    }
    this.active = next;
  }

  releaseAll(): void {
    for (const action of this.active) this.input.releaseControl(`pad:${action}`);
    this.active.clear();
  }

  private computeActiveActions(): Set<ControlAction> {
    const next = new Set<ControlAction>();
    const pads = this.getGamepads();
    for (const pad of pads) {
      if (!pad) continue;
      this.collectButtonActions(pad, next);
      this.collectAxisActions(pad, next);
    }
    return next;
  }

  private collectButtonActions(pad: Gamepad, out: Set<ControlAction>): void {
    const buttons = pad.buttons;
    for (const [index, action] of BUTTON_ACTIONS) {
      const button = buttons[index];
      if (!button) continue;
      const threshold = index === BUTTON.l2 || index === BUTTON.r2 ? TRIGGER_THRESHOLD : 0.5;
      if (button.pressed || button.value >= threshold) out.add(action);
    }
  }

  private collectAxisActions(pad: Gamepad, out: Set<ControlAction>): void {
    // Stick izquierdo: X → mover, Y hacia abajo → soft drop. Deliberadamente NO mapeamos
    // el stick hacia arriba a hard drop: un toque accidental hacia arriba arruinaría
    // la partida. El hard drop vive en el D-pad arriba y se puede rebindear si hace falta.
    const x = pad.axes[0] ?? 0;
    const y = pad.axes[1] ?? 0;
    this.applyAxis(x, 'moveLeft', 'moveRight', out);
    if (this.axisActive(y, 'softDrop', AXIS_ENTER, AXIS_EXIT)) out.add('softDrop');
  }

  private applyAxis(value: number, negative: ControlAction, positive: ControlAction, out: Set<ControlAction>): void {
    if (this.axisActive(value, negative, -AXIS_ENTER, -AXIS_EXIT, true)) out.add(negative);
    else if (this.axisActive(value, positive, AXIS_ENTER, AXIS_EXIT)) out.add(positive);
  }

  // Histéresis: si la acción ya estaba activa, usa el umbral de salida (más bajo);
  // si no, exige el umbral de entrada. `inverted` maneja el lado negativo del eje.
  private axisActive(value: number, action: ControlAction, enter: number, exit: number, inverted = false): boolean {
    const threshold = this.active.has(action) ? exit : enter;
    return inverted ? value <= threshold : value >= threshold;
  }

  private onConnected = (event: GamepadEvent): void => {
    this.connectedCount += 1;
    this.onConnectionChange?.(this.connectedCount, event.gamepad?.id ?? null);
  };

  private onDisconnected = (event: GamepadEvent): void => {
    this.connectedCount = Math.max(0, this.connectedCount - 1);
    // Al desconectar, soltamos todo lo que tuviera pulsado ese mando para que la
    // pieza no quede "deslizándose" sola.
    this.releaseAll();
    this.onConnectionChange?.(this.connectedCount, event.gamepad?.id ?? null);
  };
}
