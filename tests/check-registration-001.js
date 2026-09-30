'use strict';
const { PROJECT_ROOT } = require("../src/paths");

// Catches missing registrations, ambiguous entry kinds and silently dropped groups.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registryPath = path.join(PROJECT_ROOT, "tests/support", 'registry.js');
assert.ok(fs.existsSync(registryPath), 'a complete check registry must exist before checks are dispatched');
const { validateManifest, discoverCheckFiles, getGroup, validateRepository } = require("./support/registry");
const fixture = () => ({ version: 1, entries: [
  { path: 'check-one.js', kind: 'check', runtime: 'system-node', platforms: ['darwin', 'linux', 'win32'] },
  { path: "tests/support/helper.js", kind: 'helper', runtime: 'not-executable', platforms: ['darwin', 'linux', 'win32'] },
], groups: { core: ['check-one.js'] }, commands: {} });
const discovered = ['check-one.js', "tests/support/helper.js"];
assert.doesNotThrow(() => validateManifest(fixture(), discovered));
assert.throws(() => validateManifest(fixture(), [...discovered, 'check-forgotten.js']), /unregistered.*check-forgotten/i);
const duplicate = fixture(); duplicate.entries.push({ ...duplicate.entries[0] });
assert.throws(() => validateManifest(duplicate, discovered), /duplicate.*check-one/i);
const missing = fixture(); missing.entries[0].path = 'missing.js';
assert.throws(() => validateManifest(missing, discovered), /missing|unregistered/i);
const ungrouped = fixture(); ungrouped.groups.core = [];
assert.throws(() => validateManifest(ungrouped, discovered), /manualReason|unassigned/i);
ungrouped.entries[0].manualReason = 'Requires a native desktop; explicitly run before release.';
assert.doesNotThrow(() => validateManifest(ungrouped, discovered));
const helperAsCheck = fixture(); helperAsCheck.groups.core.push("tests/support/helper.js");
assert.throws(() => validateManifest(helperAsCheck, discovered), /helper|executable/i);
const duplicateGroup = fixture(); duplicateGroup.groups.core.push('check-one.js');
assert.throws(() => validateManifest(duplicateGroup, discovered), /duplicate/i);
const traversal = fixture(); traversal.entries[0].path = '../outside.js';
assert.throws(() => validateManifest(traversal, discovered), /path/i);
assert.deepEqual(getGroup('core', fixture()), ['check-one.js']);
assert.throws(() => getGroup('typo', fixture()), /unknown/i);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhaocai-check-registry-'));
try {
  fs.mkdirSync(path.join(tmp, "tests/support"), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'check-one.js'), '');
  fs.writeFileSync(path.join(tmp, "tests/support", 'helper.js'), '');
  fs.mkdirSync(path.join(tmp, 'node_modules'));
  fs.writeFileSync(path.join(tmp, 'node_modules', 'check-not-ours.js'), '');
  assert.deepEqual(discoverCheckFiles(tmp), discovered);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
validateRepository();
console.log('check-registration-001: PASS (inventory, duplicates, grouping, manual reasons, paths)');
