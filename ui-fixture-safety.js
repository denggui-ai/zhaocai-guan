'use strict';

const fs = require('fs');
const path = require('path');

const GATE_ENV = 'HRBOSS_UI_FIXTURE_GATE';
const ROOT_ENV = 'HRBOSS_UI_FIXTURE_ROOT';
const TEMP_PARENT_ENV = 'HRBOSS_UI_FIXTURE_TEMP_PARENT';

function reject(reason) {
  throw new Error(`UI fixture safety gate rejected: ${reason}`);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function assertUiFixtureEnvironment(env = process.env) {
  if (env[GATE_ENV] !== '1') reject(`missing ${GATE_ENV}=1`);
  if (!env[ROOT_ENV]) reject(`missing ${ROOT_ENV}`);
  if (!env[TEMP_PARENT_ENV]) reject(`missing ${TEMP_PARENT_ENV}`);
  if (!env.BOSS_DB_PATH) reject('missing BOSS_DB_PATH');
  if (!path.isAbsolute(env[ROOT_ENV])) reject(`${ROOT_ENV} must be absolute`);
  if (!path.isAbsolute(env[TEMP_PARENT_ENV])) reject(`${TEMP_PARENT_ENV} must be absolute`);
  if (!path.isAbsolute(env.BOSS_DB_PATH)) reject('BOSS_DB_PATH must be absolute');

  let root;
  try {
    root = fs.realpathSync(env[ROOT_ENV]);
  } catch {
    reject(`${ROOT_ENV} must name an existing directory`);
  }
  if (!fs.lstatSync(root).isDirectory()) reject(`${ROOT_ENV} must name a directory`);

  let tempParent;
  try {
    tempParent = fs.realpathSync(env[TEMP_PARENT_ENV]);
  } catch {
    reject(`${TEMP_PARENT_ENV} must name an existing directory`);
  }
  if (!fs.lstatSync(tempParent).isDirectory()) reject(`${TEMP_PARENT_ENV} must name a directory`);
  const rootParent = fs.realpathSync(path.dirname(root));
  if (root === tempParent || rootParent !== tempParent) {
    reject(`${ROOT_ENV} must be a newly created direct child of ${TEMP_PARENT_ENV}`);
  }

  const databasePath = path.resolve(env.BOSS_DB_PATH);
  if (!isInside(root, databasePath)) {
    reject(`BOSS_DB_PATH must resolve inside ${ROOT_ENV}`);
  }

  // Reject existing symlink components before SQLite can follow them outside
  // the managed root. Missing components are safe for the fixture creator to
  // create below the already-canonical root.
  const parentRelative = path.relative(root, path.dirname(databasePath));
  let cursor = root;
  for (const part of parentRelative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) break;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(cursor) !== cursor) {
      reject('BOSS_DB_PATH parent must remain inside the canonical fixture root');
    }
  }
  if (fs.existsSync(databasePath) && fs.lstatSync(databasePath).isSymbolicLink()) {
    reject('BOSS_DB_PATH must not be a symbolic link');
  }

  return Object.freeze({ root, databasePath });
}

module.exports = {
  GATE_ENV,
  ROOT_ENV,
  TEMP_PARENT_ENV,
  assertUiFixtureEnvironment,
};
