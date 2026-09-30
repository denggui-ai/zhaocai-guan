import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Collapse, Empty, Input, InputNumber, Select, Space, Switch, Tag, Typography } from 'antd';
import { api, fmtTime } from '../api.js';
import { analyzeJdRecommendationRisk } from '../fixtures/jd-recommendation-diagnostics.js';
import {
  createJobManagementActionAdapter,
  JOB_MANAGEMENT_ACTION_SCHEMA,
  JobManagementWorkspace,
} from './job-management-workspace.jsx';
import ExternalAiFirstUsePrompt, {
  readExternalAiCapability,
} from './ExternalAiFirstUsePrompt.jsx';

const { Paragraph, Text } = Typography;

const PROFILE_FIELDS = [
  { key: 'responsibilities', label: '岗位职责', placeholder: '每行一项，例如：负责千川投放策略、日常调优与复盘' },
  { key: 'must_haves', label: '必须条件', placeholder: '每行一项，例如：能讲清 ROI、CTR、CVR 的优化动作' },
  { key: 'nice_to_haves', label: '加分项', placeholder: '每行一项；没有可以留空' },
  { key: 'deal_breakers', label: '淘汰项', placeholder: '每行一项；仅供 HR 判断，不自动淘汰' },
];

const STATUS_LABELS = {
  draft: { text: '草稿', color: 'default' },
  active: { text: '使用中', color: 'green' },
  confirmed: { text: '已确认', color: 'green' },
  stale: { text: '旧 JD 画像', color: 'orange' },
  superseded: { text: '历史版本', color: 'default' },
};

const DEGREE_OPTIONS = ['高中', '中专', '大专', '本科', '硕士', '研究生', '博士']
  .map((value) => ({ value, label: value }));
const ASSESSMENT_POLICY_OPTIONS = [
  { value: 'not_required', label: '不要求', description: '不生成测评待办，候选人可直接进入后续人工流程。' },
  { value: 'recommended', label: '建议补充', description: '提示 HR 补充测评，但不阻塞后续人工流程。' },
  { value: 'required', label: '终评前必需', description: '终评确认前至少需要一份 HR 已确认且可用的测评报告。' },
];

const PRESERVED_PROFILE_METADATA_FIELDS = [
  'rubric',
  'suggested_positive_signals',
  'points_to_verify',
  'interview_focus',
  'hr_context',
  'missing_hr_fields',
];

function emptyProfileForm() {
  return Object.fromEntries(PROFILE_FIELDS.map((field) => [field.key, '']));
}

function emptyHardBarForm() {
  return {
    degree: { enabled: false, allowed: ['本科', '硕士', '博士', '研究生'] },
    salary: { enabled: false, cap_k: 30 },
    city: { enabled: false, allowed: [] },
  };
}

function textLines(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function profileHasContent(form) {
  return PROFILE_FIELDS.some((field) => textLines(form[field.key]).length > 0);
}

function profileFormFromConfig(config) {
  return Object.fromEntries(PROFILE_FIELDS.map((field) => [
    field.key,
    textLines(config && config[field.key]).join('\n'),
  ]));
}

function hardBarFormFromConfig(config) {
  const hardBars = config && typeof config.hard_bars === 'object' ? config.hard_bars : {};
  const degree = hardBars.degree && typeof hardBars.degree === 'object' ? hardBars.degree : {};
  const salary = hardBars.salary && typeof hardBars.salary === 'object' ? hardBars.salary : {};
  const city = hardBars.city && typeof hardBars.city === 'object' ? hardBars.city : {};
  return {
    degree: {
      enabled: degree.enabled === true,
      allowed: Array.isArray(degree.allowed) ? degree.allowed.filter(Boolean) : ['本科', '硕士', '博士', '研究生'],
    },
    salary: {
      enabled: salary.enabled === true,
      cap_k: Number(salary.cap_k) > 0 ? Number(salary.cap_k) : 30,
    },
    city: {
      enabled: city.enabled === true,
      allowed: Array.isArray(city.allowed) ? city.allowed.filter(Boolean) : [],
    },
  };
}

function hardBarValidation(form) {
  if (form.degree.enabled && !form.degree.allowed.length) return '启用学历门槛后，请至少选择一个可接受学历。';
  if (form.salary.enabled && !(Number(form.salary.cap_k) > 0)) return '启用薪资门槛后，请填写大于 0 的月薪上限。';
  if (form.city.enabled && !form.city.allowed.length) return '启用城市门槛后，请至少填写一个可接受城市。';
  return '';
}

function normalizeAssessmentPolicy(value) {
  return ASSESSMENT_POLICY_OPTIONS.some((item) => item.value === value) ? value : 'not_required';
}

function profileRubric(form) {
  return PROFILE_FIELDS.map((field) => {
    const items = textLines(form[field.key]);
    if (!items.length) return '';
    const label = field.key === 'deal_breakers' ? '淘汰项（仅供 HR 判断，不自动淘汰）' : field.label;
    return `${label}：${items.join('；')}`;
  }).filter(Boolean).join('\n');
}

function preservedProfileMetadata(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  const hasTemplateMetadata = PRESERVED_PROFILE_METADATA_FIELDS
    .some((key) => key !== 'rubric' && Object.prototype.hasOwnProperty.call(config, key));
  return Object.fromEntries(PRESERVED_PROFILE_METADATA_FIELDS
    .filter((key) => (key !== 'rubric' || hasTemplateMetadata) && Object.prototype.hasOwnProperty.call(config, key))
    .map((key) => [key, config[key]]));
}

function buildProfileConfig(form, hardBarForm, assessmentPolicy = 'not_required', baseConfig = {}) {
  const preserved = preservedProfileMetadata(baseConfig);
  return {
    ...preserved,
    schema_version: 'manual_job_profile_v1',
    responsibilities: textLines(form.responsibilities),
    must_haves: textLines(form.must_haves),
    nice_to_haves: textLines(form.nice_to_haves),
    deal_breakers: textLines(form.deal_breakers),
    rubric: preserved.rubric || profileRubric(form),
    assessment_policy: normalizeAssessmentPolicy(assessmentPolicy),
    hard_bars: {
      degree: { enabled: hardBarForm.degree.enabled === true, allowed: hardBarForm.degree.allowed },
      salary: { enabled: hardBarForm.salary.enabled === true, cap_k: Number(hardBarForm.salary.cap_k) || 0 },
      city: { enabled: hardBarForm.city.enabled === true, allowed: hardBarForm.city.allowed },
    },
  };
}

function freshJdAiRequestId(jobId) {
  const nonce = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `job-jd:${jobId}:${nonce}`;
}

function StatusTag({ status }) {
  const meta = STATUS_LABELS[status] || { text: status || '未知', color: 'default' };
  return <Tag color={meta.color}>{meta.text}</Tag>;
}

function ProfileSummary({ config }) {
  const rows = PROFILE_FIELDS.map((field) => ({ ...field, items: textLines(config && config[field.key]) }))
    .filter((field) => field.items.length > 0);
  const templateDetails = [
    { key: 'suggested_positive_signals', label: '建议关注的证据', items: textLines(config && config.suggested_positive_signals) },
    { key: 'points_to_verify', label: '待核实', items: textLines(config && config.points_to_verify) },
    { key: 'interview_focus', label: '面试关注点', items: textLines(config && config.interview_focus) },
  ].filter((field) => field.items.length > 0);
  const hrContext = config && config.hr_context && typeof config.hr_context === 'object' && !Array.isArray(config.hr_context)
    ? Object.entries(config.hr_context).filter(([, value]) => String(value || '').trim())
    : [];
  const missingHrFields = textLines(config && config.missing_hr_fields);
  const hasTemplateSupplement = templateDetails.length > 0 || hrContext.length > 0 || missingHrFields.length > 0;
  const hardBars = hardBarFormFromConfig(config);
  const assessmentPolicy = normalizeAssessmentPolicy(config && config.assessment_policy);
  const assessmentPolicyLabel = ASSESSMENT_POLICY_OPTIONS
    .find((item) => item.value === assessmentPolicy)?.label || '不要求';
  const hardBarLabels = [
    `学历：${hardBars.degree.enabled ? hardBars.degree.allowed.join('、') || '未填写' : '关闭'}`,
    `薪资：${hardBars.salary.enabled ? `月薪上限 ${hardBars.salary.cap_k}K` : '关闭'}`,
    `城市：${hardBars.city.enabled ? hardBars.city.allowed.join('、') || '未填写' : '关闭'}`,
  ];
  return (
    <div>
      {rows.length ? rows.map((row) => (
        <Paragraph key={row.key} style={{ marginBottom: 6 }}>
          <Text strong>{row.label}：</Text>{row.items.join('；')}
          {row.key === 'deal_breakers' && <Text type="secondary">（仅供 HR 判断，不自动淘汰）</Text>}
        </Paragraph>
      )) : config && config.rubric ? (
        <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 6 }}>{config.rubric}</Paragraph>
      ) : (
        <Text type="secondary">该历史版本没有可显示的画像内容。</Text>
      )}
      {templateDetails.map((row) => (
        <Paragraph key={row.key} style={{ marginBottom: 6 }}>
          <Text strong>{row.label}：</Text>{row.items.join('；')}
        </Paragraph>
      ))}
      {!!hrContext.length && (
        <Paragraph style={{ marginBottom: 6 }}>
          <Text strong>HR 已补充的模板事实：</Text>
          {hrContext.map(([key, value]) => `${key}：${String(value).trim()}`).join('；')}
        </Paragraph>
      )}
      {!!missingHrFields.length && (
        <Paragraph style={{ marginBottom: 6 }}>
          <Text strong>待 HR 补充的模板字段：</Text>{missingHrFields.join('、')}
        </Paragraph>
      )}
      {hasTemplateSupplement && config && config.rubric && (
        <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 6 }}>
          <Text strong>模板原始补充说明：</Text>{'\n'}{config.rubric}
        </Paragraph>
      )}
      <Paragraph style={{ marginBottom: 0 }}>
        <Text strong>客观门槛：</Text>{hardBarLabels.join('；')}
        <Text type="secondary">（Unknown 只提示人工确认）</Text>
      </Paragraph>
      <Paragraph style={{ marginBottom: 0 }}>
        <Text strong>测评策略：</Text>{assessmentPolicyLabel}
        <Text type="secondary">（只形成材料待办和终评前置检查，不自动评分、排序或淘汰）</Text>
      </Paragraph>
    </div>
  );
}

export default function JobManagementPanel({
  job,
  workbench,
  loadState,
  loadError,
  readOnly,
  onRefresh,
  onDirtyChange,
  onReturnLedger,
  onOpenAiSettings,
  aiResumeIntent,
  onAiResumeConsumed,
}) {
  const currentJobId = job?.id ?? null;
  const jobIdRef = useRef(currentJobId);
  const operationEpochRef = useRef(0);
  if (jobIdRef.current !== currentJobId) {
    jobIdRef.current = currentJobId;
    operationEpochRef.current += 1;
  }
  const [jdBrief, setJdBrief] = useState('');
  const [jdText, setJdText] = useState('');
  const jdTextRef = useRef(jdText);
  jdTextRef.current = jdText;
  const [jdAiResult, setJdAiResult] = useState(null);
  const [jdAiSource, setJdAiSource] = useState(null);
  const [jdBeforeAi, setJdBeforeAi] = useState(null);
  const [jdEditorBaseline, setJdEditorBaseline] = useState('');
  const [profileForm, setProfileForm] = useState(emptyProfileForm);
  const [hardBarForm, setHardBarForm] = useState(emptyHardBarForm);
  const [assessmentPolicy, setAssessmentPolicy] = useState('not_required');
  const [profileBaseConfig, setProfileBaseConfig] = useState({});
  const [profileEditorBaselineSignature, setProfileEditorBaselineSignature] = useState(() => JSON.stringify(
    buildProfileConfig(emptyProfileForm(), emptyHardBarForm(), 'not_required'),
  ));
  const [lastSavedJdText, setLastSavedJdText] = useState(null);
  const [lastSavedProfileSignature, setLastSavedProfileSignature] = useState(null);
  const [jdHistoryActiveKeys, setJdHistoryActiveKeys] = useState([]);
  const [profileHistoryActiveKeys, setProfileHistoryActiveKeys] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshWarning, setRefreshWarning] = useState('');
  const [aiFirstUseOpen, setAiFirstUseOpen] = useState(false);
  const [aiFirstUseError, setAiFirstUseError] = useState('');
  const [aiFirstUseInput, setAiFirstUseInput] = useState(null);
  const [aiCapabilityChecking, setAiCapabilityChecking] = useState(false);
  const [activeSection, setActiveSection] = useState('jd');
  const authorityWriteLocked = ['loading', 'error', 'stale'].includes(loadState);
  const writesLocked = readOnly || authorityWriteLocked;

  useEffect(() => {
    setJdBrief('');
    setJdText('');
    setJdAiResult(null);
    setJdAiSource(null);
    setJdBeforeAi(null);
    setAiFirstUseOpen(false);
    setAiFirstUseError('');
    setAiFirstUseInput(null);
    setAiCapabilityChecking(false);
    setJdEditorBaseline('');
    const nextProfileForm = emptyProfileForm();
    const nextHardBarForm = emptyHardBarForm();
    setProfileForm(nextProfileForm);
    setHardBarForm(nextHardBarForm);
    setAssessmentPolicy('not_required');
    setProfileBaseConfig({});
    setProfileEditorBaselineSignature(JSON.stringify(buildProfileConfig(nextProfileForm, nextHardBarForm, 'not_required')));
    setLastSavedJdText(null);
    setLastSavedProfileSignature(null);
    setJdHistoryActiveKeys([]);
    setProfileHistoryActiveKeys([]);
    setBusy('');
    setError('');
    setNotice('');
    setRefreshWarning('');
    setActiveSection('jd');
  }, [currentJobId]);

  function currentOperation() {
    return { jobId: jobIdRef.current, epoch: operationEpochRef.current };
  }

  function operationIsCurrent(operation) {
    return operation.jobId === jobIdRef.current && operation.epoch === operationEpochRef.current;
  }

  const hardBarError = useMemo(() => hardBarValidation(hardBarForm), [hardBarForm]);
  const profileDraftSignature = useMemo(
    () => JSON.stringify(buildProfileConfig(profileForm, hardBarForm, assessmentPolicy, profileBaseConfig)),
    [profileForm, hardBarForm, assessmentPolicy, profileBaseConfig],
  );
  const canSaveProfile = useMemo(
    () => profileHasContent(profileForm)
      && !hardBarError
      && profileDraftSignature !== lastSavedProfileSignature,
    [profileForm, hardBarError, profileDraftSignature, lastSavedProfileSignature],
  );
  const jdDriftWarnings = useMemo(() => {
    if (!jdAiResult || !jdAiSource || !jdText.trim()) return [];
    return analyzeJdRecommendationRisk({
      jobTitle: job?.name || '',
      simpleNeed: jdAiSource.brief,
      jdDescription: jdAiSource.currentJd,
      optimizedText: jdText,
    }).driftWarnings || [];
  }, [job?.name, jdAiResult, jdAiSource, jdText]);
  const jd = workbench?.jd || { versions: [] };
  const profile = workbench?.profile || { versions: [] };
  const jdVersions = jd.versions || [];
  const profileVersions = profile.versions || [];
  const pendingJdDraft = !jd.active
    ? jdVersions.find((row) => row.status === 'draft') || null
    : null;
  const waitingProfileDraft = !profile.confirmed && !jd.active
    ? profileVersions.find((row) => {
      if (row.status !== 'draft') return false;
      const linkedJd = jdVersions.find((item) => Number(item.id) === Number(row.jd_version_id));
      return linkedJd?.status === 'draft';
    }) || null
    : null;
  const pendingProfileDraft = !profile.confirmed
    ? waitingProfileDraft
      || profileVersions.find((row) => row.status === 'draft' && !row.stale_for_active_jd)
      || null
    : null;
  const profileWaitsForLinkedDraftJd = !!waitingProfileDraft
    && Number(waitingProfileDraft.id) === Number(pendingProfileDraft?.id);
  const editorDirty = !!jdBrief.trim()
    || jdText !== jdEditorBaseline
    || profileDraftSignature !== profileEditorBaselineSignature;

  useEffect(() => {
    if (typeof onDirtyChange === 'function') onDirtyChange(editorDirty);
  }, [editorDirty, onDirtyChange]);

  useEffect(() => () => {
    if (typeof onDirtyChange === 'function') onDirtyChange(false);
  }, [currentJobId, onDirtyChange]);

  useEffect(() => {
    if (pendingJdDraft) {
      setJdHistoryActiveKeys((keys) => (keys.includes('jd-history') ? keys : [...keys, 'jd-history']));
    }
  }, [pendingJdDraft?.id]);

  useEffect(() => {
    if (pendingProfileDraft) {
      setProfileHistoryActiveKeys((keys) => (keys.includes('profile-history') ? keys : [...keys, 'profile-history']));
    }
  }, [pendingProfileDraft?.id, profileWaitsForLinkedDraftJd]);

  if (!job) return <Empty description="先选择岗位" />;
  if (!workbench) {
    const failed = loadState === 'error';
    return (
      <Alert
        type={failed ? 'error' : 'info'}
        showIcon
        message={failed ? '职位数据读取失败' : '正在加载职位数据'}
        description={loadError || (failed ? '请重试；错误不会被当作空数据。' : undefined)}
        action={failed ? <Button size="small" onClick={onRefresh}>重试</Button> : null}
      />
    );
  }
  if (workbench.data_class === 'fixture') return <Alert type="warning" showIcon message="Fixture 岗位仅用于离线验收" description="正式 JD、画像、漏斗和待办不会套用 Demo fallback。" />;

  function blockLockedWrite() {
    if (!writesLocked) return false;
    setError(readOnly
      ? '当前岗位为只读状态，未提交任何修改。'
      : '职位权威数据尚未就绪，写操作已锁定；重新读取成功前不会提交任何修改。');
    return true;
  }

  async function run(key, fn, successText) {
    if (blockLockedWrite()) return false;
    if (busy) return false;
    const operation = currentOperation();
    setBusy(key);
    setError('');
    setNotice('');
    setRefreshWarning('');
    try {
      await fn();
      if (!operationIsCurrent(operation)) return false;
      setNotice(`${successText} 正在刷新最新数据…`);
      try {
        await onRefresh();
      } catch (refreshError) {
        if (!operationIsCurrent(operation)) return false;
        const detail = refreshError?.message ? `（${refreshError.message}）` : '';
        setNotice('');
        setRefreshWarning(`${successText} 但页面暂未刷新${detail}；请稍后手动刷新，勿重复提交。`);
        return true;
      }
      if (!operationIsCurrent(operation)) return false;
      setNotice(successText);
      return true;
    } catch (err) {
      if (operationIsCurrent(operation)) {
        setError(err && err.message ? err.message : '操作失败，请重试。');
      }
      return false;
    } finally {
      if (operationIsCurrent(operation)) setBusy('');
    }
  }

  async function saveJdDraft() {
    const value = jdText.trim();
    if (!value) {
      setError('请先填写 JD。');
      return;
    }
    const saved = await run('jd-save', () => api.createJobJdVersion(job.id, value), 'JD 草稿已保存。请在版本记录中查看，确认无误后再启用。');
    if (saved) {
      setJdText(value);
      setLastSavedJdText(value);
      setJdEditorBaseline(value);
    }
  }

  async function optimizeJdWithAi(materialInput = null) {
    if (blockLockedWrite()) return;
    if (busy) return;
    const operation = currentOperation();
    const brief = String(materialInput?.brief ?? jdBrief).trim();
    const currentJd = String(materialInput?.currentJd ?? jdText).trim();
    if (!brief && !currentJd) {
      setError('请先用自然语言描述招聘需求，或粘贴一份需要优化的 JD。');
      return;
    }
    setBusy('jd-ai');
    setError('');
    setNotice('');
    try {
      const requestId = freshJdAiRequestId(job.id);
      const approval = await api.confirmExternalAiApproval(
        'job-jd-optimization',
        String(job.id),
        requestId,
        { jobId: job.id, brief, currentJd },
      );
      if (!operationIsCurrent(operation)) return;
      if (!approval.approved) {
        setNotice('已取消发送，现有 JD 内容没有变化。');
        return;
      }
      const response = await api.optimizeJobJd(job.id, brief, currentJd, approval);
      if (!operationIsCurrent(operation)) return;
      if (!response.draft || !String(response.draft.full_text || '').trim()) {
        throw new Error('AI 没有返回可编辑的 JD 草稿。');
      }
      setJdBeforeAi(jdTextRef.current);
      setJdText(response.draft.full_text);
      setJdAiResult(response.draft);
      setJdAiSource({ brief, currentJd });
      setNotice('AI 已生成可编辑草稿。请核对事实并修改，确认后再保存。');
    } catch (err) {
      if (operationIsCurrent(operation)) {
        setError(err && err.message ? err.message : 'AI 优化失败，请检查设置后重试。');
      }
    } finally {
      if (operationIsCurrent(operation)) setBusy('');
    }
  }

  async function requestJdAiOptimization() {
    if (blockLockedWrite() || busy || aiCapabilityChecking) return;
    const materialInput = {
      brief: jdBrief.trim(),
      currentJd: jdText.trim(),
    };
    if (!materialInput.brief && !materialInput.currentJd) {
      setError('请先用自然语言描述招聘需求，或粘贴一份需要优化的 JD。');
      return;
    }
    setAiCapabilityChecking(true);
    setError('');
    const access = await readExternalAiCapability('job_jd');
    setAiCapabilityChecking(false);
    if (access.available) {
      await optimizeJdWithAi(materialInput);
      return;
    }
    setAiFirstUseInput(materialInput);
    setAiFirstUseError(access.readable ? '' : access.error);
    setAiFirstUseOpen(true);
  }

  function continueJdManually() {
    setAiFirstUseOpen(false);
    setNotice('已保留当前招聘需求和 JD 内容，可继续手动编辑、保存并启用。');
    globalThis.setTimeout(() => document.getElementById('job-jd-editor')?.focus(), 0);
  }

  function openJdAiSettings() {
    const materialInput = aiFirstUseInput || {
      brief: jdBrief.trim(),
      currentJd: jdText.trim(),
    };
    setAiFirstUseOpen(false);
    onOpenAiSettings?.({
      capability: 'job_jd',
      source: 'job-management',
      sourceLabel: 'AI 优化 JD',
      targetId: job.id,
      targetLabel: job.name,
      focusTargetId: 'job-jd-ai-action',
      materialInput,
      draftSnapshot: {
        jdBrief,
        jdText,
        jdAiResult,
        jdAiSource,
        jdBeforeAi,
        profileForm,
        hardBarForm,
        assessmentPolicy,
        profileBaseConfig,
        activeSection,
      },
    });
  }

  useEffect(() => {
    if (
      aiResumeIntent?.capability !== 'job_jd'
      || String(aiResumeIntent.targetId) !== String(job?.id)
    ) return;
    const intent = aiResumeIntent;
    const materialInput = intent.materialInput || {};
    const snapshot = intent.draftSnapshot && typeof intent.draftSnapshot === 'object'
      ? intent.draftSnapshot
      : null;
    if (snapshot) {
      setJdBrief(String(snapshot.jdBrief || ''));
      setJdText(String(snapshot.jdText || ''));
      setJdAiResult(snapshot.jdAiResult || null);
      setJdAiSource(snapshot.jdAiSource || null);
      setJdBeforeAi(snapshot.jdBeforeAi == null ? null : String(snapshot.jdBeforeAi));
      if (snapshot.profileForm) setProfileForm(snapshot.profileForm);
      if (snapshot.hardBarForm) setHardBarForm(snapshot.hardBarForm);
      setAssessmentPolicy(String(snapshot.assessmentPolicy || 'not_required'));
      setProfileBaseConfig(snapshot.profileBaseConfig || {});
      setActiveSection(snapshot.activeSection === 'profile' ? 'profile' : 'jd');
    } else {
      if (Object.hasOwn(materialInput, 'brief')) setJdBrief(String(materialInput.brief || ''));
      if (Object.hasOwn(materialInput, 'currentJd')) setJdText(String(materialInput.currentJd || ''));
    }
    onAiResumeConsumed?.(intent.id);
    const resume = async () => {
      const focusTarget = () => {
        const target = document.getElementById(intent.focusTargetId || 'job-jd-ai-action');
        target?.focus({ preventScroll: false });
        target?.scrollIntoView?.({ block: 'nearest' });
      };
      focusTarget();
      if (intent.resumeAction !== false) await optimizeJdWithAi(materialInput);
      globalThis.requestAnimationFrame(focusTarget);
    };
    globalThis.setTimeout(() => { void resume(); }, 0);
  }, [aiResumeIntent?.id, job?.id]);

  function restoreJdBeforeAi() {
    if (jdBeforeAi === null) return;
    setJdText(jdBeforeAi);
    setJdBeforeAi(null);
    setJdAiResult(null);
    setJdAiSource(null);
    setError('');
    setNotice('已恢复 AI 优化前的 JD 正文。');
  }

  async function copyJdText() {
    if (!jdText.trim()) return;
    const operation = currentOperation();
    setError('');
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('当前系统剪贴板不可用。');
      }
      await navigator.clipboard.writeText(jdText);
      if (!operationIsCurrent(operation)) return;
      setNotice('JD 已复制。请由 HR 核对后手动使用。');
    } catch (err) {
      if (operationIsCurrent(operation)) {
        setError(err && err.message ? err.message : '复制失败。');
      }
    }
  }

  async function saveProfileDraft() {
    if (!profileHasContent(profileForm)) {
      setError('岗位画像至少填写一项。');
      return;
    }
    if (!jd.active) {
      setError('请先完成 JD 并启用，再保存岗位画像。');
      return;
    }
    if (hardBarError) {
      setError(hardBarError);
      return;
    }
    const saved = await run('profile-save', async () => {
      const config = buildProfileConfig(profileForm, hardBarForm, assessmentPolicy, profileBaseConfig);
      await api.createJobProfileVersion(job.id, config, jd.active.id);
    }, '岗位画像草稿已保存。请在版本记录中查看，确认无误后再确认画像。');
    if (saved) {
      setLastSavedProfileSignature(profileDraftSignature);
      setProfileEditorBaselineSignature(profileDraftSignature);
    }
  }

  function loadJdForEditing(row) {
    setJdText(row.jd_text || '');
    setJdEditorBaseline(row.jd_text || '');
    setLastSavedJdText(null);
    setJdAiResult(null);
    setJdAiSource(null);
    setJdBeforeAi(null);
    setError('');
    setNotice(`已载入 JD 第 ${row.version} 版。修改后保存会创建新草稿，不覆盖历史。`);
  }

  function loadProfileForEditing(row, waitsForLinkedDraftJd = false) {
    const nextForm = profileFormFromConfig(row.config);
    const nextHardBars = hardBarFormFromConfig(row.config);
    const nextAssessmentPolicy = normalizeAssessmentPolicy(row.config && row.config.assessment_policy);
    const nextBaseConfig = preservedProfileMetadata(row.config);
    setProfileForm(nextForm);
    setHardBarForm(nextHardBars);
    setAssessmentPolicy(nextAssessmentPolicy);
    setProfileBaseConfig(nextBaseConfig);
    setProfileEditorBaselineSignature(JSON.stringify(buildProfileConfig(
      nextForm,
      nextHardBars,
      nextAssessmentPolicy,
      nextBaseConfig,
    )));
    setLastSavedProfileSignature(null);
    setError('');
    setNotice(waitsForLinkedDraftJd
      ? `已载入岗位画像第 ${row.version} 版。绑定的是尚未启用的 JD 草稿；先启用对应 JD 后可直接确认这份画像草稿；若要编辑，请在启用 JD 后再保存。`
      : row.stale_for_active_jd
      ? `已载入岗位画像第 ${row.version} 版。该版本绑定旧 JD，请按当前 JD 修改后另存新草稿。`
      : `已载入岗位画像第 ${row.version} 版。修改后保存会创建新草稿，不覆盖历史。`);
  }

  const jdHistory = jdVersions.length ? [{
    key: 'jd-history',
    label: `版本记录（${jdVersions.length}）`,
    children: jdVersions.map((row) => (
      <div key={row.id} style={{ marginBottom: 14 }}>
        <Space wrap>
          <StatusTag status={row.status} />
          <Text>第 {row.version} 版 · {row.source === 'boss_sync' ? 'Boss 同步' : 'HR 手工录入'} · {fmtTime(row.created_at)}</Text>
          {!writesLocked && (
            <Button size="small" disabled={!!busy} onClick={() => loadJdForEditing(row)}>
              载入查看/修改
            </Button>
          )}
          {!writesLocked && row.status === 'draft' && (
            <Button
              size="small"
              disabled={!!busy}
              loading={busy === `jd-${row.id}`}
              onClick={() => actionAdapter.execute(JOB_MANAGEMENT_ACTION_SCHEMA.activateJdVersion.id, row)}
            >
              启用此版本
            </Button>
          )}
        </Space>
        <Paragraph style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{row.jd_text || '该版本没有可显示的 JD 内容。'}</Paragraph>
      </div>
    )),
  }] : [];

  const profileHistory = profileVersions.length ? [{
    key: 'profile-history',
    label: `版本记录（${profileVersions.length}）`,
    children: profileVersions.map((row) => {
      const linkedJd = jdVersions.find((item) => Number(item.id) === Number(row.jd_version_id));
      const waitsForLinkedDraftJd = row.status === 'draft' && linkedJd?.status === 'draft' && !jd.active;
      return (
        <div key={row.id} style={{ marginBottom: 14 }}>
          <Space wrap style={{ marginBottom: 6 }}>
            <StatusTag status={waitsForLinkedDraftJd ? 'draft' : row.stale_for_active_jd ? 'stale' : row.status} />
            <Text>第 {row.version} 版 · 关联 JD 第 {row.jd_version_id} 号记录 · {fmtTime(row.created_at)}</Text>
            {!writesLocked && (
              <Button size="small" disabled={!!busy} onClick={() => loadProfileForEditing(row, waitsForLinkedDraftJd)}>
                载入查看/修改
              </Button>
            )}
            {!writesLocked && row.status === 'draft' && !row.stale_for_active_jd && !waitsForLinkedDraftJd && (
              <Button
                size="small"
                disabled={!!busy}
                loading={busy === `profile-${row.id}`}
                onClick={() => actionAdapter.execute(JOB_MANAGEMENT_ACTION_SCHEMA.confirmProfileVersion.id, row)}
              >
                确认此版本
              </Button>
            )}
            {waitsForLinkedDraftJd ? (
              <Text type="warning">待启用对应 JD；启用后可直接确认这份画像草稿，不必另存。</Text>
            ) : row.status === 'draft' && row.stale_for_active_jd ? (
              <Text type="warning">绑定的不是当前 JD，请载入后另存新草稿。</Text>
            ) : null}
          </Space>
          <ProfileSummary config={row.config} />
        </div>
      );
    }),
  }] : [];

  const actionAdapter = createJobManagementActionAdapter({
    locked: writesLocked,
    handlers: {
      [JOB_MANAGEMENT_ACTION_SCHEMA.navigateSection.id]: setActiveSection,
      [JOB_MANAGEMENT_ACTION_SCHEMA.editDraft.id]: () => true,
      [JOB_MANAGEMENT_ACTION_SCHEMA.resetDraft.id]: restoreJdBeforeAi,
      [JOB_MANAGEMENT_ACTION_SCHEMA.optimizeJd.id]: requestJdAiOptimization,
      [JOB_MANAGEMENT_ACTION_SCHEMA.copyJd.id]: copyJdText,
      [JOB_MANAGEMENT_ACTION_SCHEMA.saveJdDraft.id]: saveJdDraft,
      [JOB_MANAGEMENT_ACTION_SCHEMA.activateJdVersion.id]: (row) => run(
        `jd-${row.id}`,
        () => api.activateJobJdVersion(row.id, row.version),
        'JD 草稿已启用。',
      ),
      [JOB_MANAGEMENT_ACTION_SCHEMA.saveProfileDraft.id]: saveProfileDraft,
      [JOB_MANAGEMENT_ACTION_SCHEMA.confirmProfileVersion.id]: (row) => run(
        `profile-${row.id}`,
        () => api.confirmJobProfileVersion(row.id, row.version),
        '岗位画像草稿已确认。',
      ),
      [JOB_MANAGEMENT_ACTION_SCHEMA.refreshData.id]: onRefresh,
    },
  });

  return (
    <JobManagementWorkspace
      title={job.name}
      status={job.status}
      mode="formal"
      readOnly={writesLocked}
      activeSection={activeSection}
      actionAdapter={actionAdapter}
      onReturnLedger={onReturnLedger}
      description="JD 与画像只保存在本机。"
    >
      {error && <Alert style={{ marginTop: 12 }} type="error" showIcon message="操作未完成" description={error} closable onClose={() => setError('')} />}
      {notice && <Alert style={{ marginTop: 12 }} type="success" showIcon message={notice} closable onClose={() => setNotice('')} />}
      {refreshWarning && <Alert style={{ marginTop: 12 }} type="warning" showIcon message="操作已完成，但页面暂未刷新" description={refreshWarning} closable onClose={() => setRefreshWarning('')} />}
      {authorityWriteLocked && (
        <Alert
          style={{ marginTop: 12 }}
          type={loadState === 'loading' ? 'info' : loadState === 'error' ? 'error' : 'warning'}
          showIcon
          role={loadState === 'loading' ? 'status' : 'alert'}
          aria-live={loadState === 'loading' ? 'polite' : 'assertive'}
          message={loadState === 'loading'
            ? '正在刷新职位权威数据，写操作暂时锁定'
            : loadState === 'error'
            ? '职位数据读取失败，写操作已锁定'
            : '当前显示上次成功读取的数据，写操作已锁定'}
          description={`${loadError ? `${loadError} ` : ''}旧 JD、岗位画像和版本记录仍可查看；重新读取成功前不会提交保存、启用或确认。`}
          action={loadState === 'loading' ? null : <Button size="small" onClick={onRefresh}>重新读取职位数据</Button>}
        />
      )}

      <div className="dashboard-main-grid" style={{ marginTop: 16 }}>
        {activeSection === 'jd' && (
        <Card title="第一步：填写并保存 JD 草稿">
          {jd.active ? (
            <>
              <Paragraph><StatusTag status="active" />第 {jd.active.version} 版 · {fmtTime(jd.active.activated_at)}</Paragraph>
              <Paragraph style={{ whiteSpace: 'pre-wrap' }}>{jd.active.jd_text}</Paragraph>
            </>
          ) : pendingJdDraft ? (
            <Alert
              type="info"
              showIcon
              message="已有 JD 草稿待检查并启用"
              description="这份草稿已保存在下方展开的版本记录中；可先载入修改，确认无误后再点击“启用此版本”。"
            />
          ) : (
            <Alert type="warning" showIcon message="还没有启用中的 JD" description="先保存草稿，在版本记录中查看无误后再点击“启用此版本”。" />
          )}

          {!writesLocked && (
            <div style={{ marginTop: 12 }}>
              <Text strong>先用平常说话描述招聘需求</Text>
              <Input.TextArea
                id="job-jd-editor"
                aria-label="自然语言招聘需求"
                rows={3}
                value={jdBrief}
                onChange={(event) => setJdBrief(event.target.value)}
                placeholder="例如：想招一个做过千川投放的人，能自己看数据、调计划、复盘素材；美妆经验优先，薪资和作息我还要再确认。"
                style={{ marginTop: 6 }}
              />
              <Space wrap style={{ marginTop: 10, marginBottom: 14 }}>
                <Button
                  id="job-jd-ai-action"
                  type="primary"
                  disabled={(!jdBrief.trim() && !jdText.trim()) || !!busy || aiCapabilityChecking}
                  loading={busy === 'jd-ai' || aiCapabilityChecking}
                  onClick={() => actionAdapter.execute(JOB_MANAGEMENT_ACTION_SCHEMA.optimizeJd.id)}
                >
                  AI 优化成 JD 草稿
                </Button>
                <Text type="secondary">会先让你确认是否发送；只生成草稿，不保存、不启用。</Text>
              </Space>

              {jdAiResult && (
                <div style={{ marginBottom: 14 }}>
                  {!!jdAiResult.missing_information?.length && (
                    <Alert
                      type="warning"
                      showIcon
                      message="AI 提醒：这些信息还需要 HR 确认"
                      description={jdAiResult.missing_information.slice(0, 6).map((item) => `${item.field}：${item.question}`).join('；')}
                    />
                  )}
                  {!!jdAiResult.compliance_warnings?.length && (
                    <Alert
                      style={{ marginTop: 8 }}
                      type="warning"
                      showIcon
                      message="发布前用词提醒"
                      description={jdAiResult.compliance_warnings.slice(0, 6).map((item) => `${item.issue}：${item.suggestion}`).join('；')}
                    />
                  )}
                  {!!jdDriftWarnings.length && (
                    <Alert
                      style={{ marginTop: 8 }}
                      type="warning"
                      showIcon
                      message="AI 改写可能漏掉了原始要求"
                      description={jdDriftWarnings.slice(0, 6).map((item) => `${item.title}：${item.desc}`).join('；')}
                    />
                  )}
                  <Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                    JD 漂移诊断适用范围：当前针对千川/电商岗位提示，其他岗位仅作基础检查。
                  </Text>
                  {!!jdAiResult.boss_keywords?.length && (
                    <div style={{ marginTop: 8 }}>
                      <Text strong>候选人搜索关键词建议：</Text>
                      {jdAiResult.boss_keywords.slice(0, 12).map((keyword) => <Tag key={keyword}>{keyword}</Tag>)}
                      <Text type="secondary">非任何招聘渠道官方权重或排名承诺。</Text>
                    </div>
                  )}
                  {jdBeforeAi !== null && (
                    <Button size="small" style={{ marginTop: 10 }} disabled={!!busy} onClick={restoreJdBeforeAi}>
                      恢复 AI 前文本
                    </Button>
                  )}
                </div>
              )}

              <Text strong>JD 正文</Text>
              <Input.TextArea
                aria-label="JD 正文"
                rows={6}
                value={jdText}
                onChange={(event) => setJdText(event.target.value)}
                placeholder="粘贴或填写岗位职责、任职要求等 JD 正文"
                style={{ marginTop: 6 }}
              />
              <Space wrap style={{ marginTop: 10 }}>
                <Button
                  type="primary"
                  disabled={!jdText.trim() || jdText.trim() === lastSavedJdText || !!busy}
                  loading={busy === 'jd-save'}
                  onClick={() => actionAdapter.execute(JOB_MANAGEMENT_ACTION_SCHEMA.saveJdDraft.id)}
                >
                  保存 JD 草稿
                </Button>
                <Button disabled={!jdText.trim() || !!busy} onClick={() => actionAdapter.execute(JOB_MANAGEMENT_ACTION_SCHEMA.copyJd.id)}>复制 JD</Button>
              </Space>
              <Text type="secondary" style={{ display: 'block', marginTop: 6 }}>保存不会自动启用；修改已保存版本时会创建新草稿。</Text>
            </div>
          )}

          {jdHistory.length ? (
            <Collapse
              ghost
              items={jdHistory}
              activeKey={jdHistoryActiveKeys}
              onChange={(keys) => setJdHistoryActiveKeys(Array.isArray(keys) ? keys : [keys].filter(Boolean))}
              style={{ marginTop: 12 }}
            />
          ) : <Text type="secondary">保存后可在这里查看历史版本。</Text>}
        </Card>
        )}

        {activeSection === 'profile' && (
        <Card title="第二步：填写并保存岗位画像草稿">
          {profile.confirmed ? (
            <>
              <Paragraph><StatusTag status="confirmed" />第 {profile.confirmed.version} 版 · {fmtTime(profile.confirmed.confirmed_at)}</Paragraph>
              <ProfileSummary config={profile.confirmed.config} />
            </>
          ) : pendingProfileDraft ? (
            <Alert
              type="info"
              showIcon
              message={profileWaitsForLinkedDraftJd ? '岗位画像草稿正在等待对应 JD' : '已有岗位画像草稿待确认'}
              description={profileWaitsForLinkedDraftJd
                ? '这份画像与上方已保存的 JD 草稿配套；请先启用对应 JD，刷新后可直接确认画像，不需要重复保存。'
                : '草稿已在下方展开；请核对与当前 JD 的绑定关系，确认无误后再确认此版本。'}
            />
          ) : profile.stale ? (
            <Alert
              type="warning"
              showIcon
              message="当前 JD 还没有已确认的岗位画像"
              description="JD 已切换；旧画像只作历史参考。请载入旧版内容，按当前 JD 修改后保存新草稿，并由 HR 确认。"
            />
          ) : (
            <Alert type="warning" showIcon message="还没有已确认的岗位画像" />
          )}

          {!jd.active && (
            <Alert
              style={{ marginTop: 12 }}
              type="info"
              showIcon
              message="请先完成上方 JD"
              description="JD 保存并启用后，才能保存岗位画像。"
            />
          )}

          {!writesLocked && (
            <div style={{ marginTop: 12 }}>
              {PROFILE_FIELDS.map((field) => (
                <div key={field.key} style={{ marginBottom: 12 }}>
                  <Text strong>{field.label}</Text>
                  {field.key === 'deal_breakers' && <Text type="secondary"> · 仅供 HR 判断，不自动淘汰</Text>}
                  <Input.TextArea
                    aria-label={field.label}
                    rows={3}
                    value={profileForm[field.key]}
                    onChange={(event) => setProfileForm((current) => ({ ...current, [field.key]: event.target.value }))}
                    placeholder={field.placeholder}
                    style={{ marginTop: 6 }}
                  />
                </div>
              ))}

              <Card size="small" title="测评报告策略" style={{ marginBottom: 12 }}>
                <Select
                  aria-label="测评报告策略"
                  style={{ width: '100%' }}
                  value={assessmentPolicy}
                  options={ASSESSMENT_POLICY_OPTIONS.map(({ value, label }) => ({ value, label }))}
                  onChange={setAssessmentPolicy}
                />
                <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                  {ASSESSMENT_POLICY_OPTIONS.find((item) => item.value === assessmentPolicy)?.description}
                  测评只作为 HR 核验材料；系统不会据此自动评分、排序、推进或淘汰。
                </Text>
              </Card>

              <Card size="small" title="客观门槛（默认关闭）" style={{ marginBottom: 12 }}>
                <Alert
                  type="info"
                  showIcon
                  message="只有 HR 主动启用的门槛才参与客观检查"
                  description="候选人学历、薪资或城市为 Unknown 时只提示人工确认，不判不符合；岗位画像里的“淘汰项”不会自动淘汰。"
                  style={{ marginBottom: 12 }}
                />
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <div>
                    <Space wrap>
                      <Text strong>学历门槛</Text>
                      <Switch
                        aria-label="启用学历门槛"
                        checked={hardBarForm.degree.enabled}
                        checkedChildren="启用"
                        unCheckedChildren="关闭"
                        onChange={(enabled) => setHardBarForm((current) => ({
                          ...current,
                          degree: { ...current.degree, enabled },
                        }))}
                      />
                    </Space>
                    <Select
                      aria-label="可接受学历"
                      mode="multiple"
                      style={{ width: '100%', marginTop: 6 }}
                      placeholder="选择可接受学历，例如本科、硕士、博士"
                      disabled={!hardBarForm.degree.enabled}
                      value={hardBarForm.degree.allowed}
                      options={DEGREE_OPTIONS}
                      onChange={(allowed) => setHardBarForm((current) => ({
                        ...current,
                        degree: { ...current.degree, allowed },
                      }))}
                    />
                  </div>

                  <div>
                    <Space wrap>
                      <Text strong>薪资门槛</Text>
                      <Switch
                        aria-label="启用薪资门槛"
                        checked={hardBarForm.salary.enabled}
                        checkedChildren="启用"
                        unCheckedChildren="关闭"
                        onChange={(enabled) => setHardBarForm((current) => ({
                          ...current,
                          salary: { ...current.salary, enabled },
                        }))}
                      />
                    </Space>
                    <div style={{ marginTop: 6 }}>
                      <Space.Compact>
                        <InputNumber
                          aria-label="月薪上限 K"
                          min={1}
                          precision={0}
                          disabled={!hardBarForm.salary.enabled}
                          value={hardBarForm.salary.cap_k}
                          onChange={(capK) => setHardBarForm((current) => ({
                            ...current,
                            salary: { ...current.salary, cap_k: capK },
                          }))}
                        />
                        <Button disabled aria-hidden="true">K / 月</Button>
                      </Space.Compact>
                    </div>
                  </div>

                  <div>
                    <Space wrap>
                      <Text strong>城市门槛</Text>
                      <Switch
                        aria-label="启用城市门槛"
                        checked={hardBarForm.city.enabled}
                        checkedChildren="启用"
                        unCheckedChildren="关闭"
                        onChange={(enabled) => setHardBarForm((current) => ({
                          ...current,
                          city: { ...current.city, enabled },
                        }))}
                      />
                    </Space>
                    <Select
                      aria-label="可接受城市"
                      mode="tags"
                      tokenSeparators={['，', ',', '、']}
                      style={{ width: '100%', marginTop: 6 }}
                      placeholder="输入城市后回车，例如杭州"
                      disabled={!hardBarForm.city.enabled}
                      value={hardBarForm.city.allowed}
                      options={hardBarForm.city.allowed.map((value) => ({ value, label: value }))}
                      onChange={(allowed) => setHardBarForm((current) => ({
                        ...current,
                        city: { ...current.city, allowed },
                      }))}
                    />
                  </div>
                </Space>
                {hardBarError && <Text type="danger" style={{ display: 'block', marginTop: 10 }}>{hardBarError}</Text>}
              </Card>

              <Text type="secondary">岗位职责、必须条件、加分项、淘汰项至少填写一项。画像只辅助 HR 判断，不会自动推进、录用或淘汰候选人。</Text>
              <br />
              <Button
                type="primary"
                style={{ marginTop: 10 }}
                disabled={!jd.active || !canSaveProfile || !!busy}
                loading={busy === 'profile-save'}
                onClick={() => actionAdapter.execute(JOB_MANAGEMENT_ACTION_SCHEMA.saveProfileDraft.id)}
              >
                保存岗位画像草稿
              </Button>
              <Text type="secondary" style={{ display: 'block', marginTop: 6 }}>保存不会自动确认；请在版本记录中查看内容后，再点击“确认此版本”。</Text>
            </div>
          )}

          {profileHistory.length ? (
            <Collapse
              ghost
              items={profileHistory}
              activeKey={profileHistoryActiveKeys}
              onChange={(keys) => setProfileHistoryActiveKeys(Array.isArray(keys) ? keys : [keys].filter(Boolean))}
              style={{ marginTop: 12 }}
            />
          ) : <Text type="secondary">保存后可在这里查看历史版本。</Text>}
        </Card>
        )}
      </div>
      <ExternalAiFirstUsePrompt
        open={aiFirstUseOpen}
        capability="job_jd"
        readError={aiFirstUseError}
        onEnable={openJdAiSettings}
        onManual={continueJdManually}
        onClose={() => {
          setAiFirstUseOpen(false);
          globalThis.setTimeout(() => document.getElementById('job-jd-ai-action')?.focus(), 0);
        }}
      />
    </JobManagementWorkspace>
  );
}
