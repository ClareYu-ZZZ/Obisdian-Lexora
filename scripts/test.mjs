// Bundle the core tests with esbuild, then run them with node --test.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outfile = path.join(root, '.tmp', 'core.test.mjs');

await build({
  entryPoints: [path.join(root, 'packages/core/test/core.test.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  external: ['node:*'],
  logLevel: 'warning',
});

const r = spawnSync('node', ['--test', outfile], { stdio: 'inherit' });
process.exit(r.status ?? 1);
