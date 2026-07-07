const fs = require('fs');
let code = fs.readFileSync('src/online/lunaNegraBets.ts', 'utf8');

// 1. imports de ngp y events
code = code.replace(/import \{\s*ngpBetsEnabled[\s\S]*?from '\.\/lunaNegraNgp\.js';\r?\n/, '');
code = code.replace(/import \{\s*fetchNgpTerms[\s\S]*?from '\.\/lunaNegraEvents\.js';\r?\n/, 
`import {
  mapNgpStatusToRoomStatus,
  buildDepositZapRequestTemplate,
  encodeLnurl,
  storeLnurlUrl,
} from './lunaNegraEvents.js';\n`);

// 2. Add pubkeyFromNpub to NGE imports
code = code.replace(/import \{\s*ngeConnected/, 'import {\n  pubkeyFromNpub,\n  ngeConnected');

// 3. Modificaciones puntuales
code = code.replace(/if \(!apiKey && !ngpEventsEnabled\(\)\) \{/, 'if (!apiKey && !ngeConnected()) {');
code = code.replace(/\s*if \(ngpEventsEnabled\(\)\) return Boolean\(\(process\.env\.LUNA_NEGRA_BASE_URL \?\? ''\)\.trim\(\)\);\r?\n/, '\n');

// En cancelBetRemote, quitamos la rama ngpEventsEnabled
code = code.replace(/\s*if \(ngpEventsEnabled\(\)\) \{\s*return publishNgpVoidEvents\(betId\);\s*\}\r?\n/, '\n');

// En fetchDetail, quitamos la rama ngpEventsEnabled
code = code.replace(/\s*if \(ngpEventsEnabled\(\)\) \{[\s\S]*?synthesizeEventsBetDetail[\s\S]*?\}\r?\n/, '\n');
// Quitamos el poke
code = code.replace(/\s*if \(hasPendingNgpInvoice\(previous\)\) \{\s*\/\/ Base de Luna[\s\S]*?pokeNgpBetDepositSync[^\}]+\}\r?\n/, '\n');

// 4. Modificar fetchBetPaymentTimeline
code = code.replace(/export async function fetchBetPaymentTimeline[\s\S]*?\}\r?\n\r?\n(?=export async function createBetForRoom)/, 
`export async function fetchBetPaymentTimeline(betId: string): Promise<unknown | null> {
  return null;
}

`);

// 5. createBetForRoom: quitar ramas NGP y Legacy
code = code.replace(/\s*if \(ngpBetsEnabled\(\) && players\.every\(\(player\) => !!player\.npub\)\) \{\s*const created = await createBetViaNgpContract[\s\S]*?\}\r?\n/, '\n');
code = code.replace(/\s*\/\/ Legacy \(custodial \/ API key\)[\s\S]*?return finalizeCreatedBet\(store, room, config, create, gameId, input\.playerId, nowMs\);\r?\n/, 
`  throw new OnlineRoomError('El servidor usa el modo NGE que requiere que todos los jugadores tengan cuenta.', 400);
`);

// 6. maybeReportRoomBetResult: quitar rama ngpEventsEnabled
code = code.replace(/\s*\} else if \(ngpEventsEnabled\(\)\) \{\s*const ev = signNgpResultEvent\([\s\S]*?publishSignedEventToRelays\(ev\);\s*\} else \{/, ' } else {');
// Quitar rama ngpKeylessEnabled de maybeReportRoomBetResult
code = code.replace(/\s*if \(ngpKeylessEnabled\(\)\) \{[\s\S]*?\} else \{/, ' {');
// Limpiar doble llaves generadas
code = code.replace(/let body: \{ event: unknown \} \| \{ winners: string\[\] \};\r?\n\s*\{\s*body = \{ winners \};\r?\n\s*\}/, 'const body = { winners };');

// 7. Funciones que hay que borrar por completo:
code = code.replace(/\/\*\*[\s\S]*?async function createBetViaNgpContract[\s\S]*?\}\r?\n/, '');
code = code.replace(/\/\*\*[\s\S]*?async function createBetViaEvents[\s\S]*?\}\r?\n/, '');
code = code.replace(/\/\*\*[\s\S]*?async function synthesizeEventsBetDetail[\s\S]*?\}\r?\n/, '');

fs.writeFileSync('src/online/lunaNegraBets.ts', code);
console.log('done bets');
