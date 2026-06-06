import { handleNodeApi } from '../src/online/vercelApi.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handleNodeApi(request, response, { GET });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const diagnostics = url.searchParams.get('diag') === 'rooms'
    ? await runRoomsDiagnostics()
    : undefined;
  return Response.json({
    ok: true,
    runtime: 'vercel-function',
    serverNowMs: Date.now(),
    diagnostics,
  });
}

async function runRoomsDiagnostics(): Promise<Record<string, unknown>> {
  const diagnostics: Record<string, unknown> = {};
  try {
    const roomService = await import('../src/online/roomService.js');
    diagnostics.roomServiceImport = 'ok';
    diagnostics.roomCode = roomService.createRoomCode(() => 0);
  } catch (error) {
    diagnostics.roomServiceImport = errorText(error);
  }

  try {
    const vercelApi = await import('../src/online/vercelApi.js');
    diagnostics.vercelApiImport = 'ok';
    diagnostics.env = {
      hasUpstashUrl: Boolean(process.env.UPSTASH_REDIS_REST_URL),
      hasUpstashToken: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN),
      hasKvUrl: Boolean(process.env.KV_REST_API_URL),
      hasKvToken: Boolean(process.env.KV_REST_API_TOKEN),
    };
    diagnostics.storeType = vercelApi.getRoomStore().constructor.name;
  } catch (error) {
    diagnostics.vercelApiImport = errorText(error);
  }

  try {
    const publicRoute = await import('./rooms/[action].js');
    diagnostics.publicRouteImport = 'ok';
    const response = await publicRoute.GET(new Request('https://stack40.local/api/rooms/public'));
    diagnostics.publicRouteStatus = response.status;
    diagnostics.publicRouteBody = await response.text();
  } catch (error) {
    diagnostics.publicRouteImport = errorText(error);
  }

  return diagnostics;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
