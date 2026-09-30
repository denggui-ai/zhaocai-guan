'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const syntheticRoot = fs.realpathSync(path.resolve(process.argv[2] || ''));
const candidateCount = Number(process.argv[3]);
const dataRoot = path.join(syntheticRoot, 'data');
const resultPath = path.join(syntheticRoot, 'database-result.json');

assert.ok([100, 500, 1000].includes(candidateCount), 'candidate count must be 100, 500, or 1000');
fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(dataRoot, 0o700);

process.env.BOSS_DB_PATH = path.join(dataRoot, 'recruiting.db');
process.env.HRBOSS_DATA_DIR = dataRoot;
process.env.HRBOSS_F018_ENABLED = '1';
process.env.HRBOSS_EXTERNAL_AI_ENABLED = '0';
process.env.BOSS_ACTION_AUTOMATION_ENABLED = '0';

const db = require("../../../src/db");

function elapsedMs(started) {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function measure(operation) {
  const started = process.hrtime.bigint();
  const value = operation();
  return { value, duration_ms: Number(elapsedMs(started).toFixed(3)) };
}

function run() {
  db.openDb(process.env.BOSS_DB_PATH);
  const job = db.upsertJob({
    encrypt_job_id: `b14-synthetic-scale-${candidateCount}`,
    numeric_job_id: `940260729${String(candidateCount).padStart(3, '0')}`,
    name: `B-14 ${candidateCount} 人合成性能岗位`,
    hr_owner: 'B-14 合成 HR',
    source_type: 'local_manual',
    status: 'open',
  });
  const database = db.conn();
  const insert = database.prepare(`
    INSERT INTO candidate (
      internal_id, job_id, geek_id, source, rec_position, name,
      degree, school, work_years, geek_desc, sabc, sabc_source,
      comm_status, disposition_status, communication_code, disposition_code,
      workflow_version, created_at, updated_at
    ) VALUES (
      @internal_id, @job_id, @geek_id, 'manual_resume', @rec_position, @name,
      '本科', @school, @work_years, @geek_desc, @sabc, 'manual_hr',
      '未打招呼', '新入库', 'not_contacted', 'new',
      1, @created_at, @updated_at
    )
  `);
  const insertCandidates = database.transaction(() => {
    for (let index = 1; index <= candidateCount; index += 1) {
      const suffix = String(index).padStart(4, '0');
      const at = new Date(Date.UTC(2026, 6, 29, 8, 0, index % 60, index)).toISOString();
      insert.run({
        internal_id: `B14-SCALE-${candidateCount}-${suffix}`,
        job_id: job.id,
        geek_id: `b14-scale-${candidateCount}-${suffix}`,
        rec_position: job.name,
        name: index === candidateCount
          ? `B-14 唯一命中 ${candidateCount}`
          : `B-14 合成候选人 ${suffix}`,
        school: `B-14 合成大学 ${String((index % 20) + 1).padStart(2, '0')}`,
        work_years: String((index % 15) + 1),
        geek_desc: `纯合成性能样本 ${suffix}，不含真实候选人数据。`,
        sabc: ['S', 'A', 'B', 'C'][index % 4],
        created_at: at,
        updated_at: at,
      });
    }
  });
  insertCandidates();

  const listCold = measure(() => db.listCandidates(job.id));
  const listWarm = measure(() => db.listCandidates(job.id));
  const workbench = measure(() => db.getJobWorkbench(job.id));
  assert.equal(listCold.value.length, candidateCount);
  assert.equal(listWarm.value.length, candidateCount);
  assert.equal(workbench.value.metrics.candidate_count, candidateCount);
  assert.equal(workbench.value.candidates.length, candidateCount);
  assert.equal(new Set(listWarm.value.map((candidate) => candidate.internal_id)).size, candidateCount);

  const result = {
    ok: true,
    evidence_level: 'E4',
    runtime_boundary: 'real temporary SQLite/WAL through production db.js projections',
    synthetic_data_only: true,
    candidate_count: candidateCount,
    job_id: job.id,
    list_candidates: {
      cold_ms: listCold.duration_ms,
      warm_ms: listWarm.duration_ms,
      payload_bytes: Buffer.byteLength(JSON.stringify(listWarm.value)),
      returned_count: listWarm.value.length,
    },
    workbench: {
      duration_ms: workbench.duration_ms,
      payload_bytes: Buffer.byteLength(JSON.stringify(workbench.value)),
      candidate_count: workbench.value.metrics.candidate_count,
      todo_count: workbench.value.todos.length,
    },
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(resultPath, 0o600);
  database.close();
  console.log(JSON.stringify(result));
}

try {
  run();
} catch (error) {
  try {
    const database = db.conn();
    if (database && database.open) database.close();
  } catch {}
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
