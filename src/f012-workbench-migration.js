const F012_TABLES = Object.freeze([
  'job_jd_version',
  'job_profile_version',
]);

const F012_SCHEMA = `
CREATE TABLE IF NOT EXISTS job_jd_version (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version > 0),
  status TEXT NOT NULL CHECK(status IN ('draft', 'active', 'superseded')),
  source TEXT NOT NULL CHECK(source IN ('manual', 'boss_sync')),
  jd_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK(LENGTH(TRIM(created_by)) > 0),
  created_at TEXT NOT NULL,
  activated_by TEXT,
  activated_at TEXT,
  superseded_at TEXT,
  UNIQUE(job_id, version),
  CHECK(
    (status = 'draft' AND activated_by IS NULL AND activated_at IS NULL AND superseded_at IS NULL)
    OR (status = 'active' AND activated_by IS NOT NULL AND activated_at IS NOT NULL AND superseded_at IS NULL)
    OR (status = 'superseded' AND superseded_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS job_profile_version (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
  jd_version_id INTEGER NOT NULL REFERENCES job_jd_version(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version > 0),
  status TEXT NOT NULL CHECK(status IN ('draft', 'confirmed', 'superseded')),
  config_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('manual', 'hiring_manager_interview')),
  source_ref_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL CHECK(LENGTH(TRIM(created_by)) > 0),
  created_at TEXT NOT NULL,
  confirmed_by TEXT,
  confirmed_at TEXT,
  superseded_at TEXT,
  UNIQUE(job_id, version),
  CHECK(
    (status = 'draft' AND confirmed_by IS NULL AND confirmed_at IS NULL AND superseded_at IS NULL)
    OR (status = 'confirmed' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL AND superseded_at IS NULL)
    OR (status = 'superseded' AND superseded_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS job_jd_version_one_active
ON job_jd_version(job_id)
WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS job_profile_version_one_confirmed
ON job_profile_version(job_id)
WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS job_jd_version_job_status_idx
ON job_jd_version(job_id, status, version DESC);

CREATE INDEX IF NOT EXISTS job_profile_version_job_status_idx
ON job_profile_version(job_id, status, version DESC);
`;

function addColumn(database, table, name, type) {
  const columns = new Set(database.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name));
  if (!columns.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}

function applyF012WorkbenchMigration(database) {
  if (!database || typeof database.exec !== 'function') throw new Error('database is required');
  database.transaction(() => {
    database.exec(F012_SCHEMA);
    addColumn(database, 'candidate', 'communication_code', 'TEXT');
    addColumn(database, 'candidate', 'disposition_code', 'TEXT');
    addColumn(database, 'candidate', 'workflow_version', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(database, 'status_history', 'from_code', 'TEXT');
    addColumn(database, 'status_history', 'to_code', 'TEXT');
    addColumn(database, 'interview_session_schedule_confirmation', 'request_id', 'TEXT');
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS interview_session_schedule_request_id_unique
      ON interview_session_schedule_confirmation(request_id)
      WHERE request_id IS NOT NULL;
    `);
  })();
  return { tables: [...F012_TABLES] };
}

module.exports = {
  F012_TABLES,
  F012_SCHEMA,
  applyF012WorkbenchMigration,
};
