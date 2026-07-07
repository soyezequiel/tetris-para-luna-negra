const fs = require('fs');

// 1. Limpiar [action].ts
let codeAction = fs.readFileSync('api/bets/[action].ts', 'utf8');
codeAction = codeAction.replace(/import \{ ngpDiagnostics \} from '\.\.\/\.\.\/src\/online\/lunaNegraNgp\.js';\r?\n/, '');
codeAction = codeAction.replace(/\s*\/\/ Estado NGP[\s\S]*?ngp: ngpDiagnostics\(\),\r?\n/, '\n');
fs.writeFileSync('api/bets/[action].ts', codeAction);

// 2. Limpiar lunaNegraBets.ts (las funciones obsoletas)
let codeBets = fs.readFileSync('src/online/lunaNegraBets.ts', 'utf8');

// hasPendingNgpInvoice
codeBets = codeBets.replace(/\/\*\*[\s\S]*?function hasPendingNgpInvoice[\s\S]*?\}\r?\n/, '');

// createBetViaNgpContract
codeBets = codeBets.replace(/\/\*\*[\s\S]*?async function createBetViaNgpContract[\s\S]*?\}\r?\n/, '');

// createBetViaEvents
codeBets = codeBets.replace(/\/\*\*[\s\S]*?async function createBetViaEvents[\s\S]*?\}\r?\n/, '');

// synthesizeEventsBetDetail
codeBets = codeBets.replace(/\/\*\*[\s\S]*?async function synthesizeEventsBetDetail[\s\S]*?\}\r?\n/, '');

// ngpEventsEnabled en ensureWebhookRegistered
codeBets = codeBets.replace(/\s*\/\/ Modo eventos: no hay webhooks[\s\S]*?if \(ngpEventsEnabled\(\)\) return;\r?\n/, '\n');

fs.writeFileSync('src/online/lunaNegraBets.ts', codeBets);
console.log('Done dead code');
