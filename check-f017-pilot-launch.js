'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const packageJson = require('./package.json');
const launcher = fs.readFileSync(path.join(__dirname, 'start-assessment-pilot-mac.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'action-server.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, 'candidate-main.js'), 'utf8');
const normalLauncher = fs.readFileSync(path.join(__dirname, 'start-candidate-ui.js'), 'utf8');

assert.equal(
  packageJson.scripts['assessment:pilot:mac'],
  'npm run build:web && node start-assessment-pilot-mac.js',
);
assert.match(launcher, /process\.platform !== 'darwin'/);
assert.match(launcher, /process\.env\.HRBOSS_ASSESSMENT_PHASE_A_ENABLED = '1'/);
assert.match(launcher, /require\('\.\/start-candidate-ui'\)/);
assert.equal(packageJson.scripts.ui, 'npm run build:web && node start-candidate-ui.js');
assert.match(main, /const ASSESSMENT_ENABLED = process\.env\.HRBOSS_ASSESSMENT_PHASE_A_ENABLED !== '0'/);
assert.doesNotMatch(normalLauncher, /HRBOSS_ASSESSMENT_PHASE_A_ENABLED\s*=/);
assert.match(main, /HRBOSS_ASSESSMENT_PHASE_A_ENABLED: ASSESSMENT_ENABLED \? '1' : '0'/);
assert.match(main, /DEFAULT_ASSESSMENT_RETENTION_POLICY_VERSION = 'hrboss-internal-assessment-v1'/);
assert.match(main, /DEFAULT_ASSESSMENT_RETENTION_DAYS = '365'/);
assert.match(server, /ASSESSMENT_INTERNAL_AVAILABLE = ASSESSMENT_PHASE_A_ENABLED/);
assert.match(server, /real_pdf_pilot_allowed: false/);
assert.match(server, /automated_decision_use: false/);
assert.match(server, /automatic_scoring_enabled: false/);
assert.match(server, /automatic_ranking_enabled: false/);
assert.match(server, /ranking_requires_hr_confirmed_binding: true/);
assert.match(server, /ai_requires_per_use_hr_approval: true/);
assert.match(server, /import_enabled: ASSESSMENT_INTERNAL_AVAILABLE/);

console.log('check-f017-pilot-launch ok');
