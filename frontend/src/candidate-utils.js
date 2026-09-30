import { clean, has, parseSections } from './api.js';

const CANDIDATE_SOURCE_LABELS = Object.freeze({
  fixture: '测试数据',
  manual_resume: '手动上传简历',
  resume_upload: '手动上传简历',
  screenshot_ocr: '截图 OCR',
  '截图导入': '截图 OCR',
  boss_recommend: 'Boss 推荐',
  recommend_candidates: 'Boss 推荐',
  online_resume: 'Boss 在线简历',
});

export function candidateSourceLabel(candidateOrSource) {
  const source = clean(candidateOrSource && typeof candidateOrSource === 'object'
    ? candidateOrSource.source
    : candidateOrSource);
  if (!source) return '本地记录';
  if (CANDIDATE_SOURCE_LABELS[source]) return CANDIDATE_SOURCE_LABELS[source];
  return /^[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(source) ? '本地导入' : source;
}

function resumeEducation(candidate) {
  const s = parseSections(candidate);
  if (!s) return null;
  const edu = Array.isArray(s.edu) ? s.edu.find((row) => has(row.school) || has(row.degree)) : null;
  const basic = Array.isArray(s.basic) ? s.basic.find((row) => has(row.degree)) : null;
  return {
    degree: clean(candidate.degree) || clean(basic && basic.degree) || clean(edu && edu.degree),
    school: clean(candidate.school) || clean(edu && edu.school),
    school_tier: clean(candidate.school_tier) || clean((edu && edu.tags || []).join('/')),
  };
}

export function candidateEducation(candidate) {
  return resumeEducation(candidate) || {
    degree: clean(candidate.degree),
    school: clean(candidate.school),
    school_tier: clean(candidate.school_tier),
  };
}

export function educationBucket(candidate) {
  const edu = candidateEducation(candidate);
  const text = `${edu.school_tier} ${edu.school} ${edu.degree}`;
  // ponytail: front-end-only bucket heuristic; replace with stored audited tags when manual tagging lands.
  if (/985/.test(text)) return '985';
  if (/211/.test(text)) return '211';
  if (/重点|卓越工程师|省部共建|双一流/.test(text)) return '重点学校';
  if (/本科/.test(text)) return '普通本科';
  if (/专科|大专|高职/.test(text)) return '专科院校';
  return '其他';
}
