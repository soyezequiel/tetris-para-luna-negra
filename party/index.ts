import { routePartykitRequest } from 'partyserver';
import type { Env } from './env.js';

// Los Durable Objects deben exportarse desde el módulo main del Worker.
export { RoomServer } from './room.js';
export { LobbyServer } from './lobby.js';

/**
 * Entrypoint del Worker. `routePartykitRequest` mantiene el esquema de URL
 * `/parties/:party/:name` (el mismo que usa `partysocket` en el cliente), mapeando
 * el segmento `:party` al binding por kebab-case: `Main`→`main`, `Lobby`→`lobby`.
 * Así el cliente conecta igual que con PartyKit, sin cambios.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routePartykitRequest(request, env as never)) ?? new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
