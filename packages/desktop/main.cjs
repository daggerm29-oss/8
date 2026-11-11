'use strict';
/**
 * Helix desktop shell (F-AUTH-1, architecture.md §5.1). The Engine runs as its own OS process so a UI
 * crash never kills agents; this main process supervises it (restart with backoff) and shows the
 * workbench in a hardened window. The per-launch token stays in the URL fragment and is never logged.
 */
const { app, BrowserWindow, MessageChannelMain, dialog, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { existsSync } = require('node:fs');
const { RENDERER_CSP, windowWebPreferences, validateIpcRequest } = require('./security.cjs');
const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'dist');
const ENGINE_MAIN = app.isPackaged ? path.join(resources, 'engine/src/main.mjs') : process.env.HELIX_ENGINE_MAIN || path.resolve(__dirname, '../engine/src/main.ts');
const NODE = app.isPackaged ? path.join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') : process.env.HELIX_NODE || 'node';
const RENDERER = path.join(resources, 'renderer');
const HEADLESS = process.env.HELIX_DESKTOP_HEADLESS === '1';
const MAX_BACKOFF_MS = 10_000;
const STABLE_UPTIME_MS = 30_000;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES_PER_WINDOW = 5;

/** Lifecycle events as JSON lines on stdout (supervision log; used by the smoke test). */
const emit = (event, data = {}) => process.stdout.write(`helix-desktop ${JSON.stringify({ event, ...data })}\n`);

let engine = null;
let origin = null;
let engineUrl = null;
let engineToken = '';
let engineStartedAt = null;
let win = null;
let quitting = false;
let restarts = 0;
const rendererCrashes = [];

if (HEADLESS) app.disableHardwareAcceleration();

function startEngine() {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, ['--disable-warning=ExperimentalWarning', ENGINE_MAIN, '--ws', '0', '--ui', ...(existsSync(RENDERER) ? ['--desktop-ui', RENDERER] : [])], { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
    engine = child;
    let buf = '';
    let readyAt = 0;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      buf = (buf + chunk).slice(-8192);
      const m = !readyAt && buf.match(/workbench: (http:\/\/\S+)/);
      if (m) {
        readyAt = Date.now();
        resolve(m[1]);
      }
    });
    child.once('error', (err) => reject(err));
    child.once('exit', (code, signal) => {
      if (engine === child) engine = null;
      emit('engine.exit', { pid: child.pid, code, signal });
      if (!readyAt) reject(new Error(`engine exited before ready (${code ?? signal})`));
      if (readyAt && Date.now() - readyAt > STABLE_UPTIME_MS) restarts = 0;
      if (!quitting) scheduleRestart();
    });
    emit('engine.spawned', { pid: child.pid });
  });
}

function scheduleRestart() {
  const delay = Math.min(500 * 2 ** restarts, MAX_BACKOFF_MS);
  restarts += 1;
  emit('engine.restarting', { delayMs: delay, attempt: restarts });
  setTimeout(() => {
    if (quitting) return;
    startEngine().then(load, (err) => emit('engine.error', { message: err.message }));
  }, delay);
}

/** The desktop renderer receives the token over the bridge, so it never sits in the URL; the legacy UI reads the fragment. */
const windowUrl = () => (existsSync(RENDERER) ? engineUrl.split('#')[0] : engineUrl);

async function load(url) {
  const parsed = new URL(url);
  origin = parsed.origin;
  engineUrl = url;
  engineToken = new URLSearchParams(parsed.hash.slice(1)).get('token') || '';
  engineStartedAt = new Date().toISOString();
  emit('engine.ready', { pid: engine && engine.pid, origin });
  if (win && !win.isDestroyed()) await win.loadURL(windowUrl());
}

const senderOk = (w) => !!origin && !w.isDestroyed() && (() => { try { return new URL(w.webContents.getURL()).origin === origin; } catch { return false; } })();

/** Allowlisted channel handlers (security.cjs IPC_CHANNELS). Payloads are already validated. */
const handlers = {
  'app.info': () => ({ name: 'Helix', version: app.getVersion(), platform: process.platform, packaged: app.isPackaged, electron: process.versions.electron }),
  'engine.connection': () => ({ origin, token: engineToken }),
  'engine.status': () => ({ pid: engine ? engine.pid : null, alive: !!engine, origin, restarts, startedAt: engineStartedAt, rendererCrashes: rendererCrashes.length }),
  'shell.openExternal': async ({ url }, w) => {
    if (HEADLESS) return { opened: false, reason: 'headless' };
    const r = await dialog.showMessageBox(w, { type: 'question', buttons: ['Open in browser', 'Cancel'], defaultId: 1, message: `Open ${url} in your browser?` });
    if (r.response !== 0) return { opened: false, reason: 'cancelled' };
    await shell.openExternal(url);
    return { opened: true };
  },
};

/** Hands a fresh MessagePort to the page after each load; every request is validated before dispatch (SEC-13). */
function attachBridge(w) {
  if (!senderOk(w)) return;
  const { port1, port2 } = new MessageChannelMain();
  const reply = (message) => { try { port1.postMessage(message); } catch { /* port closed */ } };
  port1.on('message', async ({ data }) => {
    const request = validateIpcRequest(data);
    if (!request.ok) {
      emit('ipc.rejected', { channel: typeof data?.channel === 'string' ? data.channel.slice(0, 64) : null, error: request.error });
      if (request.id !== null) reply({ id: request.id, error: request.error });
      return;
    }
    if (!senderOk(w)) {
      emit('ipc.rejected', { channel: request.channel, error: 'sender origin not allowed' });
      return reply({ id: request.id, error: 'IPC sender origin not allowed' });
    }
    try {
      reply({ id: request.id, result: await handlers[request.channel](request.payload, w) });
    } catch (err) {
      reply({ id: request.id, error: err.message });
    }
  });
  port1.start();
  const onNavigate = (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    w.webContents.off('did-start-navigation', onNavigate);
    port1.close();
  };
  w.webContents.on('did-start-navigation', onNavigate);
  w.webContents.once('destroyed', () => port1.close());
  w.webContents.postMessage('helix:port', null, [port2]);
}

/** Workbench responses from the Engine origin always carry the hardened CSP, whatever the server sent. */
function enforceCsp() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    let sameOrigin = false;
    try { sameOrigin = !!origin && new URL(details.url).origin === origin; } catch { /* opaque url */ }
    if (!sameOrigin) return callback({});
    const headers = Object.fromEntries(Object.entries(details.responseHeaders || {}).filter(([k]) => k.toLowerCase() !== 'content-security-policy'));
    headers['Content-Security-Policy'] = [RENDERER_CSP];
    callback({ responseHeaders: headers });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    emit('permission.denied', { permission });
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
}

/** A crashed renderer is replaced by a new window on the same Engine; agents keep running (NFR-4). */
function onRendererGone(w, details) {
  emit('renderer.gone', { reason: details.reason, exitCode: details.exitCode });
  if (quitting || details.reason === 'clean-exit') return;
  const now = Date.now();
  rendererCrashes.push(now);
  while (rendererCrashes.length && now - rendererCrashes[0] > CRASH_WINDOW_MS) rendererCrashes.shift();
  if (rendererCrashes.length > MAX_CRASHES_PER_WINDOW) {
    emit('renderer.crash-loop', { crashes: rendererCrashes.length });
    if (!HEADLESS) dialog.showErrorBox('Helix', 'The workbench window keeps crashing. Agents are still running in the Engine; restart Helix to reopen it.');
    return;
  }
  const next = createWindow();
  if (engineUrl) next.loadURL(windowUrl()).catch((err) => emit('window.error', { message: err.message }));
  emit('window.reopened', { engine: engine && engine.pid });
  if (!w.isDestroyed()) w.destroy();
}

async function waitConnected() {
  for (let i = 0; i < 60 && win && !win.isDestroyed(); i++) {
    const state = await win.webContents.executeJavaScript(
      `({ cls: document.getElementById('engine-status')?.className || '', title: document.title, desktop: typeof window.helixDesktop === 'object', node: typeof require })`,
    ).catch(() => null);
    if (state && /\bok\b/.test(state.cls)) return emit('workbench.connected', { pid: engine && engine.pid, title: state.title, desktop: state.desktop, node: state.node });
    await new Promise((r) => setTimeout(r, 250));
  }
  emit('workbench.disconnected', {});
}

function createWindow() {
  const w = new BrowserWindow({
    width: 1400,
    height: 900,
    show: !HEADLESS,
    title: 'Helix',
    // Headless CI: native windows crash under `--ozone-platform=headless`, offscreen rendering does not.
    webPreferences: windowWebPreferences({ preload: path.join(__dirname, 'preload.cjs'), offscreen: HEADLESS }),
  });
  win = w;
  w.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault();
      emit('navigation.blocked', { origin: new URL(target).origin });
    }
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !HEADLESS) {
      dialog.showMessageBox(w, { type: 'question', buttons: ['Open in browser', 'Cancel'], defaultId: 1, message: `Open ${url} in your browser?` })
        .then((r) => { if (r.response === 0) shell.openExternal(url); });
    }
    return { action: 'deny' };
  });
  w.webContents.on('did-finish-load', () => {
    attachBridge(w);
    if (w === win) void waitConnected();
  });
  w.webContents.on('render-process-gone', (_event, details) => onRendererGone(w, details));
  return w;
}

function stopEngine() {
  return new Promise((resolve) => {
    const child = engine;
    if (!child) return resolve();
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

app.on('will-quit', (event) => {
  if (!engine) return;
  event.preventDefault();
  quitting = true;
  stopEngine().then(() => app.quit());
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => { event.preventDefault(); emit('webview.blocked', {}); });
});
process.on('SIGTERM', () => app.quit());
process.on('SIGINT', () => app.quit());

app.whenReady().then(async () => {
  enforceCsp();
  createWindow();
  try {
    await load(await startEngine());
  } catch (err) {
    emit('engine.error', { message: err.message });
  }
});
