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

// Relays donde PUBLICAMOS metadata pública firmada por el propio usuario (presencia
// NIP-38 kind:30315; a futuro el marcador kind:31339). Es el subconjunto escribible
// de PROFILE_RELAYS: quitamos relay.nostr.band (indexador de solo lectura que rechaza
// escrituras) para no perder un slot de publicación en un relay que igual reindexa.
// Incluye relay.lacrypta.ar (que Luna Negra LEE) para que el clear de cierre
// aterrice también ahí: un target más reduce la chance de que un relay se quede
// con el "on" viejo si su socket estaba reconectando en el `pagehide`.
export const PUBLIC_WRITE_RELAYS = [
  'wss://relay.lacrypta.ar',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

let pool: SimplePool | null = null;

/** Pool singleton compartido por todos los módulos Nostr del cliente. */
export function getPool(): SimplePool {
  if (!pool) pool = new SimplePool();
  return pool;
}

// `randomizedTimestamp` (NIP-59) se mudó a la capa protocolo: nostr-game-protocol/ngp.
