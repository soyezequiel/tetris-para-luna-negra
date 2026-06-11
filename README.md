# TETRA

Juego web de tetris con capacidad multijugador basado en las herramientas proporcionadas por luna negra otro proyecto a presentar en la hackatón, creado para la hackathon de La Crypta. Este mes la consigna es gaming, asi que el proyecto apunta a una experiencia directa: entrar y jugas con tus amigos de nostr.
Podes apostar satoshis gracias a la integracion de luna negra que hace de scrow.

https://tetris-para-luna-negra.vercel.app/
## Caracteristicas

- Modo objetivo de 40 lineas.
- Renderizado con PixiJS.
- Motor deterministicamente testeable con bolsa de 7 piezas.
- Controles configurables desde la pantalla del juego.
- Ajustes de DAS (Delayed Auto Shift, desplazamiento automatico retrasado) y ARR (Auto Repeat Rate, velocidad de repeticion automatica).
- Guardado local de mejor tiempo, volumen y configuracion.
- Historial local de partidas con replays reproducibles.
- Sonidos, musica y cambio de pista.
- Exportacion de replay (repeticion) en JSON.

## Stack tecnico

- Vite para desarrollo y build (compilacion).
- TypeScript para tipado estatico.
- PixiJS para render 2D.
- Vitest para pruebas automatizadas.
- Playwright para pruebas E2E (End-to-End, de punta a punta).

## Instalacion

```bash
npm install
```

## Desarrollo

```bash
npm run dev
```

Vite levanta el sitio en `127.0.0.1`. La terminal muestra el puerto disponible.

## Comandos utiles

```bash
npm run test
npm run test:e2e
npm run build
npm run preview
```

Si Playwright no encuentra un navegador local, instalalo con:

```bash
npx playwright install chromium
```

## Apuestas con Luna Negra (escrow Lightning)

Las salas privadas creadas vía Luna Negra (con `?inviteToken=`) soportan un pozo
"winner-takes-all": cada jugador deposita el mismo monto en sats y el ganador se
lleva el pozo (menos la comisión de Luna Negra). Es **opcional**: el host la activa
desde el lobby.

Flujo: el host crea la apuesta → cada jugador deposita su stake (invoice / LNURL /
deep-link) → cuando el pozo está completo se habilita **Start** → al terminar la
partida el servidor reporta el ganador firmando un evento Nostr y Luna Negra paga.

Variables de entorno (Vercel) para habilitarlo en el backend:

| Variable | Para qué |
| --- | --- |
| `LUNA_NEGRA_BASE_URL` | URL del deploy de Luna Negra (también valida invites). |
| `LUNA_NEGRA_API_KEY` | API key del proveedor (`ln_sk_…`) — única credencial requerida: crea/lee/cancela apuestas, reporta ganador y registra el webhook. |
| `LUNA_NEGRA_GAME_SLUG` | (Opcional) Slug de TETRA en Luna Negra para el botón de login; por defecto `tetris`. |
| `LUNA_NEGRA_GAME_ID` | (Opcional) Fallback del `gameId`; normalmente **no hace falta** porque se toma del `inviteToken`. |
| `LUNA_NEGRA_WEBHOOK_URL` | (Opcional) Fuerza la URL de webhook a registrar; si no, se deriva del dominio del deploy. |
| `LUNA_NEGRA_WEBHOOK_SECRET` | (Opcional) Override del secreto de firma; normalmente **no hace falta** (se obtiene solo). |

> El juego **no toca Nostr**: el ganador se reporta con la API key y Luna Negra firma
> el resultado con el oráculo gestionado del proveedor.
>
> **El webhook se registra solo**: al crear la primera apuesta, el backend registra su
> URL (`…/api/webhooks/luna-negra`) con la API key y cachea el secreto de firma. No
> hace falta configurarlo a mano en el panel ni pegar `LUNA_NEGRA_WEBHOOK_SECRET`.

Configurá además la **URL de webhook** en /provider apuntando a
`https://<tu-deploy>/api/webhooks/luna-negra`. Sin webhooks igual funciona: el lobby
refresca el estado de la apuesta por polling.

## Controles por defecto

| Accion | Tecla |
| --- | --- |
| Mover izquierda | Flecha izquierda |
| Mover derecha | Flecha derecha |
| Caida suave | Flecha abajo |
| Caida dura | Espacio |
| Rotar horario | Flecha arriba / X |
| Rotar antihorario | Z |
| Guardar pieza | C / Shift |
| Reiniciar | R |
| Pausar | Escape |
| Silenciar sonido | M |
| Cambiar musica | N |

## Replays

El juego guarda localmente las partidas terminadas y top outs con sus replays. Tambien permite exportar una repeticion en formato JSON. El archivo incluye semilla, reglas, configuracion de controles, resultado y entradas registradas por frame. Esto permite auditar una corrida y deja una base preparada para ranking, validacion o reproduccion futura.
