// Fuente única de los íconos SVG inline de la UI.
//
// Antes cada ícono se escribía a mano en cada call site de `main.ts`: el play
// aparecía 5 veces, el engranaje 2 (una variante quedó mal formada), el home 2 y
// había dos relojes de "historial" distintos. Centralizarlos acá evita esa
// divergencia: un glifo = una definición. Las funciones devuelven el SVG como
// string porque las vistas se rinden por template-strings.
//
// Convención: todos los glifos base usan viewBox 0 0 24 24. `svgWrap` arma el
// contenedor preservando el orden de atributos que ya usaban los call sites
// (viewBox · width · height · fill · aria) para no cambiar el render.

// Mismas modalidades que el `PlayMode` de main.ts (unión estructuralmente
// idéntica, por eso es asignable). Se declara acá para no acoplar el módulo de
// íconos al shell; cuando PlayMode se extraiga a su propio módulo, importarlo.
type IconPlayMode = 'survival' | 'custom' | 'local1v1';

export interface IconOptions {
  /** Lado del SVG en px (width = height). Default 24. */
  size?: number;
  /** Color de relleno. `false` omite el atributo (lo controla el CSS, como la sidebar). */
  fill?: string | false;
  /** Agrega aria-hidden="true" cuando el ícono es decorativo. */
  ariaHidden?: boolean;
}

function svgWrap(inner: string, { size = 24, fill = 'currentColor', ariaHidden = false }: IconOptions = {}): string {
  const fillAttr = fill === false ? '' : ` fill="${fill}"`;
  const aria = ariaHidden ? ' aria-hidden="true"' : '';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"${fillAttr}${aria}>${inner}</svg>`;
}

// ─── Glifos de relleno (fill) ────────────────────────────────────────────────

export function homeIcon(opts?: IconOptions): string {
  return svgWrap('<path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>', opts);
}

export function playIcon(opts?: IconOptions): string {
  return svgWrap('<path d="M8 5v14l11-7z"/>', opts);
}

// Engranaje Material "settings" (bien formado y simétrico). Único engranaje de
// relleno: úsalo para Ajustes en cualquier nav.
export function settingsGearIcon(opts?: IconOptions): string {
  return svgWrap('<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>', opts);
}

// Reloj con manecilla ("historial"). Glifo único: antes la sidebar y la nav móvil
// usaban dos paths distintos para el mismo concepto.
export function historyClockIcon(opts?: IconOptions): string {
  return svgWrap('<path d="M13 3a9 9 0 1 0 8.49 12h-2.13A7 7 0 1 1 13 5a7 7 0 0 1 6.32 4H22A9 9 0 0 0 13 3zm-1 5v5l4.25 2.52.75-1.23-3.5-2.04V8z"/>', opts);
}

// Flecha de importar (subir archivo).
export function importIcon(opts?: IconOptions): string {
  return svgWrap('<path d="M5 20h14v-2H5v2zM12 2L6 8h4v6h4V8h4l-6-6z"/>', opts);
}

// Escudo macizo (rol/host).
export function shieldSolidIcon(opts?: IconOptions): string {
  return svgWrap('<path d="M12 2l9 5v6c0 5-3.6 8.7-9 9-5.4-.3-9-4-9-9V7l9-5z"/>', opts);
}

// Escudo con recorte interior (propósito de sala).
export function shieldCrestIcon(opts?: IconOptions): string {
  return svgWrap('<path d="M12 2l9 5v6c0 5-3.6 8.7-9 9-5.4-.3-9-4-9-9V7l9-5zm0 4.2L6 9.5V13c0 3.1 2.1 5.4 6 5.8 3.9-.4 6-2.7 6-5.8V9.5l-6-3.3z"/>', opts);
}

// Cohete (estado "empezar partida" del smart-play stage).
export function rocketIcon(opts?: IconOptions): string {
  return svgWrap('<path d="M12 2c3.5 2 5.5 5.5 5.5 9.5 0 1.6-.3 2.9-.8 4l-1.7-1V12a3 3 0 1 0-6 0v2.5l-1.7 1c-.5-1.1-.8-2.4-.8-4C6.5 7.5 8.5 4 12 2zm-1 10a1 1 0 1 1 2 0v6l-1 2-1-2v-6z"/>', { size: 30, ...opts });
}

// ─── Glifos de trazo (stroke) ────────────────────────────────────────────────

// Tilde de "listo" (smart-play stage del invitado).
export function checkIcon({ size = 30 }: Pick<IconOptions, 'size'> = {}): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>`;
}

// Engranaje de trazo del botón relax (HUD), distinto del settings macizo.
export function gearOutlineIcon({ size = 20 }: Pick<IconOptions, 'size'> = {}): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
}

// Parlante (mute on/off), de trazo. `muted` cruza el ícono.
export function speakerIcon(muted: boolean): string {
  const extra = muted
    ? '<line x1="16" y1="9.5" x2="21" y2="14.5"></line><line x1="21" y1="9.5" x2="16" y2="14.5"></line>'
    : '<path d="M15.5 9.2a3.6 3.6 0 0 1 0 5.6"></path><path d="M18 7a6.8 6.8 0 0 1 0 10"></path>';
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 9.5h3L11 6v12l-4.5-3.5h-3z"></path>${extra}</svg>`;
}

// ─── Compuestos ──────────────────────────────────────────────────────────────

// Ícono de tetrominó por modalidad, con el color del acento. Mantiene la forma
// distinta por modo (Supervivencia = vertical, Custom = fila, Duelo = dos pares).
export function tetrominoIcon(mode: IconPlayMode, accent: string, size = 28): string {
  if (mode === 'custom') {
    return `<svg width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true"><rect x="2" y="3" width="11" height="11" rx="2" fill="${accent}"/><rect x="14.5" y="3" width="11" height="11" rx="2" fill="${accent}"/><rect x="27" y="3" width="11" height="11" rx="2" fill="${accent}"/><rect x="14.5" y="15.5" width="11" height="11" rx="2" fill="${accent}" opacity="0.6"/></svg>`;
  }
  if (mode === 'local1v1') {
    return `<svg width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true"><rect x="18" y="3" width="10" height="10" rx="2" fill="${accent}"/><rect x="28" y="3" width="10" height="10" rx="2" fill="${accent}"/><rect x="6" y="22" width="10" height="10" rx="2" fill="${accent}" opacity="0.7"/><rect x="16" y="22" width="10" height="10" rx="2" fill="${accent}" opacity="0.7"/></svg>`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true"><rect x="14" y="2" width="12" height="11" rx="2" fill="${accent}"/><rect x="14" y="14.5" width="12" height="11" rx="2" fill="${accent}" opacity="0.78"/><rect x="14" y="27" width="12" height="11" rx="2" fill="${accent}" opacity="0.5"/></svg>`;
}
