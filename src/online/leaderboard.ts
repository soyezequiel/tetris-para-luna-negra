import { OnlineRoomError } from './roomService.js';
import type { LeaderboardEntry, SubmitScoreRequest } from './protocol';

// Tope de filas que se guardan/sirven del ranking mundial. Acota el crecimiento
// del sorted set y de la memoria en dev.
export const LEADERBOARD_MAX_ENTRIES = 100;
export const LEADERBOARD_DEFAULT_LIMIT = 50;
// Cotas de validación del tiempo de un sprint de 40 líneas (el juego corre a 60
// fps). Piso y techo descartan envíos absurdos sin pretender ser anti-cheat.
export const SPRINT40_MIN_FRAMES = 60; // 1 segundo
export const SPRINT40_MAX_FRAMES = 60 * 60 * 60; // 60 minutos

export interface LeaderboardStore {
  /** Devuelve el top de mejores tiempos, ascendente (el más rápido primero). */
  topSprint40(limit: number): Promise<LeaderboardEntry[]>;
  /** Guarda el resultado solo si mejora el mejor tiempo previo del jugador. */
  submitSprint40(entry: LeaderboardEntry): Promise<void>;
}

/**
 * Implementación en memoria (dev / tests / fallback sin Redis). Conserva solo el
 * mejor tiempo de cada jugador, igual que la versión con Upstash.
 */
export class MemoryLeaderboardStore implements LeaderboardStore {
  private best = new Map<string, LeaderboardEntry>();

  async topSprint40(limit: number): Promise<LeaderboardEntry[]> {
    return [...this.best.values()].sort(compareEntries).slice(0, clampLimit(limit));
  }

  async submitSprint40(entry: LeaderboardEntry): Promise<void> {
    const current = this.best.get(entry.playerId);
    if (!current || entry.elapsedFrames < current.elapsedFrames) {
      this.best.set(entry.playerId, entry);
    }
    if (this.best.size > LEADERBOARD_MAX_ENTRIES) {
      const trimmed = [...this.best.values()].sort(compareEntries).slice(0, LEADERBOARD_MAX_ENTRIES);
      this.best = new Map(trimmed.map((item) => [item.playerId, item]));
    }
  }
}

function compareEntries(a: LeaderboardEntry, b: LeaderboardEntry): number {
  return a.elapsedFrames - b.elapsedFrames || a.createdAtServerMs - b.createdAtServerMs;
}

export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return LEADERBOARD_DEFAULT_LIMIT;
  return Math.min(LEADERBOARD_MAX_ENTRIES, Math.floor(limit));
}

export async function getSprint40Leaderboard(
  store: LeaderboardStore,
  limit = LEADERBOARD_DEFAULT_LIMIT,
): Promise<LeaderboardEntry[]> {
  return store.topSprint40(clampLimit(limit));
}

export async function submitSprint40Score(
  store: LeaderboardStore,
  input: SubmitScoreRequest,
  nowMs = Date.now(),
): Promise<LeaderboardEntry> {
  const playerId = normalizeId(input.playerId);
  if (!playerId) throw new OnlineRoomError('playerId inválido.', 400);
  const elapsedFrames = Math.floor(Number(input.elapsedFrames));
  if (!Number.isFinite(elapsedFrames) || elapsedFrames < SPRINT40_MIN_FRAMES || elapsedFrames > SPRINT40_MAX_FRAMES) {
    throw new OnlineRoomError('Tiempo de sprint inválido.', 400);
  }
  const entry: LeaderboardEntry = {
    playerId,
    npub: normalizeNullable(input.npub),
    name: normalizeName(input.name),
    avatarUrl: normalizeNullable(input.avatarUrl),
    elapsedFrames,
    createdAtServerMs: nowMs,
  };
  await store.submitSprint40(entry);
  return entry;
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
