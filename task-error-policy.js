'use strict';

const ERROR_CODES = Object.freeze({
  BOSS_RISK_36: 'TASK_BOSS_RISK_36',
  BOSS_RISK_121: 'TASK_BOSS_RISK_121',
  BOSS_RISK_122: 'TASK_BOSS_RISK_122',
  SECURITY_CHECK: 'TASK_SECURITY_CHECK',
  ACCESS_RESTRICTED: 'TASK_ACCESS_RESTRICTED',
  WRITE_FAILED: 'TASK_WRITE_FAILED',
  LOCAL_READ_TIMEOUT: 'TASK_LOCAL_READ_TIMEOUT',
  LOCAL_READ_TEMPORARY_IO: 'TASK_LOCAL_READ_TEMPORARY_IO',
  UNKNOWN: 'TASK_UNKNOWN_FAILURE',
});

const CATEGORIES = Object.freeze({
  PLATFORM_RISK: 'platform_risk',
  SECURITY: 'security',
  ACCESS: 'access',
  WRITE: 'write_failure',
  TEMPORARY_LOCAL_READ: 'temporary_local_read',
  UNKNOWN: 'unknown',
});

const RETRY_DISPOSITIONS = Object.freeze({
  NO_RETRY: 'no_retry',
  MANUAL_RETRY_ALLOWED: 'manual_retry_allowed',
});

const BOSS_RISK_CODES = Object.freeze({
  36: ERROR_CODES.BOSS_RISK_36,
  121: ERROR_CODES.BOSS_RISK_121,
  122: ERROR_CODES.BOSS_RISK_122,
});

const WRITE_OPERATIONS = new Set(['local_write', 'remote_write']);

function result(errorCode, category, retryDisposition, hardStop, message) {
  return Object.freeze({
    error_code: errorCode,
    category,
    retry_disposition: retryDisposition,
    hard_stop: hardStop,
    message,
  });
}

function hardStop(errorCode, category, message) {
  return result(
    errorCode,
    category,
    RETRY_DISPOSITIONS.NO_RETRY,
    true,
    message,
  );
}

/**
 * Resolve a fixed, redacted policy from a small allowlist of caller signals.
 *
 * Accepted input fields:
 * - operation_class: local_read | local_write | remote_read | remote_write
 * - platform: boss | local
 * - platform_code: Boss numeric risk-control code
 * - error_kind: security_check | access_restricted | timeout | temporary_io
 *
 * Every other value fails closed. Caller-provided messages and exception details
 * are deliberately ignored and never copied to the returned object.
 */
function resolveTaskErrorPolicy(input) {
  const safeInput = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : Object.create(null);
  const operationClass = typeof safeInput.operation_class === 'string'
    ? safeInput.operation_class
    : '';
  const platform = typeof safeInput.platform === 'string' ? safeInput.platform : '';
  const errorKind = typeof safeInput.error_kind === 'string' ? safeInput.error_kind : '';
  const platformCode = typeof safeInput.platform_code === 'number'
    || typeof safeInput.platform_code === 'string'
    ? String(safeInput.platform_code)
    : '';

  if (platform === 'boss' && Object.hasOwn(BOSS_RISK_CODES, platformCode)) {
    return hardStop(
      BOSS_RISK_CODES[platformCode],
      CATEGORIES.PLATFORM_RISK,
      '平台触发风险控制，任务已停止，请人工核验。',
    );
  }

  if (errorKind === 'security_check') {
    return hardStop(
      ERROR_CODES.SECURITY_CHECK,
      CATEGORIES.SECURITY,
      '任务触发安全验证，已停止，请人工核验。',
    );
  }

  if (errorKind === 'access_restricted') {
    return hardStop(
      ERROR_CODES.ACCESS_RESTRICTED,
      CATEGORIES.ACCESS,
      '当前访问受限，任务已停止，请人工处理。',
    );
  }

  if (WRITE_OPERATIONS.has(operationClass)) {
    return hardStop(
      ERROR_CODES.WRITE_FAILED,
      CATEGORIES.WRITE,
      '写入任务失败，已停止且不会自动重试。',
    );
  }

  if (operationClass === 'local_read' && platform === 'local' && errorKind === 'timeout') {
    return result(
      ERROR_CODES.LOCAL_READ_TIMEOUT,
      CATEGORIES.TEMPORARY_LOCAL_READ,
      RETRY_DISPOSITIONS.MANUAL_RETRY_ALLOWED,
      false,
      '本地读取超时，可在人工确认后重试。',
    );
  }

  if (operationClass === 'local_read' && platform === 'local' && errorKind === 'temporary_io') {
    return result(
      ERROR_CODES.LOCAL_READ_TEMPORARY_IO,
      CATEGORIES.TEMPORARY_LOCAL_READ,
      RETRY_DISPOSITIONS.MANUAL_RETRY_ALLOWED,
      false,
      '本地读取遇到临时 I/O 故障，可在人工确认后重试。',
    );
  }

  return hardStop(
    ERROR_CODES.UNKNOWN,
    CATEGORIES.UNKNOWN,
    '任务因未分类故障停止，请人工核验。',
  );
}

module.exports = {
  CATEGORIES,
  ERROR_CODES,
  RETRY_DISPOSITIONS,
  resolveTaskErrorPolicy,
};
