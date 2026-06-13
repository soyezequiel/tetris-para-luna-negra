import type {
  AttackRequest,
  CreateRoomRequest,
  EliminateRequest,
  JoinRoomRequest,
  KickPlayerRequest,
  LeaveRoomRequest,
  LeaveRoomResponse,
  CreateBetRequest,
  LeaderboardResponse,
  LunaNegraEnterRequest,
  LunaNegraEnterResponse,
  RoomBetActionRequest,
  OnlineErrorResponse,
  SubmitScoreRequest,
  OnlineRoomResponse,
  PeerSignalRequest,
  ProgressRequest,
  PublicRoomsFilters,
  PublicRoomsResponse,
  ReadyRequest,
  RestartRoomRequest,
  ResultRequest,
  SetTargetingRequest,
  StartRoomRequest,
  UpdateRoomSettingsRequest,
} from './protocol';

/** Error HTTP de la API online, con el status para poder distinguir un 404 (sala inexistente). */
export class OnlineApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'OnlineApiError';
  }
}

export class OnlineClient {
  constructor(private readonly basePath = '/api/rooms') {}

  createRoom(request: CreateRoomRequest): Promise<OnlineRoomResponse> {
    return this.post('/create', request);
  }

  joinRoom(request: JoinRoomRequest): Promise<OnlineRoomResponse> {
    return this.post('/join', request);
  }

  leaveRoom(request: LeaveRoomRequest): Promise<LeaveRoomResponse> {
    return this.post('/leave', request);
  }

  kickPlayer(request: KickPlayerRequest): Promise<OnlineRoomResponse> {
    return this.post('/kick', request);
  }

  enterLunaNegraRoom(request: LunaNegraEnterRequest): Promise<LunaNegraEnterResponse> {
    return this.post('/luna-negra/enter', request);
  }

  createBet(request: CreateBetRequest): Promise<OnlineRoomResponse> {
    return this.post('/api/bets/create', request);
  }

  refreshBet(request: RoomBetActionRequest): Promise<OnlineRoomResponse> {
    return this.post('/api/bets/refresh', request);
  }

  cancelBet(request: RoomBetActionRequest): Promise<OnlineRoomResponse> {
    return this.post('/api/bets/cancel', request);
  }

  settleBet(request: RoomBetActionRequest): Promise<OnlineRoomResponse> {
    return this.post('/api/bets/settle', request);
  }

  setReady(request: ReadyRequest): Promise<OnlineRoomResponse> {
    return this.post('/ready', request);
  }

  startRoom(request: StartRoomRequest): Promise<OnlineRoomResponse> {
    return this.post('/start', request);
  }

  restartRoom(request: RestartRoomRequest): Promise<OnlineRoomResponse> {
    return this.post('/restart', request);
  }

  /** Devuelve una sala terminada al lobby (sin que nadie salga de ella). */
  reopenRoom(request: RestartRoomRequest): Promise<OnlineRoomResponse> {
    return this.post('/reopen', request);
  }

  updateRoomSettings(request: UpdateRoomSettingsRequest): Promise<OnlineRoomResponse> {
    return this.post('/settings', request);
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

  /** Top mundial del sprint de 40 líneas (mejor tiempo por jugador). */
  getLeaderboard(limit?: number): Promise<LeaderboardResponse> {
    const query = limit ? `?limit=${encodeURIComponent(limit)}` : '';
    return this.get(`/api/leaderboard${query}`);
  }

  /** Reporta un tiempo de sprint terminado al ranking mundial. */
  submitScore(request: SubmitScoreRequest): Promise<LeaderboardResponse> {
    return this.post('/api/leaderboard', request);
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
    const response = await fetch(path.startsWith('/api/') ? path : `${this.basePath}${path}`, init);
    const payload = await readResponsePayload<T | OnlineErrorResponse>(response);
    if (!response.ok) {
      throw new OnlineApiError(isErrorResponse(payload) ? payload.error : 'Online request failed.', response.status);
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
  if (filters.customPreset) params.set('customPreset', filters.customPreset);
  if (filters.minPlayers !== undefined) params.set('minPlayers', String(filters.minPlayers));
  if (filters.maxPlayers !== undefined) params.set('maxPlayers', String(filters.maxPlayers));
  const query = params.toString();
  return query ? `?${query}` : '';
}
