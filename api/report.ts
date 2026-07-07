import { handleApiError, handleNodeApi, sendJson } from '../src/online/vercelApi.js';
import { fetchBetPaymentTimeline } from '../src/online/lunaNegraBets.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export { config } from '../src/online/vercelApi.js';

// Tope de tamaño del reporte (anti-abuso): un reporte normal pesa ~1–50KB. Más que esto
// es ruido/ataque y lo rechazamos antes de tocar el webhook.
const MAX_REPORT_BYTES = 256 * 1024;
const DEFAULT_BET_PAYMENT_WEBHOOK_URL =
  'https://discord.com/api/webhooks/1517597347767521360/gXXREmf8vApvoN1at3FDFn5Ir4skS_KRx8fJU_MJc6nhOgPY9_f0-BQzo-AWcJobS_Oe';

export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handleNodeApi(request, response, { POST });
}

// Recibe el reporte de performance del cliente (botón "Reportar" en resultados) y lo reenvía
// a un webhook de Discord. El URL del webhook vive SOLO en el server (env DISCORD_WEBHOOK_URL):
// nunca se expone al cliente, así no se puede spamear el canal desde afuera. El JSON completo
// va como archivo adjunto (descargable) + un resumen legible en el mensaje.
export async function POST(request: Request): Promise<Response> {
  try {
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

    // Radiografía del pago (server-authoritative): si el reporte trae un betId,
    // le pedimos a Luna Negra —con la API key que vive SOLO en este server— el
    // desglose temporal (fases, depósitos, payout, ledger) y lo adjuntamos. Así el
    // reporte del jugador incluye el "por qué tardó" con timestamps exactos, no solo
    // lo que el cliente alcanzó a ver por polling. Best-effort: nunca bloquea.
    const webhookUrl = webhookUrlForReportKind(report.kind);
    if (!webhookUrl) {
      return sendJson(503, { error: 'Reporte no configurado (falta webhook de Discord en el server).' });
    }

    const betId = typeof report.betWithdrawal?.betId === 'string' ? report.betWithdrawal.betId : null;
    if (betId) {
      const paymentTimeline = await fetchBetPaymentTimeline(betId).catch(() => null);
      if (paymentTimeline) report.paymentTimeline = paymentTimeline as PaymentTimeline;
    }

    const content = buildDiscordSummary(report);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Reserializamos DESPUÉS de adjuntar el timeline: el JSON que va a Discord (embed
    // y archivo) es el enriquecido, no el crudo del request. El chequeo de tamaño de
    // arriba sigue sobre el body original (anti-abuso de lo que mandó el cliente).
    const outText = JSON.stringify(report);

    // El JSON completo va en un bloque de código DENTRO de un embed: en Discord (desktop) un
    // bloque ``` muestra botón "Copiar" de un clic, así se pega directo en Claude Code sin
    // descargar nada. La descripción de un embed admite hasta 4096 chars (vs 2000 del content),
    // así que el reporte entero suele entrar; si no, lo truncamos y queda el archivo adjunto.
    const EMBED_DESC_MAX = 4096;
    const FENCE = '```';
    const wrap = (body: string): string => `${FENCE}json\n${body}\n${FENCE}`;
    const overhead = wrap('').length + 1; // backticks + saltos de línea
    const truncated = outText.length > EMBED_DESC_MAX - overhead;
    // Neutralizamos cualquier backtick del payload (p. ej. en el comentario del jugador) con un
    // zero-width space para que no cierre el bloque de código del embed. En un reporte normal el
    // JSON no tiene backticks, así que es un no-op; el ZWSP es invisible al pegar.
    const safe = (s: string): string => s.replace(/`/g, '`​');
    const jsonForEmbed = truncated
      ? `${safe(outText.slice(0, EMBED_DESC_MAX - overhead - 24))}…\n(truncado, ver adjunto)`
      : safe(outText);
    const embed = {
      title: '📋 Reporte (copialo y pegalo en Claude Code)',
      description: wrap(jsonForEmbed),
      color: 0xf59e0b,
    };

    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content, embeds: [embed] }));
    // Solo adjuntamos el archivo cuando el JSON NO entró entero en el bloque copiable del embed
    // (truncado). Si entró completo, el adjunto sería una copia exacta y redundante del embed.
    if (truncated) {
      form.append('files[0]', new Blob([outText], { type: 'application/json' }), `report-${stamp}.json`);
    }

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

interface PaymentTimeline {
  status?: unknown;
  phases?: { fundingMs?: unknown; settlementMs?: unknown; totalMs?: unknown };
  bet?: { hasResultEvent?: unknown; hasSettleNote?: unknown };
  participants?: {
    seat?: unknown;
    result?: unknown;
    deposit?: { status?: unknown; sinceCreateMs?: unknown };
    payout?: { status?: unknown; kind?: unknown; sats?: unknown; sinceReadyMs?: unknown };
  }[];
  ledger?: { kind?: unknown; status?: unknown; sinceReadyMs?: unknown }[];
}

interface ReportPayload {
  kind?: unknown;
  url?: unknown;
  comment?: unknown;
  // Radiografía temporal del pago, adjuntada por ESTE server (no la manda el
  // cliente): fases + depósitos + payout + ledger, con timestamps de Luna Negra.
  paymentTimeline?: PaymentTimeline;
  // Fallo de validación de sesión de Luna Negra (401). Lo manda automáticamente el cliente
  // cuando el entitlement no valida; los claims van decodificados SIN verificar (diagnóstico).
  lunaSession?: {
    reason?: unknown;
    hasToken?: unknown;
    tokenExpired?: unknown;
    tokenAgeSec?: unknown;
    secsPastExp?: unknown;
    iss?: unknown;
    aud?: unknown;
    scope?: unknown;
    likelyCause?: unknown;
  };
  device?: { userAgent?: unknown; cores?: unknown; dpr?: unknown; viewport?: unknown; transport?: unknown };
  context?: { appMode?: unknown; roomId?: unknown; players?: unknown; isHost?: unknown };
  betWithdrawal?: {
    roomStatus?: unknown;
    betId?: unknown;
    betStatus?: unknown;
    payoutStatus?: unknown;
    hasWithdrawLnurl?: unknown;
    withdrawHandleVersion?: unknown;
    qrInDom?: unknown;
    qrConnected?: unknown;
    qrComplete?: unknown;
    trace?: unknown[];
    depositStatus?: unknown;
    hasDepositBolt11?: unknown;
    hasDepositZapRequest?: unknown;
    hasDepositCallback?: unknown;
    depositQrInDom?: unknown;
    depositQrConnected?: unknown;
    depositQrComplete?: unknown;
    betBusy?: unknown;
    betPaying?: unknown;
    ngpPushActive?: unknown;
    ngpPushEvents?: unknown;
    ngpPushRefreshes?: unknown;
    ngpPushLastEventAt?: unknown;
  };
  paymentDiagnostic?: {
    stage?: unknown;
    reason?: unknown;
    playerId?: unknown;
    invoiceElapsedMs?: unknown;
    signerElapsedMs?: unknown;
    zapSignElapsedMs?: unknown;
    commentSignElapsedMs?: unknown;
    depositInvoiceElapsedMs?: unknown;
    sinceStartMs?: unknown;
    renderWaitMs?: unknown;
    weblnElapsedMs?: unknown;
    refreshElapsedMs?: unknown;
    sinceCreatedMs?: unknown;
    sinceInvoiceMs?: unknown;
    sinceLastPushMs?: unknown;
  };
  session?: {
    frames?: unknown; spikes?: unknown; longtasks?: unknown; snaps?: unknown;
    b33?: unknown; b50?: unknown; b100?: unknown; b200?: unknown;
    maxLoopMs?: unknown; maxLongtaskMs?: unknown; maxSnapMs?: unknown; durationMs?: unknown;
    worst?: { dur?: unknown; mode?: unknown; sync?: unknown; render?: unknown } | null;
  };
  events?: unknown[];
  errors?: unknown[];
  audio?: {
    muted?: unknown; sfxMuted?: unknown; musicMuted?: unknown;
    sfxVolume?: unknown; musicVolume?: unknown; reverbMode?: unknown; standalone?: unknown;
    music?: { contextState?: unknown; sampleRate?: unknown; playing?: unknown } | null;
    sfx?: {
      mobileProfile?: unknown; detectMobileNow?: unknown; pointerCoarse?: unknown; minViewport?: unknown;
      contextState?: unknown; sampleRate?: unknown; satK?: unknown; driveFactor?: unknown;
      peak?: unknown; clipReads?: unknown; meterReads?: unknown; clipRatio?: unknown;
    } | null;
  };
  marks?: {
    tasksByLabel?: { label?: unknown; count?: unknown; totalMs?: unknown; maxMs?: unknown; avgMs?: unknown; kb?: unknown }[];
    slow?: unknown[];
  };
}

// Resumen legible para el mensaje de Discord (≤2000 chars). El detalle completo va adjunto.
function buildDiscordSummary(report: ReportPayload): string {
  if (report.kind === 'bet-payment-diagnostic') {
    return buildBetPaymentDiagnosticSummary(report);
  }
  // Los reportes de fallo de sesión de Luna Negra no traen métricas de lag: resumen propio.
  if (report.kind === 'luna-session-failure' || report.lunaSession) {
    return buildLunaSessionSummary(report);
  }
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
    buildBetWithdrawalLine(report.betWithdrawal),
    buildPaymentTimelineLine(report.paymentTimeline),
    buildAudioLine(report.audio),
    buildMarksLine(report.marks),
  ].filter((line): line is string => line !== null);
  return lines.join('\n').slice(0, 1990);
}

// Resumen del pago con las duraciones por fase (la respuesta a "¿por qué tardó?"):
// fondeo (crear→listo), liquidación (listo→pagado) y total. Más el detalle del
// premio del/los ganador(es) y el mayor desfase de un asiento del ledger respecto a
// "listo" (revela serialización lenta en la liquidación). null si no hay timeline.
function webhookUrlForReportKind(kind: unknown): string {
  if (kind === 'bet-payment-diagnostic') {
    return (
      process.env.DISCORD_BET_PAYMENT_WEBHOOK_URL?.trim()
      || DEFAULT_BET_PAYMENT_WEBHOOK_URL
      || process.env.DISCORD_WEBHOOK_URL?.trim()
      || ''
    ).trim();
  }
  return (process.env.DISCORD_WEBHOOK_URL ?? '').trim();
}

function buildBetPaymentDiagnosticSummary(report: ReportPayload): string {
  const ctx = report.context ?? {};
  const bet = report.betWithdrawal ?? {};
  const diag = report.paymentDiagnostic ?? {};
  const dev = report.device ?? {};
  const traceCount = Array.isArray(bet.trace) ? bet.trace.length : 0;
  const lines = [
    '⚡ **Diagnóstico automático de pago Tetra**',
    `etapa=\`${str(diag.stage)}\` motivo=\`${str(diag.reason)}\``,
    `sala=\`${str(ctx.roomId)}\` bet=\`${str(bet.betId)}\` player=\`${str(diag.playerId)}\` host=${str(ctx.isHost)}`,
    `room=${str(bet.roomStatus)} betStatus=${str(bet.betStatus)} deposit=${str(bet.depositStatus)} handles: bolt11=${str(bet.hasDepositBolt11)} zapReq=${str(bet.hasDepositZapRequest)} cb=${str(bet.hasDepositCallback)}`,
    `qr: dom=${str(bet.depositQrInDom)} connected=${str(bet.depositQrConnected)} complete=${str(bet.depositQrComplete)} paying=${str(bet.betPaying)} busy=${str(bet.betBusy)}`,
    `ngpPush: active=${str(bet.ngpPushActive)} events=${str(bet.ngpPushEvents)} refreshes=${str(bet.ngpPushRefreshes)} last=${str(bet.ngpPushLastEventAt)} trace=${traceCount}`,
    `firma: signer=${ms(diag.signerElapsedMs)} zap=${ms(diag.zapSignElapsedMs)} comment=${ms(diag.commentSignElapsedMs)} request=${ms(diag.depositInvoiceElapsedMs)} renderWait=${ms(diag.renderWaitMs)} sinceStart=${ms(diag.sinceStartMs)}`,
    `latencias: invoice=${ms(diag.invoiceElapsedMs)} webln=${ms(diag.weblnElapsedMs)} refresh=${ms(diag.refreshElapsedMs)} sinceCreated=${ms(diag.sinceCreatedMs)} sinceInvoice=${ms(diag.sinceInvoiceMs)} sincePush=${ms(diag.sinceLastPushMs)}`,
    `cliente: ${str(dev.viewport)} cores=${str(dev.cores)} dpr=${str(dev.dpr)} transport=${str(dev.transport)}`,
    buildPaymentTimelineLine(report.paymentTimeline),
  ].filter((line): line is string => line !== null);
  return lines.join('\n').slice(0, 1990);
}

function buildPaymentTimelineLine(tl: ReportPayload['paymentTimeline']): string | null {
  if (!tl || typeof tl !== 'object') return null;
  const secs = (v: unknown): string => (typeof v === 'number' ? `${(v / 1000).toFixed(1)}s` : '—');
  const ph = tl.phases ?? {};
  const winners = (Array.isArray(tl.participants) ? tl.participants : []).filter(
    (p) => p?.result === 'won' || p?.result === 'tie',
  );
  const winStr = winners.length
    ? winners
        .map((w) => {
          const kind = str(w.payout?.kind);
          const sats = typeof w.payout?.sats === 'number' ? w.payout.sats : '—';
          return `${sats} sats vía ${kind} en ${secs(w.payout?.sinceReadyMs)}`;
        })
        .join(', ')
    : '—';
  const ledger = Array.isArray(tl.ledger) ? tl.ledger : [];
  const maxLedger = ledger.reduce(
    (max, e) => (typeof e?.sinceReadyMs === 'number' && e.sinceReadyMs > max ? e.sinceReadyMs : max),
    0,
  );
  return (
    `⏳ pago \`${str(tl.status)}\`: fondeo=${secs(ph.fundingMs)} liquidación=${secs(ph.settlementMs)} total=${secs(ph.totalMs)}` +
    ` · ganador: ${winStr} · últ.asiento=+${secs(maxLedger)}`
  );
}

// Resumen de un fallo de validación de sesión de Luna Negra (401). La línea clave es
// `causa probable`: la deriva el cliente de si el token ya estaba vencido (expiración,
// benigno) o seguía vigente (firma/baseURL mismatch → revisar LUNA_NEGRA_BASE_URL).
function buildLunaSessionSummary(report: ReportPayload): string {
  const ls = report.lunaSession ?? {};
  const bool = (v: unknown): string => (v === true ? 'sí' : v === false ? 'no' : '—');
  const lines = [
    '🔒 **Sesión de Luna Negra rechazada (401)**',
    `💬 ${str(ls.reason)}`,
    `🎯 causa probable: **${str(ls.likelyCause)}**`,
    `🎟️ token: presente=${bool(ls.hasToken)} vencido=${bool(ls.tokenExpired)} edad=${str(ls.tokenAgeSec)}s pasado_exp=${str(ls.secsPastExp)}s`,
    `🏷️ iss=\`${str(ls.iss)}\` aud=\`${str(ls.aud)}\` scope=\`${str(ls.scope)}\``,
    `🔗 ${str(report.url)}`,
    `🖥️ ${str(report.device?.userAgent)}`,
  ];
  return lines.join('\n').slice(0, 1990);
}

function buildBetWithdrawalLine(bet: ReportPayload['betWithdrawal']): string | null {
  if (!bet || typeof bet !== 'object') return null;
  const bool = (value: unknown): string => value === true ? 'sí' : value === false ? 'no' : '—';
  const traceCount = Array.isArray(bet.trace) ? bet.trace.length : 0;
  return `⚡ retiro: room=${str(bet.roomStatus)} bet=${str(bet.betStatus)} payout=${str(bet.payoutStatus)} LNURL=${bool(bet.hasWithdrawLnurl)} QR=${bool(bet.qrInDom)}/${bool(bet.qrConnected)} v=${str(bet.withdrawHandleVersion)} eventos=${traceCount}`;
}

// Atribución del trabajo fuera de rAF (mensajes peer / poll). Mostramos las 3 etiquetas que más
// tiempo total acumularon (la pista de qué bloquea el main thread del cliente). null si no hay datos.
function buildMarksLine(marks: ReportPayload['marks']): string | null {
  const tasks = Array.isArray(marks?.tasksByLabel) ? marks!.tasksByLabel! : [];
  if (tasks.length === 0) return null;
  const numOf = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const top = tasks
    .slice()
    .sort((a, b) => numOf(b.totalMs) - numOf(a.totalMs))
    .slice(0, 3)
    .map((t) => `${str(t.label)} ×${numOf(t.count)} (Σ${numOf(t.totalMs)}ms, max ${numOf(t.maxMs)}ms)`);
  return `🔍 fuera de rAF: ${top.join(' · ')}`;
}

// Línea de audio: lo crítico para el "suena mal en el celular". La clave es si el
// perfil móvil se activó (si es false en un teléfono, suena el drive áspero de
// desktop) y si la salida recorta de verdad (peak≥1 / clipReads>0). null si no hay datos.
function buildAudioLine(audio: ReportPayload['audio']): string | null {
  if (!audio || typeof audio !== 'object') return null;
  const sfx = audio.sfx ?? null;
  const num = (v: unknown): string => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : '—');
  const bool = (v: unknown): string => (v === true ? 'sí' : v === false ? 'no' : '—');
  const profile = sfx
    ? `móvil=${bool(sfx.mobileProfile)} (coarse=${bool(sfx.pointerCoarse)} minVp=${num(sfx.minViewport)}) drive=${num(sfx.driveFactor)} satK=${num(sfx.satK)}`
    : '—';
  const meter = sfx
    ? `pico=${num(sfx.peak)} recortes=${num(sfx.clipReads)}/${num(sfx.meterReads)}`
    : '—';
  const mix = `sfx=${num(audio.sfxVolume)}${audio.sfxMuted ? '(mute)' : ''} mus=${num(audio.musicVolume)}${audio.musicMuted ? '(mute)' : ''} pwa=${bool(audio.standalone)} sr=${num(sfx?.sampleRate)}`;
  return `🔊 ${profile} · ${meter} · ${mix}`;
}

function str(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  return String(v).slice(0, 80);
}

function ms(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}ms` : 'â€”';
}
