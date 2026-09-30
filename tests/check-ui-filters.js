const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-ui-filters-'));
process.env.BOSS_DB_PATH = path.join(TEMP_ROOT, 'fixture.db');
const db = require("../src/db");

function educationBucket(row) {
  const text = `${row.school_tier || ''} ${row.school || ''} ${row.degree || ''}`;
  if (/985/.test(text)) return '985';
  if (/211/.test(text)) return '211';
  if (/重点/.test(text)) return '重点学校';
  if (/本科/.test(text)) return '普通本科';
  if (/专科|大专|高职/.test(text)) return '专科院校';
  return '其他';
}

const connection = db.openDb(process.env.BOSS_DB_PATH);
const jobId = db.upsertJob({ encrypt_job_id: 'ui-filter-fixture-job', name: '筛选合成岗位' }).id;
[
  { geek_id: 'ui-s', name: 'S', sabc: 'S', school: 'Fixture 985', school_tier: '985', degree: '本科', created_at: '2026-07-11T08:00:00.000Z' },
  { geek_id: 'ui-a', name: 'A', sabc: 'A', school: 'Fixture 211', school_tier: '211', degree: '硕士', created_at: '2026-07-11T09:00:00.000Z' },
  { geek_id: 'ui-b', name: 'B', sabc: 'B', school: 'Fixture College', school_tier: '', degree: '本科', created_at: '2026-07-11T10:00:00.000Z' },
  { geek_id: 'ui-u', name: 'Unknown', sabc: null, school: 'Fixture Unknown', school_tier: '', degree: '未知', created_at: '2026-07-11T11:00:00.000Z' },
].forEach((fixture) => db.upsertCandidate({ job_id: jobId, source: 'fixture', ...fixture }, fixture.created_at));

const rows = db.listCandidates(jobId);
assert.ok(rows.length > 1, '需要候选人样本');

for (const field of ['degree', 'school', 'school_tier']) {
  assert.ok(Object.hasOwn(rows[0], field), `listCandidates 应返回 ${field} 给前端筛选`);
}

assert.ok(rows.every((row) => !Object.hasOwn(row, 'quality_score')), '正式候选人列表不得返回历史质量分');
const tierRank = { S: 0, A: 1, B: 2, C: 3, D: 4 };
for (let i = 1; i < rows.length; i += 1) {
  const prev = tierRank[String(rows[i - 1].sabc || '').toUpperCase()] ?? 5;
  const cur = tierRank[String(rows[i].sabc || '').toUpperCase()] ?? 5;
  assert.ok(prev <= cur, '候选人应按 S/A/B/C/D 确定性档位排序');
}

assert.ok(rows.some((row) => educationBucket(row) === '其他'), '学历分类应能兜底到“其他”');

connection.close();
fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
console.log('check-ui-filters ok');
