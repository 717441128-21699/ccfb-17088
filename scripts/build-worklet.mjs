// 把 AudioWorklet 处理器（TypeScript）打包成浏览器可直接 addModule 的单文件。
// worklet 环境没有模块加载器，必须输出 IIFE 单文件。
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'public/worklet');
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [resolve(root, 'src/worklet/forge-worklet.ts')],
  outfile: resolve(outdir, 'forge-worklet.js'),
  bundle: true,
  format: 'iife',
  target: 'es2022',
  sourcemap: false,
  logLevel: 'info',
});

console.log('[build:worklet] public/worklet/forge-worklet.js 已生成');
