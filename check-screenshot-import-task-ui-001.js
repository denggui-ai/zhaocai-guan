#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

// Execute the shipped handlers; only HTTP, React setters and time are supplied
// by the harness. A persisted import summary is intentionally left at one after
// the database fixture has no remaining pending drafts (confirm or reject).
async function checkPendingReviewLifecycle(appSource, panelSource, taskModule) {
  const failures = [];
  let cases = 0;
  const check = async (name, body) => {
    cases += 1;
    try { await body(); } catch (error) { failures.push(`${name}: ${error.message}`); }
  };
  const staleProgress = {
    run_id: 'completed-A', status: 'done', image_count: 1, detail_draft_count: 1,
    ocr_done: 1, ocr_total: 1, finished_at: '2026-09-30T01:34:25.253Z',
    result: { job_id: 2, job_name: '虚构截图岗位', pending_review: 1, total: 1 },
  };
  const callbackSource = (name) => {
    const match = appSource.match(new RegExp(`const ${name} = useCallback\\(([\\s\\S]*?)\\n  \\}, \\[[^\\]]*\\]\\);`));
    assert.ok(match, `${name} must remain discoverable`);
    return `${match[1]}\n  }`;
  };
  const pollSource = appSource.match(/async function pollScreenshotImportProgress\(\) \{[\s\S]*?\n    \}/)?.[0];
  assert.ok(pollSource);
  function harness(options = {}) {
    const observed = { opens: [], notices: [], draftJobs: [], pending: null, task: null };
    const context = vm.createContext({
      ...taskModule,
      READONLY_UI: false, dead: false,
      currentJobContextRef: { current: { jobId: options.currentJobId ?? 2, token: 1 } },
      screenshotImportTaskRequestRef: { current: 0 }, screenshotPendingRequestRef: { current: 0 },
      screenshotImportTaskRef: { current: null }, screenshotImportDoneRef: { current: '' },
      screenshotImportBusyRef: { current: false },
      sameJobId: (a, b) => a != null && b != null && String(a) === String(b),
      isCurrentJobContext: (ref, captured) => ref.current.token === captured.token
        && String(ref.current.jobId) === String(captured.jobId),
      progressDoneKey: (task) => task?.finished_at || '', isRecentProgress: () => true,
      api: {
        screenshotImportProgress: async () => ({ progress: options.progress || staleProgress }),
        screenshotImportTask: async () => ({ task: options.detailed || null }),
        listScreenshotOcrDrafts: async (status, jobId) => {
          assert.equal(status, 'pending_review');
          observed.draftJobs.push(jobId);
          if (options.readDrafts) return options.readDrafts(context);
          return { drafts: options.pending ?? [] };
        },
      },
      setScreenshotPendingReview: (value) => { observed.pending = value; },
      setScreenshotImportProgress: (value) => { observed.task = value; },
      setScreenshotImportTaskLoadState: () => {}, setScreenshotImportTaskError: () => {},
      setScreenshotImportTaskOpen: (value) => { observed.opens.push(['task', value]); },
      setScreenshotReviewOpen: (value) => { observed.opens.push(['review', value]); },
      loadCandidates: async (jobId) => {
        assert.equal(jobId, context.currentJobContextRef.current.jobId);
        await options.beforeCandidates?.(context);
        return true;
      },
      message: Object.fromEntries(['success', 'error', 'warning', 'info'].map((kind) => [
        kind, (...args) => observed.notices.push([kind, ...args]),
      ])),
    });
    context.refreshScreenshotPendingCount = vm.runInContext(`(${callbackSource('refreshScreenshotPendingCount')})`, context);
    context.refreshScreenshotImportTask = vm.runInContext(`(${callbackSource('refreshScreenshotImportTask')})`, context);
    context.acceptScreenshotPendingCount = vm.runInContext(`(${callbackSource('acceptScreenshotPendingCount')})`, context);
    return { observed, context, poll: vm.runInContext(`(${pollSource})`, context) };
  }
  function panelPending(state) {
    const start = panelSource.indexOf('  const authoritativePendingReview');
    const end = panelSource.indexOf('  const issueCount', start);
    assert.ok(start >= 0 && end > start);
    return vm.runInNewContext(`${panelSource.slice(start, end)}\n({count: pendingReviewCount, known: pendingReviewKnown})`, {
      task: taskModule.normalizeScreenshotImportTask(staleProgress), pendingReviewState: state,
    });
  }
  await check('confirmed/rejected drafts override the persisted count in the panel', () => {
    const actual = panelPending({ status: 'ready', count: 0 });
    assert.equal(actual.count, 0);
    assert.equal(actual.known, true);
  });
  for (const status of ['loading', 'error']) {
    await check(`${status} never presents a stale or fabricated pending count`, () => {
      const actual = panelPending({ status, count: null });
      assert.equal(actual.known, false);
      assert.equal(actual.count, null);
    });
  }
  await check('normalizing twice preserves an unknown count', () => {
    const once = taskModule.normalizeScreenshotImportTask({ run_id: 'working', status: 'running' });
    assert.equal(taskModule.normalizeScreenshotImportTask(once).pending_review_known, false);
  });
  await check('manual task refresh reads current database drafts', async () => {
    const h = harness();
    const task = await h.context.refreshScreenshotImportTask({ runId: 'completed-A' });
    assert.equal(task.pending_review_state?.status, 'ready');
    assert.equal(task.pending_review_state?.count, 0);
    assert.equal(h.observed.pending?.count, 0);
    assert.deepEqual(h.observed.draftJobs, [2]);
  });
  await check('restart after confirm/reject does not reopen or announce pending drafts', async () => {
    const h = harness();
    await h.poll();
    assert.deepEqual(h.observed.opens, []);
    assert.deepEqual(h.observed.notices, []);
  });
  await check('a genuine pending draft still opens review once', async () => {
    const h = harness({ pending: [{ id: 1, job_id: 2, status: 'pending_review' }] });
    await h.poll();
    await h.poll();
    assert.deepEqual(h.observed.opens, [['review', true]]);
  });
  await check('confirmed task from another job never opens or switches context', async () => {
    const h = harness({ currentJobId: 1 });
    await h.poll();
    assert.deepEqual(h.observed.opens, []);
    assert.equal(h.context.currentJobContextRef.current.jobId, 1);
    assert.deepEqual(h.observed.draftJobs, [2]);
  });
  for (const [name, readDrafts] of [
    ['database failure', async () => { throw new Error('synthetic draft read failure'); }],
    ['malformed draft response', async () => ({ drafts: null })],
  ]) {
    await check(`${name} remains unknown and offers task recovery`, async () => {
      const h = harness({ readDrafts });
      await h.poll();
      assert.equal(h.observed.task.pending_review_state?.status, 'error');
      assert.equal(h.observed.task.pending_review_state?.count, null);
      assert.deepEqual(h.observed.opens, [['task', true]]);
    });
  }
  await check('late completion of A cannot open over a new batch B in the same job', async () => {
    const h = harness({
      pending: [{ id: 1, job_id: 2 }],
      beforeCandidates: async (context) => {
        context.screenshotImportTaskRef.current = taskModule.normalizeScreenshotImportTask({
          run_id: 'running-B', status: 'running', result: { job_id: 2 },
        });
      },
    });
    await h.poll();
    assert.deepEqual(h.observed.opens, []);
    assert.deepEqual(h.observed.notices, []);
  });
  await check('task lookup never merges the latest unrelated legacy run', async () => {
    const h = harness({
      progress: { ...staleProgress, run_id: 'running-B', status: 'running', source_dir_name: 'B', result: { job_id: 3 } },
      detailed: { ...staleProgress, source_dir_name: 'A' },
    });
    const task = await h.context.refreshScreenshotImportTask({ runId: 'completed-A' });
    assert.equal(task.task_id, 'completed-A');
    assert.equal(task.status, 'done');
    assert.equal(task.source_dir_name, 'A');
    assert.equal(task.result.job_id, 2);
    assert.equal(task.pending_review_state?.count, 0);
  });
  await check('an empty queue does not hide failed or unrecognized screenshots', async () => {
    const h = harness({ progress: {
      ...staleProgress, result: { ...staleProgress.result, unrecognized_count: 1 },
    } });
    await h.poll();
    assert.deepEqual(h.observed.opens, [['task', true]]);
  });
  await check('manual refresh recovers an unknown queue without reusing its import count', async () => {
    let broken = true;
    const h = harness({ readDrafts: async () => {
      if (broken) throw new Error('synthetic temporary database read failure');
      return { drafts: [] };
    } });
    await h.poll();
    assert.equal(h.observed.pending.status, 'error');
    broken = false;
    const task = await h.context.refreshScreenshotImportTask({ runId: 'completed-A', showLoading: true });
    assert.equal(task.pending_review_state.status, 'ready');
    assert.equal(task.pending_review_state.count, 0);
    assert.equal(h.observed.pending.count, 0);
    await h.poll();
    assert.deepEqual(h.observed.opens, [['task', true]], 'recovery must not reopen a settled task or review');
  });
  await check('a late database read cannot overwrite a new task request', async () => {
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    const h = harness({ readDrafts: async () => { entered(); return waiting; } });
    const first = h.context.refreshScreenshotImportTask();
    await started;
    h.context.api.screenshotImportProgress = async () => ({ progress: { run_id: 'running-B', status: 'running' } });
    await h.context.refreshScreenshotImportTask();
    release({ drafts: [{ id: 1, job_id: 2 }] });
    assert.equal(await first, null);
    assert.equal(h.observed.task.task_id, 'running-B');
  });
  await check('confirming while a task read is pending keeps the accepted zero', async () => {
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    const h = harness({ readDrafts: async () => { entered(); return waiting; } });
    const inflight = h.context.refreshScreenshotImportTask();
    await started;
    h.context.acceptScreenshotPendingCount(0, 2);
    release({ drafts: [{ id: 1, job_id: 2 }] });
    assert.equal(await inflight, null);
    assert.equal(h.observed.pending.count, 0);
    assert.equal(h.observed.task, null);
  });
  await check('changing jobs during candidate refresh prevents review from reopening', async () => {
    const h = harness({ pending: [{ id: 1, job_id: 2 }], beforeCandidates: async (context) => {
      context.currentJobContextRef.current = { jobId: 3, token: 2 };
    } });
    await h.poll();
    assert.deepEqual(h.observed.opens, []);
    assert.deepEqual(h.observed.notices, []);
  });
  await check('confirming the last draft during candidate refresh invalidates the earlier pending one', async () => {
    const h = harness({ pending: [{ id: 1, job_id: 2 }], beforeCandidates: async (context) => {
      context.acceptScreenshotPendingCount(0, 2);
    } });
    await h.poll();
    assert.deepEqual(h.observed.opens, []);
    assert.deepEqual(h.observed.notices, []);
    assert.equal(h.observed.pending.count, 0);
  });
  await check('a mismatched detail response is not hidden behind cached AI metadata', async () => {
    const h = harness({
      progress: { ...staleProgress, ai_task: { ...staleProgress } },
      detailed: { ...staleProgress, run_id: 'different-B' },
    });
    const task = await h.context.refreshScreenshotImportTask({ runId: 'completed-A' });
    assert.equal(task, null);
    assert.equal(h.observed.task, null);
    assert.deepEqual(h.observed.draftJobs, []);
  });
  assert.deepEqual(failures, [], failures.join('\n'));
  console.log(`screenshot pending lifecycle: ${cases} behavior cases passed`);
}

(async () => {
  const taskModule = await import(pathToFileURL(
    path.join(__dirname, 'frontend/src/screenshot-import-task.mjs'),
  ));
  const {
    isScreenshotImportTaskActive,
    normalizeScreenshotImportTask,
    screenshotImportTaskIssueCount,
    screenshotImportTaskNeedsAttention,
  } = taskModule;

  const running = normalizeScreenshotImportTask({
    run_id: 'run-live',
    status: 'running',
    counts: {
      image_count: 6,
      pending_count: 4,
      processed_count: 2,
      recognized_image_count: 1,
      succeeded_count: 1,
      skipped_list_count: 1,
      unrecognized_count: 0,
      failed_count: 0,
    },
  });
  assert.equal(running.task_id, 'run-live');
  assert.equal(isScreenshotImportTaskActive(running), true);
  assert.deepEqual(running.progress, { done: 2, total: 6, percent: 33 });
  assert.equal(running.counts.processingPending, 4);
  assert.equal(running.counts.pendingReview, 0,
    'pending_count is unfinished image work and must never be presented as pending review');
  assert.equal(running.pending_review_known, false);

  const partial = normalizeScreenshotImportTask({
    run_id: 'run-partial',
    status: 'completed_with_failures',
    counts: {
      image_count: 4,
      pending_count: 0,
      processed_count: 4,
      recognized_image_count: 1,
      detail_draft_count: 1,
      pending_review_count: 1,
      skipped_list_count: 1,
      unrecognized_count: 1,
      failed_count: 1,
      retryable_count: 2,
    },
    items: [
      { image_id: 'image-unrecognized', ordinal: 2, status: 'unrecognized', attempts: 1, error_code: 'SCREENSHOT_AI_UNRECOGNIZED' },
      { image_id: 'image-failed', ordinal: 4, status: 'failed', attempts: 2, error_code: 'SCREENSHOT_AI_READ_FAILED' },
    ],
  });
  assert.equal(partial.status, 'done');
  assert.equal(partial.pending_review_known, true);
  assert.equal(partial.counts.pendingReview, 1);
  assert.equal(partial.counts.drafts, 1);
  assert.equal(partial.detail_draft_count, 1,
    'legacy detail_draft_count alias must describe candidate drafts, not recognized images');
  assert.equal(partial.items.unrecognized[0].id, 'image-unrecognized');
  assert.equal(partial.items.unrecognized[0].fileName, '第 2 张截图');
  assert.equal(partial.items.unrecognized[0].retryable, true);
  assert.equal(partial.items.failed[0].id, 'image-failed');
  assert.equal(screenshotImportTaskIssueCount(partial), 2);
  assert.equal(screenshotImportTaskNeedsAttention(partial), true);

  const macLegacy = normalizeScreenshotImportTask({
    status: 'done',
    image_count: 5,
    detail_draft_count: 2,
    ocr_done: 5,
    ocr_total: 5,
    result: {
      pending_review: 2,
      skipped_list_count: 1,
      unrecognized_count: 1,
      failed_count: 0,
    },
  });
  assert.deepEqual(macLegacy.progress, { done: 5, total: 5, percent: 100 });
  assert.equal(macLegacy.counts.recognized, 3,
    'legacy Mac success images are derived from input minus explicit non-success outcomes');
  assert.equal(macLegacy.counts.drafts, 2,
    'candidate groups stay separate from recognized image count');
  assert.equal(macLegacy.detail_draft_count, 2,
    'legacy detail_draft_count alias stays candidate-group based');
  assert.equal(macLegacy.counts.pendingReview, 2);

  const appSource = fs.readFileSync(path.join(__dirname, 'frontend/src/App.jsx'), 'utf8');
  const panelSource = fs.readFileSync(
    path.join(__dirname, 'frontend/src/components/ScreenshotImportTaskPanel.jsx'),
    'utf8',
  );
  const reviewSource = fs.readFileSync(
    path.join(__dirname, 'frontend/src/components/ScreenshotOcrReviewModal.jsx'),
    'utf8',
  );
  const apiSource = fs.readFileSync(path.join(__dirname, 'frontend/src/api.js'), 'utf8');
  assert.match(panelSource, /<Progress[\s\S]*?task\.progress\.percent/);
  for (const label of ['输入截图', '识别成功截图', '候选人待校对', '未识别', '失败', '跳过列表页']) {
    assert.ok(panelSource.includes(label), `task center must expose the ${label} count`);
  }
  assert.match(panelSource, /title="未识别截图"[\s\S]*?onRetry=\{retry\}/);
  assert.match(panelSource, /title="识别失败截图"[\s\S]*?onRetry=\{retry\}/);
  assert.match(appSource, /screenshotImportBusyRef\.current \|\| isScreenshotImportTaskActive\(screenshotImportTaskRef\.current\)/);
  assert.ok(
    appSource.indexOf('api.approveScreenshotImportRetry') < appSource.indexOf('api.retryScreenshotImportItems'),
    'failed-item retry must obtain native approval before POSTing the retry',
  );
  assert.match(
    appSource,
    /async function refreshScreenshotReviewJob[\s\S]*?api\.listJobs\(\)[\s\S]*?jobsRef\.current = nextJobs[\s\S]*?jobsStateRef\.current = nextState/,
    'opening review must refresh the authoritative jobs ledger, including synchronous refs',
  );
  const openReviewSource = appSource.slice(
    appSource.indexOf('async function handleOpenScreenshotReviewFromTask'),
    appSource.indexOf('async function refreshJobs(', appSource.indexOf('async function handleOpenScreenshotReviewFromTask')),
  );
  assert.ok(
    openReviewSource.indexOf('refreshScreenshotReviewJob(targetJobId)')
      < openReviewSource.indexOf('handleJobChange(targetJobId)'),
    'a task-owned job missing from the current list must be refreshed before switching context',
  );
  assert.match(apiSource, /\/screenshot-import\/task/);
  assert.match(apiSource, /\/screenshot-import\/retry/);
  assert.match(reviewSource, /selectedNameTrace\.extraction_method === 'external_ai_vision_v1'/);
  assert.match(reviewSource, /screenshotOcrDraftPreviewUrl\(selected\.id\)/);
  assert.match(reviewSource, /URL\.revokeObjectURL/);
  assert.match(reviewSource, /我已对照原图确认姓名/);
  assert.match(reviewSource, /name_verified_by_hr: requiresNameVerification && nameVerifiedByHr/);
  assert.match(reviewSource, /trace\.rejected_value/);
  assert.match(reviewSource, /trace\.rejected_reason/);
  assert.match(reviewSource, /未自动采用/);
  assert.ok(
    reviewSource.indexOf('api.approveScreenshotOcrAiFill') < reviewSource.indexOf('api.aiFillScreenshotOcrDrafts'),
    'AI fill must obtain a per-image native approval before sending draft screenshots',
  );

  await checkPendingReviewLifecycle(appSource, panelSource, taskModule);

  console.log('check-screenshot-import-task-ui-001 ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
