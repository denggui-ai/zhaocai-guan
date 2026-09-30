'use strict';
const { PROJECT_ROOT } = require("../src/paths");

// Catches packaged/source entry paths and default data roots changing during relocation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = PROJECT_ROOT;
const pkg = require("../package.json");
assert.equal(pkg.main, 'src/candidate-main.js', 'Electron must start through the relocated entry');
for (const file of [pkg.main, 'src/preload.js', 'src/start-candidate-ui.js', 'src/action-server.js',
  'native/vision-ocr.swift', 'native/stitch-screenshot-drafts.py', 'src/legacy/candidate.html']) {
  assert.ok(fs.statSync(path.join(root, file)).isFile(), `Required runtime resource: ${file}`);
}
const config = require("../forge.config");
const ignored = file => config.packagerConfig.ignore.some(pattern => pattern.test('/' + file));
for (const file of ['tests/check-registration-001.js', 'tests/support/bootstrap.js', 'scripts/asr-model-benchmark-p0.js',
  'docs/showcase/workbench.png', '.superpowers/sdd/progress.md', 'release/build-development-source.sh']) {
  assert.equal(ignored(file), true, `Development-only input must not ship: ${file}`);
}
for (const file of ['src/candidate-main.js', 'src/preload.js', 'native/vision-ocr.swift',
  'frontend/dist/index.html', 'assets/app-icon.png', 'LICENSE', 'THIRD_PARTY_LICENSES.txt', 'THIRD_PARTY_NOTICES.md']) {
  assert.equal(ignored(file), false, `Runtime/license resource must ship: ${file}`);
}
const outcome = spawnSync(process.execPath, ['-e', `
  const path = require('path');
  const p = require(${JSON.stringify(path.join(root, 'src/interview-material-paths.js'))});
  process.stdout.write(p.DEFAULT_INTERVIEW_MATERIAL_ROOT);
`], { cwd: require('node:os').tmpdir(), encoding: 'utf8' });
assert.equal(outcome.status, 0, outcome.stderr);
assert.equal(outcome.stdout, path.join(root, 'data', 'interviews'), 'Default data stays at the application root, not src/ or cwd');
const { resolveElectronRuntime } = require("../src/start-candidate-ui");
assert.ok(fs.existsSync(resolveElectronRuntime().electron), 'Relocated launcher resolves the pinned Electron');
console.log('check-repository-layout-001: PASS (entry, resources, package filtering, stable data root)');

const packageProbe = fs.readFileSync(path.join(root, 'release/macos-candidate-self-test.js'), 'utf8');
assert.match(packageProbe, /path\.join\(resources, 'src', 'sqlite-backup-recovery'\)/,
  'Generated packaged recovery probe must resolve the migrated runtime module');
assert.ok(fs.existsSync(path.join(root, 'src/sqlite-backup-recovery.js')));
