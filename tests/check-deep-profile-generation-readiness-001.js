'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-deep-profile-readiness-'));
process.env.HRBOSS_DATA_DIR = path.join(root, 'data');
process.env.BOSS_DB_PATH = path.join(root, 'synthetic.db');
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = path.join(root, 'interviews');
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const db = require("../src/db");
const actor = 'MAC-UI-003-SYNTHETIC';

;(async () => {
  db.openDb(process.env.BOSS_DB_PATH);
  const job = db.upsertJob({
    encrypt_job_id: 'mac-ui-003-synthetic-job',
    numeric_job_id: 'mac-ui-003-synthetic-job',
    name: '合成深度画像岗位',
    hr_owner: actor,
  });

  let readiness = db.getDeepProfileGenerationReadiness(job.id);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.code, 'JOB_ACTIVE_JD_REQUIRED');
  assert.match(readiness.message, /职位管理.*启用 JD/);

  const jd = db.createJobJdVersion({ jobId: job.id, jdText: '合成 JD', actor });
  db.activateJobJdVersion({ jdVersionId: jd.id, expectedVersion: jd.version, actor });
  readiness = db.getDeepProfileGenerationReadiness(job.id);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.code, 'JOB_CURRENT_PROFILE_REQUIRED');

  const profile = db.createJobProfileVersion({
    jobId: job.id,
    jdVersionId: jd.id,
    config: { rubric: '合成简版画像' },
    actor,
  });
  db.confirmJobProfileVersion({ profileVersionId: profile.id, expectedVersion: profile.version, actor });
  readiness = db.getDeepProfileGenerationReadiness(job.id);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.code, 'JOB_INTERVIEW_REQUIRED');

  db.insertInterview({ job_id: job.id, transcript: '仅用于回归测试的合成负责人访谈。' });
  readiness = db.getDeepProfileGenerationReadiness(job.id);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.code, 'READY');
  assert.equal(readiness.interview_count, 1);
  assert.equal(readiness.active_jd_id, jd.id);
  assert.equal(readiness.profile_version_id, profile.id);

  db.updateJobStatus({ jobId: job.id, status: 'closed', closeReason: 'other', actor });
  readiness = db.getDeepProfileGenerationReadiness(job.id);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.code, 'JOB_CLOSED');

  const errorsModuleUrl = pathToFileURL(path.join(PROJECT_ROOT, 'frontend/src/deep-profile-errors.js')).href;
  const { deepProfileErrorMessage } = await import(errorsModuleUrl);
  assert.equal(
    deepProfileErrorMessage(new Error("Error invoking remote method 'external-ai-approval:confirm': Error: 岗位“合成深度画像岗位”还没有已启用 JD，请先启用 JD")),
    '当前岗位还没有已启用 JD。请先到“职位管理”启用 JD，再生成深度画像。',
  );
  assert.equal(
    deepProfileErrorMessage(new Error("Error invoking remote method 'external-ai-approval:confirm': Error: 安全的业务提示")),
    '安全的业务提示',
  );
  assert.doesNotMatch(
    deepProfileErrorMessage(new Error("Error invoking remote method 'external-ai-approval:confirm': Error invoking remote method nested")),
    /Error invoking remote method/,
  );

  const componentSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/DeepProfileModal.jsx'), 'utf8');
  const actionServerSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/action-server.js"), 'utf8');
  assert.match(actionServerSource, /generation_readiness: db\.getDeepProfileGenerationReadiness\(jobId\)/);
  assert.match(componentSource, /setGenerationReadiness\(cfgRes\.generation_readiness \|\| \{/);
  assert.match(componentSource, /api\.getLlmConfig\(\)/);
  assert.match(componentSource, /capabilities\?\.deep_profile === true/);
  assert.match(componentSource, /const generationLocked = writeLocked \|\| generationReadiness\?\.ready !== true/);
  assert.match(componentSource, /disabled=\{generationLocked\}/);
  assert.match(componentSource, /const generationPrerequisiteId = generationReadiness\?\.ready === false/);
  assert.match(componentSource, /aria-describedby=\{generationPrerequisiteId\}/);
  assert.match(componentSource, /if \(generationReadiness\?\.ready !== true\) \{[\s\S]*?return;[\s\S]*?confirmExternalAiApproval/);
  assert.match(componentSource, /options\.skipCapabilityCheck !== true[\s\S]*externalAiAccess\?\.config\?\.capabilities\?\.deep_profile !== true/);
  assert.match(componentSource, /readExternalAiCapability\('deep_profile'\)/);
  assert.match(componentSource, /<ExternalAiFirstUsePrompt[\s\S]*capability="deep_profile"/);
  assert.match(componentSource, /message="外部 AI 尚未可用"/);
  assert.match(componentSource, /打开外部 AI 设置/);
  assert.match(componentSource, /const safeErrorMessage = deepProfileErrorMessage\(err\)/);
  assert.doesNotMatch(componentSource, /message\.error\(`生成画像失败：\$\{err\.message\}`\)/);

  console.log(JSON.stringify({
    ok: true,
    contract: 'MAC-UI-003-DEEP-PROFILE-GENERATION-READINESS',
    synthetic_only: true,
    network_used: false,
  }));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
