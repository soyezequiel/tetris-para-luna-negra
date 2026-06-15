import type { MusicTrack } from './SoundEngine';

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo de música AUTOMÁTICO.
//
// Para AGREGAR una pista: copiá el archivo (.m4a/.mp3/.ogg) a src/audio/music/.
// Para QUITAR una pista: borrá el archivo de src/audio/music/.
// No hace falta editar este archivo ni correr ningún comando: Vite descubre los
// archivos en build/dev y arma la lista solo. (En dev reiniciá el server si el
// watcher no toma el archivo nuevo — ver memoria "Vite stale HMR en F:\".)
//
// Opcionalmente podés ajustar el TÍTULO que se ve en la UI y el ORDEN de la
// playlist más abajo. Lo que no esté listado usa un título auto-generado a
// partir del nombre del archivo y se ordena alfabético al final.
// ─────────────────────────────────────────────────────────────────────────────

// Vite resuelve esto en build-time: cada archivo de la carpeta queda como una
// URL de asset (hasheada y copiada al bundle). `query: '?url'` evita inlinearlos.
const modules = import.meta.glob('./music/*.{m4a,mp3,ogg}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

// Títulos lindos para archivos cuyo nombre no capitaliza bien solo.
// Clave = nombre del archivo SIN extensión.
const TITLE_OVERRIDES: Record<string, string> = {
  'schneidig-vor-op-79': 'Schneidig vor, Op. 79',
  'two-tribes': 'Two Tribes (feat. Kevin Blumenfeld)',
  'heart-of-glass-russian': 'Heart Of Glass (Russian)',
  'holding-out-for-a-hero-russian': 'Holding Out For A Hero (Russian)',
  'holding-out-for-a-hero-japanese': 'Holding Out For A Hero (Japanese)',
  opportunities: "Opportunities (Let's Make Lots of Money)",
  'the-final-countdown-trailer': 'The Final Countdown (Trailer Music)',
};

// Orden de la playlist. Los nombres listados (sin extensión) van primero, en
// este orden; cualquier archivo nuevo no listado va después, alfabético.
const ORDER: string[] = [
  'tetris-theme-reworked',
  'stacking-squares',
  'puzzle-piece',
  'fall-into-place',
  'benevolence',
  'farewell-of-slavianka',
  'schneidig-vor-op-79',
  'two-tribes',
  'heart-of-glass',
  'heart-of-glass-russian',
  'holding-out-for-a-hero-russian',
  'holding-out-for-a-hero-japanese',
  'opportunities',
  'the-final-countdown-trailer',
];

function baseName(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.[^.]+$/, '');
}

// 'tetris-theme-reworked' -> 'Tetris Theme Reworked'
function autoTitle(name: string): string {
  return name
    .split('-')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function orderRank(name: string): number {
  const i = ORDER.indexOf(name);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

export const MUSIC_TRACKS: MusicTrack[] = Object.entries(modules)
  .map(([path, src]) => {
    const name = baseName(path);
    return { name, title: TITLE_OVERRIDES[name] ?? autoTitle(name), src };
  })
  .sort((a, b) => {
    const ra = orderRank(a.name);
    const rb = orderRank(b.name);
    return ra !== rb ? ra - rb : a.title.localeCompare(b.title);
  })
  .map(({ title, src }) => ({ title, src }));
