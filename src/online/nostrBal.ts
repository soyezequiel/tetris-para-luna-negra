import {
  createBalBrowserLogin,
  type BalBrowserSigner,
} from 'nostr-bal-browser-sdk';
import { NIP46_PERMS } from './nostrPermissions';

const SHARED_ACTIVE_HINT_KEY = 'tetra.bal.shared-active.v1';

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
    activeHintKey: SHARED_ACTIVE_HINT_KEY,
  },
});

/**
 * Conecta BAL reutilizando primero la sesión del SharedWorker. Luna revoca esa
 * sesión cuando cambia de cuenta, así que los room links de la misma cuenta no
 * repiten el handshake completo.
 */
export async function connectNostrBal(
  onLauncherLogout: () => void,
  onConsentRequired?: () => void,
): Promise<BalBrowserSigner | null> {
  return nostrBal.connect(onLauncherLogout, onConsentRequired);
}
