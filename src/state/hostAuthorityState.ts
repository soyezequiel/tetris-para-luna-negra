// Estado de la AUTORIDAD DE HOST en batallas online: el host rutea ataques y, si el
// server le migra la autoridad a mitad de ronda (host original caído), simula en modo
// degradado. Sub-dominio más enredado del clúster online-net (lleva Sets/Maps de
// bookkeeping por jugador). Objeto mutable fuera de main.ts, igual que el resto de PR7.
import type { HostAuthoritySimulator } from '../online/hostAuthority';

export interface HostAuthorityState {
  // Simulador de autoridad activo, o null si no soy host autoritativo.
  simulator: HostAuthoritySimulator | null;
  // true cuando el server me migró la autoridad a mitad de ronda (host original
  // desconectado). Corro como host en "modo degradado": ver ensureMigratedHostAuthority().
  migrated: boolean;
  // Bookkeeping por jugador mientras soy host autoritativo.
  progressInFlight: Set<string>;
  lastProgressAt: Map<string, number>;
  committedEliminations: Set<string>;
  committedResults: Set<string>;
  lastAuthoritativeFrame: number;
  lastSimLogAt: Map<string, number>;
}

export const hostAuthorityState: HostAuthorityState = {
  simulator: null,
  migrated: false,
  progressInFlight: new Set<string>(),
  lastProgressAt: new Map<string, number>(),
  committedEliminations: new Set<string>(),
  committedResults: new Set<string>(),
  lastAuthoritativeFrame: 0,
  lastSimLogAt: new Map<string, number>(),
};
