import { OnlineRoomError } from './roomService.js';
import type { LeaderboardEntry, SubmitScoreRequest } from './protocol';

// Tope de filas que se guardan/sirven del ranking mundial. Acota el crecimiento
// del sorted set y de la memoria en dev.
export const LEADERBOARD_MAX_ENTRIES = 100;
export const LEADERBOARD_DEFAULT_LIMIT = 50;

// Metadatos de una victoria. Las `wins` no viajan en el request: las cuenta el
// store (cada envío suma una). Esto evita que un cliente declare su propio total.
export type LeaderboardWinMeta = Omit<LeaderboardEntry, 'wins'>;

export interface LeaderboardStore {
  /** Devuelve el top por victorias, descendente (el que más ganó primero). */
  topWins(limit: number): Promise<LeaderboardEntry[]>;
  /** Suma una victoria al jugador (crea la entrada si no existía). */
  recordWin(meta: LeaderboardWinMeta): Promise<void>;
}

/**
 * Implementación en memoria (dev / tests / fallback sin Redis). Acumula las
 * victorias de cada jugador, igual que la versión con Upstash.
 */
export class MemoryLeaderboardStore implements LeaderboardStore {
  private entries = new Map<string, LeaderboardEntry>();

  async topWins(limit: number): Promise<LeaderboardEntry[]> {
    return [...this.entries.values()].sort(compareEntries).slice(0, clampLimit(limit));
  }

  async recordWin(meta: LeaderboardWinMeta): Promise<void> {
    const current = this.entries.get(meta.playerId);
    this.entries.set(meta.playerId, { ...meta, wins: (current?.wins ?? 0) + 1 });
    if (this.entries.size > LEADERBOARD_MAX_ENTRIES) {
      const trimmed = [...this.entries.values()].sort(compareEntries).slice(0, LEADERBOARD_MAX_ENTRIES);
      this.entries = new Map(trimmed.map((item) => [item.playerId, item]));
    }
  }
}

function compareEntries(a: LeaderboardEntry, b: LeaderboardEntry): number {
  // Más victorias primero; a igualdad, el que llegó antes a ese total.
  return b.wins - a.wins || a.createdAtServerMs - b.createdAtServerMs;
}

export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return LEADERBOARD_DEFAULT_LIMIT;
  return Math.min(LEADERBOARD_MAX_ENTRIES, Math.floor(limit));
}

export async function getWinsLeaderboard(
  store: LeaderboardStore,
  limit = LEADERBOARD_DEFAULT_LIMIT,
): Promise<LeaderboardEntry[]> {
  return store.topWins(clampLimit(limit));
}

export async function submitWin(
  store: LeaderboardStore,
  input: SubmitScoreRequest,
  nowMs = Date.now(),
): Promise<LeaderboardWinMeta> {
  const playerId = normalizeId(input.playerId);
  if (!playerId) throw new OnlineRoomError('playerId inválido.', 400);
  const meta: LeaderboardWinMeta = {
    playerId,
    npub: normalizeNullable(input.npub),
    name: normalizeName(input.name),
    avatarUrl: normalizeNullable(input.avatarUrl),
    createdAtServerMs: nowMs,
  };
  await store.recordWin(meta);
  return meta;
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 64) : '';
}

function normalizeName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().slice(0, 24) : '';
  return name || 'Jugador';
}

function normalizeNullable(value: unknown): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  return v ? v.slice(0, 256) : null;
}
