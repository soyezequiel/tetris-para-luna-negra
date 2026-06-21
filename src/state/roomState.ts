// Estado de la SALA online: la sala en la que estoy (`current`) y la lista de salas
// públicas para unirse (`publicRooms`). Es el núcleo del clúster online-net y el
// estado online más leído de toda la app —incluidas las vistas pesadas del dashboard
// (room panel, smart-play), que es justo lo que PR7 busca poder pasarles por
// parámetro. Objeto mutable fuera de main.ts, igual que el resto de PR7.
import type { OnlineRoom, OnlineRoomSummary } from '../online/protocol';

export interface RoomState {
  // Sala en la que estoy actualmente, o null si no estoy en ninguna.
  current: OnlineRoom | null;
  // Salas públicas listadas para unirse (refrescadas por el poll del lobby).
  publicRooms: OnlineRoomSummary[];
}

export const roomState: RoomState = {
  current: null,
  publicRooms: [],
};
