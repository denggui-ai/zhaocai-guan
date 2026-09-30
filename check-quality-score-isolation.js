const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-quality-score-isolation-'));
const TEMP_DB = path.join(TEMP_ROOT, 'fixture.db');
process.env.BOSS_DB_PATH = TEMP_DB;

const dbmod = require('./db');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
}

function formalSnapshot(jobId) {
  const { generated_at: _generatedAt, ...talentPool } = dbmod.listTalentPool({ jobId });
  return {
    candidates: dbmod.listCandidates(jobId),
    talentPool,
  };
}

async function main() {
  const database = dbmod.openDb(TEMP_DB);
  const job = dbmod.upsertJob({
    encrypt_job_id: 'fixture-quality-isolation-job',
    name: '质量分隔离合成岗位',
    created_at: '2026-07-11T08:00:00.000Z',
  }).id;
  const otherJob = dbmod.upsertJob({
    encrypt_job_id: 'fixture-quality-isolation-other-job',
    name: '跨岗位人才库合成岗位',
    created_at: '2026-07-11T08:00:00.000Z',
  }).id;

  const rows = [
    { geek_id: 'legacy-score-s', name: 'S Candidate', sabc: 'S', sabc_source: '人工', created_at: '2026-07-11T09:00:00.000Z' },
    { geek_id: 'legacy-score-a', name: 'A Candidate', sabc: 'A', sabc_source: '规则v1', created_at: '2026-07-11T10:00:00.000Z' },
    { geek_id: 'legacy-score-b', name: 'B Candidate', sabc: 'B', sabc_source: '人工', created_at: '2026-07-11T11:00:00.000Z' },
    { geek_id: 'legacy-score-none', name: 'Unrated Candidate', sabc: null, sabc_source: null, created_at: '2026-07-11T12:00:00.000Z' },
  ].map((fixture) => dbmod.upsertCandidate({
    job_id: job,
    source: 'fixture',
    geek_desc: `${fixture.name} 的合成简历证据`,
    comm_status: '未打招呼',
    disposition_status: '新入库',
    ...fixture,
  }, fixture.created_at));

  const crossJob = dbmod.upsertCandidate({
    job_id: otherJob,
    geek_id: 'legacy-score-a',
    name: 'A Candidate',
    source: 'fixture',
    geek_desc: '跨岗位合成人才证据',
    sabc: 'C',
    sabc_source: '人工',
    comm_status: '未打招呼',
    disposition_status: '新入库',
    created_at: '2026-07-10T10:00:00.000Z',
  }, '2026-07-10T10:00:00.000Z');

  for (const row of [...rows, crossJob]) {
    dbmod.insertResumeOnline({
      candidate_id: row.internal_id,
      sections_json: {
        basic: [{ description: '合成材料，不含真实候选人数据。' }],
        work: [{ company: 'Fixture Co', title: 'Fixture', desc: '负责确定性合成项目交付。' }],
        proj: [],
        edu: [],
        skill: [],
        expect: [],
      },
      is_paywalled: 0,
      raw_json: JSON.stringify({ fixture: true }),
      fetched_at: '2026-07-11T12:30:00.000Z',
    });
  }

  const setScore = database.prepare('UPDATE candidate SET quality_score = ? WHERE internal_id = ?');
  [99, 1, 65, 88].forEach((score, index) => setScore.run(score, rows[index].internal_id));
  setScore.run(42, crossJob.internal_id);

  const before = formalSnapshot(job);
  assert.deepEqual(before.candidates.map((row) => row.name), [
    'S Candidate',
    'A Candidate',
    'B Candidate',
    'Unrated Candidate',
  ], '正式列表必须按 S/A/B/C/D 与稳定次级键排序');
  assert.ok(before.candidates.every((row) => !Object.hasOwn(row, 'quality_score')), '正式列表载荷不得返回历史质量分');
  assert.ok(!Object.hasOwn(dbmod.getCandidate(rows[0].internal_id), 'quality_score'), '候选人正式详情不得返回历史质量分');

  [3, 100, 0, 77].forEach((score, index) => setScore.run(score, rows[index].internal_id));
  setScore.run(999, crossJob.internal_id);
  const after = formalSnapshot(job);

  assert.deepEqual(after.candidates, before.candidates, '任意置换历史质量分后，正式候选人列表与顺序必须完全不变');
  assert.deepEqual(after.talentPool, before.talentPool, '任意置换历史质量分后，人才池、推荐组与顺序必须完全不变');
  assert.deepEqual(
    database.prepare('SELECT geek_id, sabc, sabc_source FROM candidate ORDER BY geek_id, job_id').all(),
    [
      { geek_id: 'legacy-score-a', sabc: 'A', sabc_source: '规则v1' },
      { geek_id: 'legacy-score-a', sabc: 'C', sabc_source: '人工' },
      { geek_id: 'legacy-score-b', sabc: 'B', sabc_source: '人工' },
      { geek_id: 'legacy-score-none', sabc: null, sabc_source: null },
      { geek_id: 'legacy-score-s', sabc: 'S', sabc_source: '人工' },
    ],
    '置换历史质量分不得改变 S/A/B/C/D 或来源',
  );

  const scoreBeforeRate = database.prepare('SELECT quality_score FROM candidate WHERE internal_id = ?').get(rows[3].internal_id).quality_score;
  await dbmod.rateJob(job);
  const scoreAfterRate = database.prepare('SELECT quality_score FROM candidate WHERE internal_id = ?').get(rows[3].internal_id).quality_score;
  assert.equal(scoreAfterRate, scoreBeforeRate, '规则重评不得清空或改写历史质量分');

  const formalUiFiles = [
    'frontend/src/App.jsx',
    'frontend/src/components/CandidateList.jsx',
    'frontend/src/components/CandidateDetail.jsx',
    'frontend/src/components/DashboardPanel.jsx',
    'frontend/src/components/InterviewSchedulePanel.jsx',
    'frontend/src/components/JobManagementDemo.jsx',
    'frontend/src/components/TalentPoolDemo.jsx',
    'candidate.html',
  ];
  for (const file of formalUiFiles) {
    const source = read(file);
    assert.doesNotMatch(source, /quality_score|质量分/, `${file} 不得消费或展示历史质量分`);
  }

  const dbSource = read('db.js');
  const listSource = dbSource.slice(dbSource.indexOf('function listCandidates'), dbSource.indexOf('function getCandidateKeys'));
  assert.doesNotMatch(listSource, /quality_score/, '正式候选人列表和详情查询不得读取历史质量分');
  assert.doesNotMatch(dbSource, /quality_score\s*=\s*@quality_score/, '正式重评不得写历史质量分');
  assert.match(dbSource, /quality_score INTEGER/, '历史数据库列必须保留');
  assert.match(dbSource, /\['quality_score', 'INTEGER'\]/, '历史迁移兼容必须保留');

  database.close();
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  console.log('check-quality-score-isolation ok');
}

main().catch((error) => {
  try {
    const database = dbmod.conn();
    if (database && database.open) database.close();
  } catch {}
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
