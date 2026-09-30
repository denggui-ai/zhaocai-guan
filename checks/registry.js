'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const manifest = require('./manifest.json');

function getGroup(name, source = manifest) {
  const group = source.groups[name];
  if (!Array.isArray(group)) throw new Error(`Unknown check group: ${name}`);
  return [...group];
}

function discoverCheckFiles(root = ROOT) {
  const files = fs.readdirSync(root).filter(name => /^check-.*\.js$/.test(name));
  function walk(dir) {
    if (!fs.existsSync(path.join(root, dir))) return;
    for (const item of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = `${dir}/${item.name}`;
      if (item.isDirectory()) walk(relative);
      else if (item.isFile() && item.name.endsWith('.js')) files.push(relative);
    }
  }
  walk('checks');
  if (fs.existsSync(path.join(root, 'create-ui-fixture-db.js'))) files.push('create-ui-fixture-db.js');
  return files.sort();
}

function validateManifest(source, discovered) {
  if (source.version !== 1 || !Array.isArray(source.entries) || !source.groups || !source.commands) {
    throw new Error('Invalid check manifest schema');
  }
  const entries = new Map();
  for (const entry of source.entries) {
    if (typeof entry.path !== 'string' || entry.path.includes('\\') || entry.path.startsWith('/')
        || entry.path.split('/').some(part => !part || part === '..' || part === '.')) {
      throw new Error(`Invalid check path: ${entry.path}`);
    }
    if (entries.has(entry.path)) throw new Error(`Duplicate check registration: ${entry.path}`);
    if (!['check', 'helper', 'runner', 'fixture'].includes(entry.kind)) throw new Error(`Invalid kind: ${entry.path}`);
    if (!['system-node', 'electron-node', 'electron-gui', 'not-executable'].includes(entry.runtime)) {
      throw new Error(`Invalid runtime: ${entry.path}`);
    }
    if (!Array.isArray(entry.platforms) || !entry.platforms.length
        || entry.platforms.some(p => !['darwin', 'linux', 'win32'].includes(p))) {
      throw new Error(`Invalid platforms: ${entry.path}`);
    }
    if (!discovered.includes(entry.path)) throw new Error(`Registered check is missing: ${entry.path}`);
    entries.set(entry.path, entry);
  }
  for (const file of discovered) {
    if (!entries.has(file)) throw new Error(`Unregistered check: ${file}`);
  }
  const assigned = new Set();
  for (const [name, files] of Object.entries(source.groups)) {
    if (!Array.isArray(files)) throw new Error(`Invalid group: ${name}`);
    if (new Set(files).size !== files.length) throw new Error(`Duplicate check in group: ${name}`);
    for (const file of files) {
      const entry = entries.get(file);
      if (!entry || !['check', 'fixture'].includes(entry.kind)) {
        throw new Error(`Group ${name} contains a missing or non-executable helper: ${file}`);
      }
      assigned.add(file);
    }
  }
  for (const [name, steps] of Object.entries(source.commands)) {
    if (!Array.isArray(steps) || !steps.length) throw new Error(`Empty npm command: ${name}`);
    for (const step of steps) {
      if (!['node', 'electron', 'npm'].includes(step.executable) || !Array.isArray(step.args)
          || step.args.some(arg => typeof arg !== 'string') || !step.env || typeof step.env !== 'object') {
        throw new Error(`Invalid npm command step: ${name}`);
      }
      if (step.executable !== 'npm') {
        const file = step.args[0];
        if (!entries.has(file)) throw new Error(`Unregistered npm entry: ${name}: ${file}`);
        const entry = entries.get(file);
        if (entry.kind === 'helper') throw new Error(`npm command cannot execute helper: ${file}`);
        assigned.add(file);
        if (entry.kind === 'runner' && step.args[1] === 'files') {
          for (const check of step.args.slice(2)) {
            if (!entries.has(check) || entries.get(check).kind !== 'check') {
              throw new Error(`Unregistered npm check: ${name}: ${check}`);
            }
            assigned.add(check);
          }
        }
      }
    }
  }
  for (const entry of entries.values()) {
    if (entry.kind === 'check' && !assigned.has(entry.path)
        && !(typeof entry.manualReason === 'string' && entry.manualReason.trim())) {
      throw new Error(`Unassigned check requires manualReason: ${entry.path}`);
    }
  }
  return true;
}

function validateRepository() {
  return validateManifest(manifest, discoverCheckFiles());
}

function renderCommand(name) {
  if (!manifest.commands[name]) throw new Error(`Unknown npm check: ${name}`);
  return manifest.commands[name].map(step => [
    ...Object.entries(step.env).map(([key, value]) => `${key}=${value}`), step.executable, ...step.args,
  ].join(' ')).join(' && ');
}

module.exports = { ROOT, manifest, getGroup, discoverCheckFiles, validateManifest, validateRepository, renderCommand };
