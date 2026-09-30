'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

if (app.isPackaged) {
  throw new Error('Synthetic candidate scale runtime is compile-time excluded from packaged HRBOSS builds.');
}

const syntheticRoot = fs.realpathSync(path.resolve(process.env.HRBOSS_B14_SYNTHETIC_ROOT || ''));
const candidateCount = Number(process.env.HRBOSS_B14_CANDIDATE_COUNT);
if (![100, 500, 1000].includes(candidateCount)) throw new Error('invalid B-14 candidate count');

const userData = path.join(syntheticRoot, 'user-data');
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(userData, 0o700);
app.setPath('userData', userData);

require('./runtime-controller').installRuntimeController({
  app,
  BrowserWindow,
  syntheticRoot,
  candidateCount,
});
require(path.join(__dirname, '..', '..', 'candidate-main.js'));
