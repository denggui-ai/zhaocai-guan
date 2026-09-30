#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const topBar = fs.readFileSync(
  path.join(__dirname, 'frontend/src/components/TopBar.jsx'),
  'utf8',
);

// The shell owns only context, task truth, and global recovery. Module actions
// must not be reintroduced through either a dropdown or an opaque action slot.
for (const crossDomainLabel of [
  '导入 Boss App 截图',
  '校对 OCR 草稿',
  '批量规则评级',
  '连接 Boss（可选）',
  '检查 Boss 职位新增数据',
  '检查当前岗位候选人',
  '检查 5 份缺失简历',
  '招聘画像（前往岗位管理）',
  '深度画像',
  '主动搜索（材料）',
  '查看导入预览',
  '停止运行任务',
]) {
  assert.ok(!topBar.includes(crossDomainLabel), `TopBar still renders cross-domain action: ${crossDomainLabel}`);
}
assert.doesNotMatch(topBar, /<Dropdown\b|operationItems|operationHandlers|操作菜单/);
assert.doesNotMatch(topBar, /\{extraActions\}|topbar-secondary-actions/);
assert.match(topBar, /\.\.\._legacyActionProps/);

// Job identity and the single current-task projection remain global truth.
assert.match(topBar, /value=\{jobId \?\? undefined\}/);
assert.match(topBar, /onChange=\{onJobChange\}/);
assert.match(topBar, /jobs\.map\(\(job\) => \(\{ value: job\.id/);
assert.match(topBar, /role="status"[\s\S]*?aria-live="polite"[\s\S]*?\{statusText\}/);
assert.match(topBar, /const statusText = screenshotImportActive/);
assert.match(topBar, /DONE_STATUS_VISIBLE_MS/);
assert.match(topBar, /recentlyFinished/);

// Refresh remains the only unconditional shell recovery action; there is no
// more platform read-preview or running-task-stop control to keep scrollable.
assert.match(topBar, /className="topbar-global-recovery" role="group" aria-label="全局状态与恢复"/);
assert.match(topBar, /className="topbar-refresh-local"[\s\S]*?onClick=\{onRefreshLocal\}/);
assert.doesNotMatch(topBar, /overflowX|overflow-x|overflow:\s*['"]?hidden/);
assert.doesNotMatch(topBar, /boss-read-preview-open|onOpenBossReadPreview|topbar-stop-running|onStopRunningTask|runningTask|operationalReadOnly/);

// A closed job still shows the neutral readonly tag; there is no more global
// operational readonly prop distinguishing it from per-job readonly.
assert.match(topBar, /readOnlyReason === 'closed-job' \? '岗位已关闭' : '操作只读'/);

console.log(JSON.stringify({
  ok: true,
  contract: 'UX-W1-A-TOPBAR-OWNERSHIP',
  job_context_preserved: true,
  current_task_status_preserved: true,
  global_refresh_explicit: true,
  cross_domain_actions_removed: true,
  platform_read_preview_removed: true,
  app_wiring_required: ['readOnly', 'readOnlyReason', 'localRefreshBusy', 'onRefreshLocal'],
}));
