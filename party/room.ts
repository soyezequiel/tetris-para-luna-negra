import { Server, getServerByName, type Connection, type WSMessage } from 'partyserver';
import { getRoomState, HOST_STALE_MS, MemoryRoomStore, normalizeRoomId, OnlineRoomError } from '../src/online/roomService.js';
import {
  dispatchRoomAction,
  lobbyUpdateForRoom,
  lobbyUpdateKey,
  LOBBY_PARTY_ID,
  type LobbyUpdate,
  type RoomClientMessage,
  type RoomReplyMessage,
  type RoomStateMessage,
} from '../src/online/roomDispatch.js';
import type { OnlineRoom } from '../src/online/protocol.js';
import type { Env } from './env.js';

/** Clave del storage durable del Party donde vive la sala (sobrevive hibernación). */
const ROOM_STORAGE_KEY = 'room';

/**
 * Clave donde persistimos el id de la sala. `onAlarm` NO puede leer la identidad
 * del Durable Object de forma fiable, así que lo guardamos mientras la sala vive.
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
 * Un Durable Object = una sala. El estado vive en RAM (MemoryRoomStore) y los
 * mensajes se procesan en serie, así que la lógica de `roomService` corre sin el
 * CAS ni los reintentos por versión del camino HTTP. Ver [[online-client-authoritative]].
 *
 * - El cliente conecta al DO cuyo nombre es el código de sala (ej. "ABCD"), vía
 *   `/parties/main/ABCD` (routePartykitRequest mapea el binding `Main`→`main`).
 * - Cada mensaje {action,payload} se despacha y se responde al emisor (reqId).
 * - Tras una mutación se EMPUJA el room a todas las conexiones: adiós al polling.
 *
 * Presencia por ciclo de conexión: cuando cae la última conexión se programa un
 * alarm; si tras la gracia sigue sin conexiones, la sala está abandonada → se
 * borra y se quita del lobby. El alarm persiste aunque el DO hiberne, así una
 * sala "fantasma" (todos cerraron la pestaña) se limpia sin que nadie pollee.
 *
 * Timers autoritativos: el MISMO alarm corre las transiciones temporales de la
 * ronda (countdown→playing al llegar `startsAtServerMs`, host failover tras
 * HOST_STALE_MS) llamando a `getRoomState` —idéntico a un poll— y empujando el
 * resultado. El alarm es ÚNICO: `rescheduleAlarm` lo fija a la fecha tope más
 * próxima entre {abandono, countdown, failover}.
 */
export class RoomServer extends Server<Env> {
  private readonly store = new MemoryRoomStore();
  /** Última clave enviada al lobby; dedup para no reavisar lo mismo (ej. cada ataque en 'playing'). */
  private lastLobbyKey: string | null = null;

  /**
   * Rehidrata la sala desde el storage durable al (re)arrancar la instancia. El
   * DO hiberna sin conexiones y pierde la RAM; sin esto, una reconexión tras un
   * blip total caería en una sala vacía. Reseteamos la versión porque el CAS del
   * MemoryRoomStore es irrelevante acá (un solo escritor en serie).
   */
  async onStart(): Promise<void> {
    const stored = await this.ctx.storage.get<OnlineRoom>(ROOM_STORAGE_KEY);
    if (!stored) return;
    stored.version = 0;
    await this.store.saveRoom(stored);
  }

  async onConnect(connection: Connection): Promise<void> {
    // Alguien (re)conectó: cancelamos la limpieza local pendiente y, si el lobby
    // tenía armada la remoción de esta sala, la desarmamos.
    // OJO: no usamos deleteAlarm() acá — borraría un alarm de countdown/failover si
    // alguien reconecta a mitad de ronda; rescheduleAlarm lo re-fija correctamente.
    await this.ctx.storage.delete(ABANDON_AT_STORAGE_KEY);
    await this.ctx.storage.put(ROOM_ID_STORAGE_KEY, this.name);
    await this.postToLobby({ op: 'cancel-removal', roomId: this.name });
    const room = await this.store.getRoom(this.name);
    if (room) {
      const message: RoomStateMessage = { type: 'room', room, serverNowMs: Date.now() };
      connection.send(JSON.stringify(message));
    }
    await this.rescheduleAlarm(this.name);
  }

  async onClose(connection: Connection): Promise<void> {
    const remaining = [...this.getConnections()].filter((c) => c.id !== connection.id).length;
    if (remaining > 0) return;
    // Cayó la última conexión. Dos limpiezas con la misma gracia:
    //  1) marcamos abandonAt → el alarm unificado borra el storage local (anti-fantasma);
    //  2) el LOBBY arma la remoción de su lista — el alarm de la RoomParty no puede
    //     avisarle (sin acceso a otros DO desde onAlarm), así que la gracia vive allá.
    const grace = this.abandonGraceMs();
    await this.ctx.storage.put(ROOM_ID_STORAGE_KEY, this.name);
    await this.ctx.storage.put(ABANDON_AT_STORAGE_KEY, Date.now() + grace);
    await this.postToLobby({ op: 'arm-removal', roomId: this.name, graceMs: grace });
    await this.rescheduleAlarm(this.name);
  }

  /**
   * Alarm unificado. Según la fecha que venció:
   *  - Sin conexiones y vencida la gracia → la sala está abandonada: se borra su
   *    storage local (el listado lo limpia el LobbyParty por su lado, porque acá
   *    no se puede hablar con otro DO ni leer la identidad de forma fiable).
   *  - Con conexiones → tick autoritativo: aplica las transiciones temporales
   *    (countdown→playing, host failover) vía `getRoomState` y empuja el resultado.
   */
  async onAlarm(): Promise<void> {
    const roomId = await this.ctx.storage.get<string>(ROOM_ID_STORAGE_KEY);
    if (!roomId) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    if ([...this.getConnections()].length === 0) {
      const abandonAt = await this.ctx.storage.get<number>(ABANDON_AT_STORAGE_KEY);
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

  /** Bridge server-to-server para que Vercel sincronice apuestas sobre la sala autoritativa. */
  async bridgeGetRoom(): Promise<OnlineRoom | null> {
    return this.store.getRoom(this.name);
  }

  /**
   * Reemplaza la sala con una copia leida previamente del mismo DO.
   * MemoryRoomStore valida la version, asi que una escritura vieja devuelve 409.
   */
  async bridgeSaveRoom(room: OnlineRoom): Promise<OnlineRoom> {
    const roomId = normalizeRoomId(room.id);
    const currentRoomId = normalizeRoomId(this.name);
    if (roomId !== currentRoomId) throw new OnlineRoomError('Room bridge id mismatch.', 400);
    // El DO es la ÚNICA autoridad de `updatedAtServerMs`: el resto de las escrituras
    // de sala (peer signals, ready, failover) lo sellan con el reloj de Cloudflare.
    // Las apuestas, en cambio, llegan vía Vercel selladas con OTRO reloj. Si dejáramos
    // ese timestamp ajeno, el guard monótono del cliente (adoptOnlineRoom) lo compararía
    // contra valores de Cloudflare y, ante el menor skew, descartaría la escritura por
    // verla "más vieja" → p. ej. cancelar la apuesta "no hacía nada". Re-sellamos con el
    // reloj del DO para que todos los timestamps de la sala vivan en un solo reloj.
    const nowMs = Date.now();
    const next: OnlineRoom = { ...room, id: currentRoomId, updatedAtServerMs: nowMs };
    await this.store.saveRoom(next);
    await this.persistAndBroadcastRoom(next, nowMs);
    await this.syncLobby(next);
    await this.rescheduleAlarm(currentRoomId);
    return next;
  }

  // ⚠️ partyserver invierte el orden respecto a PartyKit: (connection, message).
  async onMessage(sender: Connection, raw: WSMessage): Promise<void> {
    if (typeof raw !== 'string') return; // el cliente solo manda JSON de texto
    let message: RoomClientMessage;
    try {
      message = JSON.parse(raw) as RoomClientMessage;
    } catch {
      return;
    }

    try {
      const result = await dispatchRoomAction(this.store, this.name, message.action, message.payload);
      this.reply(sender, { type: 'reply', reqId: message.reqId, ok: true, ...result });
      if (result.room) {
        await this.persistAndBroadcastRoom(result.room, result.serverNowMs);
      } else {
        await this.ctx.storage.delete(ROOM_STORAGE_KEY);
        await this.ctx.storage.delete(ROOM_ID_STORAGE_KEY);
      }
      await this.syncLobby(result.room);
      // Una mutación pudo abrir/mover una fecha tope (start → countdown, progress
      // del host → corre la ventana de failover): re-fijamos el alarm unificado.
      await this.rescheduleAlarm(this.name);
    } catch (error) {
      const status = error instanceof OnlineRoomError ? error.status : 500;
      const text = error instanceof Error ? error.message : 'Unexpected server error.';
      this.reply(sender, { type: 'reply', reqId: message.reqId, ok: false, status, error: text, serverNowMs: Date.now() });
    }
  }

  private reply(connection: Connection, message: RoomReplyMessage): void {
    connection.send(JSON.stringify(message));
  }

  private abandonGraceMs(): number {
    return Number(this.env.PARTY_ABANDON_GRACE_MS) || DEFAULT_ABANDON_GRACE_MS;
  }

  /** Empuja el room a todas las conexiones y lo persiste (sobrevive hibernación). */
  private async persistAndBroadcastRoom(room: OnlineRoom, serverNowMs: number): Promise<void> {
    const broadcast: RoomStateMessage = { type: 'room', room, serverNowMs };
    this.broadcast(JSON.stringify(broadcast));
    await this.ctx.storage.put(ROOM_STORAGE_KEY, room);
    await this.ctx.storage.put(ROOM_ID_STORAGE_KEY, room.id);
  }

  /** Borra todo rastro local de la sala (abandono / 404). El alarm queda sin fecha. */
  private async clearRoomStorage(roomId: string): Promise<void> {
    await this.store.deleteRoom(roomId);
    await this.ctx.storage.delete(ROOM_STORAGE_KEY);
    await this.ctx.storage.delete(ROOM_ID_STORAGE_KEY);
    await this.ctx.storage.delete(ABANDON_AT_STORAGE_KEY);
    await this.ctx.storage.deleteAlarm();
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
    const abandonAt = await this.ctx.storage.get<number>(ABANDON_AT_STORAGE_KEY);
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
    if (next == null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1));
  }

  /** Avisa al LobbyParty del estado listable de esta sala (con dedup). */
  private async syncLobby(room: Awaited<ReturnType<typeof dispatchRoomAction>>['room']): Promise<void> {
    const update = lobbyUpdateForRoom(this.name, room);
    const key = lobbyUpdateKey(update);
    if (key === this.lastLobbyKey) return;
    this.lastLobbyKey = key;
    await this.postToLobby(update);
  }

  /** POST best-effort al LobbyParty (otro Durable Object). Sin dedup: lo hace syncLobby. */
  private async postToLobby(update: LobbyUpdate): Promise<void> {
    try {
      const lobby = await getServerByName(this.env.Lobby, LOBBY_PARTY_ID);
      await lobby.fetch(new Request('https://lobby/notify', { method: 'POST', body: JSON.stringify(update) }));
    } catch {
      // El lobby es best-effort: si el aviso falla, la sala sigue jugable.
      this.lastLobbyKey = null;
    }
  }
}
