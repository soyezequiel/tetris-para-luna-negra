const fs = require('fs');

function replaceBlock(code, startStr, endStr, replacement) {
  const startIdx = code.indexOf(startStr);
  if (startIdx === -1) {
    console.log("NOT FOUND: " + startStr.substring(0, 30));
    return code;
  }
  const endIdx = code.indexOf(endStr, startIdx);
  if (endIdx === -1) {
    console.log("END NOT FOUND: " + endStr.substring(0, 30));
    return code;
  }
  const before = code.substring(0, startIdx);
  const after = code.substring(endIdx + endStr.length);
  return before + replacement + after;
}

let code = fs.readFileSync('src/online/lunaNegraBets.ts', 'utf8').replace(/\r\n/g, '\n');

// 1. Imports 1
code = replaceBlock(
  code,
  "import {\n  ngpBetsEnabled,",
  "} from './lunaNegraNgp.js';\n",
  ""
);

// 2. Imports 2
code = replaceBlock(
  code,
  "import {\n  fetchNgpTerms,",
  "} from './lunaNegraEvents.js';\n",
  "import {\n  mapNgpStatusToRoomStatus,\n  buildDepositZapRequestTemplate,\n  encodeLnurl,\n  storeLnurlUrl,\n} from './lunaNegraEvents.js';\n"
);

// 3. Imports 3
code = replaceBlock(
  code,
  "import {\n  ngeConnected,",
  "} from './lunaNegraNge.js';\n",
  "import {\n  pubkeyFromNpub,\n  ngeConnected,\n  fetchNgeConfig,\n  fetchNgeBetState,\n  createNgeContract,\n  reportNgeResult,\n  voidNgeBet,\n  ngeStoreLnurlUrl,\n  type NgeConfig,\n} from './lunaNegraNge.js';\n"
);

// 4. readApiConfig
code = replaceBlock(
  code,
  "  if (!apiKey && !ngpEventsEnabled()) {\n    throw new OnlineRoomError('LUNA_NEGRA_API_KEY no está configurada.', 500);\n  }\n  return { baseUrl, apiKey };\n}",
  "  if (!apiKey && !ngpEventsEnabled()) {\n    throw new OnlineRoomError('LUNA_NEGRA_API_KEY no está configurada.', 500);\n  }\n  return { baseUrl, apiKey };\n}",
  "  if (!apiKey && !ngeConnected()) {\n    throw new OnlineRoomError('LUNA_NEGRA_API_KEY no está configurada.', 500);\n  }\n  return { baseUrl, apiKey };\n}"
);

// 5. isLunaNegraApiConfigured
code = replaceBlock(
  code,
  "  if (ngeConnected()) return true;\n  // Modo eventos: alcanza con la base URL (la API key no se usa).\n  if (ngpEventsEnabled()) return Boolean((process.env.LUNA_NEGRA_BASE_URL ?? '').trim());",
  "  if (ngeConnected()) return true;\n  // Modo eventos: alcanza con la base URL (la API key no se usa).\n  if (ngpEventsEnabled()) return Boolean((process.env.LUNA_NEGRA_BASE_URL ?? '').trim());",
  "  if (ngeConnected()) return true;"
);

// 6. cancelBetRemote
code = replaceBlock(
  code,
  "  if (ngeConnected()) {\n    await voidNgeBet(betId);\n    return undefined;\n  }\n  if (ngpEventsEnabled()) {\n    return publishNgpVoidEvents(betId);\n  }",
  "  if (ngeConnected()) {\n    await voidNgeBet(betId);\n    return undefined;\n  }\n  if (ngpEventsEnabled()) {\n    return publishNgpVoidEvents(betId);\n  }",
  "  if (ngeConnected()) {\n    await voidNgeBet(betId);\n    return undefined;\n  }"
);

// 7. fetchDetail
code = replaceBlock(
  code,
  "  if (ngeConnected()) {\n    const ngeConfig = await fetchNgeConfig();\n    if (hasPendingNgpInvoice(previous)) {\n      // Base de Luna para el poke = host del lud16 del bind (el riel de depósito no\n      // depende de LUNA_NEGRA_BASE_URL). Best-effort.\n      await pokeNgpBetDepositSync(`https://${ngeConfig.lud16.split('@')[1]}`, betId);\n    }\n    return synthesizeNgeBetDetail(betId, npubs, stakeSats, ngeConfig, previous);\n  }\n  if (ngpEventsEnabled()) {\n    if (!config) throw new OnlineRoomError('LUNA_NEGRA_BASE_URL no está configurada.', 500);\n    const terms = await fetchNgpTerms();\n    if (!terms) return null;\n    if (hasPendingNgpInvoice(previous)) {\n      await pokeNgpBetDepositSync(config.baseUrl, betId);\n    }\n    return synthesizeEventsBetDetail(betId, npubs, stakeSats, terms, config.baseUrl, previous);\n  }",
  "  if (ngeConnected()) {\n    const ngeConfig = await fetchNgeConfig();\n    if (hasPendingNgpInvoice(previous)) {\n      // Base de Luna para el poke = host del lud16 del bind (el riel de depósito no\n      // depende de LUNA_NEGRA_BASE_URL). Best-effort.\n      await pokeNgpBetDepositSync(`https://${ngeConfig.lud16.split('@')[1]}`, betId);\n    }\n    return synthesizeNgeBetDetail(betId, npubs, stakeSats, ngeConfig, previous);\n  }\n  if (ngpEventsEnabled()) {\n    if (!config) throw new OnlineRoomError('LUNA_NEGRA_BASE_URL no está configurada.', 500);\n    const terms = await fetchNgpTerms();\n    if (!terms) return null;\n    if (hasPendingNgpInvoice(previous)) {\n      await pokeNgpBetDepositSync(config.baseUrl, betId);\n    }\n    return synthesizeEventsBetDetail(betId, npubs, stakeSats, terms, config.baseUrl, previous);\n  }",
  "  if (ngeConnected()) {\n    const ngeConfig = await fetchNgeConfig();\n    return synthesizeNgeBetDetail(betId, npubs, stakeSats, ngeConfig, previous);\n  }"
);

// 8. fetchBetPaymentTimeline
code = replaceBlock(
  code,
  "export async function fetchBetPaymentTimeline(betId: string): Promise<unknown | null> {\n  if (ngeConnected()) return null;\n  // Modo eventos: el timeline es un diagnóstico REST; no está disponible sin API key.\n  if (ngpEventsEnabled()) return null;\n  if (!betId || !isLunaNegraApiConfigured()) return null;\n  try {\n    const config = readApiConfig();\n    return await lunaFetch<unknown>(\n      config,\n      `/api/v2/bets/${encodeURIComponent(betId)}/timeline`,\n    );\n  } catch {\n    return null;\n  }\n}",
  "export async function fetchBetPaymentTimeline(betId: string): Promise<unknown | null> {\n  if (ngeConnected()) return null;\n  // Modo eventos: el timeline es un diagnóstico REST; no está disponible sin API key.\n  if (ngpEventsEnabled()) return null;\n  if (!betId || !isLunaNegraApiConfigured()) return null;\n  try {\n    const config = readApiConfig();\n    return await lunaFetch<unknown>(\n      config,\n      `/api/v2/bets/${encodeURIComponent(betId)}/timeline`,\n    );\n  } catch {\n    return null;\n  }\n}",
  "export async function fetchBetPaymentTimeline(betId: string): Promise<unknown | null> {\n  return null;\n}"
);

// 9. createBetForRoom
code = replaceBlock(
  code,
  "  if (!gameId) throw new OnlineRoomError('No se pudo determinar el gameId de Luna Negra para esta sala.', 409);\n  const config = readApiConfig();\n\n  if (ngpBetsEnabled() && players.every((player) => !!player.npub)) {\n    const created = await createBetViaNgpContract(config, room, gameId, stakeSats, input.victoryCondition);\n    return finalizeCreatedBet(store, room, config, created, gameId, input.playerId, nowMs);\n  }\n\n  // Legacy (custodial / API key). Pozo MIXTO: por cada jugador, su npub real si\n  // entró con cuenta Luna; si es invitado (sin npub), un placeholder `{ guest: true }`\n  // que Luna convierte en una identidad efímera. Así el de cuenta cobra a su billetera\n  // y el invitado cobra por LNURL-withdraw. El orden se conserva para mapear asiento→jugador.\n  const spec: Array<string | { guest: true }> = players.map(\n    (player) => (player.npub ? player.npub : { guest: true }),\n  );\n\n  const create = await lunaFetch<LunaBetCreateWithSeats>(config, '/api/v2/bets', {\n    method: 'POST',\n    body: {\n      gameId,\n      participants: spec,\n      stakeSats,\n      victoryCondition: input.victoryCondition?.slice(0, 280) || 'Último jugador en pie gana el pozo.',\n      roomId: room.id,\n      metadata: { roomId: room.id },\n      // Resiliencia del pozo: si algún jugador arrastra un npub de una sesión vieja que\n      // Luna ya no reconoce (cuenta borrada / DB reseteada), que ese asiento se degrade a\n      // invitado (cobra por LNURL-withdraw) en vez de tirar abajo TODA la apuesta. Sin\n      // esto, en una sala grande basta un npub fantasma para bloquear el pozo entero.\n      unknownNpubsAsGuests: true,\n    },\n  });\n\n  return finalizeCreatedBet(store, room, config, create, gameId, input.playerId, nowMs);\n}",
  "  if (!gameId) throw new OnlineRoomError('No se pudo determinar el gameId de Luna Negra para esta sala.', 409);\n  const config = readApiConfig();\n\n  if (ngpBetsEnabled() && players.every((player) => !!player.npub)) {\n    const created = await createBetViaNgpContract(config, room, gameId, stakeSats, input.victoryCondition);\n    return finalizeCreatedBet(store, room, config, created, gameId, input.playerId, nowMs);\n  }\n\n  // Legacy (custodial / API key). Pozo MIXTO: por cada jugador, su npub real si\n  // entró con cuenta Luna; si es invitado (sin npub), un placeholder `{ guest: true }`\n  // que Luna convierte en una identidad efímera. Así el de cuenta cobra a su billetera\n  // y el invitado cobra por LNURL-withdraw. El orden se conserva para mapear asiento→jugador.\n  const spec: Array<string | { guest: true }> = players.map(\n    (player) => (player.npub ? player.npub : { guest: true }),\n  );\n\n  const create = await lunaFetch<LunaBetCreateWithSeats>(config, '/api/v2/bets', {\n    method: 'POST',\n    body: {\n      gameId,\n      participants: spec,\n      stakeSats,\n      victoryCondition: input.victoryCondition?.slice(0, 280) || 'Último jugador en pie gana el pozo.',\n      roomId: room.id,\n      metadata: { roomId: room.id },\n      // Resiliencia del pozo: si algún jugador arrastra un npub de una sesión vieja que\n      // Luna ya no reconoce (cuenta borrada / DB reseteada), que ese asiento se degrade a\n      // invitado (cobra por LNURL-withdraw) en vez de tirar abajo TODA la apuesta. Sin\n      // esto, en una sala grande basta un npub fantasma para bloquear el pozo entero.\n      unknownNpubsAsGuests: true,\n    },\n  });\n\n  return finalizeCreatedBet(store, room, config, create, gameId, input.playerId, nowMs);\n}",
  "  throw new OnlineRoomError('El servidor usa el modo NGE que requiere que todos los jugadores tengan cuenta.', 400);\n}"
);

// 10. maybeReportRoomBetResult
code = replaceBlock(
  code,
  "    } else if (ngpEventsEnabled()) {\n      const ev = signNgpResultEvent({\n        betId: bet.betId,\n        winnerNpubs: winners,\n        anchorEventId: bet.betId,\n      });\n      await publishSignedEventToRelays(ev);\n    } else {\n      if (!config) throw new OnlineRoomError('LUNA_NEGRA_BASE_URL no está configurada.', 500);\n      let body: { event: unknown } | { winners: string[] };\n      if (ngpKeylessEnabled()) {\n        // Aseguramos que NUESTRA clave esté declarada como oráculo (idempotente): si no,\n        // Luna rechazaría el { event } con WRONG_SIGNER. Cubre el caso de reportar sin\n        // haber creado una apuesta NGP en esta instancia (cold start).\n        await ensureOracleDeclared(config.baseUrl, config.apiKey);\n        body = { event: signNgpResultEvent({ betId: bet.betId, winnerNpubs: winners }) };\n      } else {\n        body = { winners };\n      }\n      await lunaFetch(config, `/api/v2/bets/${encodeURIComponent(bet.betId)}/result`, {\n        method: 'POST',\n        body,\n      });\n    }",
  "    } else if (ngpEventsEnabled()) {\n      const ev = signNgpResultEvent({\n        betId: bet.betId,\n        winnerNpubs: winners,\n        anchorEventId: bet.betId,\n      });\n      await publishSignedEventToRelays(ev);\n    } else {\n      if (!config) throw new OnlineRoomError('LUNA_NEGRA_BASE_URL no está configurada.', 500);\n      let body: { event: unknown } | { winners: string[] };\n      if (ngpKeylessEnabled()) {\n        // Aseguramos que NUESTRA clave esté declarada como oráculo (idempotente): si no,\n        // Luna rechazaría el { event } con WRONG_SIGNER. Cubre el caso de reportar sin\n        // haber creado una apuesta NGP en esta instancia (cold start).\n        await ensureOracleDeclared(config.baseUrl, config.apiKey);\n        body = { event: signNgpResultEvent({ betId: bet.betId, winnerNpubs: winners }) };\n      } else {\n        body = { winners };\n      }\n      await lunaFetch(config, `/api/v2/bets/${encodeURIComponent(bet.betId)}/result`, {\n        method: 'POST',\n        body,\n      });\n    }",
  "    } else {\n      if (!config) throw new OnlineRoomError('LUNA_NEGRA_BASE_URL no está configurada.', 500);\n      const body = { winners };\n      await lunaFetch(config, `/api/v2/bets/${encodeURIComponent(bet.betId)}/result`, {\n        method: 'POST',\n        body,\n      });\n    }"
);

// 11. webhook
code = replaceBlock(
  code,
  "  // Modo eventos: no hay webhooks (el estado se sigue por relays / 31340), y el\n  // registro requiere API key que no usamos. No-op.\n  if (ngpEventsEnabled()) return;\n  if (webhookSetupDone || !isLunaNegraApiConfigured()) return;",
  "  // Modo eventos: no hay webhooks (el estado se sigue por relays / 31340), y el\n  // registro requiere API key que no usamos. No-op.\n  if (ngpEventsEnabled()) return;\n  if (webhookSetupDone || !isLunaNegraApiConfigured()) return;",
  "  if (webhookSetupDone || !isLunaNegraApiConfigured()) return;"
);

// DEAD FUNCTIONS:
// Para borrar las funciones, simplemente busco sus definiciones y el cierre. 
// Las funciones están en el top level, así que `\n}\n` las cierra.
function removeDeadFunction(code, funcName, suffixToRemove) {
  const startIdx = code.indexOf(funcName);
  if (startIdx === -1) return code;
  // Buscamos hacia atrás el inicio del JSDoc si tiene: "/**"
  const lines = code.substring(0, startIdx).split('\n');
  let startLine = lines.length - 1;
  while(startLine > 0 && (lines[startLine].includes('/**') || lines[startLine].includes(' * ') || lines[startLine].includes(' */') || lines[startLine].includes('//'))) {
    startLine--;
  }
  const realStart = code.indexOf(lines[startLine + 1]);
  const endIdx = code.indexOf(suffixToRemove, startIdx);
  if (endIdx === -1) return code;
  return code.substring(0, realStart) + code.substring(endIdx + suffixToRemove.length);
}

code = removeDeadFunction(code, 'async function createBetViaNgpContract(', '\n}\n');
code = removeDeadFunction(code, 'function createBetViaEvents(', '\n}\n');
code = removeDeadFunction(code, 'function synthesizeEventsBetDetail(', '\n}\n');
code = removeDeadFunction(code, 'function hasPendingNgpInvoice(', '\n}\n');

fs.writeFileSync('src/online/lunaNegraBets.ts', code);
console.log('Done bets');

// [action].ts
let codeAction = fs.readFileSync('api/bets/[action].ts', 'utf8').replace(/\r\n/g, '\n');
codeAction = replaceBlock(
  codeAction,
  "import { ngpDiagnostics } from '../../src/online/lunaNegraNgp.js';\n",
  "import { ngpDiagnostics } from '../../src/online/lunaNegraNgp.js';\n",
  ""
);
codeAction = replaceBlock(
  codeAction,
  "        // Estado NGP en la función deployada (sin secretos): permite ver de una si el\n        // flag/clave llegan y si la ruta de contrato Nostr se activaría. Ver ngpDiagnostics.\n        ngp: ngpDiagnostics(),\n",
  "        // Estado NGP en la función deployada (sin secretos): permite ver de una si el\n        // flag/clave llegan y si la ruta de contrato Nostr se activaría. Ver ngpDiagnostics.\n        ngp: ngpDiagnostics(),\n",
  ""
);
fs.writeFileSync('api/bets/[action].ts', codeAction);
console.log('Done action');
