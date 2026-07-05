import { handleNodeApi } from '../src/online/vercelApi.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handleNodeApi(request, response, { GET });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const diag = url.searchParams.get('diag');
  const diagnostics = diag === 'rooms'
    ? await runRoomsDiagnostics()
    : diag === 'env'
      ? await runEnvDiagnostics()
      : undefined;
  return Response.json({
    ok: true,
    runtime: 'vercel-function',
    serverNowMs: Date.now(),
    diagnostics,
  });
}

// Reporte de configuración por función: qué env vars están seteadas (solo booleanos,
// nunca el valor) para que un deploy nuevo vea de un vistazo qué falta. Pensado para
// abrir /api/health?diag=env en el navegador tras subir un Vercel nuevo.
async function runEnvDiagnostics(): Promise<Record<string, unknown>> {
  const has = (name: string): boolean => Boolean((process.env[name] ?? '').trim());
  const groups: Record<string, { ready: boolean; note?: string; vars: Record<string, boolean> }> = {};

  // Salas online / invitar / apostar: el invitar lee la sala del MISMO transporte
  // que usa el juego. En prod el juego corre por WebSocket (Cloudflare), así que
  // Vercel solo ve esa sala vía el puente → PARTY_BRIDGE_TOKEN. Sin puente ni Upstash,
  // el store cae a memoria y toda sala "desaparece" entre requests → "Room not found".
  const hasBridge = has('PARTY_BRIDGE_TOKEN');
  const hasUpstash = (has('UPSTASH_REDIS_REST_URL') || has('KV_REST_API_URL'))
    && (has('UPSTASH_REDIS_REST_TOKEN') || has('KV_REST_API_TOKEN'));
  let betStoreType = 'unknown';
  try {
    const vercelApi = await import('../src/online/vercelApi.js');
    betStoreType = vercelApi.getBetRoomStore().constructor.name;
  } catch (error) {
    betStoreType = errorText(error);
  }
  groups.salasOnline = {
    ready: hasBridge || hasUpstash,
    note: betStoreType === 'MemoryRoomStore'
      ? 'Store en MEMORIA: las salas no persisten entre requests → "Room not found" al invitar. '
        + 'Seteá PARTY_BRIDGE_TOKEN (puente a Cloudflare, recomendado en prod) o Upstash/KV.'
      : `Store activo del invitar: ${betStoreType}.`,
    vars: {
      PARTY_BRIDGE_TOKEN: hasBridge,
      PARTY_BRIDGE_URL: has('PARTY_BRIDGE_URL'), // opcional; default tetra.naranjas.workers.dev
      UPSTASH_REDIS_REST_URL: has('UPSTASH_REDIS_REST_URL'),
      UPSTASH_REDIS_REST_TOKEN: has('UPSTASH_REDIS_REST_TOKEN'),
      KV_REST_API_URL: has('KV_REST_API_URL'),
      KV_REST_API_TOKEN: has('KV_REST_API_TOKEN'),
    },
  };

  // Login SSO / amigos / invitar (entrega) / presencia / apuestas contra Luna Negra.
  groups.lunaNegra = {
    ready: has('LUNA_NEGRA_BASE') && has('LUNA_NEGRA_API_KEY'),
    note: 'Sin BASE+API_KEY el login SSO cae a invitado y la invitación no se entrega.',
    vars: {
      LUNA_NEGRA_BASE: has('LUNA_NEGRA_BASE'),
      LUNA_NEGRA_API_KEY: has('LUNA_NEGRA_API_KEY'),
      LUNA_NEGRA_GAME_ID: has('LUNA_NEGRA_GAME_ID'),
      LUNA_NEGRA_GAME_SLUG: has('LUNA_NEGRA_GAME_SLUG'),
    },
  };

  // Link de invitación (opcional): si falta usa el origin del request.
  groups.linkInvitacion = {
    ready: true,
    note: 'Opcional: sin PUBLIC_BASE_URL el link usa el origin del request.',
    vars: { PUBLIC_BASE_URL: has('PUBLIC_BASE_URL') },
  };

  // Webhooks de apuestas (push de cobro por zap).
  groups.webhooksApuestas = {
    ready: has('LUNA_NEGRA_WEBHOOK_URL') && has('LUNA_NEGRA_WEBHOOK_SECRET'),
    vars: {
      LUNA_NEGRA_WEBHOOK_URL: has('LUNA_NEGRA_WEBHOOK_URL'),
      LUNA_NEGRA_WEBHOOK_SECRET: has('LUNA_NEGRA_WEBHOOK_SECRET'),
    },
  };

  // Alertas y reportes a Discord.
  groups.alertasDiscord = {
    ready: has('DISCORD_WEBHOOK_URL') || has('DISCORD_ALERT_WEBHOOK_URL'),
    vars: {
      DISCORD_WEBHOOK_URL: has('DISCORD_WEBHOOK_URL'),
      DISCORD_ALERT_WEBHOOK_URL: has('DISCORD_ALERT_WEBHOOK_URL'),
    },
  };

  // Panel de estado (/status.html).
  groups.panelEstado = {
    ready: has('STATUS_TOKEN'),
    vars: {
      STATUS_TOKEN: has('STATUS_TOKEN'),
      CLOUDFLARE_API_TOKEN: has('CLOUDFLARE_API_TOKEN'),
      CLOUDFLARE_ACCOUNT_ID: has('CLOUDFLARE_ACCOUNT_ID'),
    },
  };

  return {
    // VITE_* son de build (se hornean en el bundle); no se pueden leer desde la función.
    nota: 'Solo se reportan booleanos, nunca valores. Las VITE_* son build-time y no aparecen acá.',
    vercelEnv: (process.env.VERCEL_ENV ?? '').trim() || 'local',
    faltantes: Object.entries(groups).filter(([, g]) => !g.ready).map(([key]) => key),
    groups,
  };
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
