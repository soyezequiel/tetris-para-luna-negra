// ───────────────── HARD TEST MULTIJUGADOR: tipos + checker de invariantes ─────────────────
// Módulo PURO (sin DOM, sin red) compartido por el harness interactivo
// (src/dev/hardTestHarness.ts) y el test determinista (tests/hardTestScenarios.test.ts).
// Dada la evidencia de una corrida de 8 jugadores con caminos no felices, evalúa si
// la sala se comportó bien y arma el reporte que va a Discord.

import type { OnlinePlayer, OnlineRoom, OnlineRoomStatus, RoomBetStatus } from '../online/protocol';

export interface HardTestScenarios {
  /** El host deja de heartbeatear a mitad de ronda (failover server-side). */
  hostDisconnect: boolean;
  /** Un jugador no-host abandona en silencio a mitad de ronda. */
  playerAbandon: boolean;
  /** Dos jugadores mueren casi a la vez; el KO del "ganador" llega tarde. */
  doubleKo: boolean;
}

export interface HardTestConfig {
  playerCount: number;
  scenarios: HardTestScenarios;
  withMockedBet: boolean;
  stakeSats: number;
}

export interface TimelineEntry {
  tMs: number;
  status: OnlineRoomStatus;
  hostPlayerId: string;
  alivePlayerIds: string[];
  winnerPlayerId: string | null;
  betStatus: RoomBetStatus | null;
  note?: string;
}

export interface HardTestCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface HardTestEvidence {
  config: HardTestConfig;
  /** Host al iniciar la ronda (para verificar la migración tras la caída). */
  originalHostId: string | null;
  /** Jugador marcado para abandono silencioso, si el escenario estaba activo. */
  suppressedPlayerId: string | null;
  /** Los dos jugadores forzados a morir casi a la vez (doble-KO). */
  doubleKoPlayerIds: string[];
  /** Sala final tal como la dejó el servidor. */
  finalRoom: OnlineRoom | null;
  /** La sala llegó a `finished` antes del timeout. */
  reachedFinished: boolean;
  timeline: TimelineEntry[];
  errors: string[];
  startedAtMs: number;
  endedAtMs: number;
}

export interface HardTestResult {
  startedAt: string;
  durationMs: number;
  config: HardTestConfig;
  pass: boolean;
  checks: HardTestCheck[];
  timeline: TimelineEntry[];
  errors: string[];
  finalRoom: {
    id: string;
    status: OnlineRoomStatus;
    hostPlayerId: string;
    winnerPlayerId: string | null;
    players: Array<{ id: string; name: string; status: string; alive: boolean; eliminatedAtFrame: number | null }>;
    betStatus: RoomBetStatus | null;
  } | null;
}

/** Frames sobrevividos: igual que survivalFrame de roomService. */
function survivalFrame(player: OnlinePlayer): number {
  return player.eliminatedAtFrame ?? player.elapsedFrames;
}

function isTerminal(player: OnlinePlayer): boolean {
  return player.status === 'eliminated' || player.status === 'won' || player.status === 'lost' || player.status === 'winner';
}

/**
 * Evalúa la corrida contra las invariantes. Cada check es independiente: el
 * resultado global pasa solo si TODOS los checks aplicables pasan.
 */
export function evaluateHardTest(ev: HardTestEvidence): HardTestResult {
  const checks: HardTestCheck[] = [];
  const room = ev.finalRoom;
  const players = room?.players ?? [];
  const findPlayer = (id: string | null): OnlinePlayer | undefined =>
    id ? players.find((p) => p.id === id) : undefined;

  // 1. La sala no se cuelga: llega a `finished`.
  checks.push({
    name: 'noHang',
    pass: ev.reachedFinished && room?.status === 'finished',
    detail: room
      ? `status final=${room.status} (reachedFinished=${ev.reachedFinished})`
      : 'no hubo sala final',
  });

  // 2. Coronación única. winner null se acepta SOLO si cayó el host (puede no quedar
  //    nadie con autoridad para coronar) — se marca como nota, no como fallo.
  const winner = findPlayer(room?.winnerPlayerId ?? null);
  if (room?.winnerPlayerId) {
    checks.push({
      name: 'singleWinner',
      pass: !!winner && (winner.status === 'won' || winner.status === 'winner'),
      detail: winner ? `ganador=${winner.name} status=${winner.status}` : 'winnerPlayerId no existe en la sala',
    });
  } else {
    checks.push({
      name: 'singleWinner',
      pass: ev.config.scenarios.hostDisconnect,
      detail: ev.config.scenarios.hostDisconnect
        ? 'sin ganador: la caída del host pudo anular la ronda (aceptable)'
        : 'sin ganador y sin caída de host: la ronda debió coronar a alguien',
    });
  }

  // 3. Host failover: la autoridad migró y el host viejo quedó eliminado.
  if (ev.config.scenarios.hostDisconnect) {
    const migrated = !!room && !!ev.originalHostId && room.hostPlayerId !== ev.originalHostId;
    const oldHost = findPlayer(ev.originalHostId);
    const oldHostDown = !!oldHost && isTerminal(oldHost) && !oldHost.alive;
    checks.push({
      name: 'hostFailover',
      pass: migrated && oldHostDown,
      detail: `host ${ev.originalHostId} → ${room?.hostPlayerId ?? '∅'}; host viejo status=${oldHost?.status ?? '∅'} alive=${oldHost?.alive ?? '∅'}`,
    });
  }

  // 4. Abandono resuelto: el jugador suprimido quedó eliminado y la sala progresó.
  if (ev.config.scenarios.playerAbandon) {
    const abandoned = findPlayer(ev.suppressedPlayerId);
    const resolved = !!abandoned && isTerminal(abandoned) && !abandoned.alive;
    checks.push({
      name: 'abandonResolved',
      pass: resolved,
      detail: abandoned
        ? `abandonado=${abandoned.name} status=${abandoned.status} alive=${abandoned.alive}`
        : 'no se identificó al jugador abandonado',
    });
  }

  // 5. Re-coronación: el ganador aguantó al menos tanto como las VÍCTIMAS del doble-KO
  //    (no se coronó a alguien que murió antes por orden de llegada de paquetes). Se
  //    compara SOLO contra los dos forzados a morir casi a la vez —no contra cualquier
  //    eliminado— porque cuando también cae el host, el sucesor coronado por el failover
  //    legítimamente no es el de más frames, y eso no invalida la re-coronación.
  if (ev.config.scenarios.doubleKo && room?.winnerPlayerId && winner) {
    const koVictims = players.filter((p) => ev.doubleKoPlayerIds.includes(p.id) && p.id !== winner.id);
    const topRivalFrame = koVictims.reduce((max, p) => Math.max(max, survivalFrame(p)), 0);
    // El ganador está vivo, así que no tiene frame de muerte: medimos cuánto duró por
    // los frames que alcanzó. Un ganador coronado por orden de llegada de paquetes
    // (que en realidad murió antes) tendría menos frames que el verdadero último en pie.
    const winnerFrame = winner.alive ? winner.elapsedFrames : survivalFrame(winner);
    checks.push({
      name: 'recrown',
      pass: winnerFrame >= topRivalFrame,
      detail: `ganador duró ${winnerFrame} frames vs. víctimas doble-KO ${topRivalFrame}`,
    });
  }

  // 6. Conservación del pozo (apuesta mock): payout + reembolsos cubren el pozo.
  if (ev.config.scenarios && ev.config.withMockedBet) {
    const bet = room?.bet ?? null;
    if (!bet) {
      checks.push({ name: 'betConserved', pass: false, detail: 'la apuesta mock no llegó a la sala final' });
    } else if (bet.status === 'settled') {
      const paidOut = bet.participants.reduce((sum, p) => sum + (p.payoutSats ?? 0), 0);
      checks.push({
        name: 'betConserved',
        pass: paidOut > 0,
        detail: `settled: pozo=${bet.potSats} sats, pagado al ganador=${paidOut} sats`,
      });
    } else if (bet.status === 'cancelled' || bet.status === 'refunded') {
      const allRefunded = bet.participants.every((p) => p.depositStatus !== 'paid');
      checks.push({
        name: 'betConserved',
        pass: allRefunded,
        detail: `${bet.status}: depósitos reembolsados=${allRefunded}`,
      });
    } else {
      checks.push({
        name: 'betConserved',
        pass: false,
        detail: `la apuesta quedó en estado no terminal: ${bet.status}`,
      });
    }
  }

  // Errores capturados (window.onerror / unhandledrejection) hacen fallar la corrida.
  if (ev.errors.length > 0) {
    checks.push({
      name: 'noErrors',
      pass: false,
      detail: `${ev.errors.length} error(es) durante la corrida: ${ev.errors.slice(0, 3).join(' | ')}`,
    });
  }

  const pass = checks.every((c) => c.pass);
  return {
    startedAt: new Date(ev.startedAtMs).toISOString(),
    durationMs: ev.endedAtMs - ev.startedAtMs,
    config: ev.config,
    pass,
    checks,
    timeline: ev.timeline,
    errors: ev.errors,
    finalRoom: room
      ? {
        id: room.id,
        status: room.status,
        hostPlayerId: room.hostPlayerId,
        winnerPlayerId: room.winnerPlayerId,
        players: room.players.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          alive: p.alive,
          eliminatedAtFrame: p.eliminatedAtFrame,
        })),
        betStatus: room.bet?.status ?? null,
      }
      : null,
  };
}

/** Resumen de una línea por check, para logs y consola. */
export function summarizeHardTest(result: HardTestResult): string {
  const head = `${result.pass ? '✅ PASÓ' : '❌ FALLÓ'} — ${result.checks.filter((c) => c.pass).length}/${result.checks.length} checks · ${Math.round(result.durationMs / 1000)}s`;
  const lines = result.checks.map((c) => `  ${c.pass ? '✅' : '❌'} ${c.name}: ${c.detail}`);
  return [head, ...lines].join('\n');
}
