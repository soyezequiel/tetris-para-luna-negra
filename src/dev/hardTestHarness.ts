// ─────────────────────── HARD TEST MULTIJUGADOR: orquestador ───────────────────────
// Maneja una corrida de 8 jugadores (vos con autoplay + 7 bots) sobre el stack online
// REAL, dispara los caminos no felices elegidos y al final evalúa invariantes y manda
// el reporte a Discord. No toca el DOM ni el online stack directo: todo pasa por la
// interfaz `HardTestHost`, que main.ts implementa con closures sobre sus internals.
// Solo se carga vía import() dinámico detrás de import.meta.env.DEV.

import {
  evaluateHardTest,
  type HardTestConfig,
  type HardTestEvidence,
  type HardTestResult,
  type TimelineEntry,
} from './hardTestReport';
import type { OnlineRoom } from '../online/protocol';

/** Handle mínimo de un bot que el harness manipula para el caos. */
export interface HardTestBotHandle {
  playerId: string;
  forceTopOut(): void;
  dispose(): void;
}

/** Puente hacia main.ts: todo lo que el harness necesita del online stack real. */
export interface HardTestHost {
  selfPlayerId(): string;
  /** Reloj sincronizado con el servidor (onlineNowMs). */
  nowMs(): number;
  /** Crea la sala privada con vos de host. Devuelve la sala o null si falló. */
  createRoom(): Promise<OnlineRoom | null>;
  /** Estado actual de la sala (roomState.current). */
  getRoom(): OnlineRoom | null;
  /** Suma un bot a la sala (lo une y devuelve su handle). */
  spawnBot(index: number): Promise<HardTestBotHandle>;
  setAutoplay(on: boolean): void;
  /** Pollea la sala (pollOnlineRoom): dispara las transiciones server-side. */
  poll(): Promise<void>;
  /** Arranca la ronda (startOnlineRoom). */
  startRound(): Promise<void>;
  /** Prende/apaga el mock de Luna en el server (endpoint dev). */
  setLunaMock(on: boolean): Promise<void>;
  createBet(stakeSats: number): Promise<void>;
  /** Refresca la apuesta (sincroniza depósitos y, si la sala terminó, liquida). */
  refreshBet(): Promise<void>;
  /** Corta TODAS las escrituras del host al servidor (simula su caída). */
  suppressHostWrites(on: boolean): void;
  /** Deja de relayar el progreso de un jugador (simula su abandono silencioso). */
  suppressPlayer(playerId: string, on: boolean): void;
  cleanup(): Promise<void>;
  sendReport(result: HardTestResult): Promise<{ ok: boolean; detail: string }>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Ventanas (ms desde que la ronda entra a 'playing'), escalonadas. El doble-KO va
// primero (necesita que el host todavía rutee los KO). La caída del host va TEMPRANO
// y a tiempo fijo: al cortar las escrituras del host, el servidor queda CONGELADO en
// los vivos que tenía (los KO de los bots ya no se commitean), así el host no puede
// ganar la ronda por más que su tablero local termine. Debe pasar antes de que el host
// gane sola; con los bots a cadencia 8 la ronda no resuelve antes de ~10s.
const DOUBLE_KO_AT_MS = 2_000;
const ABANDON_AT_MS = 3_000;
const HOST_DISCONNECT_AT_MS = 5_000;
// Tras el failover (la autoridad ya migró del host a un bot) resolvemos rápido: en vez
// de esperar la cascada de 15s por bot, dejamos UN bot vivo y el resto deja la sala.
const HARD_TIMEOUT_MS = 90_000;
const OBSERVE_INTERVAL_MS = 300;

interface ScheduledChaos {
  atMs: number;
  label: string;
  fired: boolean;
  run(): void;
}

/**
 * Una corrida de hard test. main.ts instancia, llama run() y lee los campos públicos
 * (phase/result/reportStatus) para repintar el panel dev en vivo.
 */
export class HardTestRun {
  phase = 'idle';
  result: HardTestResult | null = null;
  reportStatus: string | null = null;

  private readonly bots: HardTestBotHandle[] = [];
  private readonly timeline: TimelineEntry[] = [];
  private readonly errors: string[] = [];
  private originalHostId: string | null = null;
  private suppressedPlayerId: string | null = null;
  private doubleKoPlayerIds: string[] = [];
  private startedAtMs = 0;
  private cancelled = false;
  private onError = (event: ErrorEvent): void => { this.errors.push(`error: ${event.message}`); };
  private onRejection = (event: PromiseRejectionEvent): void => {
    this.errors.push(`rejection: ${String(event.reason).slice(0, 200)}`);
  };

  constructor(
    private readonly host: HardTestHost,
    private readonly config: HardTestConfig,
    private readonly onUpdate: () => void,
  ) {}

  cancel(): void {
    this.cancelled = true;
  }

  private setPhase(phase: string): void {
    this.phase = phase;
    this.onUpdate();
  }

  async run(): Promise<HardTestResult> {
    this.startedAtMs = Date.now();
    if (typeof window !== 'undefined') {
      window.addEventListener('error', this.onError);
      window.addEventListener('unhandledrejection', this.onRejection);
    }
    try {
      return await this.execute();
    } finally {
      if (typeof window !== 'undefined') {
        window.removeEventListener('error', this.onError);
        window.removeEventListener('unhandledrejection', this.onRejection);
      }
      await this.host.cleanup().catch(() => {});
    }
  }

  private async execute(): Promise<HardTestResult> {
    this.setPhase('Creando sala…');
    const room = await this.host.createRoom();
    if (!room) throw new Error('No se pudo crear la sala.');

    this.setPhase(`Sumando ${this.config.playerCount - 1} bots…`);
    for (let index = 0; index < this.config.playerCount - 1; index += 1) {
      this.bots.push(await this.host.spawnBot(index));
    }
    this.host.setAutoplay(true);

    if (this.config.withMockedBet) {
      this.setPhase('Creando apuesta (mock)…');
      await this.host.setLunaMock(true);
      await this.host.poll();
      try {
        await this.host.createBet(this.config.stakeSats);
        await this.host.refreshBet();
      } catch (error) {
        this.errors.push(`apuesta: ${String(error).slice(0, 160)}`);
      }
    }

    this.setPhase('Arrancando ronda…');
    await this.host.poll();
    await this.host.startRound();

    await this.observeRound();

    // Si la sala terminó con apuesta, un refresh final liquida (paga al ganador o reembolsa).
    if (this.config.withMockedBet && this.host.getRoom()?.status === 'finished') {
      await this.host.refreshBet().catch((error) => this.errors.push(`liquidación: ${String(error).slice(0, 160)}`));
    }
    await this.host.poll().catch(() => {});

    const finalRoom = this.host.getRoom();
    const evidence: HardTestEvidence = {
      config: this.config,
      originalHostId: this.originalHostId,
      suppressedPlayerId: this.suppressedPlayerId,
      doubleKoPlayerIds: this.doubleKoPlayerIds,
      finalRoom,
      reachedFinished: finalRoom?.status === 'finished',
      timeline: this.timeline,
      errors: this.errors,
      startedAtMs: this.startedAtMs,
      endedAtMs: Date.now(),
    };
    this.result = evaluateHardTest(evidence);
    this.setPhase(this.result.pass ? 'PASÓ ✅' : 'FALLÓ ❌');

    this.setPhase('Enviando reporte a Discord…');
    const report = await this.host.sendReport(this.result).catch((error) => ({ ok: false, detail: String(error).slice(0, 160) }));
    this.reportStatus = report.ok ? 'reporte enviado a Discord' : `reporte no enviado: ${report.detail}`;
    this.setPhase(this.result.pass ? 'PASÓ ✅' : 'FALLÓ ❌');
    return this.result;
  }

  // Pollea la sala hasta que termine (o timeout), grabando la timeline y disparando
  // el caso de caos que corresponda según el reloj de la ronda.
  private async observeRound(): Promise<void> {
    let roundStartMs: number | null = null;
    let schedule: ScheduledChaos[] = [];
    this.setPhase('Observando la ronda…');
    while (!this.cancelled) {
      await this.host.poll().catch((error) => this.errors.push(`poll: ${String(error).slice(0, 120)}`));
      const room = this.host.getRoom();
      this.record(room);

      if (room && (room.status === 'playing' || room.status === 'finished')) {
        if (roundStartMs === null) {
          roundStartMs = this.host.nowMs();
          this.originalHostId = room.hostPlayerId;
          schedule = this.buildSchedule();
        }
        const elapsed = this.host.nowMs() - roundStartMs;
        for (const chaos of schedule) {
          if (!chaos.fired && elapsed >= chaos.atMs) {
            chaos.fired = true;
            try { chaos.run(); } catch (error) { this.errors.push(`caos ${chaos.label}: ${String(error).slice(0, 120)}`); }
          }
        }
      }

      if (room?.status === 'finished') return;
      if (Date.now() - this.startedAtMs > HARD_TIMEOUT_MS) {
        this.errors.push('timeout: la sala no llegó a finished a tiempo (posible cuelgue).');
        return;
      }
      await sleep(OBSERVE_INTERVAL_MS);
    }
  }

  private buildSchedule(): ScheduledChaos[] {
    const schedule: ScheduledChaos[] = [];
    if (this.config.scenarios.playerAbandon) {
      schedule.push({
        atMs: ABANDON_AT_MS,
        label: 'abandono',
        fired: false,
        run: () => {
          const victim = this.pickLastLivingBot();
          if (!victim) { this.errors.push('abandono: no había bot vivo para abandonar.'); return; }
          this.suppressedPlayerId = victim.playerId;
          this.host.suppressPlayer(victim.playerId, true);
        },
      });
    }
    if (this.config.scenarios.doubleKo) {
      schedule.push({
        atMs: DOUBLE_KO_AT_MS,
        label: 'doble-KO',
        fired: false,
        run: () => {
          const victims = this.pickLivingBots(2, this.suppressedPlayerId);
          if (victims.length < 2) { this.errors.push('doble-KO: no había 2 bots vivos.'); return; }
          this.doubleKoPlayerIds = victims.map((b) => b.playerId);
          for (const bot of victims) bot.forceTopOut();
        },
      });
    }
    if (this.config.scenarios.hostDisconnect) {
      schedule.push({
        atMs: HOST_DISCONNECT_AT_MS,
        label: 'caída del host',
        fired: false,
        run: () => { this.host.suppressHostWrites(true); },
      });
    }
    return schedule;
  }

  // El sucesor que elige applyHostFailover es el PRIMER jugador vivo no-host en orden
  // de la sala. Para que el abandonado no termine siendo coronado como ese sucesor
  // (lo que invalidaría el check de abandono), lo elegimos del FINAL de la lista de
  // vivos: así queda lejos del sucesor y el servidor lo barre por inactividad (20s).
  private pickLastLivingBot(): HardTestBotHandle | null {
    const living = this.pickLivingBots(this.bots.length);
    return living.at(-1) ?? null;
  }

  private pickLivingBots(count: number, exclude: string | null = null): HardTestBotHandle[] {
    const room = this.host.getRoom();
    if (!room) return [];
    const aliveIds = new Set(room.players.filter((p) => p.alive && p.id !== room.hostPlayerId).map((p) => p.id));
    return this.bots
      .filter((bot) => aliveIds.has(bot.playerId) && bot.playerId !== exclude)
      .slice(0, count);
  }

  private record(room: OnlineRoom | null): void {
    if (!room) return;
    const last = this.timeline.at(-1);
    const alivePlayerIds = room.players.filter((p) => p.alive).map((p) => p.id);
    // Evita duplicar entradas idénticas consecutivas (la sala se pollea cada 500ms).
    if (last
      && last.status === room.status
      && last.hostPlayerId === room.hostPlayerId
      && last.winnerPlayerId === room.winnerPlayerId
      && last.betStatus === (room.bet?.status ?? null)
      && last.alivePlayerIds.length === alivePlayerIds.length) {
      return;
    }
    this.timeline.push({
      tMs: Date.now() - this.startedAtMs,
      status: room.status,
      hostPlayerId: room.hostPlayerId,
      alivePlayerIds,
      winnerPlayerId: room.winnerPlayerId,
      betStatus: room.bet?.status ?? null,
    });
    this.onUpdate();
  }
}
