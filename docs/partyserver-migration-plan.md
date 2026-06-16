# Plan de migración PartyKit → partyserver (Cloudflare Durable Objects)

> Estado: ✅ IMPLEMENTADO y **DESPLEGADO EN PRODUCCIÓN** (rama `feature/partyserver-migration`,
> sin commitear). Worker `tetra` vivo en `https://tetra.naranjas.workers.dev`.
> Verificado: `party:check` (tsc worker-types) OK, root tsc OK, 214 unit + **5/5 e2e
> contra `wrangler dev`** (incl. countdown→playing por alarm y cleanup de abandono),
> `wrangler deploy --dry-run` OK, y **smoke test 3/3 contra el worker en prod**
> (flujo de sala + lobby push + 404). El frontend de producción usa WS contra
> `tetra.naranjas.workers.dev` por default. Ver [[partykit-websocket-migration]].
>
> Motivo: el deploy de PartyKit está bloqueado porque la zona compartida
> `partykit.dev` está al tope de custom domains de Cloudflare. `partyserver` es el
> sucesor oficial (mismo autor, ahora en Cloudflare) y corre en TU cuenta de
> Cloudflare → subdominio `*.workers.dev` gratis, sin la zona compartida.

## TL;DR

- **Esfuerzo:** ~medio día. Es mecánico, NO un rewrite.
- **Costo:** Workers Free incluye Durable Objects con SQLite (100k requests/día,
  13k GB-s/día, 5 GB storage). Si te pasás, la operación falla hasta el reset —
  no hay cobro sorpresa.
- **El cliente NO cambia:** `partyClient.ts` usa `partysocket`, que es compatible
  con partyserver. Solo cambia el HOST (de `*.partykit.dev` a `*.workers.dev`).
  En producción el default apunta a `tetra.naranjas.workers.dev`; `?pkhost=` queda
  sólo para debugging.

## Lo que NO cambia (la mayor parte)

- `src/online/roomDispatch.ts` — lógica pura de dispatch. **Sin tocar.**
- `src/online/roomService.ts` — lógica pura de salas. **Sin tocar.**
- `src/online/partyClient.ts` — usa `partysocket`. **Sin tocar** (solo el host).
- Toda la LÓGICA de `party/room.ts` y `party/lobby.ts` (Fases 0-5): el ciclo de
  sala, el lobby con su gracia, el alarm unificado, los timers autoritativos.
- **Los workarounds de Fase 4/5 siguen siendo necesarios y correctos:** la
  limitación de no acceder a `id`/`context.parties` dentro de `onAlarm` es del
  Durable Object subyacente, no de PartyKit. Seguimos guardando el roomId en
  storage y dejando la gracia del listado en el LobbyParty.

## Lo que SÍ cambia

### 1. Dependencias (`package.json`)
- Agregar `partyserver`. Quitar `partykit` (el CLI). **Mantener `partysocket`.**
- Scripts: `party:dev` → `wrangler dev`; `party:deploy` → `wrangler deploy`.
- Agregar `wrangler` como devDependency.

### 2. `party/room.ts` y `party/lobby.ts` — mapeo de API

| PartyKit (hoy) | partyserver |
|---|---|
| `implements Party.Server` + `constructor(readonly room)` | `extends Server<Env>` (sin constructor; los fields quedan igual) |
| `this.room.id` | `this.name` (en onAlarm: igual que hoy, leer roomId del storage) |
| `this.room.storage` | `this.ctx.storage` |
| `this.room.getConnections()` | `this.getConnections()` |
| `this.room.broadcast(msg)` | `this.broadcast(msg)` |
| `this.room.env.X` | `this.env.X` |
| `this.room.context.parties.lobby.get(ID).fetch(...)` | `(await getServerByName(this.env.Lobby, ID)).fetch(...)` |

**Firmas de los hooks (ojo el orden):**
- `onStart()` — igual.
- `onConnect(connection, ctx)` — igual (el 2º arg es opcional).
- `onMessage(connection, message)` — ⚠️ **ORDEN INVERTIDO** respecto a PartyKit
  (`onMessage(message, sender)`). Hay que dar vuelta los args en nuestro handler.
- `onClose(connection, code, reason, wasClean)` — más args, compatibles.
- `onAlarm()` — igual.

**Detalle cross-party:** `getServerByName(binding, name)` es `async` y devuelve un
stub; el `.fetch()` sobre él reemplaza al de `context.parties`. Nuestro
`postToLobby` pasa a `await getServerByName(this.env.Lobby, LOBBY_PARTY_ID)`.

### 3. Nuevo entrypoint Worker (`party/index.ts` o `src/server.ts`)
```ts
import { routePartykitRequest } from 'partyserver';
export { default as Main } from './room';   // o export class
export { default as Lobby } from './lobby';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routePartykitRequest(request, env)) ?? new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```
`routePartykitRequest` mantiene el esquema de URL `/parties/:party/:name`, así que
`partysocket` (cliente) sigue conectando igual. El segmento `:party` se mapea al
binding por nombre en minúsculas → **binding `Main` ↔ party `main`**, **binding
`Lobby` ↔ party `lobby`** (que es lo que usa el cliente hoy). *(Confirmar el mapeo
exacto contra la doc al implementar; si hace falta, `routePartykitRequest` acepta
un objeto de mapeo.)*

### 4. `partykit.json` → `wrangler.jsonc`
```jsonc
{
  "name": "stacker-40",
  "main": "party/index.ts",
  "compatibility_date": "2026-06-16",
  "durable_objects": {
    "bindings": [
      { "name": "Main",  "class_name": "RoomServer"  },
      { "name": "Lobby", "class_name": "LobbyServer" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["RoomServer", "LobbyServer"] }
  ]
}
```
`new_sqlite_classes` es lo que mete los DO en el **free tier**. La var de gracia
pasa por `wrangler dev --var PARTY_ABANDON_GRACE_MS=1500` o sección `vars`.

### 5. Tipos (`Env`)
```ts
interface Env {
  Main: DurableObjectNamespace<RoomServer>;
  Lobby: DurableObjectNamespace<LobbyServer>;
  PARTY_ABANDON_GRACE_MS?: string;
}
```
Las clases `RoomServer`/`LobbyServer` ahora `extends Server<Env>` para tipar
`this.env`.

## Deploy (en TU cuenta de Cloudflare)
1. `npx wrangler login` (abre el navegador, login con tu cuenta de Cloudflare).
2. `npx wrangler deploy` → publica en `tetra.<tu-subdominio>.workers.dev`.
3. Publicar el frontend. En builds de producción, si no hay env explícita,
   `partyClient.ts` usa WS contra `tetra.naranjas.workers.dev` sin query params.
4. Para debugging puntual, `?transport=http` fuerza HTTP y
   `?transport=ws&pkhost=<host>` fuerza otro host WS sólo en esa carga.

## Verificación
- `wrangler dev --port 1999 --var PARTY_ABANDON_GRACE_MS=1500` levanta local.
- Los tests e2e ya escritos (`tests/partyClient.integration.test.ts`,
  `PARTY_E2E=1`) deberían pasar **sin cambios** apuntando al puerto de wrangler
  (mismo esquema de URL `/parties/main/<id>`). Es la mejor red de seguridad de la
  migración: si los 5 pasan contra wrangler, el comportamiento se preservó.

## Riesgos / gotchas
- ⚠️ **`onMessage(connection, message)`**: orden de args invertido. Es el error
  más fácil de cometer.
- **Mapeo party→binding** (`main`/`lobby`): confirmar contra la doc; default es
  binding-name-en-minúsculas.
- **`getServerByName` es async**: `postToLobby` y `onConnect`/`onClose` ya son
  async, así que encaja.
- **Hibernación + alarm**: partyserver soporta WebSocket hibernation y
  `ctx.storage` alarms igual que PartyKit; nuestro patrón onStart-rehidrata +
  alarm-único se mantiene.

## Apuestas / Luna Negra bajo WS
- Implementado con un bridge server-to-server: Vercel conserva las credenciales de
  Luna Negra y usa `PARTY_BRIDGE_TOKEN` para leer/escribir la sala autoritativa en
  el Worker `tetra`.
- El bridge vive en `party/index.ts` (`/__bridge/rooms/:roomId`) y delega en el
  `RoomServer` del Durable Object. Cada escritura valida version, persiste en
  storage durable y emite broadcast a los sockets conectados.
- `/api/bets/*`, `/api/webhooks/luna-negra` y `/api/rooms/luna-negra/enter` usan
  `getBetRoomStore()`: con token configurado van al Worker; sin token conservan el
  store viejo para desarrollo local.
