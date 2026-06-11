import type {
  LunaFriendsResponse,
  LunaInviteRequest,
  LunaInviteResponse,
  LunaInviteWindowResponse,
  LunaLaunchRequestResponse,
  LunaLoginUrlResponse,
  LunaPresenceRequest,
  LunaSessionResponse,
} from './protocol';

// Cliente del frontend para la capa social de Luna Negra. Habla con los
// endpoints proxy /api/luna-negra/* (la API key vive en el servidor).
export class LunaSocialClient {
  constructor(private readonly basePath = '/api/luna-negra') {}

  resolveSession(token: string): Promise<LunaSessionResponse> {
    return this.get(`/session?token=${encodeURIComponent(token)}`);
  }

  listFriends(npub: string): Promise<LunaFriendsResponse> {
    return this.get(`/friends?npub=${encodeURIComponent(npub)}`);
  }

  heartbeat(request: LunaPresenceRequest): Promise<{ ok: boolean }> {
    return this.post('/presence', request);
  }

  invite(request: LunaInviteRequest): Promise<LunaInviteResponse> {
    return this.post('/invite', request);
  }

  inviteWindow(gameId: string, roomId: string, playerId: string): Promise<LunaInviteWindowResponse> {
    const params = new URLSearchParams({ gameId, roomId, playerId });
    return this.get(`/invite-window?${params.toString()}`);
  }

  loginUrl(): Promise<LunaLoginUrlResponse> {
    return this.get('/login-url');
  }

  launchRequest(npub: string): Promise<LunaLaunchRequestResponse> {
    return this.get(`/launch-request?npub=${encodeURIComponent(npub)}`);
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
