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
  SurvivalLeaderboardResponse,
  SubmitSurvivalRequest,
  LunaNegraEnterRequest,
  LunaNegraEnterResponse,
  RoomBetActionRequest,
  RoomBetDepositInvoiceRequest,
  OnlineBetDepositInvoiceResponse,
  OnlineErrorResponse,
  SubmitScoreRequest,
  OnlineRoomResponse,
  PeerSignalRequest,
  ProgressRequest,
  PublicRoomsFilters,
  PublicRoomsResponse,
  ReadyRequest,
  RequestHostFailoverRequest,
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

/**
 * Superficie del cliente online. La implementan tanto `OnlineClient` (HTTP, sobre
 * /api/rooms en Vercel) como `PartyOnlineClient` (WebSocket vía PartyKit). El juego
 * habla contra esta interfaz; el transporte se elige en `createOnlineClient`.
 */
export interface OnlineClientApi {
  createRoom(request: CreateRoomRequest): Promise<OnlineRoomResponse>;
  joinRoom(request: JoinRoomRequest): Promise<OnlineRoomResponse>;
  leaveRoom(request: LeaveRoomRequest): Promise<LeaveRoomResponse>;
  kickPlayer(request: KickPlayerRequest): Promise<OnlineRoomResponse>;
  enterLunaNegraRoom(request: LunaNegraEnterRequest): Promise<LunaNegraEnterResponse>;
  createBet(request: CreateBetRequest): Promise<OnlineRoomResponse>;
  refreshBet(request: RoomBetActionRequest): Promise<OnlineRoomResponse>;
  retryBet(request: RoomBetActionRequest): Promise<OnlineRoomResponse>;
  cancelBet(request: RoomBetActionRequest): Promise<OnlineRoomResponse>;
  settleBet(request: RoomBetActionRequest): Promise<OnlineRoomResponse>;
  depositInvoice(request: RoomBetDepositInvoiceRequest): Promise<OnlineBetDepositInvoiceResponse>;
  setReady(request: ReadyRequest): Promise<OnlineRoomResponse>;
  startRoom(request: StartRoomRequest): Promise<OnlineRoomResponse>;
  restartRoom(request: RestartRoomRequest): Promise<OnlineRoomResponse>;
  reopenRoom(request: RestartRoomRequest): Promise<OnlineRoomResponse>;
  updateRoomSettings(request: UpdateRoomSettingsRequest): Promise<OnlineRoomResponse>;
  setTargeting(request: SetTargetingRequest): Promise<OnlineRoomResponse>;
  updateProgress(request: ProgressRequest): Promise<OnlineRoomResponse>;
  sendAttack(request: AttackRequest): Promise<OnlineRoomResponse>;
  eliminatePlayer(request: EliminateRequest): Promise<OnlineRoomResponse>;
  requestHostFailover(request: RequestHostFailoverRequest): Promise<OnlineRoomResponse>;
  submitResult(request: ResultRequest): Promise<OnlineRoomResponse>;
  sendPeerSignal(request: PeerSignalRequest): Promise<OnlineRoomResponse>;
  getRoomState(roomId: string, playerId?: string): Promise<OnlineRoomResponse>;
  listPublicRooms(filters?: PublicRoomsFilters): Promise<PublicRoomsResponse>;
  getLeaderboard(limit?: number): Promise<LeaderboardResponse>;
  submitScore(request: SubmitScoreRequest): Promise<LeaderboardResponse>;
  getSurvivalLeaderboard(limit?: number): Promise<SurvivalLeaderboardResponse>;
  submitSurvival(request: SubmitSurvivalRequest): Promise<SurvivalLeaderboardResponse>;
}

export class OnlineClient implements OnlineClientApi {
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

  retryBet(request: RoomBetActionRequest): Promise<OnlineRoomResponse> {
    return this.post('/api/bets/retry', request);
  }

  cancelBet(request: RoomBetActionRequest): Promise<OnlineRoomResponse> {
    return this.post('/api/bets/cancel', request);
  }

  settleBet(request: RoomBetActionRequest): Promise<OnlineRoomResponse> {
    return this.post('/api/bets/settle', request);
  }

  depositInvoice(request: RoomBetDepositInvoiceRequest): Promise<OnlineBetDepositInvoiceResponse> {
    return this.post('/api/bets/deposit-invoice', request);
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

  /** Pide al servidor que migre la autoridad porque el host parece inalcanzable. */
  requestHostFailover(request: RequestHostFailoverRequest): Promise<OnlineRoomResponse> {
    return this.post('/failover', request);
  }

  submitResult(request: ResultRequest): Promise<OnlineRoomResponse> {
    return this.post('/result', request);
  }

  sendPeerSignal(request: PeerSignalRequest): Promise<OnlineRoomResponse> {
    return this.post('/signal', request);
  }

  getRoomState(roomId: string, playerId?: string): Promise<OnlineRoomResponse> {
    const presence = playerId ? `&playerId=${encodeURIComponent(playerId)}` : '';
    return this.get(`/state?roomId=${encodeURIComponent(roomId)}${presence}`);
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

  /** Suma una victoria multijugador del jugador al ranking mundial. */
  submitScore(request: SubmitScoreRequest): Promise<LeaderboardResponse> {
    return this.post('/api/leaderboard', request);
  }

  /** Top de supervivencia (modo "igual para todos"): mayor tiempo por jugador. */
  getSurvivalLeaderboard(limit?: number): Promise<SurvivalLeaderboardResponse> {
    const query = limit ? `?limit=${encodeURIComponent(limit)}` : '';
    return this.get(`/api/survival${query}`);
  }

  /** Registra el tiempo de supervivencia del jugador (solo mejora su récord). */
  submitSurvival(request: SubmitSurvivalRequest): Promise<SurvivalLeaderboardResponse> {
    return this.post('/api/survival', request);
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
