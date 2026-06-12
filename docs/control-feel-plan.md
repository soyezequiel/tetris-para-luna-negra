# Plan de Game Feel: Controles (solo + multijugador)

Objetivo: que mover, rotar y soltar piezas se sienta más ágil, suave y preciso,
estilo TETR.IO, **sin** rediseñar la lógica ni perder el "peso" actual del juego.
Mejora fina y progresiva, no un cambio brusco.

Feedback que origina este plan: "el juego se siente algo duro; al mover una
pieza parece que tarda un poco en reaccionar".

---

## 1. Diagnóstico

### 1.1 Mapa del pipeline de input (estado actual)

```
keydown (window) ──> InputController.queue (inmediato, sin esperar frame)
                          │
rAF loop (main.ts) ──> advanceFrame(candidateFrame) + collect(candidateFrame)
                          │  (DAS/ARR se resuelven acá, en frames de 60Hz)
                          │
advanceGameToFrame ──> engine.tick(frame, inputs)  [inputs ANTES de gravedad ✓]
                          │
renderer.render(state) en el MISMO rAF  [latencia visual ≤ 1 frame ✓]
```

La arquitectura base es sana: el input se aplica antes de la gravedad del mismo
tick y se renderiza en el mismo rAF. La latencia teórica del tap inicial es
≤ 16,7ms @60Hz — estándar. La "dureza" no viene de un retraso grande único,
sino de la suma de los puntos siguientes.

### 1.2 Problemas encontrados (ordenados por impacto)

**P1 — ARR pierde repeats ante jitter de frames** (`src/input.ts:55-61`).
`collect()` decide el repeat con `(age - dasFrames) % arrFrames === 0`
evaluado solo en el frame candidato. Si el loop salta un frame (GC, picos de
CPU, pestaña, monitor que no clava 60Hz), el repeat que "caía" en el frame
salteado se pierde en vez de acumularse. Resultado: el auto-repeat se siente
irregular y "trabado" justo cuando más se nota (cargando DAS hacia la pared).
Fix: pasar de módulo a **acumulador** — guardar `nextRepeatFrame` por tecla y
emitir todos los repeats pendientes `<= frame` (pueden ser varios en un mismo
collect).

**P2 — La velocidad del juego depende del refresh rate del monitor**
(`src/main.ts:457-472`). `targetGameplayFrame()` devuelve
`Math.max(gameFrame + 1, elapsedFrames)`: cada rAF fuerza **al menos** un frame
de engine. En un monitor de 120/144Hz el juego entero corre ~2-2,4× más rápido
(gravedad, DAS, ARR, lock delay, todo). En 60Hz se ve bien; en otros equipos el
feel es directamente otro juego. Verificar primero en un monitor high-refresh
(o `chrome://flags` + monitor externo); si se confirma, cambiar a
`Math.max(gameFrame, elapsedFrames)` con dos cuidados:
- cuando `candidateFrame === gameFrame` los inputs recolectados ese rAF **no
  deben descartarse**: bufferizarlos hasta el próximo tick real (hoy
  `advanceGameToFrame` solo aplica inputs en el frame final del catch-up);
- el path online usa la misma función anclada al reloj del server
  (`startsAtServerMs`): el fix aplica igual y de hecho mejora la alineación
  host/cliente.

**P3 — Sin prioridad entre izquierda y derecha simultáneas** (`src/input.ts:47-64`).
Si el jugador mantiene ambas direcciones (muy común al "rolear" rápido), las
dos repiten a la vez y la pieza tiembla. TETR.IO usa "la última tecla gana"
(la dirección presionada más recientemente silencia a la otra mientras ambas
estén apretadas; al soltar, la anterior recupera el control con su DAS ya
cargado). Fix localizado en `InputController`.

**P4 — Piso de ARR = 1 frame (16,7ms)** (`src/input/settings.ts:67`,
`MIN_ARR_FRAMES = 1`). No existe ARR 0 ("instantáneo a la pared"), que es la
seña de identidad del control TETR.IO competitivo. Con ARR 0 la pieza cruza el
tablero en 1 frame una vez cargado el DAS. Implementación: con `arrFrames === 0`,
`collect()` emite tantos `moveLeft/Right` como ancho del tablero en ese frame
(el engine ya soporta múltiples inputs por frame y `tryMove` frena en colisión,
así que es compatible con replays y protocolo online sin tocar nada más).

**P5 — Soft drop fijo y no configurable** (`src/game/rules.ts:4-5`). Hoy es
40 celdas/s (factor 40× hardcodeado). Está bien como default, pero TETR.IO
ofrece SDF configurable hasta infinito ("instant soft drop": la pieza baja al
piso sin lockear). Falta exponerlo como opción.

**P6 — Tap inicial perdido durante el countdown**. Si el jugador toca (no
mantiene) una dirección durante la cuenta regresiva, ese input se descarta.
Mantener la tecla sí pre-carga DAS (comportamiento TETR.IO-correcto que ya
funciona de rebote). Menor, pero pulible: bufferizar el último tap de cada
acción durante el countdown y aplicarlo en el frame 1.

**P7 — Feedback sensorial del movimiento**. `playImmediateInputSounds` ya
dispara sonido en el mismo rAF (bien). Verificar que el sample de "move" sea
corto y con ataque seco (un sonido con fade-in de 20ms se percibe como lag).
**No** interpolar visualmente la posición X de la pieza: TETR.IO mueve en
saltos discretos instantáneos; suavizar la X se leería como más lag, no menos.

### 1.3 Lo que NO está mal (no tocar)

- DAS default 8 frames (133ms) ya es **más rápido** que el default de TETR.IO
  (~167ms). ARR 2 (33ms) empata el default de TETR.IO. La queja de dureza no
  se arregla bajando números a lo loco: se arregla con P1-P4 (precisión) y
  recién después micro-ajustando defaults.
- Lock delay 30 frames (500ms) + 15 resets: estándar guideline, igual a TETR.IO.
- Hard drop instantáneo con su propio SFX/efecto: OK.
- Rotación con kicks aplicada antes de la gravedad del mismo tick: OK.
- DAS se conserva entre piezas (la tecla mantenida sigue cargada al spawnear):
  comportamiento TETR.IO-correcto que ya funciona.

---

## 2. Parámetros: dónde viven y referencia TETR.IO

| Parámetro | Valor actual | Dónde | TETR.IO default | TETR.IO competitivo |
|---|---|---|---|---|
| DAS | 8 f (133ms) | `rules.ts` `dasFrames` + `input/settings.ts` | ~167ms | 83-117ms |
| ARR | 2 f (33ms), mín 1 | ídem `arrFrames` | ~33ms | 0-17ms |
| SDF (soft drop) | 40 celdas/s fijo | `rules.ts` `softDropCellsPerFrame` | 6× gravedad | 20×-infinito |
| Lock delay | 30 f (500ms) | `rules.ts` `lockDelayFrames` | ~500ms | ídem |
| Lock resets | 15 | `rules.ts` `lockResetLimit` | 15 | ídem |
| DCD (DAS cut delay) | no existe | — | ~17ms | 0-17ms |
| Prioridad L/R | ninguna (P3) | `input.ts` | última gana | ídem |
| Repeat scheduling | módulo (P1) | `input.ts` | por-tick acumulado | ídem |

DCD (retraso del ARR tras rotar/holdear con DAS cargado) queda como opcional de
última fase: es polish para jugadores muy finos, no causa de la queja actual.

---

## 3. Solo vs. multijugador

La buena noticia estructural: **el handling es 100% local en ambos modos**.
DAS/ARR se resuelven en `InputController` antes de que los inputs sellados
(`{frame, action}`) viajen por `sendOnlineInputsToHost` o se graben en el
replay. Cambiar timing de handling no toca el protocolo ni el server.

Cuidados específicos:

1. **Timeline de frames online**: host y cliente anclan el frame al reloj del
   server. El fix de P2 modifica `targetGameplayFrame()`, que es compartida:
   probar explícitamente una batalla online tras el cambio (con el monitor
   high-refresh si se confirma el bug).
2. **Replays**: graban inputs por frame + settings. ARR 0 genera varios moves
   en el mismo frame — el formato ya lo soporta (array por frame), pero
   verificar export/import round-trip con un replay ARR 0.
3. **Determinismo del engine**: misma seed + mismos inputs = mismo resultado.
   Ningún cambio de este plan debe tocar `engine.tick()` salvo lo estrictamente
   necesario; los tests de `tests/engine.test.ts` son la red de seguridad.
4. **Retry online deshabilitado / countdown multi**: el buffering de P6 debe
   respetar `canAdvanceGame` y no inyectar inputs en modos donde el juego no
   avanza.
5. **Igualdad de condiciones**: los settings de handling son por-jugador (como
   TETR.IO); no hace falta sincronizarlos ni validarlos server-side.

---

## 4. Cómo probar sin romper la jugabilidad

1. **Tests unitarios nuevos de `InputController`** (hoy casi no tiene):
   - DAS exacto: tap = 1 celda; mantener = primer repeat en frame `das`, luego cada `arr`.
   - Jitter: si `collect` salta del frame N al N+2, no se pierde ningún repeat (P1).
   - Prioridad última-tecla-gana con L+R mantenidas y al soltar (P3).
   - ARR 0: cruza el tablero en el primer frame post-DAS (P4).
   - Pre-carga de DAS durante countdown + tap bufferizado (P6).
2. **Determinismo**: correr `npm test` (engine + roomService) intacto; agregar
   un test de replay round-trip con los nuevos settings extremos.
3. **e2e**: `npm run test:e2e` existente; agregar un spec que ajuste DAS/ARR
   desde la UI de settings y verifique persistencia en `stack40.inputSettings`.
4. **Overlay de debug dev-only** (detrás de flag, estilo TRUCO AUTOPLAY):
   frame actual, DAS charge por tecla, inputs aplicados por frame, repeats
   emitidos vs. esperados. Es la herramienta para "ver" el feel.
5. **Verificación cross-refresh**: misma partida de 30s en monitor 60Hz y
   120/144Hz; cronometrar cuánto tarda una pieza en caer (P2).
6. **Migración de settings**: ya existe el patrón `LEGACY_DEFAULT_TIMINGS` en
   `input/settings.ts` para migrar a usuarios que tengan el default viejo
   guardado; reutilizarlo si se cambian defaults en Fase 3.
7. **Sesión de juego manual** tras cada fase (solo + 1 batalla online), ideal
   con la persona que dio el feedback de "duro".

---

## 5. Métricas y criterios de éxito

**Objetivas:**
- Repeats perdidos por minuto (contador en el overlay de debug): debe ser 0
  tras P1, incluso forzando jitter (throttling de CPU en DevTools).
- Velocidad de juego idéntica en 60Hz y 144Hz (±1%) tras P2.
- Tiempo input→cambio visible: medir con `performance.mark` en keydown vs.
  render; objetivo ≤ 1 frame + present. (Opcional: grabación a 240fps con el
  celular para validar end-to-end real.)
- 40L: tiempo personal y KPM antes/después no deben empeorar; idealmente
  mejoran con ARR más fino.

**Subjetivas (checklist con el tester):**
- Tap de 1 celda: 10/10 intentos mueven exactamente 1 celda.
- Cargar DAS hasta la pared: llegada consistente, sin tartamudeo.
- L+R rápido alternado: la pieza obedece a la última tecla, sin temblar.
- Soft drop: "baja cuando quiero que baje".
- Pregunta directa: "¿sigue sintiéndose duro? ¿dónde?"

**Criterio de no-regresión:** nadie que juegue con los settings actuales
guardados nota un cambio no pedido (las fases 1-2 no cambian defaults).

---

## 6. Valores iniciales recomendados para experimentar

| Parámetro | Hoy | Paso 1 (tras fixes) | Rango a explorar |
|---|---|---|---|
| DAS | 8 f (133ms) | 8 f (sin cambio) | 6-8 f (100-133ms) |
| ARR | 2 f (33ms) | 1 f (16,7ms) | 0-2 f |
| ARR mínimo en UI | 1 | 0 | — |
| SDF | 40 c/s fijo | 40 c/s default, configurable | 20 / 40 / instantáneo |
| Lock delay | 30 f | 30 f (no tocar) | — |
| DCD | — | — | 0-1 f (Fase 4, opcional) |

**Presets de handling sugeridos** (un click en settings, en vez de pedirle al
jugador que entienda frames):
- **Clásico**: DAS 10 / ARR 2 / SDF 20 — más peso, estilo guideline.
- **Actual** (default): DAS 8 / ARR 2 / SDF 40 — lo de hoy, ya con los fixes.
- **Ágil**: DAS 7 / ARR 1 / SDF 40 — el candidato a nuevo default.
- **Competitivo**: DAS 6 / ARR 0 / SDF instantáneo — estilo TETR.IO tryhard.

La filosofía del usuario ("no eliminar la pequeña demora, ajustarla apenas") se
traduce en: **DAS casi no se toca** (ahí vive el "peso"), la agilidad se gana
en ARR, SDF y, sobre todo, en la precisión de P1-P3 que es gratis en feel.

---

## 7. Estrategia gradual (fases)

**Fase 0 — Instrumentar y asegurar** (sin cambio de gameplay)
Overlay de debug + tests unitarios de `InputController` que documenten el
comportamiento actual. Verificar P2 en monitor high-refresh.

**Fase 1 — Correcciones de precisión** (invisibles en números, grandes en feel)
P1 (acumulador de ARR), P3 (prioridad última-tecla), P2 (independencia del
refresh rate, con buffering de inputs). Defaults intactos. Gate: tests verdes,
checklist subjetiva, partida online de humo.

> **Estado:** P1 y P3 implementados en `src/input.ts` (reescritura de
> `InputController`: acumulador robusto a jitter + last-key-wins con DAS
> preservado). Soporte de ARR 0 ya cableado (inactivo hasta Fase 2). Cubierto
> por `tests/input.test.ts` (7 tests). `npm test` (136), `tsc` y `npm run build`
> en verde. **Pendiente P2** (refresh rate): requiere verificar primero en un
> monitor 120/144Hz; toca `targetGameplayFrame()`, compartida con online.
> Verificación en navegador del feel real pendiente de una pestaña enfocada (el
> preview headless pausa el rAF).

**Fase 2 — Nuevas opciones, mismos defaults**
P4 (ARR 0 habilitado en UI), P5 (SDF configurable), P6 (buffer de countdown),
presets de handling en settings. Quien no toca nada, no nota nada.

> **Estado:** P4 y P5 implementados + presets de handling.
> - `MIN_ARR_FRAMES = 0` en `input/settings.ts` (el controlador ya hace la
>   ráfaga a la pared con ARR 0).
> - `softDropFactor` agregado a `InputSettings`, normalizado [5, 41] (41 = ∞),
>   mapeado por `softDropCellsPerFrameForFactor()` en `game/rules.ts` y
>   threadeado a las 4 funciones de reglas (solo/battle/online/custom).
> - Presets `HANDLING_PRESETS` (Clásico / Actual / Ágil / Competitivo) +
>   `applyHandlingPreset` / `matchHandlingPreset`. UI: fila de soft drop, botones
>   de preset con resaltado del activo (`renderHandlingPresets`) y CSS en
>   `styles.css`.
> - Tests nuevos en `tests/input.test.ts` (mapeo SDF, ARR 0, normalización,
>   presets) + ajuste del test legacy que asumía ARR mín 1. `npm test` (141),
>   `tsc` y `build` en verde. Data layer verificado en vivo (`softDropFactor`
>   presente, cambio de modo OK). **Pendiente:** verificación visual del panel
>   (bloqueada por el preview headless con rAF pausado) y P6 (buffer de
>   countdown), que queda como último ítem de la fase.

**Fase 3 — Ajuste de defaults**
Probar "Ágil" (DAS 7/ARR 1) como default con el tester ~1 semana. Si convence,
migrar con el patrón `LEGACY_DEFAULT_TIMINGS` para no pisar settings
personalizados. Si no, queda como preset.

**Fase 4 — Polish opcional**
DCD configurable, revisión del SFX de move (ataque seco), micro-FX de dash a la
pared con ARR 0 (partículas ya existentes en JuiceFX, sin tocar timing).

Cada fase termina con: `npm test` + `npm run build` + `npm run test:e2e` +
sesión manual solo/online + feedback. Una fase no empieza hasta cerrar la
anterior. Cualquier cambio de default es reversible vía preset.
