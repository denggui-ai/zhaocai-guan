// 硬门槛引擎（纯函数，不碰 DB / 网络）。
// 职责已收窄：只判「客观硬性要求」（学历 / 薪资上限 / 城市），产出「符合 / 不符合」标记，
// 不负责 S/A/B/C/D 定档或正式排序；定档由独立的确定性规则和人工复核负责。
// 另提供 buildResumeText：把结构化简历拼成给专家看的大白话文本（不含联系方式）。
const { normalizeMonthlySalary } = require('./screenshot-normalization');

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

// 默认画像：新岗位打开编辑器时的起点。
// rubric = 用人方大白话写「要什么样的人」；hard_bars = 客观硬门槛，默认都关（用人方自己开）。
function defaultProfile() {
  return {
    rubric: '',
    hard_bars: {
      degree: { enabled: false, allowed: ['本科', '硕士', '博士', '研究生'] },
      salary: { enabled: false, cap_k: 30 },
      city: { enabled: false, allowed: [] },
    },
  };
}

// 兼容旧画像形状（signal_groups 那版）：把 config.degree/salary 抬进 hard_bars，signal_groups 丢弃。
function normalizeConfig(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const hb = cfg.hard_bars && typeof cfg.hard_bars === 'object' ? cfg.hard_bars : {};
  const degree = hb.degree || cfg.degree || {};
  const salary = hb.salary || cfg.salary || {};
  const city = hb.city || cfg.city || {};
  return {
    rubric: clean(cfg.rubric),
    hard_bars: {
      degree: { enabled: degree.enabled === true, allowed: Array.isArray(degree.allowed) ? degree.allowed : [] },
      salary: { enabled: salary.enabled === true, cap_k: Number(salary.cap_k) || 0 },
      city: { enabled: city.enabled === true, allowed: Array.isArray(city.allowed) ? city.allowed : [] },
    },
  };
}

// 收集候选人所有学历值：basic[].degree + 每段 edu[].degree（交叉取，别只信 basic）。
function collectDegrees(sections) {
  const s = sections || {};
  const values = [];
  (s.basic || []).forEach((b) => { const v = clean(b && b.degree); if (v) values.push(v); });
  (s.edu || []).forEach((e) => { const v = clean(e && e.degree); if (v) values.push(v); });
  return [...new Set(values)];
}

// 学历是否达标：任一学历值精确命中 allowed 即达标（精确成员判定，避开子串误命中的坑）。
function degreeMeetsBar(degrees, allowed) {
  const allow = new Set((allowed || []).map(clean).filter(Boolean));
  return degrees.some((d) => allow.has(d));
}

// 统一读取月薪 K。优先使用已确认的结构化值；其他来源走同一确定性换算。
// 年薪、13/14 薪等周期不明确的表达保持 Unknown，不做推断。
function parseSalaryCapK(sections) {
  const s = sections || {};
  let max = null;
  for (const e of s.expect || []) {
    const stored = e && e.salary_normalized;
    const normalized = stored && stored.status === 'normalized' && Number.isFinite(Number(stored.max_k)) && Number(stored.max_k) > 0
      ? { status: 'normalized', max_k: Number(stored.max_k) }
      : normalizeMonthlySalary(e && (e.salary_raw || e.salary));
    if (normalized.status === 'normalized') {
      max = max === null ? normalized.max_k : Math.max(max, normalized.max_k);
    }
  }
  return max;
}

// 收集候选人期望城市。
function collectCities(sections) {
  const s = sections || {};
  const values = [];
  (s.expect || []).forEach((e) => { const v = clean(e && e.city); if (v) values.push(v); });
  return [...new Set(values)];
}

// 硬门槛判定：返回 { pass, fails[], notes[] }。
// fails = 客观不符合（学历不够 / 要价超上限 / 城市不对），pass=false 表示不符硬性要求。
// notes = 存疑但不否决（如学历取不到）——绝不因为取不到就误杀。
function checkHardBars(config, candidate) {
  const cfg = normalizeConfig(config);
  const sections = candidate && candidate.sections;
  const hb = cfg.hard_bars;
  const fails = [];
  const notes = [];

  if (hb.degree.enabled) {
    const degrees = collectDegrees(sections);
    if (degrees.length === 0) notes.push('学历信息缺失，待人工确认');
    else if (!degreeMeetsBar(degrees, hb.degree.allowed)) fails.push(`学历 ${degrees.join('/')} 不在允许范围（${hb.degree.allowed.join('/') || '未设'}）`);
  }

  if (hb.salary.enabled) {
    const cap = hb.salary.cap_k;
    const upper = parseSalaryCapK(sections);
    if (cap > 0 && upper !== null && upper > cap) fails.push(`期望薪资上限 ${upper}K 超过岗位上限 ${cap}K`);
  }

  if (hb.city.enabled && hb.city.allowed.length) {
    const cities = collectCities(sections);
    const allow = new Set(hb.city.allowed.map(clean).filter(Boolean));
    if (cities.length === 0) notes.push('期望城市缺失，待人工确认');
    else if (!cities.some((c) => allow.has(c))) fails.push(`期望城市 ${cities.join('/')} 不在 ${hb.city.allowed.join('/')}`);
  }

  return { pass: fails.length === 0, fails, notes };
}

function pushLine(lines, label, value) {
  const v = clean(value);
  if (v) lines.push(`${label}：${v}`);
}

function rangeText(start, end) {
  const s = clean(start);
  const e = clean(end);
  if (s && e) return `${s}-${e}`;
  return s || e || '';
}

// 把结构化简历拼成给人才专家看的大白话文本。绝不含联系方式（联系方式在 contact 表，本就不进 sections）。
function buildResumeText(sections, geekDesc) {
  const s = sections || {};
  const lines = [];

  const basic = (s.basic || [])[0] || {};
  const basicMeta = [basic.age, basic.work_years, basic.degree, basic.status].map(clean).filter(Boolean).join(' / ');
  if (basicMeta) lines.push(`基本情况：${basicMeta}`);
  pushLine(lines, '自我描述', basic.description || geekDesc);

  (s.expect || []).forEach((e) => {
    const meta = [e.position, e.city, e.salary].map(clean).filter(Boolean).join(' / ');
    if (meta) lines.push(`求职期望：${meta}`);
  });

  const edu = (s.edu || []).map((e) => {
    const meta = [e.school, e.major, e.degree, rangeText(e.start, e.end)].map(clean).filter(Boolean).join(' ');
    return meta ? `  - ${meta}` : '';
  }).filter(Boolean);
  if (edu.length) lines.push('教育经历：\n' + edu.join('\n'));

  const work = (s.work || []).map((w) => {
    const head = [w.company, w.title, rangeText(w.start, w.end)].map(clean).filter(Boolean).join(' ');
    const desc = clean(w.desc);
    return [head ? `  - ${head}` : '', desc ? `    ${desc}` : ''].filter(Boolean).join('\n');
  }).filter(Boolean);
  if (work.length) lines.push('工作经历：\n' + work.join('\n'));

  const proj = (s.proj || []).map((p) => {
    const head = [p.name, p.role, rangeText(p.start, p.end)].map(clean).filter(Boolean).join(' ');
    const desc = clean(p.desc);
    return [head ? `  - ${head}` : '', desc ? `    ${desc}` : ''].filter(Boolean).join('\n');
  }).filter(Boolean);
  if (proj.length) lines.push('项目经历：\n' + proj.join('\n'));

  const skill = (s.skill || []).map((k) => clean(k && k.text)).filter(Boolean).join('；');
  if (skill) lines.push(`技能：${skill}`);

  return lines.join('\n').trim();
}

module.exports = {
  defaultProfile,
  normalizeConfig,
  checkHardBars,
  buildResumeText,
  parseSalaryCapK,
  collectDegrees,
  collectCities,
  degreeMeetsBar,
};
