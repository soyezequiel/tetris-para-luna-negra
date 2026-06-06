import type {
  AttackRequest,
  CreateRoomRequest,
  EliminateRequest,
  EnqueueMatchmakingRequest,
  JoinRoomRequest,
  LeaveMatchmakingRequest,
  MatchmakingHeartbeatRequest,
  MatchmakingTicketResponse,
  OnlineErrorResponse,
  OnlineProfileResponse,
  OnlineRoomResponse,
  PeerSignalRequest,
  ProgressRequest,
  PublicRoomsFilters,
  PublicRoomsResponse,
  QuickPlayEnterRequest,
  QuickPlayEnterResponse,
  QuickPlayLeaderboardResponse,
  ReadyRequest,
  ResultRequest,
  SetTargetingRequest,
  StartRoomRequest,
} from './protocol';

export class OnlineClient {
  constructor(
    private readonly basePath = '/api/rooms',
    private readonly matchmakingBasePath = '/api/matchmaking',
  ) {}

  createRoom(request: CreateRoomRequest): Promise<OnlineRoomResponse> {
    return this.post('/create', request);
  }

  joinRoom(request: JoinRoomRequest): Promise<OnlineRoomResponse> {
    return this.post('/join', request);
  }

  setReady(request: ReadyRequest): Promise<OnlineRoomResponse> {
    return this.post('/ready', request);
  }

  startRoom(request: StartRoomRequest): Promise<OnlineRoomResponse> {
    return this.post('/start', request);
  }

  setTargeting(request: SetTargetingRequest): Promise<OnlineRoomResponse> {
    return this.post('/targeting', request);
  }

  updateProgress(request: ProgressRequest): Promise<OnlineRoomResponse> {
    return this.post('/progress', request);
  }

  sendAttack(request: AttackRequest): Promise<OnlineRoomResponse> {
    return this.post('/attack', request);
  }

  eliminatePlayer(request: EliminateRequest): Promise<OnlineRoomResponse> {
    return this.post('/eliminate', request);
  }

  submitResult(request: ResultRequest): Promise<OnlineRoomResponse> {
    return this.post('/result', request);
  }

  sendPeerSignal(request: PeerSignalRequest): Promise<OnlineRoomResponse> {
    return this.post('/signal', request);
  }

  getRoomState(roomId: string): Promise<OnlineRoomResponse> {
    return this.get(`/state?roomId=${encodeURIComponent(roomId)}`);
  }

  listPublicRooms(filters: PublicRoomsFilters = {}): Promise<PublicRoomsResponse> {
    const query = filtersToQuery(filters);
    return this.get(`/public${query}`);
  }

  enqueueMatchmaking(request: EnqueueMatchmakingRequest): Promise<MatchmakingTicketResponse> {
    return this.postMatchmaking('/enqueue', request);
  }

  heartbeatMatchmaking(request: MatchmakingHeartbeatRequest): Promise<MatchmakingTicketResponse> {
    return this.postMatchmaking('/heartbeat', request);
  }

  leaveMatchmaking(request: LeaveMatchmakingRequest): Promise<MatchmakingTicketResponse> {
    return this.postMatchmaking('/leave', request);
  }

  getMatchmakingTicket(ticketId: string, playerId: string): Promise<MatchmakingTicketResponse> {
    return this.request<MatchmakingTicketResponse>(
      `${this.matchmakingBasePath}/ticket?ticketId=${encodeURIComponent(ticketId)}&playerId=${encodeURIComponent(playerId)}`,
      { method: 'GET' },
    );
  }

  getProfileState(playerId: string, name: string): Promise<OnlineProfileResponse> {
    return this.request<OnlineProfileResponse>(
      `/api/profiles/state?playerId=${encodeURIComponent(playerId)}&name=${encodeURIComponent(name)}`,
      { method: 'GET' },
    );
  }

  enterQuickPlay(request: QuickPlayEnterRequest): Promise<QuickPlayEnterResponse> {
    return this.request<QuickPlayEnterResponse>('/api/quickplay/enter', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  }

  getQuickPlayLeaderboard(): Promise<QuickPlayLeaderboardResponse> {
    return this.request<QuickPlayLeaderboardResponse>('/api/quickplay/leaderboard', { method: 'GET' });
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

  private async postMatchmaking<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(`${this.matchmakingBasePath}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(path.startsWith('/api/') ? path : `${this.basePath}${path}`, init);
    const payload = await readResponsePayload<T | OnlineErrorResponse>(response);
    if (!response.ok) {
      throw new Error(isErrorResponse(payload) ? payload.error : 'Online request failed.');
    }
    if (payload === null) throw new Error('Online API returned an empty response.');
    return payload as T;
  }
}

async function readResponsePayload<T>(response: Response): Promise<T | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    const preview = text.slice(0, 120).replace(/\s+/g, ' ').trim();
    throw new Error(`Online API returned non-JSON response (${response.status}): ${preview}`);
  }
}

function isErrorResponse(value: unknown): value is OnlineErrorResponse {
  return typeof value === 'object' && value !== null && 'error' in value && typeof (value as OnlineErrorResponse).error === 'string';
}

function filtersToQuery(filters: PublicRoomsFilters): string {
  const params = new URLSearchParams();
  if (filters.matchType) params.set('matchType', filters.matchType);
  if (filters.status) params.set('status', filters.status);
  if (filters.region) params.set('region', filters.region);
  if (typeof filters.ranked === 'boolean') params.set('ranked', String(filters.ranked));
  if (filters.customPreset) params.set('customPreset', filters.customPreset);
  if (filters.minPlayers !== undefined) params.set('minPlayers', String(filters.minPlayers));
  if (filters.maxPlayers !== undefined) params.set('maxPlayers', String(filters.maxPlayers));
  const query = params.toString();
  return query ? `?${query}` : '';
}
