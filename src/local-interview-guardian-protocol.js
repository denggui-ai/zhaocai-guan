'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { durableAtomicWriteFile } = require('./durable-atomic-file');
const { ensurePrivateDir } = require('./secure-fs');

const GUARDIAN_REGISTRY_SCHEMA = 'hrboss_local_interview_guardian_registry_v1';
const GUARDIAN_CONTROL_SCHEMA = 'hrboss_local_interview_guardian_control_v1';
const GUARDIAN_IPC_SCHEMA = 'hrboss_local_interview_guardian_ipc_v1';
const GUARDIAN_REGISTRY_MAX_BYTES = 8192;
const GUARDIAN_CONTROL_MAX_BYTES = 4096;

function atomicPrivateJsonPath(target) {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomBytes(16).toString('hex')}.tmp`,
  );
}

function writeAtomicPrivateJson(target, value) {
  const resolved = path.resolve(target);
  ensurePrivateDir(path.dirname(resolved));
  return durableAtomicWriteFile(resolved, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
    temporaryName: path.basename(atomicPrivateJsonPath(resolved)),
  });
}

function readPrivateJson(target, maxBytes = GUARDIAN_REGISTRY_MAX_BYTES) {
  const resolved = path.resolve(target);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
    throw new Error('local interview guardian registry is invalid');
  }
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } finally {
    fs.closeSync(descriptor);
  }
}

function validOpaqueId(value, min = 8, max = 200) {
  return typeof value === 'string'
    && value.length >= min
    && value.length <= max
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function validateGuardianRegistry(value, expectedActionInstanceId = '') {
  if (!value
      || value.schema_version !== GUARDIAN_REGISTRY_SCHEMA
      || !validOpaqueId(value.guardian_instance_id, 16)
      || !validOpaqueId(value.action_instance_id, 1)
      || !validOpaqueId(value.job_id, 8)
      || !/^[a-f0-9]{64}$/.test(String(value.control_token || ''))
      || !Number.isSafeInteger(Number(value.guardian_pid))
      || Number(value.guardian_pid) <= 0
      || !Number.isSafeInteger(Number(value.control_port))
      || Number(value.control_port) < 1
      || Number(value.control_port) > 65535) {
    throw new Error('local interview guardian registry cannot be trusted');
  }
  if (expectedActionInstanceId
      && value.action_instance_id !== expectedActionInstanceId) {
    const error = new Error('local interview guardian belongs to another action-server instance');
    error.code = 'GUARDIAN_INSTANCE_MISMATCH';
    throw error;
  }
  return {
    ...value,
    guardian_pid: Number(value.guardian_pid),
    control_port: Number(value.control_port),
  };
}

function readGuardianRegistry(registryPath, options = {}) {
  try {
    return validateGuardianRegistry(
      readPrivateJson(registryPath),
      options.expectedActionInstanceId || '',
    );
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function removeGuardianRegistry(registryPath, guardianInstanceId) {
  let current;
  try {
    current = readGuardianRegistry(registryPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    return false;
  }
  if (!current || current.guardian_instance_id !== guardianInstanceId) return false;
  try {
    fs.rmSync(path.resolve(registryPath), { force: true });
    return true;
  } catch {
    return false;
  }
}

function secureTokenEqual(left, right) {
  const expected = Buffer.from(String(left || ''), 'utf8');
  const actual = Buffer.from(String(right || ''), 'utf8');
  return expected.length === actual.length
    && expected.length > 0
    && crypto.timingSafeEqual(expected, actual);
}

function guardianControlRequest(registry, options = {}) {
  const timeoutMs = Math.max(100, Math.min(10_000, Number(options.timeoutMs) || 1500));
  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = '';
    const socket = net.createConnection({
      host: '127.0.0.1',
      port: registry.control_port,
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({
        schema_version: GUARDIAN_CONTROL_SCHEMA,
        command: 'emergency_stop',
        reason: String(options.reason || 'action_server_unexpected_exit').slice(0, 200),
        action_instance_id: registry.action_instance_id,
        guardian_instance_id: registry.guardian_instance_id,
        job_id: registry.job_id,
        control_token: registry.control_token,
      })}\n`);
    });
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      if (pending.length > GUARDIAN_CONTROL_MAX_BYTES) {
        finish(new Error('local interview guardian response is too large'));
        return;
      }
      const newline = pending.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(pending.slice(0, newline));
        if (response.schema_version !== GUARDIAN_CONTROL_SCHEMA
            || response.guardian_instance_id !== registry.guardian_instance_id
            || response.accepted !== true) {
          throw new Error('local interview guardian rejected the authenticated stop request');
        }
        finish(null, {
          ok: true,
          active: true,
          accepted: true,
          guardian_instance_id: registry.guardian_instance_id,
          job_id: registry.job_id,
        });
      } catch (error) {
        finish(error);
      }
    });
    socket.once('timeout', () => finish(new Error('local interview guardian stop request timed out')));
    socket.once('error', (error) => finish(error));
    socket.once('end', () => {
      if (!settled) finish(new Error('local interview guardian closed without acknowledgement'));
    });
  });
}

async function requestGuardianEmergencyStop(options = {}) {
  const registryPath = path.resolve(options.registryPath || '');
  const waitForRegistryMs = Math.max(0, Math.min(5000, Number(options.waitForRegistryMs) || 0));
  const deadline = Date.now() + waitForRegistryMs;
  let lastError = null;
  do {
    let registry;
    try {
      registry = readGuardianRegistry(registryPath, {
        expectedActionInstanceId: options.expectedActionInstanceId || '',
      });
    } catch (error) {
      if (error && error.code === 'GUARDIAN_INSTANCE_MISMATCH') {
        return { ok: true, active: false, stale: true };
      }
      throw error;
    }
    if (registry) {
      try {
        return await guardianControlRequest(registry, options);
      } catch (error) {
        lastError = error;
      }
    } else if (Date.now() >= deadline) {
      return { ok: true, active: false };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (true);
  if (lastError) throw lastError;
  return { ok: true, active: false };
}

module.exports = {
  GUARDIAN_CONTROL_MAX_BYTES,
  GUARDIAN_CONTROL_SCHEMA,
  GUARDIAN_IPC_SCHEMA,
  GUARDIAN_REGISTRY_SCHEMA,
  atomicPrivateJsonPath,
  readGuardianRegistry,
  removeGuardianRegistry,
  requestGuardianEmergencyStop,
  secureTokenEqual,
  validateGuardianRegistry,
  writeAtomicPrivateJson,
};
