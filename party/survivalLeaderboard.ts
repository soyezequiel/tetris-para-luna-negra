import { Server } from 'partyserver';
import {
  SURVIVAL_DEFAULT_LIMIT,
  MemorySurvivalLeaderboardStore,
  type SurvivalTimeMeta,
} from '../src/online/survivalLeaderboard.js';
import type { SurvivalEntry } from '../src/online/protocol.js';
import type { Env } from './env.js';

/** Nombre del DO singleton: hay un único top de supervivencia mundial. */
export const SURVIVAL_PARTY_ID = 'global';

/** Clave del storage durable donde vive el snapshot del top (sobrevive hibernación). */
const ENTRIES_STORAGE_KEY = 'entries';

/**
 * Top de supervivencia (modo "igual para todos") sobre un único Durable Object,
 * paralelo al ranking de victorias (`LeaderboardServer`). El mejor tiempo por jugador
 * y la poda al top N viven en `MemorySurvivalLeaderboardStore` —el mismo store que el
 * fallback en memoria—, así que la lógica no se duplica; el DO solo agrega persistencia.
 *
 * Los mensajes a un DO se procesan en serie (un solo escritor por vez). Se accede vía
 * el bridge HTTP `/__bridge/survival` (ver party/index.ts).
 */
export class SurvivalLeaderboardServer extends Server<Env> {
  private readonly store = new MemorySurvivalLeaderboardStore();

  async onStart(): Promise<void> {
    const stored = await this.ctx.storage.get<SurvivalEntry[]>(ENTRIES_STORAGE_KEY);
    if (stored) this.store.hydrate(stored);
  }

  /** Top por tiempo, descendente. */
  async topTimes(limit: number = SURVIVAL_DEFAULT_LIMIT): Promise<SurvivalEntry[]> {
    return this.store.topTimes(limit);
  }

  /** Registra un tiempo (solo mejora el récord), persiste el snapshot y devuelve el top. */
  async recordTime(meta: SurvivalTimeMeta): Promise<SurvivalEntry[]> {
    await this.store.recordTime(meta);
    await this.ctx.storage.put(ENTRIES_STORAGE_KEY, this.store.snapshot());
    return this.store.topTimes(SURVIVAL_DEFAULT_LIMIT);
  }
}
