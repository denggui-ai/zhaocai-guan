import React from 'react';
import { Alert, Button, Card, Skeleton, Space, Tag, Typography } from 'antd';
import {
  BulbOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CompassOutlined,
  ReloadOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import PageHeader from './PageHeader.jsx';

const { Paragraph, Text, Title } = Typography;

const AI_CAPABILITY_DEFS = [
  {
    key: 'jd',
    title: 'AI 优化 JD',
    summary: '把岗位要求整理成可编辑的 JD 草稿，并标出信息缺口和合规提醒。',
    location: '职位管理 → 管理 JD/画像 → AI 优化成 JD 草稿',
    output: 'JD 草稿、待补信息、合规提醒',
    nav: '职位管理',
    action: '打开职位管理',
  },
  {
    key: 'profile',
    title: '深度岗位画像',
    summary: '把用人经理访谈整理为招聘画像，区分明确要求、AI 推断和待追问项。',
    location: '职位管理 → 管理 JD/画像 → 查看深度画像',
    output: '岗位画像草稿、推断依据、追问清单',
    nav: '职位管理',
    action: '生成深度画像',
  },
  {
    key: 'candidate',
    title: '候选人 AI 初评',
    summary: '对照当前岗位和候选人简历，给出有证据的第二意见，不自动评级或淘汰。',
    location: '候选人 → 选择一人 → 资料评估 → AI 初评',
    output: '匹配 / 不匹配 / 未知证据、雷达、面试追问',
    nav: '候选人',
    action: '打开候选人',
  },
  {
    key: 'assessment',
    title: '测评综合分析',
    summary: '联合岗位、简历、已确认测评和面试材料，整理优势、风险与矛盾点。',
    location: '候选人 → 选择一人 → 测评报告 → AI 测评综合分析',
    output: '优势、风险、矛盾点、补充验证问题',
    nav: '候选人',
    action: '打开候选人',
  },
  {
    key: 'interview',
    title: '面试 AI 复盘',
    summary: '基于已归属的面试材料生成复盘草稿和关键事实，确认后才进入正式报告。',
    location: '面试安排 → 打开候选人 → 面试 → 生成 AI 草稿',
    output: '复盘草稿、关键事实、待确认项',
    nav: '面试安排',
    action: '打开面试安排',
  },
];

const STEP_DEFS = [
  {
    key: 'job',
    title: '建立招聘岗位',
    summary: '先明确这次招聘是谁负责、计划招几人。',
    location: '职位管理 → 新建岗位',
    completion: '岗位出现在台账，并成为顶部当前岗位。',
    attention: '岗位之间的候选人、JD 和画像彼此隔离。',
    nav: '职位管理',
    action: '打开职位管理',
  },
  {
    key: 'profile',
    title: '启用 JD 并确认画像',
    summary: '把岗位要求写清楚，作为筛选和面试的统一依据。',
    location: '职位管理 → 管理 JD/画像',
    completion: '存在启用中的 JD 和已确认岗位画像。',
    attention: 'AI 可以辅助起草，但启用 JD、确认画像都由 HR 完成。',
    nav: '职位管理',
    action: '打开职位管理',
  },
  {
    key: 'source',
    title: '导入候选人',
    summary: '按来源选择上传简历建档或导入 Boss App 截图。',
    location: '候选人 → 上传简历建档；候选人 → 候选人操作 → 导入 Boss App 截图',
    completion: '上传简历经 HR 校对确认后进入候选人列表；截图草稿也须 HR 确认后才入库。',
    attention: '截图先生成 OCR 待人工校对草稿，顶部显示待校对数量；草稿可能属于专用截图岗位，系统不会自动切换当前岗位。',
    nav: '候选人',
    action: '打开候选人',
  },
  {
    key: 'screen',
    title: '筛选并人工处置',
    summary: '逐人看简历、档位和证据，决定继续、暂缓或结束本轮关系。',
    location: '候选人 → 选择一人 → 资料评估 / 人工处置',
    completion: '每位待处理候选人都有 HR 明确的下一步。',
    attention: 'S/A/B/C 来自确定性规则或 HR 人工评级；AI 不自动评级，也不改变排序或替 HR 作决定。',
    nav: '候选人',
    action: '打开候选人',
  },
  {
    key: 'interview',
    title: '安排面试并复盘',
    summary: '由 HR 记录时间、地点或会议链接及候选人确认状态，面试后再核对事实。',
    location: '面试安排 → 创建/排期；候选人详情 → 面试 → 复盘/确认',
    completion: '排期信息、面试轮次状态、报告和待确认事实在页面上保持一致。',
    attention: '邀约话术只是可编辑草稿，不会自动发送；取消、爽约和下一轮都会保留历史。',
    nav: '面试安排',
    action: '打开面试安排',
  },
  {
    key: 'decision',
    title: '完成 HR 决定',
    summary: '根据招聘事实作出继续、暂缓、淘汰、人才库、主动放弃或录用决定。',
    location: '候选人详情 → HR 人工处置',
    completion: '候选人当前状态、工作台队列和历史记录一致。',
    attention: '关闭岗位不会删除候选人或历史；AI 永远只提供草稿。',
    nav: '候选人',
    action: '打开候选人',
  },
];

const INTERVIEW_TODO_CODES = new Set([
  'material_classification_required',
  'material_assignment_required',
  'schedule_confirmation_required',
  'interview_preparation_required',
  'report_draft_required',
  'report_fact_review_required',
  'report_confirmation_required',
]);

const DECISION_TODO_CODES = new Set([
  'final_review_required',
  'final_disposition_confirmation_required',
]);

function candidateCount(candidates, workbench) {
  if (Array.isArray(candidates)) return candidates.length;
  return Number(workbench?.metrics?.candidate_count || 0);
}

export function resolveWorkflowGuideAuthority({
  jobsLoadState = 'ready',
  loadState = 'ready',
  job,
  workbench,
} = {}) {
  const jobsAuthority = jobsLoadState === 'error' && job ? 'stale' : jobsLoadState;
  const workbenchAuthority = loadState === 'error' && workbench ? 'stale' : loadState;
  const states = job ? [jobsAuthority, workbenchAuthority] : [jobsAuthority];
  if (states.includes('error')) return 'error';
  if (states.includes('loading')) return 'loading';
  if (states.includes('stale')) return 'stale';
  return 'ready';
}

export function deriveWorkflowGuide({ jobs = [], job, candidates = [], workbench } = {}) {
  const todos = Array.isArray(workbench?.todos) ? workbench.todos : [];
  const todoCodes = new Set(todos.map((item) => item.code));
  const count = candidateCount(candidates, workbench);
  const missingJobSetup = todoCodes.has('job_jd_required') || todoCodes.has('job_profile_confirmation_required');
  const hasInterviewTodo = todos.some((item) => INTERVIEW_TODO_CODES.has(item.code));
  const hasDecisionTodo = todos.some((item) => DECISION_TODO_CODES.has(item.code));

  let currentIndex = 0;
  if (job) {
    if (missingJobSetup) currentIndex = 1;
    else if (!count) currentIndex = 2;
    else if (hasDecisionTodo) currentIndex = 5;
    else if (hasInterviewTodo) currentIndex = 4;
    else currentIndex = 3;
  }

  const steps = STEP_DEFS.map((step, index) => ({
    ...step,
    number: index + 1,
    state: index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'waiting',
  }));

  return {
    currentIndex,
    current: steps[currentIndex],
    steps,
    candidateCount: count,
    jobCount: Array.isArray(jobs) ? jobs.length : 0,
  };
}

function StateTag({ state, stale = false }) {
  if (state === 'done') return <Tag color="success" icon={<CheckCircleOutlined />}>已走过</Tag>;
  if (state === 'current') return <Tag color={stale ? 'warning' : 'processing'} icon={<ClockCircleOutlined />}>{stale ? '旧数据建议' : '当前建议'}</Tag>;
  return <Tag>后续步骤</Tag>;
}

function findAiCapability(key) {
  return AI_CAPABILITY_DEFS.find((item) => item.key === key) || AI_CAPABILITY_DEFS[0];
}

export function deriveAiValueSuggestion({ job, candidates = [], workbench } = {}) {
  const todoCodes = new Set((workbench?.todos || []).map((item) => item.code));
  if (!job || todoCodes.has('job_jd_required')) return findAiCapability('jd');
  if (todoCodes.has('job_profile_confirmation_required') || !candidateCount(candidates, workbench)) return findAiCapability('profile');
  if ([...todoCodes].some((code) => INTERVIEW_TODO_CODES.has(code))) return findAiCapability('interview');
  return findAiCapability('candidate');
}

function openAiCapability(item, props) {
  if (item.key === 'profile' && props.onOpenDeepProfile) {
    props.onOpenDeepProfile();
    return;
  }
  props.onOpenNav?.(item.nav);
}

export function AiValueSummary(props) {
  const authorityState = props.authorityState || 'ready';
  const suggestionUnavailable = authorityState === 'loading' || authorityState === 'error';
  const stale = authorityState === 'stale';
  const showAction = props.showAction !== false;
  const current = suggestionUnavailable ? null : deriveAiValueSuggestion(props);
  return (
    <section className="ai-value-summary" aria-label="AI 招聘助手" data-guide-authority={authorityState}>
      <div className="ai-value-summary-head">
        <div>
          <Text className="ai-value-kicker"><BulbOutlined />系统亮点 · AI 招聘助手</Text>
          <Title level={4}>AI 不替你做决定，而是提供有证据的第二意见</Title>
          <Paragraph>它把分散的岗位、简历、测评和面试材料整理成草稿、风险和追问，最终由 HR 修改并确认。</Paragraph>
        </div>
        <Button onClick={() => props.onOpenNav?.('使用指南')}>查看 5 项 AI 能力</Button>
      </div>
      {current ? (
        <div className="ai-value-current">
          <div>
            <Space size={6} wrap><Tag color={stale ? 'warning' : 'cyan'}>{stale ? '上次数据建议' : '当前推荐'}</Tag><Tag>AI 辅助</Tag><Tag color="green">HR 确认</Tag></Space>
            <strong>{current.title}</strong>
            <p><b>在哪里用：</b>{current.location}</p>
            <p><b>你会得到：</b>{current.output}</p>
          </div>
          {showAction && <Button type="primary" onClick={() => openAiCapability(current, props)}>{current.action}<RightOutlined /></Button>}
        </div>
      ) : (
        <Alert
          type={authorityState === 'error' ? 'warning' : 'info'}
          showIcon
          message={authorityState === 'error' ? '读取失败，暂不推荐 AI 能力' : '正在读取招聘状态'}
          description="权威状态可用后再显示与当前岗位相关的建议；这里不会把未知状态推断成确定步骤。"
        />
      )}
      <div className="ai-value-chips" aria-label="五项 AI 能力">
        {AI_CAPABILITY_DEFS.map((item) => <span key={item.key}>{item.title}</span>)}
      </div>
    </section>
  );
}

function AiCapabilityGuide(props) {
  return (
    <section className="ai-capability-guide" aria-label="系统 AI 能力指南">
      <div className="ai-capability-head">
        <div>
          <Text className="ai-value-kicker"><BulbOutlined />系统亮点</Text>
          <Title level={3}>AI 在招聘流程中如何帮助你</Title>
          <Paragraph>每项能力都告诉你入口和产出。AI 负责整理与提示，HR 负责核对事实、修改草稿并作最终决定。</Paragraph>
        </div>
        <Space wrap><Tag color="cyan">AI 辅助</Tag><Tag color="green">HR 确认</Tag></Space>
      </div>
      <div className="ai-capability-grid">
        {AI_CAPABILITY_DEFS.map((item, index) => (
          <Card size="small" key={item.key} className="ai-capability-card" title={<span><i>{index + 1}</i>{item.title}</span>}>
            <p>{item.summary}</p>
            <dl>
              <div><dt>在哪里用</dt><dd>{item.location}</dd></div>
              <div><dt>你会得到</dt><dd>{item.output}</dd></div>
            </dl>
            <Button onClick={() => openAiCapability(item, props)}>{item.action}<RightOutlined /></Button>
          </Card>
        ))}
      </div>
      <Alert
        type="info"
        showIcon
        message="判断边界：AI 建议不等于招聘结论"
        description="S/A/B/C、HC 统计和人才库反查不是 AI 自动决策；自动打招呼、自动约面、自动淘汰和自动录用也不在 AI 权限内。"
      />
    </section>
  );
}

export function WorkflowGuideSummary(props) {
  const authorityState = props.authorityState || 'ready';
  if (authorityState === 'loading' || authorityState === 'error') {
    return (
      <section className="workflow-guide-summary" aria-label="HR 使用流程" data-guide-authority={authorityState}>
        <div className="workflow-guide-summary-head">
          <div>
            <Text className="workflow-guide-kicker">HR 招聘工作流</Text>
            <Title level={4}>等待招聘状态读取完成</Title>
            <Paragraph>当前状态尚未确认，因此暂不推断下一步。</Paragraph>
          </div>
        </div>
        {authorityState === 'loading' ? (
          <Skeleton active title={{ width: '38%' }} paragraph={{ rows: 2, width: ['88%', '62%'] }} />
        ) : (
          <Alert type="warning" showIcon message="招聘状态读取失败" description="请先重试读取；错误不会被当作空岗位或已完成流程。" />
        )}
      </section>
    );
  }
  const guide = deriveWorkflowGuide(props);
  const current = guide.current;
  const stale = authorityState === 'stale';
  const showAction = props.showAction !== false;
  return (
    <section className="workflow-guide-summary" aria-label="HR 使用流程" data-guide-authority={authorityState}>
      <div className="workflow-guide-summary-head">
        <div>
          <Text className="workflow-guide-kicker">第一次使用，从这里开始</Text>
          <Title level={4}>HR 招聘工作流</Title>
          <Paragraph>先建岗位，再导入候选人；系统提供证据和草稿，所有推进、淘汰和录用决定都由 HR 完成。</Paragraph>
        </div>
        <Button icon={<CompassOutlined />} onClick={() => props.onOpenNav?.('使用指南')}>查看完整指南</Button>
      </div>
      <div className="workflow-guide-rail">
        {guide.steps.map((step) => (
          <div className={`workflow-guide-rail-step ${step.state}`} key={step.key}>
            <span>{step.state === 'done' ? <CheckCircleOutlined /> : step.number}</span>
            <strong>{step.title}</strong>
          </div>
        ))}
      </div>
      <div className="workflow-guide-next">
        <div>
          <Text>{stale ? '上次成功数据建议' : '当前建议'} · 第 {current.number} 步</Text>
          <strong>{current.title}</strong>
          <p>{current.summary}</p>
        </div>
        {showAction && <Button type="primary" onClick={() => props.onOpenNav?.(current.nav)}>
          {current.action}<RightOutlined />
        </Button>}
      </div>
    </section>
  );
}

export default function WorkflowGuidePanel(props) {
  const authorityState = resolveWorkflowGuideAuthority(props);
  const retryAction = props.onRetry ? (
    <Button icon={<ReloadOutlined />} onClick={props.onRetry}>重新读取</Button>
  ) : null;

  if (authorityState === 'loading' || authorityState === 'error') {
    return (
      <section className="workflow-guide-page" data-guide-authority={authorityState}>
        <PageHeader
          className="workflow-guide-hero"
          kicker="招才官使用指南"
          title="从建岗到录用，按这 6 步操作"
          description="指南会读取当前岗位与工作台状态后再给出下一步。"
        />
        {authorityState === 'loading' ? (
          <div role="status" aria-live="polite" aria-label="正在读取使用指南状态">
            <Text type="secondary">正在读取招聘状态；完成前不会推断当前步骤。</Text>
            <Skeleton active title={{ width: '34%' }} paragraph={{ rows: 5, width: ['92%', '86%', '90%', '76%', '68%'] }} />
          </div>
        ) : (
          <Alert
            role="alert"
            type="error"
            showIcon
            message="使用指南所需状态读取失败"
            description={`${props.jobsLoadError || props.loadError || '当前无法确认岗位与工作台状态。'} 错误不会被当作空数据，也不会据此推断下一步。`}
            action={retryAction}
          />
        )}
      </section>
    );
  }

  const guide = deriveWorkflowGuide(props);
  const current = guide.current;
  const stale = authorityState === 'stale';
  return (
    <section className="workflow-guide-page" data-guide-authority={authorityState}>
      <PageHeader
        className="workflow-guide-hero"
        kicker="招才官使用指南"
        title="从建岗到录用，按这 6 步操作"
        description="这不是系统配置手册，而是 HR 每天真正使用的招聘路径。你可以从当前建议开始，也可以随时跳到对应模块。"
        actions={(
          <Space wrap>
            {props.job ? <Tag color="cyan">当前岗位：{props.job.name}</Tag> : <Tag color="gold">尚未建立岗位</Tag>}
            <Tag>{guide.candidateCount} 名候选人</Tag>
            {stale && <Tag color="orange">旧内容</Tag>}
          </Space>
        )}
      />

      {stale && (
        <Alert
          type="warning"
          showIcon
          message="当前显示上次成功读取的指南内容"
          description={props.jobsLoadError || props.loadError || '最新状态尚未读取成功；下方步骤仅供继续查看。'}
          action={retryAction}
        />
      )}

      <Alert
        type={stale ? 'warning' : 'info'}
        showIcon
        icon={<CompassOutlined />}
        message={`${stale ? '上次数据建议' : '现在建议'}：第 ${current.number} 步 · ${current.title}`}
        description={current.summary}
        action={<Button type="primary" onClick={() => props.onOpenNav?.(current.nav)}>{current.action}</Button>}
      />

      <AiCapabilityGuide {...props} />

      <div className="workflow-guide-grid">
        {guide.steps.map((step) => (
          <Card
            size="small"
            key={step.key}
            className={`workflow-guide-step-card ${step.state}`}
            title={<span><i>{step.number}</i>{step.title}</span>}
            extra={<StateTag state={step.state} stale={stale} />}
          >
            <p className="workflow-guide-step-summary">{step.summary}</p>
            <dl>
              <div><dt>在哪里做</dt><dd>{step.location}</dd></div>
              <div><dt>完成信号</dt><dd>{step.completion}</dd></div>
              <div><dt>注意</dt><dd>{step.attention}</dd></div>
            </dl>
            <Button onClick={() => props.onOpenNav?.(step.nav)}>{step.action}<RightOutlined /></Button>
          </Card>
        ))}
      </div>

      <div className="workflow-guide-daily">
        <Card size="small" title="每天打开系统后怎么做">
          <ol>
            <li><strong>核对顶部当前岗位</strong><span>系统会记住上次岗位，但操作前仍要核对；候选人、面试和画像都以它为上下文。</span></li>
            <li><strong>先看工作台待办</strong><span>待沟通、待排期、待复盘和失败重试都从工作台进入。</span></li>
            <li><strong>逐人完成明确动作</strong><span>没有业务事实时不要为了清空待办制造淘汰、录用或爽约。</span></li>
            <li><strong>结束前再看一次队列</strong><span>确认候选人详情、工作台数量和面试状态没有互相矛盾。</span></li>
          </ol>
        </Card>
        <Card size="small" title="系统会做什么 / 不会做什么">
          <div className="workflow-guide-boundary">
            <p><CheckCircleOutlined />保存岗位、候选人关系、面试和人工操作历史。</p>
            <p><CheckCircleOutlined />S/A/B/C 来自确定性规则或 HR 人工评级，AI 只辅助写草稿。</p>
            <p><SafetyCertificateOutlined />不会自动打招呼、自动约面、自动淘汰或自动录用。</p>
            <p><SafetyCertificateOutlined />关闭岗位也不会删除历史。</p>
          </div>
        </Card>
      </div>
    </section>
  );
}
