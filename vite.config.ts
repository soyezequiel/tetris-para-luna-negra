import { defineConfig, loadEnv } from 'vite';
import * as health from './api/health';
import * as lunaNegraAction from './api/luna-negra/[action]';
import * as lunaNegraEnter from './api/rooms/luna-negra/enter';
import * as roomsAction from './api/rooms/[action]';
import * as betsAction from './api/bets/[action]';
import * as localBetAction from './api/local-bet/[action]';
import * as leaderboard from './api/leaderboard';
import * as survival from './api/survival';
import * as report from './api/report';
import * as status from './api/status';
// Endpoints DEV-only del hard test: viven fuera de api/ para que Vercel NO los cuente
// como funciones serverless (el plan Hobby tope a 12). vite los cablea al dev server.
import * as hardTestReport from './dev-api/hard-test-report';
import * as hardTestLunaMock from './dev-api/hard-test/luna-mock';

type LocalApiHandler = (request: Request) => Response | Promise<Response>;
type LocalApiModule = Partial<Record<'GET' | 'POST', LocalApiHandler>>;

const localApiHandlers = new Map<string, LocalApiModule>([
  ['/api/health', health],
  ['/api/luna-negra/friends', lunaNegraAction],
  ['/api/luna-negra/game-info', lunaNegraAction],
  ['/api/luna-negra/invite', lunaNegraAction],
  ['/api/luna-negra/invite-window', lunaNegraAction],
  ['/api/luna-negra/launch-request', lunaNegraAction],
  ['/api/luna-negra/presence', lunaNegraAction],
  ['/api/luna-negra/verify-room-invite', lunaNegraAction],

  ['/api/rooms/attack', roomsAction],
  ['/api/rooms/create', roomsAction],
  ['/api/rooms/eliminate', roomsAction],
  ['/api/rooms/failover', roomsAction],
  ['/api/rooms/join', roomsAction],
  ['/api/rooms/kick', roomsAction],
  ['/api/rooms/leave', roomsAction],
  ['/api/rooms/luna-negra/enter', lunaNegraEnter],
  ['/api/rooms/progress', roomsAction],
  ['/api/rooms/public', roomsAction],
  ['/api/rooms/ready', roomsAction],
  ['/api/rooms/reopen', roomsAction],
  ['/api/rooms/restart', roomsAction],
  ['/api/rooms/result', roomsAction],
  ['/api/rooms/settings', roomsAction],
  ['/api/rooms/signal', roomsAction],
  ['/api/rooms/start', roomsAction],
  ['/api/rooms/state', roomsAction],
  ['/api/rooms/targeting', roomsAction],

  ['/api/bets/create', betsAction],
  ['/api/bets/refresh', betsAction],
  ['/api/bets/cancel', betsAction],
  ['/api/bets/settle', betsAction],
  ['/api/bets/state', betsAction],

  ['/api/local-bet/available', localBetAction],
  ['/api/local-bet/create', localBetAction],
  ['/api/local-bet/state', localBetAction],
  ['/api/local-bet/result', localBetAction],
  ['/api/local-bet/cancel', localBetAction],

  ['/api/leaderboard', leaderboard],
  ['/api/survival', survival],
  ['/api/report', report],
  ['/api/status', status],
  // HARD TEST (dev): reporte a Discord + toggle del mock de Luna.
  ['/api/hard-test-report', hardTestReport],
  ['/api/hard-test/luna-mock', hardTestLunaMock],
]);

export default defineConfig(({ mode }) => {
  // Las rutas API locales (dev) leen `process.env` (LUNA_NEGRA_*, etc.). Vite solo
  // expone las VITE_* a `import.meta.env`, así que cargamos los .env a mano y los
  // volcamos a process.env para que el middleware de API funcione en `npm run dev`.
  // Solo dev: en Vercel el process.env ya viene poblado por la plataforma.
  const env = loadEnv(mode, process.cwd(), '');
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return {
  server: {
    port: 5173,
  },
  plugins: [{
    name: 'stack40-local-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? '';
        const handlers = localApiHandlers.get(path);
        const method = req.method === 'POST' ? 'POST' : 'GET';
        const handler = handlers?.[method];
        if (!handler) {
          next();
          return;
        }
        void toWebRequest(req)
          .then(handler)
          .then((response) => writeWebResponse(res, response))
          .catch(next);
      });
    },
  }],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, '/');
          if (normalizedId.includes('/node_modules/@pixi/')) return 'pixi';
        },
      },
    },
  },
  };
});

async function toWebRequest(req: import('node:http').IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? '127.0.0.1';
  const url = `http://${host}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else if (value !== undefined) headers.set(key, value);
  }
  const method = req.method ?? 'GET';
  const rawBody = method === 'GET' || method === 'HEAD' ? undefined : await readNodeBody(req);
  const body = rawBody ? Buffer.from(rawBody).toString('utf8') : undefined;
  return new Request(url, { method, headers, body });
}

async function readNodeBody(req: import('node:http').IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

async function writeWebResponse(res: import('node:http').ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}
