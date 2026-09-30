'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PLAN_MARKER = 'HRBOSS_B2_SIGNED_NATIVE_AI_CONFIRMATION_V1';
const MAX_PLAN_AGE_MS = 5 * 60 * 1000;
const ENV_KEYS = Object.freeze({
  marker: 'HRBOSS_B2_NATIVE_CONFIRMATION_MARKER',
  plan: 'HRBOSS_B2_NATIVE_CONFIRMATION_PLAN',
  secret: 'HRBOSS_B2_NATIVE_CONFIRMATION_SECRET',
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hmac(secret, payload) {
  return crypto.createHmac('sha256', secret).update(stableJson(payload), 'utf8').digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function assertPrivate(target, expectedType) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`signed AI confirmation path cannot be a symlink: ${target}`);
  if (expectedType === 'file' && !stat.isFile()) throw new Error(`signed AI confirmation path must be a file: ${target}`);
  if (expectedType === 'directory' && !stat.isDirectory()) throw new Error(`signed AI confirmation path must be a directory: ${target}`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`signed AI confirmation path permissions are unsafe: ${target}`);
  }
}

function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`signed AI confirmation path escapes its private root: ${target}`);
  }
}

function encodePlan(secret, input, nowMs = Date.now()) {
  const payload = {
    marker: PLAN_MARKER,
    issued_at_ms: nowMs,
    expires_at_ms: nowMs + MAX_PLAN_AGE_MS,
    synthetic_root: input.synthetic_root,
    f009_approval_secret: input.f009_approval_secret,
    responses: [0, 1, 0, 1],
  };
  return { payload, signature: hmac(secret, payload) };
}

function loadSignedPlan({ marker, planPath, secret, nowMs = Date.now() }) {
  if (marker !== PLAN_MARKER) throw new Error('signed AI confirmation marker is missing');
  if (Buffer.byteLength(String(secret || ''), 'utf8') < 32) throw new Error('signed AI confirmation secret is invalid');
  const resolvedPlan = path.resolve(String(planPath || ''));
  assertPrivate(resolvedPlan, 'file');
  const envelope = JSON.parse(fs.readFileSync(resolvedPlan, 'utf8'));
  if (!envelope || !envelope.payload || !safeEqual(envelope.signature, hmac(secret, envelope.payload))) {
    throw new Error('signed AI confirmation plan signature is invalid');
  }
  const payload = envelope.payload;
  if (payload.marker !== PLAN_MARKER
    || !Number.isFinite(payload.issued_at_ms)
    || !Number.isFinite(payload.expires_at_ms)
    || payload.expires_at_ms - payload.issued_at_ms !== MAX_PLAN_AGE_MS
    || nowMs < payload.issued_at_ms
    || nowMs > payload.expires_at_ms) {
    throw new Error('signed AI confirmation plan is invalid or expired');
  }
  if (!/^[a-f0-9]{64}$/.test(String(payload.f009_approval_secret || ''))) {
    throw new Error('signed AI confirmation F-009 secret is invalid');
  }
  assert.deepEqual(
    payload.responses,
    [0, 1, 0, 1],
    'signed AI confirmation responses must cancel then approve the generic and interview dialogs',
  );
  const root = fs.realpathSync(path.resolve(String(payload.synthetic_root || '')));
  assertPrivate(root, 'directory');
  assertInside(root, fs.realpathSync(resolvedPlan));
  return {
    root,
    planPath: resolvedPlan,
    f009ApprovalSecret: payload.f009_approval_secret,
    responses: [...payload.responses],
  };
}

function createConfirmationQueue(plan, providerBaseUrl) {
  const providerUrl = new URL(providerBaseUrl);
  assert.equal(providerUrl.protocol, 'https:');
  assert.equal(providerUrl.hostname, '127.0.0.1');
  const responses = [...plan.responses];
  return {
    next(options) {
      if (!responses.length) throw new Error('unexpected extra native AI confirmation');
      assert.equal(options.type, 'warning');
      assert.equal(options.message, '这是一次会产生外部数据传输和潜在费用的操作。');
      assert.deepEqual(options.buttons, ['取消', '确认发送']);
      assert.equal(options.defaultId, 0);
      assert.equal(options.cancelId, 0);
      assert.equal(options.noLink, true);
      if (options.title === '确认发送岗位需求到外部 AI') {
        assert.match(String(options.detail || ''), /Provider：synthetic；模型：gpt-b2-synthetic；发送文本字符数：\d+/);
        assert.match(String(options.detail || ''), /排除项：候选人、简历、测评和面试材料/);
        assert.match(String(options.detail || ''), /—— 实际发送文本开始 ——/);
        assert.match(String(options.detail || ''), /B-2 合成 JD 原生预览/);
        assert.match(String(options.detail || ''), /—— 实际发送文本结束 ——/);
      } else {
        assert.equal(options.title, '确认发送面试材料到外部 AI');
        assert.match(String(options.detail || ''), /面试 \d+；材料 \d+(?:, \d+)*；请求 [A-Za-z0-9_.:-]+；内容 [a-f0-9]{12}…/);
        assert.ok(String(options.detail || '').includes(`Provider synthetic（${providerUrl.host}）；模型 gpt-b2-synthetic`));
      }
      assert.match(String(options.detail || ''), /十分钟内一次有效/);
      return { response: responses.shift(), checkboxChecked: false };
    },
    remaining() {
      return responses.length;
    },
  };
}

module.exports = {
  ENV_KEYS,
  PLAN_MARKER,
  createConfirmationQueue,
  encodePlan,
  loadSignedPlan,
};
