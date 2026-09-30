// 外部 AI 生成深度画像、无分数的简历第二意见，以及 HR 已确认测评的岗位匹配分析。
// SABC / quality_score 仍只允许走本地规则；测评 AI 的 fit_score 只进入独立测评结果和辅助信号，不参与默认排序。
// 兼容适配器：生产动作入口已统一使用 f009Runtime 与设置页配置；这里保留给旧配置迁移和历史测试。
// 每次真实网络调用仍必须消费由受信任动作入口签发的一次性用途授权。

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { ensurePrivateFile } = require('./secure-fs');
const { consumeExternalAiAuthorization } = require('./external-ai-authorization');
const {
  REPORT_SYSTEM_PROMPT,
  buildCandidateReportUserPrompt,
  parseCandidateReportReply,
} = require('./candidate-report-v1');
const {
  ASSESSMENT_AI_PURPOSE,
  ASSESSMENT_AI_SYSTEM_PROMPT,
  buildAssessmentAiUserPrompt,
  parseAssessmentAiReply,
} = require('./assessment-ai-analysis');

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

let cachedConfig;

function readRawConfig() {
  const explicit = process.env.HRBOSS_RATING_CONFIG_PATH
    ? path.resolve(process.env.HRBOSS_RATING_CONFIG_PATH)
    : null;
  const runtime = process.env.HRBOSS_DATA_DIR
    ? path.join(path.resolve(process.env.HRBOSS_DATA_DIR), 'rating-config.json')
    : null;
  const legacy = path.join(__dirname, 'rating-config.json');
  const candidates = explicit ? [explicit] : [...new Set([runtime, legacy].filter(Boolean))];
  const configPath = candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0] || legacy;
  if (!fs.existsSync(configPath)) return { raw: null, error: null };
  try {
    ensurePrivateFile(configPath);
    return { raw: JSON.parse(fs.readFileSync(configPath, 'utf8')), error: null };
  } catch (error) {
    return { raw: null, error: `rating-config.json 不是合法 JSON：${error.message}` };
  }
}

function externalAiStatus() {
  const enabled = process.env.HRBOSS_EXTERNAL_AI_ENABLED === '1';
  const { raw, error } = readRawConfig();
  const blockers = [];
  if (!enabled) blockers.push('真实 AI 外发默认关闭；需显式设置 HRBOSS_EXTERNAL_AI_ENABLED=1。');
  if (error) blockers.push(error);
  if (!raw) blockers.push('缺少 rating-config.json。');
  let url = null;
  if (raw) {
    try { url = new URL(String(raw.base_url || '')); } catch { blockers.push('base_url 不是合法 URL。'); }
    if (!raw.api_key) blockers.push('rating-config.json 缺 api_key。');
    if (raw.data_processing_approved !== true) blockers.push('必须显式设置 data_processing_approved=true。');
    if (raw.cost_acknowledged !== true) blockers.push('必须显式设置 cost_acknowledged=true。');
  }
  if (url) {
    const insecureLocalAllowed = process.env.HRBOSS_ALLOW_INSECURE_LOCAL_AI === '1'
      && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !insecureLocalAllowed) blockers.push('真实 AI base_url 必须使用 HTTPS。');
    const allowedHosts = Array.isArray(raw.allowed_hosts)
      ? raw.allowed_hosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean)
      : [];
    if (!allowedHosts.includes(url.hostname.toLowerCase())) blockers.push('base_url 主机不在 allowed_hosts 白名单中。');
  }
  return {
    enabled,
    config_present: !!raw,
    policy_valid: blockers.length === 0,
    provider: raw && raw.provider ? String(raw.provider) : null,
    model: raw && raw.model ? String(raw.model) : null,
    host: url ? url.hostname : null,
    blockers,
  };
}

function loadConfig() {
  // 每次真实调用都重读总开关、审批项和主机白名单，确保运行中撤销授权会立即生效。
  const status = externalAiStatus();
  if (!status.policy_valid) throw new Error(status.blockers.join('；'));
  const { raw } = readRawConfig();
  cachedConfig = {
    base_url: String(raw.base_url).replace(/\/+$/, ''),
    api_key: String(raw.api_key),
    model: raw.model ? String(raw.model) : 'gpt-5.4-mini',
    // 推理档：high 让模型多花心思查水分/找矛盾；配了才带这个参数，老模型不配即可。
    reasoning_effort: raw.reasoning_effort ? String(raw.reasoning_effort) : null,
    timeout_ms: Number(raw.timeout_ms) || 60000,
    provider: raw.provider ? String(raw.provider) : 'approved-provider',
  };
  return cachedConfig;
}

// 供测试注入用：绕过真实配置。
function resetConfigCache() {
  cachedConfig = undefined;
}

// timeoutMs 可选覆盖：深度画像生成要读几万字转写，60 秒不够用（画像 300s / 单评 180s）。
function postJson(cfg, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${cfg.base_url}/chat/completions`);
    const payload = JSON.stringify(body);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.api_key}`,
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        let receivedBytes = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          receivedBytes += Buffer.byteLength(chunk);
          if (receivedBytes > MAX_RESPONSE_BYTES) {
            res.destroy(new Error(`中转 API 响应超过 ${MAX_RESPONSE_BYTES} 字节上限`));
            return;
          }
          data += chunk;
        });
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`中转 API 返回 ${res.statusCode}：${data.slice(0, 300)}`));
          }
          try { resolve(JSON.parse(data)); } catch (err) { reject(new Error(`中转 API 响应不是 JSON：${err.message}`)); }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs || cfg.timeout_ms, () => req.destroy(new Error('中转 API 请求超时')));
    req.write(payload);
    req.end();
  });
}

// 从模型回复里抠出 JSON 对象：容忍代码块围栏和前后废话。抠不出 / 不合法就抛错。
function extractJson(content) {
  let text = String(content || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

// ============ 深度人才画像生成（访谈 → 结构化画像） ============
// 核心纪律：严格区分「负责人明说的」和「AI 推断的」，拿不准一律标推断。
// 画像是给不懂这个岗位的 HR 照着筛简历用的，所以每个能力项都要落到「简历上怎么判」。

const DEEP_PROFILE_SYSTEM_PROMPT = [
  '你是一位资深招聘顾问。用人部门负责人接受了一场关于「这个岗位要招什么人」的访谈，',
  '你的任务是把负责人脑子里模糊的、口语化的要求，整理成一份 HR 能直接照着筛简历的「深度人才画像」。',
  '这位 HR 可能完全没接触过这个岗位，所以画像要写到外行也能执行的程度。',
  '',
  '最重要的纪律——分清两种内容，绝不混淆：',
  '1. stated（负责人明说的）：负责人在访谈里明确说过的要求。source 标 "stated"，quotes 里引负责人原话',
  '   （可以修剪语气词、口头禅，但绝不许改意思、不许把两句话拼成一句）。',
  '2. inferred（你推断的）：负责人没直说、但你根据上下文合理推出来的。source 标 "inferred"，',
  '   inference_basis 里写清楚：从访谈的哪几处、按什么逻辑推出来的。',
  '拿不准算哪种的，一律标 inferred。冒充原话是最严重的错误——负责人看到自己没说过的话被当成他说的，整份画像的信任就没了。',
  '',
  '怎么理解得比字面更深：',
  '3. 别停在字面。负责人说「要会 XX」，多想一层：他要 XX 是为了解决什么问题？把这个写进该项的 why。',
  '4. 负责人讲的具体故事最值钱：他夸过什么人、嫌弃过什么人、上一个员工为什么不行、他自己怎么干这活——',
  '   这些故事里藏着他真正的用人标准，往往比他直接列的条件更真实。',
  '5. 负责人反复强调、语气明显加重、主动绕回来说的点，就算他没说「这是硬要求」，也值得挖出来放进 implicit_preferences。',
  '',
  '每个核心能力项都要落到「简历可判」：',
  '6. resume_evidence：简历上出现什么样的经历/项目/成果，算这项能力的真证据。要具体到 HR 一眼能对照。',
  '7. fake_signals：什么样的写法看着像、其实不算数（比如只写「精通 XX」但没有任何项目支撑；比如挂了个头衔但看不出实际做了什么）。',
  '',
  '诚实面对缺口：',
  '8. 访谈里没聊到、前后矛盾、或者模糊到没法执行的点，不许脑补补齐，全部转成 followup_questions：',
  '   问题要具体到负责人能直接回答（别问「您对能力有什么要求」这种空话），why_ask 写清为什么这个缺口重要。',
  '   kind 从三个里选：gap（没聊到）/ conflict（前后矛盾）/ vague（说了但模糊到没法执行）。',
  '',
  '迭代规则（当输入里有「上一版画像」和「负责人补答」时）：',
  '9. 补答是负责人亲口给的，视同访谈原话（stated）。',
  '10. 上一版里 inferred 的条目，这轮被负责人证实的升级为 stated；被否定的直接删掉；没提到的保持 inferred。',
  '11. 已经得到回答的追问，从 followup_questions 里移出；还没回答的保留。',
  '',
  '只输出一个 JSON，不要任何多余文字、不要代码块围栏。所有键必须齐全，没有内容的数组给空数组：',
  '{',
  '  "position_mission": {"content": "这个岗位存在的意义、要解决什么问题", "source": "stated|inferred|mixed", "quotes": ["原话"], "inference_basis": ""},',
  '  "hard_requirements": [{"item": "硬性要求", "detail": "补充说明", "source": "stated|inferred", "quotes": [], "inference_basis": ""}],',
  '  "core_competencies": [{"name": "能力名", "what": "具体指什么", "why": "负责人为什么要这个", "source": "stated|inferred", "quotes": [], "inference_basis": "", "resume_evidence": ["简历上什么算真证据"], "fake_signals": ["什么写法看着像其实不算"]}],',
  '  "plus_points": [{"item": "加分项", "detail": "", "source": "stated|inferred", "quotes": [], "inference_basis": ""}],',
  '  "minus_points": [{"item": "减分项", "detail": "", "source": "stated|inferred", "quotes": [], "inference_basis": ""}],',
  '  "deal_breakers": [{"item": "一票否决项", "detail": "", "source": "stated|inferred", "quotes": [], "inference_basis": ""}],',
  '  "implicit_preferences": [{"observation": "负责人没明说但明显在意的偏好", "basis": "从哪看出来的"}],',
  '  "followup_questions": [{"question": "给负责人的具体追问", "why_ask": "为什么要问", "kind": "gap|conflict|vague"}]',
  '}',
].join('\n');

function buildDeepProfileUserPrompt({ jobName, rubric, transcripts, previousProfile, followupAnswers }) {
  const parts = [];
  parts.push(`【岗位】\n${(jobName || '').trim() || '（未命名岗位）'}`);
  const r = (rubric || '').trim();
  if (r) parts.push(`【HR 手上的简版画像（仅供参考，以访谈为准）】\n${r}`);
  (transcripts || []).forEach((t, i) => {
    const label = transcripts.length > 1 ? `访谈转写 ${i + 1}` : '访谈转写';
    const meta = [t.note, t.created_at].filter(Boolean).join('，');
    parts.push(`【${label}${meta ? `（${meta}）` : ''}】\n${(t.text || '').trim()}`);
  });
  if (previousProfile) {
    parts.push(`【上一版深度画像（按迭代规则更新它，别从头重来）】\n${JSON.stringify(previousProfile, null, 2)}`);
  }
  if (followupAnswers && followupAnswers.length) {
    const body = followupAnswers.map((a, i) => `补答 ${i + 1}（${a.created_at || ''}）：\n${(a.text || '').trim()}`).join('\n\n');
    parts.push(`【负责人对追问的补答（视同访谈原话）】\n${body}`);
  }
  return parts.join('\n\n');
}

const DEEP_PROFILE_LIST_ITEM_KEYS = ['hard_requirements', 'plus_points', 'minus_points', 'deal_breakers'];

function normalizeSource(value, allowMixed) {
  const v = String(value || '').trim();
  if (v === 'stated') return 'stated';
  if (allowMixed && v === 'mixed') return 'mixed';
  // 非法值一律归为 inferred：宁可把原话标成猜的，也不能把猜的冒充原话。
  return 'inferred';
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v || '').trim()).filter(Boolean);
}

// 把模型返回的画像文本校验成结构化 doc。校验失败抛错——上层不写库，draft 语义容忍重试。
function parseDeepProfileReply(content) {
  const obj = extractJson(content);
  if (!obj || typeof obj !== 'object') throw new Error('模型没返回画像 JSON');
  const pm = obj.position_mission;
  if (!pm || typeof pm !== 'object' || !String(pm.content || '').trim()) {
    throw new Error('模型没给出 position_mission（岗位使命）');
  }
  const doc = {
    position_mission: {
      content: String(pm.content).trim(),
      source: normalizeSource(pm.source, true),
      quotes: toStringArray(pm.quotes),
      inference_basis: String(pm.inference_basis || '').trim(),
    },
  };
  for (const key of DEEP_PROFILE_LIST_ITEM_KEYS) {
    doc[key] = (Array.isArray(obj[key]) ? obj[key] : [])
      .map((it) => ({
        item: String((it && it.item) || '').trim(),
        detail: String((it && it.detail) || '').trim(),
        source: normalizeSource(it && it.source, false),
        quotes: toStringArray(it && it.quotes),
        inference_basis: String((it && it.inference_basis) || '').trim(),
      }))
      .filter((it) => it.item);
  }
  doc.core_competencies = (Array.isArray(obj.core_competencies) ? obj.core_competencies : [])
    .map((it) => ({
      name: String((it && it.name) || '').trim(),
      what: String((it && it.what) || '').trim(),
      why: String((it && it.why) || '').trim(),
      source: normalizeSource(it && it.source, false),
      quotes: toStringArray(it && it.quotes),
      inference_basis: String((it && it.inference_basis) || '').trim(),
      resume_evidence: toStringArray(it && it.resume_evidence),
      fake_signals: toStringArray(it && it.fake_signals),
    }))
    .filter((it) => it.name);
  doc.implicit_preferences = (Array.isArray(obj.implicit_preferences) ? obj.implicit_preferences : [])
    .map((it) => ({
      observation: String((it && it.observation) || '').trim(),
      basis: String((it && it.basis) || '').trim(),
    }))
    .filter((it) => it.observation);
  doc.followup_questions = (Array.isArray(obj.followup_questions) ? obj.followup_questions : [])
    .map((it) => ({
      question: String((it && it.question) || '').trim(),
      why_ask: String((it && it.why_ask) || '').trim(),
      kind: ['gap', 'conflict', 'vague'].includes(it && it.kind) ? it.kind : 'gap',
    }))
    .filter((it) => it.question);
  return doc;
}

// 生成深度画像。成功返回结构化 doc；失败抛错（上层不写库）。
async function generateDeepProfile({ jobName, rubric, transcripts, previousProfile, followupAnswers }, authorization) {
  consumeExternalAiAuthorization(authorization, 'deep-profile');
  const cfg = loadConfig();
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: DEEP_PROFILE_SYSTEM_PROMPT },
      { role: 'user', content: buildDeepProfileUserPrompt({ jobName, rubric, transcripts, previousProfile, followupAnswers }) },
    ],
  };
  if (cfg.reasoning_effort) body.reasoning_effort = cfg.reasoning_effort;
  else body.temperature = 0;
  // 要通读几万字转写再产出大 JSON，超时放宽到 5 分钟。
  const resp = await postJson(cfg, body, Math.max(cfg.timeout_ms, 300000));
  const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
  return parseDeepProfileReply(content);
}

// ============ 单人评估（第二意见，绝不给分数/档位） ============

const ASSESS_SYSTEM_PROMPT = [
  '你是一位资深的招聘 / 人才评估专家，帮一位对这个岗位不熟的 HR 看一份简历。',
  '你会拿到一份「深度人才画像」——它来自对用人部门负责人的访谈，里面每项都标了是负责人明说的（stated）还是 AI 推断的（inferred）。',
  '你的任务：逐项对照画像看这份简历，给 HR 一个第二意见，帮他判断这个人值不值得往下推。',
  '',
  '对照方法：',
  '1. 先过 hard_requirements 和 deal_breakers：有没有踩一票否决、缺硬性要求的，有就直说。',
  '2. 再把 core_competencies 一项一项过：这份简历上有没有这项能力的证据。',
  '3. 匹配点必须落在简历的具体事实上（他在哪做过什么、结果如何），并按该项的 resume_evidence 标准判断证据硬不硬。',
  '   命中 fake_signals 的写法（比如只写「精通」没有支撑），算疑虑点，不算匹配点。绝不接受「简历上写了」当证据。',
  '4. 查水分：口号无支撑、时间线矛盾、职级年限跟经历深度不匹配、成果数字夸张却没说怎么做到的——都点出来放进疑虑。',
  '5. 你只看得到文字，看不到真人，不要冒充「确认了真假」。拿不准的，转成面试核实建议：问什么问题、听到什么样的回答算过关、什么样算露馅。',
  '6. 画像里标 inferred 的条目，对照时留有余地——用「如果负责人确实在意 X，那么…」的口吻，别把推断当铁律。',
  '',
  '硬性禁令（最重要）：',
  '7. 不许输出任何分数、百分比、评级、档位（S/A/B/C/D 之类）或定档建议。这个工具里定档是另一套流程，你的报告是纯参考意见。',
  '   overall 里用大白话下判断（值得推 / 建议面试重点核实 / 不太对口……），敢下结论，但把不确定性说清楚。',
  '',
  '只输出一个 JSON，不要任何多余文字、不要代码块围栏：',
  '{',
  '  "matches": [{"competency": "对应画像哪一项", "point": "匹配在哪", "evidence": "简历上的具体事实"}],',
  '  "concerns": [{"competency": "对应画像哪一项（没有就留空）", "point": "疑虑是什么", "basis": "从简历哪里看出来的", "severity": "高|中|低"}],',
  '  "verify_in_interview": [{"question": "面试该问什么", "listen_for": "听到什么算过关、什么算露馅"}],',
  '  "overall": "一段大白话综合意见"',
  '}',
].join('\n');

function buildAssessUserPrompt({ deepProfile, rubric, resumeText, hardBarNotes }) {
  const parts = [];
  if (deepProfile) {
    parts.push(`【深度人才画像（来自负责人访谈）】\n${JSON.stringify(deepProfile, null, 2)}`);
  } else {
    const r = (rubric || '').trim();
    parts.push(`【岗位画像（简版，该岗位还没生成深度画像）】\n${r || '岗位方没写具体要求。你就按这个人本身的基本盘、经历含金量、稳定性和成长性给参考意见。'}`);
  }
  if (hardBarNotes && hardBarNotes.length) parts.push(`【注意】\n${hardBarNotes.join('；')}`);
  parts.push(`【候选人在线简历】\n${(resumeText || '').trim() || '（简历内容为空）'}`);
  return parts.join('\n\n');
}

// 校验评估报告。overall 必填否则抛错；三个数组缺了补空。schema 里没有任何分数/档位字段可写。
function parseAssessReply(content) {
  const obj = extractJson(content);
  if (!obj || typeof obj !== 'object') throw new Error('模型没返回评估 JSON');
  const overall = String(obj.overall || '').trim();
  if (!overall) throw new Error('模型没给出 overall 综合意见');
  const matches = (Array.isArray(obj.matches) ? obj.matches : [])
    .map((it) => ({
      competency: String((it && it.competency) || '').trim(),
      point: String((it && it.point) || '').trim(),
      evidence: String((it && it.evidence) || '').trim(),
    }))
    .filter((it) => it.point);
  const concerns = (Array.isArray(obj.concerns) ? obj.concerns : [])
    .map((it) => ({
      competency: String((it && it.competency) || '').trim(),
      point: String((it && it.point) || '').trim(),
      basis: String((it && it.basis) || '').trim(),
      severity: ['高', '中', '低'].includes(it && it.severity) ? it.severity : '中',
    }))
    .filter((it) => it.point);
  const verify = (Array.isArray(obj.verify_in_interview) ? obj.verify_in_interview : [])
    .map((it) => ({
      question: String((it && it.question) || '').trim(),
      listen_for: String((it && it.listen_for) || '').trim(),
    }))
    .filter((it) => it.question);
  return { matches, concerns, verify_in_interview: verify, overall };
}

// 单人评估（第二意见）。成功返回报告对象；失败抛错（上层不写库）。
async function assessCandidate({ deepProfile, rubric, resumeText, hardBarNotes }, authorization) {
  consumeExternalAiAuthorization(authorization, 'candidate-assessment');
  const cfg = loadConfig();
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: ASSESS_SYSTEM_PROMPT },
      { role: 'user', content: buildAssessUserPrompt({ deepProfile, rubric, resumeText, hardBarNotes }) },
    ],
  };
  if (cfg.reasoning_effort) body.reasoning_effort = cfg.reasoning_effort;
  else body.temperature = 0;
  const resp = await postJson(cfg, body, Math.max(cfg.timeout_ms, 180000));
  const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
  return parseAssessReply(content);
}

// ============ 候选人匹配报告 V1（动态雷达 + Unknown） ============

async function assessCandidateV1({ jobName, candidateName, deepProfile, rubric, evidenceProfile, dimensions }, authorization) {
  consumeExternalAiAuthorization(authorization, 'candidate-assessment');
  const cfg = loadConfig();
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: buildCandidateReportUserPrompt({ jobName, candidateName, deepProfile, rubric, evidenceProfile, dimensions }) },
    ],
  };
  if (cfg.reasoning_effort) body.reasoning_effort = cfg.reasoning_effort;
  else body.temperature = 0;
  const resp = await postJson(cfg, body, Math.max(cfg.timeout_ms, 180000));
  const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
  return parseCandidateReportReply(content, { jobName, candidateName, deepProfile, rubric, evidenceProfile, dimensions });
}

// ============ 测评组合 AI 分析（已确认测评 + 岗位 + 简历 + 已确认面试） ============

async function analyzeAssessmentPortfolio(input, authorization) {
  consumeExternalAiAuthorization(authorization, ASSESSMENT_AI_PURPOSE);
  const cfg = loadConfig();
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: ASSESSMENT_AI_SYSTEM_PROMPT },
      { role: 'user', content: buildAssessmentAiUserPrompt(input) },
    ],
  };
  if (cfg.reasoning_effort) body.reasoning_effort = cfg.reasoning_effort;
  else body.temperature = 0;
  const resp = await postJson(cfg, body, Math.max(cfg.timeout_ms, 180000));
  const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
  return parseAssessmentAiReply(content, { allowedEvidenceRefs: input.allowed_evidence_refs });
}

module.exports = {
  DEEP_PROFILE_SYSTEM_PROMPT,
  ASSESS_SYSTEM_PROMPT,
  loadConfig,
  resetConfigCache,
  extractJson,
  generateDeepProfile,
  parseDeepProfileReply,
  buildDeepProfileUserPrompt,
  assessCandidate,
  parseAssessReply,
  buildAssessUserPrompt,
  assessCandidateV1,
  analyzeAssessmentPortfolio,
  externalAiStatus,
  parseCandidateReportReply,
  buildCandidateReportUserPrompt,
};
