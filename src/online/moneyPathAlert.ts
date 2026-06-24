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
