// Relays donde Luna publica terms/estado/contratos NGP. Compartidos por el backend
// de apuestas y por el browser watcher para no duplicar listas ni importar helpers
// server-side en el cliente.
export const NGP_READ_RELAYS = [
  'wss://relay.lacrypta.ar',
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.primal.net',
];
