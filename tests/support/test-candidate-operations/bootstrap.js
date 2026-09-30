'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

if (app.isPackaged) {
  throw new Error('Synthetic candidate operations runtime is compile-time excluded from packaged HRBOSS builds.');
}

const syntheticRoot = fs.realpathSync(path.resolve(process.env.HRBOSS_B3_SYNTHETIC_ROOT || ''));
const userData = path.join(syntheticRoot, 'user-data');
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(userData, 0o700);
app.setPath('userData', userData);

const telemetry = { candidateStatusRequests: [] };
const originalHandle = ipcMain.handle.bind(ipcMain);
Object.defineProperty(ipcMain, 'handle', {
  configurable: true,
  value(channel, listener) {
    if (channel !== 'local-api:request') return originalHandle(channel, listener);
    return originalHandle(channel, async (...args) => {
      const request = args[1] || {};
      const isCandidateStatus = request.service === 'action'
        && request.method === 'POST'
        && request.requestPath === '/candidate-status';
      if (!isCandidateStatus) return listener(...args);
      const record = {
        action: request.body && (request.body.action || request.body.code),
        candidate_id: request.body && request.body.candidateId,
        started_at: new Date().toISOString(),
        backend_completed_at: null,
        released_at: null,
        response_status: null,
      };
      telemetry.candidateStatusRequests.push(record);
      const response = await listener(...args);
      record.response_status = response && response.status;
      record.backend_completed_at = new Date().toISOString();
      await new Promise((resolve) => setTimeout(resolve, 1_400));
      record.released_at = new Date().toISOString();
      return response;
    });
  },
});

require('./runtime-controller').installRuntimeController({
  app,
  BrowserWindow,
  syntheticRoot,
  telemetry,
});
require(path.join(__dirname, "../../../src/candidate-main.js"));
Object.defineProperty(ipcMain, 'handle', {
  configurable: true,
  value: originalHandle,
});
