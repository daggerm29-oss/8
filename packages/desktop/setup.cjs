'use strict';
// Fetches the Electron binary on demand (workspace installs skip it: `allowBuilds.electron: false`).
const { execFileSync } = require('node:child_process');
const { existsSync, readdirSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');

const pkgDir = path.dirname(require.resolve('electron/package.json'));
const { version } = require('electron/package.json');
const binary = path.join(pkgDir, 'dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron');

if (!existsSync(binary)) execFileSync(process.execPath, [path.join(pkgDir, 'install.js')], { stdio: 'inherit' });

// electron's extractor can silently leave only `locales/` behind; fall back to unzip from its download cache.
if (!existsSync(binary) && process.platform === 'linux') {
  const cache = path.join(process.env.electron_config_cache || path.join(homedir(), '.cache', 'electron'));
  const zipName = `electron-v${version}-linux-${process.arch}.zip`;
  const zip = existsSync(cache) && readdirSync(cache).map((d) => path.join(cache, d, zipName)).find((p) => existsSync(p));
  if (zip) {
    execFileSync('unzip', ['-qo', zip, '-d', path.join(pkgDir, 'dist')], { stdio: 'inherit' });
    writeFileSync(path.join(pkgDir, 'path.txt'), 'electron');
  }
}

if (!existsSync(binary)) {
  console.error(`Electron ${version} binary missing at ${binary}`);
  process.exit(1);
}
console.log(`Electron ${version} ready: ${binary}`);
