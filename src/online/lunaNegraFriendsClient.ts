import type {
  LunaInviteWindowResponse,
  LunaGameInfoResponse,
  LunaLaunchRequestResponse,
  LunaRoomInviteResponse,
} from './protocol';

// Cliente del frontend para los endpoints de Luna Negra que siguen vivos:
// invitación a sala ("Luna Room Link"), launch requests y datos del juego. Habla
// con los proxies /api/luna-negra/* (la API key vive en el servidor).
export class LunaSocialClient {
  constructor(private readonly basePath = '/api/luna-negra') {}

  inviteWindow(gameId: string, roomId: string, playerId: string): Promise<LunaInviteWindowResponse> {
    const params = new URLSearchParams({ gameId, roomId, playerId });
    return this.get(`/invite-window?${params.toString()}`);
  }

  gameInfo(): Promise<LunaGameInfoResponse> {
    return this.get('/game-info');
  }

  launchRequest(npub: string): Promise<LunaLaunchRequestResponse> {
    return this.get(`/launch-request?npub=${encodeURIComponent(npub)}`);
  }

  /** Verifica un `lnInvite` de "Luna Room Link" (invitación dirigida a una sala de
   * este juego). Devuelve el payload o `null` si el token es inválido. */
  verifyRoomInvite(lnInvite: string): Promise<LunaRoomInviteResponse> {
    return this.post('/verify-room-invite', { lnInvite });
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.basePath}${path}`, init);
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message = payload && typeof payload.error === 'string' ? payload.error : 'Luna Negra request failed.';
      throw new Error(message);
    }
    if (payload === null) throw new Error('Luna Negra API returned an empty response.');
    return payload as T;
  }
}
