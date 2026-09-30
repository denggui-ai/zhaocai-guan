'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, 'frontend/src/components/ScreenshotOcrReviewModal.jsx'),
  'utf8',
);

assert.match(source, /const hasUnsavedChanges = useMemo/);
assert.match(source, /function requestSelectDraft\(nextId\)/);
assert.match(source, /title: '当前 OCR 修改尚未保存'/);
assert.match(source, /okText: '放弃修改并切换'/);
assert.match(source, /function requestClose\(\)/);
assert.match(source, /okText: '放弃修改并关闭'/);
assert.match(source, /onCancel=\{requestClose\}/);
assert.match(source, /onClick=\{\(\) => requestSelectDraft\(item\.id\)\}/);
assert.match(source, /有未保存修改/);
assert.match(source, /disabled=\{saving \|\| committedRefreshBlocked \|\| !hasUnsavedChanges\}/);

console.log(JSON.stringify({
  ok: true,
  contract: 'OCR-UNSAVED-GUARD-UI-001',
  switch_requires_confirmation: true,
  close_requires_confirmation: true,
  unchanged_save_disabled: true,
}));
