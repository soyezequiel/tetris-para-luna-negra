// Estado de los visores de repetición. Dos sub-dominios relacionados:
//  - replayState: visor de UNA partida (appMode 'replayPlayback').
//  - multiReplayState: visor multi-tablero tipo tetr.io (appMode 'onlineReplay').
// Objetos mutables fuera de main.ts, igual que el resto de PR7.
import type { ReplayPlayback } from '../app/replayPlayback';
import type { MultiReplayPlayback } from '../app/multiReplayPlayback';
import type { AppMode } from '../app/state';

export interface ReplayState {
  // Reproducción activa, o null fuera del visor.
  playback: ReplayPlayback | null;
  // Reloj del visor: el motor avanza a 60fps anclado al tiempo real (NO una vez por
  // rAF), si no en monitores >60Hz la repetición corre acelerada. Contamos los frames
  // de 60Hz transcurridos y llamamos tick() esa cantidad de veces.
  clockOriginMs: number;
  framesAdvanced: number;
  // A dónde volver al salir. null = al menú (replays importados/del historial); lo
  // setea la repetición de "últimos 5s" para volver a la pantalla de resultados.
  returnMode: AppMode | null;
  importedName: string | null;
  importError: string | null;
}

// Referencias persistentes a cada tarjeta/canvas del visor multi-tablero.
export interface MultiReplayCard {
  playerId: string;
  card: HTMLElement;
  canvas: HTMLCanvasElement;
  tag: HTMLElement;
  stat: HTMLElement;
}

export interface MultiReplayState {
  // Mi log se difunde una sola vez por ronda, al terminar mi partida.
  broadcast: boolean;
  // Visor multi-tablero activo (appMode 'onlineReplay'), o null fuera del visor.
  playback: MultiReplayPlayback | null;
  // Mientras miro una repetición dentro de una sala me marco NO listo para que el host
  // no arranque sin mí; el poll re-afirma el no-listo si el reopen me readyea.
  holdNotReady: boolean;
  // Sala desde la que se abrió el visor, para poder volver a los resultados.
  returnRoomId: string | null;
  // Tarjetas/canvas del visor (creadas al abrir).
  cards: MultiReplayCard[];
}

export const replayState: ReplayState = {
  playback: null,
  clockOriginMs: performance.now(),
  framesAdvanced: 0,
  returnMode: null,
  importedName: null,
  importError: null,
};

export const multiReplayState: MultiReplayState = {
  broadcast: false,
  playback: null,
  holdNotReady: false,
  returnRoomId: null,
  cards: [],
};
