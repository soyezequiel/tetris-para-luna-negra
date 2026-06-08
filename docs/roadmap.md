# TETRA Roadmap

Este documento ignora el README y parte del estado actual del codigo: juego 40L jugable, menu/pausa, input settings, export/import de replay y playback basico.

Para el plan de multiplayer versus de ultimo en pie, ver `docs/multiplayer-versus-plan.md`.

## Criterio De Prioridad

1. Primero, persistir valor del gameplay que ya existe.
2. Despues, hacer reproducible y navegable ese valor.
3. Luego, proteger al usuario de perder partidas.
4. Despues, automatizar regresiones.
5. Finalmente, sumar profundidad, nuevos dispositivos y performance.

## P0 - Historial Local De Partidas

### Objetivo

Guardar cada run relevante en `localStorage` para que el jugador pueda revisar progreso, comparar tiempos y recuperar replays sin exportar manualmente.

### Alcance Inicial

- Guardar runs terminadas y top outs.
- Guardar fecha, seed, estado final, lineas, piezas, tiempo, PPS e input count.
- Guardar el replay embebido o una referencia serializada al replay.
- Mostrar un panel simple desde el menu principal.

### Arquitectura

- Crear `src/app/runHistory.ts`.
- Extender `storage.ts` o mantener un storage separado con versionado.
- No meter historial en `GameEngine`; el motor no debe saber que existe persistencia.

### Tareas

1. Definir `RunHistoryEntry`.
2. Crear `loadRunHistory`, `saveRunHistoryEntry`, `clearRunHistory`.
3. Guardar entrada al finalizar `finished` o `gameover`.
4. Agregar accion `Run history` al menu.
5. Renderizar lista compacta con tiempo, fecha, piezas, PPS y estado.
6. Agregar boton `Play replay` por entrada.

### Tests

- Normaliza storage corrupto.
- Limita cantidad maxima de entradas.
- Guarda una run terminada con replay.
- No duplica una run si el loop renderiza muchas veces despues del final.

### Riesgos

- `localStorage` tiene limite de espacio; los replays largos pueden crecer.
- Conviene limitar historial, por ejemplo 50 o 100 runs.

## P1 - Replay Library

### Objetivo

Convertir el historial en una biblioteca reproducible: el jugador entra, elige una partida y la mira sin importar/exportar archivos.

### Alcance Inicial

- Reproducir replay desde historial local.
- Borrar entradas individuales.
- Exportar replay desde una entrada historica.
- Filtrar por `clear`, `top out` y mejores tiempos.

### Arquitectura

- Reusar `ReplayPlayback`.
- Reusar `ExportedReplay`.
- La biblioteca debe vivir en la capa de app, no en el motor.

### Tareas

1. Agregar `library` como `AppMode`.
2. Crear render de biblioteca con lista escaneable.
3. Agregar acciones `play-history-replay`, `export-history-replay`, `delete-history-entry`.
4. Mantener seleccion y errores en estado de app.
5. Agregar export desde historial usando `replayFileName`.

### Tests

- Cargar replay desde entrada local reproduce el resultado.
- Borrar una entrada no rompe las demas.
- Export de entrada historica conserva seed, reglas e inputs.

### Riesgos

- La UI puede saturarse si se muestran demasiados datos.
- Si cambia el formato de replay, hay que migrar o marcar entradas viejas como incompatibles.

## P2 - Confirmaciones De Acciones Destructivas

### Objetivo

Evitar perder una run activa por accidente al tocar `Restart`, `Main menu` o importar un replay.

### Alcance Inicial

- Confirmar solo si hay run activa y no terminal.
- No confirmar en menu inicial ni despues de `finished`/`gameover`.
- Mensajes cortos: `Restart run?`, `Exit run?`, `Import replay and abandon current run?`.

### Arquitectura

- Agregar `pendingConfirmAction` al estado de app.
- Renderizar confirmacion como overlay ligero dentro del mismo sistema visual.
- Ejecutar accion solo al confirmar.

### Tareas

1. Crear helper `requiresRunConfirmation`.
2. Interceptar acciones destructivas en `handleOverlayClick`.
3. Renderizar confirmacion con `Cancel` y `Confirm`.
4. Permitir `Escape` para cancelar.

### Tests

- `Restart` durante run activa abre confirmacion.
- Confirmar reinicia.
- Cancelar preserva frame, tablero y modo.
- `Restart` en pantalla final no pide confirmacion.

### Riesgos

- Demasiadas confirmaciones molestan; deben aparecer solo cuando hay perdida real.

## P3 - E2E Tests En El Repo

### Objetivo

Automatizar los flujos principales para evitar regresiones en overlays, botones y file input.

### Alcance Inicial

- Usar Playwright.
- Cubrir menu, start, pause/resume, settings, export, import replay y playback pause/resume.
- Usar Chrome del sistema o documentar instalacion de browsers.

### Arquitectura

- Crear carpeta `tests/e2e`.
- Agregar script `test:e2e` en `package.json`.
- Generar fixtures temporales en `.codex-output` o carpeta temporal.

### Tareas

1. Configurar `playwright.config.ts`.
2. Crear helper para levantar app o asumir `npm run dev`.
3. Test de menu/start/pause.
4. Test de settings rebind/reset.
5. Test de import replay y playback pause/resume.
6. Integrar screenshots solo en fallo.

### Tests

- Estos son los tests; ademas mantener unit tests existentes.

### Riesgos

- Playwright requiere browser instalado.
- En Windows conviene evitar supuestos de rutas Unix.

## P4 - Stats Avanzadas

### Objetivo

Dar feedback competitivo real para 40L: no solo tiempo, tambien calidad de inputs y ritmo.

### Alcance Inicial

- PPS: piezas por segundo.
- Inputs por pieza.
- Lineas por minuto.
- Finesse simple: exceso de inputs por pieza comparado contra minimo ideal, si se define tabla.
- Splits por cada 10 lineas.

### Arquitectura

- Crear `src/game/stats.ts` o `src/app/runStats.ts`.
- Separar stats derivadas de stats del motor.
- Usar replay/input log como fuente para metricas de input.

### Tareas

1. Crear `RunSummary`.
2. Calcular PPS, input count, inputs por pieza.
3. Agregar splits 10/20/30/40 lineas.
4. Mostrar summary al terminar y en historial.
5. Evaluar finesse en una fase posterior.

### Tests

- PPS calcula correctamente sobre frames.
- Inputs por pieza maneja cero piezas.
- Splits se registran al cruzar lineas.

### Riesgos

- Finesse requiere definicion exacta de reglas de movimiento y tabla de optimos.
- Si se calcula mal, puede dar feedback injusto.

## P5 - Controles Touch/Mobile

### Objetivo

Hacer el juego usable en pantalla tactil sin degradar la experiencia de teclado.

### Alcance Inicial

- Botones tactiles para izquierda, derecha, soft drop, hard drop, rotaciones, hold y pausa.
- Layout responsive que no tape el tablero.
- Soporte de mantener presionado izquierda/derecha con DAS/ARR.

### Arquitectura

- Extender `InputController` o crear `TouchInputController`.
- Traducir eventos tactiles a las mismas `ControlAction`.
- Evitar que el motor reciba eventos DOM.

### Tareas

1. Definir layout tactil para portrait y landscape.
2. Crear capa `.touch-controls` visible por media query o deteccion de puntero.
3. Implementar pointer down/up/cancel.
4. Reusar settings de DAS/ARR para movimiento sostenido.
5. Agregar opcion para ocultar controles tactiles.

### Tests

- Pointer down emite accion inicial.
- Mantener izquierda/derecha repite con DAS/ARR.
- Pointer cancel limpia estado presionado.

### Riesgos

- En mobile el espacio vertical es caro.
- Gestos del navegador pueden interferir si no se usa `touch-action` correctamente.

## P6 - Performance Del Bundle

### Objetivo

Reducir o justificar el warning de Vite por chunk mayor a 500 kB.

### Alcance Inicial

- Medir de donde viene el peso.
- Separar Pixi o audio si corresponde.
- No optimizar prematuramente si no afecta carga real.

### Arquitectura

- Analisis primero; despues code splitting si vale la pena.
- Mantener `GameEngine` y tests sin depender de renderer.

### Tareas

1. Agregar analisis de bundle con una herramienta ligera o revisar output de Vite.
2. Confirmar cuanto pesa Pixi.
3. Evaluar `manualChunks` para vendor.
4. Evaluar carga diferida de audio o musica.
5. Medir antes/despues.

### Tests

- `npm run build` debe seguir pasando.
- Verificar que el canvas inicial aparece igual.
- Verificar que audio sigue desbloqueandose con interaccion.

### Riesgos

- Separar chunks puede mejorar warning pero no mejorar experiencia real.
- Dynamic import mal usado puede retrasar el primer render.

## Resumen De Ejecucion

1. P0 - Historial local de partidas.
2. P1 - Replay library.
3. P2 - Confirmaciones destructivas.
4. P3 - E2E tests.
5. P4 - Stats avanzadas.
6. P5 - Controles touch/mobile.
7. P6 - Performance del bundle.

La razon: historial y biblioteca aprovechan directamente replay import/export; confirmaciones protegen la UX; E2E estabiliza lo ya construido; stats agregan profundidad competitiva; touch amplia dispositivos; performance se aborda con medicion cuando el producto ya tiene mas superficie real.
