import { createBalBrowserLogin } from 'nostr-bal-browser-sdk';
import { NIP46_PERMS } from './nostrPermissions';

/**
 * Bunker Auto Login de Luna Negra. El identificador y los permisos deben
 * coincidir exactamente con el manifiesto de TETRA registrado en el launcher.
 */
export const nostrBal = createBalBrowserLogin({
  gameId: 'tetris-beta',
  gameName: 'TETRA',
  launcherName: 'Luna Negra',
  permissions: NIP46_PERMS,
  launcherOriginStorageKey: 'tetra.bal.launcher-origin.v1',
  shared: {
    createWorker: () => new SharedWorker(
      new URL('./bal-worker.ts', import.meta.url),
      { type: 'module', name: 'tetra-bal-v1' },
    ),
    activeHintKey: 'tetra.bal.shared-active.v1',
  },
});
