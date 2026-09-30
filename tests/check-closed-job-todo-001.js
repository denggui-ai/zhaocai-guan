'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-closed-job-todo-'));
const DB_PATH = path.join(ROOT, 'synthetic.db');

process.env.HRBOSS_DATA_DIR = ROOT;
process.env.BOSS_DB_PATH = DB_PATH;
process.env.BOSS_PROFILE_DATA_DIR = path.join(ROOT, 'boss-profile');
process.env.HRBOSS_RECOVERY_ROOT = path.join(ROOT, 'recovery');
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = path.join(ROOT, 'interviews');
process.env.HRBOSS_SENSITIVE_READ_AUDIT_FILE = path.join(ROOT, 'audit.jsonl');

const db = require("../src/db");

process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

function assertReadableHistory(workbench, candidateId, sessionId) {
  assert.equal(workbench.metrics.candidate_count, 1, 'historical candidate metric must remain readable');
  assert.equal(workbench.candidates.length, 1, 'historical candidate list must remain readable');
  assert.equal(workbench.candidates[0].internal_id, candidateId);
  assert.ok(
    workbench.interview_sessions.some((session) => Number(session.id) === Number(sessionId)),
    'historical interview session must remain readable',
  );
}

function checkDashboardContract() {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/DashboardPanel.jsx'), 'utf8');
  assert.match(source, /function DashboardPanel\(\{[\s\S]*?readOnly\s*=\s*false/,
    'DashboardPanel must consume the read-only state passed by App');
  assert.match(source, /job\?\.status\s*===\s*'closed'[\s\S]*?岗位已关闭，仅查看历史[\s\S]*?当前为只读模式，仅查看历史/,
    'DashboardPanel must distinguish a closed job from global read-only mode');
  assert.match(source, /readOnly\s*&&\s*<Alert[^>]*message=\{readOnlyMessage\}/,
    'read-only workbench must explain that only historical data is available');
  assert.match(source, /!readOnly\s*&&\s*<Button[\s\S]*?className="dashboard-todo-action"[\s\S]*?>\{actionLabel\}<\/Button>/,
    'read-only workbench must not render per-todo mutation navigation');
  assert.match(source, /onClick=\{\(\)\s*=>\s*onOpenNav\('候选人'\)\}>候选人队列<\/Button>/,
    'candidate history navigation must remain available');
  assert.match(source, /icon=\{<ReloadOutlined(?:\s+aria-hidden="true")?\s*\/?>\}\s*onClick=\{onRetry\}>刷新工作台<\/Button>/,
    'read-only workbench refresh must remain available and name its current-module scope');
}

function run() {
  db.openDb(DB_PATH, { f018Enabled: false, assessmentEnabled: false });
  const job = db.upsertJob({
    encrypt_job_id: 'closed-job-todo-001',
    name: '关闭岗位待办合成岗',
    source_type: 'local_db',
  });
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'closed-job-todo-candidate-001',
    source: 'synthetic',
    name: '关闭岗位历史候选人',
  });
  const session = db.createNextInterviewSession({
    candidateId: candidate.internal_id,
    jobId: job.id,
    mode: 'online',
  });

  const openWorkbench = db.getJobWorkbench(job.id);
  assert.ok(openWorkbench.todos.length >= 1, 'open job must keep generating its normal active todos');
  assert.ok(openWorkbench.todos.some((todo) => todo.code === 'job_jd_required'));
  assert.ok(openWorkbench.todos.some((todo) => todo.code === 'candidate_rating_required'));
  assert.ok(openWorkbench.todos.some((todo) => todo.code === 'schedule_confirmation_required'));
  assertReadableHistory(openWorkbench, candidate.internal_id, session.id);
  assert.ok(db.getCandidateTimeline(candidate.internal_id).pending_todos.length >= 1,
    'open candidate timeline must retain active pending todos');

  db.updateJobStatus({ jobId: job.id, status: 'paused', actor: 'HR-CLOSED-JOB-TODO-001' });
  const pausedWorkbench = db.getJobWorkbench(job.id);
  assert.deepEqual(
    pausedWorkbench.todos.map((todo) => todo.code),
    openWorkbench.todos.map((todo) => todo.code),
    'pausing a job must not change the existing todo projection',
  );

  db.updateJobStatus({ jobId: job.id, status: 'closed', closeReason: 'other', actor: 'HR-CLOSED-JOB-TODO-001' });
  const closedWorkbench = db.getJobWorkbench(job.id);
  assert.deepEqual(closedWorkbench.todos, [], 'closed job must not publish active recruiting todos');
  assertReadableHistory(closedWorkbench, candidate.internal_id, session.id);

  const closedTimeline = db.getCandidateTimeline(candidate.internal_id);
  assert.deepEqual(closedTimeline.pending_todos, [], 'closed candidate timeline must not publish active todos');
  assert.ok(closedTimeline.events.length >= 2, 'closed candidate timeline must retain historical events');

  db.updateJobStatus({ jobId: job.id, status: 'open', actor: 'HR-CLOSED-JOB-TODO-001' });
  assert.deepEqual(
    db.getJobWorkbench(job.id).todos.map((todo) => todo.code),
    openWorkbench.todos.map((todo) => todo.code),
    'reopening must restore the normal derived todo projection without rewriting history',
  );

  checkDashboardContract();
  db.conn().close();
  console.log('check-closed-job-todo-001 ok');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
