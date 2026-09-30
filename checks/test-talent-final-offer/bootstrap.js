'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, clipboard, ipcMain } = require('electron');

if (app.isPackaged) {
  throw new Error('Synthetic talent/final-review/Offer runtime is compile-time excluded from packaged HRBOSS builds.');
}

const syntheticRoot = fs.realpathSync(path.resolve(process.env.HRBOSS_B12_SYNTHETIC_ROOT || ''));
const userData = path.join(syntheticRoot, 'user-data');
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(userData, 0o700);
app.setPath('userData', userData);

delete process.env.HRBOSS_B12_SYNTHETIC_ROOT;

const telemetry = {
  localApiRequests: [],
  rendererConsole: [],
};
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_consoleEvent, levelOrDetails, message, line, sourceId) => {
    const details = levelOrDetails && typeof levelOrDetails === 'object'
      ? levelOrDetails
      : {
        level: levelOrDetails,
        message,
        lineNumber: line,
        sourceId,
      };
    telemetry.rendererConsole.push({
      level: details.level,
      message: String(details.message || ''),
      line: Number(details.lineNumber || 0),
      source_id: String(details.sourceId || ''),
    });
    if (telemetry.rendererConsole.length > 100) telemetry.rendererConsole.shift();
  });
});

const trackedPaths = [
  /^\/f018\/final-review/,
  /^\/f018\/disposition$/,
  /^\/candidate-journey-operations/,
  /^\/candidate-journey\/offer-status$/,
  /^\/talent-pool/,
];
const originalHandle = ipcMain.handle.bind(ipcMain);
Object.defineProperty(ipcMain, 'handle', {
  configurable: true,
  value(channel, listener) {
    if (channel !== 'local-api:request') return originalHandle(channel, listener);
    return originalHandle(channel, async (...args) => {
      const request = args[1] || {};
      const tracked = trackedPaths.some((pattern) => pattern.test(String(request.requestPath || '')));
      if (!tracked) return listener(...args);
      const record = {
        service: request.service,
        method: request.method,
        request_path: request.requestPath,
        body: request.body || null,
        started_at: new Date().toISOString(),
        completed_at: null,
        response_status: null,
        response_code: null,
      };
      telemetry.localApiRequests.push(record);
      const response = await listener(...args);
      record.response_status = response?.status ?? null;
      record.response_code = response?.body?.code || null;
      record.completed_at = new Date().toISOString();
      return response;
    });
  },
});

const originalClipboardText = clipboard.readText();
require('./runtime-controller').installRuntimeController({
  app,
  BrowserWindow,
  clipboard,
  originalClipboardText,
  syntheticRoot,
  telemetry,
});
require(path.join(__dirname, '..', '..', 'candidate-main.js'));
Object.defineProperty(ipcMain, 'handle', {
  configurable: true,
  value: originalHandle,
});
