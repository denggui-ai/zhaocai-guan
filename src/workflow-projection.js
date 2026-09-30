const COMMUNICATION_CODES = Object.freeze([
  'not_contacted',
  'greeted',
  'replied',
  'resume_requested',
  'resume_received',
]);

const DISPOSITION_CODES = Object.freeze([
  'new',
  'under_review',
  'interview_requested',
  'rejected',
  'talent_pool',
  'hired',
  'candidate_withdrew',
  'do_not_contact',
]);

const WORKFLOW_STATUSES = Object.freeze([
  'new',
  'screening',
  'contact_pending',
  'communicating',
  'resume_pending',
  'interview_pending_schedule',
  'interview_scheduled',
  'interview_in_progress',
  'interview_pending_review',
  'report_pending_confirmation',
  'report_confirmed',
  'rejected',
  'talent_pool',
  'hired',
  'candidate_withdrew',
  'do_not_contact',
  'legacy_review_required',
]);

const TODO_CODES = Object.freeze([
  'job_jd_required',
  'job_profile_confirmation_required',
  'candidate_rating_required',
  'contact_required',
  'communication_followup_required',
  'resume_followup_required',
  'candidate_screening_required',
  'assessment_report_required',
  'assessment_review_required',
  'assessment_binding_confirmation_required',
  'material_classification_required',
  'material_assignment_required',
  'schedule_confirmation_required',
  'interview_preparation_required',
  'report_draft_required',
  'report_fact_review_required',
  'report_confirmation_required',
  'final_review_required',
  'final_disposition_confirmation_required',
  'candidate_next_action_due',
  'candidate_next_action_overdue',
  'offer_send_followup_required',
  'offer_response_followup_required',
  'offer_negotiation_followup_required',
  'onboarding_handoff_required',
  'legacy_status_review_required',
  'task_failed_retryable',
]);

const COMMUNICATION_LABEL_TO_CODE = Object.freeze({
  '未打招呼': 'not_contacted',
  '已打招呼': 'greeted',
  '已回复': 'replied',
  '已求简历': 'resume_requested',
  '已收到简历': 'resume_received',
});

const DISPOSITION_LABEL_TO_CODE = Object.freeze({
  '新入库': 'new',
  '待处理': 'under_review',
  '待定': 'under_review',
  '通过': 'under_review',
  '待约面': 'interview_requested',
  '淘汰': 'rejected',
  '暂存人才库': 'talent_pool',
  '备选': 'talent_pool',
  '已入职': 'hired',
  '主动放弃': 'candidate_withdrew',
  '不再联系': 'do_not_contact',
});

const COMMUNICATION_CODE_TO_LABEL = Object.freeze({
  not_contacted: '未打招呼',
  greeted: '已打招呼',
  replied: '已回复',
  resume_requested: '已求简历',
  resume_received: '已收到简历',
});
const DISPOSITION_CODE_TO_LABEL = Object.freeze({
  new: '新入库',
  under_review: '待处理',
  interview_requested: '待约面',
  rejected: '淘汰',
  talent_pool: '暂存人才库',
  hired: '已入职',
  candidate_withdrew: '主动放弃',
  do_not_contact: '不再联系',
});

const TIER_RANK = Object.freeze({ S: 0, A: 1, B: 2, C: 3, D: 4 });
const TODO_PRIORITY = Object.freeze({
  task_failed_retryable: 0,
  legacy_status_review_required: 1,
  material_classification_required: 2,
  material_assignment_required: 3,
  report_fact_review_required: 4,
  report_confirmation_required: 5,
  assessment_review_required: 6,
  assessment_binding_confirmation_required: 7,
  assessment_report_required: 8,
  final_disposition_confirmation_required: 6,
  final_review_required: 7,
  candidate_next_action_overdue: 8,
  onboarding_handoff_required: 9,
  offer_send_followup_required: 10,
  offer_response_followup_required: 11,
  offer_negotiation_followup_required: 12,
  candidate_next_action_due: 17,
  schedule_confirmation_required: 6,
  report_draft_required: 7,
  job_jd_required: 9,
  job_profile_confirmation_required: 10,
  candidate_rating_required: 11,
  candidate_screening_required: 12,
  resume_followup_required: 13,
  communication_followup_required: 14,
  contact_required: 15,
  interview_preparation_required: 16,
});

function exactCode(value, allowed, labels) {
  if (allowed.includes(value)) return value;
  return Object.hasOwn(labels, value) ? labels[value] : null;
}

function communicationCode(storedCode, legacyLabel) {
  return exactCode(storedCode, COMMUNICATION_CODES, COMMUNICATION_LABEL_TO_CODE)
    || exactCode(legacyLabel, COMMUNICATION_CODES, COMMUNICATION_LABEL_TO_CODE);
}

function dispositionCode(storedCode, legacyLabel) {
  // A short-lived internal build wrote job-specific candidate withdrawal using
  // the global do-not-contact code. Preserve that exact legacy pair without
  // reclassifying genuine do_not_contact + 不再联系 records.
  if (String(storedCode || '').trim() === 'do_not_contact'
    && String(legacyLabel || '').trim() === '主动放弃') return 'candidate_withdrew';
  return exactCode(storedCode, DISPOSITION_CODES, DISPOSITION_LABEL_TO_CODE)
    || exactCode(legacyLabel, DISPOSITION_CODES, DISPOSITION_LABEL_TO_CODE);
}

function validTier(value) {
  const tier = String(value || '').trim().toUpperCase();
  return Object.hasOwn(TIER_RANK, tier) ? tier : null;
}

function latestSession(sessions) {
  return [...(sessions || [])]
    .filter((item) => item && item.status !== 'cancelled')
    .sort((a, b) => Number(b.round || 0) - Number(a.round || 0) || Number(b.id || 0) - Number(a.id || 0))[0] || null;
}

function deriveWorkflowStatus(input = {}) {
  const candidate = input.candidate || {};
  const communication = communicationCode(candidate.communication_code, candidate.comm_status);
  const disposition = dispositionCode(candidate.disposition_code, candidate.disposition_status);
  const source = { entity_type: 'candidate', entity_id: candidate.internal_id || null, status: disposition || communication || null, time: candidate.updated_at || candidate.created_at || null };

  if (disposition === 'candidate_withdrew') return { status: 'candidate_withdrew', communication_code: communication, disposition_code: disposition, source };
  if (disposition === 'do_not_contact') return { status: 'do_not_contact', communication_code: communication, disposition_code: disposition, source };
  if (disposition === 'hired') return { status: 'hired', communication_code: communication, disposition_code: disposition, source };
  if (disposition === 'rejected') return { status: 'rejected', communication_code: communication, disposition_code: disposition, source };
  if (disposition === 'talent_pool') return { status: 'talent_pool', communication_code: communication, disposition_code: disposition, source };

  if (!communication || !disposition) return { status: 'legacy_review_required', communication_code: communication, disposition_code: disposition, source };

  const session = latestSession(input.sessions);
  const hasSessionContext = Array.isArray(input.sessions);
  const reportBelongsToCurrentSession = !hasSessionContext
    || (session && input.report && String(input.report.session_id) === String(session.id));
  const report = reportBelongsToCurrentSession ? (input.report || null) : null;
  if (report && report.status === 'confirmed') {
    return { status: 'report_confirmed', communication_code: communication, disposition_code: disposition, source: { entity_type: 'interview_report_v1', entity_id: report.id, status: report.status, time: report.confirmed_at || report.updated_at } };
  }
  if (report && report.status === 'draft') {
    return { status: 'report_pending_confirmation', communication_code: communication, disposition_code: disposition, source: { entity_type: 'interview_report_v1', entity_id: report.id, status: report.status, time: report.updated_at } };
  }

  if (session) {
    const bySession = {
      draft: 'interview_pending_schedule',
      scheduled: 'interview_scheduled',
      in_progress: 'interview_in_progress',
      pending_review: 'interview_pending_review',
      confirmed: 'interview_pending_review',
    };
    if (bySession[session.status]) {
      return { status: bySession[session.status], communication_code: communication, disposition_code: disposition, source: { entity_type: 'interview_session', entity_id: session.id, status: session.status, time: session.updated_at || session.created_at } };
    }
  }
  if (disposition === 'interview_requested') return { status: 'interview_pending_schedule', communication_code: communication, disposition_code: disposition, source };
  if (communication === 'resume_requested') return { status: 'resume_pending', communication_code: communication, disposition_code: disposition, source };
  if (communication === 'greeted' || communication === 'replied') return { status: 'communicating', communication_code: communication, disposition_code: disposition, source };
  if (communication === 'resume_received') return { status: 'screening', communication_code: communication, disposition_code: disposition, source };
  if (disposition === 'under_review') return { status: validTier(candidate.sabc) ? 'contact_pending' : 'screening', communication_code: communication, disposition_code: disposition, source };
  if (validTier(candidate.sabc)) return { status: 'contact_pending', communication_code: communication, disposition_code: disposition, source };
  return { status: 'new', communication_code: communication, disposition_code: disposition, source };
}

function todo(input) {
  return {
    todo_id: `${input.code}:${input.source.entity_type}:${input.source.entity_id}`,
    code: input.code,
    priority: input.priority || 'normal',
    candidate_id: input.candidate_id || null,
    job_id: input.job_id || null,
    source: input.source,
    blocking: input.blocking === true,
    action: input.action || null,
    created_at: input.created_at || input.source.time || null,
    sabc: validTier(input.sabc),
  };
}

function sortTodos(rows) {
  return [...rows].sort((a, b) => {
    const priority = (TODO_PRIORITY[a.code] ?? 99) - (TODO_PRIORITY[b.code] ?? 99);
    if (priority) return priority;
    const tier = (TIER_RANK[a.sabc] ?? 5) - (TIER_RANK[b.sabc] ?? 5);
    if (tier) return tier;
    const time = String(a.created_at || '').localeCompare(String(b.created_at || ''));
    if (time) return time;
    return String(a.todo_id).localeCompare(String(b.todo_id));
  });
}

module.exports = {
  COMMUNICATION_CODES,
  DISPOSITION_CODES,
  WORKFLOW_STATUSES,
  TODO_CODES,
  COMMUNICATION_LABEL_TO_CODE,
  DISPOSITION_LABEL_TO_CODE,
  COMMUNICATION_CODE_TO_LABEL,
  DISPOSITION_CODE_TO_LABEL,
  TIER_RANK,
  communicationCode,
  dispositionCode,
  validTier,
  deriveWorkflowStatus,
  todo,
  sortTodos,
};
