import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Collapse, Empty, Progress, Radio, Skeleton, Space, Tag, Typography } from 'antd';
import {
  CalendarOutlined,
  CheckCircleOutlined,
  DatabaseOutlined,
  FileDoneOutlined,
  MessageOutlined,
  ReloadOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { AiValueSummary, WorkflowGuideSummary } from './WorkflowGuidePanel.jsx';
import { resolveWorkflowGuideAuthority } from './WorkflowGuidePanel.jsx';
import '../workbench-v2.css';

const { Text, Title } = Typography;
const TODO_PREVIEW_LIMIT = 3;
const DASHBOARD_GUIDANCE_CLASS_NAMES = {
  header: 'dashboard-guidance-header',
  body: 'dashboard-guidance-body',
};
const TODO_LABELS = {
  job_jd_required: '补齐并激活 JD',
  job_profile_confirmation_required: '确认岗位画像',
  candidate_rating_required: '候选人待评级',
  contact_required: '候选人待沟通',
  communication_followup_required: '沟通事实待跟进',
  resume_followup_required: '跟进候选人简历',
  candidate_screening_required: '候选人待本地筛选',
  assessment_report_required: '补充候选人测评报告',
  assessment_review_required: '核对测评报告信息',
  assessment_binding_confirmation_required: '确认测评报告归属',
  material_classification_required: '面试材料待分类',
  material_assignment_required: '面试材料待归属',
  schedule_confirmation_required: '人工确认面试时间',
  interview_preparation_required: '准备面试脚本',
  report_draft_required: '生成面试报告草稿',
  report_fact_review_required: '复核报告关键事实',
  report_confirmation_required: '人工确认面试报告',
  final_review_required: 'HR 人工处置',
  final_disposition_confirmation_required: '确认人工处置结果',
  candidate_next_action_due: '候选人下一步即将到期',
  candidate_next_action_overdue: '候选人下一步已逾期',
  offer_send_followup_required: '准备发送 Offer',
  offer_response_followup_required: '跟进 Offer 回复',
  offer_negotiation_followup_required: '跟进 Offer 协商',
  onboarding_handoff_required: '完成入职交接',
  legacy_status_review_required: '复核历史状态',
  task_failed_retryable: '检查最近失败任务',
};
const TODO_DESCRIPTIONS = {
  job_jd_required: '当前岗位还没有启用中的 JD。',
  job_profile_confirmation_required: '当前岗位还没有确认的招聘画像。',
  candidate_rating_required: '有候选人需要完成规则评级。',
  contact_required: '有候选人等待 HR 沟通。',
  communication_followup_required: 'HR 已记录联系或回复事实，请人工继续跟进；不会自动发送消息。',
  resume_followup_required: '有候选人等待简历跟进。',
  candidate_screening_required: '候选人需要在本地资料流程中继续核对、补充材料或完成规则筛选。',
  assessment_report_required: '岗位画像要求或建议补充测评；请由 HR 导入报告，不会自动联系候选人。',
  assessment_review_required: '已有测评 PDF 等待 HR 核对报告类型、姓名或解析异常。',
  assessment_binding_confirmation_required: '报告信息已就绪，等待 HR 人工确认与当前候选人、岗位的绑定。',
  material_classification_required: '有面试材料需要判断用途。',
  material_assignment_required: '有面试材料需要关联候选人和面试轮次。',
  schedule_confirmation_required: '有面试等待人工确认时间。',
  interview_preparation_required: '已排期面试尚未准备面试脚本。',
  report_draft_required: '面试结束后尚未生成报告草稿。',
  report_fact_review_required: '报告草稿有关键事实待复核。',
  report_confirmation_required: '报告草稿等待 HR 人工确认。',
  final_review_required: '现有材料已齐，等待 HR 人工决定下一步。',
  final_disposition_confirmation_required: '等待 HR 明确并确认本次人工处置。',
  candidate_next_action_due: 'HR 已记录的候选人下一步将在三天内到期。',
  candidate_next_action_overdue: 'HR 已记录的候选人下一步已过期，请人工处理或调整日期。',
  offer_send_followup_required: '终评已确认继续流程，等待 HR 人工准备并发送 Offer。',
  offer_response_followup_required: 'Offer 已发出，等待 HR 人工跟进候选人回复。',
  offer_negotiation_followup_required: 'Offer 正在协商，等待 HR 人工记录最新结论。',
  onboarding_handoff_required: '候选人已接受 Offer，等待 HR 完成入职交接。',
  legacy_status_review_required: '有候选人的历史状态需要人工确认。',
  task_failed_retryable: '最近一次相关任务失败，请进入对应模块查看原因和可用处理方式。',
};
const TODO_ACTION_LABELS = {
  job_jd_required: '完善 JD',
  job_profile_confirmation_required: '确认画像',
  candidate_rating_required: '去评级',
  contact_required: '记录沟通',
  communication_followup_required: '继续跟进',
  resume_followup_required: '跟进简历',
  candidate_screening_required: '去筛选',
  assessment_report_required: '打开测评',
  assessment_review_required: '核对报告',
  assessment_binding_confirmation_required: '确认归属',
  material_classification_required: '分类材料',
  material_assignment_required: '关联候选人',
  schedule_confirmation_required: '确认时间',
  interview_preparation_required: '准备脚本',
  report_draft_required: '生成草稿',
  report_fact_review_required: '复核事实',
  report_confirmation_required: '确认报告',
  final_review_required: '人工处置',
  final_disposition_confirmation_required: '确认处置',
  candidate_next_action_due: '查看下一步',
  candidate_next_action_overdue: '立即跟进',
  offer_send_followup_required: '跟进 Offer',
  offer_response_followup_required: '查看 Offer',
  offer_negotiation_followup_required: '继续协商',
  onboarding_handoff_required: '入职交接',
  legacy_status_review_required: '复核状态',
  task_failed_retryable: '查看处理方式',
};

// `lens: true` marks a filter that spans the whole list rather than owning a
// slice of it. 需关注 is a severity predicate that deliberately overlaps the
// code-based groups below, so the per-filter counts do not sum to 全部 — the
// chip row is separated visually so it does not read as a partition.
const TODO_FILTER_DEFINITIONS = [
  { key: 'all', label: '全部', lens: true, matches: () => true },
  {
    key: 'attention',
    label: '需关注',
    lens: true,
    matches: (item) => item?.blocking === true || item?.priority === 'high' || item?.code === 'task_failed_retryable',
  },
  { key: 'rating', label: '评级', matches: (item) => item?.code === 'candidate_rating_required' },
  {
    key: 'followup',
    label: '沟通与资料',
    matches: (item) => [
      'contact_required',
      'communication_followup_required',
      'resume_followup_required',
      'candidate_screening_required',
      'candidate_next_action_due',
      'candidate_next_action_overdue',
      'offer_send_followup_required',
      'offer_response_followup_required',
      'offer_negotiation_followup_required',
      'onboarding_handoff_required',
      'material_classification_required',
      'material_assignment_required',
    ].includes(item?.code),
  },
  {
    key: 'interview',
    label: '测评、面试与报告',
    matches: (item) => [
      'assessment_report_required',
      'assessment_review_required',
      'assessment_binding_confirmation_required',
      'schedule_confirmation_required',
      'interview_preparation_required',
      'report_draft_required',
      'report_fact_review_required',
      'report_confirmation_required',
    ].includes(item?.code),
  },
];

function navForTodo(code) {
  if (code.startsWith('job_')) return '职位管理';
  if (code.startsWith('assessment_')) return '候选人';
  if (code.includes('schedule') || code.includes('interview_') || code.includes('report_') || code.includes('material_')) return '面试安排';
  return '候选人';
}

function todoContextLabel(item, candidateNames, job) {
  if (item?.candidate_id != null) {
    const candidateName = candidateNames.get(String(item.candidate_id));
    return `候选人：${candidateName || `记录 ${item.candidate_id}`}`;
  }
  if (String(item?.code || '').startsWith('job_')) {
    return `岗位：${job?.name || `岗位 ${item?.job_id || '--'}`}`;
  }
  if (String(item?.code || '').startsWith('material_')) {
    return `面试材料：待办 ${item?.todo_id || '--'}`;
  }
  if (item?.code === 'task_failed_retryable') {
    return `失败任务：待办 ${item?.todo_id || '--'}`;
  }
  return `岗位：${job?.name || `岗位 ${item?.job_id || '--'}`}`;
}

function todoVisualState(item) {
  if (item?.code === 'task_failed_retryable') return { className: 'failed', label: '任务失败', color: 'red' };
  if (item?.blocking === true) return { className: 'attention', label: '阻塞流程', color: 'orange' };
  if (item?.priority === 'high') return { className: 'attention', label: '高优先级', color: 'gold' };
  return { className: 'normal', label: '', color: '' };
}

function DashboardLoadingSkeleton({ label }) {
  return (
    <div className="dashboard-loading-skeleton" role="status" aria-live="polite" aria-label={label}>
      <Text type="secondary">{label}；完成前不会把错误或未返回数据当作空工作台。</Text>
      <div className="dashboard-loading-skeleton-grid" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <div className="dashboard-loading-skeleton-card" key={index}>
            <Skeleton active title={{ width: index === 1 ? '46%' : '58%' }} paragraph={{ rows: 2, width: ['92%', '68%'] }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DashboardPanel({
  jobs,
  job,
  jobId,
  candidates,
  workbench,
  jobsLoadState = 'ready',
  jobsLoadError = '',
  loadState = 'idle',
  loadError = '',
  readOnly = false,
  onRetryJobs,
  onRetry,
  onOpenNav,
  onOpenTodo,
  onOpenDeepProfile,
  screenshotImportActive = false,
  onUploadResume,
  onImportScreenshots,
}) {
  const [todoFilter, setTodoFilter] = useState('all');
  const [todosExpanded, setTodosExpanded] = useState(false);
  const fixture = workbench?.data_class === 'fixture';
  const metrics = workbench?.metrics || {};
  const total = Number(metrics.candidate_count || 0);
  const rated = Number(metrics.rated_count || 0);
  const counts = metrics.workflow_counts || {};
  const todos = workbench ? (workbench.todos || []) : [];
  const todoCandidates = Array.isArray(workbench?.candidates) && workbench.candidates.length
    ? workbench.candidates
    : candidates;
  const candidateNames = new Map((todoCandidates || []).map((candidate) => [
    String(candidate.internal_id),
    candidate.name || candidate.geek_name || '',
  ]));
  const todoFilterOptions = TODO_FILTER_DEFINITIONS
    .map((definition) => ({
      ...definition,
      count: todos.filter(definition.matches).length,
    }))
    .filter((definition) => definition.key === 'all' || definition.count > 0);
  const firstTodoTypeFilterIndex = todoFilterOptions.findIndex((option) => !option.lens);
  const activeTodoFilter = todoFilterOptions.some((option) => option.key === todoFilter)
    ? todoFilter
    : 'all';
  const activeTodoFilterDefinition = TODO_FILTER_DEFINITIONS
    .find((definition) => definition.key === activeTodoFilter) || TODO_FILTER_DEFINITIONS[0];
  const filteredTodos = todos.filter(activeTodoFilterDefinition.matches);
  const visibleTodos = todosExpanded ? filteredTodos : filteredTodos.slice(0, TODO_PREVIEW_LIMIT);
  const hiddenTodoCount = Math.max(0, filteredTodos.length - visibleTodos.length);
  const scheduled = Number(counts.interview_scheduled || 0) + Number(counts.interview_in_progress || 0);
  const reports = Number(counts.report_pending_confirmation || 0) + Number(counts.report_confirmed || 0);
  const readOnlyMessage = job?.status === 'closed'
    ? '岗位已关闭，仅查看历史'
    : '当前为只读模式，仅查看历史';
  const guideAuthorityState = resolveWorkflowGuideAuthority({ jobsLoadState, loadState, job, workbench });
  const guideProps = {
    jobs,
    job,
    candidates,
    workbench,
    authorityState: guideAuthorityState,
    onOpenNav,
    onOpenDeepProfile,
  };
  const secondaryGuideProps = { ...guideProps, showAction: false };
  const metricItems = [
    {
      key: 'candidate',
      label: '正式候选人',
      value: total,
      hint: '当前岗位',
      icon: <TeamOutlined aria-hidden="true" />,
    },
    {
      key: 'rating',
      label: '评级覆盖',
      value: `${rated}/${total}`,
      hint: `${total ? Math.round(rated * 100 / total) : 0}% 已完成`,
      icon: <CheckCircleOutlined aria-hidden="true" />,
      progress: total ? Math.round(rated * 100 / total) : 0,
    },
    {
      key: 'contact',
      label: '待沟通',
      value: Number(counts.contact_pending || 0),
      hint: '需要人工跟进',
      icon: <MessageOutlined aria-hidden="true" />,
    },
    {
      key: 'schedule',
      label: '待确认时间',
      value: Number(counts.interview_pending_schedule || 0),
      hint: '面试时间待定',
      icon: <CalendarOutlined aria-hidden="true" />,
    },
    {
      key: 'interview',
      label: '面试进行中',
      value: scheduled,
      hint: '已排期或面试中',
      icon: <CalendarOutlined aria-hidden="true" />,
    },
    {
      key: 'report',
      label: '面试报告',
      value: reports,
      hint: '处理中或已确认',
      icon: <FileDoneOutlined aria-hidden="true" />,
    },
  ];

  useEffect(() => {
    setTodoFilter('all');
    setTodosExpanded(false);
  }, [jobId]);

  if (!jobId && jobsLoadState === 'loading') {
    return (
      <section className="dashboard-panel dashboard-v2 dashboard-v2-state">
        <DashboardLoadingSkeleton label="正在读取岗位" />
        <Collapse
          className="dashboard-secondary-guidance"
          size="small"
          items={[{
            key: 'ai-guide',
            classNames: DASHBOARD_GUIDANCE_CLASS_NAMES,
            label: 'AI 招聘助手说明',
            children: <AiValueSummary {...guideProps} />,
          }]}
        />
      </section>
    );
  }

  if (!jobId && jobsLoadState === 'error') {
    return (
      <section className="dashboard-panel dashboard-v2 dashboard-v2-state">
        <Alert
          type="error"
          showIcon
          message="岗位读取失败"
          description={jobsLoadError || '当前无法确认是否已有岗位；不会把读取失败当作首次使用。'}
          action={<Button icon={<ReloadOutlined />} onClick={onRetryJobs}>重试</Button>}
        />
        <Collapse
          className="dashboard-secondary-guidance"
          size="small"
          items={[{
            key: 'ai-guide',
            classNames: DASHBOARD_GUIDANCE_CLASS_NAMES,
            label: 'AI 招聘助手说明',
            children: <AiValueSummary {...guideProps} />,
          }]}
        />
      </section>
    );
  }

  if (!jobId || loadState === 'idle') {
    return (
      <section className="dashboard-panel dashboard-v2 dashboard-v2-state">
        <Alert type="success" showIcon message="本地工作台可用" description="先创建本地岗位；后续可上传简历、导入截图 OCR，并在同一套候选人流程中筛选和回填。" />
        <Card className="dashboard-card dashboard-first-job-card">
          <Empty
            className="dashboard-todo-empty"
            description="先建立一个岗位，工作台才会显示这个岗位的候选人和待办。"
          >
            <Button type="primary" onClick={() => onOpenNav('职位管理')}>去新建岗位</Button>
          </Empty>
        </Card>
        <WorkflowGuideSummary {...guideProps} showAction={false} />
        <Collapse
          className="dashboard-secondary-guidance"
          size="small"
          items={[{
            key: 'ai-guide',
            classNames: DASHBOARD_GUIDANCE_CLASS_NAMES,
            label: '可选：了解 5 项 AI 辅助能力',
            children: <AiValueSummary {...secondaryGuideProps} />,
          }]}
        />
      </section>
    );
  }

  if (loadState === 'loading' && !workbench) {
    return (
      <section className="dashboard-panel dashboard-v2 dashboard-v2-state">
        <DashboardLoadingSkeleton label="正在加载工作台" />
        <Collapse
          className="dashboard-secondary-guidance"
          size="small"
          items={[{
            key: 'ai-guide',
            classNames: DASHBOARD_GUIDANCE_CLASS_NAMES,
            label: 'AI 招聘助手说明',
            children: <AiValueSummary {...guideProps} />,
          }]}
        />
      </section>
    );
  }

  if (loadState === 'error' && !workbench) {
    return (
      <section className="dashboard-panel dashboard-v2 dashboard-v2-state">
        <Alert type="error" showIcon message="工作台读取失败" description={loadError} action={<Button icon={<ReloadOutlined />} onClick={onRetry}>重试</Button>} />
        <Collapse
          className="dashboard-secondary-guidance"
          size="small"
          items={[{
            key: 'ai-guide',
            classNames: DASHBOARD_GUIDANCE_CLASS_NAMES,
            label: 'AI 招聘助手说明',
            children: <AiValueSummary {...guideProps} />,
          }]}
        />
      </section>
    );
  }

  if (!workbench) {
    return (
      <section className="dashboard-panel dashboard-v2 dashboard-v2-state">
        <Empty description="暂无工作台数据" />
        <Collapse
          className="dashboard-secondary-guidance"
          size="small"
          items={[{
            key: 'ai-guide',
            classNames: DASHBOARD_GUIDANCE_CLASS_NAMES,
            label: 'AI 招聘助手说明',
            children: <AiValueSummary {...guideProps} />,
          }]}
        />
      </section>
    );
  }

  return (
    <section className="dashboard-panel dashboard-v2">
      <div className="dashboard-head">
        <div className="dashboard-heading-copy">
          <div className="dashboard-heading-line">
            <Title className="dashboard-page-title" level={2}>{job?.name || `岗位 ${jobId}`}</Title>
            {fixture && <Tag className="dashboard-fixture-tag">测试数据</Tag>}
            {loadState === 'stale' && <Tag color="orange">旧数据 · 可重试</Tag>}
          </div>
          <div className="dashboard-heading-meta">
            <strong>当前岗位</strong>
            <span aria-hidden="true">/</span>
            <Text className="dashboard-heading-status">{todos.length ? `${todos.length} 项待办等待处理` : '当前没有待处理事项'}</Text>
          </div>
        </div>
        <div className="dashboard-head-actions">
          <Button className="dashboard-head-action dashboard-head-primary-action" type="primary" onClick={() => onOpenNav('候选人')}>候选人队列</Button>
          <Button className="dashboard-head-action" aria-label="刷新工作台" title="仅重新读取当前工作台" icon={<ReloadOutlined aria-hidden="true" />} onClick={onRetry}>刷新工作台</Button>
        </div>
      </div>
      {fixture && (
        <div className="dashboard-context-note" role="note">
          <span aria-hidden="true">i</span>
          <div><strong>当前为隔离测试岗位</strong><small>不计入正式指标、人才库、时间线和待办。</small></div>
        </div>
      )}
      {readOnly && <Alert type="info" showIcon message={readOnlyMessage} />}
      {loadState === 'stale' && (
        <Alert
          type="warning"
          showIcon
          message="刷新失败，当前展示上次成功数据"
          description={loadError}
          action={<Button icon={<ReloadOutlined />} onClick={onRetry}>重试</Button>}
        />
      )}
      <div className={`dashboard-v2-focus-grid ${todos.length ? 'has-todos' : 'is-clear'}`}>
        <section className="dashboard-progress-section dashboard-v2-summary" aria-labelledby="dashboard-progress-heading">
          <div className="dashboard-section-heading dashboard-progress-heading">
            <div>
              <h3 id="dashboard-progress-heading">招聘进度</h3>
            </div>
            <Text className="dashboard-section-caption">本地正式数据</Text>
          </div>
          <div className="dashboard-metrics">
            {metricItems.map((item) => (
              <article
                className="dashboard-metric-item"
                data-metric={item.key}
                data-tier={item.key === 'candidate' || item.key === 'rating' ? 'primary' : 'secondary'}
                key={item.key}
              >
                <span className="dashboard-metric-icon">{item.icon}</span>
                <div className="dashboard-metric-copy">
                  <span className="dashboard-metric-label">{item.label}</span>
                  <strong>{item.value}</strong>
                  <small>{item.hint}</small>
                  {item.progress != null && (
                    <Progress
                      className="dashboard-rating-progress"
                      percent={item.progress}
                      showInfo={false}
                      size="small"
                      trailColor="var(--hb-v2-stroke-subtle)"
                    />
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
        <div className="dashboard-main-grid">
          <section className={`dashboard-card dashboard-todo-card ${todos.length ? '' : 'is-empty'}`} aria-labelledby="dashboard-todo-heading">
          <div className="dashboard-todo-section-head">
            <div>
              <h3 id="dashboard-todo-heading" className="dashboard-card-title">待办事项 <span>{todos.length}</span></h3>
            </div>
            <Text className="dashboard-section-caption">按流程阻塞程度与处理顺序排列</Text>
          </div>
          {todos.length ? (
            <>
              <div className="dashboard-todo-toolbar">
                <Radio.Group
                  className="dashboard-todo-filters"
                  value={activeTodoFilter}
                  size="small"
                  role="radiogroup"
                  aria-label="筛选待办事项"
                  onChange={(event) => {
                    setTodoFilter(event.target.value);
                    setTodosExpanded(false);
                  }}
                >
                  {todoFilterOptions.map((option, index) => (
                    <Radio.Button
                      className={`dashboard-todo-filter${option.lens ? ' dashboard-todo-filter-lens' : ''}${
                        index === firstTodoTypeFilterIndex ? ' dashboard-todo-filter-group-start' : ''}`}
                      key={option.key}
                      value={option.key}
                    >
                      {option.label}<span className="dashboard-todo-filter-count">{option.count}</span>
                    </Radio.Button>
                  ))}
                </Radio.Group>
                <Text className="dashboard-todo-result-status" role="status" aria-live="polite">
                  按处理顺序显示 {visibleTodos.length}/{filteredTodos.length} 条
                </Text>
              </div>
              <ul id="dashboard-todo-list" className="dashboard-todo-list" aria-labelledby="dashboard-todo-heading">
                {visibleTodos.map((item) => {
                  const contextLabel = todoContextLabel(item, candidateNames, job);
                  const actionLabel = TODO_ACTION_LABELS[item.code] || '查看详情';
                  const visualState = todoVisualState(item);
                  return (
                    <li
                      key={item.todo_id}
                      className={`dashboard-todo-row ${visualState.className}`}
                      data-todo-id={item.todo_id}
                      data-todo-code={item.code}
                    >
                      <div className="dashboard-todo-copy">
                        <div className="dashboard-todo-heading-line">
                          <strong>{TODO_LABELS[item.code] || '待处理事项'}</strong>
                          <span className="dashboard-todo-context">{contextLabel}</span>
                          {visualState.label ? <Tag color={visualState.color}>{visualState.label}</Tag> : null}
                        </div>
                        <p>{TODO_DESCRIPTIONS[item.code] || '请进入对应模块查看并完成处理。'}</p>
                      </div>
                      {!readOnly && <Button
                        className="dashboard-todo-action"
                        size="small"
                        aria-label={`${actionLabel}：${contextLabel}`}
                        onClick={() => (onOpenTodo
                          ? onOpenTodo(item, navForTodo(item.code))
                          : onOpenNav(navForTodo(item.code)))}
                      >{actionLabel}</Button>}
                    </li>
                  );
                })}
              </ul>
              {filteredTodos.length > TODO_PREVIEW_LIMIT ? (
                <div className="dashboard-todo-expand-row">
                  <Button
                    type="link"
                    size="small"
                    aria-expanded={todosExpanded}
                    aria-controls="dashboard-todo-list"
                    onClick={() => setTodosExpanded((expanded) => !expanded)}
                  >
                    {todosExpanded ? '收起待办' : `查看其余 ${hiddenTodoCount} 条`}
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="dashboard-todo-clear" role="status">
              <span className="dashboard-todo-clear-icon"><CheckCircleOutlined aria-hidden="true" /></span>
              <div>
                <strong>{fixture ? '测试岗位不生成正式待办' : '当前没有阻塞待办'}</strong>
                <p>{fixture ? '可继续浏览合成流程与页面状态。' : '优先队列已处理完；需要复核候选人时，从页面顶部进入候选人队列。'}</p>
              </div>
            </div>
          )}
          </section>
        </div>
      </div>
      <section className="dashboard-workflow-section dashboard-v2-workflow" aria-labelledby="dashboard-workflow-heading">
        <div className="dashboard-section-heading">
          <div>
            <h3 id="dashboard-workflow-heading">工作入口</h3>
          </div>
          <Text className="dashboard-section-caption">所有处置均以本地 SQLite 记录为准</Text>
        </div>
        <div className="dashboard-channel-grid dashboard-v2-channel-grid">
          <section className="dashboard-local-channel dashboard-primary-channel" aria-labelledby="dashboard-local-channel-heading">
            <div className="dashboard-channel-head">
              <span className="dashboard-channel-icon local"><DatabaseOutlined aria-hidden="true" /></span>
              <div>
                <h4 id="dashboard-local-channel-heading">{readOnly ? '本地资料可查看' : '招聘工作已就绪'}</h4>
                <p>建档、筛选、面试与人工处置都在本机完成。</p>
              </div>
              <Tag className="dashboard-channel-state-tag" color="green">可用</Tag>
            </div>
            <ol className="dashboard-flow-rail" aria-label="本地招聘主流程">
              <li><span>01</span><strong>候选人建档</strong></li>
              <li><span>02</span><strong>本地筛选</strong></li>
              <li><span>03</span><strong>面试与报告</strong></li>
              <li><span>04</span><strong>人工处置</strong></li>
            </ol>
            <div className="dashboard-local-actions" aria-label="本地招聘入口">
              <div className="dashboard-local-primary-actions">
                <Button className="dashboard-local-action" type="primary" disabled={readOnly || !jobId} onClick={onUploadResume}>上传简历建档</Button>
                <Button className="dashboard-local-action" disabled={readOnly || !jobId || screenshotImportActive} onClick={onImportScreenshots}>
                  {screenshotImportActive ? '截图识别中…' : '导入截图 OCR'}
                </Button>
              </div>
              <div className="dashboard-local-secondary-actions">
                <Button className="dashboard-local-action dashboard-local-text-action" type="text" onClick={() => onOpenNav('职位管理')}>管理岗位</Button>
                <Text className="dashboard-candidate-entry-note">
                  截图导入后，从页面顶部“截图任务”查看进度、待校对和问题项；筛选与沟通统一从页面顶部“候选人队列”进入。
                </Text>
              </div>
            </div>
          </section>
        </div>
      </section>
      <Collapse
        className="dashboard-secondary-guidance"
        size="small"
        items={[
          {
            key: 'workflow-guide',
            classNames: DASHBOARD_GUIDANCE_CLASS_NAMES,
            label: '使用流程与当前建议',
            children: <WorkflowGuideSummary {...secondaryGuideProps} />,
          },
          {
            key: 'ai-guide',
            classNames: DASHBOARD_GUIDANCE_CLASS_NAMES,
            label: 'AI 招聘助手说明',
            children: <AiValueSummary {...secondaryGuideProps} />,
          },
        ]}
      />
    </section>
  );
}
