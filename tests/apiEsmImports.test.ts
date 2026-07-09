import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// Guardarraíl de deploy. Las funciones de `api/` corren en Vercel como ESM de Node SIN
// empaquetar: los specifiers quedan tal cual y Node exige extensión explícita en los
// imports relativos. Un `from './x'` (sin `.js`) tira ERR_MODULE_NOT_FOUND al importar
// el módulo y voltea la función ENTERA — todas sus rutas devuelven 500
// FUNCTION_INVOCATION_FAILED, incluso las que no tocan ese código.
//
// Es una trampa silenciosa: Vite y Vitest resuelven sin extensión, así que el build y la
// suite pasan en verde mientras producción está caída. Pasó de verdad: f6a0b98 metió
// `from './nostrRelays'` en nostrAttestation.ts (alcanzable desde api/bets/*) y dejó las
// apuestas muertas en prod con typecheck, tests y build todos verdes.
//
// Los imports SOLO de tipo (`import type`) se borran en compilación: no aplican.
// Los módulos que solo toca el navegador tampoco: a esos los empaqueta Vite. Por eso el
// test recorre el grafo real desde `api/` en vez de barrer todo `src/`.

const API_DIR = resolve(__dirname, '../api');
const ROOT = resolve(__dirname, '..');

function tsFilesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesIn(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Resuelve un specifier relativo (con o sin `.js`) al archivo `.ts` fuente. */
function resolveToSource(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const IMPORT_RE = /^import\s+(type\s+)?([\s\S]*?)from\s+'(\.[^']*)';/gm;

interface RelativeImport {
  specifier: string;
  typeOnly: boolean;
  line: number;
}

function relativeImports(source: string): RelativeImport[] {
  const found: RelativeImport[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const typeOnly = Boolean(match[1]) || /^\s*type\s/.test(match[2]);
    found.push({
      specifier: match[3],
      typeOnly,
      line: source.slice(0, match.index).split('\n').length,
    });
  }
  return found;
}

/** Camina el grafo de imports desde los entrypoints de `api/` y junta las ofensas. */
function crawlApiGraph(): { offenses: string[]; visited: Set<string> } {
  const visited = new Set<string>();
  const offenses: string[] = [];

  const visit = (file: string): void => {
    if (visited.has(file) || !existsSync(file)) return;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const imp of relativeImports(source)) {
      if (!imp.typeOnly && !imp.specifier.endsWith('.js')) {
        const where = relative(ROOT, file).replace(/\\/g, '/');
        offenses.push(`${where}:${imp.line} → '${imp.specifier}' (falta .js)`);
      }
      const resolved = resolveToSource(file, imp.specifier);
      if (resolved) visit(resolved);
    }
  };

  tsFilesIn(API_DIR).forEach(visit);
  return { offenses, visited };
}

describe('imports ESM de las funciones serverless', () => {
  it('todo import relativo de valor alcanzable desde api/ lleva extensión .js', () => {
    expect(crawlApiGraph().offenses).toEqual([]);
  });

  it('el crawler cruza de api/ a src/ (si no, el test de arriba pasaría vacío para siempre)', () => {
    const visited = [...crawlApiGraph().visited].map((file) => relative(ROOT, file).replace(/\\/g, '/'));
    // nostrAttestation es transitivo (api/bets → lunaNegraBets → nostrAttestation): que
    // aparezca prueba que el grafo se sigue en profundidad, no solo los entrypoints.
    expect(visited).toContain('src/online/nostrAttestation.ts');
    expect(visited.length).toBeGreaterThan(10);
  });
});
