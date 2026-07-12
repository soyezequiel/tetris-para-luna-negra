// La invitación "Luna Room Link" llega como DM NIP-04 (kind:4) con el texto
// "Te invito a jugar X en Luna Negra 🎮\n<url ?join=>" (sendDm del repo de
// Luna). Estos tests arman ESE evento real (cifrado NIP-04 incluido) y verifican
// que la bandeja lo detecte igual que el cliente de Luna, filtrando por origin.
import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent, type Event } from 'nostr-tools';
import { createLocalSigner } from '../src/online/nostrSigner';

type SubHandlers = { onevent: (event: Event) => void };
const subscriptions: { filter: Record<string, unknown>; handlers: SubHandlers }[] = [];

vi.mock('../src/online/nostrRelays', () => ({
  DM_RELAYS: ['wss://fake.relay'],
  getPool: () => ({
    subscribeMany: (_relays: string[], filter: Record<string, unknown>, handlers: SubHandlers) => {
      subscriptions.push({ filter, handlers });
      return { close: () => {} };
    },
  }),
}));

import {
  parseOwnRoomLink,
  startRoomLinkInviteInbox,
  type RoomLinkInvite,
} from '../src/online/nostrRoomLinkInbox';

const ORIGIN = 'https://tetra.example';

function makePair() {
  const skLuna = generateSecretKey();
  const skMe = generateSecretKey();
  return {
    skLuna,
    signerMe: createLocalSigner(skMe),
    pubLuna: getPublicKey(skLuna),
    pubMe: getPublicKey(skMe),
  };
}

/** Arma el DM kind:4 EXACTO que manda Luna (inviteViaRoomLink → sendDm). */
async function buildLunaInviteDm(
  skSender: Uint8Array,
  toPubkey: string,
  text: string,
): Promise<Event> {
  const sender = createLocalSigner(skSender);
  const content = await sender.nip04Encrypt(toPubkey, text);
  return finalizeEvent(
    {
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', toPubkey]],
      content,
    },
    skSender,
  );
}

function collectInvites(): { invites: RoomLinkInvite[]; onInvite: (i: RoomLinkInvite) => void } {
  const invites: RoomLinkInvite[] = [];
  return { invites, onInvite: (i) => invites.push(i) };
}

async function flushAsyncParsers(): Promise<void> {
  // onevent descifra en una IIFE async: dos vueltas de microtask alcanzan.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('parseOwnRoomLink', () => {
  it('detecta el enlace join del propio origin dentro del texto del DM', () => {
    const text = `Te invito a jugar TETRA en Luna Negra 🎮\n${ORIGIN}/?join=AB2C`;
    expect(parseOwnRoomLink(text, ORIGIN)).toEqual({
      url: `${ORIGIN}/?join=AB2C`,
      roomId: 'AB2C',
    });
  });

  it('ignora enlaces de OTRO juego (origin distinto): no es una sala nuestra', () => {
    const text = `Te invito a jugar Otro en Luna Negra 🎮\nhttps://otro-juego.example/?join=AB2C`;
    expect(parseOwnRoomLink(text, ORIGIN)).toBeNull();
  });

  it('ignora textos sin URL o con join inválido', () => {
    expect(parseOwnRoomLink('hola, ¿jugamos?', ORIGIN)).toBeNull();
    expect(parseOwnRoomLink(`${ORIGIN}/?join=${'X'.repeat(65)}`, ORIGIN)).toBeNull();
  });

  it('elige la primera URL con join válido aunque haya otras antes', () => {
    const text = `mirá ${ORIGIN}/ranking y vení: ${ORIGIN}/?join=Z9Z9 ya`;
    expect(parseOwnRoomLink(text, ORIGIN)?.roomId).toBe('Z9Z9');
  });
});

describe('bandeja de invitaciones room-link (DM kind:4)', () => {
  it('descifra el DM de Luna y entrega la invitación con sala, url y título', async () => {
    const { skLuna, signerMe, pubLuna, pubMe } = makePair();
    const url = `${ORIGIN}/?join=QF3N`;
    const dm = await buildLunaInviteDm(skLuna, pubMe, `Te invito a jugar TETRA en Luna Negra 🎮\n${url}`);

    const { invites, onInvite } = collectInvites();
    const stop = startRoomLinkInviteInbox(signerMe, pubMe, onInvite, { origin: ORIGIN });
    const sub = subscriptions.at(-1)!;
    expect(sub.filter).toMatchObject({ kinds: [4], '#p': [pubMe] });

    sub.handlers.onevent(dm);
    await flushAsyncParsers();
    stop();

    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({
      eventId: dm.id,
      fromPubkey: pubLuna,
      roomId: 'QF3N',
      url,
      title: 'TETRA',
    });
  });

  it('no avisa por DMs propios, DMs sin enlace ni el mismo evento dos veces', async () => {
    const { skLuna, signerMe, pubMe } = makePair();
    const { invites, onInvite } = collectInvites();
    const stop = startRoomLinkInviteInbox(signerMe, pubMe, onInvite, { origin: ORIGIN });
    const sub = subscriptions.at(-1)!;

    // DM sin enlace de sala: charla normal, no invita.
    sub.handlers.onevent(await buildLunaInviteDm(skLuna, pubMe, 'hola! después jugamos'));
    // Invitación real, entregada dos veces (dos relays).
    const dm = await buildLunaInviteDm(skLuna, pubMe, `entrá: ${ORIGIN}/?join=DUP1`);
    sub.handlers.onevent(dm);
    sub.handlers.onevent(dm);
    await flushAsyncParsers();
    stop();

    expect(invites).toHaveLength(1);
    expect(invites[0].roomId).toBe('DUP1');
  });

  it('ignora la invitación de otro juego (enlace con origin ajeno)', async () => {
    const { skLuna, signerMe, pubMe } = makePair();
    const { invites, onInvite } = collectInvites();
    const stop = startRoomLinkInviteInbox(signerMe, pubMe, onInvite, { origin: ORIGIN });
    const sub = subscriptions.at(-1)!;

    sub.handlers.onevent(
      await buildLunaInviteDm(skLuna, pubMe, 'Te invito a jugar Otro en Luna Negra 🎮\nhttps://otro.example/?join=AJ3N'),
    );
    await flushAsyncParsers();
    stop();

    expect(invites).toHaveLength(0);
  });
});
