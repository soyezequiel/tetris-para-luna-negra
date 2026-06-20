import {
  cancelLocalBet,
  createLocalBet,
  getLocalBet,
  isLocalBetConfigured,
  reportLocalBetResult,
} from '../../src/online/localBets.js';
import {
  handleApiError,
  handleNodeApi,
  readJsonBody,
  sendJson,
  sendMethodNotAllowed,
} from '../../src/online/vercelApi.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export { config } from '../../src/online/vercelApi.js';

export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handleNodeApi(request, response, { GET, POST });
}

interface SeatHint { seat: number; npub: string }

export async function GET(request: Request): Promise<Response> {
  try {
    const action = actionFromRequest(request);
    if (action === 'available') {
      return sendJson(200, { available: isLocalBetConfigured(), serverNowMs: Date.now() });
    }
    return sendMethodNotAllowed();
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const action = actionFromRequest(request);
    if (action === 'create') {
      const body = await readJsonBody<{ stakeSats: number; seats?: number; victoryCondition?: string }>(request);
      const bet = await createLocalBet({
        stakeSats: body.stakeSats,
        seats: body.seats,
        victoryCondition: body.victoryCondition,
      });
      return sendJson(200, { bet, serverNowMs: Date.now() });
    }
    if (action === 'state') {
      const body = await readJsonBody<{ betId: string; seats?: SeatHint[] }>(request);
      const bet = await getLocalBet(body.betId, body.seats);
      return sendJson(200, { bet, serverNowMs: Date.now() });
    }
    if (action === 'result') {
      const body = await readJsonBody<{ betId: string; winnerNpubs: string[]; seats?: SeatHint[] }>(request);
      const bet = await reportLocalBetResult(body.betId, body.winnerNpubs ?? [], body.seats);
      return sendJson(200, { bet, serverNowMs: Date.now() });
    }
    if (action === 'cancel') {
      const body = await readJsonBody<{ betId: string; seats?: SeatHint[] }>(request);
      const bet = await cancelLocalBet(body.betId, body.seats);
      return sendJson(200, { bet, serverNowMs: Date.now() });
    }
    return sendMethodNotAllowed();
  } catch (error) {
    return handleApiError(error);
  }
}

function actionFromRequest(request: Request): string {
  const pathname = new URL(request.url).pathname;
  return pathname.split('/').filter(Boolean).at(-1) ?? '';
}
