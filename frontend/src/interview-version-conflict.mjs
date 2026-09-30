function clean(value) {
  return value == null ? '' : String(value).trim();
}

export function isInterviewVersionConflict(error) {
  const code = clean(error?.code || error?.data?.code).toUpperCase();
  if (code === 'STALE_VERSION' || code === 'VERSION_CONFLICT') return true;
  const message = clean(error?.message || error?.data?.error);
  return /STALE_VERSION|VERSION_CONFLICT|版本已变化|版本冲突|version\s+(?:is\s+)?(?:stale|changed|conflict)/i.test(message);
}

export function createInterviewVersionConflict(error, options = {}) {
  return {
    status: 'conflict',
    actionKey: clean(options.actionKey),
    hasLocalChanges: options.hasLocalChanges === true,
    message: clean(error?.message || error?.data?.error) || '服务端版本已变化。',
    recoveryError: '',
  };
}

export async function recoverInterviewVersionConflict(conflict, refresh) {
  if (!conflict || typeof refresh !== 'function') {
    throw new Error('版本冲突恢复上下文不可用。');
  }
  const result = await refresh({ afterCurrent: true });
  if (!result || result.status !== 'committed' || result.value?.ok === false) {
    throw new Error(result?.value?.error || '重新读取服务端版本失败，请重试。');
  }
  return {
    ...conflict,
    status: 'recovered',
    recoveryError: '',
  };
}
