const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const { extractMinuteToken } = require('./minutes-fetch');
const { applyF007InterviewAdapterMigration } = require('./f007-interview-adapter-migration');

const PURPOSES = new Set(['candidate_interview', 'hiring_manager_profile_interview']);
const AUDIT_REASON_CODES = new Set([
  'explicit_candidate_context',
  'manual_candidate_classification',
  'manual_profile_classification',
  'manual_assignment',
  'manual_correction',
]);

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function payloadHash(value) {
  return value === undefined || value === null ? null : sha256(String(value));
}

function sourceKeyForLarkUrl(sourceUrl) {
  const token = extractMinuteToken(sourceUrl);
  if (!token) throw new Error('invalid lark minutes source URL');
  return `lark_minutes:${sha256(token)}`;
}

function sourceKeyForOfflineSummary(summaryPath) {
  const raw = text(summaryPath);
  if (!raw) throw new Error('summaryPath is required');
  const resolved = path.resolve(raw);
  return `offline_recording:${sha256(resolved)}`;
}

function requiredActor(value, label = 'actor') {
  const actor = text(value);
  if (!actor) throw new Error(`${label} is required`);
  if (!/^[A-Za-z0-9._:@-]{1,80}$/.test(actor)) throw new Error(`${label} must be a stable non-name identifier`);
  return actor;
}

function requiredReason(value) {
  const reason = text(value);
  if (!reason) throw new Error('reason is required');
  if (!AUDIT_REASON_CODES.has(reason)) throw new Error(`unsupported audit reason: ${reason}`);
  return reason;
}

function requiredRequestId(value) {
  const requestId = text(value);
  if (!requestId) throw new Error('requestId is required');
  return requestId;
}

function requiredVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version <= 0) throw new Error('expectedVersion must be a positive integer');
  return version;
}

function explicitContext(input = {}) {
  const candidateId = text(input.candidate_id === undefined ? input.candidateId : input.candidate_id);
  const rawJobId = input.job_id === undefined ? input.jobId : input.job_id;
  const rawRound = input.round;
  const jobId = Number(rawJobId);
  const round = Number(rawRound);
  const complete = !!candidateId
    && Number.isInteger(jobId) && jobId > 0
    && Number.isInteger(round) && round > 0;
  return { complete, candidateId, jobId, round };
}

function ensureSchema(database) {
  // Global operational-readonly projections must never repair or backfill the
  // database as a side effect of a GET. The db.js read helpers perform their
  // own readonly schema assertions; direct queries below fail closed if their
  // required table is absent.
  if (database && database.readonly === true) return;
  db.applyF006InterviewSessionMigration(database);
  applyF007InterviewAdapterMigration(database);
  db.applyF006InterviewSessionMigration(database);
}

function pendingById(database, id) {
  return database.prepare('SELECT * FROM interview_pending_assignment WHERE id = ?').get(Number(id));
}

function pendingBySourceKey(database, sourceType, sourceKey) {
  return database.prepare(`
    SELECT * FROM interview_pending_assignment
    WHERE source_type = ? AND source_key = ?
  `).get(sourceType, sourceKey);
}

function duplicateSuspect(database, sourceType, hash, pendingId = null) {
  if (!hash) return null;
  return database.prepare(`
    SELECT id, source_type, source_key
    FROM interview_pending_assignment
    WHERE source_type = @source_type
      AND payload_hash = @payload_hash
      AND (@id IS NULL OR id <> @id)
    ORDER BY id
    LIMIT 1
  `).get({ source_type: sourceType, payload_hash: hash, id: pendingId }) || null;
}

function existingSessionForContext(context, mode) {
  const existing = db.listInterviewSessions({
    candidateId: context.candidateId,
    jobId: context.jobId,
    round: context.round,
  })[0] || null;
  if (existing) {
    db.assertInterviewSessionProcessingAllowedById(existing.id);
    if (existing.mode !== mode) throw new Error(`interview session round already uses mode=${existing.mode}`);
    return existing;
  }
  return db.createInterviewSession({
    candidateId: context.candidateId,
    jobId: context.jobId,
    round: context.round,
    mode,
    status: 'draft',
  });
}

function insertActionAudit(database, input) {
  database.prepare(`
    INSERT INTO interview_pending_assignment_classification_audit (
      pending_assignment_id, action_type,
      before_purpose, before_status, before_assigned_session_id, before_version,
      after_purpose, after_status, after_assigned_session_id, after_version,
      actor, reason, request_id, classified_at, created_at
    ) VALUES (
      @pending_assignment_id, @action_type,
      @before_purpose, @before_status, @before_assigned_session_id, @before_version,
      @after_purpose, @after_status, @after_assigned_session_id, @after_version,
      @actor, @reason, @request_id, @classified_at, @created_at
    )
  `).run(input);
}

function auditByRequest(database, pendingId, requestId) {
  return database.prepare(`
    SELECT * FROM interview_pending_assignment_classification_audit
    WHERE pending_assignment_id = ? AND request_id = ?
  `).get(pendingId, requestId);
}

function ensureMaterialLink(database, pending, sessionId, actor, timestamp) {
  // This is the adapter's final material-write boundary. Recheck lifecycle
  // authority inside the caller's transaction so a closed/withdrawn Session
  // cannot receive a recording, material link, assignment update or audit.
  db.assertInterviewSessionProcessingAllowedById(sessionId);
  const idColumn = pending.source_type === 'lark_minutes' ? 'job_interview_id' : 'interview_recording_id';
  const sourceId = pending[idColumn];
  const materialKind = pending.source_type === 'lark_minutes' ? 'online_minutes' : 'offline_recording';
  const existing = database.prepare(`SELECT * FROM interview_session_material WHERE ${idColumn} = ?`).get(sourceId);
  if (existing) {
    if (Number(existing.session_id) !== Number(sessionId)) {
      database.prepare(`UPDATE interview_session_material SET session_id = ?, linked_by = ?, linked_at = ? WHERE id = ?`)
        .run(sessionId, actor, timestamp, existing.id);
    }
    return database.prepare('SELECT * FROM interview_session_material WHERE id = ?').get(existing.id);
  }
  database.prepare(`
    INSERT INTO interview_session_material (
      session_id, material_kind, job_interview_id, interview_recording_id, linked_by, linked_at
    ) VALUES (@session_id, @material_kind, @job_interview_id, @interview_recording_id, @linked_by, @linked_at)
  `).run({
    session_id: sessionId,
    material_kind: materialKind,
    job_interview_id: pending.job_interview_id,
    interview_recording_id: pending.interview_recording_id,
    linked_by: actor,
    linked_at: timestamp,
  });
  return database.prepare(`SELECT * FROM interview_session_material WHERE ${idColumn} = ?`).get(sourceId);
}

function directAssign(database, pending, context, actor, reason, requestId) {
  const mode = pending.source_type === 'lark_minutes' ? 'online' : 'offline';
  const session = existingSessionForContext(context, mode);
  const timestamp = new Date().toISOString();
  const afterVersion = Number(pending.version) + 1;
  insertActionAudit(database, {
    pending_assignment_id: pending.id,
    action_type: 'explicit_context',
    before_purpose: pending.purpose,
    before_status: pending.status,
    before_assigned_session_id: pending.assigned_session_id,
    before_version: pending.version,
    after_purpose: 'candidate_interview',
    after_status: 'assigned',
    after_assigned_session_id: session.id,
    after_version: afterVersion,
    actor,
    reason,
    request_id: requestId,
    classified_at: timestamp,
    created_at: timestamp,
  });
  if (pending.source_type === 'offline_recording') {
    db.bindInterviewRecording({
      id: pending.interview_recording_id,
      candidateId: context.candidateId,
      jobId: context.jobId,
    });
  }
  ensureMaterialLink(database, pending, session.id, actor, timestamp);
  database.prepare(`
    UPDATE interview_pending_assignment
    SET job_id = ?, purpose = 'candidate_interview', status = 'assigned', reason = 'missing_candidate',
        assigned_session_id = ?, assigned_by = ?, assigned_at = ?, version = ?, updated_at = ?
    WHERE id = ?
  `).run(context.jobId, session.id, actor, timestamp, afterVersion, timestamp, pending.id);
  return { pending: pendingById(database, pending.id), session: db.getInterviewSession(session.id) };
}

function publicIngestResult(database, pending, created, session = null) {
  const duplicate = duplicateSuspect(database, pending.source_type, pending.payload_hash, pending.id);
  return {
    created,
    idempotent_replay: !created,
    duplicate_suspect: duplicate ? { pending_assignment_id: duplicate.id } : null,
    assignment: pending,
    session: session || (pending.assigned_session_id ? db.getInterviewSession(pending.assigned_session_id) : null),
  };
}

function ingestOnlineMinutes(input = {}) {
  const database = db.conn();
  ensureSchema(database);
  const jobId = Number(input.job_id === undefined ? input.jobId : input.job_id);
  if (!Number.isInteger(jobId) || jobId <= 0) throw new Error('jobId is required');
  db.assertJobRecruitingWritableById(jobId);
  const sourceUrl = text(input.source_url === undefined ? input.sourceUrl : input.source_url);
  const transcript = input.transcript === undefined || input.transcript === null ? '' : String(input.transcript);
  if (!transcript.trim()) throw new Error('transcript is required');
  const sourceKey = text(input.source_key === undefined ? input.sourceKey : input.source_key) || sourceKeyForLarkUrl(sourceUrl);
  const hash = text(input.payload_hash === undefined ? input.payloadHash : input.payload_hash) || payloadHash(transcript);
  const context = explicitContext(input);
  const actor = context.complete ? requiredActor(input.actor) : text(input.actor) || 'HR';
  const requestId = context.complete ? requiredRequestId(input.request_id === undefined ? input.requestId : input.request_id) : null;
  const reason = context.complete ? requiredReason(input.reason) : null;

  return database.transaction(() => {
    const existing = pendingBySourceKey(database, 'lark_minutes', sourceKey);
    if (existing) {
      if (Number(existing.job_id) !== jobId) throw new Error('stable source key is already registered to another job');
      return publicIngestResult(database, existing, false);
    }
    const job = database.prepare('SELECT id FROM job WHERE id = ?').get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    const timestamp = text(input.created_at === undefined ? input.createdAt : input.created_at) || new Date().toISOString();
    const info = database.prepare(`
      INSERT INTO job_interview (job_id, source_url, transcript, note, source_type, created_at)
      VALUES (?, ?, ?, ?, 'lark_minutes', ?)
    `).run(jobId, sourceUrl || null, transcript, text(input.note) || '线上会议导入 · 飞书妙记', timestamp);
    const legacyId = Number(info.lastInsertRowid);
    database.prepare(`
      INSERT INTO interview_pending_assignment (
        job_interview_id, interview_recording_id, job_id, source_type, source_key, payload_hash,
        purpose, status, reason, assigned_session_id, assigned_by, assigned_at,
        version, created_at, updated_at
      ) VALUES (?, NULL, ?, 'lark_minutes', ?, ?, 'unknown', 'pending_classification',
        'purpose_unclassified', NULL, NULL, NULL, 1, ?, ?)
    `).run(legacyId, jobId, sourceKey, hash, timestamp, timestamp);
    let pending = database.prepare('SELECT * FROM interview_pending_assignment WHERE job_interview_id = ?').get(legacyId);
    let session = null;
    if (context.complete) {
      const assigned = directAssign(database, pending, context, actor, reason, requestId);
      pending = assigned.pending;
      session = assigned.session;
    }
    database.prepare(`
      INSERT INTO audit_log (action, target, who, auto, result, detail_json, created_at)
      VALUES ('面试材料适配入库', ?, ?, 0, '成功', ?, ?)
    `).run(String(pending.id), actor, JSON.stringify({
      source_type: 'lark_minutes',
      source_key_hash: sha256(sourceKey),
      assignment_status: pending.status,
      session_id: pending.assigned_session_id,
    }), timestamp);
    return publicIngestResult(database, pending, true, session);
  })();
}

function ingestOfflineRecording(input = {}) {
  const database = db.conn();
  ensureSchema(database);
  const recordingInput = input.recording || input.recording_input || input.recordingInput || null;
  let recordingId = Number(input.recording_id === undefined ? input.recordingId : input.recording_id);
  if (!recordingId && !recordingInput) throw new Error('recordingId or recording input is required');
  const summaryPath = text(input.summary_path === undefined ? input.summaryPath : input.summary_path)
    || text(recordingInput && (recordingInput.summary_path || recordingInput.summaryPath));
  const sourceKey = text(input.source_key === undefined ? input.sourceKey : input.source_key)
    || sourceKeyForOfflineSummary(summaryPath);
  const hash = text(input.payload_hash === undefined ? input.payloadHash : input.payload_hash) || null;
  const context = explicitContext(input);
  const actor = context.complete ? requiredActor(input.actor) : text(input.actor) || 'HR';
  const requestId = context.complete ? requiredRequestId(input.request_id === undefined ? input.requestId : input.request_id) : null;
  const reason = context.complete ? requiredReason(input.reason) : null;

  return database.transaction(() => {
    const existing = pendingBySourceKey(database, 'offline_recording', sourceKey);
    if (existing) return publicIngestResult(database, existing, false);
    let recording = null;
    if (recordingId) recording = db.getInterviewRecording(recordingId);
    else {
      recording = db.createInterviewRecording(recordingInput);
      recordingId = recording.id;
    }
    if (!recording) throw new Error(`interview recording not found: ${recordingId}`);
    if (context.complete) db.assertJobRecruitingWritableById(context.jobId);
    else if (recording.job_id) db.assertJobRecruitingWritableById(recording.job_id);
    const timestamp = text(input.created_at === undefined ? input.createdAt : input.created_at)
      || text(recording.created_at)
      || new Date().toISOString();
    database.prepare(`
      INSERT INTO interview_pending_assignment (
        job_interview_id, interview_recording_id, job_id, source_type, source_key, payload_hash,
        purpose, status, reason, assigned_session_id, assigned_by, assigned_at,
        version, created_at, updated_at
      ) VALUES (NULL, ?, ?, 'offline_recording', ?, ?, 'unknown', 'pending_classification',
        'purpose_unclassified', NULL, NULL, NULL, 1, ?, ?)
    `).run(recordingId, recording.job_id || (context.complete ? context.jobId : null), sourceKey, hash, timestamp, timestamp);
    let pending = database.prepare('SELECT * FROM interview_pending_assignment WHERE interview_recording_id = ?').get(recordingId);
    let session = null;
    if (context.complete) {
      const assigned = directAssign(database, pending, context, actor, reason, requestId);
      pending = assigned.pending;
      session = assigned.session;
    }
    database.prepare(`
      INSERT INTO audit_log (action, target, who, auto, result, detail_json, created_at)
      VALUES ('面试材料适配入库', ?, ?, 0, '成功', ?, ?)
    `).run(String(pending.id), actor, JSON.stringify({
      source_type: 'offline_recording',
      source_key_hash: sha256(sourceKey),
      assignment_status: pending.status,
      session_id: pending.assigned_session_id,
    }), timestamp);
    return publicIngestResult(database, pending, true, session);
  })();
}

function classifyPendingMaterial(input = {}) {
  const database = db.conn();
  ensureSchema(database);
  const id = Number(input.pending_assignment_id === undefined ? input.pendingAssignmentId : input.pending_assignment_id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('pendingAssignmentId is required');
  const purpose = text(input.purpose);
  if (!PURPOSES.has(purpose)) throw new Error(`unsupported manual interview purpose: ${purpose || 'empty'}`);
  const actor = requiredActor(input.actor);
  const reasonText = requiredReason(input.reason);
  const requestId = requiredRequestId(input.request_id === undefined ? input.requestId : input.request_id);
  const expectedVersion = requiredVersion(input.expected_version === undefined ? input.expectedVersion : input.expected_version);
  return database.transaction(() => {
    const replay = auditByRequest(database, id, requestId);
    if (replay) return pendingById(database, id);
    const current = pendingById(database, id);
    if (!current) throw new Error(`pending interview classification not found: ${id}`);
    if (current.job_id) db.assertJobRecruitingWritableById(current.job_id);
    if (Number(current.version) !== expectedVersion) throw new Error(`stale pending assignment version: expected ${expectedVersion}, current ${current.version}`);
    if (current.purpose !== 'unknown' || current.status !== 'pending_classification') {
      throw new Error(`illegal interview purpose transition from ${current.purpose}/${current.status}`);
    }
    const afterStatus = purpose === 'candidate_interview' ? 'pending_assignment' : 'excluded';
    const afterReason = purpose === 'candidate_interview' ? 'missing_candidate' : 'hiring_manager_profile_interview';
    const timestamp = new Date().toISOString();
    insertActionAudit(database, {
      pending_assignment_id: id,
      action_type: 'classification',
      before_purpose: current.purpose,
      before_status: current.status,
      before_assigned_session_id: current.assigned_session_id,
      before_version: current.version,
      after_purpose: purpose,
      after_status: afterStatus,
      after_assigned_session_id: null,
      after_version: current.version + 1,
      actor,
      reason: reasonText,
      request_id: requestId,
      classified_at: timestamp,
      created_at: timestamp,
    });
    database.prepare(`
      UPDATE interview_pending_assignment
      SET purpose = ?, status = ?, reason = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(purpose, afterStatus, afterReason, timestamp, id);
    return pendingById(database, id);
  })();
}

function assignPendingMaterial(input = {}) {
  const database = db.conn();
  ensureSchema(database);
  const id = Number(input.pending_assignment_id === undefined ? input.pendingAssignmentId : input.pending_assignment_id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('pendingAssignmentId is required');
  const actor = requiredActor(input.actor);
  const reasonText = requiredReason(input.reason);
  const requestId = requiredRequestId(input.request_id === undefined ? input.requestId : input.request_id);
  const expectedVersion = requiredVersion(input.expected_version === undefined ? input.expectedVersion : input.expected_version);
  const context = explicitContext(input);
  if (!context.complete) throw new Error('candidateId, jobId and round are required for manual assignment');
  db.assertJobRecruitingWritableById(context.jobId);
  return database.transaction(() => {
    const replay = auditByRequest(database, id, requestId);
    if (replay) return { assignment: pendingById(database, id), session: db.getInterviewSession(replay.after_assigned_session_id) };
    const current = pendingById(database, id);
    if (!current) throw new Error(`pending interview assignment not found: ${id}`);
    if (Number(current.version) !== expectedVersion) throw new Error(`stale pending assignment version: expected ${expectedVersion}, current ${current.version}`);
    if (current.purpose !== 'candidate_interview' || !['pending_assignment', 'assigned'].includes(current.status)) {
      throw new Error(`pending interview assignment ${id} must be candidate_interview/pending_assignment or assigned`);
    }
    if (current.job_id && Number(current.job_id) !== context.jobId) throw new Error(`pending interview assignment ${id} belongs to another job`);
    const mode = current.source_type === 'lark_minutes' ? 'online' : 'offline';
    const session = existingSessionForContext(context, mode);
    const actionType = current.status === 'assigned' ? 'correction' : 'assignment';
    const timestamp = new Date().toISOString();
    const afterVersion = current.version + 1;
    insertActionAudit(database, {
      pending_assignment_id: id,
      action_type: actionType,
      before_purpose: current.purpose,
      before_status: current.status,
      before_assigned_session_id: current.assigned_session_id,
      before_version: current.version,
      after_purpose: 'candidate_interview',
      after_status: 'assigned',
      after_assigned_session_id: session.id,
      after_version: afterVersion,
      actor,
      reason: reasonText,
      request_id: requestId,
      classified_at: timestamp,
      created_at: timestamp,
    });
    if (current.source_type === 'offline_recording') {
      db.bindInterviewRecording({
        id: current.interview_recording_id,
        candidateId: context.candidateId,
        jobId: context.jobId,
      });
    }
    ensureMaterialLink(database, current, session.id, actor, timestamp);
    database.prepare(`
      UPDATE interview_pending_assignment
      SET job_id = ?, status = 'assigned', assigned_session_id = ?, assigned_by = ?, assigned_at = ?,
          version = ?, updated_at = ?
      WHERE id = ?
    `).run(context.jobId, session.id, actor, timestamp, afterVersion, timestamp, id);
    return { assignment: pendingById(database, id), session: db.getInterviewSession(session.id) };
  })();
}

function sourceKeyFingerprint(sourceKey) {
  return sha256(sourceKey).slice(0, 12);
}

function listPendingMaterials(filters = {}) {
  const database = db.conn();
  ensureSchema(database);
  const where = [];
  const params = {};
  if (filters.jobId || filters.job_id) {
    params.job_id = Number(filters.jobId || filters.job_id);
    where.push('pending.job_id = @job_id');
  }
  if (filters.status) {
    params.status = text(filters.status);
    where.push('pending.status = @status');
  } else {
    where.push("pending.status IN ('pending_classification', 'pending_assignment')");
  }
  return database.prepare(`
    SELECT pending.*, job.name AS job_name,
           COALESCE(legacy.created_at, recording.created_at, pending.created_at) AS material_created_at
    FROM interview_pending_assignment pending
    LEFT JOIN job ON job.id = pending.job_id
    LEFT JOIN job_interview legacy ON legacy.id = pending.job_interview_id
    LEFT JOIN interview_recording recording ON recording.id = pending.interview_recording_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY material_created_at DESC, pending.id DESC
  `).all(params).map((row) => ({
    id: row.id,
    job_interview_id: row.job_interview_id,
    interview_recording_id: row.interview_recording_id,
    job_id: row.job_id,
    job_name: row.job_name,
    source_type: row.source_type,
    source_key_fingerprint: sourceKeyFingerprint(row.source_key || `legacy:${row.id}`),
    purpose: row.purpose,
    classification: row.status,
    reason: row.reason,
    version: row.version,
    duplicate_suspect: !!duplicateSuspect(database, row.source_type, row.payload_hash, row.id),
    material_created_at: row.material_created_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

function materialDto(database, material) {
  const pending = material.job_interview_id
    ? database.prepare('SELECT * FROM interview_pending_assignment WHERE job_interview_id = ?').get(material.job_interview_id)
    : database.prepare('SELECT * FROM interview_pending_assignment WHERE interview_recording_id = ?').get(material.interview_recording_id);
  const created = material.job_interview_id
    ? database.prepare('SELECT created_at FROM job_interview WHERE id = ?').get(material.job_interview_id)
    : database.prepare('SELECT created_at FROM interview_recording WHERE id = ?').get(material.interview_recording_id);
  const manualNote = material.job_interview_id
    ? database.prepare(`
      SELECT id, status, version
      FROM interview_session_manual_note
      WHERE session_id = ? AND job_interview_id = ?
    `).get(material.session_id, material.job_interview_id)
    : null;
  return {
    id: material.id,
    material_kind: material.material_kind,
    source_type: manualNote ? 'manual_note' : (pending ? pending.source_type : (material.job_interview_id ? 'lark_minutes' : 'offline_recording')),
    source_status: manualNote ? manualNote.status : 'active',
    source_version: manualNote ? Number(manualNote.version) : null,
    source_key_fingerprint: pending ? sourceKeyFingerprint(pending.source_key || `legacy:${pending.id}`) : null,
    payload_hash: pending ? pending.payload_hash : null,
    duplicate_suspect: pending ? !!duplicateSuspect(database, pending.source_type, pending.payload_hash, pending.id) : false,
    job_interview_id: material.job_interview_id,
    interview_recording_id: material.interview_recording_id,
    created_at: created ? created.created_at : material.linked_at,
    linked_at: material.linked_at,
  };
}

function listSessionTimeline(filters = {}) {
  const database = db.conn();
  ensureSchema(database);
  return db.listInterviewSessions(filters).map((session) => {
    const full = db.getInterviewSession(session.id);
    return {
      id: full.id,
      candidate_id: full.candidate_id,
      job_id: full.job_id,
      round: full.round,
      mode: full.mode,
      interview_format: full.interview_format,
      status: full.status,
      scheduled_at: full.scheduled_at,
      scheduled_confirmed_by: full.scheduled_confirmed_by,
      scheduled_confirmed_at: full.scheduled_confirmed_at,
      duration_minutes: full.duration_minutes,
      meeting_platform: full.meeting_platform,
      meeting_link: full.meeting_link,
      location_address: full.location_address,
      location_room: full.location_room,
      logistics_note: full.logistics_note,
      invitation_status: full.invitation_status,
      invitation_sent_by: full.invitation_sent_by,
      invitation_sent_at: full.invitation_sent_at,
      candidate_confirmation_status: full.candidate_confirmation_status,
      candidate_confirmation_recorded_by: full.candidate_confirmation_recorded_by,
      candidate_confirmation_recorded_at: full.candidate_confirmation_recorded_at,
      logistics_version: full.logistics_version,
      manual_note: full.manual_note,
      interviewer_assignments: full.interviewer_assignments,
      schedule_confirmations: full.schedule_confirmations,
      created_at: full.created_at,
      updated_at: full.updated_at,
      materials: full.materials.map((material) => materialDto(database, material)),
    };
  });
}

function listPendingMaterialAudits(pendingAssignmentId) {
  const database = db.conn();
  ensureSchema(database);
  const id = Number(pendingAssignmentId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('pendingAssignmentId is required');
  return database.prepare(`
    SELECT id, pending_assignment_id, action_type,
           before_purpose, before_status, before_assigned_session_id, before_version,
           after_purpose, after_status, after_assigned_session_id, after_version,
           actor, reason, request_id, classified_at, created_at
    FROM interview_pending_assignment_classification_audit
    WHERE pending_assignment_id = ?
    ORDER BY id
  `).all(id);
}

module.exports = {
  assignPendingMaterial,
  classifyPendingMaterial,
  ingestOfflineRecording,
  ingestOnlineMinutes,
  listPendingMaterialAudits,
  listPendingMaterials,
  listSessionTimeline,
  payloadHash,
  sourceKeyForLarkUrl,
  sourceKeyForOfflineSummary,
};
