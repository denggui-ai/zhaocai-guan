const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-old-schema-'));
const dbPath = path.join(testRoot, 'legacy.db');
process.on('exit', () => fs.rmSync(testRoot, { recursive: true, force: true }));

const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE job (
    id INTEGER PRIMARY KEY,
    encrypt_job_id TEXT NOT NULL,
    numeric_job_id TEXT,
    name TEXT,
    hr_owner TEXT,
    created_at TEXT
  );

  CREATE TABLE job_interview (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES job(id),
    source_url TEXT,
    transcript TEXT NOT NULL,
    note TEXT,
    created_at TEXT
  );

  CREATE TABLE screenshot_ocr_draft (
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
    candidate_id TEXT,
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  INSERT INTO job VALUES (1, 'real-job-old', '1001', '真实旧岗位', 'HR', '2026-07-01T00:00:00.000Z');
  INSERT INTO job VALUES (2, 'fixture-job-old', '1002', '旧样本岗位', 'HR', '2026-07-01T00:00:00.000Z');
  INSERT INTO job VALUES (3, 'legacy-demo-id', '1003', 'Fixture Legacy Job', 'HR', '2026-07-01T00:00:00.000Z');

  INSERT INTO screenshot_ocr_draft (
    id, draft_key, draft_id, evidence_batch_id, job_id, job_name, status,
    original_json, current_json, field_evidence_json, review_flags_json, context_json,
    created_at, updated_at
  ) VALUES (
    1, 'legacy-f002-draft', 'legacy-draft', NULL, 1, '真实旧岗位', 'pending_review',
    '{}', '{}', '{}', '{}', '{}', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
  );

  INSERT INTO job_interview VALUES (1, 1, NULL, '手动转写原文', '负责人访谈', '2026-07-01T01:00:00.000Z');
  INSERT INTO job_interview VALUES (2, 1, NULL, '线下录音原文', '线下录音转写', '2026-07-01T02:00:00.000Z');
  INSERT INTO job_interview VALUES (3, 1, 'https://example.test/minutes/legacy', '会议转写原文', '线上会议导入', '2026-07-01T03:00:00.000Z');
  INSERT INTO job_interview VALUES (4, 1, NULL, '旧标记原文', '[source_type:offline_recording] 历史材料', '2026-07-01T04:00:00.000Z');
`);
legacy.close();

const dbmod = require('./db');

function verifyUpgrade(database) {
  const jobColumns = database.prepare("PRAGMA table_info('job')").all();
  const fixtureColumn = jobColumns.find((column) => column.name === 'is_fixture');
  const sourceColumn = jobColumns.find((column) => column.name === 'source_type');
  assert.ok(fixtureColumn && sourceColumn, 'job migration must append both persisted columns');
  assert.equal(fixtureColumn.notnull, 1);
  assert.equal(sourceColumn.notnull, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('job_interview') WHERE name = 'source_type'").get().n, 1);

  assert.deepEqual(database.prepare('SELECT id, is_fixture, source_type FROM job ORDER BY id').all(), [
    { id: 1, is_fixture: 0, source_type: 'local_db' },
    { id: 2, is_fixture: 1, source_type: 'fixture' },
    { id: 3, is_fixture: 0, source_type: 'local_db' },
  ]);
  assert.deepEqual(database.prepare('SELECT id, source_type FROM job_interview ORDER BY id').all(), [
    { id: 1, source_type: 'manual_transcript' },
    { id: 2, source_type: 'offline_recording' },
    { id: 3, source_type: 'lark_minutes' },
    { id: 4, source_type: 'offline_recording' },
  ]);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM job').get().n, 3, 'job rows must not be lost');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM job_interview').get().n, 4, 'interview rows must not be lost');
  assert.equal(database.prepare('SELECT transcript FROM job_interview WHERE id = 3').get().transcript, '会议转写原文');
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'screenshot_ocr_draft'").get().n, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'screenshot_ocr_review_audit'").get().n, 1);
  for (const column of ['identity_key', 'source_fingerprint', 'content_fingerprint', 'identity_status', 'identity_json']) {
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('screenshot_ocr_draft') WHERE name = ?").get(column).n, 1);
  }
  assert.equal(database.prepare('SELECT draft_key FROM screenshot_ocr_draft WHERE id = 1').get().draft_key, 'legacy-f002-draft');
  assert.equal(database.prepare('SELECT identity_status FROM screenshot_ocr_draft WHERE id = 1').get().identity_status, 'insufficient');
  assert.match(
    database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'screenshot_ocr_draft'").get().sql,
    /pending_review[\s\S]*confirmed[\s\S]*rejected/,
    'OCR review migration must persist the stable status vocabulary',
  );
}

let upgraded = dbmod.openDb(dbPath);
verifyUpgrade(upgraded);
upgraded.exec('BEGIN');
upgraded.exec('DROP TABLE screenshot_ocr_review_audit; DROP TABLE screenshot_ocr_draft;');
upgraded.exec('ROLLBACK');
assert.equal(
  upgraded.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'screenshot_ocr_draft'").get().n,
  1,
  'additive OCR review migration DDL must be transactionally rollbackable',
);
assert.deepEqual(dbmod.listJobs().map(({ id, name, is_fixture, source_type }) => ({ id, name, is_fixture, source_type })), [
  { id: 1, name: '真实旧岗位', is_fixture: 0, source_type: 'local_db' },
  { id: 3, name: 'Fixture Legacy Job', is_fixture: 0, source_type: 'local_db' },
  { id: 2, name: '旧样本岗位', is_fixture: 1, source_type: 'fixture' },
]);
assert.deepEqual(dbmod.listInterviews(1).map((row) => row.source_type), [
  'manual_transcript',
  'offline_recording',
  'lark_minutes',
  'offline_recording',
]);
upgraded.close();

upgraded = dbmod.openDb(dbPath);
assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM job').get().n, 3);
assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM job_interview').get().n, 4);
assert.equal(upgraded.prepare('SELECT source_type FROM job_interview WHERE id = 3').get().source_type, 'lark_minutes');
upgraded.prepare("UPDATE job_interview SET source_type = 'manual_transcript' WHERE id = 3").run();
upgraded.close();

upgraded = dbmod.openDb(dbPath);
assert.equal(
  upgraded.prepare('SELECT source_type FROM job_interview WHERE id = 3').get().source_type,
  'manual_transcript',
  '重复启动必须尊重已持久化字段，不能再用 source_url 覆盖人工修正',
);
assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM job').get().n, 3);
assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM job_interview').get().n, 4);
upgraded.close();

fs.rmSync(testRoot, { recursive: true, force: true });
console.log('check-schema-migration ok');
