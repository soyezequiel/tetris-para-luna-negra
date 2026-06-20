// Service worker de TETRA — PWA instalable con caché conservadora.
// Objetivo: que la app sea instalable y cargue offline el "shell",
// SIN interferir con el juego online (/api/*, WebSockets, cross-origin).

// Subir esta versiÃ³n invalida el shell/assets de instalaciones PWA anteriores.
// v2: fuerza la entrega del UI de cobro mÃ³vil y evita JS/CSS stale.
const VERSION = 'v2';
const CACHE = `tetra-${VERSION}`;

// Shell mínimo. Los assets con hash de Vite se cachean en runtime
// (stale-while-revalidate), así no hay que listarlos acá.
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Solo manejamos mismo origen. Fuentes/CDN y demás los maneja el navegador.
  if (url.origin !== self.location.origin) return;

  // Nunca tocar la API ni endpoints en vivo del online.
  if (url.pathname.startsWith('/api/')) return;

  // Navegaciones (cargar la página): network-first con fallback al shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))),
    );
    return;
  }

  // Los bundles de la app deben ser network-first. Servir un JS viejo durante la
  // primera carga tras un deploy deja la PWA ejecutando una UI anterior (p. ej.
  // sin el botÃ³n "Abrir wallet Lightning") hasta una segunda recarga.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  // ImÃ¡genes/manifest y otros recursos: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
