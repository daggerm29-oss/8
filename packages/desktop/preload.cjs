'use strict';
// Minimal, typed bridge (§5.1): no Node APIs reach the renderer, which talks to the Engine over its own WebSocket.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('helixDesktop', Object.freeze({ shell: 'electron', platform: process.platform }));
