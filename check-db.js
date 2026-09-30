const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  openDb,
  upsertJob,
  upsertCandidate,
  changeStatus,
  writeAuditLog,
  writeRunLog,
  insertResumeOnline,
  getJobProfile,
  upsertJobProfile,
  upsertJobProfilePreservingDeep,
  createJobJdVersion,
  activateJobJdVersion,
  createJobProfileVersion,
  confirmJobProfileVersion,
  insertInterview,
  listInterviews,
  listAiReviews,
  getAssessStatus,
  generateDeepProfileForJob,
  confirmDeepProfile,
  runSecondOpinion,
  runSecondOpinionLocalDemo,
  getCandidateChildren,
  getLatestRun,
  getLatestRunByType,
  rateJob,
  listCandidates,
  setCandidateNextAction,
} = require('./db');
const {
  parseDeepProfileReply,
  parseAssessReply,
} = require('./rating-llm');
const {
  extractMinuteToken,
  fetchMinutesTranscript,
} = require('./minutes-fetch');
const {
  defaultProfile,
  checkHardBars,
  buildResumeText,
  parseSalaryCapK,
  collectDegrees,
  degreeMeetsBar,
} = require('./rating-engine');
const {
  SCHEMA_VERSION,
  REPORT_DISCLAIMER,
  buildEvidenceProfile,
  buildReportDimensions,
  parseCandidateReportReply,
} = require('./candidate-report-v1');

// Resume snapshots are stored already structured; this is the section layout the app reads.
function emptySections() {
  return { basic: [], expect: [], edu: [], work: [], proj: [], skill: [] };
}

const SELF_CHECK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'recruiting-selfcheck-'));
const SELF_CHECK_DB = path.join(SELF_CHECK_ROOT, 'recruiting.db');
process.on('exit', () => fs.rmSync(SELF_CHECK_ROOT, { recursive: true, force: true }));

function constraintError(fn, message) {
  let hit = false;
  try {
    fn();
  } catch (err) {
    hit = /constraint/i.test(err.message || '');
  }
  assert.equal(hit, true, message);
}

function mustThrow(fn, message) {
  let hit = false;
  try {
    fn();
  } catch {
    hit = true;
  }
  assert.equal(hit, true, message);
}

async function mustThrowAsync(fn, message) {
  let hit = false;
  try {
    await fn();
  } catch {
    hit = true;
  }
  assert.equal(hit, true, message);
}

fs.rmSync(SELF_CHECK_DB, { force: true });
fs.mkdirSync(path.dirname(SELF_CHECK_DB), { recursive: true });

const db = openDb(SELF_CHECK_DB);
assert.equal(db.pragma('journal_mode', { simple: true }), 'wal', 'main database must use WAL journal mode');
assert.equal(db.pragma('busy_timeout', { simple: true }), 5000, 'main database must wait briefly for transient write locks');
const now = '2026-06-30T10:00:00.000Z';
const later = '2026-06-30T10:00:01.000Z';

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
assert.deepEqual(tables, [
  'ai_review',
  'audit_log',
  'candidate',
  'candidate_next_action',
  'candidate_offer_status',
  'circuit_breaker',
  'comment',
  'contact',
  'field_annotation',
  'hiring_manager_feedback',
  'hr_journey_request',
  'inbox_scan',
  'interview_ai_report',
  'interview_interviewer',
  'interview_lifecycle_event',
  'interview_lifecycle_hold',
  'interview_lifecycle_manifest',
  'interview_lifecycle_manifest_item',
  'interview_lifecycle_material',
  'interview_lifecycle_session',
  'interview_lifecycle_tombstone',
  'interview_llm_request_audit',
  'interview_pending_assignment',
  'interview_pending_assignment_classification_audit',
  'interview_recording',
  'interview_recording_confirmation',
  'interview_recording_consent',
  'interview_recording_consent_revocation_gate',
  'interview_report_action_request',
  'interview_report_confirmed_projection',
  'interview_report_fact_review',
  'interview_report_source_snapshot',
  'interview_report_v1',
  'interview_script',
  'interview_session',
  'interview_session_confirmation',
  'interview_session_consent',
  'interview_session_interviewer',
  'interview_session_manual_note',
  'interview_session_manual_note_revision',
  'interview_session_material',
  'interview_session_report',
  'interview_session_schedule_confirmation',
  'job',
  'job_interview',
  'job_jd_version',
  'job_profile',
  'job_profile_version',
  'resume_attachment',
  'resume_online',
  'run_log',
  'screenshot_ocr_draft',
  'screenshot_ocr_review_audit',
  'status_history',
  'write_action',
]);
assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
assert.equal(db.prepare(`
  SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = 'application_episode'
`).get(), undefined);
assert.equal(db.prepare(`
  SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = 'candidate_offer_event'
`).get(), undefined, 'F018-disabled schema must not create application-scoped Offer history');
assert.equal(db.prepare(`
  SELECT 1 FROM sqlite_master
  WHERE type = 'trigger' AND name = 'candidate_offer_status_context_insert_guard'
`).get(), undefined, 'F018-disabled schema must not leave a trigger referencing application_episode');
db.exec(`
  CREATE TABLE hr_journey_f018_disabled_schema_probe (id INTEGER PRIMARY KEY);
  ALTER TABLE hr_journey_f018_disabled_schema_probe RENAME TO hr_journey_f018_disabled_schema_probe_v2;
  DROP TABLE hr_journey_f018_disabled_schema_probe_v2;
`);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('candidate') WHERE name = 'numeric_uid'").get().n, 1);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('candidate') WHERE name IN ('communication_code', 'disposition_code', 'workflow_version')").get().n, 3);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('status_history') WHERE name IN ('from_code', 'to_code')").get().n, 2);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('job') WHERE name IN ('is_fixture', 'source_type')").get().n, 2);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('job_interview') WHERE name = 'source_type'").get().n, 1);
assert.equal(db.prepare(`
  SELECT COUNT(*) AS n
  FROM pragma_table_info('interview_recording_consent_revocation_gate')
  WHERE name IN ('scope_hash', 'status', 'requested_at')
`).get().n, 3);
assert.equal(db.prepare(`
  SELECT COUNT(*) AS n
  FROM pragma_table_info('interview_session')
  WHERE name IN (
    'interview_format', 'duration_minutes', 'meeting_platform', 'meeting_link',
    'location_address', 'location_room', 'logistics_note',
    'invitation_status', 'invitation_sent_by', 'invitation_sent_at',
    'candidate_confirmation_status', 'candidate_confirmation_recorded_by',
    'candidate_confirmation_recorded_at', 'logistics_version'
  )
`).get().n, 14);
assert.equal(db.prepare(`
  SELECT COUNT(*) AS n
  FROM pragma_table_info('interview_session_schedule_confirmation')
  WHERE name IN ('logistics_snapshot_json', 'logistics_snapshot_sha256')
`).get().n, 2);
assert.equal(db.prepare(`
  SELECT COUNT(*) AS n FROM sqlite_master
  WHERE type = 'trigger' AND name IN (
    'interview_session_logistics_insert_guard',
    'interview_session_logistics_update_guard',
    'interview_session_interviewer_session_match_guard',
    'interview_session_schedule_confirmation_immutable'
  )
`).get().n, 4);
assert.equal(db.prepare(`
  SELECT COUNT(*) AS n FROM sqlite_master
  WHERE type = 'index' AND name IN (
    'interview_session_interviewer_unique',
    'interview_session_single_lead'
  )
`).get().n, 2);

const upsertedJob1 = upsertJob({
  encrypt_job_id: 'jid-upsert',
  numeric_job_id: '900000000000000001',
  name: '后端工程师',
  hr_owner: 'HR1',
});
const upsertedJob2 = upsertJob({
  encrypt_job_id: 'jid-upsert',
  numeric_job_id: '900000000000000002',
  name: '后端工程师-改名',
  hr_owner: 'HR2',
});
assert.equal(upsertedJob1.id, upsertedJob2.id);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job WHERE encrypt_job_id = ?').get('jid-upsert').n, 1);
const upsertedJobRow = db.prepare('SELECT * FROM job WHERE id = ?').get(upsertedJob1.id);
assert.equal(upsertedJobRow.numeric_job_id, '900000000000000002');
assert.equal(upsertedJobRow.name, '后端工程师-改名');
assert.equal(upsertedJobRow.is_fixture, 0);
assert.equal(upsertedJobRow.source_type, 'local_db');

const fixtureJob = upsertJob({ encrypt_job_id: 'legacy-fixture-job', name: '本地样本岗位' });
const fixtureJobRow = db.prepare('SELECT is_fixture, source_type FROM job WHERE id = ?').get(fixtureJob.id);
assert.equal(fixtureJobRow.is_fixture, 1);
assert.equal(fixtureJobRow.source_type, 'fixture');

const job = db.prepare(`
  INSERT INTO job (encrypt_job_id, numeric_job_id, name, hr_owner, created_at)
  VALUES (?, ?, ?, ?, ?)
`).run('jid-demo', '123456789012345678', '全栈工程师', 'HR', now);
const jobId = job.lastInsertRowid;

const full = upsertCandidate({
  job_id: jobId,
  geek_id: '350000000000123456',
  numeric_uid: '53967795',
  boss_id: 'gid-demo',
  security_id: 'sec-demo',
  encrypt_job_id: 'jid-demo',
  expect_id: '450000000000123456',
  lid: 'lid-demo',
  source: '推荐',
  name: 'candidate_full',
  raw_json: JSON.stringify({ source: 'recommend', nested: { ok: true } }),
}, now);
const missing = upsertCandidate({
  job_id: jobId,
  geek_id: '350000000000123457',
  boss_id: 'gid-missing',
  encrypt_job_id: 'jid-demo',
  expect_id: '450000000000123457',
  lid: 'lid-missing',
  source: '推荐',
  name: 'candidate_missing_key',
  raw_json: JSON.stringify({ source: 'recommend', key: 'missing' }),
}, now);
db.prepare(`
  INSERT INTO candidate_offer_status (
    candidate_id, job_id, application_id, status, expected_start_date,
    reason_code, note, version, actor_id, request_id, created_at, updated_at
  ) VALUES (?, ?, NULL, 'ready_to_offer', NULL, NULL, ?, 1, ?, ?, ?, ?)
`).run(
  full.internal_id,
  jobId,
  'F018-disabled 兼容投影',
  'synthetic-check-db',
  'check-db.f018-disabled.offer',
  now,
  now,
);
assert.equal(db.prepare(`
  SELECT application_id, status FROM candidate_offer_status
  WHERE request_id = 'check-db.f018-disabled.offer'
`).get().application_id, null);

assert.match(full.internal_id, /^C-\d{4}-\d{6}$/);
assert.match(missing.internal_id, /^C-\d{4}-\d{6}$/);

let rows = db.prepare('SELECT * FROM candidate ORDER BY geek_id').all();
assert.equal(rows.length, 2);
assert.equal(rows[0].keys_complete, 1);
assert.equal(rows[1].keys_complete, 0);
assert.equal(rows[0].geek_id, '350000000000123456');
assert.equal(rows[0].numeric_uid, '53967795');
assert.equal(JSON.parse(rows[0].raw_json).nested.ok, true);

const firstId = full.internal_id;
upsertCandidate({
  job_id: jobId,
  geek_id: '350000000000123456',
  boss_id: 'gid-demo-2',
  security_id: 'sec-demo-2',
  encrypt_job_id: 'jid-demo',
  expect_id: '450000000000123456',
  lid: 'lid-demo',
  source: 'inbox',
  name: 'candidate_full_updated',
  raw_json: JSON.stringify({ source: 'inbox', stable: true }),
}, later);
const afterUpsert = db.prepare('SELECT * FROM candidate WHERE geek_id = ? AND job_id = ?').get('350000000000123456', jobId);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candidate').get().n, 2);
assert.equal(afterUpsert.internal_id, firstId);
assert.equal(afterUpsert.updated_at, later);
assert.equal(afterUpsert.raw_json, JSON.stringify({ source: 'inbox', stable: true }));
assert.equal(afterUpsert.source, '推荐');

constraintError(() => {
  db.prepare(`
    INSERT INTO candidate (internal_id, job_id, geek_id, comm_status, disposition_status, keys_complete, created_at, updated_at)
    VALUES ('C-2026-999999', ?, '350000000000123456', '未打招呼', '新入库', 0, ?, ?)
  `).run(jobId, now, now);
}, 'duplicate (geek_id, job_id) must be rejected');

changeStatus(firstId, 'disposition', '待处理', 'HR', '刘杰', 'self-check');
const changed = db.prepare('SELECT disposition_status FROM candidate WHERE internal_id = ?').get(firstId);
const history = db.prepare('SELECT * FROM status_history WHERE candidate_id = ?').get(firstId);
assert.equal(changed.disposition_status, '待处理');
assert.equal(history.from_status, '新入库');
assert.equal(history.to_status, '待处理');
assert.equal(history.to_code, 'under_review');
assert.equal(history.layer, 'disposition');

const historyCountBeforeStatusUpsert = db.prepare('SELECT COUNT(*) AS n FROM status_history WHERE candidate_id = ?').get(firstId).n;
upsertCandidate({
  job_id: jobId,
  geek_id: '350000000000123456',
  boss_id: 'gid-demo-3',
  security_id: 'sec-demo-3',
  encrypt_job_id: 'jid-demo',
  expect_id: '450000000000123456',
  lid: 'lid-demo',
  disposition_status: '淘汰',
  comm_status: '已打招呼',
  raw_json: JSON.stringify({ source: 'recommend', statusAttempt: true }),
}, later);
const afterStatusUpsert = db.prepare('SELECT comm_status, disposition_status FROM candidate WHERE internal_id = ?').get(firstId);
assert.equal(afterStatusUpsert.comm_status, '未打招呼');
assert.equal(afterStatusUpsert.disposition_status, '待处理');
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM status_history WHERE candidate_id = ?').get(firstId).n, historyCountBeforeStatusUpsert);

constraintError(() => {
  db.prepare(`
    INSERT INTO candidate (internal_id, job_id, geek_id, comm_status, disposition_status, keys_complete, created_at, updated_at)
    VALUES ('C-2026-888888', 999999, '350000000000123458', '未打招呼', '新入库', 0, ?, ?)
  `).run(now, now);
}, 'foreign key must reject missing job_id');

db.prepare(`
  INSERT INTO candidate (internal_id, job_id, geek_id, keys_complete, created_at, updated_at)
  VALUES ('C-2026-777777', ?, '350000000000123459', 0, ?, ?)
`).run(jobId, now, now);
const defaulted = db.prepare('SELECT comm_status, disposition_status FROM candidate WHERE internal_id = ?').get('C-2026-777777');
assert.equal(defaulted.comm_status, '未打招呼');
assert.equal(defaulted.disposition_status, '新入库');

upsertCandidate({
  job_id: jobId,
  geek_id: '350000000000123457',
  boss_id: 'gid-missing',
  security_id: 'sec-filled',
  encrypt_job_id: 'jid-demo',
  expect_id: '450000000000123457',
  lid: 'lid-missing',
  name: 'candidate_missing_key_filled',
  raw_json: JSON.stringify({ source: 'recommend', key: 'filled' }),
}, later);
assert.equal(db.prepare('SELECT keys_complete FROM candidate WHERE internal_id = ?').get(missing.internal_id).keys_complete, 1);

const missingOnlyLid = upsertCandidate({
  job_id: jobId,
  geek_id: '350000000000123460',
  boss_id: 'gid-no-lid',
  security_id: 'sec-no-lid',
  encrypt_job_id: 'jid-demo',
  expect_id: '450000000000123460',
  source: '推荐',
  name: 'candidate_no_lid',
  raw_json: JSON.stringify({ source: 'recommend', key: 'no_lid' }),
}, now);
assert.equal(db.prepare('SELECT keys_complete FROM candidate WHERE internal_id = ?').get(missingOnlyLid.internal_id).keys_complete, 0);

const resumeSections = {
  basic: [{ name: 'candidate_full', age: '28岁', work_years: '5年', degree: '本科', status: '离职-随时到岗', description: '自我描述 <script>' }],
  expect: [{ position: '后端工程师', salary: '15-20K', city: '深圳' }],
  edu: [{ school: '深圳大学', major: '软件工程', degree: '本科', start: '2014.09', end: '2018.06', tags: ['一本'] }],
  work: [{ company: '甲公司', title: 'Node 后端', desc: '负责 API 、 自动化', start: '2021.01', end: '至今' }],
  proj: [{ name: '招聘工具', role: '后端', desc: '简历入库', start: '2024.01', end: '2024.06' }],
  skill: [{ text: 'Node.js\nSQLite' }],
};
const resumeRawJson = JSON.stringify({ source: 'self-check', sections: resumeSections });
assert.deepEqual(Object.keys(resumeSections), Object.keys(emptySections()));

insertResumeOnline({
  candidate_id: firstId,
  sections_json: resumeSections,
  is_paywalled: 0,
  raw_json: resumeRawJson,
}, { ifMissing: true });
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resume_online WHERE candidate_id = ?').get(firstId).n, 1);
const storedResume = db.prepare('SELECT * FROM resume_online WHERE candidate_id = ?').get(firstId);
assert.equal(storedResume.is_paywalled, 0);
assert.equal(JSON.parse(storedResume.sections_json).skill[0].text, 'Node.js\nSQLite');
insertResumeOnline({
  candidate_id: firstId,
  sections_json: resumeSections,
  is_paywalled: 0,
  raw_json: resumeRawJson,
}, { ifMissing: true });
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resume_online WHERE candidate_id = ?').get(firstId).n, 1);

insertResumeOnline({
  candidate_id: missing.internal_id,
  sections_json: emptySections(),
  is_paywalled: 1,
  raw_json: '{"unreadable":true}',
}, { ifMissing: true });
assert.equal(db.prepare('SELECT is_paywalled FROM resume_online WHERE candidate_id = ?').get(missing.internal_id).is_paywalled, 1);

insertResumeOnline({
  candidate_id: missingOnlyLid.internal_id,
  sections_json: emptySections(),
  is_paywalled: 1,
  raw_json: '{"manual":true}',
  fetched_at: now,
});
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resume_online WHERE candidate_id = ?').get(missingOnlyLid.internal_id).n, 1);

// Identifiers beyond Number.MAX_SAFE_INTEGER must survive storage as text.
const bigJob = upsertJob({ encrypt_job_id: 'jid-big', numeric_job_id: '800000000000000001', name: '大整数岗位' });
upsertCandidate({
  job_id: bigJob.id,
  geek_id: '350000000000123456',
  boss_id: 'gid-big',
  security_id: 'sec-big',
  encrypt_job_id: 'jid-big',
  expect_id: '450000000000123456',
  lid: '550000000000123456',
  source: '推荐',
  name: '大整数',
  geek_desc: '卡片概要',
  raw_json: JSON.stringify({ source: 'self-check', key: 'big' }),
});
const bigStored = db.prepare('SELECT geek_id, expect_id, lid, keys_complete FROM candidate WHERE job_id = ? AND geek_id = ?')
  .get(bigJob.id, '350000000000123456');
assert.equal(bigStored.geek_id, '350000000000123456');
assert.equal(bigStored.expect_id, '450000000000123456');
assert.equal(bigStored.lid, '550000000000123456');
assert.equal(bigStored.keys_complete, 1);

const sampleJob = upsertJob({ encrypt_job_id: 'jid-sample', numeric_job_id: '800000000000000002', name: '样本岗位' });
const sampleCandidates = [
  { geek_id: '350000000000223456', boss_id: 'gid-sample-1', security_id: 'sec-sample-1', expect_id: '450000000000223456', lid: '550000000000223456', name: '样本一', geek_desc: '短描述一' },
  { geek_id: '350000000000223457', boss_id: 'gid-sample-2', security_id: 'sec-sample-2', expect_id: '450000000000223457', lid: '550000000000223457', name: '样本二', geek_desc: '短描述二' },
].map((candidate, index) => ({
  ...candidate,
  job_id: sampleJob.id,
  encrypt_job_id: 'jid-sample',
  source: '推荐',
  raw_json: JSON.stringify({ source: 'self-check', key: `sample-${index + 1}` }),
}));
let sampleInserted = 0;
let sampleUpdated = 0;
sampleCandidates.forEach((candidate) => {
  const write = upsertCandidate(candidate);
  if (write.inserted) sampleInserted += 1;
  else sampleUpdated += 1;
});
const sample = { total: sampleCandidates.length, inserted: sampleInserted, updated: sampleUpdated, job_id: sampleJob.id };
assert.equal(sample.total, 2);
assert.equal(sample.inserted + sample.updated, 2);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candidate WHERE job_id = ? AND keys_complete = 1').get(sample.job_id).n, 2);

writeAuditLog({
  action: '附件下载',
  target: firstId,
  who: 'self-check',
  auto: 1,
  result: '成功',
  detail_json: JSON.stringify({ ok: true }),
  created_at: now,
});
writeRunLog({
  run_type: '推荐流抓取',
  account: 'self-check',
  job: '全栈工程师',
  status: '成功',
  count_new: 2,
  count_total: 2,
  started_at: now,
  finished_at: later,
});
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 1);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_log').get().n, 1);
writeRunLog({
  run_type: '规则评级',
  account: 'self-check',
  job: '全栈工程师',
  status: '成功',
  count_new: 0,
  count_total: 2,
  started_at: now,
  finished_at: '2026-07-08T11:00:00.000Z',
});
assert.equal(getLatestRun().run_type, '规则评级');
assert.equal(getLatestRunByType('推荐流抓取').run_type, '推荐流抓取');
assert.equal(getLatestRunByType('不存在'), undefined);

db.prepare(`
  INSERT INTO contact (candidate_id, type, value_encrypted, value_hash, source, confidence, created_at)
  VALUES (?, '手机', 'ciphertext-only', 'same-hash', '附件抽取', '高', ?)
`).run(firstId, now);
constraintError(() => {
  db.prepare(`
    INSERT INTO contact (candidate_id, type, value_encrypted, value_hash, source, confidence, created_at)
    VALUES (?, '手机', 'another-ciphertext', 'same-hash', '附件抽取', '高', ?)
  `).run(firstId, now);
}, 'duplicate contact hash must be rejected');
const encryptedValues = db.prepare('SELECT value_encrypted FROM contact').all().map((r) => r.value_encrypted);
assert(encryptedValues.every((v) => !/1[3-9]\d{9}/.test(v) && !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(v)));
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('contact') WHERE name = 'value'").get().n, 0);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('contact') WHERE name = 'value_encrypted'").get().n, 1);

// ---- 硬门槛引擎：纯函数 ----
const dp = defaultProfile();
assert.equal(typeof dp.rubric, 'string');
assert.equal(dp.hard_bars.degree.enabled, false);
assert.ok(Array.isArray(dp.hard_bars.degree.allowed));

// 薪资解析
assert.equal(parseSalaryCapK({ expect: [{ salary: '18-24K' }] }), 24);
assert.equal(parseSalaryCapK({ expect: [{ salary: '20K' }] }), 20);
assert.equal(parseSalaryCapK({ expect: [{ salary: '面议' }] }), null);
assert.equal(parseSalaryCapK({ expect: [{ salary: '15-20K' }, { salary: '25-30K' }] }), 30);
assert.equal(parseSalaryCapK({ expect: [] }), null);

// 学历收集 + 门槛判定
assert.deepEqual(collectDegrees({ basic: [{ degree: '本科' }], edu: [{ degree: '本科' }, { degree: '硕士' }] }), ['本科', '硕士']);
assert.equal(degreeMeetsBar(['本科'], ['本科', '硕士']), true);
assert.equal(degreeMeetsBar(['大专'], ['本科', '硕士']), false);
assert.equal(degreeMeetsBar(['专科'], ['科']), false, '精确成员判定，不能子串误命中');

function sec({ degree, aiDesc, kjDesc, salary, extraDesc }) {
  return {
    basic: [{ description: [aiDesc, kjDesc, extraDesc].filter(Boolean).join(' '), degree: degree || '' }],
    expect: [{ position: '', salary: salary || '' }],
    edu: [], work: [], proj: [], skill: [],
  };
}

const HB = {
  rubric: '要能独立搭 AI Agent 的后端，做过跨境更好',
  hard_bars: {
    degree: { enabled: true, allowed: ['本科', '硕士', '博士', '研究生'] },
    salary: { enabled: true, cap_k: 30 },
  },
};
// 学历达标 + 薪资合规 → 过硬门槛
assert.equal(checkHardBars(HB, { sections: sec({ degree: '本科', salary: '20K' }) }).pass, true);
// 学历不达标 → 不过
const dFail = checkHardBars(HB, { sections: sec({ degree: '大专', salary: '20K' }) });
assert.equal(dFail.pass, false);
assert.match(dFail.fails.join('；'), /学历/);
// 学历取不到 → 不误杀，只 note
const noDeg = checkHardBars(HB, { sections: sec({ salary: '20K' }) });
assert.equal(noDeg.pass, true);
assert.match(noDeg.notes.join('；'), /学历/);
// 薪资超上限 → 不过
const salFail = checkHardBars(HB, { sections: sec({ degree: '本科', salary: '40K' }) });
assert.equal(salFail.pass, false);
assert.match(salFail.fails.join('；'), /薪资/);
// 面议 → 不算超
assert.equal(checkHardBars(HB, { sections: sec({ degree: '本科', salary: '面议' }) }).pass, true);
// 兼容旧画像形状（degree/salary 在顶层、有 signal_groups）
const OLD = { degree: { enabled: true, allowed: ['本科'] }, salary: { enabled: false }, signal_groups: [] };
assert.equal(checkHardBars(OLD, { sections: sec({ degree: '大专' }) }).pass, false);

// buildResumeText：把结构化简历拼成可读文本
const rt = buildResumeText(sec({ degree: '本科', aiDesc: 'ai agent llm', salary: '20K' }));
assert.match(rt, /ai agent llm/);

// ---- V1 候选人匹配报告：证据层 + parser 纯函数 ----
const reportSections = {
  basic: [{ name: '张三', description: '候选人张 三，28岁，手机13800138000，期望薪资35-40K，毕业于985测试大学，自称熟悉 Docker 和自动化流程。', degree: '本科', age: '28岁' }],
  expect: [{ city: '上海', salary: '35-40K' }],
  edu: [{ school: '985测试大学', tags: ['985', '双一流'], major: '自动化', degree: '本科' }],
  work: [{ company: '测试公司', title: 'RPA 工程师', desc: '负责 RPA 自动化流程维护，梳理业务流程并上线自动化脚本。' }],
  proj: [],
  skill: [{ text: 'Docker Kubernetes RPA' }, { text: '张三，期望薪资35-40K，毕业于985测试大学。' }],
};
const evidenceProfile = buildEvidenceProfile(reportSections);
const evidenceBlob = JSON.stringify(evidenceProfile);
assert.doesNotMatch(evidenceBlob, /张\s*三|13800138000|40K|35-40K|985|双一流|测试大学/, 'V1 evidence must remove known candidate, salary and school entities even when OCR repeats them in free text');
assert.ok(evidenceProfile.evidence_items.some((item) => item.id === 'work.0.desc' && /RPA/.test(item.text)), 'work/project evidence should remain available');
assert.ok(evidenceProfile.evidence_items.some((item) => item.id === 'skill.0.text' && item.source_type === 'claim_only'), 'skill-only evidence is marked as claim-only');

const reportDims = buildReportDimensions({
  rubric: '要做 RPA 自动化，有 Docker 更好',
  deep_profile: {
    doc: {
      core_competencies: [
        { name: '自动化经验', what: '能落地 RPA 或流程自动化', resume_evidence: ['工作/项目里有自动化流程'], fake_signals: ['只写熟悉 RPA'] },
        { name: 'Docker', what: '能在容器环境部署服务', resume_evidence: ['工作/项目里有 Docker 部署'], fake_signals: ['只列技能词'] },
      ],
    },
  },
});
const v1Reply = JSON.stringify({
  schema_version: SCHEMA_VERSION,
  job_understanding: { title: 'RPA 工程师', goal: '交付自动化流程', core_requirements: ['自动化经验', 'Docker'], source: 'deep_profile' },
  candidate_summary: { name: '候选人', education: '本科 / 自动化', work_experience: '1段工作经历', summary: '做过 RPA 自动化流程维护。' },
  dimension_matches: [
    {
      dimension: '自动化经验',
      state: 'Match',
      score: 8,
      confidence: 0.75,
      evidence: [{ id: 'work.0.desc', section: 'work', index: 0, field: 'desc', text: '负责 RPA 自动化流程维护' }],
      explanation: { fact: '工作经历写到 RPA 自动化流程维护。', judgment: '与岗位自动化经验相关。', impact: '支持该维度 Match。' },
      risk: '缺少规模和指标。',
    },
    {
      dimension: 'Docker',
      state: 'Unknown',
      score: 3,
      confidence: 0.2,
      evidence: [{ id: 'skill.0.text', section: 'skill', index: 0, field: 'text', text: 'Docker' }],
      explanation: { fact: '只有技能词。', judgment: '无法判断 Docker 实操。', impact: '不作为扣分项。' },
      risk: '需要面试核实。',
    },
    {
      dimension: '技能落地深度',
      state: 'Match',
      score: 9,
      confidence: 0.8,
      evidence: [{ id: 'skill.0.text', section: 'skill', index: 0, field: 'text', text: 'Docker Kubernetes RPA' }],
      explanation: { fact: '技能栏列出 Docker/Kubernetes/RPA。', judgment: '只有声明，缺少项目支撑。', impact: '不能直接高分。' },
      risk: '',
    },
  ],
  radar: [],
  strengths: [],
  risks: [],
  unknowns: [{ dimension: 'Docker', reason: '没有工作/项目证据' }],
  interview_questions: [{ question: '请讲一个真实 RPA 自动化流程。', verification_target: '核实自动化经验', source_risk: '缺少规模指标' }],
  overall: '仅供 HR 参考，建议面试核实 Unknown 项。',
  disclaimer: REPORT_DISCLAIMER,
});
const v1Parsed = parseCandidateReportReply(v1Reply, { evidenceProfile, dimensions: reportDims, jobName: 'RPA 工程师', candidateName: '候选人', deepProfile: {} });
const dockerRow = v1Parsed.dimension_matches.find((item) => item.dimension === 'Docker');
assert.equal(dockerRow.state, 'Unknown', 'no work/project Docker evidence -> Unknown');
assert.equal(dockerRow.score, null, 'Unknown score must be null');
assert.deepEqual(dockerRow.evidence, [], 'Unknown evidence must be empty');
const skillOnlyRow = v1Parsed.dimension_matches.find((item) => item.dimension === '技能落地深度');
assert.ok(skillOnlyRow.score <= 5, 'skill-only claim must not become a high score');
assert.equal(v1Parsed.radar.find((item) => item.dimension === 'Docker').score, null);
assert.equal(v1Parsed.disclaimer, REPORT_DISCLAIMER);
mustThrow(() => parseCandidateReportReply(JSON.stringify({ ...JSON.parse(v1Reply), fit_score: 88 }), { evidenceProfile, dimensions: reportDims }), 'V1 report must reject fit_score');

// ---- job_profile 读写 + rateJob 批量专家评级（注入假专家器，不调真 API）----
const rateJobRow = upsertJob({ encrypt_job_id: 'jid-rate', numeric_job_id: '700000000000000001', name: '评级测试岗' });
const rateJobId = rateJobRow.id;
// 没配画像时返回默认画像
assert.equal(getJobProfile(rateJobId).hard_bars.degree.enabled, defaultProfile().hard_bars.degree.enabled);
upsertJobProfile(rateJobId, HB);
assert.equal(getJobProfile(rateJobId).hard_bars.salary.cap_k, 30);
// upsert 幂等：再存一次不产生第二行
upsertJobProfile(rateJobId, HB);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job_profile WHERE job_id = ?').get(rateJobId).n, 1);
const rateJdVersion = createJobJdVersion({ jobId: rateJobId, jdText: '评级测试岗纯合成 JD', actor: 'check-db' });
activateJobJdVersion({ jdVersionId: rateJdVersion.id, expectedVersion: rateJdVersion.version, actor: 'check-db' });
const rateProfileVersion = createJobProfileVersion({
  jobId: rateJobId,
  jdVersionId: rateJdVersion.id,
  config: HB,
  actor: 'check-db',
});
confirmJobProfileVersion({ profileVersionId: rateProfileVersion.id, expectedVersion: rateProfileVersion.version, actor: 'check-db' });

function makeRateCandidate(suffix, sections, isPaywalled, extra = {}) {
  const c = upsertCandidate({
    job_id: rateJobId,
    geek_id: `36000000000000${suffix}`,
    boss_id: `rb-${suffix}`,
    security_id: `rs-${suffix}`,
    encrypt_job_id: 'jid-rate',
    expect_id: `re-${suffix}`,
    lid: `rl-${suffix}`,
    source: '推荐',
    name: `rate-${suffix}`,
    ...extra,
  }, now);
  insertResumeOnline({
    candidate_id: c.internal_id,
    sections_json: JSON.stringify(sections),
    is_paywalled: isPaywalled ? 1 : 0,
    raw_json: '{}',
    fetched_at: now,
  });
  return c.internal_id;
}

makeRateCandidate('01', sec({ degree: '本科', aiDesc: 'ai agent llm 大模型 rag，我是 rate-01', salary: '20K' }), false); // 无规则 → 待确认；姓名用于验证外发脱敏
makeRateCandidate('02', sec({ degree: '本科', aiDesc: 'ai agent 一般', salary: '20K' }), false); // 无规则 → 待确认
makeRateCandidate('03', sec({ degree: '本科', aiDesc: '普通增删改', salary: '20K' }), false); // 无规则 → 待确认
makeRateCandidate('04', sec({ degree: '大专', aiDesc: 'ai agent llm', salary: '20K' }), false); // 学历不符 → 规则 C，不调模型
makeRateCandidate('05', sec({ degree: '本科', aiDesc: 'ai', salary: '20K' }), true); // 付费墙，跳过
const manualId = makeRateCandidate('06', sec({ degree: '本科', aiDesc: 'ai', salary: '20K' }), false, { sabc: 'C', sabc_source: '人工' }); // 人工，跳过
makeRateCandidate('07', sec({ degree: '本科', aiDesc: '抛错样本', salary: '20K' }), false); // fake scorer 不应被调用，仍待确认
upsertCandidate({
  job_id: rateJobId,
  geek_id: '3600000000000008',
  boss_id: 'rb-08',
  security_id: 'rs-08',
  encrypt_job_id: 'jid-rate',
  expect_id: 're-08',
  lid: 'rl-08',
  source: '推荐',
  name: 'rate-08',
}, now); // 缺在线简历，跳过但不能误报为付费墙
db.prepare('UPDATE candidate SET quality_score = 88 WHERE geek_id = ?').run('3600000000000001');

// 假专家器：P0 红线护栏，规则评级不得调用它。
let scorerCalls = 0;
const fakeScorer = async () => {
  scorerCalls += 1;
  throw new Error('rateJob must not call LLM scorer');
};

(async () => {
  // 进度回调：应从 0 起、单调不减、末次等于总数（这里 5 人参与：01/02/03/04硬失/07，06人工被前置跳过）
  const progress = [];
  const rateResult = await rateJob(rateJobId, { scorer: fakeScorer, onProgress: (done, total) => progress.push([done, total]) });
  assert.ok(progress.length >= 2, 'onProgress 至少报告一次');
  assert.deepEqual(progress[0], [0, 5], '首次应报 0/总数');
  const last = progress[progress.length - 1];
  assert.deepEqual(last, [5, 5], '末次应报 满/满');
  for (let i = 1; i < progress.length; i += 1) assert.ok(progress[i][0] >= progress[i - 1][0], 'done 单调不减');
  assert.equal(rateResult.skipped_manual, 1);
  assert.equal(rateResult.skipped_paywalled, 1);
  assert.equal(rateResult.skipped_missing_resume, 1);
  assert.equal(rateResult.hard_fail, 1);
  assert.equal(rateResult.pending, 4);
  assert.deepEqual(rateResult.byTier, { S: 0, A: 0, B: 0, C: 1, D: 0 });
  assert.equal(scorerCalls, 0, 'rateJob must not call LLM scorer or use fit_score for SABC');

  // 无规则口径 → 待确认；历史 quality_score 只读保留，重评不得覆盖
  const s01 = db.prepare('SELECT sabc, quality_score, verdict_label, expert_comment, sabc_source, hard_bar_pass FROM candidate WHERE geek_id = ?').get('3600000000000001');
  assert.equal(s01.sabc, null);
  assert.equal(s01.quality_score, 88);
  assert.equal(s01.verdict_label, '待确认');
  assert.equal(s01.expert_comment, null);
  assert.equal(s01.sabc_source, null);
  assert.equal(s01.hard_bar_pass, 1);
  // 学历不符 → 规则 C、不打分、不写专家评语
  const d04 = db.prepare('SELECT sabc, sabc_source, quality_score, expert_comment, hard_bar_pass, risk_point FROM candidate WHERE geek_id = ?').get('3600000000000004');
  assert.equal(d04.sabc, 'C');
  assert.equal(d04.sabc_source, '规则v1');
  assert.equal(d04.quality_score, null);
  assert.equal(d04.hard_bar_pass, 0);
  assert.equal(d04.expert_comment, null);
  assert.match(d04.risk_point, /学历/);
  // 原「打分失败」样本：scorer 不被调用，因此只是缺规则待确认
  const p07 = db.prepare('SELECT sabc, quality_score, verdict_label, sabc_source FROM candidate WHERE geek_id = ?').get('3600000000000007');
  assert.equal(p07.sabc, null);
  assert.equal(p07.quality_score, null);
  assert.equal(p07.verdict_label, '待确认');
  assert.equal(p07.sabc_source, null);
  // 人工评级不被覆盖
  const manualAfter = db.prepare('SELECT sabc, sabc_source FROM candidate WHERE internal_id = ?').get(manualId);
  assert.equal(manualAfter.sabc, 'C');
  assert.equal(manualAfter.sabc_source, '人工');
  // 付费墙候选人保持未评级
  assert.equal(db.prepare('SELECT sabc FROM candidate WHERE geek_id = ?').get('3600000000000005').sabc, null);

  // listCandidates：正式列表载荷不返回历史质量分
  const listed = listCandidates(rateJobId);
  assert.ok(listed.every((c) => !Object.hasOwn(c, 'quality_score')), '正式候选人列表不得返回 quality_score');

  // 幂等：再跑一遍结果一致
  const rateResult2 = await rateJob(rateJobId, { scorer: fakeScorer });
  assert.deepEqual(rateResult2.byTier, { S: 0, A: 0, B: 0, C: 1, D: 0 });
  assert.equal(rateResult2.skipped_manual, 1);
  assert.equal(rateResult2.skipped_paywalled, 1);
  assert.equal(rateResult2.skipped_missing_resume, 1);
  assert.equal(rateResult2.pending, 4);
  assert.equal(db.prepare('SELECT quality_score FROM candidate WHERE geek_id = ?').get('3600000000000001').quality_score, 88, '重复重评仍须保留历史质量分');
  // 重评写了 run_log + audit_log
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM run_log WHERE run_type = '规则评级'").get().n >= 1);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = '批量重评' AND auto = 0").get().n >= 1);

  // ---- 2.0-02：访谈入库 → 深度画像（注入假生成器）→ 确认 → 单人第二意见（注入假评估器）----

  // 访谈入库：空转写/缺 job_id 拒绝
  mustThrow(() => insertInterview({ job_id: rateJobId, transcript: '   ' }), '空转写必须拒绝');
  mustThrow(() => insertInterview({ transcript: '有内容但没岗位' }), '缺 job_id 必须拒绝');
  const syntheticSourceUrl = 'https://meeting.example.test/minutes/42?access_token=synthetic-secret-token#private';
  const iv1 = insertInterview({
    job_id: rateJobId,
    source_url: syntheticSourceUrl,
    transcript: '负责人：我要的是能独立把 AI Agent 项目从头带到上线的人，上一个人只会调包不会排查问题。',
  });
  assert.ok(iv1.id > 0);
  const ivList = listInterviews(rateJobId);
  assert.equal(ivList.length, 1);
  assert.equal(ivList[0].note, '负责人访谈', '不填 note 默认为负责人访谈');
  assert.equal(ivList[0].source_type, 'manual_transcript', '旧客户端未传 source_type 时必须安全默认为手动转写');
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = '访谈入库'").get().n >= 1);
  const interviewAuditRaw = db.prepare("SELECT detail_json FROM audit_log WHERE action = '访谈入库' ORDER BY id DESC LIMIT 1").get().detail_json;
  const interviewAudit = JSON.parse(interviewAuditRaw);
  assert.equal(interviewAudit.source_url_present, true);
  assert.equal(interviewAudit.source_origin, 'https://meeting.example.test');
  assert.match(interviewAudit.source_url_sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(interviewAudit, 'source_url'), false, '审计详情不得保留完整来源 URL');
  assert.equal(interviewAuditRaw.includes('synthetic-secret-token'), false, '审计详情不得泄露 URL query token');

  // 没访谈的岗位不能生成画像
  await mustThrowAsync(() => generateDeepProfileForJob(jobId, { generator: async () => ({}) }), '无访谈必须抛错');

  // 假生成器：记录收到的入参，返回固定 doc（不调真 API）
  const docV1 = {
    position_mission: { content: '把 AI Agent 项目独立带到上线', source: 'stated', quotes: ['从头带到上线'], inference_basis: '' },
    hard_requirements: [], core_competencies: [], plus_points: [], minus_points: [], deal_breakers: [],
    implicit_preferences: [],
    followup_questions: [{ question: '预算范围是多少？', why_ask: '访谈没聊到', kind: 'gap' }],
  };
  let genArgs = null;
  const deepV1 = await generateDeepProfileForJob(rateJobId, { generator: async (args) => { genArgs = args; return docV1; } });
  assert.equal(genArgs.jobName, '评级测试岗');
  assert.equal(genArgs.rubric, HB.rubric, '生成时应把 HR 简版画像一起给模型参考');
  assert.equal(genArgs.transcripts.length, 1);
  assert.equal(genArgs.previousProfile, null, '第一版没有上一版画像');
  assert.deepEqual(genArgs.followupAnswers, []);
  assert.equal(deepV1.status, 'draft');
  assert.equal(deepV1.version, 1);
  assert.deepEqual(deepV1.source_interview_ids, [iv1.id]);
  // 生成画像不动简版画像的 rubric / hard_bars
  const cfgAfterGen = getJobProfile(rateJobId);
  assert.equal(cfgAfterGen.rubric, HB.rubric);
  assert.equal(cfgAfterGen.hard_bars.salary.cap_k, 30);
  assert.deepEqual(cfgAfterGen.deep_profile.doc, docV1);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = '生成深度画像'").get().n >= 1);

  // 转写总量超 20 万字符 → 报错不截断
  const limitJob = upsertJob({ encrypt_job_id: 'jid-limit', numeric_job_id: '700000000000000002', name: '超长转写岗' });
  insertInterview({ job_id: limitJob.id, transcript: 'x'.repeat(200001) });
  await mustThrowAsync(() => generateDeepProfileForJob(limitJob.id, { generator: async () => docV1 }), '超长转写必须报错，不静默截断');

  // 确认闭环：没画像的岗位不能确认；确认后 status/confirmed_at/审计齐全
  mustThrow(() => confirmDeepProfile(jobId), '没画像不能确认');
  const confirmed = confirmDeepProfile(rateJobId);
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(confirmed.confirmed_at);
  assert.equal(confirmed.confirmed_by, 'HR代录');
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = '画像确认'").get().n >= 1);

  // 追问补答 → 重新生成：补答归 followupAnswers、上一版画像传进去、版本+1、确认状态作废回 draft
  insertInterview({ job_id: rateJobId, transcript: '问：预算范围是多少？\n答：50-80万，特别好的可以再谈。', note: '追问补答' });
  const docV2 = { ...docV1, followup_questions: [] };
  let genArgs2 = null;
  const deepV2 = await generateDeepProfileForJob(rateJobId, { generator: async (args) => { genArgs2 = args; return docV2; } });
  assert.equal(genArgs2.transcripts.length, 1, '补答不算访谈正文');
  assert.equal(genArgs2.followupAnswers.length, 1);
  assert.match(genArgs2.followupAnswers[0].text, /50-80万/);
  assert.deepEqual(genArgs2.previousProfile, docV1, '重生成要把上一版画像给模型迭代');
  assert.equal(deepV2.version, 2);
  assert.equal(deepV2.status, 'draft', '重新生成后旧确认作废');
  assert.equal(deepV2.confirmed_at, null);

  // 防抹除：UI 保存简版画像（带不带 deep_profile 都一样）不许碰库里的深度画像
  upsertJobProfilePreservingDeep(rateJobId, { rubric: '改了简版', hard_bars: HB.hard_bars, deep_profile: { status: 'confirmed', hacked: true } });
  const cfgAfterSave = getJobProfile(rateJobId);
  assert.equal(cfgAfterSave.rubric, '改了简版');
  assert.equal(cfgAfterSave.deep_profile.version, 2, '深度画像不许被简版保存覆盖');
  assert.equal(cfgAfterSave.deep_profile.status, 'draft', '客户端传来的 deep_profile 一律不认');
  assert.equal(cfgAfterSave.deep_profile.hacked, undefined);
  // 没有深度画像的岗位：客户端硬塞 deep_profile 也存不进去
  upsertJobProfilePreservingDeep(limitJob.id, { rubric: 'x', deep_profile: { fake: 1 } });
  assert.equal(getJobProfile(limitJob.id).deep_profile, undefined);
  const limitJdVersion = createJobJdVersion({ jobId: limitJob.id, jdText: '无深画像降级纯合成 JD', actor: 'check-db' });
  activateJobJdVersion({ jdVersionId: limitJdVersion.id, expectedVersion: limitJdVersion.version, actor: 'check-db' });
  const limitProfileVersion = createJobProfileVersion({
    jobId: limitJob.id,
    jdVersionId: limitJdVersion.id,
    config: { rubric: 'x' },
    actor: 'check-db',
  });
  confirmJobProfileVersion({ profileVersionId: limitProfileVersion.id, expectedVersion: limitProfileVersion.version, actor: 'check-db' });

  // ---- 单人第二意见：红线 = 候选人评级列一个字节都不能变 ----
  const c01 = db.prepare("SELECT internal_id FROM candidate WHERE geek_id = '3600000000000001'").get().internal_id;
  const snapshotSql = `
    SELECT sabc, sabc_source, sabc_reason, quality_score, verdict_label, expert_comment,
           hard_bar_pass, risk_point, match_point, comm_status, disposition_status, updated_at
    FROM candidate WHERE internal_id = ?
  `;
  const before = db.prepare(snapshotSql).get(c01);
  const statusBeforeLocal = getAssessStatus(c01);
  assert.equal(statusBeforeLocal.candidate_found, true);
  assert.equal(statusBeforeLocal.has_resume, true);
  assert.equal(statusBeforeLocal.is_paywalled, false);
  assert.equal(statusBeforeLocal.has_v1_report, false);
  assert.equal(statusBeforeLocal.can_local_demo, true);
  assert.equal(statusBeforeLocal.rating_config_present, fs.existsSync(path.join(__dirname, 'rating-config.json')));
  if (!statusBeforeLocal.rating_config_present) {
    assert.equal(statusBeforeLocal.can_real_assess, false);
    assert.match(statusBeforeLocal.blockers.join('；'), /rating-config\.json/);
  }

  const localDemo = runSecondOpinionLocalDemo(c01);
  assert.equal(localDemo.report.schema_version, SCHEMA_VERSION);
  assert.equal(localDemo.report.generator, 'local_demo_v1');
  assert.equal(localDemo.report.is_local_demo, true);
  assert.match(localDemo.report.disclaimer, /本地样本/);
  assert.ok(Array.isArray(localDemo.report.dimension_matches) && localDemo.report.dimension_matches.length >= 4);
  for (const item of localDemo.report.dimension_matches) {
    if (item.state === 'Unknown') assert.equal(item.score, null, 'local demo Unknown score must be null');
    if (item.evidence && item.evidence.length) {
      const blob = JSON.stringify(item.evidence);
      assert.doesNotMatch(blob, /13800138000|40K|985|双一流|测试大学/, 'local demo evidence must stay scrubbed');
    }
  }
  assert.deepEqual(db.prepare(snapshotSql).get(c01), before, '红线：本地样本绝不改候选人任何评级列');
  assert.equal(listAiReviews(c01).length, 1);
  assert.equal(getAssessStatus(c01).has_v1_report, true);
  assert.equal(getAssessStatus(c01).latest_report_is_local_demo, true);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = '单人AI评估本地样本'").get().n >= 1);

  const fakeV1Assessor = async (args) => {
    const dim = (args.dimensions && args.dimensions[0] && args.dimensions[0].name) || '岗位核心经验';
    return parseCandidateReportReply(JSON.stringify({
      schema_version: SCHEMA_VERSION,
      job_understanding: { title: args.jobName || 'Unknown', goal: '筛选匹配候选人', core_requirements: [dim], source: args.deepProfile ? 'deep_profile' : 'rubric' },
      candidate_summary: { name: args.candidateName || 'Unknown', education: 'Unknown', work_experience: 'Unknown', summary: '简历有 AI Agent 相关描述。' },
      dimension_matches: [
        {
          dimension: dim,
          state: 'Match',
          score: 8,
          confidence: 0.6,
          evidence: [{ id: 'basic.0.description', section: 'basic', index: 0, field: 'description', text: 'ai agent llm 大模型 rag' }],
          explanation: { fact: '自我描述里出现 AI Agent / 大模型 / RAG。', judgment: '与岗位方向相关，但仍需项目支撑。', impact: '可作为初筛匹配点。' },
          risk: '缺少工作/项目经历支撑。',
        },
        {
          dimension: 'Docker',
          state: 'Unknown',
          score: null,
          confidence: 0,
          evidence: [],
          explanation: { fact: '简历未提供 Docker 经历。', judgment: '无法判断 Docker 能力。', impact: '不作为扣分项。' },
          risk: '面试核实。',
        },
      ],
      radar: [],
      strengths: [],
      risks: [{ point: '项目深度待核实', basis: '只有自我描述，缺少工作/项目条目', severity: '中' }],
      unknowns: [{ dimension: 'Docker', reason: '没有简历证据' }],
      interview_questions: [{ question: '请讲一个你实际落地的 AI Agent 项目。', verification_target: '核实项目深度', source_risk: '只有自我描述' }],
      overall: '仅供 HR 参考，建议面试核实项目深度。',
      disclaimer: REPORT_DISCLAIMER,
    }), args);
  };
  let assessArgs = null;
  const r1 = await runSecondOpinion(c01, { assessor: async (args) => { assessArgs = args; return fakeV1Assessor(args); } });
  const localCandidateName = db.prepare('SELECT name FROM candidate WHERE internal_id = ?').get(c01).name;
  assert.notEqual(assessArgs.candidateName, localCandidateName, '候选人姓名不得进入外部 AI 请求');
  assert.match(assessArgs.candidateName, /隐去姓名/);
  assert.doesNotMatch(JSON.stringify(assessArgs.evidenceProfile), new RegExp(localCandidateName), '结构化简历证据也必须移除本地已知姓名');
  assert.equal(r1.report.candidate_summary.name, localCandidateName, '本地落库前应恢复候选人姓名，保证 UI 可读');
  assert.deepEqual(assessArgs.deepProfile, docV2, '评估要拿到深度画像 doc');
  assert.equal(assessArgs.resumeText, undefined, 'V1 不再把整份简历拼成旧 resumeText 给评估器');
  assert.ok(assessArgs.evidenceProfile.evidence_items.some((item) => item.id === 'basic.0.description' && /大模型 rag/.test(item.text)), 'V1 评估要拿 evidence profile');
  assert.ok(Array.isArray(assessArgs.dimensions) && assessArgs.dimensions.length >= 4, 'V1 评估要拿动态维度');
  assert.equal(r1.profile_confirmed, 0, '此刻画像是 draft（v2 重生成后未再确认）');
  assert.equal(r1.report.schema_version, SCHEMA_VERSION);
  assert.equal(r1.report.deep_profile_missing, false);
  assert.equal(r1.report.deep_profile_version, 2);
  assert.equal(r1.report.radar.find((item) => item.dimension === 'Docker').score, null);
  assert.deepEqual(db.prepare(snapshotSql).get(c01), before, '红线：第二意见绝不改候选人任何评级列');
  const storedV1 = JSON.parse(listAiReviews(c01)[0].report_json);
  assert.equal(storedV1.schema_version, SCHEMA_VERSION, 'ai_review.report_json must store V1 schema');
  assert.ok(!('fit_score' in storedV1) && !('sabc' in storedV1) && !('tier' in storedV1), 'V1 report must not carry old score/tier fields');
  // ai_review 落行 + children 能带出来 + 审计
  assert.equal(listAiReviews(c01).length, 2);
  assert.equal(getCandidateChildren(c01).ai_review.length, 2);
  const assessmentAiRow = db.prepare(`
    INSERT INTO ai_review (candidate_id, job_id, profile_confirmed, report_json, created_at)
    VALUES (?, ?, 0, ?, ?)
  `).run(c01, rateJobId, JSON.stringify({ schema_version: 'assessment_ai_analysis_record_v1', analysis: { fit_score: 75 } }), '2026-07-14T00:00:00.000Z');
  assert.equal(getCandidateChildren(c01).ai_review.length, 2, 'assessment AI records must not pollute Candidate AI 初评');
  db.prepare('DELETE FROM ai_review WHERE id = ?').run(assessmentAiRow.lastInsertRowid);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = '单人AI评估'").get().n >= 1);

  // 确认画像后再评：profile_confirmed 快照 = 1，历史两条都在（新的在前）
  confirmDeepProfile(rateJobId);
  const r2 = await runSecondOpinion(c01, { assessor: fakeV1Assessor });
  assert.equal(r2.profile_confirmed, 1);
  const reviews = listAiReviews(c01);
  assert.equal(reviews.length, 3);
  assert.ok(reviews[0].id > reviews[1].id, '最新评估排最前');
  assert.equal(reviews[0].profile_confirmed, 1);
  assert.equal(reviews[1].profile_confirmed, 0);

  // 评估器抛错：不落行、候选人列不动
  await mustThrowAsync(() => runSecondOpinion(c01, { assessor: async () => { throw new Error('模拟评估失败'); } }), '评估失败必须抛错');
  assert.equal(listAiReviews(c01).length, 3, '失败不落行');
  assert.deepEqual(db.prepare(snapshotSql).get(c01), before, '失败也不许碰候选人列');

  // 付费墙 / 没简历 → 拒绝评估
  const c05 = db.prepare("SELECT internal_id FROM candidate WHERE geek_id = '3600000000000005'").get().internal_id;
  await mustThrowAsync(() => runSecondOpinion(c05, { assessor: fakeV1Assessor }), '付费墙必须拒绝');
  mustThrow(() => runSecondOpinionLocalDemo(c05), '付费墙必须拒绝本地样本');
  const noResume = upsertCandidate({ job_id: rateJobId, geek_id: '3600000000000099', boss_id: 'rb-99', source: '推荐', name: 'rate-99' }, now);
  await mustThrowAsync(() => runSecondOpinion(noResume.internal_id, { assessor: fakeV1Assessor }), '没简历必须拒绝');
  mustThrow(() => runSecondOpinionLocalDemo(noResume.internal_id), '没简历必须拒绝本地样本');

  // 没深度画像的岗位 → 降级用简版 rubric，报告标 deep_profile_missing
  const degradeCand = upsertCandidate({ job_id: limitJob.id, geek_id: '3600000000000098', boss_id: 'rb-98', encrypt_job_id: 'jid-limit', source: '推荐', name: 'rate-98' }, now);
  insertResumeOnline({ candidate_id: degradeCand.internal_id, sections_json: JSON.stringify(sec({ degree: '本科', aiDesc: 'ai agent', salary: '20K' })), is_paywalled: 0, raw_json: '{}', fetched_at: now });
  let degradeArgs = null;
  const r3 = await runSecondOpinion(degradeCand.internal_id, { assessor: async (args) => { degradeArgs = args; return fakeV1Assessor(args); } });
  assert.equal(degradeArgs.deepProfile, null);
  assert.equal(degradeArgs.rubric, 'x', '降级时用简版 rubric');
  assert.equal(r3.report.schema_version, SCHEMA_VERSION);
  assert.equal(r3.report.deep_profile_missing, true);
  assert.equal(r3.report.deep_profile_version, null);

  // ---- parser 纯函数：容忍围栏和废话，非法值归一，缺关键键抛错 ----
  const dpReply = '好的，这是画像：\n```json\n' + JSON.stringify({
    position_mission: { content: '搭出稳定的 AI 管线', source: '负责人说的', quotes: ['要能落地'], inference_basis: '' },
    hard_requirements: [{ item: '3年后端', source: 'stated', quotes: ['至少三年'] }],
    core_competencies: [
      { name: 'LLM 应用', what: '会 RAG', why: '业务要', source: 'guess', resume_evidence: ['做过 RAG 项目'], fake_signals: ['只写精通没项目'] },
      { name: '', what: '缺名字应被过滤' },
    ],
    plus_points: [],
    minus_points: null,
    deal_breakers: [{ item: '频繁跳槽', source: 'inferred', inference_basis: '他反复嫌弃上一个人不稳定' }],
    implicit_preferences: [{ observation: '偏爱动手快的人', basis: '反复强调别磨叽' }],
    followup_questions: [{ question: '预算多少？', why_ask: '没聊到', kind: '瞎写的类型' }],
  }) + '\n```\n以上供参考。';
  const dpDoc = parseDeepProfileReply(dpReply);
  assert.equal(dpDoc.position_mission.source, 'inferred', 'source 非法值必须归一为 inferred，绝不冒充原话');
  assert.equal(dpDoc.hard_requirements[0].source, 'stated');
  assert.equal(dpDoc.core_competencies.length, 1, '没名字的能力项应被过滤');
  assert.equal(dpDoc.core_competencies[0].source, 'inferred');
  assert.deepEqual(dpDoc.minus_points, [], '非数组补空数组');
  assert.equal(dpDoc.followup_questions[0].kind, 'gap', 'kind 非法值归一为 gap');
  mustThrow(() => parseDeepProfileReply(JSON.stringify({ hard_requirements: [] })), '缺 position_mission 必须抛错');
  mustThrow(() => parseDeepProfileReply('模型抽风没给 JSON'), '没 JSON 必须抛错');

  const asReply = '```json\n' + JSON.stringify({
    matches: [{ competency: 'LLM 应用', point: '做过 RAG', evidence: '在 X 公司搭过检索系统' }],
    concerns: [{ point: '年限存疑', basis: '时间线对不上', severity: '特别高' }],
    overall: '值得一面，重点核实年限。',
  }) + '\n```';
  const asr = parseAssessReply(asReply);
  assert.equal(asr.matches.length, 1);
  assert.equal(asr.concerns[0].severity, '中', 'severity 非法值归一为 中');
  assert.deepEqual(asr.verify_in_interview, [], '缺的数组补空');
  assert.ok(!('fit_score' in asr) && !('score' in asr) && !('tier' in asr) && !('sabc' in asr), '第二意见报告没有任何分数/档位字段');
  mustThrow(() => parseAssessReply(JSON.stringify({ matches: [] })), '缺 overall 必须抛错');

  // ---- 妙记链接解析与拉取（假执行器，不真起子进程）----
  assert.equal(extractMinuteToken('https://xx.feishu.cn/minutes/obcnq97x12345abcde'), 'obcnq97x12345abcde');
  assert.equal(extractMinuteToken('https://xx.feishu.cn/minutes/obcnq97x12345abcde?from=share&x=1'), 'obcnq97x12345abcde', '带查询参数也能解析');
  assert.equal(extractMinuteToken('不是一个链接'), null);
  assert.equal(extractMinuteToken(''), null);
  assert.equal(extractMinuteToken('https://xx.feishu.cn/minutes/abc def'), null, '带空格的 token 必须拒绝');
  assert.equal(extractMinuteToken('https://xx.feishu.cn/minutes/abc;rm%20-rf'), null, '带分号的注入 token 必须拒绝');
  assert.equal(extractMinuteToken('https://xx.feishu.cn/minutes/$(whoami)'), null, '带 $() 的注入 token 必须拒绝');
  assert.equal(extractMinuteToken("https://xx.feishu.cn/minutes/a'b"), null, '带引号的 token 必须拒绝');

  const fakeCliCalls = [];
  const fakeRunCli = ({ command, cwd }) => {
    fakeCliCalls.push(command);
    assert.ok(command.includes('--minute-tokens obcnq97xok'), '命令必须带白名单后的 token');
    const dir = path.join(cwd, 'minutes', 'obcnq97xok');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcript.txt'), '张三：我们要一个能独立带项目的人。', 'utf8');
    return Promise.resolve({ code: 0, stdout: '{}', stderr: '' });
  };
  const fetched = await fetchMinutesTranscript('https://xx.feishu.cn/minutes/obcnq97xok', { runCli: fakeRunCli });
  assert.equal(fetched, '张三：我们要一个能独立带项目的人。');
  assert.equal(fakeCliCalls.length, 1, '假执行器应被调用一次（没有真 spawn）');

  await mustThrowAsync(() => fetchMinutesTranscript('不是链接', { runCli: fakeRunCli }), '非法链接必须抛人话错误');
  await mustThrowAsync(
    () => fetchMinutesTranscript('https://xx.feishu.cn/minutes/obcnq97xfail', {
      runCli: () => Promise.resolve({ code: 1, stdout: '', stderr: 'not logged in' }),
    }),
    '命令返回非零必须抛错',
  );
  await mustThrowAsync(
    () => fetchMinutesTranscript('https://xx.feishu.cn/minutes/obcnq97xempty', {
      runCli: () => Promise.resolve({ code: 0, stdout: '{}', stderr: '' }),
    }),
    '命令成功但没有逐字稿文件必须抛错',
  );

  assert.equal(setCandidateNextAction({
    candidateId: full.internal_id,
    jobId,
    actionType: 'contact',
    dueDate: '2026-07-27',
    requestId: 'check-db.f018-disabled.next-action',
    actor: 'synthetic-check-db',
  }).next_action.state, 'pending', 'journey idempotency must work when optional F018 tables are disabled');

  db.close();
  fs.rmSync(SELF_CHECK_ROOT, { recursive: true, force: true });
  console.log('self-check ok');
})().catch((err) => { console.error(err); process.exit(1); });
