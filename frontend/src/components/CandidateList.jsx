import React, { useMemo } from 'react';
import { Alert, Button, Dropdown, Input, Pagination, Select, Skeleton, Space, Spin, Tag } from 'antd';
import { MoreOutlined } from '@ant-design/icons';
import { clean, fmtTime, has, joinParts, parseSections, recLabel } from '../api.js';
import { SABC_COLOR } from '../theme.js';
import { candidateEducation, candidateSourceLabel, educationBucket } from '../candidate-utils.js';
import '../candidate-v2.css';

const EDUCATION_OPTIONS = [
  { value: '', label: '学历：全部' },
  { value: '985', label: '985' },
  { value: '211', label: '211' },
  { value: '重点学校', label: '重点学校' },
  { value: '普通本科', label: '普通本科' },
  { value: '专科院校', label: '专科院校' },
  { value: '其他', label: '其他' },
];
const PAGE_SIZE = 10;
const DEFAULT_QUEUE = 'mine';
const DEFAULT_RANKING_EXPLANATION = '默认排序仅按确定性 SABC 档位、入库时间和内部 ID。AI 测评匹配属于可选辅助材料；测评为可选辅助材料，缺失不降级，测评、AI 和面试分均不参与默认排序。';
// Keep the queue decision surface to three direct choices plus one stage menu.
// “全部待处理” is the aggregate view for every active, non-hold candidate.
// The remaining queues are stage filters, so their counts must not read like
// additional people on top of the aggregate total.
const PRIMARY_QUEUE_KEYS = new Set(['mine', 'interview', 'review']);
const QUEUE_DEFS = [
  { key: 'mine', label: '全部待处理' },
  { key: 'hold', label: '暂缓' },
  { key: 'new', label: '新推荐' },
  { key: 'contact', label: '待沟通' },
  { key: 'interview', label: '面试中' },
  { key: 'review', label: '待复盘/决策' },
  { key: 'archived', label: '已归档' },
];
const QUEUE_LABEL = QUEUE_DEFS.reduce((acc, item) => ({ ...acc, [item.key]: item.label }), {});
const ARCHIVED_WORKFLOWS = new Set(['rejected', 'talent_pool', 'hired', 'candidate_withdrew', 'do_not_contact']);
const REVIEW_WORKFLOWS = new Set(['interview_pending_review', 'report_pending_confirmation', 'report_confirmed']);
const INTERVIEW_WORKFLOWS = new Set(['interview_pending_schedule', 'interview_scheduled', 'interview_in_progress']);
const CONTACT_WORKFLOWS = new Set(['contact_pending', 'communicating', 'resume_pending']);
const NEW_WORKFLOWS = new Set(['new', 'screening', 'legacy_review_required']);
const WORKFLOW_STATUS_LABELS = Object.freeze({
  new: '新入库',
  screening: '初筛中',
  legacy_review_required: '历史状态待复核',
  contact_pending: '待沟通',
  communicating: '沟通中',
  resume_pending: '待补简历',
  interview_pending_schedule: '待确认面试时间',
  interview_scheduled: '已安排面试',
  interview_in_progress: '面试中',
  interview_pending_review: '待面试复盘',
  report_pending_confirmation: '报告待确认',
  report_confirmed: '报告已确认',
  under_review: '人工复核中',
  hold: '暂缓',
  rejected: '已淘汰',
  talent_pool: '已进入人才库',
  hired: '已录用',
  candidate_withdrew: '候选人已放弃',
  do_not_contact: '不再联系',
});

function workflowStatusLabel(value) {
  return WORKFLOW_STATUS_LABELS[clean(value)] || '待人工复核';
}

function candidateDispositionLabel(candidate) {
  if (candidate?.disposition_code === 'candidate_withdrew' || candidate?.disposition_status === '主动放弃') return '主动放弃';
  if (candidate?.disposition_code === 'do_not_contact' || candidate?.disposition_status === '不再联系') return '不再联系';
  const code = clean(candidate?.disposition_code || candidate?.disposition_status);
  const labels = {
    new: '新入库',
    under_review: '评估中',
    continue_process: '继续推进',
    hold: '暂缓',
    rejected: '淘汰',
    talent_pool: '人才库',
    hired: '已录用',
  };
  return labels[code] || clean(candidate?.disposition_status);
}

function optionSet(values, allLabel) {
  const uniq = [...new Set(values.filter(has))];
  return [{ value: '', label: allLabel }, ...uniq.map((v) => ({ value: v, label: v }))];
}

function highlight(text, query) {
  const source = clean(text);
  const needle = clean(query);
  if (!needle) return source;
  const lowerSource = source.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts = [];
  let cursor = 0;
  let index = lowerSource.indexOf(lowerNeedle);
  if (index === -1) return source;
  while (index !== -1) {
    if (index > cursor) parts.push(source.slice(cursor, index));
    parts.push(<mark key={`${index}-${needle}`}>{source.slice(index, index + needle.length)}</mark>);
    cursor = index + needle.length;
    index = lowerSource.indexOf(lowerNeedle, cursor);
  }
  if (cursor < source.length) parts.push(source.slice(cursor));
  return parts;
}

function SabcBadge({ value }) {
  const v = clean(value).toUpperCase();
  if (!v) {
    return (
      <Tag aria-label="SABC 未评估" className="candidate-sabc-badge candidate-sabc-unrated">
        SABC 未评估
      </Tag>
    );
  }
  const c = SABC_COLOR[v] || SABC_COLOR.D;
  return <Tag aria-label={`SABC 评级 ${v}`} className="candidate-sabc-badge" style={{ background: c.bg, color: c.fg, border: 'none', fontWeight: 600 }}>{v}</Tag>;
}

function statusText(c, includeSource = false) {
  const rows = [c.comm_status, c.disposition_status, c.verdict_label];
  if (includeSource) rows.push(c.source, recLabel(c.rec_position));
  return rows.map(clean).filter(Boolean).join(' ');
}

function hasPriorityTier(c) {
  const tier = clean(c.sabc).toUpperCase();
  return ['S', 'A', 'B'].includes(tier);
}

function tierRank(c) {
  const rank = { S: 0, A: 1, B: 2, C: 3, D: 4 };
  return rank[clean(c.sabc).toUpperCase()] ?? 5;
}

function compareTextDescending(left, right) {
  const leftText = clean(left);
  const rightText = clean(right);
  if (leftText === rightText) return 0;
  return leftText < rightText ? 1 : -1;
}

function compareCandidateDefaultPriority(left, right) {
  const tierDiff = tierRank(left) - tierRank(right);
  if (tierDiff !== 0) return tierDiff;
  const createdDiff = compareTextDescending(left?.created_at, right?.created_at);
  if (createdDiff !== 0) return createdDiff;
  return compareTextDescending(left?.internal_id, right?.internal_id);
}

function isArchivedCandidate(c) {
  return ARCHIVED_WORKFLOWS.has(c.workflow_status);
}

function isHoldCandidate(c) {
  return c.application_status === 'active' && c.application_disposition_action === 'hold';
}

function workQueueKey(c) {
  const status = c.workflow_status;
  if (isHoldCandidate(c)) return 'hold';
  if (ARCHIVED_WORKFLOWS.has(status)) return 'archived';
  if (REVIEW_WORKFLOWS.has(status)) return 'review';
  if (INTERVIEW_WORKFLOWS.has(status)) return 'interview';
  if (CONTACT_WORKFLOWS.has(status)) return 'contact';
  if (NEW_WORKFLOWS.has(status)) return 'new';
  return 'mine';
}

function matchesQueue(c, queue) {
  if (queue === DEFAULT_QUEUE) return !['archived', 'hold'].includes(workQueueKey(c));
  return workQueueKey(c) === queue;
}

function nextAction(c, queueKey) {
  if (queueKey === 'hold') return '等待 HR 重新推进或转入明确终态';
  if (queueKey === 'archived') return '保持结构化终态，必要时人工复核';
  if (c.workflow_status === 'report_confirmed') return '报告已确认，待 HR 完成最终决策';
  if (c.workflow_status === 'report_pending_confirmation') return '复核事实并人工确认报告';
  if (queueKey === 'review') return '补齐结构化报告与人工确认';
  if (c.workflow_status === 'interview_pending_schedule') return '人工明确并确认面试时间';
  if (queueKey === 'interview') return '按面试轮次状态推进';
  if (c.workflow_status === 'resume_pending') return '人工跟进简历';
  if (c.communication_code === 'resume_received' || c.comm_status === '已收到简历') return '核对新简历并继续本地筛选';
  if (c.workflow_status === 'screening') return '核对现有材料并继续本地筛选';
  if (c.communication_code === 'replied' || c.comm_status === '已回复') return '人工继续跟进，必要时请求简历';
  if (c.communication_code === 'greeted' || c.comm_status === '已打招呼') return '等待或记录候选人回复';
  if (queueKey === 'contact') return '人工更新沟通状态';
  if (c.workflow_status === 'legacy_review_required') return '人工映射历史状态';
  if (queueKey === 'new') {
    if (hasPriorityTier(c)) return '人工确认是否沟通';
    if (has(c.sabc)) return '人工复核评级与材料，决定是否继续';
    return '先完成规则 SABC 评级；测评仅供参考';
  }
  return '打开详情补全判断或更新状态';
}

// Next-step strings that carry no candidate-specific signal: the blanket text
// for the contact queue and the final fallback. Repeated down every row they
// only cost scanning effort, so the row hides them. The accessible label and
// the truth meta still spell them out in full.
const GENERIC_NEXT_ACTIONS = new Set(['人工更新沟通状态', '打开详情补全判断或更新状态']);

function candidateWorkMeta(c) {
  const queueKey = workQueueKey(c);
  const queueLabel = QUEUE_LABEL[queueKey] || QUEUE_LABEL[DEFAULT_QUEUE];
  const workflowLabel = workflowStatusLabel(c.workflow_status);
  const primaryStatus = candidateDispositionLabel(c) || '新入库';
  const nextActionText = nextAction(c, queueKey);
  return {
    queueKey,
    queueLabel,
    workflowLabel,
    primaryStatus,
    // '新入库' means no HR disposition has been made yet. Compare the resolved
    // label, not the raw value: candidateDispositionLabel maps an explicit
    // disposition_code of 'new' to the same words, and both cases carry the
    // same (absent) signal.
    primaryStatusIsDefault: primaryStatus === '新入库',
    context: joinParts([queueLabel, workflowLabel]),
    nextAction: nextActionText,
    nextActionIsDefault: GENERIC_NEXT_ACTIONS.has(nextActionText),
  };
}

function parsedSections(c) {
  return parseSections(c) || {};
}

function skillTags(c) {
  const s = parsedSections(c);
  const source = [
    clean(c.geek_desc),
    ...(Array.isArray(s.skill) ? s.skill.map((item) => clean(item.text)) : []),
  ].join(' ');
  const known = ['Java', 'Spring Boot', 'Redis', 'MySQL', 'Kafka', 'RocketMQ', 'OMS', 'WMS', 'ERP', 'AI Infra', '团队管理'];
  return known.filter((tag) => new RegExp(tag.replace(/\s+/g, '\\s*'), 'i').test(source)).slice(0, 3);
}

function tagList(c) {
  const edu = candidateEducation(c);
  const rows = [
    c.source === '截图导入' ? '截图导入' : '',
    c.source === 'fixture' ? '测试数据' : '',
    edu.school_tier,
    educationBucket(c),
    ...skillTags(c),
    c.verdict_label,
    c.comm_status,
  ];
  return [...new Set(rows.map(clean).filter(Boolean))].slice(0, 5);
}

function initialQueueCounts() {
  return QUEUE_DEFS.reduce((acc, item) => ({ ...acc, [item.key]: 0 }), {});
}

function countPopulatedQueueCategories(options) {
  return options.filter((item) => item.count > 0).length;
}

function EmptyState({ title, description, actions }) {
  return (
    <div className="candidate-empty-state">
      <div className="candidate-empty-title">{title}</div>
      <div className="candidate-empty-desc">{description}</div>
      {actions && actions.length > 0 && (
        <Space size={8} wrap className="candidate-empty-actions">
          {actions}
        </Space>
      )}
    </div>
  );
}

function CandidateLoadErrorDescription({ message, technicalDetails }) {
  const [detailsExpanded, setDetailsExpanded] = React.useState(false);
  React.useEffect(() => {
    setDetailsExpanded(false);
  }, [message, technicalDetails]);
  return (
    <div className="candidate-load-error-description">
      <span>{message}</span>
      {technicalDetails && (
        <>
          <Button
            type="link"
            size="small"
            className="candidate-load-error-detail-trigger"
            aria-expanded={detailsExpanded}
            aria-controls="candidate-load-error-technical"
            onClick={() => setDetailsExpanded((current) => !current)}
          >
            {detailsExpanded ? '收起详情' : '查看详情'}
          </Button>
          {detailsExpanded && (
            <code id="candidate-load-error-technical" className="candidate-load-error-technical">
              {technicalDetails}
            </code>
          )}
        </>
      )}
    </div>
  );
}

function CandidateListSkeleton() {
  return (
    <div className="candidate-list-skeleton" role="status" aria-live="polite" aria-label="正在读取候选人">
      <div className="candidate-list-skeleton-copy">
        <strong>正在读取候选人</strong>
        <span>读取完成前不会把当前岗位判断为没有候选人。</span>
      </div>
      {[0, 1, 2, 3].map((index) => (
        <div className="candidate-list-skeleton-row" key={index} aria-hidden="true">
          <Skeleton active title={{ width: index % 2 ? '46%' : '58%' }} paragraph={{ rows: 1, width: '88%' }} />
        </div>
      ))}
    </div>
  );
}

function shortCandidateId(value) {
  const id = clean(value);
  if (!id) return '';
  const segments = id.split('-').filter(Boolean);
  if (segments.length >= 3) return segments.slice(-2).join('-');
  if (id.length > 12) return id.slice(-8);
  return id;
}

function candidateStableReference(candidate) {
  const explicitReference = clean(candidate?.candidate_ref);
  if (explicitReference) {
    return {
      visible: `候选人编号 ${explicitReference}`,
      full: `候选人编号：${explicitReference}`,
    };
  }
  const internalId = clean(candidate?.candidate_id || candidate?.internal_id);
  if (internalId) {
    return {
      visible: `候选人编号 ${shortCandidateId(internalId)}`,
      full: `内部候选人 ID：${internalId}`,
    };
  }
  const school = clean(candidateEducation(candidate || {}).school);
  if (school) {
    return {
      visible: `学校 ${school}`,
      full: `学校：${school}`,
    };
  }
  return {
    visible: '身份信息待补全',
    full: '暂无可用候选人编号或学校信息',
  };
}

function CandidateCard({ candidate, selectedId, onSelect, tabIndex, cardRef, onMoveFocus, onRovingFocus }) {
  const c = candidate;
  const active = c.internal_id === selectedId;
  const work = candidateWorkMeta(c);
  const fullName = clean(c.name) || '未命名候选人';
  const stableReference = candidateStableReference(c);
  const sourceLabel = candidateSourceLabel(c);
  const updatedLabel = fmtTime(c.updated_at || c.created_at);
  const ratingLabel = clean(c.sabc).toUpperCase() || '未评估';
  const truthMeta = `姓名：${fullName}；${stableReference.full}；队列：${work.queueLabel}；流程阶段：${work.workflowLabel}；来源：${sourceLabel}；资料更新：${updatedLabel}`;
  const accessibleLabel = `${fullName}，${stableReference.full}，SABC ${ratingLabel}，当前处置：${work.primaryStatus}，下一步：${work.nextAction}。队列：${work.queueLabel}；流程阶段：${work.workflowLabel}；来源：${sourceLabel}；资料更新：${updatedLabel}`;
  function handleKeyDown(event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(c.internal_id);
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      onMoveFocus(c.internal_id, event.key);
    }
  }
  return (
    <article
      ref={cardRef}
      className={`candidate-card candidate-v2-row candidate-card-${work.queueKey} ${active ? 'active' : ''}`}
      role="option"
      tabIndex={tabIndex}
      aria-selected={active}
      aria-label={accessibleLabel}
      title={truthMeta}
      onClick={() => onSelect(c.internal_id)}
      onFocus={() => onRovingFocus(c.internal_id)}
      onKeyDown={handleKeyDown}
    >
      <header className="candidate-card-head candidate-row-head">
        <div className="candidate-card-main candidate-row-main">
          <div className="candidate-title-stack candidate-row-title">
            <div className="candidate-row-identity">
              <span className="candidate-name" title={`完整姓名：${fullName}`}>{fullName}</span>
              <SabcBadge value={c.sabc} />
            </div>
            <div className="candidate-row-disambiguator" title={stableReference.full}>
              {stableReference.visible}
            </div>
          </div>
        </div>
        {!work.primaryStatusIsDefault && (
          <div
            className={`candidate-row-state candidate-row-state-${work.queueKey}`}
            title={work.context}
          >
            <span className="candidate-row-queue">{work.primaryStatus}</span>
          </div>
        )}
      </header>
      {!work.nextActionIsDefault && (
        <div className="candidate-workline candidate-row-work">
          <span className="candidate-next-action candidate-row-next" title={`下一步：${work.nextAction}`}>
            <span className="candidate-next-label">下一步</span>
            <span>{work.nextAction}</span>
          </span>
        </div>
      )}
    </article>
  );
}

export default function CandidateList({
  candidates,
  loadState = 'ready',
  loadError = '',
  loadErrorDetails = '',
  onRetry,
  selectedId,
  onSelect,
  onSelectionInvalidated,
  query,
  onQueryChange,
  comm,
  onCommChange,
  disp,
  onDispChange,
  sabc,
  onSabcChange,
  education,
  onEducationChange,
  summaryText,
}) {
  const commOptions = useMemo(() => optionSet(candidates.map((c) => c.comm_status), '沟通状态：全部'), [candidates]);
  const dispOptions = useMemo(() => optionSet(candidates.map((c) => c.disposition_status), '处置状态：全部'), [candidates]);
  const tagOptions = useMemo(() => optionSet(candidates.flatMap(tagList), '标签：全部'), [candidates]);
  const [activeQueue, setActiveQueue] = React.useState(DEFAULT_QUEUE);
  const [tag, setTag] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [rovingCandidateId, setRovingCandidateId] = React.useState(null);
  const candidateCardRefs = React.useRef(new Map());
  const selectionRestorePendingRef = React.useRef(false);
  const countsUnavailable = loadState === 'error' && candidates.length === 0;

  const sabcCoverage = useMemo(() => {
    const rated = candidates.filter((candidate) => has(candidate.sabc)).length;
    return { rated, unrated: Math.max(0, candidates.length - rated) };
  }, [candidates]);

  React.useEffect(() => {
    setPage(1);
  }, [candidates.length, activeQueue, query, comm, disp, sabc, education, tag]);

  const sortedCandidates = useMemo(
    () => [...candidates].sort(compareCandidateDefaultPriority),
    [candidates]
  );

  const queueCounts = useMemo(() => {
    return candidates.reduce((acc, c) => {
      const key = workQueueKey(c);
      if (!['archived', 'hold'].includes(key)) acc.mine = (acc.mine || 0) + 1;
      if (key !== DEFAULT_QUEUE) acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, initialQueueCounts());
  }, [candidates]);

  const queueOptions = useMemo(
    () => QUEUE_DEFS.map((item) => ({
      ...item,
      count: queueCounts[item.key] || 0,
    })),
    [queueCounts]
  );

  const queueCandidates = useMemo(
    () => sortedCandidates.filter((c) => matchesQueue(c, activeQueue)),
    [sortedCandidates, activeQueue]
  );

  const filtered = useMemo(() => {
    const q = clean(query).toLowerCase();
    return queueCandidates.filter((c) => {
      const edu = candidateEducation(c);
      const text = [
        c.name,
        c.candidate_ref,
        c.candidate_id,
        c.internal_id,
        c.job_name,
        c.source,
        c.geek_desc,
        edu.school,
        edu.degree,
        c.comm_status,
        c.disposition_status,
        c.verdict_label,
        recLabel(c.rec_position),
      ].map(clean).join(' ').toLowerCase();
      const matchSabc = !sabc || (sabc === '__none' ? !has(c.sabc) : clean(c.sabc).toUpperCase() === sabc);
      const matchEducation = !education || educationBucket(c) === education;
      const matchTag = !tag || tagList(c).includes(tag);
      return (!q || text.includes(q)) && (!comm || c.comm_status === comm) && (!disp || c.disposition_status === disp) && matchSabc && matchEducation && matchTag;
    });
  }, [queueCandidates, query, comm, disp, sabc, education, tag]);
  const selectedCandidate = candidates.find((candidate) => candidate.internal_id === selectedId) || null;
  const selectedExists = Boolean(selectedCandidate);
  const selectedVisible = !selectedId || filtered.some((candidate) => candidate.internal_id === selectedId);
  const selectionFilteredOut = Boolean(selectedId && !selectedVisible && selectedExists);

  React.useEffect(() => {
    if (selectedId && !selectedExists) onSelectionInvalidated?.();
  }, [selectedId, selectedExists, onSelectionInvalidated]);

  React.useEffect(() => {
    if (!selectionRestorePendingRef.current || !selectedId) return;
    const selectedIndex = filtered.findIndex((candidate) => candidate.internal_id === selectedId);
    if (selectedIndex < 0) return;
    selectionRestorePendingRef.current = false;
    setPage(Math.floor(selectedIndex / PAGE_SIZE) + 1);
  }, [filtered, selectedId]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page]
  );
  const selectedPagedCandidate = paged.find((candidate) => candidate.internal_id === selectedId);
  const rovingPagedCandidate = paged.find((candidate) => candidate.internal_id === rovingCandidateId);
  const tabStopCandidateId = selectedPagedCandidate?.internal_id
    ?? rovingPagedCandidate?.internal_id
    ?? paged[0]?.internal_id
    ?? null;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const activeQueueLabel = QUEUE_LABEL[activeQueue] || QUEUE_LABEL[DEFAULT_QUEUE];
  const hasFilters = has(query) || has(comm) || has(disp) || has(sabc) || has(education) || has(tag);
  const advancedFilterCount = [comm, disp, sabc, education, tag].filter(has).length;
  const showAdvancedFilters = filtersOpen;
  const sabcUnavailable = candidates.length > 0 && sabcCoverage.rated === 0;
  const sabcCoverageIncomplete = sabcCoverage.rated > 0 && sabcCoverage.unrated > 0;
  const primaryQueueOptions = queueOptions.filter((item) => PRIMARY_QUEUE_KEYS.has(item.key));
  const overflowQueueOptions = queueOptions.filter((item) => !PRIMARY_QUEUE_KEYS.has(item.key));
  const overflowQueueActive = overflowQueueOptions.some((item) => item.key === activeQueue);
  const overflowQueueCategoryCount = countPopulatedQueueCategories(overflowQueueOptions);
  const activeOverflowQueueCount = overflowQueueOptions.find((item) => item.key === activeQueue)?.count || 0;
  const overflowQueueAccessibleLabel = countsUnavailable
    ? `${overflowQueueActive ? activeQueueLabel : '其他阶段'}，数量未知`
    : overflowQueueActive
      ? `${activeQueueLabel}，${activeOverflowQueueCount} 人`
      : `其他阶段，${overflowQueueCategoryCount} 个阶段有候选人`;
  const coverageSummary = sabcUnavailable
    ? `评级 0/${candidates.length} · 暂不可筛选`
    : sabcCoverageIncomplete
      ? `评级 ${sabcCoverage.rated}/${candidates.length} · ${sabcCoverage.unrated} 人未评估`
      : `评级 ${sabcCoverage.rated}/${candidates.length}`;
  const coverageExplanation = sabcUnavailable
    ? `SABC 暂不可筛选：${candidates.length} 人均未评估，空结果不代表无人合格。`
    : sabcCoverageIncomplete
      ? `SABC 覆盖 ${sabcCoverage.rated}/${candidates.length}；${sabcCoverage.unrated} 人未评估，不进入评级筛选。`
      : `SABC 已覆盖 ${sabcCoverage.rated}/${candidates.length}。`;

  React.useEffect(() => {
    if (!paged.length) {
      setRovingCandidateId(null);
      return;
    }
    setRovingCandidateId((current) => {
      if (selectedPagedCandidate) return selectedPagedCandidate.internal_id;
      if (paged.some((candidate) => candidate.internal_id === current)) return current;
      return paged[0].internal_id;
    });
  }, [page, selectedId, selectedPagedCandidate, paged]);

  function rememberCandidateRef(id, node) {
    if (node) candidateCardRefs.current.set(id, node);
    else candidateCardRefs.current.delete(id);
  }

  function handleCandidateSelect(id) {
    setRovingCandidateId(id);
    onSelect(id);
  }

  function handleCandidateMoveFocus(id, key) {
    const currentIndex = paged.findIndex((candidate) => candidate.internal_id === id);
    if (currentIndex < 0) return;
    let nextIndex = currentIndex;
    if (key === 'ArrowDown') nextIndex = Math.min(paged.length - 1, currentIndex + 1);
    if (key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1);
    if (key === 'Home') nextIndex = 0;
    if (key === 'End') nextIndex = paged.length - 1;
    const nextId = paged[nextIndex]?.internal_id;
    if (nextId == null) return;
    setRovingCandidateId(nextId);
    window.requestAnimationFrame(() => candidateCardRefs.current.get(nextId)?.focus());
  }

  function handleClearFilters() {
    onQueryChange('');
    onCommChange('');
    onDispChange('');
    onEducationChange('');
    if (onSabcChange) onSabcChange('');
    setTag('');
    setPage(1);
  }

  function handleBackToDefaultQueue() {
    setActiveQueue(DEFAULT_QUEUE);
    setPage(1);
  }

  function handleRevealSelectedCandidate() {
    if (!selectedCandidate) return;
    const selectedQueue = workQueueKey(selectedCandidate);
    selectionRestorePendingRef.current = true;
    setActiveQueue(['hold', 'archived'].includes(selectedQueue) ? selectedQueue : DEFAULT_QUEUE);
    handleClearFilters();
  }

  let emptyState = null;
  if (candidates.length === 0 && loadState === 'loading') {
    emptyState = <CandidateListSkeleton />;
  } else if (candidates.length === 0 && loadState === 'error') {
    emptyState = (
      <EmptyState
        title="候选人读取失败"
        description={(
          <CandidateLoadErrorDescription
            message={loadError || '当前无法确认候选人列表；请重试，错误不会被当作空数据。'}
            technicalDetails={loadErrorDetails}
          />
        )}
        actions={[<Button key="retry" size="small" type="primary" onClick={onRetry}>重新读取</Button>]}
      />
    );
  } else if (candidates.length === 0) {
    emptyState = (
      <EmptyState
        title="暂无候选人"
        description="优先使用上方“上传简历建档”；也可导入截图 OCR。"
        actions={[]}
      />
    );
  } else if (queueCandidates.length === 0) {
    const actions = [];
    if (activeQueue !== DEFAULT_QUEUE) {
      actions.push(<Button key="back" size="small" onClick={handleBackToDefaultQueue}>回到全部待处理</Button>);
    }
    if (hasFilters) {
      actions.push(<Button key="clear" size="small" onClick={handleClearFilters}>清空筛选</Button>);
    }
    emptyState = (
      <EmptyState
        title={`${activeQueueLabel}暂无候选人`}
        description={activeQueue === DEFAULT_QUEUE ? '当前没有需要立即处理的人选。' : '这个队列暂时没有命中的候选人。'}
        actions={actions}
      />
    );
  } else if (filtered.length === 0) {
    const actions = [<Button key="clear" size="small" type="primary" onClick={handleClearFilters}>清空筛选</Button>];
    if (activeQueue !== DEFAULT_QUEUE) {
      actions.push(<Button key="back" size="small" onClick={handleBackToDefaultQueue}>回到全部待处理</Button>);
    }
    emptyState = (
      <EmptyState
        title={has(sabc) && sabcUnavailable ? 'SABC 筛选暂无可用数据' : '筛选后没有结果'}
        description={has(sabc) && sabcUnavailable
          ? `当前列表 ${candidates.length} 人均未评估；空结果不代表无人合格，请清除评级筛选或先完成规则评级。`
          : has(sabc) && sabcCoverageIncomplete
            ? `当前 SABC 筛选只覆盖 ${sabcCoverage.rated} 名已评估候选人，另有 ${sabcCoverage.unrated} 人未评估；空结果不代表其不合格。`
            : `${activeQueueLabel}队列有 ${queueCandidates.length} 人，但当前筛选条件没有命中。`}
        actions={actions}
      />
    );
  }

  return (
    <div className="candidate-list candidate-v2-list">
      {loadState === 'stale' && candidates.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="刷新失败，当前展示上次成功数据"
          description={<CandidateLoadErrorDescription message={loadError} technicalDetails={loadErrorDetails} />}
          action={<Button size="small" onClick={onRetry}>重试</Button>}
        />
      )}
      {loadState === 'refreshing' && candidates.length > 0 && (
        <div className="so-banner" role="status" aria-live="polite"><Spin size="small" /> 正在刷新候选人列表…</div>
      )}
      {selectionFilteredOut && (
        <Alert
          type="info"
          showIcon
          message={`仍在查看：${selectedCandidate.name || '当前候选人'}`}
          description={`当前“${activeQueueLabel}”队列或筛选条件未包含此候选人；详情已保留，不会静默切换到其他人。`}
          action={<Button size="small" onClick={handleRevealSelectedCandidate}>在列表中显示</Button>}
        />
      )}
      <div className="candidate-filters">
        <div className="candidate-list-toolbar">
          {summaryText && <div className="candidate-job-summary" title={summaryText}>{summaryText}</div>}
          <div className="candidate-list-meta">{activeQueueLabel} · {countsUnavailable ? '—' : filtered.length} 人 · 第 {Math.min(page, totalPages)}/{totalPages} 页</div>
        </div>
        <div className="candidate-queue-tabs" role="group" aria-label="候选人队列筛选；全部待处理为聚合视图，其余为阶段筛选">
          {primaryQueueOptions.map((item) => (
            <Button
              key={item.key}
              size="small"
              type={activeQueue === item.key ? 'primary' : 'default'}
              className={`candidate-queue-tab ${activeQueue === item.key ? 'active' : ''}`}
              aria-pressed={activeQueue === item.key}
              onClick={() => setActiveQueue(item.key)}
            >
              <span className="candidate-queue-tab-label">{item.label}</span>
              <span className="candidate-queue-tab-count">{countsUnavailable ? '—' : item.count}</span>
            </Button>
          ))}
          <Dropdown
            trigger={['click']}
            menu={{
              'aria-label': '其他阶段候选人队列',
              selectable: true,
              selectedKeys: overflowQueueActive ? [activeQueue] : [],
              items: overflowQueueOptions.map((item) => ({
                key: item.key,
                label: `${item.label} · ${countsUnavailable ? '—' : item.count}`,
              })),
              onClick: ({ key }) => setActiveQueue(key),
            }}
          >
            <Button
              size="small"
              type={overflowQueueActive ? 'primary' : 'default'}
              className={`candidate-queue-tab candidate-queue-more ${overflowQueueActive ? 'active' : ''}`}
              aria-pressed={overflowQueueActive}
              aria-haspopup="menu"
              aria-label={overflowQueueAccessibleLabel}
              icon={<MoreOutlined aria-hidden="true" />}
            >
              <span className="candidate-queue-tab-label">{overflowQueueActive ? activeQueueLabel : '其他阶段'}</span>
              <span className="candidate-queue-tab-count">{countsUnavailable
                ? '—'
                : overflowQueueActive
                  ? activeOverflowQueueCount
                  : `${overflowQueueCategoryCount} 类`}</span>
            </Button>
          </Dropdown>
        </div>
        <div className="candidate-search-row">
          <Input
            className="candidate-search-input"
            name="candidate-search"
            autoComplete="off"
            aria-label="搜索候选人"
            placeholder="搜索姓名 / 岗位 / 学校…"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            allowClear
          />
          <Button
            className="candidate-filter-trigger"
            size="small"
            aria-expanded={showAdvancedFilters}
            aria-controls="candidate-advanced-filters"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            {showAdvancedFilters ? '收起筛选' : advancedFilterCount ? `筛选 ${advancedFilterCount}` : '筛选'}
          </Button>
        </div>
        {showAdvancedFilters && (
          <div id="candidate-advanced-filters" className="candidate-advanced-filters">
            <div className="candidate-filter-row">
              <Select aria-label="按沟通状态筛选" value={comm} onChange={onCommChange} options={commOptions} size="small" />
              <Select aria-label="按处置状态筛选" value={disp} onChange={onDispChange} options={dispOptions} size="small" />
            </div>
            <div className="candidate-filter-row">
              <Select aria-label="按学历筛选" value={education} onChange={onEducationChange} options={EDUCATION_OPTIONS} size="small" />
              <Select aria-label="按标签筛选" value={tag} onChange={setTag} options={tagOptions} size="small" />
            </div>
            {hasFilters && (
              <Button size="small" type="link" className="candidate-clear-filters" onClick={handleClearFilters}>
                清空筛选
              </Button>
            )}
          </div>
        )}
        {candidates.length > 0 && (
          <div
            className="assessment-ranking-banner candidate-queue-guidance"
            role={sabcUnavailable || sabcCoverageIncomplete ? 'status' : 'note'}
            aria-live={sabcUnavailable || sabcCoverageIncomplete ? 'polite' : undefined}
            aria-label={`${coverageExplanation} ${DEFAULT_RANKING_EXPLANATION}`}
            title={DEFAULT_RANKING_EXPLANATION}
          >
            <span>{coverageSummary}</span>
            <span>按 SABC、入库时间排序</span>
            {has(sabc) && (
              <Button className="candidate-queue-guidance-action" size="small" type="link" onClick={() => onSabcChange && onSabcChange('')}>
                清除评级
              </Button>
            )}
          </div>
        )}
      </div>
      <div
        className="candidate-scroll"
        role={emptyState ? 'region' : 'listbox'}
        aria-label="候选人列表"
        aria-busy={loadState === 'loading' || loadState === 'refreshing'}
      >
        {emptyState || paged.map((c) => (
          <CandidateCard
            key={c.internal_id}
            candidate={c}
            selectedId={selectedId}
            onSelect={handleCandidateSelect}
            tabIndex={c.internal_id === tabStopCandidateId ? 0 : -1}
            cardRef={(node) => rememberCandidateRef(c.internal_id, node)}
            onMoveFocus={handleCandidateMoveFocus}
            onRovingFocus={setRovingCandidateId}
          />
        ))}
      </div>
      {filtered.length > 0 && (
        <div className="candidate-pagination">
          <Pagination
            size="small"
            current={page}
            pageSize={PAGE_SIZE}
            total={filtered.length}
            showSizeChanger={false}
            showLessItems
            onChange={setPage}
          />
        </div>
      )}
    </div>
  );
}

export {
  SabcBadge,
  candidateDispositionLabel,
  candidateStableReference,
  candidateWorkMeta,
  compareCandidateDefaultPriority,
  highlight,
};
