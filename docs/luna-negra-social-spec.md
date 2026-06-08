# Integración social con Luna Negra (amigos / presencia / login SSO / invitaciones)

> **Estado: IMPLEMENTADO por Luna Negra** (4 endpoints live, CORS abierto, envelope
> estándar de `src/lib/api.ts`). El juego ya tolera el envelope (`unwrapEnvelope` en
> `src/online/lunaNegraSocial.ts`) y canjea el `lnToken` una sola vez al cargar
> (persistiendo la **identidad**, no el token, porque el entitlement expira a ~5 min).
>
> **A coordinar todavía:**
> 1. **Nombre del parámetro de apertura**: el juego se abre desde Luna Negra con el
>    entitlement en la URL. El contrato del juego espera `?lnToken=<jwt>` (también
>    acepta `?entitlement=`). Confirmar cuál usa `play-button.tsx`.
> 2. **Expiración del token (5 min)**: alcanza para canjearlo al cargar. Si en el
>    futuro el juego necesitara revalidar la sesión más tarde, haría falta un token
>    de sesión más largo (follow-up corto del lado de Luna Negra).
> 3. **Verificación E2E** con `ln_sk_…` + `lnToken` reales: confirmar que `source`
>    pasa de `"mock"` a `"luna-negra"` y que la presencia cae a offline tras 30s.


STACK/40 ya integra a Luna Negra como **escrow de apuestas** (`/api/v1/bets/*`),
verificación de invites de sala (`/api/v1/rooms/verify`) y webhooks
(`/api/v1/provider/webhook`). Para la pantalla de salas estilo Counter‑Strike 2
necesitamos una **capa social** que Luna Negra todavía **no expone**:

1. **Login SSO**: que al abrir el juego desde Luna Negra el jugador quede logueado
   automáticamente con su cuenta (npub).
2. **Lista de amigos** del jugador.
3. **Presencia**: saber qué amigos tienen el juego abierto / están jugando.
4. **Invitaciones**: notificar a un amigo para que se una a una sala.

Mientras estos endpoints no existan, el juego funciona en **modo demo (mock)**:
deriva la identidad del token, y considera "amigos" a los demás jugadores con
presencia reciente (heartbeat) en este mismo juego. Cuando Luna Negra implemente
los endpoints de abajo, el juego los usa automáticamente (sin cambios de UI).

> El game server ya tiene `LUNA_NEGRA_BASE_URL` + `LUNA_NEGRA_API_KEY`. La capa
> social usa esas mismas credenciales del lado servidor (`src/online/lunaNegraSocial.ts`),
> nunca expone la API key al browser.

---

## Contrato propuesto

Todas las rutas cuelgan de `LUNA_NEGRA_BASE_URL`. Autenticación con
`Authorization: Bearer <…>` (API key del proveedor salvo donde se indique el
token de sesión del usuario).

### 1) `GET /api/v1/session`  — login SSO

El juego se abre desde Luna Negra con `?lnToken=<token>` en la URL. El backend
del juego intercambia ese token por la identidad del usuario.

- **Auth**: `Bearer <lnToken>` (token de sesión del usuario, no la API key).
- **200**:

```json
{
  "npub": "npub1…",
  "pubkey": "hex…",
  "displayName": "Satoshi",
  "avatarUrl": "https://…/avatar.png",
  "gameId": "luna-game-id-opcional"
}
```

- **401** si el token es inválido/expiró.

> ¿Cómo le pasa Luna Negra el token al juego? Proponemos abrir el juego con
> `https://<deploy-tetris>/?lnToken=<token-de-sesion-corta>`. Si Luna Negra ya
> tiene otro mecanismo (NIP‑07, cookie de sesión compartida, deep‑link firmado),
> nos adaptamos: solo necesitamos un endpoint que, dado lo que llegue en la URL,
> devuelva `{ npub, displayName, avatarUrl, gameId }`.

### 2) `GET /api/v1/friends?npub=<npub>&presence=true`  — lista de amigos

- **Auth**: `Bearer <API_KEY>`.
- **Query**: `npub` del usuario; `presence=true` para incluir presencia en ESTE juego.
- **200**:

```json
{
  "friends": [
    {
      "npub": "npub1…",
      "displayName": "Hal",
      "avatarUrl": "https://…",
      "presence": "in-game",        // "in-game" | "online" | "offline"
      "roomId": "AB12",             // sala actual en este juego, o null
      "lastSeenMs": 1733600000000    // epoch ms o null
    }
  ]
}
```

El juego ya ordena: primero `in-game`, después `online`, después `offline`.

### 3) `POST /api/v1/presence`  — heartbeat de presencia

El juego avisa, cada ~10 s, que el usuario tiene el juego abierto o está en una sala.

- **Auth**: `Bearer <API_KEY>`.
- **Body**:

```json
{ "npub": "npub1…", "status": "in-game", "roomId": "AB12" }
```

`status`: `"in-game"` (dentro de una sala) o `"online"` (juego abierto, sin sala).
`roomId` puede ser `null`. Respuesta `200 { "ok": true }`. Idealmente la presencia
expira sola (TTL ~30 s) para que "offline" sea automático al cerrar el juego.

### 4) `POST /api/v1/friends/invite`  — invitar a una sala

El host (o cualquier miembro) invita a un amigo a su sala. Luna Negra notifica al
amigo (push / deep‑link) con el link de unión.

- **Auth**: `Bearer <API_KEY>`.
- **Body**:

```json
{
  "fromNpub": "npub1host…",
  "toNpub": "npub1friend…",
  "roomId": "AB12",
  "inviteUrl": "https://<deploy-tetris>/?join=AB12"
}
```

- **200**: `{ "delivered": true }` si se notificó al amigo. Si `delivered` es
  `false` o el endpoint no existe, el juego copia el `inviteUrl` al portapapeles
  como fallback para compartir manualmente.

> El `inviteUrl` abre el juego y se une directo a la sala (`?join=<roomId>`). Si
> además querés que el invitado entre ya logueado, el link puede incluir el
> `lnToken` del invitado: `…/?join=AB12&lnToken=<token>`.

---

## Cómo lo consume el juego (referencia)

- Backend proxy: `api/luna-negra/[action].ts` → `session`, `friends`, `presence`, `invite`.
- Lógica + fallback mock: `src/online/lunaNegraSocial.ts`.
- Cliente del browser: `src/online/lunaNegraFriendsClient.ts`.
- UI (panel de amigos + lobby CS2): `src/main.ts` (`renderFriendsSidebar`, `renderOnlineLobbyOverlay`).

Cuando los 4 endpoints estén disponibles bajo `LUNA_NEGRA_BASE_URL`, el juego los
detecta y deja de usar el mock automáticamente (el campo `source` pasa de
`"mock"` a `"luna-negra"`).

---

## Prompt listo para enviar al equipo de Luna Negra

> Hola 👋 Estamos integrando STACK/40 (juego de Tetris de la hackathon) con Luna
> Negra. Ya usamos su API de apuestas (`/api/v1/bets/*`), verificación de salas
> (`/api/v1/rooms/verify`) y webhooks. Para la nueva pantalla de salas (estilo
> Counter‑Strike 2) necesitamos 4 endpoints de **capa social**. Detalle y ejemplos
> de request/response en el documento adjunto (`luna-negra-social-spec.md`). En
> resumen necesitamos:
>
> 1. `GET /api/v1/session` — dado el token con el que Luna Negra abre nuestro
>    juego, devolver `{ npub, displayName, avatarUrl, gameId }` (login automático).
> 2. `GET /api/v1/friends?npub=…&presence=true` — lista de amigos del usuario con
>    su estado de presencia en nuestro juego (`in-game` / `online` / `offline`) y
>    `roomId` actual.
> 3. `POST /api/v1/presence` — heartbeat `{ npub, status, roomId }` con TTL ~30 s.
> 4. `POST /api/v1/friends/invite` — `{ fromNpub, toNpub, roomId, inviteUrl }` que
>    notifique al amigo (push/deep‑link) y devuelva `{ delivered: true|false }`.
>
> Pregunta clave de diseño: **¿cómo prefieren pasarnos la sesión del usuario al
> abrir el juego?** Nuestra propuesta es abrir
> `https://<deploy>/?lnToken=<token-de-sesion>` y que `/api/v1/session` valide ese
> token. Si tienen otro mecanismo (NIP‑07, cookie compartida, deep‑link firmado),
> nos adaptamos. Mientras tanto el juego corre en modo demo con presencia propia.
> ¡Gracias!
