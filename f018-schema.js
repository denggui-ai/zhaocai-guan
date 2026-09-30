const F018_TABLES = Object.freeze([
  'application_episode',
  'application_event',
  'final_review',
  'final_disposition',
]);

const F018_INDEXES = Object.freeze([
  'application_episode_one_active_context',
  'application_episode_context_history',
  'application_event_application_time',
  'application_event_object_time',
  'final_review_one_current_editable',
  'final_review_one_current_confirmed',
  'final_review_application_history',
  'final_disposition_application_time',
]);

const F018_TRIGGERS = Object.freeze([
  'application_episode_candidate_job_insert_guard',
  'application_episode_candidate_job_update_guard',
  'application_episode_identity_update_guard',
  'application_episode_terminal_update_guard',
  'application_episode_sequence_insert_guard',
  'application_episode_reopen_insert_guard',
  'candidate_application_job_update_guard',
  'application_event_update_guard',
  'application_event_object_insert_guard',
  'application_event_delete_guard',
  'final_review_profile_insert_guard',
  'final_review_profile_update_guard',
  'final_review_report_insert_guard',
  'final_review_report_update_guard',
  'final_review_confirmed_update_guard',
  'final_review_superseded_update_guard',
  'final_review_delete_guard',
  'final_disposition_review_insert_guard',
  'final_disposition_update_guard',
  'final_disposition_delete_guard',
]);

const F018_SCHEMA = `
CREATE TABLE IF NOT EXISTS application_episode (
  id INTEGER PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(internal_id) ON DELETE RESTRICT,
  job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
  episode_no INTEGER NOT NULL
    CHECK(typeof(episode_no) = 'integer' AND episode_no > 0),
  status TEXT NOT NULL CHECK(status IN ('active', 'withdrawn', 'closed')),
  reopened_from_application_id INTEGER REFERENCES application_episode(id) ON DELETE RESTRICT,
  disposition_action TEXT
    CHECK(disposition_action IS NULL OR disposition_action IN (
      'continue_process', 'hold', 'reject', 'talent_pool'
    )),
  version INTEGER NOT NULL DEFAULT 1
    CHECK(typeof(version) = 'integer' AND version > 0),
  opened_by TEXT NOT NULL CHECK(LENGTH(TRIM(opened_by)) > 0),
  ended_by TEXT,
  opened_at TEXT NOT NULL CHECK(LENGTH(TRIM(opened_at)) > 0),
  ended_at TEXT,
  created_at TEXT NOT NULL CHECK(LENGTH(TRIM(created_at)) > 0),
  updated_at TEXT NOT NULL CHECK(LENGTH(TRIM(updated_at)) > 0),
  UNIQUE(candidate_id, job_id, episode_no),
  CHECK(reopened_from_application_id IS NULL OR reopened_from_application_id <> id),
  CHECK(
    (episode_no = 1 AND reopened_from_application_id IS NULL)
    OR (episode_no > 1 AND reopened_from_application_id IS NOT NULL)
  ),
  CHECK(
    (status = 'active' AND ended_by IS NULL AND ended_at IS NULL)
    OR
    (status IN ('withdrawn', 'closed')
      AND ended_by IS NOT NULL AND LENGTH(TRIM(ended_by)) > 0
      AND ended_at IS NOT NULL AND LENGTH(TRIM(ended_at)) > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS application_episode_one_active_context
ON application_episode(candidate_id, job_id)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS application_episode_context_history
ON application_episode(candidate_id, job_id, episode_no DESC);

CREATE TABLE IF NOT EXISTS application_event (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES application_episode(id) ON DELETE RESTRICT,
  object_type TEXT NOT NULL
    CHECK(object_type IN ('application', 'final_review', 'disposition')),
  object_id INTEGER NOT NULL
    CHECK(typeof(object_id) = 'integer' AND object_id > 0),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'opened', 'withdrawn', 'closed', 'reopened', 'disposition_recorded',
    'review_drafted', 'review_updated', 'review_confirmed',
    'review_reopened', 'review_superseded'
  )),
  request_id TEXT NOT NULL UNIQUE CHECK(
    LENGTH(request_id) BETWEEN 1 AND 128
    AND request_id NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND SUBSTR(request_id, 1, 1) GLOB '[A-Za-z0-9]'
  ),
  request_hash TEXT NOT NULL CHECK(
    LENGTH(request_hash) = 64
    AND request_hash = LOWER(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  actor_id TEXT NOT NULL CHECK(LENGTH(TRIM(actor_id)) > 0),
  reason_code TEXT NOT NULL CHECK(
    LENGTH(reason_code) BETWEEN 1 AND 80
    AND reason_code NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND SUBSTR(reason_code, 1, 1) GLOB '[A-Za-z0-9]'
  ),
  before_status TEXT,
  after_status TEXT,
  before_version INTEGER
    CHECK(before_version IS NULL OR (typeof(before_version) = 'integer' AND before_version > 0)),
  after_version INTEGER
    CHECK(after_version IS NULL OR (typeof(after_version) = 'integer' AND after_version > 0)),
  related_object_type TEXT
    CHECK(related_object_type IS NULL OR related_object_type IN ('application', 'final_review', 'disposition')),
  related_object_id INTEGER
    CHECK(related_object_id IS NULL OR (typeof(related_object_id) = 'integer' AND related_object_id > 0)),
  occurred_at TEXT NOT NULL CHECK(LENGTH(TRIM(occurred_at)) > 0),
  CHECK((related_object_type IS NULL) = (related_object_id IS NULL)),
  CHECK(
    (object_type = 'application' AND event_type IN ('opened', 'withdrawn', 'closed', 'reopened'))
    OR
    (object_type = 'final_review' AND event_type IN (
      'review_drafted', 'review_updated', 'review_confirmed',
      'review_reopened', 'review_superseded'
    ))
    OR
    (object_type = 'disposition' AND event_type = 'disposition_recorded')
  )
);

CREATE INDEX IF NOT EXISTS application_event_application_time
ON application_event(application_id, occurred_at, id);

CREATE INDEX IF NOT EXISTS application_event_object_time
ON application_event(object_type, object_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS final_review (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES application_episode(id) ON DELETE RESTRICT,
  job_profile_version_id INTEGER NOT NULL REFERENCES job_profile_version(id) ON DELETE RESTRICT,
  interview_report_id INTEGER REFERENCES interview_report_v1(id) ON DELETE SET NULL,
  interview_report_ref_id INTEGER
    CHECK(interview_report_ref_id IS NULL OR (typeof(interview_report_ref_id) = 'integer' AND interview_report_ref_id > 0)),
  interview_report_content_hash TEXT,
  interview_report_version INTEGER
    CHECK(interview_report_version IS NULL OR (typeof(interview_report_version) = 'integer' AND interview_report_version > 0)),
  status TEXT NOT NULL CHECK(status IN ('draft', 'reopened', 'confirmed', 'superseded')),
  review_json TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK(
    LENGTH(content_hash) = 64
    AND content_hash = LOWER(content_hash)
    AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  version INTEGER NOT NULL DEFAULT 1
    CHECK(typeof(version) = 'integer' AND version > 0),
  reopened_from_final_review_id INTEGER REFERENCES final_review(id) ON DELETE RESTRICT,
  reopen_reason TEXT,
  created_by TEXT NOT NULL CHECK(LENGTH(TRIM(created_by)) > 0),
  updated_by TEXT NOT NULL CHECK(LENGTH(TRIM(updated_by)) > 0),
  confirmed_by TEXT,
  confirmed_at TEXT,
  superseded_by_final_review_id INTEGER REFERENCES final_review(id) ON DELETE RESTRICT,
  superseded_at TEXT,
  created_at TEXT NOT NULL CHECK(LENGTH(TRIM(created_at)) > 0),
  updated_at TEXT NOT NULL CHECK(LENGTH(TRIM(updated_at)) > 0),
  CHECK(reopened_from_final_review_id IS NULL OR reopened_from_final_review_id <> id),
  CHECK(superseded_by_final_review_id IS NULL OR superseded_by_final_review_id <> id),
  CHECK(
    (interview_report_ref_id IS NULL
      AND interview_report_id IS NULL
      AND interview_report_content_hash IS NULL
      AND interview_report_version IS NULL)
    OR
    (interview_report_ref_id IS NOT NULL
      AND (interview_report_id IS NULL OR interview_report_id = interview_report_ref_id)
      AND interview_report_content_hash IS NOT NULL
      AND LENGTH(interview_report_content_hash) = 64
      AND interview_report_content_hash = LOWER(interview_report_content_hash)
      AND interview_report_content_hash NOT GLOB '*[^0-9a-f]*'
      AND interview_report_version IS NOT NULL)
  ),
  CHECK(
    (reopened_from_final_review_id IS NULL AND reopen_reason IS NULL)
    OR
    (reopened_from_final_review_id IS NOT NULL
      AND reopen_reason IS NOT NULL AND LENGTH(TRIM(reopen_reason)) > 0)
  ),
  CHECK(
    (status IN ('draft', 'reopened')
      AND confirmed_by IS NULL AND confirmed_at IS NULL
      AND superseded_by_final_review_id IS NULL AND superseded_at IS NULL)
    OR
    (status = 'confirmed'
      AND interview_report_ref_id IS NOT NULL
      AND confirmed_by IS NOT NULL AND LENGTH(TRIM(confirmed_by)) > 0
      AND confirmed_at IS NOT NULL AND LENGTH(TRIM(confirmed_at)) > 0
      AND superseded_by_final_review_id IS NULL AND superseded_at IS NULL)
    OR
    (status = 'superseded'
      AND interview_report_ref_id IS NOT NULL
      AND confirmed_by IS NOT NULL AND LENGTH(TRIM(confirmed_by)) > 0
      AND confirmed_at IS NOT NULL AND LENGTH(TRIM(confirmed_at)) > 0
      AND superseded_by_final_review_id IS NOT NULL
      AND superseded_at IS NOT NULL AND LENGTH(TRIM(superseded_at)) > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS final_review_one_current_editable
ON final_review(application_id)
WHERE status IN ('draft', 'reopened');

CREATE UNIQUE INDEX IF NOT EXISTS final_review_one_current_confirmed
ON final_review(application_id)
WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS final_review_application_history
ON final_review(application_id, created_at, id);

CREATE TABLE IF NOT EXISTS final_disposition (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES application_episode(id) ON DELETE RESTRICT,
  final_review_id INTEGER NOT NULL UNIQUE REFERENCES final_review(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('continue_process', 'hold', 'reject', 'talent_pool')),
  reason_code TEXT NOT NULL CHECK(
    LENGTH(reason_code) BETWEEN 1 AND 80
    AND reason_code NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND SUBSTR(reason_code, 1, 1) GLOB '[A-Za-z0-9]'
  ),
  actor_id TEXT NOT NULL CHECK(LENGTH(TRIM(actor_id)) > 0),
  request_id TEXT NOT NULL UNIQUE CHECK(
    LENGTH(request_id) BETWEEN 1 AND 128
    AND request_id NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND SUBSTR(request_id, 1, 1) GLOB '[A-Za-z0-9]'
  ),
  request_hash TEXT NOT NULL CHECK(
    LENGTH(request_hash) = 64
    AND request_hash = LOWER(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  application_before_version INTEGER NOT NULL
    CHECK(typeof(application_before_version) = 'integer' AND application_before_version > 0),
  application_after_version INTEGER NOT NULL
    CHECK(typeof(application_after_version) = 'integer'
      AND application_after_version = application_before_version + 1),
  created_at TEXT NOT NULL CHECK(LENGTH(TRIM(created_at)) > 0)
);

CREATE INDEX IF NOT EXISTS final_disposition_application_time
ON final_disposition(application_id, created_at, id);
`;

const F018_GUARDS = `
CREATE TRIGGER IF NOT EXISTS application_episode_candidate_job_insert_guard
BEFORE INSERT ON application_episode
WHEN NOT EXISTS (
  SELECT 1 FROM candidate
  WHERE internal_id = NEW.candidate_id AND job_id = NEW.job_id
)
BEGIN
  SELECT RAISE(ABORT, 'application candidate/job mismatch');
END;

CREATE TRIGGER IF NOT EXISTS application_episode_candidate_job_update_guard
BEFORE UPDATE OF candidate_id, job_id ON application_episode
WHEN NOT EXISTS (
  SELECT 1 FROM candidate
  WHERE internal_id = NEW.candidate_id AND job_id = NEW.job_id
)
BEGIN
  SELECT RAISE(ABORT, 'application candidate/job mismatch');
END;

CREATE TRIGGER IF NOT EXISTS application_episode_identity_update_guard
BEFORE UPDATE OF candidate_id, job_id, episode_no, reopened_from_application_id,
  opened_by, opened_at, created_at ON application_episode
WHEN NEW.candidate_id IS NOT OLD.candidate_id
  OR NEW.job_id IS NOT OLD.job_id
  OR NEW.episode_no IS NOT OLD.episode_no
  OR NEW.reopened_from_application_id IS NOT OLD.reopened_from_application_id
  OR NEW.opened_by IS NOT OLD.opened_by
  OR NEW.opened_at IS NOT OLD.opened_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'application episode identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS application_episode_terminal_update_guard
BEFORE UPDATE ON application_episode
WHEN OLD.status IN ('withdrawn', 'closed')
BEGIN
  SELECT RAISE(ABORT, 'terminal application episode is immutable');
END;

CREATE TRIGGER IF NOT EXISTS application_episode_sequence_insert_guard
BEFORE INSERT ON application_episode
WHEN NEW.episode_no <> COALESCE((
  SELECT MAX(existing.episode_no)
  FROM application_episode existing
  WHERE existing.candidate_id = NEW.candidate_id
    AND existing.job_id = NEW.job_id
), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'application episode number must be monotonic');
END;

CREATE TRIGGER IF NOT EXISTS application_episode_reopen_insert_guard
BEFORE INSERT ON application_episode
WHEN NEW.reopened_from_application_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM application_episode prior
    WHERE prior.id = NEW.reopened_from_application_id
      AND prior.candidate_id = NEW.candidate_id
      AND prior.job_id = NEW.job_id
      AND prior.status IN ('withdrawn', 'closed')
  )
BEGIN
  SELECT RAISE(ABORT, 'application reopen source mismatch');
END;

CREATE TRIGGER IF NOT EXISTS candidate_application_job_update_guard
BEFORE UPDATE OF job_id ON candidate
WHEN EXISTS (
  SELECT 1 FROM application_episode application
  WHERE application.candidate_id = OLD.internal_id
    AND application.job_id <> NEW.job_id
)
BEGIN
  SELECT RAISE(ABORT, 'candidate job conflicts with application history');
END;

CREATE TRIGGER IF NOT EXISTS application_event_update_guard
BEFORE UPDATE ON application_event
BEGIN
  SELECT RAISE(ABORT, 'application events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS application_event_object_insert_guard
BEFORE INSERT ON application_event
WHEN (NEW.object_type = 'application' AND NEW.object_id <> NEW.application_id)
  OR (NEW.object_type = 'final_review' AND NOT EXISTS (
    SELECT 1 FROM final_review review
    WHERE review.id = NEW.object_id AND review.application_id = NEW.application_id
  ))
  OR (NEW.object_type = 'disposition' AND NOT EXISTS (
    SELECT 1 FROM final_disposition disposition
    WHERE disposition.id = NEW.object_id AND disposition.application_id = NEW.application_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'application event object context mismatch');
END;

CREATE TRIGGER IF NOT EXISTS application_event_delete_guard
BEFORE DELETE ON application_event
BEGIN
  SELECT RAISE(ABORT, 'application events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS final_review_profile_insert_guard
BEFORE INSERT ON final_review
WHEN NOT EXISTS (
  SELECT 1
  FROM job_profile_version profile
  JOIN application_episode application ON application.id = NEW.application_id
  WHERE profile.id = NEW.job_profile_version_id
    AND profile.job_id = application.job_id
    AND profile.status = 'confirmed'
)
BEGIN
  SELECT RAISE(ABORT, 'final review requires confirmed job profile for application job');
END;

CREATE TRIGGER IF NOT EXISTS final_review_profile_update_guard
BEFORE UPDATE OF application_id, job_profile_version_id, status ON final_review
WHEN NEW.status <> 'superseded'
  AND NOT EXISTS (
  SELECT 1
  FROM job_profile_version profile
  JOIN application_episode application ON application.id = NEW.application_id
  WHERE profile.id = NEW.job_profile_version_id
    AND profile.job_id = application.job_id
    AND profile.status = 'confirmed'
)
BEGIN
  SELECT RAISE(ABORT, 'final review requires confirmed job profile for application job');
END;

CREATE TRIGGER IF NOT EXISTS final_review_report_insert_guard
BEFORE INSERT ON final_review
WHEN NEW.interview_report_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM interview_report_v1 report
    JOIN interview_session session ON session.id = report.session_id
    JOIN application_episode application ON application.id = NEW.application_id
    WHERE report.id = NEW.interview_report_id
      AND report.status = 'confirmed'
      AND session.candidate_id = application.candidate_id
      AND session.job_id = application.job_id
  )
BEGIN
  SELECT RAISE(ABORT, 'final review interview report context mismatch');
END;

CREATE TRIGGER IF NOT EXISTS final_review_report_update_guard
BEFORE UPDATE OF application_id, interview_report_id ON final_review
WHEN NEW.interview_report_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM interview_report_v1 report
    JOIN interview_session session ON session.id = report.session_id
    JOIN application_episode application ON application.id = NEW.application_id
    WHERE report.id = NEW.interview_report_id
      AND report.status = 'confirmed'
      AND session.candidate_id = application.candidate_id
      AND session.job_id = application.job_id
  )
BEGIN
  SELECT RAISE(ABORT, 'final review interview report context mismatch');
END;

CREATE TRIGGER IF NOT EXISTS final_review_confirmed_update_guard
BEFORE UPDATE ON final_review
WHEN OLD.status = 'confirmed'
  AND (
    NEW.id IS NOT OLD.id
    OR NEW.application_id IS NOT OLD.application_id
    OR NEW.job_profile_version_id IS NOT OLD.job_profile_version_id
    OR NEW.interview_report_ref_id IS NOT OLD.interview_report_ref_id
    OR NEW.interview_report_content_hash IS NOT OLD.interview_report_content_hash
    OR NEW.interview_report_version IS NOT OLD.interview_report_version
    OR NEW.review_json IS NOT OLD.review_json
    OR NEW.content_hash IS NOT OLD.content_hash
    OR NEW.reopened_from_final_review_id IS NOT OLD.reopened_from_final_review_id
    OR NEW.reopen_reason IS NOT OLD.reopen_reason
    OR NEW.created_by IS NOT OLD.created_by
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.confirmed_by IS NOT OLD.confirmed_by
    OR NEW.confirmed_at IS NOT OLD.confirmed_at
    OR NEW.status NOT IN ('confirmed', 'superseded')
    OR (NEW.status = 'confirmed' AND (
      NEW.version IS NOT OLD.version
      OR NEW.updated_by IS NOT OLD.updated_by
      OR NEW.updated_at IS NOT OLD.updated_at
      OR NEW.superseded_by_final_review_id IS NOT OLD.superseded_by_final_review_id
      OR NEW.superseded_at IS NOT OLD.superseded_at
    ))
    OR (NEW.status = 'superseded' AND (
      NEW.version <> OLD.version + 1
      OR NEW.superseded_by_final_review_id IS NULL
      OR NEW.superseded_at IS NULL
    ))
  )
BEGIN
  SELECT RAISE(ABORT, 'confirmed final review content and context are immutable');
END;

CREATE TRIGGER IF NOT EXISTS final_review_superseded_update_guard
BEFORE UPDATE ON final_review
WHEN OLD.status = 'superseded'
  AND (
    NEW.id IS NOT OLD.id
    OR NEW.application_id IS NOT OLD.application_id
    OR NEW.job_profile_version_id IS NOT OLD.job_profile_version_id
    OR NEW.interview_report_ref_id IS NOT OLD.interview_report_ref_id
    OR NEW.interview_report_content_hash IS NOT OLD.interview_report_content_hash
    OR NEW.interview_report_version IS NOT OLD.interview_report_version
    OR NEW.status IS NOT OLD.status
    OR NEW.review_json IS NOT OLD.review_json
    OR NEW.content_hash IS NOT OLD.content_hash
    OR NEW.version IS NOT OLD.version
    OR NEW.reopened_from_final_review_id IS NOT OLD.reopened_from_final_review_id
    OR NEW.reopen_reason IS NOT OLD.reopen_reason
    OR NEW.created_by IS NOT OLD.created_by
    OR NEW.updated_by IS NOT OLD.updated_by
    OR NEW.confirmed_by IS NOT OLD.confirmed_by
    OR NEW.confirmed_at IS NOT OLD.confirmed_at
    OR NEW.superseded_by_final_review_id IS NOT OLD.superseded_by_final_review_id
    OR NEW.superseded_at IS NOT OLD.superseded_at
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.updated_at IS NOT OLD.updated_at
  )
BEGIN
  SELECT RAISE(ABORT, 'superseded final review is immutable');
END;

CREATE TRIGGER IF NOT EXISTS final_review_delete_guard
BEFORE DELETE ON final_review
BEGIN
  SELECT RAISE(ABORT, 'final reviews are append-only');
END;

CREATE TRIGGER IF NOT EXISTS final_disposition_review_insert_guard
BEFORE INSERT ON final_disposition
WHEN NOT EXISTS (
  SELECT 1 FROM final_review review
  WHERE review.id = NEW.final_review_id
    AND review.application_id = NEW.application_id
    AND review.status = 'confirmed'
)
BEGIN
  SELECT RAISE(ABORT, 'final disposition requires confirmed final review');
END;

CREATE TRIGGER IF NOT EXISTS final_disposition_update_guard
BEFORE UPDATE ON final_disposition
BEGIN
  SELECT RAISE(ABORT, 'final dispositions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS final_disposition_delete_guard
BEFORE DELETE ON final_disposition
BEGIN
  SELECT RAISE(ABORT, 'final dispositions are immutable');
END;
`;

function applyF018SchemaMigration(database) {
  if (!database || typeof database.exec !== 'function' || typeof database.transaction !== 'function') {
    throw new Error('database is required');
  }
  database.transaction(() => {
    database.exec(F018_SCHEMA);
    database.exec(F018_GUARDS);
  })();
  return { tables: [...F018_TABLES] };
}

module.exports = {
  F018_TABLES,
  F018_INDEXES,
  F018_TRIGGERS,
  F018_SCHEMA,
  F018_GUARDS,
  applyF018SchemaMigration,
};
