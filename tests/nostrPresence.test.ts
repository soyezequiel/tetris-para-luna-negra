import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { createLocalSigner } from '../src/online/nostrSigner';
import { buildPresenceEvent, PRESENCE_TTL_SEC } from '../src/online/nostrPresence';
import { TETRA_GAME_COORD } from '../src/online/nostrChallenge';

function makeSigner() {
  const sk = generateSecretKey();
  return { signer: createLocalSigner(sk), pubkey: getPublicKey(sk) };
}

const tag = (tags: string[][], k: string) => tags.find((t) => t[0] === k)?.[1] ?? null;

describe('presencia NIP-38 · evento kind:30315', () => {
  it('firma un estado "in-game" anclado al juego y auto-reemplazable', async () => {
    const { signer, pubkey } = makeSigner();
    const evt = await buildPresenceEvent(signer, 'in-game');

    expect(evt.kind).toBe(30315);
    expect(evt.pubkey).toBe(pubkey);
    expect(verifyEvent(evt)).toBe(true);
    // `d`="general" hace que cada jugador tenga UN estado que se reemplaza (NIP-38).
    expect(tag(evt.tags, 'd')).toBe('general');
    // Ancla al juego para que Luna Negra derive "Jugando TETRA".
    expect(tag(evt.tags, 'a')).toBe(TETRA_GAME_COORD);
    expect(evt.content).toContain('Jugando');
  });

  it('distingue el estado "online" (juego abierto, sin sala)', async () => {
    const { signer } = makeSigner();
    const evt = await buildPresenceEvent(signer, 'online');
    expect(evt.content).not.toContain('Jugando');
    expect(evt.content.length).toBeGreaterThan(0);
  });

  it('caduca a los PRESENCE_TTL_SEC si el jugador deja de latir', async () => {
    const { signer } = makeSigner();
    const before = Math.floor(Date.now() / 1000);
    const evt = await buildPresenceEvent(signer, 'in-game');
    const expiration = Number(tag(evt.tags, 'expiration'));
    expect(expiration).toBeGreaterThanOrEqual(before + PRESENCE_TTL_SEC);
    expect(expiration).toBeLessThanOrEqual(before + PRESENCE_TTL_SEC + 2);
  });
});
