import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Empty, Input, Select, Space, Spin, Tag, Typography } from 'antd';
import { api, fmtTime } from '../api.js';
import {
  canWriteJourneyOperations,
  preserveEditedGeneratedDraft,
  resolveStableDraftRequest,
} from '../candidate-journey-operation-state.mjs';

const { Paragraph, Text, Title } = Typography;

const NEXT_ACTION_OPTIONS = [
  { value: 'contact', label: '联系候选人' },
  { value: 'resume', label: '跟进简历' },
  { value: 'assessment', label: '跟进测评' },
  { value: 'interview', label: '推进面试' },
  { value: 'feedback', label: '收集负责人反馈' },
  { value: 'offer', label: '跟进 Offer' },
  { value: 'onboarding', label: '入职交接' },
  { value: 'other', label: '其他' },
];

const FEEDBACK_CONTEXT_OPTIONS = [
  { value: 'job_profile', label: '画像/筛选' },
  { value: 'interview', label: '面试' },
  { value: 'final_review', label: '最终评审' },
];

const FEEDBACK_CONCLUSION_OPTIONS = [
  { value: 'agree', label: '同意推进' },
  { value: 'need_more', label: '需要补充信息' },
  { value: 'disagree', label: '不同意推进' },
];

const OFFER_LABELS = {
  ready_to_offer: '准备发 Offer',
  offer_sent: 'Offer 已发出',
  negotiating: '协商中',
  accepted: '候选人已接受',
  declined: '候选人拒绝',
  company_withdrawn: '公司撤回',
  onboarding_handoff: '已交接入职',
};

const OFFER_TRANSITIONS = {
  ready_to_offer: ['offer_sent', 'company_withdrawn'],
  offer_sent: ['negotiating', 'accepted', 'declined', 'company_withdrawn'],
  negotiating: ['negotiating', 'accepted', 'declined', 'company_withdrawn'],
  accepted: ['onboarding_handoff'],
  declined: [],
  company_withdrawn: [],
  onboarding_handoff: [],
};

function requestId(prefix) {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${id}`;
}

function today() {
  return new Date().toLocaleDateString('sv-SE');
}

function emptyNextAction() {
  return { action_type: 'contact', due_date: today(), note: '' };
}

function emptyFeedback() {
  return {
    context_type: 'interview',
    feedback_person: '',
    feedback_role: '',
    conclusion: 'agree',
    summary: '',
  };
}

function emptyOfferDraft() {
  return { status: '', expected_start_date: '', note: '' };
}

function emptyDraftTouched() {
  return { next: false, feedback: false, offer: false, copy: false };
}

function candidateContext(candidate) {
  const candidateId = candidate?.internal_id;
  const jobId = candidate?.job_id;
  if (!candidateId || !jobId) return null;
  return {
    candidateId,
    jobId,
    key: `${String(candidateId)}:${String(jobId)}`,
  };
}

function conclusionLabel(value) {
  return FEEDBACK_CONCLUSION_OPTIONS.find((item) => item.value === value)?.label || value;
}

function contextLabel(value) {
  return FEEDBACK_CONTEXT_OPTIONS.find((item) => item.value === value)?.label || value;
}

export default function CandidateJourneyOperationsPanel({
  candidate,
  readOnly = false,
  onChanged,
  onDirtyChange,
  onBusyChange,
}) {
  const { message } = AntApp.useApp();
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);
  const [refreshRequired, setRefreshRequired] = useState(null);
  const [authorityLoaded, setAuthorityLoaded] = useState(false);
  const [authorityLoadFailed, setAuthorityLoadFailed] = useState(false);
  const [authorityError, setAuthorityError] = useState('');
  const [nextAction, setNextAction] = useState(emptyNextAction);
  const [feedback, setFeedback] = useState(emptyFeedback);
  const [offerDraft, setOfferDraft] = useState(emptyOfferDraft);
  const [offerCopyDraft, setOfferCopyDraft] = useState('');
  const [draftTouched, setDraftTouched] = useState(emptyDraftTouched);
  const activeContextRef = useRef('');
  const loadSequenceRef = useRef(0);
  const draftTouchedRef = useRef(emptyDraftTouched());
  const stableRequestRef = useRef({ next: null, feedback: null, offer: null });

  function clearStableDraftRequest(section) {
    if (!Object.hasOwn(stableRequestRef.current, section)) return;
    stableRequestRef.current[section] = null;
  }

  function clearAllStableDraftRequests() {
    stableRequestRef.current = { next: null, feedback: null, offer: null };
  }

  function stableDraftRequest(section, prefix, payload, withTimestamp = false) {
    const envelope = resolveStableDraftRequest(stableRequestRef.current[section], {
      prefix,
      payload,
      createRequestId: requestId,
      createTimestamp: withTimestamp ? () => new Date().toISOString() : undefined,
    });
    stableRequestRef.current[section] = envelope;
    return envelope;
  }

  function replaceDraftTouched(nextValue) {
    draftTouchedRef.current = nextValue;
    setDraftTouched(nextValue);
  }

  function markDraftTouched(section) {
    clearStableDraftRequest(section);
    if (draftTouchedRef.current[section]) return;
    replaceDraftTouched({ ...draftTouchedRef.current, [section]: true });
  }

  function applyLoadedState(response, options = {}) {
    const { resetDrafts = false, committedSection = '' } = options;
    const touched = draftTouchedRef.current;
    const choices = response.offer
      ? (OFFER_TRANSITIONS[response.offer.status] || [])
      : response.offer_eligible ? ['ready_to_offer'] : [];
    setState(response);
    if (resetDrafts || committedSection === 'next' || !touched.next) {
      setNextAction(response.next_action ? {
        action_type: response.next_action.action_type,
        due_date: response.next_action.due_date,
        note: response.next_action.note || '',
      } : emptyNextAction());
    }
    if (resetDrafts || committedSection === 'feedback') {
      setFeedback(emptyFeedback());
    }
    if (resetDrafts || committedSection === 'offer' || !touched.offer) {
      setOfferDraft({
        status: choices[0] || '',
        expected_start_date: response.offer?.expected_start_date || '',
        note: '',
      });
    }
    replaceDraftTouched(resetDrafts
      ? emptyDraftTouched()
      : { ...touched, ...(committedSection ? { [committedSection]: false } : {}) });
  }

  async function load(context, options = {}) {
    if (!context) return { status: 'empty' };
    const {
      showLoading = true,
      resetDrafts = false,
      committedSection = '',
      surfaceError = true,
    } = options;
    const sequence = ++loadSequenceRef.current;
    if (showLoading) setLoading(true);
    if (surfaceError) {
      setAuthorityLoadFailed(false);
      setAuthorityError('');
    }
    try {
      const response = await api.getCandidateJourneyOperations(context.candidateId, context.jobId);
      if (sequence !== loadSequenceRef.current || activeContextRef.current !== context.key) {
        return { status: 'stale' };
      }
      applyLoadedState(response, { resetDrafts, committedSection });
      setAuthorityLoaded(true);
      setAuthorityLoadFailed(false);
      setAuthorityError('');
      return { status: 'ok' };
    } catch (loadError) {
      if (sequence === loadSequenceRef.current && activeContextRef.current === context.key && surfaceError) {
        setAuthorityLoaded(false);
        setAuthorityLoadFailed(true);
        setAuthorityError(loadError?.message || '招聘推进记录读取失败。');
      }
      throw loadError;
    } finally {
      if (sequence === loadSequenceRef.current && activeContextRef.current === context.key && showLoading) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    const context = candidateContext(candidate);
    activeContextRef.current = context?.key || '';
    loadSequenceRef.current += 1;
    setState(null);
    setLoading(Boolean(context));
    setBusy('');
    setError('');
    setNotice(null);
    setRefreshRequired(null);
    setAuthorityLoaded(false);
    setAuthorityLoadFailed(false);
    setAuthorityError('');
    setNextAction(emptyNextAction());
    setFeedback(emptyFeedback());
    setOfferDraft(emptyOfferDraft());
    setOfferCopyDraft('');
    replaceDraftTouched(emptyDraftTouched());
    clearAllStableDraftRequests();
    if (!context) {
      setLoading(false);
      return undefined;
    }
    void load(context, { resetDrafts: true }).catch(() => {});
    return () => {
      if (activeContextRef.current === context.key) {
        activeContextRef.current = '';
        loadSequenceRef.current += 1;
      }
    };
  }, [candidate?.internal_id, candidate?.job_id]);

  const dirty = Object.values(draftTouched).some(Boolean);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => {
    onDirtyChange?.(false);
    onBusyChange?.(false);
  }, [onBusyChange, onDirtyChange]);

  function retryAuthorityLoad() {
    if (loading || busy) return;
    const context = candidateContext(candidate);
    if (!context || activeContextRef.current !== context.key) return;
    void load(context, { resetDrafts: true }).catch(() => {});
  }

  function beginWrite(kind) {
    if (!authorityLoaded || authorityLoadFailed || busy || refreshRequired) return null;
    const context = candidateContext(candidate);
    if (!context || activeContextRef.current !== context.key) return null;
    setBusy(kind);
    onBusyChange?.(true);
    setError('');
    setNotice(null);
    return context;
  }

  function finishWrite(context) {
    if (context && activeContextRef.current === context.key) setBusy('');
    onBusyChange?.(false);
  }

  function clearCommittedDraft(section) {
    replaceDraftTouched({ ...draftTouchedRef.current, [section]: false });
    if (section === 'feedback') setFeedback(emptyFeedback());
    if (section === 'offer') setOfferDraft((current) => ({ ...current, note: '' }));
  }

  function surfaceWriteError(writeError, fallbackMessage) {
    const status = Number(writeError?.status);
    if (!Number.isInteger(status) || status >= 500) {
      setNotice({
        type: 'warning',
        message: `${fallbackMessage}的结果尚未确认。请不要修改当前草稿，直接重试会复用同一请求 ID 并安全确认结果。${writeError?.message ? `详情：${writeError.message}` : ''}`,
      });
      return;
    }
    setError(writeError?.message || `${fallbackMessage}失败。`);
  }

  async function refreshAfterCommittedWrite(context, section) {
    const failures = [];
    let panelRefreshed = false;
    try {
      const result = await load(context, {
        showLoading: false,
        committedSection: section,
        surfaceError: false,
      });
      panelRefreshed = result.status === 'ok';
    } catch (refreshError) {
      failures.push(refreshError?.message || '招聘推进记录读取失败');
    }
    try {
      await onChanged?.(context.candidateId, context.jobId);
    } catch (refreshError) {
      failures.push(refreshError?.message || '候选人列表或工作台刷新失败');
    }
    if (activeContextRef.current !== context.key) return;
    if (!panelRefreshed) {
      setRefreshRequired({ context, section });
      setNotice({
        type: 'warning',
        message: `操作已经保存，但最新记录读取失败：${failures.join('；') || '请重新读取'}。请勿重复提交。`,
      });
      return;
    }
    setRefreshRequired(null);
    if (failures.length) {
      setNotice({
        type: 'warning',
        message: `操作已经保存，本面板已更新；候选人列表或工作台刷新失败：${failures.join('；')}。`,
      });
    }
  }

  async function retryCommittedRefresh() {
    if (!refreshRequired || busy) return;
    const { context, section } = refreshRequired;
    if (activeContextRef.current !== context.key) return;
    setBusy('refresh');
    onBusyChange?.(true);
    setError('');
    try {
      const result = await load(context, {
        showLoading: false,
        committedSection: section,
        surfaceError: false,
      });
      if (result.status !== 'ok' || activeContextRef.current !== context.key) return;
      setRefreshRequired(null);
      setNotice({ type: 'success', message: '已读取刚才保存的最新记录，无需重复提交。' });
      try {
        await onChanged?.(context.candidateId, context.jobId);
      } catch (refreshError) {
        setNotice({
          type: 'warning',
          message: `最新记录已读取；候选人列表或工作台仍刷新失败：${refreshError?.message || '请稍后重试读取。'}`,
        });
      }
    } catch (refreshError) {
      setNotice({
        type: 'warning',
        message: `操作已经保存，但最新记录仍读取失败：${refreshError?.message || '请稍后重试读取。'}。请勿重复提交。`,
      });
    } finally {
      if (activeContextRef.current === context.key) setBusy('');
      onBusyChange?.(false);
    }
  }

  async function saveNextAction(stateValue = 'pending') {
    if (!nextAction.due_date) {
      setError('请填写下一步日期。');
      return;
    }
    const context = beginWrite(`next-${stateValue}`);
    if (!context) return;
    const payload = {
      candidate_id: context.candidateId,
      job_id: context.jobId,
      action_type: nextAction.action_type,
      due_date: nextAction.due_date,
      note: nextAction.note,
      state: stateValue,
    };
    const draftRequest = stableDraftRequest('next', 'next-action', payload);
    try {
      await api.setCandidateNextAction({
        ...payload,
        request_id: draftRequest.request_id,
      });
      clearStableDraftRequest('next');
      clearCommittedDraft('next');
      message.success(stateValue === 'pending' ? '下一步已保存。' : stateValue === 'completed' ? '下一步已完成。' : '下一步已取消。');
      await refreshAfterCommittedWrite(context, 'next');
    } catch (writeError) {
      if (activeContextRef.current === context.key) surfaceWriteError(writeError, '下一步保存');
    } finally {
      finishWrite(context);
    }
  }

  async function saveFeedback() {
    if (!feedback.feedback_person.trim() || !feedback.summary.trim()) {
      setError('请填写反馈人和反馈摘要。');
      return;
    }
    const context = beginWrite('feedback');
    if (!context) return;
    const payload = {
      candidate_id: context.candidateId,
      job_id: context.jobId,
      ...feedback,
    };
    const draftRequest = stableDraftRequest('feedback', 'manager-feedback', payload, true);
    try {
      await api.recordHiringManagerFeedback({
        ...payload,
        feedback_at: draftRequest.created_at,
        request_id: draftRequest.request_id,
      });
      clearStableDraftRequest('feedback');
      clearCommittedDraft('feedback');
      message.success('用人负责人反馈已记录。');
      await refreshAfterCommittedWrite(context, 'feedback');
    } catch (writeError) {
      if (activeContextRef.current === context.key) surfaceWriteError(writeError, '负责人反馈保存');
    } finally {
      finishWrite(context);
    }
  }

  async function saveOfferStatus() {
    if (!offerDraft.status) return;
    if (offerDraft.status === 'accepted' && !offerDraft.expected_start_date) {
      setError('候选人接受 Offer 时请填写预计入职日期。');
      return;
    }
    if (['declined', 'company_withdrawn'].includes(offerDraft.status) && !offerDraft.note.trim()) {
      setError('候选人拒绝或公司撤回时，请填写实际原因。');
      return;
    }
    const context = beginWrite('offer');
    if (!context) return;
    const payload = {
      candidate_id: context.candidateId,
      job_id: context.jobId,
      status: offerDraft.status,
      expected_start_date: offerDraft.expected_start_date || null,
      note: offerDraft.note,
      reason_code: ['declined', 'company_withdrawn'].includes(offerDraft.status) ? 'manual_offer_outcome' : null,
    };
    const draftRequest = stableDraftRequest('offer', 'offer-status', payload);
    try {
      await api.setCandidateOfferStatus({
        ...payload,
        request_id: draftRequest.request_id,
      });
      clearStableDraftRequest('offer');
      clearCommittedDraft('offer');
      message.success(`Offer 状态已更新为“${OFFER_LABELS[offerDraft.status]}”。`);
      await refreshAfterCommittedWrite(context, 'offer');
    } catch (writeError) {
      if (activeContextRef.current === context.key) surfaceWriteError(writeError, 'Offer 状态保存');
    } finally {
      finishWrite(context);
    }
  }

  const offerChoices = useMemo(() => {
    if (!state) return [];
    const values = state.offer
      ? (OFFER_TRANSITIONS[state.offer.status] || [])
      : state.offer_eligible ? ['ready_to_offer'] : [];
    return values.map((value) => ({ value, label: OFFER_LABELS[value] }));
  }, [state]);

  const generatedOfferCopy = useMemo(() => {
    const name = candidate?.name || '候选人';
    const status = state?.offer?.status;
    if (!status) return '';
    if (status === 'ready_to_offer') return `${name}，您好。我们希望与您沟通本岗位的 Offer 信息，请告知方便沟通的时间。`;
    if (status === 'offer_sent') return `${name}，您好。此前发送的 Offer 如有任何问题，欢迎直接反馈，我们会由 HR 人工跟进。`;
    if (status === 'negotiating') return `${name}，您好。关于 Offer 中仍在沟通的事项，我们已记录，将在确认后由 HR 回复您。`;
    if (status === 'accepted') return `${name}，您好。感谢确认接受 Offer，我们将继续与您核对预计入职日期和入职准备事项。`;
    return '';
  }, [candidate?.name, state?.offer?.status]);

  useEffect(() => {
    setOfferCopyDraft((currentDraft) => preserveEditedGeneratedDraft({
      currentDraft,
      generatedDraft: generatedOfferCopy,
      touched: draftTouchedRef.current.copy,
    }));
  }, [generatedOfferCopy]);

  if (loading) return <Card><Spin size="small" /> <Text type="secondary">正在读取招聘推进记录…</Text></Card>;

  const writeDisabled = !canWriteJourneyOperations({
    readOnly,
    authorityLoaded,
    busy: Boolean(busy),
    refreshRequired: Boolean(refreshRequired),
  });

  return (
    <div style={{ display: 'grid', gap: 12, marginBottom: 12 }}>
      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
      {authorityLoadFailed && (
        <Alert
          type="error"
          showIcon
          message="招聘推进记录尚未读取，写操作已锁定"
          description={`${authorityError || '当前候选人的招聘推进状态无法确认。'} 请先重新读取，成功前不会提交默认表单。`}
          action={<Button size="small" onClick={retryAuthorityLoad}>重新读取</Button>}
        />
      )}
      {notice && (
        <Alert
          type={notice.type}
          showIcon
          message={notice.message}
          closable={!refreshRequired}
          onClose={() => setNotice(null)}
          action={refreshRequired ? (
            <Button size="small" loading={busy === 'refresh'} onClick={retryCommittedRefresh}>
              重新读取
            </Button>
          ) : null}
        />
      )}

      <Card size="small">
        <Title level={5}>下一步与日期</Title>
        <Paragraph type="secondary">只记录 HR 已明确的下一步；到期或逾期会进入工作台，不会自动联系候选人。</Paragraph>
        <Space wrap align="start">
          <Select
            aria-label="下一步类型"
            value={nextAction.action_type}
            options={NEXT_ACTION_OPTIONS}
            onChange={(value) => {
              markDraftTouched('next');
              setNextAction((current) => ({ ...current, action_type: value }));
            }}
            style={{ width: 160 }}
            disabled={writeDisabled}
          />
          <Input
            aria-label="下一步日期"
            type="date"
            value={nextAction.due_date}
            onChange={(event) => {
              markDraftTouched('next');
              setNextAction((current) => ({ ...current, due_date: event.target.value }));
            }}
            style={{ width: 160 }}
            disabled={writeDisabled}
          />
          <Input
            aria-label="下一步备注"
            placeholder="一句话说明（可选）"
            value={nextAction.note}
            onChange={(event) => {
              markDraftTouched('next');
              setNextAction((current) => ({ ...current, note: event.target.value }));
            }}
            style={{ width: 280 }}
            maxLength={500}
            disabled={writeDisabled}
          />
          {!readOnly && <Button type="primary" disabled={writeDisabled} loading={busy === 'next-pending'} onClick={() => saveNextAction('pending')}>保存下一步</Button>}
          {!readOnly && state?.next_action?.state === 'pending' && (
            <>
              <Button disabled={writeDisabled} loading={busy === 'next-completed'} onClick={() => saveNextAction('completed')}>标记完成</Button>
              <Button disabled={writeDisabled} loading={busy === 'next-cancelled'} onClick={() => saveNextAction('cancelled')}>取消</Button>
            </>
          )}
        </Space>
        {state?.next_action && (
          <div style={{ marginTop: 10 }}>
            <Tag color={state.next_action.state === 'pending' ? 'blue' : 'default'}>
              {state.next_action.state === 'pending' ? '待跟进' : state.next_action.state === 'completed' ? '已完成' : '已取消'}
            </Tag>
            <Text type="secondary">最近更新：{fmtTime(state.next_action.updated_at)}</Text>
          </div>
        )}
      </Card>

      <Card size="small">
        <Title level={5}>用人负责人反馈</Title>
        <Paragraph type="secondary">记录谁、何时、基于哪个环节给了什么结论；不建设账号、审批流或催办系统。</Paragraph>
        {!readOnly && (
          <Space wrap align="start">
            <Select
              aria-label="反馈环节"
              value={feedback.context_type}
              options={FEEDBACK_CONTEXT_OPTIONS}
              onChange={(value) => {
                markDraftTouched('feedback');
                setFeedback((current) => ({ ...current, context_type: value }));
              }}
              style={{ width: 140 }}
              disabled={writeDisabled}
            />
            <Input
              aria-label="反馈人"
              placeholder="反馈人"
              value={feedback.feedback_person}
              onChange={(event) => {
                markDraftTouched('feedback');
                setFeedback((current) => ({ ...current, feedback_person: event.target.value }));
              }}
              style={{ width: 140 }}
              maxLength={80}
              disabled={writeDisabled}
            />
            <Input
              aria-label="反馈人角色"
              placeholder="角色（可选）"
              value={feedback.feedback_role}
              onChange={(event) => {
                markDraftTouched('feedback');
                setFeedback((current) => ({ ...current, feedback_role: event.target.value }));
              }}
              style={{ width: 140 }}
              maxLength={80}
              disabled={writeDisabled}
            />
            <Select
              aria-label="反馈结论"
              value={feedback.conclusion}
              options={FEEDBACK_CONCLUSION_OPTIONS}
              onChange={(value) => {
                markDraftTouched('feedback');
                setFeedback((current) => ({ ...current, conclusion: value }));
              }}
              style={{ width: 150 }}
              disabled={writeDisabled}
            />
            <Input
              aria-label="反馈摘要"
              placeholder="反馈摘要"
              value={feedback.summary}
              onChange={(event) => {
                markDraftTouched('feedback');
                setFeedback((current) => ({ ...current, summary: event.target.value }));
              }}
              style={{ width: 320 }}
              maxLength={1000}
              disabled={writeDisabled}
            />
            <Button type="primary" disabled={writeDisabled} loading={busy === 'feedback'} onClick={saveFeedback}>记录反馈</Button>
          </Space>
        )}
        <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          {(state?.manager_feedback || []).length ? state.manager_feedback.map((item) => (
            <div key={item.id}>
              <Space wrap>
                <Tag>{contextLabel(item.context_type)}</Tag>
                <Tag color={item.conclusion === 'agree' ? 'green' : item.conclusion === 'disagree' ? 'red' : 'gold'}>
                  {conclusionLabel(item.conclusion)}
                </Tag>
                <Text strong>{item.feedback_person}</Text>
                {item.feedback_role && <Text type="secondary">{item.feedback_role}</Text>}
                <Text type="secondary">{fmtTime(item.feedback_at)}</Text>
              </Space>
              <Paragraph style={{ margin: '4px 0 0' }}>{item.summary}</Paragraph>
            </div>
          )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未记录用人负责人反馈" />}
        </div>
      </Card>

      <Card size="small">
        <Title level={5}>Offer 与入职交接</Title>
        <Paragraph type="secondary">这是人工跟进状态，不会自动生成薪酬、自动发送消息、自动录用或替代 HR 确认。</Paragraph>
        {state?.offer ? (
          <Space wrap>
            <Text>当前状态：</Text>
            <Tag color={['accepted', 'onboarding_handoff'].includes(state.offer.status) ? 'green' : 'blue'}>
              {OFFER_LABELS[state.offer.status] || state.offer.status}
            </Tag>
            {state.offer.expected_start_date && <Text>预计入职：{state.offer.expected_start_date}</Text>}
            <Text type="secondary">更新于 {fmtTime(state.offer.updated_at)}</Text>
          </Space>
        ) : !state?.offer_eligible ? (
          <Alert type="info" showIcon message="完成终评并人工确认“继续流程”后，才会开放 Offer 跟进。" />
        ) : (
          <Alert type="success" showIcon message="终评已允许继续流程，可由 HR 开始 Offer 跟进。" />
        )}
        {!readOnly && offerChoices.length > 0 && (
          <Space wrap align="start" style={{ marginTop: 12 }}>
            <Select
              aria-label="Offer 下一状态"
              value={offerDraft.status}
              options={offerChoices}
              onChange={(value) => {
                markDraftTouched('offer');
                setOfferDraft((current) => ({ ...current, status: value }));
              }}
              style={{ width: 180 }}
              disabled={writeDisabled}
            />
            {offerDraft.status === 'accepted' && (
              <Input
                aria-label="预计入职日期"
                type="date"
                value={offerDraft.expected_start_date}
                onChange={(event) => {
                  markDraftTouched('offer');
                  setOfferDraft((current) => ({ ...current, expected_start_date: event.target.value }));
                }}
                style={{ width: 160 }}
                disabled={writeDisabled}
              />
            )}
            <Input
              aria-label="Offer 跟进备注"
              placeholder={['declined', 'company_withdrawn'].includes(offerDraft.status) ? '请记录原因' : '跟进备注（可选）'}
              value={offerDraft.note}
              onChange={(event) => {
                markDraftTouched('offer');
                setOfferDraft((current) => ({ ...current, note: event.target.value }));
              }}
              style={{ width: 300 }}
              maxLength={1000}
              disabled={writeDisabled}
            />
            <Button type="primary" disabled={writeDisabled} loading={busy === 'offer'} onClick={saveOfferStatus}>确认更新</Button>
          </Space>
        )}
        {(state?.offer_history || []).length > 0 && (
          <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
            <Text strong>Offer 变更记录</Text>
            {state.offer_history.map((item) => (
              <div key={item.id}>
                <Space wrap>
                  <Tag>{OFFER_LABELS[item.to_status] || item.to_status}</Tag>
                  <Text type="secondary">申请轮次 #{item.application_id}</Text>
                  <Text type="secondary">{fmtTime(item.occurred_at)}</Text>
                  {item.expected_start_date && <Text>预计入职：{item.expected_start_date}</Text>}
                </Space>
                {(item.note || item.reason_code) && (
                  <Paragraph style={{ margin: '4px 0 0' }}>
                    原因/备注：{item.note || item.reason_code}
                  </Paragraph>
                )}
              </div>
            ))}
          </div>
        )}
        {offerCopyDraft && (
          <div style={{ marginTop: 12 }}>
            <Text strong>可编辑沟通草稿（本地生成，不会自动发送）</Text>
            <Input.TextArea
              aria-label="Offer 沟通草稿"
              value={offerCopyDraft}
              onChange={(event) => {
                markDraftTouched('copy');
                setOfferCopyDraft(event.target.value);
              }}
              autoSize={{ minRows: 2, maxRows: 4 }}
              style={{ marginTop: 6 }}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
