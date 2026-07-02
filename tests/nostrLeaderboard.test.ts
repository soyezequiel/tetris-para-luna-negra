import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { createLocalSigner } from '../src/online/nostrSigner';
import {
  buildScoreEvent,
  NOSTR_BOARD_SURVIVAL,
  NOSTR_BOARD_WINS,
} from '../src/online/nostrLeaderboard';
import { TETRA_GAME_COORD } from '../src/online/nostrChallenge';

function makeSigner() {
  const sk = generateSecretKey();
  return { signer: createLocalSigner(sk), pubkey: getPublicKey(sk) };
}

const tag = (tags: string[][], k: string) => tags.find((t) => t[0] === k)?.[1] ?? null;

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
