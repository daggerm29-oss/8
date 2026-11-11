'use strict';
/**
 * Electron hardening policy (SEC-13, architecture.md §5.1). Shared by the main process and the hardening
 * tests so the enforced policy and the verified policy are the same object.
 */

/** Enforced on every workbench response from the Engine origin. Scripts only from 'self'; never framed. */
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "worker-src 'self'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  'frame-src http://127.0.0.1:* http://localhost:*',
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
].join('; ');

/** Renderer: no Node, isolated world, Chromium sandbox, no webviews or subframe Node. */
function windowWebPreferences({ preload, offscreen = false }) {
  return Object.freeze({
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    enableBlinkFeatures: '',
    spellcheck: false,
    offscreen,
    preload,
  });
}

const MAX_URL = 2048;
const noPayload = (payload) => (payload === undefined || (isPlainObject(payload) && Object.keys(payload).length === 0) ? null : 'payload not accepted');

/** The complete IPC allowlist. Anything else is rejected by the main process. */
const IPC_CHANNELS = Object.freeze({
  'app.info': noPayload,
  'engine.connection': noPayload,
  'engine.status': noPayload,
  'shell.openExternal': (payload) => {
    if (!isPlainObject(payload) || Object.keys(payload).join() !== 'url' || typeof payload.url !== 'string') return 'payload must be { url: string }';
    if (payload.url.length > MAX_URL) return 'url too long';
    let parsed;
    try { parsed = new URL(payload.url); } catch { return 'invalid url'; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'invalid url scheme';
    if (parsed.username || parsed.password) return 'invalid url credentials';
    return null;
  },
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Validates one bridge message `{ id, channel, payload? }`.
 * Returns `{ ok: true, id, channel, payload }` or `{ ok: false, id, error }` (id is null when unusable).
 */
function validateIpcRequest(message) {
  const id = isPlainObject(message) && Number.isSafeInteger(message.id) && message.id > 0 ? message.id : null;
  if (id === null) return { ok: false, id: null, error: 'IPC request must have a positive integer id' };
  const extra = Object.keys(message).filter((k) => k !== 'id' && k !== 'channel' && k !== 'payload');
  if (extra.length) return { ok: false, id, error: `IPC request has unexpected fields: ${extra.join(', ')}` };
  if (typeof message.channel !== 'string' || message.channel.length > 64) return { ok: false, id, error: 'IPC channel must be a string' };
  if (!Object.prototype.hasOwnProperty.call(IPC_CHANNELS, message.channel)) return { ok: false, id, error: `IPC channel not allowed: ${message.channel}` };
  const problem = IPC_CHANNELS[message.channel](message.payload);
  if (problem) return { ok: false, id, error: `invalid ${message.channel} payload: ${problem}` };
  return { ok: true, id, channel: message.channel, payload: message.payload };
}

/** Parses a CSP header into `{ directive: [sources] }`. */
function parseCsp(header) {
  const out = {};
  for (const part of String(header).split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name.toLowerCase()] = sources;
  }
  return out;
}

/** Returns the SEC-13 violations of a CSP header (empty when compliant). */
function cspViolations(header) {
  const csp = parseCsp(header);
  const problems = [];
  const scripts = csp['script-src'] ?? csp['default-src'];
  if (!scripts) problems.push('no script-src or default-src');
  else {
    for (const bad of ["'unsafe-inline'", "'unsafe-eval'", '*', 'data:', 'http:', 'https:']) if (scripts.includes(bad)) problems.push(`script-src allows ${bad}`);
  }
  const ancestors = csp['frame-ancestors'];
  if (!ancestors) problems.push('no frame-ancestors');
  else if (ancestors.some((s) => s === '*' || s === 'http:' || s === 'https:')) problems.push(`frame-ancestors allows ${ancestors.join(' ')}`);
  if (!csp['object-src'] || !csp['object-src'].includes("'none'")) problems.push("object-src is not 'none'");
  if (!csp['base-uri']) problems.push('no base-uri');
  return problems;
}

module.exports = { RENDERER_CSP, IPC_CHANNELS, windowWebPreferences, validateIpcRequest, parseCsp, cspViolations };
