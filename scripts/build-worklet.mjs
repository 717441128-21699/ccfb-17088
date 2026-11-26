import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('public/worklets', { recursive: true });

await build({
  entryPoints: ['src/worklet/hammer-worklet.ts'],
  outfile: 'public/worklets/hammer-worklet.js',
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: false,
  sourcemap: false,
  legalComments: 'none',
});

console.log('Built AudioWorklet bundle: public/worklets/hammer-worklet.js');
