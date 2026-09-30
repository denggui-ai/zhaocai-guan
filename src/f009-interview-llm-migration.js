const F009_TABLES = Object.freeze(['interview_llm_request_audit']);
const DEFAULT_BASE_URL = ''; // Legacy rows may have no recorded destination.

function auditTableSchema(tableName = 'interview_llm_request_audit') {
  return `
CREATE TABLE IF NOT EXISTS ${tableName} (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  session_id INTEGER NOT NULL REFERENCES interview_session(id) ON DELETE RESTRICT,
  material_ids_json TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_hash TEXT,
  provider TEXT NOT NULL CHECK(LENGTH(TRIM(provider)) BETWEEN 1 AND 64),
  base_url TEXT NOT NULL CHECK(base_url = '' OR LENGTH(TRIM(base_url)) BETWEEN 8 AND 2048),
  model TEXT NOT NULL,
  returned_model TEXT,
  prompt_version TEXT NOT NULL,
  prompt_hash TEXT NOT NULL DEFAULT '',
  schema_version TEXT NOT NULL CHECK(schema_version = 'interview_report_v1'),
  model_catalog_hash TEXT NOT NULL DEFAULT '',
  source_version_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN (
    'previewed', 'running', 'draft_saved', 'cancelled', 'timeout',
    'failed', 'invalid_response'
  )),
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error_code TEXT,
  report_id INTEGER REFERENCES interview_report_v1(id) ON DELETE RESTRICT,
  actor TEXT NOT NULL CHECK(LENGTH(TRIM(actor)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(duration_ms IS NULL OR duration_ms >= 0),
  CHECK(input_tokens IS NULL OR input_tokens >= 0),
  CHECK(output_tokens IS NULL OR output_tokens >= 0)
);`;
}

const F009_INDEX_SCHEMA = `
CREATE INDEX IF NOT EXISTS interview_llm_request_audit_session_created_idx
ON interview_llm_request_audit(session_id, created_at DESC);
`;

const F009_SCHEMA = `${auditTableSchema()}\n${F009_INDEX_SCHEMA}`;

function rebuildConfigurableProviderTable(database, columns) {
  const temporaryTable = 'interview_llm_request_audit_configurable_new';
  const expression = (name, fallbackSql) => columns.has(name) ? name : fallbackSql;
  const migrate = () => {
    database.exec(`DROP TABLE IF EXISTS ${temporaryTable};`);
    database.exec(auditTableSchema(temporaryTable));
    database.exec(`
      INSERT INTO ${temporaryTable} (
        id, request_id, session_id, material_ids_json, request_hash, response_hash,
        provider, base_url, model, returned_model, prompt_version, prompt_hash,
        schema_version, model_catalog_hash, source_version_hash, status,
        duration_ms, input_tokens, output_tokens, error_code, report_id,
        actor, created_at, updated_at
      )
      SELECT
        id, request_id, session_id, material_ids_json, request_hash, response_hash,
        provider, ${expression('base_url', `'${DEFAULT_BASE_URL}'`)}, model, returned_model,
        prompt_version, ${expression('prompt_hash', "''")}, schema_version,
        ${expression('model_catalog_hash', "''")}, ${expression('source_version_hash', "''")}, status,
        duration_ms, input_tokens, output_tokens, error_code, report_id,
        actor, created_at, updated_at
      FROM interview_llm_request_audit;
      DROP TABLE interview_llm_request_audit;
      ALTER TABLE ${temporaryTable} RENAME TO interview_llm_request_audit;
    `);
    database.exec(F009_INDEX_SCHEMA);
  };
  if (database.inTransaction) migrate();
  else database.transaction(migrate)();
}

function applyF009InterviewLlmMigration(database) {
  if (!database || typeof database.exec !== 'function') throw new Error('database is required');
  database.exec(auditTableSchema());
  let columns = new Set(database.prepare('PRAGMA table_info(interview_llm_request_audit)').all().map((row) => row.name));
  const tableSql = String((database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='interview_llm_request_audit'").get() || {}).sql || '');
  if (!columns.has('base_url') || /CHECK\s*\(\s*provider\s*=\s*'[^']+'\s*\)/i.test(tableSql)) {
    rebuildConfigurableProviderTable(database, columns);
    columns = new Set(database.prepare('PRAGMA table_info(interview_llm_request_audit)').all().map((row) => row.name));
  }
  if (!columns.has('prompt_hash')) database.exec("ALTER TABLE interview_llm_request_audit ADD COLUMN prompt_hash TEXT NOT NULL DEFAULT ''; ");
  if (!columns.has('model_catalog_hash')) database.exec("ALTER TABLE interview_llm_request_audit ADD COLUMN model_catalog_hash TEXT NOT NULL DEFAULT ''; ");
  if (!columns.has('source_version_hash')) database.exec("ALTER TABLE interview_llm_request_audit ADD COLUMN source_version_hash TEXT NOT NULL DEFAULT ''; ");
  database.exec(F009_INDEX_SCHEMA);
  return { tables: [...F009_TABLES] };
}

function rollbackF009InterviewLlmMigration(database) {
  if (!database || typeof database.exec !== 'function') throw new Error('database is required');
  database.exec('DROP TABLE IF EXISTS interview_llm_request_audit;');
  return { dropped_tables: [...F009_TABLES] };
}

module.exports = {
  F009_TABLES,
  F009_SCHEMA,
  DEFAULT_BASE_URL,
  applyF009InterviewLlmMigration,
  rollbackF009InterviewLlmMigration,
};
