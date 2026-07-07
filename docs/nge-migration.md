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
  el navegador ni se pega a un callback LNURL.
- **La config** (límites, comisiones) se pide por `get_info`, no por el `bind` event.
- **El resultado** se reporta con `report_result` (los `seatId` ganadores); la firma
  del request (credencial `C`) es la autenticación. No hay `1341` firmado.

## Invitados con cuenta efímera

Sigue vigente: todo asiento necesita un npub, así que **el jugador anónimo recibe
una cuenta Nostr efímera local** al participar (`generateLocalSigner()`). Ese npub
es el `seatId` estable de su asiento en `create_bet`. Como Tetris no conoce la
dirección Lightning de sus jugadores, no manda `payoutAddress`: el ganador cobra por
**QR de retiro** en `<base>/apuestas/{betId}` (cascada de payout §8 de la spec). Un
jugador con billetera propia puede reclamarlo ahí con su sesión.

**Caveat browser-held:** la clave efímera vive en el navegador (login `local`). Si
se pierde antes de fondear, no puede pagar; si se pierde tras ganar, el premio queda
en `withdraw_pending` hasta que se reclame o expire. Trade-off de una cuenta
descartable.

## Alcance — qué es NGE y qué NO

NGE cubre **solo el escrow de apuestas**. **No toca** (siguen en REST 1.0):

| Sigue en REST 1.0 (NO migra) | Archivo |
|---|---|
| Social (presencia, amigos, actividad) | `lunaNegraSocial.ts` |
| Leaderboard | `lunaNegraLeaderboard.ts` |
| Invitaciones / entrar a sala | `lunaNegraRoomInvite.ts`, `api/rooms/luna-negra/enter.ts` |

Por eso `LUNA_NEGRA_BASE_URL` / `API_KEY` / `GAME_ID` **se quedan** (los usan esas
features). El único gate de apuestas es la existencia de `NGE_CONNECTION`.

## Piezas

| Archivo | Rol |
|---|---|
| `src/online/nge.ts` | **SDK NGE v2 vendorizado** de Luna (`sdk/nge.ts`). Única dep: `nostr-tools`. No editar salvo re-copiar al actualizar Luna. |
| `src/online/lunaNegraNge.ts` | Adaptador: `ngeConnected()`, `fetchNgeConfig()` (`get_info`), `createNgeBet` (`create_bet`), `fetchNgeBet` (`get_bet`), `reportNgeResult` (`report_result`), `cancelNgeBet` (`cancel_bet`). |
| `src/online/lunaNegraBets.ts` | Orquestación de sala/pozo. Rutea NGE cuando `ngeConnected()`: `createBetViaNge` → `createNgeBet`; `synthesizeNgeBetDetail` ← `get_bet`; `cancelBetRemote` → `cancel_bet`/`report_result` vacío; `maybeReportRoomBetResult` → `report_result`. |

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

## Depósito en la UI (sin cambios de firma)

El panel de `main.ts` ya renderiza `participant.bolt11` como QR y paga con WebLN. En
v2 el `bolt11` viene siempre poblado desde `get_bet`, y `depositZapRequest`/
`depositCallback` quedan `null`, así que el flujo de firma de `9734` del jugador
(`signAndGenerateBetDeposit`, `maybeAutoSignBetDeposit`) **nunca se activa** — código
inerte, candidato a limpieza futura, pero inocuo.

## Env vars

**Se quedan** (las usa el resto de Tetris, no la capa de escrow):
`LUNA_NEGRA_BASE_URL`, `LUNA_NEGRA_API_KEY`, `LUNA_NEGRA_GAME_ID` — social,
leaderboard, invitaciones.

`NGE_CONNECTION` es la credencial de apuestas (host = pubkey del escrow, `secret` =
clave del cliente). Sin ella, no hay apuestas.

## Cómo obtener el `NGE_CONNECTION`

Panel de proveedor de Luna Negra → juego → tab Integración → **Generar credencial
NGE** → copiar el string `nostr+nge://…` → pegarlo en el env de Tetris como
`NGE_CONNECTION`.

## Pendiente (limpieza opcional, no bloquea)

- Borrar el path REST-legacy de apuestas de `lunaNegraBets.ts` (`generateBetDepositInvoice`,
  `fetchDepositInvoiceFromCallback`, `deposit-invoice` en `api/bets/[action].ts`) y el
  mock v1 (`lunaNegraMock.ts` + sus consumidores) — quedaron inertes con el corte a NGE.
- Adaptar los tests del mock money-path (`hardTestScenarios.test.ts`) y los de
  `engine.test.ts` que dependían del path REST: hoy fallan porque `createBetForRoom`
  exige `NGE_CONNECTION` (breakage previo al v2, del corte duro Opción B).
- Smoke test real: sala 1v1 (uno real + uno efímero) contra un escrow v2 vivo;
  verificar `create_bet` → depósito bolt11 → `get_bet` funded → `report_result` → payout.
