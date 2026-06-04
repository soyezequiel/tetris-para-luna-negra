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

  constructor(settings: InputSettings) {
    this.settings = settings;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  updateSettings(settings: InputSettings): void {
    this.settings = settings;
    this.releaseAll();
  }

  releaseAll(): void {
    this.pressed.clear();
    this.queue.length = 0;
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
    if (event.repeat) return;
    const action = actionForCode(this.settings, event.code);
    if (!action) return;
    event.preventDefault();
    this.queue.push({ frame: 0, action });
    if (action === 'moveLeft' || action === 'moveRight' || action === 'softDrop') this.pressed.set(event.code, { frame: 0, action });
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
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
