import React from 'react';
import { Select, Button, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import {
  isScreenshotImportTaskActive,
  normalizeScreenshotImportTask,
  screenshotImportTaskIssueCount,
} from '../screenshot-import-task.mjs';

const SABC_OPTIONS = [
  { value: '', label: '评级：全部' },
  { value: 'S', label: 'S' },
  { value: 'A', label: 'A' },
  { value: 'B', label: 'B' },
  { value: 'C', label: 'C' },
  { value: 'D', label: 'D' },
  { value: '__none', label: '未评级' },
];
const DONE_STATUS_VISIBLE_MS = 5 * 60 * 1000;

function recentlyFinished(task) {
  const raw = task && (task.finished_at || task.updated_at);
  if (!raw) return false;
  const time = Date.parse(raw);
  return Number.isFinite(time) && Date.now() - time <= DONE_STATUS_VISIBLE_MS;
}

export default function TopBar({
  readOnly = false,
  readOnlyReason = '',
  showJobContext = true,
  showSabcFilter = false,
  jobs = [],
  jobId,
  onJobChange,
  sabc,
  onSabcChange,
  localRefreshBusy = false,
  onRefreshLocal,
  screenshotImportProgress,
  screenshotPendingReview,
  onOpenScreenshotImportTask,
  // App can keep passing the former cross-domain action props during its staged
  // migration. They are intentionally ignored and never rendered by TopBar.
  ..._legacyActionProps
}) {
  const currentJob = jobs.find((job) => String(job.id) === String(jobId));
  const currentJobIsFixture = !!(currentJob && currentJob.is_fixture);
  const screenshotTask = normalizeScreenshotImportTask(screenshotImportProgress);
  const screenshotImportActive = isScreenshotImportTaskActive(screenshotTask);
  const screenshotDoneVisible = screenshotTask.status === 'done' && recentlyFinished(screenshotTask);
  const screenshotErrorVisible = screenshotTask.status === 'error' && recentlyFinished(screenshotTask);
  const screenshotTaskTargetJobId = screenshotTask.result?.job_id;
  const screenshotTaskMatchesCurrentJob = !screenshotTaskTargetJobId
    || String(screenshotTaskTargetJobId) === String(jobId);
  const screenshotPendingReady = screenshotTaskMatchesCurrentJob
    && screenshotPendingReview?.status === 'ready'
    && Number.isFinite(screenshotPendingReview.count);
  // Recognition is the long stretch of an import; show the page counter while
  // it runs instead of one static line for the whole stage.
  const screenshotOcrCounter = screenshotTask.progress.total > 0
    ? `正在识别截图 ${screenshotTask.progress.done}/${screenshotTask.progress.total}`
    : '';
  // Separate the two reasons a screenshot produced no candidate: a skipped list
  // page is the importer working correctly, an unrecognized one is not. Naming
  // only the second keeps a normal import from reading as a partial failure.
  const screenshotOutcome = screenshotTask.counts;
  const screenshotOutcomeParts = [
    screenshotOutcome.recognized ? `${screenshotOutcome.recognized} 张识别成功` : '',
    screenshotOutcome.skipped ? `跳过 ${screenshotOutcome.skipped} 张列表页` : '',
    screenshotOutcome.unrecognized ? `${screenshotOutcome.unrecognized} 张未识别` : '',
    screenshotOutcome.failed ? `${screenshotOutcome.failed} 张失败` : '',
  ].filter(Boolean);
  const screenshotOutcomeTail = screenshotOutcomeParts.length ? `（${screenshotOutcomeParts.join('，')}）` : '';
  const screenshotTaskText = screenshotTask.status === 'running'
    ? (screenshotOcrCounter || screenshotTask.message || '截图导入中')
    : screenshotTask.status === 'done'
      ? !screenshotTaskMatchesCurrentJob
        ? `${screenshotTask.result?.job_name || '其他岗位'}的 OCR 草稿已暂存，请打开截图任务查看`
        : screenshotPendingReady
        ? `OCR 待校对：${screenshotPendingReview.count} 条${screenshotOutcomeTail}`
        : screenshotPendingReview?.status === 'error'
          ? 'OCR 草稿已暂存，待校对数量读取失败'
          : 'OCR 草稿已暂存，正在读取待校对数量'
      : screenshotTask.status === 'error'
        ? `截图导入失败：${screenshotTask.message || screenshotTask.error || '未知错误'}`
        : '';
  const statusText = screenshotImportActive
    ? screenshotTaskText
    : screenshotErrorVisible
      ? screenshotTaskText
      : screenshotDoneVisible
        ? screenshotTaskText
        : '';
  const statusTone = /失败|异常/.test(statusText)
    ? 'error'
    : /暂停|受限|待确认|待校对|问题项/.test(statusText)
      ? 'warning'
      : /中|等待|处理|正在停止/.test(statusText)
        ? 'active'
        : /完成|已同步|已完成|已确认导入/.test(statusText)
          ? 'done'
          : '';
  const screenshotIssueCount = screenshotImportTaskIssueCount(screenshotTask);
  const screenshotTaskPresent = Boolean(
    screenshotImportProgress
    && (screenshotTask.task_id || screenshotTask.status !== 'idle' || screenshotTask.counts.input > 0),
  );

  return (
    <div className="topbar">
      {showJobContext && (
        <div className="topbar-left topbar-job-context" role="group" aria-label={showSabcFilter ? '岗位与评级筛选' : '岗位上下文'}>
          <Select
            aria-label="选择岗位"
            size="small"
            variant="borderless"
            className="topbar-job-select"
            style={{ width: 230 }}
            value={jobId ?? undefined}
            onChange={onJobChange}
            options={jobs.map((job) => ({ value: job.id, label: `${job.name || `岗位 ${job.id}`}${job.is_fixture ? '（测试数据）' : ''}` }))}
            placeholder="选择岗位"
          />
          {currentJobIsFixture && <Tag color="gold">测试数据</Tag>}
          {showSabcFilter && (
            <Select
              aria-label="按评级筛选候选人"
              size="small"
              variant="borderless"
              className="topbar-rating-select"
              style={{ width: 116 }}
              value={sabc}
              onChange={onSabcChange}
              options={SABC_OPTIONS}
            />
          )}
        </div>
      )}
      <Typography.Text
        type="secondary"
        className={`topbar-source topbar-status ${statusText ? '' : 'empty'} ${statusTone}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {statusText}
      </Typography.Text>
      <div className="topbar-actions">
        <div className="topbar-global-recovery" role="group" aria-label="全局状态与恢复">
          {/* Neutral, not green: this names a restriction, not a healthy state. */}
          {readOnly && <Tag color="default">{readOnlyReason === 'closed-job' ? '岗位已关闭' : '操作只读'}</Tag>}
          {screenshotTaskPresent && typeof onOpenScreenshotImportTask === 'function' && (
            <Button
              size="small"
              className="topbar-screenshot-task-open"
              onClick={onOpenScreenshotImportTask}
            >
              {screenshotImportActive
                ? '查看截图进度'
                : screenshotIssueCount
                  ? `截图问题项（${screenshotIssueCount}）`
                  : '截图任务'}
            </Button>
          )}
          <Button
            size="small"
            className="topbar-refresh-local"
            icon={<ReloadOutlined aria-hidden="true" />}
            loading={localRefreshBusy}
            disabled={localRefreshBusy || typeof onRefreshLocal !== 'function'}
            onClick={onRefreshLocal}
          >
            {localRefreshBusy ? '刷新中…' : '刷新本地数据'}
          </Button>
        </div>
      </div>
    </div>
  );
}
