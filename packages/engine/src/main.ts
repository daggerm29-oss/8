#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { Engine } from './engine.ts';

/**
 * `helix-engine [--stdio | --ws [port] [--ui] [--host h] [--allow-host h] [--no-auth]]`
 * stdio is the default transport for CLI-spawned engines; `--ui` also serves the web workbench (F-UI-1).
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => (flag(name) ? args[args.indexOf(name) + 1] : undefined);
const engine = new Engine();
const stop = () => void engine.close().then(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

if (flag('--ws') || flag('--ui')) {
  const raw = value('--ws') ?? value('--port');
  const allowedHosts = args.flatMap((a, i) => (a === '--allow-host' && args[i + 1] ? [args[i + 1]] : []));
  const noAuth = flag('--no-auth');
  const { port, url } = await engine.serve({ port: raw && /^\d+$/.test(raw) ? Number(raw) : 0, host: value('--host'), ui: flag('--ui'), noAuth, allowedHosts, desktopUiDir: value('--desktop-ui') });
  process.stderr.write(`helix-engine ${engine.id} listening on ws://${value('--host') ?? '127.0.0.1'}:${port} (token in ${engine.home}/engine.json)\n`);
  if (flag('--ui')) process.stderr.write(`workbench: ${url}\n`);
  if (noAuth) process.stderr.write('WARNING: --no-auth disables the Engine token. Use only inside an isolated dev sandbox.\n');
} else {
  const peer = engine.serveStdio();
  peer.onClose(stop);
  process.stdin.on('end', stop);
}
