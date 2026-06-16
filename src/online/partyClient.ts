import { PartySocket } from 'partysocket';
import { OnlineApiError, OnlineClient, type OnlineClientApi } from './client.js';
import { createRoomCode } from './roomService.js';
import {
  LOBBY_PARTY_ID,
  LOBBY_PARTY_NAME,
  ROOM_PARTY_NAME,
  type LobbyRoomsMessage,
  type RoomAction,
  type RoomClientMessage,
  type RoomReplyMessage,
  type RoomStateMessage,
} from './roomDispatch.js';
import type {
  AttackRequest,
  CreateBetRequest,
  CreateRoomRequest,
  EliminateRequest,
  JoinRoomRequest,
  KickPlayerRequest,
  LeaderboardResponse,
  LeaveRoomRequest,
  LeaveRoomResponse,
  LunaNegraEnterRequest,
  LunaNegraEnterResponse,
  OnlineRoomResponse,
  OnlineRoomSummary,
  PeerSignalRequest,
  ProgressRequest,
  PublicRoomsFilters,
  PublicRoomsResponse,
  ReadyRequest,
  RequestHostFailoverRequest,
  RestartRoomRequest,
  ResultRequest,
  RoomBetActionRequest,
  SetTargetingRequest,
  StartRoomRequest,
  SubmitScoreRequest,
  UpdateRoomSettingsRequest,
} from './protocol.js';

const REQUEST_TIMEOUT_MS = 10_000;
const CREATE_ROOM_ATTEMPTS = 20;

interface PendingRequest {
  resolve: (reply: RoomReplyMessage) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Cliente online sobre WebSocket (PartyKit). Mantiene UN socket a la sala activa
 * (un cliente está en una sala a la vez) y otro al lobby mientras se navega el
 * menú. Las acciones de sala son pedido/respuesta por reqId; el estado además
 * llega empujado (broadcast) y se cachea. Las acciones que NO son de sala
 * (leaderboard, apuestas, Luna Negra) siguen por HTTP, delegadas a `OnlineClient`.
 *
 * No hay polling contra Redis: el estado vive en la RAM del Party. El loop de
 * `getRoomState` del juego sigue corriendo, pero ahora es un ida y vuelta por el
 * socket abierto contra la sala en memoria (0 comandos Redis). Ver
 * [[online-client-authoritative]].
 */
export class PartyOnlineClient implements OnlineClientApi {
  private readonly http: OnlineClient;
  private socket: PartySocket | null = null;
  private socketRoomId: string | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private reqCounter = 0;

  private lobbySocket: PartySocket | null = null;
  private lobbyReady: Promise<void> | null = null;
  private lobbyRooms: OnlineRoomSummary[] = [];
  private lobbyServerNowMs = 0;

  constructor(
    private readonly host: string,
    httpBasePath?: string,
  ) {
    this.http = new OnlineClient(httpBasePath);
  }

  // ── Acciones que NO son de sala: siguen por HTTP (Vercel) ──
  enterLunaNegraRoom(request: LunaNegraEnterRequest): Promise<LunaNegraEnterResponse> {
    return this.http.enterLunaNegraRoom(request);
  }
  createBet(request: CreateBetRequest): Promise<OnlineRoomResponse> {
    return this.http.createBet(request);
  }
  refreshBet(request: RoomBetActionRequest): Promise<OnlineRoomResponse> {
    return this.http.refreshBet(request);
  }
  cancelBet(request: RoomBetActionRequest): Promise<OnlineRoomResponse> {
    return this.http.cancelBet(request);
  }
  settleBet(request: RoomBetActionRequest): Promise<OnlineRoomResponse> {
    return this.http.settleBet(request);
  }
  getLeaderboard(limit?: number): Promise<LeaderboardResponse> {
    return this.http.getLeaderboard(limit);
  }
  submitScore(request: SubmitScoreRequest): Promise<LeaderboardResponse> {
    return this.http.submitScore(request);
  }

  // ── Acciones de sala: por WebSocket ──
  async createRoom(request: CreateRoomRequest): Promise<OnlineRoomResponse> {
    // Sala con id fijo (Luna Negra): un único intento sobre ese id.
    if (request.roomId) {
      await this.ensureRoom(request.roomId);
      return this.roomAction('create', request);
    }
    // Sin id: el cliente elige el código y conecta al Party; si choca (409),
    // reintenta con otro. El server igual valida la unicidad.
    let lastError: unknown;
    for (let attempt = 0; attempt < CREATE_ROOM_ATTEMPTS; attempt += 1) {
      const roomId = createRoomCode();
      await this.ensureRoom(roomId);
      try {
        return await this.roomAction('create', { ...request, roomId });
      } catch (error) {
        lastError = error;
        if (error instanceof OnlineApiError && error.status === 409) {
          this.disconnectRoom();
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new OnlineApiError('No se pudo crear la sala.', 503);
  }

  async joinRoom(request: JoinRoomRequest): Promise<OnlineRoomResponse> {
    await this.ensureRoom(request.roomId);
    return this.roomAction('join', request);
  }

  async leaveRoom(request: LeaveRoomRequest): Promise<LeaveRoomResponse> {
    await this.ensureRoom(request.roomId);
    const reply = await this.request('leave', request);
    this.disconnectRoom();
    if (!reply.ok) throw new OnlineApiError(reply.error ?? 'Online request failed.', reply.status ?? 500);
    return { room: reply.room ?? null, hostMigratedTo: reply.hostMigratedTo ?? null, serverNowMs: reply.serverNowMs };
  }

  kickPlayer(request: KickPlayerRequest): Promise<OnlineRoomResponse> {
    return this.scopedAction('kick', request.roomId, request);
  }
  setReady(request: ReadyRequest): Promise<OnlineRoomResponse> {
    return this.scopedAction('ready', request.roomId, request);
  }
  startRoom(request: StartRoomRequest): Promise<OnlineRoomResponse> {
    return this.scopedAction('start', request.roomId, request);
  }
  restartRoom(request: RestartRoomRequest): Promise<OnlineRoomResponse> {
    return this.scopedAction('restart', request.roomId, request);
  }
  reopenRoom(request: RestartRoomRequest): Promise<OnlineRoomResponse> {
    return this.scopedAction('reopen', request.roomId, request);
  }
  updateRoomSettings(request: UpdateRoomSettingsRequest): Promise<OnlineRoomResponse> {
    return this.scopedAction('settings', request.roomId, request);
  }
  setTargeting(request: SetTargetingRequest): Promise<OnlineRoomResponse> {
    return this.scopedAction('targeting', request.roomId, request);
  }
  updateProgress(request: ProgressRequest): Promise<OnlineRoomResponse> {
    return this.scopedAction('progress', request.roomId, request);
  }
  sendAttack(request: AttackRequest): Promise<OnlineRoomResponse> {
    return this.scopedAction('attack', request.roomId, request);
  }
  eliminatePlayer(request: EliminateRequest): Promise<OnlineRoomResponse> {
    return this.scopedAction('eliminate', request.roomId, request);
  }
  requestHostFailover(request: RequestHostFailoverRequest): Promise<OnlineRoomResponse> {
    return this.scopedAction('failover', request.roomId, request);
  }
  submitResult(request: ResultRequest): Promise<OnlineRoomResponse> {
    return this.scopedAction('result', request.roomId, request);
  }
  sendPeerSignal(request: PeerSignalRequest): Promise<OnlineRoomResponse> {
    return this.scopedAction('signal', request.roomId, request);
  }

  async getRoomState(roomId: string, playerId?: string): Promise<OnlineRoomResponse> {
    await this.ensureRoom(roomId);
    return this.roomAction('state', { roomId, playerId });
  }

  async listPublicRooms(filters: PublicRoomsFilters = {}): Promise<PublicRoomsResponse> {
    await this.ensureLobby();
    return {
      rooms: this.lobbyRooms.filter((room) => matchesFilters(room, filters)),
      serverNowMs: this.lobbyServerNowMs || Date.now(),
    };
  }

  // ── Internos ──
  private async scopedAction(action: RoomAction, roomId: string, request: unknown): Promise<OnlineRoomResponse> {
    await this.ensureRoom(roomId);
    return this.roomAction(action, request);
  }

  private async roomAction(action: RoomAction, payload: unknown): Promise<OnlineRoomResponse> {
    const reply = await this.request(action, payload);
    if (!reply.ok) throw new OnlineApiError(reply.error ?? 'Online request failed.', reply.status ?? 500);
    if (!reply.room) throw new OnlineApiError('Online API returned an empty room.', 500);
    return { room: reply.room, serverNowMs: reply.serverNowMs };
  }

  private request(action: RoomAction, payload: unknown): Promise<RoomReplyMessage> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new OnlineApiError('Sin conexión a la sala.', 0));
    const reqId = `r${(this.reqCounter += 1)}`;
    const message: RoomClientMessage = { action, payload, reqId };
    return new Promise<RoomReplyMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new OnlineApiError('El servidor no respondió a tiempo.', 0));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, { resolve, reject, timer });
      socket.send(JSON.stringify(message));
    });
  }

  private ensureRoom(roomId: string): Promise<void> {
    if (this.socket && this.socketRoomId === roomId) return Promise.resolve();
    if (this.socket) this.disconnectRoom();
    return this.connectRoom(roomId);
  }

  private connectRoom(roomId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new PartySocket({ host: this.host, room: roomId, party: ROOM_PARTY_NAME });
      this.socket = socket;
      this.socketRoomId = roomId;

      const onOpen = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onConnectError);
        resolve();
      };
      const onConnectError = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onConnectError);
        reject(new OnlineApiError('No se pudo conectar a la sala.', 0));
      };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onConnectError);
      socket.addEventListener('message', (event) => this.onRoomMessage(event));
      socket.addEventListener('close', () => this.rejectPending(new OnlineApiError('Conexión con la sala interrumpida.', 0)));
    });
  }

  private onRoomMessage(event: { data: unknown }): void {
    let message: RoomReplyMessage | RoomStateMessage;
    try {
      message = JSON.parse(String(event.data)) as RoomReplyMessage | RoomStateMessage;
    } catch {
      return;
    }
    if (message.type === 'room') {
      // Broadcast de estado: en la Fase 3 el juego sigue pidiendo `state`; el push
      // se consumirá para reemplazar ese loop en una fase siguiente.
      return;
    }
    if (message.type === 'reply') {
      if (!message.reqId) return;
      const entry = this.pending.get(message.reqId);
      if (!entry) return;
      this.pending.delete(message.reqId);
      clearTimeout(entry.timer);
      entry.resolve(message);
    }
  }

  private rejectPending(error: unknown): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private disconnectRoom(): void {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    this.socketRoomId = null;
    this.rejectPending(new OnlineApiError('Saliste de la sala.', 0));
    socket.close();
  }

  private ensureLobby(): Promise<void> {
    if (this.lobbyReady) return this.lobbyReady;
    this.lobbyReady = new Promise<void>((resolve) => {
      if (this.lobbySocket) this.lobbySocket.close(); // defensivo: nunca dejamos dos sockets al lobby
      const socket = new PartySocket({ host: this.host, room: LOBBY_PARTY_ID, party: LOBBY_PARTY_NAME });
      this.lobbySocket = socket;
      let resolved = false;
      const settle = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      socket.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data)) as LobbyRoomsMessage;
          if (message.type === 'rooms') {
            this.lobbyRooms = message.rooms;
            this.lobbyServerNowMs = message.serverNowMs;
            settle();
          }
        } catch {
          // ignoramos mensajes no-JSON
        }
      });
      // Si la conexión falla, resolvemos con la lista que haya (vacía) para no colgar el menú.
      socket.addEventListener('error', settle);
    });
    return this.lobbyReady;
  }
}

/** Filtro de salas públicas en el cliente (el lobby empuja la lista completa). */
function matchesFilters(room: OnlineRoomSummary, filters: PublicRoomsFilters): boolean {
  if (filters.matchType && room.matchType !== filters.matchType) return false;
  if (filters.status && room.status !== filters.status) return false;
  if (filters.region && room.region.trim().toLowerCase() !== filters.region.trim().toLowerCase()) return false;
  if (filters.customPreset && room.customPreset !== filters.customPreset) return false;
  if (filters.minPlayers !== undefined && room.playerCount < filters.minPlayers) return false;
  if (filters.maxPlayers !== undefined && room.playerCount > filters.maxPlayers) return false;
  return true;
}

/**
 * Elige el transporte según `VITE_ONLINE_TRANSPORT`:
 *  - 'ws'  → PartyOnlineClient (WebSocket / PartyKit), host en VITE_PARTYKIT_HOST.
 *  - otro  → OnlineClient (HTTP sobre /api/rooms en Vercel), el de siempre.
 */
export function createOnlineClient(): OnlineClientApi {
  const env = import.meta.env;
  if (env?.VITE_ONLINE_TRANSPORT === 'ws') {
    const host = env.VITE_PARTYKIT_HOST ?? '127.0.0.1:1999';
    return new PartyOnlineClient(host);
  }
  return new OnlineClient();
}
