#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { Engine } from './engine.ts';

/** `helix-engine [--stdio | --ws [port]]` — stdio is the default transport for CLI-spawned engines. */
const args = process.argv.slice(2);
const engine = new Engine({ forceProcessSandbox: process.env.HELIX_SANDBOX_PROVIDER === 'process' });
const stop = () => void engine.close().then(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

if (args.includes('--ws')) {
  const raw = args[args.indexOf('--ws') + 1];
  const { port } = await engine.serveWebSocket(raw && /^\d+$/.test(raw) ? Number(raw) : 0);
  process.stderr.write(`helix-engine ${engine.id} listening on ws://127.0.0.1:${port} (token in ${engine.home}/engine.json)\n`);
} else {
  const peer = engine.serveStdio();
  peer.onClose(stop);
  process.stdin.on('end', stop);
}
