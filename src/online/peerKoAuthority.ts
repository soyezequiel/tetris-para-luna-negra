export type PeerKoAction = 'ignore' | 'apply' | 'commit';

interface PeerKoDecisionInput {
  isHostAuthority: boolean;
  localPlayerId: string;
  hostPlayerId: string;
  remotePlayerId: string;
  messagePlayerId: string;
  playerIsInRoom: boolean;
  seedMatches: boolean;
}

export function decidePeerKoAction(input: PeerKoDecisionInput): PeerKoAction {
  if (!input.seedMatches) return 'ignore';
  if (!input.playerIsInRoom) return 'ignore';
  if (input.remotePlayerId !== input.messagePlayerId) return 'ignore';

  if (input.isHostAuthority) {
    if (input.remotePlayerId === input.localPlayerId) return 'ignore';
    return 'commit';
  }

  return input.remotePlayerId === input.hostPlayerId ? 'apply' : 'ignore';
}
