import { OnlineRoomError } from './roomService.js';

// Alerta a Discord cuando un flujo de plata (apuestas) falla en el server. El URL del
// webhook vive SOLO en el server (env `DISCORD_ALERT_WEBHOOK_URL`, con fallback al
// `DISCORD_WEBHOOK_URL` del botón "Reportar"): nunca se expone al cliente, así no se
// puede spamear el canal desde afuera. Best-effort: si no hay webhook o el POST falla,
// NO interrumpe la respuesta de la API (el error real igual le llega al cliente).

// Anti-spam: no repetir la misma alerta (flujo + código/mensaje + sala) dentro de esta
// ventana. Evita inundar el canal si un cliente reintenta en loop.
const RECENT_TTL_MS = 60_000;
const recent = new Map<string, number>();

function shouldThrottle(key: string, nowMs: number): boolean {
  if (recent.size > 200) {
    for (const [k, t] of recent) if (nowMs - t > RECENT_TTL_MS) recent.delete(k);
  }
  const last = recent.get(key);
  if (last !== undefined && nowMs - last < RECENT_TTL_MS) return true;
  recent.set(key, nowMs);
  return false;
}

interface ErrorInfo {
  status: number | null;
  code: string | null;
  message: string;
}

// Snapshot de la configuración del server relevante para el flujo de plata. Solo
// booleanos y el nombre del backend activo: NUNCA valores de secretos. Sirve para
// que la alerta diga *qué falta* en este entorno (típico: env vars que están en
// producción pero no en el deploy preview).
interface MoneyPathConfig {
  betStore: 'partyserver' | 'upstash' | 'memory';
  hasApiKey: boolean;
  hasBaseUrl: boolean;
  hasGameId: boolean;
  hasPartyBridgeToken: boolean;
  hasUpstash: boolean;
}

function readMoneyPathConfig(): MoneyPathConfig {
  const hasPartyBridgeToken = Boolean((process.env.PARTY_BRIDGE_TOKEN ?? '').trim());
  const hasUpstash = Boolean(
    (process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? '').trim()
    && (process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? '').trim(),
  );
  return {
    // Mismo orden de resolución que getBetRoomStore(): partyserver > upstash > memoria.
    betStore: hasPartyBridgeToken ? 'partyserver' : (hasUpstash ? 'upstash' : 'memory'),
    hasApiKey: Boolean((process.env.LUNA_NEGRA_API_KEY ?? '').trim()),
    hasBaseUrl: Boolean((process.env.LUNA_NEGRA_BASE_URL ?? '').trim()),
    hasGameId: Boolean((process.env.LUNA_NEGRA_GAME_ID ?? '').trim()),
    hasPartyBridgeToken,
    hasUpstash,
  };
}

function tick(ok: boolean): string {
  return ok ? '✅' : '❌';
}

/**
 * Líneas de diagnóstico para la alerta: un snapshot de config (qué store se está
 * usando y qué env vars faltan) y, cuando el fallo es un 404 de "sala no encontrada",
 * una pista de la causa raíz más probable (mismatch de transporte / env vars ausentes
 * en este entorno). El objetivo es que la alerta baste para saber *qué configurar*
 * sin ir a leer el código.
 */
function diagnosticLines(info: ErrorInfo, cfg: MoneyPathConfig): string[] {
  const lines: string[] = [
    `🔧 store apuestas=\`${cfg.betStore}\` · API_KEY ${tick(cfg.hasApiKey)}`
    + ` · BASE_URL ${tick(cfg.hasBaseUrl)} · GAME_ID ${tick(cfg.hasGameId)}`,
  ];

  const roomNotFound = info.status === 404
    || /room not found|sala no encontrada/i.test(info.message);
  if (roomNotFound) {
    if (cfg.betStore === 'memory') {
      lines.push(
        '💡 El store de apuestas es en-memoria (falta `PARTY_BRIDGE_TOKEN` y Upstash en'
        + ' este entorno): es efímero por instancia y NUNCA ve las salas del transporte'
        + ' WebSocket. Configurá `PARTY_BRIDGE_TOKEN` + `PARTY_BRIDGE_URL` en ESTE deploy'
        + ' (preview) apuntando al mismo partyserver que usa el cliente.',
      );
    } else {
      lines.push(
        `💡 La sala no está en el store \`${cfg.betStore}\`. Probable mismatch de transporte:`
        + ' el cliente creó la sala en otro backend (p. ej. WebSocket/Cloudflare) mientras'
        + ' esta API lee otro. Verificá que cliente y bet API apunten al MISMO transporte y,'
        + ' si usás partyserver, que `PARTY_BRIDGE_URL` sea el mismo host en ambos.',
      );
    }
  }

  const missing: string[] = [];
  if (!cfg.hasApiKey) missing.push('`LUNA_NEGRA_API_KEY`');
  if (!cfg.hasBaseUrl) missing.push('`LUNA_NEGRA_BASE_URL`');
  if (!cfg.hasGameId) missing.push('`LUNA_NEGRA_GAME_ID`');
  if (missing.length) {
    lines.push(`⚠ Faltan env vars de escrow en este entorno: ${missing.join(', ')}.`);
  }
  return lines;
}

// Extrae código de error del proveedor (LunaApiError) + status HTTP real cuando existen,
// sin acoplar a esas clases (acceso defensivo por si el error viene de otra capa).
function describeError(error: unknown): ErrorInfo {
  if (error instanceof OnlineRoomError) {
    const e = error as OnlineRoomError & { code?: string | null; httpStatus?: number };
    return {
      status: e.httpStatus ?? e.status ?? null,
      code: e.code ?? null,
      message: error.message,
    };
  }
  if (error instanceof Error) return { status: null, code: null, message: error.message };
  return { status: null, code: null, message: String(error) };
}

/**
 * Reporta a Discord un fallo en un flujo de apuestas (crear/cancelar/cobrar/reintentar).
 * `flow` identifica la operación (ej. `bet:create`) y `context` agrega datos útiles para
 * diagnosticar (sala, jugador, monto). Nunca lanza.
 */
export async function alertMoneyPathError(
  flow: string,
  context: Record<string, unknown>,
  error: unknown,
): Promise<void> {
  const webhookUrl = (process.env.DISCORD_ALERT_WEBHOOK_URL ?? process.env.DISCORD_WEBHOOK_URL ?? '').trim();
  if (!webhookUrl) return;
  try {
    const nowMs = Date.now();
    const info = describeError(error);
    const key = `${flow}:${info.code ?? info.message}:${String(context.roomId ?? '')}`;
    if (shouldThrottle(key, nowMs)) return;

    const env = (process.env.VERCEL_ENV ?? 'dev').trim() || 'dev';
    const ctxLine = Object.entries(context)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([k, value]) => `${k}=\`${String(value).slice(0, 80)}\``)
      .join(' · ');
    const lines = [
      `🚨 **Falló un flujo de plata** · \`${flow}\` (${env})`,
      `❌ ${info.code ? `\`${info.code}\` · ` : ''}${info.message.slice(0, 400)}${info.status ? ` (HTTP ${info.status})` : ''}`,
      ctxLine ? `📍 ${ctxLine}` : null,
      ...diagnosticLines(info, readMoneyPathConfig()),
      `🕒 ${new Date(nowMs).toISOString()}`,
    ].filter((line): line is string => line !== null);

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n').slice(0, 1990) }),
    });
  } catch {
    // Best-effort: un fallo al alertar nunca debe tapar/alterar el error original.
  }
}
