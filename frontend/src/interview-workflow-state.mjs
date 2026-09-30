import { localInterviewRecordingFinalizationUiState } from './interview-review-navigation.mjs';

const STARTED_SESSION_STATUSES = new Set([
  'in_progress',
  'pending_review',
  'pending_confirmation',
  'confirmed',
]);

const PRESTART_SESSION_STATUSES = new Set([
  'draft',
  'pending_schedule',
  'scheduled',
]);

const TERMINAL_SESSION_STATUSES = new Set(['confirmed', 'cancelled', 'rejected', 'completed', 'archived']);
const ACTIONABLE_TODO_TONES = new Set(['warning', 'blocked', 'ready', 'processing', 'error']);

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function joinParts(parts) {
  return parts.filter(Boolean).join(' · ');
}

function formatSeconds(value) {
  const total = Number(value);
  if (!Number.isFinite(total) || total < 0) return '暂无';
  const minutes = Math.floor(total / 60);
  const seconds = Math.round(total % 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours}:${String(rest).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function interviewSessionProgress(sessions = []) {
  const statuses = (Array.isArray(sessions) ? sessions : [])
    .map((session) => clean(session?.status))
    .filter(Boolean);
  const count = (status) => statuses.filter((value) => value === status).length;
  return {
    total: statuses.length,
    inProgressCount: count('in_progress'),
    reviewPendingCount: count('pending_review'),
    confirmationPendingCount: count('pending_confirmation'),
    confirmedCount: count('confirmed'),
    cancelledCount: count('cancelled'),
    prestartCount: statuses.filter((status) => PRESTART_SESSION_STATUSES.has(status)).length,
    startedCount: statuses.filter((status) => STARTED_SESSION_STATUSES.has(status)).length,
    terminalOnly: statuses.length > 0 && statuses.every((status) => TERMINAL_SESSION_STATUSES.has(status)),
  };
}

export function deriveWorkflowState({
  script,
  records = [],
  recordCount = records.length,
  reportCount = 0,
  confirmationStats = {},
  confirmedCount = 0,
  localJob,
  candidateId,
  sessions = [],
}) {
  const jobCandidateId = localJob && localJob.bind_candidate_id;
  const isCurrentJob = localJob && (!jobCandidateId || jobCandidateId === candidateId);
  const starting = isCurrentJob && localJob.status === 'starting';
  const running = isCurrentJob && localJob.status === 'running';
  const recordingFinalization = localInterviewRecordingFinalizationUiState(
    isCurrentJob ? localJob : {},
  );
  const pendingConfirmations = Math.max((confirmationStats.total || 0) - (confirmationStats.finished || 0), 0);
  const sessionProgress = interviewSessionProgress(sessions);

  if (starting) {
    return {
      key: 'starting',
      label: '建立录音中',
      step: 'start',
      tone: 'processing',
      message: '正在确认安全守护与持久状态，尚未打开麦克风。',
    };
  }
  if (recordingFinalization.discarding) {
    return {
      key: 'discarding',
      label: '停止清理中',
      step: 'start',
      tone: 'processing',
      message: '授权已撤回；正在停止录音并删除未完成材料，不会生成本次转写或复盘。',
    };
  }
  if (recordingFinalization.transcribing) {
    return {
      key: 'transcribing',
      label: '转写中',
      step: 'start',
      tone: 'processing',
      message: '录音已停止，正在生成转写和复盘输入。',
    };
  }
  if (running && localJob.mode === 'record') {
    return {
      key: 'recording',
      label: '录音中',
      step: 'start',
      tone: 'processing',
      message: joinParts([
        `已录 ${formatSeconds(localJob.elapsed_seconds)}`,
        localJob.planned_duration_seconds ? `预计 ${formatSeconds(localJob.planned_duration_seconds)}` : '手动停止',
      ]),
    };
  }
  if (running && localJob.mode === 'mic-check') {
    return {
      key: 'mic-check',
      label: '预检中',
      step: 'start',
      tone: 'processing',
      message: '正在检查麦克风输入和本地 ASR。',
    };
  }
  if (running) {
    return {
      key: 'processing',
      label: '处理中',
      step: 'start',
      tone: 'processing',
      message: localJob.message || '本地录音任务正在运行。',
    };
  }
  if (isCurrentJob && localJob.status === 'error') {
    return {
      key: 'error',
      label: '异常',
      step: 'start',
      tone: 'error',
      message: localJob.error || localJob.message || '本地录音或转写任务失败。',
    };
  }
  if (!recordCount) {
    if (sessionProgress.inProgressCount > 0) {
      return {
        key: 'session-in-progress',
        label: '面试中',
        step: 'start',
        tone: 'processing',
        message: '面试轮次已开始；脚本缺失不会把流程回退到准备阶段。',
      };
    }
    if (sessionProgress.reviewPendingCount > 0) {
      return {
        key: 'review-pending',
        label: '待复盘',
        step: 'review',
        tone: 'warning',
        message: `${sessionProgress.reviewPendingCount} 个面试轮次待补充复盘材料。`,
      };
    }
    if (sessionProgress.confirmationPendingCount > 0) {
      return {
        key: 'confirm-pending',
        label: '待确认',
        step: 'confirm',
        tone: 'warning',
        message: `${sessionProgress.confirmationPendingCount} 个面试轮次待核对关键事实。`,
      };
    }
    if (sessionProgress.terminalOnly) {
      return {
        key: 'archived',
        label: sessionProgress.confirmedCount ? '已入档' : '已结束',
        step: 'archive',
        tone: 'done',
        message: sessionProgress.confirmedCount
          ? '面试轮次已确认入档；历史脚本缺失不影响当前状态。'
          : '面试轮次已结束，历史材料仍可查看。',
      };
    }
    return script
      ? {
        key: 'script-ready',
        label: '脚本已准备',
        step: 'start',
        tone: 'ready',
        message: '可以进入麦克风预检和正式录音。',
      }
      : {
        key: 'not-ready',
        label: '未准备',
        step: 'prepare',
        tone: 'warning',
        message: '建议先生成结构化面试脚本。',
      };
  }
  if (reportCount < recordCount) {
    return {
      key: 'review-pending',
      label: '待复盘',
      step: 'review',
      tone: 'warning',
      message: '已有录音记录，复盘报告待补齐；可由 HR 人工完成。',
    };
  }
  if (pendingConfirmations > 0) {
    return {
      key: 'confirm-pending',
      label: '待确认',
      step: 'confirm',
      tone: 'warning',
      message: `${pendingConfirmations} 个关键事实待 HR 核对。`,
    };
  }
  if (confirmedCount < recordCount) {
    return {
      key: 'archive-pending',
      label: '待入档',
      step: 'archive',
      tone: 'ready',
      message: '关键事实已处理，等待确认记录入档。',
    };
  }
  return {
    key: 'archived',
    label: '已入档',
    step: 'archive',
    tone: 'done',
    message: '面试记录已确认，可进入后续推进或归档。',
  };
}

export function actionableInterviewTodoItems(items = []) {
  return (Array.isArray(items) ? items : []).filter((item) => ACTIONABLE_TODO_TONES.has(item?.tone));
}

export function interviewLogisticsNeedsAttention(session = {}) {
  if (session?.status !== 'scheduled') return false;
  if (session?.invitation_status !== 'sent') return true;
  return !session?.candidate_confirmation_status || session.candidate_confirmation_status === 'pending';
}
