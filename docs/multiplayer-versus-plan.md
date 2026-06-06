# Arquitectura Multiplayer Versus

Este archivo ya no es un plan pendiente. Es el documento de arquitectura vigente
del modo online battle royale de STACK/40.

Se mantiene porque el multijugador tiene decisiones que no son obvias al leer
solo `src/main.ts`: quien tiene la verdad, que viaja por WebRTC, que persiste el
servidor y como se evita que el jugador no-host se sienta trabado.

## Resumen

- El modo local sigue siendo STACK/40: 40 lineas, historial y replays locales.
- El modo online usa reglas battle: `targetLines: null`.
- El creador de la sala es el host-authoritative peer (host autoritativo).
- El host simula la partida real de todos los invitados.
- Los invitados mandan inputs al host por WebRTC.
- El host publica progreso, ataques, eliminaciones y ganador.
- Vercel/Redis no arbitra gameplay; solo persiste y retransmite estado confirmado por el host.
- Los invitados pueden predecir localmente, pero corrigen contra snapshots autoritativos del host.

## Fuente De Verdad

La verdad competitiva esta en el host:

- `room.hostPlayerId` identifica al host.
- Los endpoints competitivos exigen `authorityPlayerId === room.hostPlayerId`.
- `src/online/roomService.ts` rechaza progreso, ataques, resultados y eliminaciones que no vengan del host.
- Los snapshots enviados por invitados no definen verdad de sala.

Esto no es server-authoritative (servidor autoritativo). Es host-authoritative
(host autoritativo): el servidor guarda y replica, pero no simula la partida.

## Flujo De Partida

1. Un jugador crea la sala y queda como host.
2. Los invitados entran, hacen ready y esperan el countdown.
3. Al empezar, todos arrancan con el mismo seed.
4. Cada invitado juega con prediccion local para que el input se sienta inmediato.
5. Cada invitado envia sus `GameInput[]` al host por WebRTC.
6. El host mantiene un `GameEngine` por invitado en `src/online/hostAuthority.ts`.
7. El host avanza esas simulaciones frame por frame.
8. Cuando la simulacion del host detecta clears, garbage o top out, el host publica el estado.
9. Los clientes reciben snapshots autoritativos y ataques confirmados.

## Mensajes P2P

El canal WebRTC transporta:

```ts
type BattlePeerMessage =
  | { type: 'input'; playerId: string; inputs: GameInput[] }
  | { type: 'snapshot'; playerId: string; game: OnlineGameSnapshot }
  | { type: 'attack'; authorityPlayerId: string; attackId: string; fromPlayerId: string; toPlayerId: string; lines: number; holeSeed: number; frame: number }
  | { type: 'ko'; playerId: string; frame: number };
```

Reglas:

- `input` solo es valido si viene por el canal del mismo `playerId`.
- `snapshot` autoritativo solo se acepta desde el host.
- `attack` solo se aplica si `authorityPlayerId` es el host.
- `ko` de invitado no decide la sala; la eliminacion real sale de la simulacion del host.

## Prediccion Y Reconciliacion

El jugador no-host no espera al host para mover piezas. Juega localmente y manda
inputs al host.

Para reconciliar:

- Cada input online lleva `sequence` (numero de orden).
- El host incluye `lastProcessedInputSequence` en el snapshot autoritativo.
- El snapshot autoritativo incluye una instantanea interna del `GameEngine`.
- El cliente descarta inputs ya confirmados.
- Si no quedan inputs pendientes, restaura el snapshot del host.
- Si quedan inputs pendientes, conserva la prediccion local para evitar tirones.
- En estados terminales, como `gameover`, el snapshot del host se aplica igual.

Los helpers principales estan en:

- `src/game/engine.ts`: `createSnapshot()` y `restoreSnapshot()`.
- `src/online/reconciliation.ts`: decision de reconciliacion.
- `src/main.ts`: `reconcileLocalEngine()` y `resimulateLocalPrediction()`.

## Ataques Y Garbage

- Limpiar lineas genera eventos del engine.
- El host calcula ataques desde la simulacion autoritativa.
- El ataque se publica por `POST /api/rooms/attack`.
- El mismo ataque se ignora si llega duplicado por P2P y polling HTTP.
- El receptor aplica `queueGarbage()`.
- La cancelacion de garbage entrante antes de atacar vive en `src/game/battle.ts`.

Tabla MVP:

| Clear | Garbage |
| --- | ---: |
| Single | 0 |
| Double | 1 |
| Triple | 2 |
| Quad/Tetris | 4 |

## Eliminacion Y Ganador

- Un jugador pierde al hacer top out.
- El host detecta el top out desde su simulacion.
- El host publica `POST /api/rooms/eliminate` con `authorityPlayerId`.
- Si queda un solo jugador vivo, ese jugador pasa a `winner`.
- La sala pasa a `finished`.

## Archivos Clave

- `src/online/protocol.ts`: contrato de sala, ataques y snapshots.
- `src/online/peerBroadcast.ts`: WebRTC DataChannel.
- `src/online/hostAuthority.ts`: simulacion remota en el host.
- `src/online/reconciliation.ts`: reglas para corregir al cliente no-host.
- `src/online/roomService.ts`: validacion de autoridad y persistencia.
- `src/main.ts`: orquestacion del gameplay online.
- `src/game/engine.ts`: motor determinista y snapshots restaurables.

## Limitaciones Actuales

- No hay anti-cheat fuerte. Un cliente podria mentir sobre inputs si controla su navegador.
- No hay servidor dedicado autoritativo.
- Sin TURN, WebRTC puede fallar en algunas redes.
- El host tiene ventaja estructural: corre su propia partida local y simula al resto.
- Falta un E2E multicliente real con dos navegadores jugando y WebRTC activo.

## Verificacion Recomendada

Despues de tocar esta arquitectura:

```powershell
npm test
npm run build
npm run test:e2e
```

Para cambios de sensacion de input o reconciliacion, agregar o actualizar tests
unitarios en `tests/engine.test.ts` y, cuando sea posible, crear un E2E de dos
navegadores.

## No Alcance Del MVP

- Servidor dedicado autoritativo.
- Anti-cheat fuerte.
- Espectadores.
- Chat.
- Badges.
- Targeting complejo.
- T-Spins.
- B2B (back-to-back, cadena de clears dificiles).
- Combos avanzados.
