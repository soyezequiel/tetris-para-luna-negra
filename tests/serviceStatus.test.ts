import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildStatusReport } from '../src/online/serviceStatus.js';

// Variables que los probes leen; las limpiamos para forzar el camino "no configurado"
// (que NO hace ninguna llamada de red, así el test es determinístico y offline).
const ENV_KEYS = [
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN',
  'LUNA_NEGRA_BASE_URL', 'DISCORD_WEBHOOK_URL', 'VERCEL_ENV',
];

describe('buildStatusReport', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  it('reporta los 5 servicios y degrada con gracia sin credenciales', async () => {
    const report = await buildStatusReport();
    const ids = report.services.map((s) => s.id).sort();
    expect(ids).toEqual(['cloudflare', 'discord', 'luna-negra', 'upstash', 'vercel']);

    const byId = Object.fromEntries(report.services.map((s) => [s.id, s]));
    // Sin tokens, los probes externos quedan 'no configurado' sin tocar la red.
    expect(byId.cloudflare.configured).toBe(false);
    expect(byId.cloudflare.status).toBe('unknown');
    expect(byId.upstash.configured).toBe(false);
    expect(byId['luna-negra'].configured).toBe(false);
    expect(byId.discord.configured).toBe(false);
    // Vercel siempre se reporta (no necesita token), como 'unknown' informativo.
    expect(byId.vercel.configured).toBe(true);
    expect(byId.vercel.status).toBe('unknown');

    expect(typeof report.generatedAtMs).toBe('number');
  });

  it('marca Discord ok cuando hay webhook', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.example/webhook';
    const report = await buildStatusReport();
    const discord = report.services.find((s) => s.id === 'discord');
    expect(discord?.configured).toBe(true);
    expect(discord?.status).toBe('ok');
  });
});
