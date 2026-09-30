'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const mode = process.argv[2];
const syntheticRoot = fs.realpathSync(path.resolve(process.argv[3] || ''));
const dataRoot = path.join(syntheticRoot, 'data');
process.env.BOSS_DB_PATH = path.join(dataRoot, 'recruiting.db');
process.env.HRBOSS_DATA_DIR = dataRoot;
process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED = '1';
process.env.HRBOSS_F018_ENABLED = '1';

const db = require("../../../src/db");

function screenshotJobIdentity(jobName) {
  const suffix = crypto.createHash('sha1').update(jobName).digest('hex').slice(0, 16);
  return `local-screenshot-job-${suffix}`;
}

function seed() {
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dataRoot, 0o700);
  db.openDb(process.env.BOSS_DB_PATH);
  const jobName = '截图导入 · 合成OCR测试岗位';
  const job = db.upsertJob({
    encrypt_job_id: screenshotJobIdentity(jobName),
    name: jobName,
    hr_owner: '合成 HR',
    source_type: 'local_manual',
  });
  db.conn().close();
  process.stdout.write(`${JSON.stringify({ ok: true, job_id: job.id, job_name: jobName })}\n`);
}

function verify() {
  db.openDb(process.env.BOSS_DB_PATH);
  const database = db.conn();
  const candidates = database.prepare(`
    SELECT internal_id, name, source, job_id
    FROM candidate
    ORDER BY internal_id
  `).all();
  const resume = candidates.find((row) => row.name === '合成简历候选人');
  const screenshot = candidates.find((row) => row.name === '李合成测试');
  assert.ok(resume, 'the HR-confirmed synthetic resume candidate must persist');
  assert.ok(screenshot, 'the HR-corrected synthetic OCR candidate must persist');
  assert.equal(resume.source, '本地简历');
  assert.equal(screenshot.source, '截图导入');
  const resumeAttachments = database.prepare('SELECT COUNT(*) AS count FROM resume_attachment WHERE candidate_id = ?').get(resume.internal_id).count;
  assert.equal(resumeAttachments, 1, 'resume intake must persist one controlled attachment');
  const ocrDraft = database.prepare(`
    SELECT status, candidate_id, reviewed_by
    FROM screenshot_ocr_draft
    WHERE candidate_id = ?
  `).get(screenshot.internal_id);
  assert.deepEqual(
    { status: ocrDraft.status, candidate_id: ocrDraft.candidate_id, reviewed_by: ocrDraft.reviewed_by },
    { status: 'confirmed', candidate_id: screenshot.internal_id, reviewed_by: 'local-primary-operator' },
  );
  const assessment = database.prepare(`
    SELECT binding.state, binding.candidate_id, document.report_type, document.review_state,
           document.analysis_status
    FROM assessment_binding binding
    JOIN assessment_document document ON document.id = binding.document_id
    WHERE binding.candidate_id = ?
  `).get(resume.internal_id);
  assert.ok(assessment, 'the synthetic assessment binding must persist');
  assert.deepEqual(assessment, {
    state: 'active',
    candidate_id: resume.internal_id,
    report_type: 'career_potential',
    review_state: 'ready',
    analysis_status: 'ready',
  });
  const result = {
    ok: true,
    candidates: candidates.map((row) => ({ name: row.name, source: row.source, job_id: row.job_id })),
    resume_attachment_count: resumeAttachments,
    screenshot_draft: ocrDraft,
    assessment,
  };
  database.close();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (mode === 'seed') seed();
else if (mode === 'verify') verify();
else throw new Error('runtime-db mode must be seed or verify');
