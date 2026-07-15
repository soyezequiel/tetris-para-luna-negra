/**
 * Conexión con firmantes remotos NIP-46 (Nostr Connect): Amber, Primal,
 * nsec.app, etc. Porteado del repo de Luna Negra (src/lib/signer-nip46.ts).
 *
 * El flujo por QR / "abrir en la app" usa `Nip46Client` (cliente propio con
 * detección de cifrado NIP-44/NIP-04), porque el `BunkerSigner` de nostr-tools
 * solo habla NIP-44 y se traba contra Amber/Primal que usan NIP-04. El flujo
 * `bunker://` pegado a mano sigue usando BunkerSigner.
 */

import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  BunkerSigner,
  createNostrConnectURI,
  parseBunkerInput,
  type BunkerPointer,
} from 'nostr-tools/nip46';
import { Nip46Client } from './nip46Client';
import { NIP46_PERMS } from './nostrPermissions';
import type { LunaSigner, StoredSigner } from './nostrSigner';

// Relays donde cliente y firmante se encuentran para el handshake NIP-46.
// Lideramos con relays grandes y abiertos (damus, nos.lol) que cualquier firmante
// genérico (Amber, Primal, nsec.app) alcanza. Dejamos relay.nsec.app al final
// para los usuarios de nsec.app.
export const NIP46_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nsec.app',
];

// El QR expira a los 5 minutos sin respuesta.
const QR_TIMEOUT_MS = 5 * 60_000;

// ─── Wrappers a LunaSigner ────────────────────────────────────────────────

/** Envuelve el BunkerSigner de nostr-tools (flujo bunker:// y sesiones legacy). */
function wrapBunker(signer: BunkerSigner): LunaSigner {
  return {
    method: 'nip46',
    getPublicKey: () => signer.getPublicKey(),
    signEvent: (e) => signer.signEvent(e),
    nip04Encrypt: (peer, plaintext) => signer.nip04Encrypt(peer, plaintext),
    nip04Decrypt: (peer, ciphertext) => signer.nip04Decrypt(peer, ciphertext),
    nip44Encrypt: (peer, plaintext) => signer.nip44Encrypt(peer, plaintext),
    nip44Decrypt: (peer, ciphertext) => signer.nip44Decrypt(peer, ciphertext),
    close: () => signer.close(),
  };
}

/**
 * Envuelve nuestro `Nip46Client`. `ensureConnected` se llama antes de cada RPC:
 * en el flujo QR es noop (recién hicimos el handshake); al restaurar una sesión
 * dispara un `connect` best-effort (algunos firmantes lo necesitan).
 */
function wrapClient(
  client: Nip46Client,
  ensureConnected: () => Promise<void> = async () => {},
): LunaSigner {
  return {
    method: 'nip46',
    getPublicKey: async () => {
      await ensureConnected();
      return client.getPublicKey();
    },
    signEvent: async (e) => {
      await ensureConnected();
      return client.signEvent(e);
    },
    nip04Encrypt: async (peer, plaintext) => {
      await ensureConnected();
      return client.nip04Encrypt(peer, plaintext);
    },
    nip04Decrypt: async (peer, ciphertext) => {
      await ensureConnected();
      return client.nip04Decrypt(peer, ciphertext);
    },
    nip44Encrypt: async (peer, plaintext) => {
      await ensureConnected();
      return client.nip44Encrypt(peer, plaintext);
    },
    nip44Decrypt: async (peer, ciphertext) => {
      await ensureConnected();
      return client.nip44Decrypt(peer, ciphertext);
    },
    close: () => client.close(),
  };
}

// ─── Persistencia ─────────────────────────────────────────────────────────

/** Sesión legacy (BunkerSigner): bunker pointer sin cifrado detectado. */
export function storedNip46(
  clientSecretKey: Uint8Array,
  bp: BunkerPointer,
): StoredSigner {
  return {
    method: 'nip46',
    clientNsec: nip19.nsecEncode(clientSecretKey),
    bunker: { relays: bp.relays, pubkey: bp.pubkey, secret: bp.secret },
  };
}

/** Sesión del flujo QR: incluye el cifrado detectado para restaurar igual. */
function storedFromClient(clientSecret: Uint8Array, client: Nip46Client): StoredSigner {
  return {
    method: 'nip46',
    clientNsec: nip19.nsecEncode(clientSecret),
    bunker: {
      relays: client.relays,
      pubkey: client.bunkerPubkey,
      secret: client.secret,
      encryption: client.encryptionVersion,
    },
  };
}

// ─── Flujos de conexión ───────────────────────────────────────────────────

/**
 * Conecta con un bunker a partir de un `bunker://...` o un identificador
 * NIP-05 (`usuario@dominio`). `onauth` recibe la URL de autorización si el
 * bunker la pide (se muestra como link al usuario).
 */
export async function connectBunker(
  input: string,
  onauth?: (url: string) => void,
): Promise<{ signer: LunaSigner; stored: StoredSigner }> {
  const bp = await parseBunkerInput(input.trim());
  if (!bp) {
    throw new Error('No es un bunker:// ni un identificador NIP-05 válido');
  }
  const clientSecretKey = generateSecretKey();
  const bunker = BunkerSigner.fromBunker(clientSecretKey, bp, { onauth });
  await bunker.connect();
  return { signer: wrapBunker(bunker), stored: storedNip46(clientSecretKey, bp) };
}

/**
 * Inicia el flujo Nostr Connect por QR / "abrir en la app": genera el URI
 * `nostrconnect://` y devuelve la promesa que resuelve cuando el firmante remoto
 * acepta la conexión. Usa `Nip46Client` (detección NIP-44/NIP-04).
 */
export function startNostrConnect(opts?: {
  onauth?: (url: string) => void;
  signal?: AbortSignal;
  /** Diagnóstico: líneas de estado del handshake (relays, eventos, cifrado). */
  onDebug?: (line: string) => void;
}): {
  uri: string;
  established: Promise<{ signer: LunaSigner; stored: StoredSigner }>;
} {
  const clientSecret = generateSecretKey();
  const clientPubkey = getPublicKey(clientSecret);
  const secret = crypto.randomUUID().replace(/-/g, '');
  const uri = createNostrConnectURI({
    clientPubkey,
    relays: NIP46_RELAYS,
    secret,
    perms: NIP46_PERMS,
    name: 'Tetra',
    url: typeof window !== 'undefined' ? window.location.origin : undefined,
  });

  const established = Nip46Client.fromURI({
    clientSecret,
    relays: NIP46_RELAYS,
    secret,
    timeoutMs: QR_TIMEOUT_MS,
    abortSignal: opts?.signal,
    onAuthUrl: opts?.onauth,
    onDiag: opts?.onDebug,
  })
    .then((client) => ({
      signer: wrapClient(client),
      stored: storedFromClient(clientSecret, client),
    }))
    .catch((e: unknown) => {
      // Mensaje amistoso para el timeout interno del cliente.
      if (e instanceof Error && e.message === '__qr_timeout__') {
        throw new Error('El código expiró (5 minutos sin respuesta del firmante). Probá de nuevo.');
      }
      throw e;
    });

  return { uri, established };
}

/** Reconecta una sesión NIP-46 persistida (al restaurar la app). */
export async function restoreBunkerSigner(
  clientNsec: string,
  bunker: {
    relays: string[];
    pubkey: string;
    secret: string | null;
    encryption?: 'nip44' | 'nip04';
  },
): Promise<LunaSigner> {
  const decoded = nip19.decode(clientNsec);
  if (decoded.type !== 'nsec') throw new Error('clave de cliente inválida');

  // Sesiones del flujo QR (con cifrado detectado) → cliente propio dual.
  if (bunker.encryption) {
    const client = Nip46Client.fromStored({
      clientSecret: decoded.data,
      bunkerPubkey: bunker.pubkey,
      relays: bunker.relays,
      secret: bunker.secret,
      encryption: bunker.encryption,
    });
    // `connect` best-effort: algunos firmantes tratan cada carga como sesión
    // nueva y lo necesitan antes de firmar. No bloqueamos la UI más de 5s.
    let connectPromise: Promise<void> | null = null;
    const ensureConnected = () => {
      if (!connectPromise) {
        connectPromise = Promise.race([
          client.connect().catch(() => {}),
          new Promise<void>((r) => setTimeout(r, 5000)),
        ]).then(() => {});
      }
      return connectPromise;
    };
    ensureConnected();
    return wrapClient(client, ensureConnected);
  }

  // Sesiones legacy (bunker:// o anteriores a la detección) → BunkerSigner.
  const signer = BunkerSigner.fromBunker(decoded.data, bunker);
  await signer.connect();
  return wrapBunker(signer);
}
