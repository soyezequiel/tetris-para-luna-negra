import {
  createBalBrowserLogin,
  hasSharedBalHint,
  type BalBrowserSigner,
} from 'nostr-bal-browser-sdk';
import { NIP46_PERMS } from './nostrPermissions';

const SHARED_ACTIVE_HINT_KEY = 'tetra.bal.shared-active.v1';
let bypassSharedWorker = false;

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
    createWorker: () => {
      // Un cambio explícito de cuenta no debe adoptar el signer compartido de
      // la cuenta anterior. Al lanzar ese handshake usamos el transporte directo.
      if (bypassSharedWorker) throw new Error('BAL requiere una sesión nueva');
      return new SharedWorker(
        new URL('./bal-worker.ts', import.meta.url),
        { type: 'module', name: 'tetra-bal-v1' },
      );
    },
    activeHintKey: SHARED_ACTIVE_HINT_KEY,
  },
});

/**
 * Conecta BAL. En un pedido explícito de cambio de cuenta evita reutilizar una
 * sesión del SharedWorker que todavía pertenece a otra pestaña/cuenta.
 */
export async function connectNostrBal(
  onLauncherLogout: () => void,
  onConsentRequired?: () => void,
  options: { fresh?: boolean } = {},
): Promise<BalBrowserSigner | null> {
  bypassSharedWorker = Boolean(options.fresh && hasSharedBalHint(SHARED_ACTIVE_HINT_KEY));
  try {
    return await nostrBal.connect(onLauncherLogout, onConsentRequired);
  } finally {
    bypassSharedWorker = false;
  }
}
