'use strict';

const fs = require('node:fs');
const path = require('node:path');

function preserveLegacyUserDataPath(app) {
  const current = app.getPath('userData');
  if (app.commandLine?.hasSwitch('user-data-dir')) return current;
  const appData = app.getPath('appData');
  const isNewDefault = ['TalentBench', 'TalentBench 识才台', 'talentbench', '招才官', 'ZhaocaiGuan', 'zhaocai-guan']
    .some((name) => path.resolve(current) === path.resolve(appData, name));
  // Respect custom profiles, especially isolated runtime-test directories.
  if (!isNewDefault) return current;
  const legacy = path.join(appData, 'HRBOSS');
  fs.mkdirSync(legacy, { recursive: true, mode: 0o700 });
  app.setPath('userData', legacy);
  return legacy;
}

module.exports = { preserveLegacyUserDataPath };
