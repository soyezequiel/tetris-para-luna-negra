# Plan Multiplayer Versus

Este plan cambia el online actual de una carrera 40L compartida a un versus de ultimo en pie inspirado en salas custom/ROYALE de TETR.IO.

## Estado Actual Del Repo

- El modo local sigue siendo STACK/40: `DEFAULT_RULES.targetLines = 40`.
- `GameEngine.lockPiece()` marca `finished` cuando `lines >= targetLines`.
- Online ya tiene salas publicas/privadas, ready/start, countdown sincronizado, polling HTTP y snapshots P2P por WebRTC DataChannel.
- Online no tiene garbage, ataques, cola de garbage entrante, cancelacion, targeting ni ganador por ultimo vivo.
- El resultado online actual distingue `won/lost`, pero `won` hoy significa terminar 40L.

## Objetivo

Crear un modo online battle royale casual:

1. El objetivo online no es hacer 40 lineas.
2. Cada jugador juega localmente.
3. Limpiar lineas genera ataques.
4. Los ataques agregan garbage al tablero objetivo.
5. Cada jugador pierde al topear.
6. La sala termina cuando queda un solo jugador vivo.
7. El ultimo jugador vivo gana.

## Principios De Arquitectura

- Mantener 40L local sin romper historial, replay library ni stats existentes.
- Agregar reglas de batalla como modo separado, no reemplazar `DEFAULT_RULES` globalmente.
- Mantener `GameEngine` determinista y testeable.
- Usar WebRTC DataChannel para inputs de invitados, ataques confirmados y snapshots autoritativos rapidos.
- Usar al host, el jugador que crea la sala, como fuente de verdad de la partida.
- Usar Vercel/Redis como persistencia y relay de estado confirmado por el host, no como arbitro de gameplay.
- Aceptar MVP sin anti-cheat fuerte: los invitados mandan inputs al host; el host simula sus tableros y publica progreso, ataques, vida/muerte y ganador.

## 1. Nuevo Modo Online De Ultimo En Pie

### Cambio

Online debe arrancar el motor con reglas de batalla, donde no hay `targetLines = 40`.

### Diseno

- Extender `GameRules` con una opcion:
  - `targetLines: number | null`
  - `null` significa sin objetivo de lineas.
- En `GameEngine.lockPiece()`, solo marcar `finished` si `targetLines !== null`.
- En online, usar `targetLines: null`.
- En local 40L, conservar `targetLines: 40`.

### Archivos

- `src/game/types.ts`
- `src/game/rules.ts`
- `src/game/engine.ts`
- `src/main.ts`
- `tests/engine.test.ts`

### Criterio De Aceptacion

- En modo local, hacer 40 lineas sigue marcando `finished`.
- En modo online battle, hacer 40 lineas no termina la partida.
- En online battle, solo `gameover` elimina al jugador.

## 2. Garbage En El Engine

### Cambio

El motor debe poder recibir lineas de garbage desde otro jugador.

### Diseno

Agregar una estructura:

```ts
interface PendingGarbage {
  lines: number;
  holeColumn: number;
  receivedFrame: number;
  applyFrame: number;
}
```

Agregar metodos al engine:

```ts
queueGarbage(lines: number, holeSeed: number, frame: number): void
applyPendingGarbage(frame: number): void
```

Regla MVP:

- Garbage entra despues de un delay fijo, por ejemplo 90 frames.
- Cada linea garbage tiene todas las celdas ocupadas salvo un hueco.
- El hueco se calcula con seed para que sea reproducible.
- Si al subir el tablero hay bloques empujados fuera de la zona visible/hidden, el jugador pierde.

### Archivos

- `src/game/types.ts`
- `src/game/engine.ts`
- `src/game/board.ts`
- `tests/engine.test.ts`

### Criterio De Aceptacion

- Aplicar 1 garbage sube el tablero una fila.
- Aplicar N garbage conserva ancho y alto del board.
- El hueco queda vacio.
- Si garbage empuja bloques arriba, el estado pasa a `gameover`.

## 3. Ataques Al Limpiar Lineas

### Cambio

Cada clear debe producir un potencial ataque.

### Tabla MVP

| Clear | Garbage |
| --- | ---: |
| Single | 0 |
| Double | 1 |
| Triple | 2 |
| Quad/Tetris | 4 |

Fases posteriores:

- Perfect Clear.
- Combo.
- B2B (back-to-back, cadena de clears dificiles).
- T-Spins.

### Diseno

Hoy `clearLines()` solo suma lineas y no expone evento. Cambiar el motor para registrar eventos de batalla:

```ts
interface LineClearEvent {
  frame: number;
  cleared: number;
  attackLines: number;
}
```

El estado puede exponer:

```ts
events: GameEvent[]
```

O el loop puede consumir eventos mediante:

```ts
drainEvents(): GameEvent[]
```

Recomendacion: `drainEvents()` para no inflar cada snapshot.

### Archivos

- `src/game/types.ts`
- `src/game/engine.ts`
- `src/main.ts`
- `tests/engine.test.ts`

### Criterio De Aceptacion

- Double emite ataque de 1.
- Triple emite ataque de 2.
- Quad emite ataque de 4.
- Single no ataca.
- El evento se emite una sola vez por clear.

## 4. Cancelacion De Garbage

### Cambio

Si un jugador tiene garbage pendiente y limpia lineas, primero cancela garbage entrante antes de atacar.

### Diseno

Funcion de resolucion:

```ts
resolveAttack({
  outgoingLines,
  pendingIncoming,
}): {
  remainingIncoming;
  outgoingAfterCancel;
}
```

Ejemplo:

- Incoming pendiente: 3.
- Clear genera 4.
- Resultado: cancela 3 y manda 1.

Otro ejemplo:

- Incoming pendiente: 5.
- Clear genera 2.
- Resultado: quedan 3 incoming y no manda ataque.

### Archivos

- `src/game/battle.ts` nuevo.
- `src/game/engine.ts`
- `tests/engine.test.ts`

### Criterio De Aceptacion

- Ataques cancelan garbage pendiente antes de enviar.
- Garbage que queda pendiente mantiene su orden.
- Un clear nunca duplica ataque y defensa.

## 5. Inputs Al Host Y Ataques Autoritativos

### Cambio

El P2P actual mandaba snapshots visuales. Debe mandar inputs al host y snapshots autoritativos desde el host.

### Mensajes

```ts
type BattlePeerMessage =
  | { type: 'input'; playerId: string; inputs: GameInput[] }
  | { type: 'snapshot'; playerId: string; game: OnlineGameSnapshot }
  | { type: 'attack'; authorityPlayerId: string; id: string; fromPlayerId: string; toPlayerId: string; lines: number; holeSeed: number; frame: number }
  | { type: 'ko'; playerId: string; frame: number };
```

### Diseno

- Cada invitado envia sus `GameInput` al host.
- El host mantiene un `GameEngine` por invitado y simula sus tableros.
- Los snapshots de invitados no definen verdad; el host envia snapshots autoritativos de todos los jugadores.
- Cada input online lleva `sequence`; el snapshot autoritativo incluye `lastProcessedInputSequence`.
- El snapshot autoritativo incluye una instantanea interna del `GameEngine` para restaurar tablero, pieza, cola, hold, garbage, RNG, gravedad y lock delay.
- El invitado restaura el snapshot del host para su propio jugador, descarta inputs confirmados y re-simula los inputs pendientes para conservar prediccion local.
- Para 2 jugadores: objetivo = el otro jugador vivo.
- Para 3+ jugadores MVP: objetivo random entre vivos.
- Cada ataque debe tener `id` para evitar duplicados.
- Solo el host calcula y publica ataques por HTTP:
  - `POST /api/rooms/attack`
  - polling lo entrega en `room.attacks`.
- Si WebRTC no conecta, el host no recibe inputs del invitado y la simulacion autoritativa de ese invitado queda sin controles nuevos.
- El receptor aplica `queueGarbage()`.

### Archivos

- `src/online/peerBroadcast.ts`
- `src/online/protocol.ts`
- `src/online/client.ts`
- `src/main.ts`
- `api/rooms/attack.ts`
- `src/online/roomService.ts`
- `tests/engine.test.ts`
- `tests/e2e/app.spec.ts`

### Criterio De Aceptacion

- Al limpiar un double en la simulacion del host, el otro jugador recibe 1 garbage.
- El mismo ataque no se aplica dos veces aunque llegue por P2P y HTTP.
- Si WebRTC no conecta con el host, los inputs del invitado no cuentan para la verdad de sala.

## 6. Servidor Guarda Vida, Muerte Y Ganador

### Cambio

El servidor ya guarda resultados, pero debe aceptar supervivencia solo cuando la publica el host.

### Modelo Propuesto

```ts
type OnlinePlayerStatus =
  | 'joined'
  | 'ready'
  | 'playing'
  | 'eliminated'
  | 'winner'
  | 'disconnected';

interface OnlinePlayer {
  alive: boolean;
  eliminatedAtFrame: number | null;
  eliminatedAtServerMs: number | null;
}

interface OnlineRoom {
  winnerPlayerId: string | null;
}
```

### Reglas

- Al `gameover` en la simulacion del host, el host manda `POST /api/rooms/eliminate` con `authorityPlayerId`.
- El servidor marca al jugador como eliminado solo si `authorityPlayerId` coincide con `room.hostPlayerId`.
- Si queda 1 vivo, ese jugador pasa a `winner` y la sala a `finished`.
- Si todos se eliminan casi al mismo tiempo, gana el de mayor `elapsedFrames` o menor `eliminatedAtServerMs` segun regla definida.

### Archivos

- `src/online/protocol.ts`
- `src/online/roomService.ts`
- `src/online/client.ts`
- `api/rooms/eliminate.ts`
- `src/main.ts`
- `tests/engine.test.ts`

### Criterio De Aceptacion

- Con 2 jugadores, si A topoutea, B gana.
- Con 3 jugadores, la sala no termina hasta que queden 1 vivo.
- Resultado final no se sobrescribe por progreso tardio.
- Ranking final muestra winner primero y eliminados por supervivencia.

## 7. UI De Versus

### Cambio

La UI debe comunicar que ya no es 40L y mostrar amenazas.

### Pantalla De Lobby

- Mostrar modo: `Battle - last player standing`.
- Mostrar cantidad de jugadores.
- Mostrar si WebRTC esta `open`, `connecting` o fallback `server`.

### Durante La Partida

- Remover copy de `40L` del modo online.
- Mostrar contador: `Alive 3/4`.
- Mostrar mini-tableros remotos.
- Mostrar barra de garbage entrante al costado del tablero propio.
- Mostrar `ELIMINATED` sobre jugadores muertos.
- Mostrar `WINNER` cuando termina.

### Resultados

- Ranking por supervivencia, no por 40 lineas.
- Mostrar:
  - ganador.
  - orden de eliminacion.
  - tiempo sobrevivido.
  - lineas enviadas.
  - lineas recibidas.

### Archivos

- `src/main.ts`
- `src/styles.css`
- `src/renderer/PixiGameRenderer.ts`
- `tests/e2e/app.spec.ts`

### Criterio De Aceptacion

- En online no aparece `lines/40` como objetivo.
- La UI muestra incoming garbage.
- Al perder, el jugador ve `ELIMINATED`.
- Al ganar, ve `WINNER`.

## Orden Recomendado De Implementacion

1. Separar reglas 40L vs battle (`targetLines: null`).
2. Agregar garbage al engine.
3. Agregar eventos de clear y tabla de ataques.
4. Agregar cancelacion de garbage.
5. Agregar envio de inputs por WebRTC hacia el host, simulacion remota en el host y persistencia HTTP solo para ataques confirmados por host.
6. Cambiar resultados online a ultimo en pie.
7. Actualizar UI y E2E.

## Tests Minimos

### Unit

- 40L local sigue terminando a 40.
- Battle online no termina a 40.
- Garbage sube el board y respeta hueco.
- Garbage puede causar top out.
- Double/triple/quad calculan ataque correcto.
- Cancelacion consume incoming antes de atacar.
- Ataque duplicado se ignora por `id`.
- Ultimo vivo gana la sala.

### E2E

- Dos jugadores empiezan battle.
- A limpia double y B recibe garbage.
- B topoutea y A queda como winner.
- En 3 jugadores, eliminar a uno no termina la sala.
- Si WebRTC no abre entre invitado y host, los inputs del invitado no llegan a la simulacion autoritativa.

## Riesgos

- Con ataques, la latencia importa mas que antes: ya no es solo visual.
- Sin TURN, WebRTC puede fallar en algunas redes; en host-autoritativo completo eso impide recibir inputs de invitados hasta recuperar conexion con el host.
- El MVP confia en clientes, asi que no sirve para competitivo serio.
- Full mesh P2P escala mal si hay muchos jugadores; conviene limitar salas a 4 u 8 al principio.
- Cambiar `finished`/`gameover` puede romper historial/replays si no se separa bien el modo 40L del modo battle.

## No Alcance Del MVP

- T-Spins.
- B2B.
- Combo avanzado.
- Badges.
- Targeting complejo.
- Chat.
- Espectadores.
- Anti-cheat fuerte.
- Servidor autoritativo.
