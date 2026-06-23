// Núcleo de "tetra status": consulta el uso real de cada servicio externo que usa la
// producción y lo compara contra los límites de su plan. Cada probe es best-effort y
// degrada con gracia: si falta el token o la API falla, devuelve 'unknown'/'error' sin
// tumbar al resto (todos corren en paralelo).
//
// Los LÍMITES de abajo son los del FREE TIER. Si subís de plan, editá las constantes.

export type CheckStatus = 'ok' | 'warn' | 'critical' | 'unknown' | 'error';

export interface Metric {
  label: string;
  /** Valor medido. null = no se pudo obtener (sin token / API caída). */
  used: number | null;
  /** Tope del plan. null = métrica informativa sin límite duro. */
  limit: number | null;
  /** Unidad para formateo en la UI: 'bytes' o undefined (cantidad). */
  unit?: 'bytes';
  /** Ventana de la métrica ('día', 'mes', ...). */
  period?: string;
  /** Porcentaje usado (1 decimal) o null si no aplica. */
  pct: number | null;
}

export interface ServiceCheck {
  id: string;
  name: string;
  /** ¿Hay credenciales/URL para este servicio en este entorno? */
  configured: boolean;
  status: CheckStatus;
  dashboardUrl?: string;
  metrics: Metric[];
  note?: string;
  error?: string;
}

export interface StatusReport {
  generatedAtMs: number;
  services: ServiceCheck[];
}

// --- Límites del free tier (ajustá si cambiás de plan) ---
const CF_WORKERS_REQUESTS_PER_DAY = 100_000; // Workers Free: 100k requests/día
const CF_DO_REQUESTS_PER_DAY = 100_000; // Durable Objects incluidos en Workers Free
const UPSTASH_MAX_BYTES = 256 * 1024 * 1024; // Free tier: 256 MB de datos

// Umbrales para colorear: <70% ok, 70–90% warn, ≥90% crítico.
const WARN_PCT = 70;
const CRITICAL_PCT = 90;

export async function buildStatusReport(): Promise<StatusReport> {
  const [cloudflare, upstash, luna] = await Promise.all([
    checkCloudflare(),
    checkUpstash(),
    checkLunaNegra(),
  ]);
  return {
    generatedAtMs: Date.now(),
    services: [cloudflare, upstash, checkVercel(), luna, checkDiscord()],
  };
}

// --- Cloudflare Workers + Durable Objects (lo que más roza el límite hoy) ---
async function checkCloudflare(): Promise<ServiceCheck> {
  const id = 'cloudflare';
  const name = 'Cloudflare Workers + Durable Objects';
  const token = (process.env.CLOUDFLARE_API_TOKEN ?? '').trim();
  const account = (process.env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  const dashboardUrl = account
    ? `https://dash.cloudflare.com/${account}/workers/services/view/tetra/production/metrics`
    : 'https://dash.cloudflare.com/';
  if (!token || !account) {
    return {
      id, name, configured: false, status: 'unknown', dashboardUrl, metrics: [],
      note: 'Falta CLOUDFLARE_API_TOKEN y/o CLOUDFLARE_ACCOUNT_ID para ver uso en vivo.',
    };
  }

  const { start, end } = todayUtcRange();
  const metrics: Metric[] = [];
  let error: string | undefined;

  // Requests del Worker hoy = la métrica crítica contra el límite diario.
  try {
    const requests = await cfWorkersRequests(token, account, start, end);
    metrics.push(metric('Requests del Worker (hoy)', requests, CF_WORKERS_REQUESTS_PER_DAY));
  } catch (e) {
    error = errText(e);
  }

  // Requests a Durable Objects: best-effort (si el campo cambia, no rompe lo de arriba).
  try {
    const doRequests = await cfDurableObjectRequests(token, account, start, end);
    metrics.push(metric('Requests a Durable Objects (hoy)', doRequests, CF_DO_REQUESTS_PER_DAY));
  } catch {
    // Silencioso: la métrica de DO es secundaria.
  }

  const status = metrics.length === 0
    ? (error ? 'error' : 'unknown')
    : worst(...metrics.map((m) => statusFromPct(m.pct)));
  return {
    id, name, configured: true, status, dashboardUrl, metrics, error,
    note: 'Storage SQLite de los DO: revisalo en el dashboard (free tier 5 GB).',
  };
}

async function cfWorkersRequests(token: string, account: string, start: string, end: string): Promise<number> {
  const data = await cfGraphql<CfWorkersData>(token, `
    query($tag:String!,$start:Time!,$end:Time!){
      viewer{ accounts(filter:{accountTag:$tag}){
        workersInvocationsAdaptive(limit:10000, filter:{datetime_geq:$start, datetime_leq:$end}){
          sum{ requests }
        }
      }}
    }`, { tag: account, start, end });
  const groups = data.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  return groups.reduce((acc, g) => acc + (g.sum?.requests ?? 0), 0);
}

async function cfDurableObjectRequests(token: string, account: string, start: string, end: string): Promise<number> {
  const data = await cfGraphql<CfDoData>(token, `
    query($tag:String!,$start:Time!,$end:Time!){
      viewer{ accounts(filter:{accountTag:$tag}){
        durableObjectsInvocationsAdaptiveGroups(limit:10000, filter:{datetime_geq:$start, datetime_leq:$end}){
          sum{ requests }
        }
      }}
    }`, { tag: account, start, end });
  const groups = data.viewer?.accounts?.[0]?.durableObjectsInvocationsAdaptiveGroups ?? [];
  return groups.reduce((acc, g) => acc + (g.sum?.requests ?? 0), 0);
}

interface CfSumGroup { sum?: { requests?: number } }
interface CfWorkersData { viewer?: { accounts?: { workersInvocationsAdaptive?: CfSumGroup[] }[] } }
interface CfDoData { viewer?: { accounts?: { durableObjectsInvocationsAdaptiveGroups?: CfSumGroup[] }[] } }

async function cfGraphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetchWithTimeout('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  }, 8000);
  const payload = await response.json() as { data?: T; errors?: { message?: string }[] };
  if (!response.ok) throw new Error(`Cloudflare HTTP ${response.status}`);
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(payload.errors[0]?.message ?? 'GraphQL error');
  }
  if (!payload.data) throw new Error('Cloudflare devolvió respuesta vacía.');
  return payload.data;
}

// --- Upstash Redis (store de salas legacy; fallback fuera de Cloudflare) ---
async function checkUpstash(): Promise<ServiceCheck> {
  const id = 'upstash';
  const name = 'Upstash Redis (salas legacy)';
  const url = (process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? '').trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? '').trim();
  const dashboardUrl = 'https://console.upstash.com/';
  if (!url || !token) {
    return {
      id, name, configured: false, status: 'unknown', dashboardUrl, metrics: [],
      note: 'No configurado acá (el online con apuestas usa Cloudflare, no Upstash). Si sigue sin usarse, se puede quitar del proyecto.',
    };
  }

  const metrics: Metric[] = [];
  let error: string | undefined;
  try {
    const keys = await upstashCommand<number>(url, token, ['DBSIZE']);
    metrics.push({ label: 'Claves almacenadas', used: Number(keys) || 0, limit: null, pct: null });
  } catch (e) {
    error = errText(e);
  }
  try {
    const info = await upstashCommand<string>(url, token, ['INFO']);
    const used = parseUsedMemory(info);
    if (used !== null) metrics.push(metric('Memoria usada', used, UPSTASH_MAX_BYTES, 'bytes', 'total'));
  } catch {
    // INFO puede no estar habilitado en algunos planes: lo dejamos pasar.
  }

  const status = metrics.length === 0
    ? (error ? 'error' : 'unknown')
    : worst(...metrics.map((m) => statusFromPct(m.pct)));
  return {
    id, name, configured: true, status, dashboardUrl, metrics, error,
    note: 'Cuota de comandos/día: revisala en el dashboard (free ~10k/día); no se expone por la API de Redis.',
  };
}

async function upstashCommand<T>(url: string, token: string, command: unknown[]): Promise<T> {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  }, 6000);
  const payload = await response.json() as { result?: T; error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? `Upstash HTTP ${response.status}`);
  return payload.result as T;
}

function parseUsedMemory(info: string): number | null {
  const match = /used_memory:(\d+)/.exec(info);
  return match ? Number(match[1]) : null;
}

// --- Vercel: el plan Hobby no expone uso por API; informamos y linkeamos al dashboard ---
function checkVercel(): ServiceCheck {
  const env = (process.env.VERCEL_ENV ?? '').trim() || 'local';
  return {
    id: 'vercel',
    name: 'Vercel (frontend + funciones)',
    configured: true,
    status: 'unknown',
    dashboardUrl: 'https://vercel.com/dashboard/usage',
    metrics: [],
    note: `Plan Hobby: el uso no se expone por API. Entorno=${env}, región=gru1. Revisá ancho de banda e invocaciones en el dashboard (Usage).`,
  };
}

// --- Luna Negra: backend propio (SSO/apuestas). Chequeo de conectividad, no de cuota ---
async function checkLunaNegra(): Promise<ServiceCheck> {
  const id = 'luna-negra';
  const name = 'Luna Negra (backend SSO/apuestas)';
  const base = (process.env.LUNA_NEGRA_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!base) {
    return {
      id, name, configured: false, status: 'unknown', metrics: [],
      note: 'Falta LUNA_NEGRA_BASE_URL.',
    };
  }
  const started = Date.now();
  try {
    const response = await fetchWithTimeout(`${base}/api/health`, { method: 'GET' }, 6000);
    const ms = Date.now() - started;
    // Cualquier respuesta HTTP = alcanzable. Solo un 5xx lo marcamos como degradado.
    const status: CheckStatus = response.status >= 500 ? 'warn' : 'ok';
    return {
      id, name, configured: true, status, dashboardUrl: base, metrics: [],
      note: `Alcanzable: HTTP ${response.status} en ${ms} ms.`,
    };
  } catch (e) {
    return {
      id, name, configured: true, status: 'error', dashboardUrl: base, metrics: [],
      note: 'No responde (timeout o red caída).', error: errText(e),
    };
  }
}

// --- Discord webhook (reportes) ---
function checkDiscord(): ServiceCheck {
  const configured = Boolean((process.env.DISCORD_WEBHOOK_URL ?? '').trim());
  return {
    id: 'discord',
    name: 'Discord webhook (reportes)',
    configured,
    status: configured ? 'ok' : 'unknown',
    metrics: [],
    note: configured
      ? 'Configurado. Límite del webhook: 30 mensajes/min (no medible por API).'
      : 'Falta DISCORD_WEBHOOK_URL (el botón Reportar queda inactivo).',
  };
}

// --- helpers ---
function metric(label: string, used: number | null, limit: number | null, unit?: 'bytes', period = 'día'): Metric {
  return { label, used, limit, unit, period, pct: pct(used, limit) };
}

function pct(used: number | null, limit: number | null): number | null {
  if (used === null || limit === null || limit <= 0) return null;
  return Math.round((used / limit) * 1000) / 10;
}

function statusFromPct(p: number | null): CheckStatus {
  if (p === null) return 'unknown';
  if (p >= CRITICAL_PCT) return 'critical';
  if (p >= WARN_PCT) return 'warn';
  return 'ok';
}

const STATUS_RANK: Record<CheckStatus, number> = { unknown: 0, ok: 1, warn: 3, error: 4, critical: 5 };
function worst(...statuses: CheckStatus[]): CheckStatus {
  let result: CheckStatus = 'unknown';
  for (const status of statuses) {
    if (STATUS_RANK[status] > STATUS_RANK[result]) result = status;
  }
  return result;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function todayUtcRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  return { start: start.toISOString(), end: now.toISOString() };
}

function errText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
