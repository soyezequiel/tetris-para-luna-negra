import type { Event } from 'nostr-tools';
import { getPool } from './nostrRelays';
import { NGP_READ_RELAYS } from './ngpRelays';

type SubCloser = { close: () => void };

export interface NgpBetStatePush {
  eventId: string;
  createdAt: number;
  receivedAtMs: number;
}

export interface NgpBetStateWatcherSlot {
  betId: string | null;
  stop: (() => void) | null;
}

export function isNgpContractEventId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

export function ngpBetStateWatcherTarget(
  betId: string | null | undefined,
  refreshable: boolean,
): string | null {
  if (!refreshable || !isNgpContractEventId(betId)) return null;
  return betId.trim().toLowerCase();
}

export function setNgpBetStateWatcherTarget(
  slot: NgpBetStateWatcherSlot,
  targetBetId: string | null,
  open: (betId: string) => () => void,
): void {
  if (slot.betId === targetBetId) return;
  try {
    slot.stop?.();
  } catch {
    // ignore
  }
  slot.betId = null;
  slot.stop = null;
  if (!targetBetId) return;
  slot.betId = targetBetId;
  slot.stop = open(targetBetId);
}

export function createNgpBetStateEventGate(
  nowMs: () => number = Date.now,
): (event: Pick<Event, 'id' | 'created_at'>) => NgpBetStatePush | null {
  const seen = new Set<string>();
  let lastAcceptedCreatedAt = 0;

  return (event) => {
    if (!isNgpContractEventId(event.id)) return null;
    if (seen.has(event.id)) return null;
    if (event.created_at < lastAcceptedCreatedAt) return null;
    seen.add(event.id);
    lastAcceptedCreatedAt = Math.max(lastAcceptedCreatedAt, event.created_at);
    return {
      eventId: event.id,
      createdAt: event.created_at,
      receivedAtMs: nowMs(),
    };
  };
}

export function startNgpBetStateWatcher(
  contractId: string,
  onEvent: (push: NgpBetStatePush, event: Event) => void,
): () => void {
  if (!isNgpContractEventId(contractId)) return () => undefined;

  let closed = false;
  let sub: SubCloser | null = null;
  const accept = createNgpBetStateEventGate();

  try {
    sub = getPool().subscribeMany(
      NGP_READ_RELAYS,
      {
        kinds: [31340],
        '#d': [contractId.toLowerCase()],
        since: Math.floor(Date.now() / 1000) - 60,
      },
      {
        onevent: (event: Event) => {
          if (closed) return;
          const push = accept(event);
          if (!push || closed) return;
          onEvent(push, event);
        },
      },
    );
  } catch {
    // Best-effort: el polling existente sigue funcionando si no podemos suscribir.
  }

  return () => {
    if (closed) return;
    closed = true;
    try {
      sub?.close();
    } catch {
      // ignore
    }
  };
}
