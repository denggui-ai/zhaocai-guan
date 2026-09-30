'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { applyAssessmentSchemaMigration } = require("../src/assessment-schema");
const { issueAssessmentFileSelection } = require("../src/assessment-file-selection");
const { createAssessmentProductService } = require("../src/assessment-product-service");

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-assessment-closed-gate-'));
const database = new Database(path.join(root, 'synthetic.db'));

process.on('exit', () => {
  try { database.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});

database.pragma('foreign_keys = ON');
database.exec(`
  CREATE TABLE job (
    id INTEGER PRIMARY KEY,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'open'
  );
  CREATE TABLE candidate (
    internal_id TEXT PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES job(id),
    name TEXT
  );
  CREATE TABLE ai_review (
    id INTEGER PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    job_id INTEGER NOT NULL,
    report_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  INSERT INTO job (id, name, status) VALUES (1, '合成测评岗位', 'open');
  INSERT INTO candidate (internal_id, job_id, name) VALUES ('C-ASSESSMENT-CLOSED-1', 1, '合成候选人');
`);
applyAssessmentSchemaMigration(database);

const actor = Object.freeze({
  actor_id: 'local-primary-operator',
  actor_type: 'local_os_subject',
  actor_source: 'server_local_instance',
  actor_session_id: 'synthetic-assessment-closed-gate',
  assurance: 'local_instance_only',
});
const secret = 'synthetic-assessment-closed-gate-secret-'.repeat(2);
const clock = Date.parse('2026-07-17T08:00:00.000Z');
let importCalls = 0;
const previewBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function fakeImport(sourcePath, options) {
  importCalls += 1;
  const hashCharacter = String.fromCharCode(96 + importCalls);
  const reportType = sourcePath.includes('unknown') ? 'unknown' : 'career_potential';
  const stored = {
    state: 'stored_pending_reference',
    duplicate: false,
    content_sha256: hashCharacter.repeat(64),
    byte_size: 128,
    page_count: 1,
    mime_detected: 'application/pdf',
    storage_relpath: `accepted/sha256/${hashCharacter.repeat(2)}/${hashCharacter.repeat(64)}.pdf`,
    preview_relpath: `previews/sha256/${hashCharacter.repeat(2)}/${hashCharacter.repeat(64)}`,
    analysis: {
      schema_version: 'assessment_report_analysis_v1',
      source: 'supplier_pdf_text',
      report_type: reportType,
      report_type_label: reportType === 'unknown' ? '未识别报告' : '职业潜能报告',
      subject_name: '合成候选人',
      assessed_job: '合成测评岗位',
      assessment_date: null,
      validity: '合成',
      summary: '纯合成报告',
      highlights: [], strengths: [], watchouts: [], career_matches: [], details: {},
    },
  };
  await options.commitDocument(stored);
  return { state: stored.state, duplicate: false, page_count: 1 };
}

const service = createAssessmentProductService({
  database,
  dataRoot: root,
  selectionSecret: secret,
  importPdf: fakeImport,
  readPreviewPage: () => previewBytes,
  executePhysicalDeletion: ({ command }) => ({
    operation: 'deleted_by_policy',
    document_id: command.document_id,
    lifecycle_state: 'deleted',
    version: command.expected_version + 1,
    event_id: 'synthetic-closed-cleanup-delete',
    idempotent_replay: false,
    tombstone: true,
    artifact_delete_state: 'deleted',
    deletion_request_state: 'completed',
  }),
  now: () => clock,
  retentionPolicy: { version: 'synthetic-retention-v1', days: 30 },
});

function selection(requestId, label, reportType = 'career_potential') {
  const binding = {
    source_path: path.join(root, `${label}.pdf`),
    candidate_id: 'C-ASSESSMENT-CLOSED-1',
    job_id: 1,
    report_type: reportType,
    assessment_date: null,
    request_id: requestId,
  };
  return { ...binding, selection_token: issueAssessmentFileSelection(secret, binding, { now: clock }) };
}

function materialSnapshot() {
  return {
    documents: database.prepare(`
      SELECT id, report_type, review_state, lifecycle_state,
             retention_policy_version, delete_after, version
      FROM assessment_document ORDER BY id
    `).all(),
    bindings: database.prepare(`
      SELECT id, document_id, state, version FROM assessment_binding ORDER BY id
    `).all(),
    events: database.prepare('SELECT COUNT(*) AS n FROM assessment_event').get().n,
  };
}

function isClosed(error) {
  return error && error.code === 'JOB_CLOSED' && error.statusCode === 409;
}

async function run() {
  const pendingKnown = await service.importSelected({
    auditContext: actor,
    command: selection('REQ-CLOSED-GATE-KNOWN', 'known'),
  });
  const pendingUnknown = await service.importSelected({
    auditContext: actor,
    command: selection('REQ-CLOSED-GATE-UNKNOWN', 'unknown', 'unknown'),
  });
  const closedImportCommand = selection('REQ-CLOSED-GATE-IMPORT', 'reopen');

  database.prepare(`
    UPDATE assessment_document
    SET retention_policy_version = NULL, delete_after = NULL
    WHERE id = ?
  `).run(pendingUnknown.document_id);
  database.prepare("UPDATE job SET status = 'closed' WHERE id = 1").run();
  const beforeBlockedWrites = materialSnapshot();
  const callsBeforeBlockedImport = importCalls;

  await assert.rejects(
    () => service.importSelected({ auditContext: actor, command: closedImportCommand }),
    isClosed,
  );
  assert.equal(importCalls, callsBeforeBlockedImport, 'closed import must fail before controlled-store import starts');
  assert.throws(() => service.confirmBinding({
    auditContext: actor,
    command: {
      binding_id: pendingKnown.binding_id,
      expected_version: pendingKnown.binding_version,
      request_id: 'REQ-CLOSED-GATE-CONFIRM',
      reason_code: 'manual_archive_confirmed',
      candidate_id: 'C-ASSESSMENT-CLOSED-1',
      job_id: 1,
    },
  }), isClosed);
  assert.throws(() => service.confirmMetadata({
    auditContext: actor,
    command: {
      binding_id: pendingUnknown.binding_id,
      document_id: pendingUnknown.document_id,
      candidate_id: 'C-ASSESSMENT-CLOSED-1',
      job_id: 1,
      report_type: 'career_potential',
      assessment_date: null,
      expected_version: database.prepare('SELECT version FROM assessment_document WHERE id = ?')
        .get(pendingUnknown.document_id).version,
      request_id: 'REQ-CLOSED-GATE-METADATA',
    },
  }), isClosed);
  assert.throws(() => service.resolveDuplicateBinding({
    auditContext: actor,
    command: {
      document_id: pendingKnown.document_id,
      candidate_id: 'C-ASSESSMENT-CLOSED-1',
      job_id: 1,
      request_id: 'REQ-CLOSED-GATE-DUPLICATE',
      confirmed: true,
    },
  }), isClosed);
  assert.deepEqual(materialSnapshot(), beforeBlockedWrites, 'blocked closed-job material actions must write nothing');

  const closedArchives = await service.listArchives({
    auditContext: actor,
    command: { candidate_id: 'C-ASSESSMENT-CLOSED-1', job_id: 1 },
  });
  const closedQueue = await service.listQueue({ auditContext: actor, command: { job_id: 1 } });
  assert.equal(closedArchives.length, 2, 'closed job assessment history must remain readable');
  assert.equal(closedQueue.length, 2, 'closed job assessment queue history must remain readable');

  const revoked = service.revokeBinding({
    auditContext: actor,
    command: {
      binding_id: pendingKnown.binding_id,
      expected_version: pendingKnown.binding_version,
      request_id: 'REQ-CLOSED-GATE-REVOKE',
      reason_code: 'manual_archive_revoked',
      candidate_id: 'C-ASSESSMENT-CLOSED-1',
      job_id: 1,
    },
  });
  assert.equal(revoked.state, 'revoked', 'closed job must still allow binding cleanup');

  database.prepare(`
    UPDATE assessment_document
    SET retention_policy_version = 'synthetic-retention-v1', delete_after = '2000-01-01T00:00:00.000Z'
    WHERE id = ?
  `).run(pendingKnown.document_id);
  const deleteVersion = database.prepare('SELECT version FROM assessment_document WHERE id = ?')
    .get(pendingKnown.document_id).version;
  const deletion = service.requestDeletion({
    auditContext: actor,
    command: {
      document_id: pendingKnown.document_id,
      candidate_id: 'C-ASSESSMENT-CLOSED-1',
      job_id: 1,
      expected_version: deleteVersion,
      request_id: 'REQ-CLOSED-GATE-DELETE',
      reason_code: 'retention_due',
      policy_version: 'synthetic-retention-v1',
      effective_at: '2000-01-01T00:00:00.000Z',
    },
  });
  assert.equal(deletion.lifecycle_state, 'deletion_pending', 'closed job must still allow retention cleanup');
  const deleted = service.confirmDeletion({
    auditContext: actor,
    command: {
      document_id: pendingKnown.document_id,
      candidate_id: 'C-ASSESSMENT-CLOSED-1',
      job_id: 1,
      expected_version: deletion.version,
      request_id: 'REQ-CLOSED-GATE-DELETE',
      reason_code: 'retention_due',
      policy_version: 'synthetic-retention-v1',
      effective_at: '2000-01-01T00:00:00.000Z',
      physical_delete_confirmed: true,
    },
  });
  assert.equal(deleted.artifact_delete_state, 'deleted');

  database.prepare("UPDATE job SET status = 'open' WHERE id = 1").run();
  const reopenedImport = await service.importSelected({ auditContext: actor, command: closedImportCommand });
  assert.equal(reopenedImport.binding_state, 'pending', 'reopened job must accept the same unconsumed native selection');
  assert.equal(service.confirmBinding({
    auditContext: actor,
    command: {
      binding_id: reopenedImport.binding_id,
      expected_version: reopenedImport.binding_version,
      request_id: 'REQ-CLOSED-GATE-REOPEN-CONFIRM',
      reason_code: 'manual_archive_confirmed',
      candidate_id: 'C-ASSESSMENT-CLOSED-1',
      job_id: 1,
    },
  }).state, 'active');
  const classified = service.confirmMetadata({
    auditContext: actor,
    command: {
      binding_id: pendingUnknown.binding_id,
      document_id: pendingUnknown.document_id,
      candidate_id: 'C-ASSESSMENT-CLOSED-1',
      job_id: 1,
      report_type: 'career_potential',
      assessment_date: null,
      expected_version: database.prepare('SELECT version FROM assessment_document WHERE id = ?')
        .get(pendingUnknown.document_id).version,
      request_id: 'REQ-CLOSED-GATE-REOPEN-METADATA',
    },
  });
  assert.equal(classified.review_state, 'ready', 'reopened job must restore metadata confirmation');

  database.prepare("UPDATE job SET status = 'closed' WHERE id = 1").run();
  const preview = service.createPreview({
    auditContext: actor,
    command: {
      binding_id: reopenedImport.binding_id,
      document_id: reopenedImport.document_id,
      candidate_id: 'C-ASSESSMENT-CLOSED-1',
      job_id: 1,
      request_id: 'REQ-CLOSED-GATE-PREVIEW',
    },
  });
  assert.deepEqual(service.getPreviewPage(preview.preview_id, 1), previewBytes,
    'closed job must retain read-only assessment preview');

  console.log('check-assessment-closed-job-gate-001 ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
