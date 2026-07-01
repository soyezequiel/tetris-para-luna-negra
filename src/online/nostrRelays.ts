// Pool de relays y constantes compartidas para todo lo Nostr del cliente (perfiles
// kind:0, contactos kind:3, retos NIP-17). Antes cada módulo abría su propio
// SimplePool; centralizarlo evita duplicar conexiones a los mismos relays.
import { SimplePool } from 'nostr-tools';

// Relays de LECTURA de metadata pública (perfiles, contactos, presencia). Mismos
// que usa Luna Negra para que nombre/avatar coincidan con lo que muestra la tienda.
export const PROFILE_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

// Relays de ESCRITURA/lectura para DMs (gift-wrap NIP-17). relay.nostr.band es un
// indexador de solo lectura y rechaza escrituras, por eso no va acá; en su lugar
// sumamos relay.snort.social, que acepta gift-wraps.
export const DM_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
];

let pool: SimplePool | null = null;

/** Pool singleton compartido por todos los módulos Nostr del cliente. */
export function getPool(): SimplePool {
  if (!pool) pool = new SimplePool();
  return pool;
}

// NIP-59: los sobres (seal kind:13 y gift-wrap kind:1059) deben llevar un
// `created_at` aleatorizado hacia atrás (hasta 2 días) para no filtrar el momento
// real en que se armó el reto.
const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;

export function randomizedTimestamp(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec - Math.floor(Math.random() * TWO_DAYS_SECONDS);
}
