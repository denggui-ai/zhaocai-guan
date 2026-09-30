const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { rollbackF006InterviewSessionMigration } = require('./f006-interview-session-migration');

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

async function rollbackWithRecoveryPoint({ dbPath, recoveryPointPath }) {
  const source = path.resolve(String(dbPath || ''));
  const recovery = path.resolve(String(recoveryPointPath || ''));
  if (!dbPath || !recoveryPointPath) throw new Error('--db and --recovery-point are required');
  if (source === recovery) throw new Error('recovery point must be different from the database path');
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw new Error('--db must point to an existing SQLite file');
  if (fs.existsSync(recovery)) throw new Error('recovery point already exists; refusing to overwrite it');
  fs.mkdirSync(path.dirname(recovery), { recursive: true });

  const database = new Database(source);
  try {
    database.pragma('foreign_keys = ON');
    await database.backup(recovery);
    const result = rollbackF006InterviewSessionMigration(database);
    return { database: source, recovery_point: recovery, ...result };
  } finally {
    database.close();
  }
}

if (require.main === module) {
  rollbackWithRecoveryPoint({
    dbPath: argumentValue(process.argv.slice(2), '--db'),
    recoveryPointPath: argumentValue(process.argv.slice(2), '--recovery-point'),
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`F-006 rollback failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { rollbackWithRecoveryPoint };
