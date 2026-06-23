import { handleNodeApi, sendJson } from '../src/online/vercelApi.js';
import { buildStatusReport } from '../src/online/serviceStatus.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export { config } from '../src/online/vercelApi.js';

export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handleNodeApi(request, response, { GET });
}

// "tetra status": uso real de cada servicio externo vs. los límites de su plan.
//
// Este endpoint revela QUÉ servicios y keys hay configurados, así que en producción exige
// STATUS_TOKEN (por query ?token= o header x-status-token). En local (sin VERCEL_ENV) se
// permite sin token para desarrollo.
export async function GET(request: Request): Promise<Response> {
  const expected = (process.env.STATUS_TOKEN ?? '').trim();
  const isProd = (process.env.VERCEL_ENV ?? '').trim() === 'production';
  if (isProd && !expected) {
    return sendJson(503, {
      error: 'Status sin proteger: definí STATUS_TOKEN en el server para habilitarlo en producción.',
    });
  }
  if (expected) {
    const url = new URL(request.url);
    const provided = (url.searchParams.get('token') ?? request.headers.get('x-status-token') ?? '').trim();
    if (provided !== expected) return sendJson(401, { error: 'Token inválido.' });
  }
  const report = await buildStatusReport();
  return sendJson(200, report);
}
