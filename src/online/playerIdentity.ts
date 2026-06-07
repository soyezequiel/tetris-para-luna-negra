export interface LocalOnlinePlayer {
  id: string;
  name: string;
  avatarUrl: string | null;
}

const PLAYER_KEY = 'stack40.onlinePlayer.v1';

export function loadOnlinePlayer(): LocalOnlinePlayer {
  try {
    const raw = localStorage.getItem(PLAYER_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<LocalOnlinePlayer> : {};
    return normalizePlayer(parsed);
  } catch {
    return normalizePlayer({});
  }
}

export function saveOnlinePlayer(player: LocalOnlinePlayer): LocalOnlinePlayer {
  const normalized = normalizePlayer(player);
  localStorage.setItem(PLAYER_KEY, JSON.stringify(normalized));
  return normalized;
}

function normalizePlayer(player: Partial<LocalOnlinePlayer>): LocalOnlinePlayer {
  return {
    id: normalizeId(player.id),
    name: normalizeName(player.name),
    avatarUrl: normalizeAvatarUrl(player.avatarUrl),
  };
}

function normalizeId(value: unknown): string {
  if (typeof value === 'string' && value.length >= 8) return value;
  if (crypto.randomUUID) return crypto.randomUUID();
  return `player-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') return 'Player';
  const normalized = value.trim().slice(0, 18);
  return normalized.length > 0 ? normalized : 'Player';
}

function normalizeAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
