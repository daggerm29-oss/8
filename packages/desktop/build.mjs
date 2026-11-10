import { build } from 'esbuild';
import { cpSync, mkdirSync, copyFileSync, chmodSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const engineRequire = createRequire(join(root, '../engine/package.json'));
const dist = join(root, 'dist');
mkdirSync(join(dist, 'renderer'), { recursive: true });
await build({
  entryPoints: [join(root, 'renderer/main.tsx')], bundle: true, splitting: true, format: 'esm',
  platform: 'browser', target: 'chrome140', outdir: join(dist, 'renderer'), minify: true,
  entryNames: 'app', assetNames: 'assets/[name]-[hash]', loader: { '.ttf': 'file' },
  define: { 'process.env.NODE_ENV': '"production"' }, jsx: 'automatic',
});
await build({
  entryPoints: [join(root, 'renderer/editor.worker.ts')], bundle: true, format: 'iife',
  platform: 'browser', target: 'chrome140', outfile: join(dist, 'renderer/editor.worker.js'), minify: true,
});
cpSync(join(root, 'renderer/index.html'), join(dist, 'renderer/index.html'));
await build({
  entryPoints: [join(root, '../engine/src/main.ts')], bundle: true, format: 'esm', platform: 'node',
  target: 'node24', outfile: join(dist, 'engine/src/main.mjs'), external: ['@vscode/tree-sitter-wasm', 'typescript'],
  banner: { js: "import { createRequire as __helixRequire } from 'node:module'; const require = __helixRequire(import.meta.url);" },
});
for (const name of ['@vscode/tree-sitter-wasm', 'typescript', '@xterm/xterm']) {
  const entry = engineRequire.resolve(`${name}/package.json`);
  cpSync(dirname(entry), join(dist, 'engine/node_modules', name), { recursive: true, dereference: true });
}
cpSync(join(root, '../engine/ui'), join(dist, 'engine/ui'), { recursive: true });
mkdirSync(join(dist, 'runtime'), { recursive: true });
const node = join(dist, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
copyFileSync(process.execPath, node);
chmodSync(node, 0o755);
mkdirSync(join(dist, 'app'), { recursive: true });
for (const name of ['main.cjs', 'preload.cjs']) cpSync(join(root, name), join(dist, 'app', name));
writeFileSync(join(dist, 'app/package.json'), JSON.stringify({ name: 'helix', productName: 'Helix', version: '0.1.0', main: 'main.cjs', description: 'Helix desktop workbench', author: 'Helix contributors' }));
console.log('Desktop renderer, Engine, parser assets and Node runtime built.');
