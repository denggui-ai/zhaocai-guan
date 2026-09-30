'use strict';

// Optional external-AI fill for the fields local recognition reads worst.
//
// Vision reads the candidate name from a large header and gets it right; it
// reads the compact "9年 · 本科 · 30岁" line at 0.3 confidence and sometimes
// turns 9年 into 19年. This module fills only those weak fields, only for
// candidates that need it, and never touches the name — the name carries the
// geometric evidence the review gate depends on, and AI answers carry none.
//
// Measured on the 76-screenshot sample: correct on every detail page tried, but
// on a candidate *list* page it mixed rows and reported one candidate's age for
// another. Detail pages only, therefore, and never as an override of a field
// local recognition already read confidently.

const fs = require('fs');
const path = require('path');

const DEFAULT_CONCURRENCY = 4;
const LOW_CONFIDENCE = 0.8;
const FILLABLE = ['work_years', 'degree', 'age', 'salary', 'availability'];
const EXTRACTION_METHOD = 'external_ai_vision_v1';

// The detail page shows two salaries that look alike. 「求职期望」 is what the
// candidate is asking for; 「最近关注」/「牛人最近7天沟通过的职位」 is the pay of a
// job they happened to contact — often the HR's own posting, identical across
// candidates. On many pages that job figure is the only salary visible, and a
// model not told the difference reports it as the candidate's expectation:
// measured wrong on 7 of the 7 such pages in the sample. A wrong salary here
// reads as plausible in review, so the two sections are named explicitly.
//
// The skeleton is all-null rather than descriptive, because a model that sees
// "期望薪资原文" sitting in a value position will sometimes echo that text back
// as the answer.
const PROMPT = `这是 BOSS 直聘 App 的候选人详情页截图。只返回一个 JSON 对象，不要解释、不要代码块。

字段说明：
- work_years：工作年限，如 8年；应届生写 应届生
- degree：学历，如 大专 / 本科 / 硕士
- age：年龄，如 28岁
- salary：**候选人本人的期望薪资**，通常在「求职期望」区块里。「最近关注」「牛人最近7天沟通过的职位」区块里的薪资是岗位薪资，不是候选人的期望薪资，绝对不要取。页面上没有候选人本人的期望薪资就填 null。
- availability：求职状态，如 离职-随时到岗

读不到、不确定、或只能从岗位信息推测的字段，一律填 null，不要猜。
按这个结构返回：{"work_years":null,"degree":null,"age":null,"salary":null,"availability":null}`;

// A field is worth an AI call when local recognition produced nothing, or
// produced something it is not confident about. Anything read confidently is
// left alone: the local value has screenshot coordinates behind it.
function weakFields(facts, evidence) {
  return FILLABLE.filter((field) => {
    const value = facts[field];
    if (!value) return true;
    const confidence = Number((evidence[field] || {}).confidence);
    return !Number.isFinite(confidence) || confidence < LOW_CONFIDENCE;
  });
}

function mediaType(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'image/png';
}

// The channel is injected rather than built here. The API key lives in the
// settings-page runtime's closure and is never handed out, so this module can
// only ever ask that runtime to read an image — which is also why configuring
// the settings page is now enough to make this work, and why an environment
// variable is no longer involved.
async function readFieldsFromScreenshot(readImageJson, file, options = {}) {
  const bytes = Buffer.isBuffer(options.bytes) ? options.bytes : fs.readFileSync(file);
  return readImageJson({
    prompt: PROMPT,
    dataUri: `data:${mediaType(file)};base64,${bytes.toString('base64')}`,
  });
}

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

module.exports = {
  EXTRACTION_METHOD,
  PROMPT,
  DEFAULT_CONCURRENCY,
  readFieldsFromScreenshot,
  runPool,
  LOW_CONFIDENCE,
  weakFields,
};
