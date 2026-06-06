import type { OnlineMatchType, OnlineRoomStatus, PublicRoomsFilters } from '../../src/online/protocol.js';
import { listPublicRooms } from '../../src/online/roomService.js';
import { getRoomStore, handleApiError, sendJson } from '../../src/online/vercelApi.js';

export { config } from '../../src/online/vercelApi.js';

export async function GET(request: Request): Promise<Response> {
  try {
    const rooms = await listPublicRooms(getRoomStore(), Date.now(), filtersFromRequest(request));
    return sendJson(200, { rooms, serverNowMs: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}

function filtersFromRequest(request: Request): PublicRoomsFilters {
  const params = new URL(request.url).searchParams;
  return {
    matchType: readMatchType(params.get('matchType')),
    status: readStatus(params.get('status')),
    region: readString(params.get('region')),
    ranked: readBoolean(params.get('ranked')),
    customPreset: readString(params.get('customPreset')),
    minPlayers: readInteger(params.get('minPlayers')),
    maxPlayers: readInteger(params.get('maxPlayers')),
  };
}

function readMatchType(value: string | null): OnlineMatchType | undefined {
  if (
    value === 'battle'
    || value === 'duel'
    || value === 'league'
    || value === 'royale'
    || value === 'quickPlay'
    || value === 'custom'
    || value === 'sprintRace'
  ) return value;
  return undefined;
}

function readStatus(value: string | null): OnlineRoomStatus | undefined {
  if (value === 'lobby' || value === 'countdown' || value === 'playing' || value === 'finished') return value;
  return undefined;
}

function readBoolean(value: string | null): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function readInteger(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : undefined;
}

function readString(value: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
