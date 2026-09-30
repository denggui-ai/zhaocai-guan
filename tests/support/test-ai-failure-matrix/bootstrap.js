'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
const {
  ENV_KEYS,
  PLAN_MARKER,
  createConfirmationQueue,
  loadSignedPlan,
} = require('./signed-plan');

if (app.isPackaged) {
  throw new Error('Synthetic B-11 AI failure matrix is compile-time excluded from packaged Zhaocai Guan builds.');
}

const plan = loadSignedPlan({
  marker: process.env[ENV_KEYS.marker],
  planPath: process.env[ENV_KEYS.plan],
  secret: process.env[ENV_KEYS.secret],
});
const providerBaseUrl = String(process.env.HRBOSS_B11_PROVIDER_BASE_URL || '').trim();
const confirmationQueue = createConfirmationQueue(plan, providerBaseUrl);
const userData = path.join(plan.root, 'user-data');
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(userData, 0o700);
app.setPath('userData', userData);

for (const key of Object.values(ENV_KEYS)) delete process.env[key];
fs.unlinkSync(plan.planPath);

const originalRandomBytes = crypto.randomBytes;
let candidateMainRandom32Calls = 0;
let f009SecretInjected = false;
crypto.randomBytes = function testOnlyRandomBytes(size, callback) {
  const fromCandidateMain = size === 32 && String(new Error().stack || '').includes(`${path.sep}candidate-main.js`);
  if (fromCandidateMain) candidateMainRandom32Calls += 1;
  if (fromCandidateMain && candidateMainRandom32Calls === 2) {
    f009SecretInjected = true;
    crypto.randomBytes = originalRandomBytes;
    const bytes = Buffer.from(plan.f009ApprovalSecret, 'hex');
    if (typeof callback === 'function') {
      process.nextTick(callback, null, bytes);
      return undefined;
    }
    return bytes;
  }
  return originalRandomBytes.call(crypto, size, callback);
};

Object.defineProperty(dialog, 'showMessageBox', {
  configurable: true,
  value: async (...args) => {
    const options = args.length === 1 ? args[0] : args[1];
    if (!options || typeof options !== 'object') {
      throw new Error('Synthetic B-11 native AI confirmation received an invalid dialog request.');
    }
    return confirmationQueue.next(options);
  },
});

process.once('exit', () => {
  if (confirmationQueue.remaining() !== 0) {
    process.stderr.write(`Synthetic B-11 native AI confirmation left ${confirmationQueue.remaining()} signed responses unused.\n`);
  }
});

require('./runtime-controller').installRuntimeController({
  app,
  BrowserWindow,
  syntheticRoot: plan.root,
  confirmationQueue,
  wasSecretInjected: () => f009SecretInjected,
  providerBaseUrl,
});
require(path.join(__dirname, "../../../src/candidate-main.js"));
