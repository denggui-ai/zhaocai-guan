#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  JOB_JD_OPTIMIZATION_PURPOSE,
  buildJobJdOptimizationUserPrompt,
  deterministicComplianceWarnings,
  parseJobJdOptimizationReply,
} = require('./job-jd-ai');
const { issueExternalAiAuthorization } = require('./external-ai-authorization');
const {
  issueExternalAiUserApproval,
  consumeExternalAiUserApproval,
} = require('./external-ai-user-approval');
const { createF009LlmRuntime } = require('./f009-interview-llm');
const { describeModel } = require('./external-ai-policy');
const {
  externalAiMaterialHash,
  externalAiMaterialSnapshot,
} = require('./external-ai-material-hash');

assert.equal(JOB_JD_OPTIMIZATION_PURPOSE, 'job-jd-optimization');

const syntheticPreviewDatabase = {
  prepare() {
    throw new Error('JD preview must not query candidate material');
  },
};
const syntheticPreviewDbApi = {
  getJobForFetch(jobId) {
    return { id: Number(jobId), name: '合成岗位', status: 'open' };
  },
};
const syntheticPreviewOptions = {
  database: syntheticPreviewDatabase,
  dbApi: syntheticPreviewDbApi,
  purpose: JOB_JD_OPTIMIZATION_PURPOSE,
  targetId: '101',
  materialInput: {
    brief: '合成招聘需求，仅用于发送预览测试。',
    currentJd: '合成现有 JD，不含真实候选人。',
  },
};
const syntheticPreview = externalAiMaterialSnapshot(syntheticPreviewOptions);
assert.equal(syntheticPreview.materialHash, externalAiMaterialHash(syntheticPreviewOptions));
assert.equal(syntheticPreview.preview.characterCount, syntheticPreview.preview.text.length);
assert.match(syntheticPreview.preview.text, /【模型系统规则】/);
assert.match(syntheticPreview.preview.text, /【本次发送材料】[\s\S]*合成招聘需求/);
assert.match(syntheticPreview.preview.exclusions.join('\n'), /候选人、简历、测评和面试材料/);

const prompt = buildJobJdOptimizationUserPrompt({
  jobName: '千川优化师',
  brief: '帮我招一个会千川投放、能复盘的人，薪资还没定。',
  currentJd: '负责账户日常投放。',
});
assert.match(prompt, /千川优化师/);
assert.match(prompt, /薪资还没定/);
assert.match(prompt, /负责账户日常投放/);

const draft = parseJobJdOptimizationReply(JSON.stringify({
  job_title: '千川优化师',
  job_goal: '持续提升投放效率',
  responsibilities: ['制定投放策略', '日常调优与复盘'],
  requirements: ['能根据数据定位问题'],
  nice_to_haves: ['有直播投放经验'],
  known_work_arrangements: [],
  missing_information: [{ field: '薪资范围', question: '该岗位的薪资范围是多少？' }],
  compliance_warnings: [{ issue: '不应承诺保底结果', suggestion: '改为描述工作目标。' }],
  boss_keywords: ['千川投放', '数据复盘'],
  full_text: '岗位职责：\n1. 制定投放策略。\n\n任职要求：\n1. 能根据数据定位问题。',
}));
assert.equal(draft.job_title, '千川优化师');
assert.equal(draft.responsibilities.length, 2);
assert.equal(draft.missing_information[0].field, '薪资范围');
assert.equal(draft.compliance_warnings[0].issue, '不应承诺保底结果');
assert.match(draft.full_text, /岗位职责/);
assert.throws(() => parseJobJdOptimizationReply('{"responsibilities":[]}'), /可编辑的 JD 草稿/);
assert.throws(
  () => parseJobJdOptimizationReply({ full_text: '合成 JD', requirements: '不是数组' }),
  /requirements 必须是数组/,
);
assert.throws(
  () => parseJobJdOptimizationReply({ full_text: '合成 JD', server_owned: true }),
  /未知 JD 字段：server_owned/,
);
assert.throws(
  () => parseJobJdOptimizationReply({ full_text: 'x'.repeat(50001) }),
  /full_text 过长/,
);

const guardedDraft = parseJobJdOptimizationReply({
  full_text: '仅限 25 岁以下女性；提供双休；月薪 100 万。',
  compliance_warnings: [],
}, {
  jobName: '合成岗位',
  brief: '负责内容运营，薪资和休息安排尚未确定。',
  currentJd: '',
});
assert.match(guardedDraft.compliance_warnings.map((item) => item.issue).join('\n'), /性别限制或偏好/);
assert.match(guardedDraft.compliance_warnings.map((item) => item.issue).join('\n'), /年龄限制/);
assert.match(guardedDraft.compliance_warnings.map((item) => item.issue).join('\n'), /未提供的福利或工作安排/);
assert.match(guardedDraft.compliance_warnings.map((item) => item.issue).join('\n'), /未提供的数字事实/);
const structuredGuardedDraft = parseJobJdOptimizationReply({
  requirements: ['招聘女性候选人，年龄 20-28 岁'],
  known_work_arrangements: ['双休'],
  boss_keywords: ['女性优先'],
  full_text: '负责内容运营。',
}, {
  jobName: '合成岗位',
  brief: '负责内容运营，其他条件尚未确定。',
  currentJd: '',
});
assert.match(
  structuredGuardedDraft.compliance_warnings.map((item) => item.issue).join('\n'),
  /性别限制或偏好[\s\S]*年龄限制[\s\S]*未提供的福利或工作安排/,
  'visible structured output must not bypass deterministic compliance checks',
);
assert.equal(
  deterministicComplianceWarnings('负责女装类目运营，不限制候选人性别。').length,
  0,
  'product-category language must not be mislabeled as a gender restriction',
);

const userApprovalSecret = 'synthetic-jd-user-approval-secret-20260718';
const userApprovalBinding = {
  purpose: JOB_JD_OPTIMIZATION_PURPOSE,
  targetId: '101',
  requestId: 'job-jd:101:synthetic-001',
  actor: 'local-primary-operator',
  materialSha256: 'a'.repeat(64),
  provider: 'synthetic',
  baseUrl: 'https://ai.example.test/v1',
  model: 'gpt-synthetic-jd',
};
const consumedUserApprovals = new Set();
const userApproval = issueExternalAiUserApproval(userApprovalSecret, userApprovalBinding);
assert.equal(
  consumeExternalAiUserApproval(
    userApprovalSecret,
    userApproval,
    userApprovalBinding,
    consumedUserApprovals,
  ).binding.purpose,
  JOB_JD_OPTIMIZATION_PURPOSE,
);
assert.throws(
  () => consumeExternalAiUserApproval(
    userApprovalSecret,
    userApproval,
    userApprovalBinding,
    consumedUserApprovals,
  ),
  /已使用/,
);
const changedMaterialApproval = issueExternalAiUserApproval(userApprovalSecret, userApprovalBinding);
assert.throws(
  () => consumeExternalAiUserApproval(
    userApprovalSecret,
    changedMaterialApproval,
    { ...userApprovalBinding, materialSha256: 'b'.repeat(64) },
    new Set(),
  ),
  /不一致/,
);

const actionSource = fs.readFileSync(path.join(__dirname, 'action-server.js'), 'utf8');
const principalSource = fs.readFileSync(path.join(__dirname, 'local-principal.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, 'candidate-main.js'), 'utf8');
const apiSource = fs.readFileSync(path.join(__dirname, 'frontend/src/api.js'), 'utf8');
assert.match(actionSource, /\/api\/job-jd\/optimize[\s\S]*consumeExternalAiUserApproval[\s\S]*optimizeJobDescription/);
assert.match(actionSource, /\/api\/job-jd\/optimize[\s\S]*currentExternalAiMaterialHash[\s\S]*materialSha256/);
assert.match(principalSource, /external_ai\.execute[\s\S]*\/api\/job-jd\/optimize/);
assert.match(mainSource, /job-jd-optimization[\s\S]*确认发送岗位需求到外部 AI/);
assert.match(mainSource, /实际发送文本开始[\s\S]*materialPreview\.text[\s\S]*实际发送文本结束/);
assert.match(mainSource, /发送文本字符数：\$\{materialPreview\.characterCount\}/);
assert.match(mainSource, /排除项：\$\{exclusions\.length/);
assert.match(apiSource, /optimizeJobJd[\s\S]*\/job-jd\/optimize/);
const runtimeSource = fs.readFileSync(path.join(__dirname, 'f009-interview-llm.js'), 'utf8');
assert.match(runtimeSource, /parseJobJdOptimizationReply\(extractReply\(response\), input\)/);

async function checkConfiguredRuntime() {
  const previous = {
    enabled: process.env.HRBOSS_EXTERNAL_AI_ENABLED,
    apiKey: process.env.HRBOSS_EXTERNAL_AI_API_KEY,
    model: process.env.HRBOSS_EXTERNAL_AI_MODEL,
  };
  process.env.HRBOSS_EXTERNAL_AI_ENABLED = '1';
  process.env.HRBOSS_EXTERNAL_AI_API_KEY = 'synthetic-jd-ai-key';
  process.env.HRBOSS_EXTERNAL_AI_MODEL = 'gpt-synthetic-jd';
  let request;
  try {
    const runtime = createF009LlmRuntime({
      env: {
        HRBOSS_EXTERNAL_AI_PROVIDER: 'synthetic',
        HRBOSS_EXTERNAL_AI_BASE_URL: 'https://ai.example.test/v1',
        HRBOSS_EXTERNAL_AI_ENABLED: '1',
        HRBOSS_EXTERNAL_AI_API_KEY: 'synthetic-jd-ai-key',
        HRBOSS_EXTERNAL_AI_MODEL: 'gpt-synthetic-jd',
      },
      initialSupportedModels: [
        describeModel('gpt-synthetic-jd', { verified: true }),
        describeModel('gpt-synthetic-jd-b', { verified: true }),
      ],
      transport: async (input) => {
        request = input;
        return {
          model: 'gpt-synthetic-jd',
          choices: [{ message: { content: JSON.stringify({ full_text: '岗位职责：负责合成测试。' }) } }],
        };
      },
    });
    const authorization = issueExternalAiAuthorization({
      purpose: JOB_JD_OPTIMIZATION_PURPOSE,
      confirmed: true,
      binding: {
        provider: runtime.publicConfig().provider,
        base_url: runtime.publicConfig().baseUrl,
        model: runtime.publicConfig().model,
      },
    });
    const optimized = await runtime.optimizeJobDescription({
      jobName: '合成岗位',
      brief: '需要一名能复盘的人',
      currentJd: '',
    }, authorization);
    assert.equal(optimized.full_text, '岗位职责：负责合成测试。');
    assert.equal(request.body.model, 'gpt-synthetic-jd');
    assert.match(request.body.messages[1].content, /需要一名能复盘的人/);
    await assert.rejects(
      () => runtime.optimizeJobDescription({ jobName: '合成岗位', brief: '重复请求' }, authorization),
      /缺少本次 job-jd-optimization 调用的一次性授权/,
    );
    const modelBoundAuthorization = issueExternalAiAuthorization({
      purpose: JOB_JD_OPTIMIZATION_PURPOSE,
      confirmed: true,
      binding: {
        provider: runtime.publicConfig().provider,
        base_url: runtime.publicConfig().baseUrl,
        model: runtime.publicConfig().model,
      },
    });
    runtime.configure({ model: 'gpt-synthetic-jd-b' });
    await assert.rejects(
      () => runtime.optimizeJobDescription(
        { jobName: '合成岗位', brief: '模型切换后不得沿用旧授权' },
        modelBoundAuthorization,
      ),
      /内容与发送预览授权不一致/,
    );
  } finally {
    if (previous.enabled === undefined) delete process.env.HRBOSS_EXTERNAL_AI_ENABLED;
    else process.env.HRBOSS_EXTERNAL_AI_ENABLED = previous.enabled;
    if (previous.apiKey === undefined) delete process.env.HRBOSS_EXTERNAL_AI_API_KEY;
    else process.env.HRBOSS_EXTERNAL_AI_API_KEY = previous.apiKey;
    if (previous.model === undefined) delete process.env.HRBOSS_EXTERNAL_AI_MODEL;
    else process.env.HRBOSS_EXTERNAL_AI_MODEL = previous.model;
  }
}

checkConfiguredRuntime().then(() => {
  console.log('JD AI draft parser, configured runtime and guarded route contracts passed');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
