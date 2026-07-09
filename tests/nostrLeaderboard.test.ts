import { describe, it, expect } from 'vitest';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  verifyEvent,
  type Event,
} from 'nostr-tools';
import { createLocalSigner } from '../src/online/nostrSigner';
import {
  buildScoreEvent,
  rankNostrScores,
  NOSTR_BOARD_SURVIVAL,
  NOSTR_BOARD_WINS,
} from '../src/online/nostrLeaderboard';
import { TETRA_GAME_COORD } from '../src/online/nostrChallenge';

function makeSigner() {
  const sk = generateSecretKey();
  return { signer: createLocalSigner(sk), pubkey: getPublicKey(sk) };
}

const tag = (tags: string[][], k: string) => tags.find((t) => t[0] === k)?.[1] ?? null;

// Firma un evento de puntaje crudo con created_at/score/board/coord controlados (lo
// que buildScoreEvent no deja fijar), para ejercitar el keep-best y el desempate.
function signScore(
  sk: Uint8Array,
  opts: { board: string; score: number; createdAt: number; coord?: string },
): Event {
  const coord = opts.coord ?? TETRA_GAME_COORD;
  return finalizeEvent(
    {
      kind: 31337,
      created_at: opts.createdAt,
      tags: [
        ['a', coord],
        ['d', `${coord}:${opts.board}`],
        ['board', opts.board],
        ['score', String(opts.score)],
      ],
      content: '',
    },
    sk,
  );
}

describe('marcador 2.0 · evento de puntaje kind:31337', () => {
  it('firma un puntaje anclado al juego y auto-reemplazable por tabla', async () => {
    const { signer, pubkey } = makeSigner();
    const evt = await buildScoreEvent(signer, NOSTR_BOARD_WINS, 7);

    expect(evt.kind).toBe(31337);
    expect(evt.pubkey).toBe(pubkey);
    expect(verifyEvent(evt)).toBe(true);
    // Ancla al juego (a) + un único récord por jugador y tabla (d = coord:board).
    expect(tag(evt.tags, 'a')).toBe(TETRA_GAME_COORD);
    expect(tag(evt.tags, 'd')).toBe(`${TETRA_GAME_COORD}:${NOSTR_BOARD_WINS}`);
    expect(tag(evt.tags, 'board')).toBe(NOSTR_BOARD_WINS);
    expect(tag(evt.tags, 'score')).toBe('7');
  });

  it('separa el récord de supervivencia en su propia tabla', async () => {
    const { signer } = makeSigner();
    const evt = await buildScoreEvent(signer, NOSTR_BOARD_SURVIVAL, 123456);
    expect(tag(evt.tags, 'd')).toBe(`${TETRA_GAME_COORD}:${NOSTR_BOARD_SURVIVAL}`);
    expect(tag(evt.tags, 'score')).toBe('123456');
  });

  it('trunca el puntaje a entero (no acepta decimales sueltos en el tag)', async () => {
    const { signer } = makeSigner();
    const evt = await buildScoreEvent(signer, NOSTR_BOARD_WINS, 9.9);
    expect(tag(evt.tags, 'score')).toBe('9');
  });

  it('rechaza nombres de tabla inválidos', async () => {
    const { signer } = makeSigner();
    await expect(buildScoreEvent(signer, '_malo', 1)).rejects.toThrow();
    await expect(buildScoreEvent(signer, 'MAYÚSCULAS', 1)).rejects.toThrow();
  });

  it('rechaza puntajes negativos', async () => {
    const { signer } = makeSigner();
    await expect(buildScoreEvent(signer, NOSTR_BOARD_WINS, -1)).rejects.toThrow();
  });
});

describe('marcador 2.0 · lectura del ranking desde Nostr (rankNostrScores)', () => {
  it('arma el top ordenado por puntaje y un récord por jugador', () => {
    const a = generateSecretKey();
    const b = generateSecretKey();
    const events = [
      signScore(a, { board: NOSTR_BOARD_WINS, score: 3, createdAt: 100 }),
      // Mismo jugador A, mejor marca: se queda con la mayor (5), no duplica.
      signScore(a, { board: NOSTR_BOARD_WINS, score: 5, createdAt: 200 }),
      signScore(b, { board: NOSTR_BOARD_WINS, score: 9, createdAt: 150 }),
    ];
    const top = rankNostrScores(events, NOSTR_BOARD_WINS);
    expect(top).toHaveLength(2);
    expect(top[0]).toMatchObject({ pubkey: getPublicKey(b), score: 9 });
    expect(top[1]).toMatchObject({ pubkey: getPublicKey(a), score: 5 });
    // npub derivado de la pubkey del firmante.
    expect(top[0].npub).toBe(nip19.npubEncode(getPublicKey(b)));
  });

  it('separa por tabla y por juego (ignora otros boards/coords)', () => {
    const sk = generateSecretKey();
    const events = [
      signScore(sk, { board: NOSTR_BOARD_WINS, score: 4, createdAt: 100 }),
      signScore(sk, { board: NOSTR_BOARD_SURVIVAL, score: 999, createdAt: 100 }),
      signScore(sk, { board: NOSTR_BOARD_WINS, score: 100, createdAt: 100, coord: '30023:otro:juego' }),
    ];
    const wins = rankNostrScores(events, NOSTR_BOARD_WINS);
    expect(wins).toHaveLength(1);
    expect(wins[0].score).toBe(4); // el 100 es de otro juego; el 999 es de otra tabla
  });

  it('descarta eventos con firma inválida (anti-forja)', () => {
    const sk = generateSecretKey();
    const ok = signScore(sk, { board: NOSTR_BOARD_WINS, score: 5, createdAt: 100 });
    // Manoseamos el puntaje después de firmar: el id deja de casar con el hash. El clon
    // por JSON descarta el flag de verificación cacheado que nostr-tools deja en el evento.
    const forged = JSON.parse(JSON.stringify(ok)) as Event;
    forged.tags = forged.tags.map((t) => (t[0] === 'score' ? ['score', '999'] : t));
    expect(verifyEvent(forged)).toBe(false);
    const top = rankNostrScores([forged], NOSTR_BOARD_WINS);
    expect(top).toHaveLength(0);
  });

  it('a igualdad de puntaje, gana el récord más viejo', () => {
    const a = generateSecretKey();
    const b = generateSecretKey();
    const events = [
      signScore(a, { board: NOSTR_BOARD_WINS, score: 7, createdAt: 300 }),
      signScore(b, { board: NOSTR_BOARD_WINS, score: 7, createdAt: 100 }),
    ];
    const top = rankNostrScores(events, NOSTR_BOARD_WINS);
    expect(top.map((e) => e.pubkey)).toEqual([getPublicKey(b), getPublicKey(a)]);
  });

  it('respeta el límite del top', () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      signScore(generateSecretKey(), { board: NOSTR_BOARD_WINS, score: i + 1, createdAt: 100 }),
    );
    expect(rankNostrScores(events, NOSTR_BOARD_WINS, 3)).toHaveLength(3);
  });
});
