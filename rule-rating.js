const {
  checkHardBars,
  collectDegrees,
  collectCities,
  parseSalaryCapK,
} = require('./rating-engine');

const RULE_SOURCE = '规则v1';
const MANUAL_SOURCE = '人工';
const REVIEW_LABEL = '待确认';
const TIER_LABELS = {
  S: '推荐面试',
  A: '重点看',
  B: '待看',
  C: '不建议',
};

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function asList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(clean).filter(Boolean);
}

function normalizeText(value) {
  return clean(value).toLowerCase();
}

function collectText(value, out) {
  if (value === undefined || value === null) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = clean(value);
    if (text) out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectText(item, out));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectText(item, out));
  }
}

// Only objective resume payload is eligible for rule matching. Expert output fields stay out.
function buildRuleHaystack(candidate = {}) {
  const parts = [];
  collectText(candidate.sections, parts);
  collectText(candidate.geek_desc, parts);
  collectText(candidate.resume_text, parts);
  return normalizeText(parts.join('\n'));
}

function normalizeTierRule(rule) {
  const tier = clean(rule && rule.tier).toUpperCase();
  if (!TIER_LABELS[tier]) return null;
  const any = asList(rule.any);
  const all = asList(rule.all);
  const none = asList(rule.none);
  const minAny = Math.max(0, Math.floor(Number(rule.min_any) || 0));
  return {
    tier,
    any,
    all,
    none,
    min_any: minAny || (any.length ? 1 : 0),
    reason: clean(rule.reason),
  };
}

function normalizeRuleConfig(config = {}) {
  const rules = config.rule_rating || config.tier_rules || {};
  return {
    hard_bars: config.hard_bars || {},
    required_fields: asList(rules.required_fields),
    tiers: (Array.isArray(rules.tiers) ? rules.tiers : [])
      .map(normalizeTierRule)
      .filter(Boolean),
  };
}

function keywordHits(haystack, keywords) {
  return keywords.filter((keyword) => haystack.includes(normalizeText(keyword)));
}

function matchKeywordRule(rule, haystack) {
  if (!rule) return { match: false, hits: [] };
  const forbidden = keywordHits(haystack, rule.none);
  if (forbidden.length) return { match: false, hits: [], forbidden };

  const allHits = keywordHits(haystack, rule.all);
  if (allHits.length !== rule.all.length) return { match: false, hits: allHits };

  const anyHits = keywordHits(haystack, rule.any);
  if (rule.any.length && anyHits.length < rule.min_any) return { match: false, hits: allHits.concat(anyHits) };

  if (!rule.all.length && !rule.any.length) return { match: false, hits: [] };
  return { match: true, hits: [...new Set(allHits.concat(anyHits))] };
}

function hasRows(value) {
  return Array.isArray(value) && value.length > 0;
}

function missingRequiredInfo(config, candidate = {}) {
  const sections = candidate.sections || {};
  const missing = [];
  for (const field of config.required_fields) {
    if (field === 'degree' && collectDegrees(sections).length === 0) missing.push('学历信息缺失，待人工确认');
    else if (field === 'city' && collectCities(sections).length === 0) missing.push('期望城市缺失，待人工确认');
    else if (field === 'salary' && parseSalaryCapK(sections) === null) missing.push('期望薪资缺失，待人工确认');
    else if (field === 'work' && !hasRows(sections.work)) missing.push('工作经历缺失，待人工确认');
    else if (field === 'education' && !hasRows(sections.edu)) missing.push('教育经历缺失，待人工确认');
    else if (field === 'project' && !hasRows(sections.proj)) missing.push('项目经历缺失，待人工确认');
    else if (field === 'skill' && !hasRows(sections.skill)) missing.push('技能信息缺失，待人工确认');
    else if (field === 'resume' && !buildRuleHaystack(candidate)) missing.push('简历内容缺失，待人工确认');
    else if (!['degree', 'city', 'salary', 'work', 'education', 'project', 'skill', 'resume'].includes(field)) {
      const value = sections[field] !== undefined ? sections[field] : candidate[field];
      if (!clean(value) && !hasRows(value)) missing.push(`${field} 缺失，待人工确认`);
    }
  }
  return [...new Set(missing)];
}

function pendingResult(reasons, extra = {}) {
  return {
    tier: null,
    source: RULE_SOURCE,
    label: REVIEW_LABEL,
    requires_human_review: true,
    auto_write: false,
    hard_bar_pass: extra.hard_bar_pass !== undefined ? extra.hard_bar_pass : null,
    reasons: [...new Set(reasons.filter(Boolean))],
    evidence: [],
  };
}

function tierResult(tier, reasons, evidence, extra = {}) {
  return {
    tier,
    source: RULE_SOURCE,
    label: TIER_LABELS[tier],
    requires_human_review: true,
    auto_write: false,
    hard_bar_pass: extra.hard_bar_pass !== undefined ? extra.hard_bar_pass : true,
    reasons: [...new Set(reasons.filter(Boolean))],
    evidence: [...new Set(evidence.filter(Boolean))],
  };
}

function decideRuleTier(config, candidate = {}) {
  const normalized = normalizeRuleConfig(config);
  const hard = checkHardBars({ hard_bars: normalized.hard_bars }, candidate);
  if (!hard.pass) {
    return tierResult('C', ['不符合硬性要求'].concat(hard.fails), hard.fails, { hard_bar_pass: false });
  }

  const missing = [...new Set(hard.notes.concat(missingRequiredInfo(normalized, candidate)))];
  if (missing.length) return pendingResult(missing, { hard_bar_pass: true });

  if (!normalized.tiers.length) {
    return pendingResult(['缺少规则定档口径，待人工确认'], { hard_bar_pass: true });
  }

  const haystack = buildRuleHaystack(candidate);
  for (const rule of normalized.tiers) {
    const matched = matchKeywordRule(rule, haystack);
    if (matched.match) {
      const reason = rule.reason || `命中 ${rule.tier} 档规则`;
      return tierResult(rule.tier, [reason], matched.hits, { hard_bar_pass: true });
    }
  }

  return pendingResult(['未命中任何定档规则，待人工确认'], { hard_bar_pass: true });
}

function applyRuleRating(config, candidate = {}) {
  if (clean(candidate.sabc_source) === MANUAL_SOURCE) {
    return {
      tier: clean(candidate.sabc).toUpperCase() || null,
      source: MANUAL_SOURCE,
      label: '人工评级保留',
      skipped: true,
      preserved: true,
      requires_human_review: true,
      auto_write: false,
      hard_bar_pass: null,
      reasons: ['人工评级已存在，规则定档不覆盖'],
      evidence: [],
    };
  }
  return decideRuleTier(config, candidate);
}

module.exports = {
  RULE_SOURCE,
  MANUAL_SOURCE,
  REVIEW_LABEL,
  TIER_LABELS,
  normalizeRuleConfig,
  buildRuleHaystack,
  matchKeywordRule,
  missingRequiredInfo,
  decideRuleTier,
  applyRuleRating,
};
