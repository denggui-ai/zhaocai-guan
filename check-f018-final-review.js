'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { applyAssessmentSchemaMigration } = require('./assessment-schema');
const { applyF018SchemaMigration } = require('./f018-schema');
const {
  confirmFinalReview,
  createFinalReview,
  recordFinalDisposition,
  reopenFinalReview,
  updateFinalReview,
} = require('./f018-final-review-service');

const database = new Database(':memory:');
database.pragma('foreign_keys = ON');
database.exec(`
  CREATE TABLE job (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
  );
  CREATE TABLE candidate (
    internal_id TEXT PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES job(id),
    sabc TEXT,
    quality_score INTEGER,
    sort_input INTEGER,
    disposition_status TEXT,
    disposition_code TEXT,
    workflow_version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT
  );
  CREATE TABLE status_history (
    id INTEGER PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidate(internal_id),
    layer TEXT, from_status TEXT, to_status TEXT, source TEXT, who TEXT, reason TEXT,
    from_code TEXT, to_code TEXT, created_at TEXT
  );
  CREATE TABLE job_profile_version (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES job(id),
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    config_json TEXT
  );
  CREATE TABLE interview_session (
    id INTEGER PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidate(internal_id),
    job_id INTEGER NOT NULL REFERENCES job(id)
  );
  CREATE TABLE interview_report_v1 (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES interview_session(id),
    status TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    version INTEGER NOT NULL
  );

  INSERT INTO job (id, name) VALUES
    (1, '合成岗位一'), (2, '合成岗位二'), (3, '要求测评的合成岗位');
  INSERT INTO job_profile_version VALUES
    (1, 1, 1, 'confirmed', '${'a'.repeat(64)}', '{"assessment_policy":"not_required"}'),
    (2, 1, 2, 'draft', '${'b'.repeat(64)}', '{"assessment_policy":"not_required"}'),
    (3, 2, 1, 'confirmed', '${'c'.repeat(64)}', '{"assessment_policy":"not_required"}'),
    (4, 3, 1, 'confirmed', '${'d'.repeat(64)}', '{"assessment_policy":"required"}');
`);
applyAssessmentSchemaMigration(database);
applyF018SchemaMigration(database);

const actor = Object.freeze({
  actor_id: 'local-primary-operator',
  actor_type: 'local_os_subject',
  actor_source: 'server_local_instance',
  actor_session_id: 'synthetic-f018-session',
  assurance: 'local_instance_only',
});

let sequence = 0;

function seedContext(jobId = 1, options = {}) {
  sequence += 1;
  const candidateId = `C-F018-${sequence}`;
  const timestamp = `2026-07-12T12:${String(sequence).padStart(2, '0')}:00.000Z`;
  database.prepare(`
    INSERT INTO candidate (
      internal_id, job_id, sabc, quality_score, sort_input,
      disposition_status, disposition_code, workflow_version, updated_at
    ) VALUES (?, ?, 'A', 88, 701, '待处理', 'under_review', 4, ?)
  `).run(candidateId, jobId, timestamp);
  const appInfo = database.prepare(`
    INSERT INTO application_episode (
      candidate_id, job_id, episode_no, status, reopened_from_application_id,
      disposition_action, version, opened_by, ended_by, opened_at, ended_at,
      created_at, updated_at
    ) VALUES (?, ?, 1, 'active', NULL, NULL, 1, ?, NULL, ?, NULL, ?, ?)
  `).run(candidateId, jobId, actor.actor_id, timestamp, timestamp, timestamp);
  const applicationId = Number(appInfo.lastInsertRowid);
  const sessionInfo = database.prepare('INSERT INTO interview_session (candidate_id, job_id) VALUES (?, ?)')
    .run(candidateId, jobId);
  const reportInfo = database.prepare(`
    INSERT INTO interview_report_v1 (session_id, status, content_hash, version)
    VALUES (?, ?, ?, 3)
  `).run(
    sessionInfo.lastInsertRowid,
    options.reportStatus || 'confirmed',
    String(sequence % 10).repeat(64),
  );
  const context = {
    applicationId,
    candidateId,
    jobId,
    profileId: jobId === 1 ? 1 : jobId === 2 ? 3 : 4,
    reportId: Number(reportInfo.lastInsertRowid),
    assessmentDocumentIds: [],
  };
  if (options.withAssessment) {
    const documentId = `DOC-F018-${sequence}`;
    const contentHash = sequence.toString(16).padStart(64, '0').slice(-64);
    database.prepare(`
      INSERT INTO assessment_document (
        id, content_sha256, storage_relpath, byte_size, page_count, mime_detected,
        security_state, report_type, assessment_date,
        analysis_status, analysis_schema_version, analysis_json, analysis_error_code,
        review_state, dispute_state, lifecycle_state,
        retention_policy_version, delete_after, legal_hold_state,
        supersedes_document_id, created_by, version, created_at, updated_at, deleted_at
      ) VALUES (
        ?, ?, ?, 1024, 2, 'application/pdf',
        'accepted', 'career_potential', '2026-07-01',
        'ready', 'synthetic-v1', '{}', NULL,
        'ready', 'none', 'active',
        'synthetic-retention-v1', '2027-07-01T00:00:00.000Z', 'none',
        NULL, ?, 1, ?, ?, NULL
      )
    `).run(documentId, contentHash, `sha256/${contentHash}.pdf`, actor.actor_id, timestamp, timestamp);
    database.prepare(`
      INSERT INTO assessment_binding (
        id, document_id, candidate_id, job_id, scope, state, conflict_state,
        identity_basis, actor_id, reason_code, request_id, version,
        created_at, updated_at, revoked_at
      ) VALUES (?, ?, ?, ?, 'candidate_job_archive', 'active', 'none',
                'current_candidate_context', ?, 'synthetic_confirmed',
                ?, 1, ?, ?, NULL)
    `).run(
      `BIND-F018-${sequence}`,
      documentId,
      candidateId,
      jobId,
      actor.actor_id,
      `REQ-BIND-F018-${sequence}`,
      timestamp,
      timestamp,
    );
    context.assessmentDocumentIds.push(documentId);
  }
  return context;
}

function reviewJson(context, suffix = 'base', includeReport = true) {
  return {
    summary: `合成人工终评 ${suffix}`,
    evidence_refs: [
      { source_type: 'job_profile', source_id: context.profileId },
      ...(includeReport ? [{ source_type: 'interview_report', source_id: context.reportId }] : []),
      ...(context.assessmentDocumentIds || []).map((documentId) => ({
        source_type: 'assessment_document',
        source_id: documentId,
      })),
    ],
    open_questions: ['仅供人工复核'],
  };
}

function createCommand(context, requestId, overrides = {}) {
  const includeReport = overrides.interview_report_id !== null;
  return {
    application_id: context.applicationId,
    job_profile_version_id: context.profileId,
    interview_report_id: context.reportId,
    assessment_document_ids: context.assessmentDocumentIds || [],
    review_json: reviewJson(context, requestId, includeReport),
    expected_version: 0,
    request_id: requestId,
    ...overrides,
  };
}

function createConfirmedReview(context, prefix) {
  const draft = createFinalReview({
    database,
    auditContext: actor,
    command: createCommand(context, `${prefix}-create`),
  });
  return confirmFinalReview({
    database,
    auditContext: actor,
    command: {
      application_id: context.applicationId,
      final_review_id: draft.id,
      expected_version: draft.version,
      request_id: `${prefix}-confirm`,
      confirmed: true,
    },
  });
}

function expectCode(fn, code, statusCode) {
  assert.throws(fn, (error) => {
    if (!error || error.code !== code) return false;
    if (statusCode !== undefined) assert.equal(error.statusCode, statusCode);
    return true;
  }, `expected ${code}`);
}

const main = seedContext(1, { withAssessment: true });
const protectedBefore = database.prepare(`
  SELECT sabc, quality_score, sort_input, disposition_status, disposition_code, workflow_version
  FROM candidate WHERE internal_id = ?
`).get(main.candidateId);

expectCode(() => createFinalReview({
  database,
  auditContext: { ...actor, actor_id: 'renderer-forged-actor' },
  command: createCommand(main, 'REQ-F018-FORGED-ACTOR'),
}), 'AUDIT_CONTEXT_INVALID');

const foreignAssessmentContext = seedContext(2, { withAssessment: true });
expectCode(() => createFinalReview({
  database,
  auditContext: actor,
  command: createCommand(main, 'REQ-F018-ASSESSMENT', {
    assessment_document_ids: foreignAssessmentContext.assessmentDocumentIds,
    review_json: {
      summary: '跨候选人测评证据',
      evidence_refs: [
        { source_type: 'job_profile', source_id: main.profileId },
        { source_type: 'interview_report', source_id: main.reportId },
        { source_type: 'assessment_document', source_id: foreignAssessmentContext.assessmentDocumentIds[0] },
      ],
    },
  }),
}), 'ASSESSMENT_EVIDENCE_INVALID');
expectCode(() => createFinalReview({
  database,
  auditContext: actor,
  command: createCommand(main, 'REQ-F018-SCORE', { review_json: { overall_score: 99 } }),
}), 'FORBIDDEN_REVIEW_FIELD');
expectCode(() => createFinalReview({
  database,
  auditContext: actor,
  command: createCommand(main, 'REQ-F018-HIDDEN-TEXT', {
    review_json: {
      decision_summary: '测评得分 95%，压力角色不匹配，建议自动淘汰',
      evidence_refs: [
        { source_type: 'job_profile', source_id: main.profileId },
        { source_type: 'interview_report', source_id: main.reportId },
      ],
    },
  }),
}), 'FORBIDDEN_REVIEW_CONTENT');
expectCode(() => createFinalReview({
  database,
  auditContext: actor,
  command: createCommand(main, 'REQ-F018-HIDDEN-ASSESSMENT-SOURCE', {
    review_json: { summary: '合成评语', sources: [{ source_type: 'assessment', source_id: 99 }] },
  }),
}), 'REVIEW_EVIDENCE_TYPE_FORBIDDEN');
expectCode(() => createFinalReview({
  database,
  auditContext: actor,
  command: createCommand(main, 'REQ-F018-DRAFT-PROFILE', {
    job_profile_version_id: 2,
    review_json: {
      summary: '未确认岗位画像',
      evidence_refs: [
        { source_type: 'job_profile', source_id: 2 },
        { source_type: 'interview_report', source_id: main.reportId },
      ],
    },
  }),
}), 'CONFIRMED_JOB_PROFILE_REQUIRED');

const unconfirmedReportContext = seedContext(1, { reportStatus: 'draft' });
expectCode(() => createFinalReview({
  database,
  auditContext: actor,
  command: createCommand(unconfirmedReportContext, 'REQ-F018-DRAFT-REPORT'),
}), 'CONFIRMED_INTERVIEW_REPORT_REQUIRED');
const crossContext = seedContext(2);
expectCode(() => createFinalReview({
  database,
  auditContext: actor,
  command: createCommand(main, 'REQ-F018-CROSS-REPORT', {
    interview_report_id: crossContext.reportId,
    review_json: {
      summary: '跨应用证据',
      evidence_refs: [
        { source_type: 'job_profile', source_id: main.profileId },
        { source_type: 'interview_report', source_id: crossContext.reportId },
      ],
    },
  }),
}), 'INTERVIEW_REPORT_CONTEXT_MISMATCH');

const emptyContentContext = seedContext(1);
const emptyContentDraft = createFinalReview({
  database,
  auditContext: actor,
  command: createCommand(emptyContentContext, 'REQ-F018-EMPTY-CONTENT-CREATE', {
    review_json: {
      evidence_refs: [
        { source_type: 'job_profile', source_id: emptyContentContext.profileId },
        { source_type: 'interview_report', source_id: emptyContentContext.reportId },
      ],
    },
  }),
});
expectCode(() => confirmFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: emptyContentContext.applicationId,
    final_review_id: emptyContentDraft.id,
    expected_version: emptyContentDraft.version,
    request_id: 'REQ-F018-EMPTY-CONTENT-CONFIRM',
    confirmed: true,
  },
}), 'FINAL_REVIEW_CONTENT_REQUIRED');

const missingEvidenceContext = seedContext(1);
const missingEvidenceDraft = createFinalReview({
  database,
  auditContext: actor,
  command: createCommand(missingEvidenceContext, 'REQ-F018-MISSING-EVIDENCE-CREATE', {
    review_json: { summary: '合成人工终评，仅用于验证证据门禁' },
  }),
});
expectCode(() => confirmFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: missingEvidenceContext.applicationId,
    final_review_id: missingEvidenceDraft.id,
    expected_version: missingEvidenceDraft.version,
    request_id: 'REQ-F018-MISSING-EVIDENCE-CONFIRM',
    confirmed: true,
  },
}), 'REVIEW_EVIDENCE_REQUIRED');

const requiredAssessmentContext = seedContext(3);
const requiredAssessmentDraft = createFinalReview({
  database,
  auditContext: actor,
  command: createCommand(requiredAssessmentContext, 'REQ-F018-REQUIRED-ASSESSMENT-CREATE'),
});
expectCode(() => confirmFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: requiredAssessmentContext.applicationId,
    final_review_id: requiredAssessmentDraft.id,
    expected_version: requiredAssessmentDraft.version,
    request_id: 'REQ-F018-REQUIRED-ASSESSMENT-CONFIRM',
    confirmed: true,
  },
}), 'ASSESSMENT_EVIDENCE_REQUIRED');
const requiredAssessmentReadyContext = seedContext(3, { withAssessment: true });
const requiredAssessmentConfirmed = createConfirmedReview(
  requiredAssessmentReadyContext,
  'REQ-F018-REQUIRED-ASSESSMENT-READY',
);
assert.equal(requiredAssessmentConfirmed.status, 'confirmed');

const draft = createFinalReview({
  database,
  auditContext: actor,
  command: createCommand(main, 'REQ-F018-CREATE', {
    interview_report_id: null,
    review_json: reviewJson(main, 'draft-without-report', false),
    actor: 'renderer-forged-actor',
  }),
});
assert.equal(typeof draft.id, 'number');
assert.equal(draft.status, 'draft');
assert.equal(draft.version, 1);
assert.equal(draft.created_by, actor.actor_id);
const createReplay = createFinalReview({
  database,
  auditContext: actor,
  command: createCommand(main, 'REQ-F018-CREATE', {
    interview_report_id: null,
    review_json: reviewJson(main, 'draft-without-report', false),
  }),
});
assert.equal(createReplay.id, draft.id);
assert.equal(createReplay.idempotent_replay, true);
expectCode(() => createFinalReview({
  database,
  auditContext: actor,
  command: createCommand(main, 'REQ-F018-CREATE', {
    interview_report_id: null,
    review_json: reviewJson(main, 'different-payload', false),
  }),
}), 'IDEMPOTENCY_CONFLICT');
expectCode(() => confirmFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: main.applicationId,
    final_review_id: draft.id,
    expected_version: draft.version,
    request_id: 'REQ-F018-CONFIRM-WITHOUT-REPORT',
    confirmed: true,
  },
}), 'CONFIRMED_INTERVIEW_REPORT_REQUIRED');

const updated = updateFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: main.applicationId,
    final_review_id: draft.id,
    job_profile_version_id: main.profileId,
    interview_report_id: main.reportId,
    review_json: reviewJson(main, 'with-confirmed-report'),
    expected_version: draft.version,
    request_id: 'REQ-F018-UPDATE',
  },
});
assert.equal(updated.version, 2);
assert.equal(updated.interview_report_id, main.reportId);
assert.equal(updateFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: main.applicationId,
    final_review_id: draft.id,
    job_profile_version_id: main.profileId,
    interview_report_id: main.reportId,
    review_json: reviewJson(main, 'with-confirmed-report'),
    expected_version: draft.version,
    request_id: 'REQ-F018-UPDATE',
  },
}).idempotent_replay, true);
expectCode(() => confirmFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: main.applicationId,
    final_review_id: draft.id,
    expected_version: updated.version,
    request_id: 'REQ-F018-NOT-EXPLICIT',
    confirmed: false,
  },
}), 'EXPLICIT_CONFIRM_REQUIRED');
const confirmed = confirmFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: main.applicationId,
    final_review_id: draft.id,
    expected_version: updated.version,
    request_id: 'REQ-F018-CONFIRM',
    confirmed: true,
  },
});
assert.equal(confirmed.status, 'confirmed');
assert.equal(confirmed.version, 3);
assert.equal(confirmed.interview_report_ref_id, main.reportId);
assert.equal(
  confirmed.interview_report_content_hash,
  database.prepare('SELECT content_hash FROM interview_report_v1 WHERE id = ?').get(main.reportId).content_hash,
);
assert.equal(confirmed.interview_report_version, 3);
assert.equal(confirmFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: main.applicationId,
    final_review_id: draft.id,
    expected_version: updated.version,
    request_id: 'REQ-F018-CONFIRM',
    confirmed: true,
  },
}).idempotent_replay, true);
expectCode(() => updateFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: main.applicationId,
    final_review_id: confirmed.id,
    review_json: reviewJson(main, 'overwrite-confirmed'),
    expected_version: confirmed.version,
    request_id: 'REQ-F018-OVERWRITE-CONFIRMED',
  },
}), 'FINAL_REVIEW_IMMUTABLE');
assert.deepEqual(database.prepare(`
  SELECT sabc, quality_score, sort_input, disposition_status, disposition_code, workflow_version
  FROM candidate WHERE internal_id = ?
`).get(main.candidateId), protectedBefore, 'review actions must not mutate candidate projection');

const reopened = reopenFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: main.applicationId,
    final_review_id: confirmed.id,
    expected_version: confirmed.version,
    request_id: 'REQ-F018-REOPEN',
    reason_code: 'material_change',
    reopened: true,
  },
});
assert.equal(reopened.status, 'reopened');
assert.equal(reopened.version, 1);
assert.equal(reopened.reopened_from_final_review_id, confirmed.id);
assert.equal(reopened.content_hash, confirmed.content_hash);
assert.deepEqual(database.prepare(`
  SELECT status, version, superseded_by_final_review_id FROM final_review WHERE id = ?
`).get(confirmed.id), {
  status: 'superseded',
  version: confirmed.version + 1,
  superseded_by_final_review_id: reopened.id,
});
assert.throws(() => database.prepare(`
  UPDATE final_review
  SET review_json = '{"tampered":true}', content_hash = ?, version = version + 1
  WHERE id = ?
`).run('9'.repeat(64), confirmed.id), /superseded final review is immutable/);
assert.equal(reopenFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: main.applicationId,
    final_review_id: confirmed.id,
    expected_version: confirmed.version,
    request_id: 'REQ-F018-REOPEN',
    reason_code: 'material_change',
    reopened: true,
  },
}).idempotent_replay, true);

const atomicContext = seedContext();
const atomicConfirmed = createConfirmedReview(atomicContext, 'REQ-F018-ATOMIC-REOPEN');
database.exec(`
  CREATE TRIGGER synthetic_fail_reopened_review
  BEFORE INSERT ON final_review WHEN NEW.status = 'reopened'
  BEGIN SELECT RAISE(ABORT, 'synthetic reopen failure'); END;
`);
assert.throws(() => reopenFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: atomicContext.applicationId,
    final_review_id: atomicConfirmed.id,
    expected_version: atomicConfirmed.version,
    request_id: 'REQ-F018-ATOMIC-REOPEN-FAIL',
    reason_code: 'synthetic_failure',
    reopened: true,
  },
}), /synthetic reopen failure/);
database.exec('DROP TRIGGER synthetic_fail_reopened_review');
assert.deepEqual(database.prepare('SELECT status, version FROM final_review WHERE id = ?').get(atomicConfirmed.id), {
  status: 'confirmed', version: atomicConfirmed.version,
});
assert.throws(() => database.prepare(`
  UPDATE final_review
  SET review_json = '{"tampered":true}', content_hash = ?, version = version + 1
  WHERE id = ?
`).run('8'.repeat(64), atomicConfirmed.id), /confirmed final review content and context are immutable/);
assert.throws(() => database.prepare('DELETE FROM final_review WHERE id = ?').run(atomicConfirmed.id), /final reviews are append-only/);
assert.equal(database.prepare("SELECT COUNT(*) AS n FROM application_event WHERE request_id = 'REQ-F018-ATOMIC-REOPEN-FAIL'").get().n, 0);

const reconfirmed = confirmFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: main.applicationId,
    final_review_id: reopened.id,
    expected_version: reopened.version,
    request_id: 'REQ-F018-RECONFIRM',
    confirmed: true,
  },
});
expectCode(() => recordFinalDisposition({
  database,
  auditContext: actor,
  command: {
    application_id: main.applicationId,
    final_review_id: reconfirmed.id,
    action: 'hired',
    reason_code: 'forbidden_hired',
    expected_version: 1,
    request_id: 'REQ-F018-HIRED',
    confirmed: true,
  },
}), 'HIRED_FORBIDDEN');
expectCode(() => recordFinalDisposition({
  database,
  auditContext: actor,
  command: {
    application_id: main.applicationId,
    final_review_id: reconfirmed.id,
    action: 'reject',
    reason_code: 'manual_final_review',
    expected_version: 1,
    request_id: 'REQ-F018-DISPOSITION-NOT-EXPLICIT',
    confirmed: false,
  },
}), 'EXPLICIT_CONFIRM_REQUIRED');

database.exec(`
  CREATE TRIGGER synthetic_fail_f018_status_history
  BEFORE INSERT ON status_history
  BEGIN SELECT RAISE(ABORT, 'synthetic status history failure'); END;
`);
const dispositionCountsBefore = {
  disposition: database.prepare('SELECT COUNT(*) AS n FROM final_disposition').get().n,
  event: database.prepare('SELECT COUNT(*) AS n FROM application_event').get().n,
};
assert.throws(() => recordFinalDisposition({
  database,
  auditContext: actor,
  command: {
    application_id: main.applicationId,
    final_review_id: reconfirmed.id,
    action: 'reject',
    reason_code: 'manual_final_review',
    expected_version: 1,
    request_id: 'REQ-F018-DISPOSITION-ROLLBACK',
    confirmed: true,
  },
}), /synthetic status history failure/);
database.exec('DROP TRIGGER synthetic_fail_f018_status_history');
assert.deepEqual({
  disposition: database.prepare('SELECT COUNT(*) AS n FROM final_disposition').get().n,
  event: database.prepare('SELECT COUNT(*) AS n FROM application_event').get().n,
}, dispositionCountsBefore);
assert.deepEqual(database.prepare('SELECT status, version, disposition_action, ended_by, ended_at FROM application_episode WHERE id = ?').get(main.applicationId), {
  status: 'active', version: 1, disposition_action: null, ended_by: null, ended_at: null,
});
assert.deepEqual(database.prepare('SELECT disposition_code, workflow_version FROM candidate WHERE internal_id = ?').get(main.candidateId), {
  disposition_code: protectedBefore.disposition_code,
  workflow_version: protectedBefore.workflow_version,
});

const disposition = recordFinalDisposition({
  database,
  auditContext: actor,
  command: {
    application_id: main.applicationId,
    final_review_id: reconfirmed.id,
    action: 'reject',
    reason_code: 'manual_final_review',
    expected_version: 1,
    request_id: 'REQ-F018-DISPOSITION',
    confirmed: true,
  },
});
assert.equal(disposition.action, 'reject');
assert.equal(recordFinalDisposition({
  database,
  auditContext: actor,
  command: {
    application_id: main.applicationId,
    final_review_id: reconfirmed.id,
    action: 'reject',
    reason_code: 'manual_final_review',
    expected_version: 1,
    request_id: 'REQ-F018-DISPOSITION',
    confirmed: true,
  },
}).idempotent_replay, true);
expectCode(() => recordFinalDisposition({
  database,
  auditContext: actor,
  command: {
    application_id: main.applicationId,
    final_review_id: reconfirmed.id,
    action: 'talent_pool',
    reason_code: 'manual_final_review',
    expected_version: 1,
    request_id: 'REQ-F018-DISPOSITION',
    confirmed: true,
  },
}), 'IDEMPOTENCY_CONFLICT');
const rejectedApplication = database.prepare(`
  SELECT disposition_action, status, version, ended_by, ended_at
  FROM application_episode WHERE id = ?
`).get(main.applicationId);
assert.equal(rejectedApplication.disposition_action, 'reject');
assert.equal(rejectedApplication.status, 'closed');
assert.equal(rejectedApplication.version, 2);
assert.equal(rejectedApplication.ended_by, actor.actor_id);
assert.ok(rejectedApplication.ended_at);
assert.throws(() => database.prepare(`
  UPDATE application_episode
  SET status = 'active', ended_by = NULL, ended_at = NULL, version = version + 1
  WHERE id = ?
`).run(main.applicationId), /terminal application episode is immutable/);
assert.deepEqual(database.prepare('SELECT disposition_status, disposition_code, workflow_version, sabc, quality_score, sort_input FROM candidate WHERE internal_id = ?').get(main.candidateId), {
  disposition_status: '淘汰',
  disposition_code: 'rejected',
  workflow_version: protectedBefore.workflow_version + 1,
  sabc: protectedBefore.sabc,
  quality_score: protectedBefore.quality_score,
  sort_input: protectedBefore.sort_input,
});
assert.deepEqual(database.prepare(`
  SELECT layer, source, who, reason, from_code, to_code
  FROM status_history WHERE candidate_id = ? ORDER BY id DESC LIMIT 1
`).get(main.candidateId), {
  layer: 'disposition',
  source: 'f018_final_disposition',
  who: actor.actor_id,
  reason: 'manual_final_review',
  from_code: 'under_review',
  to_code: 'rejected',
});

for (const [action, expectedCode] of [
  ['continue_process', 'under_review'],
  ['hold', 'under_review'],
  ['talent_pool', 'talent_pool'],
]) {
  const context = seedContext();
  const review = createConfirmedReview(context, `REQ-F018-${action.toUpperCase()}`);
  const result = recordFinalDisposition({
    database,
    auditContext: actor,
    command: {
      application_id: context.applicationId,
      final_review_id: review.id,
      action,
      reason_code: `manual_${action}`,
      expected_version: 1,
      request_id: `REQ-F018-${action.toUpperCase()}-DISPOSITION`,
      confirmed: true,
    },
  });
  assert.equal(result.action, action);
  assert.equal(database.prepare('SELECT disposition_code FROM candidate WHERE internal_id = ?').get(context.candidateId).disposition_code, expectedCode);
  const application = database.prepare('SELECT status, disposition_action, version, ended_by, ended_at FROM application_episode WHERE id = ?')
    .get(context.applicationId);
  assert.equal(application.disposition_action, action);
  assert.equal(application.version, 2);
  assert.equal(application.status, action === 'talent_pool' ? 'closed' : 'active');
  assert.equal(Boolean(application.ended_at), action === 'talent_pool');
  assert.equal(application.ended_by, action === 'talent_pool' ? actor.actor_id : null);
  if (action === 'hold') {
    expectCode(() => reopenFinalReview({
      database,
      auditContext: actor,
      command: {
        application_id: context.applicationId,
        final_review_id: review.id,
        expected_version: review.version,
        request_id: 'REQ-F018-HOLD-REOPEN-AFTER-DISPOSITION',
        reason_code: 'post_disposition_reopen',
        reopened: true,
      },
    }), 'DISPOSITION_REVERSAL_NOT_IMPLEMENTED');
  }
}

const closedJobContext = seedContext();
database.prepare("UPDATE job SET status = 'closed' WHERE id = ?").run(closedJobContext.jobId);
const closedCreateBefore = {
  reviews: database.prepare('SELECT COUNT(*) AS n FROM final_review').get().n,
  events: database.prepare('SELECT COUNT(*) AS n FROM application_event').get().n,
};
expectCode(() => createFinalReview({
  database,
  auditContext: actor,
  command: createCommand(closedJobContext, 'REQ-F018-CLOSED-CREATE'),
}), 'JOB_CLOSED', 409);
assert.deepEqual({
  reviews: database.prepare('SELECT COUNT(*) AS n FROM final_review').get().n,
  events: database.prepare('SELECT COUNT(*) AS n FROM application_event').get().n,
}, closedCreateBefore, 'closed-job review creation must fail before any write');

database.prepare("UPDATE job SET status = 'open' WHERE id = ?").run(closedJobContext.jobId);
const closedDraft = createFinalReview({
  database,
  auditContext: actor,
  command: createCommand(closedJobContext, 'REQ-F018-CLOSED-DRAFT-SETUP'),
});
database.prepare("UPDATE job SET status = 'closed' WHERE id = ?").run(closedJobContext.jobId);
const closedDraftSnapshot = database.prepare('SELECT * FROM final_review WHERE id = ?').get(closedDraft.id);
const closedDraftEventCount = database.prepare('SELECT COUNT(*) AS n FROM application_event').get().n;
expectCode(() => updateFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: closedJobContext.applicationId,
    final_review_id: closedDraft.id,
    job_profile_version_id: closedJobContext.profileId,
    interview_report_id: closedJobContext.reportId,
    review_json: reviewJson(closedJobContext, 'closed-update'),
    expected_version: closedDraft.version,
    request_id: 'REQ-F018-CLOSED-UPDATE',
  },
}), 'JOB_CLOSED', 409);
expectCode(() => confirmFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: closedJobContext.applicationId,
    final_review_id: closedDraft.id,
    expected_version: closedDraft.version,
    request_id: 'REQ-F018-CLOSED-CONFIRM',
    confirmed: true,
  },
}), 'JOB_CLOSED', 409);
assert.deepEqual(database.prepare('SELECT * FROM final_review WHERE id = ?').get(closedDraft.id), closedDraftSnapshot,
  'closed-job update and confirm must not mutate the review');
assert.equal(database.prepare('SELECT COUNT(*) AS n FROM application_event').get().n, closedDraftEventCount,
  'closed-job update and confirm must not append events');

database.prepare("UPDATE job SET status = 'open' WHERE id = ?").run(closedJobContext.jobId);
const writableAgain = updateFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: closedJobContext.applicationId,
    final_review_id: closedDraft.id,
    job_profile_version_id: closedJobContext.profileId,
    interview_report_id: closedJobContext.reportId,
    review_json: reviewJson(closedJobContext, 'reopened-job-update'),
    expected_version: closedDraft.version,
    request_id: 'REQ-F018-REOPENED-JOB-UPDATE',
  },
});
const closedConfirmed = confirmFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: closedJobContext.applicationId,
    final_review_id: writableAgain.id,
    expected_version: writableAgain.version,
    request_id: 'REQ-F018-REOPENED-JOB-CONFIRM',
    confirmed: true,
  },
});
database.prepare("UPDATE job SET status = 'closed' WHERE id = ?").run(closedJobContext.jobId);
const closedConfirmedSnapshot = database.prepare('SELECT * FROM final_review WHERE id = ?').get(closedConfirmed.id);
const closedApplicationSnapshot = database.prepare('SELECT * FROM application_episode WHERE id = ?')
  .get(closedJobContext.applicationId);
const closedDispositionCounts = {
  reviews: database.prepare('SELECT COUNT(*) AS n FROM final_review').get().n,
  dispositions: database.prepare('SELECT COUNT(*) AS n FROM final_disposition').get().n,
  events: database.prepare('SELECT COUNT(*) AS n FROM application_event').get().n,
};
assert.equal(confirmFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: closedJobContext.applicationId,
    final_review_id: writableAgain.id,
    expected_version: writableAgain.version,
    request_id: 'REQ-F018-REOPENED-JOB-CONFIRM',
    confirmed: true,
  },
}).idempotent_replay, true, 'a committed review replay remains readable after job close');
assert.deepEqual({
  reviews: database.prepare('SELECT COUNT(*) AS n FROM final_review').get().n,
  dispositions: database.prepare('SELECT COUNT(*) AS n FROM final_disposition').get().n,
  events: database.prepare('SELECT COUNT(*) AS n FROM application_event').get().n,
}, closedDispositionCounts, 'closed-job review replay must be zero-write');
expectCode(() => reopenFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: closedJobContext.applicationId,
    final_review_id: closedConfirmed.id,
    expected_version: closedConfirmed.version,
    request_id: 'REQ-F018-CLOSED-REOPEN-REVIEW',
    reason_code: 'closed_job_must_not_reopen_review',
    reopened: true,
  },
}), 'JOB_CLOSED', 409);
for (const action of ['continue_process', 'hold', 'reject', 'talent_pool']) {
  expectCode(() => recordFinalDisposition({
    database,
    auditContext: actor,
    command: {
      application_id: closedJobContext.applicationId,
      final_review_id: closedConfirmed.id,
      action,
      reason_code: `closed_job_must_not_${action}`,
      expected_version: 1,
      request_id: `REQ-F018-CLOSED-${action.toUpperCase()}`,
      confirmed: true,
    },
  }), 'JOB_CLOSED', 409);
}
assert.deepEqual(database.prepare('SELECT * FROM final_review WHERE id = ?').get(closedConfirmed.id),
  closedConfirmedSnapshot, 'closed-job review reopen must not mutate either review generation');
assert.deepEqual(database.prepare('SELECT * FROM application_episode WHERE id = ?')
  .get(closedJobContext.applicationId), closedApplicationSnapshot,
  'closed-job disposition actions must not mutate the application');
assert.deepEqual({
  reviews: database.prepare('SELECT COUNT(*) AS n FROM final_review').get().n,
  dispositions: database.prepare('SELECT COUNT(*) AS n FROM final_disposition').get().n,
  events: database.prepare('SELECT COUNT(*) AS n FROM application_event').get().n,
}, closedDispositionCounts, 'closed-job review reopen and dispositions must fail before any write');

database.prepare("UPDATE job SET status = 'open' WHERE id = ?").run(closedJobContext.jobId);
const reopenedAfterJobReopen = reopenFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: closedJobContext.applicationId,
    final_review_id: closedConfirmed.id,
    expected_version: closedConfirmed.version,
    request_id: 'REQ-F018-REOPENED-JOB-REOPEN-REVIEW',
    reason_code: 'job_reopened_manual_review',
    reopened: true,
  },
});
const reconfirmedAfterJobReopen = confirmFinalReview({
  database,
  auditContext: actor,
  command: {
    application_id: closedJobContext.applicationId,
    final_review_id: reopenedAfterJobReopen.id,
    expected_version: reopenedAfterJobReopen.version,
    request_id: 'REQ-F018-REOPENED-JOB-RECONFIRM',
    confirmed: true,
  },
});
const reopenedJobDisposition = recordFinalDisposition({
  database,
  auditContext: actor,
  command: {
    application_id: closedJobContext.applicationId,
    final_review_id: reconfirmedAfterJobReopen.id,
    action: 'reject',
    reason_code: 'reopened_job_reject',
    expected_version: 1,
    request_id: 'REQ-F018-REOPENED-JOB-REJECT',
    confirmed: true,
  },
});
assert.equal(reopenedJobDisposition.action, 'reject', 'reopening the job restores final disposition');
assert.deepEqual(database.prepare('SELECT status, disposition_action FROM application_episode WHERE id = ?')
  .get(closedJobContext.applicationId), { status: 'closed', disposition_action: 'reject' });

const hiredContext = seedContext();
const hiredReview = createConfirmedReview(hiredContext, 'REQ-F018-EXISTING-HIRED');
database.prepare("UPDATE candidate SET disposition_status = '已入职', disposition_code = NULL WHERE internal_id = ?")
  .run(hiredContext.candidateId);
expectCode(() => recordFinalDisposition({
  database,
  auditContext: actor,
  command: {
    application_id: hiredContext.applicationId,
    final_review_id: hiredReview.id,
    action: 'reject',
    reason_code: 'must_not_override_hired',
    expected_version: 1,
    request_id: 'REQ-F018-EXISTING-HIRED-DISPOSITION',
    confirmed: true,
  },
}), 'HIRED_FORBIDDEN');
assert.equal(database.prepare('SELECT COUNT(*) AS n FROM final_disposition WHERE application_id = ?').get(hiredContext.applicationId).n, 0);

const hiredReviewWriteContext = seedContext();
database.prepare("UPDATE candidate SET disposition_status = '已入职', disposition_code = 'hired' WHERE internal_id = ?")
  .run(hiredReviewWriteContext.candidateId);
const hiredReviewWriteBefore = {
  candidate: database.prepare('SELECT * FROM candidate WHERE internal_id = ?').get(hiredReviewWriteContext.candidateId),
  reviews: database.prepare('SELECT COUNT(*) AS n FROM final_review').get().n,
  events: database.prepare('SELECT COUNT(*) AS n FROM application_event').get().n,
};
expectCode(() => createFinalReview({
  database,
  auditContext: actor,
  command: createCommand(hiredReviewWriteContext, 'REQ-F018-HIRED-REVIEW-CREATE'),
}), 'HIRED_FORBIDDEN');
assert.deepEqual(database.prepare('SELECT * FROM candidate WHERE internal_id = ?').get(hiredReviewWriteContext.candidateId),
  hiredReviewWriteBefore.candidate, 'hired review guard must not rewrite the candidate');
assert.deepEqual({
  reviews: database.prepare('SELECT COUNT(*) AS n FROM final_review').get().n,
  events: database.prepare('SELECT COUNT(*) AS n FROM application_event').get().n,
}, {
  reviews: hiredReviewWriteBefore.reviews,
  events: hiredReviewWriteBefore.events,
}, 'hired review guard must fail before any review or event write');

const retentionContext = seedContext();
const retentionReview = createConfirmedReview(retentionContext, 'REQ-F018-RETENTION');
const retainedSnapshot = database.prepare(`
  SELECT interview_report_id, interview_report_ref_id,
         interview_report_content_hash, interview_report_version,
         review_json, content_hash, version, status
  FROM final_review WHERE id = ?
`).get(retentionReview.id);
assert.equal(retainedSnapshot.interview_report_id, retentionContext.reportId);
database.prepare('DELETE FROM interview_report_v1 WHERE id = ?').run(retentionContext.reportId);
assert.deepEqual(database.prepare(`
  SELECT interview_report_id, interview_report_ref_id,
         interview_report_content_hash, interview_report_version,
         review_json, content_hash, version, status
  FROM final_review WHERE id = ?
`).get(retentionReview.id), {
  ...retainedSnapshot,
  interview_report_id: null,
}, 'F010 report deletion must clear only the live FK and preserve the immutable report snapshot');

const source = fs.readFileSync(path.join(__dirname, 'f018-final-review-service.js'), 'utf8');
assert.match(source, /'assessment_document'/, 'confirmed assessment documents must be allowed as evidence');
assert.doesNotMatch(source, /UPDATE\s+assessment_|DELETE\s+FROM\s+assessment_|quality_score\s*=|sabc\s*=/i);
assert.equal(database.prepare("SELECT COUNT(*) AS n FROM application_event WHERE event_type = 'review_confirmed'").get().n >= 1, true);
assert.equal(database.prepare("SELECT COUNT(*) AS n FROM application_event WHERE event_type = 'disposition_recorded'").get().n, 5);

database.close();
console.log('check-f018-final-review ok');
