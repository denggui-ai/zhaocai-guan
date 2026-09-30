function normalizedText(value) {
  return String(value || '').trim();
}

export const DEFAULT_LLM_PROVIDER = 'openai-compatible';
export const DEFAULT_LLM_BASE_URL = '';

export function settingsBusinessReturn({
  jobsLoadState = 'ready',
  jobs = [],
  job = null,
  workbenchState = 'ready',
  workbench = null,
} = {}) {
  if (['ready', 'empty'].includes(jobsLoadState) && jobs.length === 0) {
    return {
      label: '返回工作台新建岗位',
      description: '首次开始只需要建立本地岗位；外部 AI 和面试设备都不是前置条件。',
    };
  }
  const preparationCodes = new Set(
    (Array.isArray(workbench?.todos) ? workbench.todos : [])
      .map((item) => item?.code)
      .filter((code) => ['job_jd_required', 'job_profile_confirmation_required'].includes(code)),
  );
  if (job && workbenchState === 'ready' && preparationCodes.size) {
    return {
      label: `返回工作台处理 ${preparationCodes.size} 项岗位准备`,
      description: '先完成启用 JD 和确认岗位画像，再导入候选人；AI 只作为可选加速。',
    };
  }
  return {
    label: '返回工作台继续招聘',
    description: '设置只负责本机可用性和可选能力；招聘下一步仍回到工作台处理。',
  };
}

function canonicalBaseUrl(value) {
  let parsed;
  if (normalizedText(value).length > 2048) return '';
  try { parsed = new URL(normalizedText(value)); } catch {}
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/v1';
  const normalized = parsed.toString().replace(/\/$/, '');
  return normalized.length <= 2048 ? normalized : '';
}

export function hasLlmConnectionChanges(draft = {}, persisted = {}) {
  if (!persisted) return false;
  return normalizedText(draft.provider).toLowerCase() !== normalizedText(persisted.provider).toLowerCase()
    || canonicalBaseUrl(draft.baseUrl) !== canonicalBaseUrl(persisted.baseUrl);
}

export function comparableLlmConfig(config = {}) {
  return {
    provider: normalizedText(config.provider),
    baseUrl: normalizedText(config.baseUrl),
    enabled: config.enabled === true,
    model: normalizedText(config.model),
    timeoutMs: Number(config.timeoutMs) || 120000,
  };
}

export function hasUnsavedLlmChanges(draft, persisted, apiKey = '') {
  if (normalizedText(apiKey)) return true;
  if (!persisted) return false;
  return JSON.stringify(comparableLlmConfig(draft)) !== JSON.stringify(comparableLlmConfig(persisted));
}

export function shouldGuardSettingsExit(hasUnsavedChanges, destinationKind) {
  return hasUnsavedChanges === true && destinationKind === 'outside-settings';
}

export function isLlmConfigurationLocked(readOnly, loadError) {
  return readOnly === true || Boolean(loadError);
}

export function llmConfigLoadRecovery(errorCode = '') {
  if (normalizedText(errorCode) === 'EXTERNAL_AI_CONFIG_UNREADABLE') {
    return {
      retryable: false,
      title: '请重启招才官后再检查',
      description: '本次启动未能安全读取外部 AI 配置，管理员写入已锁定。重启后若仍失败，请联系部署人员；本页重复读取无法恢复。',
    };
  }
  return {
    retryable: true,
    title: '外部 AI 配置状态未知',
    description: '为避免覆盖本机已有配置，当前已禁止编辑和写入。请先重新读取真实配置。',
    action: '重新读取 AI 配置',
  };
}

export function validateLlmConnectionDraft(config = {}, modelOptions = []) {
  const errors = {};
  const provider = normalizedText(config.provider);
  const baseUrl = normalizedText(config.baseUrl);
  const model = normalizedText(config.model);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider)) errors.provider = '服务商标识限 64 个字母、数字、点、短横线或下划线。';
  if (!canonicalBaseUrl(baseUrl)) errors.baseUrl = '请输入有效 HTTPS API 根地址，不可包含用户名、密码、查询参数或片段。';
  if (model.length > 160) errors.model = '模型标识不能超过 160 个字符。';
  else if (model && !modelOptions.some((item) => normalizedText(item?.value) === model && item?.verified === true)) {
    errors.model = '请先点击“测试并使用”，确认该模型兼容招才官。';
  }
  return errors;
}

export function reconcileDraftModelVerification(draft, persisted, modelOptions = []) {
  const next = { ...(draft || {}) };
  const saved = persisted || {};
  const sameConnection = !hasLlmConnectionChanges(next, saved);
  const sameSavedModel = normalizedText(next.model) === normalizedText(saved.model);
  if (sameConnection && sameSavedModel) {
    return { ...next, modelVerified: saved.modelVerified === true };
  }
  const listed = modelOptions.some((item) => (
    normalizedText(item?.value) === normalizedText(next.model) && item?.verified === true
  ));
  return { ...next, modelVerified: sameConnection && listed };
}

export function mergeRefreshedLlmConfig(current, refreshed, modelOptions = []) {
  const next = { ...(current || {}), ...(refreshed || {}) };
  const currentModel = normalizedText(refreshed?.model) || normalizedText(current?.model);
  const modelVerified = modelOptions.some((item) => (
    normalizedText(item?.value) === currentModel && item?.verified === true
  ));
  return {
    ...next,
    model: currentModel,
    modelVerified,
  };
}

export function credentialPersistenceFeedback(result, savesNewCredential) {
  if (result?.credentialPersistence === 'session_only' || result?.credentialPersistenceWarning) {
    return {
      type: 'warning',
      message: savesNewCredential ? '访问密钥只在本次会话生效' : '本次 AI 配置只在当前会话生效',
      description: savesNewCredential
        ? '系统安全存储暂不可用。本次新密钥仅当前会话使用；关闭或重启招才官后，可能恢复保存前的配置或原访问密钥。届时请重新确认当前状态，必要时重新保存；请联系部署人员检查本机安全存储。'
        : '系统安全存储暂不可用。关闭或重启招才官后，本次修改可能恢复为原来的配置；请联系部署人员检查本机安全存储。',
    };
  }
  if (savesNewCredential && result?.credentialPersistence === 'system_encrypted') {
    return {
      type: 'success',
      message: '外部 AI 配置已更新',
      description: '访问密钥已写入本机系统安全存储，页面不会回显。',
    };
  }
  if (savesNewCredential) {
    return {
      type: 'success',
      message: '外部 AI 配置已更新',
      description: '访问密钥不会在页面中回显；请以桌面应用返回的持久化状态为准。',
    };
  }
  return {
    type: 'success',
    message: '外部 AI 配置已保存到本机',
    description: '当前生效状态已更新。',
  };
}

export function localInterviewMicCheckReady(doctor) {
  if (!doctor) return false;
  const capability = doctor.capabilities?.micCheck;
  const discovery = doctor.readiness?.appDiscovery;
  if (capability && Object.prototype.hasOwnProperty.call(capability, 'ready')) {
    return capability.ready === true && discovery?.ready !== false;
  }
  if (discovery && Object.prototype.hasOwnProperty.call(discovery, 'ready')) {
    return discovery.ready === true;
  }
  return doctor.toolchainReady === true || doctor.ready === true;
}

export function localInterviewTranscriptionReady(doctor) {
  if (!doctor) return false;
  const capability = doctor.capabilities?.transcription;
  if (capability && Object.prototype.hasOwnProperty.call(capability, 'ready')) {
    return capability.ready === true;
  }
  return doctor.toolchainReady === true || doctor.ready === true;
}

export function interviewDeviceSummary({ doctor, availableCapabilityCount = 0, micCheck, doctorError = '', micError = '' } = {}) {
  if (doctorError) return { tone: 'warning', value: '软件依赖检查失败', ready: false };
  if (!doctor) return { tone: 'warning', value: '尚未检查', ready: false };
  const micCheckToolchainReady = localInterviewMicCheckReady(doctor);
  if (!micCheckToolchainReady) return { tone: 'warning', value: '录音与转写工具未就绪', ready: false };
  if (micError) return { tone: 'warning', value: '麦克风测试失败', ready: false };
  if (!micCheck) return { tone: 'warning', value: '软件已就绪，麦克风未测试', ready: false };
  const micPassed = micCheck.level == null ? micCheck.passed === true : micCheck.level === 'pass';
  if (micPassed) {
    return { tone: 'success', value: '面试设备可用', ready: true };
  }
  return { tone: 'warning', value: '麦克风需要重新测试', ready: false };
}
