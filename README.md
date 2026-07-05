# TETRA

Un juego de bloques que caen, en el navegador, para jugar solo o con amigos.
Entrás, armás líneas y competís: a ver quién aguanta más, quién gana la batalla
o quién se lleva el pozo.

**Jugar:** https://tetra.naranja.fit

TETRA nació para la hackathon de La Crypta (edición gaming) y se apoya en
**Luna Negra** para el login y para las apuestas en sats. Igual se puede jugar de
una, sin cuenta ni nada: abrís el link y arrancás.

## Modos de juego

- **Supervivencia.** Reglas iguales para todos. Aguantá lo máximo posible; hay un
  ranking mundial por tiempo.
- **Custom.** Configurás gravedad, objetivo y reglas a tu gusto para jugar solo.
- **Duelo local 1v1.** Dos jugadores en la misma computadora, misma secuencia de
  piezas, sin cuenta ni conexión.
- **Batalla online.** Salas multijugador con amigos: las líneas que hacés le mandan
  basura al rival y gana el último en pie. Hay ranking por victorias.

## Apuestas en sats (opcional)

Con la integración de Luna Negra podés sumarle un pozo a la partida: cada jugador
deposita el mismo monto en sats y el ganador se lo lleva entero (menos la comisión
de Luna Negra). Funciona tanto en las batallas online como en el duelo local, y
siempre lo activa quien arma la sala. Si no querés apostar, jugás igual.

Para pagar y cobrar se usa Lightning: alcanza con escanear un QR o, si tenés una
extensión de navegador compatible (como Alby), con un clic.

## Controles por defecto

Se pueden reasignar desde los ajustes del juego.

| Acción | Tecla |
| --- | --- |
| Mover izquierda / derecha | ← / → |
| Bajar suave | ↓ |
| Caída rápida | Espacio |
| Girar a la derecha | ↑ / X |
| Girar a la izquierda | Z |
| Media vuelta (180°) | A |
| Guardar pieza | C / Shift |
| Reiniciar | R |
| Pausa | Escape |
| Silenciar | M |
| Cambiar de música | N |

## Para desarrollar

### Stack

- **Vite** — servidor de desarrollo y build.
- **TypeScript** — tipado estático.
- **PixiJS** — render 2D.
- **partyserver** (Cloudflare Workers + Durable Objects) — salas online en tiempo real.
- **Vitest** — pruebas unitarias.
- **Playwright** — pruebas end-to-end.

### Puesta en marcha

```bash
npm install
npm run dev
```

Vite levanta el sitio en `127.0.0.1`; la terminal muestra el puerto.

### Comandos

```bash
npm run test       # pruebas unitarias
npm run test:e2e   # pruebas end-to-end
npm run build      # compilación de producción
npm run preview    # sirve el build
```

Si Playwright no encuentra un navegador, instalalo con
`npx playwright install chromium`.

Para las salas online (Worker de Cloudflare):

```bash
npm run party:dev      # Worker en local
npm run party:deploy   # deploy
```

## Replays

Las partidas terminadas se guardan localmente con su repetición, y se pueden
exportar a JSON. El archivo incluye semilla, reglas, configuración de controles,
resultado y las entradas registradas cuadro a cuadro: sirve para auditar una corrida
o reproducirla más adelante.

## Música

El catálogo de pistas se arma solo a partir de los archivos en `src/audio/music/`.

- **Agregar una pista:** copiá el archivo (`.m4a`, `.mp3` u `.ogg`) a la carpeta.
  Aparece sola.
- **Quitar una pista:** borrá el archivo. Desaparece sola.

No hace falta tocar código: Vite descubre los archivos con `import.meta.glob`. En
desarrollo, si el watcher no toma un archivo nuevo al instante, reiniciá el servidor.

Opcionalmente, en `src/audio/music.ts` se ajustan dos cosas (ambas usan el nombre
del archivo sin extensión como clave):

- `TITLE_OVERRIDES`: el título que se ve en pantalla. Lo que no esté listado se
  genera del nombre del archivo (`tetris-theme-reworked` → `Tetris Theme Reworked`).
- `ORDER`: el orden de la playlist. Lo listado va primero; lo nuevo cae al final, en
  orden alfabético.

## Configuración del backend (Luna Negra)

Variables de entorno (en Vercel) para habilitar las apuestas:

| Variable | Para qué |
| --- | --- |
| `LUNA_NEGRA_BASE` | URL del deploy de Luna Negra (también valida invites). |
| `LUNA_NEGRA_API_KEY` | API key del proveedor (`ln_sk_…`). Única credencial requerida: crea/lee/cancela apuestas, reporta al ganador y registra el webhook. |
| `LUNA_NEGRA_GAME_SLUG` | (Opcional) Slug de TETRA en Luna Negra para el botón de login. Por defecto `tetris-beta`. |
| `LUNA_NEGRA_GAME_ID` | (Opcional) Fallback del `gameId`; normalmente no hace falta (se toma del `inviteToken`). |
| `LUNA_NEGRA_WEBHOOK_URL` | (Opcional) Fuerza la URL de webhook a registrar; si no, se deriva del dominio del deploy. |
| `LUNA_NEGRA_WEBHOOK_SECRET` | (Opcional) Override del secreto de firma; normalmente no hace falta (se obtiene solo). |
| `PARTY_BRIDGE_TOKEN` | Token compartido entre Vercel y el Worker de salas para que apuestas, webhooks e invites lean/escriban la sala WebSocket autoritativa. |
| `PARTY_BRIDGE_URL` | (Opcional) URL del Worker de salas. Por defecto `https://tetra.naranjas.workers.dev`. |

El juego **no toca Nostr** directamente: el ganador se reporta con la API key y Luna
Negra firma el resultado con su oráculo. El **webhook se registra solo** al crear la
primera apuesta (cachea el secreto de firma), así que no hace falta configurarlo a
mano. Sin webhooks igual funciona: el lobby refresca el estado por polling.
