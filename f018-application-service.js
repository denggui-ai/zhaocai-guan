const crypto = require('crypto');

const REQUEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const APPLICATION_COLUMNS = `
  id, candidate_id, job_id, episode_no, status,
  reopened_from_application_id, disposition_action, version,
  opened_by, ended_by, opened_at, ended_at, created_at, updated_at
`;

class F018ApplicationError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'F018ApplicationError';
    this.code = code;
    this.path = path;
    if (code === 'JOB_CLOSED') this.statusCode = 409;
  }
}

function fail(code, path, message) {
  throw new F018ApplicationError(code, path, message);
}

function requiredText(value, path, code, maxLength = 256) {
  if (typeof value !== 'string' || !value.trim()) fail(code, path, `${path} is required.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) fail(code, path, `${path} is too long.`);
  return normalized;
}

function requiredId(value, path, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code, path, `${path} must be a positive integer.`);
  return value;
}

function requiredVersion(value) {
  return requiredId(value, '$.command.expected_version', 'EXPECTED_VERSION_REQUIRED');
}

function requiredRequestId(value) {
  const requestId = requiredText(value, '$.command.request_id', 'REQUEST_ID_REQUIRED', 128);
  if (!REQUEST_PATTERN.test(requestId)) {
    fail('REQUEST_ID_INVALID', '$.command.request_id', 'request_id has an invalid format.');
  }
  return requestId;
}

function requiredReasonCode(value) {
  const reasonCode = requiredText(value, '$.command.reason_code', 'REASON_CODE_REQUIRED', 80);
  if (!REASON_PATTERN.test(reasonCode)) {
    fail('REASON_CODE_INVALID', '$.command.reason_code', 'reason_code has an invalid format.');
  }
  return reasonCode;
}

function assertCommandObject(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    fail('COMMAND_REQUIRED', '$.command', 'command is required.');
  }
}

function assertAllowedKeys(command, allowed) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(command)) {
    if (!allowedSet.has(key)) fail('UNSUPPORTED_FIELD', `$.command.${key}`, `Unsupported command field: ${key}.`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function hashPayload(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value)), 'utf8').digest('hex');
}

function applicationById(database, applicationId) {
  return database.prepare(`SELECT ${APPLICATION_COLUMNS} FROM application_episode WHERE id = ?`).get(applicationId) || null;
}

function eventByRequestId(database, requestId) {
  return database.prepare(`
    SELECT id, application_id, object_type, object_id, event_type, request_id, request_hash,
           actor_id, reason_code, before_status, after_status,
           before_version, after_version, related_object_type, related_object_id, occurred_at
    FROM application_event
    WHERE request_id = ?
  `).get(requestId) || null;
}

function publicEvent(row) {
  if (!row) return null;
  const { request_hash: ignored, ...result } = row;
  return result;
}

function replayResult(database, requestId, requestHash, eventType) {
  const event = eventByRequestId(database, requestId);
  if (!event) return null;
  if (event.request_hash !== requestHash || event.object_type !== 'application' || event.event_type !== eventType) {
    fail('REQUEST_ID_REUSED', '$.command.request_id', 'request_id is already bound to another command.');
  }
  const application = applicationById(database, event.application_id);
  if (!application) fail('APPLICATION_NOT_FOUND', '$.command.application_id', 'Application no longer exists.');
  return { ...application, replayed: true };
}

function insertApplicationEvent(database, row) {
  database.prepare(`
    INSERT INTO application_event (
      application_id, object_type, object_id, event_type,
      request_id, request_hash, actor_id, reason_code,
      before_status, after_status, before_version, after_version,
      related_object_type, related_object_id, occurred_at
    ) VALUES (
      @application_id, 'application', @application_id, @event_type,
      @request_id, @request_hash, @actor_id, @reason_code,
      @before_status, @after_status, @before_version, @after_version,
      @related_object_type, @related_object_id, @occurred_at
    )
  `).run({
    related_object_type: null,
    related_object_id: null,
    ...row,
  });
}

function assertCandidateJob(database, candidateId, jobId) {
  const job = database.prepare('SELECT id FROM job WHERE id = ?').get(jobId);
  if (!job) fail('JOB_NOT_FOUND', '$.command.job_id', `Job ${jobId} was not found.`);
  const candidate = database.prepare(`
    SELECT internal_id, job_id, disposition_code, disposition_status
    FROM candidate WHERE internal_id = ?
  `).get(candidateId);
  if (!candidate) fail('CANDIDATE_NOT_FOUND', '$.command.candidate_id', `Candidate ${candidateId} was not found.`);
  if (Number(candidate.job_id) !== jobId) {
    fail('CANDIDATE_JOB_MISMATCH', '$.command.job_id', 'Candidate does not belong to the supplied job.');
  }
  return candidate;
}

function assertRecruitingEntryAllowed(database, candidateId, jobId, path) {
  const candidate = assertCandidateJob(database, candidateId, jobId);
  assertJobRecruitingWritable(database, jobId, path);
  const dispositionCode = String(candidate.disposition_code || '').trim();
  const dispositionStatus = String(candidate.disposition_status || '').trim();
  if (dispositionCode === 'hired' || dispositionStatus === '已入职') {
    fail('HIRED_FORBIDDEN', path, 'F018 cannot open or re-enter an application for a hired candidate.');
  }
  return candidate;
}

function assertJobRecruitingWritable(database, jobId, path) {
  const job = database.prepare('SELECT id, status FROM job WHERE id = ?').get(jobId);
  if (!job) fail('JOB_NOT_FOUND', path, `Job ${jobId} was not found.`);
  if (job.status === 'closed') {
    fail('JOB_CLOSED', path, 'The job is closed; reopen it before changing F018 recruiting state.');
  }
  return job;
}

function normalizeActor(actorContext) {
  if (!actorContext || typeof actorContext !== 'object' || Array.isArray(actorContext)) {
    fail('ACTOR_CONTEXT_REQUIRED', '$.actorContext', 'Server actor context is required.');
  }
  return requiredText(actorContext.actor_id, '$.actorContext.actor_id', 'ACTOR_CONTEXT_REQUIRED', 160);
}

function normalizeNow(now) {
  const value = typeof now === 'function' ? now() : new Date().toISOString();
  return requiredText(value, '$.now', 'CLOCK_INVALID', 80);
}

function transitionCommand(command) {
  assertCommandObject(command);
  assertAllowedKeys(command, ['application_id', 'expected_version', 'request_id', 'reason_code']);
  return {
    applicationId: requiredId(command.application_id, '$.command.application_id', 'APPLICATION_ID_REQUIRED'),
    expectedVersion: requiredVersion(command.expected_version),
    requestId: requiredRequestId(command.request_id),
    reasonCode: requiredReasonCode(command.reason_code),
  };
}

function createF018ApplicationService({ database, actorContext, now } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    throw new Error('database is required');
  }
  const actorId = normalizeActor(actorContext);

  function openApplication(command) {
    assertCommandObject(command);
    assertAllowedKeys(command, ['candidate_id', 'job_id', 'request_id', 'reason_code']);
    const input = {
      candidateId: requiredText(command.candidate_id, '$.command.candidate_id', 'CANDIDATE_ID_REQUIRED', 160),
      jobId: requiredId(command.job_id, '$.command.job_id', 'JOB_ID_REQUIRED'),
      requestId: requiredRequestId(command.request_id),
      reasonCode: requiredReasonCode(command.reason_code),
    };
    const requestHash = hashPayload({ operation: 'open', actor_id: actorId, ...input });

    return database.transaction(() => {
      const replay = replayResult(database, input.requestId, requestHash, 'opened');
      if (replay) return replay;
      assertRecruitingEntryAllowed(
        database,
        input.candidateId,
        input.jobId,
        '$.command.candidate_id',
      );

      const previous = database.prepare(`
        SELECT id, status FROM application_episode
        WHERE candidate_id = ? AND job_id = ?
        ORDER BY episode_no DESC LIMIT 1
      `).get(input.candidateId, input.jobId);
      if (previous) {
        const code = previous.status === 'active' ? 'ACTIVE_APPLICATION_EXISTS' : 'REENTRY_REQUIRED';
        fail(code, '$.command.candidate_id', previous.status === 'active'
          ? 'An active application already exists for this candidate/job context.'
          : 'A prior application exists; use reenterApplication to create a new episode.');
      }

      const timestamp = normalizeNow(now);
      const inserted = database.prepare(`
        INSERT INTO application_episode (
          candidate_id, job_id, episode_no, status, version,
          opened_by, opened_at, created_at, updated_at
        ) VALUES (?, ?, 1, 'active', 1, ?, ?, ?, ?)
      `).run(input.candidateId, input.jobId, actorId, timestamp, timestamp, timestamp);
      const applicationId = Number(inserted.lastInsertRowid);
      insertApplicationEvent(database, {
        application_id: applicationId,
        event_type: 'opened',
        request_id: input.requestId,
        request_hash: requestHash,
        actor_id: actorId,
        reason_code: input.reasonCode,
        before_status: null,
        after_status: 'active',
        before_version: null,
        after_version: 1,
        occurred_at: timestamp,
      });
      return { ...applicationById(database, applicationId), replayed: false };
    })();
  }

  function endApplication(operation, targetStatus, command) {
    const input = transitionCommand(command);
    const requestHash = hashPayload({ operation, actor_id: actorId, ...input });

    return database.transaction(() => {
      const replay = replayResult(database, input.requestId, requestHash, operation);
      if (replay) return replay;
      const current = applicationById(database, input.applicationId);
      if (!current) fail('APPLICATION_NOT_FOUND', '$.command.application_id', 'Application was not found.');
      assertJobRecruitingWritable(database, Number(current.job_id), '$.command.application_id');
      if (current.version !== input.expectedVersion) {
        fail('STALE_VERSION', '$.command.expected_version', 'Application version has changed.');
      }
      if (current.status !== 'active') {
        fail('APPLICATION_NOT_ACTIVE', '$.command.application_id', 'Only an active application can be ended.');
      }

      const timestamp = normalizeNow(now);
      const updated = database.prepare(`
        UPDATE application_episode
        SET status = ?, version = version + 1,
            ended_by = ?, ended_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active' AND version = ?
      `).run(targetStatus, actorId, timestamp, timestamp, input.applicationId, input.expectedVersion);
      if (updated.changes !== 1) {
        fail('STALE_VERSION', '$.command.expected_version', 'Application version has changed.');
      }
      insertApplicationEvent(database, {
        application_id: input.applicationId,
        event_type: operation,
        request_id: input.requestId,
        request_hash: requestHash,
        actor_id: actorId,
        reason_code: input.reasonCode,
        before_status: 'active',
        after_status: targetStatus,
        before_version: input.expectedVersion,
        after_version: input.expectedVersion + 1,
        occurred_at: timestamp,
      });
      return { ...applicationById(database, input.applicationId), replayed: false };
    })();
  }

  function withdrawApplication(command) {
    return endApplication('withdrawn', 'withdrawn', command);
  }

  function closeApplication(command) {
    return endApplication('closed', 'closed', command);
  }

  function reenterApplication(command) {
    const input = transitionCommand(command);
    const requestHash = hashPayload({ operation: 'reenter', actor_id: actorId, ...input });

    return database.transaction(() => {
      const replay = replayResult(database, input.requestId, requestHash, 'reopened');
      if (replay) return replay;
      const prior = applicationById(database, input.applicationId);
      if (!prior) fail('APPLICATION_NOT_FOUND', '$.command.application_id', 'Application was not found.');
      assertRecruitingEntryAllowed(
        database,
        prior.candidate_id,
        Number(prior.job_id),
        '$.command.application_id',
      );
      if (prior.version !== input.expectedVersion) {
        fail('STALE_VERSION', '$.command.expected_version', 'Application version has changed.');
      }
      if (!['withdrawn', 'closed'].includes(prior.status)) {
        fail('APPLICATION_NOT_ENDED', '$.command.application_id', 'Only a withdrawn or closed application can be re-entered.');
      }
      const active = database.prepare(`
        SELECT id FROM application_episode
        WHERE candidate_id = ? AND job_id = ? AND status = 'active'
      `).get(prior.candidate_id, prior.job_id);
      if (active) fail('ACTIVE_APPLICATION_EXISTS', '$.command.application_id', 'An active application already exists.');

      const nextEpisode = Number(database.prepare(`
        SELECT COALESCE(MAX(episode_no), 0) + 1 AS episode_no
        FROM application_episode WHERE candidate_id = ? AND job_id = ?
      `).get(prior.candidate_id, prior.job_id).episode_no);
      const timestamp = normalizeNow(now);
      const inserted = database.prepare(`
        INSERT INTO application_episode (
          candidate_id, job_id, episode_no, status, reopened_from_application_id,
          version, opened_by, opened_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, 1, ?, ?, ?, ?)
      `).run(
        prior.candidate_id,
        prior.job_id,
        nextEpisode,
        prior.id,
        actorId,
        timestamp,
        timestamp,
        timestamp,
      );
      const applicationId = Number(inserted.lastInsertRowid);
      insertApplicationEvent(database, {
        application_id: applicationId,
        event_type: 'reopened',
        request_id: input.requestId,
        request_hash: requestHash,
        actor_id: actorId,
        reason_code: input.reasonCode,
        before_status: prior.status,
        after_status: 'active',
        before_version: prior.version,
        after_version: 1,
        related_object_type: 'application',
        related_object_id: prior.id,
        occurred_at: timestamp,
      });
      return { ...applicationById(database, applicationId), replayed: false };
    })();
  }

  function getApplication(applicationId) {
    const id = requiredId(applicationId, '$.application_id', 'APPLICATION_ID_REQUIRED');
    return applicationById(database, id);
  }

  function listApplications(filters = {}) {
    assertCommandObject(filters);
    assertAllowedKeys(filters, ['candidate_id', 'job_id']);
    const candidateId = requiredText(filters.candidate_id, '$.filters.candidate_id', 'CANDIDATE_ID_REQUIRED', 160);
    const jobId = requiredId(filters.job_id, '$.filters.job_id', 'JOB_ID_REQUIRED');
    assertCandidateJob(database, candidateId, jobId);
    return database.prepare(`
      SELECT ${APPLICATION_COLUMNS}
      FROM application_episode
      WHERE candidate_id = ? AND job_id = ?
      ORDER BY episode_no DESC, id DESC
    `).all(candidateId, jobId);
  }

  function listApplicationEvents(applicationId) {
    const id = requiredId(applicationId, '$.application_id', 'APPLICATION_ID_REQUIRED');
    return database.prepare(`
      SELECT id, application_id, object_type, object_id, event_type, request_id,
             actor_id, reason_code, before_status, after_status,
             before_version, after_version, related_object_type, related_object_id, occurred_at
      FROM application_event
      WHERE application_id = ?
      ORDER BY occurred_at, id
    `).all(id).map(publicEvent);
  }

  return {
    openApplication,
    withdrawApplication,
    closeApplication,
    reenterApplication,
    getApplication,
    listApplications,
    listApplicationEvents,
  };
}

function terminalLegacyDisposition(code, label) {
  return ['rejected', 'talent_pool', 'hired', 'candidate_withdrew', 'do_not_contact'].includes(String(code || '').trim())
    || ['淘汰', '暂存人才库', '备选', '已入职', '主动放弃', '不再联系'].includes(String(label || '').trim());
}

function backfillRequestId(kind, candidateId, jobId) {
  const digest = crypto.createHash('sha256').update(`${candidateId}:${jobId}`, 'utf8').digest('hex').slice(0, 32);
  return `f018.backfill.${kind}.${digest}`;
}

function backfillLegacyCandidates({ database, actorContext = { actor_id: 'f018-migration' }, now } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    throw new Error('database is required');
  }
  const actorId = normalizeActor(actorContext);
  const candidateColumns = new Set(database.prepare("PRAGMA table_info('candidate')").all().map((row) => row.name));
  const selectColumn = (name) => candidateColumns.has(name) ? name : `NULL AS ${name}`;
  const candidates = database.prepare(`
    SELECT internal_id, job_id,
           ${selectColumn('disposition_code')},
           ${selectColumn('disposition_status')},
           ${selectColumn('created_at')},
           ${selectColumn('updated_at')}
    FROM candidate
    ORDER BY internal_id
  `).all();

  return database.transaction(() => {
    let created = 0;
    let active = 0;
    let closed = 0;
    let events = 0;
    for (const candidate of candidates) {
      const existing = database.prepare(`
        SELECT id FROM application_episode
        WHERE candidate_id = ? AND job_id = ? LIMIT 1
      `).get(candidate.internal_id, candidate.job_id);
      if (existing) continue;

      assertCandidateJob(database, candidate.internal_id, Number(candidate.job_id));
      const isClosed = terminalLegacyDisposition(candidate.disposition_code, candidate.disposition_status);
      const openedAt = typeof candidate.created_at === 'string' && candidate.created_at.trim()
        ? candidate.created_at.trim()
        : normalizeNow(now);
      const endedAt = isClosed
        ? (typeof candidate.updated_at === 'string' && candidate.updated_at.trim()
          ? candidate.updated_at.trim()
          : openedAt)
        : null;
      const status = isClosed ? 'closed' : 'active';
      const version = isClosed ? 2 : 1;
      const inserted = database.prepare(`
        INSERT INTO application_episode (
          candidate_id, job_id, episode_no, status, version,
          opened_by, ended_by, opened_at, ended_at, created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidate.internal_id,
        candidate.job_id,
        status,
        version,
        actorId,
        isClosed ? actorId : null,
        openedAt,
        endedAt,
        openedAt,
        endedAt || openedAt,
      );
      const applicationId = Number(inserted.lastInsertRowid);
      const openRequestId = backfillRequestId('opened', candidate.internal_id, candidate.job_id);
      insertApplicationEvent(database, {
        application_id: applicationId,
        event_type: 'opened',
        request_id: openRequestId,
        request_hash: hashPayload({ operation: 'backfill_opened', candidate_id: candidate.internal_id, job_id: candidate.job_id }),
        actor_id: actorId,
        reason_code: 'legacy_candidate_backfill',
        before_status: null,
        after_status: 'active',
        before_version: null,
        after_version: 1,
        occurred_at: openedAt,
      });
      events += 1;
      if (isClosed) {
        const closeRequestId = backfillRequestId('closed', candidate.internal_id, candidate.job_id);
        insertApplicationEvent(database, {
          application_id: applicationId,
          event_type: 'closed',
          request_id: closeRequestId,
          request_hash: hashPayload({ operation: 'backfill_closed', candidate_id: candidate.internal_id, job_id: candidate.job_id }),
          actor_id: actorId,
          reason_code: 'legacy_terminal_disposition',
          before_status: 'active',
          after_status: 'closed',
          before_version: 1,
          after_version: 2,
          occurred_at: endedAt,
        });
        events += 1;
        closed += 1;
      } else {
        active += 1;
      }
      created += 1;
    }
    return { scanned: candidates.length, created, active, closed, events };
  })();
}

module.exports = {
  F018ApplicationError,
  createF018ApplicationService,
  backfillLegacyCandidates,
};
