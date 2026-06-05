import { defineConfig } from 'vite';
import * as createRoom from './api/rooms/create';
import * as joinRoom from './api/rooms/join';
import * as progressRoom from './api/rooms/progress';
import * as publicRooms from './api/rooms/public';
import * as readyRoom from './api/rooms/ready';
import * as resultRoom from './api/rooms/result';
import * as startRoom from './api/rooms/start';
import * as stateRoom from './api/rooms/state';

type LocalApiHandler = (request: Request) => Response | Promise<Response>;
type LocalApiModule = Partial<Record<'GET' | 'POST', LocalApiHandler>>;

const localApiHandlers = new Map<string, LocalApiModule>([
  ['/api/rooms/create', createRoom],
  ['/api/rooms/join', joinRoom],
  ['/api/rooms/progress', progressRoom],
  ['/api/rooms/public', publicRooms],
  ['/api/rooms/ready', readyRoom],
  ['/api/rooms/result', resultRoom],
  ['/api/rooms/start', startRoom],
  ['/api/rooms/state', stateRoom],
]);

export default defineConfig({
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
