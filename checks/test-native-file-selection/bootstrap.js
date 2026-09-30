'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
const {
  ENV_KEYS,
  PLAN_MARKER,
  createSelectionQueue,
  loadSignedPlan,
} = require('./signed-plan');

if (app.isPackaged) {
  throw new Error('Synthetic native file selection is compile-time excluded from packaged HRBOSS builds.');
}

const plan = loadSignedPlan({
  marker: process.env[ENV_KEYS.marker],
  planPath: process.env[ENV_KEYS.plan],
  secret: process.env[ENV_KEYS.secret],
});
const queue = createSelectionQueue(plan);
const userData = path.join(plan.root, 'user-data');
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(userData, 0o700);
app.setPath('userData', userData);

for (const key of Object.values(ENV_KEYS)) delete process.env[key];
fs.unlinkSync(plan.planPath);

Object.defineProperty(dialog, 'showOpenDialog', {
  configurable: true,
  value: async (...args) => {
    const options = args.length === 1 ? args[0] : args[1];
    if (!options || typeof options !== 'object') {
      throw new Error('Synthetic native file selection received an invalid dialog request.');
    }
    return queue.next(options);
  },
});

process.once('exit', () => {
  if (queue.remaining() !== 0) {
    process.stderr.write(`Synthetic native file selection left ${queue.remaining()} signed dialog entries unused.\n`);
  }
});

require('./runtime-controller').installRuntimeController({
  app,
  BrowserWindow,
  syntheticRoot: plan.root,
  selectionQueue: queue,
});
require(path.join(__dirname, '..', '..', 'candidate-main.js'));
