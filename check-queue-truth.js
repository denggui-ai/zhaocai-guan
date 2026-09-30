const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-queue-truth-'));
process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
process.env.BOSS_DB_PATH = path.join(ROOT, 'queue-truth.db');
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const workflow = require('./workflow-projection');

const baseCandidate = {
  internal_id: 'C-QUEUE-TRUTH',
  communication_code: 'resume_received',
  disposition_code: 'interview_requested',
  sabc: 'A',
  created_at: '2026-07-14T00:00:00.000Z',
};
const roundOneReport = {
  id: 101,
  session_id: 11,
  status: 'confirmed',
  confirmed_at: '2026-07-14T01:00:00.000Z',
};

for (const [sessionStatus, expectedWorkflow] of [
  ['scheduled', 'interview_scheduled'],
  ['in_progress', 'interview_in_progress'],
  ['pending_review', 'interview_pending_review'],
]) {
  const result = workflow.deriveWorkflowStatus({
    candidate: baseCandidate,
    sessions: [
      { id: 11, round: 1, status: 'confirmed' },
      { id: 12, round: 2, status: sessionStatus },
    ],
    report: roundOneReport,
  });
  assert.equal(result.status, expectedWorkflow, `round-one report must not override round-two ${sessionStatus}`);
  assert.equal(result.source.entity_id, 12);
}

assert.equal(workflow.deriveWorkflowStatus({
  candidate: baseCandidate,
  sessions: [{ id: 11, round: 1, status: 'cancelled' }],
  report: roundOneReport,
}).status, 'interview_pending_schedule', 'a cancelled session report must not control the current queue');

assert.equal(workflow.deriveWorkflowStatus({
  candidate: baseCandidate,
  sessions: [{ id: 11, round: 1, status: 'confirmed' }],
  report: roundOneReport,
}).status, 'report_confirmed', 'the current session confirmed report remains decision evidence');

const candidateListSource = fs.readFileSync(path.join(__dirname, 'frontend/src/components/CandidateList.jsx'), 'utf8');
const archivedSet = candidateListSource.match(/const ARCHIVED_WORKFLOWS = new Set\(\[([^\]]*)\]\)/);
const reviewSet = candidateListSource.match(/const REVIEW_WORKFLOWS = new Set\(\[([^\]]*)\]\)/);
assert.ok(archivedSet && reviewSet, 'candidate queue definitions must remain explicit');
assert.doesNotMatch(archivedSet[1], /report_confirmed/);
assert.match(reviewSet[1], /report_confirmed/);
assert.match(candidateListSource, /workflow_status === 'report_confirmed'[\s\S]{0,120}\u5f85 HR \u5b8c成最终决策/);

const db = require('./db');
const database = db.openDb(process.env.BOSS_DB_PATH);
const job = db.upsertJob({
  encrypt_job_id: 'queue-truth-job',
  numeric_job_id: '202607140001',
  name: 'QUEUE-TRUTH 纯合成岗位',
  hr_owner: 'HR-QUEUE-TRUTH',
});

function createCandidate(suffix) {
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: `queue-truth-${suffix}`,
    source: 'synthetic_queue_truth',
    name: `QUEUE-TRUTH 纯合成候选人 ${suffix}`,
  });
  database.prepare(`
    UPDATE candidate
    SET communication_code = 'resume_received', comm_status = '已收到简历',
        disposition_code = 'interview_requested', disposition_status = '待约面', sabc = 'A'
    WHERE internal_id = ?
  `).run(candidate.internal_id);
  return candidate;
}

function createSession(candidateId, round, status) {
  return db.createInterviewSession({
    candidateId,
    jobId: job.id,
    round,
    mode: 'online',
    status,
  });
}

function insertConfirmedReport(sessionId, suffix) {
  const timestamp = `2026-07-14T0${suffix}:00:00.000Z`;
  const info = database.prepare(`
    INSERT INTO interview_report_v1 (
      session_id, schema_version, status, report_json, content_hash, version,
      created_by, updated_by, confirmed_by, confirmed_at,
      rejected_by, rejected_at, created_at, updated_at
    ) VALUES (?, 'interview_report_v1', 'confirmed', '{}', ?, 1,
      'HR-QUEUE-TRUTH', 'HR-QUEUE-TRUTH', 'HR-QUEUE-TRUTH', ?,
      NULL, NULL, ?, ?)
  `).run(sessionId, String(suffix).repeat(64).slice(0, 64), timestamp, timestamp, timestamp);
  return Number(info.lastInsertRowid);
}

const multiRoundCandidate = createCandidate('multi-round');
const firstRound = createSession(multiRoundCandidate.internal_id, 1, 'confirmed');
insertConfirmedReport(firstRound.id, 1);
assert.equal(db.getCandidate(multiRoundCandidate.internal_id).workflow_status, 'report_confirmed');

const secondRound = createSession(multiRoundCandidate.internal_id, 2, 'in_progress');
const multiRoundProjection = db.getCandidate(multiRoundCandidate.internal_id);
assert.equal(multiRoundProjection.workflow_status, 'interview_in_progress');
assert.equal(multiRoundProjection.report_status, null);
assert.equal(multiRoundProjection.workflow_source.entity_id, secondRound.id);

const cancelledCandidate = createCandidate('cancelled-report');
const cancelledSession = createSession(cancelledCandidate.internal_id, 1, 'confirmed');
insertConfirmedReport(cancelledSession.id, 2);
db.setInterviewSessionStatus({ sessionId: cancelledSession.id, status: 'cancelled' });
const cancelledProjection = db.getCandidate(cancelledCandidate.internal_id);
assert.equal(cancelledProjection.workflow_status, 'interview_pending_schedule');
assert.equal(cancelledProjection.report_status, null);
assert.equal(cancelledProjection.workflow_source.entity_type, 'candidate');

const currentReportCandidate = createCandidate('current-report');
const currentSession = createSession(currentReportCandidate.internal_id, 1, 'confirmed');
insertConfirmedReport(currentSession.id, 3);
const currentProjection = db.getCandidate(currentReportCandidate.internal_id);
assert.equal(currentProjection.workflow_status, 'report_confirmed');
assert.equal(currentProjection.report_status, 'confirmed');
assert.equal(currentProjection.workflow_source.entity_type, 'interview_report_v1');

database.close();

console.log(JSON.stringify({
  ok: true,
  contract: 'queue-truth-v1',
  cases: ['old-report-vs-new-round', 'cancelled-session-report', 'current-session-report', 'candidate-list-decision-queue'],
}));
