/**
 * Audio posicional — convierte la posición EN PANTALLA de la fuente de un sonido en
 * un paneo estéreo [-1, 1] que se pasa a las capas de audio (SoundEngine / JuiceAudio
 * → NeoSynth). La idea: lo que pasa a la izquierda de la pantalla suena a la izquierda,
 * lo de la derecha a la derecha.
 *
 *   · Tu tablero (y el tablero enfocado como espectador) se dibuja CENTRADO en el
 *     canvas, así que su paneo es leve y sigue la columna de la pieza activa.
 *   · Los tableros rivales son mini-tableros DOM en una grilla lateral; su paneo sale
 *     del centro de su rectángulo en pantalla (panForPlayerBoard).
 *
 * El interruptor global (setPositionalAudio) lo controla el ajuste "Audio posicional":
 * apagado, todos los helpers devuelven 0 (mezcla mono centrada de siempre).
 */

// No paneamos a tope duro (±1): dejaría un canal casi mudo y se siente antinatural.
// Acotamos a ±0.9 para conservar algo de presencia en ambos oídos.
const MAX_PAN = 0.9;

let enabled = true;

export function setPositionalAudio(on: boolean): void {
  enabled = on;
}

export function isPositionalAudio(): boolean {
  return enabled;
}

/** Mapea una coordenada X de pantalla (px) a paneo estéreo. 0 si está desactivado o
 * no hay viewport. Centro de pantalla → 0; borde izquierdo → -MAX_PAN; derecho → +MAX_PAN. */
export function panForScreenX(x: number, viewportWidth = viewport()): number {
  if (!enabled || !Number.isFinite(x) || viewportWidth <= 0) return 0;
  const half = viewportWidth / 2;
  return clampPan(((x - half) / half) * MAX_PAN);
}

/** Paneo hacia el mini-tablero DOM de un rival (sección con data-player-id). Devuelve
 * 0 si está desactivado, no existe en el DOM o aún no tiene tamaño. */
export function panForPlayerBoard(playerId: string): number {
  if (!enabled || typeof document === 'undefined') return 0;
  const el = document.querySelector(`[data-player-id="${cssEscape(playerId)}"]`);
  if (!el) return 0;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return panForScreenX(rect.left + rect.width / 2);
}

function viewport(): number {
  return typeof window === 'undefined' ? 0 : window.innerWidth;
}

function clampPan(pan: number): number {
  return Math.min(MAX_PAN, Math.max(-MAX_PAN, pan));
}

function cssEscape(value: string): string {
  const css = typeof CSS !== 'undefined' ? CSS : undefined;
  if (css && typeof css.escape === 'function') return css.escape(value);
  // Fallback minimal para entornos sin CSS.escape (escapa comillas y backslash).
  return value.replace(/["\\]/g, '\\$&');
}
