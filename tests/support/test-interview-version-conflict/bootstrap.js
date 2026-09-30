'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

if (app.isPackaged) {
  throw new Error('Synthetic interview version conflict runtime is compile-time excluded from packaged HRBOSS builds.');
}

const syntheticRoot = fs.realpathSync(path.resolve(process.env.HRBOSS_B8_SYNTHETIC_ROOT || ''));
const userData = path.join(syntheticRoot, 'user-data');
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(userData, 0o700);
app.setPath('userData', userData);

const telemetry = {
  reportRequests: [],
  reportReads: [],
  concurrentWrites: [],
};
const originalHandle = ipcMain.handle.bind(ipcMain);
Object.defineProperty(ipcMain, 'handle', {
  configurable: true,
  value(channel, listener) {
    if (channel !== 'local-api:request') return originalHandle(channel, listener);
    return originalHandle(channel, async (...args) => {
      const request = args[1] || {};
      const isFactWrite = request.service === 'action'
        && request.method === 'POST'
        && request.requestPath === '/interview-report/facts';
      const isReportRead = request.service === 'action'
        && request.method === 'GET'
        && String(request.requestPath || '').startsWith('/interview-report?');
      if (!isFactWrite && !isReportRead) return listener(...args);
      const record = {
        request_path: request.requestPath,
        body: request.body || {},
        started_at: new Date().toISOString(),
        completed_at: null,
        response_status: null,
        response_code: null,
        report_version: null,
      };
      (isFactWrite ? telemetry.reportRequests : telemetry.reportReads).push(record);
      const response = await listener(...args);
      record.response_status = response && response.status;
      record.response_code = response && response.body && response.body.code;
      record.report_version = response && response.body && response.body.report
        ? Number(response.body.report.version)
        : null;
      record.completed_at = new Date().toISOString();
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
