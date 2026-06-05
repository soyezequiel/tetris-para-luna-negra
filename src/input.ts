import type { GameInput } from './game/types';
import { actionForCode, type ControlAction, type InputSettings } from './input/settings';

export interface ControlInput {
  frame: number;
  action: ControlAction;
}

export class InputController {
  private readonly pressed = new Map<string, { frame: number; action: ControlAction }>();
  private readonly queue: ControlInput[] = [];
  private settings: InputSettings;
  private readonly eventTarget: Window | null;

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
  }

  pressControl(sourceId: string, action: ControlAction): void {
    if (this.pressed.has(sourceId)) return;
    this.queue.push({ frame: 0, action });
    if (isHeldAction(action)) this.pressed.set(sourceId, { frame: 0, action });
  }

  releaseControl(sourceId: string): void {
    this.pressed.delete(sourceId);
  }

  collect(frame: number): ControlInput[] {
    const inputs = this.queue.splice(0);
    for (const [, held] of this.pressed) {
      if (held.action === 'softDrop') {
        inputs.push({ frame, action: held.action });
        continue;
      }
      if (held.action !== 'moveLeft' && held.action !== 'moveRight') continue;
      const age = frame - held.frame;
      if (age >= this.settings.dasFrames && (age - this.settings.dasFrames) % this.settings.arrFrames === 0) {
        inputs.push({ frame, action: held.action });
      }
    }
    return inputs;
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
      if (held.frame === 0) this.pressed.set(key, { ...held, frame });
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

function isHeldAction(action: ControlAction): boolean {
  return action === 'moveLeft' || action === 'moveRight' || action === 'softDrop';
}
