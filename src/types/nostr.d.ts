// Tipado de la API NIP-07 expuesta por extensiones tipo nos2x / Alby. Porteado
// del repo de Luna Negra (src/types/nostr.d.ts).
type Nip07UnsignedEvent = {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

type Nip07SignedEvent = Nip07UnsignedEvent & {
  id: string;
  pubkey: string;
  sig: string;
};

interface Nip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(event: Nip07UnsignedEvent): Promise<Nip07SignedEvent>;
  nip04?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

interface Window {
  nostr?: Nip07Provider;
}
