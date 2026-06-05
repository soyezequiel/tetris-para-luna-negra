import { defineConfig } from 'vite';
import createRoom from './api/rooms/create';
import joinRoom from './api/rooms/join';
import progressRoom from './api/rooms/progress';
import publicRooms from './api/rooms/public';
import readyRoom from './api/rooms/ready';
import resultRoom from './api/rooms/result';
import startRoom from './api/rooms/start';
import stateRoom from './api/rooms/state';

const localApiHandlers = new Map([
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
        const handler = localApiHandlers.get(path);
        if (!handler) {
          next();
          return;
        }
        void handler(req, res).catch(next);
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
