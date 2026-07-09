#!/usr/bin/env node
// Genera la PRUEBA DE POSESIÓN de la clave del oráculo de atestaciones (NGP
// kind:31338) para declararla en Luna Negra.
//
// Uso:
//   node scripts/attestation-oracle-proof.mjs "<reto>"
//
// El <reto> lo muestra la card "Oráculo de atestaciones" del panel de proveedor
// de Luna Negra (formato `luna-negra:attestation-oracle:claim:<gameId>`). El
// script firma un evento con ese content usando LUNA_NEGRA_NGP_NSEC del .env —
// la MISMA clave con la que el server firma los 31338 — e imprime el JSON para
// pegar en la card. La clave nunca sale de esta máquina: solo viaja la firma.
//
// La prueba vence a los 5 minutos (anti-replay): generala y pegala en el momento.
import { readFileSync, existsSync } from 'node:fs';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
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
    if (d.type !== 'nsec') throw new Error('LUNA_NEGRA_NGP_NSEC no es un nsec válido');
    return d.data;
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) return Uint8Array.from(Buffer.from(raw, 'hex'));
  throw new Error('LUNA_NEGRA_NGP_NSEC debe ser un nsec bech32 o 32 bytes hex');
}

const challenge = (process.argv[2] ?? '').trim();
if (!challenge.startsWith('luna-negra:attestation-oracle:claim:')) {
  console.error('Uso: node scripts/attestation-oracle-proof.mjs "<reto>"');
  console.error('El reto sale de la card "Oráculo de atestaciones" del panel de Luna Negra');
  console.error('y tiene la forma luna-negra:attestation-oracle:claim:<gameId>.');
  process.exit(1);
}

const raw = readEnvVar('LUNA_NEGRA_NGP_NSEC');
if (!raw) {
  console.error('Falta LUNA_NEGRA_NGP_NSEC (en el entorno o en .env/.env.local).');
  process.exit(1);
}

const sk = decodeSecret(raw);
const proof = finalizeEvent(
  {
    kind: 27235, // auth efímero (estilo NIP-98); Luna valida content+firma+frescura
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: challenge,
  },
  sk,
);

console.error(`Oráculo: ${getPublicKey(sk)}`);
console.error('Pegá el JSON de abajo en la card "Oráculo de atestaciones" (vence en 5 min):\n');
console.log(JSON.stringify(proof));
