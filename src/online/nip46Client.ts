/**
 * Cliente NIP-46 (Nostr Connect) propio, con DETECCIÓN AUTOMÁTICA de cifrado
 * (NIP-44 vs NIP-04). El `BunkerSigner` de nostr-tools solo habla NIP-44, y eso
 * rompe contra firmantes como Amber/Primal que por defecto usan NIP-04: la
 * respuesta `connect` nunca se descifra y el login "aprueba y no pasa nada".
 *
 * Porteado del repo de Luna Negra (src/lib/nip46-client.ts), que lo adaptó de
 * lacrypta-dev / lawalletio. Acá lo integramos a `LunaSigner`.
 */

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip04,
  nip44,
  type Event,
} from 'nostr-tools';
import { SimplePool, type SubCloser } from 'nostr-tools/pool';
import type { UnsignedEvent } from './nostrSigner';

export type EncryptionVersion = 'nip44' | 'nip04';

const NOSTR_CONNECT_KIND = 24133;
const RPC_TIMEOUT_MS = 30_000;

type Listener = {
  resolve: (v: string) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type FromURIOptions = {
  clientSecret: Uint8Array;
  relays: string[];
  /** Secret que va en el URI nostrconnect://; el firmante lo devuelve. */
  secret: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  onAuthUrl?: (url: string) => void;
  onDiag?: (msg: string) => void;
};

type FromStoredOptions = {
  clientSecret: Uint8Array;
  bunkerPubkey: string;
  relays: string[];
  secret?: string | null;
  encryption: EncryptionVersion;
  onAuthUrl?: (url: string) => void;
};

export class Nip46Client {
  /** Se fija en el primer descifrado exitoso y queda fijo en la sesión. */
  encryptionVersion: EncryptionVersion = 'nip44';
  bunkerPubkey = '';
  relays: string[] = [];
  secret: string | null = null;

  private pool!: SimplePool;
  private subCloser?: SubCloser;
  private listeners: Record<string, Listener> = {};
  private serial = 0;
  private idPrefix = Math.random().toString(36).slice(2, 8);
  private isOpen = false;
  private cachedPubkey?: string;
  private clientSecret!: Uint8Array;
  private clientPubkey!: string;
  private onAuthUrl?: (url: string) => void;

  private constructor() {}

  // ─── Flujo nostrconnect:// (QR / "abrir en la app") ─────────────────────
  static fromURI(opts: FromURIOptions): Promise<Nip46Client> {
    const c = new Nip46Client();
    c.clientSecret = opts.clientSecret;
    c.clientPubkey = getPublicKey(opts.clientSecret);
    c.relays = opts.relays;
    c.secret = opts.secret;
    // Pool con reconexión: en celular, al abrir el firmante por deep link el
    // navegador pasa a segundo plano y el SO corta el WebSocket; con reconexión
    // la suscripción no muere y la respuesta llega al volver.
    c.pool = new SimplePool({ enableReconnect: true });
    c.onAuthUrl = opts.onAuthUrl;
    const diag = opts.onDiag ?? (() => {});

    return new Promise<Nip46Client>((resolve, reject) => {
      let settled = false;
      let pendingSub: SubCloser | null = null;

      const cleanup = () => {
        try {
          pendingSub?.close();
        } catch {
          /* noop */
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        c.pool.destroy();
        reject(new Error('__qr_timeout__'));
      }, opts.timeoutMs);

      opts.abortSignal?.addEventListener('abort', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        c.pool.destroy();
        reject(new Error('Cancelado por el usuario.'));
      });

      pendingSub = c.pool.subscribe(
        opts.relays,
        { kinds: [NOSTR_CONNECT_KIND], '#p': [c.clientPubkey], limit: 0 },
        {
          onevent: async (event) => {
            if (settled) return;
            diag(`← evento kind ${event.kind} de ${event.pubkey.slice(0, 8)}…`);
            let decoded: { plaintext: string; version: EncryptionVersion };
            try {
              decoded = c.tryDecrypt(event.content, event.pubkey);
              diag(`  ✓ descifrado ${decoded.version.toUpperCase()}`);
            } catch {
              diag('  ✗ no se pudo descifrar (ni NIP-44 ni NIP-04)');
              return;
            }

            let response: { id?: string; result?: string; error?: string };
            try {
              response = JSON.parse(decoded.plaintext);
            } catch {
              diag(`  ✗ JSON inválido: ${decoded.plaintext.slice(0, 60)}`);
              return;
            }

            // auth_url: el firmante pide aprobación en su web; seguimos esperando.
            if (response.result === 'auth_url' && response.error) {
              c.onAuthUrl?.(response.error);
              diag('  → auth_url recibida');
              return;
            }

            // Algunos firmantes devuelven el secret; otros responden "ack".
            const accepted = response.result === opts.secret || response.result === 'ack';
            if (!accepted) {
              diag(`  ⚠ result inesperado: "${response.result}" (esperaba "${opts.secret}")`);
              return;
            }

            settled = true;
            clearTimeout(timer);
            cleanup();
            c.bunkerPubkey = event.pubkey;
            c.encryptionVersion = decoded.version;
            diag(`  ✓ conexión aceptada por ${event.pubkey.slice(0, 8)}… (${decoded.version})`);
            try {
              c.openSession();
              resolve(c);
            } catch (err) {
              c.pool.destroy();
              reject(err);
            }
          },
          oneose() {
            diag('EOSE — escuchando en tiempo real');
          },
          onclose(reason: unknown) {
            diag(`suscripción cerrada: ${String(reason)}`);
          },
        },
      );
      diag('suscripción abierta — esperando al firmante');
    });
  }

  // ─── Restaurar sesión persistida ────────────────────────────────────────
  static fromStored(opts: FromStoredOptions): Nip46Client {
    const c = new Nip46Client();
    c.clientSecret = opts.clientSecret;
    c.clientPubkey = getPublicKey(opts.clientSecret);
    c.bunkerPubkey = opts.bunkerPubkey;
    c.relays = opts.relays;
    c.secret = opts.secret ?? null;
    c.encryptionVersion = opts.encryption;
    c.onAuthUrl = opts.onAuthUrl;
    c.pool = new SimplePool({ enableReconnect: true });
    c.openSession();
    return c;
  }

  // ─── Cifrado (detección + uso consistente) ──────────────────────────────
  private tryDecrypt(
    content: string,
    peerPubkey: string,
  ): { plaintext: string; version: EncryptionVersion } {
    try {
      const convKey = nip44.getConversationKey(this.clientSecret, peerPubkey);
      return { plaintext: nip44.decrypt(content, convKey), version: 'nip44' };
    } catch {
      /* probamos NIP-04 */
    }
    try {
      const plaintext = nip04.decrypt(this.clientSecret, peerPubkey, content);
      return { plaintext, version: 'nip04' };
    } catch {
      throw new Error('no se pudo descifrar (NIP-44 ni NIP-04)');
    }
  }

  private async encryptContent(plaintext: string): Promise<string> {
    if (this.encryptionVersion === 'nip44') {
      const convKey = nip44.getConversationKey(this.clientSecret, this.bunkerPubkey);
      return nip44.encrypt(plaintext, convKey);
    }
    return nip04.encrypt(this.clientSecret, this.bunkerPubkey, plaintext);
  }

  // ─── Suscripción de sesión + RPC ────────────────────────────────────────
  private openSession(): void {
    if (this.isOpen) return;
    this.subCloser = this.pool.subscribe(
      this.relays,
      {
        kinds: [NOSTR_CONNECT_KIND],
        authors: [this.bunkerPubkey],
        '#p': [this.clientPubkey],
        limit: 0,
      },
      {
        onevent: (event) => {
          let decoded: { plaintext: string; version: EncryptionVersion };
          try {
            decoded = this.tryDecrypt(event.content, event.pubkey);
          } catch (e) {
            console.warn('[nip46] no se pudo descifrar evento de sesión', e);
            return;
          }
          // Si el firmante cambia de cifrado a mitad de sesión, lo seguimos.
          if (decoded.version !== this.encryptionVersion) {
            this.encryptionVersion = decoded.version;
          }
          let parsed: { id?: string; result?: string; error?: string };
          try {
            parsed = JSON.parse(decoded.plaintext);
          } catch {
            return;
          }
          const { id, result, error } = parsed;
          if (result === 'auth_url' && error) {
            this.onAuthUrl?.(error);
            return;
          }
          if (!id) return;
          const handler = this.listeners[id];
          if (!handler) return;
          clearTimeout(handler.timer);
          delete this.listeners[id];
          if (error) handler.reject(new Error(error));
          else handler.resolve(result ?? '');
        },
        onclose: () => {
          this.subCloser = undefined;
          this.isOpen = false;
        },
      },
    );
    this.isOpen = true;
  }

  /** Manda `connect` — para re-handshake de sesiones restauradas. */
  async connect(): Promise<void> {
    this.openSession();
    await this.sendRequest('connect', [this.bunkerPubkey, this.secret ?? '']);
  }

  private async sendRequest(method: string, params: string[]): Promise<string> {
    if (!this.isOpen) this.openSession();
    this.serial++;
    const id = `${this.idPrefix}-${this.serial}`;
    const encryptedContent = await this.encryptContent(
      JSON.stringify({ id, method, params }),
    );
    const event = finalizeEvent(
      {
        kind: NOSTR_CONNECT_KIND,
        tags: [['p', this.bunkerPubkey]],
        content: encryptedContent,
        created_at: Math.floor(Date.now() / 1000),
      },
      this.clientSecret,
    );
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        delete this.listeners[id];
        reject(new Error(`el firmante no respondió a ${method} a tiempo`));
      }, RPC_TIMEOUT_MS);
      this.listeners[id] = { resolve, reject, timer };
      Promise.any(this.pool.publish(this.relays, event)).catch((err) => {
        clearTimeout(timer);
        delete this.listeners[id];
        reject(err);
      });
    });
  }

  async getPublicKey(): Promise<string> {
    if (!this.cachedPubkey) {
      this.cachedPubkey = await this.sendRequest('get_public_key', []);
    }
    return this.cachedPubkey;
  }

  async signEvent(event: UnsignedEvent): Promise<Event> {
    const resp = await this.sendRequest('sign_event', [JSON.stringify(event)]);
    return JSON.parse(resp) as Event;
  }

  async nip04Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    return this.sendRequest('nip04_encrypt', [peerPubkey, plaintext]);
  }

  async nip04Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    return this.sendRequest('nip04_decrypt', [peerPubkey, ciphertext]);
  }

  async nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    return this.sendRequest('nip44_encrypt', [peerPubkey, plaintext]);
  }

  async nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    return this.sendRequest('nip44_decrypt', [peerPubkey, ciphertext]);
  }

  async close(): Promise<void> {
    this.isOpen = false;
    for (const id of Object.keys(this.listeners)) {
      clearTimeout(this.listeners[id].timer);
      this.listeners[id].reject(new Error('cliente cerrado'));
      delete this.listeners[id];
    }
    try {
      this.subCloser?.close();
    } catch {
      /* noop */
    }
    this.pool.destroy();
  }
}

/** Genera una clave de cliente efímera (helper para el flujo de QR). */
export function generateClientSecret(): Uint8Array {
  return generateSecretKey();
}
