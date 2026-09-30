#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-ecom-template-flow-'));
const DB_PATH = path.join(ROOT, 'template-flow.db');
const PORT = 19400 + (process.pid % 500);
const TOKEN = 'ecommerce-template-flow-local-token-20260716';

process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
process.env.BOSS_DB_PATH = DB_PATH;
process.env.BOSS_ACTION_PORT = String(PORT);
process.env.HRBOSS_LOCAL_API_TOKEN = TOKEN;
process.env.HRBOSS_LOCAL_API_INSTANCE_ID = 'ecommerce-template-flow-check';
process.env.HRBOSS_EXTERNAL_AI_ENABLED = '0';
process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED = '0';
process.env.HRBOSS_F018_ENABLED = '0';

const db = require("../src/db");
const { startHttpServer, shutdown } = require("../src/action-server");
const { prepareEcommerceTemplateDraft } = require("../src/ecommerce-job-template-flow");
const { ECOMMERCE_JOB_TEMPLATE_CATALOG } = require("../src/ecommerce-job-template-catalog");

function request(method, pathname, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method,
      headers: {
        'x-hrboss-token': TOKEN,
        ...(payload === null ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        }),
      },
      timeout: 5000,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end(payload || undefined);
  });
}

function get(pathname) {
  return request('GET', pathname);
}

function post(pathname, body) {
  return request('POST', pathname, body);
}

function recordCounts(database) {
  return {
    job: database.prepare('SELECT COUNT(*) AS n FROM job').get().n,
    jd: database.prepare('SELECT COUNT(*) AS n FROM job_jd_version').get().n,
    profile: database.prepare('SELECT COUNT(*) AS n FROM job_profile_version').get().n,
    audit: database.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = '从预置岗位新建草稿'").get().n,
    blank_audit: database.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = '本地新建岗位'").get().n,
  };
}

let createRequestSequence = 0;
function withCreateRequest(input, label = 'synthetic') {
  createRequestSequence += 1;
  return {
    ...input,
    createRequestId: `${label}-${process.pid}-${createRequestSequence}`,
  };
}

function validInput(family, variant, suffix = '') {
  return {
    templateKey: family.family_key,
    variantKey: variant.variant_key,
    name: `合成${variant.job_title}${suffix}`,
    hrOwner: '合成 HR',
    plannedHires: 1,
    department: '合成电商部',
    location: '合成杭州',
    hrFields: {
      [variant.hr_variables[0]]: `仅合成业务事实${suffix}`,
    },
  };
}

async function assertRejectedWithoutWrites(input, expectedStatus, expectedCode) {
  const database = db.conn();
  const before = recordCounts(database);
  const response = await post('/api/jobs/from-template', withCreateRequest(input, 'rejected'));
  assert.equal(response.status, expectedStatus, JSON.stringify(response.body));
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, expectedCode);
  assert.deepEqual(recordCounts(database), before, 'invalid template input must not leave records');
}

async function main() {
  await startHttpServer();
  const database = db.conn();

  const catalogResponse = await get('/api/job-templates/ecommerce');
  assert.equal(catalogResponse.status, 200, JSON.stringify(catalogResponse.body));
  assert.equal(catalogResponse.body.ok, true);
  assert.equal(catalogResponse.body.catalog.families.length, 12);
  assert.equal(
    catalogResponse.body.catalog.families.flatMap((family) => family.variants).length,
    34,
  );
  assert.match(catalogResponse.body.catalog.usage_notice, /不发布到 Boss/);
  assert.equal(catalogResponse.body.catalog.families[0].family_key, 'content-new-media');
  assert.ok(Array.isArray(catalogResponse.body.catalog.families[0].variants[0].hr_variables));
  assert.equal(typeof catalogResponse.body.catalog.families[0].variants[0].hr_variables[0], 'string');
  assert.deepEqual(
    Object.keys(catalogResponse.body.catalog.hr_variable_definitions.business_model).sort(),
    ['label', 'prompt'],
  );

  const variants = ECOMMERCE_JOB_TEMPLATE_CATALOG.families
    .flatMap((family) => family.variants.map((variant) => ({ family, variant })));
  assert.equal(variants.length, 34);
  for (const { family, variant } of variants) {
    const prepared = prepareEcommerceTemplateDraft(validInput(family, variant, '-解析'));
    assert.equal(prepared.source_ref.template_key, family.family_key);
    assert.equal(prepared.source_ref.variant_key, variant.variant_key);
    assert.equal(prepared.job.status, 'draft');
    assert.equal(prepared.profile_config.hard_bars.degree.enabled, false);
    assert.equal(prepared.profile_config.hard_bars.salary.enabled, false);
    assert.equal(prepared.profile_config.hard_bars.city.enabled, false);
  }

  const created = [];
  const familyCreateRequests = [];
  for (const [index, family] of ECOMMERCE_JOB_TEMPLATE_CATALOG.families.entries()) {
    const variant = family.variants[0];
    const secretSyntheticFact = `仅合成业务事实-family-${index + 1}`;
    const input = validInput(family, variant, `-${index + 1}`);
    input.hrFields[variant.hr_variables[0]] = secretSyntheticFact;
    const createInput = withCreateRequest(input, `family-${index + 1}`);
    const response = await post('/api/jobs/from-template', createInput);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.ok, true);
    assert.equal(response.body.job.status, 'draft');
    assert.equal(response.body.job.source_type, 'local_db');
    assert.equal(response.body.jd.status, 'draft');
    assert.equal(response.body.jd.source, 'manual');
    assert.equal(response.body.jd.activated_at, null);
    assert.equal(response.body.profile.status, 'draft');
    assert.equal(response.body.profile.source_kind, 'manual');
    assert.equal(response.body.profile.confirmed_at, null);
    assert.equal(Number(response.body.profile.jd_version_id), Number(response.body.jd.id));
    assert.equal(response.body.profile.config.deep_profile, undefined);
    assert.equal(response.body.profile.config.hard_bars.degree.enabled, false);
    assert.equal(response.body.profile.config.hard_bars.salary.enabled, false);
    assert.equal(response.body.profile.config.hard_bars.city.enabled, false);
    assert.equal(response.body.profile.source_ref.kind, 'ecommerce_job_template');
    assert.equal(response.body.profile.source_ref.template_key, family.family_key);
    assert.equal(response.body.profile.source_ref.variant_key, variant.variant_key);
    assert.match(response.body.jd.jd_text, /需由 HR 核对、编辑并单独启用/);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS n FROM job_profile WHERE job_id = ?').get(response.body.job.id).n,
      0,
      'draft template creation must not write the confirmed compatibility projection',
    );
    const audit = database.prepare(`
      SELECT detail_json FROM audit_log
      WHERE action = '从预置岗位新建草稿' AND target = ?
    `).get(String(response.body.job.id));
    assert.ok(audit);
    assert.doesNotMatch(audit.detail_json, new RegExp(secretSyntheticFact));
    assert.equal(JSON.parse(audit.detail_json).template_key, family.family_key);
    created.push(response.body);
    familyCreateRequests.push(createInput);
  }

  assert.equal(created.length, 12);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM job WHERE status <> 'draft'").get().n, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM job_jd_version WHERE status <> 'draft'").get().n, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM job_profile_version WHERE status <> 'draft'").get().n, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM candidate').get().n, 0);

  const firstFamily = ECOMMERCE_JOB_TEMPLATE_CATALOG.families[0];
  const firstVariant = firstFamily.variants[0];
  const secondFamily = ECOMMERCE_JOB_TEMPLATE_CATALOG.families[1];

  const beforeTemplateReplay = recordCounts(database);
  const templateReplay = await post('/api/jobs/from-template', familyCreateRequests[0]);
  assert.equal(templateReplay.status, 201, JSON.stringify(templateReplay.body));
  assert.equal(templateReplay.body.job.id, created[0].job.id);
  assert.equal(templateReplay.body.jd.id, created[0].jd.id);
  assert.equal(templateReplay.body.profile.id, created[0].profile.id);
  assert.deepEqual(recordCounts(database), beforeTemplateReplay, 'template replay must not add job, JD, profile or audit');
  const templateConflict = await post('/api/jobs/from-template', {
    ...familyCreateRequests[0],
    name: `${familyCreateRequests[0].name}-冲突材料`,
  });
  assert.equal(templateConflict.status, 409, JSON.stringify(templateConflict.body));
  assert.equal(templateConflict.body.code, 'JOB_CREATE_IDEMPOTENCY_CONFLICT');
  assert.deepEqual(recordCounts(database), beforeTemplateReplay, 'template idempotency conflict must not write');

  const parallelTemplateInput = withCreateRequest(
    validInput(firstFamily, firstVariant, '-并发幂等'),
    'parallel-template',
  );
  const beforeParallelTemplate = recordCounts(database);
  const [parallelTemplateA, parallelTemplateB] = await Promise.all([
    post('/api/jobs/from-template', parallelTemplateInput),
    post('/api/jobs/from-template', parallelTemplateInput),
  ]);
  assert.equal(parallelTemplateA.status, 201, JSON.stringify(parallelTemplateA.body));
  assert.equal(parallelTemplateB.status, 201, JSON.stringify(parallelTemplateB.body));
  assert.equal(parallelTemplateA.body.job.id, parallelTemplateB.body.job.id);
  assert.equal(parallelTemplateA.body.jd.id, parallelTemplateB.body.jd.id);
  assert.equal(parallelTemplateA.body.profile.id, parallelTemplateB.body.profile.id);
  const afterParallelTemplate = recordCounts(database);
  assert.equal(afterParallelTemplate.job, beforeParallelTemplate.job + 1);
  assert.equal(afterParallelTemplate.jd, beforeParallelTemplate.jd + 1);
  assert.equal(afterParallelTemplate.profile, beforeParallelTemplate.profile + 1);
  assert.equal(afterParallelTemplate.audit, beforeParallelTemplate.audit + 1);

  const blankInput = {
    requestId: `blank-request-${process.pid}`,
    name: '合成空白幂等岗位',
    hrOwner: '合成 HR',
    plannedHires: 2,
    department: '合成空白部门',
    location: '合成杭州',
    status: 'draft',
  };
  const beforeBlankCreate = recordCounts(database);
  const [blankA, blankB] = await Promise.all([
    post('/api/jobs', blankInput),
    post('/api/jobs', blankInput),
  ]);
  assert.equal(blankA.status, 201, JSON.stringify(blankA.body));
  assert.equal(blankB.status, 201, JSON.stringify(blankB.body));
  assert.equal(blankA.body.job.id, blankB.body.job.id);
  const afterBlankCreate = recordCounts(database);
  assert.equal(afterBlankCreate.job, beforeBlankCreate.job + 1);
  assert.equal(afterBlankCreate.jd, beforeBlankCreate.jd);
  assert.equal(afterBlankCreate.profile, beforeBlankCreate.profile);
  assert.equal(afterBlankCreate.blank_audit, beforeBlankCreate.blank_audit + 1);
  const blankConflict = await post('/api/jobs', { ...blankInput, location: '合成上海' });
  assert.equal(blankConflict.status, 409, JSON.stringify(blankConflict.body));
  assert.equal(blankConflict.body.code, 'JOB_CREATE_IDEMPOTENCY_CONFLICT');
  assert.deepEqual(recordCounts(database), afterBlankCreate, 'blank idempotency conflict must not write');

  for (const [pathname, input] of [
    ['/api/jobs', {}],
    ['/api/jobs/from-template', validInput(firstFamily, firstVariant, '-缺少幂等键')],
  ]) {
    const beforeMissingRequestId = recordCounts(database);
    const response = await post(pathname, input);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.code, 'JOB_CREATE_REQUEST_ID_REQUIRED');
    assert.deepEqual(recordCounts(database), beforeMissingRequestId, 'missing createRequestId must not write');
  }

  const beforeMismatchedRequestIds = recordCounts(database);
  const mismatchedRequestIds = await post('/api/jobs', {
    ...blankInput,
    requestId: 'blank-request-a',
    createRequestId: 'blank-request-b',
  });
  assert.equal(mismatchedRequestIds.status, 400, JSON.stringify(mismatchedRequestIds.body));
  assert.equal(mismatchedRequestIds.body.code, 'JOB_CREATE_REQUEST_ID_MISMATCH');
  assert.deepEqual(recordCounts(database), beforeMismatchedRequestIds, 'mismatched request ids must not write');

  await assertRejectedWithoutWrites(
    { ...validInput(firstFamily, firstVariant, '-伪造状态'), status: 'open' },
    400,
    'JOB_TEMPLATE_INPUT_INVALID',
  );
  for (const forgedField of ['jdText', 'profileConfig', 'templateBody', 'hard_bars', 'deep_profile']) {
    await assertRejectedWithoutWrites(
      { ...validInput(firstFamily, firstVariant, `-${forgedField}`), [forgedField]: { forged: true } },
      400,
      'JOB_TEMPLATE_INPUT_INVALID',
    );
  }
  await assertRejectedWithoutWrites(
    validInput(firstFamily, secondFamily.variants[0], '-跨族'),
    404,
    'JOB_TEMPLATE_VARIANT_NOT_FOUND',
  );
  await assertRejectedWithoutWrites(
    {
      ...validInput(firstFamily, firstVariant, '-未知 HR 字段'),
      hrFields: { arbitrary_system_template_body: '伪造正文' },
    },
    400,
    'JOB_TEMPLATE_HR_FIELD_INVALID',
  );
  await assertRejectedWithoutWrites(
    {
      ...validInput(firstFamily, firstVariant, '-非文本 HR 字段'),
      hrFields: { [firstVariant.hr_variables[0]]: { forged: true } },
    },
    400,
    'JOB_TEMPLATE_HR_FIELD_INVALID',
  );
  await assertRejectedWithoutWrites(
    {
      ...validInput(firstFamily, firstVariant, '-过长 HR 字段'),
      hrFields: { [firstVariant.hr_variables[0]]: 'x'.repeat(2001) },
    },
    400,
    'JOB_TEMPLATE_HR_FIELD_INVALID',
  );

  const storedBeforePurePrepare = database.prepare(`
    SELECT jd.jd_text, profile.config_json
    FROM job_jd_version jd
    JOIN job_profile_version profile ON profile.jd_version_id = jd.id
    WHERE jd.job_id = ?
  `).get(created[0].job.id);
  prepareEcommerceTemplateDraft(validInput(firstFamily, firstVariant, '-后续解析'));
  assert.deepEqual(database.prepare(`
    SELECT jd.jd_text, profile.config_json
    FROM job_jd_version jd
    JOIN job_profile_version profile ON profile.jd_version_id = jd.id
    WHERE jd.job_id = ?
  `).get(created[0].job.id), storedBeforePurePrepare, 'later template reads must not rewrite an existing job');

  database.exec(`
    CREATE TEMP TRIGGER synthetic_template_profile_failure
    BEFORE INSERT ON job_profile_version
    WHEN instr(NEW.source_ref_json, 'ecommerce_job_template') > 0
    BEGIN
      SELECT RAISE(ABORT, 'synthetic template profile failure');
    END;
  `);
  const beforeRollbackProbe = recordCounts(database);
  const rollbackResponse = await post(
    '/api/jobs/from-template',
    withCreateRequest(validInput(firstFamily, firstVariant, '-原子回滚'), 'rollback'),
  );
  assert.equal(rollbackResponse.status, 400, JSON.stringify(rollbackResponse.body));
  assert.equal(rollbackResponse.body.code, 'JOB_TEMPLATE_CREATE_FAILED');
  assert.deepEqual(
    recordCounts(database),
    beforeRollbackProbe,
    'profile insert failure must roll back job, JD, profile and audit together',
  );
  database.exec('DROP TRIGGER synthetic_template_profile_failure');

  console.log(JSON.stringify({
    ok: true,
    contract: 'ECOM-TEMPLATE-FLOW-001',
    family_create_count: created.length,
    variant_resolve_count: variants.length,
    job_status: 'draft',
    jd_status: 'draft',
    profile_status: 'draft',
    profile_bound_to_draft_jd: true,
    automatic_jd_activation: false,
    automatic_profile_confirmation: false,
    boss_publish_called: false,
    ai_called: false,
    template_idempotent_replay: true,
    template_concurrent_replay: true,
    blank_idempotent_replay: true,
    changed_material_conflict_status: 409,
    rollback_probe: 'profile_insert_abort_left_zero_partial_records',
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await shutdown().catch(() => {});
  try { db.conn().close(); } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
});
