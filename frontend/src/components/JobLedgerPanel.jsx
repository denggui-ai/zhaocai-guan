import React, { useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Collapse,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { CopyOutlined, EditOutlined, FolderOpenOutlined, MoreOutlined, PlusOutlined } from '@ant-design/icons';
import { api, fmtTime } from '../api.js';

const { Paragraph, Title, Text } = Typography;

const JOB_STATUS = Object.freeze({
  draft: { label: '草稿', color: 'default' },
  open: { label: '招聘中', color: 'success' },
  paused: { label: '暂缓', color: 'warning' },
  closed: { label: '已关闭', color: 'error' },
});

const CREATE_STATUS_OPTIONS = [
  { value: 'draft', label: '草稿' },
  { value: 'open', label: '招聘中' },
  { value: 'paused', label: '暂缓' },
  { value: 'closed', label: '已关闭' },
];

const JOB_CLOSE_REASON_OPTIONS = [
  { value: 'filled', label: '招聘目标已完成' },
  { value: 'cancelled', label: '岗位取消' },
  { value: 'changed', label: '岗位需求已变化' },
  { value: 'long_pause', label: '长期暂停' },
  { value: 'other', label: '其他' },
];

const PRIMARY_TEMPLATE_FACT_COUNT = 4;

const JOB_FIELD_LABELS = Object.freeze({
  name: '岗位名称',
  hr_owner: 'HR 负责人',
  planned_hires: '计划 HC',
  department: '部门',
  location: '工作地点',
});

function parseChangeDetail(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function recentChangeSummary(job) {
  if (!job.last_change_action) return null;
  const detail = parseChangeDetail(job.last_change_detail_json);
  if (job.last_change_action === 'created') return '创建';
  if (job.last_change_action === '编辑岗位基础信息') {
    const fields = Array.isArray(detail.changed_fields)
      ? detail.changed_fields.map((field) => JOB_FIELD_LABELS[field]).filter(Boolean)
      : [];
    return fields.length ? `修改：${fields.join('、')}` : '编辑岗位信息';
  }
  if (job.last_change_action === '切换岗位状态') {
    const from = JOB_STATUS[detail.from_status]?.label || detail.from_status;
    const to = JOB_STATUS[detail.to_status]?.label || detail.to_status;
    return from && to ? `${from} → ${to}` : '切换岗位状态';
  }
  return job.last_change_action;
}

function changeActorLabel(value) {
  if (!value) return '';
  return value === 'local-primary-operator' ? '本地 HR' : value;
}

function JobStatusTag({ status }) {
  const meta = JOB_STATUS[status] || JOB_STATUS.draft;
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

function JobSourceTag({ job }) {
  if (job.is_fixture) return <Tag color="gold">测试数据</Tag>;
  if (job.source_type === 'boss_sync') return <Tag color="blue">Boss 同步</Tag>;
  return <Tag>本地岗位</Tag>;
}

function jobCloseReasonLabel(value) {
  return JOB_CLOSE_REASON_OPTIONS.find((item) => item.value === value)?.label || value || '未记录';
}

function jobReachedHiringTarget(job) {
  const planned = Number(job?.planned_hires || 0);
  return planned > 0 && Number(job?.accepted_offer_count || 0) >= planned;
}

function statusActions(status) {
  if (status === 'draft') return [
    { status: 'open', label: '开始招聘' },
    { status: 'closed', label: '关闭' },
  ];
  if (status === 'open') return [
    { status: 'paused', label: '暂缓' },
    { status: 'closed', label: '关闭' },
  ];
  if (status === 'paused') return [
    { status: 'open', label: '重新开启' },
    { status: 'closed', label: '关闭' },
  ];
  return [{ status: 'open', label: '重新开启' }];
}

function cleanHrFields(values, selectedVariant, location) {
  const source = values && typeof values === 'object' ? values : {};
  const allowed = new Set(selectedVariant?.hr_variables || []);
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = String(value || '').trim();
    if (allowed.has(key) && normalized) result[key] = normalized;
  }
  if (allowed.has('work_location') && String(location || '').trim()) {
    result.work_location = String(location).trim();
  }
  return result;
}

function templateSelectionKey(familyKey, variantKey) {
  return `${familyKey}::${variantKey}`;
}

function newCreateRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function focusFirstValidationError(targetForm, validationError) {
  const firstInvalidName = validationError?.errorFields?.[0]?.name;
  if (!firstInvalidName) return false;
  targetForm.scrollToField(firstInvalidName, { behavior: 'smooth', block: 'center' });
  const focusField = () => targetForm.getFieldInstance(firstInvalidName)?.focus?.({ preventScroll: true });
  if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(focusField);
  else globalThis.setTimeout(focusField, 0);
  return true;
}

function TemplateVariableFields({ fieldKeys, definitions }) {
  if (!fieldKeys.length) return null;
  return (
    <div className="job-ledger-form-grid">
      {fieldKeys.map((key) => {
        const definition = definitions[key] || { label: key, prompt: '请由 HR 补充真实信息。' };
        return (
          <Form.Item
            key={key}
            name={['hrFields', key]}
            label={`${definition.label}（可后补）`}
            extra={definition.prompt}
            rules={[{ max: 2000, message: `${definition.label}不能超过 2000 个字符` }]}
          >
            <Input.TextArea
              name={`job-template-hr-field-${key}`}
              autoComplete="off"
              autoSize={{ minRows: 1, maxRows: 3 }}
              placeholder="填写真实信息；尚未确定可留空…"
            />
          </Form.Item>
        );
      })}
    </div>
  );
}

function PreviewList({ title, items }) {
  if (!Array.isArray(items) || !items.length) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <Text strong>{title}</Text>
      <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}

function TemplateDraftPreview({ family, variant }) {
  if (!variant) return null;
  return (
    <Collapse
      size="small"
      items={[{
        key: 'template-preview',
        label: '预览职责、要求与画像草稿',
        children: (
          <div>
            <Paragraph style={{ marginBottom: 10 }}>
              <Text strong>岗位族：</Text>{family?.display_name || '—'}
              <br />
              <Text strong>职位分类提示：</Text>{(variant.boss_category_hint || []).join(' → ') || '—'}
            </Paragraph>
            <PreviewList title="核心职责草稿" items={variant.core_responsibilities_draft} />
            <PreviewList title="可选职责草稿" items={variant.optional_responsibilities_draft} />
            <PreviewList title="必须项建议（仍需 HR 核对）" items={variant.job_requirements_draft?.must_have} />
            <PreviewList title="加分项建议" items={variant.job_requirements_draft?.nice_to_have} />
            {variant.profile_draft?.role_mission && (
              <Paragraph style={{ marginBottom: 10 }}>
                <Text strong>画像使命草稿：</Text>{variant.profile_draft.role_mission}
              </Paragraph>
            )}
            <PreviewList title="面试关注点" items={variant.interview_focus} />
          </div>
        ),
      }]}
    />
  );
}

export default function JobLedgerPanel({
  jobs,
  jobId,
  loadState = 'ready',
  loadError = '',
  readOnly,
  onOpenJob,
  onJobsChanged,
  onRetry,
}) {
  const { message, modal } = AntApp.useApp();
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [templateForm] = Form.useForm();
  const [closeForm] = Form.useForm();
  const createRequestIdRef = useRef('');
  const templateCreateRequestIdRef = useRef('');
  const copyRequestIdByJobRef = useRef(new Map());
  const [createOpen, setCreateOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateCatalog, setTemplateCatalog] = useState(null);
  const [templateCatalogState, setTemplateCatalogState] = useState('idle');
  const [templateCatalogError, setTemplateCatalogError] = useState('');
  const [templateError, setTemplateError] = useState('');
  const [templateFamilyKey, setTemplateFamilyKey] = useState('');
  const [templateVariantKey, setTemplateVariantKey] = useState('');
  const [editJob, setEditJob] = useState(null);
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [hideClosed, setHideClosed] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [refreshWarning, setRefreshWarning] = useState('');
  const [committedPending, setCommittedPending] = useState([]);
  const committedRefreshTargetRef = useRef(null);
  const committedRefreshLocked = committedPending.length > 0;
  const authorityLoading = loadState === 'loading';
  const authorityError = loadState === 'error';
  const authorityWriteLocked = authorityLoading || authorityError;
  const initialAuthorityUnavailable = authorityWriteLocked && jobs.length === 0;

  function warnAuthorityUnavailable() {
    message.warning(authorityLoading
      ? '岗位台账仍在读取，写操作暂不可用。'
      : '岗位台账读取失败，请先重新读取；当前不会把未知状态当作空台账。');
  }

  const templateFamilies = templateCatalog?.families || [];
  const selectedTemplateFamily = useMemo(
    () => templateFamilies.find((family) => family.family_key === templateFamilyKey) || null,
    [templateFamilies, templateFamilyKey],
  );
  const selectedTemplateVariant = useMemo(
    () => (selectedTemplateFamily?.variants || []).find((variant) => variant.variant_key === templateVariantKey) || null,
    [selectedTemplateFamily, templateVariantKey],
  );
  const templateVariantCount = useMemo(
    () => templateFamilies.reduce((total, family) => total + (family.variants || []).length, 0),
    [templateFamilies],
  );
  const templateJobOptions = useMemo(
    () => templateFamilies.map((family) => ({
      label: `${family.display_name}（${family.variants.length} 个）`,
      options: family.variants.map((variant) => ({
        value: templateSelectionKey(family.family_key, variant.variant_key),
        label: variant.job_title,
      })),
    })),
    [templateFamilies],
  );
  const templateVariableDefinitions = templateCatalog?.hr_variable_definitions || {};
  const visibleTemplateVariables = (selectedTemplateVariant?.hr_variables || [])
    .filter((key) => key !== 'work_location');
  const primaryTemplateVariables = visibleTemplateVariables.slice(0, PRIMARY_TEMPLATE_FACT_COUNT);
  const deferredTemplateVariables = visibleTemplateVariables.slice(PRIMARY_TEMPLATE_FACT_COUNT);
  const selectedTemplateSelectionKey = selectedTemplateVariant
    ? templateSelectionKey(selectedTemplateFamily.family_key, selectedTemplateVariant.variant_key)
    : undefined;

  function openCreateModal() {
    if (authorityWriteLocked) {
      warnAuthorityUnavailable();
      return;
    }
    if (committedRefreshLocked) {
      message.warning('上一项岗位操作已提交但台账尚未刷新，请先重试刷新，勿重复提交。');
      return;
    }
    setError('');
    setRefreshWarning('');
    createRequestIdRef.current = newCreateRequestId();
    form.resetFields();
    form.setFieldsValue({
      name: '',
      hr_owner: '',
      planned_hires: 1,
      status: 'draft',
      department: '',
      location: '',
    });
    setCreateOpen(true);
  }

  async function loadTemplateCatalog(force = false) {
    if (!force && templateCatalog) return templateCatalog;
    setTemplateCatalogState('loading');
    setTemplateCatalogError('');
    try {
      const response = await api.listEcommerceJobTemplates();
      const catalog = response.catalog || response;
      if (!Array.isArray(catalog.families) || !catalog.families.length) {
        throw new Error('预置岗位目录为空。');
      }
      setTemplateCatalog(catalog);
      setTemplateCatalogState('ready');
      return catalog;
    } catch (err) {
      setTemplateCatalogState('error');
      setTemplateCatalogError(err && err.message ? err.message : '预置岗位目录读取失败。');
      return null;
    }
  }

  function openTemplateModal() {
    if (authorityWriteLocked) {
      warnAuthorityUnavailable();
      return;
    }
    if (committedRefreshLocked) {
      message.warning('上一项岗位操作已提交但台账尚未刷新，请先重试刷新，勿重复提交。');
      return;
    }
    setTemplateError('');
    setRefreshWarning('');
    setTemplateFamilyKey('');
    setTemplateVariantKey('');
    templateCreateRequestIdRef.current = newCreateRequestId();
    templateForm.resetFields();
    templateForm.setFieldsValue({
      name: '',
      hrOwner: '',
      plannedHires: 1,
      department: '',
      location: '',
      hrFields: {},
    });
    setTemplateOpen(true);
    void loadTemplateCatalog();
  }

  function selectTemplateJob(selectionKey) {
    let family = null;
    let variant = null;
    for (const candidateFamily of templateFamilies) {
      const candidateVariant = (candidateFamily.variants || [])
        .find((item) => templateSelectionKey(candidateFamily.family_key, item.variant_key) === selectionKey);
      if (candidateVariant) {
        family = candidateFamily;
        variant = candidateVariant;
        break;
      }
    }
    setTemplateFamilyKey(family?.family_key || '');
    setTemplateVariantKey(variant?.variant_key || '');
    setTemplateError('');
    // setFieldsValue merges nested objects, so assigning hrFields: {} leaves values
    // from the previously selected variant in Ant Form's preserved field store.
    templateForm.resetFields(['hrFields']);
    templateForm.setFieldValue('hrFields', undefined);
    templateForm.setFieldsValue({
      name: variant?.job_title || '',
    });
  }

  function offerJobSetupNextStep(job, sourceKind) {
    if (job.status === 'closed') return;
    const fromTemplate = sourceKind === 'template';
    const statusLabel = JOB_STATUS[job.status]?.label || job.status || JOB_STATUS.draft.label;
    modal.confirm({
      title: `“${job.name}”已创建（${statusLabel}）`,
      content: fromTemplate
        ? '下一步请检查 JD 和岗位画像。AI 优化 JD 仍可使用，但只会生成可编辑草稿，并会在每次发送前要求你确认。'
        : '下一步请填写 JD 和岗位画像。可以选择 AI 优化 JD，但它只会生成可编辑草稿，并会在每次发送前要求你确认。',
      okText: '继续完善 JD/画像',
      cancelText: '留在岗位台账',
      onOk: () => openJob(job),
    });
  }

  async function createTemplateJob() {
    if (authorityWriteLocked) {
      warnAuthorityUnavailable();
      return;
    }
    if (committedRefreshLocked) {
      message.warning('上一项岗位操作已提交但台账尚未刷新，请先重试刷新，勿重复提交。');
      return;
    }
    if (!selectedTemplateFamily || !selectedTemplateVariant) {
      setTemplateError('请先选择岗位族和具体岗位。');
      return;
    }
    let values;
    try {
      values = await templateForm.validateFields();
    } catch (err) {
      if (focusFirstValidationError(templateForm, err)) return;
      setTemplateError('请检查岗位基础信息。');
      return;
    }

    setBusy('template-create');
    setTemplateError('');
    let response;
    try {
      response = await api.createJobFromTemplate({
        createRequestId: templateCreateRequestIdRef.current || (templateCreateRequestIdRef.current = newCreateRequestId()),
        templateKey: selectedTemplateFamily.family_key,
        variantKey: selectedTemplateVariant.variant_key,
        name: String(values.name || '').trim(),
        hrOwner: String(values.hrOwner || '').trim(),
        plannedHires: Number(values.plannedHires),
        department: String(values.department || '').trim(),
        location: String(values.location || '').trim(),
        hrFields: cleanHrFields(values.hrFields, selectedTemplateVariant, values.location),
      });
    } catch (err) {
      setTemplateError(err && err.message ? err.message : '预置岗位草稿创建失败。');
      setBusy('');
      return;
    }

    const committedKey = 'template-create';
    markCommittedPending(committedKey, response.job.id);
    templateCreateRequestIdRef.current = '';
    setTemplateOpen(false);
    message.success(`已创建“${response.job.name}”及配套 JD/画像草稿；尚未启用、确认或发布。`, 6);
    let refreshed = false;
    try {
      await onJobsChanged(response.job.id);
      refreshed = true;
      setCommittedPendingKey(committedKey, false);
      committedRefreshTargetRef.current = null;
    } catch (err) {
      setRefreshWarning(`岗位已经创建，但台账自动刷新失败：${err && err.message ? err.message : '请手动刷新后查看。'}`);
    } finally {
      setBusy('');
    }
    if (refreshed) offerJobSetupNextStep(response.job, 'template');
  }

  async function createJob() {
    if (authorityWriteLocked) {
      warnAuthorityUnavailable();
      return;
    }
    if (committedRefreshLocked) {
      message.warning('上一项岗位操作已提交但台账尚未刷新，请先重试刷新，勿重复提交。');
      return;
    }
    let values;
    try {
      values = await form.validateFields();
    } catch (err) {
      if (focusFirstValidationError(form, err)) return;
      setError('请检查岗位基础信息。');
      return;
    }
    setBusy('create');
    setError('');
    setRefreshWarning('');
    values = {
      ...values,
      createRequestId: createRequestIdRef.current || (createRequestIdRef.current = newCreateRequestId()),
    };
    let response;
    try {
      response = await api.createLocalJob(values);
    } catch (err) {
      setError(err && err.message ? err.message : '岗位新建失败。');
      setBusy('');
      return;
    }
    createRequestIdRef.current = '';
    response = {
      ...response,
      job: {
        ...response.job,
        status: response.job.status || values.status || 'draft',
      },
    };
    const committedKey = 'create';
    markCommittedPending(committedKey, response.job.id);
    setCreateOpen(false);
    message.success(`已新建岗位“${response.job.name}”（${JOB_STATUS[response.job.status]?.label || response.job.status}）。`);
    let refreshed = false;
    try {
      await onJobsChanged(response.job.id);
      refreshed = true;
      setCommittedPendingKey(committedKey, false);
      committedRefreshTargetRef.current = null;
    } catch (err) {
      setRefreshWarning(`岗位已新建，但台账暂未刷新：${err && err.message ? err.message : '请手动刷新后查看。'}`);
    } finally {
      setBusy('');
    }
    if (refreshed) offerJobSetupNextStep(response.job, 'blank');
  }

  function openEditModal(job) {
    if (authorityWriteLocked) {
      warnAuthorityUnavailable();
      return;
    }
    if (committedRefreshLocked || committedPending.includes(`edit-${job.id}`)) {
      message.warning('岗位修改已提交但台账尚未刷新，请先重试刷新，勿重复提交。');
      return;
    }
    setError('');
    setRefreshWarning('');
    editForm.setFieldsValue({
      name: job.name || '',
      hr_owner: job.hr_owner || '',
      planned_hires: Number(job.planned_hires || 1),
      department: job.department || '',
      location: job.location || '',
    });
    setEditJob(job);
  }

  async function saveJobDetails() {
    if (!editJob) return;
    if (authorityWriteLocked) {
      warnAuthorityUnavailable();
      return;
    }
    if (committedRefreshLocked || committedPending.includes(`edit-${editJob.id}`)) {
      message.warning('岗位修改已提交但台账尚未刷新，请先重试刷新，勿重复提交。');
      return;
    }
    let values;
    try {
      values = await editForm.validateFields();
    } catch (err) {
      if (focusFirstValidationError(editForm, err)) return;
      setError('请检查岗位基础信息。');
      return;
    }
    const targetJob = editJob;
    const committedKey = `edit-${targetJob.id}`;
    setBusy(committedKey);
    setError('');
    setRefreshWarning('');
    let response;
    try {
      response = await api.updateJobDetails(targetJob.id, values);
    } catch (err) {
      setError(err && err.message ? err.message : '岗位信息更新失败。');
      setBusy('');
      return;
    }
    markCommittedPending(committedKey, jobId || response.job.id);
    setEditJob(null);
    message.success(`已更新岗位“${response.job.name}”。`);
    try {
      await onJobsChanged(jobId || response.job.id);
      setCommittedPendingKey(committedKey, false);
      committedRefreshTargetRef.current = null;
    } catch (err) {
      setRefreshWarning(`岗位信息已更新，但台账暂未刷新：${err && err.message ? err.message : '请手动刷新后查看。'}`);
    } finally {
      setBusy('');
    }
  }

  function setCommittedPendingKey(key, pending) {
    setCommittedPending((current) => pending
      ? (current.includes(key) ? current : [...current, key])
      : current.filter((item) => item !== key));
  }

  function markCommittedPending(key, refreshTarget) {
    committedRefreshTargetRef.current = refreshTarget ?? committedRefreshTargetRef.current;
    setCommittedPendingKey(key, true);
  }

  async function retryCommittedRefresh() {
    if (!committedPending.length || busy) return;
    setBusy('committed-refresh');
    try {
      await onJobsChanged(committedRefreshTargetRef.current ?? jobId);
      setCommittedPending([]);
      committedRefreshTargetRef.current = null;
      setRefreshWarning('');
      message.success('岗位台账已刷新；不会重放上一项岗位操作。');
    } catch (err) {
      setRefreshWarning(`操作已经完成，但台账仍未刷新：${err && err.message ? err.message : '请稍后再次重试刷新，勿重复提交。'}`);
    } finally {
      setBusy('');
    }
  }

  function confirmCopy(job) {
    if (authorityWriteLocked) {
      warnAuthorityUnavailable();
      return;
    }
    if (committedRefreshLocked || committedPending.includes(`copy-${job.id}`)) {
      message.warning('岗位复制已提交但台账尚未刷新，请先重试刷新，勿重复复制。');
      return;
    }
    const sourceJobId = Number(job.id);
    const requestId = copyRequestIdByJobRef.current.get(sourceJobId) || newCreateRequestId();
    copyRequestIdByJobRef.current.set(sourceJobId, requestId);
    let copiedJobName = '';
    modal.confirm({
      title: `复制“${job.name}”`,
      content: '将复制岗位基础信息及当前 JD/画像为一个本地草稿；候选人、面试、处置和历史事件不会复制。',
      okText: '复制为新草稿',
      cancelText: '取消',
      onOk: async () => {
        const key = `copy-${job.id}`;
        setBusy(key);
        setError('');
        setRefreshWarning('');
        let response;
        try {
          response = await api.copyJob(job.id, { requestId });
        } catch (err) {
          setError(err && err.message ? err.message : '岗位复制失败。');
          throw err;
        } finally {
          setBusy('');
        }
        copyRequestIdByJobRef.current.delete(sourceJobId);
        markCommittedPending(key, response.job.id);
        copiedJobName = response.job.name;
        void onJobsChanged(response.job.id).then(() => {
          setCommittedPendingKey(key, false);
          committedRefreshTargetRef.current = null;
        }).catch((err) => {
          setRefreshWarning(`岗位已复制，但台账暂未刷新：${err && err.message ? err.message : '请手动刷新后查看。'}`);
        });
      },
      // The success notice waits for afterClose so it never fires under the
      // still-closing confirm dialog.
      afterClose: () => {
        if (copiedJobName) message.success(`已创建“${copiedJobName}”。`);
      },
    });
  }

  function confirmStatus(job, action) {
    if (authorityWriteLocked) {
      warnAuthorityUnavailable();
      return;
    }
    if (committedRefreshLocked || committedPending.includes(`status-${job.id}`)) {
      message.warning('岗位状态已提交但台账尚未刷新，请先重试刷新，勿重复提交。');
      return;
    }
    const destructive = action.status === 'closed';
    let statusChanged = false;
    modal.confirm({
      title: `${action.label}“${job.name}”`,
      content: destructive
        ? (
          <div style={{ display: 'grid', gap: 10 }}>
            <Text>关闭岗位不会删除候选人、JD、画像、测评、面试、Offer 或招聘历史，之后仍可重新开启。</Text>
            <Form form={closeForm} layout="vertical" preserve={false}>
              <Form.Item
                label="关闭原因"
                name="closeReason"
                rules={[{ required: true, message: '请选择关闭原因后再确认。' }]}
              >
                <Select
                  aria-label="岗位关闭原因"
                  placeholder="请选择关闭原因"
                  options={JOB_CLOSE_REASON_OPTIONS}
                  style={{ width: '100%' }}
                />
              </Form.Item>
              <Form.Item label="关闭备注（可选）" name="closeNote">
                <Input.TextArea
                  aria-label="岗位关闭备注"
                  placeholder="补充说明（可选，最多 500 字）"
                  maxLength={500}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                />
              </Form.Item>
            </Form>
          </div>
        )
        : action.status === 'paused'
          ? '暂缓只改变岗位台账状态，不会自动改变任何候选人状态。'
          : job.status === 'draft'
            ? '开始招聘只改变岗位台账状态，不会自动改变任何候选人状态。'
            : '重新开启只恢复岗位为招聘中，不会自动改变任何候选人状态。',
      okText: action.label,
      cancelText: '取消',
      okButtonProps: destructive ? { danger: true } : {},
      onOk: async () => {
        const closeValues = destructive ? await closeForm.validateFields() : {};
        const key = `status-${job.id}`;
        setBusy(key);
        setError('');
        setRefreshWarning('');
        try {
          await api.updateJobStatus(job.id, action.status, {
            closeReason: closeValues.closeReason || '',
            closeNote: closeValues.closeNote || '',
          });
        } catch (err) {
          setError(err && err.message ? err.message : '岗位状态更新失败。');
          throw err;
        } finally {
          setBusy('');
        }
        markCommittedPending(key, jobId || job.id);
        statusChanged = true;
        void onJobsChanged(jobId || job.id).then(() => {
          setCommittedPendingKey(key, false);
          committedRefreshTargetRef.current = null;
        }).catch((err) => {
          setRefreshWarning(`岗位状态已更新，但台账暂未刷新：${err && err.message ? err.message : '请手动刷新后查看。'}`);
        });
      },
      // The success notice waits for afterClose so it never fires under the
      // still-closing confirm dialog.
      afterClose: () => {
        if (statusChanged) message.success(`岗位已${action.label}。`);
      },
    });
  }

  async function openJob(job, focusAction = 'manage') {
    setBusy(`open-${job.id}`);
    setError('');
    try {
      await onOpenJob(job.id, {
        jobId: String(job.id),
        action: focusAction === 'name' ? 'name' : 'manage',
      });
    } catch (err) {
      setError(err && err.message ? err.message : '岗位打开失败。');
    } finally {
      setBusy('');
    }
  }

  function renderJobActions(job) {
    const statusItems = statusActions(job.status);
    const shouldPromptClose = job.status === 'open' && jobReachedHiringTarget(job);
    const menuItems = [
      {
        key: 'edit',
        label: '编辑岗位信息',
        icon: <EditOutlined aria-hidden="true" />,
        disabled: authorityWriteLocked || committedRefreshLocked || committedPending.includes(`edit-${job.id}`),
      },
      {
        key: 'copy',
        label: '复制岗位',
        icon: <CopyOutlined aria-hidden="true" />,
        disabled: authorityWriteLocked || committedRefreshLocked || committedPending.includes(`copy-${job.id}`),
      },
      { type: 'divider' },
      ...statusItems.map((action) => ({
        key: `status:${action.status}`,
        label: action.label,
        danger: action.status === 'closed',
        disabled: authorityWriteLocked || !!busy || committedRefreshLocked || committedPending.includes(`status-${job.id}`),
      })),
    ];
    return (
      <Space className="job-ledger-row-actions" size={6} wrap>
        <Button
          size="small"
          data-job-ledger-focus-job-id={String(job.id)}
          data-job-ledger-focus-action="manage"
          aria-label={`管理 ${job.name || `岗位 ${job.id}`} 的 JD 和画像`}
          icon={<FolderOpenOutlined aria-hidden="true" />}
          onClick={() => openJob(job, 'manage')}
        >
          管理 JD/画像
        </Button>
        {!readOnly && !job.is_fixture && shouldPromptClose && (
          <Button
            size="small"
            type="primary"
            disabled={authorityWriteLocked || !!busy || committedRefreshLocked || committedPending.includes(`status-${job.id}`)}
            title="已接受 Offer 人数达到计划 HC；请由 HR 决定是否关闭岗位，不会自动关闭。"
            onClick={() => confirmStatus(job, { status: 'closed', label: '关闭' })}
          >
            招聘达标，关闭岗位
          </Button>
        )}
        {!readOnly && !job.is_fixture && (
          <Dropdown
            trigger={['click']}
            menu={{
              items: menuItems,
              onClick: ({ key }) => {
                if (key === 'edit') openEditModal(job);
                else if (key === 'copy') confirmCopy(job);
                else if (key.startsWith('status:')) {
                  const action = statusItems.find((item) => item.status === key.slice('status:'.length));
                  if (action) confirmStatus(job, action);
                }
              },
            }}
          >
            <Button
              size="small"
              aria-label={`打开 ${job.name || `岗位 ${job.id}`} 的更多操作`}
              disabled={authorityWriteLocked || committedRefreshLocked}
              title={authorityWriteLocked
                ? '岗位台账尚未完成权威读取，请先重新读取'
                : committedRefreshLocked ? '上一项岗位操作已提交，请先重试刷新' : undefined}
              loading={[`edit-${job.id}`, `copy-${job.id}`, `status-${job.id}`].includes(busy)}
              icon={<MoreOutlined aria-hidden="true" />}
            >
              更多
            </Button>
          </Dropdown>
        )}
      </Space>
    );
  }

  const columns = useMemo(() => [
    {
      title: '岗位',
      dataIndex: 'name',
      key: 'name',
      width: 260,
      fixed: 'left',
      render: (_, job) => (
        <div className="job-ledger-name">
          <Button
            type="link"
            className="job-ledger-open-link"
            data-job-ledger-focus-job-id={String(job.id)}
            data-job-ledger-focus-action="name"
            onClick={() => openJob(job, 'name')}
            loading={busy === `open-${job.id}`}
          >
            {job.name || `岗位 ${job.id}`}
          </Button>
          <Space size={4} wrap>
            <JobSourceTag job={job} />
            {String(job.id) === String(jobId) && <Tag color="cyan">当前上下文</Tag>}
          </Space>
          {(job.department || job.location) && (
            <Text type="secondary" className="job-ledger-name-meta">
              {[job.department, job.location].filter(Boolean).join(' · ')}
            </Text>
          )}
        </div>
      ),
    },
    { title: '状态', dataIndex: 'status', key: 'status', width: 96, render: (status) => <JobStatusTag status={status} /> },
    {
      title: '剩余 HC',
      dataIndex: 'remaining_hires',
      key: 'remaining_hires',
      width: 96,
      align: 'center',
      render: (value, job) => Number(job.over_hires) > 0
        ? <Text type="danger">超编 {job.over_hires}</Text>
        : <Text type={Number(value) === 0 ? 'success' : undefined}>{value}</Text>,
    },
    {
      title: '最近变更',
      key: 'last_change',
      width: 184,
      render: (_, job) => {
        const summary = recentChangeSummary(job);
        return summary ? (
          <div className="job-ledger-recent-change">
            <Text className="job-ledger-recent-change-line">{summary}</Text>
            <Text type="secondary" className="job-ledger-recent-change-line">{fmtTime(job.last_change_at)}{job.last_change_who ? ` · ${changeActorLabel(job.last_change_who)}` : ''}</Text>
          </div>
        ) : <Text type="secondary">暂无变更记录</Text>;
      },
    },
    { title: 'HR 负责人', dataIndex: 'hr_owner', key: 'hr_owner', width: 124, render: (value) => value || '—' },
    { title: '计划 HC', dataIndex: 'planned_hires', key: 'planned_hires', width: 88, align: 'center' },
    { title: '已录用', dataIndex: 'hired_count', key: 'hired_count', width: 88, align: 'center' },
    { title: '已接受 Offer', dataIndex: 'accepted_offer_count', key: 'accepted_offer_count', width: 116, align: 'center' },
    { title: '已移交入职', dataIndex: 'onboarding_handoff_count', key: 'onboarding_handoff_count', width: 112, align: 'center' },
    { title: '候选人数', dataIndex: 'candidate_count', key: 'candidate_count', width: 96, align: 'center' },
    {
      title: '关闭信息',
      key: 'close_info',
      width: 220,
      render: (_, job) => job.status === 'closed' ? (
        <div className="job-ledger-recent-change">
          <Text>{jobCloseReasonLabel(job.close_reason_code)}</Text>
          {job.close_note && <Text type="secondary" className="job-ledger-recent-change-line">{job.close_note}</Text>}
        </div>
      ) : <Text type="secondary">—</Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: readOnly ? 164 : 216,
      fixed: 'right',
      render: (_, job) => renderJobActions(job),
    },
  ], [authorityWriteLocked, busy, committedPending, committedRefreshLocked, jobId, readOnly]);

  const totals = jobs.reduce((summary, job) => ({
    jobs: summary.jobs + 1,
    open: summary.open + (job.status === 'open' ? 1 : 0),
    planned: summary.planned + Number(job.planned_hires || 0),
    hired: summary.hired + Number(job.hired_count || 0),
  }), { jobs: 0, open: 0, planned: 0, hired: 0 });

  const filteredJobs = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return jobs.filter((job) => {
      if (hideClosed && job.status === 'closed') return false;
      if (statusFilter !== 'all' && job.status !== statusFilter) return false;
      if (!query) return true;
      return [job.name, job.hr_owner, job.department, job.location]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [hideClosed, jobs, searchText, statusFilter]);

  return (
    <section className="job-ledger-page" style={{ minWidth: 0, width: '100%', maxWidth: '100%' }}>
      <div className="job-ledger-hero">
        <div>
          <Title level={2} className="job-ledger-hero-title" aria-hidden="true">职位管理</Title>
          <Text type="secondary" className="job-ledger-hero-copy">先从全部岗位台账进入具体岗位。</Text>
        </div>
        {!readOnly && (
          <Space wrap>
            <Button icon={<PlusOutlined />} disabled={authorityWriteLocked || committedRefreshLocked} onClick={openCreateModal}>
              空白新建
            </Button>
            <Button type="primary" icon={<PlusOutlined />} disabled={authorityWriteLocked || committedRefreshLocked} onClick={openTemplateModal}>
              从预置岗位开始
            </Button>
          </Space>
        )}
      </div>

      {initialAuthorityUnavailable && authorityLoading && (
        <div className="job-ledger-authority-loading" role="status" aria-live="polite" aria-label="正在读取岗位台账">
          <Skeleton active title={{ width: '32%' }} paragraph={{ rows: 6, width: ['96%', '90%', '94%', '82%', '88%', '70%'] }} />
        </div>
      )}

      {initialAuthorityUnavailable && authorityError && (
        <Alert
          className="job-ledger-authority-error"
          role="alert"
          type="error"
          showIcon
          message="岗位台账读取失败"
          description={`${loadError || '当前无法确认岗位台账。'} 错误不会被当作空台账，恢复前创建、编辑、复制和状态写操作保持锁定。`}
          action={<Button onClick={onRetry}>重新读取岗位台账</Button>}
        />
      )}

      {!initialAuthorityUnavailable && authorityWriteLocked && (
        <Alert
          className="job-ledger-authority-stale"
          role={authorityError ? 'alert' : 'status'}
          aria-live={authorityError ? 'assertive' : 'polite'}
          type={authorityError ? 'warning' : 'info'}
          showIcon
          message={authorityError ? '岗位台账读取失败，当前显示上次成功数据' : '正在刷新岗位台账，当前显示上次成功数据'}
          description={authorityError
            ? `${loadError || '当前无法确认最新岗位台账。'} 恢复前创建、编辑、复制和状态写操作保持锁定。`
            : '权威读取完成前，创建、编辑、复制和状态写操作暂不可用。'}
          action={authorityError ? <Button onClick={onRetry}>重新读取岗位台账</Button> : null}
        />
      )}

      {error && (
        <Alert
          role="alert"
          type="error"
          showIcon
          closable
          message="岗位操作未完成"
          description={error}
          onClose={() => setError('')}
        />
      )}

      {refreshWarning && (
        <Alert
          role="status"
          aria-live="polite"
          type="warning"
          showIcon
          closable={!committedRefreshLocked}
          message="操作已完成，但台账暂未刷新"
          description={`${refreshWarning}${committedRefreshLocked ? ' 当前相关写操作已锁定；请先重试刷新，勿重复提交。' : ''}`}
          action={committedRefreshLocked ? (
            <Button size="small" loading={busy === 'committed-refresh'} onClick={retryCommittedRefresh}>
              重试刷新
            </Button>
          ) : null}
          onClose={() => setRefreshWarning('')}
        />
      )}

      {!initialAuthorityUnavailable && <><div className="job-ledger-summary" aria-label="岗位汇总">
        <Card className="job-ledger-summary-card" classNames={{ body: 'job-ledger-summary-card-body' }} size="small"><Text type="secondary">全部岗位</Text><strong>{totals.jobs}</strong></Card>
        <Card className="job-ledger-summary-card" classNames={{ body: 'job-ledger-summary-card-body' }} size="small"><Text type="secondary">招聘中</Text><strong>{totals.open}</strong></Card>
        <Card className="job-ledger-summary-card" classNames={{ body: 'job-ledger-summary-card-body' }} size="small"><Text type="secondary">计划 HC</Text><strong>{totals.planned}</strong></Card>
        <Card className="job-ledger-summary-card" classNames={{ body: 'job-ledger-summary-card-body' }} size="small"><Text type="secondary">已录用</Text><strong>{totals.hired}</strong></Card>
      </div>

      <div className="job-ledger-filters" role="search" aria-label="岗位筛选">
        <Input
          aria-label="搜索岗位"
          name="job-ledger-search"
          autoComplete="off"
          spellCheck={false}
          allowClear
          value={searchText}
          placeholder="搜索岗位名称、负责人、部门或地点…"
          onChange={(event) => setSearchText(event.target.value)}
        />
        <Select
          aria-label="按岗位状态筛选"
          value={statusFilter}
          options={[
            { value: 'all', label: '全部状态' },
            ...Object.entries(JOB_STATUS).map(([value, meta]) => ({ value, label: meta.label })),
          ]}
          onChange={(value) => {
            setStatusFilter(value);
            if (value === 'closed') setHideClosed(false);
          }}
        />
        <Checkbox checked={hideClosed} onChange={(event) => setHideClosed(event.target.checked)}>
          隐藏已关闭
        </Checkbox>
        <Text type="secondary">显示 {filteredJobs.length} / {jobs.length}</Text>
      </div>

      <ul className="job-ledger-compact-list" aria-label="岗位台账卡片列表">
        {filteredJobs.length ? filteredJobs.map((ledgerJob) => {
          const recentChange = recentChangeSummary(ledgerJob);
          return (
            <li
              className="job-ledger-compact-item"
              key={ledgerJob.id}
              aria-current={String(ledgerJob.id) === String(jobId) ? 'page' : undefined}
            >
              <div className="job-ledger-compact-head">
                <div className="job-ledger-name">
                  <Button
                    type="link"
                    className="job-ledger-open-link"
                    data-job-ledger-focus-job-id={String(ledgerJob.id)}
                    data-job-ledger-focus-action="name"
                    onClick={() => openJob(ledgerJob, 'name')}
                    loading={busy === `open-${ledgerJob.id}`}
                  >
                    {ledgerJob.name || `岗位 ${ledgerJob.id}`}
                  </Button>
                  {(ledgerJob.department || ledgerJob.location) && (
                    <Text type="secondary" className="job-ledger-name-meta">
                      {[ledgerJob.department, ledgerJob.location].filter(Boolean).join(' · ')}
                    </Text>
                  )}
                </div>
                <Space size={4} wrap>
                  <JobStatusTag status={ledgerJob.status} />
                  <JobSourceTag job={ledgerJob} />
                  {String(ledgerJob.id) === String(jobId) && <Tag color="cyan">当前上下文</Tag>}
                </Space>
              </div>

              <dl className="job-ledger-compact-facts">
                <div>
                  <dt>剩余 HC</dt>
                  <dd>{Number(ledgerJob.over_hires) > 0 ? <Text type="danger">超编 {ledgerJob.over_hires}</Text> : ledgerJob.remaining_hires}</dd>
                </div>
                <div><dt>计划 HC</dt><dd>{ledgerJob.planned_hires}</dd></div>
                <div><dt>已录用</dt><dd>{ledgerJob.hired_count}</dd></div>
                <div><dt>已接受 Offer</dt><dd>{ledgerJob.accepted_offer_count || 0}</dd></div>
                <div><dt>已移交入职</dt><dd>{ledgerJob.onboarding_handoff_count || 0}</dd></div>
                <div><dt>候选人数</dt><dd>{ledgerJob.candidate_count}</dd></div>
                <div><dt>HR 负责人</dt><dd>{ledgerJob.hr_owner || '—'}</dd></div>
              </dl>

              {ledgerJob.status === 'closed' && (
                <Alert
                  type="info"
                  showIcon
                  message={`关闭原因：${jobCloseReasonLabel(ledgerJob.close_reason_code)}`}
                  description={ledgerJob.close_note ? `备注：${ledgerJob.close_note}` : '未填写关闭备注。'}
                />
              )}

              <div className="job-ledger-compact-change">
                <Text type="secondary">最近变更</Text>
                {recentChange ? (
                  <span>
                    <Text>{recentChange}</Text>
                    <Text type="secondary">{fmtTime(ledgerJob.last_change_at)}{ledgerJob.last_change_who ? ` · ${changeActorLabel(ledgerJob.last_change_who)}` : ''}</Text>
                  </span>
                ) : <Text type="secondary">暂无变更记录</Text>}
              </div>

              <div className="job-ledger-compact-actions">
                {renderJobActions(ledgerJob)}
              </div>
            </li>
          );
        }) : (
          <li className="job-ledger-compact-empty">
            <Empty description={jobs.length ? '没有符合筛选条件的岗位。' : '还没有岗位。可选择“空白新建”或“从预置岗位开始”。'} />
          </li>
        )}
      </ul>

      <Card className="job-ledger-table-card" styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filteredJobs}
          pagination={false}
          scroll={{ x: readOnly ? 1680 : 1760 }}
          locale={{ emptyText: jobs.length ? '没有符合筛选条件的岗位。' : '还没有岗位。可选择“空白新建”或“从预置岗位开始”。' }}
        />
      </Card>
      </>}

      <Modal
        title="从预置岗位开始"
        open={templateOpen}
        width={920}
        okText="创建岗位和两份草稿"
        cancelText="取消"
        confirmLoading={busy === 'template-create'}
        okButtonProps={{
          disabled: templateCatalogState !== 'ready'
            || !selectedTemplateFamily
            || !selectedTemplateVariant,
        }}
        styles={{ body: { maxHeight: '70vh', overflowY: 'auto', overscrollBehavior: 'contain', scrollbarGutter: 'stable' } }}
        onOk={createTemplateJob}
        onCancel={() => !busy && setTemplateOpen(false)}
      >
        <Alert
          type="info"
          showIcon
          message="只创建本地可编辑草稿"
          description="本次会原子创建普通岗位草稿、JD 草稿和绑定该 JD 的画像草稿；不会启用 JD、不会确认画像，也不会调用 AI。创建后进入“管理 JD/画像”，仍可按需使用 AI 优化 JD 草稿。"
          style={{ marginBottom: 16 }}
        />

        {templateCatalogState === 'loading' && (
          <Alert role="status" aria-live="polite" type="info" showIcon message="正在读取本地预置岗位目录…" style={{ marginBottom: 16 }} />
        )}
        {templateCatalogState === 'error' && (
          <Alert
            role="alert"
            type="error"
            showIcon
            message="预置岗位目录读取失败"
            description={templateCatalogError || '请重试；错误不会被当作空目录。'}
            action={<Button size="small" onClick={() => loadTemplateCatalog(true)}>重试</Button>}
            style={{ marginBottom: 16 }}
          />
        )}
        {templateError && (
          <Alert
            role="alert"
            type="error"
            showIcon
            closable
            message="草稿创建未完成"
            description={templateError}
            onClose={() => setTemplateError('')}
            style={{ marginBottom: 16 }}
          />
        )}

        {templateCatalogState === 'ready' && (
          <Form form={templateForm} layout="vertical" requiredMark="optional">
            <Form.Item
              label={`搜索具体岗位（${templateVariantCount} 个，按 ${templateFamilies.length} 个岗位族分组）`}
              required
              extra="可以直接输入岗位名称，也可以展开后按岗位族浏览；岗位族只是查找分组，不是平台或职级。"
            >
              <Select
                showSearch
                aria-label="搜索预置具体岗位"
                value={selectedTemplateSelectionKey}
                placeholder="输入岗位名称，例如：直播运营、会计、客服主管"
                optionFilterProp="label"
                options={templateJobOptions}
                onChange={selectTemplateJob}
              />
            </Form.Item>

            {selectedTemplateVariant && (
              <>
                <Space wrap style={{ marginBottom: 12 }}>
                  <Tag color="blue">岗位族：{selectedTemplateFamily.display_name}</Tag>
                  <Tag>具体岗位：{selectedTemplateVariant.job_title}</Tag>
                </Space>
                <TemplateDraftPreview family={selectedTemplateFamily} variant={selectedTemplateVariant} />

                <Title level={5} style={{ marginTop: 18 }}>岗位基础信息</Title>
                <div className="job-ledger-form-grid">
                  <Form.Item name="name" label="岗位名称" rules={[{ required: true, message: '请输入岗位名称' }, { max: 120 }]}>
                    <Input name="job-template-name" autoComplete="off" placeholder="可在预置岗位名基础上补充类目或业务线…" />
                  </Form.Item>
                  <Form.Item name="hrOwner" label="HR 负责人" rules={[{ required: true, message: '请输入 HR 负责人' }, { max: 80 }]}>
                    <Input name="job-template-hr-owner" autoComplete="off" placeholder="例如：张三…" />
                  </Form.Item>
                  <Form.Item name="plannedHires" label="计划 HC" rules={[{ required: true, message: '请输入计划 HC' }]}>
                    <InputNumber name="job-template-planned-hires" autoComplete="off" inputMode="numeric" min={1} max={10000} precision={0} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="department" label="部门（可选）" rules={[{ max: 120 }]}>
                    <Input name="job-template-department" autoComplete="off" placeholder="例如：电商运营部…" />
                  </Form.Item>
                  <Form.Item
                    name="location"
                    label="工作地点"
                    rules={[{ required: true, message: '请输入真实工作地点' }, { max: 120 }]}
                    extra={templateVariableDefinitions.work_location?.prompt}
                  >
                    <Input name="job-template-location" autoComplete="off" placeholder="例如：杭州；远程岗位请填写真实安排…" />
                  </Form.Item>
                </div>

                <Title level={5} style={{ marginTop: 8 }}>优先补充的岗位事实</Title>
                <Paragraph type="secondary">
                  先显示模板排在前面的 {primaryTemplateVariables.length} 项事实；尚未确定可以留空，服务端会标为待补充，不会擅自补写事实或生成硬门槛。
                </Paragraph>
                <TemplateVariableFields fieldKeys={primaryTemplateVariables} definitions={templateVariableDefinitions} />

                {!!deferredTemplateVariables.length && (
                  <Collapse
                    size="small"
                    style={{ marginBottom: 16 }}
                    items={[{
                      key: 'deferred-template-facts',
                      label: `其余 ${deferredTemplateVariables.length} 项岗位事实（可创建后补充）`,
                      children: (
                        <TemplateVariableFields fieldKeys={deferredTemplateVariables} definitions={templateVariableDefinitions} />
                      ),
                    }]}
                  />
                )}

                <Alert
                  type="warning"
                  showIcon
                  message="创建后仍需 HR 完成两个明确动作"
                  description="请进入“管理 JD/画像”检查内容；需要时可先让 AI 优化 JD 草稿，再由 HR 保存并启用 JD，最后确认与该 JD 绑定的岗位画像。只有草稿不会启动招聘。"
                />
              </>
            )}
          </Form>
        )}
      </Modal>

      <Modal
        title="本地新建岗位"
        open={createOpen}
        okText="创建岗位"
        cancelText="取消"
        confirmLoading={busy === 'create'}
        onOk={createJob}
        onCancel={() => !busy && setCreateOpen(false)}
      >
        <Alert
          type="info"
          showIcon
          message="只写入本机 SQLite"
          description="创建后可独立维护 JD、画像和候选人关系。"
          style={{ marginBottom: 16 }}
        />
        <Form form={form} layout="vertical" requiredMark="optional">
          <Form.Item name="name" label="岗位名称" rules={[{ required: true, message: '请输入岗位名称' }, { max: 120 }]}>
            <Input name="job-create-name" autoComplete="off" placeholder="例如：电商投放经理…" autoFocus />
          </Form.Item>
          <div className="job-ledger-form-grid">
            <Form.Item name="hr_owner" label="HR 负责人" rules={[{ required: true, message: '请输入 HR 负责人' }, { max: 80 }]}>
              <Input name="job-create-hr-owner" autoComplete="off" placeholder="例如：张三…" />
            </Form.Item>
            <Form.Item name="planned_hires" label="计划 HC" rules={[{ required: true, message: '请输入计划 HC' }]}>
              <InputNumber name="job-create-planned-hires" autoComplete="off" inputMode="numeric" min={1} max={10000} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </div>
          <Form.Item name="status" label="岗位状态" rules={[{ required: true }]}>
            <Select options={CREATE_STATUS_OPTIONS} />
          </Form.Item>
          <div className="job-ledger-form-grid">
            <Form.Item name="department" label="部门（可选）" rules={[{ max: 120 }]}>
            <Input name="job-create-department" autoComplete="off" placeholder="例如：增长中心…" />
            </Form.Item>
            <Form.Item name="location" label="工作地点（可选）" rules={[{ max: 120 }]}>
            <Input name="job-create-location" autoComplete="off" placeholder="例如：杭州…" />
            </Form.Item>
          </div>
        </Form>
      </Modal>

      <Modal
        title={`编辑岗位${editJob ? `“${editJob.name}”` : ''}`}
        open={!!editJob}
        okText="保存修改"
        cancelText="取消"
        confirmLoading={!!editJob && busy === `edit-${editJob.id}`}
        onOk={saveJobDetails}
        onCancel={() => !busy && setEditJob(null)}
      >
        <Form form={editForm} layout="vertical" requiredMark="optional">
          <Form.Item name="name" label="岗位名称" rules={[{ required: true, message: '请输入岗位名称' }, { max: 120 }]}>
            <Input name="job-edit-name" autoComplete="off" />
          </Form.Item>
          <div className="job-ledger-form-grid">
            <Form.Item name="hr_owner" label="HR 负责人" rules={[{ required: true, message: '请输入 HR 负责人' }, { max: 80 }]}>
              <Input name="job-edit-hr-owner" autoComplete="off" />
            </Form.Item>
            <Form.Item name="planned_hires" label="计划 HC" rules={[{ required: true, message: '请输入计划 HC' }]}>
              <InputNumber name="job-edit-planned-hires" autoComplete="off" inputMode="numeric" min={1} max={10000} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </div>
          <div className="job-ledger-form-grid">
            <Form.Item name="department" label="部门（可选）" rules={[{ max: 120 }]}>
              <Input name="job-edit-department" autoComplete="off" />
            </Form.Item>
            <Form.Item name="location" label="工作地点（可选）" rules={[{ max: 120 }]}>
              <Input name="job-edit-location" autoComplete="off" />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </section>
  );
}
