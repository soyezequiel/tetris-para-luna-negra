import type { GameInput } from './game/types';
import { actionForCode, type ControlAction, type InputSettings } from './input/settings';

export interface ControlInput {
  frame: number;
  action: ControlAction;
}

// Con ARR 0 ("instantáneo a la pared") emitimos un ráfaga de movimientos en el
// mismo frame; el engine frena en la pared, así que alcanza con cubrir el ancho
// máximo razonable de tablero. Costo despreciable (cada move extra es un no-op
// al chocar).
const REPEAT_BURST = 24;

interface HeldKey {
  action: ControlAction;
  // Orden de pulsación: la dirección horizontal con mayor seq "gana" (last key wins).
  seq: number;
  // Frame en que se anclo el DAS. null hasta que advanceFrame lo fija.
  startFrame: number | null;
  // Próximo frame en el que toca emitir un repeat. Infinity = DAS aún sin cargar.
  nextRepeatFrame: number;
}

export class InputController {
  private readonly pressed = new Map<string, HeldKey>();
  private readonly queue: ControlInput[] = [];
  private settings: InputSettings;
  private readonly eventTarget: Window | null;
  private pressCounter = 0;
  // Última dirección horizontal dominante; al cambiar, re-evaluamos su DAS.
  private lastHorizDominant: string | null = null;

  constructor(settings: InputSettings, eventTarget: Window | null = typeof window === 'undefined' ? null : window) {
    this.settings = settings;
    this.eventTarget = eventTarget;
    this.eventTarget?.addEventListener('keydown', this.onKeyDown);
    this.eventTarget?.addEventListener('keyup', this.onKeyUp);
  }

  destroy(): void {
    this.eventTarget?.removeEventListener('keydown', this.onKeyDown);
    this.eventTarget?.removeEventListener('keyup', this.onKeyUp);
  }

  updateSettings(settings: InputSettings): void {
    this.settings = settings;
    this.releaseAll();
  }

  releaseAll(): void {
    this.pressed.clear();
    this.queue.length = 0;
    this.lastHorizDominant = null;
  }

  pressControl(sourceId: string, action: ControlAction): void {
    if (this.pressed.has(sourceId)) return;
    this.queue.push({ frame: 0, action });
    if (isRepeatableAction(action)) {
      this.pressCounter += 1;
      this.pressed.set(sourceId, {
        action,
        seq: this.pressCounter,
        startFrame: null,
        nextRepeatFrame: Number.POSITIVE_INFINITY,
      });
    }
  }

  releaseControl(sourceId: string): void {
    this.pressed.delete(sourceId);
  }

  collect(frame: number): ControlInput[] {
    // Taps inmediatos (el primer movimiento al pulsar, sin esperar DAS).
    const inputs = this.queue.splice(0);
    const das = this.settings.dasFrames;
    const arr = this.settings.arrFrames;

    this.reconcileHorizontalDominance(frame, das);
    const dominant = this.lastHorizDominant;

    for (const [sourceId, held] of this.pressed) {
      if (held.startFrame === null) continue;
      const age = frame - held.startFrame;

      if (held.action === 'softDrop') {
        if (age > 0) inputs.push({ frame, action: held.action });
        continue;
      }

      if (!isHorizontalRepeatAction(held.action)) continue;
      // Sólo la dirección dominante repite; la otra queda suprimida (last key wins).
      if (sourceId !== dominant) continue;
      if (held.nextRepeatFrame === Number.POSITIVE_INFINITY) continue;
      if (held.nextRepeatFrame > frame) continue;

      if (arr <= 0) {
        // ARR 0: ráfaga a la pared en este mismo frame.
        for (let k = 0; k < REPEAT_BURST; k += 1) inputs.push({ frame, action: held.action });
        held.nextRepeatFrame = frame + 1;
        continue;
      }
      // Acumulador: emite todos los repeats vencidos (robusto ante frames salteados).
      while (held.nextRepeatFrame <= frame) {
        inputs.push({ frame, action: held.action });
        held.nextRepeatFrame += arr;
      }
    }

    return inputs;
  }

  // Determina la dirección horizontal dominante (la pulsada más recientemente) y,
  // al cambiar, programa su próximo repeat: si la tecla ya tenía el DAS cargado
  // (venías manteniéndola: caso "soltar la otra dirección"), dispara de inmediato;
  // si es una pulsación reciente, espera a que se cargue el DAS.
  private reconcileHorizontalDominance(frame: number, das: number): void {
    let dominant: string | null = null;
    let bestSeq = -1;
    for (const [sourceId, held] of this.pressed) {
      if (!isHorizontalRepeatAction(held.action)) continue;
      if (held.startFrame === null) continue;
      if (held.seq > bestSeq) {
        bestSeq = held.seq;
        dominant = sourceId;
      }
    }

    if (dominant === this.lastHorizDominant) return;
    if (dominant) {
      const held = this.pressed.get(dominant)!;
      const age = held.startFrame === null ? 0 : frame - held.startFrame;
      held.nextRepeatFrame = age >= das
        ? frame // DAS ya cargado: repetir ya (sin ráfaga de golpe).
        : (held.startFrame ?? frame) + das;
    }
    this.lastHorizDominant = dominant;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (isEditableKeyboardTarget(event.target)) return;
    if (isBrowserShortcutKeyDown(event)) return;
    if (event.repeat) return;
    const action = actionForCode(this.settings, event.code);
    if (!action) return;
    event.preventDefault();
    this.pressControl(`key:${event.code}`, action);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.releaseControl(`key:${event.code}`);
  };

  advanceFrame(frame: number): void {
    for (const [key, held] of this.pressed) {
      if (held.startFrame === null) this.pressed.set(key, { ...held, startFrame: frame });
    }
  }
}

export function toGameInput(input: ControlInput): GameInput {
  return input as GameInput;
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  if (typeof HTMLInputElement !== 'undefined' && target instanceof HTMLInputElement) return true;
  if (typeof HTMLTextAreaElement !== 'undefined' && target instanceof HTMLTextAreaElement) return true;
  if (typeof HTMLSelectElement !== 'undefined' && target instanceof HTMLSelectElement) return true;
  return typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && target.isContentEditable;
}

export function isBrowserShortcutKeyDown(event: KeyboardEvent): boolean {
  if (event.ctrlKey && event.code !== 'ControlLeft' && event.code !== 'ControlRight') return true;
  if (event.metaKey && event.code !== 'MetaLeft' && event.code !== 'MetaRight') return true;
  if (event.altKey && event.code !== 'AltLeft' && event.code !== 'AltRight') return true;
  return false;
}

function isRepeatableAction(action: ControlAction): boolean {
  return isHorizontalRepeatAction(action) || action === 'softDrop';
}

function isHorizontalRepeatAction(action: ControlAction): boolean {
  return action === 'moveLeft' || action === 'moveRight';
}
