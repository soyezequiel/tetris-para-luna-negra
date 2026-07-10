# Integración social con Luna Negra (amigos / presencia / login SSO / invitaciones)

> **Estado: HISTÓRICO — TETRA ya no consume esta capa.** El juego migró a Nostr:
> login con firmante NIP-07/46 (`src/online/nostrLogin.ts`), presencia NIP-38
> (`nostrPresence.ts`), amigos por contactos kind:3 (`nostrContacts.ts`) e
> invitaciones/retos por NIP-17 (`nostrChallenge.ts`); el escrow de apuestas pasó a
> NGE (ver [nge-migration.md](nge-migration.md)). Los endpoints siguen live del lado
> de Luna Negra y este documento queda como referencia del contrato, pero **no hay
> código en TETRA que los llame**.
>
> Lo único que TETRA sigue consumiendo de la 1.0:
>
> | Qué | Endpoint | Dónde |
> |---|---|---|
> | Launch request ("jugar" desde la tienda) | `GET /api/v1/invites?npub=` | `lunaNegraSocial.ts` |
> | Verificación de invite de sala (Room Link) | `GET /.well-known/jwks.json` (offline) | `lunaNegraRoomInvite.ts` |
> | Entrar a sala con `inviteToken` | `GET /api/v1/rooms/verify` | `api/rooms/luna-negra/enter.ts` |
> | Espejo del marcador a la tienda | `POST /api/v1/leaderboards/{board}/scores` | `lunaNegraLeaderboard.ts` |

Lo que sigue describe el contrato original de la capa social 1.0, tal como quedó
implementado del lado de Luna Negra.

TETRA integraba a Luna Negra como **escrow de apuestas** (`/api/v1/bets/*`, hoy NGE),
verificación de invites de sala (`/api/v1/rooms/verify`) y webhooks
(`/api/v1/provider/webhook`, hoy eliminados). Para la pantalla de salas estilo
Counter‑Strike 2 usaba además la **capa social** de Luna Negra:

1. **Login SSO**: que al abrir el juego desde Luna Negra el jugador quede logueado
   automáticamente con su cuenta (npub).
2. **Lista de amigos** del jugador.
3. **Presencia**: saber qué amigos tienen el juego abierto / están jugando.
4. **Invitaciones**: notificar a un amigo para que se una a una sala.

> El game server tiene `LUNA_NEGRA_BASE_URL` + `LUNA_NEGRA_API_KEY`. La capa
> social usaba esas mismas credenciales del lado servidor, nunca exponía la API key
> al browser.

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

## 6) "Luna Room Link" — invitación a sala hosteada por TETRA (`?lnRoom=`)

Estándar de enlace de invitación de Luna Negra (ver `docs/luna-room-link.md` en el
repo de Luna). Permite invitar a jugar **desde la ficha de Luna, sin abrir TETRA
primero**, con un enlace que lleva el dominio de TETRA y una sala que **no
pre-existe** (la crea el primer jugador que entra). Es DISTINTO del par
`?inviteToken=`+`?room=` (salas hosteadas por Luna, §4): acá la sala vive en el
backend de TETRA (las mismas salas PartyKit que usa `?join=`).

Enlace: `https://<deploy-tetris>/?lnRoom=<roomId>[&lnInvite=<jwt>]`.

- **Pública** (sin `lnInvite`): cualquiera con el enlace entra a la sala `lnRoom`
  con su identidad actual (Nostr o local).
- **Dirigida** (con `lnInvite`): TETRA verifica el token **offline** contra el JWKS
  de Luna (`POST /api/luna-negra/verify-room-invite`) y exige que el jugador sea el
  `toNpub` autorizado; si no está logueado con esa cuenta, abre la **puerta de login
  Nostr** y entra sola al completar el login (no usa el rebote a `/launch` de Luna,
  porque esta build es Nostr-nativa).

Cuando Luna crea una variante dirigida desde **Invitar a sala**, también encola una
orden `kind: "room-link"` en `GET /api/v1/invites`. TETRA la detecta con el polling
existente y muestra el popup de invitación si ya estaba abierto; al aceptar reutiliza
`lnInvite` y entra por este mismo flujo, sin crear una sala hosteada por Luna.

Al cargar, TETRA descarta los params (`lnRoom`/`lnInvite`/`lnToken`/`lnOrigin`) de la
URL. Para que Luna muestre el botón **"Invitar"** en la ficha, el proveedor declara la
capacidad `roomLink` en el panel de integración de Luna.

Consumo: `bootstrapLunaRoomLink` en `src/main.ts` (dispatch en `bootstrapOnlineStartup`),
verificación en `src/online/lunaNegraRoomInvite.ts` (server, `jose`), acción
`verify-room-invite` en `api/luna-negra/[action].ts`.

---

## Cómo lo consume el juego (referencia)

- Backend proxy: `api/luna-negra/[action].ts` → `session`, `friends`, `presence`, `invite`, `launch-request`, `verify-room-invite`.
- Lógica (cliente server-side de la capa social): `src/online/lunaNegraSocial.ts`; verificación de `lnInvite`: `src/online/lunaNegraRoomInvite.ts`.
- Cliente del browser: `src/online/lunaNegraFriendsClient.ts`.
- UI (panel de amigos + lobby CS2): `src/main.ts` (`renderFriendsSidebar`, `renderOnlineLobbyOverlay`).

Las funciones sociales requieren `LUNA_NEGRA_BASE_URL` + `LUNA_NEGRA_API_KEY`; sin
ellas fallan con un error claro (no hay modo demo). El campo `source` de las
respuestas es siempre `"luna-negra"`.
