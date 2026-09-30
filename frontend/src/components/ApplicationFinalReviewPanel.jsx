import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Empty, Input, Modal, Select, Space, Spin, Tag, Typography } from 'antd';
import { api, fmtTime } from '../api.js';

const { Text, Title } = Typography;
const { TextArea } = Input;
const DISPOSITIONS = [
  { value: 'continue_process', label: '继续流程' },
  { value: 'hold', label: '暂缓' },
  { value: 'reject', label: '不推进' },
  { value: 'talent_pool', label: '进入人才库' },
];
const DEFAULT_DISPOSITION = 'continue_process';
const DEFAULT_DISPOSITION_REASON = 'manual_final_disposition';
const ASSESSMENT_REPORT_LABELS = {
  career_potential: '职业潜力',
  workplace_style: '职场风格',
  team_role: '团队角色',
};
const FORBIDDEN_AI_DRAFT_TEXT = /(?:得分|评分|百分比|\d+(?:\.\d+)?\s*%|权重|排名|排序|自动(?:录用|淘汰|决策|处置)|建议(?:录用|淘汰))/i;

function requestId(prefix) {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${id}`;
}

function parseReview(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function emptyDraft() {
  return { decision_summary: '', strengths: '', risks: '', limitations: '', evidence_refs: [] };
}

function editableDraft(value) {
  const parsed = parseReview(value);
  return {
    ...emptyDraft(),
    decision_summary: String(parsed.decision_summary || ''),
    strengths: String(parsed.strengths || ''),
    risks: String(parsed.risks || ''),
    limitations: String(parsed.limitations || ''),
    evidence_refs: Array.isArray(parsed.evidence_refs) ? parsed.evidence_refs : [],
  };
}

function draftFingerprint(value) {
  const draft = editableDraft(value);
  return JSON.stringify({
    decision_summary: draft.decision_summary,
    strengths: draft.strengths,
    risks: draft.risks,
    limitations: draft.limitations,
  });
}

function safeAiDraftPoints(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => String(item?.point || '').trim())
    .filter((item) => item && !FORBIDDEN_AI_DRAFT_TEXT.test(item))
    .slice(0, 6);
}

function dispositionFingerprint(value, reason) {
  return JSON.stringify({
    disposition: String(value || DEFAULT_DISPOSITION),
    reason: String(reason || ''),
  });
}

export default function ApplicationFinalReviewPanel({ candidate, readOnly, onWorkflowChanged, onDirtyChange }) {
  const { message } = AntApp.useApp();
  const contextKey = candidate ? `${candidate.internal_id}:${candidate.job_id}` : '';
  const contextRef = useRef(contextKey);
  const stateContextRef = useRef('');
  const sequenceRef = useRef(0);
  const savedDraftFingerprintRef = useRef(draftFingerprint(emptyDraft()));
  const draftValueRef = useRef(emptyDraft());
  const savedDispositionFingerprintRef = useRef(dispositionFingerprint(DEFAULT_DISPOSITION, DEFAULT_DISPOSITION_REASON));
  const dispositionValueRef = useRef({ disposition: DEFAULT_DISPOSITION, reason: DEFAULT_DISPOSITION_REASON });
  const [, refreshDirtyState] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [disposition, setDisposition] = useState(DEFAULT_DISPOSITION);
  const [reason, setReason] = useState(DEFAULT_DISPOSITION_REASON);

  const active = state?.active_application || null;
  const review = state?.current_review || null;
  const confirmedReview = review?.status === 'confirmed' ? review : state?.confirmed_review || null;
  const editable = review && ['draft', 'reopened'].includes(review.status) ? review : null;
  const applications = state?.applications || [];
  const prerequisites = state?.prerequisites || {};
  const confirmedAssessments = Array.isArray(prerequisites.confirmed_assessments)
    ? prerequisites.confirmed_assessments
    : [];
  const currentAssessmentAiAnalysis = prerequisites.current_assessment_ai_analysis?.current === true
    ? prerequisites.current_assessment_ai_analysis
    : null;

  async function load(expectedContext = contextKey) {
    if (!candidate || expectedContext !== contextRef.current) return;
    const sequence = ++sequenceRef.current;
    const candidateId = candidate.internal_id;
    const jobId = candidate.job_id;
    setLoading(true);
    setLoadError('');
    try {
      const result = await api.getF018State(candidateId, jobId);
      if (sequence !== sequenceRef.current || expectedContext !== contextRef.current) return;
      stateContextRef.current = expectedContext;
      setState(result.state || result);
      return true;
    } catch (error) {
      if (sequence === sequenceRef.current && expectedContext === contextRef.current) {
        setLoadError(error.message || '终评状态读取失败');
      }
      return false;
    } finally {
      if (sequence === sequenceRef.current && expectedContext === contextRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    contextRef.current = contextKey;
    stateContextRef.current = '';
    sequenceRef.current += 1;
    setState(null);
    setLoadError('');
    const nextDraft = emptyDraft();
    const nextDisposition = { disposition: DEFAULT_DISPOSITION, reason: DEFAULT_DISPOSITION_REASON };
    draftValueRef.current = nextDraft;
    savedDraftFingerprintRef.current = draftFingerprint(nextDraft);
    dispositionValueRef.current = nextDisposition;
    savedDispositionFingerprintRef.current = dispositionFingerprint(nextDisposition.disposition, nextDisposition.reason);
    setDraft(nextDraft);
    setDisposition(nextDisposition.disposition);
    setReason(nextDisposition.reason);
    onDirtyChange?.(false);
    if (contextKey) load(contextKey);
    else setLoading(false);
  }, [contextKey]);

  useEffect(() => {
    if (stateContextRef.current !== contextKey) return;
    const nextDraft = editable ? editableDraft(editable.review_json) : emptyDraft();
    const currentFingerprint = draftFingerprint(draftValueRef.current);
    if (currentFingerprint !== savedDraftFingerprintRef.current) return;
    draftValueRef.current = nextDraft;
    savedDraftFingerprintRef.current = draftFingerprint(nextDraft);
    setDraft(nextDraft);
  }, [contextKey, editable?.id, editable?.version, editable?.review_json]);

  useEffect(() => {
    if (stateContextRef.current !== contextKey) return;
    const currentValue = dispositionValueRef.current;
    const currentFingerprint = dispositionFingerprint(currentValue.disposition, currentValue.reason);
    if (currentFingerprint !== savedDispositionFingerprintRef.current) return;
    const nextValue = { disposition: DEFAULT_DISPOSITION, reason: DEFAULT_DISPOSITION_REASON };
    dispositionValueRef.current = nextValue;
    savedDispositionFingerprintRef.current = dispositionFingerprint(nextValue.disposition, nextValue.reason);
    setDisposition(nextValue.disposition);
    setReason(nextValue.reason);
  }, [contextKey, confirmedReview?.id, confirmedReview?.version, state?.disposition?.id]);

  const draftDirty = draftFingerprint(draft) !== savedDraftFingerprintRef.current;
  const dispositionDirty = dispositionFingerprint(disposition, reason) !== savedDispositionFingerprintRef.current;
  const workspaceDirty = draftDirty || dispositionDirty;
  const writesBlocked = readOnly || busy || loading || Boolean(loadError);

  useEffect(() => {
    onDirtyChange?.(workspaceDirty);
  }, [workspaceDirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const stateIsCurrent = contextRef.current === contextKey;
  const canConfirm = Boolean(
    editable
    && prerequisites.confirmed_interview_report_id
    && prerequisites.assessment_requirement_met !== false,
  );
  const dispositionLabel = useMemo(() => (
    DISPOSITIONS.find((item) => item.value === disposition)?.label || disposition
  ), [disposition]);

  function updateDraftField(field, value) {
    setDraft((current) => {
      const nextDraft = { ...current, [field]: value };
      draftValueRef.current = nextDraft;
      return nextDraft;
    });
  }

  function applyAssessmentAiDraft() {
    const analysis = currentAssessmentAiAnalysis?.analysis || {};
    const strengths = safeAiDraftPoints(analysis.strengths);
    const risks = safeAiDraftPoints(analysis.risks);
    const contradictions = safeAiDraftPoints(analysis.contradictions);
    const questions = (Array.isArray(analysis.interview_questions) ? analysis.interview_questions : [])
      .map((item) => String(item?.question || '').trim())
      .filter((item) => item && !FORBIDDEN_AI_DRAFT_TEXT.test(item))
      .slice(0, 4);
    const nextDraft = {
      ...draft,
      decision_summary: `已参考当前获批的 AI 测评分析：提取 ${strengths.length} 项优势、${risks.length} 项风险和 ${contradictions.length} 项待核实点。请 HR 对照原始岗位、面试和测评证据改写最终结论。`,
      strengths: strengths.join('\n'),
      risks: risks.join('\n'),
      limitations: [...contradictions, ...questions.map((item) => `待核实：${item}`)].join('\n'),
    };
    draftValueRef.current = nextDraft;
    setDraft(nextDraft);
    message.info('已把现有 AI 分析转换为不含分数和自动处置建议的可编辑草稿；保存与确认仍需 HR 操作。');
  }

  function updateDisposition(value) {
    dispositionValueRef.current = { ...dispositionValueRef.current, disposition: value };
    setDisposition(value);
  }

  function updateDispositionReason(value) {
    dispositionValueRef.current = { ...dispositionValueRef.current, reason: value };
    setReason(value);
  }

  function markSubmittedFormBaseline(form, submittedValue) {
    if (form === 'draft') {
      savedDraftFingerprintRef.current = draftFingerprint(submittedValue || draftValueRef.current);
    }
    if (form === 'disposition') {
      const currentValue = submittedValue || dispositionValueRef.current;
      savedDispositionFingerprintRef.current = dispositionFingerprint(currentValue.disposition, currentValue.reason);
    }
    refreshDirtyState((current) => current + 1);
  }

  async function runAction(work, success, { committedForm = '', committedValue = null } = {}) {
    const expectedContext = contextKey;
    if (expectedContext !== contextRef.current) return;
    setBusy(true);
    let committed = false;
    try {
      if (expectedContext !== contextRef.current) return;
      await work();
      committed = true;
      if (expectedContext !== contextRef.current) return;
      if (committedForm) markSubmittedFormBaseline(committedForm, committedValue);
      message.success(success);
      if (onWorkflowChanged) {
        try {
          await onWorkflowChanged(candidate.internal_id, candidate.job_id);
        } catch (error) {
          message.warning(`操作已提交，但候选人队列或时间线刷新失败：${error.message || '请稍后重试读取。'}`);
        }
      }
      if (expectedContext === contextRef.current) await load(expectedContext);
    } catch (error) {
      if (expectedContext === contextRef.current) {
        if (committed) {
          setLoadError(`操作已提交，但最新状态刷新失败：${error.message || '未知错误'}`);
          message.warning('操作已提交，但最新状态刷新失败，请点击重试。');
        } else {
          message.error(error.message);
        }
      }
    } finally {
      if (expectedContext === contextRef.current) setBusy(false);
    }
  }

  function confirmAction(title, content, work, success, danger = false, runOptions = {}) {
    Modal.confirm({
      title,
      content,
      okText: '确认执行',
      cancelText: '取消',
      okButtonProps: { danger },
      onOk: () => runAction(work, success, runOptions),
    });
  }

  function applicationCommand(action) {
    if (action === 'open') {
      return api.openF018Application({
        candidate_id: candidate.internal_id, job_id: candidate.job_id,
        request_id: requestId('f018-open'), reason_code: 'manual_application_opened',
      });
    }
    const input = {
      application_id: active?.id || applications[0]?.id,
      expected_version: (active || applications[0])?.version,
      request_id: requestId(`f018-${action}`),
      reason_code: `manual_application_${action}`,
      candidate_id: candidate.internal_id,
      job_id: candidate.job_id,
    };
    return api.transitionF018Application(action, input);
  }

  async function saveDraft() {
    if (!active) return;
    const evidence = [];
    if (prerequisites.confirmed_job_profile_id) evidence.push({ source_type: 'job_profile', source_id: prerequisites.confirmed_job_profile_id });
    if (prerequisites.confirmed_interview_report_id) evidence.push({ source_type: 'interview_report', source_id: prerequisites.confirmed_interview_report_id });
    confirmedAssessments.forEach((item) => evidence.push({
      source_type: 'assessment_document',
      source_id: item.id,
    }));
    const input = {
      application_id: active.id,
      final_review_id: editable?.id,
      job_profile_version_id: prerequisites.confirmed_job_profile_id,
      interview_report_id: prerequisites.confirmed_interview_report_id || null,
      assessment_document_ids: confirmedAssessments.map((item) => item.id),
      review_json: { ...draft, evidence_refs: evidence },
      expected_version: editable?.version || 0,
      request_id: requestId(editable ? 'f018-review-update' : 'f018-review-create'),
      candidate_id: candidate.internal_id,
      job_id: candidate.job_id,
    };
    await runAction(
      () => (editable ? api.updateF018FinalReview(input) : api.createF018FinalReview(input)),
      '终评草稿已保存，不会改变候选人处置。',
      { committedForm: 'draft', committedValue: input.review_json },
    );
  }

  function confirmReview() {
    confirmAction(
      '确认终评卡？',
      '确认后终评内容不可覆盖，但候选人处置仍不会改变；处置必须再次单独确认。',
      () => api.confirmF018FinalReview({
        application_id: active.id,
        final_review_id: editable.id,
        expected_version: editable.version,
        request_id: requestId('f018-review-confirm'),
        confirmed: true,
        candidate_id: candidate.internal_id,
        job_id: candidate.job_id,
      }),
      '终评卡已确认，等待单独处置。',
    );
  }

  function reopenReview() {
    confirmAction(
      '重新打开终评？',
      '旧终评将保留为 superseded，新建可编辑版本；历史不会被覆盖。',
      () => api.reopenF018FinalReview({
        application_id: active.id,
        final_review_id: confirmedReview.id,
        expected_version: confirmedReview.version,
        request_id: requestId('f018-review-reopen'),
        reopened: true,
        reason_code: 'manual_review_reopened',
        candidate_id: candidate.internal_id,
        job_id: candidate.job_id,
      }),
      '已创建新的终评版本。',
    );
  }

  function recordDisposition() {
    const submittedDisposition = { disposition, reason };
    confirmAction(
      `确认执行“${dispositionLabel}”？`,
      '这是终评确认后的第二个独立人工动作，将按白名单更新申请处置；系统不会写入“已入职”。',
      () => api.recordF018Disposition({
        application_id: active.id,
        final_review_id: confirmedReview.id,
        action: disposition,
        reason_code: reason || 'manual_final_disposition',
        expected_version: active.version,
        request_id: requestId('f018-disposition'),
        confirmed: true,
        candidate_id: candidate.internal_id,
        job_id: candidate.job_id,
      }),
      '申请处置已记录。',
      disposition === 'reject',
      { committedForm: 'disposition', committedValue: submittedDisposition },
    );
  }

  if (!stateIsCurrent || (loading && !state)) return <Spin />;
  if (!state) {
    return (
      <Alert
        type="error"
        showIcon
        message="申请终评状态读取失败"
        description={loadError || '当前状态未知，为避免重复建立申请或错误处置，写入入口已暂停。'}
        action={<Button onClick={() => load(contextKey)}>重试</Button>}
      />
    );
  }
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {loading && (
        <Alert
          type="info"
          showIcon
          message="正在刷新结构化终评"
          description="最近一次成功内容仍可查看；完成读取前写操作已暂停。"
        />
      )}
      {loadError && (
        <Alert
          type="warning"
          showIcon
          message="结构化终评刷新失败，正在显示最近一次成功内容"
          description={`${loadError}。为避免基于过期版本重复提交，写操作已暂停。`}
          action={<Button onClick={() => load(contextKey)}>重试读取</Button>}
        />
      )}
      <Alert
        type="info"
        showIcon
        message="通用申请轮次与独立人工终评"
        description="终评可引用 HR 已确认的岗位画像、面试报告和测评报告；AI 结论与供应商数值都只作核验线索，不自动评分、排序、录用或淘汰。终评确认与最终处置仍是两个独立人工动作。"
      />

      <Card size="small">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space style={{ justifyContent: 'space-between', width: '100%' }}>
            <Title level={5} style={{ margin: 0 }}>Application 申请轮次</Title>
            {!active && !applications.length && <Button disabled={writesBlocked} onClick={() => runAction(() => applicationCommand('open'), '已建立首次申请轮次。')}>建立首次申请</Button>}
            {!active && applications.length > 0 && <Button disabled={writesBlocked} onClick={() => confirmAction('确认重新进入？', '将新建申请轮次，旧轮次保持不变。', () => applicationCommand('reenter'), '已建立新的申请轮次。')}>重新进入</Button>}
          </Space>
          {!applications.length ? <Empty description="暂无申请轮次" /> : applications.map((item) => (
            <Space key={item.id} wrap>
              <Tag color={item.status === 'active' ? 'green' : 'default'}>第 {item.episode_no} 次 · {item.status}</Tag>
              <Text type="secondary">开启：{fmtTime(item.opened_at)} · 版本 {item.version}</Text>
            </Space>
          ))}
          {active && (
            <Space>
              <Button disabled={writesBlocked} onClick={() => confirmAction('确认撤回本次申请？', '撤回后需要“重新进入”才能建立新轮次。', () => applicationCommand('withdraw'), '本次申请已撤回。', true)}>撤回</Button>
              <Button disabled={writesBlocked} onClick={() => confirmAction('确认关闭本次申请？', '关闭不会删除历史终评和事件。', () => applicationCommand('close'), '本次申请已关闭。')}>关闭</Button>
            </Space>
          )}
          {(state?.review_history?.length > 0 || state?.disposition_history?.length > 0) && (
            <Text type="secondary">
              历史留痕：终评 {(state.review_history || []).length} 版 · 处置 {(state.disposition_history || []).length} 条
            </Text>
          )}
        </Space>
      </Card>

      {active && (
        <Card size="small" title="FinalReview 独立终评卡">
          {!prerequisites.confirmed_job_profile_id && <Alert type="warning" showIcon message="缺少已确认岗位画像，暂不能创建终评卡。" />}
          {!prerequisites.confirmed_interview_report_id && <Alert type="warning" showIcon message="缺少已确认面试报告；可以保存草稿，但不能确认终评。" />}
          {prerequisites.assessment_policy === 'required'
            && prerequisites.assessment_requirement_met === false && (
            <Alert
              type="warning"
              showIcon
              message="当前岗位要求测评报告；可以保存终评草稿，但不能确认。"
              description="请先在候选人的“测评”分区导入、核对并确认至少一份报告归属。"
            />
          )}
          {prerequisites.assessment_policy === 'recommended'
            && confirmedAssessments.length === 0 && (
            <Alert
              type="info"
              showIcon
              message="当前岗位建议补充测评报告"
              description="这是非阻塞提示；HR 可基于现有岗位画像和面试证据继续人工终评。"
            />
          )}
          {confirmedAssessments.length > 0 && (
            <Space wrap style={{ marginBottom: 10 }}>
              <Text strong>已纳入终评的测评证据：</Text>
              {confirmedAssessments.map((item) => (
                <Tag key={item.id}>
                  {ASSESSMENT_REPORT_LABELS[item.report_type] || '测评报告'} · {item.id}
                </Tag>
              ))}
              <Text type="secondary">仅引用 HR 已确认报告，不采用自动处置。</Text>
            </Space>
          )}
          {currentAssessmentAiAnalysis && (!review || editable) && (
            <Alert
              type="info"
              showIcon
              message="可复用当前已获批的 AI 测评分析"
              description="只提取优势、风险和待核实项，不复制分数、排名或自动处置建议；本次操作不再调用外部 AI。"
              action={(
                <Button disabled={writesBlocked} onClick={applyAssessmentAiDraft}>
                  起草终评
                </Button>
              )}
            />
          )}
          {(!review || editable) && prerequisites.confirmed_job_profile_id && (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Text>人工终评摘要</Text>
              <TextArea
                aria-label="人工终评摘要"
                name="application-final-review-summary"
                autoComplete="off"
                rows={3}
                value={draft.decision_summary}
                disabled={writesBlocked}
                onChange={(event) => updateDraftField('decision_summary', event.target.value)}
              />
              <Text>岗位相关优势证据</Text>
              <TextArea
                aria-label="岗位相关优势证据"
                name="application-final-review-strengths"
                autoComplete="off"
                rows={2}
                value={draft.strengths}
                disabled={writesBlocked}
                onChange={(event) => updateDraftField('strengths', event.target.value)}
              />
              <Text>风险与反证</Text>
              <TextArea
                aria-label="风险与反证"
                name="application-final-review-risks"
                autoComplete="off"
                rows={2}
                value={draft.risks}
                disabled={writesBlocked}
                onChange={(event) => updateDraftField('risks', event.target.value)}
              />
              <Text>限制与待核实项</Text>
              <TextArea
                aria-label="限制与待核实项"
                name="application-final-review-limitations"
                autoComplete="off"
                rows={2}
                value={draft.limitations}
                disabled={writesBlocked}
                onChange={(event) => updateDraftField('limitations', event.target.value)}
              />
              <Space>
                <Button type="primary" disabled={writesBlocked} onClick={saveDraft}>保存终评草稿</Button>
                {editable && <Button disabled={writesBlocked || !canConfirm || draftDirty} onClick={confirmReview}>确认终评卡</Button>}
              </Space>
            </Space>
          )}
          {confirmedReview && (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Tag color="green">终评已确认 · 版本 {confirmedReview.version}</Tag>
              <Text>{parseReview(confirmedReview.review_json).decision_summary || '未填写摘要'}</Text>
              {!state?.disposition && (
                <>
                  <Alert type="warning" showIcon message="终评确认尚未改变处置，必须再次显式确认。" />
                  <Space wrap>
                    <Select aria-label="终评处置" value={disposition} onChange={updateDisposition} options={DISPOSITIONS} style={{ width: 160 }} />
                    <Input
                      aria-label="处置理由代码"
                      name="application-final-review-disposition-reason"
                      autoComplete="off"
                      value={reason}
                      onChange={(event) => updateDispositionReason(event.target.value)}
                      placeholder="处置理由代码"
                      style={{ width: 240 }}
                    />
                    <Button type="primary" disabled={writesBlocked} onClick={recordDisposition}>确认处置</Button>
                    <Button disabled={writesBlocked} onClick={reopenReview}>重开终评</Button>
                  </Space>
                </>
              )}
              {state?.disposition && <Tag>处置已记录：{state.disposition.action}</Tag>}
            </Space>
          )}
        </Card>
      )}
    </div>
  );
}
