#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-ux-g0-a-'));
const databasePath = path.join(fixtureRoot, 'timeline.db');
process.env.HRBOSS_DATA_DIR = path.join(fixtureRoot, 'data');
process.env.BOSS_DB_PATH = databasePath;
// Windows keeps the SQLite handle open until the process is gone, so the temp
// tree cannot always be removed here. Losing a temp directory is not a reason
// to fail a check.
process.on('exit', () => { try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch {} });

const db = require('./db');
const database = db.openDb(databasePath);
const job = db.upsertJob({
  encrypt_job_id: 'ux-g0-a-synthetic-job',
  numeric_job_id: '990000000071',
  name: 'UX-G0-A 合成岗位',
  status: 'open',
});

function createCandidate(suffix) {
  return db.upsertCandidate({
    job_id: job.id,
    geek_id: `ux-g0-a-${suffix}`,
    source: 'synthetic_ux_g0_a',
    name: `UX-G0-A 合成候选人 ${suffix}`,
  });
}

function businessEvents(candidate) {
  return db.getCandidateTimeline(candidate.internal_id).events
    .filter((event) => event.source_entity?.type !== 'candidate');
}

const reasonCandidate = createCandidate('reason');
database.prepare(`
  INSERT INTO status_history (
    candidate_id, layer, from_status, to_status, source, who, reason,
    from_code, to_code, created_at
  ) VALUES (?, 'disposition', '新入库', '淘汰', 'manual_hr_action', 'HR-合成', ?, 'new', 'rejected', ?)
`).run(reasonCandidate.internal_id, '合成状态原因：岗位方向不匹配', '2026-07-21T01:00:00.000Z');
const reasonEvents = businessEvents(reasonCandidate);
assert.equal(reasonEvents.length, 1, 'reason-only fixture must add exactly one visible business event');
assert.equal(reasonEvents[0].event_type, 'disposition_decided');
assert.equal(reasonEvents[0].detail, '合成状态原因：岗位方向不匹配');

const commentCandidate = createCandidate('comment');
database.prepare(`
  INSERT INTO comment (
    candidate_id, body, purpose_tag, is_persona_signal, polarity, author, created_at
  ) VALUES (?, ?, '跟进备注', 0, 'neutral', 'HR-合成', ?)
`).run(commentCandidate.internal_id, '合成备注：候选人周五补充作品集', '2026-07-21T02:00:00.000Z');
const commentEvents = businessEvents(commentCandidate);
assert.equal(commentEvents.length, 1, 'comment-only fixture must add exactly one visible business event');
assert.equal(commentEvents[0].event_type, 'comment_recorded');
assert.equal(commentEvents[0].summary, '跟进备注');
assert.equal(commentEvents[0].detail, '合成备注：候选人周五补充作品集');

const contactCandidate = createCandidate('contact');
const encryptedContactSentinel = 'ENC[synthetic-private-contact-13800138000]';
const contactHashSentinel = 'synthetic-private-contact-hash';
database.prepare(`
  INSERT INTO contact (
    candidate_id, type, value_encrypted, value_hash, source, confidence, created_at
  ) VALUES (?, 'phone', ?, ?, 'manual', 'confirmed', ?)
`).run(contactCandidate.internal_id, encryptedContactSentinel, contactHashSentinel, '2026-07-21T03:00:00.000Z');
const contactTimeline = db.getCandidateTimeline(contactCandidate.internal_id);
const contactEvents = contactTimeline.events.filter((event) => event.source_entity?.type === 'contact');
assert.equal(contactEvents.length, 1, 'contact-only fixture must add exactly one visible contact event');
assert.equal(contactEvents[0].event_type, 'contact_recorded');
assert.equal(contactEvents[0].summary, '电话联系方式已记录');
assert.equal(contactEvents[0].detail, '联系方式已安全保存；当前时间线不展示明文。');
const serializedContactTimeline = JSON.stringify(contactTimeline);
assert.doesNotMatch(serializedContactTimeline, /13800138000/);
assert.equal(serializedContactTimeline.includes(encryptedContactSentinel), false);
assert.equal(serializedContactTimeline.includes(contactHashSentinel), false);

const actionCandidate = createCandidate('action');
database.prepare(`
  INSERT INTO write_action (
    action_type, candidate_id, dedup_key, status, boss_code, decision,
    attempt, greet_text, result_json, created_at, updated_at, executed_at
  ) VALUES ('request_resume', ?, ?, 'done', 0, 'ok', 1, NULL, NULL, ?, ?, ?)
`).run(
  actionCandidate.internal_id,
  `ux-g0-a:${actionCandidate.internal_id}:request_resume`,
  '2026-07-21T04:00:00.000Z',
  '2026-07-21T04:01:00.000Z',
  '2026-07-21T04:01:00.000Z',
);
const actionEvents = businessEvents(actionCandidate);
assert.equal(actionEvents.length, 1, 'write-action-only fixture must add exactly one visible business event');
assert.equal(actionEvents[0].event_type, 'write_action_recorded');
assert.equal(actionEvents[0].summary, '自动动作：求简历');
assert.equal(actionEvents[0].detail, '执行决定：成功');
assert.equal(actionEvents[0].diagnostic, null);
assert.equal(actionEvents[0].status_code, 'done');

const unknownActionCandidate = createCandidate('unknown-action');
const unknownActionType = 'legacy_unknown_action';
const unknownDecision = 'legacy_unknown_decision';
database.prepare(`
  INSERT INTO write_action (
    action_type, candidate_id, dedup_key, status, boss_code, decision,
    attempt, greet_text, result_json, created_at, updated_at, executed_at
  ) VALUES (?, ?, ?, 'done', 0, ?, 1, NULL, NULL, ?, ?, ?)
`).run(
  unknownActionType,
  unknownActionCandidate.internal_id,
  `ux-g0-a:${unknownActionCandidate.internal_id}:unknown`,
  unknownDecision,
  '2026-07-21T04:10:00.000Z',
  '2026-07-21T04:11:00.000Z',
  '2026-07-21T04:11:00.000Z',
);
const unknownActionEvents = businessEvents(unknownActionCandidate);
assert.equal(unknownActionEvents.length, 1, 'unknown write action must remain visible as one business event');
assert.equal(unknownActionEvents[0].event_type, 'write_action_recorded');
assert.equal(unknownActionEvents[0].summary, '待人工复核');
assert.equal(unknownActionEvents[0].detail, '待人工复核');
assert.deepEqual(unknownActionEvents[0].diagnostic, {
  legacy_action_type_code: unknownActionType,
  legacy_decision_code: unknownDecision,
});
assert.equal(unknownActionEvents[0].summary.includes(unknownActionType), false);
assert.equal(unknownActionEvents[0].detail.includes(unknownDecision), false);

const legacyCandidate = createCandidate('legacy');
database.prepare(`
  INSERT INTO status_history (
    candidate_id, layer, from_status, to_status, source, who, reason,
    from_code, to_code, created_at
  ) VALUES (?, 'disposition', '新入库', '历史神秘状态', 'legacy_import', 'legacy', ?, 'new', 'legacy-mystery-code', ?)
`).run(legacyCandidate.internal_id, '合成 legacy 原因', '2026-07-21T05:00:00.000Z');
const legacyEvent = businessEvents(legacyCandidate)[0];
assert.equal(legacyEvent.status_code, 'legacy_review_required');
assert.equal(legacyEvent.summary, '待人工复核');
assert.equal(legacyEvent.detail, '合成 legacy 原因');
assert.equal(legacyEvent.diagnostic?.legacy_status_code, 'legacy-mystery-code');

const beforeCloseTimeline = db.getCandidateTimeline(reasonCandidate.internal_id);
database.prepare("UPDATE job SET status = 'closed' WHERE id = ?").run(job.id);
const closedJobTimeline = db.getCandidateTimeline(reasonCandidate.internal_id);
assert.deepEqual(closedJobTimeline.events, beforeCloseTimeline.events, 'closed jobs must retain readable history');
assert.deepEqual(closedJobTimeline.pending_todos, [], 'closed jobs must keep writes/todos disabled');

for (const candidate of [
  reasonCandidate,
  commentCandidate,
  contactCandidate,
  actionCandidate,
  unknownActionCandidate,
  legacyCandidate,
]) {
  const timeline = db.getCandidateTimeline(candidate.internal_id);
  assert.equal(
    timeline.visible_record_count,
    timeline.events.length + timeline.pending_todos.length,
    'timeline count contract must equal every rendered event and todo row',
  );
}

const detailSource = fs.readFileSync(
  path.join(__dirname, 'frontend/src/components/CandidateDetail.jsx'),
  'utf8',
);
assert.match(detailSource, /function timelineVisibleRecordCount\(timeline\)/);
assert.match(detailSource, /timeline\.visible_record_count/);
assert.match(detailSource, /const flowCount = timelineVisibleRecordCount\(timeline\);/);
assert.match(detailSource, /event\.detail/);
assert.match(detailSource, /activeDomain === 'flow' && \([\s\S]*?<CanonicalTimelinePanel timeline=\{timeline\} \/>[\s\S]*?\)/,
  'read-only mode must not hide the timeline panel');

console.log(JSON.stringify({
  ok: true,
  contract: 'UX-G0-A',
  fixture_categories: ['reason', 'comment', 'contact', 'write_action', 'unknown_write_action', 'legacy'],
  contact_plaintext_exposed: false,
  closed_job_history_visible: true,
  count_contract: 'events + pending_todos',
}));
