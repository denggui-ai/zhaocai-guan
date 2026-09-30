const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
process.env.SQLITE_USE_URI = '1';
const Database = require('better-sqlite3');
const { ensurePrivateDir, hardenPrivateDir, ensurePrivateFile } = require('./secure-fs');
const consentRevocationLatch = require('./interview-consent-revocation-latch');
const { defaultProfile } = require('./rating-engine');
const ratingLlm = require('./rating-llm');
const {
  buildEvidenceProfile,
  buildReportDimensions,
  buildLocalDemoReport,
  isCandidateReportV1,
  isLocalDemoReport,
  scrubSensitive,
} = require('./candidate-report-v1');
const { describeExternalAiAuthorization } = require('./external-ai-authorization');
const { applyRuleRating } = require('./rule-rating');
const {
  getInterviewMaterialRoot,
  readControlledTextFile,
  validateInterviewMaterialFile,
  validateInterviewRecordingPaths,
} = require('./interview-material-paths');
const {
  buildCanonicalTranscript,
  redactTranscriptForExternalAi,
  readCanonicalTranscript,
} = require('./interview-transcript-cues');
const {
  applyF006InterviewSessionMigration,
  rollbackF006InterviewSessionMigration,
} = require('./f006-interview-session-migration');
const { applyF007InterviewAdapterMigration } = require('./f007-interview-adapter-migration');
const { applyF008InterviewReportMigration } = require('./f008-interview-report-migration');
const { applyF009InterviewLlmMigration } = require('./f009-interview-llm-migration');
const {
  INTERVIEW_LOGISTICS_INDEXES,
  INTERVIEW_LOGISTICS_TABLES,
  INTERVIEW_LOGISTICS_TRIGGERS,
  INTERVIEW_SESSION_LOGISTICS_COLUMNS,
  SCHEDULE_LOGISTICS_COLUMNS,
  applyInterviewLogisticsDataMigration,
} = require('./interview-logistics-data-migration');
const { applyF012WorkbenchMigration } = require('./f012-workbench-migration');
const {
  HR_JOURNEY_APPLICATION_DEPENDENT_TABLES,
  HR_JOURNEY_APPLICATION_DEPENDENT_TRIGGERS,
  HR_JOURNEY_OPERATION_TABLES,
  applyHrJourneyOperationsSchema,
  journeyRequestHash,
} = require('./hr-journey-operations-schema');
const {
  ASSESSMENT_DELETION_INDEXES,
  ASSESSMENT_DELETION_TRIGGERS,
  ASSESSMENT_TABLES,
  applyAssessmentSchemaMigration,
} = require('./assessment-schema');
const {
  F018_INDEXES,
  F018_TABLES,
  F018_TRIGGERS,
  applyF018SchemaMigration,
} = require('./f018-schema');
const { backfillLegacyCandidates, createF018ApplicationService } = require('./f018-application-service');
const {
  POLICY_VERSION: INTERVIEW_LIFECYCLE_POLICY_VERSION,
  applyInterviewMaterialLifecycleSchema,
  createLifecycleSession,
  registerLifecycleMaterial,
  registerLifecycleDatabaseMaterial,
  assertSessionProcessingAllowed,
  closeRecruitment,
  withdrawSession,
  applyLegalHold,
  releaseLegalHold,
  createDeletionDryRun,
  confirmDeletion,
  recoverStagedDeletions,
  replayLifecycleTombstones,
} = require('./interview-material-lifecycle');
const { createSqliteBackup, purgeExpiredRecoveryPackages } = require('./sqlite-backup-recovery');
const { createAssessmentStoreBackup } = require('./assessment-store-backup');
const workflow = require('./workflow-projection');
const {
  attachAssessmentFitSignals,
  compareCandidateDefaultPriority,
} = require('./assessment-fit-ranking');
const {
  SCHEMA_VERSION: INTERVIEW_REPORT_SCHEMA_VERSION,
  InterviewReportValidationError,
  validateInterviewReport,
} = require('./interview-report-v1');
const { buildConfirmedInterviewProjection } = require('./interview-report-authority');
const { prepareEcommerceTemplateDraft } = require('./ecommerce-job-template-flow');

const DEFAULT_DATA_DIR = process.env.HRBOSS_DATA_DIR ? path.resolve(process.env.HRBOSS_DATA_DIR) : path.join(__dirname, 'data');
const DEFAULT_DB_PATH = path.join(DEFAULT_DATA_DIR, 'recruiting.db');
const DB_PATH = process.env.BOSS_DB_PATH ? path.resolve(process.env.BOSS_DB_PATH) : DEFAULT_DB_PATH;
const INTERVIEW_MATERIAL_ROOT = getInterviewMaterialRoot();
const SCREENSHOT_STITCHED_DIR = path.join(DEFAULT_DATA_DIR, 'import', 'stitched-candidates');
const SCREENSHOT_EVIDENCE_BATCHES_DIR = path.join(DEFAULT_DATA_DIR, 'import', 'screenshot-evidence', 'batches');
let db;
let readonlyMode = false;
let operationalReadonlyMode = false;
let f018RuntimeEnabled = false;
const readonlySchemaChecks = new Set();
const SQLITE_BUSY_TIMEOUT_MS = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS job (
  id INTEGER PRIMARY KEY,
  encrypt_job_id TEXT NOT NULL,
  numeric_job_id TEXT,
  name TEXT,
  hr_owner TEXT,
  department TEXT,
  location TEXT,
  planned_hires INTEGER NOT NULL DEFAULT 1 CHECK(planned_hires > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('draft', 'open', 'paused', 'closed')),
  close_reason_code TEXT,
  close_note TEXT,
  closed_at TEXT,
  closed_by TEXT,
  is_fixture INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL DEFAULT 'local_db',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS candidate (
  internal_id TEXT PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES job(id),
  geek_id TEXT NOT NULL,
  numeric_uid TEXT,
  boss_id TEXT,
  security_id TEXT,
  encrypt_job_id TEXT,
  expect_id TEXT,
  lid TEXT,
  chat_uid TEXT,
  relation_type TEXT,
  last_ts TEXT,
  source TEXT,
  rec_position TEXT,
  keys_complete INTEGER,
  name TEXT,
  age TEXT,
  degree TEXT,
  degree_verified TEXT,
  school TEXT,
  school_tier TEXT,
  work_years TEXT,
  salary TEXT,
  geek_desc TEXT,
  sabc TEXT,
  sabc_source TEXT,
  sabc_reason TEXT,
  match_point TEXT,
  risk_point TEXT,
  quality_score INTEGER,
  verdict_label TEXT,
  expert_comment TEXT,
  hard_bar_pass INTEGER,
  comm_status TEXT DEFAULT '未打招呼',
  disposition_status TEXT DEFAULT '新入库',
  communication_code TEXT,
  disposition_code TEXT,
  workflow_version INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(geek_id, job_id)
);

CREATE TABLE IF NOT EXISTS resume_online (
  id INTEGER PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(internal_id),
  sections_json TEXT,
  is_paywalled INTEGER,
  raw_json TEXT,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS resume_attachment (
  id INTEGER PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(internal_id),
  resume_id TEXT,
  file_name TEXT,
  file_type TEXT,
  local_path TEXT,
  download_status TEXT DEFAULT '未下载',
  is_paywalled INTEGER,
  has_contact INTEGER,
  source_mid TEXT,
  created_at TEXT,
  downloaded_at TEXT,
  UNIQUE(candidate_id, resume_id)
);

CREATE TABLE IF NOT EXISTS contact (
  id INTEGER PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(internal_id),
  type TEXT,
  value_encrypted TEXT NOT NULL,
  value_hash TEXT,
  source TEXT,
  confidence TEXT,
  created_at TEXT,
  UNIQUE(candidate_id, type, value_hash)
);

CREATE TABLE IF NOT EXISTS field_annotation (
  id INTEGER PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(internal_id),
  target_ref TEXT,
  kind TEXT,
  value TEXT,
  drives_status TEXT,
  author_role TEXT,
  author TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS comment (
  id INTEGER PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(internal_id),
  body TEXT NOT NULL,
  purpose_tag TEXT NOT NULL,
  is_persona_signal INTEGER,
  polarity TEXT,
  author TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(internal_id),
  layer TEXT,
  from_status TEXT,
  to_status TEXT,
  source TEXT,
  who TEXT,
  reason TEXT,
  from_code TEXT,
  to_code TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  action TEXT,
  target TEXT,
  who TEXT,
  auto INTEGER,
  result TEXT,
  detail_json TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS run_log (
  id INTEGER PRIMARY KEY,
  run_type TEXT,
  account TEXT,
  job TEXT,
  status TEXT,
  count_new INTEGER,
  count_total INTEGER,
  error_summary TEXT,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS job_profile (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES job(id),
  config_json TEXT,
  updated_at TEXT,
  UNIQUE(job_id)
);

CREATE TABLE IF NOT EXISTS job_interview (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES job(id),
  source_url TEXT,
  transcript TEXT NOT NULL,
  note TEXT,
  source_type TEXT NOT NULL DEFAULT 'manual_transcript',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS ai_review (
  id INTEGER PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(internal_id),
  job_id INTEGER NOT NULL REFERENCES job(id),
  profile_confirmed INTEGER,
  report_json TEXT NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS circuit_breaker (
  id INTEGER PRIMARY KEY,
  account TEXT,
  state TEXT,
  reason_code INTEGER,
  reason_text TEXT,
  consecutive_failures INTEGER,
  cooldown_until TEXT,
  stopped_at TEXT,
  updated_at TEXT,
  UNIQUE(account)
);

CREATE TABLE IF NOT EXISTS write_action (
  id INTEGER PRIMARY KEY,
  action_type TEXT,
  candidate_id TEXT,
  dedup_key TEXT,
  status TEXT,
  boss_code INTEGER,
  decision TEXT,
  attempt INTEGER,
  greet_text TEXT,
  result_json TEXT,
  created_at TEXT,
  updated_at TEXT,
  executed_at TEXT,
  UNIQUE(dedup_key, action_type)
);

CREATE TABLE IF NOT EXISTS inbox_scan (
  id INTEGER PRIMARY KEY,
  account TEXT,
  last_scanned_at TEXT,
  last_cursor TEXT,
  updated_at TEXT,
  UNIQUE(account)
);
`;

const JOB_UNIQUE_INDEX = `
-- 这条唯一索引是 job 表去重的唯一护栏（旧库 job 表无列级 UNIQUE，CREATE TABLE IF NOT EXISTS 不会补结构），upsertJob 的 ON CONFLICT(encrypt_job_id) 依赖它，不可删除。
CREATE UNIQUE INDEX IF NOT EXISTS job_encrypt_job_id_unique
ON job(encrypt_job_id);
`;

const RESUME_ONLINE_UNIQUE_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS resume_online_candidate_id_unique
ON resume_online(candidate_id);
`;

const JOB_PROFILE_UNIQUE_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS job_profile_job_id_unique
ON job_profile(job_id);
`;

const INBOX_SCAN_UNIQUE_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS inbox_scan_account_unique
ON inbox_scan(account);
`;

const SCREENSHOT_OCR_REVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS screenshot_ocr_draft (
  id INTEGER PRIMARY KEY,
  draft_key TEXT NOT NULL UNIQUE,
  draft_id TEXT NOT NULL,
  evidence_batch_id TEXT,
  job_id INTEGER NOT NULL REFERENCES job(id),
  job_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK(status IN ('pending_review', 'confirmed', 'rejected')),
  original_json TEXT NOT NULL,
  current_json TEXT NOT NULL,
  field_evidence_json TEXT NOT NULL,
  review_flags_json TEXT NOT NULL,
  context_json TEXT NOT NULL,
  identity_key TEXT,
  source_fingerprint TEXT,
  content_fingerprint TEXT,
  identity_status TEXT NOT NULL DEFAULT 'insufficient',
  identity_json TEXT NOT NULL DEFAULT '{}',
  candidate_id TEXT REFERENCES candidate(internal_id),
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS screenshot_ocr_review_audit (
  id INTEGER PRIMARY KEY,
  screenshot_draft_id INTEGER NOT NULL REFERENCES screenshot_ocr_draft(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK(action IN ('created', 'edited', 'confirmed', 'rejected')),
  before_json TEXT,
  after_json TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS screenshot_ocr_draft_status_idx
ON screenshot_ocr_draft(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS screenshot_ocr_draft_job_idx
ON screenshot_ocr_draft(job_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS screenshot_ocr_review_audit_draft_idx
ON screenshot_ocr_review_audit(screenshot_draft_id, id);
`;

const SCREENSHOT_IDENTITY_INDEXES = `
CREATE INDEX IF NOT EXISTS screenshot_ocr_draft_identity_idx
ON screenshot_ocr_draft(job_id, identity_key);

CREATE INDEX IF NOT EXISTS screenshot_ocr_draft_source_fingerprint_idx
ON screenshot_ocr_draft(job_id, source_fingerprint);

CREATE INDEX IF NOT EXISTS screenshot_ocr_draft_name_content_idx
ON screenshot_ocr_draft(job_id, content_fingerprint);
`;

const INTERVIEW_RECORDING_SCHEMA = `
CREATE TABLE IF NOT EXISTS interview_recording (
  id INTEGER PRIMARY KEY,
  summary_path TEXT UNIQUE,
  topic TEXT,
  source_path TEXT,
  wav_path TEXT,
  transcript_txt_path TEXT,
  transcript_srt_path TEXT,
  transcript_json_path TEXT,
  codex_input_path TEXT,
  report_path TEXT,
  candidate_id TEXT REFERENCES candidate(internal_id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES job(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'pending_match',
  confirmed_at TEXT,
  raw_summary_json TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS interview_ai_report (
  id INTEGER PRIMARY KEY,
  recording_id INTEGER NOT NULL REFERENCES interview_recording(id) ON DELETE CASCADE,
  candidate_id TEXT REFERENCES candidate(internal_id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES job(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'draft',
  report_json TEXT NOT NULL,
  confirmed_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS interview_recording_confirmation (
  id INTEGER PRIMARY KEY,
  recording_id INTEGER NOT NULL REFERENCES interview_recording(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  field_label TEXT,
  extracted_value TEXT,
  corrected_value TEXT,
  status TEXT DEFAULT 'pending',
  evidence TEXT,
  note TEXT,
  confirmed_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(recording_id, field_key)
);

CREATE TABLE IF NOT EXISTS interview_script (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'draft',
  source TEXT,
  script_json TEXT NOT NULL,
  script_text TEXT,
  confirmed_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(job_id)
);

CREATE TABLE IF NOT EXISTS interview_recording_consent (
  id INTEGER PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(internal_id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  consented_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  source TEXT NOT NULL,
  consent_text_version TEXT,
  consent_text_sha256 TEXT,
  revoked_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS interview_recording_consent_revocation_gate (
  scope_hash TEXT PRIMARY KEY NOT NULL
    CHECK(length(scope_hash) = 64),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status = 'pending'),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS interview_recording_summary_path_unique
ON interview_recording(summary_path)
WHERE summary_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS interview_recording_candidate_idx
ON interview_recording(candidate_id);

CREATE INDEX IF NOT EXISTS interview_recording_job_idx
ON interview_recording(job_id);

CREATE INDEX IF NOT EXISTS interview_recording_status_idx
ON interview_recording(status);

CREATE UNIQUE INDEX IF NOT EXISTS interview_ai_report_recording_unique
ON interview_ai_report(recording_id);

CREATE INDEX IF NOT EXISTS interview_recording_confirmation_recording_idx
ON interview_recording_confirmation(recording_id);

CREATE INDEX IF NOT EXISTS interview_script_job_idx
ON interview_script(job_id);

CREATE INDEX IF NOT EXISTS interview_recording_consent_lookup_idx
ON interview_recording_consent(candidate_id, job_id, scope, status, consented_at DESC);

CREATE INDEX IF NOT EXISTS interview_recording_consent_revocation_gate_status_idx
ON interview_recording_consent_revocation_gate(status, updated_at);
`;

// 给已存在的老库补加 2.0 评级新列（CREATE TABLE IF NOT EXISTS 不会改已存在表的结构）。
// 只加可空新列，无损；新建库走 SCHEMA 已带这些列，这里查到已存在就跳过。
function migrateCandidateColumns(database) {
  const existing = new Set(database.prepare("PRAGMA table_info('candidate')").all().map((c) => c.name));
  const additions = [
    ['numeric_uid', 'TEXT'],
    ['quality_score', 'INTEGER'],
    ['verdict_label', 'TEXT'],
    ['expert_comment', 'TEXT'],
    ['hard_bar_pass', 'INTEGER'],
  ];
  for (const [name, type] of additions) {
    if (!existing.has(name)) database.exec(`ALTER TABLE candidate ADD COLUMN ${name} ${type}`);
  }
}

// 只追加带安全默认值的列，再原地回填旧记录；重复启动时不会重建表或覆盖有效来源。
function migrateSourceColumns(database) {
  database.transaction(() => {
    const jobColumns = new Set(database.prepare("PRAGMA table_info('job')").all().map((c) => c.name));
    if (!jobColumns.has('is_fixture')) {
      database.exec('ALTER TABLE job ADD COLUMN is_fixture INTEGER NOT NULL DEFAULT 0');
    }
    if (!jobColumns.has('source_type')) {
      database.exec("ALTER TABLE job ADD COLUMN source_type TEXT NOT NULL DEFAULT 'local_db'");
    }

    database.exec(`
      UPDATE job
      SET is_fixture = 1
      WHERE LOWER(COALESCE(source_type, '')) = 'fixture'
         OR LOWER(COALESCE(encrypt_job_id, '')) = 'fixture'
         OR LOWER(COALESCE(encrypt_job_id, '')) LIKE 'fixture-%'
         OR LOWER(COALESCE(encrypt_job_id, '')) LIKE '%-fixture'
         OR LOWER(COALESCE(encrypt_job_id, '')) LIKE '%-fixture-%';

      UPDATE job
      SET is_fixture = 0
      WHERE is_fixture IS NULL OR is_fixture NOT IN (0, 1);

      UPDATE job
      SET source_type = 'fixture'
      WHERE is_fixture = 1;

      UPDATE job
      SET source_type = 'local_db'
      WHERE is_fixture = 0
        AND (source_type IS NULL OR TRIM(source_type) = '' OR source_type NOT IN ('local_db', 'boss_sync', 'fixture'));
    `);

    const interviewColumns = new Set(database.prepare("PRAGMA table_info('job_interview')").all().map((c) => c.name));
    const interviewSourceAdded = !interviewColumns.has('source_type');
    if (interviewSourceAdded) {
      database.exec("ALTER TABLE job_interview ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual_transcript'");
    }

    if (interviewSourceAdded) {
      database.exec(`
        UPDATE job_interview
        SET source_type = 'lark_minutes'
        WHERE (source_url IS NOT NULL AND TRIM(source_url) != '')
           OR LOWER(COALESCE(note, '')) LIKE '[source_type:lark_minutes]%';

        UPDATE job_interview
        SET source_type = 'offline_recording'
        WHERE (source_url IS NULL OR TRIM(source_url) = '')
          AND (
            LOWER(COALESCE(note, '')) LIKE '[source_type:offline_recording]%'
            OR COALESCE(note, '') LIKE '%线下%录音%'
          );
      `);
    }

    database.exec(`
      UPDATE job_interview
      SET source_type = 'manual_transcript'
      WHERE source_type IS NULL
         OR TRIM(source_type) = ''
         OR source_type NOT IN ('manual_transcript', 'offline_recording', 'lark_minutes');
    `);
  })();
}

// JOB-MULTI-001：只追加岗位台账字段，旧岗位按原先“可用岗位”语义回填为招聘中。
// 启动迁移前仍由 openDbWithMigrationBackup 生成恢复点；这里不改写任何候选人或版本历史。
function migrateJobLedgerColumns(database) {
  const columns = new Set(database.prepare("PRAGMA table_info('job')").all().map((column) => column.name));
  const additions = [
    ['department', 'TEXT'],
    ['location', 'TEXT'],
    ['planned_hires', 'INTEGER NOT NULL DEFAULT 1'],
    ['status', "TEXT NOT NULL DEFAULT 'open'"],
    ['close_reason_code', 'TEXT'],
    ['close_note', 'TEXT'],
    ['closed_at', 'TEXT'],
    ['closed_by', 'TEXT'],
    ['updated_at', 'TEXT'],
  ];
  database.transaction(() => {
    for (const [name, type] of additions) {
      if (!columns.has(name)) database.exec(`ALTER TABLE job ADD COLUMN ${name} ${type}`);
    }
    database.exec(`
      UPDATE job
      SET planned_hires = 1
      WHERE planned_hires IS NULL OR typeof(planned_hires) != 'integer' OR planned_hires < 1;

      UPDATE job
      SET status = 'open'
      WHERE status IS NULL OR status NOT IN ('draft', 'open', 'paused', 'closed');

      UPDATE job
      SET updated_at = COALESCE(updated_at, created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE updated_at IS NULL OR TRIM(updated_at) = '';
    `);
  })();
}

function migrateScreenshotOcrDraftColumns(database) {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'screenshot_ocr_draft'").get();
  if (!exists) return;
  const columns = new Set(database.prepare("PRAGMA table_info('screenshot_ocr_draft')").all().map((column) => column.name));
  const additions = [
    ['identity_key', 'TEXT'],
    ['source_fingerprint', 'TEXT'],
    ['content_fingerprint', 'TEXT'],
    ['identity_status', "TEXT NOT NULL DEFAULT 'insufficient'"],
    ['identity_json', "TEXT NOT NULL DEFAULT '{}'"],
  ];
  database.transaction(() => {
    for (const [name, type] of additions) {
      if (!columns.has(name)) database.exec(`ALTER TABLE screenshot_ocr_draft ADD COLUMN ${name} ${type}`);
    }
  })();
}

function assessmentPhaseAEnabled(options = {}) {
  if (Object.hasOwn(options, 'assessmentEnabled')) return options.assessmentEnabled === true;
  return process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED === '1';
}

function f018FeatureEnabled(options = {}) {
  if (Object.hasOwn(options, 'f018Enabled')) return options.f018Enabled === true;
  return process.env.HRBOSS_F018_ENABLED === '1';
}

function f018ProjectionTablesAvailable(database) {
  const names = new Set(database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN (${F018_TABLES.map(() => '?').join(', ')})
  `).all(...F018_TABLES).map((row) => row.name));
  return F018_TABLES.every((name) => names.has(name));
}

function configurePrimaryDatabase(database) {
  database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  let journalMode;
  try {
    journalMode = String(database.pragma('journal_mode = WAL', { simple: true }) || '').toLowerCase();
  } catch (cause) {
    const error = new Error(`SQLite WAL mode is required but could not be enabled: ${cause.code || cause.message || 'unknown error'}`);
    error.code = 'SQLITE_WAL_REQUIRED';
    error.cause = cause;
    throw error;
  }
  if (journalMode !== 'wal') {
    const error = new Error(`SQLite WAL mode is required, but journal_mode=${journalMode || 'unknown'}`);
    error.code = 'SQLITE_WAL_REQUIRED';
    throw error;
  }
  database.pragma('foreign_keys = ON');
}

function openDb(file = DB_PATH, options = {}) {
  consentRevocationLatch.setActiveDatabasePath(file);
  const dataDir = path.dirname(file);
  if (process.platform === 'win32' || path.resolve(dataDir) === path.resolve(path.dirname(DEFAULT_DB_PATH))) hardenPrivateDir(dataDir);
  else ensurePrivateDir(dataDir);
  db = new Database(file);
  ensurePrivateFile(file);
  try {
    configurePrimaryDatabase(db);
  } catch (error) {
    db.close();
    db = null;
    throw error;
  }
  db.exec(SCHEMA);
  migrateCandidateColumns(db);
  migrateSourceColumns(db);
  migrateJobLedgerColumns(db);
  const duplicateJob = db.prepare(`
    SELECT encrypt_job_id, COUNT(*) AS n
    FROM job
    GROUP BY encrypt_job_id
    HAVING n > 1
    LIMIT 1
  `).get();
  if (duplicateJob) {
    throw new Error(`job 表里 encrypt_job_id=${duplicateJob.encrypt_job_id} 重复了 ${duplicateJob.n} 条；请先清理重复岗位再开库。`);
  }
  db.exec(JOB_UNIQUE_INDEX);
  const duplicateResume = db.prepare(`
    SELECT candidate_id, COUNT(*) AS n
    FROM resume_online
    GROUP BY candidate_id
    HAVING n > 1
    LIMIT 1
  `).get();
  if (duplicateResume) {
    throw new Error(`resume_online 表里 candidate_id=${duplicateResume.candidate_id} 重复了 ${duplicateResume.n} 条；请先清理重复简历再开库。`);
  }
  db.exec(RESUME_ONLINE_UNIQUE_INDEX);
  const duplicateProfile = db.prepare(`
    SELECT job_id, COUNT(*) AS n
    FROM job_profile
    GROUP BY job_id
    HAVING n > 1
    LIMIT 1
  `).get();
  if (duplicateProfile) {
    throw new Error(`job_profile 表里 job_id=${duplicateProfile.job_id} 重复了 ${duplicateProfile.n} 条；请先清理重复画像再开库。`);
  }
  db.exec(JOB_PROFILE_UNIQUE_INDEX);
  db.exec(INBOX_SCAN_UNIQUE_INDEX);
  db.exec(SCREENSHOT_OCR_REVIEW_SCHEMA);
  migrateScreenshotOcrDraftColumns(db);
  db.exec(SCREENSHOT_IDENTITY_INDEXES);
  ensureInterviewRecordingSchema(db);
  applyF006InterviewSessionMigration(db);
  applyF007InterviewAdapterMigration(db);
  applyF006InterviewSessionMigration(db);
  applyF008InterviewReportMigration(db);
  applyF009InterviewLlmMigration(db);
  applyInterviewLogisticsDataMigration(db);
  applyF012WorkbenchMigration(db);
  applyHrJourneyOperationsSchema(db);
  applyInterviewMaterialLifecycleSchema(db);
  ensureLifecycleSessionsForExistingInterviews(db);
  backfillInterviewLifecycleMaterials(db);
  if (fs.existsSync(INTERVIEW_MATERIAL_ROOT)) {
    recoverStagedDeletions({ database: db, root: INTERVIEW_MATERIAL_ROOT });
  }
  // F-017 Phase A is opt-in while real-data governance and Windows gates remain open.
  // It is deliberately last in the migration chain and disabled for the existing DB by default.
  if (assessmentPhaseAEnabled(options)) applyAssessmentSchemaMigration(db);
  f018RuntimeEnabled = f018FeatureEnabled(options);
  if (f018RuntimeEnabled) {
    db.transaction(() => {
      applyF018SchemaMigration(db);
      backfillLegacyCandidates({ database: db, actorContext: { actor_id: 'f018-migration' } });
      applyHrJourneyOperationsSchema(db);
    })();
  }
  return db;
}

function needsDatabaseMigration(database, options = {}) {
  const requiredTables = [
    'candidate', 'job', 'job_interview', 'resume_online', 'screenshot_ocr_draft',
    'interview_recording', 'interview_recording_consent',
    'interview_recording_consent_revocation_gate', 'interview_session',
    'interview_session_consent', 'interview_pending_assignment', 'interview_report_v1', 'interview_llm_request_audit',
    'job_jd_version', 'job_profile_version', 'interview_lifecycle_session',
    'interview_lifecycle_material', 'interview_lifecycle_hold',
    ...HR_JOURNEY_OPERATION_TABLES,
    ...INTERVIEW_LOGISTICS_TABLES,
  ];
  if (assessmentPhaseAEnabled(options)) requiredTables.push(...ASSESSMENT_TABLES);
  if (f018FeatureEnabled(options)) {
    requiredTables.push(...F018_TABLES, ...HR_JOURNEY_APPLICATION_DEPENDENT_TABLES);
  }
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  if (requiredTables.some((name) => !tables.has(name))) return true;
  const legacyConsentUnique = database.prepare("PRAGMA index_list('interview_session_consent')").all()
    .filter((item) => Number(item.unique) === 1)
    .some((item) => {
      const escapedIndex = String(item.name).replaceAll("'", "''");
      const columns = database.prepare(`PRAGMA index_info('${escapedIndex}')`).all()
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((column) => column.name);
      return columns.length === 1 && columns[0] === 'consent_id';
    });
  if (legacyConsentUnique) return true;
  const requiredColumns = {
    candidate: [
      'numeric_uid', 'quality_score', 'verdict_label', 'expert_comment', 'hard_bar_pass',
      'communication_code', 'disposition_code', 'workflow_version',
    ],
    job: ['is_fixture', 'source_type', 'department', 'location', 'planned_hires', 'status', 'updated_at'],
    job_interview: ['source_type'],
    screenshot_ocr_draft: ['identity_key', 'source_fingerprint', 'content_fingerprint', 'identity_status', 'identity_json'],
    interview_recording_consent: ['consent_text_version', 'consent_text_sha256'],
    interview_recording: ['report_path'],
    interview_llm_request_audit: ['base_url', 'prompt_hash', 'model_catalog_hash', 'source_version_hash'],
    interview_pending_assignment: ['source_type', 'source_key', 'payload_hash', 'purpose', 'version'],
    candidate_next_action: ['application_id'],
    status_history: ['from_code', 'to_code'],
    interview_session: [...INTERVIEW_SESSION_LOGISTICS_COLUMNS],
    interview_session_schedule_confirmation: ['request_id', ...SCHEDULE_LOGISTICS_COLUMNS],
    interview_lifecycle_material: ['storage_kind', 'db_entity_type', 'db_entity_id'],
    interview_lifecycle_tombstone: ['storage_kind', 'db_entity_type', 'db_entity_id'],
  };
  if (assessmentPhaseAEnabled(options)) {
    requiredColumns.assessment_document = ['dispute_state'];
    requiredColumns.assessment_binding = ['conflict_state'];
  }
  if (f018FeatureEnabled(options)) {
    requiredColumns.application_episode = ['episode_no', 'status', 'disposition_action', 'version'];
    requiredColumns.application_event = ['object_type', 'object_id', 'request_hash', 'event_type'];
    requiredColumns.final_review = [
      'review_json', 'content_hash', 'status', 'version',
      'interview_report_ref_id', 'interview_report_content_hash', 'interview_report_version',
    ];
    requiredColumns.final_disposition = ['request_hash', 'application_before_version', 'application_after_version'];
  }
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const present = new Set(database.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name));
    if (columns.some((name) => !present.has(name))) return true;
  }
  if (tables.has('candidate_offer_status')) {
    const offerIndexes = database.prepare("PRAGMA index_list('candidate_offer_status')").all();
    const hasApplicationUnique = offerIndexes.some((item) => (
      item.name === 'candidate_offer_status_application_unique'
      && Number(item.unique) === 1
    ));
    const hasLegacyCandidateJobUnique = offerIndexes
      .filter((item) => Number(item.unique) === 1)
      .some((item) => {
        const escapedIndex = String(item.name).replaceAll("'", "''");
        const columns = database.prepare(`PRAGMA index_info('${escapedIndex}')`).all()
          .sort((left, right) => Number(left.seqno) - Number(right.seqno))
          .map((column) => column.name);
        return columns.length === 2
          && columns[0] === 'candidate_id'
          && columns[1] === 'job_id';
      });
    if (!hasApplicationUnique || hasLegacyCandidateJobUnique) return true;
  }
  const journeyGuardNames = ['candidate_offer_status_identity_update_guard'];
  if (tables.has('application_episode')) {
    journeyGuardNames.push(...HR_JOURNEY_APPLICATION_DEPENDENT_TRIGGERS);
  }
  const journeyGuards = new Set(database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND name IN (${journeyGuardNames.map(() => '?').join(', ')})
  `).all(...journeyGuardNames).map((row) => row.name));
  if (journeyGuardNames.some((name) => !journeyGuards.has(name))) return true;
  if (!tables.has('application_episode')) {
    const staleDependentArtifacts = database.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE (
        type = 'table' AND name IN (${HR_JOURNEY_APPLICATION_DEPENDENT_TABLES.map(() => '?').join(', ')})
      ) OR (
        type = 'trigger' AND name IN (${HR_JOURNEY_APPLICATION_DEPENDENT_TRIGGERS.map(() => '?').join(', ')})
      )
      LIMIT 1
    `).get(
      ...HR_JOURNEY_APPLICATION_DEPENDENT_TABLES,
      ...HR_JOURNEY_APPLICATION_DEPENDENT_TRIGGERS,
    );
    if (staleDependentArtifacts) return true;
  }
  const interviewLogisticsObjects = database.prepare(`
    SELECT type, name FROM sqlite_master WHERE type IN ('index', 'trigger')
  `).all();
  const interviewLogisticsIndexes = new Set(interviewLogisticsObjects.filter((row) => row.type === 'index').map((row) => row.name));
  const interviewLogisticsTriggers = new Set(interviewLogisticsObjects.filter((row) => row.type === 'trigger').map((row) => row.name));
  if (INTERVIEW_LOGISTICS_INDEXES.some((name) => !interviewLogisticsIndexes.has(name))
      || INTERVIEW_LOGISTICS_TRIGGERS.some((name) => !interviewLogisticsTriggers.has(name))) return true;
  if (assessmentPhaseAEnabled(options)) {
    const assessmentObjects = database.prepare(`
      SELECT type, name FROM sqlite_master WHERE type IN ('index', 'trigger')
    `).all();
    const indexes = new Set(assessmentObjects.filter((row) => row.type === 'index').map((row) => row.name));
    const triggers = new Set(assessmentObjects.filter((row) => row.type === 'trigger').map((row) => row.name));
    if (ASSESSMENT_DELETION_INDEXES.some((name) => !indexes.has(name))
        || ASSESSMENT_DELETION_TRIGGERS.some((name) => !triggers.has(name))) return true;
  }
  if (f018FeatureEnabled(options)) {
    const f018Objects = database.prepare(`
      SELECT type, name FROM sqlite_master WHERE type IN ('index', 'trigger')
    `).all();
    const indexes = new Set(f018Objects.filter((row) => row.type === 'index').map((row) => row.name));
    const triggers = new Set(f018Objects.filter((row) => row.type === 'trigger').map((row) => row.name));
    if (F018_INDEXES.some((name) => !indexes.has(name))
        || F018_TRIGGERS.some((name) => !triggers.has(name))) return true;
  }
  if (database.prepare(`
    SELECT 1
    FROM interview_session session
    LEFT JOIN interview_lifecycle_session lifecycle ON lifecycle.id = CAST(session.id AS TEXT)
    WHERE lifecycle.id IS NULL
    LIMIT 1
  `).get()) return true;
  if (f018FeatureEnabled(options) && database.prepare(`
    SELECT 1
    FROM candidate candidate
    LEFT JOIN application_episode application
      ON application.candidate_id = candidate.internal_id AND application.job_id = candidate.job_id
    WHERE application.id IS NULL
    LIMIT 1
  `).get()) return true;
  return hasPendingLifecycleMaterialBackfill(database);
}

async function prepareDatabaseMigrationBackup(file = DB_PATH, options = {}) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) return { backup_required: false, reason: 'new_database' };
  ensurePrivateFile(resolved);
  const source = new Database(resolved, { fileMustExist: true });
  try {
    const migrationRequired = options.force === true || needsDatabaseMigration(source, options);
    if (!migrationRequired) return { backup_required: false, reason: 'schema_current' };
    const recoveryRoot = path.resolve(
      options.recoveryRoot
        || process.env.HRBOSS_RECOVERY_ROOT
        || path.join(path.dirname(resolved), 'recovery'),
    );
    const createdAt = options.createdAt || nowIso();
    const recoveryId = options.recoveryId
      || `startup-${createdAt.replace(/[^0-9]/g, '').slice(0, 17)}-${crypto.randomBytes(6).toString('hex')}`;
    const assessmentDocumentTable = source.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'assessment_document'
    `).get();
    const hasAssessmentDocuments = assessmentDocumentTable
      && Boolean(source.prepare('SELECT 1 AS present FROM assessment_document LIMIT 1').get());
    if (hasAssessmentDocuments) {
      const assessmentRecoveryRoot = path.resolve(
        options.assessmentRecoveryRoot
          || process.env.HRBOSS_ASSESSMENT_RECOVERY_ROOT
          || path.join(path.dirname(resolved), 'assessment-recovery'),
      );
      const result = await (options.createAssessmentBackup || createAssessmentStoreBackup)({
        database: source,
        dataRoot: path.resolve(options.assessmentDataRoot || path.dirname(resolved)),
        backupRoot: assessmentRecoveryRoot,
        recoveryId,
        policyVersion: options.assessmentBackupPolicyVersion,
        retentionDays: options.assessmentBackupRetentionDays,
        createdAt,
      });
      return {
        backup_required: true,
        backup_kind: 'assessment_db_store',
        recovery_root: assessmentRecoveryRoot,
        ...result,
      };
    }
    const backup = options.createBackup || createSqliteBackup;
    const result = await backup({
      database: source,
      recoveryRoot,
      recoveryId,
      appVersion: options.appVersion || require('./package.json').version,
      policyVersion: INTERVIEW_LIFECYCLE_POLICY_VERSION,
      createdAt,
    });
    return { backup_required: true, recovery_root: recoveryRoot, ...result };
  } finally {
    source.close();
  }
}

async function openDbWithMigrationBackup(file = DB_PATH, options = {}) {
  const recoveryRoot = path.resolve(options.recoveryRoot || process.env.HRBOSS_RECOVERY_ROOT || path.join(path.dirname(path.resolve(file)), 'recovery'));
  const purge = purgeExpiredRecoveryPackages({ recoveryRoot, now: options.now || nowIso() });
  const backup = await prepareDatabaseMigrationBackup(file, { ...options, recoveryRoot });
  return { database: openDb(file, options), backup, recovery_packages_purged: purge.purged_count };
}

function openReadonly(file = DB_PATH) {
  consentRevocationLatch.setActiveDatabasePath(file);
  // Operational-readonly startup must never repair permissions or create paths.
  // Validate and fail closed; the normal writable startup remains responsible
  // for creating and hardening the database.
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    const error = new Error('readonly database must be an existing regular file');
    error.code = 'READONLY_DATABASE_FILE_INVALID';
    throw error;
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    const error = new Error('readonly database permissions are not private; open once in normal mode to repair them');
    error.code = 'READONLY_DATABASE_PERMISSIONS_UNSAFE';
    throw error;
  }
  if (operationalReadonlyMode) {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        fs.lstatSync(`${file}${suffix}`);
        const error = new Error(`readonly database has recovery sidecar ${suffix}; open once in normal mode before operational readonly`);
        error.code = 'READONLY_DATABASE_RECOVERY_REQUIRED';
        throw error;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
    }
    const immutableUri = `${pathToFileURL(path.resolve(file)).href}?immutable=1`;
    db = new Database(immutableUri, { readonly: true, fileMustExist: true });
  } else {
    db = new Database(file, { readonly: true, fileMustExist: true });
  }
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.pragma('foreign_keys = ON');
  // Readonly consumers may project an already-migrated F018 database, but must
  // never create or repair its schema. A disabled flag or any missing F018
  // table safely falls back to the legacy projection.
  f018RuntimeEnabled = f018FeatureEnabled() && f018ProjectionTablesAvailable(db);
  return db;
}

function useReadonly(options = {}) {
  readonlyMode = true;
  operationalReadonlyMode = options.operational === true;
}

function assertReadonlySchema(database, key, requirements) {
  if (!readonlyMode || readonlySchemaChecks.has(key)) return;
  for (const [table, columns] of Object.entries(requirements)) {
    const present = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    if (!present) {
      const error = new Error(`readonly projection schema is missing table: ${table}`);
      error.code = 'READONLY_SCHEMA_MIGRATION_REQUIRED';
      error.statusCode = 503;
      throw error;
    }
    const available = new Set(database.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name));
    const missing = columns.filter((column) => !available.has(column));
    if (missing.length) {
      const error = new Error(`readonly projection schema is missing ${table}.${missing.join(',')}`);
      error.code = 'READONLY_SCHEMA_MIGRATION_REQUIRED';
      error.statusCode = 503;
      throw error;
    }
  }
  readonlySchemaChecks.add(key);
}

function conn() {
  return db || (readonlyMode ? openReadonly() : openDb());
}

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return value === undefined || value === null ? null : String(value);
}

function redactKnownCandidateName(value, candidateName) {
  const name = String(candidateName || '').replace(/\s+/g, '').trim();
  if (!name || name.length < 2) return value;
  if (typeof value === 'string') {
    const pattern = [...name]
      .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s*');
    return value.replace(new RegExp(pattern, 'g'), '候选人');
  }
  if (Array.isArray(value)) return value.map((item) => redactKnownCandidateName(item, name));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactKnownCandidateName(item, name)]));
  }
  return value;
}

function jsonText(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

const RECORDING_SUMMARY_METADATA_KEYS = Object.freeze([
  'source', 'is_fixture', 'external_services_called', 'createdAt', 'topic',
  'durationSeconds', 'language', 'asrEngine', 'model', 'format_version',
  'transcriptSchemaVersion', 'transcriptReviewStatus', 'transcriptAccuracyLabel',
  'cueCount', 'lowConfidenceCueCount',
]);

function safeRecordingSummaryMetadata(value) {
  const summary = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const safe = {};
  for (const key of RECORDING_SUMMARY_METADATA_KEYS) {
    const item = summary[key];
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) safe[key] = item;
  }
  return safe;
}

function confirmationValue(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function ensureInterviewRecordingSchema(database = conn()) {
  if (readonlyMode) {
    assertReadonlySchema(database, 'interview-recording', {
      interview_recording: ['id', 'candidate_id', 'job_id', 'transcript_txt_path', 'raw_summary_json', 'report_path'],
      interview_ai_report: ['id', 'recording_id', 'status', 'report_json'],
      interview_recording_consent: ['id', 'candidate_id', 'job_id', 'consent_text_version', 'consent_text_sha256'],
      interview_recording_consent_revocation_gate: ['scope_hash', 'status', 'requested_at'],
      interview_recording_confirmation: ['id', 'recording_id', 'field_key', 'status'],
      interview_script: ['id', 'job_id', 'script_json', 'script_text', 'status'],
      interview_session_material: ['id', 'session_id', 'interview_recording_id'],
      interview_lifecycle_material: ['id', 'session_id', 'state'],
    });
    return;
  }
  database.exec(INTERVIEW_RECORDING_SCHEMA);
  const recordingColumns = new Set(database.prepare("PRAGMA table_info('interview_recording')").all().map((column) => column.name));
  if (!recordingColumns.has('report_path')) database.exec('ALTER TABLE interview_recording ADD COLUMN report_path TEXT');
  const consentColumns = new Set(database.prepare("PRAGMA table_info('interview_recording_consent')").all().map((column) => column.name));
  if (!consentColumns.has('consent_text_version')) {
    database.exec('ALTER TABLE interview_recording_consent ADD COLUMN consent_text_version TEXT');
  }
  if (!consentColumns.has('consent_text_sha256')) {
    database.exec('ALTER TABLE interview_recording_consent ADD COLUMN consent_text_sha256 TEXT');
  }
}

function keysComplete(row) {
  return ['boss_id', 'geek_id', 'security_id', 'encrypt_job_id', 'expect_id', 'lid']
    .every((k) => text(row[k])) ? 1 : 0;
}

function fixtureJobValue(input) {
  if (input.is_fixture === true || Number(input.is_fixture) === 1) return 1;
  if (text(input.source_type) === 'fixture') return 1;
  const encryptJobId = text(input.encrypt_job_id) || '';
  return /(^|[-_:])fixture($|[-_:])/i.test(encryptJobId) ? 1 : 0;
}

function jobSourceTypeValue(input, isFixture) {
  if (isFixture) return 'fixture';
  return text(input.source_type) === 'boss_sync' ? 'boss_sync' : 'local_db';
}

const JOB_STATUSES = Object.freeze(['draft', 'open', 'paused', 'closed']);
const JOB_STATUS_TRANSITIONS = Object.freeze({
  draft: Object.freeze(['open', 'paused', 'closed']),
  open: Object.freeze(['paused', 'closed']),
  paused: Object.freeze(['open', 'closed']),
  closed: Object.freeze(['open']),
});

function jobOperationError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function requiredJobText(value, field, maxLength) {
  const normalized = String(value == null ? '' : value).trim();
  if (!normalized) throw jobOperationError('JOB_FIELD_REQUIRED', `${field}不能为空。`);
  if (normalized.length > maxLength) throw jobOperationError('JOB_FIELD_TOO_LONG', `${field}不能超过 ${maxLength} 个字符。`);
  return normalized;
}

function optionalJobText(value, field, maxLength) {
  const normalized = String(value == null ? '' : value).trim();
  if (normalized.length > maxLength) throw jobOperationError('JOB_FIELD_TOO_LONG', `${field}不能超过 ${maxLength} 个字符。`);
  return normalized || null;
}

function normalizedPlannedHires(value) {
  const plannedHires = Number(value);
  if (!Number.isSafeInteger(plannedHires) || plannedHires < 1 || plannedHires > 10000) {
    throw jobOperationError('JOB_PLANNED_HIRES_INVALID', '计划 HC 必须是 1 到 10000 之间的整数。');
  }
  return plannedHires;
}

function normalizedJobStatus(value, fallback = 'draft') {
  const status = String(value == null ? fallback : value).trim();
  if (!JOB_STATUSES.includes(status)) {
    throw jobOperationError('JOB_STATUS_INVALID', '岗位状态只支持 draft、open、paused、closed。');
  }
  return status;
}

function interviewSourceTypeValue(value) {
  const sourceType = text(value);
  return ['manual_transcript', 'offline_recording', 'lark_minutes'].includes(sourceType)
    ? sourceType
    : 'manual_transcript';
}

function upsertJob(input) {
  const database = conn();
  const timestamp = text(input.created_at) || nowIso();
  const encryptJobId = text(input.encrypt_job_id);
  if (!encryptJobId) throw new Error('encrypt_job_id is required');
  const isFixture = fixtureJobValue(input);
  const sourceType = jobSourceTypeValue(input, isFixture);
  return database.transaction(() => {
    database.prepare(`
      INSERT INTO job (
        encrypt_job_id, numeric_job_id, name, hr_owner, department, location, planned_hires, status,
        is_fixture, source_type, created_at, updated_at
      ) VALUES (
        @encrypt_job_id, @numeric_job_id, @name, @hr_owner, @department, @location, 1, 'open',
        @is_fixture, @source_type, @created_at, @updated_at
      )
      ON CONFLICT(encrypt_job_id) DO UPDATE SET
        numeric_job_id = COALESCE(excluded.numeric_job_id, job.numeric_job_id),
        name = COALESCE(excluded.name, job.name),
        hr_owner = CASE
          WHEN job.source_type = 'boss_sync' THEN job.hr_owner
          ELSE COALESCE(excluded.hr_owner, job.hr_owner)
        END,
        department = CASE
          WHEN excluded.source_type = 'boss_sync' THEN COALESCE(excluded.department, job.department)
          ELSE job.department
        END,
        location = CASE
          WHEN excluded.source_type = 'boss_sync' THEN COALESCE(excluded.location, job.location)
          ELSE job.location
        END,
        is_fixture = excluded.is_fixture,
        source_type = excluded.source_type,
        updated_at = excluded.updated_at
    `).run({
      encrypt_job_id: encryptJobId,
      numeric_job_id: text(input.numeric_job_id),
      name: text(input.name),
      hr_owner: text(input.hr_owner),
      department: text(input.department),
      location: text(input.location),
      is_fixture: isFixture,
      source_type: sourceType,
      created_at: timestamp,
      updated_at: nowIso(),
    });
    return database.prepare('SELECT id, is_fixture, source_type FROM job WHERE encrypt_job_id = ?').get(encryptJobId);
  })();
}

function nextInternalId(database) {
  const year = String(new Date().getFullYear());
  const row = database.prepare(`
    SELECT MAX(CAST(SUBSTR(internal_id, 8) AS INTEGER)) AS seq
    FROM candidate c
    WHERE internal_id GLOB 'C-[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]'
  `).get();
  return `C-${year}-${String((row.seq || 0) + 1).padStart(6, '0')}`;
}

function mergeCandidate(existing, input, timestamp) {
  const row = {};
  for (const key of [
    'numeric_uid', 'boss_id', 'security_id', 'encrypt_job_id', 'expect_id', 'lid', 'chat_uid',
    'relation_type', 'last_ts', 'rec_position', 'name', 'age', 'degree',
    'degree_verified', 'school', 'school_tier', 'work_years', 'salary', 'geek_desc',
    'sabc', 'sabc_source', 'sabc_reason', 'match_point', 'risk_point', 'raw_json',
  ]) {
    const value = text(input[key]);
    row[key] = value === null && existing ? existing[key] : value;
  }
  row.source = existing ? existing.source : text(input.source);
  row.job_id = input.job_id;
  row.geek_id = text(input.geek_id);
  row.comm_status = existing ? existing.comm_status : (text(input.comm_status) || '未打招呼');
  row.disposition_status = existing ? existing.disposition_status : (text(input.disposition_status) || '新入库');
  row.communication_code = existing && existing.communication_code
    ? existing.communication_code
    : workflow.communicationCode(text(input.communication_code), row.comm_status);
  row.disposition_code = existing && existing.disposition_code
    ? existing.disposition_code
    : workflow.dispositionCode(text(input.disposition_code), row.disposition_status);
  row.workflow_version = existing ? Number(existing.workflow_version || 1) : 1;
  row.keys_complete = keysComplete(row);
  row.created_at = existing ? existing.created_at : (text(input.created_at) || timestamp);
  row.updated_at = timestamp;
  return row;
}

const upsertCandidateTx = (database) => database.transaction((input, at) => {
  const timestamp = at || nowIso();
  const existing = database.prepare('SELECT * FROM candidate WHERE geek_id = ? AND job_id = ?')
    .get(text(input.geek_id), input.job_id);
  const row = mergeCandidate(existing, input, timestamp);

  if (existing) {
    database.prepare(`
      UPDATE candidate SET
        boss_id = @boss_id,
        numeric_uid = @numeric_uid,
        security_id = @security_id,
        encrypt_job_id = @encrypt_job_id,
        expect_id = @expect_id,
        lid = @lid,
        chat_uid = @chat_uid,
        relation_type = @relation_type,
        last_ts = @last_ts,
        source = @source,
        rec_position = @rec_position,
        keys_complete = @keys_complete,
        name = @name,
        age = @age,
        degree = @degree,
        degree_verified = @degree_verified,
        school = @school,
        school_tier = @school_tier,
        work_years = @work_years,
        salary = @salary,
        geek_desc = @geek_desc,
        sabc = @sabc,
        sabc_source = @sabc_source,
        sabc_reason = @sabc_reason,
        match_point = @match_point,
        risk_point = @risk_point,
        comm_status = @comm_status,
        disposition_status = @disposition_status,
        communication_code = @communication_code,
        disposition_code = @disposition_code,
        workflow_version = @workflow_version,
        raw_json = @raw_json,
        updated_at = @updated_at
      WHERE internal_id = @internal_id
    `).run({ ...row, internal_id: existing.internal_id });
    return { internal_id: existing.internal_id, inserted: false };
  }

  const internal_id = nextInternalId(database);
  database.prepare(`
    INSERT INTO candidate (
      internal_id, job_id, geek_id, numeric_uid, boss_id, security_id, encrypt_job_id, expect_id,
      lid, chat_uid, relation_type, last_ts, source, rec_position, keys_complete,
      name, age, degree, degree_verified, school, school_tier, work_years, salary,
      geek_desc, sabc, sabc_source, sabc_reason, match_point, risk_point, comm_status,
      disposition_status, communication_code, disposition_code, workflow_version,
      raw_json, created_at, updated_at
    ) VALUES (
      @internal_id, @job_id, @geek_id, @numeric_uid, @boss_id, @security_id, @encrypt_job_id, @expect_id,
      @lid, @chat_uid, @relation_type, @last_ts, @source, @rec_position, @keys_complete,
      @name, @age, @degree, @degree_verified, @school, @school_tier, @work_years, @salary,
      @geek_desc, @sabc, @sabc_source, @sabc_reason, @match_point, @risk_point, @comm_status,
      @disposition_status, @communication_code, @disposition_code, @workflow_version,
      @raw_json, @created_at, @updated_at
    )
  `).run({ ...row, internal_id });
  return { internal_id, inserted: true };
});

function upsertCandidate(input, at) {
  const database = conn();
  assertJobRecruitingWritable(database, input.job_id);
  return database.transaction(() => {
    const result = upsertCandidateTx(database)(input, at);
    if (f018RuntimeEnabled && result.inserted
        && database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'application_episode'").get()) {
      createF018ApplicationService({
        database,
        actorContext: { actor_id: 'f018-candidate-ingest' },
      }).openApplication({
        candidate_id: result.internal_id,
        job_id: Number(input.job_id),
        request_id: `f018.ingest.open.${result.internal_id}`,
        reason_code: 'candidate_ingest',
      });
    }
    return result;
  })();
}

function changeStatus(candidateId, layer, toStatus, source, who, reason) {
  const database = conn();
  const column = layer === 'comm' ? 'comm_status' : layer === 'disposition' ? 'disposition_status' : null;
  const codeColumn = layer === 'comm' ? 'communication_code' : layer === 'disposition' ? 'disposition_code' : null;
  if (!column) throw new Error('layer must be comm or disposition');
  const manualHold = layer === 'disposition' && source === 'manual_hr_action' && String(toStatus || '').trim() === 'hold';
  const toCode = manualHold
    ? 'under_review'
    : layer === 'comm'
    ? workflow.communicationCode(toStatus, toStatus)
    : workflow.dispositionCode(toStatus, toStatus);
  if (!toCode) throw new Error(`unsupported ${layer} status: ${toStatus}`);
  const displayStatus = manualHold
    ? '暂缓'
    : layer === 'comm'
    ? (workflow.COMMUNICATION_CODE_TO_LABEL[toCode] || toStatus)
    : source === 'manual_hr_action' && toCode === 'hired'
        ? '录用'
    : (workflow.DISPOSITION_CODE_TO_LABEL[toCode] || toStatus);
  return database.transaction(() => {
    const row = database.prepare(`SELECT job_id, ${column} AS current_status, ${codeColumn} AS current_code, workflow_version FROM candidate WHERE internal_id = ?`).get(candidateId);
    if (!row) throw new Error(`candidate not found: ${candidateId}`);
    assertJobRecruitingWritable(database, row.job_id);
    const fromCode = layer === 'comm'
      ? workflow.communicationCode(row.current_code, row.current_status)
      : workflow.dispositionCode(row.current_code, row.current_status);
    const manualProjectionChanged = layer === 'disposition'
      && source === 'manual_hr_action'
      && toCode === 'under_review'
      && fromCode === toCode
      && String(row.current_status || '').trim() !== String(displayStatus || '').trim();
    if (fromCode === toCode && !manualProjectionChanged) {
      return {
        changed: false,
        idempotent_replay: true,
        candidate_id: candidateId,
        layer,
        code: toCode,
      };
    }
    const created_at = nowIso();
    database.prepare(`UPDATE candidate SET ${column} = ?, ${codeColumn} = ?, workflow_version = workflow_version + 1, updated_at = ? WHERE internal_id = ?`)
      .run(displayStatus, toCode, created_at, candidateId);
    database.prepare(`
      INSERT INTO status_history (
        candidate_id, layer, from_status, to_status, source, who, reason,
        from_code, to_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(candidateId, layer, row.current_status, displayStatus, source, who, reason, fromCode, toCode, created_at);
    return {
      changed: true,
      idempotent_replay: false,
      candidate_id: candidateId,
      layer,
      code: toCode,
    };
  })();
}

function writeAuditLog(row) {
  return conn().prepare(`
    INSERT INTO audit_log (action, target, who, auto, result, detail_json, created_at)
    VALUES (@action, @target, @who, @auto, @result, @detail_json, @created_at)
  `).run({ ...row, created_at: row.created_at || nowIso() });
}

function writeRunLog(row) {
  return conn().prepare(`
    INSERT INTO run_log (run_type, account, job, status, count_new, count_total, error_summary, started_at, finished_at)
    VALUES (@run_type, @account, @job, @status, @count_new, @count_total, @error_summary, @started_at, @finished_at)
  `).run({
    error_summary: null,
    ...row,
    started_at: row.started_at || nowIso(),
    finished_at: row.finished_at || nowIso(),
  });
}

function computeDedupKey(input = {}) {
  const person = text(input.numeric_geek_id) || text(input.numeric_uid) || text(input.encrypted_geek_id) || text(input.geek_id) || text(input.candidate_id);
  const job = text(input.job_id) || text(input.encrypt_job_id) || 'unknown-job';
  const candidate = text(input.candidate_id) || 'unknown-candidate';
  if (!person) throw new Error('dedup id is required');
  return [job, person, candidate].join(':');
}

function enqueueWriteAction(input) {
  const database = conn();
  const timestamp = nowIso();
  const row = {
    action_type: text(input.action_type),
    candidate_id: text(input.candidate_id),
    dedup_key: text(input.dedup_key),
    greet_text: text(input.greet_text),
    created_at: timestamp,
    updated_at: timestamp,
  };
  if (!row.action_type) throw new Error('action_type is required');
  if (!row.dedup_key) throw new Error('dedup_key is required');
  return database.transaction(() => {
    const existing = database.prepare('SELECT * FROM write_action WHERE dedup_key = ? AND action_type = ?').get(row.dedup_key, row.action_type);
    if (!existing) {
      database.prepare(`
        INSERT INTO write_action (
          action_type, candidate_id, dedup_key, status, attempt,
          greet_text, created_at, updated_at
        ) VALUES (
          @action_type, @candidate_id, @dedup_key, 'queued', 0,
          @greet_text, @created_at, @updated_at
        )
      `).run(row);
      return database.prepare('SELECT * FROM write_action WHERE dedup_key = ? AND action_type = ?').get(row.dedup_key, row.action_type);
    }
    // 已存在同一 (dedup_key, action_type) 就保持原状。任何失败、停写、跳过或崩溃残留
    // 都不得由定时任务自动重排；未来如需重试，必须走独立且显式的人工授权接口。
    return existing;
  })();
}

function claimWriteAction(id) {
  const database = conn();
  return database.transaction(() => {
    const row = database.prepare('SELECT * FROM write_action WHERE id = ?').get(id);
    if (!row || row.status !== 'queued') return null;
    const timestamp = nowIso();
    database.prepare(`
      UPDATE write_action
      SET status = 'running', attempt = COALESCE(attempt, 0) + 1, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(timestamp, id);
    return database.prepare('SELECT * FROM write_action WHERE id = ?').get(id);
  })();
}

function finishWriteAction(id, result) {
  const timestamp = nowIso();
  conn().prepare(`
    UPDATE write_action
    SET status = @status,
        boss_code = @boss_code,
        decision = @decision,
        result_json = @result_json,
        updated_at = @updated_at,
        executed_at = @executed_at
    WHERE id = @id
  `).run({
    id,
    status: text(result.status),
    boss_code: result.boss_code == null ? null : Number(result.boss_code),
    decision: text(result.decision),
    result_json: typeof result.result_json === 'string' ? result.result_json : JSON.stringify(result.result_json || null),
    updated_at: timestamp,
    executed_at: timestamp,
  });
  return conn().prepare('SELECT * FROM write_action WHERE id = ?').get(id);
}

function failClosedWriteAction(id, input = {}) {
  const database = conn();
  const timestamp = nowIso();
  const account = text(input.account) || 'default';
  const errorType = (text(input.error_type) || 'Error')
    .replace(/[^A-Za-z0-9_.:-]/g, '')
    .slice(0, 64) || 'Error';
  return database.transaction(() => {
    database.prepare(`
      UPDATE write_action
      SET status = 'stopped',
          boss_code = NULL,
          decision = 'worker_exception_stop',
          result_json = @result_json,
          updated_at = @updated_at,
          executed_at = @executed_at
      WHERE id = @id AND status = 'running'
    `).run({
      id,
      result_json: JSON.stringify({ status: 'worker_exception', error_type: errorType }),
      updated_at: timestamp,
      executed_at: timestamp,
    });

    database.prepare(`
      INSERT INTO circuit_breaker (
        account, state, reason_code, reason_text, consecutive_failures,
        cooldown_until, stopped_at, updated_at
      ) VALUES (?, 'stopped', NULL, 'worker_exception_stop', 1, NULL, ?, ?)
      ON CONFLICT(account) DO UPDATE SET
        state = 'stopped',
        reason_code = NULL,
        reason_text = 'worker_exception_stop',
        consecutive_failures = COALESCE(circuit_breaker.consecutive_failures, 0) + 1,
        cooldown_until = NULL,
        stopped_at = excluded.stopped_at,
        updated_at = excluded.updated_at
    `).run(account, timestamp, timestamp);

    database.prepare(`
      INSERT INTO audit_log (action, target, who, auto, result, detail_json, created_at)
      VALUES (@action, @target, @who, 1, 'stopped', @detail_json, @created_at)
    `).run({
      action: text(input.audit_action) || 'Boss 写动作执行器异常',
      target: text(input.target) || String(id),
      who: text(input.who) || 'write-worker',
      detail_json: JSON.stringify({ decision: 'worker_exception_stop', error_type: errorType }),
      created_at: timestamp,
    });

    return database.prepare('SELECT * FROM write_action WHERE id = ?').get(id);
  })();
}

function insertResumeOnline(input, options = {}) {
  const conflictClause = options.ifMissing === true
    ? 'ON CONFLICT(candidate_id) DO NOTHING'
    : `ON CONFLICT(candidate_id) DO UPDATE SET
      sections_json = excluded.sections_json,
      is_paywalled = excluded.is_paywalled,
      raw_json = excluded.raw_json,
      fetched_at = excluded.fetched_at`;
  return conn().prepare(`
    INSERT INTO resume_online (candidate_id, sections_json, is_paywalled, raw_json, fetched_at)
    VALUES (@candidate_id, @sections_json, @is_paywalled, @raw_json, @fetched_at)
    ${conflictClause}
  `).run({
    candidate_id: text(input.candidate_id),
    sections_json: typeof input.sections_json === 'string' ? input.sections_json : JSON.stringify(input.sections_json || null),
    is_paywalled: input.is_paywalled ? 1 : 0,
    raw_json: text(input.raw_json),
    fetched_at: text(input.fetched_at) || nowIso(),
  });
}

function jobLedgerSelect(where = '') {
  const latestApplicationOfferCounts = tableExists(conn(), 'application_episode');
  const currentOfferApplication = `
          AND (
            (
              application.status = 'active'
              AND application.disposition_action = 'continue_process'
            )
            OR EXISTS (
              SELECT 1
              FROM candidate offer_candidate
              WHERE offer_candidate.internal_id = application.candidate_id
                AND offer_candidate.job_id = application.job_id
                AND (
                  offer_candidate.disposition_code = 'hired'
                  OR (
                    offer_candidate.disposition_code IS NULL
                    AND offer_candidate.disposition_status = '已入职'
                  )
                )
            )
          )
  `;
  const acceptedOfferCount = latestApplicationOfferCounts ? `
      (
        SELECT COUNT(*)
        FROM candidate_offer_status offer
        JOIN application_episode application ON application.id = offer.application_id
        WHERE offer.job_id = job.id
          AND offer.status IN ('accepted', 'onboarding_handoff')
          ${currentOfferApplication}
          AND NOT EXISTS (
            SELECT 1
            FROM application_episode newer_application
            WHERE newer_application.candidate_id = application.candidate_id
              AND newer_application.job_id = application.job_id
              AND (
                newer_application.episode_no > application.episode_no
                OR (
                  newer_application.episode_no = application.episode_no
                  AND newer_application.id > application.id
                )
              )
          )
      )
  ` : '0';
  const onboardingHandoffCount = latestApplicationOfferCounts ? `
      (
        SELECT COUNT(*)
        FROM candidate_offer_status offer
        JOIN application_episode application ON application.id = offer.application_id
        WHERE offer.job_id = job.id
          AND offer.status = 'onboarding_handoff'
          ${currentOfferApplication}
          AND NOT EXISTS (
            SELECT 1
            FROM application_episode newer_application
            WHERE newer_application.candidate_id = application.candidate_id
              AND newer_application.job_id = application.job_id
              AND (
                newer_application.episode_no > application.episode_no
                OR (
                  newer_application.episode_no = application.episode_no
                  AND newer_application.id > application.id
                )
              )
          )
      )
  ` : '0';
  return `
    SELECT
      job.id,
      job.name,
      job.hr_owner,
      job.department,
      job.location,
      job.planned_hires,
      job.status,
      job.close_reason_code,
      job.close_note,
      job.closed_at,
      job.closed_by,
      job.is_fixture,
      job.source_type,
      job.created_at,
      job.updated_at,
      COUNT(candidate.internal_id) AS candidate_count,
      SUM(CASE
        WHEN candidate.disposition_code = 'hired'
          OR (candidate.disposition_code IS NULL AND candidate.disposition_status = '已入职')
        THEN 1 ELSE 0
      END) AS hired_count,
      ${acceptedOfferCount} AS accepted_offer_count,
      ${onboardingHandoffCount} AS onboarding_handoff_count,
      MAX(
        job.planned_hires - SUM(CASE
          WHEN candidate.disposition_code = 'hired'
            OR (candidate.disposition_code IS NULL AND candidate.disposition_status = '已入职')
          THEN 1 ELSE 0
        END),
        0
      ) AS remaining_hires,
      MAX(
        SUM(CASE
          WHEN candidate.disposition_code = 'hired'
            OR (candidate.disposition_code IS NULL AND candidate.disposition_status = '已入职')
          THEN 1 ELSE 0
        END) - job.planned_hires,
        0
      ) AS over_hires,
      (
        SELECT CASE
          WHEN audit.action IN ('本地新建岗位', '从预置岗位新建草稿', '复制岗位') THEN 'created'
          ELSE audit.action
        END
        FROM audit_log audit
        WHERE audit.target = CAST(job.id AS TEXT)
          AND audit.action IN (
            '本地新建岗位', '从预置岗位新建草稿', '复制岗位',
            '编辑岗位基础信息', '切换岗位状态'
          )
        ORDER BY audit.id DESC LIMIT 1
      ) AS last_change_action,
      (
        SELECT audit.who FROM audit_log audit
        WHERE audit.target = CAST(job.id AS TEXT)
          AND audit.action IN (
            '本地新建岗位', '从预置岗位新建草稿', '复制岗位',
            '编辑岗位基础信息', '切换岗位状态'
          )
        ORDER BY audit.id DESC LIMIT 1
      ) AS last_change_who,
      (
        SELECT audit.detail_json FROM audit_log audit
        WHERE audit.target = CAST(job.id AS TEXT)
          AND audit.action IN (
            '本地新建岗位', '从预置岗位新建草稿', '复制岗位',
            '编辑岗位基础信息', '切换岗位状态'
          )
        ORDER BY audit.id DESC LIMIT 1
      ) AS last_change_detail_json,
      (
        SELECT audit.created_at FROM audit_log audit
        WHERE audit.target = CAST(job.id AS TEXT)
          AND audit.action IN (
            '本地新建岗位', '从预置岗位新建草稿', '复制岗位',
            '编辑岗位基础信息', '切换岗位状态'
          )
        ORDER BY audit.id DESC LIMIT 1
      ) AS last_change_at
    FROM job
    LEFT JOIN candidate ON candidate.job_id = job.id
    ${where}
    GROUP BY job.id
  `;
}

function listJobs() {
  return conn().prepare(`
    ${jobLedgerSelect()}
    ORDER BY
      job.is_fixture ASC,
      CASE job.status WHEN 'open' THEN 0 WHEN 'paused' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
      job.id
  `).all();
}

function getJobLedger(jobId) {
  const id = Number(jobId);
  if (!Number.isSafeInteger(id) || id <= 0) throw jobOperationError('JOB_ID_INVALID', '岗位 ID 无效。');
  return conn().prepare(`${jobLedgerSelect('WHERE job.id = ?')} LIMIT 1`).get(id) || null;
}

const JOB_CREATE_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const JOB_CREATE_IDEMPOTENCY_VERSION = 1;

function normalizedJobCreateRequestId(input, required = false) {
  const createRequestId = String(input.createRequestId == null ? '' : input.createRequestId).trim();
  const requestId = String(input.requestId == null ? '' : input.requestId).trim();
  if (createRequestId && requestId && createRequestId !== requestId) {
    throw jobOperationError(
      'JOB_CREATE_REQUEST_ID_MISMATCH',
      'createRequestId 与 requestId 必须一致。',
    );
  }
  const normalized = createRequestId || requestId;
  if (!normalized) {
    if (required) {
      throw jobOperationError('JOB_CREATE_REQUEST_ID_REQUIRED', '新建岗位必须提供 createRequestId。');
    }
    return null;
  }
  if (!JOB_CREATE_REQUEST_ID_PATTERN.test(normalized)) {
    throw jobOperationError(
      'JOB_CREATE_REQUEST_ID_INVALID',
      'createRequestId 格式无效：须为 1 到 128 位字母、数字、点、下划线、冒号或连字符。',
    );
  }
  return normalized;
}

function jobCreateMaterialHash(material) {
  return crypto.createHash('sha256').update(stableJson(material), 'utf8').digest('hex');
}

function jobCreateEncryptId(actor, requestId) {
  if (!requestId) return `local-${crypto.randomUUID()}`;
  const requestHash = crypto.createHash('sha256')
    .update(stableJson({ actor, request_id: requestId }), 'utf8')
    .digest('hex');
  return `local-create-v${JOB_CREATE_IDEMPOTENCY_VERSION}-${requestHash}`;
}

function jobCreateIdempotencyDetail(requestId, materialHash, operation) {
  if (!requestId) return null;
  return {
    version: JOB_CREATE_IDEMPOTENCY_VERSION,
    request_id: requestId,
    material_sha256: materialHash,
    operation,
  };
}

function assertJobCreateReplay(database, { actor, requestId, materialHash, operation, encryptJobId }) {
  if (!requestId) return null;
  const existing = database.prepare(`
    SELECT id FROM job WHERE encrypt_job_id = ?
  `).get(encryptJobId);
  if (!existing) return null;
  const audit = database.prepare(`
    SELECT action, who, detail_json
    FROM audit_log
    WHERE target = ? AND action IN ('本地新建岗位', '从预置岗位新建草稿', '复制岗位')
    ORDER BY id ASC
    LIMIT 1
  `).get(String(existing.id));
  let marker = null;
  try {
    const detail = JSON.parse((audit && audit.detail_json) || '{}');
    marker = detail && detail.create_idempotency;
  } catch {}
  if (
    !audit
    || audit.who !== actor
    || !marker
    || Number(marker.version) !== JOB_CREATE_IDEMPOTENCY_VERSION
    || marker.request_id !== requestId
    || marker.material_sha256 !== materialHash
    || marker.operation !== operation
  ) {
    throw jobOperationError(
      'JOB_CREATE_IDEMPOTENCY_CONFLICT',
      '该 createRequestId 已用于不同的岗位创建材料，已拒绝重复创建。',
      409,
    );
  }
  return Number(existing.id);
}

function createLocalJob(input = {}) {
  const database = conn();
  const actor = requiredLocalActor(input.actor);
  const requestId = normalizedJobCreateRequestId(input, input.requireCreateRequestId === true);
  const name = requiredJobText(input.name, '岗位名称', 120);
  const hrOwner = requiredJobText(input.hrOwner === undefined ? input.hr_owner : input.hrOwner, 'HR 负责人', 80);
  const plannedHires = normalizedPlannedHires(input.plannedHires === undefined ? input.planned_hires : input.plannedHires);
  const status = normalizedJobStatus(input.status, 'draft');
  const department = optionalJobText(input.department, '部门', 120);
  const location = optionalJobText(input.location, '工作地点', 120);
  const operation = 'local_job';
  const materialHash = jobCreateMaterialHash({
    operation,
    name,
    hr_owner: hrOwner,
    planned_hires: plannedHires,
    status,
    department,
    location,
  });
  const timestamp = nowIso();
  const encryptJobId = jobCreateEncryptId(actor, requestId);

  const create = database.transaction(() => {
    const replayJobId = assertJobCreateReplay(database, {
      actor, requestId, materialHash, operation, encryptJobId,
    });
    if (replayJobId) return getJobLedger(replayJobId);
    const info = database.prepare(`
      INSERT INTO job (
        encrypt_job_id, numeric_job_id, name, hr_owner, department, location,
        planned_hires, status, is_fixture, source_type, created_at, updated_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 0, 'local_db', ?, ?)
    `).run(encryptJobId, name, hrOwner, department, location, plannedHires, status, timestamp, timestamp);
    const jobId = Number(info.lastInsertRowid);
    writeAuditLog({
      action: '本地新建岗位',
      target: String(jobId),
      who: actor,
      auto: 0,
      result: '成功',
      detail_json: JSON.stringify({
        name,
        planned_hires: plannedHires,
        status,
        source_type: 'local_db',
        create_idempotency: jobCreateIdempotencyDetail(requestId, materialHash, operation),
      }),
      created_at: timestamp,
    });
    return getJobLedger(jobId);
  });
  return requestId ? create.immediate() : create();
}

function createLocalJobFromEcommerceTemplate(input = {}) {
  const database = conn();
  const actor = requiredLocalActor(input.actor);
  const requestId = normalizedJobCreateRequestId(input, input.requireCreateRequestId === true);
  const trustedInput = { ...input };
  delete trustedInput.actor;
  delete trustedInput.createRequestId;
  delete trustedInput.requestId;
  delete trustedInput.requireCreateRequestId;
  const prepared = prepareEcommerceTemplateDraft(trustedInput);
  const name = requiredJobText(prepared.job.name, '岗位名称', 120);
  const hrOwner = requiredJobText(prepared.job.hr_owner, 'HR 负责人', 80);
  const plannedHires = normalizedPlannedHires(prepared.job.planned_hires);
  const department = optionalJobText(prepared.job.department, '部门', 120);
  const location = optionalJobText(prepared.job.location, '工作地点', 120);
  const operation = 'ecommerce_template_job';
  const materialHash = jobCreateMaterialHash({ operation, prepared });
  const timestamp = nowIso();
  const encryptJobId = jobCreateEncryptId(actor, requestId);

  // A template profile deliberately binds to its still-draft JD. Do not call
  // createJobProfileVersion here: that normal editing path requires an active
  // JD, while this flow must leave activation and profile confirmation to HR.
  applyF012WorkbenchMigration(database);
  const create = database.transaction(() => {
    const replayJobId = assertJobCreateReplay(database, {
      actor, requestId, materialHash, operation, encryptJobId,
    });
    if (replayJobId) {
      const jd = database.prepare(`
        SELECT * FROM job_jd_version WHERE job_id = ? ORDER BY version ASC, id ASC LIMIT 1
      `).get(replayJobId);
      const profile = database.prepare(`
        SELECT * FROM job_profile_version WHERE job_id = ? ORDER BY version ASC, id ASC LIMIT 1
      `).get(replayJobId);
      if (!jd || !profile || Number(profile.jd_version_id) !== Number(jd.id)) {
        throw jobOperationError(
          'JOB_CREATE_REPLAY_STATE_INVALID',
          '岗位创建记录不完整，已拒绝幂等重放；请人工检查本地数据。',
          409,
        );
      }
      return {
        job: getJobLedger(replayJobId),
        jd,
        profile: {
          ...profile,
          config: JSON.parse(profile.config_json),
          source_ref: JSON.parse(profile.source_ref_json),
        },
        template: prepared.template,
      };
    }
    const jobInfo = database.prepare(`
      INSERT INTO job (
        encrypt_job_id, numeric_job_id, name, hr_owner, department, location,
        planned_hires, status, is_fixture, source_type, created_at, updated_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, 'draft', 0, 'local_db', ?, ?)
    `).run(
      encryptJobId,
      name,
      hrOwner,
      department,
      location,
      plannedHires,
      timestamp,
      timestamp,
    );
    const jobId = Number(jobInfo.lastInsertRowid);

    const jdInfo = database.prepare(`
      INSERT INTO job_jd_version (
        job_id, version, status, source, jd_text, content_hash,
        created_by, created_at, activated_by, activated_at, superseded_at
      ) VALUES (?, 1, 'draft', 'manual', ?, ?, ?, ?, NULL, NULL, NULL)
    `).run(jobId, prepared.jd_text, stableContentHash(prepared.jd_text), actor, timestamp);
    const jdVersionId = Number(jdInfo.lastInsertRowid);

    const profileJson = JSON.stringify(prepared.profile_config);
    const profileInfo = database.prepare(`
      INSERT INTO job_profile_version (
        job_id, jd_version_id, version, status, config_json, content_hash,
        source_kind, source_ref_json, created_by, created_at,
        confirmed_by, confirmed_at, superseded_at
      ) VALUES (?, ?, 1, 'draft', ?, ?, 'manual', ?, ?, ?, NULL, NULL, NULL)
    `).run(
      jobId,
      jdVersionId,
      profileJson,
      stableContentHash(prepared.profile_config),
      JSON.stringify(prepared.source_ref),
      actor,
      timestamp,
    );
    const profileVersionId = Number(profileInfo.lastInsertRowid);

    writeAuditLog({
      action: '从预置岗位新建草稿',
      target: String(jobId),
      who: actor,
      auto: 0,
      result: '成功',
      detail_json: JSON.stringify({
        template_key: prepared.template.template_key,
        variant_key: prepared.template.variant_key,
        catalog_version: prepared.template.catalog_version,
        jd_version_id: jdVersionId,
        profile_version_id: profileVersionId,
        provided_hr_fields: prepared.source_ref.provided_hr_fields,
        missing_hr_fields: prepared.source_ref.missing_hr_fields,
        create_idempotency: jobCreateIdempotencyDetail(requestId, materialHash, operation),
      }),
      created_at: timestamp,
    });

    const profile = database.prepare('SELECT * FROM job_profile_version WHERE id = ?').get(profileVersionId);
    return {
      job: getJobLedger(jobId),
      jd: database.prepare('SELECT * FROM job_jd_version WHERE id = ?').get(jdVersionId),
      profile: {
        ...profile,
        config: JSON.parse(profile.config_json),
        source_ref: JSON.parse(profile.source_ref_json),
      },
      template: prepared.template,
    };
  });
  return requestId ? create.immediate() : create();
}

function assertJobLedgerMutationAllowed(job) {
  if (Number(job && job.is_fixture) === 1) {
    throw jobOperationError('JOB_FIXTURE_READ_ONLY', '测试岗位不允许修改。', 403);
  }
  return job;
}

function updateJobDetails(input = {}) {
  const database = conn();
  const actor = requiredLocalActor(input.actor);
  const jobId = Number(input.jobId === undefined ? input.job_id : input.jobId);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw jobOperationError('JOB_ID_INVALID', '岗位 ID 无效。');

  return database.transaction(() => {
    const current = database.prepare(`
      SELECT id, name, hr_owner, department, location, planned_hires, status, is_fixture, source_type
      FROM job
      WHERE id = ?
    `).get(jobId);
    if (!current) throw jobOperationError('JOB_NOT_FOUND', '岗位不存在。', 404);
    assertJobLedgerMutationAllowed(current);

    const incomingName = Object.prototype.hasOwnProperty.call(input, 'name')
      ? requiredJobText(input.name, '岗位名称', 120)
      : current.name;
    const incomingDepartment = Object.prototype.hasOwnProperty.call(input, 'department')
      ? optionalJobText(input.department, '部门', 120)
      : current.department;
    const incomingLocation = Object.prototype.hasOwnProperty.call(input, 'location')
      ? optionalJobText(input.location, '工作地点', 120)
      : current.location;
    const hrOwnerInput = input.hrOwner === undefined ? input.hr_owner : input.hrOwner;
    const plannedHiresInput = input.plannedHires === undefined ? input.planned_hires : input.plannedHires;
    const next = {
      name: incomingName,
      hr_owner: hrOwnerInput === undefined
        ? current.hr_owner
        : requiredJobText(hrOwnerInput, 'HR 负责人', 80),
      department: incomingDepartment,
      location: incomingLocation,
      planned_hires: plannedHiresInput === undefined
        ? Number(current.planned_hires)
        : normalizedPlannedHires(plannedHiresInput),
    };
    const changedFields = Object.keys(next).filter((field) => next[field] !== current[field]);
    if (!changedFields.length) return { job: getJobLedger(jobId), no_op: true };

    const timestamp = nowIso();
    database.prepare(`
      UPDATE job
      SET name = ?, hr_owner = ?, department = ?, location = ?, planned_hires = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.name,
      next.hr_owner,
      next.department,
      next.location,
      next.planned_hires,
      timestamp,
      jobId,
    );
    writeAuditLog({
      action: '编辑岗位基础信息',
      target: String(jobId),
      who: actor,
      auto: 0,
      result: '成功',
      detail_json: JSON.stringify({
        source_type: current.source_type,
        changed_fields: changedFields,
        before: Object.fromEntries(changedFields.map((field) => [field, current[field]])),
        after: Object.fromEntries(changedFields.map((field) => [field, next[field]])),
        child_records_changed: 0,
      }),
      created_at: timestamp,
    });
    return { job: getJobLedger(jobId), no_op: false };
  })();
}

function copyJob(input = {}) {
  const database = conn();
  const actor = requiredLocalActor(input.actor);
  const sourceJobId = Number(input.jobId === undefined ? input.job_id : input.jobId);
  if (!Number.isSafeInteger(sourceJobId) || sourceJobId <= 0) throw jobOperationError('JOB_ID_INVALID', '岗位 ID 无效。');
  const requestId = normalizedJobCreateRequestId(input, input.requireRequestId === true);
  const requestedName = String(input.name == null ? '' : input.name).trim() || null;
  if (requestedName) requiredJobText(requestedName, '岗位名称', 120);
  const operation = 'copy_job';
  const materialHash = jobCreateMaterialHash({
    operation,
    source_job_id: sourceJobId,
    requested_name: requestedName,
  });
  const encryptJobId = jobCreateEncryptId(actor, requestId);
  const copy = database.transaction(() => {
    const replayJobId = assertJobCreateReplay(database, {
      actor, requestId, materialHash, operation, encryptJobId,
    });
    if (replayJobId) return getJobLedger(replayJobId);

  const source = database.prepare(`
    SELECT id, name, hr_owner, department, location, planned_hires, is_fixture
    FROM job WHERE id = ?
  `).get(sourceJobId);
  if (!source) throw jobOperationError('JOB_NOT_FOUND', '要复制的岗位不存在。', 404);
  assertJobLedgerMutationAllowed(source);

    const name = requiredJobText(requestedName || `${source.name || `岗位 ${source.id}`} - 副本`, '岗位名称', 120);
  const timestamp = nowIso();
    const inserted = database.prepare(`
      INSERT INTO job (
        encrypt_job_id, numeric_job_id, name, hr_owner, department, location,
        planned_hires, status, is_fixture, source_type, created_at, updated_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, 'draft', 0, 'local_db', ?, ?)
    `).run(
      encryptJobId,
      name,
      source.hr_owner,
      source.department,
      source.location,
      source.planned_hires,
      timestamp,
      timestamp,
    );
    const newJobId = Number(inserted.lastInsertRowid);

    const sourceJd = database.prepare(`
      SELECT * FROM job_jd_version
      WHERE job_id = ?
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, version DESC, id DESC
      LIMIT 1
    `).get(sourceJobId) || null;
    let copiedJdId = null;
    if (sourceJd) {
      const jdInfo = database.prepare(`
        INSERT INTO job_jd_version (
          job_id, version, status, source, jd_text, content_hash,
          created_by, created_at, activated_by, activated_at, superseded_at
        ) VALUES (?, 1, 'draft', 'manual', ?, ?, ?, ?, NULL, NULL, NULL)
      `).run(newJobId, sourceJd.jd_text, sourceJd.content_hash, actor, timestamp);
      copiedJdId = Number(jdInfo.lastInsertRowid);
    }

    let copiedProfileId = null;
    if (sourceJd && copiedJdId) {
      const sourceProfile = database.prepare(`
        SELECT * FROM job_profile_version
        WHERE job_id = ? AND jd_version_id = ?
        ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, version DESC, id DESC
        LIMIT 1
      `).get(sourceJobId, sourceJd.id) || null;
      if (sourceProfile) {
        const profileInfo = database.prepare(`
          INSERT INTO job_profile_version (
            job_id, jd_version_id, version, status, config_json, content_hash,
            source_kind, source_ref_json, created_by, created_at,
            confirmed_by, confirmed_at, superseded_at
          ) VALUES (?, ?, 1, 'draft', ?, ?, 'manual', ?, ?, ?, NULL, NULL, NULL)
        `).run(
          newJobId,
          copiedJdId,
          sourceProfile.config_json,
          sourceProfile.content_hash,
          JSON.stringify({ copied_from_job_id: sourceJobId, copied_from_profile_version_id: sourceProfile.id }),
          actor,
          timestamp,
        );
        copiedProfileId = Number(profileInfo.lastInsertRowid);
      }
    }

    writeAuditLog({
      action: '复制岗位',
      target: String(newJobId),
      who: actor,
      auto: 0,
      result: '成功',
      detail_json: JSON.stringify({
        copied_from_job_id: sourceJobId,
        copied_jd_version_id: copiedJdId,
        copied_profile_version_id: copiedProfileId,
        candidates_copied: 0,
        interviews_copied: 0,
        history_copied: 0,
        create_idempotency: jobCreateIdempotencyDetail(requestId, materialHash, operation),
      }),
      created_at: timestamp,
    });
    return getJobLedger(newJobId);
  });
  return requestId ? copy.immediate() : copy();
}

function updateJobStatus(input = {}) {
  const database = conn();
  const actor = requiredLocalActor(input.actor);
  const jobId = Number(input.jobId === undefined ? input.job_id : input.jobId);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw jobOperationError('JOB_ID_INVALID', '岗位 ID 无效。');
  const status = normalizedJobStatus(input.status);
  return database.transaction(() => {
    const current = database.prepare(`
      SELECT id, status, is_fixture, close_reason_code, close_note, closed_at, closed_by
      FROM job
      WHERE id = ?
    `).get(jobId);
    if (!current) throw jobOperationError('JOB_NOT_FOUND', '岗位不存在。', 404);
    assertJobLedgerMutationAllowed(current);
    if (current.status === status) return { job: getJobLedger(jobId), no_op: true };
    if (!(JOB_STATUS_TRANSITIONS[current.status] || []).includes(status)) {
      throw jobOperationError('JOB_STATUS_TRANSITION_INVALID', `不能把岗位从 ${current.status} 直接改为 ${status}。`, 409);
    }
    const closeReason = status === 'closed'
      ? String(input.closeReason || input.close_reason_code || '').trim()
      : null;
    const closeNote = status === 'closed'
      ? String(input.closeNote || input.close_note || '').trim()
      : null;
    const allowedCloseReasons = new Set(['filled', 'cancelled', 'changed', 'long_pause', 'other']);
    if (status === 'closed' && !allowedCloseReasons.has(closeReason)) {
      throw jobOperationError('JOB_CLOSE_REASON_REQUIRED', '关闭岗位前请选择关闭原因。', 400);
    }
    if (closeNote && closeNote.length > 500) {
      throw jobOperationError('JOB_CLOSE_NOTE_TOO_LONG', '岗位关闭备注不能超过 500 个字符。', 400);
    }
    const timestamp = nowIso();
    database.prepare(`
      UPDATE job
      SET status = ?,
          close_reason_code = ?,
          close_note = ?,
          closed_at = ?,
          closed_by = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      status,
      status === 'closed' ? closeReason : null,
      status === 'closed' ? closeNote || null : null,
      status === 'closed' ? timestamp : null,
      status === 'closed' ? actor : null,
      timestamp,
      jobId,
    );
    writeAuditLog({
      action: '切换岗位状态',
      target: String(jobId),
      who: actor,
      auto: 0,
      result: '成功',
      detail_json: JSON.stringify({
        from_status: current.status,
        to_status: status,
        close_reason_code: status === 'closed' ? closeReason : null,
        close_note_present: status === 'closed' && !!closeNote,
        child_records_changed: 0,
      }),
      created_at: timestamp,
    });
    return { job: getJobLedger(jobId), no_op: false };
  })();
}

const NEXT_ACTION_TYPES = new Set([
  'contact', 'resume', 'assessment', 'interview', 'feedback', 'offer', 'onboarding', 'other',
]);
const MANAGER_FEEDBACK_CONTEXTS = new Set(['job_profile', 'interview', 'final_review']);
const MANAGER_FEEDBACK_CONCLUSIONS = new Set(['agree', 'need_more', 'disagree']);
const OFFER_STATUSES = new Set([
  'ready_to_offer', 'offer_sent', 'negotiating', 'accepted',
  'declined', 'company_withdrawn', 'onboarding_handoff',
]);
const OFFER_TRANSITIONS = Object.freeze({
  ready_to_offer: ['offer_sent', 'company_withdrawn'],
  offer_sent: ['negotiating', 'accepted', 'declined', 'company_withdrawn'],
  negotiating: ['negotiating', 'accepted', 'declined', 'company_withdrawn'],
  accepted: ['onboarding_handoff'],
  declined: [],
  company_withdrawn: [],
  onboarding_handoff: [],
});

function requiredJourneyRequestId(value) {
  const requestId = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) {
    throw jobOperationError('REQUEST_ID_INVALID', 'requestId 格式无效。', 400);
  }
  return requestId;
}

function optionalJourneyText(value, field, maxLength = 500) {
  const normalized = String(value || '').trim();
  if (normalized.length > maxLength) {
    throw jobOperationError('JOURNEY_TEXT_TOO_LONG', `${field}不能超过 ${maxLength} 个字符。`, 400);
  }
  return normalized || null;
}

function requiredJourneyText(value, field, maxLength = 500) {
  const normalized = optionalJourneyText(value, field, maxLength);
  if (!normalized) throw jobOperationError('JOURNEY_FIELD_REQUIRED', `${field}不能为空。`, 400);
  return normalized;
}

function normalizedJourneyDate(value, field, required = true) {
  const normalized = String(value || '').trim();
  if (!normalized && !required) return null;
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const parsed = match ? new Date(`${normalized}T00:00:00.000Z`) : null;
  if (
    !match
    || !parsed
    || Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() + 1 !== Number(match[2])
    || parsed.getUTCDate() !== Number(match[3])
  ) {
    throw jobOperationError('JOURNEY_DATE_INVALID', `${field}必须是有效日期。`, 400);
  }
  return normalized;
}

function requireJourneyCandidate(database, candidateId, jobId, { writable = false } = {}) {
  const normalizedCandidateId = String(candidateId || '').trim();
  const normalizedJobId = Number(jobId);
  if (!normalizedCandidateId || !Number.isSafeInteger(normalizedJobId) || normalizedJobId <= 0) {
    throw jobOperationError('CANDIDATE_JOB_INVALID', '候选人或岗位上下文无效。', 400);
  }
  const candidate = database.prepare(`
    SELECT candidate.internal_id, candidate.job_id, candidate.name,
           job.status AS job_status, job.is_fixture
    FROM candidate
    JOIN job ON job.id = candidate.job_id
    WHERE candidate.internal_id = ? AND candidate.job_id = ?
  `).get(normalizedCandidateId, normalizedJobId);
  if (!candidate) throw jobOperationError('CANDIDATE_JOB_MISMATCH', '候选人与岗位不匹配。', 404);
  if (writable) {
    if (Number(candidate.is_fixture) === 1) {
      throw jobOperationError('JOB_FIXTURE_READ_ONLY', '测试岗位不允许修改。', 403);
    }
    if (candidate.job_status === 'closed') {
      throw jobOperationError('JOB_CLOSED', '岗位已关闭，请重新开启后再记录招聘动作。', 409);
    }
  }
  return candidate;
}

function currentOfferContext(database, candidateId, jobId) {
  if (!tableExists(database, 'final_disposition')) return null;
  return database.prepare(`
    SELECT application.id AS application_id, disposition.action, disposition.created_at
    FROM application_episode application
    JOIN final_disposition disposition ON disposition.id = (
      SELECT current_disposition.id
      FROM final_disposition current_disposition
      WHERE current_disposition.application_id = application.id
      ORDER BY current_disposition.id DESC
      LIMIT 1
    )
    WHERE application.candidate_id = ? AND application.job_id = ?
      AND application.status = 'active'
      AND application.disposition_action = 'continue_process'
      AND disposition.action = 'continue_process'
    ORDER BY application.episode_no DESC, application.id DESC
    LIMIT 1
  `).get(candidateId, jobId) || null;
}

function currentJourneyApplication(database, candidateId, jobId) {
  if (!tableExists(database, 'application_episode')) return null;
  return database.prepare(`
    SELECT id AS application_id, episode_no, status, disposition_action, version,
           opened_at, updated_at
    FROM application_episode
    WHERE candidate_id = ? AND job_id = ? AND status = 'active'
    ORDER BY episode_no DESC, id DESC
    LIMIT 1
  `).get(candidateId, jobId) || null;
}

function journeyRequestRow(database, requestId) {
  return database.prepare(`
    SELECT * FROM hr_journey_request WHERE request_id = ?
  `).get(requestId) || null;
}

function replayJourneyRequest(database, {
  existing,
  requestId,
  operationType,
  candidateId,
  jobId,
  applicationId = null,
  requestHash,
}) {
  const replay = existing || journeyRequestRow(database, requestId);
  if (!replay) return null;
  if (
    replay.operation_type !== operationType
    || replay.candidate_id !== candidateId
    || Number(replay.job_id) !== Number(jobId)
    || Number(replay.application_id || 0) !== Number(applicationId || 0)
    || replay.request_hash !== requestHash
  ) {
    throw jobOperationError(
      'JOURNEY_REQUEST_ID_CONFLICT',
      '该 requestId 已用于不同的候选人、岗位或操作内容。',
      409,
    );
  }
  let result;
  try {
    result = JSON.parse(replay.result_json);
  } catch {
    throw jobOperationError(
      'JOURNEY_REQUEST_REPLAY_INVALID',
      '该幂等请求的历史结果不可读取，请刷新后重试。',
      409,
    );
  }
  return { ...result, idempotent_replay: true };
}

function recordJourneyRequest(database, {
  requestId,
  operationType,
  candidateId,
  jobId,
  applicationId = null,
  requestHash,
  result,
  actor,
  timestamp,
}) {
  database.prepare(`
    INSERT INTO hr_journey_request (
      request_id, operation_type, candidate_id, job_id, application_id,
      request_hash, result_json, actor_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    requestId,
    operationType,
    candidateId,
    jobId,
    applicationId,
    requestHash,
    JSON.stringify(result),
    actor,
    timestamp,
  );
}

function getCandidateJourneyOperations(input = {}) {
  const database = conn();
  const candidate = requireJourneyCandidate(
    database,
    input.candidateId || input.candidate_id,
    input.jobId || input.job_id,
  );
  if (!tableExists(database, 'candidate_next_action')) {
    return {
      candidate_id: candidate.internal_id,
      job_id: candidate.job_id,
      next_action: null,
      manager_feedback: [],
      offer: null,
      offer_history: [],
      application_context: null,
      offer_context: null,
      offer_eligible: false,
    };
  }
  const storedNextAction = database.prepare(`
    SELECT * FROM candidate_next_action WHERE candidate_id = ? AND job_id = ?
  `).get(candidate.internal_id, candidate.job_id) || null;
  const applicationContext = currentJourneyApplication(
    database,
    candidate.internal_id,
    candidate.job_id,
  );
  const nextAction = !tableExists(database, 'application_episode')
    ? storedNextAction
    : (
      storedNextAction
      && applicationContext
      && Number(storedNextAction.application_id) === Number(applicationContext.application_id)
        ? storedNextAction
        : null
    );
  const managerFeedback = database.prepare(`
    SELECT * FROM hiring_manager_feedback
    WHERE candidate_id = ? AND job_id = ?
    ORDER BY feedback_at DESC, id DESC
    LIMIT 20
  `).all(candidate.internal_id, candidate.job_id);
  const offerContext = currentOfferContext(database, candidate.internal_id, candidate.job_id);
  const offer = offerContext ? database.prepare(`
    SELECT * FROM candidate_offer_status
    WHERE application_id = ? AND candidate_id = ? AND job_id = ?
  `).get(offerContext.application_id, candidate.internal_id, candidate.job_id) || null : null;
  const offerHistory = tableExists(database, 'candidate_offer_event') ? database.prepare(`
    SELECT event.*
    FROM candidate_offer_event event
    WHERE event.candidate_id = ? AND event.job_id = ?
    ORDER BY event.occurred_at DESC, event.id DESC
    LIMIT 100
  `).all(candidate.internal_id, candidate.job_id) : [];
  return {
    candidate_id: candidate.internal_id,
    job_id: candidate.job_id,
    next_action: nextAction,
    manager_feedback: managerFeedback,
    offer,
    offer_history: offerHistory,
    application_context: applicationContext,
    offer_context: offerContext,
    offer_eligible: !!offerContext,
  };
}

function setCandidateNextAction(input = {}) {
  const database = conn();
  const actor = requiredLocalActor(input.actor);
  const candidate = requireJourneyCandidate(
    database,
    input.candidateId || input.candidate_id,
    input.jobId || input.job_id,
    { writable: true },
  );
  const requestId = requiredJourneyRequestId(input.requestId || input.request_id);
  const actionType = String(input.actionType || input.action_type || '').trim();
  const state = String(input.state || 'pending').trim();
  if (!NEXT_ACTION_TYPES.has(actionType)) {
    throw jobOperationError('NEXT_ACTION_TYPE_INVALID', '请选择有效的下一步类型。', 400);
  }
  if (!['pending', 'completed', 'cancelled'].includes(state)) {
    throw jobOperationError('NEXT_ACTION_STATE_INVALID', '下一步状态无效。', 400);
  }
  const dueDate = normalizedJourneyDate(input.dueDate || input.due_date, '下一步日期');
  const note = optionalJourneyText(input.note, '下一步备注');
  const operationType = 'set_candidate_next_action';
  return database.transaction(() => {
    const existingRequest = journeyRequestRow(database, requestId);
    const applicationContext = currentJourneyApplication(
      database,
      candidate.internal_id,
      candidate.job_id,
    );
    const requestApplicationId = applicationContext
      ? Number(applicationContext.application_id)
      : Number((existingRequest && existingRequest.application_id) || 0) || null;
    const requestHash = journeyRequestHash(operationType, {
      candidate_id: candidate.internal_id,
      job_id: Number(candidate.job_id),
      application_id: requestApplicationId,
      action_type: actionType,
      due_date: dueDate,
      note,
      state,
    });
    const replay = replayJourneyRequest(database, {
      existing: existingRequest,
      requestId,
      operationType,
      candidateId: candidate.internal_id,
      jobId: candidate.job_id,
      applicationId: requestApplicationId,
      requestHash,
    });
    if (replay) return replay;
    if (f018RuntimeEnabled && !applicationContext) {
      throw jobOperationError(
        'NEXT_ACTION_ACTIVE_APPLICATION_REQUIRED',
        '当前没有进行中的招聘轮次，不能新增或更新候选人下一步。',
        409,
      );
    }
    const applicationId = applicationContext
      ? Number(applicationContext.application_id)
      : null;
    const timestamp = nowIso();
    database.prepare(`
      INSERT INTO candidate_next_action (
        candidate_id, job_id, application_id, action_type, due_date, note, state, version,
        actor_id, request_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(candidate_id, job_id) DO UPDATE SET
        application_id = excluded.application_id,
        action_type = excluded.action_type,
        due_date = excluded.due_date,
        note = excluded.note,
        state = excluded.state,
        version = candidate_next_action.version + 1,
        actor_id = excluded.actor_id,
        request_id = excluded.request_id,
        updated_at = excluded.updated_at
    `).run(
      candidate.internal_id,
      candidate.job_id,
      applicationId,
      actionType,
      dueDate,
      note,
      state,
      actor,
      requestId,
      timestamp,
      timestamp,
    );
    const row = database.prepare(`
      SELECT * FROM candidate_next_action WHERE candidate_id = ? AND job_id = ?
    `).get(candidate.internal_id, candidate.job_id);
    recordJourneyRequest(database, {
      requestId,
      operationType,
      candidateId: candidate.internal_id,
      jobId: candidate.job_id,
      applicationId,
      requestHash,
      result: { next_action: row },
      actor,
      timestamp,
    });
    writeAuditLog({
      action: '记录候选人下一步',
      target: candidate.internal_id,
      who: actor,
      auto: 0,
      result: '成功',
      detail_json: JSON.stringify({
        job_id: candidate.job_id,
        application_id: applicationId,
        action_type: actionType,
        due_date: dueDate,
        state,
        version: row.version,
      }),
      created_at: timestamp,
    });
    return { next_action: row, idempotent_replay: false };
  }).immediate();
}

function recordHiringManagerFeedback(input = {}) {
  const database = conn();
  const actor = requiredLocalActor(input.actor);
  const candidate = requireJourneyCandidate(
    database,
    input.candidateId || input.candidate_id,
    input.jobId || input.job_id,
    { writable: true },
  );
  const requestId = requiredJourneyRequestId(input.requestId || input.request_id);
  const contextType = String(input.contextType || input.context_type || '').trim();
  const conclusion = String(input.conclusion || '').trim();
  if (!MANAGER_FEEDBACK_CONTEXTS.has(contextType)) {
    throw jobOperationError('MANAGER_FEEDBACK_CONTEXT_INVALID', '请选择反馈对应环节。', 400);
  }
  if (!MANAGER_FEEDBACK_CONCLUSIONS.has(conclusion)) {
    throw jobOperationError('MANAGER_FEEDBACK_CONCLUSION_INVALID', '请选择反馈结论。', 400);
  }
  const feedbackPerson = requiredJourneyText(input.feedbackPerson || input.feedback_person, '反馈人', 80);
  const feedbackRole = optionalJourneyText(input.feedbackRole || input.feedback_role, '反馈人角色', 80);
  const feedbackAt = String(input.feedbackAt || input.feedback_at || nowIso()).trim();
  if (!Number.isFinite(Date.parse(feedbackAt))) {
    throw jobOperationError('MANAGER_FEEDBACK_TIME_INVALID', '反馈时间无效。', 400);
  }
  const summary = requiredJourneyText(input.summary, '反馈摘要', 1000);
  const operationType = 'record_hiring_manager_feedback';
  const requestHash = journeyRequestHash(operationType, {
    candidate_id: candidate.internal_id,
    job_id: Number(candidate.job_id),
    context_type: contextType,
    feedback_person: feedbackPerson,
    feedback_role: feedbackRole,
    feedback_at: feedbackAt,
    summary,
    conclusion,
  });
  return database.transaction(() => {
    const replay = replayJourneyRequest(database, {
      requestId,
      operationType,
      candidateId: candidate.internal_id,
      jobId: candidate.job_id,
      requestHash,
    });
    if (replay) return replay;
    const timestamp = nowIso();
    const info = database.prepare(`
      INSERT INTO hiring_manager_feedback (
        candidate_id, job_id, context_type, feedback_person, feedback_role,
        feedback_at, summary, conclusion, actor_id, request_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.internal_id,
      candidate.job_id,
      contextType,
      feedbackPerson,
      feedbackRole,
      feedbackAt,
      summary,
      conclusion,
      actor,
      requestId,
      timestamp,
    );
    const row = database.prepare('SELECT * FROM hiring_manager_feedback WHERE id = ?').get(Number(info.lastInsertRowid));
    recordJourneyRequest(database, {
      requestId,
      operationType,
      candidateId: candidate.internal_id,
      jobId: candidate.job_id,
      requestHash,
      result: { feedback: row },
      actor,
      timestamp,
    });
    writeAuditLog({
      action: '记录用人负责人反馈',
      target: candidate.internal_id,
      who: actor,
      auto: 0,
      result: '成功',
      detail_json: JSON.stringify({
        job_id: candidate.job_id,
        context_type: contextType,
        conclusion,
        feedback_person: feedbackPerson,
      }),
      created_at: timestamp,
    });
    return { feedback: row, idempotent_replay: false };
  }).immediate();
}

function setCandidateOfferStatus(input = {}) {
  const database = conn();
  const actor = requiredLocalActor(input.actor);
  const candidate = requireJourneyCandidate(
    database,
    input.candidateId || input.candidate_id,
    input.jobId || input.job_id,
    { writable: true },
  );
  const requestId = requiredJourneyRequestId(input.requestId || input.request_id);
  const status = String(input.status || '').trim();
  if (!OFFER_STATUSES.has(status)) {
    throw jobOperationError('OFFER_STATUS_INVALID', 'Offer 跟进状态无效。', 400);
  }
  const expectedStartDate = normalizedJourneyDate(
    input.expectedStartDate || input.expected_start_date,
    '预计入职日期',
    false,
  );
  const reasonCode = optionalJourneyText(input.reasonCode || input.reason_code, '原因代码', 80);
  const note = optionalJourneyText(input.note, 'Offer 跟进备注', 1000);
  if (['declined', 'company_withdrawn'].includes(status) && !note) {
    throw jobOperationError(
      'OFFER_REASON_DETAIL_REQUIRED',
      '候选人拒绝或公司撤回时请填写实际原因，通用原因代码不能代替说明。',
      400,
    );
  }
  const operationType = 'set_candidate_offer_status';
  return database.transaction(() => {
    const existingRequest = journeyRequestRow(database, requestId);
    const offerContext = currentOfferContext(database, candidate.internal_id, candidate.job_id);
    const requestApplicationId = offerContext
      ? Number(offerContext.application_id)
      : Number((existingRequest && existingRequest.application_id) || 0) || null;
    const requestHash = journeyRequestHash(operationType, {
      candidate_id: candidate.internal_id,
      job_id: Number(candidate.job_id),
      application_id: requestApplicationId,
      status,
      expected_start_date: expectedStartDate,
      reason_code: reasonCode,
      note,
    });
    const replay = replayJourneyRequest(database, {
      existing: existingRequest,
      requestId,
      operationType,
      candidateId: candidate.internal_id,
      jobId: candidate.job_id,
      applicationId: requestApplicationId,
      requestHash,
    });
    if (replay) return replay;
    if (!offerContext) {
      throw jobOperationError(
        'OFFER_FINAL_REVIEW_REQUIRED',
        '当前招聘轮次必须处于进行中，并已由 HR 在终评确认“继续流程”，才能更新 Offer。',
        409,
      );
    }
    const applicationId = Number(offerContext.application_id);
    const current = database.prepare(`
      SELECT * FROM candidate_offer_status
      WHERE application_id = ? AND candidate_id = ? AND job_id = ?
    `).get(applicationId, candidate.internal_id, candidate.job_id);
    if (!current && status !== 'ready_to_offer') {
      throw jobOperationError('OFFER_INITIAL_STATUS_INVALID', '请先由 HR 将候选人标记为“准备发 Offer”。', 409);
    }
    if (current && !(OFFER_TRANSITIONS[current.status] || []).includes(status)) {
      throw jobOperationError(
        'OFFER_STATUS_TRANSITION_INVALID',
        `不能把 Offer 从 ${current.status} 直接改为 ${status}。`,
        409,
      );
    }
    const resolvedExpectedStartDate = expectedStartDate
      || (current && current.expected_start_date)
      || null;
    if (status === 'accepted' && !resolvedExpectedStartDate) {
      throw jobOperationError('OFFER_EXPECTED_START_REQUIRED', '候选人接受 Offer 时请填写预计入职日期。', 400);
    }
    const timestamp = nowIso();
    if (current) {
      const updated = database.prepare(`
        UPDATE candidate_offer_status
        SET status = ?, expected_start_date = ?, reason_code = ?, note = ?,
            version = version + 1, actor_id = ?, request_id = ?, updated_at = ?
        WHERE id = ? AND application_id = ? AND version = ?
      `).run(
        status,
        resolvedExpectedStartDate,
        reasonCode,
        note,
        actor,
        requestId,
        timestamp,
        current.id,
        applicationId,
        current.version,
      );
      if (updated.changes !== 1) {
        throw jobOperationError('OFFER_STALE_VERSION', 'Offer 状态已变化，请刷新后重试。', 409);
      }
    } else {
      database.prepare(`
        INSERT INTO candidate_offer_status (
          candidate_id, job_id, application_id, status, expected_start_date,
          reason_code, note, version, actor_id, request_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        candidate.internal_id,
        candidate.job_id,
        applicationId,
        status,
        resolvedExpectedStartDate,
        reasonCode,
        note,
        actor,
        requestId,
        timestamp,
        timestamp,
      );
    }
    const row = database.prepare(`
      SELECT * FROM candidate_offer_status WHERE application_id = ?
    `).get(applicationId);
    database.prepare(`
      INSERT INTO candidate_offer_event (
        offer_id, candidate_id, job_id, application_id, from_status, to_status,
        expected_start_date, reason_code, note, offer_version, actor_id,
        request_id, request_hash, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      candidate.internal_id,
      candidate.job_id,
      applicationId,
      current ? current.status : null,
      status,
      row.expected_start_date,
      reasonCode,
      note,
      row.version,
      actor,
      requestId,
      requestHash,
      timestamp,
    );
    recordJourneyRequest(database, {
      requestId,
      operationType,
      candidateId: candidate.internal_id,
      jobId: candidate.job_id,
      applicationId,
      requestHash,
      result: { offer: row },
      actor,
      timestamp,
    });
    writeAuditLog({
      action: '更新 Offer 跟进状态',
      target: candidate.internal_id,
      who: actor,
      auto: 0,
      result: '成功',
      detail_json: JSON.stringify({
        job_id: candidate.job_id,
        application_id: applicationId,
        from_status: current ? current.status : null,
        to_status: status,
        version: row.version,
        request_id: requestId,
      }),
      created_at: timestamp,
    });
    return { offer: row, idempotent_replay: false };
  }).immediate();
}

function getJobForFetch(jobId) {
  return conn().prepare(`
    SELECT id, encrypt_job_id, numeric_job_id, name, hr_owner, department, location,
           planned_hires, status, is_fixture, source_type
    FROM job
    WHERE id = ?
  `).get(jobId);
}

function workflowContextForCandidate(database, candidateId) {
  const sessions = database.prepare(`
    SELECT id, round, mode, status, scheduled_at, created_at, updated_at
    FROM interview_session
    WHERE candidate_id = ?
    ORDER BY round DESC, id DESC
  `).all(candidateId);
  const currentSession = sessions.find((session) => session.status !== 'cancelled') || null;
  const report = currentSession ? database.prepare(`
    SELECT report.id, report.session_id, report.status, report.version,
           report.confirmed_at, report.updated_at,
           SUM(CASE WHEN fact.status = 'pending_review' THEN 1 ELSE 0 END) AS pending_fact_count
    FROM interview_report_v1 report
    LEFT JOIN interview_report_fact_review fact ON fact.report_id = report.id
    WHERE report.session_id = ?
    GROUP BY report.id
    LIMIT 1
  `).get(currentSession.id) || null : null;
  return { sessions, report };
}

function projectCandidateWorkflow(database, candidate) {
  const context = workflowContextForCandidate(database, candidate.internal_id);
  const projection = workflow.deriveWorkflowStatus({ candidate, ...context });
  return {
    ...candidate,
    communication_code: projection.communication_code,
    disposition_code: projection.disposition_code,
    workflow_status: projection.status,
    workflow_source: projection.source,
    report_status: context.report ? context.report.status : null,
    pending_fact_count: context.report ? Number(context.report.pending_fact_count || 0) : 0,
  };
}

function listCandidates(jobId) {
  const database = conn();
  const rows = database.prepare(`
    SELECT c.internal_id, c.job_id, c.source, c.name, c.rec_position, c.geek_desc, c.sabc, c.verdict_label,
           c.degree, c.school, c.school_tier, r.sections_json,
           c.comm_status, c.disposition_status, c.communication_code, c.disposition_code,
           c.workflow_version, c.created_at, c.updated_at,
           j.name AS job_name,
           CASE WHEN j.is_fixture = 1 OR c.source = 'fixture' THEN 'fixture' ELSE 'formal' END AS data_class
    FROM candidate c
    JOIN job j ON j.id = c.job_id
    LEFT JOIN resume_online r ON r.candidate_id = c.internal_id
    WHERE c.job_id = ?
    ORDER BY CASE UPPER(COALESCE(c.sabc, ''))
      WHEN 'S' THEN 0
      WHEN 'A' THEN 1
      WHEN 'B' THEN 2
      WHEN 'C' THEN 3
      WHEN 'D' THEN 4
      ELSE 5
    END ASC, c.created_at DESC, c.internal_id DESC
  `).all(jobId);
  const applicationByCandidate = new Map();
  // Application episodes are part of the core HR-action projection. The F018
  // flag controls the optional final-review product, not whether an already
  // migrated application can keep hold/reentry state visible to HR.
  const applicationEpisodeAvailable = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'application_episode'",
  ).get();
  if (applicationEpisodeAvailable) {
    database.prepare(`
      SELECT application.candidate_id, application.status AS application_status,
             application.disposition_action AS application_disposition_action,
             application.episode_no AS application_episode_no
      FROM application_episode application
      WHERE application.job_id = ?
        AND application.episode_no = (
          SELECT MAX(latest.episode_no)
          FROM application_episode latest
          WHERE latest.candidate_id = application.candidate_id
            AND latest.job_id = application.job_id
        )
    `).all(jobId).forEach((application) => applicationByCandidate.set(application.candidate_id, application));
  }
  const rowsWithApplication = rows.map((row) => ({
    ...row,
    application_status: applicationByCandidate.get(row.internal_id)?.application_status
      || (row.disposition_code === 'under_review' && row.disposition_status === '暂缓' ? 'active' : null),
    application_disposition_action: applicationByCandidate.get(row.internal_id)?.application_disposition_action
      || (row.disposition_code === 'under_review' && row.disposition_status === '暂缓' ? 'hold' : null),
    application_episode_no: applicationByCandidate.has(row.internal_id)
      ? Number(applicationByCandidate.get(row.internal_id).application_episode_no)
      : null,
  }));
  const job = requireJob(database, jobId);
  return attachAssessmentFitSignals(database, rowsWithApplication, jobId)
    .filter((row) => Number(job.is_fixture) === 1 ? row.data_class === 'fixture' : row.data_class === 'formal')
    .sort(compareCandidateDefaultPriority)
    .map((row) => projectCandidateWorkflow(database, row));
}

function getCandidate(internalId) {
  const database = conn();
  const row = database.prepare(`
    SELECT
      c.internal_id, c.job_id, c.source, c.rec_position, c.keys_complete,
      c.name, c.age, c.degree, c.degree_verified, c.school, c.school_tier, c.work_years, c.salary,
      c.geek_desc, c.sabc, c.sabc_source, c.sabc_reason, c.match_point, c.risk_point,
      c.verdict_label, c.expert_comment, c.hard_bar_pass,
      c.comm_status, c.disposition_status, c.communication_code, c.disposition_code,
      c.workflow_version, c.created_at, c.updated_at,
      CASE WHEN j.is_fixture = 1 OR c.source = 'fixture' THEN 'fixture' ELSE 'formal' END AS data_class
    FROM candidate c
    JOIN job j ON j.id = c.job_id
    WHERE c.internal_id = ?
  `).get(internalId);
  if (!row) return null;
  const applicationTableAvailable = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'application_episode'",
  ).get();
  const application = applicationTableAvailable ? database.prepare(`
    SELECT status, disposition_action, episode_no
    FROM application_episode
    WHERE candidate_id = ? AND job_id = ?
    ORDER BY episode_no DESC, id DESC LIMIT 1
  `).get(row.internal_id, row.job_id) : null;
  const fallbackHold = row.disposition_code === 'under_review' && row.disposition_status === '暂缓';
  return projectCandidateWorkflow(database, {
    ...row,
    application_status: application?.status || (fallbackHold ? 'active' : null),
    application_disposition_action: application?.disposition_action || (fallbackHold ? 'hold' : null),
    application_episode_no: application ? Number(application.episode_no) : null,
  });
}

function getCandidateKeys(internalId) {
  return conn().prepare(`
    SELECT
      internal_id, keys_complete, boss_id, geek_id, security_id,
      encrypt_job_id, expect_id, lid, rec_position
    FROM candidate
    WHERE internal_id = ?
  `).get(internalId);
}

function getCandidateChildren(internalId) {
  const database = conn();
  const aiReviews = database.prepare(
    'SELECT id, profile_confirmed, report_json, created_at FROM ai_review WHERE candidate_id = ? ORDER BY id DESC',
  ).all(internalId).filter((row) => {
    const report = parseJson(row.report_json);
    return !report || report.schema_version !== 'assessment_ai_analysis_record_v1';
  });
  return {
    resume_online: database.prepare('SELECT id, sections_json, is_paywalled, fetched_at FROM resume_online WHERE candidate_id = ? ORDER BY id').all(internalId),
    resume_attachment: database.prepare('SELECT id, resume_id, file_name, file_type, local_path, download_status, is_paywalled, has_contact, created_at, downloaded_at FROM resume_attachment WHERE candidate_id = ? ORDER BY id').all(internalId),
    contact: database.prepare('SELECT id, type, source, confidence, created_at FROM contact WHERE candidate_id = ? ORDER BY id').all(internalId),
    comment: database.prepare('SELECT id, body, purpose_tag, is_persona_signal, polarity, author, created_at FROM comment WHERE candidate_id = ? ORDER BY id').all(internalId),
    status_history: database.prepare('SELECT id, layer, from_status, to_status, from_code, to_code, source, who, reason, created_at FROM status_history WHERE candidate_id = ? ORDER BY id').all(internalId),
    ai_review: aiReviews,
  };
}

function stableContentHash(value) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function auditSafeSourceUrl(value) {
  const sourceUrl = (text(value) || '').trim();
  if (!sourceUrl) {
    return {
      source_url_present: false,
      source_origin: null,
      source_url_sha256: null,
    };
  }
  let sourceOrigin = null;
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') sourceOrigin = parsed.origin;
  } catch {
    // The business record keeps the operator-provided value; audit logs stay metadata-only.
  }
  return {
    source_url_present: true,
    source_origin: sourceOrigin,
    source_url_sha256: stableContentHash(sourceUrl),
  };
}

function requiredLocalActor(value) {
  const actor = String(value || '').trim();
  if (!actor) throw new Error('actor is required');
  return actor;
}

function requireJob(database, jobId) {
  const id = Number(jobId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('jobId must be a positive integer');
  const job = database.prepare('SELECT id, name, status, is_fixture, source_type FROM job WHERE id = ?').get(id);
  if (!job) throw new Error(`job not found: ${id}`);
  return job;
}

function assertJobRecruitingWritable(database, jobId) {
  const job = requireJob(database, jobId);
  if (job.status === 'closed') {
    throw jobOperationError('JOB_CLOSED', `岗位“${job.name || job.id}”已关闭，请重新开启后再执行招聘动作。`, 409);
  }
  return job;
}

function assertCandidateJobRecruitingWritable(candidateId) {
  const database = conn();
  const candidate = database.prepare('SELECT internal_id, job_id FROM candidate WHERE internal_id = ?').get(String(candidateId || '').trim());
  if (!candidate) throw jobOperationError('CANDIDATE_NOT_FOUND', `candidate not found: ${candidateId}`, 404);
  return assertJobRecruitingWritable(database, candidate.job_id);
}

function assertJobRecruitingWritableById(jobId) {
  return assertJobRecruitingWritable(conn(), jobId);
}

function storedJobProfileConfig(database, jobId) {
  const row = database.prepare('SELECT config_json FROM job_profile WHERE job_id = ?').get(Number(jobId));
  if (!row || !row.config_json) return defaultProfile();
  return parseJson(row.config_json) || defaultProfile();
}

function profileConfigWithoutClientDeep(config) {
  const sanitized = { ...(config || {}) };
  delete sanitized.deep_profile;
  return sanitized;
}

function writeStoredJobProfileConfig(database, jobId, config, timestamp = nowIso()) {
  return database.prepare(`
    INSERT INTO job_profile (job_id, config_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
  `).run(Number(jobId), JSON.stringify(config || defaultProfile()), timestamp);
}

function archiveDeepProfileForVersion(database, profileVersion, reason, timestamp = nowIso()) {
  if (!profileVersion) return null;
  const projection = storedJobProfileConfig(database, profileVersion.job_id);
  if (!projection.deep_profile || typeof projection.deep_profile !== 'object') return null;
  const projectedProfileId = Number(projection.deep_profile.bound_profile_version_id) || null;
  const projectedJdId = Number(projection.deep_profile.bound_jd_version_id) || null;
  // An already archived deep profile can remain in the compatibility
  // projection for traceability. Never copy it into a later profile version:
  // only an unbound legacy deep, or one bound to the exact profile/JD being
  // archived, belongs in that historical version.
  if ((projectedProfileId && projectedProfileId !== Number(profileVersion.id))
      || (projectedJdId && projectedJdId !== Number(profileVersion.jd_version_id))) {
    return null;
  }
  const archived = {
    ...projection.deep_profile,
    bound_profile_version_id: projectedProfileId || Number(profileVersion.id),
    bound_jd_version_id: projectedJdId || Number(profileVersion.jd_version_id),
    stale_for_active_jd: true,
    stale_reason: String(reason || 'profile_superseded'),
    stale_at: timestamp,
  };
  const historicalConfig = {
    ...profileConfigWithoutClientDeep(parseJson(profileVersion.config_json) || {}),
    deep_profile: archived,
  };
  database.prepare(`
    UPDATE job_profile_version
    SET config_json = ?, content_hash = ?
    WHERE id = ?
  `).run(JSON.stringify(historicalConfig), stableContentHash(historicalConfig), profileVersion.id);
  writeStoredJobProfileConfig(database, profileVersion.job_id, {
    ...profileConfigWithoutClientDeep(projection),
    deep_profile: archived,
  }, timestamp);
  return archived;
}

function currentJobProfileContext(database, jobId) {
  const job = requireJob(database, jobId);
  const activeJd = database.prepare(`
    SELECT id, job_id, version, status, source, jd_text, content_hash,
           created_by, created_at, activated_by, activated_at, superseded_at
    FROM job_jd_version
    WHERE job_id = ? AND status = 'active'
    ORDER BY version DESC, id DESC LIMIT 1
  `).get(job.id) || null;
  const profileVersion = activeJd ? database.prepare(`
    SELECT id, job_id, jd_version_id, version, status, config_json, content_hash,
           source_kind, source_ref_json, created_by, created_at,
           confirmed_by, confirmed_at, superseded_at
    FROM job_profile_version
    WHERE job_id = ? AND jd_version_id = ? AND status = 'confirmed'
    ORDER BY version DESC, id DESC LIMIT 1
  `).get(job.id, activeJd.id) || null : null;

  // Fixture-only journeys are synthetic compatibility checks, not formal
  // recruiting consumers. Keep their old profile behavior when they have no
  // version ledger so legacy tests can stay isolated from production truth.
  if (Number(job.is_fixture) === 1 && (!activeJd || !profileVersion)) {
    return {
      job,
      activeJd,
      profileVersion,
      config: storedJobProfileConfig(database, job.id),
      fixture_legacy: true,
    };
  }
  if (!activeJd) {
    throw jobOperationError(
      'JOB_ACTIVE_JD_REQUIRED',
      `岗位“${job.name || job.id}”还没有已启用 JD，请先启用 JD 再执行正式招聘判断。`,
      409,
    );
  }
  if (!profileVersion) {
    throw jobOperationError(
      'JOB_CURRENT_PROFILE_REQUIRED',
      `岗位“${job.name || job.id}”的当前 JD 还没有已确认画像，请先确认当前画像再执行正式招聘判断。`,
      409,
    );
  }

  const config = profileConfigWithoutClientDeep(parseJson(profileVersion.config_json) || {});
  const projectedDeep = storedJobProfileConfig(database, job.id).deep_profile;
  if (projectedDeep && typeof projectedDeep === 'object' && projectedDeep.stale_for_active_jd !== true) {
    const boundProfileId = Number(projectedDeep.bound_profile_version_id) || null;
    const boundJdId = Number(projectedDeep.bound_jd_version_id) || null;
    // Existing local databases may contain a pre-binding deep profile. It is
    // current only while the same confirmed profile/JD remains active; the
    // next JD/profile transition archives and stamps it before it can be reused.
    if ((!boundProfileId && !boundJdId)
        || (boundProfileId === Number(profileVersion.id) && boundJdId === Number(activeJd.id))) {
      config.deep_profile = projectedDeep;
    }
  }
  return {
    job,
    activeJd,
    profileVersion: {
      ...profileVersion,
      config: parseJson(profileVersion.config_json) || {},
      source_ref: parseJson(profileVersion.source_ref_json) || {},
    },
    config,
    fixture_legacy: false,
  };
}

function getCurrentJobProfileContext(jobId) {
  return currentJobProfileContext(conn(), jobId);
}

function getDeepProfileGenerationReadiness(jobId) {
  const database = conn();
  let profileContext;
  try {
    assertJobRecruitingWritable(database, jobId);
    profileContext = currentJobProfileContext(database, jobId);
  } catch (error) {
    const knownCode = String(error && error.code || '');
    if (knownCode === 'JOB_CLOSED') {
      return {
        ready: false,
        code: knownCode,
        message: error.message,
        next_action: 'reopen_job',
      };
    }
    if (knownCode === 'JOB_ACTIVE_JD_REQUIRED') {
      return {
        ready: false,
        code: knownCode,
        message: '当前岗位还没有已启用 JD。请先到“职位管理”启用 JD，再生成深度画像。',
        next_action: 'open_job_jd',
      };
    }
    if (knownCode === 'JOB_CURRENT_PROFILE_REQUIRED') {
      return {
        ready: false,
        code: knownCode,
        message: '当前 JD 还没有已确认画像。请先到“职位管理”确认简版岗位画像，再生成深度画像。',
        next_action: 'open_job_profile',
      };
    }
    throw error;
  }

  const interviews = listInterviews(jobId);
  if (!interviews.length) {
    return {
      ready: false,
      code: 'JOB_INTERVIEW_REQUIRED',
      message: '还没有访谈材料。请先在本页保存负责人访谈转写，再生成深度画像。',
      next_action: 'add_interview',
    };
  }
  const totalChars = interviews.reduce((sum, row) => sum + row.transcript.length, 0);
  if (totalChars > TRANSCRIPT_CHAR_LIMIT) {
    return {
      ready: false,
      code: 'JOB_INTERVIEW_LIMIT_EXCEEDED',
      message: `访谈转写总量 ${totalChars} 字超过上限 ${TRANSCRIPT_CHAR_LIMIT} 字。请先整理访谈材料再生成。`,
      next_action: 'review_interviews',
    };
  }
  return {
    ready: true,
    code: 'READY',
    message: '已具备生成深度画像所需的 JD、确认画像和访谈材料。',
    next_action: null,
    active_jd_id: profileContext.activeJd ? Number(profileContext.activeJd.id) : null,
    profile_version_id: profileContext.profileVersion ? Number(profileContext.profileVersion.id) : null,
    interview_count: interviews.length,
  };
}

function listJobJdVersions(jobId) {
  const database = conn();
  requireJob(database, jobId);
  return database.prepare(`
    SELECT id, job_id, version, status, source, jd_text, content_hash,
           created_by, created_at, activated_by, activated_at, superseded_at
    FROM job_jd_version WHERE job_id = ? ORDER BY version DESC, id DESC
  `).all(Number(jobId));
}

function createJobJdVersion(input = {}) {
  const database = conn();
  applyF012WorkbenchMigration(database);
  const job = assertJobRecruitingWritable(database, input.jobId === undefined ? input.job_id : input.jobId);
  const actor = requiredLocalActor(input.actor);
  const source = String(input.source || 'manual').trim();
  if (!['manual', 'boss_sync'].includes(source)) throw new Error('unsupported JD source');
  const jdText = String(input.jdText === undefined ? (input.jd_text || '') : input.jdText).trim();
  if (!jdText) throw new Error('jdText is required');
  const timestamp = nowIso();
  return database.transaction(() => {
    const version = Number(database.prepare('SELECT MAX(version) AS version FROM job_jd_version WHERE job_id = ?').get(job.id).version || 0) + 1;
    const info = database.prepare(`
      INSERT INTO job_jd_version (
        job_id, version, status, source, jd_text, content_hash,
        created_by, created_at, activated_by, activated_at, superseded_at
      ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, NULL, NULL, NULL)
    `).run(job.id, version, source, jdText, stableContentHash(jdText), actor, timestamp);
    return database.prepare('SELECT * FROM job_jd_version WHERE id = ?').get(info.lastInsertRowid);
  })();
}

function activateJobJdVersion(input = {}) {
  const database = conn();
  applyF012WorkbenchMigration(database);
  const id = Number(input.id === undefined ? input.jdVersionId : input.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('jdVersionId is required');
  const actor = requiredLocalActor(input.actor);
  return database.transaction(() => {
    const current = database.prepare('SELECT * FROM job_jd_version WHERE id = ?').get(id);
    if (!current) throw new Error(`JD version not found: ${id}`);
    assertJobRecruitingWritable(database, current.job_id);
    if (current.status === 'active') return current;
    if (current.status !== 'draft') throw new Error('only draft JD can be activated');
    if (input.expectedVersion !== undefined && Number(input.expectedVersion) !== Number(current.version)) throw new Error('STALE_VERSION');
    const timestamp = nowIso();
    const previousActiveJd = database.prepare(`
      SELECT id FROM job_jd_version
      WHERE job_id = ? AND status = 'active'
      ORDER BY version DESC, id DESC LIMIT 1
    `).get(current.job_id) || null;
    const previousConfirmedProfile = previousActiveJd ? database.prepare(`
      SELECT * FROM job_profile_version
      WHERE job_id = ? AND jd_version_id = ? AND status = 'confirmed'
      ORDER BY version DESC, id DESC LIMIT 1
    `).get(current.job_id, previousActiveJd.id) || null : null;
    archiveDeepProfileForVersion(database, previousConfirmedProfile, 'active_jd_superseded', timestamp);
    database.prepare(`
      UPDATE job_jd_version
      SET status = 'superseded', superseded_at = ?
      WHERE job_id = ? AND status = 'active'
    `).run(timestamp, current.job_id);
    database.prepare(`
      UPDATE job_jd_version
      SET status = 'active', activated_by = ?, activated_at = ?, superseded_at = NULL
      WHERE id = ? AND status = 'draft'
    `).run(actor, timestamp, id);
    return database.prepare('SELECT * FROM job_jd_version WHERE id = ?').get(id);
  })();
}

function listJobProfileVersions(jobId) {
  const database = conn();
  requireJob(database, jobId);
  return database.prepare(`
    SELECT id, job_id, jd_version_id, version, status, config_json, content_hash,
           source_kind, source_ref_json, created_by, created_at,
           confirmed_by, confirmed_at, superseded_at
    FROM job_profile_version WHERE job_id = ? ORDER BY version DESC, id DESC
  `).all(Number(jobId)).map((row) => ({ ...row, config: parseJson(row.config_json), source_ref: parseJson(row.source_ref_json) || {} }));
}

function createJobProfileVersion(input = {}) {
  const database = conn();
  applyF012WorkbenchMigration(database);
  const job = assertJobRecruitingWritable(database, input.jobId === undefined ? input.job_id : input.jobId);
  const actor = requiredLocalActor(input.actor);
  const sourceKind = String(input.sourceKind === undefined ? (input.source_kind || 'manual') : input.sourceKind).trim();
  if (!['manual', 'hiring_manager_interview'].includes(sourceKind)) throw new Error('unsupported profile source');
  const incomingConfig = input.config;
  if (!incomingConfig || typeof incomingConfig !== 'object' || Array.isArray(incomingConfig)) throw new Error('profile config must be an object');
  // deep_profile is a system-owned projection written only by the dedicated
  // generation/confirmation flow. A client cannot smuggle one into a version.
  const config = profileConfigWithoutClientDeep(incomingConfig);
  const rawJdVersionId = input.jdVersionId === undefined ? input.jd_version_id : input.jdVersionId;
  const jd = rawJdVersionId
    ? database.prepare("SELECT * FROM job_jd_version WHERE id = ? AND job_id = ? AND status = 'active'").get(Number(rawJdVersionId), job.id)
    : database.prepare("SELECT * FROM job_jd_version WHERE job_id = ? AND status = 'active'").get(job.id);
  if (!jd) throw new Error('active JD version is required before profile creation');
  const configJson = JSON.stringify(config);
  const sourceRef = input.sourceRef === undefined ? (input.source_ref || {}) : input.sourceRef;
  const timestamp = nowIso();
  return database.transaction(() => {
    const version = Number(database.prepare('SELECT MAX(version) AS version FROM job_profile_version WHERE job_id = ?').get(job.id).version || 0) + 1;
    const info = database.prepare(`
      INSERT INTO job_profile_version (
        job_id, jd_version_id, version, status, config_json, content_hash,
        source_kind, source_ref_json, created_by, created_at,
        confirmed_by, confirmed_at, superseded_at
      ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
    `).run(job.id, jd.id, version, configJson, stableContentHash(config), sourceKind, JSON.stringify(sourceRef || {}), actor, timestamp);
    return database.prepare('SELECT * FROM job_profile_version WHERE id = ?').get(info.lastInsertRowid);
  })();
}

function confirmJobProfileVersion(input = {}) {
  const database = conn();
  applyF012WorkbenchMigration(database);
  const id = Number(input.id === undefined ? input.profileVersionId : input.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('profileVersionId is required');
  const actor = requiredLocalActor(input.actor);
  return database.transaction(() => {
    const current = database.prepare('SELECT * FROM job_profile_version WHERE id = ?').get(id);
    if (!current) throw new Error(`profile version not found: ${id}`);
    assertJobRecruitingWritable(database, current.job_id);
    const jd = database.prepare("SELECT id FROM job_jd_version WHERE id = ? AND job_id = ? AND status = 'active'").get(current.jd_version_id, current.job_id);
    if (current.status === 'confirmed') {
      if (!jd) throw new Error('profile JD version is no longer active');
      return current;
    }
    if (current.status !== 'draft') throw new Error('only draft profile can be confirmed');
    if (input.expectedVersion !== undefined && Number(input.expectedVersion) !== Number(current.version)) throw new Error('STALE_VERSION');
    if (!jd) throw new Error('profile JD version is no longer active');
    const timestamp = nowIso();
    const previousConfirmedProfile = database.prepare(`
      SELECT * FROM job_profile_version
      WHERE job_id = ? AND status = 'confirmed' AND id <> ?
      ORDER BY version DESC, id DESC LIMIT 1
    `).get(current.job_id, current.id) || null;
    const hasLegacyDeep = !!storedJobProfileConfig(database, current.job_id).deep_profile;
    archiveDeepProfileForVersion(
      database,
      previousConfirmedProfile || (hasLegacyDeep ? current : null),
      previousConfirmedProfile ? 'profile_version_superseded' : 'legacy_deep_before_first_profile_confirmation',
      timestamp,
    );
    database.prepare(`UPDATE job_profile_version SET status = 'superseded', superseded_at = ? WHERE job_id = ? AND status = 'confirmed'`)
      .run(timestamp, current.job_id);
    database.prepare(`
      UPDATE job_profile_version
      SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, superseded_at = NULL
      WHERE id = ? AND status = 'draft'
    `).run(actor, timestamp, id);
    const row = database.prepare('SELECT * FROM job_profile_version WHERE id = ?').get(id);
    const nextConfig = profileConfigWithoutClientDeep(parseJson(row.config_json) || {});
    const archivedDeep = storedJobProfileConfig(database, row.job_id).deep_profile;
    if (archivedDeep && archivedDeep.stale_for_active_jd === true) nextConfig.deep_profile = archivedDeep;
    writeStoredJobProfileConfig(database, row.job_id, nextConfig, timestamp);
    return row;
  })();
}

function todoSource(entityType, entityId, status, time) {
  return { entity_type: entityType, entity_id: entityId, status, time };
}

function assessmentPolicyFromProfile(profile) {
  const policy = String(profile?.config?.assessment_policy || '').trim();
  return ['required', 'recommended', 'not_required'].includes(policy) ? policy : 'not_required';
}

function getJobAssessmentState(database, jobId, candidates) {
  const byCandidate = new Map((candidates || []).map((candidate) => [String(candidate.internal_id), {
    candidate_id: candidate.internal_id,
    active_ready_count: 0,
    pending_binding_count: 0,
    pending_review_count: 0,
    latest_document_id: null,
    latest_updated_at: null,
  }]));
  if (!tableExists(database, 'assessment_document') || !tableExists(database, 'assessment_binding')) {
    return { available: false, by_candidate: byCandidate };
  }
  const rows = database.prepare(`
    SELECT binding.candidate_id, binding.state AS binding_state,
           document.id AS document_id, document.security_state,
           document.report_type, document.analysis_status, document.review_state,
           document.lifecycle_state, document.updated_at
    FROM assessment_binding binding
    JOIN assessment_document document ON document.id = binding.document_id
    WHERE binding.job_id = ?
      AND binding.state IN ('pending', 'active')
      AND document.lifecycle_state <> 'deleted'
    ORDER BY document.updated_at DESC, document.id DESC
  `).all(Number(jobId));
  rows.forEach((row) => {
    const state = byCandidate.get(String(row.candidate_id));
    if (!state) return;
    if (!state.latest_document_id) {
      state.latest_document_id = row.document_id;
      state.latest_updated_at = row.updated_at;
    }
    const documentReady = row.security_state === 'accepted'
      && row.review_state === 'ready'
      && row.report_type !== 'unknown'
      && row.lifecycle_state === 'active';
    if (row.binding_state === 'active' && documentReady) {
      state.active_ready_count += 1;
    } else if (row.binding_state === 'pending' && documentReady) {
      state.pending_binding_count += 1;
    } else {
      state.pending_review_count += 1;
    }
  });
  return { available: true, by_candidate: byCandidate };
}

function getJobWorkbench(jobId) {
  const database = conn();
  const job = requireJob(database, jobId);
  const jdVersions = listJobJdVersions(job.id);
  const storedProfileVersions = listJobProfileVersions(job.id);
  const activeJd = jdVersions.find((row) => row.status === 'active') || null;
  const profileVersions = storedProfileVersions.map((row) => ({
    ...row,
    current_for_active_jd: row.status === 'confirmed'
      && !!activeJd
      && Number(row.jd_version_id) === Number(activeJd.id),
    stale_for_active_jd: ['draft', 'confirmed'].includes(row.status)
      && (!activeJd || Number(row.jd_version_id) !== Number(activeJd.id)),
  }));
  const confirmedProfile = profileVersions.find((row) => row.current_for_active_jd) || null;
  const assessmentPolicy = assessmentPolicyFromProfile(confirmedProfile);
  const staleConfirmedProfile = profileVersions.find((row) => row.status === 'confirmed' && row.stale_for_active_jd) || null;
  const candidates = listCandidates(job.id);
  const assessmentState = getJobAssessmentState(database, job.id, candidates);
  const sessions = database.prepare(`
    SELECT session.id, session.candidate_id, session.job_id, session.round,
           session.mode, session.status, session.scheduled_at,
           session.scheduled_confirmed_by, session.scheduled_confirmed_at,
           session.created_at, session.updated_at, candidate.name AS candidate_name,
           report.id AS report_id, report.status AS report_status, report.version AS report_version,
           report.updated_at AS report_updated_at,
           COALESCE(lifecycle.state, 'active') AS lifecycle_state,
           COALESCE(lifecycle.version, 1) AS lifecycle_version,
           (
             SELECT event.reason_code
             FROM interview_lifecycle_event event
             WHERE event.session_id = CAST(session.id AS TEXT)
               AND event.event_type = 'session_withdrawn'
             ORDER BY event.created_at DESC, event.id DESC
             LIMIT 1
           ) AS cancel_reason,
           SUM(CASE WHEN fact.status = 'pending_review' THEN 1 ELSE 0 END) AS pending_fact_count,
           COUNT(DISTINCT material.id) AS material_count
    FROM interview_session session
    JOIN candidate ON candidate.internal_id = session.candidate_id
    LEFT JOIN interview_session_material material ON material.session_id = session.id
    LEFT JOIN interview_report_v1 report ON report.session_id = session.id
    LEFT JOIN interview_report_fact_review fact ON fact.report_id = report.id
    LEFT JOIN interview_lifecycle_session lifecycle ON lifecycle.id = CAST(session.id AS TEXT)
    WHERE session.job_id = ?
    GROUP BY session.id, report.id
    ORDER BY session.round, session.id
  `).all(job.id).map((session) => ({
    ...session,
    schedule_confirmations: database.prepare(`
      SELECT id, session_id, scheduled_at, confirmed_by, confirmed_at, source, created_at
      FROM interview_session_schedule_confirmation
      WHERE session_id = ?
      ORDER BY id
    `).all(session.id),
  }));
  const assignments = database.prepare(`
    SELECT id, status, purpose, source_type, created_at, updated_at
    FROM interview_pending_assignment
    WHERE job_id = ? AND status IN ('pending_classification', 'pending_assignment')
    ORDER BY id
  `).all(job.id);
  const storedScript = getInterviewScript(job.id);
  const script = storedScript && storedScript.current_for_active_jd !== false
    ? { id: storedScript.id, status: storedScript.status, updated_at: storedScript.updated_at }
    : null;
  const f018Applications = f018RuntimeEnabled ? database.prepare(`
    SELECT application.id, application.candidate_id, application.job_id,
           application.status, application.disposition_action, application.version, application.updated_at,
           review.id AS review_id, review.status AS review_status, review.updated_at AS review_updated_at,
           disposition.id AS disposition_id,
           EXISTS (
             SELECT 1 FROM interview_report_v1 report
             JOIN interview_session session ON session.id = report.session_id
             WHERE session.candidate_id = application.candidate_id
               AND session.job_id = application.job_id
               AND report.status = 'confirmed'
           ) AS has_confirmed_report
    FROM application_episode application
    LEFT JOIN final_review review
      ON review.application_id = application.id
      AND review.status IN ('draft', 'reopened', 'confirmed')
    LEFT JOIN final_disposition disposition ON disposition.final_review_id = review.id
    WHERE application.job_id = ? AND application.status = 'active'
    ORDER BY application.id
  `).all(job.id) : [];
  const nextActions = tableExists(database, 'candidate_next_action')
    ? database.prepare(f018RuntimeEnabled ? `
      SELECT next_action.*
      FROM candidate_next_action next_action
      JOIN application_episode application
        ON application.id = next_action.application_id
        AND application.candidate_id = next_action.candidate_id
        AND application.job_id = next_action.job_id
      WHERE next_action.job_id = ?
        AND next_action.state = 'pending'
        AND application.status = 'active'
      ORDER BY next_action.due_date, next_action.id
    ` : `
      SELECT * FROM candidate_next_action
      WHERE job_id = ? AND state = 'pending' AND application_id IS NULL
      ORDER BY due_date, id
    `).all(job.id)
    : [];
  const offerStatuses = f018RuntimeEnabled && tableExists(database, 'candidate_offer_status') ? database.prepare(`
    SELECT offer.*
    FROM candidate_offer_status offer
    JOIN application_episode application ON application.id = offer.application_id
    WHERE offer.job_id = ?
      AND application.status = 'active'
      AND application.disposition_action = 'continue_process'
      AND offer.status IN ('ready_to_offer', 'offer_sent', 'negotiating', 'accepted')
    ORDER BY offer.updated_at, offer.id
  `).all(job.id) : [];
  const offerStatusByApplication = new Map(
    offerStatuses.map((offer) => [Number(offer.application_id), offer]),
  );
  const todos = [];
  const formal = Number(job.is_fixture) !== 1;
  if (formal && !activeJd) todos.push(workflow.todo({ code: 'job_jd_required', priority: 'high', job_id: job.id, blocking: true, source: todoSource('job', job.id, 'missing_active_jd', null), action: { type: 'open_job_jd', target_id: job.id } }));
  if (formal && !confirmedProfile) todos.push(workflow.todo({
    code: 'job_profile_confirmation_required',
    priority: 'high',
    job_id: job.id,
    blocking: true,
    source: staleConfirmedProfile
      ? todoSource('job_profile_version', staleConfirmedProfile.id, 'stale_for_active_jd', staleConfirmedProfile.confirmed_at || staleConfirmedProfile.created_at)
      : todoSource('job', job.id, 'missing_confirmed_profile_for_active_jd', activeJd && activeJd.activated_at),
    action: { type: 'open_job_profile', target_id: job.id },
  }));
  if (formal) candidates.forEach((candidate) => {
    const source = candidate.workflow_source || todoSource('candidate', candidate.internal_id, candidate.workflow_status, candidate.updated_at);
    const isOnHold = candidate.application_status === 'active'
      && candidate.application_disposition_action === 'hold';
    const ratedTier = workflow.validTier(candidate.sabc);
    if (!isOnHold && !ratedTier) todos.push(workflow.todo({ code: 'candidate_rating_required', candidate_id: candidate.internal_id, job_id: job.id, source, sabc: candidate.sabc, action: { type: 'open_candidate', target_id: candidate.internal_id } }));
    if (!isOnHold && candidate.workflow_status === 'contact_pending') todos.push(workflow.todo({ code: 'contact_required', candidate_id: candidate.internal_id, job_id: job.id, source, sabc: candidate.sabc, action: { type: 'open_candidate', target_id: candidate.internal_id } }));
    if (!isOnHold && candidate.workflow_status === 'communicating') todos.push(workflow.todo({ code: 'communication_followup_required', candidate_id: candidate.internal_id, job_id: job.id, source, sabc: candidate.sabc, action: { type: 'open_candidate', target_id: candidate.internal_id } }));
    if (!isOnHold && candidate.workflow_status === 'resume_pending') todos.push(workflow.todo({ code: 'resume_followup_required', candidate_id: candidate.internal_id, job_id: job.id, source, sabc: candidate.sabc, action: { type: 'open_candidate', target_id: candidate.internal_id } }));
    if (!isOnHold && ratedTier && candidate.workflow_status === 'screening') todos.push(workflow.todo({ code: 'candidate_screening_required', candidate_id: candidate.internal_id, job_id: job.id, source, sabc: candidate.sabc, action: { type: 'open_candidate', target_id: candidate.internal_id } }));
    if (!isOnHold && candidate.workflow_status === 'legacy_review_required') todos.push(workflow.todo({ code: 'legacy_status_review_required', priority: 'high', candidate_id: candidate.internal_id, job_id: job.id, blocking: true, source, sabc: candidate.sabc, action: { type: 'open_candidate', target_id: candidate.internal_id } }));
    const assessmentJourneyActive = !['rejected', 'talent_pool', 'hired', 'candidate_withdrew', 'do_not_contact']
      .includes(candidate.workflow_status);
    if (!isOnHold && assessmentJourneyActive && assessmentPolicy !== 'not_required') {
      const readiness = assessmentState.by_candidate.get(String(candidate.internal_id));
      if (readiness && readiness.active_ready_count === 0) {
        const assessmentSource = readiness.latest_document_id
          ? todoSource('assessment_document', readiness.latest_document_id, 'pending_hr_action', readiness.latest_updated_at)
          : todoSource('candidate', candidate.internal_id, 'assessment_missing', candidate.updated_at || candidate.created_at);
        const common = {
          candidate_id: candidate.internal_id,
          job_id: job.id,
          source: assessmentSource,
          sabc: candidate.sabc,
          priority: assessmentPolicy === 'required' ? 'high' : 'normal',
          blocking: assessmentPolicy === 'required',
          action: { type: 'open_candidate_assessment', target_id: candidate.internal_id },
        };
        if (readiness.pending_review_count > 0) {
          todos.push(workflow.todo({ ...common, code: 'assessment_review_required' }));
        } else if (readiness.pending_binding_count > 0) {
          todos.push(workflow.todo({ ...common, code: 'assessment_binding_confirmation_required' }));
        } else {
          todos.push(workflow.todo({ ...common, code: 'assessment_report_required' }));
        }
      }
    }
  });
  if (formal) assignments.forEach((row) => todos.push(workflow.todo({
    code: row.status === 'pending_classification' ? 'material_classification_required' : 'material_assignment_required',
    priority: 'high', job_id: job.id, blocking: true,
    source: todoSource('interview_pending_assignment', row.id, row.status, row.updated_at || row.created_at),
    action: { type: 'open_interview_assignment', target_id: row.id },
  })));
  if (formal) sessions.forEach((session) => {
    if (session.lifecycle_state !== 'active') return;
    const source = todoSource('interview_session', session.id, session.status, session.updated_at || session.created_at);
    const candidate = candidates.find((row) => row.internal_id === session.candidate_id);
    const base = { candidate_id: session.candidate_id, job_id: job.id, source, sabc: candidate && candidate.sabc };
    if (session.status === 'draft' && !session.scheduled_at) todos.push(workflow.todo({ ...base, code: 'schedule_confirmation_required', blocking: true, action: { type: 'open_session', target_id: session.id } }));
    if (session.status === 'scheduled' && !script) todos.push(workflow.todo({ ...base, code: 'interview_preparation_required', action: { type: 'open_candidate_interview', target_id: session.candidate_id } }));
    if (session.status === 'pending_review' && !session.report_id) todos.push(workflow.todo({ ...base, code: 'report_draft_required', action: { type: 'open_session', target_id: session.id } }));
    if (session.report_status === 'draft' && Number(session.pending_fact_count || 0) > 0) todos.push(workflow.todo({ ...base, code: 'report_fact_review_required', blocking: true, source: todoSource('interview_report_v1', session.report_id, session.report_status, session.report_updated_at), action: { type: 'open_report', target_id: session.report_id } }));
    if (session.report_status === 'draft' && Number(session.pending_fact_count || 0) === 0) todos.push(workflow.todo({ ...base, code: 'report_confirmation_required', blocking: true, source: todoSource('interview_report_v1', session.report_id, session.report_status, session.report_updated_at), action: { type: 'open_report', target_id: session.report_id } }));
  });
  if (formal) f018Applications.forEach((application) => {
    if (application.disposition_action === 'hold') return;
    const candidate = candidates.find((row) => row.internal_id === application.candidate_id);
    const base = {
      candidate_id: application.candidate_id,
      job_id: application.job_id,
      sabc: candidate && candidate.sabc,
      source: todoSource(
        application.review_id ? 'final_review' : 'application_episode',
        application.review_id || application.id,
        application.review_status || application.status,
        application.review_updated_at || application.updated_at,
      ),
      action: { type: 'open_candidate_final_review', target_id: application.candidate_id },
    };
    if (Number(application.has_confirmed_report) === 1
        && (!application.review_id || ['draft', 'reopened'].includes(application.review_status))) {
      todos.push(workflow.todo({ ...base, code: 'final_review_required', priority: 'high', blocking: true }));
    }
    if (application.review_status === 'confirmed' && !application.disposition_id) {
      todos.push(workflow.todo({
        ...base,
        code: 'final_disposition_confirmation_required',
        priority: 'high',
        blocking: true,
      }));
    }
    if (
      application.disposition_action === 'continue_process'
      && application.disposition_id
      && !offerStatusByApplication.has(Number(application.id))
    ) {
      todos.push(workflow.todo({
        ...base,
        code: 'offer_send_followup_required',
        priority: 'high',
        blocking: false,
        source: todoSource(
          'final_disposition',
          application.disposition_id,
          'continue_process',
          application.updated_at,
        ),
        action: { type: 'open_candidate_flow', target_id: application.candidate_id },
      }));
    }
  });
  if (formal) nextActions.forEach((nextAction) => {
    const today = new Date().toLocaleDateString('sv-SE');
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 3);
    const horizonDate = horizon.toLocaleDateString('sv-SE');
    if (nextAction.due_date > horizonDate) return;
    const overdue = nextAction.due_date < today;
    const candidate = candidates.find((row) => row.internal_id === nextAction.candidate_id);
    todos.push(workflow.todo({
      code: overdue ? 'candidate_next_action_overdue' : 'candidate_next_action_due',
      priority: overdue ? 'high' : 'normal',
      blocking: false,
      candidate_id: nextAction.candidate_id,
      job_id: nextAction.job_id,
      sabc: candidate && candidate.sabc,
      source: todoSource('candidate_next_action', nextAction.id, nextAction.state, nextAction.due_date),
      action: { type: 'open_candidate_flow', target_id: nextAction.candidate_id },
    }));
  });
  if (formal) offerStatuses.forEach((offer) => {
    const code = {
      ready_to_offer: 'offer_send_followup_required',
      offer_sent: 'offer_response_followup_required',
      negotiating: 'offer_negotiation_followup_required',
      accepted: 'onboarding_handoff_required',
    }[offer.status];
    if (!code) return;
    const candidate = candidates.find((row) => row.internal_id === offer.candidate_id);
    todos.push(workflow.todo({
      code,
      priority: ['ready_to_offer', 'accepted'].includes(offer.status) ? 'high' : 'normal',
      blocking: false,
      candidate_id: offer.candidate_id,
      job_id: offer.job_id,
      sabc: candidate && candidate.sabc,
      source: todoSource('candidate_offer_status', offer.id, offer.status, offer.updated_at),
      action: { type: 'open_candidate_flow', target_id: offer.candidate_id },
    }));
  });
  const failed = formal ? database.prepare(`
    SELECT id, status, finished_at, started_at
    FROM (
      SELECT id, status, finished_at, started_at
      FROM run_log
      WHERE job = ?
      ORDER BY id DESC
      LIMIT 1
    ) latest
    WHERE status IN ('error', '失败', '部分成功')
  `).get(String(job.id)) : null;
  if (failed) todos.push(workflow.todo({ code: 'task_failed_retryable', priority: 'high', job_id: job.id, blocking: true, source: todoSource('run_log', failed.id, failed.status, failed.finished_at || failed.started_at), action: { type: 'retry_task', target_id: failed.id } }));

  const workflowCounts = Object.fromEntries(workflow.WORKFLOW_STATUSES.map((status) => [status, candidates.filter((row) => row.workflow_status === status).length]));
  return {
    schema_version: 'hr_workbench_v1',
    data_class: formal ? 'formal' : 'fixture',
    job,
    jd: { active: activeJd, versions: jdVersions },
    profile: {
      confirmed: confirmedProfile,
      stale_confirmed: staleConfirmedProfile,
      stale: !!staleConfirmedProfile,
      active_jd_id: activeJd ? activeJd.id : null,
      versions: profileVersions,
      legacy_available: !!database.prepare('SELECT 1 FROM job_profile WHERE job_id = ?').get(job.id),
    },
    candidates,
    interview_sessions: sessions,
    pending_materials: assignments,
    assessment: {
      policy: assessmentPolicy,
      feature_available: assessmentState.available,
      candidates_ready: [...assessmentState.by_candidate.values()]
        .filter((row) => row.active_ready_count > 0).length,
      candidates_pending: [...assessmentState.by_candidate.values()]
        .filter((row) => row.pending_binding_count > 0 || row.pending_review_count > 0).length,
    },
    journey_operations: {
      pending_next_actions: nextActions.length,
      active_offer_followups: todos.filter((item) => [
        'offer_send_followup_required',
        'offer_response_followup_required',
        'offer_negotiation_followup_required',
        'onboarding_handoff_required',
      ].includes(item.code)).length,
    },
    // A closed job is historical context, not an active recruiting queue.
    // Keep every read projection above intact, but do not surface actions that
    // would ask HR to mutate a job which the data layer rejects as read-only.
    todos: formal && job.status !== 'closed' ? workflow.sortTodos(todos) : [],
    metrics: formal ? {
      candidate_count: candidates.length,
      rated_count: candidates.filter((row) => workflow.validTier(row.sabc)).length,
      workflow_counts: workflowCounts,
      assessment_ready_count: [...assessmentState.by_candidate.values()]
        .filter((row) => row.active_ready_count > 0).length,
      pending_next_action_count: nextActions.length,
      active_offer_followup_count: offerStatuses.length,
    } : { candidate_count: 0, rated_count: 0, workflow_counts: {}, assessment_ready_count: 0 },
  };
}

function getCandidateTimeline(candidateId) {
  const database = conn();
  const candidate = getCandidate(candidateId);
  if (!candidate) throw new Error(`candidate not found: ${candidateId}`);
  const job = requireJob(database, candidate.job_id);
  if (candidate.data_class === 'fixture' || Number(job.is_fixture) === 1) {
    return {
      schema_version: 'candidate_timeline_v1',
      data_class: 'fixture',
      candidate_id: candidate.internal_id,
      job_id: candidate.job_id,
      workflow_status: candidate.workflow_status,
      workflow_source: candidate.workflow_source,
      pending_todos: [],
      events: [],
      visible_record_count: 0,
    };
  }
  const formalDataClass = 'formal';
  const timelineApplicationContext = currentJourneyApplication(
    database,
    candidate.internal_id,
    candidate.job_id,
  );
  const timelineHasApplicationProjection = tableExists(database, 'application_episode');
  const contactTypeLabels = {
    phone: '电话',
    mobile: '电话',
    wechat: '微信',
    email: '邮箱',
  };
  const writeActionLabels = {
    greet: '打招呼',
    request_resume: '求简历',
  };
  const writeDecisionLabels = {
    ok: '成功',
    outreach_scope_block: '不符合当前触达范围，已跳过',
    do_not_contact_block: '禁止联系，已跳过',
    worker_exception_stop: '执行异常，已停止',
    security_id_stop: '身份校验信息失效，已停止',
    login_expired: '登录已失效，已停止',
    rate_limited: '触发限流，已停止',
    account_risk_stop: '账号风险，已停止',
    access_restricted_stop: '访问受限，已停止',
    security_check_stop: '需要安全验证，已停止',
    param_error_stop: '参数异常，已停止',
    write_block_stop: '写操作被拦截，已停止',
    api_error_stop: '接口异常，已停止',
    invalid_json: '响应无法解析，已停止',
  };
  const events = [{
    event_id: `candidate:${candidate.internal_id}:created`,
    event_type: 'candidate_created', occurred_at: candidate.created_at,
    source_entity: { type: 'candidate', id: candidate.internal_id, version: 1 },
    status_code: 'new', actor: { type: 'system', id: candidate.source || 'local' },
    summary: '候选人进入本地岗位候选池。', evidence_refs: [], action_required: null,
    data_class: formalDataClass,
  }];
  if (workflow.validTier(candidate.sabc)) events.push({
    event_id: `candidate:${candidate.internal_id}:rating:${candidate.updated_at || candidate.created_at}`,
    event_type: 'rating_decided', occurred_at: candidate.updated_at || candidate.created_at,
    source_entity: { type: 'candidate', id: candidate.internal_id, version: candidate.workflow_version || 1 },
    status_code: workflow.validTier(candidate.sabc), actor: { type: 'source', id: candidate.sabc_source || 'unknown' },
    summary: `确定性档位 ${workflow.validTier(candidate.sabc)}`, evidence_refs: [], action_required: null,
    data_class: formalDataClass,
  });
  database.prepare(`
    SELECT id, layer, from_status, to_status, from_code, to_code, source, who, reason, created_at
    FROM status_history WHERE candidate_id = ? ORDER BY id
  `).all(candidate.internal_id).forEach((row) => {
    const exactTo = row.layer === 'comm'
      ? workflow.communicationCode(row.to_code, row.to_status)
      : workflow.dispositionCode(row.to_code, row.to_status);
    events.push({
      event_id: `status_history:${row.id}`, event_type: row.layer === 'comm' ? 'communication_observed' : 'disposition_decided',
      occurred_at: row.created_at, source_entity: { type: 'status_history', id: row.id, version: 1 },
      status_code: exactTo || 'legacy_review_required', actor: { type: 'actor', id: row.who || row.source || 'unknown' },
      summary: exactTo ? `${row.layer === 'comm' ? '沟通' : '处置'}状态更新` : '待人工复核',
      detail: row.reason || '',
      diagnostic: exactTo ? null : { legacy_status_code: row.to_code || row.to_status || null },
      evidence_refs: [], action_required: exactTo ? null : 'legacy_status_review_required', data_class: formalDataClass,
    });
  });
  database.prepare(`
    SELECT id, body, purpose_tag, author, created_at
    FROM comment WHERE candidate_id = ? ORDER BY id
  `).all(candidate.internal_id).forEach((row) => events.push({
    event_id: `comment:${row.id}`, event_type: 'comment_recorded', occurred_at: row.created_at,
    source_entity: { type: 'comment', id: row.id, version: 1 },
    status_code: 'recorded', actor: { type: 'human', id: row.author || 'HR' },
    summary: row.purpose_tag || 'HR 备注', detail: row.body || '',
    evidence_refs: [], action_required: null, data_class: formalDataClass,
  }));
  if (tableExists(database, 'candidate_next_action')) {
    database.prepare(`
      SELECT id, application_id, action_type, due_date, note, state, version, actor_id, request_id,
             created_at, updated_at
      FROM candidate_next_action
      WHERE candidate_id = ? AND job_id = ?
      ORDER BY id
    `).all(candidate.internal_id, candidate.job_id).forEach((row) => events.push({
      event_id: `candidate_next_action:${row.id}:${row.version}`,
      event_type: 'candidate_next_action_recorded',
      occurred_at: row.updated_at || row.created_at,
      source_entity: { type: 'candidate_next_action', id: row.id, version: row.version },
      application_id: row.application_id,
      status_code: row.state,
      actor: { type: 'human', id: row.actor_id },
      summary: `候选人下一步：${row.action_type}（${row.due_date}）`,
      detail: row.note || '',
      request_id: row.request_id,
      evidence_refs: [],
      action_required: row.state === 'pending'
        && (
          !timelineHasApplicationProjection
          || (
            timelineApplicationContext
            && Number(row.application_id) === Number(timelineApplicationContext.application_id)
          )
        )
        ? 'candidate_next_action_due'
        : null,
      data_class: formalDataClass,
    }));
  }
  if (tableExists(database, 'hiring_manager_feedback')) {
    database.prepare(`
      SELECT id, context_type, feedback_person, feedback_role, feedback_at,
             summary, conclusion, actor_id, request_id, created_at
      FROM hiring_manager_feedback
      WHERE candidate_id = ? AND job_id = ?
      ORDER BY feedback_at, id
    `).all(candidate.internal_id, candidate.job_id).forEach((row) => events.push({
      event_id: `hiring_manager_feedback:${row.id}`,
      event_type: 'hiring_manager_feedback_recorded',
      occurred_at: row.feedback_at || row.created_at,
      source_entity: { type: 'hiring_manager_feedback', id: row.id, version: 1 },
      status_code: row.conclusion,
      actor: { type: 'human', id: row.actor_id },
      summary: `${row.feedback_person}${row.feedback_role ? `（${row.feedback_role}）` : ''}的反馈`,
      detail: row.summary,
      request_id: row.request_id,
      diagnostic: { context_type: row.context_type },
      evidence_refs: [],
      action_required: null,
      data_class: formalDataClass,
    }));
  }
  if (tableExists(database, 'candidate_offer_event')) {
    database.prepare(`
      SELECT id, offer_id, application_id, from_status, to_status,
             expected_start_date, reason_code, note, offer_version,
             actor_id, request_id, occurred_at
      FROM candidate_offer_event
      WHERE candidate_id = ? AND job_id = ?
      ORDER BY occurred_at, id
    `).all(candidate.internal_id, candidate.job_id).forEach((row) => events.push({
      event_id: `candidate_offer_event:${row.id}`,
      event_type: 'candidate_offer_status_changed',
      occurred_at: row.occurred_at,
      source_entity: { type: 'candidate_offer_status', id: row.offer_id, version: row.offer_version },
      application_id: row.application_id,
      status_code: row.to_status,
      actor: { type: 'human', id: row.actor_id },
      summary: row.from_status
        ? `Offer 状态从 ${row.from_status} 更新为 ${row.to_status}`
        : `Offer 进入 ${row.to_status}`,
      detail: row.note || '',
      request_id: row.request_id,
      diagnostic: {
        reason_code: row.reason_code || null,
        expected_start_date: row.expected_start_date || null,
      },
      evidence_refs: [],
      action_required: null,
      data_class: formalDataClass,
    }));
  }
  database.prepare(`
    SELECT id, type, source, confidence, created_at
    FROM contact WHERE candidate_id = ? ORDER BY id
  `).all(candidate.internal_id).forEach((row) => events.push({
    event_id: `contact:${row.id}`, event_type: 'contact_recorded', occurred_at: row.created_at,
    source_entity: { type: 'contact', id: row.id, version: 1 },
    status_code: 'recorded', actor: { type: 'source', id: row.source || 'unknown' },
    summary: `${contactTypeLabels[row.type] || '其他'}联系方式已记录`,
    detail: '联系方式已安全保存；当前时间线不展示明文。',
    diagnostic: { confidence: row.confidence || null },
    evidence_refs: [], action_required: null, data_class: formalDataClass,
  }));
  database.prepare(`
    SELECT id, action_type, status, decision, created_at, updated_at, executed_at
    FROM write_action WHERE candidate_id = ? ORDER BY id
  `).all(candidate.internal_id).forEach((row) => {
    const actionLabel = Object.hasOwn(writeActionLabels, row.action_type)
      ? writeActionLabels[row.action_type]
      : null;
    const hasDecision = Boolean(row.decision);
    const decisionLabel = hasDecision && Object.hasOwn(writeDecisionLabels, row.decision)
      ? writeDecisionLabels[row.decision]
      : null;
    const diagnostic = {};
    if (!actionLabel) diagnostic.legacy_action_type_code = row.action_type || null;
    if (hasDecision && !decisionLabel) diagnostic.legacy_decision_code = row.decision;
    events.push({
      event_id: `write_action:${row.id}`, event_type: 'write_action_recorded',
      occurred_at: row.executed_at || row.updated_at || row.created_at,
      source_entity: { type: 'write_action', id: row.id, version: 1 },
      status_code: row.status || 'recorded', actor: { type: 'system', id: 'write_action' },
      summary: actionLabel ? `自动动作：${actionLabel}` : '待人工复核',
      detail: !hasDecision ? '' : (decisionLabel ? `执行决定：${decisionLabel}` : '待人工复核'),
      diagnostic: Object.keys(diagnostic).length ? diagnostic : null,
      evidence_refs: [], action_required: null, data_class: formalDataClass,
    });
  });
  const sessions = database.prepare(`
    SELECT session.*, COALESCE(lifecycle.state, 'active') AS lifecycle_state,
           COALESCE(lifecycle.version, 1) AS lifecycle_version
    FROM interview_session session
    LEFT JOIN interview_lifecycle_session lifecycle ON lifecycle.id = CAST(session.id AS TEXT)
    WHERE session.candidate_id = ? ORDER BY session.round, session.id
  `).all(candidate.internal_id);
  sessions.forEach((session) => {
    const lifecycleTerminal = session.lifecycle_state !== 'active';
    events.push({
      event_id: `interview_session:${session.id}:status`, event_type: 'session_status_changed', occurred_at: session.updated_at || session.created_at,
      source_entity: { type: 'interview_session', id: session.id, version: 1 }, session_id: session.id, round: session.round,
      status_code: session.status, actor: { type: 'system', id: 'interview_session' }, summary: `第 ${session.round} 轮${session.mode === 'online' ? '线上' : '线下'}面试`, evidence_refs: [],
      action_required: !lifecycleTerminal && session.status === 'draft' ? 'schedule_confirmation_required' : null,
      lifecycle_state: session.lifecycle_state, lifecycle_terminal: lifecycleTerminal,
      data_class: formalDataClass,
    });
    database.prepare('SELECT * FROM interview_session_schedule_confirmation WHERE session_id = ? ORDER BY id').all(session.id).forEach((row) => events.push({
      event_id: `schedule_confirmation:${row.id}`, event_type: 'schedule_confirmed', occurred_at: row.confirmed_at,
      source_entity: { type: 'interview_session_schedule_confirmation', id: row.id, version: 1 }, session_id: session.id, round: session.round,
      status_code: 'scheduled', actor: { type: 'human', id: row.confirmed_by }, summary: `人工确认面试时间 ${row.scheduled_at}`, evidence_refs: [], action_required: null, data_class: formalDataClass,
    }));
    database.prepare('SELECT * FROM interview_session_material WHERE session_id = ? ORDER BY id').all(session.id).forEach((row) => events.push({
      event_id: `session_material:${row.id}`, event_type: 'material_linked', occurred_at: row.linked_at,
      source_entity: { type: 'interview_session_material', id: row.id, version: 1 }, session_id: session.id, round: session.round,
      status_code: row.material_kind, actor: { type: 'actor', id: row.linked_by }, summary: '面试材料已关联到本轮 Session', evidence_refs: [{ material_id: row.id }], action_required: null, data_class: formalDataClass,
    }));
    const report = database.prepare('SELECT * FROM interview_report_v1 WHERE session_id = ?').get(session.id);
    if (report) {
      events.push({
        event_id: `interview_report_v1:${report.id}:${report.version}`, event_type: report.status === 'confirmed' ? 'report_confirmed' : 'report_drafted', occurred_at: report.confirmed_at || report.updated_at,
        source_entity: { type: 'interview_report_v1', id: report.id, version: report.version }, session_id: session.id, round: session.round,
        status_code: report.status, actor: { type: 'human', id: report.confirmed_by || report.updated_by }, summary: report.status === 'confirmed' ? '面试报告已人工确认' : '面试报告草稿待人工确认', evidence_refs: [], action_required: !lifecycleTerminal && report.status === 'draft' ? 'report_confirmation_required' : null, lifecycle_state: session.lifecycle_state, lifecycle_terminal: lifecycleTerminal, data_class: formalDataClass,
      });
      database.prepare('SELECT * FROM interview_report_fact_review WHERE report_id = ? ORDER BY id').all(report.id).forEach((row) => events.push({
        event_id: `report_fact_review:${row.id}:${row.version}`, event_type: 'fact_reviewed', occurred_at: row.reviewed_at || row.updated_at,
        source_entity: { type: 'interview_report_fact_review', id: row.id, version: row.version }, session_id: session.id, round: session.round,
        status_code: row.status, actor: { type: row.reviewed_by ? 'human' : 'system', id: row.reviewed_by || 'pending' }, summary: row.status === 'pending_review' ? '关键事实待人工复核' : '关键事实已处理', evidence_refs: [], action_required: !lifecycleTerminal && row.status === 'pending_review' ? 'report_fact_review_required' : null, lifecycle_state: session.lifecycle_state, lifecycle_terminal: lifecycleTerminal, data_class: formalDataClass,
      }));
    }
  });
  events.sort((a, b) => String(a.occurred_at || '').localeCompare(String(b.occurred_at || '')) || String(a.event_id).localeCompare(String(b.event_id)));
  const workbench = getJobWorkbench(candidate.job_id);
  const pendingTodos = workbench.todos.filter((item) => item.candidate_id === candidate.internal_id);
  return {
    schema_version: 'candidate_timeline_v1', data_class: 'formal', candidate_id: candidate.internal_id, job_id: candidate.job_id,
    workflow_status: candidate.workflow_status, workflow_source: candidate.workflow_source,
    pending_todos: pendingTodos, events,
    visible_record_count: events.length + pendingTodos.length,
  };
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

const TALENT_POOL_STATUS_META = [
  { key: 'reactivable', label: '可激活', color: 'green', action: '人工复核后再触达' },
  { key: 'silver', label: '银牌候选人', color: 'cyan', action: '优先人工回访' },
  { key: 'role_mismatch', label: '转岗可复核', color: 'purple', action: '只按新岗位人工复核' },
  { key: 'cooling', label: '冷却中', color: 'blue', action: '等待冷却期' },
  { key: 'do_not_contact', label: '不建议触达', color: 'red', action: '不触达' },
  { key: 'need_info', label: '待补资料', color: 'gold', action: '先补资料' },
  { key: 'data_stale', label: '数据过期', color: 'default', action: '先确认信息有效性' },
];

const TALENT_POOL_STATUS_INDEX = Object.fromEntries(TALENT_POOL_STATUS_META.map((item, index) => [item.key, index]));
const TALENT_CONTACT_BLOCKED_STATUSES = new Set(['cooling', 'do_not_contact', 'data_stale']);
const TALENT_VALID_CONTACT_METHODS = new Set([
  'mobile', 'phone', 'email', 'wechat', 'weixin', 'qq',
  '手机', '电话', '邮箱', '微信',
]);
const TALENT_POOL_TOKEN_CATALOG = [
  'AI', 'Agent', 'RAG', 'LLM', '大模型', '智能体', 'Java', 'Node', 'React', 'Vue', 'SQL',
  'Redis', 'MySQL', 'Python', '后端', '前端', '全栈', '架构', '自动化', 'RPA', '数据',
  '电商', '直播', '运营', '投放', 'GMV', 'ROI', '供应链', 'OMS', 'WMS', 'CRM', 'ERP',
  '销售', 'BD', '客户', '增长', '项目', '交付',
];

function cleanTalentText(value) {
  return value === undefined || value === null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function hasValidTalentContactMethod(types) {
  return (types || []).some((item) => TALENT_VALID_CONTACT_METHODS.has(cleanTalentText(item).toLowerCase()));
}

function talentContactReady(status, contactState) {
  return !TALENT_CONTACT_BLOCKED_STATUSES.has(status)
    && contactState?.has_record === true
    && contactState?.has_valid_contact_method === true
    && contactState?.consent_confirmed === true
    && contactState?.opt_out_status_confirmed === true
    && contactState?.needs_consent_check === false;
}

function clipTalentText(value, max = 140) {
  const valueText = cleanTalentText(value);
  return valueText.length > max ? `${valueText.slice(0, max)}...` : valueText;
}

const TALENT_REDACTION = Object.freeze({
  email: '[邮箱已隐藏]',
  phone: '[电话已隐藏]',
  contact: '[联系方式已隐藏]',
  age: '[年龄已隐藏]',
  salary: '[薪资已隐藏]',
  school: '[学校层级已隐藏]',
  region: '[地域已隐藏]',
  bossKey: '[Boss钥匙字段已隐藏]',
});

const TALENT_REGION_NAMES = [
  '北京', '上海', '天津', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江',
  '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州',
  '云南', '陕西', '甘肃', '青海', '台湾', '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港',
  '澳门', '石家庄', '太原', '沈阳', '长春', '哈尔滨', '南京', '杭州', '合肥', '福州',
  '南昌', '济南', '郑州', '武汉', '长沙', '广州', '深圳', '海口', '成都', '贵阳', '昆明',
  '西安', '兰州', '西宁', '呼和浩特', '南宁', '拉萨', '银川', '乌鲁木齐', '苏州', '宁波',
  '青岛', '东莞', '佛山', '厦门', '无锡', '珠海', '温州', '金华', '惠州', '大连',
  '泉州', '绍兴', '常州', '嘉兴', '烟台', '南通', '珠三角', '长三角', '京津冀', '粤港澳',
];
const TALENT_REGION_SOURCE = TALENT_REGION_NAMES.sort((a, b) => b.length - a.length).join('|');
const TALENT_REGION_PATTERN = new RegExp(`(?:${TALENT_REGION_SOURCE})(?:省|市|自治区|特别行政区)?`, 'g');
const TALENT_REGION_FIELD_PATTERN = new RegExp(
  `(?:现居地?|居住地?|所在地|所在城市|所在地区|城市|地区|地域|坐标|工作地(?:点)?|办公地(?:点)?|期望地(?:点)?|期望城市|意向地(?:点)?|意向城市|常驻地)\\s*(?:[:：=为在])?\\s*(?:${TALENT_REGION_SOURCE})(?:省|市|自治区|特别行政区)?`,
  'g',
);
const TALENT_REDACTION_PATTERN = new RegExp(
  Object.values(TALENT_REDACTION).map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'g',
);

function scrubTalentText(value, max = 160) {
  return clipTalentText(value, max)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, TALENT_REDACTION.email)
    .replace(/(?:\+?86[-\s]?)?1[3-9]\d(?:[-\s]?\d){8}/g, TALENT_REDACTION.phone)
    .replace(/(?:\+?86[-\s]?)?0\d{2,3}[-\s]?\d{7,8}/g, TALENT_REDACTION.phone)
    .replace(/(?:微信(?:号|ID)?|wechat|wx|QQ|电话|手机(?:号)?|邮箱|email|联系方式)\s*[:：=]\s*[^\s，。；;]{3,}/gi, TALENT_REDACTION.contact)
    .replace(/(?:boss[_-]?id|geek[_-]?id|security[_-]?id|encrypt[_-]?job[_-]?id|expect[_-]?id|chat[_-]?uid|lid)\s*[:：=]\s*[A-Za-z0-9_-]+/gi, TALENT_REDACTION.bossKey)
    .replace(/(?:年龄|年纪)\s*[:：=]?\s*\d{1,3}(?:\s*(?:周岁|岁))?/g, TALENT_REDACTION.age)
    .replace(/\d{1,3}\s*(?:周岁|岁)/g, TALENT_REDACTION.age)
    .replace(/(?:期望|当前|目前|原|税前|税后|基本|综合|目标|到手)?\s*(?:月薪|年薪|薪资|工资|薪酬|待遇)(?:范围|区间)?\s*[:：=为]?\s*(?:人民币|RMB|CNY|￥|¥)?\s*(?:(?:\d+(?:\.\d+)?)(?:\s*(?:[kK]|千|万元|万|元))?(?:\s*(?:-|~|～|—|至|到)\s*\d+(?:\.\d+)?\s*(?:[kK]|千|万元|万|元))?(?:\s*(?:\/|每)\s*(?:月|年))?|面议|可谈|保密)/gi, TALENT_REDACTION.salary)
    .replace(/(?:人民币|RMB|CNY|￥|¥)?\s*\d+(?:\.\d+)?\s*(?:[kK]|千|万元|万|元)?\s*(?:-|~|～|—|至|到)\s*(?:人民币|RMB|CNY|￥|¥)?\s*\d+(?:\.\d+)?\s*(?:[kK]|千|万元|万|元)(?:\s*(?:\/|每)\s*(?:月|年))?/gi, TALENT_REDACTION.salary)
    .replace(/(?:人民币|RMB|CNY|￥|¥)?\s*\d+(?:\.\d+)?\s*(?:[kK]|千|万元|万|元)(?:\s*(?:\/|每)\s*(?:月|年))?/gi, TALENT_REDACTION.salary)
    .replace(/(?:期望|当前|目前|原|税前|税后|基本|综合|目标|到手)?\s*(?:月薪|年薪|薪资|工资|薪酬|待遇)(?:范围|区间)?(?=\s*[,，。；;]|$)/g, TALENT_REDACTION.salary)
    .replace(/(?:学校|院校)(?:层级|等级|背景|标签)?\s*[:：=]\s*[^，。；;|]{1,24}/g, TALENT_REDACTION.school)
    .replace(/(?<!\d)(?:985|211)(?!\d)|C9|双一流|一本(?:院校|本科)|二本(?:院校|本科)|三本(?:院校|本科)|重点(?:本科|院校|大学)|海外名校|名校|QS\s*(?:TOP|前)?\s*\d+|(?:世界|国内)\s*前\s*\d+\s*(?:名|院校)?/gi, TALENT_REDACTION.school)
    .replace(TALENT_REGION_FIELD_PATTERN, TALENT_REDACTION.region)
    .replace(/(?:现居地?|居住地?|所在地|所在城市|所在地区|城市|地区|地域|坐标|工作地(?:点)?|办公地(?:点)?|期望地(?:点)?|期望城市|意向地(?:点)?|意向城市|常驻地)\s*[:：=]\s*[^，。；;|]{1,32}/g, TALENT_REDACTION.region)
    .replace(TALENT_REGION_PATTERN, TALENT_REDACTION.region)
    .replace(/(?:\[地域已隐藏\]\s*){2,}/g, TALENT_REDACTION.region)
    .replace(/(?:\[薪资已隐藏\]\s*){2,}/g, TALENT_REDACTION.salary)
    .trim();
}

function hasTalentDecisionText(value) {
  return cleanTalentText(value)
    .replace(TALENT_REDACTION_PATTERN, '')
    .replace(/(?:期望|当前|目前|原|税前|税后|基本|综合|目标|到手)?\s*(?:月薪|年薪|薪资|工资|薪酬|待遇)(?:范围|区间)?/g, '')
    .replace(/现居地?|居住地?|所在地|所在城市|所在地区|城市|地区|地域|坐标|工作地(?:点)?|办公地(?:点)?|期望地(?:点)?|期望城市|意向地(?:点)?|意向城市|常驻地/g, '')
    .replace(/[\s，。；;、：:,./|()（）[\]{}<>《》“”'"_-]/g, '')
    .length >= 2;
}

function talentDateMs(value) {
  const raw = cleanTalentText(value);
  if (!raw) return null;
  if (/^\d{13}$/.test(raw)) return Number(raw);
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTalentTime(value) {
  const ms = talentDateMs(value);
  if (!Number.isFinite(ms)) return cleanTalentText(value) || null;
  return new Date(ms).toISOString();
}

function latestTalentTime(values) {
  let best = null;
  let bestMs = -Infinity;
  values.filter(Boolean).forEach((value) => {
    const ms = talentDateMs(value);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = new Date(ms).toISOString();
    } else if (!best && cleanTalentText(value)) {
      best = cleanTalentText(value);
    }
  });
  return best;
}

function daysSinceTalent(value) {
  const ms = talentDateMs(value);
  if (!Number.isFinite(ms)) return null;
  return Math.floor((Date.now() - ms) / (24 * 60 * 60 * 1000));
}

function tableExists(database, name) {
  return !!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function inClause(values) {
  return values.map(() => '?').join(', ');
}

function byCandidateId(rows, reducer) {
  const map = new Map();
  rows.forEach((row) => {
    const key = row.candidate_id;
    if (!key) return;
    map.set(key, reducer ? reducer(map.get(key), row) : row);
  });
  return map;
}

function normalizeTalentSections(sections) {
  if (!sections || typeof sections !== 'object') return null;
  const out = { ...sections };
  ['basic', 'work', 'proj', 'edu', 'skill', 'expect'].forEach((key) => {
    if (out[key] && !Array.isArray(out[key])) out[key] = [out[key]];
    if (!out[key]) out[key] = [];
  });
  return out;
}

function talentEvidenceProfile(row) {
  if (!row || Number(row.is_paywalled) === 1) {
    return {
      schema_version: 'evidence_profile_v1',
      candidate_summary: { education: 'Unknown', work_experience: 'Unknown', summary: '' },
      evidence_items: [],
    };
  }
  const sections = normalizeTalentSections(parseJson(row.sections_json));
  return buildEvidenceProfile(sections);
}

function parseLatestTalentReport(aiInfo) {
  const latest = aiInfo && aiInfo.latest ? aiInfo.latest : aiInfo;
  if (!latest || !latest.report_json) return { has_v1_report: false, has_confirmed_v1_report: false, report: null, confirmed_report: null };
  const report = parseJson(latest.report_json);
  if (!isCandidateReportV1(report)) return { has_v1_report: false, has_confirmed_v1_report: false, report: null, confirmed_report: null };
  const confirmedRow = aiInfo && aiInfo.confirmed ? aiInfo.confirmed : (Number(latest.profile_confirmed) === 1 ? latest : null);
  const confirmedReport = confirmedRow ? parseJson(confirmedRow.report_json) : null;
  return {
    has_v1_report: true,
    has_confirmed_v1_report: !!(confirmedReport && isCandidateReportV1(confirmedReport)),
    report,
    confirmed_report: confirmedReport && isCandidateReportV1(confirmedReport) ? confirmedReport : null,
  };
}

function profileTextForTalent(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const pieces = [
    profile.rubric,
    profile.deep_profile && profile.deep_profile.doc,
    profile.deep_profile && profile.deep_profile.doc && profile.deep_profile.doc.summary,
    profile.deep_profile && profile.deep_profile.doc && profile.deep_profile.doc.position_mission,
    profile.deep_profile && profile.deep_profile.doc && profile.deep_profile.doc.core_competencies,
  ];
  return pieces.map((item) => {
    if (!item) return '';
    if (typeof item === 'string') return item;
    try { return JSON.stringify(item); } catch { return ''; }
  }).filter(Boolean).join(' ');
}

function extractTalentTokens(value, limit = 8) {
  const source = cleanTalentText(value);
  const hits = TALENT_POOL_TOKEN_CATALOG.filter((token) => new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(source));
  return [...new Set(hits)].slice(0, limit);
}

function textListFromTalent(value, limit = 4) {
  return cleanTalentText(value)
    .replace(/[•●▪◆]/g, '\n')
    .replace(/([。！？!?；;])\s*/g, '$1\n')
    .split(/\n+/)
    .map((item) => scrubTalentText(item, 110))
    .filter((item) => item && hasTalentDecisionText(item))
    .slice(0, limit);
}

function latestTalentAiReviews(database, candidateIds) {
  if (!candidateIds.length) return new Map();
  const rows = database.prepare(`
    SELECT candidate_id, id, profile_confirmed, report_json, created_at
    FROM ai_review
    WHERE candidate_id IN (${inClause(candidateIds)})
    ORDER BY candidate_id, created_at DESC, id DESC
  `).all(...candidateIds);
  const map = new Map();
  rows.forEach((row) => {
    const report = parseJson(row.report_json);
    if (!isCandidateReportV1(report) || isLocalDemoReport(report)) return;
    const current = map.get(row.candidate_id) || { latest: null, confirmed: null };
    if (!current.latest) current.latest = row;
    if (!current.confirmed && Number(row.profile_confirmed) === 1) current.confirmed = row;
    map.set(row.candidate_id, current);
  });
  return map;
}

function readTalentRelatedData(database, candidateIds) {
  if (!candidateIds.length) {
    return {
      latestAi: new Map(),
      contacts: new Map(),
      comments: new Map(),
      statuses: new Map(),
      fieldAnnotations: new Map(),
      interviews: new Map(),
    };
  }
  const placeholders = inClause(candidateIds);
  const contacts = byCandidateId(database.prepare(`
    SELECT
      candidate_id,
      COUNT(*) AS contact_count,
      GROUP_CONCAT(DISTINCT type) AS contact_types,
      GROUP_CONCAT(DISTINCT source) AS contact_sources,
      GROUP_CONCAT(DISTINCT confidence) AS contact_confidences,
      MAX(created_at) AS latest_contact_at
    FROM contact
    WHERE candidate_id IN (${placeholders})
    GROUP BY candidate_id
  `).all(...candidateIds));
  const comments = byCandidateId(database.prepare(`
    SELECT
      candidate_id,
      COUNT(*) AS comment_count,
      MAX(created_at) AS latest_comment_at,
      GROUP_CONCAT(COALESCE(purpose_tag, '') || ':' || COALESCE(polarity, '') || ':' || COALESCE(body, ''), '；') AS comment_signal
    FROM comment
    WHERE candidate_id IN (${placeholders})
    GROUP BY candidate_id
  `).all(...candidateIds));
  const statuses = byCandidateId(database.prepare(`
    SELECT
      candidate_id,
      COUNT(*) AS status_count,
      MAX(created_at) AS latest_status_at,
      GROUP_CONCAT(COALESCE(layer, '') || ':' || COALESCE(from_status, '') || '->' || COALESCE(to_status, '') || ':' || COALESCE(reason, ''), '；') AS status_signal
    FROM status_history
    WHERE candidate_id IN (${placeholders})
    GROUP BY candidate_id
  `).all(...candidateIds));
  const fieldAnnotations = byCandidateId(database.prepare(`
    SELECT
      candidate_id,
      COUNT(*) AS annotation_count,
      MAX(created_at) AS latest_annotation_at,
      GROUP_CONCAT(COALESCE(kind, '') || ':' || COALESCE(value, '') || ':' || COALESCE(drives_status, ''), '；') AS annotation_signal
    FROM field_annotation
    WHERE candidate_id IN (${placeholders})
    GROUP BY candidate_id
  `).all(...candidateIds));
  let interviews = new Map();
  if (tableExists(database, 'interview_recording')) {
    const rows = database.prepare(`
      SELECT
        r.candidate_id,
        COUNT(DISTINCT r.id) AS recording_count,
        MAX(COALESCE(r.updated_at, r.created_at)) AS latest_interview_at
      FROM interview_recording r
      WHERE r.candidate_id IN (${placeholders})
      GROUP BY r.candidate_id
    `).all(...candidateIds);
    interviews = byCandidateId(rows);
    if (tableExists(database, 'interview_report_v1') && tableExists(database, 'interview_session')) {
      const reportRows = database.prepare(`
        SELECT
          session.candidate_id,
          SUM(CASE WHEN report.status IN ('draft', 'confirmed') THEN 1 ELSE 0 END) AS ai_report_count,
          SUM(CASE WHEN report.status = 'draft' THEN 1 ELSE 0 END) AS draft_ai_report_count,
          SUM(CASE WHEN report.status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_ai_report_count,
          MAX(CASE WHEN report.status IN ('draft', 'confirmed') THEN report.updated_at ELSE NULL END) AS latest_report_at
        FROM interview_session session
        JOIN interview_report_v1 report ON report.session_id = session.id
        WHERE session.candidate_id IN (${placeholders})
        GROUP BY session.candidate_id
      `).all(...candidateIds);
      reportRows.forEach((row) => {
        const current = interviews.get(row.candidate_id) || { candidate_id: row.candidate_id, recording_count: 0 };
        interviews.set(row.candidate_id, {
          ...current,
          ai_report_count: Number(row.ai_report_count || 0),
          draft_ai_report_count: Number(row.draft_ai_report_count || 0),
          confirmed_ai_report_count: Number(row.confirmed_ai_report_count || 0),
          latest_interview_at: latestTalentTime([current.latest_interview_at, row.latest_report_at]),
        });
      });
    }
  }
  return {
    latestAi: latestTalentAiReviews(database, candidateIds),
    contacts,
    comments,
    statuses,
    fieldAnnotations,
    interviews,
  };
}

function buildTalentHistory(row, related) {
  const aiInfo = parseLatestTalentReport(related.latestAi.get(row.internal_id));
  const contact = related.contacts.get(row.internal_id) || {};
  const comment = related.comments.get(row.internal_id) || {};
  const status = related.statuses.get(row.internal_id) || {};
  const annotation = related.fieldAnnotations.get(row.internal_id) || {};
  const interview = related.interviews.get(row.internal_id) || {};
  const evidenceProfile = talentEvidenceProfile(row);
  const evidenceItems = Array.isArray(evidenceProfile.evidence_items) ? evidenceProfile.evidence_items : [];
  const publicEvidenceItems = evidenceItems.map((item) => ({
    id: item.id,
    source: item.source_type || 'resume_fact',
    text: scrubTalentText(item.text, 120),
  })).filter((item) => hasTalentDecisionText(item.text));
  const latestInteractionAt = latestTalentTime([
    row.last_ts,
    status.latest_status_at,
    comment.latest_comment_at,
    annotation.latest_annotation_at,
    interview.latest_interview_at,
  ]);
  const dataObservedAt = latestTalentTime([row.last_ts, row.fetched_at, row.created_at]);
  return {
    candidate_id: row.internal_id,
    job_id: row.job_id,
    job_name: scrubTalentText(row.job_name || `岗位 ${row.job_id}`, 80),
    source: scrubTalentText(row.source || '本地记录', 40),
    rec_position: scrubTalentText(row.rec_position, 80),
    created_at: normalizeTalentTime(row.created_at),
    updated_at: normalizeTalentTime(row.updated_at),
    last_interaction_at: latestInteractionAt,
    data_observed_at: dataObservedAt,
    comm_status: scrubTalentText(row.comm_status || 'Unknown', 40),
    disposition_status: scrubTalentText(row.disposition_status || 'Unknown', 40),
    communication_code: workflow.communicationCode(row.communication_code, row.comm_status),
    disposition_code: workflow.dispositionCode(row.disposition_code, row.disposition_status),
    status_count: Number(status.status_count || 0),
    comment_count: Number(comment.comment_count || 0),
    annotation_count: Number(annotation.annotation_count || 0),
    has_contact_record: Number(contact.contact_count || 0) > 0,
    contact_types: cleanTalentText(contact.contact_types).split(',').map((item) => scrubTalentText(item, 20)).filter(Boolean),
    contact_sources: cleanTalentText(contact.contact_sources).split(',').map((item) => scrubTalentText(item, 40)).filter(Boolean),
    contact_confidences: cleanTalentText(contact.contact_confidences).split(',').map((item) => scrubTalentText(item, 24)).filter(Boolean),
    latest_contact_at: normalizeTalentTime(contact.latest_contact_at),
    has_v1_report: aiInfo.has_v1_report,
    has_confirmed_v1_report: aiInfo.has_confirmed_v1_report,
    v1_report: aiInfo.report,
    has_interview_report: Number(interview.confirmed_ai_report_count || 0) > 0,
    has_draft_interview_report: Number(interview.draft_ai_report_count || 0) > 0,
    interview_count: Number(interview.recording_count || 0),
    resume_paywalled: Number(row.is_paywalled) === 1,
    has_resume: !!row.sections_json && Number(row.is_paywalled) !== 1,
    evidence_profile: evidenceProfile,
    evidence_refs: publicEvidenceItems.slice(0, 3),
    summary: {
      education: scrubTalentText(row.degree || (evidenceProfile.candidate_summary && evidenceProfile.candidate_summary.education) || 'Unknown', 60),
      work_experience: scrubTalentText(row.work_years || (evidenceProfile.candidate_summary && evidenceProfile.candidate_summary.work_experience) || 'Unknown', 80),
      self_summary: scrubTalentText((evidenceProfile.candidate_summary && evidenceProfile.candidate_summary.summary) || row.geek_desc, 160),
    },
    raw_signals: {
      match_point: scrubTalentText(row.match_point, 120),
      risk_point: scrubTalentText(row.risk_point, 120),
      verdict_label: scrubTalentText(row.verdict_label, 80),
      expert_comment: scrubTalentText(row.expert_comment, 120),
      status_blob: scrubTalentText([
        row.comm_status,
        row.disposition_status,
        row.match_point,
        row.risk_point,
        row.verdict_label,
        row.expert_comment,
        status.status_signal,
        comment.comment_signal,
        annotation.annotation_signal,
      ].filter(Boolean).join('；'), 520),
    },
  };
}

function talentEvidenceCompleteness(history) {
  const hasResume = history.some((item) => item.has_resume);
  const hasResumeEvidence = history.some((item) => (item.evidence_refs || []).length > 0);
  const hasV1 = history.some((item) => item.has_v1_report);
  const hasInterview = history.some((item) => item.has_interview_report);
  const hasProcess = history.some((item) => Number(item.status_count || 0) > 0 || Number(item.comment_count || 0) > 0);
  const hasContactState = history.some((item) => item.has_contact_record);
  const checks = [
    { key: 'resume', label: '在线简历', known: hasResume },
    { key: 'resume_evidence', label: '工作/项目证据', known: hasResumeEvidence },
    { key: 'v1_report', label: 'V1匹配报告', known: hasV1 },
    { key: 'interview_review', label: '面试复盘', known: hasInterview },
    { key: 'process_trace', label: '流程留痕', known: hasProcess },
    { key: 'contact_state', label: '联系方式状态', known: hasContactState },
  ];
  const known = checks.filter((item) => item.known).length;
  return {
    percent: Math.round((known / checks.length) * 100),
    known,
    total: checks.length,
    known_items: checks.filter((item) => item.known).map((item) => item.label),
    unknown_items: checks.filter((item) => !item.known).map((item) => item.label),
  };
}

function deriveTalentStatus(history, completeness, latestInteractionAt) {
  const days = daysSinceTalent(latestInteractionAt);
  const hasInterview = history.some((item) => item.has_interview_report || Number(item.interview_count || 0) > 0);
  if (history.some((item) => item.disposition_code === 'do_not_contact')) return { key: 'do_not_contact', reason: '结构化处置状态为不再联系。' };
  if (history[0] && history[0].disposition_code === 'candidate_withdrew') {
    return { key: 'cooling', reason: '候选人最近一次记录为主动放弃；重新触达前请由 HR 确认当前意愿。' };
  }
  const recentTouched = days != null && days <= 30 && history.some((item) => item.communication_code && item.communication_code !== 'not_contacted');
  if (recentTouched) return { key: 'cooling', reason: '近 30 天已有触达或流程推进，避免重复打扰。' };
  if (days != null && days > 180) return { key: 'data_stale', reason: `最近可识别互动距今约 ${days} 天，需先确认信息有效性。` };
  const hasResume = history.some((item) => item.has_resume);
  const hasResumeEvidence = history.some((item) => (item.evidence_refs || []).length > 0);
  if (!hasResume || !hasResumeEvidence) return { key: 'need_info', reason: '缺少在线简历或工作/项目证据，先补资料再判断。' };
  const silver = hasInterview || history.some((item) => item.disposition_code === 'talent_pool');
  if (silver) return { key: 'silver', reason: '已有确认面试报告，或结构化处置状态为人才库。' };
  if (history.some((item) => item.disposition_code === 'rejected')) return { key: 'role_mismatch', reason: '结构化处置状态显示当时岗位未推进；新岗位仍需人工复核。' };
  return { key: 'reactivable', reason: '有可读简历证据，且未发现冷却或禁止触达信号。' };
}

function summarizeV1Signals(history) {
  const reports = history.map((item) => item.v1_report).filter(Boolean);
  const latest = reports[0] || null;
  if (!latest) return { matches: [], unknowns: [], risks: [] };
  const matches = (latest.dimension_matches || [])
    .filter((item) => item.state === 'Match')
    .slice(0, 2)
    .map((item) => {
      const fact = scrubTalentText(item.explanation && item.explanation.fact, 120);
      const judgment = scrubTalentText(item.explanation && item.explanation.judgment, 120);
      const impact = scrubTalentText(item.explanation && item.explanation.impact, 120);
      return {
        dimension: scrubTalentText(item.dimension, 60),
        fact: hasTalentDecisionText(fact) ? fact : '',
        judgment: hasTalentDecisionText(judgment) ? judgment : '',
        impact: hasTalentDecisionText(impact) ? impact : '',
        evidence: (item.evidence || [])
          .map((e) => scrubTalentText(e.text, 100))
          .filter((value) => value && hasTalentDecisionText(value))
          .slice(0, 1),
      };
    });
  const unknowns = [
    ...(latest.unknowns || []).map((item) => scrubTalentText(item.dimension || item.point || item.reason, 90)),
    ...(latest.dimension_matches || []).filter((item) => item.state === 'Unknown').map((item) => scrubTalentText(item.dimension, 80)),
  ].filter(Boolean).slice(0, 4);
  const risks = (latest.risks || [])
    .map((item) => scrubTalentText(item.point || item.reason || item.risk, 120))
    .filter((item) => item && hasTalentDecisionText(item))
    .slice(0, 4);
  return { matches, unknowns, risks };
}

function buildTalentRecommendation(talent, activeJob, jobTokens) {
  const evidenceItems = talent.history.flatMap((item) => item.evidence_refs || []);
  const v1 = summarizeV1Signals(talent.history);
  const reasons = [];
  const unknowns = [];
  const risks = [];
  const uncertainties = [];
  const matchedEvidence = [];
  if (jobTokens.length && evidenceItems.length) {
    evidenceItems.forEach((item) => {
      const token = jobTokens.find((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(item.text));
      if (token && matchedEvidence.length < 2) matchedEvidence.push({ token, item });
    });
  }
  matchedEvidence.forEach(({ token, item }) => {
    reasons.push({
      source: item.source,
      fact: `简历证据提到：${item.text}`,
      judgment: `与当前职位关键词「${token}」有交集。`,
      impact: '可作为再发现线索，但只代表历史资料，需要 HR 人工确认仍然有效。',
    });
  });
  const hasCurrentJobEvidence = matchedEvidence.length > 0;
  if (hasCurrentJobEvidence) {
    v1.matches.forEach((item) => {
      if (reasons.length >= 3) return;
      reasons.push({
        source: '历史V1报告',
        fact: item.fact || (item.evidence && item.evidence[0]) || `历史报告维度「${item.dimension}」为 Match。`,
        judgment: item.judgment || '历史岗位下存在明确匹配判断。',
        impact: `${item.impact || '可作为辅助参考。'} 历史 V1 报告不直接等同当前岗位结论。`,
      });
    });
  }
  if (!reasons.length && evidenceItems.length) {
    reasons.push({
      source: '简历证据',
      fact: `可读证据：${evidenceItems[0].text}`,
      judgment: '当前职位关键词不足或未命中，暂不做强匹配判断。',
      impact: '保留为人工复核线索，页面不伪造匹配结论。',
    });
  }
  if (!jobTokens.length) unknowns.push('当前职位画像或岗位关键词不足，跨岗位匹配为 Unknown。');
  if (!evidenceItems.length) unknowns.push('缺少工作/项目证据，不能判断能力匹配。');
  if (!talent.has_v1_report) unknowns.push('没有 V1 候选人匹配报告；Unknown 不扣分，不补写结论。');
  else if (!talent.has_confirmed_v1_report) unknowns.push('有 V1 报告，但岗位画像确认态不足；不作为强推荐依据。');
  if (!talent.has_interview_report) unknowns.push('没有已确认面试复盘，无法引用面试表现。');
  if (!talent.contact_state.has_record) unknowns.push('联系方式状态未确认；API 不返回明文联系方式。');
  if (talent.contact_state.needs_consent_check) unknowns.push('再触达授权、退订/删除请求状态未确认。');
  v1.unknowns.forEach((item) => { if (unknowns.length < 6) unknowns.push(item); });
  talent.history.forEach((item) => {
    textListFromTalent(item.risk_summary || item.expert_summary, 2).forEach((risk) => {
      if (risks.length < 5) risks.push(risk);
    });
    if (item.resume_paywalled && risks.length < 5) risks.push('存在付费墙或不可读简历记录。');
  });
  v1.risks.forEach((risk) => { if (risks.length < 5) risks.push(risk); });
  if (talent.pool_status === 'cooling') risks.unshift('冷却中：近期已触达，不建议重复打扰。');
  if (talent.pool_status === 'do_not_contact') risks.unshift('不建议触达：需尊重历史拒绝或流程限制。');
  if (talent.pool_status === 'data_stale') risks.unshift('数据过期：需先确认候选人近况和资料有效性。');
  [
    '当前是否仍在看机会：Unknown',
    '上次未推进原因需 HR 人工确认',
    '再触达授权和联系方式来源需 HR 人工确认',
    '城市、薪资、到岗时间不进入人才库自动判断',
  ].forEach((item) => uncertainties.push(item));
  const sourceJob = talent.latest_job && talent.latest_job.name ? scrubTalentText(talent.latest_job.name, 80) : '历史岗位';
  const jobName = activeJob && activeJob.name ? scrubTalentText(activeJob.name, 80) : '当前岗位';
  const evidenceLine = reasons[0] && reasons[0].fact ? reasons[0].fact.replace(/^简历证据提到：/, '') : '历史资料里有可进一步确认的经历';
  const relation = talent.relationship_context || {};
  const greeting = relation.has_interview
    ? `你好 ${talent.name || '候选人'}，我是之前与你沟通过「${sourceJob}」并安排过面试的 HR。`
    : relation.has_communication
      ? `你好 ${talent.name || '候选人'}，我是之前与你沟通过「${sourceJob}」机会的 HR。`
      : `你好 ${talent.name || '候选人'}，我们之前在招聘流程中留存过你投递/推荐到「${sourceJob}」的资料。`;
  const draft = [
    greeting,
    `最近我们有一个「${jobName}」方向，看到你过往资料中「${scrubTalentText(evidenceLine, 72)}」，想先人工确认你近期是否还看相关机会。`,
    '如果你暂时不方便被联系，直接告诉我即可，我会记录为不再触达。',
    'HR发送前请核对：上次未推进原因、候选人意愿、联系方式来源和资料有效期。',
  ].join('\n');
  let group = 'cultivate';
  const hasReviewEvidence = talent.has_confirmed_v1_report || talent.has_interview_report || relation.has_positive_process_signal;
  if (['silver', 'reactivable'].includes(talent.pool_status) && reasons.length && hasCurrentJobEvidence && hasReviewEvidence) group = 'strong';
  if (['need_info', 'data_stale', 'role_mismatch'].includes(talent.pool_status)) group = 'needs_evidence';
  if (['cooling', 'do_not_contact'].includes(talent.pool_status)) group = 'not_recommended';
  return {
    group,
    group_label: {
      strong: '强推荐',
      cultivate: '可培养',
      needs_evidence: '待补证据',
      not_recommended: '不建议触达',
    }[group],
    reasons,
    unknowns: [...new Set(unknowns.filter(Boolean))].slice(0, 6),
    risks: [...new Set(risks.filter(Boolean))].slice(0, 6),
    uncertainties: [...new Set(uncertainties.filter(Boolean))].slice(0, 5),
    next_step: TALENT_POOL_STATUS_META.find((item) => item.key === talent.pool_status)?.action || '人工复核',
    outreach_draft: draft,
  };
}

function buildTalentRecord(group, index, activeJob, jobTokens) {
  const sorted = group.history.sort((a, b) => (
    talentDateMs(b.last_interaction_at || b.data_observed_at) || 0
  ) - (
    talentDateMs(a.last_interaction_at || a.data_observed_at) || 0
  ));
  const latest = sorted[0];
  const completeness = talentEvidenceCompleteness(sorted);
  const latestInteractionAt = latestTalentTime(sorted.map((item) => item.last_interaction_at));
  const latestDataObservedAt = latestTalentTime(sorted.map((item) => item.data_observed_at));
  const status = deriveTalentStatus(sorted, completeness, latestInteractionAt || latestDataObservedAt);
  const hasStructuredCommunication = sorted.some((item) => item.communication_code && item.communication_code !== 'not_contacted');
  const hasStructuredInterview = sorted.some((item) => item.has_interview_report || Number(item.interview_count || 0) > 0);
  const firstEvidence = sorted.flatMap((item) => item.evidence_refs || []).slice(0, 4);
  const contactTypes = [...new Set(sorted.flatMap((item) => item.contact_types || []))];
  const hasContactRecord = sorted.some((item) => item.has_contact_record);
  const hasValidContactMethod = hasContactRecord && hasValidTalentContactMethod(contactTypes);
  // The current local schema records encrypted contact channels, but has no
  // authoritative consent/opt-out verification record. Formal data therefore
  // fails closed until that evidence exists.
  const consentConfirmed = false;
  const optOutStatusConfirmed = false;
  const contactState = {
    has_record: hasContactRecord,
    has_valid_contact_method: hasValidContactMethod,
    consent_confirmed: consentConfirmed,
    opt_out_status_confirmed: optOutStatusConfirmed,
    needs_consent_check: !consentConfirmed || !optOutStatusConfirmed,
    label: hasContactRecord
      ? hasValidContactMethod
        ? '已记录有效联系方式，明文已隐藏；再触达授权及退订状态待人工确认'
        : '已记录联系方式，但联系渠道有效性待确认；再触达授权及退订状态待人工确认'
      : '未记录有效联系方式；再触达授权及退订状态待确认',
    types: contactTypes,
    sources: [...new Set(sorted.flatMap((item) => item.contact_sources || []))],
    confidences: [...new Set(sorted.flatMap((item) => item.contact_confidences || []))],
  };
  contactState.contact_ready = talentContactReady(status.key, contactState);
  const tokens = extractTalentTokens([
    latest.summary.self_summary,
    sorted.map((item) => item.evidence_refs.map((e) => e.text).join(' ')).join(' '),
    sorted.map((item) => item.rec_position).join(' '),
  ].join(' '), 8);
  const talent = {
    pool_id: `TP-${latest.candidate_id}`,
    display_id: `TP-${String(index + 1).padStart(3, '0')}`,
    primary_candidate_id: latest.candidate_id,
    name: scrubTalentText(group.name || latest.name || '未命名人才', 60),
    latest_job: {
      candidate_id: latest.candidate_id,
      job_id: latest.job_id,
      name: latest.job_name,
      source: latest.source,
      last_interaction_at: latest.last_interaction_at,
      data_observed_at: latest.data_observed_at,
    },
    historical_job_count: new Set(sorted.map((item) => item.job_id)).size,
    candidate_record_count: sorted.length,
    last_interaction_at: latestInteractionAt,
    data_observed_at: latestDataObservedAt,
    pool_status: status.key,
    pool_status_label: TALENT_POOL_STATUS_META.find((item) => item.key === status.key)?.label || status.key,
    pool_status_reason: status.reason,
    core_tags: tokens,
    evidence_completeness: completeness,
    has_v1_report: sorted.some((item) => item.has_v1_report),
    has_confirmed_v1_report: sorted.some((item) => item.has_confirmed_v1_report),
    has_interview_report: sorted.some((item) => item.has_interview_report),
    contact_state: contactState,
    identity_resolution: {
      method: sorted.length > 1 ? 'same_boss_geek_id' : 'single_candidate_record',
      confidence: sorted.length > 1 ? 'high_for_boss_records_only' : 'single_record',
      auto_merged: false,
      note: sorted.length > 1
        ? '仅对同一 Boss 加密人才标识下的记录做派生聚合；弱标识、截图导入和疑似同人不自动合并。'
        : '单条候选人记录，未做跨来源自然人合并。',
    },
    relationship_context: {
      has_communication: hasStructuredCommunication,
      has_interview: hasStructuredInterview,
      has_positive_process_signal: sorted.some((item) => ['talent_pool', 'hired'].includes(item.disposition_code)),
      last_known_relation: latest.disposition_code || latest.communication_code || 'legacy_review_required',
    },
    evidence_refs: firstEvidence,
    history: sorted.map((item) => ({
      candidate_id: item.candidate_id,
      job_id: item.job_id,
      job_name: item.job_name,
      source: item.source,
      rec_position: item.rec_position,
      created_at: item.created_at,
      last_interaction_at: item.last_interaction_at,
      data_observed_at: item.data_observed_at,
      comm_status: item.comm_status,
      disposition_status: item.disposition_status,
      has_v1_report: item.has_v1_report,
      has_confirmed_v1_report: item.has_confirmed_v1_report,
      has_interview_report: item.has_interview_report,
      evidence_refs: item.evidence_refs,
      summary: item.summary,
      risk_summary: item.raw_signals.risk_point,
      expert_summary: item.raw_signals.expert_comment,
      resume_paywalled: item.resume_paywalled,
    })),
    duplicate_hint: sorted.length > 1
      ? 'P0 按同一内部 Boss 人才标识聚合为同一人才；截图导入等弱标识不自动合并。'
      : '未发现跨岗位重复记录；P0 不做自动合并。',
  };
  talent.recommendation = activeJob ? buildTalentRecommendation(talent, activeJob, jobTokens) : null;
  return talent;
}

function buildTalentOverview(talents) {
  const recent30 = talents.filter((item) => {
    const days = daysSinceTalent(item.last_interaction_at);
    return days != null && days <= 30;
  }).length;
  const contactReviewable = talents.filter((item) => ['reactivable', 'silver'].includes(item.pool_status));
  const contactReady = contactReviewable.filter((item) => item.contact_state?.contact_ready === true).length;
  const compliance = talents.filter((item) => (
    ['cooling', 'do_not_contact', 'data_stale'].includes(item.pool_status)
    || item.contact_state?.contact_ready !== true
  )).length;
  return [
    { key: 'total', label: '历史人才', value: talents.length, hint: '按自然人派生聚合' },
    { key: 'recent30', label: '近30天互动', value: recent30, hint: '来自流程/备注/面试/更新时间' },
    { key: 'has_v1', label: '有V1初评', value: talents.filter((item) => item.has_v1_report).length, hint: '仅作证据层参考' },
    { key: 'has_interview', label: '有面试复盘', value: talents.filter((item) => item.has_interview_report).length, hint: '银牌线索优先' },
    {
      key: 'reactivable',
      label: '可进入联系复核',
      value: contactReviewable.length,
      hint: `其中 ${contactReady} 人已满足联系前置条件`,
    },
    { key: 'compliance', label: '需合规确认', value: compliance, hint: '含授权、退订、渠道、冷却、禁触达或过期检查' },
  ];
}

function statusCounts(talents) {
  return Object.fromEntries(TALENT_POOL_STATUS_META.map((item) => [
    item.key,
    talents.filter((talent) => talent.pool_status === item.key).length,
  ]));
}

function jobRecommendationScope(talents, jobId) {
  if (!jobId) return talents;
  return talents.filter((talent) => {
    const hasCurrentJobRecord = talent.history.some((item) => Number(item.job_id) === Number(jobId));
    const hasOtherJobRecord = talent.history.some((item) => Number(item.job_id) !== Number(jobId));
    return hasOtherJobRecord && !hasCurrentJobRecord;
  });
}

function sortTalents(a, b) {
  const statusDiff = (TALENT_POOL_STATUS_INDEX[a.pool_status] ?? 99) - (TALENT_POOL_STATUS_INDEX[b.pool_status] ?? 99);
  if (statusDiff !== 0) return statusDiff;
  return (talentDateMs(b.last_interaction_at || b.data_observed_at) || 0) - (talentDateMs(a.last_interaction_at || a.data_observed_at) || 0);
}

function buildJobRecommendations(talents, jobId) {
  return jobRecommendationScope(talents, jobId)
    .map((talent) => ({
      pool_id: talent.pool_id,
      primary_candidate_id: talent.primary_candidate_id,
      name: talent.name,
      pool_status: talent.pool_status,
      pool_status_label: talent.pool_status_label,
      group: talent.recommendation.group,
      group_label: talent.recommendation.group_label,
      latest_job: talent.latest_job,
      historical_job_count: talent.historical_job_count,
      last_interaction_at: talent.last_interaction_at,
      data_observed_at: talent.data_observed_at,
      reason_preview: talent.recommendation.reasons[0] || null,
      unknowns: talent.recommendation.unknowns.slice(0, 3),
      risks: talent.recommendation.risks.slice(0, 3),
      next_step: talent.recommendation.next_step,
    }))
    .sort((a, b) => {
      const groupOrder = { strong: 0, cultivate: 1, needs_evidence: 2, not_recommended: 3 };
      const groupDiff = (groupOrder[a.group] ?? 9) - (groupOrder[b.group] ?? 9);
      if (groupDiff !== 0) return groupDiff;
      return (TALENT_POOL_STATUS_INDEX[a.pool_status] ?? 99) - (TALENT_POOL_STATUS_INDEX[b.pool_status] ?? 99);
    });
}

function fixtureTalentPool(jobId, jobs) {
  const activeJob = jobs.find((item) => Number(item.id) === Number(jobId)) || jobs[0] || { id: jobId || null, name: '当前岗位' };
  const recommendationJob = activeJob && activeJob.status !== 'closed' ? activeJob : null;
  const now = '2026-07-10T09:00:00.000Z';
  const statuses = TALENT_POOL_STATUS_META.map((meta, index) => {
    const latest = new Date(Date.parse(now) - index * 12 * 24 * 60 * 60 * 1000).toISOString();
    const hasContactRecord = !['need_info', 'data_stale'].includes(meta.key);
    const consentConfirmed = meta.key === 'reactivable';
    const optOutStatusConfirmed = meta.key === 'reactivable';
    const contactState = {
      has_record: hasContactRecord,
      has_valid_contact_method: hasContactRecord,
      consent_confirmed: consentConfirmed,
      opt_out_status_confirmed: optOutStatusConfirmed,
      needs_consent_check: !consentConfirmed || !optOutStatusConfirmed,
      label: !hasContactRecord
        ? '未记录有效联系方式；再触达授权及退订状态待确认'
        : consentConfirmed && optOutStatusConfirmed
          ? '测试样例：有效联系方式、再触达授权及退订状态均已确认'
          : '已记录有效联系方式，明文已隐藏；再触达授权及退订状态待人工确认',
      types: hasContactRecord ? ['mobile'] : [],
      sources: hasContactRecord ? ['fixture'] : [],
      confidences: hasContactRecord ? ['demo'] : [],
    };
    contactState.contact_ready = talentContactReady(meta.key, contactState);
    const talent = {
      pool_id: `TP-DEMO-${index + 1}`,
      display_id: `TP-${String(index + 1).padStart(3, '0')}`,
      primary_candidate_id: null,
      name: ['陈同学', '李女士', '王先生', '赵同学', '周女士', '郑先生', '钱女士'][index],
      latest_job: { candidate_id: null, job_id: activeJob.id, name: scrubTalentText(activeJob.name || '历史岗位', 80), source: 'fixture', last_interaction_at: latest },
      historical_job_count: index === 1 ? 2 : 1,
      candidate_record_count: index === 1 ? 2 : 1,
      last_interaction_at: latest,
      pool_status: meta.key,
      pool_status_label: meta.label,
      pool_status_reason: {
        reactivable: 'Demo：有简历证据，未发现冷却或禁触达信号。',
        silver: 'Demo：历史面试表现不错，但当时未推进。',
        role_mismatch: 'Demo：当时岗位不合适，但可按新岗位人工复核。',
        cooling: 'Demo：近 30 天已触达，需要等待冷却。',
        do_not_contact: 'Demo：历史记录标记不建议触达。',
        need_info: 'Demo：缺少在线简历或关键证据。',
        data_stale: 'Demo：资料超过 180 天未更新。',
      }[meta.key],
      core_tags: ['电商', '运营', '数据'].slice(0, Math.max(1, 3 - (index % 3))),
      evidence_completeness: {
        percent: meta.key === 'need_info' ? 33 : meta.key === 'data_stale' ? 50 : 83,
        known: meta.key === 'need_info' ? 2 : meta.key === 'data_stale' ? 3 : 5,
        total: 6,
        known_items: ['在线简历', '工作/项目证据'],
        unknown_items: meta.key === 'need_info' ? ['V1匹配报告', '面试复盘', '联系方式状态'] : ['当前意愿'],
      },
      has_v1_report: index < 3,
      has_confirmed_v1_report: index < 2,
      has_interview_report: meta.key === 'silver',
      contact_state: contactState,
      relationship_context: {
        has_communication: meta.key === 'cooling' || meta.key === 'silver',
        has_interview: meta.key === 'silver',
        has_positive_process_signal: meta.key === 'silver',
        last_known_relation: 'fixture demo',
      },
      identity_resolution: {
        method: 'fixture',
        confidence: 'demo_only',
        auto_merged: false,
        note: 'Demo fixture，不做自动合并。',
      },
      evidence_refs: [{ id: `demo-${index}`, source: 'resume_fact', text: '历史资料提到电商运营、数据复盘或项目交付经历。' }],
      history: [{
        candidate_id: null,
        job_id: activeJob.id,
        job_name: scrubTalentText(activeJob.name || '历史岗位', 80),
        source: 'fixture_fallback',
        rec_position: '历史候选人再发现 Demo',
        created_at: latest,
        last_interaction_at: latest,
        data_observed_at: latest,
        comm_status: meta.key === 'cooling' ? '已沟通' : '未打招呼',
        disposition_status: meta.label,
        has_v1_report: index < 3,
        has_confirmed_v1_report: index < 2,
        has_interview_report: meta.key === 'silver',
        evidence_refs: [{ id: `demo-${index}`, source: 'resume_fact', text: '历史资料提到电商运营、数据复盘或项目交付经历。' }],
        summary: { education: 'Unknown', work_experience: 'Unknown', self_summary: 'Demo fixture，不含真实候选人数据。' },
        resume_paywalled: false,
      }],
      duplicate_hint: 'Demo fixture，不做自动合并。',
    };
    talent.recommendation = recommendationJob
      ? buildTalentRecommendation(talent, recommendationJob, extractTalentTokens(scrubTalentText(recommendationJob.name, 1000)))
      : null;
    return talent;
  });
  return {
    schema_version: 'talent_pool_p0_v1',
    source: 'fixture_fallback',
    generated_at: nowIso(),
    active_job: activeJob ? {
      id: activeJob.id,
      name: scrubTalentText(activeJob.name || `岗位 ${activeJob.id}`, 80),
      status: activeJob.status,
    } : null,
    statuses: TALENT_POOL_STATUS_META,
    overview: buildTalentOverview(statuses),
    status_counts: statusCounts(statuses),
    talents: statuses,
    job_recommendations: recommendationJob ? buildJobRecommendations(statuses, recommendationJob.id) : [],
    compliance_notes: [
      'Fixture fallback 仅用于本地 Demo，不含真实个人数据。',
      '再触达草稿只保存于页面状态，不发送消息。',
      '联系方式只展示状态，不返回明文。',
    ],
  };
}

function emptyTalentPool(jobId, jobs) {
  const activeJob = jobs.find((item) => Number(item.id) === Number(jobId)) || jobs[0] || null;
  return {
    schema_version: 'talent_pool_p0_v1',
    source: 'local_db_empty',
    generated_at: nowIso(),
    active_job: activeJob ? {
      id: activeJob.id,
      name: scrubTalentText(activeJob.name || `岗位 ${activeJob.id}`, 80),
      status: activeJob.status,
    } : null,
    statuses: TALENT_POOL_STATUS_META,
    overview: buildTalentOverview([]),
    status_counts: statusCounts([]),
    talents: [],
    job_recommendations: [],
    compliance_notes: [
      '当前本地库暂无候选人，人才库保持空态，不混入真实数据。',
      '可加载 Demo 样例验证页面结构；Demo 不含真实候选人数据。',
      '再触达草稿只保存于页面状态，不发送消息。',
    ],
  };
}

function listTalentPool(options = {}) {
  const database = conn();
  const rawJobId = options.job_id === undefined ? options.jobId : options.job_id;
  const jobId = rawJobId === undefined || rawJobId === null || rawJobId === '' ? null : Number(rawJobId);
  const jobs = listJobs().filter((item) => options.fixture || Number(item.is_fixture) !== 1);
  const activeJob = jobId ? jobs.find((item) => Number(item.id) === Number(jobId)) : (jobs[0] || null);
  if (options.fixture || options.fixtureFallback || options.demo) return fixtureTalentPool(jobId, jobs);
  const rows = database.prepare(`
    SELECT
      c.geek_id AS _group_key,
      c.internal_id, c.job_id, c.source, c.rec_position, c.last_ts,
      c.name, c.degree, c.school, c.school_tier, c.work_years, c.geek_desc,
      c.match_point, c.risk_point, c.verdict_label, c.expert_comment,
      c.comm_status, c.disposition_status, c.communication_code, c.disposition_code, c.created_at, c.updated_at,
      j.name AS job_name,
      r.sections_json, r.is_paywalled, r.fetched_at
    FROM candidate c
    JOIN job j ON j.id = c.job_id AND COALESCE(j.is_fixture, 0) = 0 AND c.source <> 'fixture'
    LEFT JOIN resume_online r ON r.candidate_id = c.internal_id
    ORDER BY c.updated_at DESC, c.created_at DESC, c.internal_id DESC
  `).all();
  if (!rows.length) return emptyTalentPool(jobId, jobs);

  const candidateIds = rows.map((row) => row.internal_id);
  const related = readTalentRelatedData(database, candidateIds);
  const groups = new Map();
  rows.forEach((row) => {
    const key = cleanTalentText(row._group_key) || row.internal_id;
    if (!groups.has(key)) groups.set(key, { name: row.name, history: [] });
    const group = groups.get(key);
    if (!group.name && row.name) group.name = row.name;
    const history = buildTalentHistory(row, related);
    history.name = row.name;
    group.history.push(history);
  });

  const recommendationJob = activeJob && activeJob.status !== 'closed' ? activeJob : null;
  let profile = null;
  if (recommendationJob) {
    try {
      profile = currentJobProfileContext(database, recommendationJob.id).config;
    } catch {
      // Talent-pool browsing remains available, but recommendations must not
      // reuse a stale profile after the active JD changes.
      profile = null;
    }
  }
  const jobTokens = extractTalentTokens(scrubTalentText(
    [recommendationJob && recommendationJob.name, profileTextForTalent(profile)].filter(Boolean).join(' '),
    4000,
  ), 10);
  const talents = Array.from(groups.values())
    .map((group, index) => buildTalentRecord(group, index, recommendationJob, jobTokens))
    .sort(sortTalents);
  return {
    schema_version: 'talent_pool_p0_v1',
    source: 'local_db',
    generated_at: nowIso(),
    active_job: activeJob ? {
      id: activeJob.id,
      name: scrubTalentText(activeJob.name || `岗位 ${activeJob.id}`, 80),
      status: activeJob.status,
    } : null,
    statuses: TALENT_POOL_STATUS_META,
    overview: buildTalentOverview(talents),
    status_counts: statusCounts(talents),
    talents,
    job_recommendations: recommendationJob ? buildJobRecommendations(talents, recommendationJob.id) : [],
    compliance_notes: [
      '人才库 P0 只读派生，不写人才主档案。',
      '推荐依据遵循 V1 证据层：事实、Unknown、事实->判断->影响。',
      '不返回 Boss 钥匙字段，不返回联系方式明文，不自动发送再触达消息。',
    ],
  };
}

function addTalentToJob(input = {}) {
  const database = conn();
  const actor = requiredLocalActor(input.actor);
  const sourceCandidateId = text(input.sourceCandidateId === undefined
    ? input.source_candidate_id
    : input.sourceCandidateId);
  const targetJobId = Number(input.jobId === undefined ? input.job_id : input.jobId);
  if (!sourceCandidateId) {
    throw jobOperationError('TALENT_SOURCE_REQUIRED', '请选择要加入岗位的历史候选人。');
  }

  return database.transaction(() => {
    const targetJob = assertJobRecruitingWritable(database, targetJobId);
    if (Number(targetJob.is_fixture) === 1) {
      throw jobOperationError('JOB_FIXTURE_READ_ONLY', '样例岗位不允许加入正式候选人。', 403);
    }

    const source = database.prepare(`
      SELECT candidate.*, job.is_fixture AS source_job_fixture
      FROM candidate
      JOIN job ON job.id = candidate.job_id
      WHERE candidate.internal_id = ?
    `).get(sourceCandidateId);
    if (!source) {
      throw jobOperationError('TALENT_SOURCE_NOT_FOUND', '历史候选人记录不存在。', 404);
    }
    if (!text(source.geek_id)) {
      throw jobOperationError('TALENT_IDENTITY_UNAVAILABLE', '该历史记录缺少可复用的人才标识，不能建立跨岗位关系。', 409);
    }
    if (Number(source.source_job_fixture) === 1 || source.source === 'fixture') {
      throw jobOperationError('TALENT_FIXTURE_READ_ONLY', '样例人才不能加入正式岗位。', 403);
    }

    const existing = database.prepare(`
      SELECT internal_id, disposition_code, disposition_status
      FROM candidate
      WHERE geek_id = ? AND job_id = ?
    `).get(source.geek_id, targetJob.id);
    if (existing) {
      const doNotContactPreserved = existing.disposition_code === 'do_not_contact'
        || (!existing.disposition_code && existing.disposition_status === '不再联系');
      return {
        candidate: getCandidate(existing.internal_id),
        inserted: false,
        already_exists: true,
        do_not_contact_preserved: doNotContactPreserved,
        resume_snapshot_copied: false,
        source_candidate_id: sourceCandidateId,
        job_id: targetJob.id,
      };
    }

    const doNotContact = !!database.prepare(`
      SELECT internal_id
      FROM candidate
      WHERE geek_id = ?
        AND (
          disposition_code = 'do_not_contact'
          OR (disposition_code IS NULL AND disposition_status = '不再联系')
        )
      LIMIT 1
    `).get(source.geek_id);

    const timestamp = nowIso();
    const relation = upsertCandidateTx(database)({
      job_id: targetJob.id,
      geek_id: source.geek_id,
      relation_type: 'talent_pool_reentry',
      source: '人才库再加入',
      rec_position: targetJob.name,
      name: source.name,
      age: source.age,
      degree: source.degree,
      degree_verified: source.degree_verified,
      school: source.school,
      school_tier: source.school_tier,
      work_years: source.work_years,
      salary: source.salary,
      geek_desc: source.geek_desc,
      comm_status: '未打招呼',
      disposition_status: doNotContact ? '不再联系' : '新入库',
      communication_code: 'not_contacted',
      disposition_code: doNotContact ? 'do_not_contact' : 'new',
    }, timestamp);

    const resume = database.prepare(`
      SELECT resume.id, resume.sections_json, resume.is_paywalled, resume.fetched_at
      FROM candidate historical
      JOIN resume_online resume ON resume.candidate_id = historical.internal_id
      WHERE historical.geek_id = ?
        AND resume.sections_json IS NOT NULL
        AND COALESCE(resume.is_paywalled, 0) = 0
      ORDER BY resume.fetched_at DESC, resume.id DESC
      LIMIT 1
    `).get(source.geek_id);
    if (resume) {
      database.prepare(`
        INSERT INTO resume_online (candidate_id, sections_json, is_paywalled, raw_json, fetched_at)
        VALUES (?, ?, 0, NULL, ?)
      `).run(relation.internal_id, resume.sections_json, resume.fetched_at || timestamp);
    }

    if (f018RuntimeEnabled
        && database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'application_episode'").get()) {
      const applicationService = createF018ApplicationService({
        database,
        actorContext: { actor_id: actor },
      });
      const application = applicationService.openApplication({
        candidate_id: relation.internal_id,
        job_id: targetJob.id,
        request_id: `talent-pool.add.${relation.internal_id}`,
        reason_code: 'talent_pool_manual_add_to_job',
      });
      if (doNotContact) {
        applicationService.closeApplication({
          application_id: application.id,
          expected_version: application.version,
          request_id: `talent-pool.dnc.${relation.internal_id}`,
          reason_code: 'talent_pool_do_not_contact_preserved',
        });
      }
    }

    writeAuditLog({
      action: '人才库加入岗位',
      target: relation.internal_id,
      who: actor,
      auto: 0,
      result: '成功',
      detail_json: JSON.stringify({
        source_candidate_id: sourceCandidateId,
        job_id: targetJob.id,
        resume_snapshot_copied: !!resume,
        copied_history: false,
        do_not_contact_preserved: doNotContact,
      }),
      created_at: timestamp,
    });

    return {
      candidate: getCandidate(relation.internal_id),
      inserted: true,
      already_exists: false,
      do_not_contact_preserved: doNotContact,
      resume_snapshot_copied: !!resume,
      source_candidate_id: sourceCandidateId,
      job_id: targetJob.id,
    };
  })();
}

function resolveCandidateScreenshot(internalId) {
  const database = conn();
  const row = database.prepare(`
    SELECT c.source AS candidate_source, r.sections_json
    FROM candidate c
    LEFT JOIN resume_online r ON r.candidate_id = c.internal_id
    WHERE c.internal_id = ?
    ORDER BY r.id
    LIMIT 1
  `).get(internalId);
  if (!row || row.candidate_source !== '截图导入') return null;
  const sections = parseJson(row.sections_json);
  const stitchedFile = sections && sections.source === 'boss_app_screenshot' ? text(sections.stitched_file) : null;
  if (!stitchedFile) return null;
  const allowedRoots = [SCREENSHOT_STITCHED_DIR, SCREENSHOT_EVIDENCE_BATCHES_DIR]
    .filter((root) => fs.existsSync(root))
    .map((root) => fs.realpathSync(root));
  if (!allowedRoots.length) return null;

  const candidatePaths = path.isAbsolute(stitchedFile)
    ? [stitchedFile]
    : [path.resolve(DEFAULT_DATA_DIR, stitchedFile), path.resolve(__dirname, stitchedFile)];
  const candidatePath = candidatePaths.find((file) => fs.existsSync(file));
  if (!candidatePath) return null;
  if (!fs.existsSync(candidatePath)) return null;
  const real = fs.realpathSync(candidatePath);
  if (!allowedRoots.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) return null;
  if (!/\.(jpe?g|png|webp)$/i.test(real)) return null;
  const ext = path.extname(real).toLowerCase();
  const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return { path: real, content_type: contentType, file_name: path.basename(real) };
}

function getLatestRun() {
  return conn().prepare(`
    SELECT id, run_type, account, job, status, count_new, count_total, error_summary, started_at, finished_at
    FROM run_log
    ORDER BY id DESC
    LIMIT 1
  `).get();
}

function getLatestRunByType(runType) {
  return conn().prepare(`
    SELECT id, run_type, account, job, status, count_new, count_total, error_summary, started_at, finished_at
    FROM run_log
    WHERE run_type = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(text(runType));
}

function getCircuitBreakers() {
  return conn().prepare(`
    SELECT account, state, reason_code, reason_text, consecutive_failures, cooldown_until, stopped_at, updated_at
    FROM circuit_breaker
    ORDER BY updated_at DESC, account
  `).all();
}

function getWriteActions(candidateId) {
  return conn().prepare(`
    SELECT id, action_type, status, boss_code, decision, attempt, result_json, created_at, updated_at, executed_at
    FROM write_action
    WHERE candidate_id = ?
    ORDER BY id DESC
  `).all(candidateId);
}

function getJobProfile(jobId) {
  const row = conn().prepare('SELECT config_json FROM job_profile WHERE job_id = ?').get(jobId);
  if (!row || !row.config_json) return defaultProfile();
  try {
    return JSON.parse(row.config_json);
  } catch {
    return defaultProfile();
  }
}

function upsertJobProfile(jobId, config) {
  return conn().prepare(`
    INSERT INTO job_profile (job_id, config_json, updated_at)
    VALUES (@job_id, @config_json, @updated_at)
    ON CONFLICT(job_id) DO UPDATE SET
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
  `).run({
    job_id: jobId,
    config_json: JSON.stringify(config || defaultProfile()),
    updated_at: nowIso(),
  });
}

// UI 保存简版画像（rubric + hard_bars）专用：客户端传来的 deep_profile 一律不认，
// 深度画像只允许 generateDeepProfileForJob / confirmDeepProfile 这两条专用路径写，
// 防止前端整对象覆盖时把深度画像抹掉。
function upsertJobProfilePreservingDeep(jobId, config) {
  const merged = { ...(config || {}) };
  delete merged.deep_profile;
  const existing = getJobProfile(jobId);
  if (existing && existing.deep_profile) merged.deep_profile = existing.deep_profile;
  return upsertJobProfile(jobId, merged);
}

function insertInterview(input) {
  const jobId = Number(input.job_id);
  if (!jobId) throw new Error('job_id required');
  assertJobRecruitingWritable(conn(), jobId);
  const transcript = text(input.transcript);
  if (!transcript || !transcript.trim()) throw new Error('访谈内容为空，粘贴转写文本后再保存。');
  const sourceType = interviewSourceTypeValue(input.source_type);
  const sourceUrl = text(input.source_url);
  const info = conn().prepare(`
    INSERT INTO job_interview (job_id, source_url, transcript, note, source_type, created_at)
    VALUES (@job_id, @source_url, @transcript, @note, @source_type, @created_at)
  `).run({
    job_id: jobId,
    source_url: sourceUrl,
    transcript,
    note: text(input.note) || '负责人访谈',
    source_type: sourceType,
    created_at: text(input.created_at) || nowIso(),
  });
  const id = Number(info.lastInsertRowid);
  writeAuditLog({
    action: '访谈入库',
    target: String(jobId),
    who: 'HR',
    auto: 0,
    result: '成功',
    detail_json: JSON.stringify({
      interview_id: id,
      note: text(input.note) || '负责人访谈',
      ...auditSafeSourceUrl(sourceUrl),
      source_type: sourceType,
      chars: transcript.length,
    }),
  });
  return { id, source_type: sourceType };
}

function listInterviews(jobId) {
  return conn().prepare(`
    SELECT id, job_id, source_url, note, source_type, created_at, transcript
    FROM job_interview
    WHERE job_id = ?
    ORDER BY id
  `).all(jobId);
}

function insertAiReview(input) {
  const info = conn().prepare(`
    INSERT INTO ai_review (candidate_id, job_id, profile_confirmed, report_json, created_at)
    VALUES (@candidate_id, @job_id, @profile_confirmed, @report_json, @created_at)
  `).run({
    candidate_id: text(input.candidate_id),
    job_id: Number(input.job_id),
    profile_confirmed: input.profile_confirmed ? 1 : 0,
    report_json: text(input.report_json),
    created_at: text(input.created_at) || nowIso(),
  });
  return { id: Number(info.lastInsertRowid) };
}

function listAiReviews(candidateId) {
  return conn().prepare(`
    SELECT id, candidate_id, job_id, profile_confirmed, report_json, created_at
    FROM ai_review
    WHERE candidate_id = ?
    ORDER BY id DESC
  `).all(candidateId);
}

function latestV1Review(database, candidateId) {
  const rows = database.prepare(`
    SELECT id, profile_confirmed, report_json, created_at
    FROM ai_review
    WHERE candidate_id = ?
    ORDER BY id DESC
  `).all(candidateId);
  for (const row of rows) {
    const report = parseJson(row.report_json);
    if (isCandidateReportV1(report)) return { row, report };
  }
  return null;
}

function assessStatusForRows({ candidate, resume, v1Review, externalAi, profileContext = null, profileError = null }) {
  const aiStatus = externalAi || ratingLlm.externalAiStatus();
  const configPresent = !!aiStatus.config_present;
  const candidateFound = !!candidate;
  const hasResumeRow = !!resume;
  const isPaywalled = !!(resume && Number(resume.is_paywalled) === 1);
  const hasReadableResume = hasResumeRow && !isPaywalled;
  const hasV1Report = !!v1Review;
  const latestReport = v1Review && v1Review.report;
  const blockers = [];
  if (!candidateFound) blockers.push('候选人不存在。');
  if (candidateFound && profileError) blockers.push(profileError.message);
  if (candidateFound && !hasResumeRow) blockers.push('缺少在线简历，先拉取在线简历再生成 V1 报告。');
  if (candidateFound && isPaywalled) blockers.push('在线简历处于付费墙状态，不能生成 V1 报告。');
  if (candidateFound && hasReadableResume && !aiStatus.policy_valid) {
    blockers.push(...aiStatus.blockers);
  }
  return {
    candidate_found: candidateFound,
    candidate_id: candidate ? candidate.internal_id : null,
    has_resume: hasResumeRow,
    is_paywalled: isPaywalled,
    has_v1_report: hasV1Report,
    latest_report_is_local_demo: !!(latestReport && isLocalDemoReport(latestReport)),
    rating_config_present: !!configPresent,
    ai_config_present: !!configPresent,
    external_ai_enabled: !!aiStatus.enabled,
    external_ai_policy_valid: !!aiStatus.policy_valid,
    external_ai_provider: aiStatus.provider,
    external_ai_host: aiStatus.host,
    current_profile_ready: candidateFound && !profileError,
    current_profile_error_code: profileError && profileError.code ? profileError.code : null,
    current_jd_version_id: profileContext && profileContext.activeJd ? Number(profileContext.activeJd.id) : null,
    current_profile_version_id: profileContext && profileContext.profileVersion ? Number(profileContext.profileVersion.id) : null,
    can_real_assess: candidateFound && !profileError && hasReadableResume && !!aiStatus.policy_valid,
    can_local_demo: candidateFound && !profileError && hasReadableResume,
    blockers,
  };
}

function getAssessStatus(candidateId, externalAiStatus = null) {
  const database = conn();
  const id = text(candidateId);
  if (!id) throw new Error('candidateId required');
  const candidate = database.prepare('SELECT internal_id, job_id FROM candidate WHERE internal_id = ?').get(id);
  const externalAi = externalAiStatus || ratingLlm.externalAiStatus();
  if (!candidate) return assessStatusForRows({ candidate: null, resume: null, v1Review: null, externalAi });
  let profileContext = null;
  let profileError = null;
  try {
    profileContext = currentJobProfileContext(database, candidate.job_id);
  } catch (error) {
    profileError = error;
  }
  const resume = database.prepare('SELECT id, sections_json, is_paywalled FROM resume_online WHERE candidate_id = ?').get(id);
  const v1Review = latestV1Review(database, id);
  return assessStatusForRows({
    candidate,
    resume,
    v1Review,
    externalAi,
    profileContext,
    profileError,
  });
}

const INTERVIEW_SESSION_MODES = new Set(['online', 'offline']);
const INTERVIEW_FORMATS = new Set(['online', 'offline', 'phone']);
const INTERVIEWER_ROLES = new Set(['lead', 'participant']);
const CANDIDATE_CONFIRMATION_STATUSES = new Set([
  'pending',
  'confirmed',
  'declined',
  'reschedule_requested',
]);
const INTERVIEW_SESSION_STATUSES = new Set([
  'draft',
  'scheduled',
  'in_progress',
  'pending_review',
  'confirmed',
  'cancelled',
]);
const INTERVIEW_LEGACY_PURPOSES = new Set([
  'unknown',
  'candidate_interview',
  'hiring_manager_profile_interview',
]);
const INTERVIEW_LEGACY_CLASSIFICATION_STATUSES = new Set([
  'pending_classification',
  'pending_assignment',
  'assigned',
  'excluded',
]);

function ensureInterviewSessionSchema(database = conn()) {
  if (readonlyMode) {
    ensureInterviewRecordingSchema(database);
    assertReadonlySchema(database, 'interview-session', {
      interview_session: ['id', 'candidate_id', 'job_id', 'round', 'mode', 'interview_format', 'status', ...INTERVIEW_SESSION_LOGISTICS_COLUMNS],
      interview_session_schedule_confirmation: ['id', 'session_id', 'request_id', ...SCHEDULE_LOGISTICS_COLUMNS],
      interview_session_interviewer: ['session_id', 'interviewer_id', 'role'],
      interview_interviewer: ['id', 'name', 'active'],
      interview_pending_assignment: ['id', 'job_id', 'source_type', 'source_key', 'purpose', 'status', 'version'],
      interview_pending_assignment_classification_audit: ['id', 'pending_assignment_id', 'action_type', 'request_id'],
      interview_session_material: ['id', 'session_id', 'material_kind'],
      interview_report_v1: ['id', 'session_id', 'schema_version', 'status', 'report_json', 'version'],
      interview_report_fact_review: ['id', 'report_id', 'field_key', 'status', 'version'],
      interview_lifecycle_session: ['id', 'state', 'version'],
      interview_lifecycle_hold: ['id', 'session_id', 'reason_code', 'applied_at', 'expires_at', 'released_at'],
    });
    return;
  }
  ensureInterviewRecordingSchema(database);
  applyF006InterviewSessionMigration(database);
  applyF007InterviewAdapterMigration(database);
  applyF006InterviewSessionMigration(database);
  applyF008InterviewReportMigration(database);
  applyF009InterviewLlmMigration(database);
  applyInterviewLogisticsDataMigration(database);
}

function interviewSessionRound(value) {
  const round = value === undefined || value === null || value === '' ? 1 : Number(value);
  if (!Number.isInteger(round) || round <= 0) throw new Error('interview session round must be a positive integer');
  return round;
}

function interviewSessionMode(value) {
  const mode = (text(value) || '').trim().toLowerCase();
  if (!INTERVIEW_SESSION_MODES.has(mode)) throw new Error(`unsupported interview session mode: ${mode || 'empty'}`);
  return mode;
}

function interviewFormat(value) {
  const format = (text(value) || '').trim().toLowerCase();
  if (!INTERVIEW_FORMATS.has(format)) throw new Error(`unsupported interview format: ${format || 'empty'}`);
  return format;
}

function legacyModeForInterviewFormat(format) {
  return format === 'online' ? 'online' : 'offline';
}

function interviewFormatAndLegacyMode(input = {}) {
  const rawFormat = input.interview_format === undefined ? input.interviewFormat : input.interview_format;
  const rawMode = input.mode;
  const format = rawFormat === undefined || rawFormat === null || rawFormat === ''
    ? interviewFormat(interviewSessionMode(rawMode))
    : interviewFormat(rawFormat);
  const mode = legacyModeForInterviewFormat(format);
  if (rawMode !== undefined && rawMode !== null && rawMode !== '' && interviewSessionMode(rawMode) !== mode) {
    throw new Error(`interview format ${format} conflicts with legacy mode ${rawMode}`);
  }
  return { format, mode };
}

function interviewSessionStatus(value, fallback = 'draft') {
  const status = (text(value) || fallback).trim().toLowerCase();
  if (!INTERVIEW_SESSION_STATUSES.has(status)) throw new Error(`unsupported interview session status: ${status}`);
  return status;
}

function interviewSessionId(input) {
  const raw = input && typeof input === 'object'
    ? (input.session_id === undefined ? (input.sessionId === undefined ? input.id : input.sessionId) : input.session_id)
    : input;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new Error('interview session id is required');
  return id;
}

function requiredInterviewActor(value, label = 'actor') {
  const actor = (text(value) || '').trim();
  if (!actor) throw new Error(`${label} is required`);
  return actor;
}

function normalizedScheduledAt(value) {
  const raw = (text(value) || '').trim();
  const timestamp = Date.parse(raw);
  if (!raw || !Number.isFinite(timestamp)) throw new Error('scheduledAt must be a valid explicit date-time');
  return new Date(timestamp).toISOString();
}

function interviewLogisticsError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function optionalInterviewLogisticsText(value, field, maxLength = 4000) {
  const normalized = String(value == null ? '' : value).trim();
  if (normalized.length > maxLength) {
    throw interviewLogisticsError('INTERVIEW_LOGISTICS_FIELD_TOO_LONG', `${field} cannot exceed ${maxLength} characters`);
  }
  return normalized || null;
}

function logisticsPayload(input = {}) {
  if (input.logistics === undefined || input.logistics === null) return {};
  if (typeof input.logistics !== 'object' || Array.isArray(input.logistics)) {
    throw interviewLogisticsError('INTERVIEW_LOGISTICS_INVALID', 'logistics must be an object');
  }
  return input.logistics;
}

function logisticsValue(input, logistics, snakeKey, camelKey) {
  if (Object.hasOwn(logistics, snakeKey)) return logistics[snakeKey];
  if (Object.hasOwn(logistics, camelKey)) return logistics[camelKey];
  if (Object.hasOwn(input, snakeKey)) return input[snakeKey];
  return input[camelKey];
}

function hasExplicitInterviewLogistics(input = {}) {
  if (Object.hasOwn(input, 'logistics') || Object.hasOwn(input, 'interviewerAssignments') || Object.hasOwn(input, 'interviewer_assignments')) return true;
  return [
    'interviewFormat', 'interview_format', 'durationMinutes', 'duration_minutes',
    'meetingPlatform', 'meeting_platform', 'meetingLink', 'meeting_link',
    'locationAddress', 'location_address', 'locationRoom', 'location_room',
    'logisticsNote', 'logistics_note',
  ].some((key) => Object.hasOwn(input, key));
}

function normalizedInterviewerAssignments(database, value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw interviewLogisticsError('INTERVIEWER_REQUIRED', 'at least one interviewer is required');
  }
  const seen = new Set();
  const assignments = value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw interviewLogisticsError('INTERVIEWER_ASSIGNMENT_INVALID', `interviewerAssignments[${index}] must be an object`);
    }
    const interviewerId = Number(raw.interviewer_id === undefined ? raw.interviewerId : raw.interviewer_id);
    const role = String(raw.role || '').trim().toLowerCase();
    if (!Number.isInteger(interviewerId) || interviewerId <= 0 || !INTERVIEWER_ROLES.has(role)) {
      throw interviewLogisticsError('INTERVIEWER_ASSIGNMENT_INVALID', `invalid interviewer assignment at index ${index}`);
    }
    if (seen.has(interviewerId)) {
      throw interviewLogisticsError('INTERVIEWER_ASSIGNMENT_DUPLICATE', `interviewer ${interviewerId} is assigned more than once`);
    }
    seen.add(interviewerId);
    const interviewer = database.prepare('SELECT id, name, active FROM interview_interviewer WHERE id = ?').get(interviewerId);
    if (!interviewer) throw interviewLogisticsError('INTERVIEWER_NOT_FOUND', `interviewer not found: ${interviewerId}`, 404);
    if (!interviewer.active) throw interviewLogisticsError('INTERVIEWER_INACTIVE', `interviewer is inactive: ${interviewerId}`, 409);
    return {
      interviewer_id: interviewerId,
      interviewer_name_snapshot: interviewer.name,
      role,
    };
  });
  if (assignments.filter((item) => item.role === 'lead').length !== 1) {
    throw interviewLogisticsError('INTERVIEWER_LEAD_REQUIRED', 'exactly one lead interviewer is required');
  }
  return assignments.sort((left, right) => {
    const roleOrder = (left.role === 'lead' ? 0 : 1) - (right.role === 'lead' ? 0 : 1);
    return roleOrder || left.interviewer_id - right.interviewer_id;
  });
}

function normalizedCompleteInterviewLogistics(database, input, current) {
  const logistics = logisticsPayload(input);
  const format = interviewFormat(logisticsValue(input, logistics, 'interview_format', 'interviewFormat'));
  const duration = Number(logisticsValue(input, logistics, 'duration_minutes', 'durationMinutes'));
  if (!Number.isInteger(duration) || duration < 5 || duration > 480) {
    throw interviewLogisticsError('INTERVIEW_DURATION_INVALID', 'durationMinutes must be an integer between 5 and 480');
  }
  const meetingPlatform = optionalInterviewLogisticsText(
    logisticsValue(input, logistics, 'meeting_platform', 'meetingPlatform'),
    'meetingPlatform',
    200,
  );
  const meetingLink = optionalInterviewLogisticsText(
    logisticsValue(input, logistics, 'meeting_link', 'meetingLink'),
    'meetingLink',
    4000,
  );
  const locationAddress = optionalInterviewLogisticsText(
    logisticsValue(input, logistics, 'location_address', 'locationAddress'),
    'locationAddress',
    2000,
  );
  const locationRoom = optionalInterviewLogisticsText(
    logisticsValue(input, logistics, 'location_room', 'locationRoom'),
    'locationRoom',
    500,
  );
  const logisticsNote = optionalInterviewLogisticsText(
    logisticsValue(input, logistics, 'logistics_note', 'logisticsNote'),
    'logisticsNote',
    4000,
  );
  const assignmentInput = logistics.interviewer_assignments === undefined
    ? (logistics.interviewerAssignments === undefined
      ? (input.interviewer_assignments === undefined ? input.interviewerAssignments : input.interviewer_assignments)
      : logistics.interviewerAssignments)
    : logistics.interviewer_assignments;
  const assignments = normalizedInterviewerAssignments(database, assignmentInput);

  if (format === 'online') {
    if (!meetingLink) throw interviewLogisticsError('INTERVIEW_MEETING_LINK_REQUIRED', 'online interview requires meetingLink');
    if (locationAddress || locationRoom) {
      throw interviewLogisticsError('INTERVIEW_LOGISTICS_FORMAT_CONFLICT', 'online interview must not include location address or room');
    }
  } else if (format === 'offline') {
    if (!locationAddress) throw interviewLogisticsError('INTERVIEW_LOCATION_REQUIRED', 'offline interview requires locationAddress');
    if (meetingLink) {
      throw interviewLogisticsError('INTERVIEW_LOGISTICS_FORMAT_CONFLICT', 'offline interview must not include meetingLink');
    }
  } else if (meetingLink || locationAddress || locationRoom) {
    throw interviewLogisticsError('INTERVIEW_LOGISTICS_FORMAT_CONFLICT', 'phone interview must not include meetingLink or address fields');
  }

  return {
    interview_format: format,
    mode: legacyModeForInterviewFormat(format),
    duration_minutes: duration,
    meeting_platform: meetingPlatform,
    meeting_link: meetingLink,
    location_address: locationAddress,
    location_room: locationRoom,
    logistics_note: logisticsNote,
    logistics_version: Number(current.logistics_version || 0) + 1,
    assignments,
  };
}

function currentInterviewerAssignments(database, sessionId) {
  return database.prepare(`
    SELECT interviewer_id, interviewer_name_snapshot, role
    FROM interview_session_interviewer
    WHERE session_id = ?
    ORDER BY CASE role WHEN 'lead' THEN 0 ELSE 1 END, interviewer_id
  `).all(sessionId);
}

function scheduleStateSnapshot(current, scheduledAt, logistics, statusOverride = null) {
  const status = statusOverride || current;
  return {
    scheduled_at: scheduledAt,
    interview_format: logistics.interview_format,
    duration_minutes: logistics.duration_minutes,
    interviewers: logistics.assignments.map((item) => ({
      interviewer_id: item.interviewer_id,
      interviewer_name_snapshot: item.interviewer_name_snapshot,
      role: item.role,
    })),
    meeting_platform: logistics.meeting_platform,
    meeting_link: logistics.meeting_link,
    location_address: logistics.location_address,
    location_room: logistics.location_room,
    logistics_note: logistics.logistics_note,
    invitation_status: status.invitation_status,
    invitation_sent_by: status.invitation_sent_by,
    invitation_sent_at: status.invitation_sent_at,
    candidate_confirmation_status: status.candidate_confirmation_status,
    candidate_confirmation_recorded_by: status.candidate_confirmation_recorded_by,
    candidate_confirmation_recorded_at: status.candidate_confirmation_recorded_at,
    logistics_version: logistics.logistics_version,
  };
}

function logisticsComparable(logistics) {
  return JSON.stringify({
    interview_format: logistics.interview_format,
    mode: logistics.mode,
    duration_minutes: logistics.duration_minutes,
    meeting_platform: logistics.meeting_platform,
    meeting_link: logistics.meeting_link,
    location_address: logistics.location_address,
    location_room: logistics.location_room,
    logistics_note: logistics.logistics_note,
    assignments: logistics.assignments.map((item) => ({
      interviewer_id: item.interviewer_id,
      interviewer_name_snapshot: item.interviewer_name_snapshot,
      role: item.role,
    })),
  });
}

function scheduleLogisticsSnapshot(current, scheduledAt, logistics, kind, previousSchedule = null, statusOverride = null) {
  return {
    schema_version: 'interview_logistics_snapshot_v1',
    snapshot_kind: kind,
    ...scheduleStateSnapshot(current, scheduledAt, logistics, statusOverride),
    previous_schedule: previousSchedule,
  };
}

function interviewSessionById(database, id) {
  return database.prepare(`
    SELECT
      session.id, session.candidate_id, session.job_id, session.round,
      session.mode, session.interview_format, session.status, session.scheduled_at,
      session.scheduled_confirmed_by, session.scheduled_confirmed_at,
      session.duration_minutes, session.meeting_platform, session.meeting_link,
      session.location_address, session.location_room, session.logistics_note,
      session.invitation_status, session.invitation_sent_by, session.invitation_sent_at,
      session.candidate_confirmation_status,
      session.candidate_confirmation_recorded_by, session.candidate_confirmation_recorded_at,
      session.logistics_version,
      session.created_at, session.updated_at,
      candidate.name AS candidate_name,
      job.name AS job_name
    FROM interview_session session
    JOIN candidate ON candidate.internal_id = session.candidate_id
    JOIN job ON job.id = session.job_id
    WHERE session.id = ?
  `).get(id);
}

function interviewSessionRelations(database, id) {
  return {
    manual_note: publicInterviewManualNote(database, interviewManualNoteRow(database, id)),
    interviewer_assignments: database.prepare(`
      SELECT assignment.id, assignment.session_id, assignment.interviewer_id,
             assignment.interviewer_name_snapshot, assignment.role, assignment.assigned_at,
             interviewer.name AS interviewer_current_name, interviewer.active AS interviewer_active
      FROM interview_session_interviewer assignment
      JOIN interview_interviewer interviewer ON interviewer.id = assignment.interviewer_id
      WHERE assignment.session_id = ?
      ORDER BY CASE assignment.role WHEN 'lead' THEN 0 ELSE 1 END, assignment.id
    `).all(id),
    materials: database.prepare(`
      SELECT id, session_id, material_kind, job_interview_id,
             interview_recording_id, linked_by, linked_at
      FROM interview_session_material
      WHERE session_id = ?
      ORDER BY id
    `).all(id),
    reports: database.prepare(`
      SELECT link.id, link.session_id, link.report_id, link.linked_by, link.linked_at,
             report.recording_id, report.status, report.confirmed_at
      FROM interview_session_report link
      JOIN interview_ai_report report ON report.id = link.report_id
      WHERE link.session_id = ?
      ORDER BY link.id
    `).all(id),
    consents: database.prepare(`
      SELECT link.id, link.session_id, link.consent_id, link.linked_by, link.linked_at,
             consent.scope, consent.status, consent.consented_at, consent.recorded_by
      FROM interview_session_consent link
      JOIN interview_recording_consent consent ON consent.id = link.consent_id
      WHERE link.session_id = ?
      ORDER BY link.id
    `).all(id),
    confirmations: database.prepare(`
      SELECT link.id, link.session_id, link.confirmation_id, link.linked_by, link.linked_at,
             confirmation.recording_id, confirmation.field_key,
             confirmation.status, confirmation.confirmed_at
      FROM interview_session_confirmation link
      JOIN interview_recording_confirmation confirmation ON confirmation.id = link.confirmation_id
      WHERE link.session_id = ?
      ORDER BY link.id
    `).all(id),
    schedule_confirmations: database.prepare(`
      SELECT id, session_id, scheduled_at, confirmed_by, confirmed_at, source,
             logistics_snapshot_json, logistics_snapshot_sha256, created_at
      FROM interview_session_schedule_confirmation
      WHERE session_id = ?
      ORDER BY id
    `).all(id).map((row) => ({
      ...row,
      logistics_snapshot: row.logistics_snapshot_json ? parseJson(row.logistics_snapshot_json) : null,
    })),
  };
}

function lifecycleSessionToken(sessionId) {
  return String(interviewSessionId(sessionId));
}

function ensureLifecycleSession(database, sessionId, createdAt = nowIso()) {
  const id = lifecycleSessionToken(sessionId);
  const interview = database.prepare('SELECT id, created_at FROM interview_session WHERE id = ?').get(Number(id));
  if (!interview) throw new Error(`interview session not found: ${id}`);
  const existing = database.prepare('SELECT id FROM interview_lifecycle_session WHERE id = ?').get(id);
  const rawCreatedAt = interview.created_at || createdAt;
  const parsedCreatedAt = Date.parse(rawCreatedAt);
  const normalizedCreatedAt = Number.isFinite(parsedCreatedAt) ? new Date(parsedCreatedAt).toISOString() : nowIso();
  if (!existing) createLifecycleSession({ database, sessionId: id, createdAt: normalizedCreatedAt });
  return id;
}

function ensureLifecycleSessionsForExistingInterviews(database) {
  const interviewTable = database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'interview_session'
  `).get();
  if (!interviewTable) return { created: 0 };
  const missing = database.prepare(`
    SELECT session.id, session.created_at
    FROM interview_session session
    LEFT JOIN interview_lifecycle_session lifecycle ON lifecycle.id = CAST(session.id AS TEXT)
    WHERE lifecycle.id IS NULL
    ORDER BY session.id
  `).all();
  for (const row of missing) ensureLifecycleSession(database, row.id, row.created_at || nowIso());
  return { created: missing.length };
}

function assertInterviewSessionProcessingAllowed(database, sessionId) {
  const id = ensureLifecycleSession(database, sessionId);
  assertSessionProcessingAllowed({ database, sessionId: id });
  const session = database.prepare('SELECT job_id FROM interview_session WHERE id = ?').get(Number(id));
  if (!session) throw new Error(`interview session not found: ${id}`);
  assertJobRecruitingWritable(database, session.job_id);
  return id;
}

function assertInterviewSessionProcessingAllowedById(sessionId) {
  return assertInterviewSessionProcessingAllowed(conn(), sessionId);
}

function assertInterviewRoundRecordingWritable(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const candidateId = (text(input.candidate_id) || text(input.candidateId) || '').trim();
  const rawJobId = input.job_id === undefined ? input.jobId : input.job_id;
  const jobId = Number(rawJobId);
  const round = interviewSessionRound(input.round);
  if (!candidateId || !Number.isInteger(jobId) || jobId <= 0) {
    throw new Error('candidateId and jobId are required for interview recording');
  }
  assertJobRecruitingWritable(database, jobId);
  const candidate = database.prepare('SELECT internal_id, job_id FROM candidate WHERE internal_id = ?').get(candidateId);
  if (!candidate) throw jobOperationError('CANDIDATE_NOT_FOUND', `candidate not found: ${candidateId}`, 404);
  if (Number(candidate.job_id) !== jobId) {
    throw jobOperationError(
      'CANDIDATE_JOB_MISMATCH',
      `candidate ${candidateId} does not belong to job ${jobId}`,
      409,
    );
  }
  const session = database.prepare(`
    SELECT id, candidate_id, job_id, round, status
    FROM interview_session
    WHERE candidate_id = ? AND job_id = ? AND round = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(candidateId, jobId, round) || null;
  // The first recording for a round may legitimately precede Session creation;
  // the authoritative bind transaction will create an active Session later.
  if (!session) return { session: null, existing: false };
  try {
    assertInterviewSessionProcessingAllowed(database, session.id);
  } catch (error) {
    if (error && error.code === 'PROCESSING_WITHDRAWN') {
      throw jobOperationError(
        'INTERVIEW_SESSION_WITHDRAWN',
        `第 ${round} 轮面试已撤回，不能再次开始录音或麦克风预检。`,
        409,
      );
    }
    if (error && error.code === 'PROCESSING_CLOSED') {
      throw jobOperationError(
        'INTERVIEW_SESSION_CLOSED',
        `第 ${round} 轮面试已关闭，不能再次开始录音或麦克风预检。`,
        409,
      );
    }
    throw error;
  }
  return { session, existing: true };
}

function lifecycleArtifactClassForSource(filePath) {
  return new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v'])
    .has(path.extname(filePath || '').toLowerCase()) ? 'raw_video' : 'raw_audio';
}

function offlineLifecycleFileSpecs(recording) {
  const candidates = [
    ['summary', recording.summary_path, 'draft'],
    ['source', recording.source_path, lifecycleArtifactClassForSource(recording.source_path)],
    ['wav', recording.wav_path, 'raw_audio'],
    ['transcript-txt', recording.transcript_txt_path, 'transcript'],
    ['transcript-srt', recording.transcript_srt_path, 'transcript'],
    ['transcript-json', recording.transcript_json_path, 'transcript'],
    ['draft', recording.codex_input_path, 'draft'],
    ['report', recording.report_path, 'draft'],
  ];
  const seen = new Set();
  return candidates.flatMap(([suffix, filePath, artifactClass]) => {
    if (!filePath || !fs.existsSync(filePath)) return [];
    let resolved;
    try { resolved = fs.realpathSync(filePath); } catch { return []; }
    if (seen.has(resolved)) return [];
    seen.add(resolved);
    return [{ suffix, filePath: resolved, artifactClass }];
  });
}

function hasPendingLifecycleMaterialBackfill(database) {
  if (database.prepare(`
    SELECT 1 FROM interview_session_material linked
    LEFT JOIN interview_lifecycle_material lifecycle
      ON lifecycle.id = 'db-job-interview-' || linked.job_interview_id
    WHERE linked.material_kind = 'online_minutes' AND lifecycle.id IS NULL LIMIT 1
  `).get()) return true;
  if (database.prepare(`
    SELECT 1 FROM interview_report_v1 report
    LEFT JOIN interview_lifecycle_material lifecycle ON lifecycle.id = 'db-report-v1-' || report.id
    WHERE lifecycle.id IS NULL LIMIT 1
  `).get()) return true;
  const recordings = database.prepare(`
    SELECT linked.session_id, recording.*
    FROM interview_session_material linked
    JOIN interview_recording recording ON recording.id = linked.interview_recording_id
    WHERE linked.material_kind = 'offline_recording'
  `).all();
  for (const recording of recordings) {
    const expected = [
      ...offlineLifecycleFileSpecs(recording).map((item) => `recording-${recording.id}-${item.suffix}`),
      `db-recording-metadata-${recording.id}`,
    ];
    const reports = database.prepare('SELECT id FROM interview_ai_report WHERE recording_id = ?').all(recording.id);
    expected.push(...reports.map((row) => `db-legacy-report-${row.id}`));
    const confirmations = database.prepare('SELECT 1 FROM interview_recording_confirmation WHERE recording_id = ? LIMIT 1').get(recording.id);
    if (confirmations) expected.push(`db-recording-confirmations-${recording.id}`);
    for (const id of expected) {
      if (!database.prepare('SELECT 1 FROM interview_lifecycle_material WHERE id = ?').get(id)) return true;
    }
  }
  return false;
}

function registerOfflineRecordingLifecycleMaterials(database, sessionId, recording, createdAt = nowIso()) {
  const parsedCreatedAt = Date.parse(createdAt);
  const materialCreatedAt = Number.isFinite(parsedCreatedAt) ? new Date(parsedCreatedAt).toISOString() : nowIso();
  const lifecycleSessionId = ensureLifecycleSession(database, sessionId, materialCreatedAt);
  for (const { suffix, filePath: resolved, artifactClass } of offlineLifecycleFileSpecs(recording)) {
    const materialId = `recording-${recording.id}-${suffix}`;
    const existing = database.prepare(`
      SELECT id, session_id, artifact_class FROM interview_lifecycle_material WHERE id = ?
    `).get(materialId);
    if (existing) {
      if (existing.session_id !== lifecycleSessionId || existing.artifact_class !== artifactClass) {
        throw new Error(`lifecycle material identity conflict: ${materialId}`);
      }
      continue;
    }
    registerLifecycleMaterial({
      database,
      root: INTERVIEW_MATERIAL_ROOT,
      sessionId: lifecycleSessionId,
      materialId,
      artifactClass,
      filePath: resolved,
      createdAt: materialCreatedAt,
    });
  }
  registerLifecycleDatabaseMaterial({
    database,
    sessionId: lifecycleSessionId,
    materialId: `db-recording-metadata-${recording.id}`,
    artifactClass: 'draft',
    entityType: 'interview_recording_metadata',
    entityId: String(recording.id),
    createdAt: materialCreatedAt,
  });
}

function registerOnlineTranscriptLifecycleMaterial(database, sessionId, interviewId, createdAt) {
  const row = database.prepare(`
    SELECT id, source_type, created_at
    FROM job_interview
    WHERE id = ?
  `).get(Number(interviewId));
  if (!row) throw new Error(`job interview not found: ${interviewId}`);
  if (!new Set(['manual_transcript', 'lark_minutes']).has(row.source_type)) {
    throw new Error(`unsupported online transcript source type: ${row.source_type}`);
  }
  return registerLifecycleDatabaseMaterial({
    database,
    sessionId: ensureLifecycleSession(database, sessionId, row.created_at || createdAt || nowIso()),
    materialId: `db-job-interview-${row.id}`,
    artifactClass: 'transcript',
    entityType: 'job_interview',
    entityId: String(row.id),
    createdAt: row.created_at || createdAt || nowIso(),
  });
}

function registerInterviewReportLifecycleMaterial(database, report) {
  if (!report) throw new Error('interview report is required');
  return registerLifecycleDatabaseMaterial({
    database,
    sessionId: ensureLifecycleSession(database, report.session_id, report.created_at || nowIso()),
    materialId: `db-report-v1-${report.id}`,
    artifactClass: report.status === 'confirmed' ? 'confirmed_report' : 'draft',
    entityType: 'interview_report_v1',
    entityId: String(report.id),
    createdAt: report.status === 'confirmed'
      ? (report.confirmed_at || report.updated_at || report.created_at)
      : report.created_at,
  });
}

function registerLegacyRecordingDatabaseMaterials(database, sessionId, recordingId, createdAt = nowIso()) {
  const reports = database.prepare('SELECT * FROM interview_ai_report WHERE recording_id = ? ORDER BY id').all(Number(recordingId));
  for (const report of reports) {
    registerLifecycleDatabaseMaterial({
      database,
      sessionId: String(sessionId),
      materialId: `db-legacy-report-${report.id}`,
      artifactClass: report.status === 'confirmed' ? 'confirmed_report' : 'draft',
      entityType: 'interview_ai_report',
      entityId: String(report.id),
      createdAt: report.confirmed_at || report.created_at || createdAt,
    });
  }
  const confirmation = database.prepare(`
    SELECT MIN(created_at) AS created_at, COUNT(*) AS n
    FROM interview_recording_confirmation WHERE recording_id = ?
  `).get(Number(recordingId));
  if (Number(confirmation.n) > 0) {
    registerLifecycleDatabaseMaterial({
      database,
      sessionId: String(sessionId),
      materialId: `db-recording-confirmations-${recordingId}`,
      artifactClass: 'draft',
      entityType: 'interview_recording_confirmations',
      entityId: String(recordingId),
      createdAt: confirmation.created_at || createdAt,
    });
  }
}

function backfillInterviewLifecycleMaterials(database) {
  const onlineRows = database.prepare(`
    SELECT linked.session_id, linked.job_interview_id, linked.linked_at
    FROM interview_session_material linked
    JOIN job_interview source ON source.id = linked.job_interview_id
    LEFT JOIN interview_lifecycle_material lifecycle
      ON lifecycle.id = 'db-job-interview-' || linked.job_interview_id
    WHERE linked.material_kind = 'online_minutes'
      AND source.source_type IN ('manual_transcript', 'lark_minutes')
      AND lifecycle.id IS NULL
    ORDER BY linked.id
  `).all();
  for (const row of onlineRows) {
    registerOnlineTranscriptLifecycleMaterial(database, row.session_id, row.job_interview_id, row.linked_at);
  }

  const recordingRows = database.prepare(`
    SELECT linked.session_id, linked.linked_at, recording.*
    FROM interview_session_material linked
    JOIN interview_recording recording ON recording.id = linked.interview_recording_id
    WHERE linked.material_kind = 'offline_recording'
    ORDER BY linked.id
  `).all();
  for (const row of recordingRows) {
    registerOfflineRecordingLifecycleMaterials(database, row.session_id, row, row.created_at || row.linked_at || nowIso());
    registerLegacyRecordingDatabaseMaterials(database, row.session_id, row.id, row.created_at || row.linked_at || nowIso());
  }

  const reports = database.prepare(`
    SELECT report.*
    FROM interview_report_v1 report
    LEFT JOIN interview_lifecycle_material lifecycle
      ON lifecycle.id = 'db-report-v1-' || report.id
    WHERE lifecycle.id IS NULL
    ORDER BY report.id
  `).all();
  for (const report of reports) registerInterviewReportLifecycleMaterial(database, report);
  return { online_transcripts: onlineRows.length, recordings: recordingRows.length, reports: reports.length };
}

function withdrawInterviewLifecycle(input = {}) {
  const database = conn();
  const sessionId = ensureLifecycleSession(database, input);
  return database.transaction(() => {
    const timestamp = nowIso();
    assertInterviewSessionProcessingAllowed(database, sessionId);
    const session = database.prepare('SELECT id, candidate_id, job_id, status FROM interview_session WHERE id = ?')
      .get(Number(sessionId));
    if (!session) throw new Error(`interview session not found: ${sessionId}`);
    if (session.status !== 'confirmed') {
      database.prepare(`
        UPDATE interview_session
        SET status = 'cancelled', updated_at = ?
        WHERE id = ?
      `).run(timestamp, session.id);
    }
    const result = withdrawSession({
      database,
      sessionId,
      actorRole: 'hr_admin',
      reasonCode: input.reason_code === undefined ? input.reasonCode : input.reason_code,
      withdrawnAt: timestamp,
    });
    const revoked = database.prepare(`
      UPDATE interview_recording_consent
      SET status = 'revoked', revoked_at = ?, updated_at = ?
      WHERE status = 'active' AND EXISTS (
        SELECT 1 FROM interview_session session
        WHERE CAST(session.id AS TEXT) = ?
          AND session.candidate_id = interview_recording_consent.candidate_id
          AND session.job_id = interview_recording_consent.job_id
      )
    `).run(timestamp, timestamp, sessionId);
    // The route establishes this latch before requesting process termination.
    // Clear it only in the same successful lifecycle transaction that revokes
    // the shared candidate/job consent. Any lifecycle fault rolls back this
    // deletion and leaves all future capture preflights fail-closed.
    database.prepare(`
      DELETE FROM interview_recording_consent_revocation_gate
      WHERE scope_hash = ?
    `).run(interviewConsentScopeHash(session.candidate_id, session.job_id));
    return { ...result, consent_revoked: Number(revoked.changes) > 0 };
  })();
}

function closeInterviewLifecycle(input = {}) {
  const database = conn();
  const sessionId = ensureLifecycleSession(database, input);
  assertInterviewSessionProcessingAllowed(database, sessionId);
  return closeRecruitment({
    database,
    sessionId,
    actorRole: 'hr_admin',
    reasonCode: input.reason_code === undefined ? input.reasonCode : input.reason_code,
    closedAt: nowIso(),
  });
}

function applyInterviewLegalHold(input = {}) {
  const database = conn();
  const sessionId = ensureLifecycleSession(database, input);
  return applyLegalHold({
    database,
    sessionId,
    holdId: `hold-${crypto.randomUUID()}`,
    actorRole: 'hr_admin',
    reasonCode: input.reason_code === undefined ? input.reasonCode : input.reason_code,
    appliedAt: nowIso(),
    expiresAt: input.expires_at === undefined ? input.expiresAt : input.expires_at,
  });
}

function releaseInterviewLegalHold(input = {}) {
  return releaseLegalHold({
    database: conn(),
    holdId: input.hold_id === undefined ? input.holdId : input.hold_id,
    actorRole: 'hr_admin',
    reasonCode: input.reason_code === undefined ? input.reasonCode : input.reason_code,
    releasedAt: nowIso(),
  });
}

function createInterviewDeletionDryRun(input = {}) {
  const database = conn();
  const sessionId = ensureLifecycleSession(database, input);
  return createDeletionDryRun({ database, sessionId, now: nowIso() });
}

function confirmInterviewDeletion(input = {}) {
  return confirmDeletion({
    database: conn(),
    root: INTERVIEW_MATERIAL_ROOT,
    manifestId: input.manifest_id === undefined ? input.manifestId : input.manifest_id,
    confirmationToken: input.confirmation_token === undefined ? input.confirmationToken : input.confirmation_token,
    actorRole: 'hr_admin',
    reasonCode: input.reason_code === undefined ? input.reasonCode : input.reason_code,
    now: nowIso(),
  });
}

function getInterviewLifecycleStatus(input = {}) {
  const database = conn();
  const sessionId = lifecycleSessionToken(input);
  const lifecycle = database.prepare(`
    SELECT id, state, version, created_at, recruitment_closed_at, withdrawn_at
    FROM interview_lifecycle_session
    WHERE id = ?
  `).get(sessionId);
  if (!lifecycle) {
    const error = new Error(`interview lifecycle session not found: ${sessionId}`);
    error.code = 'SESSION_NOT_FOUND';
    throw error;
  }
  const at = nowIso();
  const holds = database.prepare(`
    SELECT id AS hold_id, reason_code, applied_at, expires_at
    FROM interview_lifecycle_hold
    WHERE session_id = ? AND released_at IS NULL AND applied_at <= ? AND expires_at > ?
    ORDER BY applied_at, id
  `).all(sessionId, at, at);
  return {
    session_id: lifecycle.id,
    state: lifecycle.state,
    version: Number(lifecycle.version),
    created_at: lifecycle.created_at,
    recruitment_closed_at: lifecycle.recruitment_closed_at,
    withdrawn_at: lifecycle.withdrawn_at,
    active_holds: holds,
  };
}

function createInterviewSession(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  for (const key of ['scheduled_at', 'scheduledAt', 'scheduled_confirmed_by', 'scheduledConfirmedBy', 'scheduled_confirmed_at', 'scheduledConfirmedAt']) {
    if (Object.hasOwn(input, key) && input[key] !== undefined && input[key] !== null && input[key] !== '') {
      throw new Error('scheduled_at can only be written by explicit manual schedule confirmation');
    }
  }
  const candidateId = (text(input.candidate_id) || text(input.candidateId) || '').trim();
  const rawJobId = input.job_id === undefined ? input.jobId : input.job_id;
  const jobId = Number(rawJobId);
  if (!candidateId || !Number.isInteger(jobId) || jobId <= 0) {
    throw new Error('candidateId and jobId are required for interview session');
  }
  assertJobRecruitingWritable(database, jobId);
  const round = interviewSessionRound(input.round);
  const { format, mode } = interviewFormatAndLegacyMode(input);
  const status = interviewSessionStatus(input.status);
  if (status === 'scheduled') throw new Error('scheduled status requires explicit manual schedule confirmation');
  const timestamp = text(input.created_at) || text(input.createdAt) || nowIso();
  return database.transaction(() => {
    return insertInterviewSession(database, {
      candidateId,
      jobId,
      round,
      mode,
      interviewFormat: format,
      status,
      timestamp,
    });
  })();
}

const NEXT_INTERVIEW_SESSION_ALLOWED_PREVIOUS_STATUSES = new Set([
  'pending_review',
  'confirmed',
  'cancelled',
]);
const INTERVIEW_SESSION_STATUS_LABELS = Object.freeze({
  draft: '待排期',
  scheduled: '已排期',
  in_progress: '面试中',
  pending_review: '待复盘',
  confirmed: '报告已确认',
  cancelled: '已取消',
});

function insertInterviewSession(database, input) {
  const candidate = database.prepare('SELECT internal_id, job_id FROM candidate WHERE internal_id = ?').get(input.candidateId);
  if (!candidate) throw new Error(`candidate not found: ${input.candidateId}`);
  if (Number(candidate.job_id) !== input.jobId) {
    throw new Error(`candidate ${input.candidateId} does not belong to job ${input.jobId}`);
  }
  const info = database.prepare(`
    INSERT INTO interview_session (
      candidate_id, job_id, round, mode, interview_format, status,
      scheduled_at, scheduled_confirmed_by, scheduled_confirmed_at,
      created_at, updated_at
    ) VALUES (
      @candidate_id, @job_id, @round, @mode, @interview_format, @status,
      NULL, NULL, NULL, @created_at, @updated_at
    )
    ON CONFLICT(candidate_id, job_id, round) DO NOTHING
  `).run({
    candidate_id: input.candidateId,
    job_id: input.jobId,
    round: input.round,
    mode: input.mode,
    interview_format: input.interviewFormat,
    status: input.status,
    created_at: input.timestamp,
    updated_at: input.timestamp,
  });
  const row = database.prepare(`
    SELECT id, mode, interview_format, status
    FROM interview_session
    WHERE candidate_id = ? AND job_id = ? AND round = ?
  `).get(input.candidateId, input.jobId, input.round);
  if (!info.changes && (row.mode !== input.mode || row.interview_format !== input.interviewFormat || row.status !== input.status)) {
    throw new Error(`interview session already exists for candidate/job/round with format=${row.interview_format} status=${row.status}`);
  }
  ensureLifecycleSession(database, row.id, input.timestamp);
  return interviewSessionById(database, row.id);
}

function createNextInterviewSession(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const candidateId = (text(input.candidate_id) || text(input.candidateId) || '').trim();
  const rawJobId = input.job_id === undefined ? input.jobId : input.job_id;
  const jobId = Number(rawJobId);
  if (!candidateId || !Number.isInteger(jobId) || jobId <= 0) {
    throw new Error('candidateId and jobId are required for interview session');
  }
  assertJobRecruitingWritable(database, jobId);
  const { format, mode } = interviewFormatAndLegacyMode(input);
  const timestamp = text(input.created_at) || text(input.createdAt) || nowIso();
  return database.transaction(() => {
    const latest = database.prepare(`
      SELECT id, round, status
      FROM interview_session
      WHERE candidate_id = ? AND job_id = ?
      ORDER BY round DESC, id DESC
      LIMIT 1
    `).get(candidateId, jobId);
    if (latest && !NEXT_INTERVIEW_SESSION_ALLOWED_PREVIOUS_STATUSES.has(latest.status)) {
      const statusLabel = INTERVIEW_SESSION_STATUS_LABELS[latest.status] || latest.status;
      throw new Error(`第 ${latest.round} 轮当前为“${statusLabel}”，请先结束当前面试轮次再新建下一轮`);
    }
    return insertInterviewSession(database, {
      candidateId,
      jobId,
      round: latest ? Number(latest.round) + 1 : 1,
      mode,
      interviewFormat: format,
      status: 'draft',
      timestamp,
    });
  })();
}

function publicInterviewManualNote(database, row) {
  if (!row) return null;
  const current = database.prepare(`
    SELECT body, author, created_at
    FROM interview_session_manual_note_revision
    WHERE note_id = ? AND version = ?
  `).get(row.id, row.version) || {};
  return {
    id: Number(row.id),
    session_id: Number(row.session_id),
    material_id: Number(row.material_id),
    job_interview_id: Number(row.job_interview_id),
    source_type: 'manual_note',
    status: row.status,
    version: Number(row.version),
    body: current.body || '',
    author: current.author || row.updated_by,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    revoked_by: row.revoked_by || null,
    revoked_at: row.revoked_at || null,
    accuracy_label: 'HR 人工面试笔记（非 ASR）',
  };
}

function interviewManualNoteRow(database, sessionId) {
  return database.prepare(`
    SELECT note.*, material.id AS material_id
    FROM interview_session_manual_note note
    JOIN interview_session_material material
      ON material.session_id = note.session_id
      AND material.job_interview_id = note.job_interview_id
    WHERE note.session_id = ?
  `).get(Number(sessionId)) || null;
}

function getInterviewManualNote(input) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewReportSessionId(input);
  assertInterviewReportNotDeleted(database, sessionId);
  return publicInterviewManualNote(database, interviewManualNoteRow(database, sessionId));
}

function listInterviewManualNoteRevisions(input) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewReportSessionId(input);
  assertInterviewReportNotDeleted(database, sessionId);
  const note = interviewManualNoteRow(database, sessionId);
  if (!note) return [];
  return database.prepare(`
    SELECT id, note_id, version, body, author, created_at
    FROM interview_session_manual_note_revision
    WHERE note_id = ?
    ORDER BY version DESC
  `).all(note.id);
}

function saveInterviewManualNote(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewReportSessionId(input);
  const actor = requiredReportActor(input.actor);
  const body = String(input.body || '').replace(/\r\n/g, '\n').trim();
  if (!body) reportValidationError('MANUAL_NOTE_REQUIRED', '$.body', '人工面试笔记不能为空。');
  if (body.length > 50000) reportValidationError('MANUAL_NOTE_TOO_LARGE', '$.body', '人工面试笔记超过 50000 字上限。');
  const expectedVersion = expectedReportVersion(input.expectedVersion === undefined ? input.expected_version : input.expectedVersion);
  return database.transaction(() => {
    assertInterviewSessionProcessingAllowed(database, sessionId);
    const session = interviewSessionById(database, sessionId);
    if (!session) reportValidationError('SESSION_NOT_FOUND', '$.session_id', '面试 session 不存在。');
    const current = interviewManualNoteRow(database, sessionId);
    const currentVersion = current ? Number(current.version) : 0;
    if (currentVersion !== expectedVersion) {
      reportValidationError('STALE_VERSION', '$.expected_version', '人工面试笔记版本已变化，请重新读取。');
    }
    if (current && current.status !== 'active') {
      reportValidationError('MANUAL_NOTE_REVOKED', '$.status', '已撤销的人工面试笔记不可继续覆盖；请保留历史并新建下一轮。');
    }
    const timestamp = nowIso();
    if (!current) {
      const interview = database.prepare(`
        INSERT INTO job_interview (job_id, source_url, transcript, note, source_type, created_at)
        VALUES (?, NULL, ?, 'HR 人工面试笔记（非 ASR）', 'manual_transcript', ?)
      `).run(session.job_id, body, timestamp);
      const jobInterviewId = Number(interview.lastInsertRowid);
      database.prepare(`
        INSERT INTO interview_session_material (
          session_id, material_kind, job_interview_id, interview_recording_id, linked_by, linked_at
        ) VALUES (?, 'online_minutes', ?, NULL, ?, ?)
      `).run(sessionId, jobInterviewId, actor, timestamp);
      const note = database.prepare(`
        INSERT INTO interview_session_manual_note (
          session_id, job_interview_id, status, version,
          created_by, updated_by, revoked_by, revoked_at, created_at, updated_at
        ) VALUES (?, ?, 'active', 1, ?, ?, NULL, NULL, ?, ?)
      `).run(sessionId, jobInterviewId, actor, actor, timestamp, timestamp);
      const noteId = Number(note.lastInsertRowid);
      database.prepare(`
        INSERT INTO interview_session_manual_note_revision (
          note_id, version, body, author, created_at
        ) VALUES (?, 1, ?, ?, ?)
      `).run(noteId, body, actor, timestamp);
      registerOnlineTranscriptLifecycleMaterial(database, sessionId, jobInterviewId, timestamp);
    } else {
      const version = currentVersion + 1;
      database.prepare(`
        UPDATE job_interview SET transcript = ?, note = 'HR 人工面试笔记（非 ASR）'
        WHERE id = ?
      `).run(body, current.job_interview_id);
      database.prepare(`
        UPDATE interview_session_manual_note
        SET version = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'active'
      `).run(version, actor, timestamp, current.id, currentVersion);
      database.prepare(`
        INSERT INTO interview_session_manual_note_revision (
          note_id, version, body, author, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(current.id, version, body, actor, timestamp);
    }
    database.prepare(`
      UPDATE interview_session
      SET status = CASE WHEN status IN ('draft', 'scheduled', 'in_progress') THEN 'pending_review' ELSE status END,
          updated_at = ?
      WHERE id = ?
    `).run(timestamp, sessionId);
    return publicInterviewManualNote(database, interviewManualNoteRow(database, sessionId));
  })();
}

function revokeInterviewManualNote(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewReportSessionId(input);
  const actor = requiredReportActor(input.actor);
  const expectedVersion = expectedReportVersion(input.expectedVersion === undefined ? input.expected_version : input.expectedVersion);
  if (input.confirmed !== true) reportValidationError('EXPLICIT_CONFIRM_REQUIRED', '$.confirmed', '撤销人工面试笔记必须显式确认。');
  return database.transaction(() => {
    assertInterviewSessionProcessingAllowed(database, sessionId);
    const current = interviewManualNoteRow(database, sessionId);
    if (!current) reportValidationError('MANUAL_NOTE_NOT_FOUND', '$.session_id', '人工面试笔记不存在。');
    if (Number(current.version) !== expectedVersion) reportValidationError('STALE_VERSION', '$.expected_version', '人工面试笔记版本已变化，请重新读取。');
    if (current.status === 'revoked') return publicInterviewManualNote(database, current);
    const timestamp = nowIso();
    const currentRevision = database.prepare(`
      SELECT body FROM interview_session_manual_note_revision
      WHERE note_id = ? AND version = ?
    `).get(current.id, current.version);
    if (!currentRevision) {
      reportValidationError('MANUAL_NOTE_HISTORY_INVALID', '$.version', '人工面试笔记历史不完整，无法撤销。');
    }
    database.prepare(`
      UPDATE interview_session_manual_note
      SET status = 'revoked', version = version + 1, updated_by = ?,
          revoked_by = ?, revoked_at = ?, updated_at = ?
      WHERE id = ? AND version = ? AND status = 'active'
    `).run(actor, actor, timestamp, timestamp, current.id, current.version);
    database.prepare(`
      INSERT INTO interview_session_manual_note_revision (
        note_id, version, body, author, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(current.id, Number(current.version) + 1, currentRevision.body, actor, timestamp);
    return publicInterviewManualNote(database, interviewManualNoteRow(database, sessionId));
  })();
}

function getInterviewSession(id) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewSessionId(id);
  const session = interviewSessionById(database, sessionId);
  if (!session) return null;
  return { ...session, ...interviewSessionRelations(database, sessionId) };
}

function listInterviewSessions(filters = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const where = [];
  const params = {};
  const candidateId = text(filters.candidate_id) || text(filters.candidateId);
  const rawJobId = filters.job_id === undefined ? filters.jobId : filters.job_id;
  if (candidateId) {
    where.push('session.candidate_id = @candidate_id');
    params.candidate_id = candidateId;
  }
  if (rawJobId !== undefined && rawJobId !== null && rawJobId !== '') {
    const jobId = Number(rawJobId);
    if (!Number.isInteger(jobId) || jobId <= 0) throw new Error('jobId must be a positive integer');
    where.push('session.job_id = @job_id');
    params.job_id = jobId;
  }
  if (filters.round !== undefined && filters.round !== null && filters.round !== '') {
    where.push('session.round = @round');
    params.round = interviewSessionRound(filters.round);
  }
  if (filters.mode !== undefined && filters.mode !== null && filters.mode !== '') {
    where.push('session.mode = @mode');
    params.mode = interviewSessionMode(filters.mode);
  }
  const rawFormat = filters.interview_format === undefined ? filters.interviewFormat : filters.interview_format;
  if (rawFormat !== undefined && rawFormat !== null && rawFormat !== '') {
    where.push('session.interview_format = @interview_format');
    params.interview_format = interviewFormat(rawFormat);
  }
  if (filters.status !== undefined && filters.status !== null && filters.status !== '') {
    where.push('session.status = @status');
    params.status = interviewSessionStatus(filters.status);
  }
  return database.prepare(`
    SELECT
      session.id, session.candidate_id, session.job_id, session.round,
      session.mode, session.interview_format, session.status, session.scheduled_at,
      session.scheduled_confirmed_by, session.scheduled_confirmed_at,
      session.duration_minutes, session.meeting_platform, session.meeting_link,
      session.location_address, session.location_room, session.logistics_note,
      session.invitation_status, session.invitation_sent_by, session.invitation_sent_at,
      session.candidate_confirmation_status,
      session.candidate_confirmation_recorded_by, session.candidate_confirmation_recorded_at,
      session.logistics_version,
      session.created_at, session.updated_at,
      candidate.name AS candidate_name,
      job.name AS job_name
    FROM interview_session session
    JOIN candidate ON candidate.internal_id = session.candidate_id
    JOIN job ON job.id = session.job_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY session.job_id, session.candidate_id, session.round, session.id
  `).all(params);
}

function setInterviewSessionStatus(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const id = interviewSessionId(input);
  const status = interviewSessionStatus(input.status, '');
  return database.transaction(() => {
    assertInterviewSessionProcessingAllowed(database, id);
    const current = interviewSessionById(database, id);
    if (!current) throw new Error(`interview session not found: ${id}`);
    assertJobRecruitingWritable(database, current.job_id);
    if (status === 'scheduled' && !current.scheduled_at) {
      throw new Error('scheduled status requires explicit manual schedule confirmation first');
    }
    database.prepare('UPDATE interview_session SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id);
    return interviewSessionById(database, id);
  })();
}

function confirmInterviewSessionSchedule(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const id = interviewSessionId(input);
  if (input.confirmed !== true) throw new Error('explicit confirmed=true is required for manual schedule confirmation');
  const scheduledAt = normalizedScheduledAt(input.scheduled_at === undefined ? input.scheduledAt : input.scheduled_at);
  const confirmedBy = requiredInterviewActor(
    input.confirmed_by === undefined ? input.confirmedBy : input.confirmed_by,
    'confirmedBy',
  );
  const requestId = text(input.request_id === undefined ? input.requestId : input.request_id) || null;
  return database.transaction(() => {
    assertInterviewSessionProcessingAllowed(database, id);
    if (requestId) {
      const replay = database.prepare('SELECT session_id FROM interview_session_schedule_confirmation WHERE request_id = ?').get(requestId);
      if (replay) {
        if (Number(replay.session_id) !== id) throw new Error('requestId already belongs to another interview session');
        return {
          ...interviewSessionById(database, id),
          ...interviewSessionRelations(database, id),
          idempotent_replay: true,
        };
      }
    }
    if (Date.parse(scheduledAt) <= Date.now()) {
      throw jobOperationError('INTERVIEW_SCHEDULE_IN_PAST', '面试时间必须晚于当前时间，请重新选择。');
    }
    const current = interviewSessionById(database, id);
    if (!current) throw new Error(`interview session not found: ${id}`);
    if (current.status === 'confirmed' || current.status === 'cancelled') {
      throw new Error(`cannot schedule interview session in ${current.status} status`);
    }
    const timestamp = nowIso();
    const explicitLogistics = hasExplicitInterviewLogistics(input);
    const previousAssignments = currentInterviewerAssignments(database, id);
    const previousLogistics = {
      interview_format: current.interview_format,
      mode: current.mode,
      duration_minutes: current.duration_minutes,
      meeting_platform: current.meeting_platform,
      meeting_link: current.meeting_link,
      location_address: current.location_address,
      location_room: current.location_room,
      logistics_note: current.logistics_note,
      logistics_version: Number(current.logistics_version || 0),
      assignments: previousAssignments,
    };
    const logistics = explicitLogistics
      ? normalizedCompleteInterviewLogistics(database, input, current)
      : { ...previousLogistics };
    const logisticsChanged = explicitLogistics && logisticsComparable(logistics) !== logisticsComparable(previousLogistics);
    const isReschedule = Boolean(current.scheduled_at)
      && (current.scheduled_at !== scheduledAt || logisticsChanged);
    logistics.logistics_version = Number(current.logistics_version || 0)
      + (logisticsChanged || isReschedule ? 1 : 0);
    const resetStatus = isReschedule ? {
      invitation_status: 'draft',
      invitation_sent_by: null,
      invitation_sent_at: null,
      candidate_confirmation_status: 'pending',
      candidate_confirmation_recorded_by: null,
      candidate_confirmation_recorded_at: null,
    } : null;
    const previousSchedule = isReschedule
      ? scheduleStateSnapshot(current, current.scheduled_at, previousLogistics)
      : null;
    const snapshot = scheduleLogisticsSnapshot(
      current,
      scheduledAt,
      logistics,
      explicitLogistics ? 'complete' : 'legacy_compatible',
      previousSchedule,
      resetStatus,
    );
    const snapshotJson = JSON.stringify(snapshot);
    const snapshotSha256 = stableContentHash(snapshotJson);
    database.prepare(`
      INSERT INTO interview_session_schedule_confirmation (
        session_id, scheduled_at, confirmed_by, confirmed_at, source, request_id,
        logistics_snapshot_json, logistics_snapshot_sha256, created_at
      ) VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?)
    `).run(id, scheduledAt, confirmedBy, timestamp, requestId, snapshotJson, snapshotSha256, timestamp);
    if (explicitLogistics) {
      database.prepare('DELETE FROM interview_session_interviewer WHERE session_id = ?').run(id);
      const insertAssignment = database.prepare(`
        INSERT INTO interview_session_interviewer (
          session_id, interviewer_id, interviewer_name_snapshot, role, assigned_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const assignment of logistics.assignments) {
        insertAssignment.run(
          id,
          assignment.interviewer_id,
          assignment.interviewer_name_snapshot,
          assignment.role,
          timestamp,
        );
      }
    }
    database.prepare(`
      UPDATE interview_session
      SET scheduled_at = @scheduled_at,
          scheduled_confirmed_by = @confirmed_by,
          scheduled_confirmed_at = @confirmed_at,
          mode = @mode,
          interview_format = @interview_format,
          duration_minutes = @duration_minutes,
          meeting_platform = @meeting_platform,
          meeting_link = @meeting_link,
          location_address = @location_address,
          location_room = @location_room,
          logistics_note = @logistics_note,
          invitation_status = @invitation_status,
          invitation_sent_by = @invitation_sent_by,
          invitation_sent_at = @invitation_sent_at,
          candidate_confirmation_status = @candidate_confirmation_status,
          candidate_confirmation_recorded_by = @candidate_confirmation_recorded_by,
          candidate_confirmation_recorded_at = @candidate_confirmation_recorded_at,
          logistics_version = @logistics_version,
          status = 'scheduled',
          updated_at = @confirmed_at
      WHERE id = @id
    `).run({
      id,
      scheduled_at: scheduledAt,
      confirmed_by: confirmedBy,
      confirmed_at: timestamp,
      mode: logistics.mode,
      interview_format: logistics.interview_format,
      duration_minutes: logistics.duration_minutes,
      meeting_platform: logistics.meeting_platform,
      meeting_link: logistics.meeting_link,
      location_address: logistics.location_address,
      location_room: logistics.location_room,
      logistics_note: logistics.logistics_note,
      invitation_status: resetStatus ? resetStatus.invitation_status : current.invitation_status,
      invitation_sent_by: resetStatus ? resetStatus.invitation_sent_by : current.invitation_sent_by,
      invitation_sent_at: resetStatus ? resetStatus.invitation_sent_at : current.invitation_sent_at,
      candidate_confirmation_status: resetStatus ? resetStatus.candidate_confirmation_status : current.candidate_confirmation_status,
      candidate_confirmation_recorded_by: resetStatus ? resetStatus.candidate_confirmation_recorded_by : current.candidate_confirmation_recorded_by,
      candidate_confirmation_recorded_at: resetStatus ? resetStatus.candidate_confirmation_recorded_at : current.candidate_confirmation_recorded_at,
      logistics_version: logistics.logistics_version,
    });
    return {
      ...interviewSessionById(database, id),
      ...interviewSessionRelations(database, id),
    };
  })();
}

function createInterviewInterviewer(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const name = optionalInterviewLogisticsText(input.name, 'name', 200);
  if (!name) throw interviewLogisticsError('INTERVIEWER_NAME_REQUIRED', 'interviewer name is required');
  const active = input.active === undefined ? true : input.active;
  if (active !== true && active !== false && active !== 1 && active !== 0) {
    throw interviewLogisticsError('INTERVIEWER_ACTIVE_INVALID', 'active must be boolean');
  }
  const actor = requiredInterviewActor(input.actor, 'actor');
  const timestamp = nowIso();
  return database.transaction(() => {
    const info = database.prepare(`
      INSERT INTO interview_interviewer (name, active, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(name, active ? 1 : 0, timestamp, timestamp);
    const id = Number(info.lastInsertRowid);
    database.prepare(`
      INSERT INTO audit_log (action, target, who, auto, result, detail_json, created_at)
      VALUES ('interview_interviewer_created', ?, ?, 0, '成功', ?, ?)
    `).run(`interviewer:${id}`, actor, JSON.stringify({ active: Boolean(active) }), timestamp);
    return database.prepare('SELECT id, name, active, created_at, updated_at FROM interview_interviewer WHERE id = ?').get(id);
  })();
}

function listInterviewInterviewers(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const includeInactive = input.include_inactive === true || input.includeInactive === true
    || input.include_inactive === '1' || input.includeInactive === '1';
  return database.prepare(`
    SELECT id, name, active, created_at, updated_at
    FROM interview_interviewer
    ${includeInactive ? '' : 'WHERE active = 1'}
    ORDER BY active DESC, name COLLATE NOCASE, id
  `).all();
}

function updateInterviewInterviewer(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const id = Number(input.id === undefined ? input.interviewerId : input.id);
  if (!Number.isInteger(id) || id <= 0) throw interviewLogisticsError('INTERVIEWER_ID_REQUIRED', 'interviewer id is required');
  const current = database.prepare('SELECT id, name, active FROM interview_interviewer WHERE id = ?').get(id);
  if (!current) throw interviewLogisticsError('INTERVIEWER_NOT_FOUND', `interviewer not found: ${id}`, 404);
  const hasName = Object.hasOwn(input, 'name');
  const hasActive = Object.hasOwn(input, 'active');
  if (!hasName && !hasActive) {
    throw interviewLogisticsError('INTERVIEWER_UPDATE_REQUIRED', 'name or active is required');
  }
  const name = hasName ? optionalInterviewLogisticsText(input.name, 'name', 200) : current.name;
  if (!name) throw interviewLogisticsError('INTERVIEWER_NAME_REQUIRED', 'interviewer name is required');
  if (hasActive && input.active !== true && input.active !== false && input.active !== 1 && input.active !== 0) {
    throw interviewLogisticsError('INTERVIEWER_ACTIVE_INVALID', 'active must be boolean');
  }
  const active = hasActive ? Boolean(input.active) : Boolean(current.active);
  const actor = requiredInterviewActor(input.actor, 'actor');
  const timestamp = nowIso();
  return database.transaction(() => {
    database.prepare('UPDATE interview_interviewer SET name = ?, active = ?, updated_at = ? WHERE id = ?')
      .run(name, active ? 1 : 0, timestamp, id);
    database.prepare(`
      INSERT INTO audit_log (action, target, who, auto, result, detail_json, created_at)
      VALUES ('interview_interviewer_updated', ?, ?, 0, '成功', ?, ?)
    `).run(`interviewer:${id}`, actor, JSON.stringify({ active }), timestamp);
    return database.prepare('SELECT id, name, active, created_at, updated_at FROM interview_interviewer WHERE id = ?').get(id);
  })();
}

function markInterviewInvitationSent(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const id = interviewSessionId(input);
  if (input.confirmed !== true) throw interviewLogisticsError('EXPLICIT_CONFIRM_REQUIRED', 'explicit confirmed=true is required');
  const actor = requiredInterviewActor(input.actor, 'actor');
  return database.transaction(() => {
    assertInterviewSessionProcessingAllowed(database, id);
    const current = interviewSessionById(database, id);
    if (!current) throw interviewLogisticsError('SESSION_NOT_FOUND', `interview session not found: ${id}`, 404);
    if (!current.scheduled_at) throw interviewLogisticsError('INTERVIEW_NOT_SCHEDULED', 'interview session must be scheduled before invitation is marked sent', 409);
    const timestamp = nowIso();
    database.prepare(`
      UPDATE interview_session
      SET invitation_status = 'sent', invitation_sent_by = ?, invitation_sent_at = ?,
          logistics_version = logistics_version + 1, updated_at = ?
      WHERE id = ?
    `).run(actor, timestamp, timestamp, id);
    database.prepare(`
      INSERT INTO audit_log (action, target, who, auto, result, detail_json, created_at)
      VALUES ('interview_invitation_marked_sent', ?, ?, 0, '成功', ?, ?)
    `).run(`interview_session:${id}`, actor, JSON.stringify({ explicit: true }), timestamp);
    return { ...interviewSessionById(database, id), ...interviewSessionRelations(database, id) };
  })();
}

function recordInterviewCandidateConfirmation(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const id = interviewSessionId(input);
  if (input.confirmed !== true) throw interviewLogisticsError('EXPLICIT_CONFIRM_REQUIRED', 'explicit confirmed=true is required');
  const actor = requiredInterviewActor(input.actor, 'actor');
  const rawStatus = input.status === undefined
    ? (input.candidate_confirmation_status === undefined ? input.candidateConfirmationStatus : input.candidate_confirmation_status)
    : input.status;
  const status = String(rawStatus || '').trim().toLowerCase();
  if (!CANDIDATE_CONFIRMATION_STATUSES.has(status)) {
    throw interviewLogisticsError('CANDIDATE_CONFIRMATION_STATUS_INVALID', `unsupported candidate confirmation status: ${status || 'empty'}`);
  }
  return database.transaction(() => {
    assertInterviewSessionProcessingAllowed(database, id);
    const current = interviewSessionById(database, id);
    if (!current) throw interviewLogisticsError('SESSION_NOT_FOUND', `interview session not found: ${id}`, 404);
    if (!current.scheduled_at) throw interviewLogisticsError('INTERVIEW_NOT_SCHEDULED', 'interview session must be scheduled before candidate confirmation is recorded', 409);
    const timestamp = nowIso();
    database.prepare(`
      UPDATE interview_session
      SET candidate_confirmation_status = ?,
          candidate_confirmation_recorded_by = ?,
          candidate_confirmation_recorded_at = ?,
          logistics_version = logistics_version + 1,
          updated_at = ?
      WHERE id = ?
    `).run(status, actor, timestamp, timestamp, id);
    database.prepare(`
      INSERT INTO audit_log (action, target, who, auto, result, detail_json, created_at)
      VALUES ('interview_candidate_confirmation_recorded', ?, ?, 0, '成功', ?, ?)
    `).run(`interview_session:${id}`, actor, JSON.stringify({ status, explicit: true }), timestamp);
    return { ...interviewSessionById(database, id), ...interviewSessionRelations(database, id) };
  })();
}

function listInterviewPendingAssignments(filters = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const where = [];
  const params = {};
  const status = filters.status === undefined || filters.status === null || filters.status === ''
    ? null
    : String(filters.status);
  if (status) {
    if (!INTERVIEW_LEGACY_CLASSIFICATION_STATUSES.has(status)) throw new Error(`unsupported pending assignment status: ${status}`);
    where.push('pending.status = @status');
    params.status = status;
  }
  const purpose = filters.purpose === undefined || filters.purpose === null || filters.purpose === ''
    ? null
    : String(filters.purpose);
  if (purpose) {
    if (!INTERVIEW_LEGACY_PURPOSES.has(purpose)) throw new Error(`unsupported interview purpose: ${purpose}`);
    where.push('pending.purpose = @purpose');
    params.purpose = purpose;
  }
  const rawJobId = filters.job_id === undefined ? filters.jobId : filters.job_id;
  if (rawJobId !== undefined && rawJobId !== null && rawJobId !== '') {
    const jobId = Number(rawJobId);
    if (!Number.isInteger(jobId) || jobId <= 0) throw new Error('jobId must be a positive integer');
    where.push('pending.job_id = @job_id');
    params.job_id = jobId;
  }
  return database.prepare(`
    SELECT
      pending.id, pending.job_interview_id, pending.job_id, pending.source_type,
      pending.purpose, pending.status, pending.reason, pending.assigned_session_id,
      pending.assigned_by, pending.assigned_at, pending.created_at, pending.updated_at
    FROM interview_pending_assignment pending
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY pending.id
  `).all(params);
}

function listInterviewPendingAssignmentClassificationAudits(pendingAssignmentId) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const id = Number(pendingAssignmentId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('pendingAssignmentId is required');
  return database.prepare(`
    SELECT
      id, pending_assignment_id, before_purpose, before_status,
      after_purpose, after_status, actor, classified_at, created_at
    FROM interview_pending_assignment_classification_audit
    WHERE pending_assignment_id = ?
    ORDER BY id
  `).all(id);
}

function classifyInterviewPendingAssignment(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const id = Number(input.pending_assignment_id === undefined ? input.pendingAssignmentId : input.pending_assignment_id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('pendingAssignmentId is required');
  const purpose = (text(input.purpose) || '').trim();
  if (!['candidate_interview', 'hiring_manager_profile_interview'].includes(purpose)) {
    throw new Error(`unsupported manual interview purpose: ${purpose || 'empty'}`);
  }
  const actor = requiredInterviewActor(input.actor, 'actor');
  const afterStatus = purpose === 'candidate_interview' ? 'pending_assignment' : 'excluded';
  const reason = purpose === 'candidate_interview' ? 'missing_candidate' : 'hiring_manager_profile_interview';
  return database.transaction(() => {
    const current = database.prepare('SELECT * FROM interview_pending_assignment WHERE id = ?').get(id);
    if (!current) throw new Error(`pending interview classification not found: ${id}`);
    if (current.purpose === purpose && (
      current.status === afterStatus
      || (purpose === 'candidate_interview' && current.status === 'assigned')
    )) return current;
    if (current.purpose !== 'unknown' || current.status !== 'pending_classification') {
      throw new Error(`illegal interview purpose transition from ${current.purpose}/${current.status} to ${purpose}/${afterStatus}`);
    }
    const timestamp = nowIso();
    database.prepare(`
      INSERT INTO interview_pending_assignment_classification_audit (
        pending_assignment_id, before_purpose, before_status,
        after_purpose, after_status, actor, classified_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      current.purpose,
      current.status,
      purpose,
      afterStatus,
      actor,
      timestamp,
      timestamp,
    );
    database.prepare(`
      UPDATE interview_pending_assignment
      SET purpose = ?, status = ?, reason = ?, updated_at = ?
      WHERE id = ?
    `).run(purpose, afterStatus, reason, timestamp, id);
    return database.prepare('SELECT * FROM interview_pending_assignment WHERE id = ?').get(id);
  })();
}

function insertInterviewSessionLink(database, { table, idColumn, sessionId, sourceId, linkedBy, linkedAt }) {
  const existing = database.prepare(`SELECT * FROM ${table} WHERE ${idColumn} = ?`).get(sourceId);
  if (existing) {
    if (Number(existing.session_id) !== Number(sessionId)) {
      throw new Error(`${idColumn} ${sourceId} is already linked to interview session ${existing.session_id}`);
    }
    return existing;
  }
  database.prepare(`
    INSERT INTO ${table} (session_id, ${idColumn}, linked_by, linked_at)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, sourceId, linkedBy, linkedAt);
  return database.prepare(`SELECT * FROM ${table} WHERE ${idColumn} = ?`).get(sourceId);
}

function linkInterviewSessionRecording(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewSessionId(input);
  const recordingId = Number(input.recording_id === undefined ? input.recordingId : input.recording_id);
  if (!Number.isInteger(recordingId) || recordingId <= 0) throw new Error('recordingId is required');
  const linkedBy = requiredInterviewActor(input.linked_by === undefined ? input.linkedBy : input.linked_by, 'linkedBy');
  return database.transaction(() => {
    assertInterviewSessionProcessingAllowed(database, sessionId);
    const session = interviewSessionById(database, sessionId);
    if (!session) throw new Error(`interview session not found: ${sessionId}`);
    if (session.mode !== 'offline') throw new Error('offline recording can only be linked to an offline interview session');
    const recording = interviewRecordingById(database, recordingId);
    if (!recording) throw new Error(`interview recording not found: ${recordingId}`);
    if (recording.candidate_id && recording.candidate_id !== session.candidate_id) {
      throw new Error(`interview recording ${recordingId} belongs to another candidate`);
    }
    if (recording.job_id && Number(recording.job_id) !== Number(session.job_id)) {
      throw new Error(`interview recording ${recordingId} belongs to another job`);
    }
    const existing = database.prepare(`
      SELECT * FROM interview_session_material WHERE interview_recording_id = ?
    `).get(recordingId);
    if (existing) {
      if (Number(existing.session_id) !== sessionId) {
        throw new Error(`interview recording ${recordingId} is already linked to interview session ${existing.session_id}`);
      }
      registerOfflineRecordingLifecycleMaterials(database, sessionId, recording, recording.created_at || nowIso());
      registerLegacyRecordingDatabaseMaterials(database, sessionId, recordingId, recording.created_at || nowIso());
      return existing;
    }
    const timestamp = nowIso();
    database.prepare(`
      INSERT INTO interview_session_material (
        session_id, material_kind, job_interview_id, interview_recording_id, linked_by, linked_at
      ) VALUES (?, 'offline_recording', NULL, ?, ?, ?)
    `).run(sessionId, recordingId, linkedBy, timestamp);
    registerOfflineRecordingLifecycleMaterials(database, sessionId, recording, recording.created_at || timestamp);
    registerLegacyRecordingDatabaseMaterials(database, sessionId, recordingId, recording.created_at || timestamp);
    return database.prepare('SELECT * FROM interview_session_material WHERE interview_recording_id = ?').get(recordingId);
  })();
}

function assignInterviewPendingAssignment(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewSessionId(input);
  const pendingId = Number(input.pending_assignment_id === undefined ? input.pendingAssignmentId : input.pending_assignment_id);
  if (!Number.isInteger(pendingId) || pendingId <= 0) throw new Error('pendingAssignmentId is required');
  const assignedBy = requiredInterviewActor(input.assigned_by === undefined ? input.assignedBy : input.assigned_by, 'assignedBy');
  return database.transaction(() => {
    assertInterviewSessionProcessingAllowed(database, sessionId);
    const session = interviewSessionById(database, sessionId);
    if (!session) throw new Error(`interview session not found: ${sessionId}`);
    if (session.mode !== 'online') throw new Error('online minutes can only be assigned to an online interview session');
    const pending = database.prepare('SELECT * FROM interview_pending_assignment WHERE id = ?').get(pendingId);
    if (!pending) throw new Error(`pending interview assignment not found: ${pendingId}`);
    if (pending.purpose !== 'candidate_interview') {
      throw new Error(`pending interview assignment ${pendingId} must be explicitly classified as candidate_interview before binding`);
    }
    if (pending.status === 'assigned') {
      if (Number(pending.assigned_session_id) !== sessionId) {
        throw new Error(`pending interview assignment ${pendingId} is already assigned to session ${pending.assigned_session_id}`);
      }
      registerOnlineTranscriptLifecycleMaterial(database, sessionId, pending.job_interview_id, pending.assigned_at || pending.updated_at);
      return pending;
    }
    if (pending.status !== 'pending_assignment') {
      throw new Error(`pending interview assignment ${pendingId} cannot be bound from status ${pending.status}`);
    }
    if (Number(pending.job_id) !== Number(session.job_id)) {
      throw new Error(`pending interview assignment ${pendingId} belongs to another job`);
    }
    const timestamp = nowIso();
    const existing = database.prepare(`
      SELECT * FROM interview_session_material WHERE job_interview_id = ?
    `).get(pending.job_interview_id);
    if (existing && Number(existing.session_id) !== sessionId) {
      throw new Error(`job interview ${pending.job_interview_id} is already linked to interview session ${existing.session_id}`);
    }
    if (!existing) {
      database.prepare(`
        INSERT INTO interview_session_material (
          session_id, material_kind, job_interview_id, interview_recording_id, linked_by, linked_at
        ) VALUES (?, 'online_minutes', ?, NULL, ?, ?)
      `).run(sessionId, pending.job_interview_id, assignedBy, timestamp);
    }
    database.prepare(`
      UPDATE interview_pending_assignment
      SET status = 'assigned', assigned_session_id = ?, assigned_by = ?, assigned_at = ?, updated_at = ?
      WHERE id = ?
    `).run(sessionId, assignedBy, timestamp, timestamp, pendingId);
    registerOnlineTranscriptLifecycleMaterial(database, sessionId, pending.job_interview_id, timestamp);
    return database.prepare('SELECT * FROM interview_pending_assignment WHERE id = ?').get(pendingId);
  })();
}

function linkInterviewSessionReport(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewSessionId(input);
  const reportId = Number(input.report_id === undefined ? input.reportId : input.report_id);
  if (!Number.isInteger(reportId) || reportId <= 0) throw new Error('reportId is required');
  const linkedBy = requiredInterviewActor(input.linked_by === undefined ? input.linkedBy : input.linked_by, 'linkedBy');
  return database.transaction(() => {
    assertInterviewSessionProcessingAllowed(database, sessionId);
    const session = interviewSessionById(database, sessionId);
    if (!session) throw new Error(`interview session not found: ${sessionId}`);
    const report = database.prepare(`
      SELECT id, recording_id, candidate_id, job_id FROM interview_ai_report WHERE id = ?
    `).get(reportId);
    if (!report) throw new Error(`interview report not found: ${reportId}`);
    const material = database.prepare(`
      SELECT id FROM interview_session_material
      WHERE session_id = ? AND interview_recording_id = ?
    `).get(sessionId, report.recording_id);
    if (!material) throw new Error(`interview report ${reportId} recording is not linked to interview session ${sessionId}`);
    if (report.candidate_id && report.candidate_id !== session.candidate_id) throw new Error(`interview report ${reportId} belongs to another candidate`);
    if (report.job_id && Number(report.job_id) !== Number(session.job_id)) throw new Error(`interview report ${reportId} belongs to another job`);
    const link = insertInterviewSessionLink(database, {
      table: 'interview_session_report',
      idColumn: 'report_id',
      sessionId,
      sourceId: reportId,
      linkedBy,
      linkedAt: nowIso(),
    });
    registerLegacyRecordingDatabaseMaterials(database, sessionId, report.recording_id, nowIso());
    return link;
  })();
}

function linkInterviewSessionConsent(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewSessionId(input);
  const consentId = Number(input.consent_id === undefined ? input.consentId : input.consent_id);
  if (!Number.isInteger(consentId) || consentId <= 0) throw new Error('consentId is required');
  const linkedBy = requiredInterviewActor(input.linked_by === undefined ? input.linkedBy : input.linked_by, 'linkedBy');
  return database.transaction(() => {
    assertInterviewSessionProcessingAllowed(database, sessionId);
    const session = interviewSessionById(database, sessionId);
    if (!session) throw new Error(`interview session not found: ${sessionId}`);
    const consent = database.prepare(`
      SELECT id, candidate_id, job_id FROM interview_recording_consent WHERE id = ?
    `).get(consentId);
    if (!consent) throw new Error(`interview consent not found: ${consentId}`);
    if (consent.candidate_id !== session.candidate_id || Number(consent.job_id) !== Number(session.job_id)) {
      throw new Error(`interview consent ${consentId} does not match interview session candidate/job`);
    }
    const existing = database.prepare(`
      SELECT * FROM interview_session_consent
      WHERE session_id = ? AND consent_id = ?
    `).get(sessionId, consentId);
    if (existing) return existing;
    const linkedAt = nowIso();
    database.prepare(`
      INSERT INTO interview_session_consent (session_id, consent_id, linked_by, linked_at)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, consentId, linkedBy, linkedAt);
    const link = database.prepare(`
      SELECT * FROM interview_session_consent
      WHERE session_id = ? AND consent_id = ?
    `).get(sessionId, consentId);
    database.prepare(`
      INSERT INTO audit_log (action, target, who, auto, result, detail_json, created_at)
      VALUES ('面试录音授权关联 Session', ?, ?, 0, '成功', ?, ?)
    `).run(
      String(sessionId),
      linkedBy,
      JSON.stringify({ session_id: Number(sessionId), consent_id: consentId }),
      linkedAt,
    );
    return link;
  })();
}

function linkInterviewSessionConfirmation(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewSessionId(input);
  const confirmationId = Number(input.confirmation_id === undefined ? input.confirmationId : input.confirmation_id);
  if (!Number.isInteger(confirmationId) || confirmationId <= 0) throw new Error('confirmationId is required');
  const linkedBy = requiredInterviewActor(input.linked_by === undefined ? input.linkedBy : input.linked_by, 'linkedBy');
  return database.transaction(() => {
    assertInterviewSessionProcessingAllowed(database, sessionId);
    const session = interviewSessionById(database, sessionId);
    if (!session) throw new Error(`interview session not found: ${sessionId}`);
    const confirmation = database.prepare(`
      SELECT id, recording_id FROM interview_recording_confirmation WHERE id = ?
    `).get(confirmationId);
    if (!confirmation) throw new Error(`interview confirmation not found: ${confirmationId}`);
    const material = database.prepare(`
      SELECT id FROM interview_session_material
      WHERE session_id = ? AND interview_recording_id = ?
    `).get(sessionId, confirmation.recording_id);
    if (!material) throw new Error(`interview confirmation ${confirmationId} recording is not linked to interview session ${sessionId}`);
    return insertInterviewSessionLink(database, {
      table: 'interview_session_confirmation',
      idColumn: 'confirmation_id',
      sessionId,
      sourceId: confirmationId,
      linkedBy,
      linkedAt: nowIso(),
    });
  })();
}

function interviewRecordingById(database, id) {
  return database.prepare(`
    SELECT
      r.id, r.summary_path, r.topic, r.source_path, r.wav_path,
      r.transcript_txt_path, r.transcript_srt_path, r.transcript_json_path,
      r.codex_input_path, r.report_path, r.candidate_id, r.job_id, r.status, r.confirmed_at,
      r.raw_summary_json, r.created_at, r.updated_at,
      c.name AS candidate_name,
      j.name AS job_name
    FROM interview_recording r
    LEFT JOIN candidate c ON c.internal_id = r.candidate_id
    LEFT JOIN job j ON j.id = r.job_id
    WHERE r.id = ?
  `).get(id);
}

function assertRecordingLifecycleReadable(database, recordingId, { processing = false, access = 'generic' } = {}) {
  const relation = database.prepare(`
    SELECT session_id FROM interview_session_material
    WHERE interview_recording_id = ? ORDER BY id LIMIT 1
  `).get(Number(recordingId));
  if (!relation) return null;
  const conditions = {
    identity: `(id LIKE @file_prefix OR id = @metadata_id OR id = @confirmations_id OR id LIKE 'db-legacy-report-%')`,
    transcript: `id IN (@transcript_txt, @transcript_srt, @transcript_json)`,
    legacy_report: `id LIKE 'db-legacy-report-%'`,
    confirmations: `id = @confirmations_id`,
    metadata: `id = @metadata_id`,
  };
  const condition = conditions[access];
  const deleted = condition ? database.prepare(`
    SELECT 1 FROM interview_lifecycle_material
    WHERE session_id = @session_id AND state = 'deleted' AND (${condition}) LIMIT 1
  `).get({
    session_id: String(relation.session_id),
    file_prefix: `recording-${Number(recordingId)}-%`,
    metadata_id: `db-recording-metadata-${Number(recordingId)}`,
    confirmations_id: `db-recording-confirmations-${Number(recordingId)}`,
    transcript_txt: `recording-${Number(recordingId)}-transcript-txt`,
    transcript_srt: `recording-${Number(recordingId)}-transcript-srt`,
    transcript_json: `recording-${Number(recordingId)}-transcript-json`,
  }) : null;
  if (deleted) throw materialDeletedError();
  if (processing) assertInterviewSessionProcessingAllowed(database, relation.session_id);
  return Number(relation.session_id);
}

function getInterviewRecording(id, options = {}) {
  const database = conn();
  ensureInterviewRecordingSchema(database);
  const recordingId = Number(id);
  if (!recordingId) throw new Error('recording id is required');
  assertRecordingLifecycleReadable(database, recordingId, { access: options.access || 'generic' });
  return interviewRecordingById(database, recordingId);
}

function listInterviewRecordings(filters = {}) {
  const database = conn();
  ensureInterviewRecordingSchema(database);
  const where = [];
  const params = {};
  const candidateId = text(filters.candidate_id) || text(filters.candidateId);
  const rawJobId = filters.job_id === undefined ? filters.jobId : filters.job_id;
  const jobId = rawJobId === undefined || rawJobId === null || rawJobId === '' ? null : Number(rawJobId);
  if (candidateId) {
    where.push('r.candidate_id = @candidate_id');
    params.candidate_id = candidateId;
  }
  if (filters.unmatched || filters.unmatched === '1') {
    if (jobId) {
      where.push('(r.job_id = @job_id OR r.job_id IS NULL)');
      params.job_id = jobId;
    }
    where.push('(r.candidate_id IS NULL OR r.job_id IS NULL)');
  } else if (jobId) {
    where.push('r.job_id = @job_id');
    params.job_id = jobId;
  }
  if (filters.status) {
    where.push('r.status = @status');
    params.status = text(filters.status);
  }
  const rows = database.prepare(`
    SELECT
      r.id, r.summary_path, r.topic, r.source_path, r.wav_path,
      r.transcript_txt_path, r.transcript_srt_path, r.transcript_json_path,
      r.codex_input_path, r.report_path, r.candidate_id, r.job_id, r.status, r.confirmed_at,
      r.raw_summary_json, r.created_at, r.updated_at,
      c.name AS candidate_name,
      j.name AS job_name,
      ar.id AS report_id,
      ar.status AS report_status,
      ar.updated_at AS report_updated_at,
      ar.confirmed_at AS report_confirmed_at
    FROM interview_recording r
    LEFT JOIN candidate c ON c.internal_id = r.candidate_id
    LEFT JOIN job j ON j.id = r.job_id
    LEFT JOIN interview_ai_report ar ON ar.recording_id = r.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY r.created_at DESC, r.id DESC
  `).all(params);
  for (const row of rows) assertRecordingLifecycleReadable(database, row.id);
  return rows;
}

const INTERVIEW_CONSENT_SCOPE = 'local_recording_transcription_ai_review';
const INTERVIEW_CONSENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INTERVIEW_CONSENT_TEXT_VERSION = '2026-07-10.v2';
const INTERVIEW_CONSENT_TEXT = '已告知候选人：本次面试将进行本地录音、转写，并用于 AI 复盘和招聘记录；候选人已同意。候选人撤回同意后，正在进行的录音会立即中止，未完成材料会被丢弃。';
const INTERVIEW_CONSENT_TEXT_SHA256 = crypto.createHash('sha256').update(INTERVIEW_CONSENT_TEXT, 'utf8').digest('hex');
const INTERVIEW_CONSENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function requiredInterviewConsentRequestId(value) {
  const requestId = (text(value) || '').trim();
  if (!requestId) {
    throw jobOperationError(
      'INTERVIEW_CONSENT_REQUEST_ID_REQUIRED',
      '撤回录音授权必须提供 requestId。',
    );
  }
  if (!INTERVIEW_CONSENT_REQUEST_ID_PATTERN.test(requestId)) {
    throw jobOperationError(
      'INTERVIEW_CONSENT_REQUEST_ID_INVALID',
      'requestId 格式无效：须为 1 到 128 位字母、数字、点、下划线、冒号或连字符。',
    );
  }
  return requestId;
}

function interviewConsentRevocationAuditReplay(database, {
  requestId,
  candidateId,
  actor,
  detailJson,
}) {
  const rows = database.prepare(`
    SELECT target, who, detail_json
    FROM audit_log
    WHERE action = '面试录音同意撤销' AND result = '成功'
    ORDER BY id DESC
  `).all();
  for (const row of rows) {
    let detail;
    try {
      detail = JSON.parse(row.detail_json || '{}');
    } catch {
      continue;
    }
    if (detail.request_id !== requestId) continue;
    if (row.target !== candidateId || row.who !== actor || row.detail_json !== detailJson) {
      throw jobOperationError(
        'IDEMPOTENCY_CONFLICT',
        'requestId 已用于不同的录音授权撤回请求。',
        409,
      );
    }
    return true;
  }
  return false;
}

function interviewConsentRevocationRequestContext(database, {
  candidateId,
  jobId,
  recordedBy = 'HR',
  source = 'candidate_interview_ui',
  requestId,
}) {
  const candidate = text(candidateId);
  const job = Number(jobId);
  const actor = text(recordedBy) || 'HR';
  const normalizedSource = text(source) || 'candidate_interview_ui';
  const normalizedRequestId = requiredInterviewConsentRequestId(requestId);
  const auditDetailJson = JSON.stringify({
    job_id: job,
    scope: INTERVIEW_CONSENT_SCOPE,
    source: normalizedSource,
    consent_text_version: INTERVIEW_CONSENT_TEXT_VERSION,
    consent_text_sha256: INTERVIEW_CONSENT_TEXT_SHA256,
    request_id: normalizedRequestId,
  });
  return {
    actor,
    auditDetailJson,
    requestId: normalizedRequestId,
    replay: interviewConsentRevocationAuditReplay(database, {
      requestId: normalizedRequestId,
      candidateId: candidate,
      actor,
      detailJson: auditDetailJson,
    }),
  };
}

function validateInterviewConsentRevocationRequest(options = {}) {
  const database = conn();
  ensureInterviewRecordingSchema(database);
  const candidate = text(options.candidateId);
  const job = Number(options.jobId);
  if (!candidate || !job) throw new Error('candidateId and jobId are required for interview consent');
  requireJob(database, job);
  const candidateRow = database.prepare('SELECT internal_id, job_id FROM candidate WHERE internal_id = ?').get(candidate);
  if (!candidateRow) throw new Error(`candidate not found: ${candidate}`);
  if (Number(candidateRow.job_id) !== job) throw new Error(`candidate ${candidate} does not belong to job ${job}`);
  return interviewConsentRevocationRequestContext(database, {
    ...options,
    candidateId: candidate,
    jobId: job,
  });
}

function interviewConsentScopeHash(candidateId, jobId) {
  return consentRevocationLatch.scopeHash(candidateId, jobId, INTERVIEW_CONSENT_SCOPE);
}

function interviewConsentRevocationGate(database, candidateId, jobId) {
  const scopeHash = interviewConsentScopeHash(candidateId, jobId);
  const databaseGate = database.prepare(`
    SELECT scope_hash, status, requested_at, updated_at
    FROM interview_recording_consent_revocation_gate
    WHERE scope_hash = ?
  `).get(scopeHash) || null;
  const fallbackGate = consentRevocationLatch.pendingState(scopeHash);
  if (!databaseGate && !fallbackGate) return null;
  return {
    ...(fallbackGate || {}),
    ...(databaseGate || {}),
    scope_hash: scopeHash,
    status: 'pending',
    database_gate: !!databaseGate,
    durable_fallback: !!fallbackGate?.durable_fallback,
    in_memory_fallback: !!fallbackGate?.in_memory_fallback,
    invalid_fallback: !!fallbackGate?.invalid,
  };
}

function interviewConsentRevocationPendingError() {
  return jobOperationError(
    'INTERVIEW_CONSENT_REVOCATION_PENDING',
    '该候选人在此岗位的录音授权撤回仍待持久化；已阻止重新授权、新录音和麦克风预检。',
    409,
  );
}

function beginInterviewConsentRevocationGate({ candidateId, jobId } = {}) {
  const candidate = text(candidateId);
  const job = Number(jobId);
  if (!candidate || !Number.isInteger(job) || job <= 0) {
    throw new Error('candidateId and jobId are required for interview consent revocation');
  }
  const timestamp = nowIso();
  const scopeHash = interviewConsentScopeHash(candidate, job);
  let databaseWritten = false;
  let fallbackWritten = false;
  let databaseError = null;
  let fallbackError = null;
  // The hash-only filesystem latch is deliberately attempted before opening or
  // reading SQLite. It therefore survives database-open, schema, read and
  // INSERT faults—not only a failure of the gate-table INSERT itself.
  try {
    consentRevocationLatch.writeDurableMarker({
      scope_hash: scopeHash,
      requested_at: timestamp,
      updated_at: timestamp,
    });
    fallbackWritten = true;
  } catch (error) {
    fallbackError = error;
  }
  let database = null;
  let validationError = null;
  try {
    database = conn();
    ensureInterviewRecordingSchema(database);
    const jobRow = database.prepare('SELECT id FROM job WHERE id = ?').get(job);
    if (!jobRow) {
      validationError = jobOperationError('JOB_NOT_FOUND', `job not found: ${job}`, 404);
      throw validationError;
    }
    const candidateRow = database.prepare('SELECT internal_id, job_id FROM candidate WHERE internal_id = ?').get(candidate);
    if (!candidateRow) {
      validationError = jobOperationError('CANDIDATE_NOT_FOUND', `candidate not found: ${candidate}`, 404);
      throw validationError;
    }
    if (Number(candidateRow.job_id) !== job) {
      validationError = jobOperationError(
        'CANDIDATE_JOB_MISMATCH',
        `candidate ${candidate} does not belong to job ${job}`,
        409,
      );
      throw validationError;
    }
    database.prepare(`
      INSERT INTO interview_recording_consent_revocation_gate (
        scope_hash, status, requested_at, updated_at
      ) VALUES (?, 'pending', ?, ?)
      ON CONFLICT(scope_hash) DO UPDATE SET
        status = 'pending',
        updated_at = excluded.updated_at
    `).run(scopeHash, timestamp, timestamp);
    databaseWritten = true;
  } catch (error) {
    databaseError = error;
  }
  if (validationError) {
    if (fallbackWritten) {
      try {
        consentRevocationLatch.removeDurableMarker(scopeHash);
        fallbackWritten = false;
      } catch (cleanupError) {
        consentRevocationLatch.blockInMemory(scopeHash);
        validationError.markerCleanupCause = cleanupError;
      }
    }
    throw validationError;
  }
  if (!databaseWritten && !fallbackWritten) {
    consentRevocationLatch.blockInMemory(scopeHash);
    const error = jobOperationError(
      'INTERVIEW_CONSENT_REVOCATION_GATE_FAILED',
      '无法持久化录音授权撤回安全闩锁；当前服务已阻止该候选人与岗位继续录音，请修复本机存储后重试撤回。',
      503,
    );
    error.databaseCause = databaseError;
    error.fallbackCause = fallbackError;
    throw error;
  }
  return {
    scope_hash: scopeHash,
    status: 'pending',
    requested_at: timestamp,
    updated_at: timestamp,
    database_written: databaseWritten,
    fallback_written: fallbackWritten,
  };
}

function blockInterviewConsentRevocationInMemory({ candidateId, jobId } = {}) {
  const scopeHash = interviewConsentScopeHash(candidateId, jobId);
  consentRevocationLatch.blockInMemory(scopeHash);
  return { scope_hash: scopeHash, status: 'pending', in_memory_fallback: true };
}

function completeInterviewConsentRevocationGate({ candidateId, jobId } = {}) {
  const database = conn();
  ensureInterviewRecordingSchema(database);
  const candidate = text(candidateId);
  const job = Number(jobId);
  if (!candidate || !job) throw new Error('candidateId and jobId are required for interview consent revocation completion');
  const scopeHash = interviewConsentScopeHash(candidate, job);
  const active = database.prepare(`
    SELECT COUNT(*) AS n
    FROM interview_recording_consent
    WHERE candidate_id = ? AND job_id = ? AND scope = ? AND status = 'active'
  `).get(candidate, job, INTERVIEW_CONSENT_SCOPE);
  if (Number(active.n) > 0) {
    throw jobOperationError(
      'INTERVIEW_CONSENT_REVOCATION_NOT_COMMITTED',
      '录音授权仍为有效状态，不能释放撤回安全闩锁。',
      409,
    );
  }
  database.transaction(() => {
    database.prepare(`
      DELETE FROM interview_recording_consent_revocation_gate
      WHERE scope_hash = ?
    `).run(scopeHash);
  })();
  try {
    consentRevocationLatch.removeDurableMarker(scopeHash);
  } catch (cause) {
    consentRevocationLatch.blockInMemory(scopeHash);
    const error = jobOperationError(
      'INTERVIEW_CONSENT_REVOCATION_MARKER_CLEAR_FAILED',
      '录音授权已撤回，但本机安全闩锁清理尚未确认；系统将继续阻止重新授权和新录音，请重试完成撤回。',
      503,
    );
    error.cause = cause;
    throw error;
  }
  consentRevocationLatch.clearInMemory(scopeHash);
  return { scope_hash: scopeHash, status: 'cleared' };
}

function getInterviewConsentPolicy() {
  return {
    scope: INTERVIEW_CONSENT_SCOPE,
    text_version: INTERVIEW_CONSENT_TEXT_VERSION,
    text_sha256: INTERVIEW_CONSENT_TEXT_SHA256,
    display_text: INTERVIEW_CONSENT_TEXT,
    max_age_hours: INTERVIEW_CONSENT_MAX_AGE_MS / (60 * 60 * 1000),
  };
}

function getInterviewConsent({ candidateId, jobId, now = Date.now() }) {
  const database = conn();
  ensureInterviewRecordingSchema(database);
  const candidate = text(candidateId);
  const job = Number(jobId);
  if (!candidate || !job) return null;
  const revocationGate = interviewConsentRevocationGate(database, candidate, job);
  const row = database.prepare(`
    SELECT id, candidate_id, job_id, scope, status, consented_at,
           recorded_by, source, consent_text_version, consent_text_sha256,
           revoked_at, created_at, updated_at
    FROM interview_recording_consent
    WHERE candidate_id = ? AND job_id = ? AND scope = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(candidate, job, INTERVIEW_CONSENT_SCOPE);
  if (!row) {
    return revocationGate
      ? {
        status: 'revocation_pending',
        valid: false,
        revocation_pending: true,
        requested_at: revocationGate.requested_at,
        max_age_hours: 24,
      }
      : null;
  }
  const consentedAtMs = Date.parse(row.consented_at);
  const valid = !revocationGate
    && row.status === 'active'
    && Number.isFinite(consentedAtMs)
    && now - consentedAtMs >= 0
    && now - consentedAtMs <= INTERVIEW_CONSENT_MAX_AGE_MS;
  return {
    ...row,
    valid,
    revocation_pending: !!revocationGate,
    revocation_requested_at: revocationGate && revocationGate.requested_at,
    max_age_hours: 24,
  };
}

function recordInterviewConsent({
  candidateId,
  jobId,
  confirmed,
  recordedBy = 'HR',
  source = 'candidate_interview_ui',
  requestId,
}) {
  const candidate = text(candidateId);
  const job = Number(jobId);
  const isConfirmed = confirmed === true;
  if (!candidate || !job) throw new Error('candidateId and jobId are required for interview consent');
  const database = conn();
  ensureInterviewRecordingSchema(database);
  requireJob(database, job);
  const candidateRow = database.prepare('SELECT internal_id, job_id FROM candidate WHERE internal_id = ?').get(candidate);
  if (!candidateRow) throw new Error(`candidate not found: ${candidate}`);
  if (Number(candidateRow.job_id) !== job) throw new Error(`candidate ${candidate} does not belong to job ${job}`);
  const revocationRequest = isConfirmed
    ? null
    : interviewConsentRevocationRequestContext(database, {
      candidateId: candidate,
      jobId: job,
      recordedBy,
      source,
      requestId,
    });
  if (!isConfirmed) {
    beginInterviewConsentRevocationGate({ candidateId: candidate, jobId: job });
  }
  if (isConfirmed && interviewConsentRevocationGate(database, candidate, job)) {
    throw interviewConsentRevocationPendingError();
  }
  if (isConfirmed) assertJobRecruitingWritable(database, job);
  const timestamp = nowIso();
  const scopeHash = interviewConsentScopeHash(candidate, job);
  if (!isConfirmed) {
    const { actor, auditDetailJson, replay } = revocationRequest;
    // Phase 1 makes the revocation fact durable independently. An audit fault
    // in phase 2 must not restore the prior active authorization.
    database.transaction(() => {
      database.prepare(`
      UPDATE interview_recording_consent
      SET status = 'revoked', revoked_at = @timestamp, updated_at = @timestamp
      WHERE candidate_id = @candidate_id AND job_id = @job_id
        AND scope = @scope AND status = 'active'
      `).run({ candidate_id: candidate, job_id: job, scope: INTERVIEW_CONSENT_SCOPE, timestamp });
    })();
    // Phase 2 keeps audit evidence and latch release atomic. If either fails,
    // the consent stays revoked and the still-pending latch keeps retries and
    // restart preflight fail-closed until the same revocation is retried.
    database.transaction(() => {
      if (!replay) {
        writeAuditLog({
          action: '面试录音同意撤销',
          target: candidate,
          who: actor,
          auto: 0,
          result: '成功',
          detail_json: auditDetailJson,
        });
      }
      database.prepare(`
        DELETE FROM interview_recording_consent_revocation_gate
        WHERE scope_hash = ?
      `).run(scopeHash);
    })();
    completeInterviewConsentRevocationGate({ candidateId: candidate, jobId: job });
    return getInterviewConsent({ candidateId: candidate, jobId: job });
  }
  database.transaction(() => {
    database.prepare(`
      UPDATE interview_recording_consent
      SET status = 'revoked', revoked_at = @timestamp, updated_at = @timestamp
      WHERE candidate_id = @candidate_id AND job_id = @job_id
        AND scope = @scope AND status = 'active'
    `).run({ candidate_id: candidate, job_id: job, scope: INTERVIEW_CONSENT_SCOPE, timestamp });
    database.prepare(`
        INSERT INTO interview_recording_consent (
          candidate_id, job_id, scope, status, consented_at,
          recorded_by, source, consent_text_version, consent_text_sha256,
          revoked_at, created_at, updated_at
        ) VALUES (
          @candidate_id, @job_id, @scope, 'active', @consented_at,
          @recorded_by, @source, @consent_text_version, @consent_text_sha256,
          NULL, @created_at, @updated_at
        )
      `).run({
        candidate_id: candidate,
        job_id: job,
        scope: INTERVIEW_CONSENT_SCOPE,
        consented_at: timestamp,
        recorded_by: text(recordedBy) || 'HR',
        source: text(source) || 'candidate_interview_ui',
        consent_text_version: INTERVIEW_CONSENT_TEXT_VERSION,
        consent_text_sha256: INTERVIEW_CONSENT_TEXT_SHA256,
        created_at: timestamp,
        updated_at: timestamp,
    });
    writeAuditLog({
      action: '面试录音同意确认',
      target: candidate,
      who: text(recordedBy) || 'HR',
      auto: 0,
      result: '成功',
      detail_json: JSON.stringify({
        job_id: job,
        scope: INTERVIEW_CONSENT_SCOPE,
        source,
        consent_text_version: INTERVIEW_CONSENT_TEXT_VERSION,
        consent_text_sha256: INTERVIEW_CONSENT_TEXT_SHA256,
      }),
    });
  })();
  return getInterviewConsent({ candidateId: candidate, jobId: job });
}

function requireActiveInterviewConsent({ candidateId, jobId }) {
  const database = conn();
  ensureInterviewRecordingSchema(database);
  if (interviewConsentRevocationGate(database, candidateId, jobId)) {
    throw interviewConsentRevocationPendingError();
  }
  const consent = getInterviewConsent({ candidateId, jobId });
  if (!consent || !consent.valid) {
    throw new Error('开始录音前必须由 HR 在当前候选人页面确认候选人已知情同意；同意记录有效期为 24 小时。');
  }
  return consent;
}

function createInterviewRecording(input) {
  const database = conn();
  ensureInterviewRecordingSchema(database);
  const summaryPath = text(input.summary_path) || text(input.summaryPath);
  if (!summaryPath) throw new Error('summary_path is required');
  const resolvedSummaryPath = path.resolve(summaryPath);
  const known = database.prepare('SELECT id FROM interview_recording WHERE summary_path = ?').get(resolvedSummaryPath);
  if (known) assertRecordingLifecycleReadable(database, known.id, { processing: true, access: 'identity' });
  const material = validateInterviewRecordingPaths(input, { root: INTERVIEW_MATERIAL_ROOT });
  const timestamp = nowIso();
  return database.transaction(() => {
    const existing = database.prepare('SELECT id FROM interview_recording WHERE summary_path = ?').get(material.summary_path);
    if (existing) assertRecordingLifecycleReadable(database, existing.id, { processing: true, access: 'identity' });
    database.prepare(`
      INSERT INTO interview_recording (
        summary_path, topic, source_path, wav_path, transcript_txt_path,
        transcript_srt_path, transcript_json_path, codex_input_path, report_path,
        status, raw_summary_json, created_at, updated_at
      ) VALUES (
        @summary_path, @topic, @source_path, @wav_path, @transcript_txt_path,
        @transcript_srt_path, @transcript_json_path, @codex_input_path, @report_path,
        @status, @raw_summary_json, @created_at, @updated_at
      )
      ON CONFLICT(summary_path) DO UPDATE SET
        topic = excluded.topic,
        source_path = excluded.source_path,
        wav_path = excluded.wav_path,
        transcript_txt_path = excluded.transcript_txt_path,
        transcript_srt_path = excluded.transcript_srt_path,
        transcript_json_path = excluded.transcript_json_path,
        codex_input_path = excluded.codex_input_path,
        report_path = excluded.report_path,
        raw_summary_json = excluded.raw_summary_json,
        updated_at = excluded.updated_at
    `).run({
      summary_path: material.summary_path,
      topic: text(input.topic) || text(material.summary.topic),
      source_path: material.source_path,
      wav_path: material.wav_path,
      transcript_txt_path: material.transcript_txt_path,
      transcript_srt_path: material.transcript_srt_path,
      transcript_json_path: material.transcript_json_path,
      codex_input_path: material.codex_input_path,
      report_path: material.report_path,
      status: text(input.status) || 'pending_match',
      raw_summary_json: JSON.stringify(safeRecordingSummaryMetadata(material.summary)),
      created_at: text(input.created_at) || text(input.createdAt) || text(material.summary.createdAt) || timestamp,
      updated_at: timestamp,
    });
    const row = database.prepare('SELECT id FROM interview_recording WHERE summary_path = ?').get(material.summary_path);
    return interviewRecordingById(database, row.id);
  })();
}

function updateInterviewRecording(id, patch = {}) {
  const database = conn();
  ensureInterviewRecordingSchema(database);
  const recordingId = Number(id);
  if (!recordingId) throw new Error('recording id is required');
  assertRecordingLifecycleReadable(database, recordingId, { processing: true, access: 'identity' });
  const allowed = [
    'topic',
    'source_path',
    'wav_path',
    'transcript_txt_path',
    'transcript_srt_path',
    'transcript_json_path',
    'codex_input_path',
    'report_path',
    'status',
  ];
  const updates = [];
  const params = { id: recordingId, updated_at: nowIso() };
  const pathKinds = {
    source_path: 'source_media',
    wav_path: 'audio',
    transcript_txt_path: 'transcript_txt',
    transcript_srt_path: 'transcript_srt',
    transcript_json_path: 'transcript_json',
    codex_input_path: 'report',
    report_path: 'report',
  };
  for (const key of allowed) {
    if (Object.hasOwn(patch, key)) {
      updates.push(`${key} = @${key}`);
      const value = text(patch[key]);
      if (pathKinds[key] && value) {
        params[key] = validateInterviewMaterialFile(value, pathKinds[key], { root: INTERVIEW_MATERIAL_ROOT }).path;
      } else if ((key === 'wav_path' || key === 'transcript_txt_path') && !value) {
        throw new Error('录音和 transcript.txt 路径不能为空。');
      } else {
        params[key] = value;
      }
    }
  }
  if (!updates.length) return interviewRecordingById(database, recordingId);
  updates.push('updated_at = @updated_at');
  database.prepare(`UPDATE interview_recording SET ${updates.join(', ')} WHERE id = @id`).run(params);
  const row = interviewRecordingById(database, recordingId);
  if (!row) throw new Error(`interview recording not found: ${recordingId}`);
  return row;
}

function bindInterviewRecording(input) {
  const database = conn();
  ensureInterviewRecordingSchema(database);
  const id = Number(input.id);
  if (!id) throw new Error('id is required');
  const candidateId = text(input.candidate_id) || text(input.candidateId);
  const rawJobId = input.job_id === undefined ? input.jobId : input.job_id;
  let jobId = rawJobId === undefined || rawJobId === null || rawJobId === '' ? null : Number(rawJobId);
  if (!candidateId && !jobId) throw new Error('candidateId or jobId is required');
  return database.transaction(() => {
    assertRecordingLifecycleReadable(database, id, { processing: true, access: 'identity' });
    const current = interviewRecordingById(database, id);
    if (!current) throw new Error(`interview recording not found: ${id}`);
    if (candidateId) {
      const candidate = database.prepare('SELECT internal_id, job_id FROM candidate WHERE internal_id = ?').get(candidateId);
      if (!candidate) throw new Error(`candidate not found: ${candidateId}`);
      if (jobId && Number(candidate.job_id) !== Number(jobId)) {
        throw new Error(`candidate ${candidateId} does not belong to job ${jobId}`);
      }
      jobId = Number(candidate.job_id);
    }
    if (jobId) {
      assertJobRecruitingWritable(database, jobId);
    }
    const timestamp = nowIso();
    database.prepare(`
      UPDATE interview_recording
      SET candidate_id = @candidate_id,
          job_id = @job_id,
          status = CASE WHEN status = 'confirmed' THEN status ELSE 'matched' END,
          updated_at = @updated_at
      WHERE id = @id
    `).run({
      id,
      candidate_id: candidateId || current.candidate_id,
      job_id: jobId || current.job_id,
      updated_at: timestamp,
    });
    return interviewRecordingById(database, id);
  })();
}

function reportValidationError(code, path, message) {
  throw new InterviewReportValidationError(code, path, message);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function reportHash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function requiredReportActor(value) {
  const actor = (text(value) || '').trim();
  if (!actor) reportValidationError('ACTOR_REQUIRED', '$.actor', '人工操作者标识不能为空。');
  if (actor.length > 120) reportValidationError('ACTOR_INVALID', '$.actor', '人工操作者标识无效。');
  return actor;
}

function requiredReportRequestId(value) {
  const requestId = (text(value) || '').trim();
  if (!requestId) reportValidationError('REQUEST_ID_REQUIRED', '$.request_id', 'requestId 不能为空。');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) {
    reportValidationError('REQUEST_ID_INVALID', '$.request_id', 'requestId 格式无效。');
  }
  return requestId;
}

function expectedReportVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) {
    reportValidationError('EXPECTED_VERSION_REQUIRED', '$.expected_version', 'expectedVersion 必须是非负整数。');
  }
  return version;
}

function interviewReportSessionId(input) {
  const raw = input && typeof input === 'object'
    ? (input.session_id === undefined ? input.sessionId : input.session_id)
    : input;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) reportValidationError('SESSION_REQUIRED', '$.session_id', '必须提供有效面试 session。');
  return id;
}

function parseSrtTimestamp(value) {
  const match = String(value || '').trim().match(/^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return null;
  return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4]);
}

function parseSrtRanges(value) {
  const ranges = [];
  String(value || '').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{3})/);
    if (!match) return;
    const startMs = parseSrtTimestamp(match[1]);
    const endMs = parseSrtTimestamp(match[2]);
    if (Number.isInteger(startMs) && Number.isInteger(endMs) && endMs > startMs) {
      ranges.push({ start_ms: startMs, end_ms: endMs });
    }
  });
  return ranges;
}

function materialDeletedError() {
  const error = new Error('The interview material was deleted by retention policy.');
  error.code = 'MATERIAL_DELETED';
  return error;
}

function assertLifecycleMaterialReadable(database, materialId) {
  const lifecycle = database.prepare(`
    SELECT state FROM interview_lifecycle_material WHERE id = ?
  `).get(materialId);
  if (lifecycle && lifecycle.state === 'deleted') throw materialDeletedError();
}

function assertInterviewReportNotDeleted(database, sessionId) {
  const deleted = database.prepare(`
    SELECT 1 FROM interview_lifecycle_material
    WHERE session_id = ? AND storage_kind = 'sqlite'
      AND db_entity_type = 'interview_report_v1' AND state = 'deleted'
    LIMIT 1
  `).get(String(sessionId));
  if (deleted) throw materialDeletedError();
}

function interviewReportMaterial(database, materialId) {
  const row = database.prepare(`
    SELECT material.id, material.session_id, material.material_kind,
           material.job_interview_id, material.interview_recording_id,
           online.transcript AS online_transcript,
           manual_note.id AS manual_note_id,
           manual_note.status AS manual_note_status,
           manual_note.version AS manual_note_version,
           recording.transcript_txt_path, recording.transcript_srt_path,
           recording.transcript_json_path
    FROM interview_session_material material
    LEFT JOIN job_interview online ON online.id = material.job_interview_id
    LEFT JOIN interview_session_manual_note manual_note
      ON manual_note.session_id = material.session_id
      AND manual_note.job_interview_id = material.job_interview_id
    LEFT JOIN interview_recording recording ON recording.id = material.interview_recording_id
    WHERE material.id = ?
  `).get(Number(materialId));
  if (!row) return null;
  if (row.material_kind === 'online_minutes') {
    assertLifecycleMaterialReadable(database, `db-job-interview-${row.job_interview_id}`);
    if (row.manual_note_id && row.manual_note_status !== 'active') {
      reportValidationError('EVIDENCE_MATERIAL_REVOKED', '$.evidence_refs', '所选 HR 人工笔记已撤销，不能继续作为报告证据。');
    }
    return {
      ...row,
      text: typeof row.online_transcript === 'string' ? row.online_transcript : '',
      time_ranges: [],
      cues: [],
      source_type: row.manual_note_id ? 'manual_note' : 'online_minutes',
      transcript_review_status: row.manual_note_id ? 'human_authored' : null,
      transcript_accuracy_label: row.manual_note_id ? 'HR 人工面试笔记（非 ASR）' : null,
    };
  }
  assertRecordingLifecycleReadable(database, row.interview_recording_id, { access: 'transcript' });
  if (!row.transcript_txt_path) reportValidationError('EVIDENCE_MATERIAL_UNAVAILABLE', '$.evidence_refs', '证据材料不可验证。');
  const transcript = readControlledTextFile(row.transcript_txt_path, 'transcript_txt', { root: INTERVIEW_MATERIAL_ROOT });
  let canonical = null;
  if (row.transcript_json_path) {
    const json = readControlledTextFile(row.transcript_json_path, 'transcript_json', { root: INTERVIEW_MATERIAL_ROOT });
    canonical = readCanonicalTranscript(json.text);
  }
  let timeRanges = canonical
    ? canonical.cues.map((cue) => ({ start_ms: cue.start_ms, end_ms: cue.end_ms }))
    : [];
  if (row.transcript_srt_path) {
    const srt = readControlledTextFile(row.transcript_srt_path, 'transcript_srt', { root: INTERVIEW_MATERIAL_ROOT });
    if (!canonical) {
      try { canonical = buildCanonicalTranscript({ srt: srt.text }); } catch {}
    }
    timeRanges = canonical
      ? canonical.cues.map((cue) => ({ start_ms: cue.start_ms, end_ms: cue.end_ms }))
      : parseSrtRanges(srt.text);
  }
  return {
    ...row,
    text: transcript.text,
    time_ranges: timeRanges,
    cues: canonical ? canonical.cues : [],
    transcript_review_status: canonical ? canonical.review_status : 'unreviewed',
    transcript_accuracy_label: canonical ? canonical.accuracy_label : 'ASR 转写草稿（未经逐字复核）',
    low_confidence_cue_count: canonical ? canonical.low_confidence_cue_count : 0,
  };
}

function interviewReportValidationContext(database, sessionId) {
  const cache = new Map();
  return {
    sessionId,
    resolveMaterial(materialId) {
      const id = Number(materialId);
      if (!cache.has(id)) cache.set(id, interviewReportMaterial(database, id));
      return cache.get(id);
    },
  };
}

function interviewReportRow(database, sessionId) {
  return database.prepare(`
    SELECT id, session_id, schema_version, status, report_json, content_hash,
           version, created_by, updated_by, confirmed_by, confirmed_at,
           rejected_by, rejected_at, created_at, updated_at
    FROM interview_report_v1
    WHERE session_id = ?
  `).get(Number(sessionId));
}

function reportFactReviewRows(database, reportId) {
  return database.prepare(`
    SELECT id, report_id, field_key, fact_hash, status, corrected_value,
           reviewed_by, reviewed_at, version, created_at, updated_at
    FROM interview_report_fact_review
    WHERE report_id = ?
    ORDER BY id
  `).all(Number(reportId));
}

function storedInterviewReportProjection(database, reportId) {
  const row = database.prepare(`
    SELECT report_id, session_id, source_report_version, projection_json,
           content_hash, created_by, created_at
    FROM interview_report_confirmed_projection
    WHERE report_id = ?
  `).get(Number(reportId));
  if (!row) return null;
  let projection = null;
  try { projection = JSON.parse(row.projection_json); } catch {}
  if (!projection || reportHash(projection) !== row.content_hash) {
    reportValidationError('CONFIRMED_PROJECTION_INVALID', '$.confirmed_projection', '已确认面试报告投影完整性校验失败。');
  }
  return { ...row, projection };
}

function resolvedInterviewReportProjection(database, row) {
  if (!row || row.status !== 'confirmed') return null;
  const stored = storedInterviewReportProjection(database, row.id);
  if (stored) return stored;
  const built = buildConfirmedInterviewProjection({
    reportRow: row,
    factReviews: reportFactReviewRows(database, row.id),
  });
  return {
    report_id: Number(row.id),
    session_id: Number(row.session_id),
    source_report_version: Number(row.version),
    projection_json: built.projectionJson,
    content_hash: built.contentHash,
    created_by: row.confirmed_by,
    created_at: row.confirmed_at,
    projection: built.projection,
    legacy_computed: true,
  };
}

function publicInterviewReport(row, options = {}) {
  if (!row) return null;
  const database = options.database || db;
  let sourceReport = null;
  try { sourceReport = JSON.parse(row.report_json); } catch {}
  const confirmedProjection = database ? resolvedInterviewReportProjection(database, row) : null;
  const sourceStatus = database ? interviewReportSourceStatus(database, row) : {
    tracked: false,
    stale: false,
    reason: null,
  };
  return {
    ...row,
    report: confirmedProjection ? confirmedProjection.projection.report : sourceReport,
    source_report: confirmedProjection ? sourceReport : undefined,
    confirmed_projection: confirmedProjection ? {
      schema_version: confirmedProjection.projection.schema_version,
      source_report_version: Number(confirmedProjection.source_report_version),
      content_hash: confirmedProjection.content_hash,
      created_by: confirmedProjection.created_by,
      created_at: confirmedProjection.created_at,
      legacy_computed: confirmedProjection.legacy_computed === true,
      fact_reviews: confirmedProjection.projection.fact_reviews,
    } : null,
    source_snapshot: sourceStatus,
    stale: sourceStatus.stale,
    stale_reason: sourceStatus.reason,
    read_only: row.status !== 'draft',
    legacy: false,
    idempotent_replay: options.idempotentReplay === true,
  };
}

function reportRequestReplay(database, { requestId, action, payloadHash, sessionId }) {
  const row = database.prepare(`
    SELECT request_id, report_id, session_id, action, payload_hash,
           response_version, response_status
    FROM interview_report_action_request
    WHERE request_id = ?
  `).get(requestId);
  if (!row) return null;
  if (row.action !== action || row.payload_hash !== payloadHash || Number(row.session_id) !== Number(sessionId)) {
    reportValidationError('IDEMPOTENCY_CONFLICT', '$.request_id', 'requestId 已用于不同请求。');
  }
  const current = interviewReportRow(database, sessionId);
  if (!current || Number(current.id) !== Number(row.report_id)) {
    reportValidationError('IDEMPOTENCY_STATE_INVALID', '$.request_id', '幂等请求状态不可用。');
  }
  return publicInterviewReport(current, { idempotentReplay: true });
}

function insertReportRequest(database, input) {
  database.prepare(`
    INSERT INTO interview_report_action_request (
      request_id, report_id, session_id, action, payload_hash,
      response_version, response_status, actor, created_at
    ) VALUES (
      @request_id, @report_id, @session_id, @action, @payload_hash,
      @response_version, @response_status, @actor, @created_at
    )
  `).run(input);
}

function assertReportSession(database, sessionId) {
  const session = interviewSessionById(database, sessionId);
  if (!session) reportValidationError('SESSION_NOT_FOUND', '$.session_id', '面试 session 不存在。');
  const materialCount = database.prepare('SELECT COUNT(*) AS n FROM interview_session_material WHERE session_id = ?').get(sessionId).n;
  if (!materialCount) reportValidationError('SESSION_MATERIAL_REQUIRED', '$.session_id', '面试 session 尚未关联材料。');
  return session;
}

function f009ContextId(prefix, value, index) {
  const slug = String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return `${prefix}.${slug || index + 1}`;
}

function f009Text(value, max = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function f009HardRequirements(database, jobId) {
  const profile = database.prepare(`
    SELECT profile.config_json
    FROM job_profile_version profile
    JOIN job_jd_version jd ON jd.id = profile.jd_version_id
    WHERE profile.job_id = ? AND profile.status = 'confirmed' AND jd.status = 'active'
    ORDER BY profile.version DESC, profile.id DESC LIMIT 1
  `).get(Number(jobId));
  if (!profile) return [];
  const config = parseJson(profile.config_json) || {};
  const deepProfile = (
    config.deep_profile && typeof config.deep_profile === 'object'
      ? (config.deep_profile.doc || config.deep_profile)
      : {}
  );
  const candidates = [
    ...(Array.isArray(config.hard_requirements) ? config.hard_requirements : []),
    ...(Array.isArray(deepProfile.hard_requirements) ? deepProfile.hard_requirements : []),
  ];
  const hardBars = config.hard_bars && typeof config.hard_bars === 'object'
    ? config.hard_bars
    : {};
  if (hardBars.degree && hardBars.degree.enabled === true) {
    candidates.push({
      item: `学历须为：${(hardBars.degree.allowed || []).map(f009Text).filter(Boolean).join('、') || '以已确认岗位画像为准'}`,
      source_id: 'degree',
    });
  }
  if (hardBars.salary && hardBars.salary.enabled === true) {
    candidates.push({
      item: `候选人期望月薪不得高于 ${Number(hardBars.salary.cap_k) || 0}K`,
      source_id: 'salary',
    });
  }
  if (hardBars.city && hardBars.city.enabled === true) {
    candidates.push({
      item: `工作城市须为：${(hardBars.city.allowed || []).map(f009Text).filter(Boolean).join('、') || '以已确认岗位画像为准'}`,
      source_id: 'city',
    });
  }
  const unique = new Set();
  return candidates.map((item, index) => {
    const label = f009Text(
      typeof item === 'string'
        ? item
        : (item && (item.item || item.label || item.requirement || item.detail)),
      300,
    );
    if (!label || unique.has(label)) return null;
    unique.add(label);
    return {
      id: f009ContextId('hard_requirement', item && item.source_id, index),
      label,
    };
  }).filter(Boolean).slice(0, 40);
}

function f009ConfirmedResumeFacts(database, candidateId) {
  const confirmedKinds = new Set([
    'confirmed_fact',
    'resume_fact_confirmed',
    'hr_confirmed_resume_fact',
    '已确认事实',
    '简历事实已确认',
  ]);
  return database.prepare(`
    SELECT id, target_ref, kind, value
    FROM field_annotation
    WHERE candidate_id = ?
      AND LOWER(TRIM(COALESCE(author_role, ''))) IN ('hr', 'human_resources', 'recruiter', '招聘')
    ORDER BY created_at, id
  `).all(String(candidateId)).map((row, index) => {
    if (!confirmedKinds.has(String(row.kind || '').trim().toLowerCase())) return null;
    const value = f009Text(row.value, 600);
    if (!value) return null;
    return {
      id: f009ContextId('resume_fact', row.id, index),
      label: f009Text(row.target_ref, 160) || 'HR 已确认简历事实',
      value,
    };
  }).filter(Boolean).slice(0, 40);
}

function f009AssessmentSummary(value, candidateName) {
  const analysis = parseJson(value);
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return '';
  const fragments = [];
  if (analysis.summary) fragments.push(f009Text(analysis.summary, 900));
  if (Array.isArray(analysis.highlights)) {
    analysis.highlights.slice(0, 4).forEach((item) => {
      const label = f009Text(item && (item.label || item.name), 120);
      const content = f009Text(item && (item.value || item.level || item.point), 240);
      if (label && content) fragments.push(`${label}：${content}`);
    });
  }
  if (Array.isArray(analysis.strengths)) {
    const strengths = analysis.strengths.slice(0, 4)
      .map((item) => f009Text(item && (item.name || item.point || item.value || item), 180))
      .filter(Boolean);
    if (strengths.length) fragments.push(`已确认优势摘要：${strengths.join('；')}`);
  }
  if (Array.isArray(analysis.watchouts)) {
    const watchouts = analysis.watchouts.slice(0, 4)
      .map((item) => f009Text(item && (item.name || item.point || item.value || item), 180))
      .filter(Boolean);
    if (watchouts.length) fragments.push(`已确认关注摘要：${watchouts.join('；')}`);
  }
  let summary = fragments.filter(Boolean).join('；').slice(0, 1600);
  const name = f009Text(candidateName, 120);
  if (name) summary = summary.split(name).join('[候选人]');
  return summary;
}

function f009ConfirmedAssessments(database, session) {
  if (!tableExists(database, 'assessment_document') || !tableExists(database, 'assessment_binding')) return [];
  return database.prepare(`
    SELECT document.id, document.report_type, document.analysis_status, document.analysis_json
    FROM assessment_binding binding
    JOIN assessment_document document ON document.id = binding.document_id
    WHERE binding.candidate_id = ? AND binding.job_id = ?
      AND binding.scope = 'candidate_job_archive' AND binding.state = 'active'
      AND document.security_state = 'accepted' AND document.review_state = 'ready'
      AND document.lifecycle_state = 'active'
      AND document.report_type <> 'unknown'
    ORDER BY COALESCE(document.assessment_date, document.created_at) DESC, document.id
  `).all(session.candidate_id, Number(session.job_id)).map((row) => {
    const summary = String(row.analysis_status || '') === 'ready'
      ? f009AssessmentSummary(row.analysis_json, session.candidate_name)
      : '';
    return {
      document_id: String(row.id),
      report_type: String(row.report_type),
      summary_status: summary ? 'available' : 'unavailable',
      ...(summary ? { summary } : {}),
    };
  }).slice(0, 20);
}

function f009MinimalContext(database, session) {
  return {
    hard_requirements: f009HardRequirements(database, session.job_id),
    confirmed_resume_facts: f009ConfirmedResumeFacts(database, session.candidate_id),
    confirmed_assessments: f009ConfirmedAssessments(database, session),
  };
}

function reportEvidenceMaterialIds(report) {
  const ids = new Set();
  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Number.isInteger(value.material_id) && value.material_id > 0) ids.add(value.material_id);
    Object.values(value).forEach(visit);
  }
  visit(report);
  return [...ids].sort((left, right) => left - right);
}

function normalizedReportSourceMaterialIds(database, sessionId, report, requested) {
  let ids = requested === undefined ? reportEvidenceMaterialIds(report) : requested;
  if (!Array.isArray(ids)) {
    reportValidationError('MATERIAL_IDS_INVALID', '$.sourceMaterialIds', '报告来源材料必须是数组。');
  }
  ids = ids.map(Number);
  if (!ids.length) {
    ids = database.prepare(`
      SELECT id FROM interview_session_material
      WHERE session_id = ? ORDER BY id
    `).all(sessionId).map((row) => Number(row.id));
  }
  if (!ids.length || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    reportValidationError('MATERIAL_IDS_INVALID', '$.sourceMaterialIds', '报告必须绑定至少一份有效来源材料。');
  }
  if (new Set(ids).size !== ids.length) {
    reportValidationError('MATERIAL_IDS_DUPLICATE', '$.sourceMaterialIds', '报告来源材料不能重复。');
  }
  const linked = new Set(database.prepare(`
    SELECT id FROM interview_session_material WHERE session_id = ?
  `).all(sessionId).map((row) => Number(row.id)));
  ids.forEach((id, index) => {
    if (!linked.has(id)) {
      reportValidationError('EVIDENCE_CROSS_SESSION', `$.sourceMaterialIds[${index}]`, '报告来源材料不属于当前面试 session。');
    }
  });
  return ids.sort((left, right) => left - right);
}

function interviewReportSourceState(database, sessionId, materialIds) {
  const session = interviewSessionById(database, sessionId);
  if (!session) reportValidationError('SESSION_NOT_FOUND', '$.session_id', '面试 session 不存在。');
  const materials = materialIds.map((materialId, index) => {
    let material;
    try {
      material = interviewReportMaterial(database, materialId);
    } catch (error) {
      if (error instanceof InterviewReportValidationError) throw error;
      reportValidationError('EVIDENCE_MATERIAL_UNAVAILABLE', `$.sourceMaterialIds[${index}]`, '报告来源材料不可读取。');
    }
    if (!material || Number(material.session_id) !== Number(sessionId)) {
      reportValidationError('EVIDENCE_MATERIAL_UNAVAILABLE', `$.sourceMaterialIds[${index}]`, '报告来源材料不可读取。');
    }
    const content = {
      text: material.text,
      cues: material.cues || [],
      transcript_review_status: material.transcript_review_status || null,
      transcript_accuracy_label: material.transcript_accuracy_label || null,
      manual_note_version: material.manual_note_version === null || material.manual_note_version === undefined
        ? null
        : Number(material.manual_note_version),
    };
    return {
      material_id: Number(materialId),
      material_kind: material.material_kind,
      source_type: material.source_type || material.material_kind,
      content_hash: reportHash(content),
    };
  });
  return {
    schema_version: 'interview_report_source_snapshot_v1',
    session_id: Number(sessionId),
    materials,
    context: f009MinimalContext(database, session),
  };
}

function interviewReportSourceSnapshotRow(database, reportId) {
  return database.prepare(`
    SELECT report_id, session_id, material_ids_json, source_json,
           source_hash, created_at, updated_at
    FROM interview_report_source_snapshot
    WHERE report_id = ?
  `).get(Number(reportId)) || null;
}

function saveInterviewReportSourceSnapshot(database, reportId, sessionId, materialIds, timestamp) {
  const source = interviewReportSourceState(database, sessionId, materialIds);
  const sourceJson = stableJson(source);
  const sourceHash = reportHash(source);
  database.prepare(`
    INSERT INTO interview_report_source_snapshot (
      report_id, session_id, material_ids_json, source_json,
      source_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(report_id) DO UPDATE SET
      session_id = excluded.session_id,
      material_ids_json = excluded.material_ids_json,
      source_json = excluded.source_json,
      source_hash = excluded.source_hash,
      updated_at = excluded.updated_at
  `).run(
    reportId,
    sessionId,
    JSON.stringify(materialIds),
    sourceJson,
    sourceHash,
    timestamp,
    timestamp,
  );
  return { materialIds, source, sourceHash, createdAt: timestamp, updatedAt: timestamp };
}

function interviewReportSourceStatus(database, reportRow) {
  const snapshot = interviewReportSourceSnapshotRow(database, reportRow.id);
  if (!snapshot) return { tracked: false, stale: false, reason: null };
  let materialIds;
  try { materialIds = JSON.parse(snapshot.material_ids_json); } catch { materialIds = null; }
  if (!Array.isArray(materialIds) || !materialIds.length) {
    return {
      tracked: true,
      stale: true,
      reason: 'SOURCE_SNAPSHOT_INVALID',
      source_hash: snapshot.source_hash,
      material_ids: [],
      created_at: snapshot.created_at,
      updated_at: snapshot.updated_at,
    };
  }
  try {
    const current = interviewReportSourceState(database, Number(reportRow.session_id), materialIds.map(Number));
    const currentHash = reportHash(current);
    return {
      tracked: true,
      stale: currentHash !== snapshot.source_hash,
      reason: currentHash === snapshot.source_hash ? null : 'SOURCE_CHANGED',
      source_hash: snapshot.source_hash,
      current_source_hash: currentHash,
      material_ids: materialIds.map(Number),
      created_at: snapshot.created_at,
      updated_at: snapshot.updated_at,
    };
  } catch (error) {
    return {
      tracked: true,
      stale: true,
      reason: String(error && error.code ? error.code : 'SOURCE_UNAVAILABLE'),
      source_hash: snapshot.source_hash,
      current_source_hash: null,
      material_ids: materialIds.map(Number),
      created_at: snapshot.created_at,
      updated_at: snapshot.updated_at,
    };
  }
}

function assertInterviewReportSourcesCurrent(database, reportRow) {
  const status = interviewReportSourceStatus(database, reportRow);
  if (status.tracked && status.stale) {
    reportValidationError('REPORT_SOURCES_STALE', '$.source_snapshot', '报告来源材料或已确认上下文已变化，请重新生成或保存草稿后再确认。');
  }
  return status;
}

function getF009InterviewMaterials(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewReportSessionId(input);
  assertInterviewSessionProcessingAllowed(database, sessionId);
  const session = assertReportSession(database, sessionId);
  const requested = input.material_ids === undefined ? input.materialIds : input.material_ids;
  if (!Array.isArray(requested) || !requested.length) {
    reportValidationError('MATERIAL_SELECTION_REQUIRED', '$.materialIds', '必须由 HR 显式选择至少一份面试转写材料。');
  }
  const linkedIds = database.prepare(`
    SELECT id FROM interview_session_material
    WHERE session_id = ? ORDER BY id
  `).all(sessionId).map((row) => Number(row.id));
  const materialIds = requested.map((value) => Number(value));
  if (!Array.isArray(materialIds) || !materialIds.length || materialIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    reportValidationError('MATERIAL_IDS_INVALID', '$.materialIds', '必须选择有效的面试转写材料。');
  }
  if (new Set(materialIds).size !== materialIds.length) {
    reportValidationError('MATERIAL_IDS_DUPLICATE', '$.materialIds', '面试转写材料不能重复选择。');
  }
  const linked = new Set(linkedIds);
  const materials = materialIds.sort((a, b) => a - b).map((id, index) => {
    if (!linked.has(id)) reportValidationError('EVIDENCE_CROSS_SESSION', `$.materialIds[${index}]`, '所选材料不属于当前面试 session。');
    const material = interviewReportMaterial(database, id);
    if (!material || typeof material.text !== 'string' || !material.text.trim()) {
      reportValidationError('EVIDENCE_MATERIAL_UNAVAILABLE', `$.materialIds[${index}]`, '所选转写材料不可读取。');
    }
    return {
      id,
      session_id: sessionId,
      text: material.text,
      cues: Array.isArray(material.cues) ? material.cues : [],
      transcript_review_status: material.transcript_review_status || null,
      transcript_accuracy_label: material.transcript_accuracy_label || null,
      low_confidence_cue_count: Number(material.low_confidence_cue_count || 0),
    };
  });
  return { sessionId, materials, context: f009MinimalContext(database, session) };
}

function publicF009Audit(row) {
  if (!row) return null;
  let materialIds = [];
  try { materialIds = JSON.parse(row.material_ids_json); } catch {}
  return {
    requestId: row.request_id,
    sessionId: Number(row.session_id),
    materialIds,
    requestHash: row.request_hash,
    responseHash: row.response_hash || null,
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    returnedModel: row.returned_model || null,
    promptVersion: row.prompt_version,
    promptHash: row.prompt_hash || null,
    schemaVersion: row.schema_version,
    modelCatalogHash: row.model_catalog_hash || null,
    sourceVersionHash: row.source_version_hash || null,
    status: row.status,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
    errorCode: row.error_code || null,
    reportId: row.report_id === null ? null : Number(row.report_id),
    actor: row.actor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getF009LlmAudit(requestId) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const id = requiredReportRequestId(requestId);
  return publicF009Audit(database.prepare('SELECT * FROM interview_llm_request_audit WHERE request_id = ?').get(id));
}

function assertF009LlmActor(requestId, actor) {
  const normalizedActor = requiredReportActor(actor);
  const audit = getF009LlmAudit(requestId);
  if (!audit) reportValidationError('LLM_REQUEST_NOT_FOUND', '$.requestId', '外部 AI 请求不存在。');
  if (audit.actor !== normalizedActor) {
    reportValidationError('PREVIEW_ACTOR_MISMATCH', '$.actor', '本次操作人与外部 AI 预览记录不一致。');
  }
  return audit;
}

function createF009LlmPreviewAudit(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const requestId = requiredReportRequestId(input.requestId);
  const sessionId = interviewReportSessionId(input);
  const actor = requiredReportActor(input.actor);
  const materialIds = Array.isArray(input.materialIds) ? input.materialIds.map(Number) : [];
  if (!materialIds.length || materialIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    reportValidationError('MATERIAL_IDS_INVALID', '$.materialIds', '必须选择有效的面试转写材料。');
  }
  const requestHash = String(input.requestHash || '').trim();
  if (!/^[a-f0-9]{64}$/.test(requestHash)) reportValidationError('REQUEST_HASH_INVALID', '$.requestHash', '发送内容 hash 无效。');
  const provider = String(input.provider || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider)) {
    reportValidationError('PROVIDER_INVALID', '$.provider', '外部 AI Provider 标识无效。');
  }
  const baseUrl = String(input.baseUrl || '').trim();
  let parsedBaseUrl;
  try { parsedBaseUrl = new URL(baseUrl); } catch {}
  if (!parsedBaseUrl || parsedBaseUrl.protocol !== 'https:' || !parsedBaseUrl.hostname
    || parsedBaseUrl.username || parsedBaseUrl.password || parsedBaseUrl.search || parsedBaseUrl.hash) {
    reportValidationError('BASE_URL_INVALID', '$.baseUrl', '外部 AI Base URL 无效。');
  }
  const timestamp = nowIso();
  return database.transaction(() => {
    assertInterviewSessionProcessingAllowed(database, sessionId);
    assertReportSession(database, sessionId);
    const existing = database.prepare('SELECT * FROM interview_llm_request_audit WHERE request_id = ?').get(requestId);
    if (existing) {
      if (existing.request_hash !== requestHash
        || Number(existing.session_id) !== sessionId
        || existing.actor !== actor
        || existing.provider !== provider
        || existing.base_url !== baseUrl
        || existing.model !== String(input.model || '')
        || existing.prompt_version !== String(input.promptVersion || '')
        || existing.prompt_hash !== String(input.promptHash || '')
        || existing.model_catalog_hash !== String(input.modelCatalogHash || '')
        || existing.source_version_hash !== String(input.sourceVersionHash || '')) {
        reportValidationError('IDEMPOTENCY_CONFLICT', '$.requestId', 'requestId 已用于不同的外部 AI 预览。');
      }
      return publicF009Audit(existing);
    }
    const model = String(input.model || '').trim();
    const promptVersion = String(input.promptVersion || '').trim();
    const promptHash = String(input.promptHash || '').trim();
    const modelCatalogHash = String(input.modelCatalogHash || '').trim();
    const sourceVersionHash = String(input.sourceVersionHash || '').trim();
    if (!model || !promptVersion || ![promptHash, modelCatalogHash, sourceVersionHash].every((value) => /^[a-f0-9]{64}$/.test(value))) {
      reportValidationError('LLM_PREVIEW_VERSION_REQUIRED', '$.model', '模型目录、提示词和源码版本证据不能为空。');
    }
    database.prepare(`
      INSERT INTO interview_llm_request_audit (
        request_id, session_id, material_ids_json, request_hash, response_hash,
        provider, base_url, model, returned_model, prompt_version, prompt_hash, schema_version,
        model_catalog_hash, source_version_hash, status,
        duration_ms, input_tokens, output_tokens, error_code, report_id,
        actor, created_at, updated_at
      ) VALUES (
        @request_id, @session_id, @material_ids_json, @request_hash, NULL,
        @provider, @base_url, @model, NULL, @prompt_version, @prompt_hash, 'interview_report_v1',
        @model_catalog_hash, @source_version_hash, 'previewed',
        NULL, NULL, NULL, NULL, NULL, @actor, @created_at, @updated_at
      )
    `).run({
      request_id: requestId,
      session_id: sessionId,
      material_ids_json: JSON.stringify(materialIds),
      request_hash: requestHash,
      provider,
      base_url: baseUrl,
      model,
      prompt_version: promptVersion,
      prompt_hash: promptHash,
      model_catalog_hash: modelCatalogHash,
      source_version_hash: sourceVersionHash,
      actor,
      created_at: timestamp,
      updated_at: timestamp,
    });
    return publicF009Audit(database.prepare('SELECT * FROM interview_llm_request_audit WHERE request_id = ?').get(requestId));
  })();
}

function claimF009LlmRequest(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const requestId = requiredReportRequestId(input.requestId);
  const requestHash = String(input.requestHash || '').trim();
  return database.transaction(() => {
    const row = database.prepare('SELECT * FROM interview_llm_request_audit WHERE request_id = ?').get(requestId);
    const current = publicF009Audit(row);
    if (!current) reportValidationError('LLM_PREVIEW_REQUIRED', '$.requestId', '必须先预览外部 AI 发送内容。');
    assertInterviewSessionProcessingAllowed(database, current.sessionId);
    if (current.requestHash !== requestHash) reportValidationError('PREVIEW_HASH_MISMATCH', '$.requestHash', '发送内容与预览不一致。');
    if (current.status !== 'previewed') reportValidationError('REQUEST_ALREADY_USED', '$.requestId', '该外部 AI 请求已发送或已终止，不能重复计费调用。');
    if (Date.now() - Date.parse(current.createdAt) > 10 * 60 * 1000) {
      reportValidationError('LLM_PREVIEW_EXPIRED', '$.requestId', '发送预览已超过十分钟，请重新预览。');
    }
    if (String(input.actor || '') !== current.actor) reportValidationError('PREVIEW_ACTOR_MISMATCH', '$.actor', '本次发送操作者与人工预览记录不一致。');
    if (Number(input.sessionId) !== current.sessionId
      || stableJson((input.materialIds || []).map(Number).sort((a, b) => a - b)) !== stableJson(current.materialIds)) {
      reportValidationError('PREVIEW_MATERIAL_MISMATCH', '$.materialIds', '本次发送 session 或材料与人工预览不一致。');
    }
    if (String(input.model || '') !== current.model
      || String(input.promptVersion || '') !== current.promptVersion
      || String(input.promptHash || '') !== current.promptHash
      || String(input.schemaVersion || '') !== current.schemaVersion
      || String(input.modelCatalogHash || '') !== current.modelCatalogHash
      || String(input.sourceVersionHash || '') !== current.sourceVersionHash) {
      reportValidationError('PREVIEW_VERSION_MISMATCH', '$.requestId', '模型、提示词或 Schema 已变化，请重新预览。');
    }
    const info = database.prepare(`
      UPDATE interview_llm_request_audit
      SET status = 'running', updated_at = ?
      WHERE request_id = ? AND status = 'previewed'
    `).run(nowIso(), requestId);
    if (!info.changes) reportValidationError('REQUEST_ALREADY_USED', '$.requestId', '该外部 AI 请求已发送或已终止，不能重复计费调用。');
    return publicF009Audit(database.prepare('SELECT * FROM interview_llm_request_audit WHERE request_id = ?').get(requestId));
  })();
}

function reconcileF009RunningRequests(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const errorCode = String(input.errorCode || 'PROCESS_INTERRUPTED').slice(0, 80);
  const timestamp = nowIso();
  const info = database.prepare(`
    UPDATE interview_llm_request_audit
    SET status = 'failed', error_code = ?, updated_at = ?
    WHERE status = 'running'
  `).run(errorCode, timestamp);
  return { recovered: Number(info.changes), errorCode, updatedAt: timestamp };
}

function finishF009LlmRequest(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const requestId = requiredReportRequestId(input.requestId);
  const allowedStatuses = new Set(['draft_saved', 'cancelled', 'timeout', 'failed', 'invalid_response']);
  const status = String(input.status || '');
  if (!allowedStatuses.has(status)) reportValidationError('LLM_AUDIT_STATUS_INVALID', '$.status', '外部 AI 审计状态无效。');
  const timestamp = nowIso();
  const info = database.prepare(`
    UPDATE interview_llm_request_audit SET
      status = @status,
      response_hash = @response_hash,
      returned_model = @returned_model,
      duration_ms = @duration_ms,
      input_tokens = @input_tokens,
      output_tokens = @output_tokens,
      error_code = @error_code,
      report_id = @report_id,
      updated_at = @updated_at
    WHERE request_id = @request_id AND status = 'running'
  `).run({
    request_id: requestId,
    status,
    response_hash: input.responseHash || null,
    returned_model: input.returnedModel || null,
    duration_ms: input.durationMs === undefined ? null : Math.max(0, Number(input.durationMs) || 0),
    input_tokens: input.inputTokens === undefined || input.inputTokens === null ? null : Math.max(0, Number(input.inputTokens) || 0),
    output_tokens: input.outputTokens === undefined || input.outputTokens === null ? null : Math.max(0, Number(input.outputTokens) || 0),
    error_code: input.errorCode ? String(input.errorCode).slice(0, 80) : null,
    report_id: input.reportId === undefined ? null : Number(input.reportId),
    updated_at: timestamp,
  });
  if (!info.changes) reportValidationError('LLM_REQUEST_NOT_RUNNING', '$.requestId', '外部 AI 请求不在可结束状态。');
  return getF009LlmAudit(requestId);
}

function saveF009DraftAndFinishAudit(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  return database.transaction(() => {
    const auditBefore = database.prepare(`
      SELECT request_id, session_id, material_ids_json, status FROM interview_llm_request_audit
      WHERE request_id = ?
    `).get(requiredReportRequestId(input.requestId));
    if (!auditBefore || auditBefore.status !== 'running') {
      reportValidationError('LLM_REQUEST_NOT_RUNNING', '$.requestId', '外部 AI 请求不在可保存状态。');
    }
    const sessionId = interviewReportSessionId(input);
    if (Number(auditBefore.session_id) !== sessionId) {
      reportValidationError('PREVIEW_SESSION_MISMATCH', '$.sessionId', '外部 AI 请求不属于当前面试 session。');
    }
    let materialIds = null;
    try { materialIds = JSON.parse(auditBefore.material_ids_json); } catch {}
    if (!Array.isArray(materialIds) || !materialIds.length) {
      reportValidationError('MATERIAL_IDS_INVALID', '$.materialIds', '外部 AI 请求缺少已批准的来源材料。');
    }
    const report = saveInterviewReportV1({
      sessionId,
      report: input.report,
      actor: input.actor,
      expectedVersion: input.expectedVersion,
      requestId: input.saveRequestId,
      sourceMaterialIds: materialIds,
    });
    const audit = finishF009LlmRequest({
      requestId: input.requestId,
      status: 'draft_saved',
      responseHash: input.responseHash,
      returnedModel: input.returnedModel,
      durationMs: input.durationMs,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      reportId: report.id,
    });
    return { report, audit };
  })();
}

function reportFactHash(fact) {
  return reportHash({
    field_key: fact.field_key,
    label: fact.label,
    status: fact.status,
    value: Object.hasOwn(fact, 'value') ? fact.value : null,
    reason_code: Object.hasOwn(fact, 'reason_code') ? fact.reason_code : null,
    evidence_refs: fact.evidence_refs,
  });
}

function resetInterviewReportFacts(database, reportId, facts, timestamp) {
  database.prepare('DELETE FROM interview_report_fact_review WHERE report_id = ?').run(reportId);
  const insert = database.prepare(`
    INSERT INTO interview_report_fact_review (
      report_id, field_key, fact_hash, status, corrected_value,
      reviewed_by, reviewed_at, version, created_at, updated_at
    ) VALUES (?, ?, ?, 'pending_review', NULL, NULL, NULL, 1, ?, ?)
  `);
  facts.forEach((fact) => insert.run(reportId, fact.field_key, reportFactHash(fact), timestamp, timestamp));
}

function saveInterviewReportV1(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewReportSessionId(input);
  const actor = requiredReportActor(input.actor);
  const requestId = requiredReportRequestId(input.request_id === undefined ? input.requestId : input.request_id);
  const expectedVersion = expectedReportVersion(input.expected_version === undefined ? input.expectedVersion : input.expected_version);
  const rawReport = input.report_json === undefined
    ? (input.reportJson === undefined ? input.report : input.reportJson)
    : input.report_json;
  const requestedSourceMaterialIds = input.source_material_ids === undefined
    ? input.sourceMaterialIds
    : input.source_material_ids;
  return database.transaction(() => {
    assertInterviewSessionProcessingAllowed(database, sessionId);
    assertInterviewReportNotDeleted(database, sessionId);
    assertReportSession(database, sessionId);
    const report = validateInterviewReport(rawReport, interviewReportValidationContext(database, sessionId));
    const sourceMaterialIds = normalizedReportSourceMaterialIds(
      database,
      sessionId,
      report,
      requestedSourceMaterialIds,
    );
    const payloadHash = reportHash({
      action: 'save',
      session_id: sessionId,
      expected_version: expectedVersion,
      report,
      source_material_ids: sourceMaterialIds,
    });
    const replay = reportRequestReplay(database, { requestId, action: 'save', payloadHash, sessionId });
    if (replay) return replay;
    const current = interviewReportRow(database, sessionId);
    const currentVersion = current ? Number(current.version) : 0;
    if (currentVersion !== expectedVersion) {
      reportValidationError('STALE_VERSION', '$.expected_version', '报告版本已变化，请重新读取后再提交。');
    }
    if (current && current.status !== 'draft') {
      reportValidationError('REPORT_READ_ONLY', '$.status', '已确认或已驳回报告为只读。');
    }
    const timestamp = nowIso();
    const reportJson = JSON.stringify(report);
    const contentHash = reportHash(report);
    let reportId;
    let version;
    if (!current) {
      const info = database.prepare(`
        INSERT INTO interview_report_v1 (
          session_id, schema_version, status, report_json, content_hash,
          version, created_by, updated_by, confirmed_by, confirmed_at,
          rejected_by, rejected_at, created_at, updated_at
        ) VALUES (
          ?, ?, 'draft', ?, ?, 1, ?, ?, NULL, NULL, NULL, NULL, ?, ?
        )
      `).run(sessionId, INTERVIEW_REPORT_SCHEMA_VERSION, reportJson, contentHash, actor, actor, timestamp, timestamp);
      reportId = Number(info.lastInsertRowid);
      version = 1;
    } else {
      reportId = Number(current.id);
      version = currentVersion + 1;
      database.prepare(`
        UPDATE interview_report_v1
        SET report_json = ?, content_hash = ?, version = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'draft'
      `).run(reportJson, contentHash, version, actor, timestamp, reportId, currentVersion);
    }
    resetInterviewReportFacts(database, reportId, report.key_facts, timestamp);
    saveInterviewReportSourceSnapshot(database, reportId, sessionId, sourceMaterialIds, timestamp);
    insertReportRequest(database, {
      request_id: requestId,
      report_id: reportId,
      session_id: sessionId,
      action: 'save',
      payload_hash: payloadHash,
      response_version: version,
      response_status: 'draft',
      actor,
      created_at: timestamp,
    });
    const persisted = interviewReportRow(database, sessionId);
    registerInterviewReportLifecycleMaterial(database, persisted);
    return publicInterviewReport(persisted);
  })();
}

function manualReportText(value, maximum = 1200) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function manualReportItems(value, maximum = 20) {
  if (Array.isArray(value)) return value.slice(0, maximum);
  return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, maximum);
}

function manualReportId(prefix, index) {
  return `${prefix}.${String(index + 1).padStart(2, '0')}`;
}

function manualReportEvidence(database, materialIds) {
  for (const materialId of materialIds) {
    const material = interviewReportMaterial(database, materialId);
    if (!material || !manualReportText(material.text, 50000)) continue;
    const cue = Array.isArray(material.cues) ? material.cues.find((item) => (
      item && Number.isInteger(item.start_ms) && Number.isInteger(item.end_ms) && item.end_ms > item.start_ms
    )) : null;
    if (cue) {
      return [{
        material_id: Number(materialId),
        span: { type: 'time_span', start_ms: cue.start_ms, end_ms: cue.end_ms },
        cue_id: cue.cue_id,
        quote: redactTranscriptForExternalAi(cue.text),
      }];
    }
    return [{
      material_id: Number(materialId),
      span: { type: 'text_span', start: 0, end: material.text.length },
    }];
  }
  reportValidationError('EVIDENCE_MATERIAL_UNAVAILABLE', '$.materialIds', '所选面试材料没有可引用正文。');
}

function structuredManualClaim(item, input = {}) {
  const textValue = manualReportText(
    item && typeof item === 'object' ? (item.text || item.value || item.label) : item,
    input.maximum || 1200,
  );
  const status = item && typeof item === 'object' ? String(item.status || input.supportedStatus || 'supported') : (input.supportedStatus || 'supported');
  const unknown = status === 'unknown' || !textValue;
  return {
    id: input.id,
    ...(input.label ? { label: manualReportText(
      item && typeof item === 'object' ? (item.label || input.label) : input.label,
      160,
    ) } : {}),
    status: unknown ? 'unknown' : status,
    [input.textKey || 'text']: textValue || input.unknownText,
    ...(unknown ? { reason_code: 'not_mentioned', evidence_refs: [] } : { evidence_refs: input.evidence }),
  };
}

function saveStructuredManualInterviewReport(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewReportSessionId(input);
  const sourceMaterialIds = normalizedReportSourceMaterialIds(
    database,
    sessionId,
    {},
    input.material_ids === undefined ? input.materialIds : input.material_ids,
  );
  const evidence = manualReportEvidence(database, sourceMaterialIds);
  const summaryText = manualReportText(input.summary, 1200);
  const hardRequirements = manualReportItems(input.hardRequirements || input.hard_requirements, 40).map((item, index) => {
    const rawStatus = item && typeof item === 'object' ? String(item.status || 'unknown') : 'unknown';
    const status = ['met', 'not_met', 'unknown'].includes(rawStatus) ? rawStatus : 'unknown';
    const label = manualReportText(item && typeof item === 'object' ? (item.label || item.text) : item, 200) || `硬性条件 ${index + 1}`;
    const itemText = manualReportText(item && typeof item === 'object' ? (item.text || item.value || item.label) : item, 1200);
    return {
      id: manualReportId('hard_requirement', index),
      label,
      status,
      text: itemText || '待 HR 核对',
      ...(status === 'unknown' ? { reason_code: 'unclear', evidence_refs: [] } : { evidence_refs: evidence }),
    };
  });
  const competencies = manualReportItems(input.competencies || input.competency_evidence, 30).map((item, index) => structuredManualClaim(item, {
    id: manualReportId('competency', index),
    label: `胜任力证据 ${index + 1}`,
    evidence,
    unknownText: '材料未形成可确认的胜任力证据。',
  }));
  const risks = manualReportItems(input.risks, 20).map((item, index) => structuredManualClaim(item, {
    id: manualReportId('risk', index),
    evidence,
    unknownText: '待核实风险。',
  })).filter((item) => item.status === 'supported');
  const contradictions = manualReportItems(input.contradictions, 30).map((item, index) => structuredManualClaim(item, {
    id: manualReportId('contradiction', index),
    label: `矛盾 / 风险 ${index + 1}`,
    evidence,
    unknownText: '材料未形成可确认的矛盾。',
  }));
  const unknowns = manualReportItems(input.unknowns, 20).map((item, index) => ({
    id: manualReportId('unknown', index),
    status: 'unknown',
    text: manualReportText(item && typeof item === 'object' ? (item.text || item.label) : item, 1200),
    reason_code: 'unclear',
    evidence_refs: [],
  })).filter((item) => item.text);
  const questions = manualReportItems(input.followupQuestions || input.followup_questions, 20).map((item, index) => ({
    id: manualReportId('followup', index),
    status: 'unknown',
    question: manualReportText(item && typeof item === 'object' ? (item.question || item.text) : item, 800),
    reason_code: 'unclear',
    evidence_refs: [],
  })).filter((item) => item.question);
  const facts = manualReportItems(input.keyFacts || input.key_facts, 30).map((item, index) => {
    const label = manualReportText(item && typeof item === 'object' ? item.label : '', 120) || `关键事实 ${index + 1}`;
    const value = manualReportText(item && typeof item === 'object' ? (item.value || item.text) : item, 600);
    return value ? {
      field_key: manualReportId('fact', index),
      label,
      status: 'supported',
      value,
      evidence_refs: evidence,
    } : null;
  }).filter(Boolean);
  const motivationText = manualReportText(
    input.motivation && typeof input.motivation === 'object' ? input.motivation.text : input.motivation,
    1200,
  );
  const report = {
    schema_version: INTERVIEW_REPORT_SCHEMA_VERSION,
    summary: summaryText ? {
      id: 'summary.main',
      status: 'supported',
      text: summaryText,
      evidence_refs: evidence,
    } : {
      id: 'summary.main',
      status: 'unknown',
      text: '当前材料不足以形成摘要。',
      reason_code: 'unclear',
      evidence_refs: [],
    },
    match_points: competencies.filter((item) => item.status === 'supported').map((item, index) => ({
      id: manualReportId('match', index),
      status: 'supported',
      text: item.text,
      evidence_refs: evidence,
    })),
    risks,
    unknowns,
    followup_questions: questions,
    key_facts: facts,
    hard_requirements: hardRequirements,
    competency_evidence: competencies,
    motivation: motivationText ? {
      id: 'motivation.main',
      label: '求职动机',
      status: 'supported',
      text: motivationText,
      evidence_refs: evidence,
    } : {
      id: 'motivation.main',
      label: '求职动机',
      status: 'unknown',
      text: '材料未提及求职动机。',
      reason_code: 'not_mentioned',
      evidence_refs: [],
    },
    contradictions,
    assessment_cross_checks: [],
    ai_reference: {
      id: 'ai_reference.main',
      label: 'AI 参考分析',
      status: 'unknown',
      text: '本草稿由 HR 结构化填写，未调用外部 AI。',
      reason_code: 'not_applicable',
      evidence_refs: [],
    },
    human_confirm_required: true,
    disclaimer: '本报告仅基于已关联面试材料生成，须经 HR 人工确认，不代表自动录用、淘汰、排序或处置。',
  };
  return saveInterviewReportV1({
    sessionId,
    report,
    actor: input.actor,
    expectedVersion: input.expectedVersion,
    requestId: input.requestId,
    sourceMaterialIds,
  });
}

function listInterviewReportFactReviews(input) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewReportSessionId(input);
  assertInterviewReportNotDeleted(database, sessionId);
  const report = interviewReportRow(database, sessionId);
  if (!report) return [];
  const rows = database.prepare(`
    SELECT id, report_id, field_key, status, corrected_value, reviewed_by,
           reviewed_at, version, created_at, updated_at
    FROM interview_report_fact_review
    WHERE report_id = ?
    ORDER BY id
  `).all(report.id);
  let parsed = null;
  try { parsed = JSON.parse(report.report_json); } catch {}
  const facts = new Map(((parsed && parsed.key_facts) || []).map((fact) => [fact.field_key, fact]));
  return rows.map((row) => {
    const fact = facts.get(row.field_key) || {};
    return {
      ...row,
      field_label: fact.label || row.field_key,
      extracted_value: Object.hasOwn(fact, 'value') ? fact.value : null,
      source: 'interview_report_v1',
    };
  });
}

const REPORT_FACT_REVIEW_STATUSES = new Set(['confirmed', 'corrected', 'unknown', 'rejected']);

function reviewInterviewReportFacts(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewReportSessionId(input);
  const actor = requiredReportActor(input.actor);
  const requestId = requiredReportRequestId(input.request_id === undefined ? input.requestId : input.request_id);
  const expectedVersion = expectedReportVersion(input.expected_version === undefined ? input.expectedVersion : input.expected_version);
  if (!Array.isArray(input.items) || !input.items.length) {
    reportValidationError('FACT_REVIEW_REQUIRED', '$.items', '至少需要一条关键事实复核。');
  }
  const normalized = input.items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) reportValidationError('TYPE_MISMATCH', `$.items[${index}]`, '关键事实复核格式无效。');
    const allowed = new Set(['field_key', 'status', 'corrected_value']);
    Object.keys(item).forEach((key) => {
      if (!allowed.has(key)) reportValidationError('ADDITIONAL_PROPERTY', `$.items[${index}].${key}`, '关键事实复核字段无效。');
    });
    const fieldKey = text(item.field_key);
    if (!fieldKey) reportValidationError('REQUIRED_FIELD', `$.items[${index}].field_key`, '关键事实标识不能为空。');
    const status = text(item.status);
    if (!REPORT_FACT_REVIEW_STATUSES.has(status)) reportValidationError('ENUM_INVALID', `$.items[${index}].status`, '关键事实复核状态无效。');
    const correctedValue = item.corrected_value === undefined ? null : text(item.corrected_value);
    if (status === 'corrected' && !correctedValue) reportValidationError('CORRECTED_VALUE_REQUIRED', `$.items[${index}].corrected_value`, '修正状态必须提供修正值。');
    if (status !== 'corrected' && item.corrected_value !== undefined) reportValidationError('ADDITIONAL_PROPERTY', `$.items[${index}].corrected_value`, '非修正状态不得提供修正值。');
    return { field_key: fieldKey, status, corrected_value: correctedValue };
  });
  const unique = new Set(normalized.map((item) => item.field_key));
  if (unique.size !== normalized.length) reportValidationError('DUPLICATE_ID', '$.items', '关键事实标识不能重复。');
  return database.transaction(() => {
    assertInterviewSessionProcessingAllowed(database, sessionId);
    assertInterviewReportNotDeleted(database, sessionId);
    assertReportSession(database, sessionId);
    const current = interviewReportRow(database, sessionId);
    if (!current) reportValidationError('REPORT_NOT_FOUND', '$.session_id', '面试报告不存在。');
    const parsed = validateInterviewReport(current.report_json, interviewReportValidationContext(database, sessionId));
    if (reportHash(parsed) !== current.content_hash) {
      reportValidationError('REPORT_CONTENT_HASH_MISMATCH', '$', '报告内容完整性校验失败。');
    }
    const payloadHash = reportHash({ action: 'fact_review', session_id: sessionId, expected_version: expectedVersion, items: normalized });
    const replay = reportRequestReplay(database, { requestId, action: 'fact_review', payloadHash, sessionId });
    if (replay) return { report: replay, facts: listInterviewReportFactReviews({ sessionId }) };
    if (Number(current.version) !== expectedVersion) reportValidationError('STALE_VERSION', '$.expected_version', '报告版本已变化，请重新读取后再提交。');
    if (current.status !== 'draft') reportValidationError('REPORT_READ_ONLY', '$.status', '已确认或已驳回报告为只读。');
    const knownFacts = new Map(parsed.key_facts.map((fact) => [fact.field_key, reportFactHash(fact)]));
    const timestamp = nowIso();
    normalized.forEach((item, index) => {
      const factHash = knownFacts.get(item.field_key);
      if (!factHash) reportValidationError('FACT_NOT_FOUND', `$.items[${index}].field_key`, '关键事实不存在。');
      const row = database.prepare('SELECT id, fact_hash, version FROM interview_report_fact_review WHERE report_id = ? AND field_key = ?').get(current.id, item.field_key);
      if (!row || row.fact_hash !== factHash) reportValidationError('FACT_STALE', `$.items[${index}].field_key`, '关键事实版本已变化。');
      database.prepare(`
        UPDATE interview_report_fact_review
        SET status = ?, corrected_value = ?, reviewed_by = ?, reviewed_at = ?,
            version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(item.status, item.corrected_value, actor, timestamp, timestamp, row.id);
    });
    const version = Number(current.version) + 1;
    database.prepare('UPDATE interview_report_v1 SET version = ?, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?')
      .run(version, actor, timestamp, current.id, current.version);
    insertReportRequest(database, {
      request_id: requestId,
      report_id: current.id,
      session_id: sessionId,
      action: 'fact_review',
      payload_hash: payloadHash,
      response_version: version,
      response_status: 'draft',
      actor,
      created_at: timestamp,
    });
    return {
      report: publicInterviewReport(interviewReportRow(database, sessionId)),
      facts: database.prepare(`
        SELECT id, report_id, field_key, status, corrected_value, reviewed_by,
               reviewed_at, version, created_at, updated_at
        FROM interview_report_fact_review WHERE report_id = ? ORDER BY id
      `).all(current.id),
    };
  })();
}

function assertInterviewReportFactsReady(database, reportId, report, sessionId) {
  const rows = database.prepare(`
    SELECT field_key, fact_hash, status FROM interview_report_fact_review
    WHERE report_id = ? ORDER BY id
  `).all(reportId);
  const byKey = new Map(rows.map((row) => [row.field_key, row]));
  for (const fact of report.key_facts) {
    const row = byKey.get(fact.field_key);
    if (!row) reportValidationError('FACT_REVIEW_MISSING', '$.key_facts', '关键事实复核记录缺失。');
    if (row.fact_hash !== reportFactHash(fact)) reportValidationError('FACT_STALE', '$.key_facts', '关键事实版本已变化。');
    if (row.status === 'pending_review' || row.status === 'pending') {
      reportValidationError('PENDING_FACTS', '$.key_facts', '仍有关键事实待人工复核。');
    }
    byKey.delete(fact.field_key);
  }
  if (byKey.size) reportValidationError('FACT_STALE', '$.key_facts', '关键事实复核记录与报告不一致。');
  const legacyPending = database.prepare(`
    SELECT confirmation.field_key
    FROM interview_session_material material
    JOIN interview_recording_confirmation confirmation
      ON confirmation.recording_id = material.interview_recording_id
    WHERE material.session_id = ? AND confirmation.status IN ('pending_review', 'pending')
  `).all(sessionId);
  if (legacyPending.length) reportValidationError('PENDING_FACTS', '$.key_facts', '仍有关键事实待人工复核。');
}

function transitionInterviewReport(input, action) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewReportSessionId(input);
  const actor = requiredReportActor(input.actor);
  const requestId = requiredReportRequestId(input.request_id === undefined ? input.requestId : input.request_id);
  const expectedVersion = expectedReportVersion(input.expected_version === undefined ? input.expectedVersion : input.expected_version);
  if (action === 'confirm' && input.confirmed !== true) reportValidationError('EXPLICIT_CONFIRM_REQUIRED', '$.confirmed', '确认报告必须显式传入 confirmed=true。');
  if (action === 'reject' && input.rejected !== true) reportValidationError('EXPLICIT_REJECT_REQUIRED', '$.rejected', '驳回报告必须显式传入 rejected=true。');
  return database.transaction(() => {
    assertInterviewSessionProcessingAllowed(database, sessionId);
    assertInterviewReportNotDeleted(database, sessionId);
    const session = assertReportSession(database, sessionId);
    const current = interviewReportRow(database, sessionId);
    if (!current) reportValidationError('REPORT_NOT_FOUND', '$.session_id', '面试报告不存在。');
    const parsed = validateInterviewReport(current.report_json, interviewReportValidationContext(database, sessionId));
    if (reportHash(parsed) !== current.content_hash) {
      reportValidationError('REPORT_CONTENT_HASH_MISMATCH', '$', '报告内容完整性校验失败。');
    }
    const payloadHash = reportHash({ action, session_id: sessionId, expected_version: expectedVersion });
    const replay = reportRequestReplay(database, { requestId, action, payloadHash, sessionId });
    if (replay) return replay;
    if (Number(current.version) !== expectedVersion) reportValidationError('STALE_VERSION', '$.expected_version', '报告版本已变化，请重新读取后再提交。');
    if (current.status !== 'draft') reportValidationError('REPORT_READ_ONLY', '$.status', '已确认或已驳回报告为只读。');
    if (action === 'confirm') {
      assertInterviewReportSourcesCurrent(database, current);
      assertInterviewReportFactsReady(database, current.id, parsed, sessionId);
    }
    const timestamp = nowIso();
    const version = Number(current.version) + 1;
    if (action === 'confirm') {
      const builtProjection = buildConfirmedInterviewProjection({
        reportRow: current,
        report: parsed,
        factReviews: reportFactReviewRows(database, current.id),
        sourceReportVersion: Number(current.version),
        confirmedBy: actor,
        confirmedAt: timestamp,
      });
      database.prepare(`
        INSERT INTO interview_report_confirmed_projection (
          report_id, session_id, source_report_version, projection_json,
          content_hash, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        current.id,
        sessionId,
        current.version,
        builtProjection.projectionJson,
        builtProjection.contentHash,
        actor,
        timestamp,
      );
      database.prepare(`
        UPDATE interview_report_v1
        SET status = 'confirmed', version = ?, updated_by = ?, confirmed_by = ?,
            confirmed_at = ?, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'draft'
      `).run(version, actor, actor, timestamp, timestamp, current.id, current.version);
      database.prepare(`
        UPDATE interview_recording
        SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, ?), updated_at = ?
        WHERE id IN (
          SELECT interview_recording_id FROM interview_session_material
          WHERE session_id = ? AND interview_recording_id IS NOT NULL
        )
      `).run(timestamp, timestamp, sessionId);
      database.prepare(`
        UPDATE interview_session
        SET status = 'confirmed', updated_at = ?
        WHERE id = ?
      `).run(timestamp, sessionId);
    } else {
      database.prepare(`
        UPDATE interview_report_v1
        SET status = 'rejected', version = ?, updated_by = ?, rejected_by = ?,
            rejected_at = ?, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'draft'
      `).run(version, actor, actor, timestamp, timestamp, current.id, current.version);
    }
    const status = action === 'confirm' ? 'confirmed' : 'rejected';
    insertReportRequest(database, {
      request_id: requestId,
      report_id: current.id,
      session_id: sessionId,
      action,
      payload_hash: payloadHash,
      response_version: version,
      response_status: status,
      actor,
      created_at: timestamp,
    });
    const persisted = interviewReportRow(database, sessionId);
    registerInterviewReportLifecycleMaterial(database, persisted);
    const result = publicInterviewReport(persisted);
    result.session = { id: session.id, candidate_id: session.candidate_id, job_id: session.job_id };
    return result;
  })();
}

function confirmInterviewReportV1(input = {}) {
  return transitionInterviewReport(input, 'confirm');
}

function rejectInterviewReportV1(input = {}) {
  return transitionInterviewReport(input, 'reject');
}

function getInterviewReportV1(input) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewReportSessionId(input);
  assertInterviewReportNotDeleted(database, sessionId);
  return publicInterviewReport(interviewReportRow(database, sessionId));
}

function listOfficialInterviewReports(filters = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const where = ["report.status = 'confirmed'"];
  const params = {};
  if (filters.sessionId || filters.session_id) {
    where.push('report.session_id = @session_id');
    params.session_id = interviewReportSessionId(filters);
  }
  const candidateId = text(filters.candidateId) || text(filters.candidate_id);
  if (candidateId) {
    where.push('session.candidate_id = @candidate_id');
    params.candidate_id = candidateId;
  }
  const rawJobId = filters.jobId === undefined ? filters.job_id : filters.jobId;
  if (rawJobId !== undefined && rawJobId !== null && rawJobId !== '') {
    const jobId = Number(rawJobId);
    if (!Number.isInteger(jobId) || jobId <= 0) reportValidationError('JOB_ID_INVALID', '$.job_id', 'jobId 无效。');
    where.push('session.job_id = @job_id');
    params.job_id = jobId;
  }
  return database.prepare(`
    SELECT report.id, report.session_id, report.schema_version, report.status,
           report.report_json, report.content_hash, report.version,
           report.created_by, report.updated_by, report.confirmed_by,
           report.confirmed_at, report.created_at, report.updated_at
    FROM interview_report_v1 report
    JOIN interview_session session ON session.id = report.session_id
    WHERE ${where.join(' AND ')}
    ORDER BY report.confirmed_at DESC, report.id DESC
  `).all(params).map((row) => ({
    ...publicInterviewReport(row),
    fact_reviews: listInterviewReportFactReviews({ sessionId: row.session_id }),
  }));
}

function interviewSessionIdForRecording(database, recordingId) {
  const rows = database.prepare(`
    SELECT session_id FROM interview_session_material
    WHERE interview_recording_id = ? ORDER BY id
  `).all(Number(recordingId));
  if (!rows.length) reportValidationError('SESSION_MATERIAL_REQUIRED', '$.recording_id', '录音尚未关联面试 session。');
  if (rows.length !== 1) reportValidationError('SESSION_MATERIAL_AMBIGUOUS', '$.recording_id', '录音关联的面试 session 不唯一。');
  return Number(rows[0].session_id);
}

function latestLegacyInterviewAiReport(database, recordingId) {
  return database.prepare(`
    SELECT id, recording_id, candidate_id, job_id, status AS legacy_status,
           report_json, confirmed_at AS legacy_confirmed_at, created_at, updated_at
    FROM interview_ai_report
    WHERE recording_id = ?
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `).get(Number(recordingId));
}

function legacyInterviewReport(row) {
  if (!row) return null;
  let report = null;
  try { report = JSON.parse(row.report_json); } catch {}
  return {
    ...row,
    status: 'legacy_unvalidated',
    schema_version: 'legacy_unvalidated',
    report,
    read_only: true,
    legacy: true,
    confirmed_at: null,
  };
}

function saveInterviewReportForRecording(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const recordingId = Number(input.recording_id === undefined ? input.recordingId : input.recording_id);
  if (!Number.isInteger(recordingId) || recordingId <= 0) reportValidationError('RECORDING_REQUIRED', '$.recording_id', 'recordingId 无效。');
  assertRecordingLifecycleReadable(database, recordingId, { processing: true, access: 'transcript' });
  const recording = interviewRecordingById(database, recordingId);
  if (!recording) reportValidationError('RECORDING_NOT_FOUND', '$.recording_id', '面试录音不存在。');
  const sessionId = interviewSessionIdForRecording(database, recordingId);
  return saveInterviewReportV1({ ...input, sessionId });
}

function getInterviewReportForRecording(recordingId) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const id = Number(recordingId);
  if (!Number.isInteger(id) || id <= 0) reportValidationError('RECORDING_REQUIRED', '$.recording_id', 'recordingId 无效。');
  assertRecordingLifecycleReadable(database, id);
  const recording = interviewRecordingById(database, id);
  if (!recording) reportValidationError('RECORDING_NOT_FOUND', '$.recording_id', '面试录音不存在。');
  const relation = database.prepare('SELECT session_id FROM interview_session_material WHERE interview_recording_id = ? ORDER BY id LIMIT 1').get(id);
  if (relation) {
    assertInterviewReportNotDeleted(database, relation.session_id);
    const v1 = publicInterviewReport(interviewReportRow(database, relation.session_id));
    if (v1) return v1;
  }
  assertRecordingLifecycleReadable(database, id, { access: 'legacy_report' });
  return legacyInterviewReport(latestLegacyInterviewAiReport(database, id));
}

function confirmInterviewReportForRecording(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const recordingId = Number(input.recording_id === undefined ? (input.recordingId === undefined ? input.id : input.recordingId) : input.recording_id);
  if (!Number.isInteger(recordingId) || recordingId <= 0) reportValidationError('RECORDING_REQUIRED', '$.recording_id', 'recordingId 无效。');
  const sessionId = interviewSessionIdForRecording(database, recordingId);
  return confirmInterviewReportV1({ ...input, sessionId });
}

function rejectInterviewReportForRecording(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const recordingId = Number(input.recording_id === undefined ? (input.recordingId === undefined ? input.id : input.recordingId) : input.recording_id);
  if (!Number.isInteger(recordingId) || recordingId <= 0) reportValidationError('RECORDING_REQUIRED', '$.recording_id', 'recordingId 无效。');
  const sessionId = interviewSessionIdForRecording(database, recordingId);
  return rejectInterviewReportV1({ ...input, sessionId });
}

function listInterviewReportFactReviewsForRecording(recordingId) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const sessionId = interviewSessionIdForRecording(database, recordingId);
  return listInterviewReportFactReviews({ sessionId });
}

function reviewInterviewReportFactsForRecording(input = {}) {
  const database = conn();
  ensureInterviewSessionSchema(database);
  const recordingId = Number(input.recording_id === undefined ? input.recordingId : input.recording_id);
  if (!Number.isInteger(recordingId) || recordingId <= 0) reportValidationError('RECORDING_REQUIRED', '$.recording_id', 'recordingId 无效。');
  const sessionId = interviewSessionIdForRecording(database, recordingId);
  const items = Array.isArray(input.items) ? input.items.map((item) => ({
    field_key: item.field_key === undefined ? (item.fieldKey === undefined ? item.id : item.fieldKey) : item.field_key,
    status: item.status,
    ...(item.corrected_value === undefined && item.correctedValue === undefined
      ? {}
      : { corrected_value: item.corrected_value === undefined ? item.correctedValue : item.corrected_value }),
  })) : input.items;
  return reviewInterviewReportFacts({ ...input, sessionId, items });
}

// Compatibility names now route through the strict session-level F-008 service.
function saveInterviewAiReport(input) {
  return saveInterviewReportForRecording(input);
}

function getLatestInterviewAiReport(recordingId) {
  return getInterviewReportForRecording(recordingId);
}

const INTERVIEW_CONFIRMATION_STATUSES = new Set(['pending', 'confirmed', 'corrected', 'unknown', 'rejected']);
const INTERVIEW_CONFIRMATION_CONFIRMED_STATUSES = new Set(['confirmed', 'corrected']);

function normalizeInterviewConfirmationStatus(value) {
  const status = (text(value) || 'pending').trim().toLowerCase();
  if (!INTERVIEW_CONFIRMATION_STATUSES.has(status)) {
    throw new Error(`unsupported confirmation status: ${status}`);
  }
  return status;
}

function listInterviewRecordingConfirmations(recordingId) {
  const database = conn();
  ensureInterviewRecordingSchema(database);
  const id = Number(recordingId);
  if (!id) throw new Error('recordingId is required');
  assertRecordingLifecycleReadable(database, id, { access: 'confirmations' });
  return database.prepare(`
    SELECT
      id, recording_id, field_key, field_label, extracted_value,
      corrected_value, status, evidence, note, confirmed_at,
      created_at, updated_at
    FROM interview_recording_confirmation
    WHERE recording_id = ?
    ORDER BY id
  `).all(id);
}

function normalizeInterviewConfirmationItems(input) {
  if (Array.isArray(input)) return { recordingId: null, items: input };
  const recordingId = input ? Number(input.recording_id === undefined ? input.recordingId : input.recording_id) : null;
  if (input && Array.isArray(input.items)) return { recordingId, items: input.items };
  if (input && input.item && typeof input.item === 'object') return { recordingId, items: [input.item] };
  return { recordingId, items: [input || {}] };
}

function saveInterviewRecordingConfirmations(input) {
  const database = conn();
  ensureInterviewRecordingSchema(database);
  const { recordingId: parentRecordingId, items } = normalizeInterviewConfirmationItems(input);
  if (!items.length) return [];
  return database.transaction(() => {
    const saved = [];
    for (const item of items) {
      const recordingId = Number(item.recording_id === undefined ? (item.recordingId === undefined ? parentRecordingId : item.recordingId) : item.recording_id);
      if (!recordingId) throw new Error('recordingId is required');
      const sessionId = assertRecordingLifecycleReadable(database, recordingId, { processing: true, access: 'confirmations' });
      const recording = interviewRecordingById(database, recordingId);
      if (!recording) throw new Error(`interview recording not found: ${recordingId}`);
      const fieldKey = (text(item.field_key) || text(item.fieldKey) || '').trim();
      if (!fieldKey) throw new Error('field_key is required');
      const status = normalizeInterviewConfirmationStatus(item.status);
      const timestamp = nowIso();
      const confirmedAt = INTERVIEW_CONFIRMATION_CONFIRMED_STATUSES.has(status)
        ? (text(item.confirmed_at) || text(item.confirmedAt) || timestamp)
        : null;
      database.prepare(`
        INSERT INTO interview_recording_confirmation (
          recording_id, field_key, field_label, extracted_value,
          corrected_value, status, evidence, note,
          confirmed_at, created_at, updated_at
        ) VALUES (
          @recording_id, @field_key, @field_label, @extracted_value,
          @corrected_value, @status, @evidence, @note,
          @confirmed_at, @created_at, @updated_at
        )
        ON CONFLICT(recording_id, field_key) DO UPDATE SET
          field_label = COALESCE(excluded.field_label, interview_recording_confirmation.field_label),
          extracted_value = COALESCE(excluded.extracted_value, interview_recording_confirmation.extracted_value),
          corrected_value = excluded.corrected_value,
          status = excluded.status,
          evidence = COALESCE(excluded.evidence, interview_recording_confirmation.evidence),
          note = COALESCE(excluded.note, interview_recording_confirmation.note),
          confirmed_at = excluded.confirmed_at,
          updated_at = excluded.updated_at
      `).run({
        recording_id: recordingId,
        field_key: fieldKey,
        field_label: text(item.field_label) || text(item.fieldLabel),
        extracted_value: confirmationValue(item.extracted_value === undefined ? item.extractedValue : item.extracted_value),
        corrected_value: confirmationValue(item.corrected_value === undefined ? item.correctedValue : item.corrected_value),
        status,
        evidence: confirmationValue(item.evidence),
        note: text(item.note),
        confirmed_at: confirmedAt,
        created_at: text(item.created_at) || text(item.createdAt) || timestamp,
        updated_at: timestamp,
      });
      saved.push(database.prepare(`
        SELECT
          id, recording_id, field_key, field_label, extracted_value,
          corrected_value, status, evidence, note, confirmed_at,
          created_at, updated_at
        FROM interview_recording_confirmation
        WHERE recording_id = ? AND field_key = ?
      `).get(recordingId, fieldKey));
      if (sessionId) registerLegacyRecordingDatabaseMaterials(database, sessionId, recordingId, timestamp);
    }
    return saved;
  })();
}

function confirmInterviewRecording(id) {
  const database = conn();
  ensureInterviewRecordingSchema(database);
  const recordingId = Number(id);
  if (!recordingId) throw new Error('id is required');
  const recording = database.transaction(() => {
    assertRecordingLifecycleReadable(database, recordingId, { processing: true, access: 'identity' });
    const current = interviewRecordingById(database, recordingId);
    if (!current) throw new Error(`interview recording not found: ${recordingId}`);
    if (!current.candidate_id || !current.job_id) throw new Error('先绑定候选人和岗位，再确认入档。');
    assertJobRecruitingWritable(database, current.job_id);
    const timestamp = nowIso();
    database.prepare(`
      UPDATE interview_recording
      SET status = 'confirmed',
          confirmed_at = COALESCE(confirmed_at, @confirmed_at),
          updated_at = @updated_at
      WHERE id = @id
    `).run({ id: recordingId, confirmed_at: timestamp, updated_at: timestamp });
    return interviewRecordingById(database, recordingId);
  })();
  writeAuditLog({
    action: '面试录音确认入档',
    target: String(recordingId),
    who: 'HR',
    auto: 0,
    result: '成功',
    detail_json: JSON.stringify({ candidate_id: recording.candidate_id, job_id: recording.job_id }),
  });
  return recording;
}

function getInterviewScript(jobId) {
  const database = conn();
  ensureInterviewRecordingSchema(database);
  const id = Number(jobId);
  if (!id) throw new Error('jobId is required');
  const row = database.prepare(`
    SELECT
      id, job_id, status, source, script_json, script_text,
      confirmed_at, created_at, updated_at
    FROM interview_script
    WHERE job_id = ?
  `).get(id) || null;
  if (!row) return null;
  const script = parseJson(row.script_json) || {};
  const isProfileBound = row.source === 'local_rule_from_jd_profile'
    || script.source_jd_version_id != null
    || script.source_profile_version_id != null;
  if (!isProfileBound) {
    return { ...row, current_for_active_jd: true, stale_for_active_jd: false };
  }
  let context = null;
  try {
    context = currentJobProfileContext(database, id);
  } catch {
    return { ...row, current_for_active_jd: false, stale_for_active_jd: true };
  }
  const current = Number(script.source_jd_version_id) === Number(context.activeJd && context.activeJd.id)
    && Number(script.source_profile_version_id) === Number(context.profileVersion && context.profileVersion.id);
  return { ...row, current_for_active_jd: current, stale_for_active_jd: !current };
}

function saveInterviewScript(input) {
  const database = conn();
  ensureInterviewRecordingSchema(database);
  const jobId = Number(input.job_id === undefined ? input.jobId : input.job_id);
  if (!jobId) throw new Error('jobId is required');
  assertJobRecruitingWritable(database, jobId);
  const scriptJson = text(input.script_json) || text(input.scriptJson);
  if (!scriptJson || !scriptJson.trim()) throw new Error('script_json is required');
  let parsedScript;
  try { parsedScript = JSON.parse(scriptJson); } catch (err) { throw new Error(`script_json is not valid JSON: ${err.message}`); }
  const status = text(input.status) || 'draft';
  const source = text(input.source) || 'manual';
  const isProfileBound = source === 'local_rule_from_jd_profile'
    || parsedScript.source_jd_version_id != null
    || parsedScript.source_profile_version_id != null;
  if (isProfileBound) {
    const context = currentJobProfileContext(database, jobId);
    if (Number(parsedScript.source_jd_version_id) !== Number(context.activeJd && context.activeJd.id)
        || Number(parsedScript.source_profile_version_id) !== Number(context.profileVersion && context.profileVersion.id)) {
      throw jobOperationError(
        'INTERVIEW_SCRIPT_CURRENT_PROFILE_REQUIRED',
        '面试脚本必须绑定当前已启用 JD 和当前已确认画像，请重新生成。',
        409,
      );
    }
  }
  const timestamp = nowIso();
  const confirmedAt = status === 'confirmed' ? (text(input.confirmed_at) || text(input.confirmedAt) || timestamp) : null;
  database.prepare(`
    INSERT INTO interview_script (
      job_id, status, source, script_json, script_text,
      confirmed_at, created_at, updated_at
    ) VALUES (
      @job_id, @status, @source, @script_json, @script_text,
      @confirmed_at, @created_at, @updated_at
    )
    ON CONFLICT(job_id) DO UPDATE SET
      status = excluded.status,
      source = excluded.source,
      script_json = excluded.script_json,
      script_text = excluded.script_text,
      confirmed_at = excluded.confirmed_at,
      updated_at = excluded.updated_at
  `).run({
    job_id: jobId,
    status,
    source,
    script_json: scriptJson,
    script_text: text(input.script_text) || text(input.scriptText),
    confirmed_at: confirmedAt,
    created_at: text(input.created_at) || text(input.createdAt) || timestamp,
    updated_at: timestamp,
  });
  return getInterviewScript(jobId);
}

// 访谈转写总量上限：超了就报错，绝不静默截断——截断会让画像里的「引用原话」引到不存在的内容。
const TRANSCRIPT_CHAR_LIMIT = 200000;

function deepProfileGenerationContextHash(profileContext, interviews) {
  return stableContentHash({
    job: {
      id: Number(profileContext.job && profileContext.job.id),
      name: text(profileContext.job && profileContext.job.name),
    },
    active_jd: profileContext.activeJd ? {
      id: Number(profileContext.activeJd.id),
      content_hash: text(profileContext.activeJd.content_hash),
    } : null,
    profile_version: profileContext.profileVersion ? {
      id: Number(profileContext.profileVersion.id),
      content_hash: text(profileContext.profileVersion.content_hash),
    } : null,
    config: profileContext.config || {},
    interviews: (interviews || []).map((row) => ({
      id: Number(row.id),
      note: text(row.note),
      source_type: text(row.source_type),
      created_at: text(row.created_at),
      transcript: text(row.transcript),
    })),
  });
}

function candidateAssessmentContextHash(candidate, profileContext, resume) {
  return stableContentHash({
    candidate: candidate ? {
      internal_id: text(candidate.internal_id),
      job_id: Number(candidate.job_id),
      name: text(candidate.name),
      job_name: text(candidate.job_name),
    } : null,
    active_jd: profileContext && profileContext.activeJd ? {
      id: Number(profileContext.activeJd.id),
      content_hash: text(profileContext.activeJd.content_hash),
    } : null,
    profile_version: profileContext && profileContext.profileVersion ? {
      id: Number(profileContext.profileVersion.id),
      content_hash: text(profileContext.profileVersion.content_hash),
    } : null,
    config: (profileContext && profileContext.config) || {},
    resume: resume ? {
      sections_json: text(resume.sections_json),
      is_paywalled: Number(resume.is_paywalled) ? 1 : 0,
    } : null,
  });
}

// 由该岗位的全部访谈材料生成/更新深度人才画像。
// options.generator 可注入（测试用假生成器，不调真 API）。
// 重新生成后 status 强制回 'draft'：内容变了，旧的「负责人已确认」作废。
async function generateDeepProfileForJob(jobId, options = {}) {
  const usesExternalAi = options.usesExternalAi === true || !options.generator;
  const generator = options.generator || ratingLlm.generateDeepProfile;
  const readExternalAiStatus = typeof options.externalAiStatus === 'function'
    ? options.externalAiStatus
    : ratingLlm.externalAiStatus;
  const authorization = options.externalAiAuthorization;
  const authorizationMeta = usesExternalAi ? describeExternalAiAuthorization(authorization) : null;
  if (usesExternalAi && (!authorizationMeta || authorizationMeta.purpose !== 'deep-profile')) {
    throw new Error('生成深度画像缺少本次、一次性的外部 AI 授权。');
  }
  const database = conn();
  assertJobRecruitingWritable(database, jobId);
  const profileContext = currentJobProfileContext(database, jobId);
  const jobRow = profileContext.job;
  const interviews = listInterviews(jobId);
  if (!interviews.length) throw new Error('该岗位还没有访谈记录。先添加一条负责人访谈（粘贴转写文本或妙记链接）再生成画像。');
  const totalChars = interviews.reduce((sum, row) => sum + row.transcript.length, 0);
  if (totalChars > TRANSCRIPT_CHAR_LIMIT) {
    throw new Error(`访谈转写总量 ${totalChars} 字超过上限 ${TRANSCRIPT_CHAR_LIMIT} 字。请删掉旧的或无关的访谈记录再生成（不做自动截断，截断会让画像引错原话）。`);
  }

  const config = profileContext.config;
  const previous = config.deep_profile || null;
  const generationContextHash = deepProfileGenerationContextHash(profileContext, interviews);
  const followupAnswers = interviews
    .filter((row) => row.note === '追问补答')
    .map((row) => ({ created_at: row.created_at, text: scrubSensitive(row.transcript) }));
  const transcripts = interviews
    .filter((row) => row.note !== '追问补答')
    .map((row) => ({ note: row.note, created_at: row.created_at, text: scrubSensitive(row.transcript) }));

  // 网络请求放在事务外；生成失败不写画像，但保留不含原文的外部调用审计。
  let doc;
  try {
    doc = await generator({
      jobName: jobRow.name,
      rubric: (config && config.rubric) || '',
      transcripts,
      previousProfile: previous ? previous.doc : null,
      followupAnswers,
    }, authorization);
  } catch (error) {
    const aiStatus = usesExternalAi ? readExternalAiStatus() : {};
    writeAuditLog({
      action: '外部AI生成深度画像',
      target: String(jobId),
      who: 'HR',
      auto: 0,
      result: '失败',
      detail_json: JSON.stringify({
        provider: aiStatus.provider || null,
        model: aiStatus.model || null,
        host: aiStatus.host || null,
        authorization_id: authorizationMeta && authorizationMeta.id,
        authorization_purpose: authorizationMeta && authorizationMeta.purpose,
        error_type: error && error.name ? error.name : 'Error',
      }),
    });
    throw error;
  }

  const aiStatus = usesExternalAi ? readExternalAiStatus() : {};
  return database.transaction(() => {
    // The external call can take minutes. Recheck every input and the closed-job
    // gate inside the final write transaction so a late result cannot mutate a
    // closed job or land in a newer JD/profile context.
    assertJobRecruitingWritable(database, jobId);
    const currentProfileContext = currentJobProfileContext(database, jobId);
    const currentInterviews = listInterviews(jobId);
    if (deepProfileGenerationContextHash(currentProfileContext, currentInterviews) !== generationContextHash) {
      throw jobOperationError(
        'JOB_PROFILE_CONTEXT_CHANGED',
        '岗位 JD、画像或访谈材料已在生成期间变化，本次旧结果未保存。请基于最新材料重新生成。',
        409,
      );
    }
    const currentConfig = currentProfileContext.config;
    const currentPrevious = currentConfig.deep_profile || null;
    const deep = {
      status: 'draft',
      version: currentPrevious ? (Number(currentPrevious.version) || 0) + 1 : 1,
      generated_at: nowIso(),
      confirmed_at: null,
      confirmed_by: null,
      bound_profile_version_id: currentProfileContext.profileVersion && Number(currentProfileContext.profileVersion.id),
      bound_jd_version_id: currentProfileContext.activeJd && Number(currentProfileContext.activeJd.id),
      stale_for_active_jd: false,
      source_interview_ids: currentInterviews.map((row) => row.id),
      doc,
    };
    currentConfig.deep_profile = deep;
    writeStoredJobProfileConfig(database, jobId, currentConfig);
    writeAuditLog({
      action: '生成深度画像',
      target: String(jobId),
      who: 'HR',
      auto: 0,
      result: '成功',
      detail_json: JSON.stringify({
        version: deep.version,
        interviews: transcripts.length,
        followup_answers: followupAnswers.length,
        total_chars: totalChars,
        provider: aiStatus.provider || null,
        model: aiStatus.model || null,
        host: aiStatus.host || null,
        authorization_id: authorizationMeta && authorizationMeta.id,
        authorization_purpose: authorizationMeta && authorizationMeta.purpose,
      }),
    });
    return deep;
  })();
}

// 标记「负责人已确认」：第一版由 HR 代录（把画像 Markdown 发给负责人，得到答复后点确认）。
function confirmDeepProfile(jobId, who = 'HR代录') {
  const database = conn();
  assertJobRecruitingWritable(database, jobId);
  const profileContext = currentJobProfileContext(database, jobId);
  const config = profileContext.config;
  if (!config.deep_profile) throw new Error('该岗位还没有深度画像，先生成再确认。');
  config.deep_profile.status = 'confirmed';
  config.deep_profile.confirmed_at = nowIso();
  config.deep_profile.confirmed_by = who;
  writeStoredJobProfileConfig(database, jobId, config);
  writeAuditLog({
    action: '画像确认',
    target: String(jobId),
    who,
    auto: 0,
    result: '成功',
    detail_json: JSON.stringify({ version: config.deep_profile.version }),
  });
  return config.deep_profile;
}

// 单人 AI 评估（候选人匹配报告 V1）：只写 ai_review 表 + 审计日志。
// 红线：本函数绝不 UPDATE candidate——sabc / quality_score / verdict_label / expert_comment 一列都不碰。
// options.assessor 可注入（测试用假评估器，不调真 API）。
async function runSecondOpinion(candidateId, options = {}) {
  const usesExternalAi = options.usesExternalAi === true || !options.assessor;
  const assessor = options.assessor || ratingLlm.assessCandidateV1;
  const readExternalAiStatus = typeof options.externalAiStatus === 'function'
    ? options.externalAiStatus
    : ratingLlm.externalAiStatus;
  const authorization = options.externalAiAuthorization;
  const authorizationMeta = usesExternalAi ? describeExternalAiAuthorization(authorization) : null;
  if (usesExternalAi && (!authorizationMeta || authorizationMeta.purpose !== 'candidate-assessment')) {
    throw new Error('候选人第二意见缺少本次、一次性的外部 AI 授权。');
  }
  const database = conn();
  const cand = database.prepare(`
    SELECT c.internal_id, c.job_id, c.name, j.name AS job_name
    FROM candidate c
    LEFT JOIN job j ON j.id = c.job_id
    WHERE c.internal_id = ?
  `).get(candidateId);
  if (!cand) throw new Error(`candidate not found: ${candidateId}`);
  assertJobRecruitingWritable(database, cand.job_id);
  const profileContext = currentJobProfileContext(database, cand.job_id);
  const resume = database.prepare('SELECT sections_json, is_paywalled FROM resume_online WHERE candidate_id = ?').get(candidateId);
  if (!resume) throw new Error('该候选人还没有在线简历，先拉取简历再评估。');
  if (resume.is_paywalled) throw new Error('该候选人简历未公开（付费墙），没有内容可评估。');
  let sections;
  try { sections = JSON.parse(resume.sections_json); } catch { sections = null; }

  const config = profileContext.config;
  const deep = config.deep_profile || null;
  const assessmentContextHash = candidateAssessmentContextHash(cand, profileContext, resume);
  const evidenceProfile = redactKnownCandidateName(buildEvidenceProfile(sections), cand.name);
  const dimensions = buildReportDimensions(config);

  // 网络请求在事务外。姓名不外发；失败不落评估结果，但保留不含简历正文的调用审计。
  let raw;
  try {
    raw = await assessor({
      jobName: cand.job_name,
      candidateName: '候选人（本地已隐去姓名）',
      deepProfile: deep ? deep.doc : null,
      rubric: (config && config.rubric) || '',
      evidenceProfile,
      dimensions,
    }, authorization);
  } catch (error) {
    const aiStatus = usesExternalAi ? readExternalAiStatus() : {};
    writeAuditLog({
      action: '外部AI单人评估',
      target: candidateId,
      who: 'HR',
      auto: 0,
      result: '失败',
      detail_json: JSON.stringify({
        provider: aiStatus.provider || null,
        model: aiStatus.model || null,
        host: aiStatus.host || null,
        authorization_id: authorizationMeta && authorizationMeta.id,
        authorization_purpose: authorizationMeta && authorizationMeta.purpose,
        error_type: error && error.name ? error.name : 'Error',
      }),
    });
    throw error;
  }
  if (raw && raw.candidate_summary && typeof raw.candidate_summary === 'object') {
    raw.candidate_summary.name = cand.name;
  }

  const aiStatus = usesExternalAi ? readExternalAiStatus() : {};
  return database.transaction(() => {
    assertJobRecruitingWritable(database, cand.job_id);
    const currentCandidate = database.prepare(`
      SELECT c.internal_id, c.job_id, c.name, j.name AS job_name
      FROM candidate c
      LEFT JOIN job j ON j.id = c.job_id
      WHERE c.internal_id = ?
    `).get(candidateId);
    const currentProfileContext = currentCandidate
      ? currentJobProfileContext(database, currentCandidate.job_id)
      : null;
    const currentResume = database.prepare('SELECT sections_json, is_paywalled FROM resume_online WHERE candidate_id = ?').get(candidateId);
    if (!currentCandidate
        || Number(currentCandidate.job_id) !== Number(cand.job_id)
        || candidateAssessmentContextHash(currentCandidate, currentProfileContext, currentResume) !== assessmentContextHash) {
      throw jobOperationError(
        'CANDIDATE_ASSESSMENT_CONTEXT_CHANGED',
        '候选人、简历、JD 或画像已在评估期间变化，本次旧结果未保存。请基于最新材料重新评估。',
        409,
      );
    }
    const currentDeep = currentProfileContext.config.deep_profile || null;
    const report = {
      ...raw,
      deep_profile_missing: !currentDeep,
      deep_profile_version: currentDeep ? currentDeep.version : null,
    };
    const profileConfirmed = currentDeep && currentDeep.status === 'confirmed' ? 1 : 0;
    const row = insertAiReview({
      candidate_id: candidateId,
      job_id: currentCandidate.job_id,
      profile_confirmed: profileConfirmed,
      report_json: JSON.stringify(report),
    });
    writeAuditLog({
      action: '单人AI评估',
      target: candidateId,
      who: 'HR',
      auto: 0,
      result: '成功',
      detail_json: JSON.stringify({
        review_id: row.id,
        job_id: currentCandidate.job_id,
        profile_confirmed: profileConfirmed,
        deep_profile_missing: !currentDeep,
        provider: aiStatus.provider || null,
        model: aiStatus.model || null,
        host: aiStatus.host || null,
        authorization_id: authorizationMeta && authorizationMeta.id,
        authorization_purpose: authorizationMeta && authorizationMeta.purpose,
      }),
    });
    return { review_id: row.id, profile_confirmed: profileConfirmed, report };
  })();
}

function runSecondOpinionLocalDemo(candidateId) {
  const database = conn();
  const cand = database.prepare(`
    SELECT c.internal_id, c.job_id, c.name, j.name AS job_name
    FROM candidate c
    LEFT JOIN job j ON j.id = c.job_id
    WHERE c.internal_id = ?
  `).get(candidateId);
  if (!cand) throw new Error(`candidate not found: ${candidateId}`);
  assertJobRecruitingWritable(database, cand.job_id);
  const profileContext = currentJobProfileContext(database, cand.job_id);
  const resume = database.prepare('SELECT sections_json, is_paywalled FROM resume_online WHERE candidate_id = ?').get(candidateId);
  if (!resume) throw new Error('该候选人还没有在线简历，先拉取简历再生成本地样本。');
  if (resume.is_paywalled) throw new Error('该候选人简历未公开（付费墙），不能生成本地样本。');
  let sections;
  try { sections = JSON.parse(resume.sections_json); } catch { sections = null; }

  const config = profileContext.config;
  const deep = config.deep_profile || null;
  const evidenceProfile = buildEvidenceProfile(sections);
  const dimensions = buildReportDimensions(config);
  const report = {
    ...buildLocalDemoReport({
      jobName: cand.job_name,
      candidateName: cand.name,
      deepProfile: deep ? deep.doc : null,
      rubric: (config && config.rubric) || '',
      evidenceProfile,
      dimensions,
    }),
    deep_profile_missing: !deep,
    deep_profile_version: deep ? deep.version : null,
  };
  const profileConfirmed = deep && deep.status === 'confirmed' ? 1 : 0;
  const row = insertAiReview({
    candidate_id: candidateId,
    job_id: cand.job_id,
    profile_confirmed: profileConfirmed,
    report_json: JSON.stringify(report),
  });
  writeAuditLog({
    action: '单人AI评估本地样本',
    target: candidateId,
    who: 'HR',
    auto: 0,
    result: '成功',
    detail_json: JSON.stringify({
      review_id: row.id,
      job_id: cand.job_id,
      profile_confirmed: profileConfirmed,
      generator: 'local_demo_v1',
      is_local_demo: true,
      deep_profile_missing: !deep,
    }),
  });
  return { review_id: row.id, profile_confirmed: profileConfirmed, report };
}

// 小并发池：保留批量任务进度语义；当前 rateJob 只跑本地规则，不做网络请求。
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// 批量重评一个岗位：
//   1. 只走确定性规则定档（rule-rating.js），绝不调用大模型决定 SABC。
//   2. 没有规则口径 / 缺关键信息时标「待确认」，不强行落 SABC。
//   3. 历史 quality_score 保持原值且不读取、不排序、不展示；V1 AI 报告另写 ai_review.report_json。
// 不覆盖 HR 手动改过的评级（sabc_source='人工'）；缺在线简历/付费墙会跳过。
async function rateJob(jobId, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const database = conn();
  assertJobRecruitingWritable(database, jobId);
  const config = currentJobProfileContext(database, jobId).config;
  const resumeSkipStats = database.prepare(`
    SELECT
      SUM(CASE WHEN r.id IS NULL THEN 1 ELSE 0 END) AS skipped_missing_resume,
      SUM(CASE WHEN r.id IS NOT NULL AND r.is_paywalled = 1 THEN 1 ELSE 0 END) AS skipped_paywalled
    FROM candidate c
    LEFT JOIN resume_online r ON r.candidate_id = c.internal_id
    WHERE c.job_id = ?
  `).get(jobId) || {};
  const rows = database.prepare(`
    SELECT c.internal_id, c.geek_desc, c.sabc, c.sabc_source, r.sections_json
    FROM candidate c
    JOIN resume_online r ON r.candidate_id = c.internal_id
    WHERE c.job_id = ? AND r.is_paywalled = 0
  `).all(jobId);

  const summary = {
    jobId,
    rated: 0,
    skipped_manual: 0,
    skipped_missing_resume: Number(resumeSkipStats.skipped_missing_resume || 0),
    skipped_paywalled: Number(resumeSkipStats.skipped_paywalled || 0),
    hard_fail: 0,
    pending: 0,
    byTier: { S: 0, A: 0, B: 0, C: 0, D: 0 },
  };
  const started_at = nowIso();

  // 先算规则结果（纯本地同步逻辑，仍走小池以保留进度回调语义）。
  const jobs = rows.filter((row) => {
    if (row.sabc_source === '人工') { summary.skipped_manual += 1; return false; }
    return true;
  });

  let doneCount = 0;
  if (onProgress) onProgress(0, jobs.length); // 先报个总数，前端好显示 0/Y
  const computed = await runPool(jobs, 4, async (row) => {
    let sections;
    try { sections = JSON.parse(row.sections_json); } catch { sections = null; }
    const rule = applyRuleRating(config, { sections, geek_desc: row.geek_desc, sabc: row.sabc, sabc_source: row.sabc_source });
    const hasTier = Boolean(rule.tier);
    const result = {
      internal_id: row.internal_id,
      kind: hasTier ? (rule.hard_bar_pass === false ? 'hard_fail' : 'rule_tier') : 'pending',
      sabc: rule.tier || null,
      sabc_source: hasTier ? rule.source : null,
      verdict_label: rule.label || '待确认',
      expert_comment: null,
      hard_bar_pass: rule.hard_bar_pass === false ? 0 : rule.hard_bar_pass === true ? 1 : null,
      risk_point: (rule.reasons || []).join('；') || null,
    };
    // 单线程下自增安全：每评完一个就报进度。
    doneCount += 1;
    if (onProgress) onProgress(doneCount, jobs.length);
    return result;
  });

  const update = database.prepare(`
    UPDATE candidate SET
      sabc = @sabc, sabc_source = @sabc_source,
      verdict_label = @verdict_label,
      expert_comment = @expert_comment, hard_bar_pass = @hard_bar_pass,
      risk_point = @risk_point, updated_at = @updated_at
    WHERE internal_id = @internal_id
  `);

  const pendingReasons = [];
  database.transaction(() => {
    for (const r of computed) {
      update.run({
        internal_id: r.internal_id,
        sabc: r.sabc,
        sabc_source: r.sabc_source,
        verdict_label: r.verdict_label,
        expert_comment: r.expert_comment,
        hard_bar_pass: r.hard_bar_pass,
        risk_point: r.risk_point,
        updated_at: nowIso(),
      });
      if (r.kind === 'hard_fail') {
        summary.hard_fail += 1;
        if (summary.byTier[r.sabc] !== undefined) summary.byTier[r.sabc] += 1;
        summary.rated += 1;
      }
      else if (r.kind === 'pending') {
        summary.pending += 1;
        pendingReasons.push({ internal_id: r.internal_id, reason: r.risk_point });
      } else { summary.rated += 1; if (summary.byTier[r.sabc] !== undefined) summary.byTier[r.sabc] += 1; }
    }
  })();

  const total = database.prepare('SELECT COUNT(*) AS n FROM candidate WHERE job_id = ?').get(jobId).n;

  writeRunLog({
    run_type: '规则评级',
    account: '本地',
    job: String(jobId),
    status: '成功',
    count_new: summary.rated,
    count_total: total,
    started_at,
    finished_at: nowIso(),
  });
  writeAuditLog({
    action: '批量重评',
    target: String(jobId),
    who: 'HR',
    auto: 0,
    result: '成功',
    // pendingReasons 只进日志留痕排查用，不进 summary（summary 要发去前端 toast）。
    detail_json: JSON.stringify({ ...summary, pendingReasons }),
  });

  return summary;
}

module.exports = {
  DB_PATH,
  assessmentPhaseAEnabled,
  f018FeatureEnabled,
  openDb,
  openDbWithMigrationBackup,
  prepareDatabaseMigrationBackup,
  openReadonly,
  useReadonly,
  conn,
  listJobs,
  getJobLedger,
  assertCandidateJobRecruitingWritable,
  assertJobRecruitingWritableById,
  assertInterviewSessionProcessingAllowedById,
  assertInterviewRoundRecordingWritable,
  createLocalJob,
  createLocalJobFromEcommerceTemplate,
  updateJobDetails,
  copyJob,
  updateJobStatus,
  getCandidateJourneyOperations,
  setCandidateNextAction,
  recordHiringManagerFeedback,
  setCandidateOfferStatus,
  listTalentPool,
  addTalentToJob,
  getJobForFetch,
  listCandidates,
  listJobJdVersions,
  createJobJdVersion,
  activateJobJdVersion,
  listJobProfileVersions,
  createJobProfileVersion,
  confirmJobProfileVersion,
  getJobWorkbench,
  getCandidateTimeline,
  getCandidate,
  getCandidateKeys,
  getCandidateChildren,
  resolveCandidateScreenshot,
  getLatestRun,
  getLatestRunByType,
  getCircuitBreakers,
  getWriteActions,
  upsertJob,
  upsertCandidate,
  changeStatus,
  enqueueWriteAction,
  claimWriteAction,
  finishWriteAction,
  failClosedWriteAction,
  computeDedupKey,
  writeAuditLog,
  writeRunLog,
  insertResumeOnline,
  getJobProfile,
  getCurrentJobProfileContext,
  getDeepProfileGenerationReadiness,
  upsertJobProfile,
  upsertJobProfilePreservingDeep,
  insertInterview,
  listInterviews,
  insertAiReview,
  listAiReviews,
  getAssessStatus,
  createInterviewSession,
  createNextInterviewSession,
  getInterviewManualNote,
  listInterviewManualNoteRevisions,
  saveInterviewManualNote,
  revokeInterviewManualNote,
  getInterviewSession,
  listInterviewSessions,
  setInterviewSessionStatus,
  confirmInterviewSessionSchedule,
  createInterviewInterviewer,
  listInterviewInterviewers,
  updateInterviewInterviewer,
  markInterviewInvitationSent,
  recordInterviewCandidateConfirmation,
  listInterviewPendingAssignments,
  listInterviewPendingAssignmentClassificationAudits,
  classifyInterviewPendingAssignment,
  assignInterviewPendingAssignment,
  linkInterviewSessionRecording,
  linkInterviewSessionReport,
  linkInterviewSessionConsent,
  linkInterviewSessionConfirmation,
  closeInterviewLifecycle,
  withdrawInterviewLifecycle,
  applyInterviewLegalHold,
  releaseInterviewLegalHold,
  createInterviewDeletionDryRun,
  confirmInterviewDeletion,
  getInterviewLifecycleStatus,
  replayLifecycleTombstones,
  applyF006InterviewSessionMigration,
  rollbackF006InterviewSessionMigration,
  listInterviewRecordings,
  getInterviewRecording,
  createInterviewRecording,
  getInterviewConsent,
  getInterviewConsentPolicy,
  beginInterviewConsentRevocationGate,
  blockInterviewConsentRevocationInMemory,
  completeInterviewConsentRevocationGate,
  validateInterviewConsentRevocationRequest,
  recordInterviewConsent,
  requireActiveInterviewConsent,
  updateInterviewRecording,
  bindInterviewRecording,
  saveInterviewReportV1,
  saveStructuredManualInterviewReport,
  getInterviewReportV1,
  listOfficialInterviewReports,
  listInterviewReportFactReviews,
  reviewInterviewReportFacts,
  confirmInterviewReportV1,
  rejectInterviewReportV1,
  getF009InterviewMaterials,
  createF009LlmPreviewAudit,
  claimF009LlmRequest,
  finishF009LlmRequest,
  getF009LlmAudit,
  assertF009LlmActor,
  saveF009DraftAndFinishAudit,
  reconcileF009RunningRequests,
  saveInterviewReportForRecording,
  getInterviewReportForRecording,
  confirmInterviewReportForRecording,
  rejectInterviewReportForRecording,
  listInterviewReportFactReviewsForRecording,
  reviewInterviewReportFactsForRecording,
  saveInterviewAiReport,
  getLatestInterviewAiReport,
  listInterviewRecordingConfirmations,
  saveInterviewRecordingConfirmations,
  confirmInterviewRecording,
  getInterviewScript,
  saveInterviewScript,
  generateDeepProfileForJob,
  confirmDeepProfile,
  runSecondOpinion,
  runSecondOpinionLocalDemo,
  redactKnownCandidateName,
  rateJob,
};
