import { bech32 } from '@scure/base';
import type { UnsignedZapRequestTemplate } from './protocol';

export const NGP_READ_RELAYS = [
  'wss://relay.lacrypta.ar',
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

// MODO EVENTOS (sin REST autenticada de Luna). Helpers puros de LECTURA/construcción
// sobre Nostr para el flujo NGP de apuestas de Tetris:
//  - config desde el evento `terms` (31340 d=terms) en vez de GET /ngp-config,
//  - estado desde el `31340` (d=contrato) en vez de GET /bets/{id},
//  - el 9734 de depósito armado localmente (LNURL-pay a la tienda) en vez de que
//    Luna lo mande en el detalle.
// El flujo (crear/depositar/reportar) vive en lunaNegraBets.ts, que usa estos helpers.

/** Bech32 del URL LNURL (idéntico a `encodeLnurl` de Luna: el 9734 debe llevar este
 *  `lnurl` tag para pasar `validateDepositZapRequest`). Límite alto: las URLs superan
 *  los 90 chars del default de bech32. */
export function encodeLnurl(url: string): string {
  const words = bech32.toWords(new TextEncoder().encode(url));
  return bech32.encode('lnurl', words, 2000);
}

/** LNURL-pay estable de la tienda (riel de pago, no la API autenticada). */
export function storeLnurlUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/.well-known/lnurlp/luna`;
}



export interface NgpBetState {
  /** Id interno de la apuesta en Luna (del content del 31340), si ya materializó. */
  lunaBetId: string | null;
  /** Estado público NGP: accepted | funded | resolved | void | expired. */
  status: string;
  stakeSats: number | null;
  /** Pubkeys (hex) que ya depositaron. */
  depositedPubkeys: string[];
  /** Payout por pubkey. */
  payouts: Record<string, { sats: number; status: string; kind?: string }>;
  depositDeadlineSec: number | null;
}

/** Parsea el content de un evento de estado 31340. Puro. */
export function parseBetStateEvent(ev: { content: string }): NgpBetState | null {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(ev.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof d.status !== 'string') return null;
  const deposits = Array.isArray(d.deposits) ? (d.deposits as Array<{ p?: string }>) : [];
  const payoutsArr = Array.isArray(d.payouts) ? (d.payouts as Array<Record<string, unknown>>) : [];
  const payouts: NgpBetState['payouts'] = {};
  for (const p of payoutsArr) {
    if (typeof p.p === 'string') {
      payouts[p.p] = {
        sats: Number(p.sats) || 0,
        status: typeof p.status === 'string' ? p.status : 'none',
        ...(typeof p.kind === 'string' ? { kind: p.kind } : {}),
      };
    }
  }
  return {
    lunaBetId: typeof d.betId === 'string' ? d.betId : null,
    status: d.status,
    stakeSats: Number.isFinite(Number(d.stakeSats)) ? Number(d.stakeSats) : null,
    depositedPubkeys: deposits.map((x) => x.p).filter((x): x is string => typeof x === 'string'),
    payouts,
    depositDeadlineSec: Number.isFinite(Number(d.depositDeadline)) ? Number(d.depositDeadline) : null,
  };
}



// Vocabulario de estado de Tetris (RoomBetStatus).
type RoomStatus = 'pending_deposits' | 'funded' | 'settled' | 'cancelled' | 'expired' | 'refunded';

/** Traduce el estado público NGP (31340) al vocabulario de RoomBetStatus de Tetris. */
export function mapNgpStatusToRoomStatus(ngpStatus: string): RoomStatus {
  switch (ngpStatus) {
    case 'accepted':
      return 'pending_deposits';
    case 'funded':
      return 'funded';
    case 'resolved':
      return 'settled';
    case 'void':
      return 'refunded';
    case 'expired':
      return 'expired';
    default:
      return 'pending_deposits';
  }
}

/**
 * Arma el 9734 (zap request) SIN firmar del depósito, para que el browser del jugador
 * lo firme. Debe cuadrar con `validateDepositZapRequest` de Luna: kind 9734, `p`=tienda,
 * `e`=contrato, `amount`=stake·1000, `lnurl`=LNURL de la tienda, `relays`. El jugador
 * lo firma y se paga al LNURL-pay de la tienda (que emite el invoice y materializa).
 */
export function buildDepositZapRequestTemplate(params: {
  contractId: string;
  storePubkey: string;
  stakeSats: number;
  storeLnurlBech32: string;
}): UnsignedZapRequestTemplate {
  return {
    kind: 9734,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['relays', ...NGP_READ_RELAYS],
      ['amount', String(params.stakeSats * 1000)],
      ['lnurl', params.storeLnurlBech32],
      ['p', params.storePubkey],
      ['e', params.contractId],
    ],
  };
}
