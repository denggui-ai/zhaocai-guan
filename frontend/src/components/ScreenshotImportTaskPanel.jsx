import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Progress,
  Space,
  Tag,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import {
  normalizeScreenshotImportTask,
  screenshotImportTaskIssueCount,
} from '../screenshot-import-task.mjs';

const { Text, Title } = Typography;

const STATUS_META = {
  idle: { label: '暂无任务', color: 'default' },
  running: { label: '识别中', color: 'processing' },
  done: { label: '本批次已完成', color: 'success' },
  error: { label: '任务失败', color: 'error' },
};

const ERROR_CODE_LABELS = {
  SCREENSHOT_AI_READ_FAILED: '外部 AI 没有完成这张截图的识别',
  SCREENSHOT_AI_INTERRUPTED: '应用退出时这张截图仍未识别完成',
  SCREENSHOT_AI_UNRECOGNIZED: '没有识别为候选人详情页',
  SCREENSHOT_SOURCE_CHANGED: '截图内容已变化，请重新导入并授权',
  PROVIDER_NETWORK_ERROR: '外部 AI 网络请求失败',
  PROVIDER_TIMEOUT: '外部 AI 请求超时',
  PROVIDER_RATE_LIMITED: '外部 AI 请求受限',
  SCREENSHOT_UNRECOGNIZED: '没有识别为候选人详情页',
  SCREENSHOT_NAME_MISSING: '详情页未识别到姓名',
  SCREENSHOT_OCR_FAILED: '本地 OCR 识别失败',
};

function issueReason(item) {
  const code = String(item.error_code || '').trim();
  if (code && ERROR_CODE_LABELS[code]) return `${ERROR_CODE_LABELS[code]}（${code}）`;
  return item.reason || code || (item.kind === 'failed' ? '识别调用失败' : '没有识别为候选人详情页');
}

function taskStatusDescription(task) {
  if (task.status === 'running') {
    if (task.progress.total > 0) {
      const remaining = task.counts.processingPending > 0
        ? `，${task.counts.processingPending} 张仍在处理`
        : '';
      return `已处理 ${task.progress.done}/${task.progress.total} 张截图${remaining}`;
    }
    return task.message || '正在准备截图识别任务';
  }
  if (task.status === 'error') return task.error || task.message || '截图导入未完成，请查看失败项后重试。';
  if (task.status === 'done') {
    const issueCount = screenshotImportTaskIssueCount(task);
    const draftText = task.counts.drafts > 0 ? `，形成 ${task.counts.drafts} 个候选人草稿` : '';
    return issueCount
      ? `本批次已完成${draftText}，仍有 ${issueCount} 张截图需要处理。`
      : `本批次已完成${draftText}；当前待校对数量以下方读取结果为准。`;
  }
  return '导入截图后，可在这里查看整批进度和问题项。';
}

function Metric({ label, value, tone = '' }) {
  return (
    <div className={`screenshot-task-metric ${tone ? `is-${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function IssueList({
  kind,
  title,
  description,
  items,
  expectedCount,
  selectedIds,
  retryBusy,
  onToggle,
  onRetry,
}) {
  return (
    <section className="screenshot-task-issue-section" aria-labelledby={`screenshot-task-${kind}-heading`}>
      <div className="screenshot-task-section-heading">
        <div>
          <h3 id={`screenshot-task-${kind}-heading`}>{title} <span>{expectedCount}</span></h3>
          <p>{description}</p>
        </div>
      </div>
      {expectedCount > 0 && items.length === 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`${title}有 ${expectedCount} 项，但任务详情暂未返回清单`}
          description="请刷新任务；清单恢复前不会猜测或重试未知截图。"
        />
      ) : items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`没有${title}`} />
      ) : (
        <ul className="screenshot-task-issue-list">
          {items.map((item) => (
            <li key={`${item.kind}:${item.id || item.fileName}`}>
              <Checkbox
                checked={selectedIds.includes(item.id)}
                disabled={!item.retryable || retryBusy}
                aria-label={`选择重试${item.fileName}`}
                onChange={(event) => onToggle(item.id, event.target.checked)}
              />
              <div className="screenshot-task-issue-copy">
                <strong>{item.fileName}</strong>
                <Text type="secondary">{issueReason(item)}</Text>
                <Space size={6} wrap>
                  {item.id && <Text code>{item.id}</Text>}
                  {Number(item.attempts) > 0 && <Tag>{`已尝试 ${Number(item.attempts)} 次`}</Tag>}
                  {!item.retryable && <Tag color="default">不可重试</Tag>}
                </Space>
              </div>
              <Button
                size="small"
                disabled={!item.retryable || retryBusy || typeof onRetry !== 'function'}
                onClick={() => onRetry([item.id])}
              >
                重试此项
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function ScreenshotImportTaskPanel({
  open,
  task: taskInput,
  loadState = 'idle',
  loadError = '',
  retryBusy = false,
  pendingReviewState = null,
  onClose,
  onRefresh,
  onRetry,
  onOpenReview,
}) {
  const task = useMemo(() => normalizeScreenshotImportTask(taskInput), [taskInput]);
  const [selectedIds, setSelectedIds] = useState([]);
  const retryableItems = useMemo(
    () => [...task.items.unrecognized, ...task.items.failed].filter((item) => item.retryable),
    [task.items.failed, task.items.unrecognized],
  );
  const retryableIds = useMemo(() => [...new Set(retryableItems.map((item) => item.id).filter(Boolean))], [retryableItems]);
  const allRetryableSelected = retryableIds.length > 0 && retryableIds.every((id) => selectedIds.includes(id));
  const authoritativePendingReview = pendingReviewState?.status === 'ready'
    && Number.isFinite(pendingReviewState.count)
    ? pendingReviewState.count
    : null;
  // Import-time counts describe staging, not the current review queue.
  const pendingReviewCount = authoritativePendingReview;
  const pendingReviewKnown = authoritativePendingReview !== null;
  const issueCount = screenshotImportTaskIssueCount(task);
  const statusMeta = task.status === 'done' && issueCount > 0
    ? { label: '已完成，有问题项', color: 'warning' }
    : STATUS_META[task.status] || { label: task.raw_status || '状态未知', color: 'default' };
  const progressStatus = task.status === 'error'
    ? 'exception'
    : task.status === 'done' && issueCount === 0
      ? 'success'
      : task.status === 'running'
        ? 'active'
        : 'normal';

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => retryableIds.includes(id)));
  }, [task.task_id, task.updated_at, retryableIds.join('|')]);

  function toggleItem(id, checked) {
    if (!id) return;
    setSelectedIds((current) => checked
      ? [...new Set([...current, id])]
      : current.filter((item) => item !== id));
  }

  function toggleAll() {
    setSelectedIds(allRetryableSelected ? [] : retryableIds);
  }

  async function retry(ids) {
    const safeIds = [...new Set((ids || []).filter(Boolean))];
    if (!safeIds.length || retryBusy) return;
    const completed = await onRetry?.(safeIds);
    if (completed !== false) setSelectedIds((current) => current.filter((id) => !safeIds.includes(id)));
  }

  return (
    <Drawer
      className="screenshot-import-task-drawer"
      title="截图导入任务中心"
      width="min(720px, 100vw)"
      open={open}
      onClose={onClose}
      destroyOnHidden
      extra={(
        <Button
          icon={<ReloadOutlined aria-hidden="true" />}
          loading={loadState === 'loading'}
          disabled={typeof onRefresh !== 'function'}
          onClick={onRefresh}
        >
          刷新任务
        </Button>
      )}
    >
      <div className="screenshot-import-task-panel" aria-busy={loadState === 'loading' || retryBusy}>
        {loadError && (
          <Alert
            type={taskInput ? 'warning' : 'error'}
            showIcon
            message={taskInput ? '任务刷新失败，当前显示上次成功数据' : '截图任务读取失败'}
            description={loadError}
            action={<Button loading={loadState === 'loading'} onClick={onRefresh}>重试读取</Button>}
          />
        )}

        <section className="screenshot-task-overview" aria-labelledby="screenshot-task-overview-heading">
          <div className="screenshot-task-title-row">
            <div>
              <Title id="screenshot-task-overview-heading" level={4}>最新截图识别任务</Title>
              <Text type="secondary">{task.source_dir_name || task.job_name || '本地截图导入'}</Text>
            </div>
            <Tag color={statusMeta.color}>{statusMeta.label}</Tag>
          </div>
          <Text>{taskStatusDescription(task)}</Text>
          <Progress
            className="screenshot-task-progress"
            percent={task.progress.percent}
            status={progressStatus}
            aria-label={`截图识别进度 ${task.progress.percent}%`}
            format={() => task.progress.total > 0
              ? `${task.progress.done}/${task.progress.total}`
              : `${task.progress.percent}%`}
          />
          {task.task_id && <Text className="screenshot-task-run-id" type="secondary">任务编号：{task.task_id}</Text>}
        </section>

        <section className="screenshot-task-metrics" aria-label="截图导入结果计数">
          <Metric label="输入截图" value={task.counts.input} />
          <Metric label="识别成功截图" value={task.counts.recognized} tone="success" />
          <Metric label="候选人待校对" value={pendingReviewKnown ? pendingReviewCount : '—'} tone="pending" />
          <Metric label="未识别" value={task.counts.unrecognized} tone={task.counts.unrecognized ? 'warning' : ''} />
          <Metric label="失败" value={task.counts.failed} tone={task.counts.failed ? 'error' : ''} />
          <Metric label="跳过列表页" value={task.counts.skipped} />
        </section>

        {pendingReviewState?.status === 'error' && task.status === 'done' && (
          <Alert
            type="warning"
            showIcon
            message="待校对数量暂未读取成功"
            description="截图识别结果已保留；可刷新任务，或直接打开校对草稿重试读取。"
            action={<Button onClick={onOpenReview}>打开待校对草稿</Button>}
          />
        )}

        {pendingReviewCount > 0 && (
          <Alert
            type="info"
            showIcon
            message={`${pendingReviewCount} 条识别结果等待人工校对`}
            description="校对确认前不会写入正式候选人；校对完成前请保留原截图文件夹，不要移动或删除截图。"
            action={<Button type="primary" disabled={typeof onOpenReview !== 'function'} onClick={onOpenReview}>打开待校对草稿</Button>}
          />
        )}

        <IssueList
          kind="unrecognized"
          title="未识别截图"
          description="没有形成候选人草稿，可核对原截图后单独重试。"
          items={task.items.unrecognized}
          expectedCount={task.counts.unrecognized}
          selectedIds={selectedIds}
          retryBusy={retryBusy}
          onToggle={toggleItem}
          onRetry={retry}
        />
        <IssueList
          kind="failed"
          title="识别失败截图"
          description="识别调用或本地处理失败，不影响本批次其他截图。"
          items={task.items.failed}
          expectedCount={task.counts.failed}
          selectedIds={selectedIds}
          retryBusy={retryBusy}
          onToggle={toggleItem}
          onRetry={retry}
        />

        {retryableIds.length > 0 && (
          <div className="screenshot-task-retry-bar" role="group" aria-label="截图问题项批量重试">
            <Button disabled={retryBusy || typeof onRetry !== 'function'} onClick={toggleAll}>
              {allRetryableSelected ? '取消全选' : `全选可重试项（${retryableIds.length}）`}
            </Button>
            <Button
              type="primary"
              loading={retryBusy}
              disabled={!selectedIds.length || typeof onRetry !== 'function'}
              onClick={() => retry(selectedIds)}
            >
              {`重试所选（${selectedIds.length}）`}
            </Button>
          </div>
        )}
      </div>
    </Drawer>
  );
}
