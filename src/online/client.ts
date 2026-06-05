import type {
  CreateRoomRequest,
  JoinRoomRequest,
  OnlineErrorResponse,
  OnlineRoomResponse,
  ProgressRequest,
  PublicRoomsResponse,
  ReadyRequest,
  ResultRequest,
  StartRoomRequest,
} from './protocol';

export class OnlineClient {
  constructor(private readonly basePath = '/api/rooms') {}

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

  updateProgress(request: ProgressRequest): Promise<OnlineRoomResponse> {
    return this.post('/progress', request);
  }

  submitResult(request: ResultRequest): Promise<OnlineRoomResponse> {
    return this.post('/result', request);
  }

  getRoomState(roomId: string): Promise<OnlineRoomResponse> {
    return this.get(`/state?roomId=${encodeURIComponent(roomId)}`);
  }

  listPublicRooms(): Promise<PublicRoomsResponse> {
    return this.get('/public');
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
    const payload = await response.json() as T | OnlineErrorResponse;
    if (!response.ok) {
      throw new Error(isErrorResponse(payload) ? payload.error : 'Online request failed.');
    }
    return payload as T;
  }
}

function isErrorResponse(value: unknown): value is OnlineErrorResponse {
  return typeof value === 'object' && value !== null && 'error' in value && typeof (value as OnlineErrorResponse).error === 'string';
}
