// Estado del dominio Luna Negra / invitaciones / launch (identidad SSO de Luna,
// ventana de invitar amigos, requests de "entrar a sala" que llegan por postMessage
// desde Luna). Objeto mutable fuera de main.ts, igual que el resto de PR7.
import type { LunaIdentity, LunaLaunchRequest } from '../online/protocol';
import type { ParsedChallenge } from '../online/nostrChallenge';

// Un launch request de Luna ya normalizado (con el roomId saneado listo para unirse).
export type PendingLunaLaunchRequest = LunaLaunchRequest & { normalizedRoomId: string };

// Método de login Nostr 2.0 elegido en la puerta de bienvenida.
export type NostrLoginTab = 'extension' | 'qr' | 'bunker' | 'local';

// Estado del flujo de login Nostr 2.0 (firmante en el navegador). El signer
// activo y el `{ signer, nsec }` recién generado viven fuera del estado
// serializable (en main.ts), porque no son representables como HTML/JSON.
export interface NostrLoginState {
  tab: NostrLoginTab;
  busy: boolean;
  error: string | null;
  // Flujo QR / "abrir en la app" (Nostr Connect).
  qrUri: string | null;
  qrDataUrl: string | null;
  authUrl: string | null;
  // Inputs editables.
  bunkerInput: string;
  nsecInput: string;
  // nsec recién generado para respaldar (se muestra una sola vez).
  generatedNsec: string | null;
}

export interface NostrChallengeFriend {
  pubkey: string;
  npub: string;
  name: string;
  avatarUrl: string | null;
}

export type IncomingNostrChallenge = ParsedChallenge & {
  fromName: string;
  fromAvatarUrl: string | null;
};

export interface NostrChallengeState {
  pickerOpen: boolean;
  loading: boolean;
  error: string | null;
  query: string;
  loadedForPubkey: string | null;
  friends: NostrChallengeFriend[];
  sendingPubkey: string | null;
  incoming: IncomingNostrChallenge[];
}

export interface LunaState {
  // Identidad Nostr 2.0 (npub/pubkey/nombre/avatar), o null si no hay sesión.
  identity: LunaIdentity | null;
  inviteWindowBusy: boolean;
  inviteNotice: string | null;
  // Momento en que se copió el link de invitación de la sala, para mostrar un
  // "¡Link copiado!" efímero en el botón sin necesidad de un toast aparte.
  roomInviteLinkCopiedAt: number;
  // Si el bloque de depósito (QR de pago) estaba visible en el render anterior, para
  // auto-scrollearlo a la vista la primera vez que aparece (antes quedaba abajo).
  depositWasVisible: boolean;
  // Origen de Luna confiado para los postMessage (se persiste).
  trustedOrigin: string | null;
  launchPollInFlight: boolean;
  // Request de "entrar a sala" pendiente de confirmación del usuario.
  pendingLaunchRequest: PendingLunaLaunchRequest | null;
  // Ids de launch requests que el usuario ya descartó (no volver a ofrecerlos).
  ignoredLaunchRequestIds: Set<string>;
  // Login Nostr 2.0 (firmante en el navegador).
  nostrLogin: NostrLoginState;
  // Invitaciones 2.0: retos NIP-17 + amigos NIP-02.
  challenge: NostrChallengeState;
}

export const lunaState: LunaState = {
  identity: null,
  inviteWindowBusy: false,
  inviteNotice: null,
  roomInviteLinkCopiedAt: 0,
  depositWasVisible: false,
  trustedOrigin: null,
  launchPollInFlight: false,
  pendingLaunchRequest: null,
  ignoredLaunchRequestIds: new Set<string>(),
  nostrLogin: {
    tab: 'extension',
    busy: false,
    error: null,
    qrUri: null,
    qrDataUrl: null,
    authUrl: null,
    bunkerInput: '',
    nsecInput: '',
    generatedNsec: null,
  },
  challenge: {
    pickerOpen: false,
    loading: false,
    error: null,
    query: '',
    loadedForPubkey: null,
    friends: [],
    sendingPubkey: null,
    incoming: [],
  },
};
