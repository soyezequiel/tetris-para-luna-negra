import { describe, expect, it } from 'vitest';
import {
  loadFriendAffinities,
  prioritizeChallengeFriends,
  rememberFriendActivity,
  type FriendPriorityStorage,
} from '../src/online/challengeFriendPriority';

const OWNER = 'a'.repeat(64);
const PLAYED = 'b'.repeat(64);
const TETRA_USER = 'c'.repeat(64);
const OTHER = 'd'.repeat(64);

function memoryStorage(): FriendPriorityStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('prioridad de amigos para retos', () => {
  it('prioriza partidas compartidas, luego usuarios de TETRA y después el resto', () => {
    const storage = memoryStorage();
    rememberFriendActivity(OWNER, [TETRA_USER], { atMs: 1000 }, storage);
    const affinities = rememberFriendActivity(OWNER, [PLAYED], { matchId: 'ROOM:1', atMs: 2000 }, storage);
    const result = prioritizeChallengeFriends([
      { pubkey: OTHER, name: 'Ana' },
      { pubkey: TETRA_USER, name: 'Zoe' },
      { pubkey: PLAYED, name: 'Beto' },
    ], affinities);

    expect(result.map((friend) => friend.pubkey)).toEqual([PLAYED, TETRA_USER, OTHER]);
  });

  it('no cuenta varias veces los polls de una misma partida', () => {
    const storage = memoryStorage();
    rememberFriendActivity(OWNER, [PLAYED], { matchId: 'ROOM:7', atMs: 1000 }, storage);
    rememberFriendActivity(OWNER, [PLAYED], { matchId: 'ROOM:7', atMs: 2000 }, storage);
    rememberFriendActivity(OWNER, [PLAYED], { matchId: 'ROOM:8', atMs: 3000 }, storage);

    expect(loadFriendAffinities(OWNER, storage).get(PLAYED)).toMatchObject({
      gamesTogether: 2,
      lastPlayedAtMs: 3000,
      matchIds: ['ROOM:7', 'ROOM:8'],
    });
  });

  it('usa cantidad, recencia y nombre como desempates estables', () => {
    const storage = memoryStorage();
    const friendA = '1'.repeat(64);
    const friendB = '2'.repeat(64);
    rememberFriendActivity(OWNER, [friendA], { matchId: 'A:1', atMs: 1000 }, storage);
    rememberFriendActivity(OWNER, [friendA], { matchId: 'A:2', atMs: 2000 }, storage);
    const affinities = rememberFriendActivity(OWNER, [friendB], { matchId: 'B:1', atMs: 3000 }, storage);

    const result = prioritizeChallengeFriends([
      { pubkey: friendB, name: 'Zeta' },
      { pubkey: friendA, name: 'Álvaro' },
      { pubkey: OTHER, name: 'Bruno' },
      { pubkey: TETRA_USER, name: 'ana' },
    ], affinities);
    expect(result.map((friend) => friend.pubkey)).toEqual([friendA, friendB, TETRA_USER, OTHER]);
  });
});
