export type OnlineStartupMark =
  | 'room-link-start'
  | 'bal-start'
  | 'bal-pubkey'
  | 'bal-ready'
  | 'invite-start'
  | 'invite-ready'
  | 'room-join-start'
  | 'room-joined';

const PREFIX = 'tetra:online-startup:';

/** Marcas visibles desde DevTools sin incluir pubkeys, tokens ni URLs. */
export function markOnlineStartup(mark: OnlineStartupMark): void {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
  const name = `${PREFIX}${mark}`;
  performance.clearMarks(name);
  performance.mark(name);
}

export function measureOnlineStartup(
  name: string,
  start: OnlineStartupMark,
  end: OnlineStartupMark,
): void {
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return;
  const measure = `${PREFIX}${name}`;
  try {
    performance.clearMeasures(measure);
    performance.measure(measure, `${PREFIX}${start}`, `${PREFIX}${end}`);
  } catch {
    // Una medición parcial no debe afectar el login ni la entrada a la sala.
  }
}
