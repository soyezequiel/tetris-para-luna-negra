# Migración a NGE v2 (Nostr Game Escrow) — RPC cifrado estilo NWC

> Las apuestas de Tetris corren sobre **NGE v2**: un RPC request/response cifrado
> (NIP-44) contra el escrow de Luna Negra, manejado con una sola variable
> `NGE_CONNECTION` (la "NWC del escrow"). Reemplazó al wire público v1 (contratos
> `1339`, estado `31340`, resultado `1341`, `9734` de depósito, `bind` event).

## Modelo v2 (qué cambió respecto de v1)

En v1 Tetris publicaba un contrato Nostr `1339` propio, leía el estado del `31340`
público y armaba un `9734` (zap request) que el jugador firmaba y mandaba al LNURL
de la tienda para obtener el invoice. En v2 nada de eso existe:

- **Todo es RPC cifrado** contra la pubkey del escrow: `get_info`, `create_bet`,
  `get_bet`, `report_result`, `cancel_bet`. El relay es un caño tonto; la fuente de
  verdad vive en el escrow y se consulta con `get_bet` (polling).
- **El depósito llega como `bolt11` por asiento** directo de `create_bet`/`get_bet`.
  El jugador paga ese invoice (QR o extensión). **Ya no se firma ningún `9734`** en
  el navegador ni se pega a un callback LNURL — es un bolt11 **plano** del nodo del escrow.
- **La config** (límites, comisiones) se pide por `get_info`, no por el `bind` event.
- **El resultado** se reporta con `report_result` (los `seatId` ganadores); la firma
  del request (credencial `C`) es la autenticación. `IN_PROGRESS` (otra invocación ya
  disparó la liquidación) se trata como **éxito**, no como error (el polling confirma
  `settled`).
- **`roomId`** viaja en `create_bet` (`room.id`) → la tienda lo muestra como "Sala".

## Identidad del jugador y cobro

Tetris manda el asiento como `{ seatId: player.npub, pubkey: <hex del npub> }`. El
escrow **upsertea la cuenta real** por esa pubkey, así que:

- **Jugador logueado con su identidad Nostr** (con `lud16` en su perfil kind:0) → la
  apuesta le **pertenece** (aparece en su perfil / `luna.fit/bets`) y el premio le llega
  **automático** como **zap social** a su lud16. No reclama nada.
- **Jugador anónimo** (cuenta Nostr efímera local, `generateLocalSigner()`, sin `lud16`)
  → el escrow no le encuentra destino → cobra por **QR de retiro** en `<base>/apuestas/{betId}`.

**Caveat browser-held:** la clave efímera del anónimo vive en el navegador (login
`local`). Si se pierde tras ganar, el premio queda en `withdraw_pending` hasta que se
reclame o expire. Trade-off de una cuenta descartable — no aplica al jugador logueado.

> **Requisito del lado Luna:** el proveedor del juego debe tener **oráculo gestionado**
> (Luna firma el `kind:1341` del resultado). La emisión de la credencial NGE lo garantiza
> (`ensureManagedOracle`); un proveedor BYO/self-signed no puede liquidar (`SELF_SIGNED_ORACLE`).

## Alcance — qué es NGE y qué NO

NGE cubre **solo el escrow de apuestas**. **No toca** (siguen en REST 1.0):

| Sigue en REST 1.0 (NO migra) | Archivo |
|---|---|
| Social (presencia, amigos, actividad) | `lunaNegraSocial.ts` |
| Leaderboard | `lunaNegraLeaderboard.ts` |
| Invitaciones / entrar a sala | `lunaNegraRoomInvite.ts`, `api/rooms/luna-negra/enter.ts` |

Por eso `LUNA_NEGRA_BASE_URL` / `API_KEY` / `GAME_ID` **se quedan** (los usan esas
features). El único gate de apuestas es la existencia de `NGE_CONNECTION`.

## Piezas — el protocolo separado del resto del programa

Tres capas con frontera dura (espejo del layout de Luna Negra):

| Capa | Archivo | Rol |
|---|---|---|
| **Protocolo (núcleo)** | `nostr-game-protocol/nge-core` (paquete, dependencia git) | Wire NGE PURO: kinds, parseo de URI, cifrado NIP-44, templates de eventos. Compartido con Luna: ambos consumen el MISMO paquete ([Nostr-Game-Protocol](https://github.com/soyezequiel/Nostr-Game-Protocol)). Única dep: `nostr-tools`. |
| **Protocolo (cliente)** | `nostr-game-protocol/nge-client` (mismo paquete) | Ergonomía del cliente: clase `NGE`, tipos de la API, transporte, `auditSettlement`. Cero imports del juego. |
| **Protocolo (barrel)** | `nostr-game-protocol/nge` | Re-exporta core + cliente. Es lo que importa el puerto. |
| **Puerto** | `src/online/lunaNegraNge.ts` | La frontera protocolo↔juego: el **único módulo que importa el SDK**. Credencial (env), ciclo de vida serverless, caché de config, NgeError → OnlineRoomError. API: `ngeConnected()`, `fetchNgeConfig()` (`get_info`, incl. `transparency`/`visibilityOptions`), `createNgeBet`, `fetchNgeBet`, `reportNgeResult`, `cancelNgeBet`. |
| **Juego** | `src/online/lunaNegraBets.ts` | Orquestación de sala/pozo. No conoce el protocolo: `createBetViaNge` → `createNgeBet`; `synthesizeNgeBetDetail` ← `fetchNgeBet`; `cancelBetRemote` → `cancelNgeBet`/`reportNgeResult` vacío; `maybeReportRoomBetResult` → `reportNgeResult`. |

> Regla: si un archivo fuera de `src/online/lunaNegraNge.ts` necesita algo del
> SDK, la respuesta es agregarle una función al puerto, no importar el SDK.
>
> Fuente de verdad: el repo
> [Nostr-Game-Protocol](https://github.com/soyezequiel/Nostr-Game-Protocol)
> (SDK canónico). Ya no hay copias vendorizadas ni script de sync: Luna y Tetris
> instalan el paquete como dependencia git. Tras tocar el wire allá, `npm update
> nostr-game-protocol` en cada consumidor.
>
> Conformance: los tests del SDK (`tests/nge-client.test.ts` en ese repo) validan
> core + cliente contra los vectores firmados (`vectors/nge-test-vectors.json`).

Mapeo del rewrite v1 → v2:

| v1 (borrado) | v2 (adaptador) |
|---|---|
| `createNgeContract` → `nge.createBet` (1339) | `createNgeBet` → `nge.createBet` (RPC, devuelve `bolt11` por asiento) |
| `fetchNgeConfig` → `nge.binding()` (`bind` event) | `fetchNgeConfig` → `nge.getInfo()` (RPC) |
| `fetchNgeBetState` → `nge.state()` (31340) | `fetchNgeBet` → `nge.getBet()` (RPC, fuente de verdad) |
| `reportNgeResult` → `nge.reportResult(id, {winners})` (1341) | `reportNgeResult` → `nge.reportResult(id, seatIds)` (RPC) |
| `voidNgeBet` → `nge.voidBet()` (1341 void) | `cancelNgeBet` → `nge.cancelBet()`; fondeada → `report_result` vacío |
| `buildDepositZapRequestTemplate` + LNURL (9734) | — (el escrow devuelve `bolt11` directo) |
| `lunaNegraEvents.ts` (parseo 31340, LNURL, 9734) | **eliminado** |

## Depósito en la UI

El panel de `main.ts` renderiza `participant.bolt11` (que viene poblado desde
`get_bet`) como QR y paga con WebLN. El jugador **no firma nada**. El viejo flujo de
firma de `9734` (`signAndGenerateBetDeposit`, `maybeAutoSignBetDeposit`, el endpoint
`deposit-invoice`, el mock v1) **ya fue borrado** en la limpieza post-migración — ver
§Estado.

## Env vars

**Se quedan** (las usa el resto de Tetris, no la capa de escrow):
`LUNA_NEGRA_BASE_URL`, `LUNA_NEGRA_API_KEY`, `LUNA_NEGRA_GAME_ID` — social,
leaderboard, invitaciones.

`NGE_CONNECTION` es la credencial de apuestas (host = pubkey del escrow, `secret` =
clave del cliente). Sin ella, no hay apuestas.

`NGE_BET_VISIBILITY=unlisted` (opcional): pide al escrow omitir la sombra pública
`31340` y la nota social de cada apuesta creada (la liquidación sigue siendo
auditable por el ancla y los recibos). Default: public. Solo surte efecto si el
escrow lo anuncia en `get_info.visibilityOptions`.

## Cómo obtener el `NGE_CONNECTION`

Panel de proveedor de Luna Negra → juego → tab Integración → **Generar credencial
NGE** → copiar el string `nostr+nge://…` → pegarlo en el env de Tetris como
`NGE_CONNECTION`.

## Estado

- ✅ **Migración v2 completa** (SDK vendorizado + adaptador + orquestación de sala).
- ✅ **Limpieza post-migración hecha**: borrados el path REST-legacy
  (`generateBetDepositInvoice`, `fetchDepositInvoiceFromCallback`, acción
  `deposit-invoice`), el webhook, y el mock v1 (`lunaNegraMock.ts` + `dev-api/hard-test`)
  con sus tests. El flujo de firma de `9734` en `main.ts` se removió.
- ✅ **Smoke test real verde** (1v1 contra el escrow v2 de prod): `create_bet` → depósito
  bolt11 → `funded` → `report_result` → **pago automático al ganador** (zap social a su
  lud16, visible en su perfil) → apuesta reflejada en `luna.fit/bets`.

### Cobertura de tests
Los 8 tests de apuestas de `engine.test.ts` que ejercitaban el data-path REST se
**borraron** (probaban implementación muerta). La lógica de orquestación viva
(seat mapping, carry-forward, reembolsos) quedó **sin cobertura unitaria** en Tetris;
recuperarla implicaría mockear `lunaNegraNge` (createNgeBet/fetchNgeBet/reportNgeResult)
en vez de stubear `fetch`. Pendiente opcional.
