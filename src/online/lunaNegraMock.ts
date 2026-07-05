// ─────────────────────── MOCK DEV DEL BACKEND DE APUESTAS ───────────────────────
// Servidor de apuestas de Luna Negra simulado EN MEMORIA. Intercepta `lunaFetch`
// (ver lunaNegraBets.ts) para correr todo el money-path —crear, fondear, cancelar
// (reembolso) y liquidar (payout)— sin invoices Lightning reales ni red. La lógica
// de tetris (createBetForRoom, syncBetParticipantsWithRoom, settleRoomBet) queda
// REAL: lo único que se fake-ea es el proveedor del otro lado del HTTP.
//
// Solo se activa con `setLunaMockEnabled(true)`, que prende el hard test dev a
// través del endpoint /api/hard-test/luna-mock. En producción la flag queda en
// false y `lunaFetch` va contra la Luna Negra real.

let enabled = false;

/** Prende/apaga el mock para todo el proceso (server-side, dev). */
export function setLunaMockEnabled(value: boolean): void {
  enabled = value;
}

export function isLunaMockEnabled(): boolean {
  return enabled;
}

interface MockParticipant {
  participantId: string;
  npub: string;
  guest: boolean;
  depositStatus: 'pending' | 'paid' | 'refunded' | 'failed';
  payoutStatus: 'none' | 'paid' | 'claimed' | 'withdraw_pending';
  payoutKind: 'zap' | 'lnurl' | 'withdraw' | null;
  payoutSats: number | null;
  // v2 (zaps): el handle de depósito es un LNURL-pay por asiento (no un bolt11).
  lnurl: string | null;
}

interface MockBet {
  betId: string;
  stakeSats: number;
  status: 'pending_deposits' | 'funded' | 'settled' | 'cancelled';
  participants: MockParticipant[];
  winnerNpubs: string[] | null;
  anchorEventId: string;
}

const bets = new Map<string, MockBet>();
let sequence = 0;

/** Limpia el estado del mock (lo usa el harness al arrancar y los tests). */
export function resetLunaMock(): void {
  bets.clear();
  sequence = 0;
}

function paidCount(bet: MockBet): number {
  return bet.participants.filter((p) => p.depositStatus === 'paid').length;
}

function potSats(bet: MockBet): number {
  if (bet.status === 'cancelled') return 0;
  return bet.stakeSats * paidCount(bet);
}

/** Detalle (GET /api/v2/bets/{id}) con la forma exacta que espera buildRoomBet. */
function betDetail(bet: MockBet): unknown {
  const pot = potSats(bet);
  return {
    betId: bet.betId,
    apiVersion: 2,
    status: bet.status,
    stakeSats: bet.stakeSats,
    potSats: pot,
    potTargetSats: bet.stakeSats * bet.participants.length,
    feePct: 0,
    feeSats: 0,
    netPayoutSats: pot,
    depositDeadline: null,
    depositsReceived: paidCount(bet),
    depositsTotal: bet.participants.length,
    anchorEventId: bet.anchorEventId,
    participants: bet.participants.map((p) => ({
      participantId: p.participantId,
      npub: p.npub,
      depositStatus: p.depositStatus,
      payoutStatus: p.payoutStatus,
      payoutKind: p.payoutKind,
      payoutSats: p.payoutSats,
      // v2: sin bolt11; depósito por LNURL-pay. El invitado que gana no trae LNURL de
      // retiro (reclama en la página hosteada), igual que la Luna real.
      lnurl: p.lnurl,
      payUrl: null,
      depositError: null,
    })),
  };
}

interface CreateBody {
  participants?: Array<string | { guest: true }>;
  stakeSats?: number;
}

// Crea la apuesta y la AUTO-FONDEA: todos los depósitos arrancan `paid` y el estado
// `funded`. Así el hard test no tiene que esperar pagos Lightning reales: la sala ve
// la apuesta lista para arrancar de una. Devuelve betId + mapeo asiento→npub (los
// invitados reciben un npub efímero, igual que la Luna real en pozos mixtos).
function createBet(body: CreateBody): unknown {
  sequence += 1;
  const betId = `mockbet-${sequence}`;
  const stakeSats = Math.max(1, Math.floor(Number(body.stakeSats) || 1));
  const spec = Array.isArray(body.participants) ? body.participants : [];
  const participants: MockParticipant[] = spec.map((entry, seat) => {
    const guest = typeof entry !== 'string';
    const npub = guest ? `npubguest${sequence}seat${seat}` : entry;
    return {
      participantId: `${betId}-p${seat}`,
      npub,
      guest,
      depositStatus: 'paid',
      payoutStatus: 'none',
      payoutKind: null,
      payoutSats: null,
      // v2: LNURL-pay de depósito para todos los asientos (no hay bolt11).
      lnurl: `lnurlmock${betId}s${seat}`,
    };
  });
  const anchorEventId = `mockanchor-${sequence}`;
  const bet: MockBet = { betId, stakeSats, status: 'funded', participants, winnerNpubs: null, anchorEventId };
  bets.set(betId, bet);
  const pot = potSats(bet);
  return {
    betId,
    apiVersion: 2,
    anchorEventId,
    stakeSats,
    potTargetSats: stakeSats * participants.length,
    feePct: 0,
    feeSats: 0,
    netPayoutSats: pot,
    depositDeadline: null,
    participants: participants.map((p, seat) => ({ seat: seat + 1, npub: p.npub, participantId: p.participantId })),
  };
}

// Cancela = reembolso a todos: depósitos a `refunded`, estado `cancelled`.
function cancelBet(bet: MockBet): unknown {
  bet.status = 'cancelled';
  for (const p of bet.participants) {
    if (p.depositStatus === 'paid') p.depositStatus = 'refunded';
  }
  return { ok: true, status: 'cancelled' };
}

// Reporta ganadores = liquida el pozo. v2 (zaps): el ganador con dirección Lightning
// cobra automático por zap (`paid`); el invitado sin destino cae en
// `withdraw_pending` con `payoutKind:"withdraw"` (reclama en la página hosteada, sin
// LNURL por API key). Sin ganadores (empate/anulación) reembolsa a todos.
function reportResult(bet: MockBet, winners: string[]): unknown {
  if (winners.length === 0) {
    cancelBet(bet);
    return { ok: true, status: 'cancelled' };
  }
  const pot = potSats(bet);
  const share = Math.floor(pot / winners.length);
  bet.winnerNpubs = winners;
  bet.status = 'settled';
  for (const p of bet.participants) {
    if (!winners.includes(p.npub)) continue;
    p.payoutSats = share;
    if (p.guest) {
      p.payoutStatus = 'withdraw_pending';
      p.payoutKind = 'withdraw';
    } else {
      p.payoutStatus = 'paid';
      p.payoutKind = 'zap';
    }
  }
  return { ok: true, status: 'settled' };
}

class MockLunaError extends Error {
  constructor(message: string, readonly httpStatus: number) {
    super(message);
  }
}

/**
 * Despachador de `lunaFetch` en modo mock. Cubre solo los endpoints que toca el
 * money-path de la sala; cualquier otro path (p. ej. webhook) devuelve un vacío
 * inofensivo. Lanza con la misma forma que la Luna real para errores conocidos.
 */
export function lunaMockFetch<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' },
): Promise<T> {
  const result = dispatch(path, init);
  return Promise.resolve(result as T);
}

function dispatch(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): unknown {
  // /api/v1/provider/webhook → sin webhook configurado en el mock.
  if (path.startsWith('/api/v1/provider/webhook')) return { url: null, secret: null };

  if (path === '/api/v2/bets' && init.method === 'POST') {
    return createBet((init.body ?? {}) as CreateBody);
  }

  const betPath = path.match(/^\/api\/v2\/bets\/([^/]+)(\/(cancel|result))?$/);
  if (betPath) {
    const betId = decodeURIComponent(betPath[1]);
    const bet = bets.get(betId);
    if (!bet) throw new MockLunaError('Apuesta no encontrada (mock).', 404);
    const sub = betPath[3];
    if (!sub && init.method === 'GET') return betDetail(bet);
    if (sub === 'cancel' && init.method === 'POST') return cancelBet(bet);
    if (sub === 'result' && init.method === 'POST') {
      const winners = Array.isArray((init.body as { winners?: unknown })?.winners)
        ? ((init.body as { winners: unknown[] }).winners.filter((w): w is string => typeof w === 'string'))
        : [];
      return reportResult(bet, winners);
    }
  }

  throw new MockLunaError(`Endpoint no soportado por el mock de Luna: ${init.method} ${path}`, 404);
}
