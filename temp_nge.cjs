const fs = require('fs');

let code = fs.readFileSync('src/online/lunaNegraNge.ts', 'utf8');
if (!code.includes('pubkeyFromNpub')) {
  code = code.replace(/import \{ getPublicKey \} from 'nostr-tools\/pure';\r?\n/, 
    "import { getPublicKey } from 'nostr-tools/pure';\nimport { nip19 } from 'nostr-tools';\n"
  );
  
  code += "\nexport function pubkeyFromNpub(npub: string): string {\n" +
          "  if (npub.startsWith('npub1')) {\n" +
          "    try {\n" +
          "      const { type, data } = nip19.decode(npub);\n" +
          "      if (type === 'npub') return data as string;\n" +
          "    } catch {}\n" +
          "  }\n" +
          "  return npub;\n" +
          "}\n";
          
  fs.writeFileSync('src/online/lunaNegraNge.ts', code);
}
console.log('done nge pubkey');
