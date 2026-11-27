// 验收测试入口：用 esbuild 把 TS 测试与 DSP 核心打包为临时 ESM，再在 Node 中运行。
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'node_modules/.cache/forge-tests');
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [resolve(root, 'test/acceptance.test.ts')],
  outfile: resolve(outdir, 'acceptance.test.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  sourcemap: 'inline',
});

await import(pathToFileURL(resolve(outdir, 'acceptance.test.mjs')).href);
