// Estado del dominio Luna Negra / invitaciones / launch (identidad SSO de Luna,
// ventana de invitar amigos, requests de "entrar a sala" que llegan por postMessage
// desde Luna). Objeto mutable fuera de main.ts, igual que el resto de PR7.
import type { LunaIdentity, LunaLaunchRequest } from '../online/protocol';

// Un launch request de Luna ya normalizado (con el roomId saneado listo para unirse).
export type PendingLunaLaunchRequest = LunaLaunchRequest & { normalizedRoomId: string };

export interface LunaState {
  // Identidad SSO de Luna Negra (npub + token), o null si no hay sesión.
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
};
