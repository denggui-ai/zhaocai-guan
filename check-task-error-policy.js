'use strict';

const assert = require('assert');

const {
  CATEGORIES,
  ERROR_CODES,
  RETRY_DISPOSITIONS,
  resolveTaskErrorPolicy,
} = require('./task-error-policy');

const EXPECTED_KEYS = [
  'category',
  'error_code',
  'hard_stop',
  'message',
  'retry_disposition',
];

function assertFixedShape(value) {
  assert.deepStrictEqual(Object.keys(value).sort(), EXPECTED_KEYS);
  assert.ok(Object.values(ERROR_CODES).includes(value.error_code));
  assert.ok(Object.values(CATEGORIES).includes(value.category));
  assert.ok(Object.values(RETRY_DISPOSITIONS).includes(value.retry_disposition));
  assert.strictEqual(typeof value.hard_stop, 'boolean');
  assert.strictEqual(typeof value.message, 'string');
  assert.ok(value.message.length > 0);
  assert.strictEqual(Object.isFrozen(value), true);
  assert.notStrictEqual(value.retry_disposition, 'auto_retry');
}

function assertHardStop(value, errorCode, category) {
  assertFixedShape(value);
  assert.strictEqual(value.error_code, errorCode);
  assert.strictEqual(value.category, category);
  assert.strictEqual(value.retry_disposition, RETRY_DISPOSITIONS.NO_RETRY);
  assert.strictEqual(value.hard_stop, true);
}

function testBossRiskCodes() {
  const cases = [
    [36, ERROR_CODES.BOSS_RISK_36],
    ['121', ERROR_CODES.BOSS_RISK_121],
    [122, ERROR_CODES.BOSS_RISK_122],
  ];
  for (const [platformCode, errorCode] of cases) {
    const value = resolveTaskErrorPolicy({
      operation_class: 'remote_read',
      platform: 'boss',
      platform_code: platformCode,
    });
    assertHardStop(value, errorCode, CATEGORIES.PLATFORM_RISK);
  }

  assertHardStop(
    resolveTaskErrorPolicy({
      operation_class: 'remote_read',
      platform: 'local',
      platform_code: 36,
    }),
    ERROR_CODES.UNKNOWN,
    CATEGORIES.UNKNOWN,
  );
}

function testMandatoryHardStops() {
  assertHardStop(
    resolveTaskErrorPolicy({
      operation_class: 'local_read',
      platform: 'local',
      error_kind: 'security_check',
    }),
    ERROR_CODES.SECURITY_CHECK,
    CATEGORIES.SECURITY,
  );
  assertHardStop(
    resolveTaskErrorPolicy({
      operation_class: 'local_read',
      platform: 'local',
      error_kind: 'access_restricted',
    }),
    ERROR_CODES.ACCESS_RESTRICTED,
    CATEGORIES.ACCESS,
  );
}

function testWritesNeverRetry() {
  for (const operationClass of ['local_write', 'remote_write']) {
    for (const errorKind of ['timeout', 'temporary_io', 'anything_else']) {
      assertHardStop(
        resolveTaskErrorPolicy({
          operation_class: operationClass,
          platform: 'local',
          error_kind: errorKind,
        }),
        ERROR_CODES.WRITE_FAILED,
        CATEGORIES.WRITE,
      );
    }
  }
}

function testLocalReadManualRetryAllowlist() {
  const timeout = resolveTaskErrorPolicy({
    operation_class: 'local_read',
    platform: 'local',
    error_kind: 'timeout',
  });
  assertFixedShape(timeout);
  assert.strictEqual(timeout.error_code, ERROR_CODES.LOCAL_READ_TIMEOUT);
  assert.strictEqual(timeout.category, CATEGORIES.TEMPORARY_LOCAL_READ);
  assert.strictEqual(timeout.retry_disposition, RETRY_DISPOSITIONS.MANUAL_RETRY_ALLOWED);
  assert.strictEqual(timeout.hard_stop, false);

  const temporaryIo = resolveTaskErrorPolicy({
    operation_class: 'local_read',
    platform: 'local',
    error_kind: 'temporary_io',
  });
  assertFixedShape(temporaryIo);
  assert.strictEqual(temporaryIo.error_code, ERROR_CODES.LOCAL_READ_TEMPORARY_IO);
  assert.strictEqual(temporaryIo.retry_disposition, RETRY_DISPOSITIONS.MANUAL_RETRY_ALLOWED);
  assert.strictEqual(temporaryIo.hard_stop, false);

  for (const denied of [
    { operation_class: 'remote_read', platform: 'local', error_kind: 'timeout' },
    { operation_class: 'local_read', platform: 'boss', error_kind: 'timeout' },
    { operation_class: 'local_read', platform: 'local', error_kind: 'temporary_network' },
  ]) {
    assertHardStop(
      resolveTaskErrorPolicy(denied),
      ERROR_CODES.UNKNOWN,
      CATEGORIES.UNKNOWN,
    );
  }
}

function testUnknownFailsClosed() {
  for (const input of [undefined, null, [], {}, 'failure', {
    operation_class: 'invalid',
    platform: 'unknown',
    error_kind: 'unknown',
  }]) {
    assertHardStop(
      resolveTaskErrorPolicy(input),
      ERROR_CODES.UNKNOWN,
      CATEGORIES.UNKNOWN,
    );
  }
}

function testSensitiveDetailsNeverEcho() {
  const secrets = [
    'CANDIDATE_BODY_SENTINEL',
    'STACK_SENTINEL',
    'https://secret.example/private',
    'TOKEN_SENTINEL',
    '/Users/private/candidate.pdf',
  ];
  const injected = {
    operation_class: 'local_read',
    platform: 'local',
    error_kind: 'timeout',
    message: secrets[0],
    stack: secrets[1],
    url: secrets[2],
    token: secrets[3],
    path: secrets[4],
    body: { text: secrets.join('|') },
  };
  const serialized = JSON.stringify(resolveTaskErrorPolicy(injected));
  for (const secret of secrets) assert.strictEqual(serialized.includes(secret), false);
}

function run() {
  testBossRiskCodes();
  testMandatoryHardStops();
  testWritesNeverRetry();
  testLocalReadManualRetryAllowlist();
  testUnknownFailsClosed();
  testSensitiveDetailsNeverEcho();
  console.log(JSON.stringify({ check: 'task_error_policy', status: 'passed' }));
}

run();
