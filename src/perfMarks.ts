// Marcas de performance de trabajo que ocurre FUERA del loop()/rAF y que por eso el cronómetro
// por-frame no atribuye: el procesamiento de mensajes peer (WebRTC) y de las respuestas del poll
// de sala en el cliente —reconstruir tableros rivales, aplicar ataques, adoptar la sala— que
// llega en ráfagas y bloquea el main thread (los longtasks "self" que vimos en los reportes).
// Vive en su propio módulo para que peerBroadcast.ts (y main.ts) reporten sin acoplarse entre sí;
// main.ts lo vuelca en el reporte de performance.
//
// Dos vistas: (1) agregado por etiqueta de tarea (volumen total: cuántas veces y cuánto suman, así
// se ve la ráfaga aunque cada una sea barata) y (2) las tareas individuales LENTAS (≥ SLOW_MS),
// con su etiqueta y tamaño, para cazar el snapshot/poll pesado puntual.

export interface TaskStat {
  label: string;
  count: number;
  totalMs: number;
  maxMs: number;
  bytes: number;
}

export interface SlowMark {
  t: number;      // ms desde la carga de la página
  label: string;  // p. ej. "peer:snapshot" o "poll:process"
  ms: number;
  bytes: number;
}

const SLOW_MS = 12;       // una tarea que tarda esto bloquea casi un frame entero (16.6ms)
const SLOW_MARKS_MAX = 40;

const taskByLabel = new Map<string, TaskStat>();
const slowMarks: SlowMark[] = [];

// Registra una tarea sincrónica cronometrada, agrupada por `label`. `bytes` es opcional (tamaño
// del payload procesado, 0 si no aplica). Acota y guarda aparte las que pasan el umbral lento.
export function recordTask(label: string, ms: number, bytes = 0): void {
  let stat = taskByLabel.get(label);
  if (!stat) {
    stat = { label, count: 0, totalMs: 0, maxMs: 0, bytes: 0 };
    taskByLabel.set(label, stat);
  }
  stat.count += 1;
  stat.totalMs += ms;
  stat.bytes += bytes;
  if (ms > stat.maxMs) stat.maxMs = ms;
  if (ms >= SLOW_MS) {
    slowMarks.push({ t: Math.round(performance.now()), label, ms: Math.round(ms * 10) / 10, bytes });
    if (slowMarks.length > SLOW_MARKS_MAX) slowMarks.shift();
  }
}

// Cronometra el procesamiento sincrónico de un mensaje peer (parse + callback). `type` es el
// discriminante del mensaje ('snapshot'|'attack'|'input'|'ko'|…) y `bytes` su tamaño.
export function recordPeerMessage(type: string, ms: number, bytes: number): void {
  recordTask(`peer:${type}`, ms, bytes);
}

// Snapshot JSON-able para incrustar en el reporte de performance.
export function getPerfMarkss(): Record<string, unknown> {
  return {
    tasksByLabel: [...taskByLabel.values()].map((s) => ({
      label: s.label,
      count: s.count,
      totalMs: Math.round(s.totalMs),
      maxMs: Math.round(s.maxMs * 10) / 10,
      avgMs: Math.round((s.totalMs / Math.max(1, s.count)) * 10) / 10,
      kb: Math.round(s.bytes / 1024),
    })),
    slow: slowMarks.slice(),
  };
}
