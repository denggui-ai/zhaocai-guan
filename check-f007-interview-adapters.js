const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-f007-'));
const DB_PATH = path.join(ROOT, 'f007.db');
const MATERIAL_ROOT = path.join(ROOT, 'interviews');
process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
process.env.BOSS_DB_PATH = DB_PATH;
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = MATERIAL_ROOT;
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const db = require('./db');
const adapters = require('./interview-source-adapters');

function seedJobAndCandidate(suffix, jobId = null) {
  const job = jobId
    ? { id: jobId }
    : db.upsertJob({
      encrypt_job_id: `f007-job-${suffix}`,
      numeric_job_id: `970000000000${suffix}`,
      name: `F007 合成岗位 ${suffix}`,
      hr_owner: 'HR',
    });
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: `f007-geek-${suffix}`,
    source: 'fixture',
    name: `F007 合成候选人 ${suffix}`,
  });
  return { job, candidate };
}

function writeSummary(name, transcriptText = `纯合成线下转写 ${name}`) {
  const dir = path.join(MATERIAL_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const summaryPath = path.join(dir, 'summary.json');
  const summary = {
    createdAt: '2026-07-11T08:00:00.000Z',
    topic: name,
    sourcePath: path.join(dir, 'source.mp4'),
    wavPath: path.join(dir, 'audio.wav'),
    transcriptTxt: path.join(dir, 'transcript.txt'),
    transcriptSrt: path.join(dir, 'transcript.srt'),
    transcriptJson: path.join(dir, 'transcript.json'),
    codexInput: path.join(dir, 'codex-input.md'),
  };
  fs.writeFileSync(summary.sourcePath, 'synthetic source\n');
  fs.writeFileSync(summary.wavPath, 'RIFF synthetic audio\n');
  fs.writeFileSync(summary.transcriptTxt, `${transcriptText}\n`);
  fs.writeFileSync(summary.transcriptSrt, `1\n00:00:00,000 --> 00:00:02,000\n${transcriptText}\n`);
  fs.writeFileSync(summary.transcriptJson, `${JSON.stringify({ text: transcriptText })}\n`);
  fs.writeFileSync(summary.codexInput, '# synthetic\n');
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { summaryPath, summary, transcriptText };
}

function recordingInput(fixture) {
  return {
    summary_path: fixture.summaryPath,
    source_path: fixture.summary.sourcePath,
    wav_path: fixture.summary.wavPath,
    transcript_txt_path: fixture.summary.transcriptTxt,
    transcript_srt_path: fixture.summary.transcriptSrt,
    transcript_json_path: fixture.summary.transcriptJson,
    codex_input_path: fixture.summary.codexInput,
    topic: fixture.summary.topic,
    created_at: fixture.summary.createdAt,
    raw_summary_json: fixture.summary,
  };
}

const database = db.openDb(DB_PATH);
const first = seedJobAndCandidate('101');
const sameJobOther = seedJobAndCandidate('102', first.job.id);
const other = seedJobAndCandidate('202');

const onlineUrl = 'https://example.test/minutes/StableOnline001?from=copy';
let online = adapters.ingestOnlineMinutes({
  jobId: first.job.id,
  sourceUrl: onlineUrl,
  transcript: '候选人名字即使出现也不得自动归属：F007 合成候选人 101',
  note: '纯合成线上材料',
});
assert.equal(online.created, true);
assert.equal(online.assignment.purpose, 'unknown');
assert.equal(online.assignment.status, 'pending_classification');
assert.equal(online.session, null);
assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session').get().n, 0);

const onlineReplay = adapters.ingestOnlineMinutes({
  jobId: first.job.id,
  sourceUrl: 'https://another.example/minutes/StableOnline001',
  transcript: '重放正文可以不同，但稳定来源键必须主导幂等',
});
assert.equal(onlineReplay.idempotent_replay, true);
assert.equal(onlineReplay.assignment.id, online.assignment.id);
assert.equal(database.prepare('SELECT COUNT(*) AS n FROM job_interview').get().n, 1);

const onlineDuplicatePayload = adapters.ingestOnlineMinutes({
  jobId: first.job.id,
  sourceUrl: 'https://example.test/minutes/StableOnline002',
  transcript: '候选人名字即使出现也不得自动归属：F007 合成候选人 101',
});
assert.ok(onlineDuplicatePayload.duplicate_suspect, 'same payload hash should only raise a duplicate hint');
assert.notEqual(onlineDuplicatePayload.assignment.id, online.assignment.id);
assert.equal(onlineDuplicatePayload.assignment.status, 'pending_classification');

assert.throws(() => adapters.classifyPendingMaterial({
  pendingAssignmentId: online.assignment.id,
  purpose: 'candidate_interview',
  expectedVersion: 1,
  reason: 'manual_candidate_classification',
  requestId: 'classify-online-1',
}), /actor/);
assert.throws(() => adapters.classifyPendingMaterial({
  pendingAssignmentId: online.assignment.id,
  purpose: 'candidate_interview',
  actor: 'HR-SYNTHETIC',
  expectedVersion: 1,
  requestId: 'classify-online-missing-reason',
}), /reason/);
assert.throws(() => adapters.classifyPendingMaterial({
  pendingAssignmentId: online.assignment.id,
  purpose: 'candidate_interview',
  actor: 'HR-SYNTHETIC',
  expectedVersion: 1,
  reason: 'manual_candidate_classification',
}), /requestId/);
assert.throws(() => adapters.classifyPendingMaterial({
  pendingAssignmentId: online.assignment.id,
  purpose: 'unknown',
  actor: 'HR-SYNTHETIC',
  expectedVersion: 1,
  reason: 'manual_candidate_classification',
  requestId: 'classify-online-2',
}), /unsupported/);

let classified = adapters.classifyPendingMaterial({
  pendingAssignmentId: online.assignment.id,
  purpose: 'candidate_interview',
  actor: 'HR-SYNTHETIC',
  expectedVersion: 1,
  reason: 'manual_candidate_classification',
  requestId: 'classify-online-3',
});
assert.equal(classified.status, 'pending_assignment');
assert.equal(classified.version, 2);
assert.throws(() => adapters.assignPendingMaterial({
  pendingAssignmentId: classified.id,
  candidateId: other.candidate.internal_id,
  jobId: other.job.id,
  round: 1,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 2,
  reason: 'manual_assignment',
  requestId: 'assign-online-wrong-job',
}), /another job/);
assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session_material').get().n, 0);

let assignedOnline = adapters.assignPendingMaterial({
  pendingAssignmentId: classified.id,
  candidateId: first.candidate.internal_id,
  jobId: first.job.id,
  round: 1,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 2,
  reason: 'manual_assignment',
  requestId: 'assign-online-1',
});
assert.equal(assignedOnline.assignment.status, 'assigned');
assert.equal(assignedOnline.assignment.version, 3);
assert.equal(assignedOnline.session.mode, 'online');
assert.equal(assignedOnline.session.scheduled_at, null);
const assignedOnlineReplay = adapters.assignPendingMaterial({
  pendingAssignmentId: classified.id,
  candidateId: first.candidate.internal_id,
  jobId: first.job.id,
  round: 1,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 2,
  reason: 'manual_assignment',
  requestId: 'assign-online-1',
});
assert.equal(assignedOnlineReplay.assignment.version, 3, 'same request id must replay without another version bump');
assert.throws(() => adapters.assignPendingMaterial({
  pendingAssignmentId: classified.id,
  candidateId: sameJobOther.candidate.internal_id,
  jobId: first.job.id,
  round: 1,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 2,
  reason: 'manual_correction',
  requestId: 'assign-online-stale',
}), /stale/);

assignedOnline = adapters.assignPendingMaterial({
  pendingAssignmentId: classified.id,
  candidateId: sameJobOther.candidate.internal_id,
  jobId: first.job.id,
  round: 1,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 3,
  reason: 'manual_correction',
  requestId: 'assign-online-correction',
});
assert.equal(assignedOnline.assignment.version, 4);
assert.equal(assignedOnline.session.candidate_id, sameJobOther.candidate.internal_id);

const directOnline = adapters.ingestOnlineMinutes({
  jobId: first.job.id,
  sourceUrl: 'https://example.test/minutes/StableOnlineDirect',
  transcript: '纯合成线上显式上下文材料',
  candidateId: first.candidate.internal_id,
  round: 4,
  actor: 'HR-SYNTHETIC',
  reason: 'explicit_candidate_context',
  requestId: 'online-direct-1',
});
assert.equal(directOnline.assignment.status, 'assigned');
assert.equal(directOnline.session.mode, 'online');
assert.equal(directOnline.session.round, 4);

let profile = adapters.classifyPendingMaterial({
  pendingAssignmentId: onlineDuplicatePayload.assignment.id,
  purpose: 'hiring_manager_profile_interview',
  actor: 'HR-SYNTHETIC',
  expectedVersion: 1,
  reason: 'manual_profile_classification',
  requestId: 'classify-profile-1',
});
assert.equal(profile.status, 'excluded');
assert.equal(db.listInterviews(first.job.id).length, 3, 'excluded profile material must remain in legacy listInterviews');
assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session_material WHERE job_interview_id = ?').get(profile.job_interview_id).n, 0);

const offlineFixture = writeSummary('offline-pending', '纯合成重复转写提示');
let offline = adapters.ingestOfflineRecording({
  recording: recordingInput(offlineFixture),
  sourceKey: adapters.sourceKeyForOfflineSummary(offlineFixture.summaryPath),
  payloadHash: adapters.payloadHash(offlineFixture.transcriptText),
});
assert.equal(offline.assignment.purpose, 'unknown');
assert.equal(offline.assignment.status, 'pending_classification');
assert.equal(offline.session, null);
const offlineReplay = adapters.ingestOfflineRecording({
  recording: recordingInput(offlineFixture),
  sourceKey: adapters.sourceKeyForOfflineSummary(offlineFixture.summaryPath),
  payloadHash: adapters.payloadHash(offlineFixture.transcriptText),
});
assert.equal(offlineReplay.idempotent_replay, true);
assert.equal(offlineReplay.assignment.id, offline.assignment.id);

classified = adapters.classifyPendingMaterial({
  pendingAssignmentId: offline.assignment.id,
  purpose: 'candidate_interview',
  actor: 'HR-SYNTHETIC',
  expectedVersion: 1,
  reason: 'manual_candidate_classification',
  requestId: 'classify-offline-1',
});
const assignedOffline = adapters.assignPendingMaterial({
  pendingAssignmentId: classified.id,
  candidateId: first.candidate.internal_id,
  jobId: first.job.id,
  round: 2,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 2,
  reason: 'manual_assignment',
  requestId: 'assign-offline-1',
});
assert.equal(assignedOffline.session.mode, 'offline');
assert.equal(assignedOffline.session.scheduled_at, null);

const directFixture = writeSummary('offline-direct', '纯合成显式上下文转写');
const directOffline = adapters.ingestOfflineRecording({
  recording: recordingInput(directFixture),
  sourceKey: adapters.sourceKeyForOfflineSummary(directFixture.summaryPath),
  payloadHash: adapters.payloadHash(directFixture.transcriptText),
  candidateId: first.candidate.internal_id,
  jobId: first.job.id,
  round: 3,
  actor: 'HR-SYNTHETIC',
  reason: 'explicit_candidate_context',
  requestId: 'offline-direct-1',
});
assert.equal(directOffline.assignment.status, 'assigned');
assert.equal(directOffline.session.round, 3);

const timeline = adapters.listSessionTimeline({ jobId: first.job.id });
const onlineDto = timeline.find((item) => item.mode === 'online' && item.materials.length);
const offlineDto = timeline.find((item) => item.mode === 'offline' && item.materials.length);
assert.ok(onlineDto && offlineDto);
assert.deepEqual(Object.keys(onlineDto).sort(), Object.keys(offlineDto).sort(), 'online/offline session DTO keys must match');
assert.deepEqual(Object.keys(onlineDto.materials[0]).sort(), Object.keys(offlineDto.materials[0]).sort(), 'online/offline material DTO keys must match');
assert.equal(timeline.every((item) => item.scheduled_at === null), true, 'material timestamps must never set scheduled_at');

const pendingRows = adapters.listPendingMaterials({ jobId: first.job.id });
assert.equal(pendingRows.every((row) => ['pending_classification', 'pending_assignment'].includes(row.classification)), true);
assert.equal(pendingRows.some((row) => Object.hasOwn(row, 'transcript') || Object.hasOwn(row, 'source_url')), false);

const audits = adapters.listPendingMaterialAudits(online.assignment.id);
assert.deepEqual(audits.map((item) => item.action_type), ['classification', 'assignment', 'correction']);
assert.equal(audits[0].before_status, 'pending_classification');
assert.equal(audits[0].after_status, 'pending_assignment');
assert.equal(audits[1].before_version, 2);
assert.equal(audits[1].after_version, 3);
assert.equal(audits[2].before_assigned_session_id, audits[1].after_assigned_session_id);
const auditText = JSON.stringify(audits);
for (const forbidden of ['候选人名字', onlineUrl, offlineFixture.summaryPath, '纯合成线下转写']) {
  assert.equal(auditText.includes(forbidden), false, `audit must not contain sensitive material: ${forbidden}`);
}

assert.ok(db.listInterviewRecordings({ candidateId: first.candidate.internal_id, jobId: first.job.id }).length >= 2, 'legacy recording query must keep assigned history');
assert.equal(database.prepare('SELECT COUNT(*) AS n FROM job_interview').get().n, 3, 'legacy online rows must not be duplicated by session mapping');
assert.deepEqual(database.pragma('foreign_key_check'), []);

database.close();
console.log('check-f007-interview-adapters ok');
