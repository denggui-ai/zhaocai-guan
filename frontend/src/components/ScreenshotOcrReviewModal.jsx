import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  List,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Typography,
  App as AntApp,
} from 'antd';
import { api, screenshotOcrDraftPreviewUrl } from '../api.js';

const { Text, Title } = Typography;
const { TextArea } = Input;
const FIELDS = [
  ['name', '姓名', false],
  ['work_years', '工作年限', false],
  ['degree', '学历', false],
  ['age', '年龄', false],
  ['salary', '期望薪资', false],
  ['availability', '到岗状态', false],
  ['recent_focus', '最近关注', true],
  ['work_experience_text', '工作经历', true],
  ['education_text', '教育经历', true],
];

function draftValues(draft) {
  const current = draft && draft.current ? draft.current : {};
  return {
    name: current.name || '',
    ...(current.facts || {}),
  };
}

function traceFor(draft, key) {
  return draft && draft.field_evidence ? draft.field_evidence[key] || {} : {};
}

function confidenceLabel(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '未知';
}

export default function ScreenshotOcrReviewModal({ open, jobId, onClose, onConfirmed, onPendingCountChange }) {
  const { message, modal } = AntApp.useApp();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [hasLoadedSuccessfully, setHasLoadedSuccessfully] = useState(false);
  const [committedRefresh, setCommittedRefresh] = useState(null);
  const [saving, setSaving] = useState(false);
  const [drafts, setDrafts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [values, setValues] = useState({});
  const [nameVerifiedByHr, setNameVerifiedByHr] = useState(false);
  const [previewState, setPreviewState] = useState('idle');
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const loadContextRef = useRef('');
  const selected = useMemo(() => drafts.find((item) => item.id === selectedId) || drafts[0] || null, [drafts, selectedId]);
  const selectedNameTrace = traceFor(selected, 'name');
  const requiresNameVerification = Boolean(
    selected
    && selectedNameTrace.extraction_method === 'external_ai_vision_v1'
    && selectedNameTrace.trusted !== true,
  );
  const hasUnsavedChanges = useMemo(() => {
    if (!selected) return false;
    const baseline = draftValues(selected);
    return FIELDS.some(([key]) => String(values[key] ?? '') !== String(baseline[key] ?? ''));
  }, [selected, values]);
  const committedRefreshBlocked = committedRefresh?.context === loadContextRef.current
    && committedRefresh?.draftId === selected?.id;

  async function load(expectedContext = String(jobId || '')) {
    setLoading(true);
    try {
      const result = await api.listScreenshotOcrDrafts('pending_review', jobId || '');
      if (expectedContext !== loadContextRef.current) return false;
      const nextDrafts = result.drafts || [];
      setDrafts(nextDrafts);
      setLoadError('');
      setHasLoadedSuccessfully(true);
      setCommittedRefresh(null);
      onPendingCountChange?.(nextDrafts.length);
      setSelectedId((current) => nextDrafts.some((item) => item.id === current)
        ? current
        : (nextDrafts[0] || {}).id || null);
      return true;
    } catch (err) {
      if (expectedContext === loadContextRef.current) setLoadError(err && err.message ? err.message : '读取 OCR 草稿失败，请重试。');
      return false;
    } finally {
      if (expectedContext === loadContextRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    const nextContext = String(jobId || '');
    if (loadContextRef.current !== nextContext) {
      loadContextRef.current = nextContext;
      setDrafts([]);
      setSelectedId(null);
      setLoadError('');
      setHasLoadedSuccessfully(false);
      setCommittedRefresh(null);
      setSaving(false);
    }
    load(nextContext);
  }, [open, jobId]);

  useEffect(() => {
    setValues(draftValues(selected));
    setNameVerifiedByHr(false);
  }, [selected]);

  useEffect(() => {
    let disposed = false;
    let objectUrl = '';
    setPreviewUrl('');
    setPreviewError('');
    if (!open || !selected?.id || !requiresNameVerification) {
      setPreviewState('idle');
      return () => { disposed = true; };
    }
    setPreviewState('loading');
    screenshotOcrDraftPreviewUrl(selected.id)
      .then((url) => {
        if (disposed) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setPreviewUrl(url);
        setPreviewState('ready');
      })
      .catch((error) => {
        if (disposed) return;
        setPreviewState('error');
        setPreviewError(error?.message || 'OCR 草稿原图读取失败');
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, selected?.id, requiresNameVerification, previewAttempt]);

  function changesPayload() {
    return {
      name: values.name || '',
      facts: Object.fromEntries(FIELDS.filter(([key]) => key !== 'name').map(([key]) => [key, values[key] || null])),
    };
  }

  function requestSelectDraft(nextId) {
    if (!nextId || nextId === selected?.id || saving) return;
    const select = () => setSelectedId(nextId);
    if (!hasUnsavedChanges || committedRefreshBlocked) {
      select();
      return;
    }
    modal.confirm({
      title: '当前 OCR 修改尚未保存',
      content: '切换草稿会丢失当前编辑。如需保留，请先取消并点击“保存修改”。',
      okText: '放弃修改并切换',
      cancelText: '继续编辑',
      okButtonProps: { danger: true },
      onOk: select,
    });
  }

  function requestClose() {
    if (!hasUnsavedChanges || committedRefreshBlocked) {
      onClose?.();
      return;
    }
    modal.confirm({
      title: '当前 OCR 修改尚未保存',
      content: '关闭校对窗口会丢失当前编辑。',
      okText: '放弃修改并关闭',
      cancelText: '继续编辑',
      okButtonProps: { danger: true },
      onOk: () => onClose?.(),
    });
  }

  async function refreshAfterCommittedDraft(context, draftId, committedLabel) {
    const refreshed = await load(context);
    if (context !== loadContextRef.current) return false;
    if (refreshed) return true;
    setLoadError('');
    setCommittedRefresh({
      context,
      draftId,
      committedLabel,
      text: `${committedLabel}，但待校对列表刷新失败。当前显示提交前数据，请勿重复确认或驳回；请仅重试刷新。`,
    });
    return false;
  }

  async function retryCommittedRefresh() {
    const pending = committedRefresh;
    if (!pending || pending.context !== loadContextRef.current) return;
    const refreshed = await load(pending.context);
    if (pending.context !== loadContextRef.current || refreshed) return;
    setLoadError('');
    setCommittedRefresh((current) => current && current.context === pending.context
      ? { ...current, text: `${current.committedLabel}，但待校对列表仍未刷新。当前显示提交前数据，请勿重复确认或驳回；请稍后再次重试刷新。` }
      : current);
  }

  async function saveEdit() {
    if (!selected) return null;
    setSaving(true);
    try {
      const result = await api.editScreenshotOcrDraft(selected.id, changesPayload());
      setDrafts((current) => current.map((item) => (item.id === selected.id ? result.draft : item)));
      message.success('校对修改已保存并留痕。');
      return result.draft;
    } catch (err) {
      message.error(`保存失败：${err.message}`);
      return null;
    } finally {
      setSaving(false);
    }
  }

  // Rewrites the drafts on the server, so anything typed here and not yet saved
  // would be silently overwritten on reload. Make the HR resolve that first.
  async function runAiFill() {
    if (hasUnsavedChanges) {
      message.warning('当前有未保存的修改，请先保存或放弃后再让 AI 补全。');
      return;
    }
    const actionContext = loadContextRef.current;
    setSaving(true);
    try {
      const approval = await api.approveScreenshotOcrAiFill(jobId);
      if (!approval.approved) {
        message.info('已取消发送原截图，本次未执行 AI 补全。');
        return;
      }
      const { summary } = await api.aiFillScreenshotOcrDrafts(jobId, {
        requestId: approval.requestId,
        userApproval: approval.userApproval,
      });
      if (actionContext !== loadContextRef.current) return;
      if (summary.skipped_reason) {
        // The runtime already words each gap as an instruction ("请在设置页选择模型。"),
        // so pass those through rather than showing the HR a reason code.
        const blockers = (summary.blockers || []).join('');
        message.warning(blockers
          ? `AI 补全未执行：${blockers}`
          : `AI 补全未执行：${summary.skipped_reason}`);
        return;
      }
      await load(actionContext);
      const parts = [`补全 ${summary.filled} 项`, `确认 ${summary.corroborated} 项`];
      if (summary.failed) parts.push(`失败 ${summary.failed} 条`);
      if (summary.skipped_missing_file) parts.push(`${summary.skipped_missing_file} 条找不到原截图`);
      message.success(`AI 已读取 ${summary.attempted} 条草稿：${parts.join('，')}。补全结果仍需人工确认。`);
      // A batch where every read failed is a configuration or channel problem,
      // not a per-draft accident. Say what it was instead of just a count.
      if (summary.failed && summary.failed === summary.attempted && summary.failed_reason) {
        message.warning(`AI 补全全部失败：${summary.failed_reason}`);
      }
    } catch (err) {
      if (actionContext === loadContextRef.current) message.error(`AI 补全失败：${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDraft() {
    if (!selected) return;
    if (!String(values.name || '').trim()) {
      message.warning('姓名为空，不能确认。');
      return;
    }
    if (requiresNameVerification && previewState !== 'ready') {
      message.warning('请先加载并查看原始截图，再确认姓名。');
      return;
    }
    if (requiresNameVerification && !nameVerifiedByHr) {
      message.warning('请勾选“我已对照原图确认姓名”后再入库。');
      return;
    }
    const actionContext = loadContextRef.current;
    const draftId = selected.id;
    setSaving(true);
    try {
      await api.editScreenshotOcrDraft(draftId, changesPayload());
      const result = await api.confirmScreenshotOcrDraft(draftId, {
        name_verified_by_hr: requiresNameVerification && nameVerifiedByHr,
      });
      if (actionContext !== loadContextRef.current) return;
      message.success('已人工确认并写入正式候选人档案。');
      await refreshAfterCommittedDraft(actionContext, draftId, 'OCR 草稿已人工确认并写入正式候选人档案');
      if (onConfirmed) {
        try {
          await onConfirmed(result.draft.job_id);
        } catch (refreshError) {
          message.warning(`OCR 草稿已确认，但候选人列表刷新失败：${refreshError.message || '请稍后刷新本地数据。'}`);
        }
      }
    } catch (err) {
      if (actionContext === loadContextRef.current) message.error(`确认失败：${err.message}`);
    } finally {
      if (actionContext === loadContextRef.current) setSaving(false);
    }
  }

  async function rejectDraft() {
    if (!selected) return;
    const actionContext = loadContextRef.current;
    const draftId = selected.id;
    setSaving(true);
    try {
      await api.rejectScreenshotOcrDraft(draftId);
      if (actionContext !== loadContextRef.current) return;
      message.success('草稿已驳回，不会进入规则、搜索或候选人档案。');
      await refreshAfterCommittedDraft(actionContext, draftId, 'OCR 草稿已驳回');
    } catch (err) {
      if (actionContext === loadContextRef.current) message.error(`驳回失败：${err.message}`);
    } finally {
      if (actionContext === loadContextRef.current) setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      width={1040}
      centered
      title="OCR 人工校对"
      onCancel={requestClose}
      footer={selected ? [
        <Button key="ai-fill" disabled={saving || committedRefreshBlocked} onClick={runAiFill}>AI 补全字段</Button>,
        <Button key="save" disabled={saving || committedRefreshBlocked || !hasUnsavedChanges} onClick={saveEdit}>保存修改</Button>,
        requiresNameVerification ? (
          <Button
            key="confirm"
            type="primary"
            loading={saving}
            disabled={committedRefreshBlocked || previewState !== 'ready' || !nameVerifiedByHr}
            onClick={confirmDraft}
          >
            人工确认并入库
          </Button>
        ) : (
          <Button key="confirm" type="primary" loading={saving} disabled={committedRefreshBlocked} onClick={confirmDraft}>人工确认并入库</Button>
        ),
        <Popconfirm key="reject" disabled={saving || committedRefreshBlocked} title="确认驳回这条 OCR 草稿？" description="驳回后不会进入候选人、规则或搜索。" onConfirm={rejectDraft}>
          <Button danger disabled={committedRefreshBlocked}>驳回</Button>
        </Popconfirm>,
      ] : null}
      destroyOnHidden
      className="screenshot-ocr-review-modal"
      styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto', overscrollBehavior: 'contain', scrollbarGutter: 'stable' } }}
    >
      <Alert
        type="warning"
        showIcon
        message="OCR 只是一份待校对草稿"
        description="未确认或已驳回的内容不会进入正式候选人、简历、规则或搜索。置信度与冲突仅作提示，系统不会自动修正或自动确认。"
        style={{ marginBottom: 16 }}
      />
      {committedRefresh && committedRefresh.context === loadContextRef.current && (
        <Alert
          type="warning"
          showIcon
          message={committedRefresh.text}
          action={<Button loading={loading} onClick={retryCommittedRefresh}>重试刷新</Button>}
          style={{ marginBottom: 16 }}
        />
      )}
      {loadError && (
        <Alert
          type={hasLoadedSuccessfully ? 'warning' : 'error'}
          showIcon
          message={hasLoadedSuccessfully ? 'OCR 草稿刷新失败，当前显示上次成功数据' : 'OCR 草稿读取失败'}
          description={loadError}
          action={<Button loading={loading} onClick={() => load(loadContextRef.current)}>重试</Button>}
          style={{ marginBottom: 16 }}
        />
      )}
      <Spin spinning={loading || saving}>
        {loading && !hasLoadedSuccessfully ? <div style={{ minHeight: 120 }} /> : !hasLoadedSuccessfully ? null : !selected ? <Empty description="当前岗位没有待校对 OCR 草稿" /> : (
          <div className="screenshot-review-layout">
            <Card className="screenshot-review-list-card" size="small" title={`待校对 ${drafts.length} 条`}>
              <List
                role="listbox"
                aria-label="待校对 OCR 草稿"
                dataSource={drafts}
                renderItem={(item) => (
                  <List.Item
                    role="option"
                    aria-selected={item.id === selected.id}
                    tabIndex={0}
                    onClick={() => requestSelectDraft(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        requestSelectDraft(item.id);
                      }
                    }}
                    style={{ cursor: 'pointer', background: item.id === selected.id ? '#f0f5ff' : undefined, paddingInline: 8 }}
                  >
                    <Space direction="vertical" size={0}>
                      <Text strong>{item.current.name || '姓名待校对'}</Text>
                      <Text type="secondary">{item.job_name || `岗位 ${item.job_id}`}</Text>
                      <Tag color={(item.review_flags.fields || []).length ? 'orange' : 'blue'}>
                        {(item.review_flags.fields || []).length ? `${item.review_flags.fields.length} 项提示` : '待人工确认'}
                      </Tag>
                    </Space>
                  </List.Item>
                )}
              />
            </Card>
            <div>
              <Space style={{ marginBottom: 12 }}>
                <Text type="secondary">操作主体由桌面应用固定记录</Text>
                <Tag color="gold">待人工校对</Tag>
                {hasUnsavedChanges && !committedRefreshBlocked && <Tag color="orange">有未保存修改</Tag>}
              </Space>
              {selected.identity && selected.identity.status === 'pending_manual_merge' && (
                <Alert
                  type="warning"
                  showIcon
                  message="发现同岗位同名但内容不同的记录"
                  description="系统没有自动合并，请核对后把它作为独立候选人确认，或驳回本条。"
                  style={{ marginBottom: 10 }}
                />
              )}
              {selected.identity && selected.identity.status === 'insufficient' && (
                <Alert
                  type="info"
                  showIcon
                  message="身份信息不足"
                  description="当前只保留为待人工确认，不会仅凭姓名与其他记录合并。"
                  style={{ marginBottom: 10 }}
                />
              )}
              {requiresNameVerification && (
                <section className="screenshot-name-verification" aria-labelledby="screenshot-name-verification-heading">
                  <div className="screenshot-name-verification-head">
                    <div>
                      <Title id="screenshot-name-verification-heading" level={5}>对照原图确认姓名</Title>
                      <Text type="secondary">这条姓名来自外部 AI，且未通过可信版式定位，必须由 HR 对照原图确认。</Text>
                    </div>
                    {previewState === 'error' && (
                      <Button size="small" onClick={() => setPreviewAttempt((value) => value + 1)}>重试加载原图</Button>
                    )}
                  </div>
                  <div className="screenshot-name-preview" aria-busy={previewState === 'loading'}>
                    {previewState === 'loading' ? (
                      <div className="screenshot-name-preview-loading" role="status"><Spin size="small" /> 正在加载原始截图…</div>
                    ) : previewState === 'error' ? (
                      <Alert
                        className="screenshot-name-preview-error"
                        type="error"
                        showIcon
                        message="原始截图加载失败"
                        description={`${previewError}。请恢复导入时的原截图文件夹后重试；无法恢复时请重新导入并授权。`}
                      />
                    ) : previewUrl ? (
                      <img
                        src={previewUrl}
                        alt="当前 OCR 草稿的第一张原始截图，用于人工核对姓名"
                        onError={() => {
                          setPreviewState('error');
                          setPreviewError('原始截图无法显示，请重试加载。');
                          setNameVerifiedByHr(false);
                        }}
                      />
                    ) : null}
                  </div>
                  <Checkbox
                    checked={nameVerifiedByHr}
                    disabled={previewState !== 'ready'}
                    onChange={(event) => setNameVerifiedByHr(event.target.checked)}
                  >
                    我已对照原图确认姓名
                  </Checkbox>
                  <Text type="secondary" className="screenshot-name-verification-note">
                    此确认只证明你核对了当前姓名；其他字段仍按各自证据和校对结果入库。
                  </Text>
                </section>
              )}
              {FIELDS.map(([key, label, multiline]) => {
                const trace = traceFor(selected, key);
                const conflicts = trace.conflict_values || [];
                const rejectedValue = trace.rejected_value || '';
                const rejectedReason = trace.rejected_reason || '';
                const low = Number.isFinite(trace.confidence)
                  && trace.confidence < (selected.review_flags.confidence_warning_threshold || 0.8);
                return (
                  <Card key={key} size="small" style={{ marginBottom: 10 }}>
                    <Space wrap style={{ marginBottom: 6 }}>
                      <Text strong>{label}</Text>
                      <Tag color={low ? 'orange' : 'default'}>置信度 {confidenceLabel(trace.confidence)}</Tag>
                      {conflicts.length > 1 && <Tag color="red">冲突：{conflicts.join(' / ')}</Tag>}
                      {key === 'salary' && selected.normalized_facts && selected.normalized_facts.salary.status === 'normalized' && (
                        <Tag color="blue">统一为 {selected.normalized_facts.salary.normalized_text}</Tag>
                      )}
                    </Space>
                    {!!rejectedValue && (
                      <Alert
                        type="warning"
                        showIcon
                        message={`识别值“${rejectedValue}”未自动采用`}
                        description={rejectedReason || '该值未通过合理性校验，请对照原图人工填写。'}
                        style={{ marginBottom: 8 }}
                      />
                    )}
                    {multiline ? (
                      <TextArea aria-label={label} rows={key === 'work_experience_text' ? 4 : 2} value={values[key] || ''} onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))} />
                    ) : (
                      <Input aria-label={label}
                        value={values[key] || ''}
                        onChange={(event) => {
                          setValues((current) => ({ ...current, [key]: event.target.value }));
                          if (key === 'name') setNameVerifiedByHr(false);
                        }}
                      />
                    )}
                    {!!(trace.source_spans || []).length && (
                      <Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                        来源：{trace.source_spans.slice(0, 3).map((span) => `${span.source_file}#${span.line_index}: ${span.text}`).join('；')}
                      </Text>
                    )}
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </Spin>
    </Modal>
  );
}
