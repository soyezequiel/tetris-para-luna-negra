// ─────────────────────────── BOT MULTIJUGADOR (DEV) ───────────────────────────
// Oponente simulado para ver el flujo multijugador completo en modo dev sin un
// segundo jugador humano. Actúa como un cliente real: se une a la sala por HTTP
// (el API corre local en `npm run dev`), corre su propio GameEngine con la seed
// de la sala anclado a la línea de tiempo del servidor (startsAtServerMs) y juega
// con el heurístico de autoPlay. Como vive en la misma página que el host, en vez
// de WebRTC entrega sus intents/snapshots/KO por el DevBotBridge, que main.ts
// conecta a los mismos handlers que usaría el peer broadcast. Solo se carga vía
// import() dinámico detrás de import.meta.env.DEV: no existe en producción.

import { nextAutoPlayInput } from '../app/autoPlay';
import { GameEngine } from '../game/engine';
import { createReplayLog, recordGarbage, recordInput, type ReplayLog } from '../game/replay';
import { displayedElapsedFrames } from '../game/timing';
import type { GameInput, GameRules, GameState, InputAction } from '../game/types';
import type { OnlineClient } from '../online/client';
import type { OnlinePeerKoMessage, OnlinePeerReplayMessage } from '../online/peerBroadcast';
import type { OnlineGameSnapshot, OnlineRoom } from '../online/protocol';

const GAME_FRAME_MS = 1000 / 60;
// Tope de catch-up por llamada: si la pestaña se congeló, el bot alcanza el frame
// del servidor de a tandas en vez de bloquear el loop con una ráfaga gigante.
const MAX_CATCHUP_FRAMES = 120;
const SNAPSHOT_INTERVAL_MS = 120;

export interface DevBotAttackIntent {
  attackId: string;
  fromPlayerId: string;
  lines: number;
  holeSeed: number;
  frame: number;
}

// Puente hacia main.ts: el bot no toca estado del host directamente, solo llama
// estos hooks (que main conecta a commitOnlineAttack, applyPeerSnapshot, etc.).
export interface DevBotBridge {
  getRoom(): OnlineRoom | null;
  getNowMs(): number;
  botRules(): GameRules;
  deliverAttackIntent(intent: DevBotAttackIntent): void;
  deliverSnapshot(playerId: string, game: OnlineGameSnapshot): void;
  commitKo(report: Omit<OnlinePeerKoMessage, 'type'>): void;
  // Mismo camino que broadcastReplay del peer real: entrega el log determinista del
  // bot al recolectar la repetición, una vez al terminar su ronda.
  deliverReplay(report: Omit<OnlinePeerReplayMessage, 'type'>): void;
}

export interface DevBotConfig {
  /** Una acción del heurístico cada N frames (6 ≈ 10 acciones/seg). */
  inputCadenceFrames: number;
  /** Probabilidad por pieza de desviar el drop 1-2 columnas (genera huecos y muerte orgánica). */
  mistakeRate: number;
}

export const DEFAULT_DEV_BOT_CONFIG: DevBotConfig = {
  inputCadenceFrames: 6,
  mistakeRate: 0.15,
};

export class DevBotOpponent {
  readonly playerId = `dev-bot-${Math.random().toString(36).slice(2, 8)}`;
  readonly name = 'BOT (dev)';

  private config: DevBotConfig;
  private engine: GameEngine | null = null;
  // Log determinista de la ronda (seed/rules/inputs/garbage), igual que el `replay`
  // local de main, para que el bot aparezca en la repetición multi-tablero.
  private replay: ReplayLog | null = null;
  private replayDelivered = false;
  private roundSeed: number | null = null;
  private botFrame = 0;
  private attackSequence = 0;
  private appliedAttackIds = new Set<string>();
  private koReported = false;
  private lastSnapshotAt = 0;
  private lastPieces = -1;
  // Cola de acciones forzadas (torpeza): laterales aleatorios + el hardDrop que
  // el heurístico ya había decidido, para que la pieza caiga desviada de verdad.
  private forcedActions: InputAction[] = [];
  private topOutRequested = false;
  private disposed = false;

  constructor(
    private readonly bridge: DevBotBridge,
    private readonly client: Pick<OnlineClient, 'joinRoom' | 'leaveRoom'>,
    config: Partial<DevBotConfig> = {},
  ) {
    this.config = { ...DEFAULT_DEV_BOT_CONFIG, ...config };
  }

  async join(roomId: string): Promise<void> {
    await this.client.joinRoom({ roomId, playerId: this.playerId, name: this.name });
  }

  setConfig(partial: Partial<DevBotConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  getConfig(): DevBotConfig {
    return { ...this.config };
  }

  getState(): GameState | null {
    return this.engine?.getState() ?? null;
  }

  // Llamado una vez por vuelta del loop() de main. Máquina de estados sobre la
  // sala compartida: idle en lobby, simula en countdown/playing, y al detectar
  // seed nueva (reopen) descarta la ronda anterior.
  frame(): void {
    if (this.disposed) return;
    const room = this.bridge.getRoom();
    if (!room || !room.players.some((player) => player.id === this.playerId)) return;
    if (this.roundSeed !== room.seed) this.resetRound(room.seed);
    if (room.status !== 'countdown' && room.status !== 'playing') return;
    if (!room.startsAtServerMs) return;
    const nowMs = this.bridge.getNowMs();
    if (nowMs < room.startsAtServerMs) return;
    if (!this.engine) {
      const rules = this.bridge.botRules();
      this.engine = new GameEngine(room.seed, rules);
      this.replay = createReplayLog(room.seed, rules);
      this.botFrame = 0;
    }
    this.applyIncomingAttacks(room);
    this.maybeForceTopOut();
    this.advanceToServerFrame(room, nowMs);
    this.processEvents(room);
    this.maybeDeliverSnapshot(room, nowMs);
    this.maybeDeliverReplay(room);
  }

  // Ataque sintético desde el panel dev: entra al host por el mismo camino que
  // un line clear real del bot (el host lo rutea y commitea contra el servidor).
  forceAttack(lines: number): void {
    const room = this.bridge.getRoom();
    if (!room || this.roundSeed !== room.seed) return;
    this.attackSequence += 1;
    this.bridge.deliverAttackIntent({
      attackId: `${this.playerId}-forced-${this.botFrame}-${this.attackSequence}`,
      fromPlayerId: this.playerId,
      lines: Math.max(1, Math.floor(lines)),
      holeSeed: (room.seed + this.botFrame + this.attackSequence * 97) >>> 0,
      frame: this.botFrame,
    });
  }

  // Muerte a pedido: encola garbage masivo cada frame hasta morir. Se respeta el
  // cap de pending del motor, por eso se reintenta en frame() y no de un golpe.
  forceTopOut(): void {
    this.topOutRequested = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const room = this.bridge.getRoom();
    if (room) void this.client.leaveRoom({ roomId: room.id, playerId: this.playerId }).catch(() => {});
  }

  private resetRound(seed: number): void {
    this.roundSeed = seed;
    this.engine = null;
    this.replay = null;
    this.replayDelivered = false;
    this.botFrame = 0;
    this.attackSequence = 0;
    this.appliedAttackIds = new Set();
    this.koReported = false;
    this.lastSnapshotAt = 0;
    this.lastPieces = -1;
    this.forcedActions = [];
    this.topOutRequested = false;
  }

  // Mismo contrato que applyOnlineAttack de main: solo ataques del host autoridad,
  // de esta seed, dirigidos a mí y no aplicados antes. Anclados a attack.frame para
  // que el delay de aplicación coincida con lo que ve el atacante.
  private applyIncomingAttacks(room: OnlineRoom): void {
    if (!this.engine) return;
    for (const attack of room.attacks ?? []) {
      if (attack.authorityPlayerId !== room.hostPlayerId) continue;
      if (attack.seed !== room.seed) continue;
      if (attack.toPlayerId !== this.playerId || this.appliedAttackIds.has(attack.id)) continue;
      this.appliedAttackIds.add(attack.id);
      this.engine.queueGarbage(attack.lines, attack.holeSeed, attack.frame, attack.id);
      if (this.replay) {
        recordGarbage(this.replay, {
          queuedAtFrame: this.botFrame,
          frame: attack.frame,
          lines: attack.lines,
          holeSeed: attack.holeSeed,
          id: attack.id,
        });
      }
    }
  }

  private maybeForceTopOut(): void {
    if (!this.topOutRequested || !this.engine) return;
    const state = this.engine.getState();
    if (state.status !== 'playing') return;
    this.attackSequence += 1;
    const holeSeed = (this.botFrame + this.attackSequence * 31) >>> 0;
    const id = `${this.playerId}-topout-${this.attackSequence}`;
    this.engine.queueGarbage(state.board.length, holeSeed, this.botFrame, id);
    if (this.replay) {
      recordGarbage(this.replay, {
        queuedAtFrame: this.botFrame,
        frame: this.botFrame,
        lines: state.board.length,
        holeSeed,
        id,
      });
    }
  }

  private advanceToServerFrame(room: OnlineRoom, nowMs: number): void {
    if (!this.engine) return;
    let state = this.engine.getState();
    if (state.status !== 'playing') return;
    const startsAtServerMs = room.startsAtServerMs ?? nowMs;
    const targetFrame = Math.floor((nowMs - startsAtServerMs) / GAME_FRAME_MS);
    const upTo = Math.min(targetFrame, this.botFrame + MAX_CATCHUP_FRAMES);
    for (let frame = this.botFrame + 1; frame <= upTo && state.status === 'playing'; frame += 1) {
      const inputs: GameInput[] = [];
      if (frame % this.config.inputCadenceFrames === 0) {
        const action = this.nextAction(state);
        if (action) inputs.push({ frame, action });
      }
      // Inputs del bot generados con azar (mistakeRate): NO son reproducibles sin
      // grabarlos, así que los registramos como el replay local de main.
      if (this.replay) for (const input of inputs) recordInput(this.replay, input);
      state = this.engine.tick(frame, inputs);
      this.botFrame = frame;
    }
  }

  // Acción del heurístico, con torpeza: cuando decide soltar la pieza, a veces la
  // desvía 1-2 columnas antes del hardDrop. La cola forzada evita que el propio
  // heurístico corrija el desvío en el frame siguiente.
  private nextAction(state: GameState): InputAction | null {
    const forced = this.forcedActions.shift();
    if (forced) return forced;
    if (state.stats.pieces !== this.lastPieces) this.lastPieces = state.stats.pieces;
    const action = nextAutoPlayInput(state);
    if (action === 'hardDrop' && Math.random() < this.config.mistakeRate) {
      const direction: InputAction = Math.random() < 0.5 ? 'moveLeft' : 'moveRight';
      this.forcedActions = Math.random() < 0.5 ? [direction, 'hardDrop'] : [direction, direction, 'hardDrop'];
      return this.forcedActions.shift() ?? action;
    }
    return action;
  }

  private processEvents(room: OnlineRoom): void {
    if (!this.engine) return;
    for (const event of this.engine.drainEvents()) {
      if (event.type === 'lineClear' && event.outgoingLines > 0) {
        this.attackSequence += 1;
        this.bridge.deliverAttackIntent({
          attackId: `${this.playerId}-${event.frame}-${this.attackSequence}`,
          fromPlayerId: this.playerId,
          lines: event.outgoingLines,
          holeSeed: (room.seed + event.frame + this.attackSequence * 97) >>> 0,
          frame: event.frame,
        });
      }
    }
    const state = this.engine.getState();
    if (state.status === 'gameover' && !this.koReported) {
      this.koReported = true;
      this.bridge.commitKo(this.createKoReport(room, state));
      // Última foto del tablero muerto para que el rival vea cómo quedó.
      this.bridge.deliverSnapshot(this.playerId, this.createSnapshot(room, state));
    }
  }

  // Entrega el log del bot una sola vez por ronda, cuando su partida terminó (KO)
  // o la sala cerró (el bot sobrevivió). Espejo de maybeBroadcastOwnReplay de main.
  private maybeDeliverReplay(room: OnlineRoom): void {
    if (this.replayDelivered || !this.replay) return;
    const status = this.engine?.getState().status;
    const terminal = status === 'gameover' || status === 'finished' || room.status === 'finished';
    if (!terminal) return;
    this.replayDelivered = true;
    this.bridge.deliverReplay({
      playerId: this.playerId,
      name: this.name,
      seed: this.replay.seed,
      rules: this.replay.rules,
      inputs: this.replay.inputs,
      garbage: this.replay.garbage,
    });
  }

  private maybeDeliverSnapshot(room: OnlineRoom, nowMs: number): void {
    if (!this.engine) return;
    if (nowMs - this.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
    this.lastSnapshotAt = nowMs;
    const state = this.engine.getState();
    if (state.status !== 'playing') return;
    this.bridge.deliverSnapshot(this.playerId, this.createSnapshot(room, state));
  }

  // Réplica local de createOnlineGameSnapshotFromState de main (con la seed de
  // la sala del bot, no la del host, aunque siempre coinciden).
  private createSnapshot(room: OnlineRoom, state: GameState): OnlineGameSnapshot {
    return {
      seed: room.seed,
      board: state.board.map((row) => [...row]),
      active: state.active ? { ...state.active } : null,
      visibleRows: Math.min(state.stats.visibleRows, state.board.length),
      boardWidth: state.board[0]?.length ?? state.stats.boardWidth,
      elapsedFrames: displayedElapsedFrames(state.stats),
      status: state.status,
      lines: state.stats.lines,
      pieces: state.stats.pieces,
      sentGarbage: state.stats.sentGarbage,
      receivedGarbage: state.stats.receivedGarbage,
      pendingGarbage: state.stats.pendingGarbage,
      engine: this.engine?.createSnapshot(),
    };
  }

  private createKoReport(room: OnlineRoom, state: GameState): Omit<OnlinePeerKoMessage, 'type'> {
    const elapsedFrames = displayedElapsedFrames(state.stats);
    return {
      playerId: this.playerId,
      seed: room.seed,
      frame: elapsedFrames,
      lines: state.stats.lines,
      pieces: state.stats.pieces,
      elapsedFrames,
      sentGarbage: state.stats.sentGarbage,
      receivedGarbage: state.stats.receivedGarbage,
      pendingGarbage: state.stats.pendingGarbage,
      game: this.createSnapshot(room, state),
    };
  }
}
