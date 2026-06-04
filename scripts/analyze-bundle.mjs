import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { mkdir } from 'node:fs/promises';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = resolve(repoRoot, 'dist');
const outputPath = resolve(repoRoot, '.codex-output', 'bundle-stats.json');
const gzipExtensions = new Set(['.css', '.html', '.js', '.json', '.svg', '.txt']);

const files = await collectFiles(distRoot);
const entries = await Promise.all(files.map(toBundleEntry));
entries.sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file));

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    distRoot,
    entries,
    totals: {
      bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      gzipBytes: entries.reduce((total, entry) => total + (entry.gzipBytes ?? 0), 0),
    },
  }, null, 2)}\n`,
);

console.log(`Bundle stats written to ${relative(repoRoot, outputPath)}`);
console.table(entries.map((entry) => ({
  file: entry.file,
  size: formatBytes(entry.bytes),
  gzip: entry.gzipBytes === null ? '-' : formatBytes(entry.gzipBytes),
})));

async function collectFiles(dir) {
  const children = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(children.map(async (child) => {
    const childPath = resolve(dir, child.name);
    if (child.isDirectory()) return collectFiles(childPath);
    if (child.isFile()) return [childPath];
    return [];
  }));
  return nested.flat();
}

async function toBundleEntry(filePath) {
  const [{ size }, buffer] = await Promise.all([stat(filePath), readFile(filePath)]);
  const file = toPosixPath(relative(distRoot, filePath));
  const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
  return {
    file,
    bytes: size,
    gzipBytes: gzipExtensions.has(extension) ? gzipSync(buffer).length : null,
  };
}

function toPosixPath(value) {
  return value.replace(/\\/g, '/');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(2)} kB`;
}
