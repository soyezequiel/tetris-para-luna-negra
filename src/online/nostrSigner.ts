/**
 * Abstracción de firma Nostr, porteada del repo de Luna Negra (src/lib/signer.ts).
 * La app habla con un `LunaSigner` activo que puede ser:
 *  - "nip07": extensión del navegador (nos2x, Alby).
 *  - "nip46": firmante remoto Nostr Connect (Amber, nsec.app) vía bunker / QR.
 *  - "local": clave en este navegador (generada o nsec importado).
 *
 * El login 2.0 produce la identidad a partir del signer (pubkey → npub) y deja el
 * signer en memoria para futuras features Nostr (firmar marcador kind:31339, retos
 * NIP-17, etc.). Persistimos el método elegido para rehidratar la sesión al recargar.
 */

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip04,
  nip44,
  nip19,
  type Event,
} from 'nostr-tools';

export type SignerMethod = 'nip07' | 'nip46' | 'local';

export interface UnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface LunaSigner {
  readonly method: SignerMethod;
  getPublicKey(): Promise<string>;
  signEvent(e: UnsignedEvent): Promise<Event>;
  nip04Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
  nip04Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
  /** NIP-44 (cifrado moderno; lo necesita NIP-17 para los retos cifrados). */
  nip44Encrypt?(peerPubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt?(peerPubkey: string, ciphertext: string): Promise<string>;
  /** Libera recursos (pool del bunker NIP-46). */
  close?(): Promise<void>;
}

// --- Persistencia de la sesión de signer (localStorage, JSON discriminado) ---

const SIGNER_KEY = 'stack40.ln_signer.v1';

export type StoredSigner =
  | { method: 'nip07' }
  | { method: 'local'; nsec: string }
  | {
      method: 'nip46';
      clientNsec: string;
      bunker: {
        relays: string[];
        pubkey: string;
        secret: string | null;
        // Cifrado detectado en el handshake (NIP-44 vs NIP-04). Si falta, es una
        // sesión vieja anterior a la detección → se restaura con el cliente
        // legacy (BunkerSigner, solo NIP-44).
        encryption?: 'nip44' | 'nip04';
      };
    };

function readStoredSigner(): StoredSigner | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SIGNER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredSigner;
  } catch {
    return null;
  }
}

function writeStoredSigner(stored: StoredSigner | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (stored) localStorage.setItem(SIGNER_KEY, JSON.stringify(stored));
    else localStorage.removeItem(SIGNER_KEY);
  } catch {
    /* storage bloqueado: la sesión de signer no persiste */
  }
}

// --- Aviso de firma (hook de UI) ---

// La app registra un notificador que se dispara ANTES de cada firma de evento, para
// avisarle al usuario qué está firmando (un toast). Se cablea acá, en el ÚNICO punto
// por el que pasan todas las firmas (el signer activo), así ninguna feature tiene que
// acordarse de avisar. Best-effort: si el aviso falla, la firma sigue igual.
let signEventNotifier: ((event: UnsignedEvent) => void) | null = null;

export function setSignEventNotifier(fn: ((event: UnsignedEvent) => void) | null): void {
  signEventNotifier = fn;
}

// Envuelve un signer para que cada `signEvent` dispare el notificador antes de firmar.
// Los métodos del signer son closures (no usan `this`), así que el spread es seguro.
function withSignNotice(signer: LunaSigner): LunaSigner {
  return {
    ...signer,
    signEvent: (event) => {
      try {
        signEventNotifier?.(event);
      } catch {
        // El aviso nunca debe romper ni demorar la firma.
      }
      return signer.signEvent(event);
    },
  };
}

// --- Signer activo (singleton en memoria) ---

let active: LunaSigner | null = null;

// Toda asignación de `active` pasa por acá para quedar envuelta con el aviso de firma
// y centralizar el punto de verdad del singleton.
function setActive(signer: LunaSigner | null): void {
  active = signer ? withSignNotice(signer) : null;
}

export function getActiveSigner(): LunaSigner | null {
  return active;
}

export function setActiveSigner(signer: LunaSigner, stored: StoredSigner): void {
  setActive(signer);
  writeStoredSigner(stored);
}

export function clearActiveSigner(): void {
  const prev = active;
  setActive(null);
  writeStoredSigner(null);
  void prev?.close?.();
}

/**
 * Espera a que la extensión Nostr inyecte `window.nostr`. nos2x/Alby lo inyectan de
 * forma ASÍNCRONA tras cargar la página, así que al restaurar la sesión en un reload
 * de pestaña puede no estar todavía listo. Sondea hasta `timeoutMs`. Sin esto,
 * restoreSigner se rendía al instante y features gateadas por el firmante (buzón de
 * retos, presencia) no arrancaban hasta un re-login manual.
 */
function waitForNostrExtension(timeoutMs = 3000): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.nostr) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (window.nostr) return resolve(true);
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  });
}

/**
 * Restaura el signer guardado al montar la app. Para NIP-46 difiere la conexión
 * real con import dinámico (no carga el cliente de bunker si no hace falta).
 */
export async function restoreSigner(): Promise<LunaSigner | null> {
  if (active) return active;
  const stored = readStoredSigner();
  if (!stored) return null;
  try {
    if (stored.method === 'nip07') {
      if (!(await waitForNostrExtension())) return null;
      setActive(createNip07Signer());
    } else if (stored.method === 'local') {
      setActive(importNsec(stored.nsec));
    } else {
      const { restoreBunkerSigner } = await import('./nostrNip46');
      setActive(await restoreBunkerSigner(stored.clientNsec, stored.bunker));
    }
    return active;
  } catch {
    return null;
  }
}

// --- NIP-07 (extensión) ---

export function createNip07Signer(): LunaSigner {
  const nostr = () => {
    if (typeof window === 'undefined' || !window.nostr) {
      throw new Error('Necesitás una extensión Nostr (nos2x/Alby)');
    }
    return window.nostr;
  };
  return {
    method: 'nip07',
    getPublicKey: () => nostr().getPublicKey(),
    signEvent: async (e) => (await nostr().signEvent(e)) as unknown as Event,
    nip04Encrypt: (peer, plaintext) => {
      const n = nostr();
      if (!n.nip04) throw new Error('Tu extensión no soporta NIP-04');
      return n.nip04.encrypt(peer, plaintext);
    },
    nip04Decrypt: (peer, ciphertext) => {
      const n = nostr();
      if (!n.nip04) throw new Error('Tu extensión no soporta NIP-04');
      return n.nip04.decrypt(peer, ciphertext);
    },
    nip44Encrypt: (peer, plaintext) => {
      const n = nostr();
      if (!n.nip44) throw new Error('Tu extensión no soporta NIP-44');
      return n.nip44.encrypt(peer, plaintext);
    },
    nip44Decrypt: (peer, ciphertext) => {
      const n = nostr();
      if (!n.nip44) throw new Error('Tu extensión no soporta NIP-44');
      return n.nip44.decrypt(peer, ciphertext);
    },
  };
}

// --- Clave local (generada o nsec importado; guardada plana en localStorage) ---

export function createLocalSigner(secretKey: Uint8Array): LunaSigner {
  const pubkey = getPublicKey(secretKey);
  return {
    method: 'local',
    getPublicKey: async () => pubkey,
    signEvent: async (e) => finalizeEvent(e, secretKey),
    nip04Encrypt: async (peer, plaintext) => nip04.encrypt(secretKey, peer, plaintext),
    nip04Decrypt: async (peer, ciphertext) => nip04.decrypt(secretKey, peer, ciphertext),
    nip44Encrypt: async (peer, plaintext) =>
      nip44.encrypt(plaintext, nip44.getConversationKey(secretKey, peer)),
    nip44Decrypt: async (peer, ciphertext) =>
      nip44.decrypt(ciphertext, nip44.getConversationKey(secretKey, peer)),
  };
}

export function generateLocalSigner(): { signer: LunaSigner; nsec: string } {
  const sk = generateSecretKey();
  return { signer: createLocalSigner(sk), nsec: nip19.nsecEncode(sk) };
}

/** Valida y decodifica un nsec; lanza con mensaje claro si no lo es. */
export function importNsec(nsec: string): LunaSigner {
  let decoded: ReturnType<typeof nip19.decode>;
  try {
    decoded = nip19.decode(nsec.trim());
  } catch {
    throw new Error('Eso no parece un nsec válido');
  }
  if (decoded.type !== 'nsec') {
    throw new Error('Eso no es una clave privada (nsec)');
  }
  return createLocalSigner(decoded.data);
}
