'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createF018ApplicationService } = require("../src/f018-application-service");
const { createHrManualDispositionService } = require("../src/hr-manual-disposition-service");
const {
  HR_JOURNEY_OPERATIONS_SCHEMA,
  applyHrJourneyOperationsSchema,
} = require("../src/hr-journey-operations-schema");

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-journey-operations-'));
process.env.BOSS_DB_PATH = path.join(root, 'journey-operations.db');
process.env.HRBOSS_DATA_DIR = path.join(root, 'data');
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = path.join(root, 'interviews');
process.env.HRBOSS_F018_ENABLED = '1';
process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED = '0';
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const db = require("../src/db");

const database = db.openDb(process.env.BOSS_DB_PATH, { f018Enabled: true, assessmentEnabled: false });
const actor = 'synthetic-hr-journey-test';
const job = db.upsertJob({
  encrypt_job_id: 'synthetic-journey-operations-job',
  numeric_job_id: '991000000099',
  name: '合成招聘推进岗位',
  hr_owner: '合成 HR',
});
const jd = db.createJobJdVersion({
  jobId: job.id,
  jdText: '合成 JD，仅用于招聘推进闭环回归。',
  actor,
});
db.activateJobJdVersion({ jdVersionId: jd.id, expectedVersion: jd.version, actor });
const profile = db.createJobProfileVersion({
  jobId: job.id,
  jdVersionId: jd.id,
  config: {
    schema_version: 'manual_job_profile_v1',
    must_haves: ['合成要求'],
    assessment_policy: 'not_required',
  },
  actor,
});
db.confirmJobProfileVersion({
  profileVersionId: profile.id,
  expectedVersion: profile.version,
  actor,
});
const candidate = db.upsertCandidate({
  job_id: job.id,
  geek_id: 'synthetic-journey-operations-candidate',
  source: 'synthetic_test',
  name: '合成候选人',
  sabc: 'A',
});
const today = new Date().toLocaleDateString('sv-SE');

let result = db.setCandidateNextAction({
  candidateId: candidate.internal_id,
  jobId: job.id,
  actionType: 'feedback',
  dueDate: today,
  note: '等待负责人反馈',
  state: 'pending',
  requestId: 'journey.next.1',
  actor,
});
assert.equal(result.next_action.state, 'pending');
let workbench = db.getJobWorkbench(job.id);
let nextTodo = workbench.todos.find((item) => item.code === 'candidate_next_action_due'
  && item.candidate_id === candidate.internal_id);
assert.ok(nextTodo);
assert.deepEqual(nextTodo.action, {
  type: 'open_candidate_flow',
  target_id: candidate.internal_id,
});

result = db.setCandidateNextAction({
  candidateId: candidate.internal_id,
  jobId: job.id,
  actionType: 'feedback',
  dueDate: today,
  note: '负责人已反馈',
  state: 'completed',
  requestId: 'journey.next.2',
  actor,
});
assert.equal(result.next_action.state, 'completed');
const replayedFirstNextAction = db.setCandidateNextAction({
  candidateId: candidate.internal_id,
  jobId: job.id,
  actionType: 'feedback',
  dueDate: today,
  note: '等待负责人反馈',
  state: 'pending',
  requestId: 'journey.next.1',
  actor,
});
assert.equal(replayedFirstNextAction.idempotent_replay, true);
assert.equal(replayedFirstNextAction.next_action.state, 'pending');
assert.equal(database.prepare(`
  SELECT state FROM candidate_next_action WHERE candidate_id = ? AND job_id = ?
`).get(candidate.internal_id, job.id).state, 'completed');
workbench = db.getJobWorkbench(job.id);
assert.equal(workbench.todos.some((item) => item.code.startsWith('candidate_next_action_')), false);

const feedback = db.recordHiringManagerFeedback({
  candidateId: candidate.internal_id,
  jobId: job.id,
  contextType: 'interview',
  feedbackPerson: '合成用人负责人',
  feedbackRole: '业务负责人',
  summary: '同意继续推进，但需要核实到岗时间。',
  conclusion: 'need_more',
  feedbackAt: '2026-07-27T10:00:00.000Z',
  requestId: 'journey.feedback.1',
  actor,
});
assert.equal(feedback.feedback.conclusion, 'need_more');
assert.equal(db.getCandidateJourneyOperations({
  candidateId: candidate.internal_id,
  jobId: job.id,
}).manager_feedback.length, 1);

const application = database.prepare(`
  SELECT * FROM application_episode
  WHERE candidate_id = ? AND job_id = ? AND status = 'active'
`).get(candidate.internal_id, job.id);
assert.ok(application);
const timestamp = '2026-07-27T11:00:00.000Z';
const sessionInfo = database.prepare(`
  INSERT INTO interview_session (
    candidate_id, job_id, round, mode, status, scheduled_at,
    scheduled_confirmed_by, scheduled_confirmed_at,
    interview_format, invitation_status, candidate_confirmation_status, logistics_version,
    created_at, updated_at
  ) VALUES (
    ?, ?, 1, 'online', 'draft', NULL, NULL, NULL,
    'online', 'draft', 'pending', 0, ?, ?
  )
`).run(candidate.internal_id, job.id, timestamp, timestamp);
const reportHash = crypto.createHash('sha256').update('synthetic-interview-report').digest('hex');
const reportInfo = database.prepare(`
  INSERT INTO interview_report_v1 (
    session_id, schema_version, status, report_json, content_hash, version,
    created_by, updated_by, confirmed_by, confirmed_at,
    rejected_by, rejected_at, created_at, updated_at
  ) VALUES (?, 'interview_report_v1', 'confirmed', '{}', ?, 1,
            ?, ?, ?, ?, NULL, NULL, ?, ?)
`).run(sessionInfo.lastInsertRowid, reportHash, actor, actor, actor, timestamp, timestamp, timestamp);
const reviewHash = crypto.createHash('sha256').update('synthetic-final-review').digest('hex');
const reviewInfo = database.prepare(`
  INSERT INTO final_review (
    application_id, job_profile_version_id,
    interview_report_id, interview_report_ref_id,
    interview_report_content_hash, interview_report_version,
    status, review_json, content_hash, version,
    reopened_from_final_review_id, reopen_reason,
    created_by, updated_by, confirmed_by, confirmed_at,
    superseded_by_final_review_id, superseded_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 1,
            'confirmed', '{"decision_summary":"合成人工确认继续流程"}', ?, 1,
            NULL, NULL, ?, ?, ?, ?,
            NULL, NULL, ?, ?)
`).run(
  application.id,
  profile.id,
  reportInfo.lastInsertRowid,
  reportInfo.lastInsertRowid,
  reportHash,
  reviewHash,
  actor,
  actor,
  actor,
  timestamp,
  timestamp,
  timestamp,
);
database.prepare(`
  INSERT INTO final_disposition (
    application_id, final_review_id, action, reason_code, actor_id,
    request_id, request_hash, application_before_version,
    application_after_version, created_at
  ) VALUES (?, ?, 'continue_process', 'synthetic_continue', ?,
            'journey.disposition.1', ?, 1, 2, ?)
`).run(application.id, reviewInfo.lastInsertRowid, actor, 'a'.repeat(64), timestamp);
database.prepare(`
  UPDATE application_episode
  SET disposition_action = 'continue_process', version = 2, updated_at = ?
  WHERE id = ? AND status = 'active' AND version = 1
`).run(timestamp, application.id);

let operations = db.getCandidateJourneyOperations({
  candidateId: candidate.internal_id,
  jobId: job.id,
});
assert.equal(operations.offer_eligible, true);
workbench = db.getJobWorkbench(job.id);
assert.ok(workbench.todos.some((item) => item.code === 'offer_send_followup_required'
  && item.candidate_id === candidate.internal_id));
let offer = db.setCandidateOfferStatus({
  candidateId: candidate.internal_id,
  jobId: job.id,
  status: 'ready_to_offer',
  requestId: 'journey.offer.1',
  actor,
}).offer;
assert.equal(offer.status, 'ready_to_offer');
offer = db.setCandidateOfferStatus({
  candidateId: candidate.internal_id,
  jobId: job.id,
  status: 'offer_sent',
  requestId: 'journey.offer.2',
  actor,
}).offer;
assert.equal(offer.status, 'offer_sent');
assert.throws(
  () => db.setCandidateOfferStatus({
    candidateId: candidate.internal_id,
    jobId: job.id,
    status: 'declined',
    reasonCode: 'manual_offer_outcome',
    requestId: 'journey.offer.blank-decline',
    actor,
  }),
  (error) => error && error.code === 'OFFER_REASON_DETAIL_REQUIRED',
);
assert.throws(
  () => db.setCandidateOfferStatus({
    candidateId: candidate.internal_id,
    jobId: job.id,
    status: 'accepted',
    expectedStartDate: '2026-02-31',
    requestId: 'journey.offer.invalid-date',
    actor,
  }),
  (error) => error && error.code === 'JOURNEY_DATE_INVALID',
);
offer = db.setCandidateOfferStatus({
  candidateId: candidate.internal_id,
  jobId: job.id,
  status: 'accepted',
  expectedStartDate: '2026-08-01',
  requestId: 'journey.offer.3',
  actor,
}).offer;
assert.equal(offer.status, 'accepted');
assert.equal(db.getJobLedger(job.id).accepted_offer_count, 1);

const applicationService = createF018ApplicationService({
  database,
  actorContext: { actor_id: actor },
  now: () => '2026-07-27T12:00:00.000Z',
});
let manualDispositionTick = 0;
const manualDispositionService = createHrManualDispositionService({
  database,
  actorContext: { actor_id: actor },
  now: () => `2026-07-27T14:00:${String(++manualDispositionTick).padStart(2, '0')}.000Z`,
});
const closedApplication = applicationService.closeApplication({
  application_id: application.id,
  expected_version: 2,
  request_id: 'journey.application.close.1',
  reason_code: 'synthetic_round_closed',
});
assert.equal(closedApplication.status, 'closed');
assert.equal(
  db.getJobLedger(job.id).accepted_offer_count,
  0,
  'a closed accepted application without a hired disposition must not satisfy the hiring plan',
);
assert.throws(
  () => db.setCandidateOfferStatus({
    candidateId: candidate.internal_id,
    jobId: job.id,
    status: 'accepted',
    expectedStartDate: '2026-08-10',
    requestId: 'journey.offer.after-close',
    actor,
  }),
  (error) => error && error.code === 'OFFER_FINAL_REVIEW_REQUIRED',
);
const replayedSentOffer = db.setCandidateOfferStatus({
  candidateId: candidate.internal_id,
  jobId: job.id,
  status: 'offer_sent',
  requestId: 'journey.offer.2',
  actor,
});
assert.equal(replayedSentOffer.idempotent_replay, true);
assert.equal(replayedSentOffer.offer.status, 'offer_sent');
operations = db.getCandidateJourneyOperations({
  candidateId: candidate.internal_id,
  jobId: job.id,
});
assert.equal(operations.offer, null);
assert.equal(operations.offer_eligible, false);
assert.equal(operations.offer_history.length, 3);

const reenteredApplication = applicationService.reenterApplication({
  application_id: application.id,
  expected_version: closedApplication.version,
  request_id: 'journey.application.reenter.1',
  reason_code: 'synthetic_candidate_reapplied',
});
assert.equal(reenteredApplication.episode_no, 2);
assert.equal(
  db.getJobLedger(job.id).accepted_offer_count,
  0,
  'an accepted Offer from an older episode must not count after a new active episode opens',
);
operations = db.getCandidateJourneyOperations({
  candidateId: candidate.internal_id,
  jobId: job.id,
});
assert.equal(operations.offer, null);
assert.equal(operations.offer_eligible, false);
assert.throws(
  () => db.setCandidateOfferStatus({
    candidateId: candidate.internal_id,
    jobId: job.id,
    status: 'ready_to_offer',
    requestId: 'journey.offer.reentry.before-review',
    actor,
  }),
  (error) => error && error.code === 'OFFER_FINAL_REVIEW_REQUIRED',
);

const review2Hash = crypto.createHash('sha256').update('synthetic-final-review-reentry').digest('hex');
const review2Info = database.prepare(`
  INSERT INTO final_review (
    application_id, job_profile_version_id,
    interview_report_id, interview_report_ref_id,
    interview_report_content_hash, interview_report_version,
    status, review_json, content_hash, version,
    reopened_from_final_review_id, reopen_reason,
    created_by, updated_by, confirmed_by, confirmed_at,
    superseded_by_final_review_id, superseded_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 1,
            'confirmed', '{"decision_summary":"合成重新应聘后继续流程"}', ?, 1,
            NULL, NULL, ?, ?, ?, ?,
            NULL, NULL, ?, ?)
`).run(
  reenteredApplication.id,
  profile.id,
  reportInfo.lastInsertRowid,
  reportInfo.lastInsertRowid,
  reportHash,
  review2Hash,
  actor,
  actor,
  actor,
  timestamp,
  timestamp,
  timestamp,
);
database.prepare(`
  INSERT INTO final_disposition (
    application_id, final_review_id, action, reason_code, actor_id,
    request_id, request_hash, application_before_version,
    application_after_version, created_at
  ) VALUES (?, ?, 'continue_process', 'synthetic_reentry_continue', ?,
            'journey.disposition.reentry.1', ?, 1, 2, ?)
`).run(reenteredApplication.id, review2Info.lastInsertRowid, actor, 'b'.repeat(64), timestamp);
database.prepare(`
  UPDATE application_episode
  SET disposition_action = 'continue_process', version = 2, updated_at = ?
  WHERE id = ? AND status = 'active' AND version = 1
`).run(timestamp, reenteredApplication.id);

workbench = db.getJobWorkbench(job.id);
assert.ok(workbench.todos.some((item) => item.code === 'offer_send_followup_required'
  && item.candidate_id === candidate.internal_id));
offer = db.setCandidateOfferStatus({
  candidateId: candidate.internal_id,
  jobId: job.id,
  status: 'ready_to_offer',
  requestId: 'journey.offer.reentry.1',
  actor,
}).offer;
assert.equal(offer.application_id, reenteredApplication.id);
assert.notEqual(offer.id, database.prepare(`
  SELECT id FROM candidate_offer_status WHERE application_id = ?
`).get(application.id).id);
offer = db.setCandidateOfferStatus({
  candidateId: candidate.internal_id,
  jobId: job.id,
  status: 'offer_sent',
  requestId: 'journey.offer.reentry.2',
  actor,
}).offer;
offer = db.setCandidateOfferStatus({
  candidateId: candidate.internal_id,
  jobId: job.id,
  status: 'accepted',
  expectedStartDate: '2026-08-10',
  requestId: 'journey.offer.reentry.3',
  actor,
}).offer;
assert.equal(offer.status, 'accepted');
assert.equal(
  db.getJobLedger(job.id).accepted_offer_count,
  1,
  'an accepted Offer from the prior episode must not be added to the latest accepted Offer',
);
workbench = db.getJobWorkbench(job.id);
assert.ok(workbench.todos.some((item) => item.code === 'onboarding_handoff_required'));
offer = db.setCandidateOfferStatus({
  candidateId: candidate.internal_id,
  jobId: job.id,
  status: 'onboarding_handoff',
  expectedStartDate: '2026-08-10',
  requestId: 'journey.offer.reentry.4',
  actor,
}).offer;
assert.equal(offer.status, 'onboarding_handoff');
assert.equal(db.getJobLedger(job.id).onboarding_handoff_count, 1);
operations = db.getCandidateJourneyOperations({
  candidateId: candidate.internal_id,
  jobId: job.id,
});
assert.equal(operations.offer.application_id, reenteredApplication.id);
assert.equal(operations.offer_history.length, 7);
assert.equal(db.getCandidateTimeline(candidate.internal_id).events
  .filter((event) => event.event_type === 'candidate_offer_status_changed').length, 7);
const hiredHandoffApplication = manualDispositionService.apply({
  candidate_id: candidate.internal_id,
  job_id: job.id,
  action: 'hired',
  reason: '合成入职移交完成',
  request_id: 'journey.application.hired.handoff',
}).application;
assert.equal(hiredHandoffApplication.status, 'closed');
assert.equal(
  db.getJobLedger(job.id).accepted_offer_count,
  1,
  'the latest hired application must retain its accepted Offer ledger count after closing',
);
assert.equal(
  db.getJobLedger(job.id).onboarding_handoff_count,
  1,
  'the latest hired application must retain its onboarding handoff ledger count after closing',
);

const secondCandidate = db.upsertCandidate({
  job_id: job.id,
  geek_id: 'synthetic-journey-operations-second-candidate',
  source: 'synthetic_test',
  name: '第二位合成候选人',
  sabc: 'B',
});
assert.throws(
  () => db.setCandidateNextAction({
    candidateId: secondCandidate.internal_id,
    jobId: job.id,
    actionType: 'contact',
    dueDate: today,
    state: 'pending',
    requestId: 'journey.next.2',
    actor,
  }),
  (error) => error && error.code === 'JOURNEY_REQUEST_ID_CONFLICT',
);
assert.throws(
  () => db.recordHiringManagerFeedback({
    candidateId: secondCandidate.internal_id,
    jobId: job.id,
    contextType: 'interview',
    feedbackPerson: '第二位合成负责人',
    summary: '合成跨操作幂等冲突。',
    conclusion: 'agree',
    feedbackAt: '2026-07-27T13:00:00.000Z',
    requestId: 'journey.next.2',
    actor,
  }),
  (error) => error && error.code === 'JOURNEY_REQUEST_ID_CONFLICT',
);
assert.equal(database.prepare(`
  SELECT 1 FROM candidate_next_action WHERE candidate_id = ?
`).get(secondCandidate.internal_id), undefined);

const nextActionTodoCodes = new Set([
  'candidate_next_action_due',
  'candidate_next_action_overdue',
]);
const hasNextActionTodo = (candidateId) => db.getJobWorkbench(job.id).todos.some(
  (item) => item.candidate_id === candidateId && nextActionTodoCodes.has(item.code),
);
const nextActionTerminalCases = [
  { code: 'close', disposition: null },
  { code: 'reject', disposition: 'reject' },
  { code: 'talent-pool', disposition: 'talent_pool' },
  { code: 'withdraw', disposition: 'withdraw' },
];

nextActionTerminalCases.forEach(({ code, disposition }, index) => {
  const flowCandidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: `synthetic-next-action-${code}`,
    source: 'synthetic_test',
    name: `合成下一步轮次候选人${index + 1}`,
    sabc: 'B',
  });
  const firstApplication = database.prepare(`
    SELECT * FROM application_episode
    WHERE candidate_id = ? AND job_id = ? AND status = 'active'
    ORDER BY episode_no DESC, id DESC
    LIMIT 1
  `).get(flowCandidate.internal_id, job.id);
  assert.ok(firstApplication);

  const firstAction = db.setCandidateNextAction({
    candidateId: flowCandidate.internal_id,
    jobId: job.id,
    actionType: 'contact',
    dueDate: today,
    note: `合成 ${code} 前待办`,
    state: 'pending',
    requestId: `journey.next.application.${code}.1`,
    actor,
  }).next_action;
  assert.equal(firstAction.application_id, firstApplication.id);
  assert.equal(db.getCandidateJourneyOperations({
    candidateId: flowCandidate.internal_id,
    jobId: job.id,
  }).next_action.application_id, firstApplication.id);
  assert.equal(hasNextActionTodo(flowCandidate.internal_id), true);

  if (code === 'close') {
    const closedRound = applicationService.closeApplication({
      application_id: firstApplication.id,
      expected_version: firstApplication.version,
      request_id: `journey.next.application.${code}.terminal`,
      reason_code: 'synthetic_round_closed',
    });
    assert.equal(closedRound.status, 'closed');
  } else {
    const terminalResult = manualDispositionService.apply({
      candidate_id: flowCandidate.internal_id,
      job_id: job.id,
      action: disposition,
      reason: `合成 ${code} 终止当前申请轮次`,
      request_id: `journey.next.application.${code}.terminal`,
    });
    assert.notEqual(terminalResult.application.status, 'active');
  }

  assert.equal(db.getCandidateJourneyOperations({
    candidateId: flowCandidate.internal_id,
    jobId: job.id,
  }).next_action, null);
  assert.equal(hasNextActionTodo(flowCandidate.internal_id), false);
  const historicalAction = database.prepare(`
    SELECT application_id, state
    FROM candidate_next_action
    WHERE candidate_id = ? AND job_id = ?
  `).get(flowCandidate.internal_id, job.id);
  assert.equal(historicalAction.application_id, firstApplication.id);
  assert.equal(historicalAction.state, 'pending');
  const historicalTimelineEvent = db.getCandidateTimeline(flowCandidate.internal_id).events.find(
    (event) => event.event_type === 'candidate_next_action_recorded',
  );
  assert.ok(historicalTimelineEvent);
  assert.equal(historicalTimelineEvent.application_id, firstApplication.id);
  assert.equal(historicalTimelineEvent.action_required, null);

  const reentered = manualDispositionService.apply({
    candidate_id: flowCandidate.internal_id,
    job_id: job.id,
    action: 'reenter',
    reason: `合成 ${code} 后重新进入`,
    request_id: `journey.next.application.${code}.reenter`,
  }).application;
  assert.equal(reentered.status, 'active');
  assert.notEqual(reentered.id, firstApplication.id);
  const reenteredOperations = db.getCandidateJourneyOperations({
    candidateId: flowCandidate.internal_id,
    jobId: job.id,
  });
  assert.equal(reenteredOperations.application_context.application_id, reentered.id);
  assert.equal(reenteredOperations.next_action, null);
  assert.equal(hasNextActionTodo(flowCandidate.internal_id), false);
  const reenteredTimelineEvent = db.getCandidateTimeline(flowCandidate.internal_id).events.find(
    (event) => event.event_type === 'candidate_next_action_recorded',
  );
  assert.equal(reenteredTimelineEvent.application_id, firstApplication.id);
  assert.equal(reenteredTimelineEvent.action_required, null);

  const currentAction = db.setCandidateNextAction({
    candidateId: flowCandidate.internal_id,
    jobId: job.id,
    actionType: 'contact',
    dueDate: today,
    note: `合成 ${code} 重入后新待办`,
    state: 'pending',
    requestId: `journey.next.application.${code}.2`,
    actor,
  }).next_action;
  assert.equal(currentAction.application_id, reentered.id);
  assert.equal(hasNextActionTodo(flowCandidate.internal_id), true);
  db.setCandidateNextAction({
    candidateId: flowCandidate.internal_id,
    jobId: job.id,
    actionType: 'contact',
    dueDate: today,
    note: `合成 ${code} 重入后新待办已完成`,
    state: 'completed',
    requestId: `journey.next.application.${code}.3`,
    actor,
  });
  assert.equal(hasNextActionTodo(flowCandidate.internal_id), false);
});

assert.throws(
  () => db.updateJobStatus({ jobId: job.id, status: 'closed', actor }),
  (error) => error && error.code === 'JOB_CLOSE_REASON_REQUIRED',
);
const closed = db.updateJobStatus({
  jobId: job.id,
  status: 'closed',
  closeReason: 'filled',
  closeNote: '合成测试已完成',
  actor,
});
assert.equal(closed.job.status, 'closed');
assert.equal(closed.job.close_reason_code, 'filled');
assert.equal(db.getJobWorkbench(job.id).todos.length, 0);

database.close();

const legacyDatabase = new Database(path.join(root, 'legacy-journey-operations.db'));
legacyDatabase.pragma('foreign_keys = ON');
legacyDatabase.exec(`
  CREATE TABLE job (id INTEGER PRIMARY KEY);
  CREATE TABLE candidate (
    internal_id TEXT PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES job(id)
  );
  CREATE TABLE application_episode (
    id INTEGER PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidate(internal_id),
    job_id INTEGER NOT NULL REFERENCES job(id),
    episode_no INTEGER NOT NULL,
    status TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO job (id) VALUES (1);
  INSERT INTO candidate (internal_id, job_id)
  VALUES ('C-LEGACY', 1), ('C-LEGACY-CURRENT', 1);
  INSERT INTO application_episode (
    id, candidate_id, job_id, episode_no, status,
    opened_at, ended_at, created_at, updated_at
  )
  VALUES
    (
      1, 'C-LEGACY', 1, 1, 'closed',
      '2026-07-01T00:00:00.000Z', '2026-07-10T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z', '2026-07-10T00:00:00.000Z'
    ),
    (
      2, 'C-LEGACY', 1, 2, 'active',
      '2026-07-20T00:00:00.000Z', NULL,
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
    ),
    (
      3, 'C-LEGACY-CURRENT', 1, 1, 'active',
      '2026-07-20T00:00:00.000Z', NULL,
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
    );
  CREATE TABLE candidate_next_action (
    id INTEGER PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidate(internal_id) ON DELETE RESTRICT,
    job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
    action_type TEXT NOT NULL,
    due_date TEXT NOT NULL,
    note TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    version INTEGER NOT NULL DEFAULT 1,
    actor_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(candidate_id, job_id)
  );
  INSERT INTO candidate_next_action (
    candidate_id, job_id, action_type, due_date, note, state,
    version, actor_id, request_id, created_at, updated_at
  ) VALUES (
    'C-LEGACY', 1, 'contact', '2026-07-28', '旧库下一步',
    'pending', 1, 'legacy-hr', 'legacy.next.1',
    '2026-07-05T00:00:00.000Z', '2026-07-05T00:00:00.000Z'
  );
  INSERT INTO candidate_next_action (
    candidate_id, job_id, action_type, due_date, note, state,
    version, actor_id, request_id, created_at, updated_at
  ) VALUES (
    'C-LEGACY-CURRENT', 1, 'contact', '2026-07-28', '当前轮次下一步',
    'pending', 1, 'legacy-hr', 'legacy.next.current',
    '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z'
  );
  CREATE TABLE candidate_offer_status (
    id INTEGER PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidate(internal_id) ON DELETE RESTRICT,
    job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
    application_id INTEGER REFERENCES application_episode(id) ON DELETE RESTRICT,
    status TEXT NOT NULL,
    expected_start_date TEXT,
    reason_code TEXT,
    note TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    actor_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(candidate_id, job_id)
  );
  INSERT INTO candidate_offer_status (
    candidate_id, job_id, application_id, status, expected_start_date,
    reason_code, note, version, actor_id, request_id, created_at, updated_at
  ) VALUES (
    'C-LEGACY', 1, 1, 'offer_sent', NULL,
    NULL, '旧轮次 Offer', 2, 'legacy-hr', 'legacy.offer.1',
    '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z'
  );
`);
applyHrJourneyOperationsSchema(legacyDatabase);
assert.equal(legacyDatabase.prepare(`
  SELECT application_id
  FROM candidate_next_action WHERE request_id = 'legacy.next.1'
`).get().application_id, null);
assert.equal(legacyDatabase.prepare(`
  SELECT COUNT(*) AS count
  FROM candidate_next_action next_action
  JOIN application_episode application
    ON application.id = next_action.application_id
    AND application.candidate_id = next_action.candidate_id
    AND application.job_id = next_action.job_id
  WHERE next_action.request_id = 'legacy.next.1'
    AND next_action.state = 'pending'
    AND application.status = 'active'
`).get().count, 0, 'an old unbound action must remain historical after re-entry');
assert.equal(legacyDatabase.prepare(`
  SELECT application_id
  FROM candidate_next_action WHERE request_id = 'legacy.next.current'
`).get().application_id, 3, 'time evidence may bind an action created during the current active episode');
assert.equal(legacyDatabase.prepare(`
  SELECT application_id, status, note
  FROM candidate_offer_status WHERE request_id = 'legacy.offer.1'
`).get().application_id, 1);
assert.equal(legacyDatabase.prepare(`
  SELECT COUNT(*) AS count FROM candidate_offer_event
  WHERE request_id = 'legacy.offer.1'
`).get().count, 1);
assert.throws(
  () => legacyDatabase.prepare(`
    UPDATE candidate_offer_event SET note = '不允许覆盖历史' WHERE request_id = 'legacy.offer.1'
  `).run(),
  /append-only/,
);
assert.equal(legacyDatabase.prepare(`
  SELECT operation_type FROM hr_journey_request
  WHERE request_id = 'legacy.offer.1'
`).get().operation_type, 'set_candidate_offer_status');
legacyDatabase.prepare(`
  INSERT INTO candidate_offer_status (
    candidate_id, job_id, application_id, status, expected_start_date,
    reason_code, note, version, actor_id, request_id, created_at, updated_at
  ) VALUES (
    'C-LEGACY', 1, 2, 'ready_to_offer', NULL,
    NULL, NULL, 1, 'legacy-hr', 'legacy.offer.2',
    '2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z'
  )
`).run();
assert.throws(
  () => legacyDatabase.prepare(`
    UPDATE candidate_offer_status SET application_id = 1 WHERE request_id = 'legacy.offer.2'
  `).run(),
  /identity is immutable/,
);
assert.equal(legacyDatabase.prepare(`
  SELECT COUNT(*) AS count
  FROM candidate_offer_status WHERE candidate_id = 'C-LEGACY' AND job_id = 1
`).get().count, 2, 'application-scoped migration must allow a new Offer in a re-entry episode');
applyHrJourneyOperationsSchema(legacyDatabase);
assert.equal(legacyDatabase.prepare(`
  SELECT COUNT(*) AS count FROM candidate_offer_event
  WHERE request_id = 'legacy.offer.1'
`).get().count, 1, 'repeat migration must not duplicate Offer history');
legacyDatabase.close();

const staleDisabledDatabase = new Database(path.join(root, 'stale-disabled-journey-operations.db'));
staleDisabledDatabase.pragma('foreign_keys = ON');
staleDisabledDatabase.exec(`
  CREATE TABLE job (id INTEGER PRIMARY KEY);
  CREATE TABLE candidate (
    internal_id TEXT PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES job(id)
  );
  ${HR_JOURNEY_OPERATIONS_SCHEMA}
  CREATE TABLE candidate_offer_event (
    id INTEGER PRIMARY KEY,
    offer_id INTEGER NOT NULL REFERENCES candidate_offer_status(id) ON DELETE RESTRICT,
    candidate_id TEXT NOT NULL REFERENCES candidate(internal_id) ON DELETE RESTRICT,
    job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
    application_id INTEGER NOT NULL REFERENCES application_episode(id) ON DELETE RESTRICT,
    request_id TEXT NOT NULL UNIQUE
  );
  CREATE TRIGGER candidate_offer_status_context_insert_guard
  BEFORE INSERT ON candidate_offer_status
  WHEN NEW.application_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM application_episode application
    WHERE application.id = NEW.application_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'offer application candidate/job mismatch');
  END;
`);
applyHrJourneyOperationsSchema(staleDisabledDatabase);
assert.equal(staleDisabledDatabase.prepare(`
  SELECT 1 FROM sqlite_master
  WHERE type = 'trigger' AND name = 'candidate_offer_status_context_insert_guard'
`).get(), undefined);
assert.equal(staleDisabledDatabase.prepare(`
  SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = 'candidate_offer_event'
`).get(), undefined);
staleDisabledDatabase.exec(`
  CREATE TABLE f018_disabled_schema_probe (id INTEGER PRIMARY KEY);
  ALTER TABLE f018_disabled_schema_probe RENAME TO f018_disabled_schema_probe_v2;
  DROP TABLE f018_disabled_schema_probe_v2;
`);
applyHrJourneyOperationsSchema(staleDisabledDatabase);
assert.equal(staleDisabledDatabase.prepare(`
  SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = 'candidate_offer_event'
`).get(), undefined, 'repeat F018-disabled migration must not recreate application-dependent artifacts');
staleDisabledDatabase.close();

const unsafeDisabledDatabase = new Database(path.join(root, 'unsafe-disabled-journey-operations.db'));
unsafeDisabledDatabase.pragma('foreign_keys = OFF');
unsafeDisabledDatabase.exec(`
  CREATE TABLE job (id INTEGER PRIMARY KEY);
  CREATE TABLE candidate (
    internal_id TEXT PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES job(id)
  );
  ${HR_JOURNEY_OPERATIONS_SCHEMA}
  INSERT INTO job (id) VALUES (1);
  INSERT INTO candidate (internal_id, job_id) VALUES ('C-UNSAFE', 1);
  INSERT INTO candidate_offer_status (
    id, candidate_id, job_id, application_id, status, expected_start_date,
    reason_code, note, version, actor_id, request_id, created_at, updated_at
  ) VALUES (
    1, 'C-UNSAFE', 1, 99, 'offer_sent', NULL,
    NULL, '不可静默删除的历史', 1, 'legacy-hr', 'unsafe.offer.1',
    '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
  );
  CREATE TABLE candidate_offer_event (
    id INTEGER PRIMARY KEY,
    offer_id INTEGER NOT NULL REFERENCES candidate_offer_status(id) ON DELETE RESTRICT,
    candidate_id TEXT NOT NULL REFERENCES candidate(internal_id) ON DELETE RESTRICT,
    job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
    application_id INTEGER NOT NULL REFERENCES application_episode(id) ON DELETE RESTRICT,
    request_id TEXT NOT NULL UNIQUE
  );
  INSERT INTO candidate_offer_event (
    id, offer_id, candidate_id, job_id, application_id, request_id
  ) VALUES (1, 1, 'C-UNSAFE', 1, 99, 'unsafe.offer.event.1');
  CREATE TRIGGER candidate_offer_status_context_insert_guard
  BEFORE INSERT ON candidate_offer_status
  BEGIN
    SELECT RAISE(ABORT, 'offer application candidate/job mismatch');
  END;
  CREATE TRIGGER candidate_offer_event_update_guard
  BEFORE UPDATE ON candidate_offer_event
  BEGIN
    SELECT RAISE(ABORT, 'candidate_offer_event is append-only');
  END;
`);
assert.throws(
  () => applyHrJourneyOperationsSchema(unsafeDisabledDatabase),
  (error) => error && error.code === 'HR_JOURNEY_APPLICATION_SCHEMA_REQUIRED',
);
assert.equal(unsafeDisabledDatabase.prepare(`
  SELECT COUNT(*) AS count FROM candidate_offer_event
`).get().count, 1);
assert.equal(unsafeDisabledDatabase.prepare(`
  SELECT COUNT(*) AS count
  FROM sqlite_master
  WHERE type = 'trigger'
    AND name IN (
      'candidate_offer_status_context_insert_guard',
      'candidate_offer_event_update_guard'
    )
`).get().count, 2, 'fail-closed migration must preserve guards when dependent history is non-empty');
unsafeDisabledDatabase.close();

console.log('check-hr-journey-operations-001: ok');
