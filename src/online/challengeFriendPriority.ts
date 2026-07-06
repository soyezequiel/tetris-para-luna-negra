import { getPool, PROFILE_RELAYS } from './nostrRelays';
import { TETRA_GAME_COORD } from './nostrChallenge';

export interface FriendAffinity {
  tetraSeenAtMs: number;
  lastPlayedAtMs: number | null;
  gamesTogether: number;
  matchIds: string[];
}

export type FriendAffinities = Map<string, FriendAffinity>;

export interface FriendPriorityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface StoredFriendAffinities {
  version: 1;
  friends: Record<string, FriendAffinity>;
}

const STORAGE_PREFIX = 'tetra.challengeFriendAffinity.v1';
const MAX_MATCH_IDS_PER_FRIEND = 24;
const ACTIVITY_BATCH_SIZE = 200;
const ACTIVITY_MAX_WAIT_MS = 3000;
const PRESENCE_KIND = 30315;
const LEADERBOARD_KIND = 31337;
const PUBKEY_RE = /^[0-9a-f]{64}$/;

function browserStorage(): FriendPriorityStorage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function storageKey(ownerPubkey: string): string {
  return `${STORAGE_PREFIX}.${ownerPubkey}`;
}

function normalizePubkey(value: string): string | null {
  const pubkey = value.trim().toLowerCase();
  return PUBKEY_RE.test(pubkey) ? pubkey : null;
}

function normalizeAffinity(value: unknown): FriendAffinity | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<FriendAffinity>;
  const tetraSeenAtMs = Number(item.tetraSeenAtMs);
  if (!Number.isFinite(tetraSeenAtMs) || tetraSeenAtMs <= 0) return null;
  const lastPlayed = item.lastPlayedAtMs === null ? null : Number(item.lastPlayedAtMs);
  const gamesTogether = Math.max(0, Math.floor(Number(item.gamesTogether) || 0));
  const matchIds = Array.isArray(item.matchIds)
    ? item.matchIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(-MAX_MATCH_IDS_PER_FRIEND)
    : [];
  return {
    tetraSeenAtMs,
    lastPlayedAtMs: lastPlayed !== null && Number.isFinite(lastPlayed) && lastPlayed > 0 ? lastPlayed : null,
    gamesTogether,
    matchIds,
  };
}

/** Carga la afinidad local por cuenta. Datos inválidos o de otra versión se ignoran. */
export function loadFriendAffinities(
  ownerPubkey: string,
  storage: FriendPriorityStorage | null = browserStorage(),
): FriendAffinities {
  const owner = normalizePubkey(ownerPubkey);
  if (!owner || !storage) return new Map();
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(owner)) ?? 'null') as Partial<StoredFriendAffinities> | null;
    if (!parsed || parsed.version !== 1 || !parsed.friends || typeof parsed.friends !== 'object') return new Map();
    const result: FriendAffinities = new Map();
    for (const [rawPubkey, rawAffinity] of Object.entries(parsed.friends)) {
      const pubkey = normalizePubkey(rawPubkey);
      const affinity = normalizeAffinity(rawAffinity);
      if (pubkey && pubkey !== owner && affinity) result.set(pubkey, affinity);
    }
    return result;
  } catch {
    return new Map();
  }
}

function saveFriendAffinities(
  ownerPubkey: string,
  affinities: FriendAffinities,
  storage: FriendPriorityStorage | null,
): void {
  if (!storage) return;
  const friends: Record<string, FriendAffinity> = {};
  for (const [pubkey, affinity] of affinities) friends[pubkey] = affinity;
  try {
    storage.setItem(storageKey(ownerPubkey), JSON.stringify({ version: 1, friends } satisfies StoredFriendAffinities));
  } catch {
    // Es una mejora de orden: storage lleno o bloqueado no debe romper el picker.
  }
}

/**
 * Recuerda amigos vistos dentro de TETRA. Con `matchId` registra además una partida
 * compartida, deduplicada para que los polls de la misma ronda no sumen de más.
 */
export function rememberFriendActivity(
  ownerPubkey: string,
  friendPubkeys: Iterable<string>,
  options: { matchId?: string | null; atMs?: number } = {},
  storage: FriendPriorityStorage | null = browserStorage(),
): FriendAffinities {
  const owner = normalizePubkey(ownerPubkey);
  if (!owner) return new Map();
  const affinities = loadFriendAffinities(owner, storage);
  const atMs = Number.isFinite(options.atMs) && Number(options.atMs) > 0 ? Number(options.atMs) : Date.now();
  const matchId = options.matchId?.trim() || null;
  let changed = false;

  for (const value of friendPubkeys) {
    const pubkey = normalizePubkey(value);
    if (!pubkey || pubkey === owner) continue;
    const previous = affinities.get(pubkey);
    if (!previous) {
      affinities.set(pubkey, {
        tetraSeenAtMs: atMs,
        lastPlayedAtMs: matchId ? atMs : null,
        gamesTogether: matchId ? 1 : 0,
        matchIds: matchId ? [matchId] : [],
      });
      changed = true;
      continue;
    }
    if (!matchId || previous.matchIds.includes(matchId)) continue;
    affinities.set(pubkey, {
      ...previous,
      lastPlayedAtMs: Math.max(previous.lastPlayedAtMs ?? 0, atMs),
      gamesTogether: previous.gamesTogether + 1,
      matchIds: [...previous.matchIds, matchId].slice(-MAX_MATCH_IDS_PER_FRIEND),
    });
    changed = true;
  }

  if (changed) saveFriendAffinities(owner, affinities, storage);
  return affinities;
}

/** Orden: partidas compartidas, usuarios conocidos de TETRA y finalmente el resto. */
export function prioritizeChallengeFriends<T extends { pubkey: string; name: string }>(
  friends: T[],
  affinities: FriendAffinities,
): T[] {
  return [...friends].sort((a, b) => {
    const affinityA = affinities.get(a.pubkey.trim().toLowerCase());
    const affinityB = affinities.get(b.pubkey.trim().toLowerCase());
    const playedA = (affinityA?.gamesTogether ?? 0) > 0;
    const playedB = (affinityB?.gamesTogether ?? 0) > 0;
    if (playedA !== playedB) return playedA ? -1 : 1;
    if (playedA && playedB) {
      const gamesDelta = (affinityB?.gamesTogether ?? 0) - (affinityA?.gamesTogether ?? 0);
      if (gamesDelta !== 0) return gamesDelta;
      const recentDelta = (affinityB?.lastPlayedAtMs ?? 0) - (affinityA?.lastPlayedAtMs ?? 0);
      if (recentDelta !== 0) return recentDelta;
    }
    const knownA = affinityA !== undefined;
    const knownB = affinityB !== undefined;
    if (knownA !== knownB) return knownA ? -1 : 1;
    return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
  });
}

/**
 * Detecta contactos con evidencia pública de TETRA: presencia NIP-38 o un marcador
 * persistente. La consulta es best-effort y se parte en lotes para listas grandes.
 */
export async function fetchKnownTetraPlayers(pubkeys: string[]): Promise<Set<string>> {
  const unique = [...new Set(pubkeys.map((value) => normalizePubkey(value)).filter((value): value is string => value !== null))];
  if (unique.length === 0) return new Set();
  const batches: string[][] = [];
  for (let index = 0; index < unique.length; index += ACTIVITY_BATCH_SIZE) {
    batches.push(unique.slice(index, index + ACTIVITY_BATCH_SIZE));
  }
  const known = new Set<string>();
  await Promise.all(batches.map(async (authors) => {
    try {
      const events = await getPool().querySync(PROFILE_RELAYS, {
        kinds: [PRESENCE_KIND, LEADERBOARD_KIND],
        authors,
        '#a': [TETRA_GAME_COORD],
      }, { maxWait: ACTIVITY_MAX_WAIT_MS });
      for (const event of events) {
        if (authors.includes(event.pubkey) && event.tags.some((tag) => tag[0] === 'a' && tag[1] === TETRA_GAME_COORD)) {
          known.add(event.pubkey);
        }
      }
    } catch {
      // Un lote o relay caído no impide ordenar con el historial local disponible.
    }
  }));
  return known;
}
