# Integración social con Luna Negra (amigos / presencia / login SSO / invitaciones)

> **Estado: IMPLEMENTADO y en uso.** Los 4 endpoints sociales están live en Luna
> Negra (CORS abierto) y devuelven el **objeto crudo** (`apiOk` de `src/lib/api.ts`,
> sin envelope `{ data }`). El juego los consume directo en
> `src/online/lunaNegraSocial.ts` y canjea el `lnToken` una sola vez al cargar
> (persistiendo la **identidad**, no el token, porque el entitlement expira a ~5 min).
> No hay modo "mock": Tetris y Luna Negra se despliegan juntos, así que la API
> siempre está configurada; sin `LUNA_NEGRA_BASE_URL`/`API_KEY` las funciones
> sociales fallan con un error claro (`source` es siempre `"luna-negra"`).


TETRA integra a Luna Negra como **escrow de apuestas** (`/api/v1/bets/*`),
verificación de invites de sala (`/api/v1/rooms/verify`) y webhooks
(`/api/v1/provider/webhook`). Para la pantalla de salas estilo Counter‑Strike 2
usa además la **capa social** de Luna Negra:

1. **Login SSO**: que al abrir el juego desde Luna Negra el jugador quede logueado
   automáticamente con su cuenta (npub).
2. **Lista de amigos** del jugador.
3. **Presencia**: saber qué amigos tienen el juego abierto / están jugando.
4. **Invitaciones**: notificar a un amigo para que se una a una sala.

> El game server tiene `LUNA_NEGRA_BASE_URL` + `LUNA_NEGRA_API_KEY`. La capa
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
`roomId` puede ser `null`. Respuesta `200 { "ok": true }`.

> **TTL de 20 s (importante para evitar falsos positivos).** El juego late cada
> ~10 s **solo mientras el jugador tiene la pestaña visible en primer plano**: si
> minimiza, cambia de app o cierra el juego, **deja de latir**. Para que la
> tarjeta "Jugando Tetris" desaparezca sola, la presencia debe **caducar a los
> 20 s** sin heartbeat. Si Luna Negra muestra al jugador como "jugando" mientras
> haya un último heartbeat más reciente que 20 s, la presencia refleja
> exactamente quién está realmente en el juego.

### 4) `POST /api/v1/invites`  — invitar a una sala

El host (o cualquier miembro) invita a un amigo a su sala. Luna Negra notifica al
amigo (push / deep‑link) con el link de unión. (Recurso unificado: reemplaza a los
antiguos `friends/invite` + `launch-requests`.)

- **Auth**: `Bearer <API_KEY>`.
- **Body**:

```json
{
  "fromNpub": "npub1host…",
  "toNpub": "npub1friend…",
  "roomId": "AB12",
  "inviteUrl": "https://<deploy-tetris>/?join=AB12",
  "gameId": "luna-game-id"
}
```

- **200**: `{ "delivered": true }` si Luna Negra conoce al invitado y encoló el
  launch para TETRA abierto. Si `delivered` es `false`, el juego copia el
  `inviteUrl` al portapapeles como fallback para compartir manualmente.

> El `inviteUrl` abre el juego y se une directo a la sala (`?join=<roomId>`). Si
> además querés que el invitado entre ya logueado, el link puede incluir el
> `lnToken` del invitado: `…/?join=AB12&lnToken=<token>`.

---

### 5) `GET /api/v1/invites?npub=<npub>`  — invitaciones pendientes para TETRA abierto

El mismo recurso `/invites`, en GET, permite que TETRA detecte una invitacion
entregada por Luna Negra aunque la pestana de Luna Negra ya no este abierta.
TETRA lo consulta cada ~2 s cuando tiene una identidad de Luna Negra guardada.

- **Auth**: `Bearer <API_KEY>`.
- **Query**: `npub` del usuario invitado.
- **200** sin invitacion pendiente:

```json
{ "request": null }
```

- **200** con invitacion pendiente:

```json
{
  "request": {
    "id": "launch-req-123",
    "roomId": "AB12",
    "inviteToken": "jwt-de-sala",
    "slug": "TETRA",
    "title": "TETRA",
    "gameUrl": "https://<deploy-tetris>/"
  }
}
```

`id` debe ser estable para esa invitacion: si el usuario elige quedarse en su
sala actual, TETRA recuerda ese `id` en memoria de la pestana para que el mismo
popup no reaparezca en loop. `inviteToken` se usa contra
`POST /api/rooms/luna-negra/enter`, que a su vez valida el token con
`GET /api/v1/rooms/verify`.

> Alcance: este polling cubre "TETRA abierto, Luna Negra cerrada". Si TETRA
> tambien esta cerrado, un sitio web no puede ejecutar codigo por si solo; para
> abrirlo hace falta una notificacion/deep-link de Luna Negra o una PWA con
> permisos del navegador.

---

## Cómo lo consume el juego (referencia)

- Backend proxy: `api/luna-negra/[action].ts` → `session`, `friends`, `presence`, `invite`, `launch-request`.
- Lógica (cliente server-side de la capa social): `src/online/lunaNegraSocial.ts`.
- Cliente del browser: `src/online/lunaNegraFriendsClient.ts`.
- UI (panel de amigos + lobby CS2): `src/main.ts` (`renderFriendsSidebar`, `renderOnlineLobbyOverlay`).

Las funciones sociales requieren `LUNA_NEGRA_BASE_URL` + `LUNA_NEGRA_API_KEY`; sin
ellas fallan con un error claro (no hay modo demo). El campo `source` de las
respuestas es siempre `"luna-negra"`.
