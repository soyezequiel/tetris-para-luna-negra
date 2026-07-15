import {
  addAttack,
  addPeerSignal,
  createRoom,
  eliminatePlayer,
  getRoomState,
  joinOrCreateRoom,
  joinRoom,
  kickPlayer,
  leaveRoom,
  OnlineRoomError,
  reopenRoom,
  requestHostFailover,
  restartRoom,
  roomSummary,
  setPlayerReady,
  setPlayerTargeting,
  startRoom,
  submitResult,
  updateProgress,
  updateRoomSettings,
  type RoomStore,
} from './roomService.js';
import type {
  AttackRequest,
  CreateRoomRequest,
  EliminateRequest,
  JoinOrCreateRoomRequest,
  JoinRoomRequest,
  KickPlayerRequest,
  LeaveRoomRequest,
  OnlineRoom,
  OnlineRoomSummary,
  PeerSignalRequest,
  ProgressRequest,
  ReadyRequest,
  RequestHostFailoverRequest,
  RestartRoomRequest,
  ResultRequest,
  SetTargetingRequest,
  StartRoomRequest,
  UpdateRoomSettingsRequest,
} from './protocol.js';

/**
 * Transporte WebSocket (PartyKit): una sala = un Party. El Party corre este
 * dispatch contra un RoomStore en memoria y procesa los mensajes EN SERIE (un
 * solo isolate), así que NO hay concurrencia y NO hacen falta el CAS ni los
 * reintentos por conflicto de versión que sí necesita el camino HTTP/serverless.
 *
 * Toda acción está acotada a la sala del Party: forzamos `roomId = partyId` en el
 * payload, así un cliente nunca puede tocar otra sala a través de este socket.
 */

/** Acciones que un cliente puede pedirle al Party de una sala. */
export type RoomAction =
  | 'create'
  | 'join-or-create'
  | 'join'
  | 'leave'
  | 'kick'
  | 'ready'
  | 'start'
  | 'restart'
  | 'reopen'
  | 'settings'
  | 'targeting'
  | 'progress'
  | 'result'
  | 'attack'
  | 'eliminate'
  | 'failover'
  | 'signal'
  | 'state';

/** Mensaje cliente → Party. `reqId` permite emparejar la respuesta con el pedido. */
export interface RoomClientMessage {
  action: RoomAction;
  payload?: unknown;
  reqId?: string;
}

/** Respuesta directa al emisor de un mensaje (semántica pedido/respuesta). */
export interface RoomReplyMessage {
  type: 'reply';
  reqId?: string;
  ok: boolean;
  room?: OnlineRoom | null;
  hostMigratedTo?: string | null;
  serverNowMs: number;
  /** Solo en error. */
  error?: string;
  status?: number;
}

/** Estado de sala empujado a todas las conexiones tras una mutación. */
export interface RoomStateMessage {
  type: 'room';
  room: OnlineRoom;
  serverNowMs: number;
}

export interface RoomActionResult {
  room: OnlineRoom | null;
  hostMigratedTo?: string | null;
  serverNowMs: number;
}

/**
 * Ejecuta una acción de sala contra el store del Party. `partyId` es el id de la
 * sala (= nombre del Party); sobrescribe el `roomId` del payload para que el
 * socket solo pueda operar sobre su propia sala.
 */
export async function dispatchRoomAction(
  store: RoomStore,
  partyId: string,
  action: string,
  payload: unknown,
  nowMs: number = Date.now(),
): Promise<RoomActionResult> {
  const scoped = <T>(): T => ({ ...(asObject(payload)), roomId: partyId }) as T;
  const done = (room: OnlineRoom | null, hostMigratedTo?: string | null): RoomActionResult => ({
    room,
    serverNowMs: nowMs,
    ...(hostMigratedTo !== undefined ? { hostMigratedTo } : {}),
  });

  switch (action) {
    case 'create':
      return done(await createRoom(store, scoped<CreateRoomRequest>(), nowMs));
    case 'join-or-create':
      return done(await joinOrCreateRoom(store, scoped<JoinOrCreateRoomRequest>(), nowMs));
    case 'join':
      return done(await joinRoom(store, scoped<JoinRoomRequest>(), nowMs));
    case 'leave': {
      const { room, hostMigratedTo } = await leaveRoom(store, scoped<LeaveRoomRequest>(), nowMs);
      return done(room, hostMigratedTo);
    }
    case 'kick':
      return done(await kickPlayer(store, scoped<KickPlayerRequest>(), nowMs));
    case 'ready':
      return done(await setPlayerReady(store, scoped<ReadyRequest>(), nowMs));
    case 'start':
      return done(await startRoom(store, scoped<StartRoomRequest>(), nowMs));
    case 'restart':
      return done(await restartRoom(store, scoped<RestartRoomRequest>(), nowMs));
    case 'reopen':
      return done(await reopenRoom(store, scoped<RestartRoomRequest>(), nowMs));
    case 'settings':
      return done(await updateRoomSettings(store, scoped<UpdateRoomSettingsRequest>(), nowMs));
    case 'targeting':
      return done(await setPlayerTargeting(store, scoped<SetTargetingRequest>(), nowMs));
    case 'progress':
      return done(await updateProgress(store, scoped<ProgressRequest>(), nowMs));
    case 'result':
      return done(await submitResult(store, scoped<ResultRequest>(), nowMs));
    case 'attack':
      return done(await addAttack(store, scoped<AttackRequest>(), nowMs));
    case 'eliminate':
      return done(await eliminatePlayer(store, scoped<EliminateRequest>(), nowMs));
    case 'failover':
      return done(await requestHostFailover(store, scoped<RequestHostFailoverRequest>(), nowMs));
    case 'signal':
      return done(await addPeerSignal(store, scoped<PeerSignalRequest>(), nowMs));
    case 'state': {
      const presencePlayerId = readPlayerId(payload);
      return done(await getRoomState(store, partyId, nowMs, presencePlayerId));
    }
    default:
      throw new OnlineRoomError(`Unknown room action: ${action}`, 400);
  }
}

function asObject(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

// ───────────────────────── Lobby de salas públicas ─────────────────────────
// El LobbyParty (singleton) mantiene en RAM las salas LISTABLES y las empuja a
// los navegadores que están en el menú. Cada RoomParty le avisa tras una
// mutación: upsert si la sala sigue siendo listable, remove si dejó de serlo.

/** Id fijo de la única instancia del LobbyParty (un solo lobby global). */
export const LOBBY_PARTY_ID = 'index';

/** Nombre del party de salas (el default de PartyKit). */
export const ROOM_PARTY_NAME = 'main';

/** Nombre del party del lobby (debe coincidir con la clave en partykit.json). */
export const LOBBY_PARTY_NAME = 'lobby';

/**
 * Mensaje interno RoomParty → LobbyParty (vía fetch entre parties).
 *
 * `arm-removal`/`cancel-removal` existen porque el `onAlarm` de un Party NO puede
 * acceder a `context.parties` (ni a `id`): la RoomParty no puede avisarle al lobby
 * DESPUÉS de la gracia. Por eso la RoomParty arma la remoción al caer la última
 * conexión (en `onClose`, donde sí hay cross-party) y el LOBBY corre la gracia con
 * su propio alarm (que solo toca su estado local). La reconexión la cancela.
 */
export type LobbyUpdate =
  | { op: 'upsert'; summary: OnlineRoomSummary }
  | { op: 'remove'; roomId: string }
  | { op: 'arm-removal'; roomId: string; graceMs: number }
  | { op: 'cancel-removal'; roomId: string };

/** Lista de salas públicas empujada a los navegadores conectados al lobby. */
export interface LobbyRoomsMessage {
  type: 'rooms';
  rooms: OnlineRoomSummary[];
  serverNowMs: number;
}

/**
 * Una sala es listable en el lobby si es pública y está esperando jugadores
 * (lobby/countdown). En 'playing'/'finished' sale del listado. (La limpieza de
 * salas abandonadas —todos cerraron la pestaña— llega con la presencia por
 * conexión en la fase siguiente.)
 */
export function lobbyEntryForRoom(room: OnlineRoom | null): OnlineRoomSummary | null {
  if (!room || room.visibility !== 'public') return null;
  if (room.status !== 'lobby' && room.status !== 'countdown') return null;
  return roomSummary(room);
}

/** Update de lobby que corresponde a una sala (upsert si listable, remove si no). */
export function lobbyUpdateForRoom(roomId: string, room: OnlineRoom | null): LobbyUpdate {
  const summary = lobbyEntryForRoom(room);
  return summary ? { op: 'upsert', summary } : { op: 'remove', roomId };
}

/** Clave para deduplicar avisos al lobby: si no cambió, el RoomParty no reenvía. */
export function lobbyUpdateKey(update: LobbyUpdate): string {
  switch (update.op) {
    case 'upsert':
      return `upsert:${JSON.stringify(update.summary)}`;
    case 'remove':
      return `remove:${update.roomId}`;
    case 'arm-removal':
      return `arm:${update.roomId}:${update.graceMs}`;
    case 'cancel-removal':
      return `cancel:${update.roomId}`;
  }
}

function readPlayerId(payload: unknown): string | undefined {
  const value = asObject(payload).playerId;
  return typeof value === 'string' ? value : undefined;
}
