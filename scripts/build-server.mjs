// Server build: compiles the TypeScript once, ahead of time, into
// build/server.js (packages stay in node_modules), then cleans the fixed
// pages. The live server runs plain JavaScript with no TypeScript tooling.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';

rmSync('build', { recursive: true, force: true });
await build({
  entryPoints: { server: 'server/index.ts', 'build-fixed': 'scripts/build-fixed.ts' },
  outdir: 'build',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  logLevel: 'warning',
});
// Restoration reference samples are read next to the code.
cpSync('server/lettering-bank', 'build/lettering-bank', { recursive: true, filter: (f) => !f.endsWith('.json') });
execFileSync(process.execPath, ['build/build-fixed.js'], { stdio: 'inherit' });
rmSync('build/build-fixed.js');
