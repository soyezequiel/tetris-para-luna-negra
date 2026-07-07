import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseTermsEvent,
  parseBetStateEvent,
  mapNgpStatusToRoomStatus,
  buildDepositZapRequestTemplate,
  encodeLnurl,
  storeLnurlUrl,
  pokeNgpBetDepositSync,
  resetNgpBetDepositSyncPokeForTests,
} from '../src/online/lunaNegraEvents';

const STORE = 'a'.repeat(64);

afterEach(() => {
  resetNgpBetDepositSyncPokeForTests();
  vi.unstubAllGlobals();
});

describe('parseTermsEvent', () => {
  it('lee storePubkey (autor) + límites del content', () => {
    const terms = parseTermsEvent({
      pubkey: STORE,
      content: JSON.stringify({ minStakeSats: 10, maxStakeSats: 100000, feePct: 5 }),
    });
    expect(terms).toEqual({ storePubkey: STORE, minStakeSats: 10, maxStakeSats: 100000, feePct: 5 });
  });
  it('content inválido → null', () => {
    expect(parseTermsEvent({ pubkey: STORE, content: 'no-json' })).toBeNull();
  });
  it('sin límites numéricos → null', () => {
    expect(parseTermsEvent({ pubkey: STORE, content: JSON.stringify({}) })).toBeNull();
  });
  it('feePct ausente -> 0', () => {
    const terms = parseTermsEvent({
      pubkey: STORE,
      content: JSON.stringify({ minStakeSats: 10, maxStakeSats: 100000 }),
    });
    expect(terms?.feePct).toBe(0);
  });
});

describe('parseBetStateEvent', () => {
  it('extrae status, betId, depósitos y payouts', () => {
    const st = parseBetStateEvent({
      content: JSON.stringify({
        betId: 'luna_bet_1',
        status: 'funded',
        stakeSats: 10,
        deposits: [{ p: 'p1' }, { p: 'p2' }],
        payouts: [{ p: 'p1', sats: 19, status: 'paid', kind: 'zap' }],
        depositDeadline: 1800000000,
      }),
    });
    expect(st?.status).toBe('funded');
    expect(st?.lunaBetId).toBe('luna_bet_1');
    expect(st?.depositedPubkeys).toEqual(['p1', 'p2']);
    expect(st?.payouts.p1).toEqual({ sats: 19, status: 'paid', kind: 'zap' });
  });
  it('sin status → null', () => {
    expect(parseBetStateEvent({ content: JSON.stringify({ betId: 'x' }) })).toBeNull();
  });
});

describe('mapNgpStatusToRoomStatus', () => {
  it('mapea el vocabulario NGP al de Tetris', () => {
    expect(mapNgpStatusToRoomStatus('accepted')).toBe('pending_deposits');
    expect(mapNgpStatusToRoomStatus('funded')).toBe('funded');
    expect(mapNgpStatusToRoomStatus('resolved')).toBe('settled');
    expect(mapNgpStatusToRoomStatus('void')).toBe('refunded');
    expect(mapNgpStatusToRoomStatus('expired')).toBe('expired');
    expect(mapNgpStatusToRoomStatus('???')).toBe('pending_deposits');
  });
});

describe('buildDepositZapRequestTemplate (money-critical: debe cuadrar con validateDepositZapRequest)', () => {
  it('9734 con kind/p=store/e=contrato/amount=stake*1000/lnurl/relays', () => {
    const lnurl = encodeLnurl(storeLnurlUrl('https://luna.example'));
    const t = buildDepositZapRequestTemplate({
      contractId: 'contract1',
      storePubkey: STORE,
      stakeSats: 10,
      storeLnurlBech32: lnurl,
    });
    expect(t.kind).toBe(9734);
    const tag = (n: string) => t.tags.find((x) => x[0] === n);
    expect(tag('p')?.[1]).toBe(STORE);
    expect(tag('e')?.[1]).toBe('contract1');
    expect(tag('amount')?.[1]).toBe('10000'); // 10 sats * 1000 = msat
    expect(tag('lnurl')?.[1]).toBe(lnurl);
    expect(tag('relays')).toBeTruthy();
    expect(tag('relays')!.length).toBeGreaterThan(1);
  });
});

describe('encodeLnurl', () => {
  it('produce un lnurl1… bech32 estable', () => {
    const enc = encodeLnurl('https://luna.example/.well-known/lnurlp/luna');
    expect(enc.startsWith('lnurl1')).toBe(true);
    // determinístico
    expect(encodeLnurl('https://luna.example/.well-known/lnurlp/luna')).toBe(enc);
  });
});

describe('pokeNgpBetDepositSync', () => {
  it('llama el sync publico de Luna una sola vez por ventana de throttle', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const contractId = 'b'.repeat(64);

    await expect(pokeNgpBetDepositSync('https://luna.example/', contractId)).resolves.toBe(true);
    await expect(pokeNgpBetDepositSync('https://luna.example/', contractId)).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://luna.example/api/v2/bets/ngp-sync?contractId=${contractId}`,
    );
  });

  it('ignora ids que no son contratos NGP', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(pokeNgpBetDepositSync('https://luna.example', 'not-a-contract')).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
