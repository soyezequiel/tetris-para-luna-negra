import { OnlineRoomError } from './roomService.js';
import { ngeConnected, ngeClientPubkey } from './lunaNegraNge.js';
import type { RoomBet, RoomBetParticipant } from './protocol';

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
  // Gate REAL de apuestas en NGE v2: la credencial del escrow. Las viejas env vars
  // REST 1.0 (LUNA_NEGRA_API_KEY/GAME_ID) ya NO gatean el flujo de plata.
  hasNgeConnection: boolean;
  ngeClientPubkey: string | null;
  hasBaseUrl: boolean;
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
    hasNgeConnection: ngeConnected(),
    ngeClientPubkey: ngeClientPubkey(),
    // BASE_URL sigue viva: arma el link web de reclamo de retiro del ganador invitado.
    hasBaseUrl: Boolean((process.env.LUNA_NEGRA_BASE_URL ?? '').trim()),
    hasPartyBridgeToken,
    hasUpstash,
  };
}

function tick(ok: boolean): string {
  return ok ? '✅' : '❌';
}

/**
 * Bloque "Para Claude Code": prompt auto-contenido y copy-pasteable para que el
 * operador lo pegue en Claude Code y éste diagnostique/arregle. Política del
 * canal: todo lo que llega a Discord debe traer una acción posible.
 */
function claudeCodeBlock(summary: string, context: Record<string, unknown>): string {
  const ctx = Object.entries(context)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
    .join(', ');
  const text =
    `En el repo Tetris (F:\\proyectos\\tetris): ${summary}.` +
    (ctx ? ` Contexto: ${ctx}.` : '') +
    ' Encontrá la causa raíz y arreglala.';
  return `📋 Para Claude Code:\n\`\`\`\n${text.slice(0, 700)}\n\`\`\``;
}

// Discord corta el content en 2000 chars: recorta las líneas del cuerpo lo
// necesario para que el bloque de prompt SIEMPRE entre completo al final.
function composeWithPrompt(lines: string[], promptBlock: string): string {
  const budget = 1990 - promptBlock.length - 1;
  return `${lines.join('\n').slice(0, Math.max(0, budget))}\n${promptBlock}`;
}

/**
 * Líneas de diagnóstico para la alerta: un snapshot de config (qué store se está
 * usando y qué env vars faltan) y, cuando el fallo es un 404 de "sala no encontrada",
 * una pista de la causa raíz más probable (mismatch de transporte / env vars ausentes
 * en este entorno). El objetivo es que la alerta baste para saber *qué configurar*
 * sin ir a leer el código.
 */
function diagnosticLines(info: ErrorInfo, cfg: MoneyPathConfig): string[] {
  const shortPk = cfg.ngeClientPubkey
    ? `${cfg.ngeClientPubkey.slice(0, 8)}…${cfg.ngeClientPubkey.slice(-4)}`
    : '—';
  const lines: string[] = [
    `🔧 store apuestas=\`${cfg.betStore}\` · NGE_CONNECTION ${tick(cfg.hasNgeConnection)}`
    + ` · cliente=\`${shortPk}\` · BASE_URL ${tick(cfg.hasBaseUrl)}`,
  ];

  // Credencial rechazada por el escrow (§6): el request se firmó y descifró bien, pero
  // la pubkey del cliente no tiene credencial emitida. Suele ser (a) credencial rotada/
  // borrada del lado Luna, o (b) el escrow reinició y todavía no cargó su registro
  // (transitorio: el reintento con backoff de createNgeBet ya suele resolverlo).
  const unauthorized = info.code === 'UNAUTHORIZED' || /no autorizado|credencial rotada/i.test(info.message);
  if (unauthorized) {
    lines.push(
      `💡 El escrow NGE rechazó la credencial del cliente (\`${shortPk}\`). Si es intermitente,`
      + ' el escrow estaba reiniciando (transitorio). Si persiste, la credencial fue rotada'
      + ' o borrada del lado Luna Negra: re-emitíla y actualizá `NGE_CONNECTION` en Vercel'
      + ' (tetris) con la nueva URI. No dependas de `LUNA_NEGRA_API_KEY/GAME_ID`: son REST 1.0'
      + ' y ya no gatean apuestas.',
    );
  }

  const escrowSilent = info.code === 'TIMEOUT' || /no respondió|no se pudo leer get_info/i.test(info.message);
  if (escrowSilent && !unauthorized) {
    lines.push(
      '💡 El escrow NGE no respondió por los relays a tiempo. Probablemente esté caído o'
      + ' inalcanzable (Luna Negra corre en la laptop por SSH): verificá que el proceso del'
      + ' escrow esté vivo y que los relays de `NGE_CONNECTION` sean alcanzables.',
    );
  }

  if (!cfg.hasNgeConnection) {
    lines.push(
      '⚠ Falta `NGE_CONNECTION` en este entorno: sin la credencial del escrow no hay apuestas'
      + ' (modo NGE v2). Seteala en Vercel para ESTE deploy.',
    );
  }

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
    const prompt = claudeCodeBlock(
      `falló el flujo de apuestas "${flow}" — ${info.code ? `${info.code}: ` : ''}${info.message.slice(0, 200)}`,
      context,
    );

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: composeWithPrompt(lines, prompt) }),
    });
  } catch {
    // Best-effort: un fallo al alertar nunca debe tapar/alterar el error original.
  }
}

// Webhook del reporte de depósito de apuesta. Prioriza uno dedicado y cae a los del
// resto de alertas. Vive SOLO en el server (nunca se expone al cliente).
function betReportWebhookUrl(): string {
  return (
    process.env.DISCORD_BET_REPORT_WEBHOOK_URL
    ?? process.env.DISCORD_ALERT_WEBHOOK_URL
    ?? process.env.DISCORD_WEBHOOK_URL
    ?? ''
  ).trim();
}

// ¿Este participante quedó SIN forma de depositar dentro del juego? Necesita, mientras
// su depósito está pendiente, o un `bolt11` ya emitido (QR + copiar + extensión) o el
// par `depositZapRequest` + `depositCallback` (el 9734 sin firmar para firmarlo en el
// juego). Sin ninguno, el panel cae al fallback "Pagar en Luna Negra" (payUrl) y no hay
// QR/zap en el Tetris.
function depositHandlesIncomplete(p: RoomBetParticipant): boolean {
  return (
    p.depositStatus === 'pending'
    && !p.bolt11
    && !(p.depositZapRequest && p.depositCallback)
  );
}

/**
 * Reporte a Discord cuando una apuesta recién CREADA no trae, para algún participante
 * pendiente, los handles de depósito completos (ni `bolt11` ni `depositZapRequest`+
 * `depositCallback`). Detalla por participante qué vino y qué falta, más un snapshot de
 * config, para cazar regresiones (Luna sin identidad Nostr y sin devolver el 9734,
 * función corriendo código viejo por build cache de Vercel, env vars ausentes, etc.).
 * No fira si vino todo completo. Best-effort: nunca lanza.
 */
export async function alertBetDepositHandlesIncomplete(
  bet: RoomBet,
  context: Record<string, unknown> = {},
): Promise<void> {
  const webhookUrl = betReportWebhookUrl();
  if (!webhookUrl) return;
  // Solo mientras se esperan depósitos: en terminales/fondeadas no hay handles que emitir.
  if (bet.status !== 'pending_deposits') return;

  const incomplete = bet.participants.filter(depositHandlesIncomplete);
  if (incomplete.length === 0) return; // vino todo lo que tenía que venir → no molestamos

  try {
    const nowMs = Date.now();
    // Una alerta por apuesta (no por cada poll/refresh que la recree).
    if (shouldThrottle(`bet-handles:${bet.betId}`, nowMs)) return;

    const env = (process.env.VERCEL_ENV ?? 'dev').trim() || 'dev';
    const short = (npub: string): string =>
      npub.length > 18 ? `${npub.slice(0, 12)}…${npub.slice(-4)}` : npub;
    const partLines = bet.participants.map((p) => {
      const flags = [
        `bolt11 ${tick(!!p.bolt11)}`,
        `zapReq ${tick(!!p.depositZapRequest)}`,
        `callback ${tick(!!p.depositCallback)}`,
        `lnurl ${tick(!!p.lnurl)}`,
        `payUrl ${tick(!!p.payUrl)}`,
      ].join(' · ');
      const err = p.depositError ? ` · ⚠ ${p.depositError.slice(0, 120)}` : '';
      const flag = depositHandlesIncomplete(p) ? '🔴' : '🟢';
      return `${flag} \`${short(p.npub)}\` [${p.depositStatus}] ${flags}${err}`;
    });

    const cfg = readMoneyPathConfig();
    const ctxLine = Object.entries(context)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([k, value]) => `${k}=\`${String(value).slice(0, 60)}\``)
      .join(' · ');
    const lines = [
      `🧾 **Apuesta creada SIN handles de depósito completos** (${env})`,
      `📍 betId=\`${bet.betId}\` · stake=\`${bet.stakeSats}\` sats · estado=\`${bet.status}\` · ${incomplete.length}/${bet.participants.length} incompletos`,
      ctxLine ? `📎 ${ctxLine}` : null,
      '👥 Participantes:',
      ...partLines,
      `🔧 store=\`${cfg.betStore}\` · NGE_CONNECTION ${tick(cfg.hasNgeConnection)} · BASE_URL ${tick(cfg.hasBaseUrl)}`,
      '💡 Sin `bolt11` ni (`zapReq`+`callback`) el panel cae a "Pagar en Luna Negra" (payUrl): no hay QR/zap en el juego. Causas típicas: Luna no devolvió el 9734 (tienda sin identidad Nostr o `depositZapRequest` ausente en su respuesta) o la función corre código viejo (build cache de Vercel).',
      `🕒 ${new Date(nowMs).toISOString()}`,
    ].filter((line): line is string => line !== null);
    const prompt = claudeCodeBlock(
      `una apuesta recién creada quedó sin handles de depósito (${incomplete.length}/${bet.participants.length} asientos sin bolt11 ni 9734+callback)`,
      { betId: bet.betId, stakeSats: bet.stakeSats, ...context },
    );

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: composeWithPrompt(lines, prompt) }),
    });
  } catch {
    // Best-effort: el reporte nunca debe afectar la creación de la apuesta.
  }
}
