import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Empty,
  Input,
  Progress,
  Segmented,
  Select,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DatabaseOutlined,
  FileSearchOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  StopOutlined,
  UserAddOutlined,
  UserSwitchOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { api, clean, fmtTime, has, joinParts } from '../api.js';
import EmptyState from './EmptyState.jsx';
import { createRequestEpoch } from '../request-epoch.js';
import { candidateSourceLabel } from '../candidate-utils.js';

const { Paragraph, Text, Title } = Typography;
const GROUPS = [
  { key: 'all', label: '全部' },
  { key: 'strong', label: '强推荐' },
  { key: 'cultivate', label: '可培养' },
  { key: 'needs_evidence', label: '待补证据' },
  { key: 'not_recommended', label: '不建议触达' },
];
const OUTREACH_BLOCKED_STATUSES = new Set(['cooling', 'do_not_contact']);
const TALENT_HISTORY_PREVIEW_COUNT = 3;

const STATUS_ICON = {
  reactivable: <CheckCircleOutlined />,
  silver: <UserSwitchOutlined />,
  role_mismatch: <UserSwitchOutlined />,
  cooling: <ClockCircleOutlined />,
  do_not_contact: <StopOutlined />,
  need_info: <QuestionCircleOutlined />,
  data_stale: <DatabaseOutlined />,
};

function statusMeta(pool, key) {
  const found = (pool?.statuses || []).find((item) => item.key === key);
  return found || { key, label: key || '状态待确认', color: 'default' };
}

function StatusTag({ pool, status }) {
  const meta = statusMeta(pool, status);
  return (
    <Tag color={meta.color} icon={STATUS_ICON[status]}>
      {hrFacingTalentText(meta.label)}
    </Tag>
  );
}

function textOrPending(value) {
  return has(value) ? value : '待确认';
}

function outreachGate(talent, readOnly = false) {
  if (!talent) return { blocked: true, type: 'warning', message: '未选择人才', description: '选择人才后再生成或复制再触达草稿。' };
  if (readOnly) {
    return {
      blocked: true,
      type: 'info',
      message: '当前岗位为只读状态',
      description: '当前岗位推荐与再触达动作已停用；人才详情和历史岗位记录仍可查看。',
    };
  }
  if (OUTREACH_BLOCKED_STATUSES.has(talent.pool_status)) {
    return {
      blocked: true,
      type: 'error',
      message: talent.pool_status === 'cooling' ? '冷却中，暂不触达' : '不建议触达',
      description: talent.pool_status_reason || '历史流程或备注存在限制，需先由 HR 人工复核并解除限制。',
    };
  }
  if (talent.pool_status === 'data_stale') {
    return {
      blocked: true,
      type: 'error',
      message: '资料已过期，暂不触达',
      description: '须先核对候选人近况、意愿和联系方式有效性，并重新完成联系前置条件复核。',
    };
  }
  if (talent.contact_state?.has_record !== true || talent.contact_state?.has_valid_contact_method !== true) {
    return {
      blocked: true,
      type: 'error',
      message: '缺少已确认有效的联系方式，禁止再触达',
      description: '须先确认存在有效联系渠道；系统只展示渠道状态，不展示联系方式明文。',
    };
  }
  if (
    talent.contact_state?.consent_confirmed !== true
    || talent.contact_state?.opt_out_status_confirmed !== true
    || talent.contact_state?.needs_consent_check !== false
  ) {
    return {
      blocked: true,
      type: 'error',
      message: '授权状态未确认，禁止再触达',
      description: '联系方式状态、退订/删除请求或再触达授权尚未确认；须先在候选人授权记录中完成核验，当前不允许编辑或复制草稿。',
    };
  }
  if (talent.contact_state?.contact_ready !== true) {
    return {
      blocked: true,
      type: 'error',
      message: '联系前置条件待复核，禁止再触达',
      description: '须确认授权、退订状态、有效联系渠道和资料时效均满足要求后，才能编辑或复制草稿。',
    };
  }
  return { blocked: false, type: 'success', message: '', description: '' };
}

function talentTime(value, fallback) {
  return fmtTime(value || fallback);
}

function countByGroup(talents, group) {
  if (group === 'all') return talents.length;
  return talents.filter((item) => item.recommendation?.group === group).length;
}

function talentDraftKey(jobId, poolId) {
  return `${String(jobId ?? 'no-job')}:${String(poolId ?? 'no-talent')}`;
}

function hrFacingTalentText(value) {
  return String(value || '')
    .replace(/人才库 P0 只读派生/g, '人才库为只读派生视图')
    .replace(/P0 按同一内部 Boss 人才标识聚合为同一人才/g, '仅按同一内部 Boss 人才标识聚合为同一人才')
    .replace(/P0 不做自动合并/g, '系统不会自动合并')
    .replace(/有V1初评/g, '有候选人匹配报告')
    .replace(/V1\s*候选人匹配报告/g, '候选人匹配报告')
    .replace(/V1\s*匹配报告/g, '候选人匹配报告')
    .replace(/V1 证据层/g, '候选人匹配报告证据层')
    .replace(/V1 报告/g, '候选人匹配报告')
    .replace(/\bV1\b/g, '候选人匹配报告')
    .replace(/Boss 钥匙字段/g, 'Boss 内部定位字段')
    .replace(/不返回 Boss 内部定位字段/g, '不展示 Boss 内部定位信息')
    .replace(/事实->判断->影响/g, '事实、判断与影响')
    .replace(/事实、Unknown、事实、判断与影响/g, '事实、信息不足、判断与影响')
    .replace(/API 不返回/g, '系统不展示')
    .replace(/\s+候选人匹配报告/g, '候选人匹配报告')
    .replace(/为\s*Unknown/g, '状态待确认')
    .replace(/Unknown\s*不扣分/g, '待确认项不扣分')
    .replace(/Unknown/g, '待确认');
}

function pendingTalentRiskCount(recommendation, contactState) {
  const pendingItems = [
    ...(recommendation?.unknowns || []),
    ...(recommendation?.uncertainties || []),
  ].map(hrFacingTalentText).filter(Boolean);
  if (pendingItems.length) return new Set(pendingItems).size;
  return contactState?.contact_ready === true ? 0 : 1;
}

function miniList(items, empty = '暂无') {
  const rows = (items || []).filter(Boolean);
  if (!rows.length) return <div className="talent-pool-empty-line">{empty}</div>;
  return (
    <ul className="talent-pool-mini-list">
      {rows.map((item, index) => <li key={`${item}-${index}`}>{hrFacingTalentText(item)}</li>)}
    </ul>
  );
}

function FactChain({ reason }) {
  if (!reason) return <div className="talent-pool-empty-line">暂无推荐依据</div>;
  return (
    <div className="talent-pool-fact-chain">
      <div><span>事实</span><p>{hrFacingTalentText(textOrPending(reason.fact))}</p></div>
      <div><span>判断</span><p>{hrFacingTalentText(textOrPending(reason.judgment))}</p></div>
      <div><span>影响</span><p>{hrFacingTalentText(textOrPending(reason.impact))}</p></div>
    </div>
  );
}

function Overview({ pool }) {
  return (
    <div className="talent-pool-overview">
      {(pool?.overview || []).map((item) => (
        <div className="talent-pool-stat" key={item.key}>
          <span>{hrFacingTalentText(item.label)}</span>
          <strong>{item.value}</strong>
          <em>{hrFacingTalentText(item.hint)}</em>
        </div>
      ))}
    </div>
  );
}

function TalentRow({ pool, talent, selected, tabIndex, rowRef, onSelect, onKeyDown }) {
  return (
    <button
      type="button"
      role="option"
      ref={rowRef}
      className={`talent-pool-row ${selected ? 'active' : ''}`}
      aria-selected={selected}
      tabIndex={tabIndex}
      onClick={() => onSelect(talent.pool_id)}
      onKeyDown={onKeyDown}
    >
      <div className="talent-pool-row-main">
        <div className="talent-pool-avatar">{clean(talent.name).slice(0, 1) || '人'}</div>
        <div>
          <div className="talent-pool-row-title">
            <strong>{hrFacingTalentText(talent.name)}</strong>
            <StatusTag pool={pool} status={talent.pool_status} />
            {talent.recommendation?.group_label && <Tag>{hrFacingTalentText(talent.recommendation.group_label)}</Tag>}
          </div>
          <div className="talent-pool-row-meta">
            {hrFacingTalentText(joinParts([
              talent.latest_job?.name,
              `${talent.historical_job_count || 0} 个历史岗位`,
              talentTime(talent.last_interaction_at, talent.data_observed_at),
            ]))}
          </div>
        </div>
      </div>
      <div className="talent-pool-row-side">
        <Progress
          className="talent-pool-evidence-progress"
          size="small"
          percent={talent.evidence_completeness?.percent || 0}
          showInfo={false}
        />
        <span>证据 {talent.evidence_completeness?.percent || 0}%</span>
      </div>
    </button>
  );
}

function TalentList({
  pool,
  talents,
  selectedId,
  selectedName,
  selectedHidden,
  onSelect,
  searchText,
  onSearchTextChange,
  onSearch,
  status,
  onStatusChange,
  group,
  onGroupChange,
  onClearFilters,
}) {
  const rowRefs = useRef(new Map());
  const panelRef = useRef(null);

  useEffect(() => {
    if (!panelRef.current) return;
    panelRef.current.scrollLeft = 0;
  }, [group, searchText, selectedId, status, talents.length]);
  const statusOptions = [
    { value: '', label: '全部状态' },
    ...(pool?.statuses || []).map((item) => ({
      value: item.key,
      label: `${hrFacingTalentText(item.label)} ${pool?.status_counts?.[item.key] || 0}`,
    })),
  ];
  const allTalents = pool?.talents || [];
  const groupOptions = GROUPS.map((item) => ({
    value: item.key,
    label: `${item.label} ${countByGroup(allTalents, item.key)}`,
  }));

  function moveSelection(event, targetIndex) {
    event.preventDefault();
    const target = talents[targetIndex];
    if (!target) return;
    onSelect(target.pool_id);
    const focus = () => rowRefs.current.get(target.pool_id)?.focus();
    if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(focus);
    else globalThis.setTimeout(focus, 0);
  }

  function handleRowKeyDown(event, index, talentId) {
    if (event.key === 'ArrowDown') moveSelection(event, Math.min(index + 1, talents.length - 1));
    else if (event.key === 'ArrowUp') moveSelection(event, Math.max(index - 1, 0));
    else if (event.key === 'Home') moveSelection(event, 0);
    else if (event.key === 'End') moveSelection(event, talents.length - 1);
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(talentId);
    }
  }

  return (
    <section ref={panelRef} className="talent-pool-panel talent-pool-list-panel">
      <div className="talent-pool-panel-head">
        <div>
          <Title level={4}>人才记录</Title>
          <Text type="secondary">从同一列表选择人才，推荐分组只用于筛选</Text>
        </div>
        {pool?.active_job?.status !== 'closed' && (
          <div className="talent-pool-group-filter">
            <Segmented
              className="talent-pool-group-segmented"
              aria-label="推荐分组筛选"
              size="small"
              value={group}
              onChange={onGroupChange}
              options={groupOptions}
            />
            <Select
              className="talent-pool-group-select"
              aria-label="推荐分组筛选"
              value={group}
              onChange={onGroupChange}
              options={groupOptions}
            />
          </div>
        )}
      </div>
      <div className="talent-pool-list-tools">
        <Input.Search
          aria-label="搜索人才库"
          name="talent-pool-search"
          autoComplete="off"
          spellCheck={false}
          allowClear
          enterButton="搜索"
          placeholder="搜索姓名、岗位、标签…"
          value={searchText}
          onChange={(event) => onSearchTextChange(event.target.value)}
          onSearch={onSearch}
          onClear={() => onSearch('')}
        />
        <Select aria-label="筛选人才状态" value={status} onChange={onStatusChange} options={statusOptions} />
      </div>
      {selectedHidden && (
        <Alert
          type="info"
          showIcon
          message={`当前筛选未包含已选人才“${hrFacingTalentText(selectedName || '未命名人才')}”`}
          description="右侧详情继续保留，不会静默切换到其他人才。"
          action={<Button size="small" onClick={onClearFilters}>清除筛选</Button>}
        />
      )}
      <div className="talent-pool-list" role="listbox" aria-label="人才列表">
        {talents.length ? talents.map((talent, index) => (
          <TalentRow
            key={talent.pool_id}
            pool={pool}
            talent={talent}
            selected={selectedId === talent.pool_id}
            tabIndex={selectedId === talent.pool_id || (selectedHidden && index === 0) ? 0 : -1}
            rowRef={(node) => {
              if (node) rowRefs.current.set(talent.pool_id, node);
              else rowRefs.current.delete(talent.pool_id);
            }}
            onSelect={onSelect}
            onKeyDown={(event) => handleRowKeyDown(event, index, talent.pool_id)}
          />
        )) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无人才记录" />
        )}
      </div>
    </section>
  );
}

function DetailBlock({ title, icon, children }) {
  return (
    <section className="talent-pool-detail-block">
      <div className="talent-pool-detail-title">
        {icon}
        <strong>{title}</strong>
      </div>
      {children}
    </section>
  );
}

function TalentDetail({
  pool,
  talent,
  draft,
  adding,
  readOnly,
  onDraftChange,
  onResetDraft,
  onCopyDraft,
  onOpenCandidate,
  onAddToCurrentJob,
}) {
  const historyRegionId = useId();
  const [expandedHistoryPoolId, setExpandedHistoryPoolId] = useState('');
  if (!talent) {
    return (
      <section className="talent-pool-panel talent-pool-detail" style={{ maxHeight: 'none', overflow: 'visible' }}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择一位人才查看再发现依据" />
      </section>
    );
  }
  const recommendation = talent.recommendation || {};
  const history = Array.isArray(talent.history) ? talent.history : [];
  const historyExpanded = String(expandedHistoryPoolId) === String(talent.pool_id);
  const hiddenHistoryCount = Math.max(history.length - TALENT_HISTORY_PREVIEW_COUNT, 0);
  const visibleHistory = historyExpanded ? history : history.slice(0, TALENT_HISTORY_PREVIEW_COUNT);
  const gate = outreachGate(talent, readOnly);
  const pendingRiskCount = pendingTalentRiskCount(recommendation, talent.contact_state);
  const activeJob = pool?.active_job || null;
  const closedJob = activeJob?.status === 'closed';
  const hasCurrentJobRecord = !!activeJob?.id && (talent.history || [])
    .some((item) => Number(item.job_id) === Number(activeJob.id));
  const addBlockedReason = readOnly
    ? '当前为只读模式'
    : pool?.source === 'fixture_fallback'
    ? '样例人才不能写入岗位'
    : !activeJob?.id
      ? '请先选择当前岗位'
      : activeJob.status === 'closed'
        ? '岗位已关闭，请重新开启后再加入'
        : !talent.primary_candidate_id
            ? '缺少可用的历史候选人记录'
            : hasCurrentJobRecord
              ? '该人才已在当前岗位'
              : '';
  return (
    <section className="talent-pool-panel talent-pool-detail" style={{ maxHeight: 'none', overflow: 'visible' }}>
      <div className="talent-pool-detail-head">
        <div>
          <div className="talent-pool-detail-name">
            <Title level={3}>{hrFacingTalentText(talent.name)}</Title>
            <StatusTag pool={pool} status={talent.pool_status} />
          </div>
          <Text type="secondary">{hrFacingTalentText(talent.pool_status_reason)}</Text>
        </div>
        <Space>
          <Tooltip title={addBlockedReason || `建立“${hrFacingTalentText(activeJob?.name || '当前岗位')}”的独立招聘关系`}>
            <span>
              <Button
                type="primary"
                icon={<UserAddOutlined />}
                loading={adding}
                disabled={!!addBlockedReason}
                onClick={() => onAddToCurrentJob?.(talent)}
              >
                {hasCurrentJobRecord ? '已在当前岗位' : '加入当前岗位'}
              </Button>
            </span>
          </Tooltip>
          <Tooltip title="打开历史候选人详情">
            <Button
              aria-label={`打开${talent.name || '当前人才'}的历史候选人详情`}
              icon={<FileSearchOutlined aria-hidden="true" />}
              disabled={!talent.primary_candidate_id}
              onClick={() => onOpenCandidate?.(talent.primary_candidate_id, talent.latest_job?.job_id)}
            />
          </Tooltip>
        </Space>
      </div>

      <div className="talent-pool-chip-row">
        {(talent.core_tags || []).map((tag) => <Tag key={tag}>{hrFacingTalentText(tag)}</Tag>)}
        <Tag>{hrFacingTalentText(talent.contact_state?.label || '联系方式状态待确认')}</Tag>
        {talent.has_v1_report ? <Tag color="cyan">候选人匹配报告</Tag> : <Tag>匹配报告待确认</Tag>}
        {talent.has_interview_report ? <Tag color="green">面试复盘</Tag> : <Tag>面试信息待确认</Tag>}
      </div>

      {!closedJob && (
        <>
          <DetailBlock title="推荐依据" icon={<CheckCircleOutlined />}>
            {(recommendation.reasons || []).length ? recommendation.reasons.map((reason, index) => (
              <FactChain key={`${reason.source}-${index}`} reason={reason} />
            )) : <FactChain reason={null} />}
          </DetailBlock>

          <div className="talent-pool-detail-grid">
            <DetailBlock title="待确认" icon={<QuestionCircleOutlined />}>
              {miniList(recommendation.unknowns, '暂无待确认项')}
            </DetailBlock>
            <DetailBlock title="风险" icon={<WarningOutlined />}>
              {miniList(
                recommendation.risks,
                pendingRiskCount > 0
                  ? `未发现已知风险（仍有 ${pendingRiskCount} 项待确认）`
                  : '未发现已知风险',
              )}
            </DetailBlock>
          </div>

          <DetailBlock title="不确定项" icon={<DatabaseOutlined />}>
            {miniList(recommendation.uncertainties, '暂无待确认项')}
          </DetailBlock>
        </>
      )}

      <DetailBlock title="证据完整度" icon={<DatabaseOutlined />}>
        <div className="talent-pool-evidence-score">
          <Progress percent={talent.evidence_completeness?.percent || 0} />
          <div>
            <Text type="secondary">已知：{(talent.evidence_completeness?.known_items || []).map(hrFacingTalentText).join('、') || '暂无'}</Text>
            <Text type="secondary">缺口：{(talent.evidence_completeness?.unknown_items || []).map(hrFacingTalentText).join('、') || '暂无'}</Text>
          </div>
        </div>
      </DetailBlock>

      {!closedJob && <DetailBlock title="再触达草稿" icon={<UserSwitchOutlined />}>
        {(gate.blocked || gate.message) && (
          <Alert
            className="talent-pool-outreach-alert"
            type={gate.type}
            showIcon
            message={gate.message}
            description={gate.description}
          />
        )}
        <Input.TextArea
          aria-label="人才库再触达草稿"
          name="talent-pool-outreach-draft"
          autoComplete="off"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          disabled={gate.blocked}
          autoSize={{ minRows: 5, maxRows: 8 }}
        />
        <div className="talent-pool-draft-actions">
          <Text type="secondary">{gate.blocked ? '当前状态禁止复制触达草稿' : '本地可编辑草稿 · 不发送'}</Text>
          <Space>
            <Button size="small" disabled={gate.blocked} onClick={onResetDraft}>重置</Button>
            <Button size="small" icon={<CopyOutlined />} disabled={gate.blocked || !draft} onClick={onCopyDraft}>复制</Button>
          </Space>
        </div>
      </DetailBlock>}

      <DetailBlock title="历史岗位记录" icon={<ClockCircleOutlined />}>
        <div className="talent-pool-history" id={historyRegionId}>
          {visibleHistory.map((item) => (
            <div className="talent-pool-history-row" key={`${item.candidate_id}-${item.job_id}`}>
              <div>
                <strong>{hrFacingTalentText(item.job_name)}</strong>
                <p>{hrFacingTalentText(joinParts([candidateSourceLabel(item.source), item.rec_position, talentTime(item.last_interaction_at, item.data_observed_at)]))}</p>
                <p>{hrFacingTalentText(joinParts([item.comm_status, item.disposition_status]))}</p>
              </div>
              <Space size={[4, 4]} wrap>
                {item.has_v1_report && <Tag color="cyan">匹配报告</Tag>}
                {item.has_interview_report && <Tag color="green">面试</Tag>}
                <Button
                  size="small"
                  aria-label={`打开${talent.name || '当前人才'}在${item.job_name || '历史岗位'}的候选人详情`}
                  icon={<FileSearchOutlined aria-hidden="true" />}
                  disabled={!item.candidate_id}
                  onClick={() => onOpenCandidate?.(item.candidate_id, item.job_id)}
                />
              </Space>
            </div>
          ))}
        </div>
        {hiddenHistoryCount > 0 && (
          <Button
            type="link"
            className="talent-pool-history-toggle"
            aria-expanded={historyExpanded}
            aria-controls={historyRegionId}
            onClick={() => setExpandedHistoryPoolId(historyExpanded ? '' : String(talent.pool_id))}
          >
            {historyExpanded ? '收起记录' : `查看其余 ${hiddenHistoryCount} 条`}
          </Button>
        )}
        <Paragraph type="secondary" className="talent-pool-duplicate-note">{hrFacingTalentText(talent.duplicate_hint)}</Paragraph>
      </DetailBlock>
    </section>
  );
}

export default function TalentPoolDemo({
  jobId,
  fixtureJob = false,
  readOnly = false,
  onOpenCandidate,
  onOpenCandidates,
  onCandidateAdded,
}) {
  const { message, modal } = AntApp.useApp();
  const [pool, setPool] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [group, setGroup] = useState('all');
  const [drafts, setDrafts] = useState({});
  const [demoMode, setDemoMode] = useState(false);
  const [addingId, setAddingId] = useState('');
  const requestRef = useRef(createRequestEpoch());
  const pendingWorkspaceRefreshRef = useRef(null);

  async function loadTalentPool(nextDemoMode = demoMode) {
    if (nextDemoMode && !fixtureJob) return false;
    const requestId = requestRef.current.begin();
    setLoading(true);
    setError('');
    try {
      const { talentPool } = await api.listTalentPool(jobId, { fixture: nextDemoMode });
      if (!requestRef.current.isCurrent(requestId)) return;
      setPool(talentPool);
      const first = talentPool.job_recommendations?.[0]?.pool_id || talentPool.talents?.[0]?.pool_id || '';
      setSelectedId((current) => (
        (talentPool.talents || []).some((talent) => talent.pool_id === current) ? current : first
      ));
      return true;
    } catch (err) {
      if (requestRef.current.isCurrent(requestId)) setError(err.message);
      return false;
    } finally {
      if (requestRef.current.isCurrent(requestId)) setLoading(false);
    }
  }

  useEffect(() => {
    requestRef.current.invalidate();
    pendingWorkspaceRefreshRef.current = null;
    setPool(null);
    setSelectedId('');
    setSearchText('');
    setQuery('');
    setStatus('');
    setGroup('all');
    setDemoMode(fixtureJob);
    loadTalentPool(fixtureJob);
  }, [jobId, fixtureJob]);

  const recommendations = pool?.job_recommendations || [];
  const talents = useMemo(() => {
    const needle = clean(query).toLowerCase();
    return (pool?.talents || []).filter((talent) => {
      if (status && talent.pool_status !== status) return false;
      if (group !== 'all' && talent.recommendation?.group !== group) return false;
      if (!needle) return true;
      const hay = [
        talent.name,
        talent.pool_status_label,
        talent.latest_job?.name,
        ...(talent.core_tags || []),
        ...(talent.history || []).map((item) => item.job_name),
      ].join(' ').toLowerCase();
      return hay.includes(needle);
    });
  }, [group, pool, query, status]);
  const selected = (pool?.talents || []).find((item) => item.pool_id === selectedId)
    || (pool?.talents || [])[0]
    || null;
  const selectedHidden = !!selected && !talents.some((item) => item.pool_id === selected.pool_id);
  const selectedDraftKey = selected ? talentDraftKey(jobId, selected.pool_id) : '';
  const draft = selected
    ? drafts[selectedDraftKey] ?? hrFacingTalentText(selected.recommendation?.outreach_draft ?? '')
    : '';
  const closedJob = pool?.active_job?.status === 'closed';
  const authorityReadPending = loading || !!addingId;
  const authorityMismatch = !pool || String(pool.active_job?.id ?? '') !== String(jobId ?? '');
  const writesLocked = readOnly || authorityReadPending || !!error || authorityMismatch;

  function updateDraft(value) {
    if (!selected || writesLocked) return;
    setDrafts((prev) => ({ ...prev, [selectedDraftKey]: value }));
  }

  async function copyDraft() {
    if (!draft) return;
    const gate = outreachGate(selected, writesLocked);
    if (gate.blocked) {
      message.warning(gate.message || '当前人才状态不允许复制触达草稿');
      return;
    }
    try {
      await navigator.clipboard.writeText(draft);
      message.success('草稿已复制');
    } catch {
      message.warning('复制失败，可手动选中文本复制');
    }
  }

  function resetDraft() {
    if (!selected || writesLocked) return;
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[selectedDraftKey];
      return next;
    });
  }

  function toggleDemoMode() {
    if (!fixtureJob) return;
    const next = !demoMode;
    setDemoMode(next);
    setSelectedId('');
    loadTalentPool(next);
  }

  function submitSearch(value) {
    const next = clean(value);
    setSearchText(next);
    setQuery(next);
  }

  function clearFilters() {
    setSearchText('');
    setQuery('');
    setStatus('');
    setGroup('all');
  }

  async function refreshTalentAuthorities(nextDemoMode = demoMode) {
    const pendingWorkspaceRefresh = pendingWorkspaceRefreshRef.current;
    if (!pendingWorkspaceRefresh) return loadTalentPool(nextDemoMode);

    setAddingId(pendingWorkspaceRefresh.poolId || 'authority-refresh');
    const poolRefreshed = await loadTalentPool(false);
    let workspaceRefreshed = false;
    try {
      const workspaceRefreshResult = await onCandidateAdded?.(
        pendingWorkspaceRefresh.candidateId,
        pendingWorkspaceRefresh.jobId,
      );
      workspaceRefreshed = workspaceRefreshResult !== false;
    } catch {
      // The committed relation must remain write-locked until its workspace authority catches up.
    } finally {
      pendingWorkspaceRefreshRef.current = workspaceRefreshed ? null : pendingWorkspaceRefresh;
      if (!workspaceRefreshed) {
        setError('岗位关系已保存，但候选人工作区刷新未完成。请重新刷新后再继续操作。');
      }
      setAddingId('');
    }
    return poolRefreshed && workspaceRefreshed;
  }

  function confirmAddToCurrentJob(talent) {
    if (writesLocked || !talent?.primary_candidate_id || !pool?.active_job?.id) return;
    const targetJob = pool.active_job;
    const preservesDoNotContact = talent.pool_status === 'do_not_contact';
    let confirmBusy = false;
    let confirmInstance = null;
    let successNotice = '';
    const updateConfirmBusy = (busy) => {
      confirmBusy = busy;
      confirmInstance?.update({
        keyboard: !busy,
        closable: false,
        maskClosable: false,
        okButtonProps: { disabled: busy, loading: busy },
        cancelButtonProps: { disabled: busy },
      });
    };
    confirmInstance = modal.confirm({
      title: `将“${hrFacingTalentText(talent.name)}”加入“${hrFacingTalentText(targetJob.name)}”`,
      content: preservesDoNotContact
        ? '将建立一条新的岗位招聘关系，并继续保持“未打招呼 / 不再联系”；不会开放触达草稿、自动发送消息或改变历史记录。只复用基础资料和最近一份可读在线简历快照，不复制旧岗位的评级、AI 结论、联系方式、面试、测评、处置或状态历史。'
        : '将建立一条新的岗位招聘关系，从“未打招呼 / 新入库”开始；只复用基础资料和最近一份可读在线简历快照，不复制旧岗位的评级、AI 结论、联系方式、面试、测评、处置或状态历史，也不会自动发送消息。',
      okText: '确认加入',
      cancelText: '取消',
      keyboard: true,
      closable: false,
      maskClosable: false,
      onOk: async () => {
        if (confirmBusy) return;
        updateConfirmBusy(true);
        setAddingId(talent.pool_id);
        try {
          const { relation } = await api.addTalentToJob(talent.primary_candidate_id, targetJob.id);
          successNotice = relation.inserted
            ? (relation.do_not_contact_preserved ? '已加入当前岗位，并继续保持“不再联系”。' : '已加入当前岗位候选人队列。')
            : '该人才已在当前岗位，未重复创建。';
          pendingWorkspaceRefreshRef.current = {
            poolId: talent.pool_id,
            candidateId: relation.candidate?.internal_id,
            jobId: targetJob.id,
          };
          const refreshed = await refreshTalentAuthorities(false);
          if (!refreshed) message.warning('岗位关系已保存，但页面刷新未完成，请手动刷新。');
        } catch (err) {
          updateConfirmBusy(false);
          message.error(err?.message || '加入当前岗位失败。');
          throw err;
        } finally {
          setAddingId('');
        }
      },
      // The success notice waits for afterClose so it never fires under the
      // still-closing confirm dialog.
      afterClose: () => {
        if (successNotice) message.success(successNotice);
      },
    });
  }

  const isEmptyLocalPool = pool?.source === 'local_db_empty';
  const showUnifiedEmptyState = isEmptyLocalPool
    && (pool?.talents || []).length === 0
    && recommendations.length === 0;
  const initialLoadError = !!error && !pool;

  return (
    <div className="talent-pool-page">
      <div className="talent-pool-hero">
        <div>
          <Text className="talent-pool-kicker">人才库</Text>
          <Title level={2}>历史候选人再发现</Title>
          <Paragraph>
            {pool?.source === 'fixture_fallback' ? '样例数据 · 无真实候选人数据' : '历史证据只读 · 加入岗位需 HR 确认'} · {hrFacingTalentText(pool?.active_job?.name || '当前岗位')}
          </Paragraph>
        </div>
        <Space>
          {fixtureJob && (showUnifiedEmptyState || demoMode) ? (
            <Button onClick={toggleDemoMode}>
              {demoMode ? '退出测试样例，返回本机数据' : '加载测试样例'}
            </Button>
          ) : null}
          <Button
            aria-label="刷新人才库"
            title="刷新人才库"
            icon={<ReloadOutlined aria-hidden="true" />}
            onClick={() => refreshTalentAuthorities()}
            loading={loading}
          >
            刷新人才库
          </Button>
        </Space>
      </div>

      {error && <Alert
        className={initialLoadError ? 'talent-pool-load-error' : 'talent-pool-stale-warning'}
        role={initialLoadError ? 'alert' : 'status'}
        aria-live={initialLoadError ? 'assertive' : 'polite'}
        type={initialLoadError ? 'error' : 'warning'}
        showIcon
        message={initialLoadError ? '人才库读取失败' : '人才库刷新失败，当前显示上次成功数据'}
        description={initialLoadError
          ? `${error} 错误不会被当作空人才库；恢复前不会开放加入岗位或再触达操作。`
          : `${error} 当前内容可能不是最新，请重新读取后再执行加入岗位或再触达操作。`}
        action={<Button onClick={() => refreshTalentAuthorities()}>重新读取人才库</Button>}
      />}
      {closedJob && (
        <Alert
          type="info"
          showIcon
          message="岗位已关闭，当前岗位推荐与再触达已停用"
          description="历史人才资料、证据完整度和历史岗位记录仍可查看。重新开启岗位后才会恢复当前职位反查。"
        />
      )}
      {(pool?.compliance_notes || []).length > 0 && (
        <div className="talent-pool-compliance" role="note">
          <CheckCircleOutlined />
          <span>{(pool.compliance_notes || [])
            .map(hrFacingTalentText)
            .map((note) => note.replace(/[。；]+$/g, ''))
            .join('；')}。</span>
        </div>
      )}

      {loading && !pool ? (
        <div className="talent-pool-loading" role="status" aria-live="polite">
          <Text type="secondary">正在读取本地人才库…</Text>
          <div className="talent-pool-loading-grid" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div className="talent-pool-loading-card" key={index}>
                <Skeleton active title={{ width: index ? '42%' : '54%' }} paragraph={{ rows: 2, width: ['94%', '72%'] }} />
              </div>
            ))}
          </div>
        </div>
      ) : initialLoadError ? null : showUnifiedEmptyState ? (
        <section className="talent-pool-empty-state" aria-label="本机人才库空态">
          <EmptyState
            compact={false}
            title="本机还没有可复用的历史候选人"
            hint="完成候选人入库与招聘流程后，人才会按本地证据进入这里；当前不会从外部平台自动补数据。"
            action={onOpenCandidates ? (
              <Button type="primary" onClick={onOpenCandidates}>前往候选人列表</Button>
            ) : null}
          />
        </section>
      ) : (
        <>
          <Overview pool={pool} />
          <div className="talent-pool-workspace">
            <TalentList
              pool={pool}
              talents={talents}
              selectedId={selected?.pool_id}
              selectedName={selected?.name}
              selectedHidden={selectedHidden}
              onSelect={setSelectedId}
              searchText={searchText}
              onSearchTextChange={setSearchText}
              onSearch={submitSearch}
              status={status}
              onStatusChange={setStatus}
              group={group}
              onGroupChange={setGroup}
              onClearFilters={clearFilters}
            />
            <TalentDetail
              pool={pool}
              talent={selected}
              draft={draft}
              onDraftChange={updateDraft}
              onResetDraft={resetDraft}
              onCopyDraft={copyDraft}
              onOpenCandidate={onOpenCandidate}
              onAddToCurrentJob={confirmAddToCurrentJob}
              adding={addingId === selected?.pool_id}
              readOnly={writesLocked}
            />
          </div>
        </>
      )}
    </div>
  );
}
