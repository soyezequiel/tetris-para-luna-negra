import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent, nip19 } from 'nostr-tools';
import {
  NGP_KIND,
  parseAttestationEvent,
  isAuthorizedAttestation,
} from 'nostr-game-protocol/ngp-core';
import { MemoryRoomStore, createRoom, joinRoom } from '../src/online/roomService';
import type { OnlineRoom } from '../src/online/protocol';
import {
  attestationConfigured,
  buildRoomWinnerAttestation,
} from '../src/online/nostrAttestation';

// Oráculo de atestaciones (NGP kind:31338): el server firma "en la sala X ganó Y"
// con la clave del env, en el settle de la apuesta. Acá se testea el BUILDER puro
// (gates de config, mapeo sala→ganador, forma y firma del evento); la publicación
// a relays es best-effort y no se testea contra la red.

const COORD = '30023:' + 'a'.repeat(64) + ':tetra';
const ORACLE_SK = generateSecretKey();
const ORACLE_PK = getPublicKey(ORACLE_SK);
const WINNER_SK = generateSecretKey();
const WINNER_PK = getPublicKey(WINNER_SK);
const WINNER_NPUB = nip19.npubEncode(WINNER_PK);
const BET_ID = 'bet_123';

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv.NGP_ATTESTATION_ORACLE_NSEC = process.env.NGP_ATTESTATION_ORACLE_NSEC;
  savedEnv.gameCoord = process.env.gameCoord;
  process.env.NGP_ATTESTATION_ORACLE_NSEC = nip19.nsecEncode(ORACLE_SK);
  process.env.gameCoord = COORD;
});
afterEach(() => {
  process.env.NGP_ATTESTATION_ORACLE_NSEC = savedEnv.NGP_ATTESTATION_ORACLE_NSEC;
  process.env.gameCoord = savedEnv.gameCoord;
});

const HOST_ID = 'host-player-1';
const GUEST_ID = 'guest-player-1';

/** Sala terminada con el invitado como ganador (con o sin identidad Nostr). */
async function finishedRoom(winnerNpub: string | null): Promise<OnlineRoom> {
  const store = new MemoryRoomStore();
  const room = await createRoom(store, {
    playerId: HOST_ID,
    name: 'Host',
    visibility: 'private',
  });
  const joined = await joinRoom(store, {
    roomId: room.id,
    playerId: GUEST_ID,
    npub: winnerNpub,
    name: 'Guest',
  });
  return { ...joined, status: 'finished', winnerPlayerId: GUEST_ID };
}

describe('buildRoomWinnerAttestation', () => {
  it('firma el 31338 del ganador y cierra la cadena de verificación del SDK', async () => {
    const room = await finishedRoom(WINNER_NPUB);
    const ev = await buildRoomWinnerAttestation(room, BET_ID);
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe(NGP_KIND.scoreAttestation);
    expect(ev!.pubkey).toBe(ORACLE_PK); // firma la clave del oráculo del env
    expect(verifyEvent(ev!)).toBe(true);
    expect(ev!.tags).toContainEqual(['a', COORD]);
    expect(ev!.tags).toContainEqual(['d', `${COORD}:${BET_ID}`]); // registro permanente por apuesta
    expect(ev!.tags).toContainEqual(['ref', BET_ID]);
    expect(ev!.tags).toContainEqual(['p', WINNER_PK]);
    expect(ev!.tags).toContainEqual(['status', 'verified']);

    // El mismo camino que recorre un VERIFICADOR externo con el SDK: parsear la
    // atestación y cruzar su firmante contra la delegación del listado del juego.
    const parsed = parseAttestationEvent(ev!);
    expect(parsed).not.toBeNull();
    expect(parsed!.playerPubkey).toBe(WINNER_PK);
    expect(parsed!.ref).toBe(BET_ID);
    expect(isAuthorizedAttestation(parsed!, ORACLE_PK)).toBe(true);
    expect(isAuthorizedAttestation(parsed!, 'f'.repeat(64))).toBe(false);
  });

  it('sin nsec o sin gameCoord no atesta (gate de configuración)', async () => {
    const room = await finishedRoom(WINNER_NPUB);
    delete process.env.NGP_ATTESTATION_ORACLE_NSEC;
    expect(attestationConfigured()).toBe(false);
    expect(await buildRoomWinnerAttestation(room, BET_ID)).toBeNull();

    process.env.NGP_ATTESTATION_ORACLE_NSEC = nip19.nsecEncode(ORACLE_SK);
    delete process.env.gameCoord;
    expect(attestationConfigured()).toBe(false);
    expect(await buildRoomWinnerAttestation(room, BET_ID)).toBeNull();
  });

  it('sala sin ganador (empate/anulación) → null', async () => {
    const room = await finishedRoom(WINNER_NPUB);
    expect(await buildRoomWinnerAttestation({ ...room, winnerPlayerId: null }, BET_ID)).toBeNull();
  });

  it('ganador invitado sin identidad Nostr → null (no hay a quién certificar)', async () => {
    const room = await finishedRoom(null);
    expect(await buildRoomWinnerAttestation(room, BET_ID)).toBeNull();
  });

  it('npub del ganador inválido → null (no adivina pubkeys)', async () => {
    const room = await finishedRoom('npub1basura');
    expect(await buildRoomWinnerAttestation(room, BET_ID)).toBeNull();
  });

  it('nsec en hex crudo también configura el oráculo', async () => {
    process.env.NGP_ATTESTATION_ORACLE_NSEC = Buffer.from(ORACLE_SK).toString('hex');
    const room = await finishedRoom(WINNER_NPUB);
    const ev = await buildRoomWinnerAttestation(room, BET_ID);
    expect(ev?.pubkey).toBe(ORACLE_PK);
  });
});
