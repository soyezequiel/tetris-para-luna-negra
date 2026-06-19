import { handleApiError, handleNodeApi, sendJson } from '../src/online/vercelApi.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export { config } from '../src/online/vercelApi.js';

// Tope de tamaño del reporte (anti-abuso): un reporte normal pesa ~1–50KB. Más que esto
// es ruido/ataque y lo rechazamos antes de tocar el webhook.
const MAX_REPORT_BYTES = 256 * 1024;

export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handleNodeApi(request, response, { POST });
}

// Recibe el reporte de performance del cliente (botón "Reportar" en resultados) y lo reenvía
// a un webhook de Discord. El URL del webhook vive SOLO en el server (env DISCORD_WEBHOOK_URL):
// nunca se expone al cliente, así no se puede spamear el canal desde afuera. El JSON completo
// va como archivo adjunto (descargable) + un resumen legible en el mensaje.
export async function POST(request: Request): Promise<Response> {
  try {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      return sendJson(503, { error: 'Reporte no configurado (falta DISCORD_WEBHOOK_URL en el server).' });
    }

    const text = await request.text();
    if (!text) return sendJson(400, { error: 'Reporte vacío.' });
    if (text.length > MAX_REPORT_BYTES) return sendJson(413, { error: 'Reporte demasiado grande.' });

    let report: ReportPayload;
    try {
      report = JSON.parse(text) as ReportPayload;
    } catch {
      return sendJson(400, { error: 'Reporte malformado (no es JSON).' });
    }
    if (!report || typeof report !== 'object') return sendJson(400, { error: 'Reporte inválido.' });

    const content = buildDiscordSummary(report);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content }));
    form.append('files[0]', new Blob([text], { type: 'application/json' }), `report-${stamp}.json`);

    const discord = await fetch(webhookUrl, { method: 'POST', body: form });
    if (!discord.ok) {
      const detail = await discord.text().catch(() => '');
      return sendJson(502, { error: `El webhook rechazó el reporte (HTTP ${discord.status}).`, detail: detail.slice(0, 300) });
    }
    return sendJson(200, { ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}

interface ReportPayload {
  comment?: unknown;
  device?: { userAgent?: unknown; cores?: unknown; dpr?: unknown; viewport?: unknown; transport?: unknown };
  context?: { appMode?: unknown; roomId?: unknown; players?: unknown; isHost?: unknown };
  session?: {
    frames?: unknown; spikes?: unknown; longtasks?: unknown; snaps?: unknown;
    b33?: unknown; b50?: unknown; b100?: unknown; b200?: unknown;
    maxLoopMs?: unknown; maxLongtaskMs?: unknown; maxSnapMs?: unknown; durationMs?: unknown;
    worst?: { dur?: unknown; mode?: unknown; sync?: unknown; render?: unknown } | null;
  };
  events?: unknown[];
  errors?: unknown[];
}

// Resumen legible para el mensaje de Discord (≤2000 chars). El detalle completo va adjunto.
function buildDiscordSummary(report: ReportPayload): string {
  const s = report.session ?? {};
  const ctx = report.context ?? {};
  const dev = report.device ?? {};
  const num = (v: unknown): string => (typeof v === 'number' ? String(Math.round(v)) : '—');
  const comment = typeof report.comment === 'string' && report.comment.trim()
    ? report.comment.trim().slice(0, 400)
    : null;
  const errors = Array.isArray(report.errors) ? report.errors.length : 0;
  const worst = s.worst;
  const worstStr = worst
    ? `${num(worst.dur)}ms (sync=${num(worst.sync)} render=${num(worst.render)})`
    : '—';
  const lines = [
    '🎮 **Reporte de lag de Tetra**',
    comment ? `💬 _"${comment}"_` : '_(sin comentario)_',
    `📍 sala \`${str(ctx.roomId)}\` · ${num(ctx.players)} jug · ${ctx.isHost ? 'host' : 'invitado'} · modo \`${str(ctx.appMode)}\``,
    `📊 spikes=**${num(s.spikes)}** longtasks=**${num(s.longtasks)}** snaps=**${num(s.snaps)}** | cola >33=${num(s.b33)} >50=${num(s.b50)} >100=${num(s.b100)} >200=${num(s.b200)}`,
    `⏱️ peor frame=${worstStr} · maxLongtask=${num(s.maxLongtaskMs)}ms · frames=${num(s.frames)} en ${num(s.durationMs)}ms · errores=**${errors}**`,
    `🖥️ ${str(dev.viewport)} dpr=${num(dev.dpr)} cores=${num(dev.cores)} transport=${str(dev.transport)}`,
  ];
  return lines.join('\n').slice(0, 1990);
}

function str(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  return String(v).slice(0, 80);
}
