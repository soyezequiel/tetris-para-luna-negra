import type * as Party from 'partykit/server';
import { getRoomState, HOST_STALE_MS, MemoryRoomStore, OnlineRoomError } from '../src/online/roomService.js';
import {
  dispatchRoomAction,
  lobbyUpdateForRoom,
  lobbyUpdateKey,
  type LobbyUpdate,
  type RoomClientMessage,
  type RoomReplyMessage,
  type RoomStateMessage,
} from '../src/online/roomDispatch.js';
import { LOBBY_PARTY_ID } from './lobby.js';
import type { OnlineRoom } from '../src/online/protocol.js';

/** Clave del storage durable del Party donde vive la sala (sobrevive hibernación). */
const ROOM_STORAGE_KEY = 'room';

/**
 * Clave donde persistimos el id de la sala. `onAlarm` NO puede leer `Party.id`
 * (limitación conocida de PartyKit), así que lo guardamos mientras la sala vive.
 */
const ROOM_ID_STORAGE_KEY = 'roomId';

/**
 * Instante (ms) en que la sala debe limpiarse del storage local si nadie reconecta.
 * Lo setea `onClose` al caer la última conexión; `onConnect` lo borra. El alarm
 * unificado lo toma como una de sus fechas tope. Ver más abajo.
 */
const ABANDON_AT_STORAGE_KEY = 'abandonAt';

/**
 * Gracia antes de dar una sala por abandonada cuando se cae la última conexión.
 * Cubre reconexiones transitorias de PartySocket (un blip de red cierra y reabre
 * el socket). Override con la var PARTY_ABANDON_GRACE_MS (tests/dev).
 */
const DEFAULT_ABANDON_GRACE_MS = 15_000;

/**
 * Un Party = una sala. El estado vive en RAM (MemoryRoomStore) y los mensajes se
 * procesan en serie, así que la lógica de `roomService` corre sin el CAS ni los
 * reintentos por versión del camino HTTP. Ver [[online-client-authoritative]].
 *
 * - El cliente conecta al Party cuyo nombre es el código de sala (ej. "ABCD").
 * - Cada mensaje {action,payload} se despacha y se responde al emisor (reqId).
 * - Tras una mutación se EMPUJA el room a todas las conexiones: adiós al polling.
 *
 * Presencia por ciclo de conexión: cuando cae la última conexión se programa un
 * alarm; si tras la gracia sigue sin conexiones, la sala está abandonada → se
 * borra y se quita del lobby. El alarm persiste aunque el Party hiberne, así una
 * sala "fantasma" (todos cerraron la pestaña) se limpia sin que nadie pollee.
 *
 * Timers autoritativos: el MISMO alarm corre las transiciones temporales de la
 * ronda (countdown→playing al llegar `startsAtServerMs`, host failover tras
 * HOST_STALE_MS) llamando a `getRoomState` —idéntico a un poll— y empujando el
 * resultado. Así la ronda arranca a tiempo y se recupera de un host caído sin
 * depender de que un cliente pollee justo. El alarm es ÚNICO: `rescheduleAlarm`
 * lo fija a la fecha tope más próxima entre {abandono, countdown, failover}.
 */
export default class RoomServer implements Party.Server {
  private readonly store = new MemoryRoomStore();
  /** Última clave enviada al lobby; dedup para no reavisar lo mismo (ej. cada ataque en 'playing'). */
  private lastLobbyKey: string | null = null;

  constructor(readonly room: Party.Room) {}

  /**
   * Rehidrata la sala desde el storage durable al (re)arrancar la instancia. El
   * Party hiberna sin conexiones y pierde la RAM; sin esto, una reconexión tras un
   * blip total caería en una sala vacía. Reseteamos la versión porque el CAS del
   * MemoryRoomStore es irrelevante acá (un solo escritor en serie).
   */
  async onStart(): Promise<void> {
    const stored = await this.room.storage.get<OnlineRoom>(ROOM_STORAGE_KEY);
    if (!stored) return;
    stored.version = 0;
    await this.store.saveRoom(stored);
  }

  async onConnect(connection: Party.Connection): Promise<void> {
    // Alguien (re)conectó: cancelamos la limpieza local pendiente y, si el lobby
    // tenía armada la remoción de esta sala, la desarmamos (acá sí hay cross-party).
    // OJO: no usamos deleteAlarm() acá — borraría un alarm de countdown/failover si
    // alguien reconecta a mitad de ronda; rescheduleAlarm lo re-fija correctamente.
    await this.room.storage.delete(ABANDON_AT_STORAGE_KEY);
    await this.room.storage.put(ROOM_ID_STORAGE_KEY, this.room.id);
    await this.postToLobby({ op: 'cancel-removal', roomId: this.room.id });
    const room = await this.store.getRoom(this.room.id);
    if (room) {
      const message: RoomStateMessage = { type: 'room', room, serverNowMs: Date.now() };
      connection.send(JSON.stringify(message));
    }
    await this.rescheduleAlarm(this.room.id);
  }

  async onClose(connection: Party.Connection): Promise<void> {
    const remaining = [...this.room.getConnections()].filter((c) => c.id !== connection.id).length;
    if (remaining > 0) return;
    // Cayó la última conexión. Dos limpiezas con la misma gracia:
    //  1) marcamos abandonAt → el alarm unificado borra el storage local (anti-fantasma);
    //  2) el LOBBY arma la remoción de su lista — el alarm de la RoomParty no puede
    //     avisarle (sin context.parties), así que la gracia del listado vive allá.
    const grace = this.abandonGraceMs();
    await this.room.storage.put(ROOM_ID_STORAGE_KEY, this.room.id);
    await this.room.storage.put(ABANDON_AT_STORAGE_KEY, Date.now() + grace);
    await this.postToLobby({ op: 'arm-removal', roomId: this.room.id, graceMs: grace });
    await this.rescheduleAlarm(this.room.id);
  }

  /**
   * Alarm unificado. Según la fecha que venció:
   *  - Sin conexiones y vencida la gracia → la sala está abandonada: se borra su
   *    storage local (el listado lo limpia el LobbyParty por su lado, porque acá
   *    no hay acceso a `context.parties` ni a `id`).
   *  - Con conexiones → tick autoritativo: aplica las transiciones temporales
   *    (countdown→playing, host failover) vía `getRoomState` y empuja el resultado.
   */
  async onAlarm(): Promise<void> {
    const roomId = await this.room.storage.get<string>(ROOM_ID_STORAGE_KEY);
    if (!roomId) {
      await this.room.storage.deleteAlarm();
      return;
    }

    if ([...this.room.getConnections()].length === 0) {
      const abandonAt = await this.room.storage.get<number>(ABANDON_AT_STORAGE_KEY);
      if (abandonAt != null && Date.now() >= abandonAt) {
        await this.clearRoomStorage(roomId);
        return; // sala abandonada eliminada; nada que empujar
      }
      // Sin nadie conectado pero aún en gracia: re-programamos para cuando venza.
      await this.rescheduleAlarm(roomId);
      return;
    }

    try {
      const room = await getRoomState(this.store, roomId, Date.now());
      await this.persistAndBroadcastRoom(room, Date.now());
    } catch (error) {
      if (error instanceof OnlineRoomError && error.status === 404) {
        // getRoomState la dio por abandonada (sin presencia) y la quitó del store.
        await this.clearRoomStorage(roomId);
        return;
      }
      throw error;
    }
    await this.rescheduleAlarm(roomId);
  }

  async onMessage(raw: string, sender: Party.Connection): Promise<void> {
    let message: RoomClientMessage;
    try {
      message = JSON.parse(raw) as RoomClientMessage;
    } catch {
      return;
    }

    try {
      const result = await dispatchRoomAction(this.store, this.room.id, message.action, message.payload);
      this.reply(sender, { type: 'reply', reqId: message.reqId, ok: true, ...result });
      if (result.room) {
        await this.persistAndBroadcastRoom(result.room, result.serverNowMs);
      } else {
        await this.room.storage.delete(ROOM_STORAGE_KEY);
        await this.room.storage.delete(ROOM_ID_STORAGE_KEY);
      }
      await this.syncLobby(result.room);
      // Una mutación pudo abrir/mover una fecha tope (start → countdown, progress
      // del host → corre la ventana de failover): re-fijamos el alarm unificado.
      await this.rescheduleAlarm(this.room.id);
    } catch (error) {
      const status = error instanceof OnlineRoomError ? error.status : 500;
      const text = error instanceof Error ? error.message : 'Unexpected server error.';
      this.reply(sender, { type: 'reply', reqId: message.reqId, ok: false, status, error: text, serverNowMs: Date.now() });
    }
  }

  private reply(connection: Party.Connection, message: RoomReplyMessage): void {
    connection.send(JSON.stringify(message));
  }

  private abandonGraceMs(): number {
    return Number(this.room.env.PARTY_ABANDON_GRACE_MS) || DEFAULT_ABANDON_GRACE_MS;
  }

  /** Empuja el room a todas las conexiones y lo persiste (sobrevive hibernación). */
  private async persistAndBroadcastRoom(room: OnlineRoom, serverNowMs: number): Promise<void> {
    const broadcast: RoomStateMessage = { type: 'room', room, serverNowMs };
    this.room.broadcast(JSON.stringify(broadcast));
    await this.room.storage.put(ROOM_STORAGE_KEY, room);
    await this.room.storage.put(ROOM_ID_STORAGE_KEY, room.id);
  }

  /** Borra todo rastro local de la sala (abandono / 404). El alarm queda sin fecha. */
  private async clearRoomStorage(roomId: string): Promise<void> {
    await this.store.deleteRoom(roomId);
    await this.room.storage.delete(ROOM_STORAGE_KEY);
    await this.room.storage.delete(ROOM_ID_STORAGE_KEY);
    await this.room.storage.delete(ABANDON_AT_STORAGE_KEY);
    await this.room.storage.deleteAlarm();
  }

  /**
   * Fecha tope más próxima del alarm unificado, o null si no hay nada que esperar:
   *  - abandono: el `abandonAt` guardado (sala sin conexiones en gracia);
   *  - countdown→playing: `startsAtServerMs`;
   *  - host failover: `updatedAtServerMs + HOST_STALE_MS` (+1 para superar el `<=`
   *    de applyHostFailover). Mientras el host escribe, esta fecha se corre sola y
   *    el tick nunca dispara failover; si se queda mudo, vence y el tick lo migra.
   */
  private async nextDeadlineMs(roomId: string): Promise<number | null> {
    const deadlines: number[] = [];
    const abandonAt = await this.room.storage.get<number>(ABANDON_AT_STORAGE_KEY);
    if (abandonAt != null) deadlines.push(abandonAt);
    const room = await this.store.getRoom(roomId);
    if (room) {
      if (room.status === 'countdown' && room.startsAtServerMs != null) deadlines.push(room.startsAtServerMs);
      if (room.status === 'countdown' || room.status === 'playing') deadlines.push(room.updatedAtServerMs + HOST_STALE_MS + 1);
    }
    return deadlines.length ? Math.min(...deadlines) : null;
  }

  /** Fija el alarm único a la próxima fecha tope (o lo borra si no hay ninguna). */
  private async rescheduleAlarm(roomId: string): Promise<void> {
    const next = await this.nextDeadlineMs(roomId);
    if (next == null) await this.room.storage.deleteAlarm();
    else await this.room.storage.setAlarm(Math.max(next, Date.now() + 1));
  }

  /** Avisa al LobbyParty del estado listable de esta sala (con dedup). */
  private async syncLobby(room: Awaited<ReturnType<typeof dispatchRoomAction>>['room']): Promise<void> {
    const update = lobbyUpdateForRoom(this.room.id, room);
    const key = lobbyUpdateKey(update);
    if (key === this.lastLobbyKey) return;
    this.lastLobbyKey = key;
    await this.postToLobby(update);
  }

  /** POST best-effort al LobbyParty (fetch entre parties). Sin dedup: lo hace syncLobby. */
  private async postToLobby(update: LobbyUpdate): Promise<void> {
    try {
      await this.room.context.parties.lobby.get(LOBBY_PARTY_ID).fetch({
        method: 'POST',
        body: JSON.stringify(update),
      });
    } catch {
      // El lobby es best-effort: si el aviso falla, la sala sigue jugable.
      this.lastLobbyKey = null;
    }
  }
}

RoomServer satisfies Party.Worker;
