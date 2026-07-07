# Migración a NGE (Nostr Game Escrow) — Opción B (corte duro)

> Objetivo: reemplazar la capa de apuestas por eventos (`lunaNegraNgp.ts` + ramas
> "events mode" de `lunaNegraBets.ts`) por el **SDK NGE** manejado con una sola
> variable `NGE_CONNECTION` (la "NWC del escrow"), y **eliminar el path custodial
> legacy** de apuestas con invitados. Rama: `nge-migration`.

## Decisión: Opción B + invitados con cuenta efímera

Corte duro a **solo-NGE**: no hay asientos custodiados por Luna. Para que todo
asiento pueda firmar su propio 9734, **el jugador anónimo recibe una cuenta Nostr
efímera local** al participar (reusa `generateLocalSigner()` de `nostrSigner.ts`,
que ya existe: `method: 'local'`, nsec en el navegador). Así:

- Todo asiento tiene npub → siempre va por NGE, nunca por legacy.
- El jugador (real o efímero) **firma su propio depósito** en el navegador.
- El premio se zapea a esa pubkey; sin dirección Lightning cae a `withdraw_pending`
  (reclamo por QR), igual que hoy para invitados.

**Caveat de dinero (browser-held):** la clave efímera vive en el navegador del
jugador (persistida como el login `local` actual). Si cierra la pestaña y pierde la
sesión antes de fondear, no puede firmar su depósito; si la pierde después de ganar,
el premio queda en `withdraw_pending` y expira como forfeit. Es el trade-off
aceptado de una cuenta descartable.

## Alcance — qué reemplaza NGE y qué NO

NGE cubre **solo la coordinación del escrow** (contrato 1339, estado 31340,
resultado 1341, config por `bind`). **No toca**:

| Sigue en REST 1.0 (NO migra) | Archivo |
|---|---|
| Social (presencia, amigos, actividad) | `lunaNegraSocial.ts` |
| Leaderboard | `lunaNegraLeaderboard.ts` |
| Invitaciones / entrar a sala | `lunaNegraRoomInvite.ts`, `api/rooms/luna-negra/enter.ts` |

Por eso `LUNA_NEGRA_BASE_URL` / `API_KEY` / `GAME_ID` **se quedan** (los usan esas
features). Lo que se elimina son las `LUNA_NEGRA_NGP_*` y, al cortar el path
custodial de apuestas, también los `WEBHOOK_*` (ver §Env vars).

## Pasos

- [x] **1. Vendorizar el SDK.** `src/online/nge.ts` (copia de `sdk/nge.ts` de Luna;
  única dep `nostr-tools`, ya presente). Typecheck del proyecto verde.
- [x] **2. Gate + adaptador.** `src/online/lunaNegraNge.ts`: `ngeConnected()`,
  `fetchNgeConfig()` (config del `bind`), `createNgeContract`, `reportNgeResult`,
  `voidNgeBet`, `fetchNgeBetState`, `ngeStoreLnurlUrl` (LNURL del `lud16`). Los gates
  viejos (`ngpBetsEnabled`/`ngpEventsEnabled`) siguen como fallback hasta el Paso 5.
- [x] **3. Invitado → cuenta efímera.** `continueAsAnonymous()` ahora mintea una
  cuenta local (`generateLocalSigner`) y la adopta como identidad Nostr browser-held
  con `setActiveSigner(..., { method: 'local', nsec })`. `createOnlineRoom`,
  `joinOnlineRoom` y `joinLunaRoomLink` aseguran esa identidad antes de entrar a una
  sala, cubriendo sesiones viejas que ya tenían el gate descartado. Build verde.
- [x] **4. Rewire de `lunaNegraBets.ts` (NGE-first).** Ruteo NGE cuando
  `ngeConnected()` en las 4 operaciones, con los paths NGP/legacy como fallback:
  `createBetForRoom` → `createBetViaNge`; `fetchDetail` → `synthesizeNgeBetDetail`
  (config del bind, no `terms`+baseUrl); `cancelBetRemote` → `voidNgeBet`;
  `reportResult` → `reportNgeResult`. El template de depósito (`buildDeposit…` con el
  tag `lnurl`) y la plomería de sala/pozo se reusan. **Typecheck 0 err + 310 tests verdes.**

  | Antes | Ahora (adaptador) |
  |---|---|
  | `createBetViaEvents` / `publishBareNgpContract` | `createNgeContract` → `nge.createBet` |
  | `fetchNgpConfig` + `fetchNgpTerms` + `LUNA_NEGRA_GAME_COORD` | `fetchNgeConfig` → `nge.binding()` |
  | `signNgpResultEvent` + `publishSignedEventToRelays` | `reportNgeResult` → `nge.reportResult` |
  | `publishNgpVoidEvents` | `voidNgeBet` → `nge.voidBet` |
  | `fetchNgpBetState` (31340) | `fetchNgeBetState` → `nge.state` |

- [ ] **5. Borrar el path legacy.** Quitar de `createBetForRoom` la rama custodial
  (`/api/v2/bets` con `unknownNpubsAsGuests`), `localBets.ts` si solo lo usa el
  legacy, y `lunaNegraNgp.ts` cuando nadie lo importe. El depósito in-game (firmar
  9734 + LNURL-pay a la tienda con el `lud16` del `bind`), comentarios de
  participación, `finalizeCreatedBet` / `normalizeBet`, tracking del pozo y URLs de
  retiro **se reusan** (NGE da `deposits[].request` + `lud16`).
- [ ] **6. Tests.** Adaptar los `engine.test.ts` que setean `LUNA_NEGRA_NGP_*` a
  `NGE_CONNECTION`. Smoke test real: sala 1v1 (uno real + uno efímero) en el preview
  de Tetra; verificar bind/contrato/estado/resultado/payout en relays.
- [ ] **7. Limpieza de env vars** (ver abajo) + README.

## Env vars

**Eliminables tras el corte** (Opción B: sin path custodial de apuestas):

| Variable | Reemplazo / motivo |
|---|---|
| `LUNA_NEGRA_NGP_NSEC` | el `secret` dentro de `NGE_CONNECTION` |
| `LUNA_NEGRA_NGP_BETS` | gate = existe `NGE_CONNECTION` |
| `LUNA_NEGRA_NGP_KEYLESS` | NGE es siempre self-signed |
| `LUNA_NEGRA_NGP_EVENTS` | NGE es siempre modo eventos |
| `LUNA_NEGRA_NGP_ORACLE_NSEC` | el oráculo se deriva del `secret` único |
| `LUNA_NEGRA_WEBHOOK_URL` | el estado de la apuesta llega por la suscripción 31340 |
| `LUNA_NEGRA_WEBHOOK_SECRET` | idem (verificar antes que nada más los consuma) |

→ **7 variables menos.**

**Se quedan** (las usa el resto de Tetra, no la capa de escrow):
`LUNA_NEGRA_BASE_URL`, `LUNA_NEGRA_API_KEY`, `LUNA_NEGRA_GAME_ID` — social,
leaderboard, invitaciones.

## Cómo obtener el `NGE_CONNECTION`

Panel de proveedor de Luna Negra → juego → tab Integración → **Generar credencial
NGE** → copiar el string `nostr+nge://…` → pegarlo en el env de Tetra como
`NGE_CONNECTION`.
