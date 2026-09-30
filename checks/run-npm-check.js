'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { ROOT, manifest, validateRepository } = require('./registry');
const { resolveElectronRuntime, buildElectronNodePath } = require('../start-candidate-ui');

function runCommand(name, stack = new Set()) {
  const steps = manifest.commands[name];
  if (!steps) throw new Error(`Unknown npm check command: ${name}`);
  if (stack.has(name)) throw new Error(`Recursive npm check command: ${name}`);
  const next = new Set([...stack, name]);
  for (const step of steps) {
    if (step.executable === 'npm' && step.args[0] === 'run' && manifest.commands[step.args[1]]) {
      runCommand(step.args[1], next);
      continue;
    }
    const env = { ...process.env, ...step.env };
    let executable = process.execPath;
    let args = [...step.args];
    if (step.executable === 'electron') {
      const runtime = resolveElectronRuntime();
      executable = runtime.electron;
      env.NODE_PATH = buildElectronNodePath(runtime.dependencyRoot, env.NODE_PATH);
    } else if (step.executable === 'npm') {
      if (!process.env.npm_execpath) throw new Error('Run composed checks through npm run so npm_execpath is available.');
      args = [process.env.npm_execpath, ...args];
    }
    if (step.executable !== 'npm') args[0] = path.join(ROOT, args[0]);
    const result = spawnSync(executable, args, { cwd: ROOT, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${name}: ${step.args.join(' ')} failed (${result.signal || result.status})`);
  }
}

if (require.main === module) {
  try { validateRepository(); runCommand(process.argv[2]); }
  catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
module.exports = { runCommand };
