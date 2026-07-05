// Espejo de marcadores hacia Luna Negra (§6 de la integración).
//
// Tetris mantiene su ranking AUTORITATIVO propio (Durable Object de PartyServer):
// victorias multijugador y tiempo de Supervivencia. Además empujamos ese puntaje
// a los marcadores de Luna Negra para que el jugador aparezca en el ranking de la
// tienda (descubrimiento del juego).
//
// Server-to-server con API key: el endpoint /api/v1/leaderboards/{name}/scores
// acepta `{ gameId, npub, score }` del proveedor (Luna valida que el juego sea
// suyo). La API key NUNCA sale del servidor. El puntaje lo decide nuestro store
// autoritativo, no el cliente.
//
// Best-effort por diseño: el ranking de Luna es secundario; sin config o ante
// cualquier fallo logueamos y seguimos, nunca cortamos el flujo del jugador.

// Nombres de los marcadores en Luna Negra (los elige el juego).
export const LUNA_BOARD_WINS = 'victorias';
export const LUNA_BOARD_SURVIVAL = 'supervivencia';

// Tope que acepta Luna Negra (entero 0…1e9).
const MAX_LUNA_SCORE = 1_000_000_000;

interface LunaLeaderboardConfig {
  baseUrl: string;
  apiKey: string;
  gameId: string;
}

function readConfig(): LunaLeaderboardConfig | null {
  const baseUrl = (process.env.LUNA_NEGRA_BASE ?? '').replace(/\/+$/, '');
  const apiKey = (process.env.LUNA_NEGRA_API_KEY ?? '').trim();
  const gameId = (process.env.LUNA_NEGRA_GAME_ID ?? '').trim();
  if (!baseUrl || !apiKey || !gameId) return null;
  return { baseUrl, apiKey, gameId };
}

/**
 * Empuja un puntaje al marcador `name` de Luna Negra en nombre de `npub`.
 * Solo cuentan jugadores con cuenta (npub): los invitados no tienen marcador.
 * Nunca lanza: ante falta de config, npub ausente/ inválido o error de red,
 * loguea y resuelve. Devuelve true si el envío respondió 2xx.
 */
export async function mirrorLunaScore(
  name: string,
  npub: string | null | undefined,
  score: number,
): Promise<boolean> {
  const config = readConfig();
  if (!config) return false;
  if (!npub || !npub.startsWith('npub1')) return false;
  const value = Math.floor(score);
  if (!Number.isFinite(value) || value < 0) return false;
  const clamped = Math.min(value, MAX_LUNA_SCORE);
  try {
    const response = await fetch(
      `${config.baseUrl}/api/v1/leaderboards/${encodeURIComponent(name)}/scores`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ gameId: config.gameId, npub, score: clamped }),
      },
    );
    if (!response.ok) {
      console.warn(`[luna-negra] espejo de marcador ${name} → HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`[luna-negra] espejo de marcador ${name} falló:`, error);
    return false;
  }
}
