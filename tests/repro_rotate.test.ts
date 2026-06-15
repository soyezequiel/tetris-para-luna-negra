import { describe, it, expect } from 'vitest';
import { GameEngine } from '../src/game/engine';
import { BATTLE_RULES } from '../src/game/rules';
import type { Cell } from '../src/game/types';

const TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'] as const;
const W = 10;
const H = 40; // hiddenRows 20 + visibleRows 20

// Construye un tablero lleno desde la fila `topFilled` (incluida) hasta el fondo,
// dejando una columna `well` vacía. topFilled=20 => pila llena hasta el borde
// superior del campo visible (la pieza "sobresale" del tablero al apoyarse).
function stack(topFilled: number, well: number): Cell[][] {
  const board: Cell[][] = Array.from({ length: H }, (_, y) =>
    Array.from({ length: W }, (_, x): Cell => (y >= topFilled && x !== well ? 'Z' : null)),
  );
  return board;
}

describe('rotación con la ficha sobresaliendo del campo visible', () => {
  it('brute force: pila alta + pieza arriba, rota en todas direcciones', () => {
    const failures: string[] = [];
    // Pila que llega al borde visible (y=20) y un poco dentro del buffer (y=18,16).
    for (const topFilled of [22, 20, 18, 16]) {
      for (let well = 0; well < W; well++) {
        for (const type of TYPES) {
          if (type === 'O') continue;
          for (let rot = 0 as 0 | 1 | 2 | 3; rot < 4; rot++) {
            // Apoyamos la pieza justo encima de la superficie llena, en columnas
            // centrales (lejos de las paredes laterales, que son otro caso aparte).
            for (const x of [3, 4, 5]) {
              for (const dir of [1, -1, 2] as const) {
                const engine = new GameEngine(1, BATTLE_RULES) as any;
                engine.board = stack(topFilled, well).map((r: Cell[]) => [...r]);
                const y = topFilled - 2; // la ficha sobresale por encima de la pila
                engine.active = { type, rotation: rot, x, y };
                // descartar setups donde la pieza ya choca (inválidos)
                if (engine.collides(engine.active)) continue;
                const before = JSON.stringify(engine.active);
                engine.applyInput(dir === 1 ? 'rotateCW' : dir === -1 ? 'rotateCCW' : 'rotate180');
                const after = JSON.stringify(engine.active);
                if (before === after) {
                  failures.push(`top${topFilled} well${well} ${type} r${rot} x${x} y${y} dir${dir}`);
                }
              }
            }
          }
        }
      }
    }
    console.log('STUCK ROTATIONS:', failures.length);
    console.log(failures.slice(0, 80).join('\n'));
    expect({ count: failures.length, sample: failures.slice(0, 40) }).toEqual({ count: 0, sample: [] });
  });

  it('escenario garbage-lift: la basura empuja la pieza al buffer y luego rota', () => {
    const failures: string[] = [];
    for (let prefill = 14; prefill <= 30; prefill += 2) {
      for (const type of TYPES) {
        if (type === 'O') continue;
        const engine = new GameEngine(1, BATTLE_RULES) as any;
        // Pila previa que llega hasta `prefill`, hueco en col 0.
        engine.board = stack(prefill, 0);
        // Forzamos la pieza activa de tipo conocido cerca del techo de la pila.
        engine.active = { type, rotation: 0, x: 4, y: prefill - 2 };
        if (engine.collides(engine.active)) continue;
        const liftedBefore = JSON.stringify(engine.active);
        // Encolamos y aplicamos basura: debería levantar la pieza.
        engine.queueGarbage(8, 0, engine.frame);
        engine.applyPendingGarbage(engine.frame + 1000);
        if (engine.status !== 'playing' || !engine.active) {
          failures.push(`${type} prefill${prefill}: GAME OVER tras garbage (${engine.gameOverReason})`);
          continue;
        }
        const liftedAfter = JSON.stringify(engine.active);
        // Ahora intentamos rotar la pieza levantada.
        const before = JSON.stringify(engine.active);
        engine.applyInput('rotateCW');
        const after = JSON.stringify(engine.active);
        if (before === after) {
          failures.push(`${type} prefill${prefill}: rota STUCK lift ${liftedBefore}->${liftedAfter}`);
        }
      }
    }
    console.log('LIFT FAILS:', failures.length);
    console.log(failures.join('\n'));
    expect({ count: failures.length, sample: failures.slice(0, 40) }).toEqual({ count: 0, sample: [] });
  });
});
