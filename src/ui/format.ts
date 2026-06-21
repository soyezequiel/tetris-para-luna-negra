// Helpers de formato compartidos por las vistas de la UI (dashboard, historial,
// resultados). Viven acá —y no en main.ts— para que los módulos de vista
// (src/ui/dashboard/*) los importen sin crear una dependencia circular con el
// shell. Son funciones puras: no leen estado de módulo.

/** Frames (60fps) → "m:ss.mmm" (o "m:ss" si showMillis=false). */
export function formatFrames(frames: number, showMillis = true): string {
  const seconds = frames / 60;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  if (!showMillis) return `${minutes}:${secs}`;
  const millis = Math.floor((seconds % 1) * 1000).toString().padStart(3, '0');
  return `${minutes}:${secs}.${millis}`;
}

/** Fecha ISO → etiqueta relativa en español ("hoy", "ayer", "hace N días"). */
export function formatHistoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (dayDiff <= 0) return 'hoy';
  if (dayDiff === 1) return 'ayer';
  if (dayDiff < 7) return `hace ${dayDiff} días`;
  return date.toLocaleDateString();
}

/** Escapa texto para interpolar seguro en los template-strings de las vistas. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
