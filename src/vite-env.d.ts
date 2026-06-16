/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Transporte online: 'ws' usa PartyKit (WebSocket); cualquier otro valor usa HTTP. */
  readonly VITE_ONLINE_TRANSPORT?: 'ws' | 'http';
  /** Host de PartyKit cuando el transporte es 'ws' (ej. "127.0.0.1:1999" o "stacker-40.usuario.partykit.dev"). */
  readonly VITE_PARTYKIT_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
