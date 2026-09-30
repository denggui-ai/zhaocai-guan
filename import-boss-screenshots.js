const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ensurePrivateDir, writePrivateFile } = require('./secure-fs');
const { buildScreenshotIdentity } = require('./screenshot-normalization');
const { recognizeScreenshots } = require('./screenshot-ocr-engine');
const { inspectWorkYearsFromText } = require('./resume-structure');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const DATA_DIR = process.env.HRBOSS_DATA_DIR ? path.resolve(process.env.HRBOSS_DATA_DIR) : path.join(__dirname, 'data');
const DEFAULT_OUT = path.join(DATA_DIR, 'import', 'screenshot-drafts.json');
const DEFAULT_OCR_OUT = path.join(DATA_DIR, 'import', 'screenshot-ocr.json');
const { OCR_FILE: OCR_PROGRESS_FILE } = require('./screenshot-import-progress');
const SECTION_TITLES = new Set([
  '最近关注',
  '工作经历',
  '教育经历',
  '项目经历',
  '资格证书',
  '个人优势',
  '求职期望',
  '期望职位',
  'BOSS直聘',
  '立即沟通',
  '推荐最新',
  '内容',
  '业绩',
  '教师',
  '网络推广',
  '求简历',
  '上传简历',
  '工作描述',
  '家族工作',
  '千川投手',
  '与预期相符',
  '不合适',
  '沟通获取',
]);
const COMMON_SURNAMES = new Set('赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴宋庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹龙叶幸司韶郜黎蓟薄印宿白怀蒲台从鄂索咸籍赖卓蔺屠蒙池乔阳胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍却璩桑桂濮牛寿通边扈燕冀浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧利师巩聂关荆司马欧阳上官诸葛夏侯皇甫尉迟公孙'.split(''));

const COMPOUND_SURNAMES = ['司马', '欧阳', '上官', '诸葛', '夏侯', '皇甫', '尉迟', '公孙'];
const NAME_EXTRACTION_METHOD = 'relative_header_geometry_v2';
const NAME_STATUS_SUFFIX = /(?:[·•●]?\s*(?:刚刚活跃|今日活跃|本周活跃|月内活跃|近期活跃|刚刚|在线))\s*$/;

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function listImages(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_EXTS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans', { numeric: true }));
}

function runScreenshotOcr(files, progressFile = '') {
  return recognizeScreenshots(files, { progressFile });
}

function cleanText(value) {
  return String(value || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[·•●]/g, '•')
    .trim();
}

function cleanNameText(value) {
  return cleanText(value)
    .replace(NAME_STATUS_SUFFIX, '')
    .replace(/\s+刚\s*$/, '')
    .trim();
}

function normalizeLine(line) {
  const confidence = Number(line.confidence);
  return {
    ...line,
    text: cleanText(line.text),
    confidence: line.confidence != null && Number.isFinite(confidence) ? confidence : null,
  };
}

function isLikelyChineseName(text) {
  const raw = cleanNameText(text).replace(/[^\u4e00-\u9fa5·]/g, '');
  if (raw.length < 2 || raw.length > 5) return false;
  if (SECTION_TITLES.has(raw)) return false;
  if (/公司|传媒|商贸|科技|运营|投放|主管|经理|教师|推广|广州|深圳|北京|上海|离职|在职|到岗|活跃|在线|关注|经历|教育|推荐|最新|筛选|求职|职位|信息流|预期|内容|业绩|简历|描述|工作/.test(raw)) return false;
  if (!COMMON_SURNAMES.has(raw[0]) && !COMPOUND_SURNAMES.some((surname) => raw.startsWith(surname))) return false;
  return true;
}

function isLikelyLatinName(text) {
  const source = cleanNameText(text);
  // Do not validate only the Latin projection of a mixed-language sentence.
  // Otherwise a header-like Chinese body line containing "Oracle" or another
  // capitalized token can pass this branch, while normalizeName later returns
  // the unrelated Chinese prose as the candidate name.
  if (/[\u4e00-\u9fa5]/.test(source)) return false;
  const raw = source.replace(/[^A-Za-z ._-]/g, '').trim();
  if (!/^[A-Z][A-Za-z ._-]{1,30}$/.test(raw)) return false;
  if (/BOSS|ROI|TOP|CID|APP|PC|Q|G/i.test(raw)) return false;
  return true;
}

function normalizeName(value) {
  const text = cleanNameText(value);
  let name = text.replace(/[^\u4e00-\u9fa5·]/g, '');
  if (name) {
    if (name.length >= 3 && name[0] === name[1]) name = name.slice(1);
    if (name.length >= 4 && !COMMON_SURNAMES.has(name[0]) && COMMON_SURNAMES.has(name[1])) name = name.slice(1);
    return name;
  }
  return text.replace(/[^A-Za-z ._-]/g, '').trim();
}

function scoreNameLine(line, imageHeight, imageWidth) {
  const text = cleanText(line.text);
  if (!isLikelyChineseName(text) && !isLikelyLatinName(text)) return 0;
  const top = Number(line.top || 0);
  const left = Number(line.left || 0);
  const height = Number(line.height || 0);
  const safeHeight = Number(imageHeight) > 0 ? Number(imageHeight) : 2796;
  const safeWidth = Number(imageWidth) > 0 ? Number(imageWidth) : 1290;
  const topRatio = top / safeHeight;
  const leftRatio = left / safeWidth;
  const heightRatio = height / safeHeight;
  if (topRatio < 0.015 || topRatio > 0.22 || leftRatio > 0.55 || heightRatio < 0.02) return 0;
  let score = 100;
  if (topRatio <= 0.1) score += 30;
  if (heightRatio >= 0.025) score += 20;
  if (leftRatio <= 0.25) score += 10;
  const confidence = Number(line.confidence);
  if (Number.isFinite(confidence)) score += Math.round(confidence * 10);
  return score;
}

function extractNameLine(lines, imageHeight = 2796, imageWidth = 1290) {
  const candidates = lines
    .map((line) => ({ line, score: scoreNameLine(line, imageHeight, imageWidth) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].line : null;
}

function extractName(lines, imageHeight = 2796, imageWidth = 1290) {
  const line = extractNameLine(lines, imageHeight, imageWidth);
  return line ? normalizeName(line.text) : null;
}

function sourceSequenceHint(file) {
  const stem = path.parse(String(file || '')).name.normalize('NFKC');
  const patterns = [
    /^(.*?)(?:[\s._-]*ocr[\s._-]*(?:次数|count)?[\s._-]*)(\d+)(.*)$/i,
    /^(.*?)(?:[\s._-]*(?:page|part)[\s._-]*)(\d+)(.*)$/i,
    /^(.*?)(?:[\s._-]*第[\s._-]*)(\d+)(?:[\s._-]*页)(.*)$/i,
    /^(.*?)(?:[\s._-]+页[\s._-]*)(\d+)(.*)$/i,
  ];
  for (const pattern of patterns) {
    const match = stem.match(pattern);
    if (!match) continue;
    const prefix = cleanText(match[1]).toLocaleLowerCase('zh-Hans');
    const suffix = cleanText(match[3]).toLocaleLowerCase('zh-Hans');
    const sequence = Number(match[2]);
    if (!prefix || !Number.isInteger(sequence) || sequence < 1 || sequence > 20) return null;
    return { key: `${prefix}\u0000${suffix}`, sequence };
  }
  return null;
}

function sourceSequenceGroups(images) {
  const hinted = new Map();
  images.forEach((image, index) => {
    const hint = sourceSequenceHint(image.file);
    if (!hint) return;
    if (!hinted.has(hint.key)) hinted.set(hint.key, []);
    hinted.get(hint.key).push({ image, index, sequence: hint.sequence });
  });
  const groups = [];
  const consumed = new Set();
  for (const entries of hinted.values()) {
    const ordered = [...entries].sort((a, b) => a.sequence - b.sequence || a.index - b.index);
    const sequences = ordered.map((entry) => entry.sequence);
    const contiguous = ordered.length >= 2
      && new Set(sequences).size === sequences.length
      && sequences.every((value, index) => value === index + 1);
    if (!contiguous) continue;
    ordered.forEach((entry) => consumed.add(entry.index));
    const first = ordered[0];
    const nameLine = extractNameLine(first.image.lines, first.image.height, first.image.width);
    groups.push({
      name: (nameLine ? normalizeName(nameLine.text) : '') || '',
      name_source: nameLine ? { image: first.image, line: nameLine } : null,
      name_extraction_method: NAME_EXTRACTION_METHOD,
      images: ordered.map((entry) => entry.image),
      first_index: Math.min(...ordered.map((entry) => entry.index)),
      grouping: { strategy: 'filename_page_sequence', sequences },
    });
  }
  return { groups, consumed };
}

function classifyImage(image) {
  const text = image.lines.map((line) => cleanText(line.text)).join('\n');
  if (/推荐.*最新/.test(text) || /牛人[\s\S]*搜索[\s\S]*消息[\s\S]*我的/.test(text)) return 'list';
  if (/立即沟通|工作经历|教育经历|最近关注|离职-|在职-/.test(text)) return 'detail';
  if (/推荐|最新|筛选|求职期望/.test(text)) return 'list';
  return 'unknown';
}

function textAfter(lines, marker, stopMarkers = []) {
  const out = [];
  let inSection = false;
  for (const line of lines) {
    const text = cleanText(line.text);
    if (!inSection && text.includes(marker)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (stopMarkers.some((stop) => text.includes(stop))) break;
      if (text) out.push(text);
    }
  }
  return out.join('\n').trim();
}

function firstMatch(text, patterns) {
  for (const pattern of (Array.isArray(patterns) ? patterns : [patterns])) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function extractFacts(lines) {
  const texts = lines.map((line) => cleanText(line.text)).filter(Boolean);
  const all = texts.join('\n');
  const degree = firstMatch(all, /(博士|硕士|本科|大专|高中|中专)/g);
  const ageMatch = all.match(/(?:^|[^\d])((?:1[6-9]|[2-6]\d)岁)(?=$|[^\d])/m);
  const age = ageMatch ? ageMatch[1] : null;
  const salary = firstMatch(all, [
    /\d+(?:\.\d+)?\s*K\s*[-–—]\s*\d+(?:\.\d+)?\s*K/gi,
    /\d+(?:\.\d+)?\s*[-–—]\s*\d+(?:\.\d+)?\s*K/gi,
    /\d+(?:\.\d+)?\s*[-–—]\s*\d+(?:\.\d+)?\s*万元/g,
    /\d+(?:\.\d+)?\s*[-–—]\s*\d+(?:\.\d+)?\s*万/g,
    /\d+\s*[-–—]\s*\d+\s*元/g,
    /\d+(?:\.\d+)?\s*K/gi,
    /\d+(?:\.\d+)?\s*(?:万元|万|元)/g,
    /面议/g,
  ]);
  const availability = firstMatch(all, [
    /离职[-—][^\n]{2,12}/g,
    /在职[-—][^\n]{2,12}/g,
    /随时到岗/g,
  ]);
  const recentFocus = textAfter(texts.map((text) => ({ text })), '最近关注', ['工作经历', '教育经历', '项目经历']);
  const workExperience = textAfter(texts.map((text) => ({ text })), '工作经历', ['教育经历', '项目经历', '资格证书', '立即沟通']);
  const education = textAfter(texts.map((text) => ({ text })), '教育经历', ['项目经历', '资格证书', '立即沟通']);
  // mergeFacts rebuilds its output from a fixed key list, so the two inspection
  // keys below stay out of the stored facts and the dedup fingerprint. They
  // exist so the evidence can explain a work_years that was read but discarded.
  const workYearsInspection = inspectWorkYearsFromText(all, age);
  return {
    work_years: workYearsInspection.value,
    work_years_rejected: workYearsInspection.rejected,
    work_years_rejection_reason: workYearsInspection.reason,
    degree,
    age,
    salary,
    availability,
    recent_focus: recentFocus,
    work_experience_text: workExperience,
    education_text: education,
  };
}

function mergeUniqueLines(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    for (const line of String(value || '').split('\n')) {
      const text = cleanText(line);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
  }
  return out.join('\n');
}

function mergeFacts(group) {
  const facts = group.images.map((image) => extractFacts(image.lines));
  const pick = (key) => facts.map((item) => item[key]).find(Boolean) || null;
  return {
    work_years: pick('work_years'),
    degree: pick('degree'),
    age: pick('age'),
    salary: pick('salary'),
    availability: pick('availability'),
    recent_focus: mergeUniqueLines(facts.map((item) => item.recent_focus)),
    work_experience_text: mergeUniqueLines(facts.map((item) => item.work_experience_text)),
    education_text: mergeUniqueLines(facts.map((item) => item.education_text)),
  };
}

const TRACEABLE_FACT_FIELDS = [
  'work_years',
  'degree',
  'age',
  'salary',
  'availability',
  'recent_focus',
  'work_experience_text',
  'education_text',
];

function sourceSpan(image, line, lineIndex) {
  return {
    source_file: path.basename(image.file || ''),
    line_index: lineIndex,
    text: cleanText(line.text),
    confidence: line.confidence != null && Number.isFinite(Number(line.confidence)) ? Number(line.confidence) : null,
    bbox: {
      left: Number(line.left || 0),
      top: Number(line.top || 0),
      width: Number(line.width || 0),
      height: Number(line.height || 0),
    },
  };
}

// Report the strongest read of the value, not the weakest. A fact repeated
// across several screenshots collects one span per sighting, so Math.min turned
// every extra corroboration into a lower score and flagged 65% of all fields as
// low-confidence. What survives Math.max is genuinely weak: the compact
// "28岁·8年·大专" meta line that Vision really does read at 0.3.
function confidenceForSpans(spans) {
  const values = spans.map((span) => span.confidence).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function distinctFactValues(group, field) {
  return [...new Set(group.images.map((image) => extractFacts(image.lines)[field]).filter(Boolean))];
}

function matchingSpans(group, value, matcher = null) {
  const wanted = new Set(String(value || '').split('\n').map(cleanText).filter(Boolean));
  const spans = [];
  for (const image of group.images) {
    image.lines.forEach((line, lineIndex) => {
      const lineText = cleanText(line.text);
      if ((matcher && matcher(lineText)) || (!matcher && wanted.has(lineText))) {
        spans.push(sourceSpan(image, line, lineIndex));
      }
    });
  }
  return spans;
}

function fieldTrace(fieldKey, value, spans, conflictValues = [], metadata = {}) {
  return {
    field_key: fieldKey,
    extracted_value: value || null,
    confidence: confidenceForSpans(spans),
    source_spans: spans,
    conflict_values: conflictValues.length > 1 ? conflictValues : [],
    ...metadata,
  };
}

// The name confidence must come from the single line the geometry algorithm
// actually selected, not from an aggregate over every line that happens to
// repeat the same string. Aggregating with Math.min let each extra corroborating
// sighting *lower* the score, so a well-covered candidate scored worse than a
// barely-covered one and the downstream review gate rejected every draft.
function primaryNameSpan(group) {
  const source = group.name_source;
  if (!source || !source.image || !source.line) return null;
  return sourceSpan(source.image, source.line, source.image.lines.indexOf(source.line));
}

function buildFieldEvidence(group, facts) {
  const nameSpans = matchingSpans(group, group.name, (lineText) => normalizeName(lineText) === group.name);
  const primarySpan = primaryNameSpan(group);
  const nameTrace = fieldTrace('name', group.name, nameSpans, [], {
    extraction_method: group.name_extraction_method || null,
    trusted: group.name_extraction_method === NAME_EXTRACTION_METHOD && !!group.name && nameSpans.length > 0,
  });
  const evidence = {
    name: {
      ...nameTrace,
      confidence: primarySpan ? primarySpan.confidence : null,
      primary_span: primarySpan,
    },
  };
  const rejectedWorkYears = group.images
    .map((image) => extractFacts(image.lines))
    .find((item) => item.work_years_rejected);
  for (const field of TRACEABLE_FACT_FIELDS) {
    const value = facts[field] || null;
    const conflicts = distinctFactValues(group, field);
    const spans = matchingSpans(group, value, ['work_years', 'degree', 'age', 'salary', 'availability'].includes(field)
      ? (lineText) => !!value && lineText.includes(cleanText(value))
      : null);
    // Only worth surfacing when nothing survived: if another screenshot in the
    // group supplied a sane value, the discarded reading is just noise.
    evidence[field] = fieldTrace(`facts.${field}`, value, spans, conflicts,
      field === 'work_years' && rejectedWorkYears && !value
        ? {
          rejected_value: rejectedWorkYears.work_years_rejected,
          rejected_reason: rejectedWorkYears.work_years_rejection_reason,
        }
        : {});
  }
  return evidence;
}

function stableId(name, facts, ocrText) {
  const identity = buildScreenshotIdentity({ name, facts });
  const hash = crypto.createHash('sha1').update(JSON.stringify({
    name: cleanText(name),
    content_fingerprint: identity.content_fingerprint,
    ocr_text: cleanText(ocrText),
  })).digest('hex').slice(0, 12);
  return `screenshot-${hash}`;
}

function buildDrafts(ocrImages) {
  const normalized = ocrImages.map((image) => ({
    ...image,
    kind: classifyImage(image),
    lines: (image.lines || []).map(normalizeLine),
  }));
  const { groups: sequenceGroups, consumed } = sourceSequenceGroups(normalized);
  const groups = [...sequenceGroups];
  let current = null;

  for (let index = 0; index < normalized.length; index += 1) {
    if (consumed.has(index)) continue;
    const image = normalized[index];
    if (image.kind !== 'detail') {
      // A list or unknown page is a hard continuity boundary. Without this,
      // a later nameless detail page can inherit the previous candidate and
      // silently attach another person's facts. Explicit filename page
      // sequences were already handled above and remain the only exception.
      current = null;
      continue;
    }
    const nameLine = extractNameLine(image.lines, image.height, image.width);
    const name = nameLine ? normalizeName(nameLine.text) : null;
    const startsNewCandidate = !!name && (!current || current.name !== name);
    if (startsNewCandidate) {
      current = {
        name,
        name_source: { image, line: nameLine },
        name_extraction_method: NAME_EXTRACTION_METHOD,
        images: [],
        first_index: index,
        grouping: { strategy: 'detail_header_sequence' },
      };
      groups.push(current);
    }
    if (current) {
      current.images.push(image);
      if (!current.name && name) {
        current.name = name;
        current.name_source = { image, line: nameLine };
      }
    }
  }

  return groups
    .filter((group) => group.images.length && (group.name || group.grouping.strategy === 'filename_page_sequence'))
    .sort((a, b) => a.first_index - b.first_index)
    .map((group) => {
      const files = group.images.map((image) => image.file);
      const ocrText = mergeUniqueLines(group.images.map((image) => image.lines.map((line) => line.text).join('\n')));
      const facts = mergeFacts(group);
      return {
        draft_id: stableId(group.name, facts, ocrText),
        source: 'Boss App截图导入草稿',
        name: group.name,
        files,
        facts,
        field_evidence: buildFieldEvidence(group, facts),
        grouping: group.grouping,
        ocr_text: ocrText,
      };
    });
}

async function main() {
  const dir = argValue('dir');
  if (!dir) throw new Error('missing --dir=/path/to/screenshots');
  const out = argValue('out', DEFAULT_OUT);
  const ocrOut = argValue('ocr-out', DEFAULT_OCR_OUT);
  const limit = Number(argValue('limit', '0'));
  const files = listImages(dir).slice(0, limit > 0 ? limit : undefined);
  if (!files.length) throw new Error(`no screenshots found in ${dir}`);
  const progressFile = argValue('progress', OCR_PROGRESS_FILE);
  ensurePrivateDir(path.dirname(progressFile));
  const ocr = runScreenshotOcr(files, progressFile);
  // The per-page counter is only meaningful while recognition runs; leaving a
  // finished batch behind would make the next import look half-done.
  try { fs.rmSync(progressFile, { force: true }); } catch {}
  const drafts = buildDrafts(ocr);
  // Screenshots that never landed in a draft are the ones an HR goes looking
  // for. Counting them here is the only place that knows both the input list
  // and the grouping outcome.
  const grouped = new Set(drafts.flatMap((draft) => draft.files));
  const unmatched = ocr
    .filter((image) => !grouped.has(image.file))
    .map((image) => ({ name: path.basename(image.file), kind: classifyImage({ lines: image.lines || [] }) }));
  // A skipped list page is the pipeline working as intended; only the rest is
  // something the HR should look at. Reporting them as one number would read
  // as failure every time someone screenshots the candidate list.
  const skippedListFiles = unmatched.filter((item) => item.kind === 'list').map((item) => item.name);
  const unrecognizedFiles = unmatched.filter((item) => item.kind !== 'list').map((item) => item.name);
  ensurePrivateDir(path.dirname(out));
  writePrivateFile(ocrOut, JSON.stringify(ocr, null, 2));
  writePrivateFile(out, JSON.stringify({
    source_dir: dir,
    generated_at: new Date().toISOString(),
    image_count: files.length,
    detail_draft_count: drafts.length,
    skipped_list_count: skippedListFiles.length,
    unrecognized_count: unrecognizedFiles.length,
    skipped_list_files: skippedListFiles,
    unrecognized_files: unrecognizedFiles,
    drafts,
  }, null, 2));
  console.log(JSON.stringify({
    ok: true,
    image_count: files.length,
    detail_draft_count: drafts.length,
    skipped_list_count: skippedListFiles.length,
    unrecognized_count: unrecognizedFiles.length,
    out,
    ocr_out: ocrOut,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  cleanText,
  extractName,
  classifyImage,
  extractFacts,
  buildDrafts,
  buildFieldEvidence,
  sourceSequenceHint,
};
