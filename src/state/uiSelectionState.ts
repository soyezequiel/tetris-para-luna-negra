// Estado de SELECCIÓN de UI del dashboard que leen las vistas pesadas: qué modalidad
// está elegida en "Jugar" (decide qué arranca ▶ y el matchType al crear sala) y qué
// pestaña del config custom está activa. Objeto mutable fuera de main.ts; es justo el
// tipo de estado que PR7 encapsula para que las vistas de PR4 lo tomen por parámetro.
import type { PlayMode } from '../ui/playMode';
import type { CustomTab } from '../app/customSettings';

export interface UiSelectionState {
  // Modalidad elegida en "Jugar": 'survival' | 'custom' | 'local1v1' (default survival).
  playMode: PlayMode;
  // Pestaña activa del config custom ('game' por defecto).
  customTab: CustomTab;
}

export const uiSelectionState: UiSelectionState = {
  playMode: 'survival',
  customTab: 'game',
};
