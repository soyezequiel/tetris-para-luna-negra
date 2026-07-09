#!/usr/bin/env node
// Imprime la PUBKEY del oráculo de atestaciones (NGP kind:31338): la derivada de
// NGP_ATTESTATION_ORACLE_NSEC (del entorno o .env/.env.local). Es lo que se pega
// en la card "Oráculo de atestaciones" del panel de proveedor de Luna Negra.
// Solo imprime la clave PÚBLICA — la nsec nunca sale de esta máquina.
//
// Uso:
//   node scripts/attestation-oracle-pubkey.mjs
import { readFileSync, existsSync } from 'node:fs';
import { getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

function readEnvVar(name) {
  if (process.env[name]) return process.env[name].trim();
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return '';
}

function decodeSecret(raw) {
  if (raw.startsWith('nsec')) {
    const d = nip19.decode(raw);
    if (d.type !== 'nsec') throw new Error('NGP_ATTESTATION_ORACLE_NSEC no es un nsec válido');
    return d.data;
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) return Uint8Array.from(Buffer.from(raw, 'hex'));
  throw new Error('NGP_ATTESTATION_ORACLE_NSEC debe ser un nsec bech32 o 32 bytes hex');
}

const raw = readEnvVar('NGP_ATTESTATION_ORACLE_NSEC');
if (!raw) {
  console.error('Falta NGP_ATTESTATION_ORACLE_NSEC (en el entorno o en .env/.env.local).');
  process.exit(1);
}

const pubkey = getPublicKey(decodeSecret(raw));
console.error('Pegá cualquiera de las dos en la card "Oráculo de atestaciones" de Luna Negra:');
console.log(`hex:  ${pubkey}`);
console.log(`npub: ${nip19.npubEncode(pubkey)}`);
