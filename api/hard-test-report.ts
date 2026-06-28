import { handleApiError, handleNodeApi, sendJson } from '../src/online/vercelApi.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export { config } from '../src/online/vercelApi.js';

// Endpoint DEV del hard test multijugador: recibe el resultado de una corrida y lo
// reenvía a un webhook de Discord (el que el dev puso en VITE_HARD_TEST_WEBHOOK_URL).
// A diferencia de /api/report, el webhook viene en el body (es un canal de dev, no un
// secreto del server) pero se valida que sea un webhook de Discord para no abrir un
// SSRF. Queda inactivo en producción (Vercel): es una herramienta local.

const MAX_REPORT_BYTES = 512 * 1024;
const DISCORD_WEBHOOK_PREFIX = 'https://discord.com/api/webhooks/';

export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handleNodeApi(request, response, { POST });
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (process.env.VERCEL) return sendJson(404, { error: 'No disponible en producción.' });

    const text = await request.text();
    if (!text) return sendJson(400, { error: 'Cuerpo vacío.' });
    if (text.length > MAX_REPORT_BYTES) return sendJson(413, { error: 'Reporte demasiado grande.' });

    let payload: { webhookUrl?: unknown; report?: HardTestResultPayload };
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      return sendJson(400, { error: 'JSON malformado.' });
    }
    const webhookUrl = typeof payload.webhookUrl === 'string' ? payload.webhookUrl.trim() : '';
    if (!webhookUrl.startsWith(DISCORD_WEBHOOK_PREFIX)) {
      return sendJson(400, { error: 'webhookUrl inválido (debe ser un webhook de Discord).' });
    }
    const report = payload.report;
    if (!report || typeof report !== 'object') return sendJson(400, { error: 'Falta el reporte.' });

    const content = buildDiscordSummary(report);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const json = JSON.stringify(report, null, 2);

    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content }));
    // El detalle completo (timeline + checks + errores) va adjunto, descargable.
    form.append('files[0]', new Blob([json], { type: 'application/json' }), `hard-test-${stamp}.json`);

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

interface HardTestCheckPayload { name?: unknown; pass?: unknown; detail?: unknown }
interface HardTestResultPayload {
  pass?: unknown;
  durationMs?: unknown;
  config?: { scenarios?: Record<string, unknown>; withMockedBet?: unknown; playerCount?: unknown };
  checks?: HardTestCheckPayload[];
  errors?: unknown[];
  finalRoom?: { status?: unknown; winnerPlayerId?: unknown; hostPlayerId?: unknown } | null;
}

// Resumen legible (≤2000 chars) con el veredicto, los checks y los escenarios activos.
function buildDiscordSummary(report: HardTestResultPayload): string {
  const pass = report.pass === true;
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const passed = checks.filter((c) => c?.pass === true).length;
  const secs = typeof report.durationMs === 'number' ? Math.round(report.durationMs / 1000) : '—';
  const sc = report.config?.scenarios ?? {};
  const activeScenarios = Object.entries(sc).filter(([, v]) => v === true).map(([k]) => k);
  if (report.config?.withMockedBet) activeScenarios.push('apuesta(mock)');
  const errors = Array.isArray(report.errors) ? report.errors.length : 0;
  const room = report.finalRoom ?? null;

  const lines = [
    `${pass ? '✅' : '❌'} **Hard Test multijugador — ${pass ? 'PASÓ' : 'FALLÓ'}** (${passed}/${checks.length} checks · ${secs}s)`,
    `🎛️ escenarios: ${activeScenarios.length ? activeScenarios.join(', ') : 'ninguno'} · jugadores=${str(report.config?.playerCount)}`,
    room ? `🏁 sala=${str(room.status)} · ganador=${str(room.winnerPlayerId)} · host=${str(room.hostPlayerId)}` : null,
    errors > 0 ? `⚠️ ${errors} error(es) capturado(s)` : null,
    '',
    ...checks.map((c) => `${c?.pass ? '✅' : '❌'} ${str(c?.name)}: ${str(c?.detail, 120)}`),
  ].filter((line): line is string => line !== null);
  return lines.join('\n').slice(0, 1990);
}

function str(value: unknown, max = 80): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value).slice(0, max);
}
