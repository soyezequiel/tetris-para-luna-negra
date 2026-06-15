import { afterEach, describe, expect, it } from 'vitest';
import { isPositionalAudio, panForScreenX, setPositionalAudio } from '../src/audio/spatial';

// Restablece el interruptor a su default (on) tras cada caso para no filtrar estado.
afterEach(() => setPositionalAudio(true));

describe('panForScreenX', () => {
  const WIDTH = 1000;

  it('panea el centro de la pantalla a 0', () => {
    expect(panForScreenX(500, WIDTH)).toBeCloseTo(0, 5);
  });

  it('panea a la izquierda (negativo) y a la derecha (positivo)', () => {
    expect(panForScreenX(250, WIDTH)).toBeLessThan(0);
    expect(panForScreenX(750, WIDTH)).toBeGreaterThan(0);
  });

  it('acota los bordes a ±0.9 (no a tope duro)', () => {
    expect(panForScreenX(0, WIDTH)).toBeCloseTo(-0.9, 5);
    expect(panForScreenX(WIDTH, WIDTH)).toBeCloseTo(0.9, 5);
    // Más allá del viewport sigue acotado.
    expect(panForScreenX(-9999, WIDTH)).toBe(-0.9);
    expect(panForScreenX(9999, WIDTH)).toBe(0.9);
  });

  it('es simétrico respecto al centro', () => {
    expect(panForScreenX(300, WIDTH)).toBeCloseTo(-panForScreenX(700, WIDTH), 5);
  });

  it('devuelve 0 con entradas inválidas o viewport nulo', () => {
    expect(panForScreenX(Number.NaN, WIDTH)).toBe(0);
    expect(panForScreenX(500, 0)).toBe(0);
  });

  it('devuelve 0 cuando el audio posicional está desactivado', () => {
    setPositionalAudio(false);
    expect(isPositionalAudio()).toBe(false);
    expect(panForScreenX(0, WIDTH)).toBe(0);
    expect(panForScreenX(WIDTH, WIDTH)).toBe(0);
  });
});
