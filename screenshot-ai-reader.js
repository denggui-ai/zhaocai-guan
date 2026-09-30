'use strict';

// Reads a whole screenshot with the model, for platforms with no usable local
// recognition.
//
// macOS reads screenshots with Vision, which returns text with pixel boxes, and
// the name it produces carries the positional evidence the confirm gate weighs.
// Windows has no such reader — tesseract was measured and rejected: 6/13 names
// on the fast model, and the accurate one invented seven candidates that do not
// exist. So on Windows the model reads the page outright, name included, and the
// resulting draft is one a human must check before it can become a candidate.
// That is not a promise made here; the confirm gate enforces it, because a name
// with no source spans cannot satisfy it (AI-AUTHORED-DRAFT-GATE-001).
//
// Candidate-list pages can mix one person's details with another's record.
// Only a page explicitly classified as a single-candidate detail page may
// produce a draft; other classifications are discarded before extraction.

const fs = require('fs');
const path = require('path');

const PAGE_TYPES = ['detail', 'list', 'other'];
const SCALAR_FIELDS = ['work_years', 'degree', 'age', 'salary', 'availability'];
const TEXT_FIELDS = ['recent_focus', 'work_experience_text', 'education_text'];
const FILLABLE = [...SCALAR_FIELDS, ...TEXT_FIELDS];
const EXTRACTION_METHOD = 'external_ai_vision_v1';
const GROUPING_STRATEGY = 'external_ai_detail';

// Classification and extraction share one call: a second round trip per image
// would double a Windows import's wall clock for an answer the model already
// formed while reading the page.
const PROMPT = `这是 BOSS 直聘 App 的一张截图。只返回一个 JSON 对象，不要解释、不要代码块。

先判断页面类型，再读字段：
- page_type：detail = 单个候选人的详情页（大字姓名、工作年限/学历/年龄、立即沟通、工作经历等），或其向下滚动的续页；list = 候选人列表页（同屏多个候选人条目，或底部有 牛人/搜索/消息/我的 标签栏）；other = 其他页面
- **page_type 不是 detail 时，其余字段一律填 null，不要从列表里挑任何一个人的信息**

字段说明（仅当 page_type 为 detail 时填写）：
- name：候选人姓名本身，不要带在线/离职等状态字样
- work_years：工作年限，如 8年；应届生写 应届生
- degree：学历，如 大专 / 本科 / 硕士
- age：年龄，如 28岁
- salary：**候选人本人的期望薪资**，通常在「求职期望」区块里。「最近关注」「牛人最近7天沟通过的职位」区块里的薪资是岗位薪资，不是候选人的期望薪资，绝对不要取。页面上没有候选人本人的期望薪资就填 null。
- availability：求职状态，如 离职-随时到岗
- recent_focus：「最近关注」或求职期望中的职位、城市摘录，不要把其中的岗位薪资写入 salary
- work_experience_text：当页能看清的工作经历原文摘录，保留公司、职位、时间和主要描述
- education_text：当页能看清的教育经历原文摘录，保留学校、专业、学历和时间

读不到、不确定、或只能从岗位信息推测的字段，一律填 null，不要猜。
按这个结构返回：{"page_type":null,"name":null,"work_years":null,"degree":null,"age":null,"salary":null,"availability":null,"recent_focus":null,"work_experience_text":null,"education_text":null}`;

function mediaType(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'image/png';
}

function cleanValue(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text && text.toLowerCase() !== 'null' ? text : null;
}

// A page is usable only if the model said so in the field reserved for saying
// so. Anything else — an unknown label, a missing one — is treated as not a
// detail page, because the cost of guessing wrong is a candidate's record
// carrying another candidate's facts.
function readPageType(answer) {
  const value = cleanValue(answer && answer.page_type);
  return value && PAGE_TYPES.includes(value) ? value : 'other';
}

async function readScreenshot(readImageJson, file) {
  const answer = await readImageJson({
    prompt: PROMPT,
    dataUri: `data:${mediaType(file)};base64,${fs.readFileSync(file).toString('base64')}`,
    sourceFile: file,
  });
  const pageType = readPageType(answer);
  if (pageType !== 'detail') return { file, page_type: pageType, skipped: true, name: null, facts: null };
  const facts = {};
  for (const field of FILLABLE) facts[field] = cleanValue(answer[field]);
  return { file, page_type: pageType, skipped: false, name: cleanValue(answer.name), facts };
}

// The evidence deliberately carries no confidence and no source spans, because
// there are none: the model reports what it read, not where on the screen it
// was. That shape is what keeps the draft out of a candidate record until a
// human has looked at it.
function mergeUniqueLines(values) {
  const seen = new Set();
  const lines = [];
  for (const value of values) {
    for (const line of String(value || '').split(/\n+/)) {
      const clean = line.trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      lines.push(clean);
    }
  }
  return lines.join('\n');
}

function distinctValues(reads, field) {
  return [...new Set(reads.map((read) => cleanValue(read.facts && read.facts[field])).filter(Boolean))];
}

function buildDraft(group, index) {
  const reads = group.reads;
  const facts = Object.fromEntries(SCALAR_FIELDS.map((field) => [
    field,
    reads.map((read) => cleanValue(read.facts && read.facts[field])).find(Boolean) || null,
  ]));
  for (const field of TEXT_FIELDS) {
    facts[field] = mergeUniqueLines(reads.map((read) => read.facts && read.facts[field]));
  }
  const evidence = {
    name: {
      field_key: 'name',
      extracted_value: group.name,
      extraction_method: EXTRACTION_METHOD,
      confidence: null,
      source_spans: [],
      conflict_values: [...new Set(reads.map((read) => cleanValue(read.name)).filter(Boolean))],
      trusted: false,
    },
  };
  for (const field of FILLABLE) {
    evidence[field] = {
      field_key: `facts.${field}`,
      extracted_value: facts[field] ?? null,
      extraction_method: EXTRACTION_METHOD,
      confidence: null,
      source_spans: [],
      conflict_values: distinctValues(reads, field),
    };
  }
  return {
    draft_id: `screenshot-ai-${index}`,
    source: 'Boss App截图导入草稿',
    name: group.name,
    files: reads.map((read) => read.file),
    facts,
    field_evidence: evidence,
    grouping: { strategy: GROUPING_STRATEGY, page_count: reads.length },
    ocr_text: mergeUniqueLines([
      group.name,
      ...reads.flatMap((read) => FILLABLE.map((field) => read.facts && read.facts[field])),
    ]),
  };
}

// Mirrors the local Vision reader's ordered grouping rule. A detail page with
// a different non-empty name starts a candidate; same-name and nameless detail
// pages continue the current candidate. List/other pages never contribute.
function groupDetailReads(reads) {
  const groups = [];
  let current = null;
  reads.forEach((read, readIndex) => {
    if (!read || read.failed || read.skipped || read.page_type !== 'detail') {
      // An unknown/list/failed page may be the missing first page of a different
      // candidate. Never carry a nameless continuation across that boundary.
      current = null;
      return;
    }
    const name = cleanValue(read.name);
    if (name && (!current || current.name !== name)) {
      current = { name, reads: [], first_index: readIndex };
      groups.push(current);
    }
    if (!current) return;
    current.reads.push(read);
    read.candidate_group_index = groups.length - 1;
  });
  return groups.filter((group) => group.name && group.reads.length);
}

function assembleScreenshotReads(reads) {
  reads.forEach((read) => { if (read) delete read.candidate_group_index; });
  const groups = groupDetailReads(reads);
  const drafts = groups.map((group, index) => buildDraft(group, index + 1));
  const summary = { image_count: reads.length, detail_draft_count: drafts.length, skipped_list_count: 0, unrecognized_count: 0, failed_count: 0 };
  reads.forEach((read) => {
    if (read.failed) { summary.failed_count += 1; return; }
    if (read.skipped) {
      if (read.page_type === 'list') summary.skipped_list_count += 1;
      else summary.unrecognized_count += 1;
      return;
    }
    if (!Number.isInteger(read.candidate_group_index)) summary.unrecognized_count += 1;
  });
  return { drafts, summary, reads };
}

// Reads run concurrently and each failure stays with its own image: one screen
// the model could not read should cost that screen, not the batch.
async function readScreenshots(readImageJson, files, options = {}) {
  const concurrency = Number(options.concurrency) > 0 ? Number(options.concurrency) : 4;
  const results = new Array(files.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, files.length)) }, async () => {
    while (cursor < files.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await readScreenshots.readOne(readImageJson, files[index]);
      } catch (error) {
        results[index] = {
          file: files[index],
          page_type: null,
          skipped: true,
          failed: true,
          error_code: error && typeof error.code === 'string' ? error.code : 'SCREENSHOT_AI_READ_FAILED',
          reason: error && typeof error.code === 'string' && error.message ? error.message : '外部 AI 调用失败。',
          name: null,
          facts: null,
        };
      }
      if (typeof options.onItemSettled === 'function') {
        await options.onItemSettled(results[index], index);
      }
    }
  }));

  return assembleScreenshotReads(results);
}

readScreenshots.readOne = readScreenshot;

module.exports = {
  EXTRACTION_METHOD,
  GROUPING_STRATEGY,
  FILLABLE,
  PROMPT,
  assembleScreenshotReads,
  buildDraft,
  groupDetailReads,
  readPageType,
  readScreenshot,
  readScreenshots,
};
