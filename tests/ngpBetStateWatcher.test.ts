import { describe, expect, it, vi } from 'vitest';
import {
  createNgpBetStateEventGate,
  isNgpContractEventId,
  ngpBetStateWatcherTarget,
  setNgpBetStateWatcherTarget,
  type NgpBetStateWatcherSlot,
} from '../src/online/ngpBetStateWatcher';

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const ID_C = 'c'.repeat(64);

describe('NGP bet state watcher', () => {
  it('detecta contratos NGP solo como ids hex de 64 chars', () => {
    expect(isNgpContractEventId(ID_A)).toBe(true);
    expect(isNgpContractEventId(ID_A.toUpperCase())).toBe(true);
    expect(isNgpContractEventId('g'.repeat(64))).toBe(false);
    expect(isNgpContractEventId('a'.repeat(63))).toBe(false);
    expect(isNgpContractEventId(` ${ID_A}`)).toBe(false);
    expect(isNgpContractEventId(null)).toBe(false);
  });

  it('calcula target solo para apuestas NGP refresheables', () => {
    expect(ngpBetStateWatcherTarget(ID_A.toUpperCase(), true)).toBe(ID_A);
    expect(ngpBetStateWatcherTarget(ID_A, false)).toBeNull();
    expect(ngpBetStateWatcherTarget('luna_bet_1', true)).toBeNull();
    expect(ngpBetStateWatcherTarget(null, true)).toBeNull();
  });

  it('deduplica eventos repetidos y descarta eventos mas viejos', () => {
    let now = 10;
    const accept = createNgpBetStateEventGate(() => now);

    expect(accept({ id: ID_A, created_at: 100 })).toEqual({
      eventId: ID_A,
      createdAt: 100,
      receivedAtMs: 10,
    });
    now = 11;
    expect(accept({ id: ID_A, created_at: 100 })).toBeNull();
    expect(accept({ id: ID_B, created_at: 99 })).toBeNull();
    expect(accept({ id: ID_C, created_at: 100 })).toEqual({
      eventId: ID_C,
      createdAt: 100,
      receivedAtMs: 11,
    });
  });

  it('cierra y reemplaza el watcher cuando cambia el contrato', () => {
    const slot: NgpBetStateWatcherSlot = { betId: null, stop: null };
    const stopA = vi.fn();
    const stopB = vi.fn();
    const open = vi.fn((betId: string) => (betId === ID_A ? stopA : stopB));

    setNgpBetStateWatcherTarget(slot, ID_A, open);
    expect(slot.betId).toBe(ID_A);
    expect(open).toHaveBeenCalledTimes(1);

    setNgpBetStateWatcherTarget(slot, ID_A, open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(stopA).not.toHaveBeenCalled();

    setNgpBetStateWatcherTarget(slot, ID_B, open);
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(slot.betId).toBe(ID_B);
    expect(open).toHaveBeenCalledTimes(2);

    setNgpBetStateWatcherTarget(slot, null, open);
    expect(stopB).toHaveBeenCalledTimes(1);
    expect(slot.betId).toBeNull();
    expect(slot.stop).toBeNull();
  });
});
