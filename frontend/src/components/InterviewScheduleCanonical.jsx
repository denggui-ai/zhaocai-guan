import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Collapse, DatePicker, Empty, Input, InputNumber, Popconfirm, Select, Skeleton, Space, Tag, Typography } from 'antd';
import { api, fmtTime } from '../api.js';
import { interviewLogisticsNeedsAttention } from '../interview-workflow-state.mjs';
import LocalInterviewPanel from './LocalInterviewPanel.jsx';
import SemanticTag from './SemanticTag.jsx';

const { Text, Title } = Typography;

const NEXT_ROUND_ALLOWED_SESSION_STATUSES = new Set(['pending_review', 'confirmed', 'cancelled']);
const STATUS_LABELS = {
  draft: '待排期',
  scheduled: '已排期',
  in_progress: '面试中',
  pending_review: '待复盘',
  confirmed: '报告已确认',
  cancelled: '已取消',
};
const CANCEL_REASON_OPTIONS = [
  { value: 'hr_cancelled', label: 'HR 取消本轮' },
  { value: 'candidate_cancelled', label: '候选人取消' },
  { value: 'candidate_no_show', label: '候选人爽约' },
];
const CANCEL_REASON_LABELS = Object.fromEntries(CANCEL_REASON_OPTIONS.map((item) => [item.value, item.label]));
const INTERVIEW_FORMAT_OPTIONS = [
  { value: 'online', label: '线上面试' },
  { value: 'offline', label: '线下面试' },
  { value: 'phone', label: '电话面试' },
];
const INTERVIEW_FORMAT_LABELS = Object.fromEntries(INTERVIEW_FORMAT_OPTIONS.map((item) => [item.value, item.label]));
const CANDIDATE_CONFIRMATION_OPTIONS = [
  { value: 'pending', label: '待候选人确认' },
  { value: 'confirmed', label: '候选人已确认' },
  { value: 'declined', label: '候选人拒绝' },
  { value: 'reschedule_requested', label: '候选人申请改期' },
];
const CANDIDATE_CONFIRMATION_LABELS = Object.fromEntries(CANDIDATE_CONFIRMATION_OPTIONS.map((item) => [item.value, item.label]));

const DEFAULT_SCHEDULE_ADAPTER = Object.freeze({
  listSessions: (candidateId, jobId) => api.listInterviewSessions(candidateId, jobId),
  listInterviewers: (activeOnly) => api.listInterviewers(activeOnly),
  createSession: (input) => api.createInterviewSession(input),
  confirmSchedule: (sessionId, scheduledAt, requestId, logistics) => api.confirmInterviewSchedule(sessionId, scheduledAt, requestId, logistics),
  cancelSession: (sessionId, reasonCode) => api.withdrawInterviewLifecycle(sessionId, reasonCode),
  saveInterviewer: (input) => api.saveInterviewInterviewer(input),
  markInvitationSent: (sessionId) => api.markInterviewInvitationSent(sessionId),
  recordCandidateConfirmation: (sessionId, status) => api.recordInterviewCandidateConfirmation(sessionId, status),
});

function freshRequestId(sessionId) {
  const nonce = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `ui-schedule:${sessionId}:${nonce}`;
}

function sessionsForCandidate(sessions, candidateId) {
  return sessions
    .filter((session) => session.candidate_id === candidateId)
    .sort((left, right) => Number(left.round) - Number(right.round) || Number(left.id) - Number(right.id));
}

function sameJobId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function mergeCanonicalSessions(workbenchSessions, canonicalSessions) {
  if (!Array.isArray(canonicalSessions)) return workbenchSessions;
  const workbenchById = new Map(workbenchSessions.map((session) => [String(session.id), session]));
  return canonicalSessions.map((session) => {
    const fallback = workbenchById.get(String(session.id)) || {};
    return {
      ...fallback,
      ...session,
      candidate_name: session.candidate_name || fallback.candidate_name,
      report_status: session.report_status ?? fallback.report_status,
      cancel_reason: session.cancel_reason ?? fallback.cancel_reason,
    };
  });
}

const SESSION_WORKSPACE_PRIORITY = Object.freeze({
  in_progress: 0,
  pending_review: 1,
  scheduled: 2,
  draft: 3,
  confirmed: 4,
  cancelled: 5,
});

function sessionCurrentTodo(session) {
  if (session?.status === 'draft') return '待人工排期';
  if (session?.status === 'scheduled' && session?.invitation_status !== 'sent') return '待发送邀约';
  if (session?.status === 'scheduled' && (!session?.candidate_confirmation_status || session.candidate_confirmation_status === 'pending')) return '待候选人确认';
  if (session?.status === 'scheduled') return '等待面试开始';
  if (session?.status === 'in_progress') return '面试进行中';
  if (session?.status === 'pending_review') return '待人工复盘';
  if (session?.status === 'confirmed') return '已完成';
  if (session?.status === 'cancelled') return '已取消，历史可查';
  return STATUS_LABELS[session?.status] || session?.status || '状态待核对';
}

function orderSessionsForWorkspace(sessions) {
  return [...sessions].sort((left, right) => {
    const priority = (SESSION_WORKSPACE_PRIORITY[left?.status] ?? 9)
      - (SESSION_WORKSPACE_PRIORITY[right?.status] ?? 9);
    if (priority) return priority;
    const leftTime = Date.parse(left?.scheduled_at || left?.created_at || '') || 0;
    const rightTime = Date.parse(right?.scheduled_at || right?.created_at || '') || 0;
    return leftTime - rightTime || Number(right?.round || 0) - Number(left?.round || 0);
  });
}

function interviewerName(item) {
  return item?.interviewer_name_snapshot || item?.name || item?.interviewer_current_name || `面试官 ${item?.interviewer_id || ''}`;
}

function interviewerSummary(assignments) {
  if (!Array.isArray(assignments) || !assignments.length) return '未登记';
  return assignments.map((item) => `${item.role === 'lead' ? '主面试官' : '参与人'}：${interviewerName(item)}`).join('、');
}

function logisticsLocation(logistics) {
  const format = logistics?.interview_format || logistics?.mode;
  if (format === 'online') {
    return `${logistics.meeting_platform ? `${logistics.meeting_platform} · ` : ''}${logistics.meeting_link || '未登记会议链接'}`;
  }
  if (format === 'offline') {
    return `${logistics.location_address || '未登记地址'}${logistics.location_room ? ` · ${logistics.location_room}` : ''}`;
  }
  return '电话面试（请保持登记电话畅通）';
}

function currentLogistics(session) {
  return {
    scheduled_at: session.scheduled_at,
    interview_format: session.interview_format || session.mode,
    duration_minutes: session.duration_minutes,
    interviewers: session.interviewer_assignments || [],
    meeting_platform: session.meeting_platform,
    meeting_link: session.meeting_link,
    location_address: session.location_address,
    location_room: session.location_room,
    logistics_note: session.logistics_note,
    invitation_status: session.invitation_status,
    invitation_sent_by: session.invitation_sent_by,
    invitation_sent_at: session.invitation_sent_at,
    candidate_confirmation_status: session.candidate_confirmation_status,
    candidate_confirmation_recorded_by: session.candidate_confirmation_recorded_by,
    candidate_confirmation_recorded_at: session.candidate_confirmation_recorded_at,
  };
}

function initialScheduleForm(session) {
  const assignments = Array.isArray(session.interviewer_assignments) ? session.interviewer_assignments : [];
  const lead = assignments.find((item) => item.role === 'lead');
  return {
    interviewFormat: session.interview_format || session.mode || 'online',
    durationMinutes: session.duration_minutes || 45,
    leadInterviewerId: lead?.interviewer_id || null,
    participantInterviewerIds: assignments.filter((item) => item.role === 'participant').map((item) => item.interviewer_id),
    meetingPlatform: session.meeting_platform || '',
    meetingLink: session.meeting_link || '',
    locationAddress: session.location_address || '',
    locationRoom: session.location_room || '',
    logisticsNote: session.logistics_note || '',
  };
}

function scheduleFormErrors(value, form, interviewers, now = Date.now()) {
  const errors = {};
  if (!value) errors.time = '请选择明确的面试时间';
  else if (value.valueOf() <= now) errors.time = '面试时间必须晚于当前时间';

  const duration = Number(form.durationMinutes);
  if (!Number.isInteger(duration) || duration < 5 || duration > 480) errors.duration = '面试时长必须是 5–480 分钟的整数';

  const activeIds = new Set(interviewers.filter((item) => Number(item.active) === 1).map((item) => Number(item.id)));
  const leadInterviewerId = Number(form.leadInterviewerId);
  const participantInterviewerIds = [...new Set((form.participantInterviewerIds || []).map(Number))];
  if (!activeIds.has(leadInterviewerId)) errors.lead = '请选择一名启用中的主面试官';
  if (participantInterviewerIds.includes(leadInterviewerId)) errors.participants = '主面试官不能同时作为参与人';
  else if (participantInterviewerIds.some((id) => !activeIds.has(id))) errors.participants = '参与人只能选择启用中的面试官';
  if (form.interviewFormat === 'online' && !String(form.meetingLink || '').trim()) errors.meetingLink = '线上面试必须填写会议链接';
  if (form.interviewFormat === 'offline' && !String(form.locationAddress || '').trim()) errors.locationAddress = '线下面试必须填写面试地址';
  return errors;
}

const SCHEDULE_ERROR_FIELD_LABELS = Object.freeze({
  time: '面试时间',
  duration: '面试时长（分钟）',
  lead: '主面试官',
  participants: '参与面试官',
  meetingLink: '会议链接',
  locationAddress: '面试地址',
});

function buildInterviewInvitation(session, job) {
  if (!session?.scheduled_at) return '';
  const candidateName = String(session.candidate_name || '候选人').trim();
  const jobName = String(job?.name || '当前岗位').trim();
  const round = Number(session.round) > 0 ? `第 ${Number(session.round)} 轮` : '本轮';
  const format = session.interview_format || (session.mode === 'offline' ? 'offline' : 'online');
  const assignments = session.interviewer_assignments || [];
  return [
    `${candidateName}，你好，我是负责「${jobName}」岗位的 HR。`,
    `现邀请你参加${round}面试，时间：${fmtTime(session.scheduled_at)}。`,
    `形式：${INTERVIEW_FORMAT_LABELS[format] || format}；时长：${session.duration_minutes ? `${session.duration_minutes} 分钟` : '未登记'}。`,
    `面试官：${interviewerSummary(assignments)}。`,
    `${format === 'online' ? '会议' : format === 'offline' ? '地点' : '联系'}：${logisticsLocation(currentLogistics(session))}。`,
    `说明：${session.logistics_note || '无'}。`,
    '如时间需要调整，请提前告诉我，我会再人工确认。请确认收到，谢谢。',
  ].join('\n');
}

function InterviewInvitationEditor({ session, job }) {
  const [draft, setDraft] = useState(() => buildInterviewInvitation(session, job));
  const [copyState, setCopyState] = useState('');

  if (session.status === 'cancelled') {
    return <Alert style={{ marginTop: 12 }} type="info" showIcon message="本轮已取消，不生成邀约话术" />;
  }
  if (!session.scheduled_at) {
    return (
      <Alert
        style={{ marginTop: 12 }}
        type="info"
        showIcon
        message="请先完成本轮排期"
        description="确认明确时间后才会生成可编辑邀约话术；系统不会自动发送。"
      />
    );
  }

  async function copyInvitation() {
    setCopyState('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前系统剪贴板不可用');
      await navigator.clipboard.writeText(draft);
      setCopyState('copied');
    } catch (copyError) {
      setCopyState(copyError?.message || '复制失败');
    }
  }

  return (
    <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
      <Space wrap>
        <Text strong>面试邀约话术</Text>
        <Text type="secondary">可编辑后复制；只写入本机剪贴板，不自动发送、不保存。</Text>
      </Space>
      <Input.TextArea
        aria-label={`${session.candidate_name || '候选人'}面试邀约话术`}
        name={`interview-invitation-draft-${session.id}`}
        autoComplete="off"
        value={draft}
        onChange={(event) => { setDraft(event.target.value); setCopyState(''); }}
        autoSize={{ minRows: 4, maxRows: 8 }}
      />
      <Space wrap>
        <Button onClick={copyInvitation} disabled={!draft.trim()}>复制邀约话术</Button>
        {copyState === 'copied' && <Text type="success">已复制，请由 HR 核对后手动发送。</Text>}
        {copyState && copyState !== 'copied' && <Text type="danger">复制失败：{copyState}</Text>}
      </Space>
    </div>
  );
}

function LogisticsSnapshot({ snapshot, label }) {
  if (!snapshot) return <Text type="secondary">旧记录未登记完整物流</Text>;
  const legacyIncomplete = snapshot.snapshot_kind === 'legacy_compatible';
  return (
    <div>
      <Text strong>{label}</Text>
      {legacyIncomplete && <div><Text type="warning">旧记录未登记完整物流</Text></div>}
      <div><Text type="secondary">时间：{snapshot.scheduled_at ? fmtTime(snapshot.scheduled_at) : '未登记'}</Text></div>
      <div><Text type="secondary">形式：{INTERVIEW_FORMAT_LABELS[snapshot.interview_format] || snapshot.interview_format || '未登记'} · 时长：{snapshot.duration_minutes ? `${snapshot.duration_minutes} 分钟` : '未登记'}</Text></div>
      <div><Text type="secondary">面试官：{interviewerSummary(snapshot.interviewers)}</Text></div>
      <div><Text type="secondary">链接/地址/电话：{logisticsLocation(snapshot)}</Text></div>
      <div><Text type="secondary">说明：{snapshot.logistics_note || '无'}</Text></div>
      <div><Text type="secondary">邀请：{snapshot.invitation_status === 'sent' ? `已发送（${snapshot.invitation_sent_by || 'HR'} · ${fmtTime(snapshot.invitation_sent_at)}）` : '未标记发送'}；候选人：{CANDIDATE_CONFIRMATION_LABELS[snapshot.candidate_confirmation_status] || snapshot.candidate_confirmation_status || '待确认'}</Text></div>
    </div>
  );
}

function ScheduleConfirmationHistory({ session }) {
  const confirmations = Array.isArray(session.schedule_confirmations) ? session.schedule_confirmations : [];
  if (!confirmations.length) return null;
  return (
    <div style={{ marginTop: 12, display: 'grid', gap: 4 }}>
      <Text strong>人工排期历史</Text>
      {confirmations.map((confirmation, index) => <Card key={confirmation.id || `${session.id}:${index}`} size="small">
        <Text>{index + 1}. {confirmation.confirmed_by || 'HR'} 于 {fmtTime(confirmation.confirmed_at)} 确认</Text>
        <LogisticsSnapshot snapshot={confirmation.logistics_snapshot} label="本次排期物流" />
        {confirmation.logistics_snapshot?.previous_schedule && <LogisticsSnapshot snapshot={confirmation.logistics_snapshot.previous_schedule} label="改期前物流" />}
      </Card>)}
    </div>
  );
}

function InterviewScheduleLoadingState({ job, error, onRetry }) {
  if (error) {
    return (
      <section className="interview-schedule-panel interview-schedule-canonical">
        <Alert
          type="error"
          showIcon
          message="面试安排读取失败"
          description={error}
          action={<Button onClick={onRetry}>重新读取</Button>}
        />
      </section>
    );
  }
  return (
    <section
      className="interview-schedule-panel interview-schedule-canonical"
      role="status"
      aria-live="polite"
      aria-label="正在加载面试安排"
    >
      <div className="interview-schedule-head">
        <Title level={2}>{job?.name || '当前岗位'} · 面试安排</Title>
      </div>
      <Skeleton active title={{ width: '34%' }} paragraph={{ rows: 6, width: ['96%', '88%', '92%', '80%', '90%', '68%'] }} />
    </section>
  );
}

function InterviewScheduleEmptyState({
  job,
  onOpenJobs,
  onOpenCandidates,
  onRetry,
}) {
  const hasJob = !!job;
  return (
    <section className="interview-schedule-panel interview-schedule-canonical">
      <div className="interview-schedule-head">
        <Title level={2}>{hasJob ? `${job.name || `岗位 ${job.id}`} · 面试安排` : '面试安排'}</Title>
      </div>
      <div
        className="interview-schedule-empty-state"
        role="status"
        aria-live="polite"
        aria-label={hasJob ? '当前岗位暂无可用的面试安排数据' : '尚未选择岗位'}
      >
        <Empty
          description={hasJob
            ? '当前岗位暂无可用的面试安排数据。可以重新读取，或先查看候选人。'
            : '请先在顶部选择岗位；如果还没有岗位，请先前往职位管理创建。'}
        >
          <Space wrap>
            {hasJob ? (
              <>
                <Button onClick={onRetry}>重新读取</Button>
                <Button type="primary" onClick={onOpenCandidates}>查看候选人</Button>
              </>
            ) : (
              <Button type="primary" onClick={onOpenJobs}>前往职位管理</Button>
            )}
          </Space>
        </Empty>
      </div>
    </section>
  );
}

export default function InterviewScheduleCanonical({
  job,
  workbench,
  loadState,
  loadError,
  readOnly,
  onOpenCandidate,
  onOpenCandidates,
  onOpenJobs,
  onOpenSettings,
  onRefresh,
  navigationTarget = null,
  onNavigationTargetConsumed,
  dataAdapter = null,
  fixtureMode = false,
}) {
  const scheduleAdapter = dataAdapter || DEFAULT_SCHEDULE_ADAPTER;
  const [times, setTimes] = useState({});
  const [cancelReasons, setCancelReasons] = useState({});
  const [scheduleForms, setScheduleForms] = useState({});
  const [scheduleValidationAttempts, setScheduleValidationAttempts] = useState({});
  const [candidateConfirmationDrafts, setCandidateConfirmationDrafts] = useState({});
  const [candidateId, setCandidateId] = useState('');
  const [mode, setMode] = useState('online');
  const [canonicalSessions, setCanonicalSessions] = useState(null);
  const [canonicalLoadError, setCanonicalLoadError] = useState('');
  const [canonicalRefreshBusy, setCanonicalRefreshBusy] = useState(false);
  const [interviewers, setInterviewers] = useState([]);
  const [interviewerNameDraft, setInterviewerNameDraft] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [operationNotice, setOperationNotice] = useState(null);
  const [committedActions, setCommittedActions] = useState([]);
  const [navigationNotice, setNavigationNotice] = useState(null);
  const [focusedSessionId, setFocusedSessionId] = useState(null);
  const [expandedSessionId, setExpandedSessionId] = useState('');
  const [expandedLogisticsBySession, setExpandedLogisticsBySession] = useState({});
  const sessionCardRefs = useRef(new Map());
  const consumedNavigationTargetRef = useRef('');
  const jobContextRef = useRef({ jobId: null, token: 0 });
  const renderedJobId = job?.id ?? null;
  const jobChanged = renderedJobId == null
    ? jobContextRef.current.jobId != null
    : !sameJobId(renderedJobId, jobContextRef.current.jobId);
  if (jobChanged) {
    jobContextRef.current = {
      jobId: renderedJobId,
      token: jobContextRef.current.token + 1,
    };
  }

  function isCurrentContext(context) {
    return context.token === jobContextRef.current.token
      && sameJobId(context.jobId, jobContextRef.current.jobId);
  }

  function setCommittedAction(key, committed) {
    setCommittedActions((current) => committed
      ? (current.includes(key) ? current : [...current, key])
      : current.filter((item) => item !== key));
  }

  function isCommittedAction(key) {
    return committedActions.includes(key);
  }

  async function loadCanonicalSessions(context) {
    try {
      const response = await scheduleAdapter.listSessions(null, context.jobId);
      if (!isCurrentContext(context)) return false;
      if (!Array.isArray(response?.sessions)) throw new Error('正式面试记录返回格式无效');
      setCanonicalSessions(response.sessions);
      setCanonicalLoadError('');
      return true;
    } catch (loadCanonicalError) {
      if (isCurrentContext(context)) setCanonicalLoadError(loadCanonicalError.message || '正式面试记录读取失败');
      return false;
    }
  }

  async function retryCanonicalSessions() {
    const context = { ...jobContextRef.current };
    setCanonicalRefreshBusy(true);
    try {
      const refreshed = await loadCanonicalSessions(context);
      if (!isCurrentContext(context)) return;
      if (refreshed) {
        setError('');
        setOperationNotice({ type: 'success', text: '正式面试数据已恢复，相关写操作可以继续。' });
      }
    } finally {
      if (isCurrentContext(context)) setCanonicalRefreshBusy(false);
    }
  }

  async function loadInterviewerDirectory(context) {
    try {
      const response = await scheduleAdapter.listInterviewers(true);
      if (!isCurrentContext(context)) return false;
      setInterviewers(Array.isArray(response.interviewers) ? response.interviewers : []);
      return true;
    } catch (directoryError) {
      if (isCurrentContext(context)) setError(directoryError.message || '面试官名录读取失败');
      return false;
    }
  }

  useEffect(() => {
    setCandidateId('');
    setTimes({});
    setCancelReasons({});
    setScheduleForms({});
    setScheduleValidationAttempts({});
    setCandidateConfirmationDrafts({});
    setMode('online');
    setCanonicalSessions(null);
    setCanonicalLoadError('');
    setCanonicalRefreshBusy(false);
    setInterviewers([]);
    setInterviewerNameDraft('');
    setError('');
    setBusy('');
    setOperationNotice(null);
    setCommittedActions([]);
    setNavigationNotice(null);
    setFocusedSessionId(null);
    setExpandedSessionId('');
    setExpandedLogisticsBySession({});
    sessionCardRefs.current.clear();
    consumedNavigationTargetRef.current = '';
    if (renderedJobId != null) {
      const context = { ...jobContextRef.current };
      loadCanonicalSessions(context);
      if (!readOnly) loadInterviewerDirectory(context);
    }
  }, [renderedJobId, readOnly]);

  const workbenchSessions = workbench?.interview_sessions || [];
  const sessions = mergeCanonicalSessions(workbenchSessions, canonicalSessions);
  const candidates = workbench?.candidates || [];
  const orderedSessions = orderSessionsForWorkspace(sessions);
  const currentSessionId = orderedSessions[0] ? String(orderedSessions[0].id) : '';
  const sessionIdentity = orderedSessions.map((session) => String(session.id)).join('|');
  const logisticsAttentionIdentity = orderedSessions
    .map((session) => `${String(session.id)}:${interviewLogisticsNeedsAttention(session) ? 'attention' : 'idle'}`)
    .join('|');

  useEffect(() => {
    setExpandedSessionId((current) => {
      if (current && sessions.some((session) => String(session.id) === String(current))) return current;
      return currentSessionId;
    });
  }, [currentSessionId, sessionIdentity]);

  useEffect(() => {
    const attentionSessionIds = orderedSessions
      .filter(interviewLogisticsNeedsAttention)
      .map((session) => String(session.id));
    if (!attentionSessionIds.length) return;
    setExpandedLogisticsBySession((current) => {
      const next = { ...current };
      let changed = false;
      attentionSessionIds.forEach((sessionId) => {
        if (next[sessionId] === true) return;
        next[sessionId] = true;
        changed = true;
      });
      return changed ? next : current;
    });
  }, [logisticsAttentionIdentity]);

  useEffect(() => {
    if (!navigationTarget?.key || consumedNavigationTargetRef.current === navigationTarget.key) return;
    if (!sameJobId(navigationTarget.jobId, renderedJobId)) return;
    const matchedSession = navigationTarget.type === 'report'
      ? sessions.find((session) => sameJobId(session.job_id, navigationTarget.jobId)
        && String(session.report_id) === String(navigationTarget.targetId))
      : sessions.find((session) => sameJobId(session.job_id, navigationTarget.jobId)
        && String(session.id) === String(navigationTarget.targetId));
    consumedNavigationTargetRef.current = navigationTarget.key;
    if (!matchedSession) {
      setFocusedSessionId(null);
      setNavigationNotice({
        type: 'warning',
        text: navigationTarget.type === 'report'
          ? '未找到该报告所属的面试轮次，已打开当前岗位的面试安排。'
          : '未找到该面试轮次，已打开当前岗位的面试安排。',
      });
      onNavigationTargetConsumed?.(navigationTarget.key, { found: false });
      return;
    }
    setFocusedSessionId(matchedSession.id);
    setExpandedSessionId(String(matchedSession.id));
    if (navigationTarget.type === 'session') {
      setExpandedLogisticsBySession((current) => ({
        ...current,
        [String(matchedSession.id)]: true,
      }));
    }
    setCandidateId(matchedSession.candidate_id || '');
    setNavigationNotice({
      type: 'success',
      text: navigationTarget.type === 'report'
        ? `已定位报告所属的第 ${matchedSession.round} 轮面试。`
        : `已定位第 ${matchedSession.round} 轮面试。`,
    });
    window.setTimeout(() => {
      const card = sessionCardRefs.current.get(String(matchedSession.id));
      if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
    onNavigationTargetConsumed?.(navigationTarget.key, { found: true, sessionId: matchedSession.id });
  }, [navigationTarget, renderedJobId, sessions, onNavigationTargetConsumed]);

  if (!job) {
    return (
      <InterviewScheduleEmptyState
        job={null}
        onOpenJobs={onOpenJobs}
        onOpenCandidates={onOpenCandidates}
        onRetry={onRefresh}
      />
    );
  }
  if (!workbench) {
    if (loadState === 'error') {
      return (
        <InterviewScheduleLoadingState
          job={job}
          error={loadError || '当前无法确认面试安排；不会把读取失败当作空数据。'}
          onRetry={onRefresh}
        />
      );
    }
    if (loadState === 'loading') {
      return <InterviewScheduleLoadingState job={job} error="" onRetry={onRefresh} />;
    }
    return (
      <InterviewScheduleEmptyState
        job={job}
        onOpenJobs={onOpenJobs}
        onOpenCandidates={onOpenCandidates}
        onRetry={onRefresh}
      />
    );
  }
  if (workbench.data_class === 'fixture' && !fixtureMode) {
    return <Alert type="warning" showIcon message="测试面试数据缺少隔离适配器，已拒绝进入正式写入路径" />;
  }

  const canonicalPartitionReady = Array.isArray(canonicalSessions) && !canonicalLoadError;
  const canonicalWritesBlocked = !canonicalPartitionReady;

  function requireCanonicalWritePartition() {
    if (canonicalPartitionReady) return true;
    setError('正式面试权威数据尚未恢复；请先重新读取，恢复前不能提交相关面试操作。');
    return false;
  }

  const selectedSessions = sessionsForCandidate(sessions, candidateId);
  const selectedLatestSession = selectedSessions[selectedSessions.length - 1] || null;
  const selectedNextRound = selectedSessions.length
    ? Math.max(...selectedSessions.map((session) => Number(session.round))) + 1
    : 1;
  const canCreateSelected = canonicalPartitionReady && !!candidateId
    && (!selectedLatestSession || NEXT_ROUND_ALLOWED_SESSION_STATUSES.has(selectedLatestSession.status));
  const activeInterviewerOptions = interviewers
    .filter((interviewer) => Number(interviewer.active) === 1)
    .map((interviewer) => ({ value: interviewer.id, label: interviewer.name }));

  async function createSession(targetCandidateId, targetFormat) {
    if (!requireCanonicalWritePartition()) return;
    const context = jobContextRef.current;
    const candidateSessions = sessionsForCandidate(sessions, targetCandidateId);
    const latest = candidateSessions[candidateSessions.length - 1] || null;
    if (latest && !NEXT_ROUND_ALLOWED_SESSION_STATUSES.has(latest.status)) {
      setError(`第 ${latest.round} 轮尚未结束，请先处理当前面试。`);
      return;
    }
    const round = candidateSessions.length
      ? Math.max(...candidateSessions.map((session) => Number(session.round))) + 1
      : 1;
    const key = `create:${targetCandidateId}:${round}`;
    setBusy(key);
    setError('');
    setOperationNotice(null);
    try {
      await scheduleAdapter.createSession({
        candidateId: targetCandidateId,
        jobId: Number(context.jobId),
        round,
        interviewFormat: targetFormat,
      });
    } catch (err) {
      if (isCurrentContext(context)) setError(err.message);
      if (isCurrentContext(context)) setBusy('');
      return;
    }
    if (!isCurrentContext(context)) return;
    setCommittedAction(key, true);
    setOperationNotice({ type: 'success', text: `第 ${round} 轮面试已创建。` });
    try {
      const canonicalUpdated = await loadCanonicalSessions(context);
      if (!isCurrentContext(context)) return;
      if (!canonicalUpdated) throw new Error('正式面试数据暂未刷新');
      await onRefresh();
      if (!isCurrentContext(context)) return;
      setCommittedAction(key, false);
    } catch (refreshError) {
      if (isCurrentContext(context)) {
        setOperationNotice({
          type: 'warning',
          text: `第 ${round} 轮面试已创建，但最新面试台账暂未刷新：${refreshError.message || '请稍后重新打开本页查看。'}`,
        });
      }
    } finally {
      if (isCurrentContext(context)) setBusy('');
    }
  }

  async function schedule(session) {
    if (!requireCanonicalWritePartition()) return;
    const context = jobContextRef.current;
    const value = times[session.id];
    const form = scheduleForms[session.id] || initialScheduleForm(session);
    setScheduleValidationAttempts((current) => ({ ...current, [session.id]: true }));
    const validationErrors = scheduleFormErrors(value, form, interviewers);
    const firstInvalidField = Object.keys(validationErrors)[0];
    if (firstInvalidField) {
      setError(validationErrors[firstInvalidField]);
      requestAnimationFrame(() => {
        const card = sessionCardRefs.current.get(String(session.id));
        const field = card?.querySelector(`[aria-label="${SCHEDULE_ERROR_FIELD_LABELS[firstInvalidField]}"]`);
        if (field && typeof field.focus === 'function') field.focus();
      });
      return;
    }
    const duration = Number(form.durationMinutes);
    const leadInterviewerId = Number(form.leadInterviewerId);
    const participantInterviewerIds = [...new Set((form.participantInterviewerIds || []).map(Number))];
    const logistics = {
      interviewFormat: form.interviewFormat,
      durationMinutes: duration,
      interviewerAssignments: [
        { interviewerId: leadInterviewerId, role: 'lead' },
        ...participantInterviewerIds.map((interviewerId) => ({ interviewerId, role: 'participant' })),
      ],
      meetingPlatform: form.interviewFormat === 'online' ? String(form.meetingPlatform || '').trim() : '',
      meetingLink: form.interviewFormat === 'online' ? String(form.meetingLink || '').trim() : '',
      locationAddress: form.interviewFormat === 'offline' ? String(form.locationAddress || '').trim() : '',
      locationRoom: form.interviewFormat === 'offline' ? String(form.locationRoom || '').trim() : '',
      logisticsNote: String(form.logisticsNote || '').trim(),
    };
    const key = `schedule:${session.id}`;
    setBusy(key);
    setError('');
    setOperationNotice(null);
    try {
      await scheduleAdapter.confirmSchedule(session.id, value.toISOString(), freshRequestId(session.id), logistics);
    } catch (err) {
      if (isCurrentContext(context)) setError(err.message);
      if (isCurrentContext(context)) setBusy('');
      return;
    }
    if (!isCurrentContext(context)) return;
    setCommittedAction(key, true);
    setTimes((current) => ({ ...current, [session.id]: null }));
    setScheduleValidationAttempts((current) => ({ ...current, [session.id]: false }));
    setOperationNotice({ type: 'success', text: session.scheduled_at ? '面试改期已提交。' : '面试排期已提交。' });
    try {
      const canonicalUpdated = await loadCanonicalSessions(context);
      if (!isCurrentContext(context)) return;
      if (!canonicalUpdated) throw new Error('正式面试数据暂未刷新');
      await onRefresh();
      if (!isCurrentContext(context)) return;
      setCommittedAction(key, false);
    } catch (refreshError) {
      if (isCurrentContext(context)) {
        setOperationNotice({
          type: 'warning',
          text: `${session.scheduled_at ? '面试改期' : '面试排期'}已提交，但最新面试台账暂未刷新：${refreshError.message || '请稍后重新打开本页查看。'}`,
        });
      }
    } finally {
      if (isCurrentContext(context)) setBusy('');
    }
  }

  async function cancelSession(session) {
    if (!requireCanonicalWritePartition()) return;
    const context = jobContextRef.current;
    const reasonCode = cancelReasons[session.id];
    if (!reasonCode) { setError('请先选择取消原因'); return; }
    const key = `cancel:${session.id}`;
    setBusy(key);
    setError('');
    setOperationNotice(null);
    try {
      await scheduleAdapter.cancelSession(session.id, reasonCode);
    } catch (err) {
      if (isCurrentContext(context)) setError(err.message);
      if (isCurrentContext(context)) setBusy('');
      return;
    }
    if (!isCurrentContext(context)) return;
    setCommittedAction(key, true);
    setOperationNotice({ type: 'success', text: '本轮面试已取消。' });
    try {
      const canonicalUpdated = await loadCanonicalSessions(context);
      if (!isCurrentContext(context)) return;
      if (!canonicalUpdated) throw new Error('正式面试数据暂未刷新');
      await onRefresh();
      if (!isCurrentContext(context)) return;
      setCommittedAction(key, false);
    } catch (refreshError) {
      if (isCurrentContext(context)) {
        setOperationNotice({
          type: 'warning',
          text: `本轮面试已取消，但最新面试台账暂未刷新：${refreshError.message || '请稍后重新打开本页查看。'}`,
        });
      }
    } finally {
      if (isCurrentContext(context)) setBusy('');
    }
  }

  async function saveInterviewer(input, key) {
    const context = jobContextRef.current;
    setBusy(key);
    setError('');
    setOperationNotice(null);
    try {
      await scheduleAdapter.saveInterviewer(input);
    } catch (err) {
      if (isCurrentContext(context)) setError(err.message);
      if (isCurrentContext(context)) setBusy('');
      return;
    }
    if (!isCurrentContext(context)) return;
    setCommittedAction(key, true);
    if (!input.id) setInterviewerNameDraft('');
    setOperationNotice({ type: 'success', text: input.id ? '面试官状态已更新。' : '面试官已新增。' });
    try {
      const directoryUpdated = await loadInterviewerDirectory(context);
      if (!isCurrentContext(context)) return;
      if (!directoryUpdated) throw new Error('面试官名录暂未刷新');
      setCommittedAction(key, false);
    } catch (refreshError) {
      if (isCurrentContext(context)) {
        setOperationNotice({
          type: 'warning',
          text: `${input.id ? '面试官状态已更新' : '面试官已新增'}，但名录暂未刷新：${refreshError.message || '请稍后重新打开本页查看。'}`,
        });
      }
    } finally {
      if (isCurrentContext(context)) setBusy('');
    }
  }

  async function markInvitationSent(session) {
    if (!requireCanonicalWritePartition()) return;
    const context = jobContextRef.current;
    const key = `invitation:${session.id}`;
    setBusy(key);
    setError('');
    setOperationNotice(null);
    try {
      await scheduleAdapter.markInvitationSent(session.id);
    } catch (err) {
      if (isCurrentContext(context)) setError(err.message);
      if (isCurrentContext(context)) setBusy('');
      return;
    }
    if (!isCurrentContext(context)) return;
    setCommittedAction(key, true);
    setOperationNotice({ type: 'success', text: '邀请发送事实已记录。' });
    try {
      const canonicalUpdated = await loadCanonicalSessions(context);
      if (!isCurrentContext(context)) return;
      if (!canonicalUpdated) throw new Error('正式面试数据暂未刷新');
      await onRefresh();
      if (!isCurrentContext(context)) return;
      setCommittedAction(key, false);
    } catch (refreshError) {
      if (isCurrentContext(context)) {
        setOperationNotice({
          type: 'warning',
          text: `邀请发送事实已记录，但最新面试台账暂未刷新：${refreshError.message || '请稍后重新打开本页查看。'}`,
        });
      }
    } finally {
      if (isCurrentContext(context)) setBusy('');
    }
  }

  async function recordCandidateConfirmation(session) {
    if (!requireCanonicalWritePartition()) return;
    const context = jobContextRef.current;
    const status = candidateConfirmationDrafts[session.id] || session.candidate_confirmation_status || 'pending';
    const key = `candidate-confirmation:${session.id}`;
    setBusy(key);
    setError('');
    setOperationNotice(null);
    try {
      await scheduleAdapter.recordCandidateConfirmation(session.id, status);
    } catch (err) {
      if (isCurrentContext(context)) setError(err.message);
      if (isCurrentContext(context)) setBusy('');
      return;
    }
    if (!isCurrentContext(context)) return;
    setCommittedAction(key, true);
    setOperationNotice({ type: 'success', text: '候选人反馈已记录。' });
    try {
      const canonicalUpdated = await loadCanonicalSessions(context);
      if (!isCurrentContext(context)) return;
      if (!canonicalUpdated) throw new Error('正式面试数据暂未刷新');
      await onRefresh();
      if (!isCurrentContext(context)) return;
      setCommittedAction(key, false);
    } catch (refreshError) {
      if (isCurrentContext(context)) {
        setOperationNotice({
          type: 'warning',
          text: `候选人反馈已记录，但最新面试台账暂未刷新：${refreshError.message || '请稍后重新打开本页查看。'}`,
        });
      }
    } finally {
      if (isCurrentContext(context)) setBusy('');
    }
  }

  const scheduleChecklist = [
    { key: 'schedule', label: '待排期', count: sessions.filter((session) => session.status === 'draft').length },
    { key: 'invite', label: '待发送邀约', count: sessions.filter((session) => session.status === 'scheduled' && session.invitation_status !== 'sent').length },
    { key: 'confirmation', label: '待候选人确认', count: sessions.filter((session) => session.status === 'scheduled' && session.invitation_status === 'sent' && (!session.candidate_confirmation_status || session.candidate_confirmation_status === 'pending')).length },
    { key: 'review', label: '待人工复盘', count: sessions.filter((session) => session.status === 'pending_review').length },
  ];

  return <section
    className="interview-schedule-panel interview-schedule-canonical"
    data-interview-workspace="canonical"
    data-fixture-mode={fixtureMode ? 'true' : 'false'}
  >
    <div className="interview-schedule-head">
      <div>
        <div className="interview-schedule-title">
          <Title level={2}>{job?.name || '当前岗位'} · 面试安排</Title>
          {fixtureMode && <Tag color="gold">测试数据 · 隔离模拟</Tag>}
        </div>
        <Text type="secondary">时间只能由 HR 明确选择并确认；系统不自动定时间。取消与爽约都保留本轮记录，不删除历史。</Text>
      </div>
    </div>
    {readOnly && <Alert type="warning" showIcon message={job?.status === 'closed' ? '岗位已关闭，面试历史只读' : '当前为只读模式'} description="既有面试轮次、排期记录和邀约草稿仍可查看；创建、改期和取消等写动作已禁用。" />}
    {error && <Alert type="error" showIcon message={error} />}
    {operationNotice && <Alert type={operationNotice.type} showIcon message={operationNotice.text} />}
    {navigationNotice && <Alert type={navigationNotice.type} showIcon message={navigationNotice.text} />}
    {canonicalLoadError && <Alert
      type="error"
      showIcon
      message="正式面试权威数据读取失败，相关写操作已暂停"
      description={`${canonicalLoadError}。当前工作台缓存仅供查看；恢复成功前不能创建、排期、改期、取消、标记爽约或记录邀约确认。`}
      action={<Button size="small" loading={canonicalRefreshBusy} onClick={retryCanonicalSessions}>重新读取正式面试</Button>}
    />}
    {!canonicalLoadError && !canonicalPartitionReady && <Alert
      type="info"
      showIcon
      message="正在读取正式面试"
      description="权威数据返回前，相关写操作暂不可用；已有工作台缓存仍可查看。"
    />}
    {loadState === 'stale' && <Alert type="warning" showIcon message="当前为上次成功数据" description={loadError} />}

    <section aria-label="面试安排页内待办清单">
      <Space wrap role="list">
        {scheduleChecklist.map((item) => <span key={item.key} role="listitem">
          <SemanticTag kind={item.count ? 'waiting' : 'success'}>{item.count ? '待处理' : '无待办'}</SemanticTag>
          <Text>{item.label} {item.count}</Text>
        </span>)}
      </Space>
    </section>

    {!readOnly && <Collapse
      items={[
        {
          key: 'session-create',
          label: '新建面试',
          children: (
            <Card size="small" title="创建面试轮次">
              <Space wrap>
                <Select
                  aria-label="创建面试候选人"
                  showSearch
                  optionFilterProp="label"
                  style={{ minWidth: 240 }}
                  placeholder="选择当前岗位候选人"
                  value={candidateId || undefined}
                  onChange={setCandidateId}
                  options={candidates.map((candidate) => ({
                    value: candidate.internal_id,
                    label: `${candidate.name || candidate.internal_id}${candidate.sabc ? ` · ${candidate.sabc}` : ''}`,
                  }))}
                />
                <Select
                  aria-label="创建面试形式"
                  value={mode}
                  onChange={setMode}
                  options={INTERVIEW_FORMAT_OPTIONS}
                />
                <Button
                  type="primary"
                  disabled={canonicalWritesBlocked || !canCreateSelected || isCommittedAction(`create:${candidateId}:${selectedNextRound}`)}
                  loading={busy === `create:${candidateId}:${selectedNextRound}`}
                  onClick={() => createSession(candidateId, mode)}
                >
                  {fixtureMode ? '模拟创建面试' : selectedNextRound === 1 ? '创建首轮面试' : `新建第 ${selectedNextRound} 轮`}
                </Button>
                {selectedLatestSession && !canCreateSelected && <Text type="secondary">第 {selectedLatestSession.round} 轮仍为“{STATUS_LABELS[selectedLatestSession.status] || selectedLatestSession.status}”</Text>}
              </Space>
            </Card>
          ),
        },
        {
          key: 'interviewer-directory',
          label: '管理面试官',
          children: (
            <Card size="small" title="本地面试官名录">
              <Space wrap>
                <Input
                  aria-label="新增面试官姓名"
                  name="interview-schedule-new-interviewer-name"
                  autoComplete="off"
                  value={interviewerNameDraft}
                  placeholder="新增面试官姓名"
                  maxLength={200}
                  onChange={(event) => setInterviewerNameDraft(event.target.value)}
                />
                <Button
                  disabled={!interviewerNameDraft.trim() || isCommittedAction('interviewer:create')}
                  loading={busy === 'interviewer:create'}
                  onClick={() => saveInterviewer({ name: interviewerNameDraft.trim(), active: true }, 'interviewer:create')}
                >新增面试官</Button>
                {interviewers.map((interviewer) => <Space key={interviewer.id}>
                  <Tag color={Number(interviewer.active) === 1 ? 'green' : 'default'}>{interviewer.name} · {Number(interviewer.active) === 1 ? '启用' : '停用'}</Tag>
                  <Popconfirm
                    title={`确认${Number(interviewer.active) === 1 ? '停用' : '启用'}该面试官？`}
                    okText="确认"
                    cancelText="返回"
                    onConfirm={() => saveInterviewer({ id: interviewer.id, active: Number(interviewer.active) !== 1 }, `interviewer:${interviewer.id}`)}
                  >
                    <Button size="small" disabled={isCommittedAction(`interviewer:${interviewer.id}`)} loading={busy === `interviewer:${interviewer.id}`}>{Number(interviewer.active) === 1 ? '停用' : '启用'}</Button>
                  </Popconfirm>
                </Space>)}
              </Space>
            </Card>
          ),
        },
      ]}
    />}

    {sessions.length ? <Collapse
      accordion
      activeKey={expandedSessionId || undefined}
      onChange={(key) => setExpandedSessionId(Array.isArray(key) ? String(key[0] || '') : String(key || ''))}
      items={orderedSessions.map((session) => {
      const candidateSessions = sessionsForCandidate(sessions, session.candidate_id);
      const latest = candidateSessions[candidateSessions.length - 1];
      const nextRound = Math.max(...candidateSessions.map((item) => Number(item.round))) + 1;
      const isLatest = Number(latest.id) === Number(session.id);
      const canSchedule = session.status === 'draft' || session.status === 'scheduled';
      const selectedScheduleTime = times[session.id] || null;
      const selectedScheduleInPast = !!selectedScheduleTime && selectedScheduleTime.valueOf() <= Date.now();
      const scheduleForm = scheduleForms[session.id] || initialScheduleForm(session);
      const scheduleErrors = scheduleFormErrors(selectedScheduleTime, scheduleForm, interviewers);
      const showScheduleErrors = scheduleValidationAttempts[session.id] === true;
      const visibleScheduleErrors = showScheduleErrors ? Object.values(scheduleErrors) : [];
      const scheduleErrorId = `schedule-errors-${session.id}`;
      const updateScheduleForm = (patch) => {
        setScheduleForms((current) => ({
          ...current,
          [session.id]: { ...scheduleForm, ...patch },
        }));
        if (showScheduleErrors) setError('');
      };
      const cancelReasonLabel = CANCEL_REASON_LABELS[session.cancel_reason] || session.cancel_reason;
      const invitationEditorKey = [
        session.id,
        session.scheduled_at,
        session.interview_format,
        session.logistics_version,
        session.invitation_status,
        session.candidate_confirmation_status,
        session.candidate_name,
        job?.name,
        session.status,
      ].join(':');
      const isCurrentSession = String(session.id) === currentSessionId;
      return {
        key: String(session.id),
        label: <Space wrap>
          <strong>{session.candidate_name}</strong>
          <Tag color={isCurrentSession ? 'blue' : 'default'}>{isCurrentSession ? '当前面试' : '历史面试'}</Tag>
          <Tag>第 {session.round} 轮</Tag>
          <Tag color={session.status === 'cancelled' ? 'default' : session.status === 'confirmed' ? 'green' : 'blue'}>{STATUS_LABELS[session.status] || session.status}</Tag>
          <Text>{session.scheduled_at ? fmtTime(session.scheduled_at) : '尚未定档'}</Text>
          <Text type="secondary">当前待办：{sessionCurrentTodo(session)}</Text>
        </Space>,
        children: <div
        key={session.id}
        ref={(node) => {
          if (node) sessionCardRefs.current.set(String(session.id), node);
          else sessionCardRefs.current.delete(String(session.id));
        }}
        data-session-id={session.id}
        data-workbench-focus={String(focusedSessionId) === String(session.id) ? 'true' : undefined}
        style={String(focusedSessionId) === String(session.id)
          ? { borderColor: '#1677ff', boxShadow: '0 0 0 2px rgba(22, 119, 255, 0.16)' }
          : undefined}
      >
        <Space wrap>
          <strong>{session.candidate_name}</strong>
          <Tag>第 {session.round} 轮</Tag>
          <Tag>{INTERVIEW_FORMAT_LABELS[session.interview_format || session.mode] || session.interview_format || session.mode}</Tag>
          <Tag color={session.status === 'cancelled' ? 'default' : session.status === 'confirmed' ? 'green' : 'blue'}>{STATUS_LABELS[session.status] || session.status}</Tag>
          <span>{session.scheduled_at ? fmtTime(session.scheduled_at) : '尚未定档'}</span>
          {cancelReasonLabel && <Tag color="default">原因：{cancelReasonLabel}</Tag>}
          {session.report_status && <Tag color={session.report_status === 'confirmed' ? 'green' : 'gold'}>报告 {session.report_status}</Tag>}
          <Button size="small" onClick={() => onOpenCandidate(session.candidate_id, 'interview')}>打开候选人</Button>
          {!readOnly && isLatest && NEXT_ROUND_ALLOWED_SESSION_STATUSES.has(session.status) && <Button
            size="small"
            disabled={canonicalWritesBlocked || isCommittedAction(`create:${session.candidate_id}:${nextRound}`)}
            loading={busy === `create:${session.candidate_id}:${nextRound}`}
            onClick={() => createSession(session.candidate_id, session.interview_format || session.mode)}
          >新建第 {nextRound} 轮</Button>}
        </Space>
        {!readOnly && canSchedule && <Card size="small" style={{ marginTop: 12 }} title={session.scheduled_at ? '人工改期与物流' : '人工排期与物流'}>
          {session.scheduled_at && <Alert type="warning" showIcon message="改期会使当前“已发送”和候选人确认状态失效，改期后请重新复制、发送并记录确认。" />}
          <Space wrap style={{ marginTop: 12 }}>
            <DatePicker
              aria-label="面试时间"
              aria-required="true"
              aria-invalid={showScheduleErrors && Boolean(scheduleErrors.time)}
              aria-describedby={showScheduleErrors && scheduleErrors.time ? scheduleErrorId : undefined}
              status={showScheduleErrors && scheduleErrors.time ? 'error' : undefined}
              showTime
              value={selectedScheduleTime}
              placeholder={session.status === 'scheduled' ? '选择新的面试时间' : '选择面试时间'}
              onChange={(value) => {
                setTimes((old) => ({ ...old, [session.id]: value }));
                if (showScheduleErrors) setError('');
              }}
              disabledDate={(current) => !!current && current.endOf('day').valueOf() < Date.now()}
            />
            <Select
              aria-label="排期面试形式"
              value={scheduleForm.interviewFormat}
              options={INTERVIEW_FORMAT_OPTIONS}
              onChange={(value) => updateScheduleForm({
                interviewFormat: value,
                ...(value === 'online' ? { locationAddress: '', locationRoom: '' } : { meetingPlatform: '', meetingLink: '' }),
                ...(value === 'phone' ? { locationAddress: '', locationRoom: '', meetingPlatform: '', meetingLink: '' } : {}),
              })}
            />
            <Space.Compact>
              <InputNumber
                aria-label="面试时长（分钟）"
                name={`interview-schedule-duration-${session.id}`}
                autoComplete="off"
                inputMode="numeric"
                aria-required="true"
                aria-invalid={showScheduleErrors && Boolean(scheduleErrors.duration)}
                aria-describedby={showScheduleErrors && scheduleErrors.duration ? scheduleErrorId : undefined}
                status={showScheduleErrors && scheduleErrors.duration ? 'error' : undefined}
                min={5}
                max={480}
                precision={0}
                value={scheduleForm.durationMinutes}
                onChange={(value) => updateScheduleForm({ durationMinutes: value })}
              />
              <Button disabled aria-hidden="true">分钟</Button>
            </Space.Compact>
            <Select
              aria-label="主面试官"
              aria-required="true"
              aria-invalid={showScheduleErrors && Boolean(scheduleErrors.lead)}
              aria-describedby={showScheduleErrors && scheduleErrors.lead ? scheduleErrorId : undefined}
              status={showScheduleErrors && scheduleErrors.lead ? 'error' : undefined}
              showSearch
              optionFilterProp="label"
              placeholder="选择主面试官"
              value={scheduleForm.leadInterviewerId || undefined}
              options={activeInterviewerOptions}
              onChange={(value) => updateScheduleForm({
                leadInterviewerId: value,
                participantInterviewerIds: (scheduleForm.participantInterviewerIds || []).filter((id) => Number(id) !== Number(value)),
              })}
            />
            <Select
              aria-label="参与面试官"
              aria-invalid={showScheduleErrors && Boolean(scheduleErrors.participants)}
              aria-describedby={showScheduleErrors && scheduleErrors.participants ? scheduleErrorId : undefined}
              status={showScheduleErrors && scheduleErrors.participants ? 'error' : undefined}
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder="选择参与人（可多选）"
              value={scheduleForm.participantInterviewerIds}
              options={activeInterviewerOptions.filter((option) => Number(option.value) !== Number(scheduleForm.leadInterviewerId))}
              onChange={(value) => updateScheduleForm({ participantInterviewerIds: value })}
            />
            {scheduleForm.interviewFormat === 'online' && <>
              <Input
                aria-label="会议平台"
                name={`interview-schedule-meeting-platform-${session.id}`}
                autoComplete="off"
                placeholder="会议平台（可选）…"
                value={scheduleForm.meetingPlatform}
                onChange={(event) => updateScheduleForm({ meetingPlatform: event.target.value })}
              />
              <Input
                aria-label="会议链接"
                name={`interview-schedule-meeting-link-${session.id}`}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                aria-required="true"
                aria-invalid={showScheduleErrors && Boolean(scheduleErrors.meetingLink)}
                aria-describedby={showScheduleErrors && scheduleErrors.meetingLink ? scheduleErrorId : undefined}
                status={showScheduleErrors && scheduleErrors.meetingLink ? 'error' : undefined}
                placeholder="例如：https://meeting.example.com/room…"
                value={scheduleForm.meetingLink}
                onChange={(event) => updateScheduleForm({ meetingLink: event.target.value })}
              />
            </>}
            {scheduleForm.interviewFormat === 'offline' && <>
              <Input
                aria-label="面试地址"
                name={`interview-schedule-location-address-${session.id}`}
                autoComplete="off"
                aria-required="true"
                aria-invalid={showScheduleErrors && Boolean(scheduleErrors.locationAddress)}
                aria-describedby={showScheduleErrors && scheduleErrors.locationAddress ? scheduleErrorId : undefined}
                status={showScheduleErrors && scheduleErrors.locationAddress ? 'error' : undefined}
                placeholder="面试地址（必填）…"
                value={scheduleForm.locationAddress}
                onChange={(event) => updateScheduleForm({ locationAddress: event.target.value })}
              />
              <Input
                aria-label="房间"
                name={`interview-schedule-location-room-${session.id}`}
                autoComplete="off"
                placeholder="房间（可选）…"
                value={scheduleForm.locationRoom}
                onChange={(event) => updateScheduleForm({ locationRoom: event.target.value })}
              />
            </>}
            {scheduleForm.interviewFormat === 'phone' && <Text type="secondary">电话面试不登记会议链接或线下地址。</Text>}
            <Input.TextArea
              aria-label="面试物流说明"
              name={`interview-schedule-logistics-note-${session.id}`}
              autoComplete="off"
              placeholder="面试说明（可选）…"
              value={scheduleForm.logisticsNote}
              autoSize={{ minRows: 1, maxRows: 4 }}
              onChange={(event) => updateScheduleForm({ logisticsNote: event.target.value })}
            />
            {visibleScheduleErrors.length > 0 && <Alert
              id={scheduleErrorId}
              role="alert"
              type="error"
              showIcon
              message="请补全排期必填项"
              description={visibleScheduleErrors.join('；')}
            />}
            {session.scheduled_at ? <Popconfirm
              title="确认人工改期？"
              description="当前邀请发送状态和候选人确认状态会失效，改期后需要重新处理。"
              okText="确认改期"
              cancelText="返回"
              disabled={canonicalWritesBlocked || !selectedScheduleTime || selectedScheduleInPast || isCommittedAction(`schedule:${session.id}`)}
              onConfirm={() => schedule(session)}
            >
              <Button
                type="primary"
                aria-describedby={visibleScheduleErrors.length > 0 ? scheduleErrorId : undefined}
                disabled={canonicalWritesBlocked || !selectedScheduleTime || selectedScheduleInPast || isCommittedAction(`schedule:${session.id}`)}
                loading={busy === `schedule:${session.id}`}
              >人工确认改期</Button>
            </Popconfirm> : <Button
              type="primary"
              aria-describedby={visibleScheduleErrors.length > 0 ? scheduleErrorId : undefined}
              disabled={canonicalWritesBlocked || selectedScheduleInPast || isCommittedAction(`schedule:${session.id}`)}
              loading={busy === `schedule:${session.id}`}
              onClick={() => schedule(session)}
            >人工确认排期</Button>}
            {selectedScheduleInPast && <Text type="danger">请选择晚于当前时间</Text>}
          </Space>
        </Card>}
        {!readOnly && canSchedule && <Space wrap style={{ marginTop: 12 }}>
          <Select
            aria-label="取消原因"
            style={{ minWidth: 160 }}
            placeholder="选择取消原因"
            value={cancelReasons[session.id] || undefined}
            onChange={(value) => setCancelReasons((old) => ({ ...old, [session.id]: value }))}
            options={CANCEL_REASON_OPTIONS}
          />
          <Popconfirm
            title="确认取消本轮面试？"
            description="取消后本轮保留在历史中；如需再次面试，请新建下一轮。"
            disabled={canonicalWritesBlocked || !cancelReasons[session.id]}
            okText="确认取消"
            cancelText="返回"
            onConfirm={() => cancelSession(session)}
          >
            <Button danger disabled={canonicalWritesBlocked || !cancelReasons[session.id] || isCommittedAction(`cancel:${session.id}`)} loading={busy === `cancel:${session.id}`}>取消本轮</Button>
          </Popconfirm>
        </Space>}
        <Collapse
          ghost
          style={{ marginTop: 12 }}
          activeKey={expandedLogisticsBySession[String(session.id)] ? ['details'] : []}
          onChange={(keys) => {
            const expanded = (Array.isArray(keys) ? keys : [keys]).includes('details');
            setExpandedLogisticsBySession((current) => ({
              ...current,
              [String(session.id)]: expanded,
            }));
          }}
          items={[{
            key: 'details',
            label: '邀请、物流与历史',
            children: <>
              <Card size="small" title="当前面试物流">
                <LogisticsSnapshot snapshot={currentLogistics(session)} label="当前记录" />
              </Card>
              <InterviewInvitationEditor key={invitationEditorKey} session={session} job={job} />
              {session.scheduled_at && session.status !== 'cancelled' && <Card size="small" style={{ marginTop: 12 }} title="邀请发送与候选人反馈">
                <Space wrap>
                  <Tag color={session.invitation_status === 'sent' ? 'green' : 'default'}>
                    {session.invitation_status === 'sent'
                      ? `已发送 · ${session.invitation_sent_by || 'HR'} · ${fmtTime(session.invitation_sent_at)}`
                      : '未标记发送'}
                  </Tag>
                  {!readOnly && session.invitation_status !== 'sent' && <Popconfirm
                    title="确认已由 HR 手工发送邀请？"
                    description="这里只记录发送事实，不会自动发送任何消息。"
                    okText="确认已发送"
                    cancelText="返回"
                    disabled={canonicalWritesBlocked || isCommittedAction(`invitation:${session.id}`)}
                    onConfirm={() => markInvitationSent(session)}
                  >
                    <Button disabled={canonicalWritesBlocked || isCommittedAction(`invitation:${session.id}`)} loading={busy === `invitation:${session.id}`}>标记已手工发送</Button>
                  </Popconfirm>}
                  <Tag>{CANDIDATE_CONFIRMATION_LABELS[session.candidate_confirmation_status] || session.candidate_confirmation_status || '待候选人确认'}</Tag>
                  {session.candidate_confirmation_recorded_at && <Text type="secondary">{session.candidate_confirmation_recorded_by || 'HR'} · {fmtTime(session.candidate_confirmation_recorded_at)}</Text>}
                  {!readOnly && <>
                    <Select
                      aria-label="候选人确认状态"
                      value={candidateConfirmationDrafts[session.id] || session.candidate_confirmation_status || 'pending'}
                      options={CANDIDATE_CONFIRMATION_OPTIONS}
                      onChange={(value) => setCandidateConfirmationDrafts((current) => ({ ...current, [session.id]: value }))}
                    />
                    <Popconfirm
                      title="确认记录候选人反馈？"
                      description="这只更新候选人确认状态，不会改变本轮面试状态。"
                      okText="确认记录"
                      cancelText="返回"
                      disabled={canonicalWritesBlocked || isCommittedAction(`candidate-confirmation:${session.id}`)}
                      onConfirm={() => recordCandidateConfirmation(session)}
                    >
                      <Button disabled={canonicalWritesBlocked || isCommittedAction(`candidate-confirmation:${session.id}`)} loading={busy === `candidate-confirmation:${session.id}`}>记录候选人反馈</Button>
                    </Popconfirm>
                  </>}
                </Space>
              </Card>}
              <ScheduleConfirmationHistory session={session} />
            </>,
          }]}
        />
      </div>,
      };
    })}
    /> : (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="暂无面试安排"
      >
        {onOpenCandidates ? (
          <Button type="primary" onClick={onOpenCandidates}>选择候选人并创建首轮</Button>
        ) : <Text type="secondary">请先选择候选人，再为其创建首轮面试。</Text>}
      </Empty>
    )}

    <Collapse
      style={{ marginTop: 12 }}
      items={[{
        key: 'local-tools',
        label: '面试资料与录音工具',
        children: (
          <LocalInterviewPanel
            readOnly={readOnly}
            jobClosed={job?.status === 'closed'}
            contextJobId={job?.id}
            onOpenSettings={onOpenSettings}
            fixtureMode={fixtureMode}
          />
        ),
      }]}
    />
  </section>;
}
