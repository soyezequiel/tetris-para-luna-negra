// Contadores de tiempo de CPU por sección de dibujo, para el bench (?bench=1).
//
// El FPS medido por rAF no sirve para comparar navegadores: queda clavado al vsync del
// monitor donde cayó la ventana (75/144/180Hz) y ese dato tapa la diferencia real. Lo que
// sí compara es cuántos MILISEGUNDOS de main thread cuesta cada sección por frame.
//
// Coste cuando está apagado: una comparación booleana por llamada. Se enciende solo con
// ?bench=1 (installBenchMode llama a enableBenchCounters).

interface Counter { calls: number; totalMs: number; }

// Se decide al cargar el módulo, no en installBenchMode: el renderer se construye antes de
// que main.ts llegue a instalar el bench, y necesitamos cronometrarlo desde el primer frame.
const on = ((): boolean => {
  try { return new URLSearchParams(window.location.search).get('bench') === '1'; } catch { return false; }
})();
const counters = new Map<string, Counter>();

export function benchCountersOn(): boolean { return on; }

// Cronometra `fn` bajo `label`. Devuelve lo que devuelva `fn`.
export function benchTime<T>(label: string, fn: () => T): T {
  if (!on) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    let c = counters.get(label);
    if (!c) { c = { calls: 0, totalMs: 0 }; counters.set(label, c); }
    c.calls += 1;
    c.totalMs += performance.now() - t0;
  }
}

// Media de ms por llamada y llamadas/segundo, sobre la ventana desde el último reset.
export function benchSnapshot(elapsedMs: number): { label: string; avgMs: number; perSec: number; msPerSec: number }[] {
  const secs = Math.max(0.001, elapsedMs / 1000);
  return [...counters.entries()]
    .map(([label, c]) => ({
      label,
      avgMs: c.totalMs / Math.max(1, c.calls),
      perSec: c.calls / secs,
      msPerSec: c.totalMs / secs,
    }))
    .sort((a, b) => b.msPerSec - a.msPerSec);
}

export function benchReset(): void { counters.clear(); }
