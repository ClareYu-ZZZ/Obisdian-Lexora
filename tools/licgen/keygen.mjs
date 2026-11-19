#!/usr/bin/env node
// Generate the Lexora release keypair (Ed25519). Run ONCE, keep private.pem
// out of every repo and every sync you don't trust.
//   node keygen.mjs <output-dir>
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.';
mkdirSync(dir, { recursive: true });
const privPath = join(dir, 'private.pem');
if (existsSync(privPath)) {
  console.error(`refusing to overwrite ${privPath}`);
  process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
writeFileSync(privPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const hex = Buffer.from(raw).toString('hex');
writeFileSync(join(dir, 'public.hex'), hex + '\n');
console.log(`private key -> ${privPath}  (keep secret, back it up)`);
console.log(`public key  -> ${join(dir, 'public.hex')}`);
console.log(`\nLEXORA_PUBLIC_KEY_HEX = ${hex}`);
