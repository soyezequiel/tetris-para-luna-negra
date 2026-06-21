// Estado del botón "Reportar" de la pantalla de resultados (comentario + estado del
// botón mientras manda el reporte al webhook de Discord). Objeto mutable fuera de
// main.ts, igual que el resto de PR7.

export interface ReportState {
  comment: string;
  buttonState: 'idle' | 'sending' | 'sent' | 'error';
}

export const reportState: ReportState = {
  comment: '',
  buttonState: 'idle',
};
