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
  // El eco de mi propio KO no me interesa (yo ya lo commiteé localmente).
  if (input.remotePlayerId === input.localPlayerId) return 'ignore';

  // Autoridad descentralizada: cada quien commitea su propia muerte. El host
  // commitea como respaldo idempotente la muerte de cualquier peer; el resto de
  // los clientes la aplican para mostrar al caído al instante (espectador), sin
  // depender de que el KO venga del host. Antes un KO de un no-host se ignoraba.
  return input.isHostAuthority ? 'commit' : 'apply';
}

