'use strict';

const assert = require('assert');
const path = require('path');
const Database = require('better-sqlite3');
const { applyAssessmentSchemaMigration } = require('./assessment-schema');
const { issueAssessmentFileSelection } = require('./assessment-file-selection');
const {
  assessmentRetentionPolicyFromEnv,
  createAssessmentProductService,
  normalizeAssessmentRetentionPolicy,
} = require('./assessment-product-service');

assert.equal(assessmentRetentionPolicyFromEnv({}), null);
assert.deepEqual(
  assessmentRetentionPolicyFromEnv({
    HRBOSS_ASSESSMENT_RETENTION_POLICY_VERSION: 'synthetic-retention-v1',
    HRBOSS_ASSESSMENT_RETENTION_DAYS: '30',
  }),
  { version: 'synthetic-retention-v1', days: 30 },
);
assert.throws(
  () => assessmentRetentionPolicyFromEnv({ HRBOSS_ASSESSMENT_RETENTION_POLICY_VERSION: 'synthetic-retention-v1' }),
  (error) => error.code === 'RETENTION_POLICY_INVALID',
);
assert.throws(
  () => normalizeAssessmentRetentionPolicy({ version: 'synthetic-retention-v1', days: 0 }),
  (error) => error.code === 'RETENTION_POLICY_INVALID',
);

const database = new Database(':memory:');
database.pragma('foreign_keys = ON');
database.exec(`
  CREATE TABLE job (id INTEGER PRIMARY KEY, name TEXT, status TEXT NOT NULL DEFAULT 'open');
  CREATE TABLE candidate (
    internal_id TEXT PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES job(id),
    name TEXT,
    rec_position TEXT,
    sabc TEXT,
    quality_score INTEGER,
    disposition_code TEXT
  );
  INSERT INTO job (id, name, status) VALUES (1, '合成岗位', 'open'), (2, '隔离岗位', 'open');
  INSERT INTO candidate (internal_id, job_id, name, rec_position, sabc, quality_score, disposition_code)
  VALUES ('C-SYNTHETIC-1', 1, '合成候选人', '合成岗位', 'A', 88, 'none'), ('C-SYNTHETIC-2', 2, '隔离候选人', '隔离岗位', 'B', 66, 'none');
  CREATE TABLE job_jd_version (
    id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL, version INTEGER NOT NULL,
    jd_text TEXT NOT NULL, status TEXT NOT NULL
  );
  CREATE TABLE job_profile_version (
    id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL, version INTEGER NOT NULL,
    jd_version_id INTEGER NOT NULL, config_json TEXT NOT NULL, status TEXT NOT NULL
  );
  CREATE TABLE ai_review (
    id INTEGER PRIMARY KEY, candidate_id TEXT NOT NULL, job_id INTEGER NOT NULL,
    report_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  INSERT INTO job_jd_version (id, job_id, version, jd_text, status)
  VALUES (1, 1, 1, '合成 JD', 'active');
`);
applyAssessmentSchemaMigration(database);

const actor = Object.freeze({
  actor_id: 'local-primary-operator',
  actor_type: 'local_os_subject',
  actor_source: 'server_local_instance',
  actor_session_id: 'synthetic-product-session',
  assurance: 'local_instance_only',
});
const secret = 'synthetic-assessment-product-selection-secret-'.repeat(2);
let clock = Date.parse('2026-07-12T12:00:00.000Z');
let duplicateMode = false;
let hashCharacter = 'a';
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

async function fakeImport(_sourcePath, options) {
  const record = {
    state: duplicateMode ? 'duplicate_seen' : 'stored_pending_reference',
    duplicate: duplicateMode,
    content_sha256: hashCharacter.repeat(64),
    byte_size: 128,
    page_count: 2,
    mime_detected: 'application/pdf',
    storage_relpath: `accepted/sha256/${hashCharacter.repeat(2)}/${hashCharacter.repeat(64)}.pdf`,
    preview_relpath: `previews/sha256/${hashCharacter.repeat(2)}/${hashCharacter.repeat(64)}`,
    analysis: {
      schema_version: 'assessment_report_analysis_v1',
      source: 'supplier_pdf_text',
      report_type: 'career_potential',
      report_type_label: '职业潜能报告',
      subject_name: '合成候选人',
      assessed_job: '合成岗位',
      assessment_date: '2026-07-01',
      validity: '高',
      summary: '合成分析摘要',
      highlights: [], strengths: [], watchouts: [], career_matches: [], details: {},
    },
  };
  if (duplicateMode) await options.onDuplicate(record);
  else await options.commitDocument(record);
  return { state: record.state, duplicate: record.duplicate, page_count: 2 };
}

const service = createAssessmentProductService({
  database,
  dataRoot: path.resolve('/synthetic-only/data'),
  selectionSecret: secret,
  importPdf: fakeImport,
  executePhysicalDeletion: ({ command }) => {
    if (command.physical_delete_confirmed !== true) {
      const error = new Error('explicit physical deletion confirmation required');
      error.code = 'PHYSICAL_DELETE_CONFIRMATION_REQUIRED';
      throw error;
    }
    return {
      operation: 'deleted_by_policy', document_id: command.document_id,
      lifecycle_state: 'deleted', tombstone: true, version: command.expected_version + 1,
      event_id: 'synthetic-delete-event', idempotent_replay: false,
      artifact_delete_state: 'deleted', deletion_request_state: 'completed',
      storage_relpath: 'must-not-leak.pdf', content_sha256: 'f'.repeat(64),
    };
  },
  readPreviewPage: () => png,
  now: () => clock,
  retentionPolicy: { version: 'synthetic-retention-v1', days: 30 },
});

function selection(requestId, candidateId = 'C-SYNTHETIC-1', jobId = 1) {
  const binding = {
    source_path: path.resolve('/synthetic-only/input.pdf'),
    candidate_id: candidateId,
    job_id: jobId,
    report_type: 'career_potential',
    assessment_date: '2026-07-01',
    request_id: requestId,
  };
  return { ...binding, selection_token: issueAssessmentFileSelection(secret, binding, { now: clock }) };
}

async function checkAutomaticUnknownImportStaysPending() {
  const isolated = new Database(':memory:');
  isolated.pragma('foreign_keys = ON');
  isolated.exec(`
    CREATE TABLE job (id INTEGER PRIMARY KEY, name TEXT, status TEXT NOT NULL DEFAULT 'open');
    CREATE TABLE candidate (
      internal_id TEXT PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES job(id),
      name TEXT
    );
    INSERT INTO job (id, name, status) VALUES (1, '未知类型合成岗位', 'open');
    INSERT INTO candidate (internal_id, job_id, name) VALUES ('C-UNKNOWN-1', 1, '未知类型合成候选人');
  `);
  applyAssessmentSchemaMigration(isolated);
  const isolatedSecret = 'synthetic-unknown-assessment-selection-secret-'.repeat(2);
  let inferredReportType = 'unknown';
  let isolatedHashCharacter = 'e';
  let includeAnalysis = true;
  const importPdf = async (_sourcePath, options) => {
    const record = {
      state: 'stored_pending_reference',
      duplicate: false,
      content_sha256: isolatedHashCharacter.repeat(64),
      byte_size: 128,
      page_count: 2,
      mime_detected: 'application/pdf',
      storage_relpath: `accepted/sha256/${isolatedHashCharacter.repeat(2)}/${isolatedHashCharacter.repeat(64)}.pdf`,
      preview_relpath: `previews/sha256/${isolatedHashCharacter.repeat(2)}/${isolatedHashCharacter.repeat(64)}`,
      ...(includeAnalysis ? { analysis: {
        schema_version: 'assessment_report_analysis_v1',
        source: 'supplier_pdf_text',
        report_type: inferredReportType,
        report_type_label: inferredReportType === 'unknown' ? '未识别报告' : '职业潜能报告',
        subject_name: '未知类型合成候选人',
        assessed_job: '未知类型合成岗位',
        assessment_date: '2026-07-01',
        validity: '未知',
        summary: '合成分析摘要',
        highlights: [], strengths: [], watchouts: [], career_matches: [], details: {},
      } } : { analysis_error_code: 'ASSESSMENT_REPORT_OCR_UNAVAILABLE' }),
    };
    await options.commitDocument(record);
    return { state: record.state, duplicate: false, page_count: 2 };
  };
  const isolatedService = createAssessmentProductService({
    database: isolated,
    dataRoot: path.resolve('/synthetic-only/unknown-data'),
    selectionSecret: isolatedSecret,
    importPdf,
    now: () => clock,
    retentionPolicy: { version: 'synthetic-retention-v1', days: 30 },
  });
  const automaticSelection = (requestId) => {
    const binding = {
      source_path: path.resolve('/synthetic-only/unknown-input.pdf'),
      candidate_id: 'C-UNKNOWN-1',
      job_id: 1,
      report_type: 'unknown',
      assessment_date: null,
      request_id: requestId,
    };
    return {
      ...binding,
      selection_token: issueAssessmentFileSelection(isolatedSecret, binding, { now: clock }),
    };
  };

  const unknown = await isolatedService.importSelected({
    auditContext: actor,
    command: automaticSelection('REQ-PRODUCT-UNKNOWN'),
  });
  assert.equal(unknown.report_type, 'unknown');
  assert.equal(unknown.binding_state, 'pending');
  assert.deepEqual(isolated.prepare(`
    SELECT report_type, review_state, analysis_status, version
    FROM assessment_document WHERE id = ?
  `).get(unknown.document_id), {
    report_type: 'unknown',
    review_state: 'pending',
    analysis_status: 'ready',
    version: 2,
  });
  assert.throws(() => isolatedService.confirmBinding({
    auditContext: actor,
    command: {
      binding_id: unknown.binding_id,
      expected_version: unknown.binding_version,
      request_id: 'REQ-PRODUCT-UNKNOWN-CONFIRM',
      reason_code: 'manual_archive_confirmed',
      candidate_id: 'C-UNKNOWN-1',
      job_id: 1,
    },
  }), (error) => error.code === 'DOCUMENT_NOT_READY');
  const unknownArchive = (await isolatedService.listArchives({
    auditContext: actor,
    command: { candidate_id: 'C-UNKNOWN-1', job_id: 1 },
  })).find((row) => row.binding_id === unknown.binding_id);
  const classifyCommand = {
    binding_id: unknownArchive.binding_id,
    document_id: unknownArchive.document_id,
    candidate_id: unknownArchive.candidate_id,
    job_id: unknownArchive.job_id,
    report_type: 'career_potential',
    assessment_date: null,
    expected_version: unknownArchive.document_version,
    request_id: 'REQ-PRODUCT-UNKNOWN-CLASSIFY',
  };
  assert.throws(() => isolatedService.confirmMetadata({
    auditContext: actor,
    command: { ...classifyCommand, report_type: 'unknown' },
  }), (error) => error.code === 'REPORT_TYPE_CLASSIFICATION_REQUIRED');
  assert.throws(() => isolatedService.confirmMetadata({
    auditContext: actor,
    command: { ...classifyCommand, report_type: 'personality_score' },
  }), (error) => error.code === 'REPORT_TYPE_INVALID');
  assert.throws(() => isolatedService.confirmMetadata({
    auditContext: actor,
    command: { ...classifyCommand, job_id: 2 },
  }), (error) => error.code === 'BINDING_CONTEXT_MISMATCH');
  assert.throws(() => isolatedService.confirmMetadata({
    auditContext: actor,
    command: { ...classifyCommand, document_id: 'DOC-OTHER' },
  }), (error) => error.code === 'DOCUMENT_CONTEXT_MISMATCH');
  const classified = isolatedService.confirmMetadata({ auditContext: actor, command: classifyCommand });
  assert.equal(classified.report_type, 'career_potential');
  assert.equal(classified.review_state, 'ready');
  assert.equal(isolatedService.confirmMetadata({ auditContext: actor, command: classifyCommand }).idempotent_replay, true);
  assert.equal(isolatedService.confirmBinding({
    auditContext: actor,
    command: {
      binding_id: unknown.binding_id,
      expected_version: unknown.binding_version,
      request_id: 'REQ-PRODUCT-UNKNOWN-CONFIRM-AFTER-CLASSIFY',
      reason_code: 'manual_archive_confirmed',
      candidate_id: 'C-UNKNOWN-1',
      job_id: 1,
    },
  }).state, 'active');
  assert.throws(() => isolatedService.confirmMetadata({
    auditContext: actor,
    command: {
      ...classifyCommand,
      expected_version: classified.version,
      request_id: 'REQ-PRODUCT-UNKNOWN-RECLASSIFY',
    },
  }), (error) => error.code === 'BINDING_STATE_INVALID');

  includeAnalysis = false;
  isolatedHashCharacter = 'a';
  const unrecognized = await isolatedService.importSelected({
    auditContext: actor,
    command: automaticSelection('REQ-PRODUCT-UNRECOGNIZED'),
  });
  assert.equal(unrecognized.report_type, 'unknown');
  assert.deepEqual(isolated.prepare(`
    SELECT report_type, review_state, analysis_status, analysis_error_code
    FROM assessment_document WHERE id = ?
  `).get(unrecognized.document_id), {
    report_type: 'unknown',
    review_state: 'pending',
    analysis_status: 'failed',
    analysis_error_code: 'ASSESSMENT_REPORT_OCR_UNAVAILABLE',
  });

  includeAnalysis = true;
  inferredReportType = 'career_potential';
  isolatedHashCharacter = 'f';
  const recognized = await isolatedService.importSelected({
    auditContext: actor,
    command: automaticSelection('REQ-PRODUCT-AUTO-RECOGNIZED'),
  });
  assert.equal(recognized.report_type, 'career_potential');
  assert.equal(isolated.prepare('SELECT review_state FROM assessment_document WHERE id = ?')
    .get(recognized.document_id).review_state, 'ready');
  isolated.close();
}

async function run() {
  await checkAutomaticUnknownImportStaysPending();
  const unconfigured = createAssessmentProductService({
    database,
    dataRoot: path.resolve('/synthetic-only/unconfigured-data'),
    selectionSecret: secret,
    importPdf: fakeImport,
    now: () => clock,
  });
  await assert.rejects(
    () => unconfigured.importSelected({ auditContext: actor, command: selection('REQ-PRODUCT-NO-RETENTION') }),
    (error) => error.code === 'RETENTION_POLICY_NOT_CONFIGURED',
  );
  const candidateBefore = database.prepare('SELECT * FROM candidate ORDER BY internal_id').all();
  const imported = await service.importSelected({ auditContext: actor, command: selection('REQ-PRODUCT-IMPORT-1') });
  assert.equal(imported.duplicate, false);
  assert.equal(imported.binding_state, 'pending');
  const retained = database.prepare('SELECT retention_policy_version, delete_after FROM assessment_document WHERE id = ?').get(imported.document_id);
  assert.equal(retained.retention_policy_version, 'synthetic-retention-v1');
  assert.ok(Date.parse(retained.delete_after) > clock);
  assert.equal(Object.hasOwn(imported, 'content_sha256'), false);
  assert.equal(Object.hasOwn(imported, 'storage_relpath'), false);

  const archives = await service.listArchives({ auditContext: actor, command: { candidate_id: 'C-SYNTHETIC-1', job_id: 1 } });
  assert.equal(archives.length, 1);
  assert.equal(archives[0].binding_state, 'pending');
  assert.equal(archives[0].analysis_status, 'ready');
  assert.equal(archives[0].analysis.subject_name, '合成候选人');
  assert.equal(JSON.stringify(archives).includes('accepted/'), false);
  assert.equal(JSON.stringify(archives).includes('a'.repeat(64)), false);

  assert.throws(() => service.confirmBinding({
    auditContext: actor,
    command: {
      binding_id: imported.binding_id, expected_version: 1, request_id: 'REQ-CONFIRM-WRONG-CONTEXT',
      reason_code: 'manual_archive_confirmed', candidate_id: 'C-SYNTHETIC-2', job_id: 2,
    },
  }), (error) => error.code === 'BINDING_CONTEXT_MISMATCH');

  const confirmed = service.confirmBinding({
    auditContext: actor,
    command: {
      binding_id: imported.binding_id, expected_version: 1, request_id: 'REQ-CONFIRM-1',
      reason_code: 'manual_archive_confirmed', candidate_id: 'C-SYNTHETIC-1', job_id: 1,
    },
  });
  assert.equal(confirmed.state, 'active');
  assert.deepEqual(
    service.listAiAnalyses({ command: { candidate_id: 'C-SYNTHETIC-1', job_id: 1 } }),
    [],
    'listing local assessment archives must not require a current JD/profile for AI readiness',
  );
  const preview = service.createPreview({
    auditContext: actor,
    command: {
      binding_id: imported.binding_id,
      document_id: imported.document_id,
      candidate_id: 'C-SYNTHETIC-1',
      job_id: 1,
      request_id: 'REQ-PREVIEW-1',
    },
  });
  assert.equal(preview.page_count, 2);
  assert.deepEqual(service.getPreviewPage(preview.preview_id, 2), png);
  clock += 5 * 60 * 1000 + 1;
  assert.throws(() => service.getPreviewPage(preview.preview_id, 1), (error) => error.code === 'ASSESSMENT_PREVIEW_TICKET_INVALID');

  function previewTicket(requestId) {
    return service.createPreview({
      auditContext: actor,
      command: {
        binding_id: imported.binding_id,
        document_id: imported.document_id,
        candidate_id: 'C-SYNTHETIC-1',
        job_id: 1,
        request_id: requestId,
      },
    });
  }

  const versionTicket = previewTicket('REQ-PREVIEW-VERSION');
  database.prepare('UPDATE assessment_document SET version = version + 1 WHERE id = ?').run(imported.document_id);
  assert.throws(() => service.getPreviewPage(versionTicket.preview_id, 1),
    (error) => error.code === 'ASSESSMENT_PREVIEW_TICKET_INVALID');

  const frozenTicket = previewTicket('REQ-PREVIEW-FROZEN');
  database.prepare("UPDATE assessment_document SET lifecycle_state = 'frozen', version = version + 1 WHERE id = ?")
    .run(imported.document_id);
  assert.throws(() => service.getPreviewPage(frozenTicket.preview_id, 1),
    (error) => error.code === 'ASSESSMENT_PREVIEW_TICKET_INVALID');
  database.prepare("UPDATE assessment_document SET lifecycle_state = 'active', version = version + 1 WHERE id = ?")
    .run(imported.document_id);

  const contextTicket = previewTicket('REQ-PREVIEW-CONTEXT');
  database.prepare('UPDATE candidate SET job_id = 2 WHERE internal_id = ?').run('C-SYNTHETIC-1');
  assert.throws(() => service.getPreviewPage(contextTicket.preview_id, 1),
    (error) => error.code === 'ASSESSMENT_PREVIEW_TICKET_INVALID');
  database.prepare('UPDATE candidate SET job_id = 1 WHERE internal_id = ?').run('C-SYNTHETIC-1');

  const deleteTicket = previewTicket('REQ-PREVIEW-DELETE');
  const revokeTicket = previewTicket('REQ-PREVIEW-REVOKE');
  assert.throws(() => service.revokeBinding({
    auditContext: actor,
    command: {
      binding_id: imported.binding_id,
      expected_version: confirmed.version,
      request_id: 'REQ-REVOKE-WRONG-CONTEXT',
      reason_code: 'manual_archive_revoked',
      candidate_id: 'C-SYNTHETIC-2',
      job_id: 2,
    },
  }), (error) => error.code === 'BINDING_CONTEXT_MISMATCH');
  const revoked = service.revokeBinding({
    auditContext: actor,
    command: {
      binding_id: imported.binding_id,
      expected_version: confirmed.version,
      request_id: 'REQ-REVOKE-PREVIEW',
      reason_code: 'manual_archive_revoked',
      candidate_id: 'C-SYNTHETIC-1',
      job_id: 1,
    },
  });
  assert.equal(revoked.state, 'revoked');
  assert.throws(() => service.getPreviewPage(revokeTicket.preview_id, 1),
    (error) => error.code === 'ASSESSMENT_PREVIEW_TICKET_INVALID');

  database.prepare(`
    UPDATE assessment_document
    SET retention_policy_version = 'synthetic-retention-v1', delete_after = '2000-01-01T00:00:00.000Z'
    WHERE id = ?
  `).run(imported.document_id);
  const deleteVersion = database.prepare('SELECT version FROM assessment_document WHERE id = ?').get(imported.document_id).version;
  const effectiveAt = new Date(Date.now() - 60_000).toISOString();
  assert.throws(() => service.requestDeletion({
    auditContext: actor,
    command: {
      document_id: imported.document_id, candidate_id: 'C-SYNTHETIC-2', job_id: 2,
      expected_version: deleteVersion, request_id: 'REQ-DELETE-WRONG-CONTEXT', reason_code: 'retention_due',
      policy_version: 'synthetic-retention-v1', effective_at: effectiveAt,
    },
  }), (error) => error.code === 'DOCUMENT_CONTEXT_MISMATCH');
  const deleteRequest = service.requestDeletion({
    auditContext: actor,
    command: {
      document_id: imported.document_id, candidate_id: 'C-SYNTHETIC-1', job_id: 1,
      expected_version: deleteVersion, request_id: 'REQ-PRODUCT-DELETE', reason_code: 'retention_due',
      policy_version: 'synthetic-retention-v1', effective_at: effectiveAt,
    },
  });
  assert.equal(deleteRequest.lifecycle_state, 'deletion_pending');
  assert.equal(deleteRequest.deletion_request_state, 'pending');
  assert.throws(() => service.getPreviewPage(deleteTicket.preview_id, 1),
    (error) => error.code === 'ASSESSMENT_PREVIEW_TICKET_INVALID');
  assert.throws(() => service.confirmDeletion({
    auditContext: actor,
    command: {
      document_id: imported.document_id, candidate_id: 'C-SYNTHETIC-1', job_id: 1,
      expected_version: deleteRequest.version, request_id: 'REQ-PRODUCT-DELETE',
      reason_code: 'retention_due', policy_version: 'synthetic-retention-v1',
      effective_at: effectiveAt, physical_delete_confirmed: false,
    },
  }), (error) => error.code === 'PHYSICAL_DELETE_CONFIRMATION_REQUIRED');
  const deleted = service.confirmDeletion({
    auditContext: actor,
    command: {
      document_id: imported.document_id, candidate_id: 'C-SYNTHETIC-1', job_id: 1,
      expected_version: deleteRequest.version, request_id: 'REQ-PRODUCT-DELETE',
      reason_code: 'retention_due', policy_version: 'synthetic-retention-v1',
      effective_at: effectiveAt, physical_delete_confirmed: true,
    },
  });
  assert.equal(deleted.artifact_delete_state, 'deleted');
  assert.equal(deleted.deletion_request_state, 'completed');
  assert.equal(JSON.stringify(deleted).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(deleted).includes('f'.repeat(64)), false);

  const countsBeforeFailedImport = {
    documents: database.prepare('SELECT COUNT(*) AS n FROM assessment_document').get().n,
    bindings: database.prepare('SELECT COUNT(*) AS n FROM assessment_binding').get().n,
    events: database.prepare('SELECT COUNT(*) AS n FROM assessment_event').get().n,
  };
  hashCharacter = 'b';
  database.exec(`
    CREATE TRIGGER synthetic_fail_pending_binding
    BEFORE INSERT ON assessment_binding
    WHEN NEW.request_id LIKE 'f017:pending:%'
    BEGIN SELECT RAISE(ABORT, 'synthetic pending failure'); END;
  `);
  await assert.rejects(
    () => service.importSelected({ auditContext: actor, command: selection('REQ-ATOMIC-IMPORT-FAIL', 'C-SYNTHETIC-2', 2) }),
    /synthetic pending failure/,
  );
  database.exec('DROP TRIGGER synthetic_fail_pending_binding');
  assert.deepEqual({
    documents: database.prepare('SELECT COUNT(*) AS n FROM assessment_document').get().n,
    bindings: database.prepare('SELECT COUNT(*) AS n FROM assessment_binding').get().n,
    events: database.prepare('SELECT COUNT(*) AS n FROM assessment_event').get().n,
  }, countsBeforeFailedImport, 'intake + metadata + pending binding must roll back together');
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM assessment_document WHERE content_sha256 = ?").get('b'.repeat(64)).n, 0);

  hashCharacter = 'a';
  duplicateMode = true;
  const duplicate = await service.importSelected({ auditContext: actor, command: selection('REQ-PRODUCT-DUPLICATE-1') });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.requires_manual_resolution, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM assessment_document').get().n, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM assessment_event WHERE event_type='duplicate_seen'").get().n, 1);

  duplicateMode = false;
  hashCharacter = 'c';
  const rebindSource = await service.importSelected({
    auditContext: actor,
    command: selection('REQ-DUPLICATE-REBIND-SOURCE', 'C-SYNTHETIC-1', 1),
  });
  const rebindSourceActive = service.confirmBinding({
    auditContext: actor,
    command: {
      binding_id: rebindSource.binding_id,
      expected_version: rebindSource.binding_version,
      request_id: 'REQ-DUPLICATE-REBIND-SOURCE-CONFIRM',
      reason_code: 'manual_archive_confirmed',
      candidate_id: 'C-SYNTHETIC-1',
      job_id: 1,
    },
  });
  duplicateMode = true;
  const duplicateForOtherCandidate = await service.importSelected({
    auditContext: actor,
    command: selection('REQ-DUPLICATE-REBIND-TARGET', 'C-SYNTHETIC-2', 2),
  });
  assert.equal(duplicateForOtherCandidate.identity_name_mismatch, true);
  assert.equal(duplicateForOtherCandidate.report_subject_name, '合成候选人');
  assert.throws(() => service.resolveDuplicateBinding({
    auditContext: actor,
    command: {
      document_id: duplicateForOtherCandidate.document_id,
      candidate_id: 'C-SYNTHETIC-2',
      job_id: 2,
      request_id: 'REQ-DUPLICATE-REBIND-RESOLVE',
      confirmed: true,
    },
  }), (error) => error.code === 'IDENTITY_MISMATCH_CONFIRMATION_REQUIRED');
  const rebound = service.resolveDuplicateBinding({
    auditContext: actor,
    command: {
      document_id: duplicateForOtherCandidate.document_id,
      candidate_id: 'C-SYNTHETIC-2',
      job_id: 2,
      request_id: 'REQ-DUPLICATE-REBIND-RESOLVE',
      confirmed: true,
      identity_mismatch_acknowledged: true,
    },
  });
  assert.equal(rebound.state, 'active');
  assert.equal(rebound.candidate_id, 'C-SYNTHETIC-2');
  assert.equal(database.prepare('SELECT state FROM assessment_binding WHERE id = ?').get(rebindSourceActive.binding_id).state, 'revoked');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM assessment_binding WHERE document_id = ? AND state = ?')
    .get(duplicateForOtherCandidate.document_id, 'active').n, 1);

  duplicateMode = false;
  hashCharacter = 'd';
  const secondTargetReport = await service.importSelected({
    auditContext: actor,
    command: selection('REQ-SECOND-TARGET-REPORT', 'C-SYNTHETIC-2', 2),
  });
  const mismatchConfirmCommand = {
    binding_id: secondTargetReport.binding_id,
    expected_version: secondTargetReport.binding_version,
    request_id: 'REQ-SECOND-TARGET-REPORT-CONFIRM',
    reason_code: 'manual_archive_confirmed',
    candidate_id: 'C-SYNTHETIC-2',
    job_id: 2,
  };
  assert.throws(() => service.confirmBinding({ auditContext: actor, command: mismatchConfirmCommand }),
    (error) => error.code === 'IDENTITY_MISMATCH_CONFIRMATION_REQUIRED');
  const secondTargetActive = service.confirmBinding({
    auditContext: actor,
    command: { ...mismatchConfirmCommand, identity_mismatch_acknowledged: true },
  });
  assert.equal(secondTargetActive.state, 'active');
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM assessment_binding WHERE candidate_id = 'C-SYNTHETIC-2' AND state = 'active'").get().n, 2,
    'one candidate may have multiple different active assessment reports');
  assert.equal(database.prepare('SELECT reason_code FROM assessment_binding WHERE id = ?').get(secondTargetActive.binding_id).reason_code,
    'manual_identity_mismatch_confirmed');

  await assert.rejects(
    () => service.importSelected({ auditContext: actor, command: selection('REQ-WRONG-CONTEXT', 'C-SYNTHETIC-1', 2) }),
    (error) => error.code === 'CANDIDATE_JOB_MISMATCH',
  );
  assert.deepEqual(database.prepare('SELECT * FROM candidate ORDER BY internal_id').all(), candidateBefore,
    'Assessment administrative archive must not mutate SABC, quality or disposition');
  database.close();
  console.log('check-assessment-product-service ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
