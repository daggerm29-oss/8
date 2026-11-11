'use strict';
// Minimal, typed bridge (§5.1): no Node APIs reach the renderer. Requests travel over a MessagePort handed
// over by the main process, which validates every channel and payload against its allowlist (SEC-13).
const { contextBridge, ipcRenderer } = require('electron');

const TIMEOUT_MS = 10_000;
const pending = new Map();
let seq = 0;
let resolvePort;
let portReady = new Promise((resolve) => { resolvePort = resolve; });

ipcRenderer.on('helix:port', (event) => {
  const [port] = event.ports;
  if (!port) return;
  port.onmessage = ({ data }) => {
    const waiter = data && pending.get(data.id);
    if (!waiter) return;
    pending.delete(data.id);
    clearTimeout(waiter.timer);
    if (typeof data.error === 'string') waiter.reject(new Error(data.error));
    else waiter.resolve(data.result);
  };
  port.start();
  resolvePort(port);
  portReady = Promise.resolve(port);
});

function invoke(channel, payload) {
  return portReady.then((port) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`IPC ${String(channel)} timed out`)); }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      port.postMessage(payload === undefined ? { id, channel } : { id, channel, payload });
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error(`IPC request not cloneable: ${error.message}`));
    }
  }));
}

contextBridge.exposeInMainWorld('helixDesktop', Object.freeze({
  shell: 'electron',
  platform: process.platform,
  invoke,
  appInfo: () => invoke('app.info'),
  engineConnection: () => invoke('engine.connection'),
  engineStatus: () => invoke('engine.status'),
  openExternal: (url) => invoke('shell.openExternal', { url }),
}));
