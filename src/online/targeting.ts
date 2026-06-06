import type { OnlinePlayer, TargetingMode } from './protocol';

export interface SelectAttackTargetOptions {
  players: OnlinePlayer[];
  sourcePlayerId: string;
  attackId: string;
  mode: TargetingMode;
  manualTargetPlayerId?: string | null;
  recentAttackers?: string[];
}

export function selectAttackTarget(options: SelectAttackTargetOptions): OnlinePlayer | null {
  const candidates = liveTargetCandidates(options.players, options.sourcePlayerId);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  if (options.mode === 'manual') {
    const manual = candidates.find((player) => player.id === options.manualTargetPlayerId);
    if (manual) return manual;
  }

  if (options.mode === 'attackers') {
    const attackers = [...(options.recentAttackers ?? [])].reverse();
    const attacker = attackers
      .map((playerId) => candidates.find((player) => player.id === playerId) ?? null)
      .find((player): player is OnlinePlayer => player !== null);
    if (attacker) return attacker;
  }

  if (options.mode === 'even') {
    return minBy(candidates, (player) => (
      player.receivedGarbageThisRound * 100_000
      + player.receivedGarbage * 100
      + player.pendingGarbage
    ));
  }

  if (options.mode === 'ko') {
    return maxBy(candidates, (player) => (
      player.dangerLevel * 100_000
      + player.pendingGarbage * 100
      + player.elapsedFrames
    ));
  }

  if (options.mode === 'leader') {
    return maxBy(candidates, (player) => (
      player.koCount * 1_000_000
      + player.sentGarbage * 1_000
      + player.lines * 10
      + player.elapsedFrames
    ));
  }

  return candidates[hashText(options.attackId) % candidates.length];
}

function liveTargetCandidates(players: OnlinePlayer[], sourcePlayerId: string): OnlinePlayer[] {
  return players.filter((player) => (
    player.id !== sourcePlayerId
    && player.alive
    && player.status !== 'eliminated'
    && player.status !== 'winner'
    && player.status !== 'disconnected'
  ));
}

function minBy(players: OnlinePlayer[], score: (player: OnlinePlayer) => number): OnlinePlayer {
  return [...players].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))[0];
}

function maxBy(players: OnlinePlayer[], score: (player: OnlinePlayer) => number): OnlinePlayer {
  return [...players].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0];
}

function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
