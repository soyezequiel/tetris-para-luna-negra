// SDK NGE v2 (Nostr Game Escrow) — vendorizado de Luna Negra.
//
// Barrel de compatibilidad. NGE está partido en dos capas (espejo de Luna):
//   - `nge-core.ts`   → protocolo PURO (kinds, URI, cifrado NIP-44, templates).
//                       Es la ÚNICA parte compartida con Luna: se SINCRONIZA desde
//                       ahí (no editar a mano; ver docs/nge-migration.md). El wire
//                       está congelado por la spec, así que casi nunca cambia.
//   - `nge-client.ts` → ergonomía del cliente (clase `NGE`, tipos de la API,
//                       transporte, `auditSettlement`). Vive acá, en Tetris.
//
// El puerto (`src/online/lunaNegraNge.ts`) importa de este barrel; el resto del
// juego habla con el puerto, nunca con el SDK. Peer dependency: nostr-tools.
export * from "./nge-core.js";
export * from "./nge-client.js";
