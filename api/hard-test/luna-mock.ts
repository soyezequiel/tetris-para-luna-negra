import { handleApiError, handleNodeApi, queryParam, sendJson } from '../../src/online/vercelApi.js';
import { setLunaMockEnabled } from '../../src/online/lunaNegraMock.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export { config } from '../../src/online/vercelApi.js';

// Endpoint DEV del hard test: prende/apaga el mock en memoria del backend de apuestas
// (ver src/online/lunaNegraMock.ts), para correr el money-path sin invoices reales.
// Al prenderlo fija también un LUNA_NEGRA_GAME_ID, que createBetForRoom exige. Inactivo
// en producción.

export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handleNodeApi(request, response, { GET, POST });
}

function toggle(request: Request): Response {
  if (process.env.VERCEL) return sendJson(404, { error: 'No disponible en producción.' });
  const on = queryParam(request, 'on') === '1';
  setLunaMockEnabled(on);
  if (on && !process.env.LUNA_NEGRA_GAME_ID) process.env.LUNA_NEGRA_GAME_ID = 'hard-test-game';
  return sendJson(200, { ok: true, mock: on });
}

export function GET(request: Request): Response {
  try {
    return toggle(request);
  } catch (error) {
    return handleApiError(error);
  }
}

export function POST(request: Request): Response {
  try {
    return toggle(request);
  } catch (error) {
    return handleApiError(error);
  }
}
