// Identidad del jugador online (perfil persistido + nombre editable + código de sala
// que escribe para unirse). Sub-dominio del clúster online-net. Objeto mutable fuera
// de main.ts, igual que el resto de PR7.
import { loadOnlinePlayer, type LocalOnlinePlayer } from '../online/playerIdentity';

const initialPlayer = loadOnlinePlayer();

export interface IdentityState {
  // Perfil persistido (npub/id + nombre); se re-guarda con saveOnlinePlayer al editar.
  player: LocalOnlinePlayer;
  // Nombre en edición (puede diferir de player.name hasta que se guarda).
  name: string;
  // Código que el jugador escribe para unirse a una sala por invitación.
  joinCode: string;
}

export const identityState: IdentityState = {
  player: initialPlayer,
  name: initialPlayer.name,
  joinCode: '',
};
