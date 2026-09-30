const crypto = require('crypto');

const HR_JOURNEY_OPERATION_TABLES = Object.freeze([
  'candidate_next_action',
  'hiring_manager_feedback',
  'candidate_offer_status',
  'hr_journey_request',
]);
const HR_JOURNEY_APPLICATION_DEPENDENT_TABLES = Object.freeze([
  'candidate_offer_event',
]);
const HR_JOURNEY_APPLICATION_DEPENDENT_TRIGGERS = Object.freeze([
  'candidate_offer_status_context_insert_guard',
  'candidate_offer_event_context_insert_guard',
  'candidate_offer_event_update_guard',
  'candidate_offer_event_delete_guard',
]);

const OFFER_STATUS_TABLE = `
CREATE TABLE IF NOT EXISTS candidate_offer_status (
  id INTEGER PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(internal_id) ON DELETE RESTRICT,
  job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
  application_id INTEGER,
  status TEXT NOT NULL CHECK(status IN (
    'ready_to_offer', 'offer_sent', 'negotiating', 'accepted',
    'declined', 'company_withdrawn', 'onboarding_handoff'
  )),
  expected_start_date TEXT,
  reason_code TEXT,
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const HR_JOURNEY_OPERATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS candidate_next_action (
  id INTEGER PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(internal_id) ON DELETE RESTRICT,
  job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
  application_id INTEGER,
  action_type TEXT NOT NULL CHECK(action_type IN (
    'contact', 'resume', 'assessment', 'interview', 'feedback', 'offer', 'onboarding', 'other'
  )),
  due_date TEXT NOT NULL,
  note TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending', 'completed', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(candidate_id, job_id)
);

CREATE INDEX IF NOT EXISTS candidate_next_action_job_due
ON candidate_next_action(job_id, state, due_date, candidate_id);

CREATE TABLE IF NOT EXISTS hiring_manager_feedback (
  id INTEGER PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(internal_id) ON DELETE RESTRICT,
  job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
  context_type TEXT NOT NULL CHECK(context_type IN ('job_profile', 'interview', 'final_review')),
  feedback_person TEXT NOT NULL,
  feedback_role TEXT,
  feedback_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  conclusion TEXT NOT NULL CHECK(conclusion IN ('agree', 'need_more', 'disagree')),
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS hiring_manager_feedback_candidate_time
ON hiring_manager_feedback(candidate_id, job_id, feedback_at DESC, id DESC);

${OFFER_STATUS_TABLE}

CREATE UNIQUE INDEX IF NOT EXISTS candidate_offer_status_application_unique
ON candidate_offer_status(application_id)
WHERE application_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS candidate_offer_status_job
ON candidate_offer_status(job_id, status, updated_at DESC);

CREATE TRIGGER IF NOT EXISTS candidate_offer_status_identity_update_guard
BEFORE UPDATE OF candidate_id, job_id, application_id, created_at
ON candidate_offer_status
WHEN NEW.candidate_id IS NOT OLD.candidate_id
  OR NEW.job_id IS NOT OLD.job_id
  OR NEW.application_id IS NOT OLD.application_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'offer application identity is immutable');
END;

CREATE TABLE IF NOT EXISTS hr_journey_request (
  request_id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL CHECK(operation_type IN (
    'set_candidate_next_action',
    'record_hiring_manager_feedback',
    'set_candidate_offer_status'
  )),
  candidate_id TEXT NOT NULL REFERENCES candidate(internal_id) ON DELETE RESTRICT,
  job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
  application_id INTEGER,
  request_hash TEXT NOT NULL CHECK(
    LENGTH(request_hash) = 64
    AND request_hash = LOWER(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS hr_journey_request_context
ON hr_journey_request(candidate_id, job_id, application_id, created_at);
`;

const HR_JOURNEY_APPLICATION_DEPENDENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS candidate_offer_event (
  id INTEGER PRIMARY KEY,
  offer_id INTEGER NOT NULL REFERENCES candidate_offer_status(id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES candidate(internal_id) ON DELETE RESTRICT,
  job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
  application_id INTEGER NOT NULL REFERENCES application_episode(id) ON DELETE RESTRICT,
  from_status TEXT CHECK(from_status IS NULL OR from_status IN (
    'ready_to_offer', 'offer_sent', 'negotiating', 'accepted',
    'declined', 'company_withdrawn', 'onboarding_handoff'
  )),
  to_status TEXT NOT NULL CHECK(to_status IN (
    'ready_to_offer', 'offer_sent', 'negotiating', 'accepted',
    'declined', 'company_withdrawn', 'onboarding_handoff'
  )),
  expected_start_date TEXT,
  reason_code TEXT,
  note TEXT,
  offer_version INTEGER NOT NULL CHECK(offer_version > 0),
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK(
    LENGTH(request_hash) = 64
    AND request_hash = LOWER(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS candidate_offer_event_application_time
ON candidate_offer_event(application_id, occurred_at, id);

CREATE INDEX IF NOT EXISTS candidate_offer_event_candidate_time
ON candidate_offer_event(candidate_id, job_id, occurred_at, id);

CREATE TRIGGER IF NOT EXISTS candidate_offer_status_context_insert_guard
BEFORE INSERT ON candidate_offer_status
WHEN NEW.application_id IS NULL OR NOT EXISTS (
  SELECT 1
  FROM application_episode application
  WHERE application.id = NEW.application_id
    AND application.candidate_id = NEW.candidate_id
    AND application.job_id = NEW.job_id
)
BEGIN
  SELECT RAISE(ABORT, 'offer application candidate/job mismatch');
END;

CREATE TRIGGER IF NOT EXISTS candidate_offer_event_context_insert_guard
BEFORE INSERT ON candidate_offer_event
WHEN NOT EXISTS (
  SELECT 1
  FROM candidate_offer_status offer
  WHERE offer.id = NEW.offer_id
    AND offer.candidate_id = NEW.candidate_id
    AND offer.job_id = NEW.job_id
    AND offer.application_id = NEW.application_id
)
BEGIN
  SELECT RAISE(ABORT, 'offer event context mismatch');
END;

CREATE TRIGGER IF NOT EXISTS candidate_offer_event_update_guard
BEFORE UPDATE ON candidate_offer_event
BEGIN
  SELECT RAISE(ABORT, 'candidate_offer_event is append-only');
END;

CREATE TRIGGER IF NOT EXISTS candidate_offer_event_delete_guard
BEFORE DELETE ON candidate_offer_event
BEGIN
  SELECT RAISE(ABORT, 'candidate_offer_event is append-only');
END;
`;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function journeyRequestHash(operationType, payload) {
  return crypto.createHash('sha256')
    .update(stableJson({ operation_type: operationType, ...payload }), 'utf8')
    .digest('hex');
}

function tableExists(database, table) {
  return !!database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table);
}

function uniqueIndexColumns(database, table) {
  return database.prepare(`PRAGMA index_list('${table}')`).all()
    .filter((row) => Number(row.unique) === 1)
    .map((row) => {
      const name = String(row.name).replaceAll("'", "''");
      return database.prepare(`PRAGMA index_info('${name}')`).all()
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((column) => column.name);
    });
}

function migrateLegacyOfferProjection(database) {
  if (!tableExists(database, 'candidate_offer_status')) return;
  const hasCandidateJobUnique = uniqueIndexColumns(database, 'candidate_offer_status')
    .some((columns) => columns.length === 2
      && columns[0] === 'candidate_id'
      && columns[1] === 'job_id');
  const hasUnavailableApplicationForeignKey = !tableExists(database, 'application_episode')
    && database.prepare("PRAGMA foreign_key_list('candidate_offer_status')").all()
      .some((foreignKey) => foreignKey.table === 'application_episode');
  if (!hasCandidateJobUnique && !hasUnavailableApplicationForeignKey) return;

  database.transaction(() => {
    database.exec('DROP TABLE IF EXISTS candidate_offer_status_v2');
    database.exec(OFFER_STATUS_TABLE.replaceAll('candidate_offer_status', 'candidate_offer_status_v2'));
    database.exec(`
      INSERT INTO candidate_offer_status_v2 (
        id, candidate_id, job_id, application_id, status, expected_start_date,
        reason_code, note, version, actor_id, request_id, created_at, updated_at
      )
      SELECT
        id, candidate_id, job_id, application_id, status, expected_start_date,
        reason_code, note, version, actor_id, request_id, created_at, updated_at
      FROM candidate_offer_status;
      DROP TABLE candidate_offer_status;
      ALTER TABLE candidate_offer_status_v2 RENAME TO candidate_offer_status;
    `);
  })();
}

function backfillHrJourneyApplicationBindings(database) {
  if (
    !tableExists(database, 'candidate_next_action')
    || !tableExists(database, 'application_episode')
  ) return;
  const nextActionColumns = new Set(
    database.prepare("PRAGMA table_info('candidate_next_action')").all().map((row) => row.name),
  );
  const applicationColumns = new Set(
    database.prepare("PRAGMA table_info('application_episode')").all().map((row) => row.name),
  );
  if (
    !applicationColumns.has('status')
    || (!applicationColumns.has('opened_at') && !applicationColumns.has('created_at'))
    || (!nextActionColumns.has('updated_at') && !nextActionColumns.has('created_at'))
  ) return;
  const actionTimestamp = nextActionColumns.has('updated_at') && nextActionColumns.has('created_at')
    ? "COALESCE(NULLIF(candidate_next_action.updated_at, ''), NULLIF(candidate_next_action.created_at, ''))"
    : `NULLIF(candidate_next_action.${nextActionColumns.has('updated_at') ? 'updated_at' : 'created_at'}, '')`;
  const applicationTimestamp = applicationColumns.has('opened_at') && applicationColumns.has('created_at')
    ? "COALESCE(NULLIF(application.opened_at, ''), NULLIF(application.created_at, ''))"
    : `NULLIF(application.${applicationColumns.has('opened_at') ? 'opened_at' : 'created_at'}, '')`;
  database.prepare(`
    UPDATE candidate_next_action
    SET application_id = (
      SELECT application.id
      FROM application_episode application
      WHERE application.candidate_id = candidate_next_action.candidate_id
        AND application.job_id = candidate_next_action.job_id
        AND application.status = 'active'
        AND julianday(${actionTimestamp}) >= julianday(${applicationTimestamp})
      ORDER BY application.id DESC
      LIMIT 1
    )
    WHERE application_id IS NULL
      AND (
        SELECT COUNT(*)
        FROM application_episode application
        WHERE application.candidate_id = candidate_next_action.candidate_id
          AND application.job_id = candidate_next_action.job_id
          AND application.status = 'active'
      ) = 1
      AND EXISTS (
        SELECT 1
        FROM application_episode application
        WHERE application.candidate_id = candidate_next_action.candidate_id
          AND application.job_id = candidate_next_action.job_id
          AND application.status = 'active'
          AND julianday(${actionTimestamp}) >= julianday(${applicationTimestamp})
      )
  `).run();
}

function migrateCandidateNextActionApplication(database) {
  if (!tableExists(database, 'candidate_next_action')) return;
  const columns = new Set(
    database.prepare("PRAGMA table_info('candidate_next_action')").all().map((row) => row.name),
  );
  if (!columns.has('application_id')) {
    database.exec('ALTER TABLE candidate_next_action ADD COLUMN application_id INTEGER');
  }
  backfillHrJourneyApplicationBindings(database);
}

function removeUnavailableApplicationArtifacts(database) {
  if (tableExists(database, 'application_episode')) return;
  const hasOfferEvent = tableExists(database, 'candidate_offer_event');
  if (hasOfferEvent && Number(database.prepare(`
    SELECT COUNT(*) AS count FROM candidate_offer_event
  `).get().count) > 0) {
    const error = new Error(
      'candidate_offer_event contains application-scoped history but application_episode is unavailable',
    );
    error.code = 'HR_JOURNEY_APPLICATION_SCHEMA_REQUIRED';
    throw error;
  }
  database.transaction(() => {
    HR_JOURNEY_APPLICATION_DEPENDENT_TRIGGERS.forEach((trigger) => {
      const escaped = trigger.replaceAll('"', '""');
      database.exec(`DROP TRIGGER IF EXISTS "${escaped}"`);
    });
    if (hasOfferEvent) database.exec('DROP TABLE candidate_offer_event');
  })();
}

function applyHrJourneyApplicationArtifacts(database) {
  if (!tableExists(database, 'application_episode')) {
    removeUnavailableApplicationArtifacts(database);
    return false;
  }
  database.exec(HR_JOURNEY_APPLICATION_DEPENDENT_SCHEMA);
  return true;
}

function backfillJourneyRequest(database, {
  requestId,
  operationType,
  candidateId,
  jobId,
  applicationId = null,
  requestHash,
  result,
  actor,
  createdAt,
}) {
  database.prepare(`
    INSERT OR IGNORE INTO hr_journey_request (
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
    createdAt,
  );
}

function backfillLegacyJourneyOperations(database) {
  database.transaction(() => {
    database.prepare('SELECT * FROM candidate_next_action ORDER BY id').all().forEach((row) => {
      const payload = {
        candidate_id: row.candidate_id,
        job_id: Number(row.job_id),
        application_id: row.application_id == null ? null : Number(row.application_id),
        action_type: row.action_type,
        due_date: row.due_date,
        note: row.note || null,
        state: row.state,
      };
      backfillJourneyRequest(database, {
        requestId: row.request_id,
        operationType: 'set_candidate_next_action',
        candidateId: row.candidate_id,
        jobId: Number(row.job_id),
        applicationId: row.application_id == null ? null : Number(row.application_id),
        requestHash: journeyRequestHash('set_candidate_next_action', payload),
        result: { next_action: row },
        actor: row.actor_id,
        createdAt: row.updated_at || row.created_at,
      });
    });

    database.prepare('SELECT * FROM hiring_manager_feedback ORDER BY id').all().forEach((row) => {
      const payload = {
        candidate_id: row.candidate_id,
        job_id: Number(row.job_id),
        context_type: row.context_type,
        feedback_person: row.feedback_person,
        feedback_role: row.feedback_role || null,
        feedback_at: row.feedback_at,
        summary: row.summary,
        conclusion: row.conclusion,
      };
      backfillJourneyRequest(database, {
        requestId: row.request_id,
        operationType: 'record_hiring_manager_feedback',
        candidateId: row.candidate_id,
        jobId: Number(row.job_id),
        requestHash: journeyRequestHash('record_hiring_manager_feedback', payload),
        result: { feedback: row },
        actor: row.actor_id,
        createdAt: row.created_at,
      });
    });

    const offerRows = tableExists(database, 'application_episode') ? database.prepare(`
        SELECT offer.*
        FROM candidate_offer_status offer
        JOIN application_episode application ON application.id = offer.application_id
        WHERE offer.application_id IS NOT NULL
        ORDER BY offer.id
      `).all() : [];
    offerRows.forEach((row) => {
      const payload = {
        candidate_id: row.candidate_id,
        job_id: Number(row.job_id),
        application_id: Number(row.application_id),
        status: row.status,
        expected_start_date: row.expected_start_date || null,
        reason_code: row.reason_code || null,
        note: row.note || null,
      };
      const requestHash = journeyRequestHash('set_candidate_offer_status', payload);
      database.prepare(`
        INSERT OR IGNORE INTO candidate_offer_event (
          offer_id, candidate_id, job_id, application_id, from_status, to_status,
          expected_start_date, reason_code, note, offer_version, actor_id,
          request_id, request_hash, occurred_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.candidate_id,
        row.job_id,
        row.application_id,
        row.status,
        row.expected_start_date,
        row.reason_code,
        row.note,
        row.version,
        row.actor_id,
        row.request_id,
        requestHash,
        row.updated_at || row.created_at,
      );
      backfillJourneyRequest(database, {
        requestId: row.request_id,
        operationType: 'set_candidate_offer_status',
        candidateId: row.candidate_id,
        jobId: Number(row.job_id),
        applicationId: Number(row.application_id),
        requestHash,
        result: { offer: row },
        actor: row.actor_id,
        createdAt: row.updated_at || row.created_at,
      });
    });
  })();
}

function applyHrJourneyOperationsSchema(database) {
  if (!database || typeof database.exec !== 'function') {
    throw new Error('SQLite database connection is required');
  }
  removeUnavailableApplicationArtifacts(database);
  migrateCandidateNextActionApplication(database);
  migrateLegacyOfferProjection(database);
  database.exec(HR_JOURNEY_OPERATIONS_SCHEMA);
  applyHrJourneyApplicationArtifacts(database);
  backfillHrJourneyApplicationBindings(database);
  backfillLegacyJourneyOperations(database);
}

module.exports = {
  HR_JOURNEY_APPLICATION_DEPENDENT_TABLES,
  HR_JOURNEY_APPLICATION_DEPENDENT_TRIGGERS,
  HR_JOURNEY_OPERATION_TABLES,
  HR_JOURNEY_OPERATIONS_SCHEMA,
  applyHrJourneyApplicationArtifacts,
  applyHrJourneyOperationsSchema,
  backfillHrJourneyApplicationBindings,
  journeyRequestHash,
};
