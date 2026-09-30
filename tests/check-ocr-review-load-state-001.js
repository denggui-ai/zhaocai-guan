'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/ScreenshotOcrReviewModal.jsx'), 'utf8');

assert.match(source, /OCR 草稿读取失败/, '首次读取失败必须显示持久错误，不能伪装成空队列');
assert.match(source, /OCR 草稿刷新失败，当前显示上次成功数据/, '刷新失败必须保留上次成功草稿');
assert.match(source, /action=\{<Button loading=\{loading\} onClick=\{\(\) => load\(loadContextRef\.current\)\}>重试<\/Button>\}/, '读取失败必须提供显式人工重试');
assert.match(source, /!hasLoadedSuccessfully \? null : !selected \? <Empty/, '首次读取失败前不得渲染真实空态');
assert.doesNotMatch(source, /catch \(err\) \{[\s\S]{0,240}setDrafts\(\[\]\)/, '刷新失败不得清空上次成功草稿');
assert.match(source, /当前显示提交前数据，请勿重复确认或驳回；请仅重试刷新/, '写入已提交但刷新失败时必须明确禁止重复写入');
assert.match(source, /disabled=\{committedRefreshBlocked\}[\s\S]*?人工确认并入库/, '已提交草稿在 GET 刷新成功前必须禁用重复确认');
assert.match(source, /<Button danger disabled=\{committedRefreshBlocked\}>驳回<\/Button>/, '已提交草稿在 GET 刷新成功前必须禁用重复驳回');
assert.match(source, /setCommittedRefresh\(null\)[\s\S]*?onPendingCountChange/, '只读 GET 成功后才能解除同草稿写锁');
assert.match(source, /setHasLoadedSuccessfully\(false\);\s*setCommittedRefresh\(null\);\s*setSaving\(false\)/, '切换岗位上下文必须清理旧写入提示和忙状态');
assert.match(source, /refreshAfterCommittedDraft\(actionContext, draftId, 'OCR 草稿已人工确认并写入正式候选人档案'\)/);
assert.match(source, /refreshAfterCommittedDraft\(actionContext, draftId, 'OCR 草稿已驳回'\)/);

const retryCommittedRefresh = source.match(/async function retryCommittedRefresh\(\) \{[\s\S]*?\n  \}/)?.[0] || '';
assert.match(retryCommittedRefresh, /await load\(pending\.context\)/, '人工重试必须只重新读取 OCR 草稿');
assert.doesNotMatch(retryCommittedRefresh, /editScreenshotOcrDraft|confirmScreenshotOcrDraft|rejectScreenshotOcrDraft/, '人工重试不得重放任何写动作');

console.log('check-ocr-review-load-state-001 ok');
