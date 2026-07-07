import { getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { NGE, parseNgeUri, NgeError, type NgeBinding } from './nge.js';
import { OnlineRoomError } from './roomService.js';
import { parseBetStateEvent, type NgpBetState } from './lunaNegraEvents.js';

// Núcleo NGE-backed de las apuestas de Tetris (Opción B: corte duro, sin path
// custodial legacy). Reemplaza a lunaNegraNgp.ts + la config de lunaNegraEvents.ts:
// una sola credencial `NGE_CONNECTION` (la "NWC del escrow") aporta la clave de
// servicio (=oráculo), los relays, el escrow, y —vía el `bind` event— la
// coordenada del juego, el lud16 de depósito, los límites y las comisiones.
//
// El SDK (`nge.ts`, vendorizado de Luna) hace la coordinación del escrow (contrato
// 1339, resultado 1341, estado 31340). Lo que NO cubre el SDK y se queda en Tetris:
// el 9734 de depósito con el tag `lnurl` que exige Luna (buildDepositZapRequestTemplate
// en lunaNegraEvents.ts) y toda la plomería de sala/pozo.

/** ¿Está configurada la credencial NGE? Es el ÚNICO gate (reemplaza el trío
 *  ngpBetsEnabled/ngpKeylessEnabled/ngpEventsEnabled). */
export function ngeConnected(): boolean {
  return Boolean((process.env.NGE_CONNECTION ?? '').trim());
}

/** Crea una instancia del SDK por invocación (los sockets no persisten en
 *  serverless) y la cierra al terminar. Lanza OnlineRoomError si la URI es inválida. */
async function withNge<T>(fn: (nge: NGE) => Promise<T>): Promise<T> {
  let nge: NGE;
  try {
    nge = NGE.fromEnv();
  } catch (e) {
    const msg = e instanceof NgeError ? e.message : 'NGE_CONNECTION inválida';
    throw new OnlineRoomError(`NGE no configurado: ${msg}`, 500);
  }
  try {
    return await fn(nge);
  } finally {
    nge.close();
  }
}

/** Pubkey (hex) del oráculo/servicio derivada del `secret` de NGE_CONNECTION, o null
 *  si no hay credencial. Para diagnóstico y matcheo del 1341 en relays. */
export function ngeOraclePubkey(): string | null {
  if (!ngeConnected()) return null;
  try {
    return getPublicKey(parseNgeUri(process.env.NGE_CONNECTION!.trim()).secretKey);
  } catch {
    return null;
  }
}

// Binding cacheado por instancia serverless (coordenada/lud16/límites no cambian
// salvo que Luna reemita la credencial o toque la economía). Reemplaza termsCache
// de lunaNegraEvents.ts y la lectura de LUNA_NEGRA_GAME_COORD.
let bindingCache: (NgeBinding & { escrowPubkey: string; oraclePubkey: string }) | null = null;

export interface NgeConfig {
  escrowPubkey: string;
  oraclePubkey: string;
  gameCoord: string;
  lud16: string;
  minStakeSats: number;
  maxStakeSats: number;
  feePct: number;
}

/** Resuelve la config del `bind` event (una lectura de relays, cacheada). Reemplaza
 *  fetchNgpConfig (REST) y fetchNgpTerms (evento terms) + LUNA_NEGRA_GAME_COORD. */
export async function fetchNgeConfig(): Promise<NgeConfig> {
  if (bindingCache) return toConfig(bindingCache);
  return withNge(async (nge) => {
    const b = await nge.binding().catch((e) => {
      const msg = e instanceof NgeError ? e.message : 'no se pudo leer el bind del escrow';
      throw new OnlineRoomError(`NGE: ${msg}`, 502);
    });
    if (!b.lud16) {
      throw new OnlineRoomError('El bind del escrow no trae lud16 de depósito.', 502);
    }
    bindingCache = { ...b, escrowPubkey: nge.escrowPubkey, oraclePubkey: nge.oraclePubkey };
    return toConfig(bindingCache);
  });
}

function toConfig(b: NgeBinding & { escrowPubkey: string; oraclePubkey: string }): NgeConfig {
  return {
    escrowPubkey: b.escrowPubkey,
    oraclePubkey: b.oraclePubkey,
    gameCoord: b.gameCoord,
    lud16: b.lud16 as string,
    minStakeSats: b.minStakeSats,
    maxStakeSats: b.maxStakeSats,
    feePct: b.feePct ?? 0,
  };
}

export function resetNgeConfigCacheForTests(): void {
  bindingCache = null;
}

/** LNURL-pay de la tienda derivado del lud16 del bind (`name@host` →
 *  `https://host/.well-known/lnurlp/name`). Reemplaza storeLnurlUrl(baseUrl): el
 *  riel de depósito ya no depende de LUNA_NEGRA_BASE_URL. */
export function ngeStoreLnurlUrl(lud16: string): string {
  const [name, host] = lud16.split('@');
  if (!name || !host) throw new OnlineRoomError(`lud16 inválido en el bind: ${lud16}`, 502);
  return `https://${host}/.well-known/lnurlp/${name}`;
}

/**
 * Crea la apuesta: firma+publica el contrato 1339 con la clave de NGE_CONNECTION y
 * devuelve el id del contrato (= betId de tracking; Luna lo materializa lazy al
 * primer depósito). Reemplaza publishBareNgpContract + createBetViaEvents.
 */
export async function createNgeContract(params: {
  participantPubkeys: string[];
  stakeSats: number;
  victoryCondition: string | undefined;
  roomId: string;
}): Promise<string> {
  return withNge(async (nge) => {
    try {
      const res = await nge.createBet({
        seats: params.participantPubkeys,
        stakeSats: params.stakeSats,
        windowSec: 3600,
        roomId: params.roomId,
        memo: params.victoryCondition?.slice(0, 280) || 'Último jugador en pie gana el pozo.',
      });
      return res.contractId;
    } catch (e) {
      if (e instanceof NgeError) {
        // STAKE_OUT_OF_RANGE u otros límites del bind → 400; publish → 502.
        const status = e.code === 'STAKE_OUT_OF_RANGE' ? 400 : 502;
        throw new OnlineRoomError(`NGE: ${e.message}`, status);
      }
      throw e;
    }
  });
}

/** Reporta el ganador: firma+publica el 1341 con la clave de oráculo (=secret).
 *  Vacío = empate → reembolso. Reemplaza signNgpResultEvent + publishSignedEventToRelays. */
export async function reportNgeResult(contractId: string, winnerNpubs: string[]): Promise<void> {
  await withNge(async (nge) => {
    try {
      await nge.reportResult(contractId, { winners: winnerNpubs });
    } catch (e) {
      const msg = e instanceof NgeError ? e.message : 'no se pudo publicar el resultado';
      throw new OnlineRoomError(`NGE: ${msg}`, 502);
    }
  });
}

/** Anula la apuesta (reembolso) publicando un 1341 status=void. Con clave única
 *  (secret=oráculo=servicio) alcanza UN evento. Reemplaza publishNgpVoidEvents. */
export async function voidNgeBet(contractId: string): Promise<void> {
  await withNge(async (nge) => {
    try {
      await nge.voidBet(contractId);
    } catch (e) {
      const msg = e instanceof NgeError ? e.message : 'no se pudo publicar la anulación';
      throw new OnlineRoomError(`NGE: ${msg}`, 502);
    }
  });
}

/** Estado de la apuesta desde el 31340 (autor=escrow, d=contrato) leído por el SDK
 *  en los relays de la credencial. Reusa el parser puro de lunaNegraEvents. Devuelve
 *  null si Luna todavía no publicó estado. Reemplaza fetchNgpBetState. */
export async function fetchNgeBetState(contractId: string): Promise<NgpBetState | null> {
  return withNge(async (nge) => {
    const s = await nge.state(contractId).catch(() => null);
    if (!s) return null;
    return parseBetStateEvent(s.event);
  });
}

export function pubkeyFromNpub(npub: string): string {
  if (npub.startsWith('npub1')) {
    try {
      const { type, data } = nip19.decode(npub);
      if (type === 'npub') return data as string;
    } catch {}
  }
  return npub;
}
