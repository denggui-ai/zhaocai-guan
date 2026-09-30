const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = __dirname;
const FIXTURE_SOURCE = path.join(ROOT, 'create-ui-fixture-db.js');
const PANEL_SOURCE = path.join(ROOT, 'frontend', 'src', 'components', 'InterviewReviewPanel.jsx');

function assertNoSensitiveText(value, label) {
  const text = String(value || '');
  assert.ok(!/https?:\/\//i.test(text), `${label} must not contain links`);
  assert.ok(!/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(text), `${label} must not contain email addresses`);
  assert.ok(!/(?:^|\D)1[3-9]\d{9}(?:\D|$)/.test(text), `${label} must not contain mobile numbers`);
}

const fixtureSource = fs.readFileSync(FIXTURE_SOURCE, 'utf8');
for (const forbidden of ["require('./rating-llm')", "require('./minutes-fetch')", 'local-interview-p0.js']) {
  assert.ok(!fixtureSource.includes(forbidden), `fixture generator must not invoke ${forbidden}`);
}
assert.ok(!/\bspawn(?:Sync)?\s*\(/.test(fixtureSource), 'fixture generator must not start recording, transcription, AI, or external commands');

const panelSource = fs.readFileSync(PANEL_SOURCE, 'utf8');
for (const copy of ['本地演示样本', '不代表真实 AI 判断', '未执行真实录音、转写或 AI 调用']) {
  assert.ok(panelSource.includes(copy), `InterviewReviewPanel must disclose: ${copy}`);
}

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-interview-demo-fixture-')));
const tempParent = fs.realpathSync(os.tmpdir());
const fixtureDb = path.join(tempRoot, 'ui-fixture.db');
const defaultDataDir = path.join(tempRoot, 'default-data');
const defaultDbSentinel = path.join(defaultDataDir, 'recruiting.db');
const defaultDbSentinelContent = `synthetic-default-db-sentinel:${process.pid}:${Date.now()}`;
fs.mkdirSync(defaultDataDir, { recursive: true });
fs.writeFileSync(defaultDbSentinel, defaultDbSentinelContent, 'utf8');
assert.notEqual(fixtureDb, defaultDbSentinel, 'fixture target and injected default DB sentinel must stay distinct');

try {
  const result = spawnSync(process.execPath, [FIXTURE_SOURCE], {
    cwd: ROOT,
    env: {
      ...process.env,
      HRBOSS_UI_FIXTURE_GATE: '1',
      HRBOSS_UI_FIXTURE_ROOT: tempRoot,
      HRBOSS_UI_FIXTURE_TEMP_PARENT: tempParent,
      BOSS_DB_PATH: fixtureDb,
      HRBOSS_DATA_DIR: defaultDataDir,
      HRBOSS_INTERVIEW_OUTPUT_DIR: path.join(tempRoot, 'interviews'),
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `fixture generation failed: ${result.stderr || result.stdout}`);
  assert.equal(
    fs.readFileSync(defaultDbSentinel, 'utf8'),
    defaultDbSentinelContent,
    'fixture generation must honor BOSS_DB_PATH and leave the injected default DB sentinel untouched',
  );

  const db = new Database(fixtureDb, { readonly: true, fileMustExist: true });
  const recordingCount = db.prepare('SELECT COUNT(*) AS n FROM interview_recording').get().n;
  const reportCount = db.prepare('SELECT COUNT(*) AS n FROM interview_report_v1').get().n;
  const confirmationCount = db.prepare('SELECT COUNT(*) AS n FROM interview_report_fact_review').get().n;
  assert.equal(recordingCount, 1, 'fixture must contain exactly one interview recording loop');
  assert.equal(reportCount, 1, 'fixture must contain exactly one AI review demo report');
  assert.ok(confirmationCount >= 1, 'fixture must contain at least one human confirmation record');

  const recording = db.prepare('SELECT * FROM interview_recording').get();
  const reportRow = db.prepare('SELECT * FROM interview_report_v1').get();
  const confirmations = db.prepare('SELECT * FROM interview_report_fact_review ORDER BY id').all();
  const report = JSON.parse(reportRow.report_json);
  const rawSummary = JSON.parse(recording.raw_summary_json);

  assert.equal(recording.status, 'confirmed', 'demo recording must finish the archive step');
  assert.ok(recording.confirmed_at, 'demo recording must include an archive confirmation timestamp');
  assert.equal(reportRow.status, 'confirmed', 'demo report must finish the human-confirmed state');
  assert.ok(reportRow.confirmed_at, 'demo report must include a confirmation timestamp');
  assert.equal(report.schema_version, 'interview_report_v1');
  assert.equal(report.human_confirm_required, true);
  assert.match(report.disclaimer, /人工确认/);
  assert.match(report.disclaimer, /不代表自动录用/);
  assert.equal(rawSummary.source, 'local_demo_fixture');
  assert.equal(rawSummary.is_fixture, true);
  assert.equal(rawSummary.external_services_called, false);
  assert.ok(confirmations.some((item) => item.status === 'confirmed'), 'fixture must include an explicit human-confirmed fact');
  assert.ok(confirmations.every((item) => item.status !== 'pending'), 'fixture confirmation loop must have no pending facts');
  assert.ok(confirmations.every((item) => item.reviewed_by === 'Fixture-HR'), 'fixture fact reviews must identify the synthetic actor');

  assert.ok(recording.transcript_txt_path, 'demo recording must expose a transcript path');
  assert.ok(fs.existsSync(recording.transcript_txt_path), 'demo transcript artifact must exist');
  const transcript = fs.readFileSync(recording.transcript_txt_path, 'utf8');
  assert.match(transcript, /本地演示样本/);
  assert.match(transcript, /不能据此作招聘判断/);
  assertNoSensitiveText(transcript, 'demo transcript');
  assertNoSensitiveText(reportRow.report_json, 'demo report');
  assertNoSensitiveText(recording.raw_summary_json, 'demo recording summary');
  db.close();
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('check-interview-demo-fixture ok');
