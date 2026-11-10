'use strict';
/**
 * Helix desktop shell (F-AUTH-1, architecture.md §5.1). The Engine runs as its own OS process so a UI
 * crash never kills agents; this main process supervises it (restart with backoff) and shows the
 * workbench in a hardened window. The per-launch token stays in the URL fragment and is never logged.
 */
const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { existsSync } = require('node:fs');
const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'dist');
const ENGINE_MAIN = app.isPackaged ? path.join(resources, 'engine/src/main.mjs') : process.env.HELIX_ENGINE_MAIN || path.resolve(__dirname, '../engine/src/main.ts');
const NODE = app.isPackaged ? path.join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') : process.env.HELIX_NODE || 'node';
const RENDERER = path.join(resources, 'renderer');
const HEADLESS = process.env.HELIX_DESKTOP_HEADLESS === '1';
const MAX_BACKOFF_MS = 10_000;
const STABLE_UPTIME_MS = 30_000;

/** Lifecycle events as JSON lines on stdout (supervision log; used by the smoke test). */
const emit = (event, data = {}) => process.stdout.write(`helix-desktop ${JSON.stringify({ event, ...data })}\n`);

let engine = null;
let origin = null;
let win = null;
let quitting = false;
let restarts = 0;

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

async function load(url) {
  origin = new URL(url).origin;
  emit('engine.ready', { pid: engine && engine.pid, origin });
  if (win && !win.isDestroyed()) await win.loadURL(url);
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
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: !HEADLESS,
    title: 'Helix',
    // Headless CI: native windows crash under `--ozone-platform=headless`, offscreen rendering does not.
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, offscreen: HEADLESS, preload: path.join(__dirname, 'preload.cjs') },
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault();
      emit('navigation.blocked', { origin: new URL(target).origin });
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !HEADLESS) {
      dialog.showMessageBox(win, { type: 'question', buttons: ['Open in browser', 'Cancel'], defaultId: 1, message: `Open ${url} in your browser?` })
        .then((r) => { if (r.response === 0) shell.openExternal(url); });
    }
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', () => void waitConnected());
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
process.on('SIGTERM', () => app.quit());
process.on('SIGINT', () => app.quit());

app.whenReady().then(async () => {
  createWindow();
  try {
    await load(await startEngine());
  } catch (err) {
    emit('engine.error', { message: err.message });
  }
});
