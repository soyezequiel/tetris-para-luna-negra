import { Server, getServerByName, type Connection } from 'partyserver';
import type { OnlineRoomSummary } from '../src/online/protocol.js';
import type { LobbyRoomsMessage, LobbyUpdate } from '../src/online/roomDispatch.js';
import type { Env } from './env.js';

export { LOBBY_PARTY_ID } from '../src/online/roomDispatch.js';

/** Claves del storage durable del lobby (sobreviven hibernación). */
const ROOMS_STORAGE_KEY = 'rooms';
const PENDING_STORAGE_KEY = 'pending';

/**
 * Cada cuánto el lobby re-verifica que sus salas listadas siguen vivas (RPC a cada
 * RoomParty). Mantiene el listado auto-sanado sin que nadie recargue: un menú
 * abierto recibe por push la lista corregida en el siguiente tick.
 */
const VERIFY_INTERVAL_MS = 10_000;

/**
 * Gracia antes de sacar del listado una sala que la verificación dio por muerta
 * (misma idea que el `arm-removal` de la RoomParty): cubre reconexiones
 * transitorias de PartySocket, así un blip de red no baja una sala viva.
 */
const VERIFY_REMOVAL_GRACE_MS = 15_000;

/**
 * Lobby singleton de salas públicas. Vive en RAM la lista de salas LISTABLES y la
 * empuja a los navegadores conectados (menú). Reemplaza el fan-out N+1 del camino
 * HTTP (1 GET de ids + 1 GET por sala cada 5s): acá no hay polling ni Redis.
 *
 * - Cada RoomParty avisa por `onRequest` (fetch entre DOs): upsert / remove.
 * - Los navegadores conectan y reciben la lista por push en cada cambio.
 *
 * Salas abandonadas (todos cerraron la pestaña): la RoomParty no puede avisar
 * `remove` desde su `onAlarm` (sin acceso a otros DO), así que arma la remoción
 * (`arm-removal`) al caer la última conexión y ESTE lobby corre la gracia con su
 * propio alarm —que solo toca su estado local—. Una reconexión la cancela.
 *
 * Red de seguridad (auto-sanado): el `arm-removal` es best-effort y `onClose`
 * puede no dispararse ante una caída sucia, así que una sala muerta podría quedar
 * pegada en el listado hasta recargar. Para evitarlo, mientras haya salas listadas
 * el alarm también corre una verificación periódica (`verifyRooms`): pregunta a
 * cada RoomParty si sigue viva y arma/cancela su remoción en consecuencia.
 */
export class LobbyServer extends Server<Env> {
  private readonly rooms = new Map<string, OnlineRoomSummary>();
  /** roomId → instante (ms) en que debe removerse del listado si nadie reconecta. */
  private readonly pendingRemoval = new Map<string, number>();

  async onStart(): Promise<void> {
    const storedRooms = await this.ctx.storage.get<Record<string, OnlineRoomSummary>>(ROOMS_STORAGE_KEY);
    if (storedRooms) for (const [id, summary] of Object.entries(storedRooms)) this.rooms.set(id, summary);
    const storedPending = await this.ctx.storage.get<Record<string, number>>(PENDING_STORAGE_KEY);
    if (storedPending) for (const [id, at] of Object.entries(storedPending)) this.pendingRemoval.set(id, at);
    // Si rehidratamos con salas, arrancamos el loop de verificación (el DO pudo
    // haber hibernado sin alarm armado).
    await this.rescheduleAlarm();
  }

  async onConnect(connection: Connection): Promise<void> {
    connection.send(this.roomsMessage());
    // Un navegador abrió el menú: garantizamos que la verificación esté corriendo
    // para que la lista que ve se mantenga sana sin recargar.
    await this.rescheduleAlarm();
  }

  async onRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    let update: LobbyUpdate;
    try {
      update = (await request.json()) as LobbyUpdate;
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    switch (update.op) {
      case 'upsert':
        // Una sala viva (la acaban de tocar): entra al listado y se desarma su remoción.
        this.rooms.set(update.summary.id, update.summary);
        this.pendingRemoval.delete(update.summary.id);
        await this.persistPending();
        await this.persistAndBroadcast();
        await this.rescheduleAlarm();
        break;
      case 'remove':
        this.rooms.delete(update.roomId);
        this.pendingRemoval.delete(update.roomId);
        await this.persistPending();
        await this.persistAndBroadcast();
        await this.rescheduleAlarm();
        break;
      case 'arm-removal':
        // Cayó la última conexión de la sala: la removemos tras la gracia.
        this.pendingRemoval.set(update.roomId, Date.now() + update.graceMs);
        await this.persistPending();
        await this.rescheduleAlarm();
        break;
      case 'cancel-removal':
        // Alguien reconectó dentro de la gracia: la sala se queda.
        if (this.pendingRemoval.delete(update.roomId)) {
          await this.persistPending();
          await this.rescheduleAlarm();
        }
        break;
      default:
        return new Response('Bad request', { status: 400 });
    }

    return Response.json({ ok: true, count: this.rooms.size });
  }

  /**
   * Tick del alarm unificado: primero re-verifica las salas vivas (auto-sanado),
   * después barre las remociones cuya gracia venció, y reprograma el próximo tick.
   */
  async onAlarm(): Promise<void> {
    await this.verifyRooms();
    const now = Date.now();
    let changed = false;
    for (const [roomId, at] of this.pendingRemoval) {
      if (at > now) continue;
      this.pendingRemoval.delete(roomId);
      if (this.rooms.delete(roomId)) changed = true;
    }
    await this.persistPending();
    if (changed) await this.persistAndBroadcast();
    await this.rescheduleAlarm();
  }

  /**
   * Pregunta a cada RoomParty si su sala sigue siendo listable-viva. Una sala
   * muerta se arma para removerse tras la gracia (no se baja al instante, para
   * tolerar blips); una que volvió a estar viva cancela su remoción pendiente.
   * Best-effort: si no se pudo consultar una sala, se la deja como estaba.
   */
  private async verifyRooms(): Promise<void> {
    if (this.rooms.size === 0) return;
    const now = Date.now();
    let pendingChanged = false;
    for (const roomId of [...this.rooms.keys()]) {
      let alive = true;
      try {
        const room = await getServerByName(this.env.Main, roomId);
        alive = await room.isListableAlive();
      } catch {
        // No pudimos verificar (RPC caído): la damos por viva y la reintentamos luego.
        continue;
      }
      if (alive) {
        if (this.pendingRemoval.delete(roomId)) pendingChanged = true;
      } else if (!this.pendingRemoval.has(roomId)) {
        // Muerta y sin remoción armada (perdimos el `arm-removal`, o el host cayó
        // sucio): la armamos con la gracia para que se caiga del listado.
        this.pendingRemoval.set(roomId, now + VERIFY_REMOVAL_GRACE_MS);
        pendingChanged = true;
      }
    }
    if (pendingChanged) await this.persistPending();
  }

  /**
   * Fija el alarm a la próxima fecha tope: la más próxima entre las remociones
   * pendientes y el siguiente tick de verificación (solo mientras haya salas
   * listadas). Sin salas ni pendientes, lo cancela.
   */
  private async rescheduleAlarm(): Promise<void> {
    const deadlines = [...this.pendingRemoval.values()];
    if (this.rooms.size > 0) deadlines.push(Date.now() + VERIFY_INTERVAL_MS);
    if (deadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Math.min(...deadlines), Date.now() + 1));
  }

  private async persistAndBroadcast(): Promise<void> {
    await this.ctx.storage.put(ROOMS_STORAGE_KEY, Object.fromEntries(this.rooms));
    this.broadcast(this.roomsMessage());
  }

  private async persistPending(): Promise<void> {
    await this.ctx.storage.put(PENDING_STORAGE_KEY, Object.fromEntries(this.pendingRemoval));
  }

  private roomsMessage(): string {
    const rooms = [...this.rooms.values()].sort((a, b) => b.createdAtServerMs - a.createdAtServerMs);
    const message: LobbyRoomsMessage = { type: 'rooms', rooms, serverNowMs: Date.now() };
    return JSON.stringify(message);
  }
}
