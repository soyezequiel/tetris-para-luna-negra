import { describe, expect, it } from 'vitest';
import { decideOutcome, pendingAttacks } from '../src/app/localVersus';

describe('duelo local · intercambio de basura', () => {
  it('cada asiento ataca al rival por la diferencia de su sentGarbage acumulado', () => {
    // Estado previo: nadie había enviado nada.
    const r1 = pendingAttacks({ seat1: 0, seat2: 0 }, 4, 0);
    expect(r1.toSeat2).toBe(4); // el asiento 1 mandó 4 → le caen al asiento 2
    expect(r1.toSeat1).toBe(0);
    expect(r1.next).toEqual({ seat1: 4, seat2: 0 });

    // Frame siguiente: el asiento 1 sube a 6 (envió 2 más), el 2 envía 3 por primera vez.
    const r2 = pendingAttacks(r1.next, 6, 3);
    expect(r2.toSeat2).toBe(2);
    expect(r2.toSeat1).toBe(3);
    expect(r2.next).toEqual({ seat1: 6, seat2: 3 });
  });

  it('sin ataques nuevos no encola basura', () => {
    const r = pendingAttacks({ seat1: 6, seat2: 3 }, 6, 3);
    expect(r.toSeat1).toBe(0);
    expect(r.toSeat2).toBe(0);
  });
});

describe('duelo local · resultado', () => {
  it('sigue jugando mientras ambos viven', () => {
    expect(decideOutcome('playing', 'playing')).toBe('playing');
  });

  it('gana el asiento cuyo rival topó', () => {
    expect(decideOutcome('playing', 'gameover')).toBe('seat1');
    expect(decideOutcome('gameover', 'playing')).toBe('seat2');
  });

  it('empate si ambos topan el mismo frame', () => {
    expect(decideOutcome('gameover', 'gameover')).toBe('draw');
  });
});
