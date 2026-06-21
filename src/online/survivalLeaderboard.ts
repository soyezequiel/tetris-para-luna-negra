import { OnlineRoomError } from './roomService.js';
import type { SurvivalEntry, SubmitSurvivalRequest } from './protocol';

// Tope de filas que se guardan/sirven del top de supervivencia. Acota el crecimiento
// del store y de la memoria en dev.
export const SURVIVAL_MAX_ENTRIES = 100;
export const SURVIVAL_DEFAULT_LIMIT = 50;

// Metadatos de un tiempo de supervivencia. El store guarda el MEJOR (mayor) tiempo
// de cada jugador: cada envío reemplaza el récord previo solo si lo supera.
export type SurvivalTimeMeta = SurvivalEntry;

export interface SurvivalLeaderboardStore {
  /** Devuelve el top por tiempo, descendente (el que más sobrevivió primero). */
  topTimes(limit: number): Promise<SurvivalEntry[]>;
  /** Registra un tiempo del jugador (solo mejora su récord; nunca lo baja). */
  recordTime(meta: SurvivalTimeMeta): Promise<void>;
}

/**
 * Implementación en memoria (dev / tests / fallback). Guarda el mejor tiempo de
 * cada jugador, igual estructura que `MemoryLeaderboardStore` (victorias).
 */
export class MemorySurvivalLeaderboardStore implements SurvivalLeaderboardStore {
  private entries = new Map<string, SurvivalEntry>();

  async topTimes(limit: number): Promise<SurvivalEntry[]> {
    // El top mundial solo lista a jugadores con sesión de Luna Negra (npub). El filtro
    // va también acá —no solo en recordTime— para esconder entradas de invitados que
    // pudieran haber quedado persistidas de antes de aplicar esta regla.
    return [...this.entries.values()]
      .filter((entry) => entry.npub)
      .sort(compareEntries)
      .slice(0, clampLimit(limit));
  }

  async recordTime(meta: SurvivalTimeMeta): Promise<void> {
    // Sin sesión de Luna Negra (sin npub) no se entra al top: lo descartamos en silencio
    // para que el ranking solo cuente jugadores identificados.
    if (!meta.npub) return;
    const current = this.entries.get(meta.playerId);
    // Solo guardamos si supera el récord previo (o si no había uno).
    if (!current || meta.bestMs > current.bestMs) {
      this.entries.set(meta.playerId, meta);
    }
    if (this.entries.size > SURVIVAL_MAX_ENTRIES) {
      const trimmed = [...this.entries.values()].sort(compareEntries).slice(0, SURVIVAL_MAX_ENTRIES);
      this.entries = new Map(trimmed.map((item) => [item.playerId, item]));
    }
  }

  /** Snapshot serializable para persistir en el storage durable del Durable Object. */
  snapshot(): SurvivalEntry[] {
    return [...this.entries.values()];
  }

  /** Rehidrata desde un snapshot persistido (al (re)arrancar el DO tras hibernar). */
  hydrate(entries: SurvivalEntry[]): void {
    this.entries = new Map(entries.map((entry) => [entry.playerId, entry]));
  }
}

function compareEntries(a: SurvivalEntry, b: SurvivalEntry): number {
  // Más tiempo primero; a igualdad, el que lo logró antes.
  return b.bestMs - a.bestMs || a.createdAtServerMs - b.createdAtServerMs;
}

export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return SURVIVAL_DEFAULT_LIMIT;
  return Math.min(SURVIVAL_MAX_ENTRIES, Math.floor(limit));
}

export async function getSurvivalLeaderboard(
  store: SurvivalLeaderboardStore,
  limit = SURVIVAL_DEFAULT_LIMIT,
): Promise<SurvivalEntry[]> {
  return store.topTimes(clampLimit(limit));
}

export async function submitSurvival(
  store: SurvivalLeaderboardStore,
  input: SubmitSurvivalRequest,
  nowMs = Date.now(),
): Promise<SurvivalTimeMeta> {
  const playerId = normalizeId(input.playerId);
  if (!playerId) throw new OnlineRoomError('playerId inválido.', 400);
  const bestMs = normalizeDuration(input.durationMs);
  if (bestMs === null) throw new OnlineRoomError('durationMs inválido.', 400);
  const meta: SurvivalTimeMeta = {
    playerId,
    npub: normalizeNullable(input.npub),
    name: normalizeName(input.name),
    avatarUrl: normalizeNullable(input.avatarUrl),
    bestMs,
    createdAtServerMs: nowMs,
  };
  await store.recordTime(meta);
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

// Tope defensivo: 24h de partida es físicamente imposible; recorta valores
// absurdos (overflow / cheat trivial) sin necesitar anti-cheat real.
const MAX_SURVIVAL_MS = 24 * 60 * 60 * 1000;

function normalizeDuration(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(MAX_SURVIVAL_MS, Math.floor(value));
}
