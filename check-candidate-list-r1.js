#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, 'frontend/src/components/CandidateList.jsx'),
  'utf8',
);

// Queue semantics: the first number is explicitly an aggregate, while the
// overflow badge describes populated stage categories instead of summing
// another overlapping population.
assert.match(source, /\{ key: 'mine', label: '全部待处理' \}/);
assert.doesNotMatch(source, /\{ key: 'mine', label: '待我处理' \}/);
assert.match(source, /全部待处理为聚合视图，其余为阶段筛选/);
assert.match(source, /const overflowQueueCategoryCount = countPopulatedQueueCategories\(overflowQueueOptions\);/);
assert.match(source, /`其他阶段，\$\{overflowQueueCategoryCount\} 个阶段有候选人`/);
assert.match(source, /: `\$\{overflowQueueCategoryCount\} 类`/);
assert.doesNotMatch(source, /const overflowQueueCount\s*=\s*overflowQueueOptions\.reduce/);

const queueCountStart = source.indexOf('function countPopulatedQueueCategories');
const queueCountEnd = source.indexOf('\n\nfunction EmptyState', queueCountStart);
assert.ok(queueCountStart >= 0 && queueCountEnd > queueCountStart, 'queue category helper must be extractable');
const countPopulatedQueueCategories = new Function(
  `${source.slice(queueCountStart, queueCountEnd)}\nreturn countPopulatedQueueCategories;`,
)();
assert.equal(countPopulatedQueueCategories([
  { key: 'new', count: 7 },
  { key: 'contact', count: 2 },
  { key: 'hold', count: 0 },
  { key: 'archived', count: 0 },
]), 2, 'overflow summary must count populated categories, not nine candidates');

// Long names keep a direct full-name tooltip and every row exposes a stable,
// non-invented disambiguator. Internal IDs use a compact visible suffix while
// the accessible/title copy retains the complete value.
assert.match(source, /className="candidate-name" title=\{`完整姓名：\$\{fullName\}`\}/);
assert.match(source, /className="candidate-row-disambiguator" title=\{stableReference\.full\}/);
assert.match(source, /aria-label=\{accessibleLabel\}/);

const referenceStart = source.indexOf('function shortCandidateId');
const referenceEnd = source.indexOf('\n\nfunction CandidateCard', referenceStart);
assert.ok(referenceStart >= 0 && referenceEnd > referenceStart, 'candidate reference helpers must be extractable');
const referenceHelpers = new Function(
  'clean',
  'candidateEducation',
  `${source.slice(referenceStart, referenceEnd)}\nreturn { shortCandidateId, candidateStableReference };`,
)(
  (value) => String(value ?? '').trim(),
  (candidate) => ({ school: String(candidate?.school ?? '').trim() }),
);

assert.deepEqual(
  referenceHelpers.candidateStableReference({
    candidate_ref: 'REF-77',
    candidate_id: 'CANDIDATE-ID-IGNORED',
    internal_id: 'C-2026-000001',
    school: '合成大学',
  }),
  { visible: '候选人编号 REF-77', full: '候选人编号：REF-77' },
  'explicit candidate reference must win',
);
assert.deepEqual(
  referenceHelpers.candidateStableReference({ candidate_id: 'C-2026-000123', internal_id: 'C-2026-000999' }),
  { visible: '候选人编号 2026-000123', full: '内部候选人 ID：C-2026-000123' },
  'candidate_id must precede internal_id and keep its full accessible value',
);
assert.deepEqual(
  referenceHelpers.candidateStableReference({ internal_id: 'C-2026-000999' }),
  { visible: '候选人编号 2026-000999', full: '内部候选人 ID：C-2026-000999' },
);
assert.deepEqual(
  referenceHelpers.candidateStableReference({ school: '合成大学' }),
  { visible: '学校 合成大学', full: '学校：合成大学' },
  'school is a truthful final fallback when no stable candidate ID exists',
);

// The placeholder promises fields that are truly included in the local index.
for (const indexedField of ['c.name', 'c.job_name', 'edu.school']) {
  assert.ok(source.includes(indexedField), `search index must include ${indexedField}`);
}
assert.match(source, /placeholder="搜索姓名 \/ 岗位 \/ 学校…"/);
assert.match(source, /c\.internal_id,[\s\S]*c\.job_name,/);

// Preserve the established selection, pagination and roving-focus contracts.
assert.match(source, /const PAGE_SIZE = 10;/);
assert.match(source, /role=\{emptyState \? 'region' : 'listbox'\}/);
assert.match(source, /role="option"/);
assert.match(source, /aria-selected=\{active\}/);
assert.match(source, /\['ArrowDown', 'ArrowUp', 'Home', 'End'\]\.includes\(event\.key\)/);
assert.match(source, /event\.key === 'Enter' \|\| event\.key === ' '/);
assert.match(source, /<Pagination[\s\S]*pageSize=\{PAGE_SIZE\}/);
assert.match(source, /if \(selectedId && !selectedExists\) onSelectionInvalidated\?\.\(\);/);

console.log(JSON.stringify({
  ok: true,
  contract: 'CANDIDATE-LIST-R1',
  aggregate_queue_labeled: true,
  overflow_counts_categories: true,
  stable_row_identity: true,
  search_contract_aligned: true,
  listbox_keyboard_contract_preserved: true,
}));
