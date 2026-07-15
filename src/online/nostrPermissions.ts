// Kinds que TETRA firma: reseñas, contactos, DMs/retos, login, presencia y
// marcadores. 31337 se conserva durante la transición al kind 31339.
export const NOSTR_SIGN_KINDS = [1, 3, 4, 13, 27235, 30315, 31339, 31337];

// Deben coincidir con el manifiesto autorizado por Luna Negra. Se comparte la
// lista entre Nostr Connect manual y BAL para no pedir capacidades divergentes.
export const NIP46_PERMS = [
  'get_public_key',
  'sign_event',
  ...NOSTR_SIGN_KINDS.map((kind) => `sign_event:${kind}`),
  'nip04_encrypt',
  'nip04_decrypt',
  'nip44_encrypt',
  'nip44_decrypt',
];
