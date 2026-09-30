'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function defaultTemporaryName(target) {
  return `.${path.basename(target)}.${crypto.randomBytes(16).toString('hex')}.tmp`;
}

function fsyncDirectory(directory, options = {}) {
  const fsImpl = options.fsImpl || fs;
  if (process.platform === 'win32' && options.requireDirectoryFsync !== true) return;
  const directoryFlag = fsImpl.constants.O_DIRECTORY || 0;
  const descriptor = fsImpl.openSync(
    directory,
    fsImpl.constants.O_RDONLY | directoryFlag,
  );
  try {
    fsImpl.fsyncSync(descriptor);
  } finally {
    fsImpl.closeSync(descriptor);
  }
}

function durableAtomicWriteFile(target, data, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const resolved = path.resolve(target);
  const directory = path.dirname(resolved);
  const temporary = path.join(
    directory,
    options.temporaryName || defaultTemporaryName(resolved),
  );
  const mode = options.mode == null ? 0o600 : options.mode;
  const noFollow = fsImpl.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fsImpl.openSync(
      temporary,
      fsImpl.constants.O_WRONLY
        | fsImpl.constants.O_CREAT
        | fsImpl.constants.O_EXCL
        | noFollow,
      mode,
    );
    fsImpl.writeFileSync(descriptor, data, options.encoding || 'utf8');
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.renameSync(temporary, resolved);
    fsyncDirectory(directory, options);
    if (typeof fsImpl.chmodSync === 'function' && process.platform !== 'win32') {
      fsImpl.chmodSync(resolved, mode);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch {}
    }
    try { fsImpl.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
  return resolved;
}

module.exports = {
  defaultTemporaryName,
  durableAtomicWriteFile,
  fsyncDirectory,
};
