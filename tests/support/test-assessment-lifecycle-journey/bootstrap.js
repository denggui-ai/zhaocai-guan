'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const {
  ENV_KEYS,
  createSelectionQueue,
  loadSignedPlan,
} = require('../test-native-file-selection/signed-plan');

if (app.isPackaged) {
  throw new Error('Synthetic assessment lifecycle runtime is compile-time excluded from packaged HRBOSS builds.');
}

const syntheticRoot = fs.realpathSync(path.resolve(process.env.HRBOSS_B10_SYNTHETIC_ROOT || ''));
const plan = loadSignedPlan({
  marker: process.env[ENV_KEYS.marker],
  planPath: process.env[ENV_KEYS.plan],
  secret: process.env[ENV_KEYS.secret],
});
if (plan.root !== syntheticRoot) throw new Error('Synthetic assessment lifecycle root does not match the signed plan.');
const selectionQueue = createSelectionQueue(plan);
const userData = path.join(syntheticRoot, 'user-data');
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(userData, 0o700);
app.setPath('userData', userData);

for (const key of [...Object.values(ENV_KEYS), 'HRBOSS_B10_SYNTHETIC_ROOT']) delete process.env[key];
fs.unlinkSync(plan.planPath);

Object.defineProperty(dialog, 'showOpenDialog', {
  configurable: true,
  value: async (...args) => {
    const options = args.length === 1 ? args[0] : args[1];
    if (!options || typeof options !== 'object') {
      throw new Error('Synthetic assessment lifecycle received an invalid dialog request.');
    }
    return selectionQueue.next(options);
  },
});

const telemetry = {
  importRequests: [],
  assessmentRequests: [],
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
const trackedAssessmentPaths = new Set([
  '/assessment/binding/confirm',
  '/assessment/preview',
  '/assessment/binding/revoke',
]);
const originalHandle = ipcMain.handle.bind(ipcMain);
Object.defineProperty(ipcMain, 'handle', {
  configurable: true,
  value(channel, listener) {
    if (channel === 'assessment:select-and-import') {
      return originalHandle(channel, async (...args) => {
        const request = args[1] || {};
        const record = {
          request: { ...request },
          started_at: new Date().toISOString(),
          completed_at: null,
          response_ok: null,
          selected_count: null,
          succeeded: null,
          failed: null,
        };
        telemetry.importRequests.push(record);
        const response = await listener(...args);
        record.response_ok = response?.ok === true;
        record.selected_count = Number(response?.selected_count || 0);
        record.succeeded = Number(response?.succeeded_count || 0);
        record.failed = Number(response?.failed_count || 0);
        record.completed_at = new Date().toISOString();
        return response;
      });
    }
    if (channel !== 'local-api:request') return originalHandle(channel, listener);
    return originalHandle(channel, async (...args) => {
      const request = args[1] || {};
      const tracked = request.service === 'action'
        && (
          (request.method === 'POST' && trackedAssessmentPaths.has(request.requestPath))
          || (request.method === 'GET' && /^\/assessment\/preview\/[0-9a-f-]{36}\/page\/1$/.test(request.requestPath))
        );
      if (!tracked) return listener(...args);
      const record = {
        method: request.method,
        request_path: request.requestPath,
        body: request.body || {},
        response_type: request.responseType || 'json',
        started_at: new Date().toISOString(),
        completed_at: null,
        response_status: null,
        response_code: null,
        response_result: null,
        response_preview: null,
      };
      telemetry.assessmentRequests.push(record);
      const response = await listener(...args);
      record.response_status = response?.status ?? null;
      record.response_code = response?.body?.code || null;
      record.response_result = response?.body?.result || null;
      record.response_preview = response?.body?.preview || null;
      record.completed_at = new Date().toISOString();
      return response;
    });
  },
});

process.once('exit', () => {
  if (selectionQueue.remaining() !== 0) {
    process.stderr.write(`Synthetic assessment lifecycle left ${selectionQueue.remaining()} signed dialog entries unused.\n`);
  }
});

require('./runtime-controller').installRuntimeController({
  app,
  BrowserWindow,
  syntheticRoot,
  selectionQueue,
  telemetry,
});
require(path.join(__dirname, "../../../src/candidate-main.js"));
Object.defineProperty(ipcMain, 'handle', {
  configurable: true,
  value: originalHandle,
});
