# STACK/40

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
