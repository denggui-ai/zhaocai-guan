const assert = require('assert');
const Database = require('better-sqlite3');
const {
  F018_TABLES,
  applyF018SchemaMigration,
} = require('./f018-schema');
const {
  F018ApplicationError,
  createF018ApplicationService,
  backfillLegacyCandidates,
} = require('./f018-application-service');

const NOW = '2026-07-12T08:00:00.000Z';

function createSyntheticDatabase() {
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
      job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
      disposition_code TEXT,
      disposition_status TEXT,
      sabc TEXT,
      quality_score INTEGER,
      raw_json TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    INSERT INTO job (id, name) VALUES
      (1, '合成岗位一'),
      (2, '合成岗位二');

    INSERT INTO candidate (
      internal_id, job_id, disposition_code, disposition_status,
      sabc, quality_score, raw_json, created_at, updated_at
    ) VALUES
      ('C-OPEN', 1, 'new', '新入库', 'S', 91, '{"synthetic":"open"}', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z'),
      ('C-OTHER-JOB', 2, 'under_review', '待处理', 'A', 82, '{"synthetic":"other"}', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z');
  `);
  return database;
}

function expectCode(fn, code, path) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof F018ApplicationError, `expected F018ApplicationError, got ${error && error.stack}`);
    assert.equal(error.code, code);
    if (path) assert.equal(error.path, path);
    return true;
  });
}

function schemaObjects(database) {
  return database.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE name LIKE 'application_%'
       OR name LIKE 'final_review%'
       OR name LIKE 'final_disposition%'
       OR name LIKE 'candidate_application_%'
    ORDER BY type, name
  `).all();
}

function checkSchemaAndDataGuards() {
  const database = createSyntheticDatabase();
  const first = applyF018SchemaMigration(database);
  assert.deepEqual(first.tables, [...F018_TABLES]);
  const names = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (${F018_TABLES.map(() => '?').join(',')})
    ORDER BY name
  `).all(...F018_TABLES).map((row) => row.name);
  assert.deepEqual(names, [...F018_TABLES].sort());

  const before = schemaObjects(database);
  applyF018SchemaMigration(database);
  assert.deepEqual(schemaObjects(database), before, 'schema migration must be idempotent');

  assert.throws(() => database.prepare(`
    INSERT INTO application_episode (
      candidate_id, job_id, episode_no, status, version,
      opened_by, opened_at, created_at, updated_at
    ) VALUES ('C-OPEN', 2, 1, 'active', 1, 'server-actor', ?, ?, ?)
  `).run(NOW, NOW, NOW), /application candidate\/job mismatch/);

  database.prepare(`
    INSERT INTO application_episode (
      candidate_id, job_id, episode_no, status, version,
      opened_by, opened_at, created_at, updated_at
    ) VALUES ('C-OPEN', 1, 1, 'active', 1, 'server-actor', ?, ?, ?)
  `).run(NOW, NOW, NOW);
  assert.throws(() => database.prepare(`
    INSERT INTO application_episode (
      candidate_id, job_id, episode_no, status, version,
      opened_by, opened_at, created_at, updated_at
    ) VALUES ('C-OPEN', 1, 2, 'active', 1, 'server-actor', ?, ?, ?)
  `).run(NOW, NOW, NOW), /CHECK constraint failed|reopen source mismatch/);
  assert.ok(database.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'index' AND name = 'application_episode_one_active_context'
  `).get(), 'active uniqueness must be enforced by a partial unique index');
  assert.throws(() => database.prepare("UPDATE candidate SET job_id = 2 WHERE internal_id = 'C-OPEN'").run(), /candidate job conflicts/);
  database.close();
}

function checkLegacyBackfill() {
  const database = createSyntheticDatabase();
  database.exec(`
    INSERT INTO candidate (
      internal_id, job_id, disposition_code, disposition_status,
      sabc, quality_score, raw_json, created_at, updated_at
    ) VALUES
      ('C-BACKFILL-ACTIVE', 1, 'interview_requested', '待约面', 'B', 70, '{"private":"unchanged-active"}', '2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z'),
      ('C-BACKFILL-REJECT', 1, 'rejected', '淘汰', 'C', 60, '{"private":"unchanged-reject"}', '2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z'),
      ('C-BACKFILL-HIRED', 1, 'hired', '已入职', 'S', 95, '{"private":"unchanged-hired"}', '2026-04-01T00:00:00.000Z', '2026-04-02T00:00:00.000Z'),
      ('C-BACKFILL-POOL', 1, NULL, '备选', 'A', 80, '{"private":"unchanged-pool"}', '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z'),
      ('C-BACKFILL-DNC', 1, 'do_not_contact', '不再联系', 'D', 40, '{"private":"unchanged-dnc"}', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z'),
      ('C-BACKFILL-WITHDREW', 1, 'candidate_withdrew', '主动放弃', 'B', 65, '{"private":"unchanged-withdrew"}', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
      ('C-BACKFILL-OLD-WITHDREW', 1, 'do_not_contact', '主动放弃', 'B', 64, '{"private":"unchanged-old-withdrew"}', '2025-12-01T00:00:00.000Z', '2025-12-02T00:00:00.000Z');
  `);
  const candidateBefore = database.prepare('SELECT * FROM candidate ORDER BY internal_id').all();
  applyF018SchemaMigration(database);
  const first = backfillLegacyCandidates({
    database,
    actorContext: { actor_id: 'server-migration-principal' },
    now: () => NOW,
  });
  assert.deepEqual(first, { scanned: 9, created: 9, active: 3, closed: 6, events: 15 });
  assert.deepEqual(database.prepare('SELECT * FROM candidate ORDER BY internal_id').all(), candidateBefore,
    'legacy backfill must not mutate any candidate column');

  const active = database.prepare("SELECT * FROM application_episode WHERE candidate_id = 'C-BACKFILL-ACTIVE'").get();
  assert.equal(active.episode_no, 1);
  assert.equal(active.status, 'active');
  assert.equal(active.version, 1);
  const rejected = database.prepare("SELECT * FROM application_episode WHERE candidate_id = 'C-BACKFILL-REJECT'").get();
  assert.equal(rejected.status, 'closed');
  assert.equal(rejected.version, 2);
  assert.equal(rejected.ended_by, 'server-migration-principal');
  assert.deepEqual(database.prepare(`
    SELECT event_type, before_status, after_status, before_version, after_version
    FROM application_event WHERE application_id = ? ORDER BY id
  `).all(rejected.id), [
    { event_type: 'opened', before_status: null, after_status: 'active', before_version: null, after_version: 1 },
    { event_type: 'closed', before_status: 'active', after_status: 'closed', before_version: 1, after_version: 2 },
  ]);
  assert.equal(database.prepare("SELECT status FROM application_episode WHERE candidate_id = 'C-BACKFILL-WITHDREW'").get().status, 'closed');
  assert.equal(database.prepare("SELECT status FROM application_episode WHERE candidate_id = 'C-BACKFILL-OLD-WITHDREW'").get().status, 'closed');

  const eventCount = database.prepare('SELECT COUNT(*) AS count FROM application_event').get().count;
  const second = backfillLegacyCandidates({ database, actorContext: { actor_id: 'server-migration-principal' }, now: () => NOW });
  assert.deepEqual(second, { scanned: 9, created: 0, active: 0, closed: 0, events: 0 });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM application_event').get().count, eventCount,
    'repeat backfill must not duplicate events');
  database.close();
}

function checkApplicationLifecycleAndIdempotency() {
  const database = createSyntheticDatabase();
  applyF018SchemaMigration(database);
  const service = createF018ApplicationService({
    database,
    actorContext: { actor_id: 'server-local-principal' },
    now: () => NOW,
  });

  expectCode(() => service.openApplication({
    candidate_id: 'C-OPEN', job_id: 2, request_id: 'REQ-WRONG-JOB', reason_code: 'manual_open',
  }), 'CANDIDATE_JOB_MISMATCH', '$.command.job_id');
  expectCode(() => service.openApplication({
    candidate_id: 'C-OPEN', job_id: 1, request_id: 'REQ-ACTOR-INJECTION', reason_code: 'manual_open', actor_id: 'renderer',
  }), 'UNSUPPORTED_FIELD', '$.command.actor_id');
  expectCode(() => service.openApplication({
    candidate_id: 'C-OPEN', job_id: 1, request_id: 'REQ-ROLE-INJECTION', reason_code: 'manual_open', role: 'admin',
  }), 'UNSUPPORTED_FIELD', '$.command.role');

  const opened = service.openApplication({
    candidate_id: 'C-OPEN', job_id: 1, request_id: 'REQ-OPEN-1', reason_code: 'manual_open',
  });
  assert.equal(opened.status, 'active');
  assert.equal(opened.episode_no, 1);
  assert.equal(opened.version, 1);
  assert.equal(opened.opened_by, 'server-local-principal');
  assert.equal(opened.replayed, false);
  const replayedOpen = service.openApplication({
    candidate_id: 'C-OPEN', job_id: 1, request_id: 'REQ-OPEN-1', reason_code: 'manual_open',
  });
  assert.equal(replayedOpen.id, opened.id);
  assert.equal(replayedOpen.replayed, true);
  expectCode(() => service.openApplication({
    candidate_id: 'C-OPEN', job_id: 1, request_id: 'REQ-OPEN-1', reason_code: 'different_reason',
  }), 'REQUEST_ID_REUSED', '$.command.request_id');
  expectCode(() => service.openApplication({
    candidate_id: 'C-OPEN', job_id: 1, request_id: 'REQ-OPEN-2', reason_code: 'manual_open',
  }), 'ACTIVE_APPLICATION_EXISTS');

  expectCode(() => service.closeApplication({
    application_id: opened.id, expected_version: 2, request_id: 'REQ-CLOSE-STALE', reason_code: 'manual_close',
  }), 'STALE_VERSION', '$.command.expected_version');
  const closed = service.closeApplication({
    application_id: opened.id, expected_version: 1, request_id: 'REQ-CLOSE-1', reason_code: 'manual_close',
  });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.version, 2);
  assert.equal(closed.ended_by, 'server-local-principal');
  assert.throws(() => database.prepare(`
    UPDATE application_episode
    SET status = 'active', ended_by = NULL, ended_at = NULL, version = version + 1
    WHERE id = ?
  `).run(closed.id), /terminal application episode is immutable/);
  assert.equal(service.closeApplication({
    application_id: opened.id, expected_version: 1, request_id: 'REQ-CLOSE-1', reason_code: 'manual_close',
  }).replayed, true);
  expectCode(() => service.withdrawApplication({
    application_id: opened.id, expected_version: 1, request_id: 'REQ-WITHDRAW-LOSER', reason_code: 'manual_withdraw',
  }), 'STALE_VERSION', '$.command.expected_version');
  expectCode(() => service.openApplication({
    candidate_id: 'C-OPEN', job_id: 1, request_id: 'REQ-OPEN-AFTER-CLOSE', reason_code: 'manual_open',
  }), 'REENTRY_REQUIRED');

  const episode2 = service.reenterApplication({
    application_id: closed.id, expected_version: 2, request_id: 'REQ-REENTER-1', reason_code: 'candidate_reapplied',
  });
  assert.equal(episode2.status, 'active');
  assert.equal(episode2.episode_no, 2);
  assert.equal(episode2.reopened_from_application_id, closed.id);
  assert.equal(service.reenterApplication({
    application_id: closed.id, expected_version: 2, request_id: 'REQ-REENTER-1', reason_code: 'candidate_reapplied',
  }).replayed, true);
  expectCode(() => service.reenterApplication({
    application_id: closed.id, expected_version: 2, request_id: 'REQ-REENTER-ACTIVE-CONFLICT', reason_code: 'candidate_reapplied',
  }), 'ACTIVE_APPLICATION_EXISTS');

  const withdrawn = service.withdrawApplication({
    application_id: episode2.id, expected_version: 1, request_id: 'REQ-WITHDRAW-2', reason_code: 'candidate_withdrew',
  });
  assert.equal(withdrawn.status, 'withdrawn');
  assert.equal(withdrawn.version, 2);
  const episode3 = service.reenterApplication({
    application_id: withdrawn.id, expected_version: 2, request_id: 'REQ-REENTER-2', reason_code: 'candidate_reapplied',
  });
  assert.equal(episode3.episode_no, 3);
  assert.equal(episode3.reopened_from_application_id, withdrawn.id);

  const listed = service.listApplications({ candidate_id: 'C-OPEN', job_id: 1 });
  assert.deepEqual(listed.map((row) => row.episode_no), [3, 2, 1]);
  assert.ok(listed.every((row) => !Object.hasOwn(row, 'request_hash')));
  const events = service.listApplicationEvents(episode2.id);
  assert.deepEqual(events.map((row) => row.event_type), ['reopened', 'withdrawn']);
  assert.ok(events.every((row) => !Object.hasOwn(row, 'request_hash')));
  assert.ok(events.every((row) => row.actor_id === 'server-local-principal'));

  assert.throws(() => database.prepare("UPDATE application_event SET reason_code = 'tampered' WHERE id = 1").run(), /append-only/);
  assert.throws(() => database.prepare('DELETE FROM application_event WHERE id = 1').run(), /append-only/);
  assert.throws(() => database.prepare(`
    INSERT INTO application_episode (
      candidate_id, job_id, episode_no, status, reopened_from_application_id,
      version, opened_by, opened_at, created_at, updated_at
    ) VALUES ('C-OTHER-JOB', 2, 1, 'active', ?, 1, 'server-local-principal', ?, ?, ?)
  `).run(closed.id, NOW, NOW, NOW), /application reopen source mismatch/);

  const eventColumns = database.prepare("PRAGMA table_info('application_event')").all().map((row) => row.name);
  assert.equal(eventColumns.some((name) => /name|resume|raw_json|optional_evidence/i.test(name)), false,
    'application events must not copy candidate body or optional evidence content');
  database.close();
}

function checkClosedJobAndHiredGuards() {
  const database = createSyntheticDatabase();
  database.prepare(`
    INSERT INTO candidate (
      internal_id, job_id, disposition_code, disposition_status,
      sabc, quality_score, raw_json, created_at, updated_at
    ) VALUES (?, 2, 'hired', '已入职', 'S', 95, ?, ?, ?)
  `).run('C-HIRED', '{"synthetic":"hired"}', NOW, NOW);
  applyF018SchemaMigration(database);
  const service = createF018ApplicationService({
    database,
    actorContext: { actor_id: 'server-local-principal' },
    now: () => NOW,
  });

  database.prepare("UPDATE job SET status = 'closed' WHERE id = 1").run();
  const beforeClosedOpen = {
    applications: database.prepare('SELECT COUNT(*) AS count FROM application_episode').get().count,
    events: database.prepare('SELECT COUNT(*) AS count FROM application_event').get().count,
  };
  expectCode(() => service.openApplication({
    candidate_id: 'C-OPEN', job_id: 1, request_id: 'REQ-CLOSED-OPEN', reason_code: 'manual_open',
  }), 'JOB_CLOSED', '$.command.candidate_id');
  assert.deepEqual({
    applications: database.prepare('SELECT COUNT(*) AS count FROM application_episode').get().count,
    events: database.prepare('SELECT COUNT(*) AS count FROM application_event').get().count,
  }, beforeClosedOpen, 'closed-job open must fail before any application or event write');

  database.prepare("UPDATE job SET status = 'open' WHERE id = 1").run();
  const opened = service.openApplication({
    candidate_id: 'C-OPEN', job_id: 1, request_id: 'REQ-CLEANUP-OPEN', reason_code: 'manual_open',
  });
  database.prepare("UPDATE job SET status = 'closed' WHERE id = 1").run();
  const beforeClosedTransitions = {
    application: database.prepare('SELECT * FROM application_episode WHERE id = ?').get(opened.id),
    events: database.prepare('SELECT COUNT(*) AS count FROM application_event').get().count,
  };
  assert.equal(service.openApplication({
    candidate_id: 'C-OPEN', job_id: 1, request_id: 'REQ-CLEANUP-OPEN', reason_code: 'manual_open',
  }).replayed, true, 'an already-committed idempotent replay remains readable after job close');
  assert.deepEqual(database.prepare('SELECT * FROM application_episode WHERE id = ?').get(opened.id),
    beforeClosedTransitions.application, 'closed-job idempotent replay must be zero-write');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM application_event').get().count,
    beforeClosedTransitions.events, 'closed-job idempotent replay must not append events');
  expectCode(() => service.closeApplication({
    application_id: opened.id, expected_version: opened.version,
    request_id: 'REQ-CLOSED-JOB-CLOSE', reason_code: 'manual_close',
  }), 'JOB_CLOSED', '$.command.application_id');
  expectCode(() => service.withdrawApplication({
    application_id: opened.id, expected_version: opened.version,
    request_id: 'REQ-CLOSED-JOB-WITHDRAW', reason_code: 'candidate_withdrew',
  }), 'JOB_CLOSED', '$.command.application_id');
  assert.deepEqual(database.prepare('SELECT * FROM application_episode WHERE id = ?').get(opened.id),
    beforeClosedTransitions.application, 'closed-job close and withdraw must not mutate the application');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM application_event').get().count,
    beforeClosedTransitions.events, 'closed-job close and withdraw must not append events');

  database.prepare("UPDATE job SET status = 'open' WHERE id = 1").run();
  const closed = service.closeApplication({
    application_id: opened.id, expected_version: opened.version,
    request_id: 'REQ-REOPENED-JOB-CLOSE', reason_code: 'manual_close',
  });
  assert.equal(closed.status, 'closed', 'reopening the job restores application close');
  database.prepare("UPDATE job SET status = 'closed' WHERE id = 1").run();
  const closeReplayEventCount = database.prepare('SELECT COUNT(*) AS count FROM application_event').get().count;
  assert.equal(service.closeApplication({
    application_id: opened.id, expected_version: opened.version,
    request_id: 'REQ-REOPENED-JOB-CLOSE', reason_code: 'manual_close',
  }).replayed, true, 'an already-committed transition replay remains readable after job close');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM application_event').get().count, closeReplayEventCount,
    'closed-job transition replay must not append events');
  const beforeClosedReentry = {
    applications: database.prepare('SELECT COUNT(*) AS count FROM application_episode').get().count,
    events: database.prepare('SELECT COUNT(*) AS count FROM application_event').get().count,
  };
  expectCode(() => service.reenterApplication({
    application_id: closed.id, expected_version: closed.version,
    request_id: 'REQ-CLOSED-REENTER', reason_code: 'candidate_reapplied',
  }), 'JOB_CLOSED', '$.command.application_id');
  assert.deepEqual({
    applications: database.prepare('SELECT COUNT(*) AS count FROM application_episode').get().count,
    events: database.prepare('SELECT COUNT(*) AS count FROM application_event').get().count,
  }, beforeClosedReentry, 'closed-job reentry must fail before any application or event write');
  assert.equal(service.listApplications({ candidate_id: 'C-OPEN', job_id: 1 }).length, 1,
    'closed-job application history must remain readable');
  assert.deepEqual(service.listApplicationEvents(closed.id).map((event) => event.event_type), ['opened', 'closed'],
    'closed-job event history must remain readable');

  database.prepare("UPDATE job SET status = 'open' WHERE id = 1").run();
  const reopened = service.reenterApplication({
    application_id: closed.id, expected_version: closed.version,
    request_id: 'REQ-OPEN-JOB-REENTER', reason_code: 'candidate_reapplied',
  });
  assert.equal(reopened.status, 'active', 'reopening the job restores reentry');

  const hiredBefore = database.prepare("SELECT * FROM candidate WHERE internal_id = 'C-HIRED'").get();
  const beforeHiredOpen = {
    applications: database.prepare('SELECT COUNT(*) AS count FROM application_episode').get().count,
    events: database.prepare('SELECT COUNT(*) AS count FROM application_event').get().count,
  };
  expectCode(() => service.openApplication({
    candidate_id: 'C-HIRED', job_id: 2, request_id: 'REQ-HIRED-OPEN', reason_code: 'manual_open',
  }), 'HIRED_FORBIDDEN', '$.command.candidate_id');
  assert.deepEqual(database.prepare("SELECT * FROM candidate WHERE internal_id = 'C-HIRED'").get(), hiredBefore,
    'hired guard must not rewrite the candidate');
  assert.deepEqual({
    applications: database.prepare('SELECT COUNT(*) AS count FROM application_episode').get().count,
    events: database.prepare('SELECT COUNT(*) AS count FROM application_event').get().count,
  }, beforeHiredOpen, 'hired open must fail before any application or event write');

  const withdrawnAfterReopen = service.withdrawApplication({
    application_id: reopened.id, expected_version: reopened.version,
    request_id: 'REQ-REOPENED-JOB-WITHDRAW', reason_code: 'candidate_withdrew',
  });
  assert.equal(withdrawnAfterReopen.status, 'withdrawn', 'reopening the job restores application withdraw');
  database.prepare(`
    UPDATE candidate SET disposition_code = 'hired', disposition_status = '已入职'
    WHERE internal_id = 'C-OPEN'
  `).run();
  const closedForHired = service.listApplications({ candidate_id: 'C-OPEN', job_id: 1 })[0];
  const beforeHiredReentry = database.prepare('SELECT COUNT(*) AS count FROM application_episode').get().count;
  expectCode(() => service.reenterApplication({
    application_id: closedForHired.id, expected_version: closedForHired.version,
    request_id: 'REQ-HIRED-REENTER', reason_code: 'candidate_reapplied',
  }), 'HIRED_FORBIDDEN', '$.command.application_id');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM application_episode').get().count, beforeHiredReentry,
    'hired reentry must not create a new episode');
  assert.equal(database.prepare("SELECT disposition_code FROM candidate WHERE internal_id = 'C-OPEN'").get().disposition_code, 'hired');
  database.close();
}

checkSchemaAndDataGuards();
checkLegacyBackfill();
checkApplicationLifecycleAndIdempotency();
checkClosedJobAndHiredGuards();

console.log(JSON.stringify({
  ok: true,
  synthetic_only: true,
  tables: F018_TABLES,
  checks: [
    'four-table schema and idempotent migration',
    'candidate/job data-layer guards and one active application',
    'legacy episode-1 backfill without candidate mutation',
    'open/withdraw/close/reenter monotonic episodes',
    'expected-version conflict and request-id idempotency',
    'server actor isolation and append-only events',
    'closed-job all-write gate with history preserved and reopen recovery',
    'hired terminal guard without candidate mutation',
  ],
}, null, 2));
