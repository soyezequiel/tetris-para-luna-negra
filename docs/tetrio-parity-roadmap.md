# Roadmap TETR.IO-Inspired Multiplayer Parity

Este plan cubre los puntos 1, 2, 3 y 6 de la comparacion con TETR.IO:

1. Modos, escala y ecosistema online.
2. Objetivos de partida por modo.
3. Sistema avanzado de ataques, garbage y defensa.
6. Targeting, o seleccion de objetivo.

No busca copiar la marca, interfaz, assets ni reglas exactas de TETR.IO. Busca
llevar STACK/40 a una arquitectura comparable: varios modos online, reglas
separadas, mas profundidad competitiva y targeting legible.

## Punto De Partida Verificado

- El online ya tiene `battle` y `custom`.
- El modo online ya usa supervivencia con `targetLines: null`.
- El host de la sala es la fuente de verdad competitiva.
- Los invitados mandan inputs por WebRTC.
- El servidor persiste ataques, progreso, eliminaciones y ganador confirmados por el host.
- El sistema de ataque actual es simple: single 0, double 1, triple 2, quad 4.
- El targeting actual elige un jugador vivo mediante hash del `attackId`.

## Estado Implementado En Esta Rama

- Contratos online versionados con `OnlineMatchType`, `OnlineRuleset`, `OnlineObjective` y `TargetingMode`.
- Modos disponibles: `battle`, `custom`, `royale`, `duel`, `league`, `quickPlay` y `sprintRace`.
- Objetivos activos: `lastStanding`, `duelRounds`, `sprint` y `quickPlayClimb`.
- Matchmaking casual `Quick Duel`, matchmaking ranked `League`, perfiles, Elo versionado y resultados persistidos.
- `Quick Play` persistente con leaderboard semanal y reentrada despues de morir.
- Attack calculator separado con preset `simple` compatible y preset `modern` con combo, B2B, perfect clear y T-Spin conservador.
- Garbage avanzado: cap, travel, activation, messiness, change-on-attack y continuous garbage.
- Targeting explicito: random, even, KO, attackers, leader y manual, con UI y validacion server-side.
- `dangerLevel` se calcula desde snapshot de tablero y garbage pendiente para alimentar targeting KO.
- Verificacion actual: `npm test`, `npm run build` y `npm run test:e2e`.

## Objetivo Producto

Convertir el multijugador en un ecosistema de modos:

- `Duel`: 1v1 rapido, rounds cortos, primero a N victorias.
- `League`: matchmaking ranked (emparejamiento competitivo) con rating.
- `Royale`: free-for-all (todos contra todos) de ultimo vivo para 3+ jugadores.
- `Quick Play`: lobby publico persistente donde los jugadores entran y salen sin esperar una sala manual.
- `Custom Room`: salas configurables por host con presets exportables.

El resultado esperado es que el jugador entienda rapidamente:

- Que esta jugando.
- Como gana.
- A quien ataca.
- Que amenaza tiene encima.
- Como progresa fuera de una partida individual.

## Fase 0 - Contratos Base Antes De Escalar

### Cambios

- Separar `OnlineRoomMode` de `OnlineMatchType`.
- Agregar un contrato de reglas versionado:
  - `rulesetId`
  - `rulesetVersion`
  - `objective`
  - `attackTable`
  - `targeting`
  - `ranked`
- Mantener compatibilidad con rooms viejas via normalizacion en `roomService`.

### Archivos

- `src/online/protocol.ts`
- `src/online/roomService.ts`
- `src/game/types.ts`
- `tests/engine.test.ts`

### Criterios

- Rooms existentes siguen abriendo como `battle`.
- Custom online conserva `targetLines: null` salvo que se implemente un objetivo custom explicito.
- El servidor rechaza reglas desconocidas o fuera de rango.

## Fase 1 - Modos Y Escala Online

### 1A. Room Listing Mejorado

Extender la lista publica actual con filtros:

- modo
- cantidad de jugadores
- estado
- region declarada
- ranked/unranked
- custom preset

Ventaja: mejora lo que ya existe con bajo riesgo.
Desventaja: no resuelve matchmaking automatico todavia.

### 1B. Quick Duel

Agregar cola simple para 1v1 casual:

- `POST /api/matchmaking/enqueue`
- `POST /api/matchmaking/heartbeat`
- `POST /api/matchmaking/leave`
- `GET /api/matchmaking/ticket`

La cola crea una room privada cuando encuentra dos jugadores compatibles.

Ventaja: primer paso hacia TETRA LEAGUE sin tocar rating todavia.
Desventaja: requiere TTL y limpieza de tickets abandonados.

### 1C. League

Agregar ranked matchmaking (emparejamiento competitivo):

- perfil persistido por `playerId`
- rating inicial
- rating deviation (desviacion de certeza) simple
- historial de matches
- best-of series, por ejemplo FT3 (first to 3, primero a 3)

Alternativas:

- Rating simple tipo Elo:
  - Pro: facil de implementar y explicar.
  - Contra: peor con poca cantidad de partidas.
- Glicko-2:
  - Pro: modela incertidumbre mejor.
  - Contra: mas complejo y mas facil de implementar mal.

Recomendacion: empezar con Elo versionado y dejar una interfaz `RatingSystem`
para migrar a Glicko-2 despues.

### 1D. Quick Play Persistente

Crear un lobby publico persistente:

- el jugador entra sin crear sala manualmente
- si muere puede reentrar
- scoreboard semanal local al proyecto
- metas por altura, supervivencia o KOs

Ventaja: da sensacion de mundo vivo.
Desventaja: necesita mas estado de servidor y reglas de entrada/salida.

### Archivos

- `src/online/protocol.ts`
- `src/online/roomService.ts`
- `src/online/client.ts`
- `src/main.ts`
- `api/matchmaking/*`
- `api/rooms/*`
- `tests/engine.test.ts`
- `tests/e2e/app.spec.ts`

## Fase 2 - Objetivos Por Modo

Hoy el online usa supervivencia. Eso esta bien para battle, pero no alcanza para
un ecosistema tipo TETR.IO.

### Objetivos Nuevos

```ts
type OnlineObjective =
  | { type: 'lastStanding' }
  | { type: 'duelRounds'; firstTo: number }
  | { type: 'sprint'; targetLines: number }
  | { type: 'survivalScore'; durationSeconds?: number }
  | { type: 'quickPlayClimb'; floorSystem: string };
```

### Modos Propuestos

- `battle`: `lastStanding`
- `duel`: `duelRounds`
- `league`: `duelRounds` ranked
- `custom`: elegido por el host
- `quickPlay`: `quickPlayClimb`
- `sprintRace`: `sprint`

### Cambios De Engine

- Mantener `GameEngine` sin conocer "ranked", "league" ni "quick play".
- El engine solo sabe reglas mecanicas: lineas, garbage, gravedad, lock delay.
- La capa online decide objetivo, rounds, ranking y final de match.

### Criterios

- Local 40L sigue terminando en 40.
- Battle sigue terminando por ultimo vivo.
- Duel puede terminar una ronda y reiniciar otra sin recrear room.
- League actualiza rating solo al terminar una serie completa.

## Fase 3 - Sistema Avanzado De Ataques

El sistema actual es entendible, pero poco profundo. Para acercarse a TETR.IO hay
que separar "clear detectado" de "damage calculado".

### 3A. Eventos De Clear Mas Ricos

Extender el evento:

```ts
interface LineClearEvent {
  frame: number;
  cleared: number;
  difficult: boolean;
  spin: 'none' | 'mini' | 'full';
  piece: string;
  perfectClear: boolean;
  combo: number;
  b2b: number;
  attackLines: number;
  outgoingLines: number;
}
```

### 3B. Attack Calculator

Crear `src/game/attack.ts`:

- tabla base
- combo multiplier (multiplicador de combo)
- B2B (back-to-back, cadena de clears dificiles)
- perfect clear
- opener phase (fase de apertura)
- garbage canceling (cancelacion de basura)
- rounding mode (modo de redondeo)

### 3C. Reglas MVP

Orden recomendado:

1. Combo counter.
2. B2B para quads.
3. Perfect clear.
4. T-Spin detection.
5. Attack presets por modo.
6. Surge o ataque cargado si realmente hace falta.

No conviene empezar por T-Spins. Primero hay que construir el contrato de eventos
y tests de damage, porque T-Spins dependen de rotacion, kicks y deteccion de
inmovilidad.

### 3D. Garbage Mas Expresivo

Agregar opciones:

- `garbageTravelFrames`
- `garbageActivationFrames`
- `garbageCap`
- `garbageMessinessPercent`
- `changeOnAttack`
- `continuousGarbage`

### Criterios

- Los ataques actuales quedan como preset `simple`.
- Un preset `modern` agrega combo y B2B sin romper battle existente.
- Cada attack calculation tiene tests de tabla, no solo tests de gameplay.
- Un ataque duplicado nunca se aplica dos veces.

## Fase 4 - Targeting Real

El targeting actual es automatico por hash. Para ROYALE y Quick Play hace falta
un sistema explicito.

### Targeting Modes

```ts
type TargetingMode =
  | 'random'
  | 'even'
  | 'ko'
  | 'attackers'
  | 'leader'
  | 'manual';
```

### Comportamiento

- `random`: elige un vivo al azar deterministico por seed/evento.
- `even`: reparte ataques hacia quien recibio menos garbage.
- `ko`: prioriza jugadores cerca de top out.
- `attackers`: devuelve ataques a quienes atacaron al jugador.
- `leader`: prioriza al jugador con mas KOs o mejor posicion.
- `manual`: el usuario selecciona objetivo desde la UI.

### Datos Necesarios

- `targetingMode` por jugador.
- `manualTargetPlayerId` opcional.
- `recentAttackers`.
- `koCount`.
- `receivedGarbageThisRound`.
- `dangerLevel` calculado desde altura del board y pending garbage.

### UI

- Mostrar target actual.
- Mostrar quien te esta atacando.
- Botones compactos para cambiar targeting.
- En 1v1, ocultar targeting complejo y usar siempre el rival.

### Criterios

- En 2 jugadores, todo ataque va al rival vivo.
- En 3+ jugadores, el modo elegido cambia el destino de forma testeable.
- Si el target muere, se recalcula sin perder el ataque.
- La UI nunca permite targetear eliminados.

## Fase 5 - Ranking, Resultados Y Progresion

Para que el punto 1 tenga peso real, los modos necesitan persistencia de
progreso.

### Perfiles

Agregar `OnlineProfile`:

- `playerId`
- `displayName`
- `createdAt`
- `rating`
- `casualStats`
- `leagueStats`
- `quickPlayStats`

### Resultados

Guardar por match:

- participantes
- modo
- reglas
- seed
- ganador
- orden de eliminacion
- lineas enviadas
- lineas recibidas
- PPS (pieces per second, piezas por segundo)
- APM (attack per minute, ataque por minuto)
- replay/snapshot hash si aplica

### Criterios

- League no actualiza rating si la serie queda abortada.
- Casual no modifica rating.
- Quick Play puede tener leaderboard semanal separado.

## Orden Recomendado

1. Fase 0: contratos versionados.
2. Fase 2: objetivos por modo.
3. Fase 4: targeting real basico.
4. Fase 3A-3C: attack calculator con combo/B2B.
5. Fase 1A-1B: room listing mejorado y Quick Duel.
6. Fase 5: perfiles y resultados.
7. Fase 1C: League.
8. Fase 1D: Quick Play persistente.
9. Fase 3D: garbage avanzado y presets mas finos.

La razon del orden: primero se estabiliza el contrato y las reglas. Despues se
agrega profundidad. Recien al final conviene meter ranking serio, porque un
ranking encima de reglas inestables genera datos basura.

## Tests Minimos

### Unit

- Objetivo `lastStanding` termina con un solo vivo.
- Objetivo `duelRounds` acumula rondas.
- Objetivo `sprint` termina por lineas.
- Targeting `random`, `even`, `ko`, `attackers` y `manual`.
- Combo incrementa y se corta correctamente.
- B2B incrementa con quads y se corta con clears faciles.
- Perfect clear agrega bonus.
- Garbage cap limita pending garbage.
- Duplicados por P2P/HTTP no duplican damage.

### E2E

- Crear sala battle y jugar hasta winner.
- Crear sala custom con objetivo distinto.
- Dos jugadores entran por Quick Duel.
- Un jugador cambia targeting en una sala de 3.
- League FT3 actualiza resultado de serie.
- Quick Play permite morir y reentrar sin crear sala manual.

### Verificacion

```powershell
npm test
npm run build
npm run test:e2e
```

Para WebRTC real, agregar un E2E multi-contexto con dos browsers. Los tests
actuales mockean API y validan UI, pero no prueban una partida real entre dos
clientes conectados.

## Riesgos

- Host-authoritative no es anti-cheat fuerte.
- Sin TURN, algunas conexiones WebRTC van a fallar.
- Ranking antes de reglas estables crea datos poco confiables.
- T-Spins mal detectados rompen la confianza competitiva.
- Quick Play persistente puede crecer mas que Vercel/Redis simple.

## Referencias Externas

- https://tetris.wiki/Tetr.io
- https://tetrio.github.io/faq/mechanics.html
- https://tetr.io/about/patchnotes/
- https://ch.tetr.io/
