import { Server, type Connection } from 'partyserver';
import type { OnlineRoomSummary } from '../src/online/protocol.js';
import type { LobbyRoomsMessage, LobbyUpdate } from '../src/online/roomDispatch.js';
import type { Env } from './env.js';

export { LOBBY_PARTY_ID } from '../src/online/roomDispatch.js';

/** Claves del storage durable del lobby (sobreviven hibernación). */
const ROOMS_STORAGE_KEY = 'rooms';
const PENDING_STORAGE_KEY = 'pending';

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
  }

  onConnect(connection: Connection): void {
    connection.send(this.roomsMessage());
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
        await this.persistAndBroadcast();
        break;
      case 'remove':
        this.rooms.delete(update.roomId);
        this.pendingRemoval.delete(update.roomId);
        await this.persistAndBroadcast();
        break;
      case 'arm-removal':
        // Cayó la última conexión de la sala: la removemos tras la gracia.
        this.pendingRemoval.set(update.roomId, Date.now() + update.graceMs);
        await this.persistPending();
        await this.rescheduleSweep();
        break;
      case 'cancel-removal':
        // Alguien reconectó dentro de la gracia: la sala se queda.
        if (this.pendingRemoval.delete(update.roomId)) {
          await this.persistPending();
          await this.rescheduleSweep();
        }
        break;
      default:
        return new Response('Bad request', { status: 400 });
    }

    return Response.json({ ok: true, count: this.rooms.size });
  }

  /** Barrido de la gracia: remueve del listado las salas cuya remoción venció. */
  async onAlarm(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [roomId, at] of this.pendingRemoval) {
      if (at > now) continue;
      this.pendingRemoval.delete(roomId);
      if (this.rooms.delete(roomId)) changed = true;
    }
    await this.persistPending();
    if (changed) await this.persistAndBroadcast();
    await this.rescheduleSweep();
  }

  /** Programa el alarm para la próxima remoción pendiente (o lo cancela si no hay). */
  private async rescheduleSweep(): Promise<void> {
    if (this.pendingRemoval.size === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = Math.min(...this.pendingRemoval.values());
    await this.ctx.storage.setAlarm(next);
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
