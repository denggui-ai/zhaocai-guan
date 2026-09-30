import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Input, InputNumber, Modal, Select, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import {
  CheckCircleOutlined,
  DatabaseOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  LockOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  StopOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { api, fmtTime, has, READONLY_UI } from '../api.js';
import {
  credentialPersistenceFeedback,
  hasUnsavedLlmChanges,
  hasLlmConnectionChanges,
  interviewDeviceSummary,
  isLlmConfigurationLocked,
  localInterviewMicCheckReady,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_PROVIDER,
  llmConfigLoadRecovery,
  mergeRefreshedLlmConfig,
  reconcileDraftModelVerification,
  settingsBusinessReturn,
  shouldGuardSettingsExit,
  validateLlmConnectionDraft,
} from '../settings-state.mjs';
import appManifest from '../../../package.json';
import frontendManifest from '../../package.json';

const { Text, Title } = Typography;
const APP_VERSION = appManifest.version;
const APP_RUNTIME_STACK = [
  `Electron ${appManifest.devDependencies.electron}`,
  `React ${frontendManifest.dependencies.react}`,
  `Ant Design ${frontendManifest.dependencies.antd}`,
].join(' · ');
const AI_CAPABILITY_LABELS = Object.freeze([
  ['job_jd', 'JD'],
  ['deep_profile', '深度画像'],
  ['candidate_assessment', '候选人初评'],
  ['assessment_analysis', '测评分析'],
  ['interview_review', '面试复盘'],
]);
const SETTINGS_SECTIONS = Object.freeze([
  ['settings-overview', '本机状态'],
  ['settings-integrations', 'AI 与外部连接'],
  ['settings-interview-tools', '面试工具'],
  ['settings-data', '数据与隐私'],
  ['settings-brand', '界面显示'],
  ['settings-advanced', '关于与诊断'],
]);
const SETTINGS_INTERNAL_NAV_ITEMS = new Set(['设置', '关于/版本', '本机状态']);
const NARROW_SETTINGS_QUERY = '(max-width: 760px)';

function normalizeSettingsSection(sectionId) {
  return SETTINGS_SECTIONS.some(([id]) => id === sectionId) ? sectionId : 'settings-overview';
}

function settingsSectionFromHash() {
  if (typeof window === 'undefined') return '';
  const sectionId = String(window.location.hash || '').replace(/^#/, '');
  return SETTINGS_SECTIONS.some(([id]) => id === sectionId) ? sectionId : '';
}

function allowedModelFamily(model) {
  const id = String(model && (model.id || model.model || model.name || model) || '').toLowerCase();
  const family = String(model && model.family || '').toLowerCase();
  if (family === 'gpt' || /(^|[-_/])gpt/.test(id)) return 'GPT';
  if (family === 'claude' || id.includes('claude')) return 'Claude';
  return '';
}

function normalizeModelOptions(models) {
  const options = (Array.isArray(models) ? models : []).flatMap((model) => {
    const id = String(model && (model.id || model.model || model.name || model.value || model) || '').trim();
    if (!id) return [];
    const family = allowedModelFamily(model) || '其他';
    const verified = model?.verified === true;
    return [{
      value: id,
      label: `${model.label || id} · ${model.tier || family}${verified ? ' · 已通过' : ''}`,
      family,
      reason: String(model?.reason || ''),
      recommendation: String(model?.recommendation || ''),
      source: model?.source === 'manual' ? 'manual' : 'provider',
      verified,
    }];
  });
  return options;
}

function groupedModelOptions(models) {
  return models.length ? [{ label: '可选模型（须通过兼容性测试）', options: models }] : [];
}

const MODULES = [
  { name: '工作台', status: '已开放', tone: 'green', note: 'HR 每日招聘运营首页，展示本地派生待办和风险。' },
  { name: '职位管理', status: '已开放', tone: 'green', note: '岗位运营、JD 助手、岗位画像、候选漏斗。' },
  { name: '候选人', status: '已开放', tone: 'green', note: '候选人列表、详情、资料评估和流程动作。' },
  { name: '面试安排', status: '已开放', tone: 'green', note: '跨候选人待约、准备、反馈、复盘和异常兜底。' },
  { name: '人才库', status: '已开放', tone: 'green', note: '历史候选人再发现和再触达草稿。' },
  { name: '设置', status: '已开放', tone: 'green', note: '本地运行、迁移、安全和依赖检查中心。' },
  { name: '流程管理', status: '决策暂缓', tone: 'gold', note: '等待统一候选人 canonical state、状态迁移规则和动作留痕。' },
  { name: '数据分析', status: '决策暂缓', tone: 'gold', note: '等待真实闭环和稳定指标口径，当前只嵌入轻指标。' },
];

const HR_MIGRATION_ITEMS = [
  '候选人资料、录音和转写只在受控设备间加密迁移，不通过聊天工具或公共网盘传递。',
  '对外演示或交付只使用脱敏或演示数据，不复制真实候选人个人信息。',
  '换机后先由部署人员验证本地面试工具状态，再恢复招聘操作。',
];

const ADVANCED_MIGRATION_ITEMS = [
  '退出应用后，按本页实际路径备份完整数据目录；若数据库或面试目录位于数据目录之外，须一并备份。只在受控设备间加密迁移。',
  '对外演示或交付只使用 fixture/demo 数据，不复制真实候选人个人信息。',
  '迁移后先运行 npm install、npm run check、npm run check:ui、npm run build:web。',
  '重新执行本地录音/转写能力检查；只使用当前平台已打包并通过验收的本地能力。',
  '迁移后重新配置本机 AI 访问密钥，不把敏感凭证和内部身份字段带到不受控环境。',
  '运行变量由人工核对和启动命令控制，本设置页不直接修改环境配置文件。',
];

function statusColor(status) {
  if (!status || !status.status) return 'default';
  if (status.status === 'error') return 'red';
  if (['running', 'waiting_login', 'ingesting'].includes(status.status)) return 'blue';
  if (status.status === 'done') return 'green';
  return 'default';
}

function statusText(status) {
  if (!status || !status.status || status.status === 'idle') return '未运行';
  if (status.status === 'running') return '运行中';
  if (status.status === 'waiting_login') return '等待登录';
  if (status.status === 'ingesting') return '导入中';
  if (status.status === 'done') return '完成';
  if (status.status === 'error') return '异常';
  return status.status;
}

function toolLabel(name) {
  const labels = {
    rec: 'rec 录音',
    sox: 'sox 音频处理',
    afconvert: 'afconvert 转码',
    ffmpeg: 'ffmpeg 音视频导入',
    'whisper-cli': 'whisper.cpp 转写',
  };
  return labels[name] || name;
}

function interviewCapabilities(doctor) {
  const tools = doctor?.tools || {};
  const known = !!doctor;
  const degraded = doctor?.status === 'degraded' || doctor?.degraded === true;
  const capability = (label, available, hint) => ({
    label,
    available: known && !degraded && available === true,
    status: !known ? '未检查' : (degraded ? '当前平台不可用' : (available ? '可用' : '未配置')),
    hint: degraded ? (doctor.message || '当前平台尚未提供本地录音与转写能力。') : hint,
  });
  const recReady = tools.rec?.runnable === true;
  const whisperReady = tools['whisper-cli']?.runnable === true && has(doctor?.whisperModel);
  const afconvertReady = tools.afconvert?.runnable === true;
  const ffmpegReady = tools.ffmpeg?.runnable === true;
  const audioImportReady = afconvertReady || ffmpegReady;
  const videoImportReady = afconvertReady || ffmpegReady;
  const videoCapability = capability(
    '视频导入',
    videoImportReady,
    ffmpegReady
      ? 'ffmpeg 可用于提取视频音轨。'
      : (afconvertReady ? '可使用 afconvert；未配置 ffmpeg，部分视频格式可能不可用。' : '未发现可用的视频音轨提取工具。'),
  );
  if (known && !degraded && videoImportReady && !ffmpegReady) videoCapability.status = '有限可用';
  return [
    capability('录音工具', recReady, recReady ? '录音工具已找到；真实麦克风仍需下方 8 秒测试。' : '未发现可用的本地录音工具。'),
    capability('本地转写', whisperReady, whisperReady ? 'whisper.cpp 与本地模型均可用。' : '需要 whisper.cpp 和本地模型文件。'),
    capability('音频导入', audioImportReady, audioImportReady ? '本机具备音频转码能力。' : '未发现可用的音频转码工具。'),
    videoCapability,
  ];
}

function PathRow({ row }) {
  return (
    <div className="settings-path-row">
      <span>{row.label}</span>
      <code>{row.value}</code>
    </div>
  );
}

function StateCard({ icon, label, value, children, tone }) {
  return (
    <section className={`settings-state-card ${tone || ''}`}>
      <span>{icon}</span>
      <div>
        <strong>{value}</strong>
        <em>{label}</em>
        {children}
      </div>
    </section>
  );
}

export default function SettingsPanel({
  jobs = [],
  job,
  candidates = [],
  jobsLoadState = 'ready',
  jobsLoadError = '',
  workbench = null,
  workbenchState = 'ready',
  workbenchError = '',
  readOnly,
  screenshotImportProgress,
  brandMark,
  brandName,
  defaultBrandMark = '招',
  defaultBrandName = '招才官',
  onBrandMarkChange,
  onBrandNameChange,
  onOpenNav,
  onSectionChange,
  onDirtyChange,
  returnNav = '工作台',
  aiReturnContext = null,
  onReturnToAiOperation,
}) {
  const [localPaths, setLocalPaths] = useState(null);
  const [localPathsError, setLocalPathsError] = useState('');
  const [localPathsLoadAttempt, setLocalPathsLoadAttempt] = useState(0);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [doctor, setDoctor] = useState(null);
  const [doctorError, setDoctorError] = useState('');
  const [micCheckLoading, setMicCheckLoading] = useState(false);
  const [micCheckAbortLoading, setMicCheckAbortLoading] = useState(false);
  const [micCheckJob, setMicCheckJob] = useState(null);
  const [micCheckError, setMicCheckError] = useState('');
  const [micCheckNotice, setMicCheckNotice] = useState('');
  const [micCheckConsent, setMicCheckConsent] = useState(false);
  const micCheckActiveRef = useRef(true);
  const micCheckRunIdRef = useRef('');
  const [llmConfig, setLlmConfig] = useState({
    provider: DEFAULT_LLM_PROVIDER,
    baseUrl: DEFAULT_LLM_BASE_URL,
    enabled: false,
    apiKeyConfigured: false,
    model: '',
    timeoutMs: 120000,
  });
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmModels, setLlmModels] = useState([]);
  const [llmManualModelMode, setLlmManualModelMode] = useState(false);
  const [llmBusy, setLlmBusy] = useState('');
  const llmBusyRef = useRef(false);
  const llmPersistedConfigRef = useRef(null);
  const [llmLoadError, setLlmLoadError] = useState('');
  const [llmLoadErrorCode, setLlmLoadErrorCode] = useState('');
  const [llmLoadAttempt, setLlmLoadAttempt] = useState(0);
  const [llmOperationError, setLlmOperationError] = useState(null);
  const [llmNotice, setLlmNotice] = useState(null);
  const [llmAdminOpen, setLlmAdminOpen] = useState(false);
  const [llmClearConfirmOpen, setLlmClearConfirmOpen] = useState(false);
  const [activeSection, setActiveSection] = useState(() => normalizeSettingsSection(settingsSectionFromHash()));
  const [compactSectionNav, setCompactSectionNav] = useState(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(NARROW_SETTINGS_QUERY).matches
  ));
  const previousActiveSectionRef = useRef(activeSection);
  const [sectionAnnouncement, setSectionAnnouncement] = useState('');
  const [pendingSection, setPendingSection] = useState('');
  const pendingNavigationTriggerRef = useRef(null);
  const committedBrandMark = String(brandMark || defaultBrandMark).trim();
  const committedBrandName = String(brandName || defaultBrandName).trim();
  const [brandMarkDraft, setBrandMarkDraft] = useState(committedBrandMark);
  const [brandNameDraft, setBrandNameDraft] = useState(committedBrandName);
  const [brandValidationError, setBrandValidationError] = useState('');
  const [brandFeedback, setBrandFeedback] = useState(readOnly
    ? '修改后点击应用；操作只读模式下仅在本次会话生效。'
    : '修改后点击保存，才会写入本机界面偏好。');
  const brandDraftDirty = brandMarkDraft !== committedBrandMark
    || brandNameDraft !== committedBrandName;

  useEffect(() => {
    setBrandMarkDraft(committedBrandMark);
    setBrandNameDraft(committedBrandName);
    setBrandValidationError('');
  }, [committedBrandMark, committedBrandName]);

  useEffect(() => {
    const syncHash = () => {
      const nextSection = settingsSectionFromHash();
      if (!nextSection) return;
      setActiveSection(nextSection);
      onSectionChange?.(nextSection);
    };
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, [onSectionChange]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(NARROW_SETTINGS_QUERY);
    const syncNavigationMode = () => setCompactSectionNav(query.matches);
    syncNavigationMode();
    query.addEventListener('change', syncNavigationMode);
    return () => query.removeEventListener('change', syncNavigationMode);
  }, []);

  useEffect(() => {
    document.querySelector('.detail-content')?.scrollTo({ top: 0, behavior: 'auto' });
    onSectionChange?.(activeSection);
    const sectionChanged = previousActiveSectionRef.current !== activeSection;
    previousActiveSectionRef.current = activeSection;
    const sectionLabel = SETTINGS_SECTIONS.find(([sectionId]) => sectionId === activeSection)?.[1] || '设置';
    if (sectionChanged) setSectionAnnouncement(`已进入${sectionLabel}设置分区`);
    const focusTimer = globalThis.requestAnimationFrame(() => {
      document.getElementById(`${activeSection}-title`)?.focus({ preventScroll: true });
    });
    return () => globalThis.cancelAnimationFrame(focusTimer);
  }, [activeSection, onSectionChange]);

  useEffect(() => {
    let active = true;
    setLocalPaths(null);
    setLocalPathsError('');
    api.getLocalPaths()
      .then((paths) => { if (active) setLocalPaths(paths); })
      .catch((err) => { if (active) setLocalPathsError(err.message || '本机目录信息不可读'); });
    return () => { active = false; };
  }, [localPathsLoadAttempt]);

  useEffect(() => {
    let active = true;
    setLlmBusy('load');
    setLlmLoadError('');
    setLlmLoadErrorCode('');
    setLlmOperationError(null);
    setLlmNotice(null);
    api.getLlmConfig()
      .then((result) => {
        if (!active) return;
        setLlmLoadErrorCode('');
        const loadedModels = normalizeModelOptions(result.config?.availableModels);
        setLlmModels(loadedModels);
        setLlmConfig((current) => {
          const nextConfig = { ...current, ...(result.config || {}) };
          llmPersistedConfigRef.current = nextConfig;
          return nextConfig;
        });
      })
      .catch((err) => {
        if (active) {
          llmPersistedConfigRef.current = null;
          setLlmLoadError(err.message || 'AI 配置状态不可读');
          setLlmLoadErrorCode(err.code || '');
        }
      })
      .finally(() => {
        if (active) setLlmBusy('');
      });
    return () => { active = false; };
  }, [readOnly, llmLoadAttempt]);

  useEffect(() => () => {
    micCheckActiveRef.current = false;
  }, []);

  const progressRows = [
    ['截图导入', screenshotImportProgress],
  ];
  const localPathRows = localPaths ? [
    { label: '本次运行数据目录', value: localPaths.dataDir },
    { label: '本地数据库文件', value: localPaths.databasePath },
    { label: '面试录音与转写产物', value: localPaths.interviewDir },
    { label: '截图导入材料', value: localPaths.screenshotDir },
  ] : [];

  async function runDoctor() {
    if (READONLY_UI) {
      setDoctor(null);
      setDoctorError('操作只读模式不启动本机依赖检查。');
      return;
    }
    micCheckRunIdRef.current = '';
    setMicCheckJob(null);
    setMicCheckError('');
    setMicCheckNotice('');
    setDoctorLoading(true);
    setDoctorError('');
    try {
      const result = await api.localInterviewDoctor();
      setDoctor(result.doctor || null);
    } catch (err) {
      setDoctor(null);
      setDoctorError(err.message || '依赖检查失败');
    } finally {
      setDoctorLoading(false);
    }
  }

  async function runMicCheck() {
    if (micCheckLoading) return;
    const requestNonce = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const clientRequestId = `settings-mic-check:${requestNonce}`;
    let startupSettled = false;
    setMicCheckLoading(true);
    setMicCheckError('');
    setMicCheckNotice('');
    setMicCheckJob(null);
    micCheckRunIdRef.current = '';
    const discoverStartingTask = (async () => {
      for (let attempt = 0; micCheckActiveRef.current && !startupSettled && attempt < 80; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 125));
        try {
          const progressJob = (await api.localInterviewProgress()).job || null;
          if (
            progressJob
            && progressJob.mode === 'mic-check'
            && progressJob.client_request_id === clientRequestId
            && ['starting', 'running'].includes(progressJob.status)
          ) {
            micCheckRunIdRef.current = String(progressJob.id || '');
            setMicCheckJob(progressJob);
          }
        } catch {
          // The start request remains authoritative; transient discovery
          // failures must not turn into a second unscoped task operation.
        }
      }
    })();
    try {
      const started = await api.localInterviewMicCheck(
        'HRBOSS-mic-check',
        8,
        null,
        null,
        micCheckConsent,
        null,
        clientRequestId,
      );
      startupSettled = true;
      await discoverStartingTask;
      let nextJob = started.job || null;
      micCheckRunIdRef.current = String(nextJob?.id || '');
      setMicCheckJob(nextJob);
      for (let attempt = 0; micCheckActiveRef.current && ['starting', 'running'].includes(nextJob?.status) && attempt < 60; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        const progress = await api.localInterviewProgress();
        nextJob = progress.job || null;
        if (micCheckRunIdRef.current && String(nextJob?.id || '') !== micCheckRunIdRef.current) {
          throw new Error('麦克风测试任务已被其他本地任务替换，请重新开始测试。');
        }
        setMicCheckJob(nextJob);
      }
      if (['starting', 'running'].includes(nextJob?.status)) {
        setMicCheckNotice('麦克风测试仍在本地处理中；当前不是失败状态，请等待任务完成后再重新测试。');
      } else if (nextJob?.status === 'error') {
        setMicCheckError(nextJob.error || nextJob.message || '麦克风测试未通过');
      }
    } catch (err) {
      startupSettled = true;
      await discoverStartingTask;
      setMicCheckError(err.message || '麦克风测试失败');
    } finally {
      if (micCheckActiveRef.current) setMicCheckLoading(false);
    }
  }

  async function abortMicCheck() {
    const taskId = String(micCheckJob?.id || micCheckRunIdRef.current || '');
    if (!taskId || micCheckAbortLoading) return;
    setMicCheckAbortLoading(true);
    setMicCheckError('');
    setMicCheckNotice('已发起安全停止；正在确认进程结束并删除本次测试材料。');
    try {
      const response = await api.abortLocalInterviewTask(taskId, micCheckJob?.bind_job_id || null);
      if (response?.job) setMicCheckJob(response.job);
      const progress = await api.localInterviewProgress();
      if (String(progress?.job?.id || '') === taskId) setMicCheckJob(progress.job);
    } catch (err) {
      if (err?.data?.job) setMicCheckJob(err.data.job);
      setMicCheckError(err.message || '麦克风测试停止未确认');
    } finally {
      setMicCheckAbortLoading(false);
    }
  }

  async function resumeMicCheckPolling() {
    if (micCheckLoading || !micCheckRunIdRef.current) return;
    setMicCheckLoading(true);
    setMicCheckError('');
    setMicCheckNotice('');
    try {
      let nextJob = (await api.localInterviewProgress()).job || null;
      if (String(nextJob?.id || '') !== micCheckRunIdRef.current) {
        throw new Error('原麦克风测试已被其他本地任务替换，请重新开始测试。');
      }
      setMicCheckJob(nextJob);
      for (let attempt = 0; micCheckActiveRef.current && ['starting', 'running'].includes(nextJob?.status) && attempt < 60; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        nextJob = (await api.localInterviewProgress()).job || null;
        if (String(nextJob?.id || '') !== micCheckRunIdRef.current) {
          throw new Error('原麦克风测试已被其他本地任务替换，请重新开始测试。');
        }
        setMicCheckJob(nextJob);
      }
      if (['starting', 'running'].includes(nextJob?.status)) {
        setMicCheckNotice('麦克风测试仍在本地处理中；当前不是失败状态，可稍后继续读取结果。');
      } else if (nextJob?.status === 'error') {
        setMicCheckError(nextJob.error || nextJob.message || '麦克风测试未通过');
      }
    } catch (err) {
      setMicCheckJob(null);
      setMicCheckError(err.message || '麦克风测试状态读取失败');
    } finally {
      if (micCheckActiveRef.current) setMicCheckLoading(false);
    }
  }

  async function saveLlmSettings(forceEnabled = false) {
    if (llmBusyRef.current || llmLoadError) return;
    const savesNewCredential = !!llmApiKey.trim();
    const validationErrors = validateLlmConnectionDraft(
      savesNewCredential ? { ...llmConfig, model: '' } : llmConfig,
      llmModels,
    );
    if (Object.keys(validationErrors).length > 0) {
      setLlmAdminOpen(true);
      setLlmNotice(null);
      setLlmOperationError({ title: '请先完善 AI 配置', message: Object.values(validationErrors)[0] });
      return;
    }
    llmBusyRef.current = true;
    setLlmBusy('save');
    setLlmOperationError(null);
    setLlmNotice(null);
    try {
      const payload = {
        provider: String(llmConfig.provider || '').trim(),
        baseUrl: String(llmConfig.baseUrl || '').trim(),
        enabled: forceEnabled === true ? true : llmConfig.enabled === true,
        timeoutMs: Number(llmConfig.timeoutMs) || 120000,
        model: savesNewCredential ? '' : String(llmConfig.model || '').trim(),
      };
      const result = llmApiKey.trim()
        ? await api.saveLlmCredential({ ...payload, apiKey: llmApiKey.trim() })
        : await api.saveLlmConfig(payload);
      setLlmApiKey('');
      const nextConfig = { ...llmConfig, ...(result.config || {}) };
      setLlmModels(normalizeModelOptions(result.config?.availableModels));
      llmPersistedConfigRef.current = nextConfig;
      setLlmConfig(nextConfig);
      setLlmLoadError('');
      const feedback = credentialPersistenceFeedback(result, savesNewCredential);
      setLlmNotice(forceEnabled === true && feedback.type === 'success'
        ? {
          ...feedback,
          message: '外部 AI 已启用',
          description: `${feedback.description} 实际发送候选人材料前仍会逐次请 HR 确认。`,
        }
        : feedback);
    } catch (err) {
      setLlmOperationError({ title: 'AI 配置保存失败', message: err.message || '保存操作未完成，请重试。' });
    } finally {
      llmBusyRef.current = false;
      setLlmBusy('');
    }
  }

  async function refreshLlmModels() {
    if (llmBusyRef.current || llmLoadError) return;
    if (hasUnsavedLlmChanges(llmConfig, llmPersistedConfigRef.current, llmApiKey)) {
      setLlmOperationError({ title: '请先处理未保存修改', message: '请先保存服务、密钥和其他设置；模型草稿请先测试，完成后再刷新列表。' });
      return;
    }
    llmBusyRef.current = true;
    setLlmBusy('models');
    setLlmOperationError(null);
    setLlmNotice(null);
    try {
      const result = await api.refreshLlmModels();
      const nextModels = normalizeModelOptions(result.models);
      setLlmModels(nextModels);
      const persistedConfig = { ...(result.config || {}) };
      const refreshedConfig = mergeRefreshedLlmConfig({}, persistedConfig, nextModels);
      llmPersistedConfigRef.current = persistedConfig;
      setLlmConfig(refreshedConfig);
      setLlmLoadError('');
      if (result.credentialPersistence === 'session_only' || result.credentialPersistenceWarning) {
        const persistenceFeedback = credentialPersistenceFeedback(result, false);
        setLlmNotice({
          ...persistenceFeedback,
          description: `${persistenceFeedback.description} 本次已读取 ${nextModels.length} 个可选模型，仍需逐个测试。`,
        });
      } else if (nextModels.length === 0) {
        setLlmNotice({
          type: 'warning',
          message: '没有读取到可选模型',
          description: '服务没有返回可选模型。可手动输入模型 ID 后测试；不会发送候选人材料。',
        });
      } else if (!refreshedConfig.modelVerified && refreshedConfig.model) {
        setLlmNotice({
          type: 'warning',
          message: '当前模型不在可用列表中',
          description: `已保留 ${refreshedConfig.model}，但它尚未验证。请从读取到的模型列表中选择一项并保存。`,
        });
      } else {
        setLlmNotice({
          type: 'success',
          message: `已读取 ${nextModels.length} 个可选模型`,
          description: '列表只代表网关返回，不代表模型已兼容或已被推荐；选择后还需点击“测试并使用”。',
        });
      }
    } catch (err) {
      setLlmOperationError({ title: '模型列表刷新失败', message: err.message || '未能读取模型列表，请重试。' });
    } finally {
      llmBusyRef.current = false;
      setLlmBusy('');
    }
  }

  async function testLlmModel() {
    if (llmBusyRef.current || llmLoadError) return;
    const model = String(llmConfig.model || '').trim();
    if (!model) {
      setLlmOperationError({ title: '请选择或输入模型', message: '模型 ID 不能为空。' });
      return;
    }
    if (llmApiKey.trim() || hasLlmConnectionChanges(llmConfig, llmPersistedConfigRef.current)) {
      setLlmOperationError({ title: '请先保存服务与访问密钥', message: '更换服务或密钥会使原模型验证失效；保存后再测试模型。' });
      return;
    }
    llmBusyRef.current = true;
    setLlmBusy('test');
    setLlmOperationError(null);
    setLlmNotice(null);
    try {
      const draftEnabled = llmConfig.enabled === true;
      const draftTimeoutMs = llmConfig.timeoutMs;
      const result = await api.testLlmModel(model);
      const nextModels = normalizeModelOptions(result.config?.availableModels);
      const persistedConfig = { ...(result.config || {}) };
      llmPersistedConfigRef.current = persistedConfig;
      setLlmModels(nextModels);
      setLlmConfig({ ...persistedConfig, enabled: draftEnabled, timeoutMs: draftTimeoutMs });
      setLlmManualModelMode(result.model?.source === 'manual');
      const persistenceFeedback = credentialPersistenceFeedback(result, false);
      const testDescription = '已通过当前网关的 Chat Completions、严格 JSON 和返回型号一致性测试；测试仅发送合成文本，不含候选人材料。';
      setLlmNotice({
        type: persistenceFeedback.type,
        message: `模型测试通过：${model}`,
        description: persistenceFeedback.type === 'warning'
          ? `${persistenceFeedback.message}。${persistenceFeedback.description} ${testDescription}`
          : testDescription,
      });
    } catch (err) {
      setLlmOperationError({
        title: '模型兼容性测试未通过',
        message: `${err.message || '该模型不能用于招才官当前分析通道。'} 未保存或启用该模型。`,
      });
    } finally {
      llmBusyRef.current = false;
      setLlmBusy('');
    }
  }

  async function clearLlmCredential() {
    if (llmBusyRef.current || llmLoadError) return false;
    llmBusyRef.current = true;
    setLlmBusy('clear');
    setLlmOperationError(null);
    setLlmNotice(null);
    try {
      const persistedConfig = llmPersistedConfigRef.current || llmConfig;
      const result = await api.saveLlmConfig({
        provider: persistedConfig.provider,
        baseUrl: persistedConfig.baseUrl,
        enabled: false,
        clearApiKey: true,
        timeoutMs: Number(persistedConfig.timeoutMs) || 120000,
        model: '',
      });
      setLlmApiKey('');
      setLlmModels([]);
      const nextConfig = {
        ...llmConfig,
        ...persistedConfig,
        ...(result.config || {}),
        enabled: false,
        apiKeyConfigured: false,
      };
      llmPersistedConfigRef.current = nextConfig;
      setLlmConfig(nextConfig);
      setLlmLoadError('');
      if (result.credentialPersistence === 'session_only' || result.credentialPersistenceWarning) {
        setLlmNotice({
          type: 'warning',
          message: '外部 AI 仅在本次会话关闭',
          description: '系统安全存储未能确认清除。重启后原访问密钥可能恢复，请联系部署人员检查并再次清除。',
        });
      } else {
        setLlmNotice({ type: 'success', message: '本机 API Key 已清除', description: '外部 AI 已关闭；再次使用需要重新配置。' });
      }
      return true;
    } catch (err) {
      setLlmOperationError({ title: '清除 AI 凭据失败', message: err.message || '清除操作未完成，请重试。' });
      return false;
    } finally {
      llmBusyRef.current = false;
      setLlmBusy('');
    }
  }

  function updateLlmConnection(field, value) {
    beginLlmDraftEdit();
    setLlmApiKey('');
    setLlmModels([]);
    setLlmConfig((current) => ({
      ...current, [field]: value, enabled: false, apiKeyConfigured: false,
      model: '', modelVerified: false, operational: false, capabilities: {},
    }));
  }

  function beginLlmDraftEdit() {
    setLlmNotice(null);
    setLlmOperationError(null);
  }

  const doctorTools = doctor?.tools || {};
  const doctorToolRows = Object.entries(doctorTools);
  const doctorDegraded = doctor?.status === 'degraded' || doctor?.degraded === true;
  const doctorMicCheckReady = localInterviewMicCheckReady(doctor);
  const capabilityRows = useMemo(() => interviewCapabilities(doctor), [doctor]);
  const availableCapabilityCount = capabilityRows.filter((item) => item.available).length;
  const limitedCapabilityCount = capabilityRows.filter((item) => item.status === '有限可用').length;
  const fullCapabilityCount = availableCapabilityCount - limitedCapabilityCount;
  const micCheck = micCheckJob?.status === 'done'
    && micCheckJob?.mode === 'mic-check'
    && String(micCheckJob?.id || '') === micCheckRunIdRef.current
    ? micCheckJob?.result?.micCheck || null
    : null;
  const micCheckInProgress = ['starting', 'running'].includes(micCheckJob?.status);
  const deviceSummary = interviewDeviceSummary({
    doctor,
    availableCapabilityCount,
    micCheck,
    doctorError,
    micError: micCheckError,
  });
  const deviceDisplay = !doctor && !doctorError
    ? {
      tone: 'neutral',
      value: '使用本地录音/转写前检查',
      description: '按需检查，不是首次开工待办；不会自动申请麦克风权限或开始录音。',
    }
    : {
      ...deviceSummary,
      description: doctorError
        ? '本机能力状态未知；本地建岗、导入和人工招聘流程仍可继续。'
        : (deviceSummary.ready
          ? '软件依赖和麦克风实测均已通过。'
          : '软件依赖检查与麦克风实测分开显示，不会自动录音。'),
    };
  const llmConnectionHasUnsavedChanges = hasLlmConnectionChanges(llmConfig, llmPersistedConfigRef.current);
  const llmHasUnsavedChanges = hasUnsavedLlmChanges(llmConfig, llmPersistedConfigRef.current, llmApiKey);
  const llmModelGroups = groupedModelOptions(llmModels);
  const selectedLlmModel = llmModels.find((item) => item.value === String(llmConfig.model || '').trim()) || null;
  const settingsHasUnsavedChanges = llmHasUnsavedChanges || brandDraftDirty;
  const llmConfigurationLocked = isLlmConfigurationLocked(readOnly, llmLoadError);
  const llmFieldErrors = validateLlmConnectionDraft(llmConfig, llmModels);
  const llmFormValid = Object.keys(llmFieldErrors).length === 0;
  const llmEnableUnavailable = llmConfig.enabled !== true && llmConfig.modelVerified !== true;
  const llmLoadRecovery = llmConfigLoadRecovery(llmLoadErrorCode);
  const llmOperational = llmConfig.operational === true
    && llmConfig.enabled === true
    && llmConfig.apiKeyConfigured === true
    && llmConfig.modelVerified === true
    && !llmHasUnsavedChanges;
  const hasAiReturnContext = Boolean(aiReturnContext?.id && aiReturnContext?.capability);
  const llmCapabilityCount = AI_CAPABILITY_LABELS.filter(([key]) => llmConfig.capabilities?.[key] === true).length;
  const llmSummary = (() => {
    if (llmBusy === 'load') return { tone: 'blue', text: '正在读取外部 AI 状态。' };
    if (llmLoadError) return { tone: 'warning', text: '外部 AI 状态读取失败，当前状态未知。' };
    if (llmHasUnsavedChanges) return { tone: 'blue', text: '外部 AI 有未保存修改，当前生效状态没有改变。' };
    if (llmConfig.enabled !== true) return { tone: 'success', text: '外部 AI 未启用，数据不会发送给外部模型。' };
    if (llmOperational) return { tone: 'success', text: `AI 可用：同一配置已驱动 ${llmCapabilityCount}/5 项能力。` };
    return { tone: 'warning', text: '外部 AI 已开启但配置未完成，当前不可调用。' };
  })();
  const llmNextStep = (() => {
    if (llmBusy === 'load') return { state: 'loading', title: '正在读取 AI 配置', description: '读取完成后会显示唯一的下一步操作。' };
    if (llmLoadError) {
      return {
        state: llmLoadRecovery.retryable ? 'load-error' : 'startup-fault',
        title: llmLoadRecovery.title,
        description: llmLoadRecovery.description,
        ...(llmLoadRecovery.action ? { action: llmLoadRecovery.action } : {}),
      };
    }
    if (readOnly) {
      return {
        state: 'readonly',
        title: '只读查看外部 AI 状态',
        description: llmConfig.enabled === true
          ? `当前已保存配置：${llmConfig.model || '模型待确认'}；本次只读取状态，不允许保存、验证模型或发送候选人材料。`
          : '外部 AI 当前未启用；核心招聘流程不受影响，本次只读模式不会修改配置或发送材料。',
      };
    }
    if (llmHasUnsavedChanges) {
      if (!llmFormValid) {
        return {
          state: 'invalid',
          title: '请完善外部 AI 配置',
          description: Object.values(llmFieldErrors)[0],
          action: '检查高级设置',
        };
      }
      return {
        state: 'save',
        title: '保存外部 AI 修改',
        description: '服务、访问密钥、模型或启用状态有待保存修改；保存前不会改变当前生效状态。',
        action: '保存修改',
      };
    }
    if (!llmConfig.apiKeyConfigured) {
      return { state: 'credential', title: '填写外部 AI 访问密钥', description: '桌面应用会优先写入系统安全存储；若不可用则仅在本次会话生效并明确警告，页面不会回显。', action: '打开高级设置' };
    }
    if (llmModels.length > 0 && !llmConfig.modelVerified) {
      return {
        state: 'select-model',
        title: '选择并测试模型',
        description: '模型列表已读取，但尚未证明兼容。请在高级设置中选择模型并点击“测试并使用”。',
        action: '打开高级设置',
      };
    }
    if (!llmConfig.modelVerified) {
      return {
        state: 'models',
        title: '刷新可用模型',
        description: '访问密钥已配置。只从已保存服务读取模型列表，不发送候选人材料，也不要求先启用 AI；列表结果仍需单独测试。',
        action: '刷新可用模型',
      };
    }
    if (!llmConfig.enabled) {
      return {
        state: 'enable',
        title: '启用人工 AI 分析',
        description: `模型 ${llmConfig.model || ''} 已验证；启用后，每次发送候选人材料仍需 HR 单独确认。`,
        action: '保存并启用',
      };
    }
    if (!llmOperational) {
      return {
        state: 'invalid',
        title: 'AI 配置尚未完全生效',
        description: '已启用，但本机尚未确认全部分析能力可用。请检查高级设置并重新测试模型。',
        action: '检查高级设置',
      };
    }
    return {
      state: 'ready',
      title: 'AI 分析已可用',
      description: `当前模型：${llmConfig.model}。JD、深度画像、候选人初评、测评分析和面试复盘均可发起。`,
      action: hasAiReturnContext ? '返回刚才的 AI 操作' : '返回工作台',
    };
  })();

  const llmStatus = (() => {
    if (llmLoadError) return { color: 'red', text: '读取失败' };
    if (llmHasUnsavedChanges) return { color: 'blue', text: '有待保存修改' };
    if (llmOperational) return { color: 'green', text: '可使用' };
    if (llmConfig.enabled) return { color: 'gold', text: '配置未完成' };
    return { color: 'default', text: '未启用（默认）' };
  })();
  const coreStateError = jobsLoadState === 'error'
    || (Boolean(job) && workbenchState === 'error');
  const coreStateLoading = jobsLoadState === 'loading'
    || (Boolean(job) && ['idle', 'loading'].includes(workbenchState));
  const overviewOverall = coreStateError
    ? {
      type: 'error',
      title: '本地招聘状态读取失败',
      description: `${jobsLoadState === 'error' ? jobsLoadError : workbenchError || '关键本地数据暂不可读。'} 外部 AI 和面试设备状态不会改变这项判断。`,
    }
    : coreStateLoading
      ? {
        type: 'info',
        title: '正在确认本地招聘状态',
        description: '正在读取本地岗位和工作台数据；完成前不会把外部连接状态当作本地故障。',
      }
      : {
        type: 'success',
        title: '本地招聘可用',
        description: '当前可以建立岗位、完善 JD、导入候选人并继续本地流程。',
      };
  const businessReturn = settingsBusinessReturn({
    jobsLoadState,
    jobs,
    job,
    workbenchState,
    workbench,
  });
  const overviewAiNeedsConfiguration = !readOnly && (
    llmHasUnsavedChanges
    || !llmConfig.apiKeyConfigured
    || (llmConfig.enabled === true && !llmOperational)
  );
  const returnDestination = returnNav && returnNav !== '设置' ? returnNav : '工作台';
  const returnActionLabel = `返回${returnDestination}`;

  useEffect(() => {
    if (!shouldGuardSettingsExit(settingsHasUnsavedChanges, 'outside-settings')) return undefined;

    const guardMainNavigation = (event) => {
      const button = event.target?.closest?.('.nav-primary .nav-item, .nav-utility [data-nav-target]');
      if (!button) return;
      const nextNav = String(button.getAttribute('data-nav-target') || button.textContent || '').trim();
      if (!nextNav || SETTINGS_INTERNAL_NAV_ITEMS.has(nextNav)) return;
      event.preventDefault();
      event.stopPropagation();
      pendingNavigationTriggerRef.current = button;
      setPendingSection(`nav:${nextNav}`);
    };
    const guardMobileNavigation = (event) => {
      const select = event.target?.closest?.('.mobile-module-field select');
      if (!select || select.value === '设置') return;
      const nextNav = select.value;
      if (SETTINGS_INTERNAL_NAV_ITEMS.has(nextNav)) return;
      event.preventDefault();
      event.stopPropagation();
      select.value = '设置';
      pendingNavigationTriggerRef.current = select;
      setPendingSection(`nav:${nextNav}`);
    };
    const guardWindowClose = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };

    document.addEventListener('click', guardMainNavigation, true);
    document.addEventListener('change', guardMobileNavigation, true);
    window.addEventListener('beforeunload', guardWindowClose);
    return () => {
      document.removeEventListener('click', guardMainNavigation, true);
      document.removeEventListener('change', guardMobileNavigation, true);
      window.removeEventListener('beforeunload', guardWindowClose);
    };
  }, [settingsHasUnsavedChanges]);

  useLayoutEffect(() => {
    onDirtyChange?.(settingsHasUnsavedChanges === true);
    const syncExternalAiDirty = window.settingsState?.setExternalAiDirty;
    if (typeof syncExternalAiDirty === 'function') {
      syncExternalAiDirty(settingsHasUnsavedChanges === true);
    }
    return () => {
      onDirtyChange?.(false);
      if (typeof syncExternalAiDirty === 'function') syncExternalAiDirty(false);
    };
  }, [onDirtyChange, settingsHasUnsavedChanges]);

  function activateSection(sectionId) {
    const nextSection = normalizeSettingsSection(sectionId);
    setPendingSection('');
    setLlmClearConfirmOpen(false);
    setActiveSection(nextSection);
    onSectionChange?.(nextSection);
    window.history.replaceState(window.history.state, '', `#${nextSection}`);
    const focusSectionHeading = () => {
      document.getElementById(`${nextSection}-title`)?.focus({ preventScroll: true });
    };
    globalThis.requestAnimationFrame(focusSectionHeading);
    globalThis.setTimeout(focusSectionHeading, 120);
  }

  function saveBrandDisplay() {
    const nextMark = String(brandMarkDraft || '').trim();
    const nextName = String(brandNameDraft || '').trim();
    if (!nextMark || !nextName) {
      setBrandValidationError('工作区字标和企业 / 工作区名称都不能为空。');
      setBrandFeedback('请补全工作区字标和企业 / 工作区名称后再保存。');
      return;
    }

    const markResult = onBrandMarkChange?.(nextMark);
    const nameResult = onBrandNameChange?.(nextName);
    setBrandMarkDraft(markResult?.value || nextMark);
    setBrandNameDraft(nameResult?.value || nextName);
    setBrandValidationError('');
    setBrandFeedback(readOnly
      ? '操作只读模式下，本次会话已更新，不写入本机偏好。'
      : (markResult?.persisted === false || nameResult?.persisted === false
        ? '本次会话已更新，但未能保存到本机；重启后可能恢复原值。'
        : '界面已更新，并已保存为本机偏好。'));
  }

  function restoreBrandDefaults() {
    setBrandMarkDraft(defaultBrandMark);
    setBrandNameDraft(defaultBrandName);
    setBrandValidationError('');
    setBrandFeedback(
      committedBrandMark === defaultBrandMark && committedBrandName === defaultBrandName
        ? '当前已经是默认显示。'
        : '已载入默认值；点击“保存显示设置”后生效。',
    );
  }

  function discardBrandDraft() {
    setBrandMarkDraft(committedBrandMark);
    setBrandNameDraft(committedBrandName);
    setBrandValidationError('');
    setBrandFeedback('未保存修改已撤销。');
  }

  function leaveSettings(event) {
    if (shouldGuardSettingsExit(settingsHasUnsavedChanges, 'outside-settings')) {
      pendingNavigationTriggerRef.current = event?.currentTarget || document.activeElement;
      setPendingSection('return-nav');
      return;
    }
    if (hasAiReturnContext) onReturnToAiOperation?.({ resumeAction: false });
    else onOpenNav(returnDestination);
  }

  function confirmDiscardDraftAndLeave() {
    const destination = pendingSection;
    pendingNavigationTriggerRef.current = null;
    setPendingSection('');
    if (destination.startsWith('nav:')) onOpenNav(destination.slice(4));
    else if (destination === 'return-nav') {
      if (hasAiReturnContext) onReturnToAiOperation?.({ resumeAction: false });
      else onOpenNav(returnDestination);
    }
  }

  return (
    <section className="settings-panel">
      <div className="settings-section-announcer" role="status" aria-live="polite" aria-atomic="true">
        {sectionAnnouncement}
      </div>
      <div className="settings-head">
        <div>
          <div className="settings-title">
            <SettingOutlined />
            <span className="settings-page-title">设置</span>
            <Tag color="blue">本地中心</Tag>
            {readOnly && <Tag color="green">只读模式</Tag>}
          </div>
          <Text type="secondary">查看本机可用性、可选能力与故障恢复；完整招聘流程在工作台和使用指南中。</Text>
        </div>
        <Button
          icon={<SafetyCertificateOutlined />}
          aria-label={returnActionLabel}
          title={returnActionLabel}
          onClick={leaveSettings}
        >
          {returnActionLabel}
        </Button>
      </div>

      <nav className="settings-section-nav" aria-label="设置分区">
        {compactSectionNav ? (
          <Select
            aria-label="设置分类"
            value={activeSection}
            options={SETTINGS_SECTIONS.map(([value, label]) => ({ value, label }))}
            style={{ width: '100%' }}
            onChange={activateSection}
          />
        ) : SETTINGS_SECTIONS.map(([sectionId, label]) => (
            <button
              type="button"
              aria-current={activeSection === sectionId ? 'page' : undefined}
              aria-controls={sectionId}
              className={activeSection === sectionId ? 'active' : ''}
              key={sectionId}
              onClick={() => activateSection(sectionId)}
            >
              {label}
            </button>
          ))}
      </nav>

      <Modal
        className="settings-unsaved-switch-modal"
        open={Boolean(pendingSection)}
        title="设置有未保存修改"
        onCancel={() => setPendingSection('')}
        maskClosable={false}
        keyboard
        afterClose={() => {
          const trigger = pendingNavigationTriggerRef.current;
          pendingNavigationTriggerRef.current = null;
          if (trigger?.isConnected && typeof trigger.focus === 'function') trigger.focus();
        }}
        footer={[
          <Button key="stay" autoFocus onClick={() => setPendingSection('')}>留在本页</Button>,
          <Button key="leave" danger type="primary" onClick={confirmDiscardDraftAndLeave}>放弃草稿并离开</Button>,
        ]}
      >
        <p>离开设置会丢失本页草稿；已保存的配置不会受影响。设置内切换分区不会丢失草稿。</p>
      </Modal>

      {activeSection === 'settings-overview' && <section className="settings-section settings-panel-view" id="settings-overview" aria-labelledby="settings-overview-title">
        <div className="settings-section-head">
          <div>
            <Text className="settings-kicker">本机状态</Text>
            <Title level={4} id="settings-overview-title" tabIndex={-1}>本地招聘是否可用</Title>
          </div>
          <Text type="secondary">外部 AI 和面试设备都是可选能力，不决定本地主流程是否可用。</Text>
        </div>
        <Alert
          className="settings-overview-result"
          type={overviewOverall.type}
          showIcon
          message={overviewOverall.title}
          description={overviewOverall.description}
        />
        <Alert
          className="settings-business-return"
          type="info"
          showIcon
          message={businessReturn.label}
          description={businessReturn.description}
          action={<Button type="primary" onClick={() => onOpenNav?.('工作台')}>{businessReturn.label}</Button>}
        />
        <div className="settings-state-grid settings-overview-grid">
          <StateCard
            icon={<ToolOutlined />}
            label="面试设备"
            value={deviceDisplay.value}
            tone={deviceDisplay.tone}
          >
            <small>{deviceDisplay.description}</small>
            <div className="settings-state-action"><Button size="small" onClick={() => activateSection('settings-interview-tools')}>查看面试工具</Button></div>
          </StateCard>
          <StateCard icon={<DatabaseOutlined />} label="外部 AI 辅助" value={llmStatus.text} tone={llmLoadError ? 'warning' : (llmOperational ? 'success' : 'neutral')}>
            <small>{llmSummary.text}</small>
            <div className="settings-state-action"><Button size="small" onClick={() => activateSection('settings-integrations')}>{overviewAiNeedsConfiguration ? '按需启用外部 AI' : '查看外部 AI 状态'}</Button></div>
          </StateCard>
        </div>
      </section>}

      {activeSection === 'settings-brand' && <section className="settings-section settings-panel-view" id="settings-brand" aria-labelledby="settings-brand-title">
        <div className="settings-section-head">
          <div>
            <Text className="settings-kicker">界面显示</Text>
            <Title level={4} id="settings-brand-title" tabIndex={-1}>工作区显示名称</Title>
          </div>
          <Text type="secondary">只改变当前电脑上的工作区标识；产品名称始终为招才官，开发者为 Zhaocai Guan contributors。</Text>
        </div>
        <section className="settings-card">
          <div className="settings-card-head">
            <div><Text className="settings-kicker">侧栏预览</Text><Title level={4}>企业 / 工作区名称</Title></div>
          <Button
            size="small"
            onClick={restoreBrandDefaults}
          >
            恢复默认
          </Button>
          </div>
          <div className="settings-brand-row">
            <div className="settings-brand-preview" role="img" aria-label="浅色侧栏工作区标识预览">
              <div className="brand-mark settings-brand-preview-mark" title={brandNameDraft || '未命名'}>
                <span>{brandMarkDraft || '—'}</span>
                <strong>{brandNameDraft || '未命名'}</strong>
              </div>
            </div>
            <div className="settings-brand-fields">
              <label>
                <span>工作区字标</span>
                <Input
                  name="settings-brand-mark"
                  autoComplete="off"
                  maxLength={4}
                  showCount
                  value={brandMarkDraft}
                  placeholder={`${defaultBrandMark}…`}
                  status={brandValidationError ? 'error' : undefined}
                  aria-invalid={brandValidationError ? 'true' : undefined}
                  aria-describedby="settings-brand-feedback"
                  onChange={(event) => {
                    setBrandMarkDraft(event.target.value);
                    setBrandValidationError('');
                  }}
                />
              </label>
              <label>
                <span>企业 / 工作区名称</span>
                <Input
                  name="settings-brand-name"
                  autoComplete="off"
                  maxLength={32}
                  showCount
                  value={brandNameDraft}
                  placeholder={`${defaultBrandName}…`}
                  status={brandValidationError ? 'error' : undefined}
                  aria-invalid={brandValidationError ? 'true' : undefined}
                  aria-describedby="settings-brand-feedback"
                  onChange={(event) => {
                    setBrandNameDraft(event.target.value);
                    setBrandValidationError('');
                  }}
                />
              </label>
              <div className="settings-brand-actions">
                <Button
                  type="primary"
                  disabled={!brandDraftDirty}
                  onClick={saveBrandDisplay}
                >
                  {readOnly ? '应用到本次会话' : '保存显示设置'}
                </Button>
                <Button disabled={!brandDraftDirty} onClick={discardBrandDraft}>
                  撤销未保存修改
                </Button>
              </div>
              <small
                id="settings-brand-feedback"
                className={brandValidationError ? 'settings-field-error' : undefined}
                role={brandValidationError ? 'alert' : 'status'}
                aria-live="polite"
              >
                {brandValidationError || brandFeedback} 不影响数据读取或业务动作。
              </small>
            </div>
          </div>
        </section>
      </section>}

      {activeSection === 'settings-integrations' && <section className="settings-section settings-panel-view" id="settings-integrations" aria-labelledby="settings-integrations-title">
        <div className="settings-section-head">
          <div>
            <Text className="settings-kicker">AI 与外部连接</Text>
            <Title level={4} id="settings-integrations-title" tabIndex={-1}>可选加速与外部来源</Title>
          </div>
          <Text type="secondary">外部 AI 跨五个招聘环节按需启用；不启用时手工路径均可完整继续。</Text>
        </div>

        <section className="settings-card settings-llm-card">
          <div className="settings-card-head">
            <div><Text className="settings-kicker">可选加速</Text><Title level={4} id="settings-external-ai-title" tabIndex={-1}>外部 AI 辅助</Title></div>
            <Tag color={llmStatus.color}>{llmStatus.text}</Tag>
          </div>
          <Text>在具体招聘任务里按需使用；不启用时，JD、画像、候选人、测评和面试的手工路径都可完整继续。</Text>
          <div className="settings-ai-capability-list" aria-label="外部 AI 可辅助的五类 HR 任务">
            {AI_CAPABILITY_LABELS.map(([, label], index) => (
              <span key={label}><b>{index + 1}</b>{label}</span>
            ))}
          </div>
          <div className="settings-ai-data-boundary" role="note">
            <SafetyCertificateOutlined aria-hidden="true" />
            <span>只有 HR 在业务页明确发起并完成逐次发送确认后，才会发送当次文本材料；不会自动评级、淘汰或写回。</span>
          </div>
          {readOnly && <Alert type="warning" showIcon message="只读模式仍读取已保存的外部 AI 状态；配置修改、模型验证和材料发送保持锁定。" />}
          {llmLoadError && <Alert type="error" showIcon message="AI 配置读取失败" description={llmLoadError} />}
          {llmOperationError && <Alert type="error" showIcon message={llmOperationError.title} description={llmOperationError.message} />}
          {llmNotice && <Alert type={llmNotice.type} showIcon message={llmNotice.message} description={llmNotice.description} />}
          <div
            className="settings-llm-next-step"
            data-state={llmNextStep.state}
            role={['load-error', 'startup-fault'].includes(llmNextStep.state) ? 'alert' : 'status'}
          >
            <div>
              <strong>{llmNextStep.title}</strong>
              <span>{llmNextStep.description}</span>
            </div>
            {llmNextStep.action ? <Button
              className="settings-llm-next-step-action"
              loading={(llmNextStep.state === 'save' && llmBusy === 'save') || (llmNextStep.state === 'models' && llmBusy === 'models') || (llmNextStep.state === 'enable' && llmBusy === 'save')}
              disabled={!!llmBusy}
              onClick={() => {
                if (['credential', 'select-model', 'invalid'].includes(llmNextStep.state)) setLlmAdminOpen(true);
                else if (llmNextStep.state === 'load-error') setLlmLoadAttempt((current) => current + 1);
                else if (llmNextStep.state === 'models') refreshLlmModels();
                else if (llmNextStep.state === 'enable') saveLlmSettings(true);
                else if (llmNextStep.state === 'ready' && hasAiReturnContext) onReturnToAiOperation?.();
                else if (llmNextStep.state === 'ready') onOpenNav?.('工作台');
                else saveLlmSettings();
              }}
            >{llmNextStep.action}</Button> : null}
          </div>

          <details className="settings-admin-config" open={llmAdminOpen} onToggle={(event) => setLlmAdminOpen(event.currentTarget.open)}>
            <summary>高级设置：服务地址、访问密钥与模型</summary>
            <div className="settings-admin-config-body">
              {llmLoadError && <Alert
                type="warning"
                showIcon
                message="配置读取失败，高级设置已锁定"
                description={llmLoadRecovery.retryable
                  ? '下方不会显示本机已保存值，也不能保存、验证模型或清除密钥。请先点击“重新读取 AI 配置”。'
                  : '下方不会显示本机已保存值，也不能保存、验证模型或清除密钥。本次启动中重复读取无法恢复；请重启招才官，若仍失败请联系部署人员。'}
              />}
              <div className="settings-llm-connection" aria-label="外部 AI 服务连接">
                <div className="settings-llm-field">
                  <label htmlFor="settings-llm-provider">服务商标识</label>
                  <Input id="settings-llm-provider" name="settings-llm-provider"
                    value={llmLoadError ? '' : llmConfig.provider}
                    maxLength={64} disabled={llmConfigurationLocked || !!llmBusy}
                    status={llmFieldErrors.provider ? 'error' : undefined}
                    autoComplete="off" spellCheck={false} placeholder="例如 openai-compatible"
                    onChange={(event) => updateLlmConnection('provider', event.target.value)} />
                  {llmFieldErrors.provider && <small className="settings-field-error">{llmFieldErrors.provider}</small>}
                </div>
                <div className="settings-llm-field">
                  <label htmlFor="settings-llm-base-url">HTTPS API 根地址</label>
                  <Input id="settings-llm-base-url" name="settings-llm-base-url"
                    value={llmLoadError ? '' : llmConfig.baseUrl}
                    maxLength={2048} disabled={llmConfigurationLocked || !!llmBusy}
                    status={llmFieldErrors.baseUrl ? 'error' : undefined}
                    autoComplete="off" spellCheck={false} placeholder="https://ai.example.test/v1"
                    onChange={(event) => updateLlmConnection('baseUrl', event.target.value)} />
                  <small className={llmFieldErrors.baseUrl ? 'settings-field-error' : undefined}>
                    {llmFieldErrors.baseUrl || '填写 OpenAI 兼容服务的 API 根地址。裸域名会补 /v1，已有路径原样保留；更换服务后须重新填写密钥并测试模型。'}
                  </small>
                </div>
              </div>

              <div className="settings-llm-form">
                <div className="settings-llm-field" data-step="1">
                  <label htmlFor="settings-llm-api-key">1. 填写访问密钥</label>
                  <div className="settings-llm-key-row">
                    <Input.Password
                      id="settings-llm-api-key"
                      name="settings-llm-api-key"
                      value={llmApiKey}
                      disabled={llmConfigurationLocked || !!llmBusy}
                      autoComplete="new-password"
                      spellCheck={false}
                      visibilityToggle={false}
                      placeholder={llmLoadError ? '配置状态未知；请先重新读取…' : (llmConfig.apiKeyConfigured ? '已配置；如需替换请重新输入…' : '输入后不会回显…')}
                      onChange={(event) => {
                        beginLlmDraftEdit();
                        setLlmApiKey(event.target.value);
                      }}
                    />
                    <Button
                      type="primary"
                      disabled={llmConfigurationLocked || !!llmBusy || !llmApiKey.trim()}
                      loading={llmBusy === 'save'}
                      onClick={() => saveLlmSettings()}
                    >
                      保存密钥
                    </Button>
                  </div>
                  <small>保存后才可刷新和测试模型；桌面应用会优先写入系统安全存储，若只能在本次会话生效，保存后会明确警告。密钥不写入 localStorage、SQLite 或日志，也不会回显。</small>
                </div>

                <div className="settings-llm-field" data-step="2">
                  <div className="settings-llm-field-head">
                    <label htmlFor={llmManualModelMode ? 'settings-llm-model-manual' : 'settings-llm-model-select'}>2. 验证并获取模型</label>
                    <Button
                      type="link"
                      size="small"
                      disabled={llmConfigurationLocked || !!llmBusy}
                      onClick={() => {
                        beginLlmDraftEdit();
                        if (llmManualModelMode && !llmModels.some((item) => item.value === llmConfig.model)) {
                          setLlmConfig((current) => ({ ...current, model: '', modelVerified: false }));
                        }
                        setLlmManualModelMode(!llmManualModelMode);
                      }}
                    >
                      {llmManualModelMode ? '返回模型列表' : '手动输入模型 ID'}
                    </Button>
                  </div>
                  <div className="settings-llm-model-row">
                    {llmManualModelMode ? (
                      <Input
                        id="settings-llm-model-manual"
                        aria-label="手动输入 AI 模型 ID"
                        value={llmLoadError ? '' : (llmConfig.model || '')}
                        maxLength={160}
                        disabled={llmConfigurationLocked || !!llmBusy}
                        status={llmFieldErrors.model ? 'error' : undefined}
                        spellCheck={false}
                        placeholder="例如 vendor/synthetic-model"
                        onChange={(event) => {
                          beginLlmDraftEdit();
                          setLlmConfig((current) => ({ ...current, model: event.target.value, modelVerified: false }));
                        }}
                      />
                    ) : (
                      <Select
                        id="settings-llm-model-select"
                        aria-label="AI 模型"
                        value={llmLoadError ? undefined : (llmConfig.model || undefined)}
                        disabled={llmConfigurationLocked || !!llmBusy}
                        status={llmFieldErrors.model ? 'error' : undefined}
                        aria-invalid={llmFieldErrors.model ? 'true' : undefined}
                        aria-describedby="llm-model-help"
                        options={llmModelGroups}
                        showSearch
                        optionFilterProp="label"
                        listHeight={240}
                        allowClear
                        placeholder={llmModels.length ? '选择模型…' : '先保存密钥并刷新列表…'}
                        notFoundContent={llmConfig.apiKeyConfigured ? '未读取到模型；可改为手动输入' : '请先保存访问密钥'}
                        onChange={(model) => {
                          beginLlmDraftEdit();
                          setLlmConfig((current) => reconcileDraftModelVerification(
                            { ...current, model: model || '' },
                            llmPersistedConfigRef.current,
                            llmModels,
                          ));
                        }}
                      />
                    )}
                    <Button
                      icon={<ReloadOutlined />}
                      disabled={llmConfigurationLocked || !!llmBusy || !llmConfig.apiKeyConfigured || !!llmApiKey.trim() || llmHasUnsavedChanges}
                      loading={llmBusy === 'models'}
                      onClick={refreshLlmModels}
                      title={!llmConfig.apiKeyConfigured ? '先保存 API Key' : '只读取模型列表，不发送候选人材料'}
                    >
                      刷新列表
                    </Button>
                    <Button
                      type="primary"
                      icon={<CheckCircleOutlined />}
                      disabled={llmConfigurationLocked || !!llmBusy || !llmConfig.apiKeyConfigured || !!llmApiKey.trim() || llmConnectionHasUnsavedChanges || !String(llmConfig.model || '').trim()}
                      loading={llmBusy === 'test'}
                      onClick={testLlmModel}
                      title="发送一次不含候选人材料的合成测试，可能产生少量模型费用"
                    >
                      测试并使用
                    </Button>
                  </div>
                  <small id="llm-model-help" className={llmFieldErrors.model ? 'settings-field-error' : undefined}>
                    {llmFieldErrors.model || (selectedLlmModel
                      ? `${selectedLlmModel.reason}；${selectedLlmModel.verified ? '已通过兼容性测试。' : '尚未测试。'}`
                      : '可选择服务返回的模型，也可手动输入模型 ID。模型须通过当前服务的 Chat Completions 与严格 JSON 测试；测试可能产生少量费用。')}
                  </small>
                </div>
                <div className="settings-llm-field settings-llm-timeout-field">
                  <label htmlFor="settings-llm-timeout">高级：单次分析超时</label>
                  <InputNumber
                    id="settings-llm-timeout"
                    min={30000}
                    max={300000}
                    step={10000}
                    value={Number(llmConfig.timeoutMs) || 120000}
                    suffix="毫秒"
                    disabled={llmConfigurationLocked || !!llmBusy}
                    onChange={(value) => {
                      beginLlmDraftEdit();
                      setLlmConfig((current) => ({ ...current, timeoutMs: Number(value) || 120000 }));
                    }}
                  />
                  <small>默认 120000 毫秒。只影响单次外部 AI 等待时间，不会改变本地招聘流程。</small>
                </div>
              </div>

              <div className="settings-ai-scope">
                <strong>一套配置用于 5 项辅助能力</strong>
                <span>JD、深度画像、候选人初评、测评分析、面试复盘；当前 {llmCapabilityCount}/5 项已就绪。</span>
              </div>

              <div className="settings-llm-actions">
                <div className="settings-llm-enable">
                  <Switch
                    aria-label="允许人工发起外部 AI 分析"
                    aria-describedby="settings-llm-enable-help"
                    checked={!llmLoadError && llmConfig.enabled === true}
                    disabled={llmConfigurationLocked || !!llmBusy || llmEnableUnavailable}
                    onChange={(enabled) => {
                      beginLlmDraftEdit();
                      setLlmConfig((current) => ({ ...current, enabled }));
                    }}
                  />
                  <div>
                    <span>3. 测试并启用</span>
                    <small id="settings-llm-enable-help">
                      {llmEnableUnavailable ? '先保存密钥并完成模型测试，才能开启。' : '开启后，每次发送候选人材料仍需 HR 单独确认。'}
                    </small>
                  </div>
                </div>
                <Space wrap>
                  <Button danger disabled={llmConfigurationLocked || !!llmBusy || !llmConfig.apiKeyConfigured} loading={llmBusy === 'clear'} onClick={() => setLlmClearConfirmOpen(true)}>清除 API Key</Button>
                  <Button type="primary" icon={<LockOutlined />} disabled={llmConfigurationLocked || !!llmBusy || !llmHasUnsavedChanges || !llmFormValid || !!llmApiKey.trim()} loading={llmBusy === 'save'} onClick={() => saveLlmSettings()} title="保存启用状态不会自动发送候选人数据">保存设置</Button>
                </Space>
              </div>
              {llmClearConfirmOpen && <Alert
                className="settings-llm-clear-confirm"
                type="warning"
                showIcon
                message="确定清除本机 API Key？"
                description="清除后外部 AI 会立即关闭，本页未保存修改也会放弃；如需再次使用，必须重新填写 API Key 并验证模型。"
                action={<Space wrap>
                  <Button disabled={!!llmBusy} onClick={() => setLlmClearConfirmOpen(false)}>取消</Button>
                  <Button danger type="primary" loading={llmBusy === 'clear'} disabled={!!llmBusy} onClick={async () => { if (await clearLlmCredential()) setLlmClearConfirmOpen(false); }}>清除并关闭</Button>
                </Space>}
              />}
            </div>
          </details>
          <div className="settings-ai-consent-note" role="note">
            <SafetyCertificateOutlined />
            <span><strong>启用不等于自动发送。</strong> 每次分析前仍会展示发送文本、排除项、模型和字符数；返回结果只保存为草稿。</span>
          </div>
        </section>

      </section>}

      {activeSection === 'settings-interview-tools' && <section className="settings-card settings-dependency-card settings-panel-view" id="settings-interview-tools" aria-labelledby="settings-interview-tools-title">
        <div className="settings-card-head">
          <div>
            <Text className="settings-kicker">面试工具</Text>
            <Title level={4} id="settings-interview-tools-title" tabIndex={-1}>录音、转写与文件导入</Title>
          </div>
          <Space wrap>
            {doctorError
              ? <Tag color="red">软件检查失败</Tag>
              : (doctorDegraded
                ? <Tag color="gold">当前平台降级</Tag>
                : (doctor
                  ? <Tag color={fullCapabilityCount === 4 ? 'green' : 'gold'}>{fullCapabilityCount}/4 完整可用{limitedCapabilityCount ? ` · ${limitedCapabilityCount} 项有限` : ''}</Tag>
                  : <Tag>软件未检查</Tag>))}
            <Tooltip title={READONLY_UI ? '操作只读模式不执行子进程或本机依赖检查' : '只检查本机工具，不访问外部服务或执行录音'}>
              <Button icon={<ReloadOutlined />} loading={doctorLoading} disabled={READONLY_UI || doctorLoading} onClick={runDoctor}>
                {doctor ? '重新检查软件依赖' : '开始检查软件依赖'}
              </Button>
            </Tooltip>
          </Space>
        </div>

        {readOnly && <Alert type="warning" showIcon message="操作只读模式不启动本机依赖检查、麦克风测试、录音或转写。" />}
        {doctorDegraded && <Alert type="warning" showIcon message="本机录音与 ASR 当前不可用" description={doctor.message} />}
        {doctorError && <Alert type="warning" showIcon message="面试软件依赖检查失败" description={doctorError} />}

        <Text className="settings-kicker">软件依赖检查</Text>
        <div className="settings-capability-grid">
          {capabilityRows.map((item) => (
            <article className="settings-capability-row" key={item.label}>
              <div>
                <strong>{item.label}</strong>
                <small>{doctorError ? '上次检查失败，当前能力状态未知。' : item.hint}</small>
              </div>
              <Tag color={doctorError ? 'red' : (!doctor ? 'default' : (item.available ? 'green' : 'gold'))}>{doctorError ? '状态未知' : item.status}</Tag>
            </article>
          ))}
        </div>
        <Text type="secondary">以上只检查录音、转写和转码软件，不代表麦克风权限或实际收音已经可用。工具路径和模型文件位于“关于与诊断”。</Text>

        <div className="settings-card-head">
          <div>
            <Text className="settings-kicker">麦克风实测</Text>
            <Title level={5}>由用户主动开始的 8 秒测试</Title>
          </div>
          <Tag color={micCheckError ? 'red' : (micCheckInProgress ? 'blue' : (micCheck ? (micCheck.level === 'pass' ? 'green' : 'gold') : 'default'))}>
            {micCheckError ? '测试失败' : (micCheckInProgress ? '测试中' : (micCheck ? (micCheck.level === 'pass' ? '已通过' : '需复检') : '未测试'))}
          </Tag>
        </div>
        <Alert
          type="info"
          showIcon
          message="不会自动访问麦克风"
          description="只有确认授权并点击下方按钮后才会录制约 8 秒并运行本地转写；测试不会发送到外部服务，临时音频、转写和分析文件会在测试后删除。"
          action={(
            <Space direction="vertical" size={6}>
              <Checkbox
                checked={micCheckConsent}
                disabled={readOnly || micCheckLoading || micCheckInProgress}
                onChange={(event) => setMicCheckConsent(event.target.checked)}
              >
                已确认在场说话人知情
              </Checkbox>
              <Button
                icon={<ToolOutlined />}
                loading={micCheckLoading}
                disabled={readOnly || doctorDegraded || !doctorMicCheckReady || micCheckLoading || micCheckInProgress || !micCheckConsent}
                onClick={runMicCheck}
              >
                开始 8 秒麦克风测试
              </Button>
              {micCheckInProgress && (
                <Button
                  danger
                  icon={<StopOutlined />}
                  loading={micCheckAbortLoading}
                  disabled={readOnly || micCheckAbortLoading || !micCheckJob?.id}
                  onClick={abortMicCheck}
                >
                  {micCheckJob?.status === 'starting' ? '取消启动并清理' : '取消测试并清理'}
                </Button>
              )}
            </Space>
          )}
        />
        {micCheckInProgress && (
          <Alert
            type="info"
            showIcon
            message={micCheckJob?.status === 'starting' ? '正在建立麦克风预检' : '正在录制并检查麦克风'}
            description={micCheckJob?.status === 'starting'
              ? '尚未打开麦克风；可取消启动并清理本次任务。'
              : '请按正常面试音量说话；也可随时取消，确认进程结束后会删除本次测试材料。'}
          />
        )}
        {micCheckNotice && <Alert
          type="warning"
          showIcon
          message="麦克风测试仍在处理"
          description={micCheckNotice}
          action={<Button size="small" loading={micCheckLoading} disabled={readOnly || micCheckLoading} onClick={resumeMicCheckPolling}>继续读取结果</Button>}
        />}
        {micCheckError && <Alert type="error" showIcon message="麦克风测试未完成" description={micCheckError} />}
        {micCheck && <Alert
          type={micCheck.level === 'pass' ? 'success' : (micCheck.level === 'fail' ? 'error' : 'warning')}
          showIcon
          message={micCheck.message || '麦克风测试已完成'}
          description={`${micCheck.recommendation || '请根据结果决定是否重新测试。'} 临时音频、转写与分析文件已删除。`}
        />}
      </section>}

      {activeSection === 'settings-data' && <section className="settings-section settings-panel-view" id="settings-data" aria-labelledby="settings-data-title">
        <div className="settings-section-head">
          <div><Text className="settings-kicker">数据与隐私</Text><Title level={4} id="settings-data-title" tabIndex={-1}>数据保存与外部发送边界</Title></div>
          <Text type="secondary">候选人资料保存在本机；换机前按清单检查即可。</Text>
        </div>
        <section className="settings-card">
          <div className="settings-protection-grid">
            <div className="settings-protection-row">
              <div><span>候选人数据</span><strong>招才官本地副本保存在本机</strong><small>{job ? `当前岗位“${job.name}”共 ${candidates.length} 名候选人。` : '尚未选择岗位；选择岗位后显示该岗位候选人数。'} 招聘渠道中的原始资料仍受对应平台规则约束。</small></div>
              <Tag color="green">本机数据</Tag>
            </div>
            <div className="settings-protection-row">
              <div><span>外部 AI 发送</span><strong>{llmStatus.text}</strong><small>{llmSummary.text} 即使启用，每次发送仍需 HR 单独确认。</small></div>
              <Tag color={llmStatus.color}>{llmConfig.enabled && !llmHasUnsavedChanges ? '逐次确认' : '不会自动发送'}</Tag>
            </div>
            <div className="settings-protection-row">
              <div><span>备份与换机</span><strong>换机前检查</strong><small>招才官不会自动上传或同步候选人资料；换机前请按本机路径与迁移步骤确认。</small></div>
              <div className="settings-protection-action">
                <Tag color="gold">按需处理</Tag>
                <Button size="small" onClick={() => activateSection('settings-advanced')}>查看路径与步骤</Button>
              </div>
            </div>
          </div>
        </section>
        <section className="settings-card">
          <div className="settings-card-head"><div><Text className="settings-kicker">HR 换机清单</Text><Title level={4}>迁移前确认</Title></div><SafetyCertificateOutlined /></div>
          <ol className="settings-checklist">
            {HR_MIGRATION_ITEMS.map((item) => <li key={item}><CheckCircleOutlined /><span>{item}</span></li>)}
          </ol>
        </section>
        <div className="settings-boundary-note success" role="note">
          <CheckCircleOutlined />
          <span>保存配置不会访问外部服务；“刷新列表”只读取 已保存服务的模型目录，“测试并使用”只发送合成测试文本。两者都不会发送候选人材料。设置页不会自动发邀约、约面、淘汰或推进。</span>
        </div>
      </section>}

      {activeSection === 'settings-advanced' && <section className="settings-section settings-panel-view" id="settings-advanced" aria-labelledby="settings-advanced-title">
        <div className="settings-section-head">
          <div>
            <Text className="settings-kicker">关于与诊断</Text>
            <Title level={4} id="settings-advanced-title" tabIndex={-1}>版本与本机状态</Title>
          </div>
          <Text type="secondary">产品信息直接展示；技术详情默认收起。</Text>
        </div>
        <section className="settings-card settings-about-card" aria-labelledby="settings-about-title">
          <div className="settings-card-head">
            <div>
              <Text className="settings-kicker">关于 / 版本</Text>
              <Title level={4} id="settings-about-title" tabIndex={-1}>招才官</Title>
            </div>
            <Tag color="blue">v{APP_VERSION}</Tag>
          </div>
          <Text>HR 的招聘桌面助手</Text>
          <Text>侧栏显示的是本机可配置的企业 / 工作区名称，修改工作区名称不会改变产品名称。</Text>
          <dl className="settings-product-identity">
            <div><dt>产品</dt><dd>招才官</dd></div>
            <div><dt>当前工作区</dt><dd>{committedBrandName}</dd></div>
            <div><dt>开发商</dt><dd>Zhaocai Guan contributors</dd></div>
          </dl>
          <Text type="secondary">数据与运行状态以本机为边界，不提供账户、多租户或云同步能力。</Text>
          <div><Text type="secondary">{APP_RUNTIME_STACK}</Text></div>
        </section>
        <div className="settings-main-grid">
          <details className="settings-advanced-card">
            <summary>本机路径与部署迁移清单</summary>
            <section className="settings-card">
              <div className="settings-card-head">
                <div>
                  <Text className="settings-kicker">高级诊断 · 数据与迁移</Text>
                  <Title level={4}>本机路径与迁移步骤</Title>
                </div>
                <FolderOpenOutlined />
              </div>
              {localPathsError ? (
                <Alert
                  type="error"
                  showIcon
                  message="本机目录读取失败"
                  description={localPathsError}
                  action={<Button size="small" onClick={() => setLocalPathsLoadAttempt((attempt) => attempt + 1)}>重新读取</Button>}
                />
              ) : localPaths ? (
                <div className="settings-path-list">
                  {localPathRows.map((row) => <PathRow key={row.label} row={row} />)}
                </div>
              ) : <Text role="status">正在读取本机目录…</Text>}
              <ol className="settings-checklist">
                {ADVANCED_MIGRATION_ITEMS.map((item) => <li key={item}><CheckCircleOutlined /><span>{item}</span></li>)}
              </ol>
            </section>
          </details>

          <details className="settings-advanced-card">
            <summary>面试工具路径与模型诊断</summary>
            <section className="settings-card">
              <div className="settings-tool-grid">
                {doctorToolRows.length ? doctorToolRows.map(([name, info]) => (
                  <div className="settings-tool-row" key={name}>
                    <div><strong>{toolLabel(name)}</strong><code>{has(info.path) ? info.path : '未发现'}</code></div>
                    <Tag color={info.runnable ? 'green' : 'red'}>{info.runnable ? '可运行' : '不可用'}</Tag>
                  </div>
                )) : <div className="settings-empty">尚未检查本机工具。请先进入“面试工具”运行检查。</div>}
              </div>
              {doctor && <div className="settings-model-row"><span>模型文件</span><code>{doctor.whisperModel || '未发现'}</code></div>}
            </section>
          </details>

          <details className="settings-advanced-card">
            <summary>本机最近任务进度</summary>
            <section className="settings-card">
              <div className="settings-card-head">
                <div>
                  <Text className="settings-kicker">本地任务历史</Text>
                  <Title level={4}>最近状态</Title>
                </div>
                <HistoryOutlined />
              </div>
              <div className="settings-progress-list">
                {progressRows.map(([label, progress]) => (
                  <div className="settings-progress-row" key={label}>
                    <span>{label}</span>
                    <Tag color={statusColor(progress)}>{statusText(progress)}</Tag>
                    <em>{progress?.updated_at || progress?.finished_at ? fmtTime(progress.updated_at || progress.finished_at) : '暂无时间'}</em>
                  </div>
                ))}
              </div>
            </section>
          </details>

          <details className="settings-advanced-card">
            <summary>模块开放状态</summary>
            <section className="settings-card settings-module-card">
        <div className="settings-card-head">
          <div>
            <Text className="settings-kicker">模块开放状态</Text>
            <Title level={4}>已开放与决策暂缓</Title>
          </div>
          <Tag color="blue">本地</Tag>
        </div>
        <div className="settings-module-grid">
          {MODULES.map((item) => (
            <article className={`settings-module-row ${item.tone}`} key={item.name}>
              <div>
                <strong>{item.name}</strong>
                <p>{item.note}</p>
              </div>
              <Tag color={item.tone}>{item.status}</Tag>
            </article>
          ))}
        </div>
            </section>
          </details>
        </div>
      </section>}
    </section>
  );
}
