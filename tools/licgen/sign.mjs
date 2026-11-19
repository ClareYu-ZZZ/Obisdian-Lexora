#!/usr/bin/env node
// Issue a Lexora Pro license key.
//   node sign.mjs --key <private.pem> --email a@b.c [--exp 2027-12-31]
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!args.key || !args.email) {
  console.error('usage: node sign.mjs --key private.pem --email a@b.c [--exp YYYY-MM-DD]');
  process.exit(1);
}
const payload = { v: 1, plan: 'pro', email: args.email, iat: Date.now() };
if (args.exp) payload.exp = new Date(args.exp + 'T23:59:59Z').getTime();
const msg = Buffer.from(JSON.stringify(payload), 'utf8');
const sig = sign(null, msg, createPrivateKey(readFileSync(args.key)));
const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
console.log(`LEXORA1.${b64u(msg)}.${b64u(sig)}`);
