import { Server } from 'partyserver';
import {
  LEADERBOARD_DEFAULT_LIMIT,
  MemoryLeaderboardStore,
  type LeaderboardWinMeta,
} from '../src/online/leaderboard.js';
import type { LeaderboardEntry } from '../src/online/protocol.js';
import type { Env } from './env.js';

/** Nombre del DO singleton: hay un único ranking mundial. */
export const LEADERBOARD_PARTY_ID = 'global';

/** Clave del storage durable donde vive el snapshot del ranking (sobrevive hibernación). */
const ENTRIES_STORAGE_KEY = 'entries';

/**
 * Ranking mundial sobre un único Durable Object, reemplazando a Upstash (que se
 * quedaba sin cuota y tiraba abajo el "Top mundial"). El conteo de victorias y la
 * poda al top N viven en `MemoryLeaderboardStore` —el mismo store que el fallback
 * en memoria—, así que la lógica no se duplica; el DO solo agrega persistencia.
 *
 * Los mensajes a un DO se procesan en serie, así que no hace falta el script Lua
 * atómico que usaba Upstash para el ZINCRBY + poda: un solo escritor por vez.
 * Se accede vía el bridge HTTP `/__bridge/leaderboard` (ver party/index.ts).
 */
export class LeaderboardServer extends Server<Env> {
  private readonly store = new MemoryLeaderboardStore();

  async onStart(): Promise<void> {
    const stored = await this.ctx.storage.get<LeaderboardEntry[]>(ENTRIES_STORAGE_KEY);
    if (stored) this.store.hydrate(stored);
  }

  /** Top por victorias, descendente. */
  async topWins(limit: number = LEADERBOARD_DEFAULT_LIMIT): Promise<LeaderboardEntry[]> {
    return this.store.topWins(limit);
  }

  /** Suma una victoria, persiste el snapshot y devuelve el top actualizado. */
  async recordWin(meta: LeaderboardWinMeta): Promise<LeaderboardEntry[]> {
    await this.store.recordWin(meta);
    await this.ctx.storage.put(ENTRIES_STORAGE_KEY, this.store.snapshot());
    return this.store.topWins(LEADERBOARD_DEFAULT_LIMIT);
  }
}
