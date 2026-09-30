const SCHEMA_VERSION = 'candidate_evaluation_report_v1';
const REPORT_DISCLAIMER = '本报告基于已采集的结构化简历字段生成，仅用于招聘辅助，不代表自动录用或淘汰。';
const LOCAL_DEMO_DISCLAIMER = '本报告是本地样本，只用于验证 UI/DB/能力雷达链路，不代表真实 AI 判断，也不作为录用、淘汰、排序或自动动作依据。';

const ALLOWED_STATES = new Set(['Match', 'Mismatch', 'Unknown']);
const FORBIDDEN_KEYS = new Set([
  'fit_score',
  'fitscore',
  'quality_score',
  'qualityscore',
  'sabc',
  'tier',
  'rank',
  'ranking',
  'hire',
  'reject',
  'auto_hire',
  'auto_reject',
]);

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clip(value, max = 360) {
  const text = clean(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function knownSensitiveResumeLiterals(sections) {
  const s = sections && typeof sections === 'object' ? sections : {};
  const values = [];
  const add = (value) => {
    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    const normalized = clean(value);
    if (normalized.replace(/\s+/g, '').length >= 2) values.push(normalized);
  };
  asArray(s.basic).forEach((item) => {
    ['name', 'age', 'salary', 'phone', 'mobile', 'email', 'wechat', 'address'].forEach((key) => add(item && item[key]));
  });
  asArray(s.expect).forEach((item) => add(item && item.salary));
  asArray(s.edu).forEach((item) => {
    add(item && item.school);
    add(item && item.school_tier);
    add(item && item.tags);
  });
  if (s.contact && typeof s.contact === 'object') add(Object.values(s.contact));
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

function removeKnownSensitiveLiterals(value, literals) {
  let output = clean(value);
  asArray(literals).forEach((literal) => {
    const compact = clean(literal).replace(/\s+/g, '');
    if (compact.length < 2) return;
    const flexible = [...compact].map(escapeRegExp).join('\\s*');
    output = output.replace(new RegExp(flexible, 'gi'), '');
  });
  return output;
}

function scrubSensitive(value, sensitiveLiterals = []) {
  return removeKnownSensitiveLiterals(value, sensitiveLiterals)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '')
    .replace(/(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}/g, '')
    .replace(/\b\d{17}[\dXx]\b|\b\d{15}\b/g, '')
    .replace(/\d{1,2}\s*岁/g, '')
    .replace(/\d+\s*-\s*\d+\s*[kK]|(?:月薪|薪资|期望薪资)[:：]?\s*\d+\s*[kK]/g, '')
    .replace(/985|211|双一流|一本|重点院校|名校/g, '')
    .replace(/(?:微信(?:号)?|wechat|wx|手机(?:号)?|电话|邮箱|email)[:：]?\s*[A-Za-z0-9_.@+-]{4,}/gi, '')
    .replace(/(?:住址|地址|家庭地址|现居地?|所在地|籍贯)[:：]?\s*[^，。；;\n]{2,40}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pushEvidence(items, section, index, field, value, sourceType, sensitiveLiterals) {
  const text = clip(scrubSensitive(value, sensitiveLiterals));
  if (!text) return;
  const id = `${section}.${index}.${field}`;
  items.push({ id, section, index, field, text, source_type: sourceType || 'resume_fact' });
}

function buildEducationSummary(sections) {
  const parts = [];
  const basic = asArray(sections && sections.basic)[0] || {};
  if (clean(basic.degree)) parts.push(clean(basic.degree));
  asArray(sections && sections.edu).forEach((edu) => {
    const row = [edu && edu.degree, edu && edu.major].map(clean).filter(Boolean).join(' / ');
    if (row) parts.push(row);
  });
  return [...new Set(parts)].slice(0, 3).join('；') || 'Unknown';
}

function buildWorkSummary(sections) {
  const work = asArray(sections && sections.work).length;
  const proj = asArray(sections && sections.proj).length;
  const basic = asArray(sections && sections.basic)[0] || {};
  return [clean(basic.work_years), work ? `${work}段工作经历` : '', proj ? `${proj}段项目经历` : '']
    .filter(Boolean)
    .join('；') || 'Unknown';
}

function buildEvidenceProfile(sections) {
  const s = sections && typeof sections === 'object' ? sections : {};
  const evidenceItems = [];
  const sensitiveLiterals = knownSensitiveResumeLiterals(s);

  asArray(s.basic).slice(0, 1).forEach((item, index) => {
    pushEvidence(evidenceItems, 'basic', index, 'description', item && item.description, 'self_description', sensitiveLiterals);
  });
  asArray(s.work).slice(0, 8).forEach((item, index) => {
    pushEvidence(evidenceItems, 'work', index, 'title', item && item.title, undefined, sensitiveLiterals);
    pushEvidence(evidenceItems, 'work', index, 'desc', item && item.desc, undefined, sensitiveLiterals);
  });
  asArray(s.proj).slice(0, 8).forEach((item, index) => {
    pushEvidence(evidenceItems, 'proj', index, 'name', item && item.name, undefined, sensitiveLiterals);
    pushEvidence(evidenceItems, 'proj', index, 'role', item && item.role, undefined, sensitiveLiterals);
    pushEvidence(evidenceItems, 'proj', index, 'desc', item && item.desc, undefined, sensitiveLiterals);
  });
  asArray(s.skill).slice(0, 6).forEach((item, index) => {
    pushEvidence(evidenceItems, 'skill', index, 'text', item && item.text, 'claim_only', sensitiveLiterals);
  });

  return {
    schema_version: 'evidence_profile_v1',
    allowed_sources: ['resume_online.sections_json'],
    excluded_from_scoring: ['age', 'salary', 'contact', 'school', 'school_tier', 'school_tags', 'ai_reviews', 'candidate_scores'],
    candidate_summary: {
      education: buildEducationSummary(s),
      work_experience: buildWorkSummary(s),
      summary: clip(scrubSensitive((asArray(s.basic)[0] || {}).description, sensitiveLiterals), 220),
    },
    evidence_items: evidenceItems,
  };
}

function addDimension(out, seen, item) {
  const name = clean(item && (item.name || item.dimension || item.item));
  if (!name || seen.has(name)) return;
  seen.add(name);
  out.push({
    id: `dimension_${out.length + 1}`,
    name,
    what: clean(item && (item.what || item.detail || item.why)),
    resume_evidence: asArray(item && item.resume_evidence).map(clean).filter(Boolean),
    fake_signals: asArray(item && item.fake_signals).map(clean).filter(Boolean),
    source: clean(item && item.source) || 'rubric',
  });
}

function fallbackDimensionsFromRubric(rubric) {
  const text = clean(rubric);
  const patterns = [
    { name: 'AI/大模型落地', re: /AI|Agent|大模型|LLM|RAG|提示词|智能体/i, what: '是否有真实 AI 应用、Agent 或大模型项目落地证据' },
    { name: '工程实现能力', re: /后端|前端|全栈|Java|Node|React|系统|架构|接口|平台/i, what: '是否能把需求实现为稳定可维护的工程系统' },
    { name: '自动化/RPA经验', re: /RPA|自动化|流程|脚本|机器人/i, what: '是否做过流程自动化、脚本化或 RPA 落地' },
    { name: '数据分析与复盘', re: /数据|SQL|BI|指标|分析|复盘|报表/i, what: '是否能用数据分析问题并复盘结果' },
    { name: '业务场景理解', re: /电商|直播|投放|运营|供应链|OMS|WMS|CRM|ERP/i, what: '是否理解岗位所在业务场景和核心流程' },
    { name: '项目交付深度', re: /独立|主导|负责|上线|交付|落地|从0到1/i, what: '是否有清晰的个人职责、交付过程和结果证据' },
  ];
  const out = [];
  const seen = new Set();
  patterns.forEach((p) => {
    if (p.re.test(text)) addDimension(out, seen, { name: p.name, what: p.what, source: 'rubric' });
  });
  const generic = [
    { name: '岗位核心经验', what: '是否具备岗位最核心任务的相关经历' },
    { name: '相关项目证据', what: '是否有工作或项目经历支撑能力声明' },
    { name: '技能落地深度', what: '是否能说明工具、方法和个人贡献' },
    { name: '结果与影响', what: '是否有可解释的结果、影响或复盘' },
    { name: '风险与待核实点', what: '是否存在需要面试进一步确认的能力缺口' },
  ];
  generic.forEach((item) => {
    if (out.length < 4) addDimension(out, seen, { ...item, source: text ? 'rubric_fallback' : 'unknown_fallback' });
  });
  return out.slice(0, 6);
}

function buildReportDimensions(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const deepDoc = cfg.deep_profile && cfg.deep_profile.doc ? cfg.deep_profile.doc : null;
  const out = [];
  const seen = new Set();
  asArray(deepDoc && deepDoc.core_competencies).forEach((item) => addDimension(out, seen, item));
  fallbackDimensionsFromRubric(cfg.rubric).forEach((item) => {
    if (out.length < 4) addDimension(out, seen, item);
  });
  return out.slice(0, 6);
}

const REPORT_SYSTEM_PROMPT = [
  '你是一位资深招聘分析师，任务是生成 HR 候选人匹配报告 V1。',
  '这份报告只用于 HR 决策辅助，不代表自动录用或淘汰。',
  '',
  '硬性规则：',
  '1. 只能使用输入里的 evidence_items 作为简历证据，不能使用历史 AI 评论、历史评分、SABC、quality_score、expert_comment 或外部常识补全。',
  '2. 年龄、薪资、联系方式、学校、学校标签不得作为能力评分依据；这些字段即便出现也不能引用。',
  '3. 每个维度只能是 Match / Mismatch / Unknown。',
  '4. 没有 evidence_items 支撑的维度必须输出 Unknown，score 必须是 null，evidence 必须是 []，Unknown 不作为扣分项。',
  '5. 只有技能词或自我描述、没有工作/项目经历支撑时，不得给高分；应标为低置信度、风险或 Unknown。',
  '6. score 仅用于该维度雷达，范围 0-10；不要输出 fit_score、SABC、tier、hire、reject、排名、录用/淘汰决定。',
  '7. 每个维度解释必须包含 fact、judgment、impact，遵守“事实 -> 判断 -> 影响”。',
  '',
  '只输出一个 JSON，不要任何多余文字、不要代码块围栏。schema 必须是：',
  JSON.stringify({
    schema_version: SCHEMA_VERSION,
    job_understanding: { title: 'Unknown', goal: 'Unknown', core_requirements: [], source: 'deep_profile|rubric|unknown' },
    candidate_summary: { name: 'Unknown', education: 'Unknown', work_experience: 'Unknown', summary: '' },
    dimension_matches: [{
      dimension: '维度名',
      state: 'Match|Mismatch|Unknown',
      score: 8,
      confidence: 0.7,
      evidence: [{ id: 'work.0.desc', section: 'work', index: 0, field: 'desc', text: '证据原文摘录' }],
      explanation: { fact: '事实', judgment: '判断', impact: '影响' },
      risk: '待核实点',
    }],
    radar: [{ dimension: '维度名', score: 8, state: 'Match' }],
    strengths: [],
    risks: [],
    unknowns: [],
    interview_questions: [{ question: '面试问题', verification_target: '核实目标', source_risk: '来源风险或 Unknown' }],
    overall: '仅供 HR 参考的综合意见',
    disclaimer: REPORT_DISCLAIMER,
  }),
].join('\n');

function buildCandidateReportUserPrompt({ jobName, candidateName, deepProfile, rubric, dimensions, evidenceProfile }) {
  const parts = [];
  parts.push(`【岗位】\n${clean(jobName) || 'Unknown'}`);
  if (deepProfile) parts.push(`【深度人才画像】\n${JSON.stringify(deepProfile, null, 2)}`);
  else parts.push(`【简版岗位画像】\n${clean(rubric) || 'Unknown'}`);
  parts.push(`【动态评价维度】\n${JSON.stringify(dimensions || [], null, 2)}`);
  parts.push(`【候选人】\n${clean(candidateName) || 'Unknown'}`);
  parts.push(`【唯一允许引用的结构化简历证据】\n${JSON.stringify(evidenceProfile || {}, null, 2)}`);
  return parts.join('\n\n');
}

function extractJson(content) {
  let text = String(content || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

function assertNoForbiddenKeys(value, path = '') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  Object.entries(value).forEach(([key, child]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (FORBIDDEN_KEYS.has(normalized)) throw new Error(`V1 报告包含禁用字段：${path ? `${path}.` : ''}${key}`);
    assertNoForbiddenKeys(child, path ? `${path}.${key}` : key);
  });
}

function evidenceIndex(evidenceProfile) {
  const map = new Map();
  asArray(evidenceProfile && evidenceProfile.evidence_items).forEach((item) => {
    const section = clean(item.section);
    const index = Number(item.index);
    const field = clean(item.field);
    const key = `${section}.${index}.${field}`;
    map.set(key, {
      id: clean(item.id) || key,
      section,
      index,
      field,
      text: clean(item.text),
    });
    if (clean(item.id)) map.set(clean(item.id), map.get(key));
  });
  return map;
}

function normalizeEvidence(list, allowed) {
  return asArray(list).map((item) => {
    const id = clean(item && item.id);
    const section = clean(item && item.section);
    const index = Number(item && item.index);
    const field = clean(item && item.field);
    const key = id || `${section}.${index}.${field}`;
    const matched = allowed.get(key) || allowed.get(`${section}.${index}.${field}`);
    return matched || null;
  }).filter(Boolean);
}

function normalizeExplanation(value, state, dimension) {
  const obj = value && typeof value === 'object' ? value : {};
  const unknown = state === 'Unknown';
  return {
    fact: clean(obj.fact) || (unknown ? `简历未提供「${dimension}」相关证据。` : ''),
    judgment: clean(obj.judgment) || (unknown ? `无法判断「${dimension}」。` : ''),
    impact: clean(obj.impact) || (unknown ? '不作为扣分项，建议面试核实。' : ''),
  };
}

function normalizeScore(value, state) {
  if (state === 'Unknown') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(10, Math.round(n)));
}

function normalizeDimensionMatch(raw, allowedEvidence) {
  const dimension = clean(raw && raw.dimension);
  let state = clean(raw && raw.state);
  if (!ALLOWED_STATES.has(state)) state = 'Unknown';
  let evidence = normalizeEvidence(raw && raw.evidence, allowedEvidence);
  let score = normalizeScore(raw && raw.score, state);
  if (!evidence.length) {
    state = 'Unknown';
    score = null;
    evidence = [];
  }
  if (state === 'Unknown') {
    score = null;
    evidence = [];
  }
  const claimOnly = evidence.length > 0 && evidence.every((item) => item.section === 'skill' || item.section === 'basic');
  if (claimOnly && score !== null && score > 5) score = 5;
  const confidence = state === 'Unknown'
    ? 0
    : Math.max(0, Math.min(1, Number(raw && raw.confidence) || 0));
  return {
    dimension,
    state,
    score,
    confidence,
    evidence,
    explanation: normalizeExplanation(raw && raw.explanation, state, dimension),
    risk: [clean(raw && raw.risk), claimOnly ? '只有技能或自我描述声明，缺少工作/项目经历支撑。' : ''].filter(Boolean).join('；'),
  };
}

function normalizeObjectList(value, keyName) {
  return asArray(value).map((item) => {
    if (typeof item === 'string') return { [keyName]: clean(item) };
    if (!item || typeof item !== 'object') return null;
    const out = {};
    Object.entries(item).forEach(([key, val]) => {
      if (typeof val !== 'object') out[key] = clean(val);
    });
    return out[keyName] || out.point || out.dimension || out.question || out.reason ? out : null;
  }).filter(Boolean);
}

const LOCAL_DEMO_DIMENSION_KEYWORDS = [
  { re: /AI|Agent|大模型|LLM|RAG|提示词|智能体/i, tokens: ['AI', 'Agent', '大模型', 'LLM', 'RAG', '提示词', '智能体'] },
  { re: /工程|后端|前端|全栈|系统|架构|接口|平台|Java|Node|React/i, tokens: ['工程', '后端', '前端', '全栈', '系统', '架构', '接口', '平台', 'Java', 'Node', 'React'] },
  { re: /自动化|RPA|流程|脚本|机器人/i, tokens: ['自动化', 'RPA', '流程', '脚本', '机器人'] },
  { re: /数据|SQL|BI|指标|分析|复盘|报表/i, tokens: ['数据', 'SQL', 'BI', '指标', '分析', '复盘', '报表'] },
  { re: /电商|直播|投放|运营|供应链|OMS|WMS|CRM|ERP/i, tokens: ['电商', '直播', '投放', '运营', '供应链', 'OMS', 'WMS', 'CRM', 'ERP'] },
  { re: /项目|交付|落地|上线|负责|主导|结果|影响/i, tokens: ['项目', '交付', '落地', '上线', '负责', '主导', '结果', '影响'] },
  { re: /技能|工具|方法|能力/i, tokens: ['技能', '工具', '方法', '能力'] },
];

function localDemoDimensionText(dimension) {
  return [
    dimension && dimension.name,
    dimension && dimension.what,
    ...(asArray(dimension && dimension.resume_evidence)),
    ...(asArray(dimension && dimension.fake_signals)),
  ].map(clean).filter(Boolean).join(' ');
}

function localDemoKeywordsForDimension(dimension) {
  const source = localDemoDimensionText(dimension);
  const out = [];
  LOCAL_DEMO_DIMENSION_KEYWORDS.forEach((group) => {
    if (group.re.test(source)) out.push(...group.tokens);
  });
  const literal = source.match(/[A-Za-z][A-Za-z0-9+#.-]{1,}|[\u4e00-\u9fa5]{2,6}/g) || [];
  out.push(...literal.filter((token) => !/^(是否|相关|能力|经验|岗位|核心|项目|证据|风险|待核实点)$/.test(token)));
  return [...new Set(out.map(clean).filter((token) => token.length >= 2))].slice(0, 14);
}

function localDemoEvidenceMatches(item, keywords) {
  const text = clean(item && item.text);
  if (!text || !keywords.length) return false;
  return keywords.some((keyword) => new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text));
}

function localDemoGenericWorkDimension(dimension) {
  return /岗位核心|相关项目|项目交付|结果|影响|业务场景|工程实现|能力/.test(localDemoDimensionText(dimension));
}

function pickLocalDemoEvidence(dimension, evidenceProfile) {
  const items = asArray(evidenceProfile && evidenceProfile.evidence_items);
  const keywords = localDemoKeywordsForDimension(dimension);
  const workProject = items.filter((item) => ['work', 'proj'].includes(item.section));
  const claimOnly = items.filter((item) => ['skill', 'basic'].includes(item.section));
  const workHits = workProject.filter((item) => localDemoEvidenceMatches(item, keywords));
  if (workHits.length) {
    return {
      state: 'Match',
      score: keywords.length >= 3 ? 8 : 7,
      confidence: 0.62,
      evidence: workHits.slice(0, 2),
      risk: '本地样本只做关键词级链路验证，需真实 AI 或面试进一步判断证据强度。',
    };
  }
  if (localDemoGenericWorkDimension(dimension) && workProject.length) {
    return {
      state: 'Match',
      score: 6,
      confidence: 0.5,
      evidence: workProject.slice(0, 2),
      risk: '有工作/项目经历可用于验证链路，但本地样本不判断真实匹配强度。',
    };
  }
  const claimHits = claimOnly.filter((item) => localDemoEvidenceMatches(item, keywords));
  if (claimHits.length || (/技能|工具|方法/.test(localDemoDimensionText(dimension)) && claimOnly.length)) {
    return {
      state: 'Match',
      score: 5,
      confidence: 0.36,
      evidence: (claimHits.length ? claimHits : claimOnly).slice(0, 1),
      risk: '只有技能或自我描述声明，缺少工作/项目经历支撑。',
    };
  }
  return {
    state: 'Unknown',
    score: null,
    confidence: 0,
    evidence: [],
    risk: '简历未提供可引用的工作/项目证据。',
  };
}

function localDemoJobGoal(deepProfile, rubric) {
  const mission = deepProfile && deepProfile.position_mission;
  if (mission && typeof mission === 'object' && clean(mission.content)) return clean(mission.content);
  if (clean(rubric)) return clip(rubric, 120);
  return 'Unknown';
}

function buildLocalDemoReport({ jobName, candidateName, deepProfile, rubric, evidenceProfile, dimensions }) {
  const rows = asArray(dimensions).slice(0, 6).map((dimension) => {
    const name = clean(dimension && dimension.name) || '待核实维度';
    const picked = pickLocalDemoEvidence(dimension, evidenceProfile);
    return {
      dimension: name,
      state: picked.state,
      score: picked.score,
      confidence: picked.confidence,
      evidence: picked.evidence,
      explanation: {
        fact: picked.evidence.length
          ? `本地样本在结构化简历中找到「${name}」相关证据。`
          : `简历未提供「${name}」可引用证据。`,
        judgment: picked.state === 'Unknown'
          ? '本地样本不做能力补全，保持 Unknown。'
          : '该判断仅用于验证报告链路，不代表真实 AI 评估。',
        impact: picked.state === 'Unknown'
          ? 'Unknown 不作为扣分项，建议面试核实。'
          : '可驱动本地雷达展示，但不参与排序或自动动作。',
      },
      risk: picked.risk,
    };
  });
  const unknownRows = rows.filter((row) => row.state === 'Unknown');
  const raw = {
    schema_version: SCHEMA_VERSION,
    job_understanding: {
      title: clean(jobName) || 'Unknown',
      goal: localDemoJobGoal(deepProfile, rubric),
      core_requirements: rows.map((row) => row.dimension),
      source: deepProfile ? 'deep_profile' : (clean(rubric) ? 'rubric' : 'unknown'),
    },
    candidate_summary: {
      name: clean(candidateName) || 'Unknown',
      education: clean(evidenceProfile && evidenceProfile.candidate_summary && evidenceProfile.candidate_summary.education) || 'Unknown',
      work_experience: clean(evidenceProfile && evidenceProfile.candidate_summary && evidenceProfile.candidate_summary.work_experience) || 'Unknown',
      summary: clean(evidenceProfile && evidenceProfile.candidate_summary && evidenceProfile.candidate_summary.summary),
    },
    dimension_matches: rows,
    radar: rows.map((row) => ({ dimension: row.dimension, score: row.score, state: row.state })),
    strengths: rows.filter((row) => row.state === 'Match').slice(0, 3).map((row) => ({
      point: `${row.dimension} 有可引用样本证据`,
      basis: evidenceText(row.evidence),
    })),
    risks: rows.filter((row) => row.risk && row.state !== 'Unknown').slice(0, 4).map((row) => ({
      point: row.dimension,
      reason: row.risk,
      severity: '中',
    })),
    unknowns: unknownRows.map((row) => ({
      dimension: row.dimension,
      reason: row.risk || '证据不足',
    })),
    interview_questions: (unknownRows.length ? unknownRows : rows).slice(0, 5).map((row) => ({
      question: `请结合真实项目讲一下「${row.dimension}」的具体经历、个人职责和结果。`,
      verification_target: row.dimension,
      source_risk: row.risk || '本地样本需要人工核实',
    })),
    overall: '这是一条本地样本 V1 报告，只用于确认 ai_review、前端雷达和详情页展示链路已打通；不代表真实 AI 判断。',
    disclaimer: LOCAL_DEMO_DISCLAIMER,
  };
  const report = parseCandidateReportReply(JSON.stringify(raw), {
    jobName,
    candidateName,
    deepProfile,
    rubric,
    evidenceProfile,
    dimensions,
  });
  return {
    ...report,
    disclaimer: LOCAL_DEMO_DISCLAIMER,
    generator: 'local_demo_v1',
    is_local_demo: true,
  };
}

function evidenceText(evidence) {
  return asArray(evidence).map((item) => item && item.text).filter(Boolean).slice(0, 2).join('；');
}

function parseCandidateReportReply(content, options = {}) {
  const obj = extractJson(content);
  if (!obj || typeof obj !== 'object') throw new Error('模型没返回 V1 候选人报告 JSON');
  assertNoForbiddenKeys(obj);
  if (obj.schema_version !== SCHEMA_VERSION) throw new Error(`V1 报告 schema_version 错误：${clean(obj.schema_version) || '缺失'}`);

  const allowedEvidence = evidenceIndex(options.evidenceProfile);
  const expectedDimensions = asArray(options.dimensions).map((d) => clean(d && (d.name || d.dimension))).filter(Boolean);
  const seen = new Map();
  asArray(obj.dimension_matches).forEach((item) => {
    const row = normalizeDimensionMatch(item, allowedEvidence);
    if (row.dimension) seen.set(row.dimension, row);
  });
  expectedDimensions.forEach((dimension) => {
    if (!seen.has(dimension)) {
      seen.set(dimension, normalizeDimensionMatch({ dimension, state: 'Unknown', score: null, evidence: [] }, allowedEvidence));
    }
  });
  const dimensionMatches = Array.from(seen.values()).slice(0, 6);
  if (!dimensionMatches.length) throw new Error('V1 报告缺少 dimension_matches');

  const deepMissing = options.deepProfile ? false : true;
  const jobUnderstanding = obj.job_understanding && typeof obj.job_understanding === 'object' ? obj.job_understanding : {};
  const candidateSummary = obj.candidate_summary && typeof obj.candidate_summary === 'object' ? obj.candidate_summary : {};
  const evidenceSummary = options.evidenceProfile && options.evidenceProfile.candidate_summary ? options.evidenceProfile.candidate_summary : {};

  return {
    schema_version: SCHEMA_VERSION,
    job_understanding: {
      title: clean(jobUnderstanding.title) || clean(options.jobName) || 'Unknown',
      goal: clean(jobUnderstanding.goal) || 'Unknown',
      core_requirements: asArray(jobUnderstanding.core_requirements).map(clean).filter(Boolean),
      source: ['deep_profile', 'rubric', 'unknown'].includes(jobUnderstanding.source) ? jobUnderstanding.source : (deepMissing ? 'rubric' : 'deep_profile'),
    },
    candidate_summary: {
      name: clean(candidateSummary.name) || clean(options.candidateName) || 'Unknown',
      education: clean(candidateSummary.education) || evidenceSummary.education || 'Unknown',
      work_experience: clean(candidateSummary.work_experience) || evidenceSummary.work_experience || 'Unknown',
      summary: clean(candidateSummary.summary) || evidenceSummary.summary || '',
    },
    dimension_matches: dimensionMatches,
    radar: dimensionMatches.map((item) => ({ dimension: item.dimension, score: item.score, state: item.state })),
    strengths: normalizeObjectList(obj.strengths, 'point'),
    risks: normalizeObjectList(obj.risks, 'point'),
    unknowns: normalizeObjectList(obj.unknowns, 'dimension'),
    interview_questions: asArray(obj.interview_questions).map((item) => ({
      question: clean(item && item.question),
      verification_target: clean(item && item.verification_target),
      source_risk: clean(item && item.source_risk),
    })).filter((item) => item.question),
    overall: clean(obj.overall),
    disclaimer: REPORT_DISCLAIMER,
  };
}

function isCandidateReportV1(report) {
  return report && report.schema_version === SCHEMA_VERSION && Array.isArray(report.dimension_matches) && Array.isArray(report.radar);
}

function isLocalDemoReport(report) {
  return isCandidateReportV1(report) && (report.is_local_demo === true || report.generator === 'local_demo_v1');
}

module.exports = {
  SCHEMA_VERSION,
  REPORT_DISCLAIMER,
  LOCAL_DEMO_DISCLAIMER,
  REPORT_SYSTEM_PROMPT,
  buildEvidenceProfile,
  scrubSensitive,
  buildReportDimensions,
  buildLocalDemoReport,
  buildCandidateReportUserPrompt,
  parseCandidateReportReply,
  isCandidateReportV1,
  isLocalDemoReport,
};
