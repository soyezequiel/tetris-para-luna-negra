// Estado de la biblioteca de repeticiones del historial (filtro activo, entrada
// seleccionada, error de carga). Objeto mutable fuera de main.ts, igual que el resto
// de PR7. LIBRARY_FILTERS/LibraryFilter viven acá porque tipan el filtro.

export const LIBRARY_FILTERS = ['all', 'clear', 'topout', 'best'] as const;
export type LibraryFilter = typeof LIBRARY_FILTERS[number];

export interface LibraryState {
  filter: LibraryFilter;
  selectedHistoryEntryId: string | null;
  error: string | null;
}

export const libraryState: LibraryState = {
  filter: 'all',
  selectedHistoryEntryId: null,
  error: null,
};
