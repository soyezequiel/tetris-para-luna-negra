import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, nip44, finalizeEvent } from 'nostr-tools';
import { createLocalSigner } from '../src/online/nostrSigner';
import {
  buildChallengeGiftWrap,
  parseChallengeGiftWrap,
} from '../src/online/nostrChallenge';

const ORIGIN = 'https://tetra.example';

function makePair() {
  const skA = generateSecretKey();
  const skB = generateSecretKey();
  return {
    signerA: createLocalSigner(skA),
    signerB: createLocalSigner(skB),
    pubA: getPublicKey(skA),
    pubB: getPublicKey(skB),
    skA,
    skB,
  };
}

describe('reto NIP-17 · round-trip', () => {
  it('A arma un reto para B y B lo desarma con los datos intactos', async () => {
    const { signerA, signerB, pubB } = makePair();
    const joinUrl = `${ORIGIN}/?join=ABC123`;

    const giftWrap = await buildChallengeGiftWrap(signerA, {
      toPubkey: pubB,
      roomId: 'ABC123',
      joinUrl,
      message: '¡Te reto a una partida! 🎲',
    });

    expect(giftWrap.kind).toBe(1059);
    // El gift-wrap va firmado con clave EFÍMERA (no la de A) para no correlacionar.
    expect(giftWrap.tags).toContainEqual(['p', pubB.toLowerCase()]);

    const parsed = await parseChallengeGiftWrap(signerB, giftWrap, { origin: ORIGIN });
    expect(parsed).not.toBeNull();
    expect(parsed!.roomId).toBe('ABC123');
    expect(parsed!.joinUrl).toBe(joinUrl);
    expect(parsed!.message).toBe('¡Te reto a una partida! 🎲');
    // El remitente que ve B es A (recuperado del seal), no la clave efímera.
    const pubAHex = await signerA.getPublicKey();
    expect(parsed!.fromPubkey).toBe(pubAHex);
  });

  it('un tercero (C) no puede desarmar un reto dirigido a B', async () => {
    const { signerA, pubB } = makePair();
    const signerC = createLocalSigner(generateSecretKey());
    const giftWrap = await buildChallengeGiftWrap(signerA, {
      toPubkey: pubB,
      roomId: 'R',
      joinUrl: `${ORIGIN}/?join=R`,
      message: 'hola',
    });
    const parsed = await parseChallengeGiftWrap(signerC, giftWrap, { origin: ORIGIN });
    expect(parsed).toBeNull();
  });
});

describe('reto NIP-17 · seguridad', () => {
  it('rechaza un reto vencido', async () => {
    const { signerA, signerB, pubB } = makePair();
    const giftWrap = await buildChallengeGiftWrap(signerA, {
      toPubkey: pubB,
      roomId: 'R',
      joinUrl: `${ORIGIN}/?join=R`,
      message: 'tarde',
      ttlSec: -10, // ya vencido
    });
    const parsed = await parseChallengeGiftWrap(signerB, giftWrap, { origin: ORIGIN });
    expect(parsed).toBeNull();
  });

  it('rechaza un url de otro origin', async () => {
    const { signerA, signerB, pubB } = makePair();
    const giftWrap = await buildChallengeGiftWrap(signerA, {
      toPubkey: pubB,
      roomId: 'R',
      joinUrl: 'https://malicioso.example/?join=R',
      message: 'phishing',
    });
    const parsed = await parseChallengeGiftWrap(signerB, giftWrap, { origin: ORIGIN });
    expect(parsed).toBeNull();
  });

  it('rechaza si el autor del rumor no coincide con el firmante del seal (NIP-59)', async () => {
    // Forjamos un gift-wrap donde el rumor dice venir de un impostor distinto de
    // quien firmó el seal. parse() debe rechazarlo por el chequeo rumor.pubkey===seal.pubkey.
    const { signerB, pubB } = makePair();
    const skImpostor = generateSecretKey();
    const impostorPub = getPublicKey(skImpostor);
    const skSealer = generateSecretKey(); // firma el seal, pubkey != impostor

    const rumor = {
      kind: 14,
      pubkey: impostorPub, // ← miente
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['p', pubB],
        ['url', `${ORIGIN}/?join=R`],
        ['room', 'R'],
      ],
      content: 'falso',
      id: 'x'.repeat(64),
    };
    // seal firmado por skSealer, cifrando el rumor hacia B
    const sealContent = nip44.encrypt(
      JSON.stringify(rumor),
      nip44.getConversationKey(skSealer, pubB),
    );
    const seal = finalizeEvent(
      { kind: 13, created_at: rumor.created_at, tags: [], content: sealContent },
      skSealer,
    );
    // gift-wrap efímero hacia B
    const skEph = generateSecretKey();
    const wrapContent = nip44.encrypt(
      JSON.stringify(seal),
      nip44.getConversationKey(skEph, pubB),
    );
    const giftWrap = finalizeEvent(
      { kind: 1059, created_at: rumor.created_at, tags: [['p', pubB]], content: wrapContent },
      skEph,
    );

    const parsed = await parseChallengeGiftWrap(signerB, giftWrap, { origin: ORIGIN });
    expect(parsed).toBeNull();
  });
});
