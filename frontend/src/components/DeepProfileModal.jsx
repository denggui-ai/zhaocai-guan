import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Modal, Input, Button, Typography, Tag, Space, Collapse, Segmented, Alert, App as AntApp } from 'antd';
import { actionRequest, api, sleep, has, fmtTime, FU_KIND, READONLY_UI } from '../api.js';
import { deepProfileErrorMessage } from '../deep-profile-errors.js';
import ExternalAiFirstUsePrompt, {
  readExternalAiCapability,
} from './ExternalAiFirstUsePrompt.jsx';

const { Text, Title } = Typography;
const { TextArea } = Input;
const MATERIAL_SOURCES = {
  offline_recording: {
    label: '线下录音',
    note: '线下录音转写',
    hint: '使用本机面试工作台完成录音和转写后，把转写全文粘贴到这里；此方式不调用外部会议服务。',
    placeholder: '粘贴本机录音生成的转写全文…',
  },
  lark_minutes: {
    label: '线上会议导入',
    note: '线上会议导入 · 飞书妙记',
    hint: '只有点击“从飞书妙记导入转写”才会请求外部导入。本地演示模式默认关闭，粘贴链接或保存画像都不会执行。',
  },
  manual_transcript: {
    label: '手动粘贴转写',
    note: '手动粘贴转写',
    hint: '直接粘贴已经取得授权的访谈转写全文，不调用录音或外部会议服务。',
    placeholder: '粘贴访谈转写全文…',
  },
};

function interviewSourceLabel(sourceType) {
  return MATERIAL_SOURCES[sourceType]?.label || '历史材料';
}

async function postInterviewAction(path, body) {
  return actionRequest('POST', path, body);
}

function srcLabel(source) {
  if (source === 'stated') return '负责人明说';
  if (source === 'mixed') return '原话+推断';
  return 'AI推断';
}

function DpItem({ main, item }) {
  const inferred = item.source !== 'stated';
  const quotes = (item.quotes || []).filter(has);
  return (
    <div className={`dp-item ${inferred ? 'inferred' : ''}`}>
      {main}
      <Tag style={{ marginLeft: 6, background: inferred ? 'var(--hb-warning-soft)' : 'var(--hb-primary-soft)', color: inferred ? 'var(--hb-warning-text)' : 'var(--hb-primary-dark)', border: 'none' }}>
        {srcLabel(item.source)}
      </Tag>
      {quotes.length > 0 && <div className="dp-quote">原话：{quotes.map((q) => `「${q}」`).join(' ')}</div>}
      {inferred && has(item.inference_basis) && <div className="dp-basis">推断依据：{item.inference_basis}</div>}
    </div>
  );
}

function DpSimpleList({ title, rows }) {
  if (!rows || !rows.length) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <Title level={5}>{title}</Title>
      {rows.map((r, i) => (
        <DpItem key={i} item={r} main={<><Text strong>{r.item}</Text>{has(r.detail) && <div>{r.detail}</div>}</>} />
      ))}
    </div>
  );
}

function docToMarkdown(jobName, deep) {
  const d = deep.doc || {};
  const src = (x) => (x.source === 'stated' ? '【负责人明说】' : x.source === 'mixed' ? '【原话+推断】' : '【AI推断】');
  const quo = (x) => (x.quotes || []).filter(has).map((q) => `> 原话：「${q}」`).join('\n');
  const bas = (x) => (x.source !== 'stated' && has(x.inference_basis) ? `> 推断依据：${x.inference_basis}` : '');
  const item = (x) => [`- ${src(x)} **${x.item}**${has(x.detail) ? `：${x.detail}` : ''}`, quo(x), bas(x)].filter(Boolean).join('\n');
  const listBlock = (title, rows) => (rows && rows.length ? `\n## ${title}\n${rows.map(item).join('\n')}` : '');
  const L = [];
  L.push(`# 深度人才画像 · ${jobName}`);
  L.push(`版本 v${deep.version} · 生成于 ${fmtTime(deep.generated_at)} · ${deep.stale_for_active_jd === true ? '历史画像（已失效）' : deep.status === 'confirmed' ? '负责人已确认' : '待负责人确认'}`);
  L.push('\n请重点核对标【AI推断】的条目——那是 AI 从访谈推出来的，不是您的原话，推错了请直接指出。');
  if (d.position_mission) {
    L.push(`\n## 这个岗位要解决什么问题\n${src(d.position_mission)} ${d.position_mission.content}`);
    const q = quo(d.position_mission); if (q) L.push(q);
    const b = bas(d.position_mission); if (b) L.push(b);
  }
  L.push(listBlock('硬性要求', d.hard_requirements));
  if ((d.core_competencies || []).length) {
    L.push('\n## 核心能力');
    for (const c of d.core_competencies) {
      L.push(`\n### ${src(c)} ${c.name}`);
      if (has(c.what)) L.push(`- 具体指：${c.what}`);
      if (has(c.why)) L.push(`- 为什么要：${c.why}`);
      if ((c.resume_evidence || []).length) L.push(`- 简历上什么算真证据：${c.resume_evidence.join('；')}`);
      if ((c.fake_signals || []).length) L.push(`- 什么写法不算数：${c.fake_signals.join('；')}`);
      const q = quo(c); if (q) L.push(q);
      const b = bas(c); if (b) L.push(b);
    }
  }
  L.push(listBlock('加分项', d.plus_points));
  L.push(listBlock('减分项', d.minus_points));
  L.push(listBlock('一票否决', d.deal_breakers));
  if ((d.implicit_preferences || []).length) {
    L.push('\n## 没明说、但访谈里明显在意的（AI 观察，请核对）');
    for (const p of d.implicit_preferences) L.push(`- ${p.observation}${has(p.basis) ? `（从哪看出来：${p.basis}）` : ''}`);
  }
  if ((d.followup_questions || []).length) {
    L.push('\n## 想再和您确认几个问题');
    d.followup_questions.forEach((q, i) => L.push(`${i + 1}. ${q.question}${has(q.why_ask) ? `（${q.why_ask}）` : ''}`));
  }
  return L.filter(Boolean).join('\n');
}

function DeepDoc({ deep, jobName, jobId, writeLocked, writeLockReason, onCommittedAction }) {
  const { message, modal } = AntApp.useApp();
  const [answers, setAnswers] = useState({});
  const [busyAction, setBusyAction] = useState('');
  const d = deep.doc || {};
  const stale = deep.stale_for_active_jd === true;
  const confirmed = deep.status === 'confirmed' && !stale;

  async function handleCopy() {
    await navigator.clipboard.writeText(docToMarkdown(jobName, deep));
    message.success('已复制画像 Markdown。发给用人部门负责人核对（重点是标「AI推断」的条目）；负责人认可后回来点「标记负责人已确认」。');
  }

  async function handleConfirm() {
    if (writeLocked || busyAction) {
      message.warning(writeLockReason || '画像状态尚未读取完成，请先重试读取。');
      return;
    }
    modal.confirm({
      title: '确认用人部门负责人已经看过并认可当前这一版画像？',
      content: '此操作会记入审计日志。',
      onOk: async () => {
        setBusyAction('confirm');
        let committed = false;
        try {
          await api.confirmDeepProfile(jobId);
          committed = true;
          await onCommittedAction('负责人确认已提交', '深度画像已标记为负责人确认。');
        } catch (error) {
          if (!committed) {
            message.error(error.message || '负责人确认未提交。');
            throw error;
          }
        } finally {
          setBusyAction('');
        }
      },
    });
  }

  async function handleSaveFollowup(index) {
    if (writeLocked || busyAction) {
      message.warning(writeLockReason || '画像状态尚未读取完成，请先重试读取。');
      return;
    }
    const q = d.followup_questions[index];
    const answer = (answers[index] || '').trim();
    if (!answer) { message.warning('先把负责人的回答填进去。'); return; }
    setBusyAction(`followup:${index}`);
    let committed = false;
    try {
      await api.saveInterview(jobId, `问：${q.question}\n答：${answer}`, '', '追问补答');
      committed = true;
      setAnswers((current) => ({ ...current, [index]: '' }));
      await onCommittedAction('追问补答已保存', '补答已保存。点「重新生成画像」让 AI 把它吸收进新版画像。');
    } catch (error) {
      if (!committed) message.error(error.message || '追问补答未保存。');
    } finally {
      setBusyAction('');
    }
  }

  return (
    <>
      <Space wrap style={{ margin: '10px 0' }}>
        <Tag color="blue">画像 v{deep.version}</Tag>
        {stale
          ? <Tag color="warning">历史画像 · 已因 JD/画像切换失效</Tag>
          : confirmed
            ? <Tag color="success">负责人已确认 · {fmtTime(deep.confirmed_at)}</Tag>
            : <Tag color="error">草稿 · 待负责人确认</Tag>}
        <Text type="secondary" style={{ fontSize: 12 }}>生成于 {fmtTime(deep.generated_at)}</Text>
      </Space>
      <div style={{ margin: '10px 0' }}>
        <Space>
          <Button onClick={handleCopy}>复制为 Markdown 发负责人核对</Button>
          {!confirmed && !stale && (
            <Button disabled={writeLocked || !!busyAction} loading={busyAction === 'confirm'} onClick={handleConfirm}>
              标记负责人已确认
            </Button>
          )}
        </Space>
      </div>
      <Text type="secondary" style={{ fontSize: 12 }}>
        绿色条目 = 负责人访谈里明说的（附原话）；橙色「AI推断」条目 = AI 从访谈推出来的，负责人核对时重点看这些。
      </Text>
      {d.position_mission && (
        <div style={{ marginTop: 14 }}>
          <Title level={5}>这个岗位要解决什么问题</Title>
          <DpItem item={d.position_mission} main={<div>{d.position_mission.content}</div>} />
        </div>
      )}
      <DpSimpleList title="硬性要求" rows={d.hard_requirements} />
      {(d.core_competencies || []).length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Title level={5}>核心能力（怎么在简历上判）</Title>
          {d.core_competencies.map((c, i) => (
            <DpItem
              key={i}
              item={c}
              main={
                <>
                  <Text strong>{c.name}</Text>
                  {has(c.what) && <div>具体指：{c.what}</div>}
                  {has(c.why) && <div>为什么要：{c.why}</div>}
                  {(c.resume_evidence || []).length > 0 && <div className="dp-quote">简历上什么算真证据：{c.resume_evidence.join('；')}</div>}
                  {(c.fake_signals || []).length > 0 && <div className="dp-basis">什么写法不算数：{c.fake_signals.join('；')}</div>}
                </>
              }
            />
          ))}
        </div>
      )}
      <DpSimpleList title="加分项" rows={d.plus_points} />
      <DpSimpleList title="减分项" rows={d.minus_points} />
      <DpSimpleList title="一票否决" rows={d.deal_breakers} />
      {(d.implicit_preferences || []).length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Title level={5}>负责人没明说、但明显在意的</Title>
          {d.implicit_preferences.map((p, i) => (
            <div className="dp-item inferred" key={i}>
              <Text strong>{p.observation}</Text>
              <Tag style={{ marginLeft: 6, background: 'var(--hb-warning-soft)', color: 'var(--hb-warning-text)', border: 'none' }}>隐性偏好</Tag>
              {has(p.basis) && <div className="dp-basis">从哪看出来：{p.basis}</div>}
            </div>
          ))}
        </div>
      )}
      {(d.followup_questions || []).length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <Title level={5}>追问清单（发给负责人，答完保存再重新生成）</Title>
          {d.followup_questions.map((q, i) => (
            <div className="dp-item inferred" key={i}>
              <Text strong>{q.question}</Text>
              <Tag style={{ marginLeft: 6, background: 'var(--hb-warning-soft)', color: 'var(--hb-warning-text)', border: 'none' }}>{FU_KIND[q.kind] || '没聊到'}</Tag>
              {has(q.why_ask) && <div className="dp-basis">为什么问：{q.why_ask}</div>}
              <TextArea
                aria-label={`${q.question}的回答`}
                name={`deep-profile-followup-answer-${i}`}
                autoComplete="off"
                rows={2}
                style={{ marginTop: 6 }}
                placeholder="把负责人的回答填在这里…"
                value={answers[i] || ''}
                disabled={writeLocked || !!busyAction}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [i]: e.target.value }))}
              />
              <div style={{ marginTop: 6 }}>
                <Button
                  size="small"
                  disabled={writeLocked || !!busyAction}
                  loading={busyAction === `followup:${i}`}
                  onClick={() => handleSaveFollowup(i)}
                >保存补答</Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Text type="secondary" style={{ display: 'block', marginTop: 14 }}>没有待追问的问题。</Text>
      )}
    </>
  );
}

export default function DeepProfileModal({
  open,
  jobId,
  jobName,
  readOnly = false,
  onClose,
  onOpenAiSettings,
  aiResumeIntent,
  onAiResumeConsumed,
}) {
  const { message, modal } = AntApp.useApp();
  const [interviews, setInterviews] = useState([]);
  const [config, setConfig] = useState(null);
  const [generationReadiness, setGenerationReadiness] = useState(null);
  const [externalAiAccess, setExternalAiAccess] = useState(null);
  const [ivText, setIvText] = useState('');
  const [ivUrl, setIvUrl] = useState('');
  const [sourceType, setSourceType] = useState('offline_recording');
  const [larkCapability, setLarkCapability] = useState(null);
  const [savingIv, setSavingIv] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState(READONLY_UI ? 'readonly' : 'checking');
  const [generationError, setGenerationError] = useState('');
  const [loadState, setLoadState] = useState('idle');
  const [loadError, setLoadError] = useState('');
  const [hasLoadedSuccessfully, setHasLoadedSuccessfully] = useState(false);
  const [committedRefresh, setCommittedRefresh] = useState(null);
  const [aiFirstUseOpen, setAiFirstUseOpen] = useState(false);
  const [aiFirstUseError, setAiFirstUseError] = useState('');
  const [aiCapabilityChecking, setAiCapabilityChecking] = useState(false);
  const profileContextRef = useRef({ key: '', jobId: null, token: 0 });
  const reloadRequestRef = useRef(0);
  const loadedContextRef = useRef('');
  const componentMountedRef = useRef(true);
  const generationPollEpochRef = useRef(0);
  const generationAttemptRef = useRef(null);
  const dialogInitialFocusRef = useRef(null);
  const contextKey = `${open ? 'open' : 'closed'}:${jobId ?? ''}`;
  if (profileContextRef.current.key !== contextKey) {
    profileContextRef.current = {
      key: contextKey,
      jobId,
      token: profileContextRef.current.token + 1,
    };
    reloadRequestRef.current += 1;
  }

  function isCurrentContext(context) {
    return componentMountedRef.current
      && context.token === profileContextRef.current.token
      && context.key === profileContextRef.current.key;
  }

  function isCurrentGeneration(context, epoch) {
    return isCurrentContext(context) && epoch === generationPollEpochRef.current;
  }

  useEffect(() => {
    componentMountedRef.current = true;
    return () => {
      componentMountedRef.current = false;
      generationPollEpochRef.current += 1;
      reloadRequestRef.current += 1;
      generationAttemptRef.current = null;
    };
  }, []);

  const reload = useCallback(async (context = profileContextRef.current) => {
    if (!context.jobId || !isCurrentContext(context)) return { ok: false, stale: true };
    const requestId = ++reloadRequestRef.current;
    const hadSuccessfulData = loadedContextRef.current === context.key;
    setLoadState('loading');
    setLoadError('');
    try {
      const [ivRes, cfgRes, larkRes, externalAiRes] = await Promise.all([
        api.listInterviews(context.jobId),
        api.getProfile(context.jobId),
        api.getLarkImportStatus().catch(() => ({ enabled: false, status: 'unavailable' })),
        api.getLlmConfig()
          .then((result) => ({ readable: true, config: result.config || null, error: '' }))
          .catch((error) => ({ readable: false, config: null, error: error?.message || '外部 AI 配置状态不可读' })),
      ]);
      if (!isCurrentContext(context) || requestId !== reloadRequestRef.current) return { ok: false, stale: true };
      setInterviews(Array.isArray(ivRes.interviews) ? ivRes.interviews : []);
      setConfig(cfgRes.config || null);
      setGenerationReadiness(cfgRes.generation_readiness || {
        ready: false,
        code: 'READINESS_UNKNOWN',
        message: '暂时无法确认 JD、岗位画像和访谈材料是否齐全，请重试读取。',
      });
      setExternalAiAccess(externalAiRes);
      setLarkCapability(larkRes);
      loadedContextRef.current = context.key;
      setHasLoadedSuccessfully(true);
      setLoadState('ready');
      setLoadError('');
      return { ok: true };
    } catch (error) {
      if (!isCurrentContext(context) || requestId !== reloadRequestRef.current) return { ok: false, stale: true };
      const errorMessage = error?.message || '深度画像状态读取失败，请重试。';
      setLoadState('error');
      setLoadError(errorMessage);
      return { ok: false, error: errorMessage, hasStaleData: hadSuccessfulData };
    }
  }, []);

  async function monitorGeneration(context, initialProgress = null, epoch = ++generationPollEpochRef.current) {
    if (!isCurrentGeneration(context, epoch)) return { status: 'stale' };
    setGenerationStatus('running');
    setGenerationError('');
    setGenerating(true);
    const deadline = Date.now() + 10 * 60 * 1000;
    let progress = initialProgress;
    let consecutiveErrors = 0;
    try {
      while (Date.now() < deadline) {
        if (!isCurrentContext(context)) return { status: 'stale' };
        if (!isCurrentGeneration(context, epoch)) return { status: 'stale' };
        if (!progress) {
          try {
            progress = await api.deepProfileProgress(context.jobId);
            if (!isCurrentGeneration(context, epoch)) return { status: 'stale' };
            consecutiveErrors = 0;
          } catch (error) {
            if (!isCurrentGeneration(context, epoch)) return { status: 'stale' };
            consecutiveErrors += 1;
            if (consecutiveErrors >= 5) {
              const errorMessage = `连续无法读取任务状态：${deepProfileErrorMessage(error)}`;
              setGenerationStatus('unknown');
              setGenerationError(errorMessage);
              return { status: 'unknown', error: errorMessage };
            }
            await sleep(2000);
            continue;
          }
        }
        if (progress.status === 'running') {
          progress = null;
          await sleep(2000);
          continue;
        }
        if (progress.status === 'error') {
          const errorMessage = deepProfileErrorMessage(progress.error || '任务已失败');
          setGenerationStatus('error');
          setGenerationError(errorMessage);
          return { status: 'error', error: errorMessage };
        }
        if (progress.status === 'done') {
          setGenerationStatus('done');
          setGenerationError('');
          return { status: 'done' };
        }
        const errorMessage = `生成任务状态丢失或服务已重启（${progress.status || 'unknown'}），请先重试读取任务状态。`;
        setGenerationStatus('unknown');
        setGenerationError(errorMessage);
        return { status: 'unknown', error: errorMessage };
      }
      if (!isCurrentGeneration(context, epoch)) return { status: 'stale' };
      const errorMessage = '生成画像等待超过 10 分钟，已停止轮询；请重试读取任务状态。';
      setGenerationStatus('unknown');
      setGenerationError(errorMessage);
      return { status: 'unknown', error: errorMessage };
    } finally {
      if (isCurrentGeneration(context, epoch)) setGenerating(false);
    }
  }

  async function bootstrapGenerationRecovery(context, epoch) {
    if (READONLY_UI) {
      if (isCurrentGeneration(context, epoch)) setGenerationStatus('readonly');
      await reload(context);
      return;
    }

    let progress;
    try {
      progress = await api.deepProfileProgress(context.jobId);
      if (!isCurrentGeneration(context, epoch)) return;
    } catch (error) {
      if (!isCurrentGeneration(context, epoch)) return;
      setGenerationStatus('unknown');
      setGenerationError(`生成任务状态读取失败：${deepProfileErrorMessage(error)}`);
      await reload(context);
      return;
    }

    if (progress.status === 'running') {
      setGenerationStatus('running');
      setGenerationError('');
    } else if (progress.status === 'error') {
      setGenerationStatus('error');
      setGenerationError(deepProfileErrorMessage(progress.error || '任务已失败'));
    } else if (progress.status === 'done') {
      setGenerationStatus('done');
      setGenerationError('');
    } else if (progress.status === 'idle') {
      setGenerationStatus('idle');
      setGenerationError('');
    } else {
      setGenerationStatus('unknown');
      setGenerationError(`无法确认生成任务状态（${progress.status || 'unknown'}）。`);
    }

    await reload(context);
    if (!isCurrentGeneration(context, epoch) || progress.status !== 'running') return;
    const result = await monitorGeneration(context, progress, epoch);
    if (result.status === 'done' && isCurrentGeneration(context, epoch)) {
      await refreshAfterCommittedAction(context, '深度画像已生成', '深度画像生成已完成，已读取最新画像。');
    }
  }

  useEffect(() => {
    const recoveryEpoch = ++generationPollEpochRef.current;
    generationAttemptRef.current = null;
    setInterviews([]);
    setConfig(null);
    setGenerationReadiness(null);
    setExternalAiAccess(null);
    setIvText('');
    setIvUrl('');
    setSourceType('offline_recording');
    setLarkCapability(null);
    setSavingIv(false);
    setGenerating(false);
    setGenerationStatus(READONLY_UI ? 'readonly' : (open && jobId ? 'checking' : 'idle'));
    setGenerationError('');
    setLoadState(open && jobId ? 'loading' : 'idle');
    setLoadError('');
    setHasLoadedSuccessfully(false);
    setCommittedRefresh(null);
    loadedContextRef.current = '';
    if (open && jobId) {
      const context = profileContextRef.current;
      void bootstrapGenerationRecovery(context, recoveryEpoch);
    }
    return () => {
      generationPollEpochRef.current += 1;
      generationAttemptRef.current = null;
    };
  }, [open, jobId, reload]);

  const displayReady = hasLoadedSuccessfully && loadedContextRef.current === contextKey;
  const committedForContext = committedRefresh?.contextKey === contextKey ? committedRefresh : null;
  const writeLocked = readOnly || READONLY_UI || !displayReady || loadState !== 'ready' || !!committedForContext;
  const writeLockReason = readOnly || READONLY_UI
    ? '当前为只读模式，不能修改访谈或深度画像。'
    : committedForContext
      ? '上次操作已提交但页面尚未刷新，请先重试读取，勿重复提交。'
      : loadState === 'loading'
        ? '正在读取深度画像状态，请稍候。'
        : '深度画像状态尚未读取成功，请先重试读取。';

  async function refreshAfterCommittedAction(context, committedLabel, successText) {
    const refreshed = await reload(context);
    if (!isCurrentContext(context) || refreshed.stale) return false;
    if (refreshed.ok) {
      setCommittedRefresh(null);
      if (successText) message.success(successText);
      return true;
    }
    setCommittedRefresh({
      kind: 'committed',
      contextKey: context.key,
      label: committedLabel,
      error: refreshed.error || '最新数据读取失败。',
    });
    return false;
  }

  async function retryRead() {
    const context = profileContextRef.current;
    const pending = committedForContext;
    let refreshPending = pending;
    if (pending?.kind === 'generation-status') {
      if (READONLY_UI) return;
      setLoadState('loading');
      setLoadError('');
      try {
        const progress = await api.deepProfileProgress(context.jobId);
        if (!isCurrentContext(context)) return;
        if (progress.status === 'running') {
          const error = '生成任务仍在运行；没有再次发起任务。请稍后继续重试读取。';
          setLoadState('error');
          setLoadError(error);
          setCommittedRefresh({ ...pending, error });
          return;
        }
        if (progress.status === 'error') {
          setCommittedRefresh(null);
          await reload(context);
          if (isCurrentContext(context)) message.error(`生成画像失败：${progress.error || '任务已失败'}`);
          return;
        }
        if (progress.status !== 'done') throw new Error(`生成任务状态仍不可确认（${progress.status || 'unknown'}）`);
        refreshPending = {
          kind: 'committed',
          contextKey: context.key,
          label: '深度画像已生成',
          error: '最新数据尚未读取。',
        };
        setCommittedRefresh(refreshPending);
      } catch (error) {
        if (!isCurrentContext(context)) return;
        const errorMessage = error?.message || '生成任务状态仍不可读。';
        setLoadState('error');
        setLoadError(errorMessage);
        setCommittedRefresh({ ...pending, error: errorMessage });
        return;
      }
    }
    const refreshed = await reload(context);
    if (!isCurrentContext(context) || refreshed.stale) return;
    if (refreshed.ok) {
      setCommittedRefresh(null);
      message.success('深度画像最新数据已读取。');
    } else if (refreshPending) {
      setCommittedRefresh({ ...refreshPending, error: refreshed.error || refreshPending.error });
    }
  }

  async function retryGenerationProgress() {
    if (READONLY_UI) return;
    const context = profileContextRef.current;
    const epoch = ++generationPollEpochRef.current;
    setGenerationStatus('checking');
    setGenerationError('');
    let progress;
    try {
      progress = await api.deepProfileProgress(context.jobId);
      if (!isCurrentGeneration(context, epoch)) return;
    } catch (error) {
      if (!isCurrentGeneration(context, epoch)) return;
      setGenerationStatus('unknown');
      setGenerationError(`生成任务状态读取失败：${deepProfileErrorMessage(error)}`);
      return;
    }

    if (progress.status === 'running') {
      const result = await monitorGeneration(context, progress, epoch);
      if (result.status === 'done' && isCurrentGeneration(context, epoch)) {
        await refreshAfterCommittedAction(context, '深度画像已生成', '深度画像生成已完成，已读取最新画像。');
      }
      return;
    }
    if (progress.status === 'done') {
      setGenerationStatus('done');
      await reload(context);
      return;
    }
    if (progress.status === 'error') {
      setGenerationStatus('error');
      setGenerationError(deepProfileErrorMessage(progress.error || '任务已失败'));
      return;
    }
    if (progress.status === 'idle') {
      setGenerationStatus('idle');
      setGenerationError('');
      return;
    }
    setGenerationStatus('unknown');
    setGenerationError(`无法确认生成任务状态（${progress.status || 'unknown'}）。`);
  }

  async function handleSaveInterview() {
    if (writeLocked) { message.warning(writeLockReason); return; }
    if (!ivText.trim()) { message.warning('先粘贴已有的访谈转写文本。'); return; }
    const context = profileContextRef.current;
    setSavingIv(true);
    let committed = false;
    try {
      await postInterviewAction('/interview', {
        jobId: context.jobId,
        transcript: ivText,
        sourceType,
        note: MATERIAL_SOURCES[sourceType].note,
      });
      committed = true;
      if (!isCurrentContext(context)) return;
      setIvText('');
      await refreshAfterCommittedAction(
        context,
        `${MATERIAL_SOURCES[sourceType].label}已保存`,
        `${MATERIAL_SOURCES[sourceType].label}已保存。`,
      );
    } catch (err) {
      if (isCurrentContext(context) && !committed) message.error(err.message || '访谈材料未保存。');
    } finally {
      if (isCurrentContext(context)) setSavingIv(false);
    }
  }

  async function handleImportLark() {
    if (writeLocked) { message.warning(writeLockReason); return; }
    if (!ivUrl.trim()) { message.warning('先粘贴飞书妙记链接。'); return; }
    const context = profileContextRef.current;
    setSavingIv(true);
    let committed = false;
    try {
      await postInterviewAction('/interview/import-lark', {
        jobId: context.jobId,
        sourceUrl: ivUrl.trim(),
        note: MATERIAL_SOURCES.lark_minutes.note,
      });
      committed = true;
      if (!isCurrentContext(context)) return;
      setIvUrl('');
      await refreshAfterCommittedAction(context, '飞书妙记转写已导入', '飞书妙记转写已导入。');
    } catch (err) {
      if (isCurrentContext(context) && !committed) {
        if (/默认关闭|ENABLE_LARK_IMPORT/.test(err.message)) message.warning(err.message);
        else message.error(err.message);
      }
    } finally {
      if (isCurrentContext(context)) setSavingIv(false);
    }
  }

  async function handleGenerate(options = {}) {
    if (writeLocked) { message.warning(writeLockReason); return; }
    if (generationReadiness?.ready !== true) {
      message.warning(generationReadiness?.message || '暂时无法确认生成前置条件，请重试读取。');
      return;
    }
    if (
      options.skipCapabilityCheck !== true
      && (externalAiAccess?.readable !== true || externalAiAccess?.config?.capabilities?.deep_profile !== true)
    ) {
      setAiFirstUseError(externalAiAccess?.readable === false ? externalAiAccess.error : '');
      setAiFirstUseOpen(true);
      return;
    }
    const context = profileContextRef.current;
    if (generationStatus === 'checking' || generationStatus === 'unknown') {
      message.warning('生成任务状态尚未确认，请先重试读取任务状态。');
      return;
    }
    if (generationAttemptRef.current?.contextKey === context.key) return;
    const attempt = { contextKey: context.key };
    generationAttemptRef.current = attempt;
    setGenerating(true);
    let generationStarted = false;
    let generationCommitted = false;
    let terminalFailure = false;
    try {
      const progressEpoch = ++generationPollEpochRef.current;
      setGenerationStatus('checking');
      setGenerationError('');
      let p;
      try {
        p = await api.deepProfileProgress(context.jobId);
      } catch (error) {
        if (!isCurrentGeneration(context, progressEpoch)) return;
        setGenerationStatus('unknown');
        setGenerationError(`生成任务状态读取失败：${deepProfileErrorMessage(error)}`);
        return;
      }
      if (!isCurrentGeneration(context, progressEpoch)) return;
      if (p.status === 'running') {
        p = await monitorGeneration(context, p, progressEpoch);
        if (p.status === 'done') {
          generationCommitted = true;
          await refreshAfterCommittedAction(context, '深度画像已生成', '深度画像生成已完成，已读取最新画像。');
        }
        return;
      }
      if (!['idle', 'done', 'error'].includes(p.status)) {
        setGenerationStatus('unknown');
        setGenerationError(`无法确认生成任务状态（${p.status || 'unknown'}）。`);
        return;
      }
      setGenerationStatus(p.status);
      if (p.status !== 'error') setGenerationError('');

      const requestId = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `deep-profile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const approval = await api.confirmExternalAiApproval('deep-profile', context.jobId, requestId, { jobId: context.jobId });
      if (!isCurrentContext(context)) return;
      if (!approval.approved) return;
      try {
        await api.generateDeepProfile(context.jobId, { requestId, userApproval: approval.userApproval });
        generationStarted = true;
      } catch (err) {
        if (err?.status !== 409 || !/生成中/.test(err.message)) throw err;
        generationStarted = true;
      }
      if (!isCurrentContext(context)) return;
      p = await monitorGeneration(context, { status: 'running' }, progressEpoch);
      if (p.status === 'error') {
        terminalFailure = true;
        throw new Error(p.error || '任务已失败');
      }
      if (p.status === 'done') {
        generationCommitted = true;
        await refreshAfterCommittedAction(context, '深度画像已生成', '深度画像已生成。');
      } else if (p.status === 'unknown') {
        throw new Error(p.error || '任务状态暂不可读。');
      }
    } catch (err) {
      if (isCurrentContext(context)) {
        const safeErrorMessage = deepProfileErrorMessage(err);
        if (generationCommitted) {
          setCommittedRefresh({
            kind: 'committed',
            contextKey: context.key,
            label: '深度画像已生成',
            error: safeErrorMessage,
          });
        } else if (generationStarted && !terminalFailure) {
          const errorMessage = safeErrorMessage || '任务状态暂不可读。';
          setGenerationStatus('unknown');
          setGenerationError(errorMessage);
        } else {
          const requiresNewApproval = err?.code === 'external_ai_confirmation_required'
            || /确认.*(?:过期|无效|不一致)|材料.*(?:变化|不一致)/.test(safeErrorMessage);
          setGenerationStatus('error');
          setGenerationError(requiresNewApproval
            ? `${safeErrorMessage} 当前材料未自动重放，请重新确认并生成。`
            : safeErrorMessage);
        }
      }
    } finally {
      if (generationAttemptRef.current === attempt) generationAttemptRef.current = null;
      if (isCurrentContext(context)) setGenerating(false);
    }
  }

  // Only the plain regenerate path voids a live confirmation: the stale path
  // builds a new version rather than discarding a current one, and the error
  // path is a retry. Confirming just that case keeps the dialog meaningful.
  async function requestDeepProfileGeneration() {
    const voidsConfirmation = generationStatus !== 'error' && !staleDeep && Boolean(deep);
    if (!voidsConfirmation) {
      await startDeepProfileGeneration();
      return;
    }
    let confirmed = false;
    modal.confirm({
      title: '重新生成深度画像？',
      content: '当前已确认的深度画像会作废，基于它的评分、AI 第二意见与面试脚本都需要重新确认。生成后无法撤销。',
      okText: '确认重新生成',
      cancelText: '取消',
      okButtonProps: { danger: true },
      // onOk only records the decision. Generation starts from afterClose so
      // this dialog has fully closed and handed focus back to the trigger
      // first — the flow can open its own dialog (external AI first use), and
      // two focus restorations running at once leave focus nowhere useful.
      // Starting here also keeps the dialog from sitting in a loading state
      // for a run that takes minutes and reports its own progress.
      onOk: () => { confirmed = true; },
      afterClose: () => { if (confirmed) void startDeepProfileGeneration(); },
    });
  }

  async function startDeepProfileGeneration() {
    if (writeLocked || generationReadiness?.ready !== true || generationProgressLocked || aiCapabilityChecking) {
      await handleGenerate();
      return;
    }
    setAiCapabilityChecking(true);
    const access = await readExternalAiCapability('deep_profile');
    setAiCapabilityChecking(false);
    if (access.available) {
      setExternalAiAccess(access);
      await handleGenerate({ skipCapabilityCheck: true });
      return;
    }
    setAiFirstUseError(access.readable ? '' : access.error);
    setAiFirstUseOpen(true);
  }

  function continueDeepProfileManually() {
    setAiFirstUseOpen(false);
    message.info('访谈材料仍保留在本机。可继续补充和核对材料，不启用 AI 也不影响岗位与候选人主流程。');
    globalThis.setTimeout(() => dialogInitialFocusRef.current?.focus(), 0);
  }

  async function openDeepProfileAiSettings(options = {}) {
    setAiFirstUseOpen(false);
    await onOpenAiSettings?.({
      capability: 'deep_profile',
      source: 'deep-profile',
      sourceLabel: '深度岗位画像',
      targetId: jobId,
      targetLabel: jobName,
      focusTargetId: 'deep-profile-ai-action',
      resumeAction: options.resumeAction !== false,
      draftSnapshot: {
        ivText,
        ivUrl,
        sourceType,
      },
    });
  }

  const deep = config && config.deep_profile;
  const staleDeep = deep && deep.stale_for_active_jd === true;
  const externalAiOperational = externalAiAccess?.readable === true
    && externalAiAccess?.config?.capabilities?.deep_profile === true;
  const generationProgressLocked = ['checking', 'running', 'unknown'].includes(generationStatus);
  const generationLocked = writeLocked || generationReadiness?.ready !== true
    || generationProgressLocked;
  const generationPrerequisiteId = generationReadiness?.ready === false
    ? 'deep-profile-generation-prerequisite'
    : !externalAiOperational
      ? 'deep-profile-external-ai-prerequisite'
      : generationProgressLocked
        ? 'deep-profile-generation-progress'
        : undefined;
  const larkEnabled = larkCapability?.enabled === true;
  const larkStatusLoading = larkCapability === null;
  const larkStatusUnavailable = larkCapability?.status === 'unavailable';
  const documentContext = profileContextRef.current;

  useEffect(() => {
    if (
      aiResumeIntent?.capability !== 'deep_profile'
      || String(aiResumeIntent.targetId) !== String(jobId)
      || !open
      || loadState !== 'ready'
    ) return;
    const intent = aiResumeIntent;
    const snapshot = intent.draftSnapshot && typeof intent.draftSnapshot === 'object'
      ? intent.draftSnapshot
      : null;
    if (snapshot) {
      setIvText(String(snapshot.ivText || ''));
      setIvUrl(String(snapshot.ivUrl || ''));
      setSourceType(String(snapshot.sourceType || 'offline_recording'));
    }
    onAiResumeConsumed?.(intent.id);
    globalThis.setTimeout(() => {
      const target = globalThis.document?.getElementById(intent.focusTargetId || 'deep-profile-ai-action');
      target?.focus?.({ preventScroll: false });
      target?.scrollIntoView?.({ block: 'nearest' });
      if (intent.resumeAction !== false && externalAiOperational && !generationProgressLocked) {
        void handleGenerate({ skipCapabilityCheck: true });
      }
    }, 0);
  }, [
    aiResumeIntent?.id,
    jobId,
    open,
    loadState,
    externalAiOperational,
    generationProgressLocked,
  ]);

  return (
    <Modal
      title={<>访谈与深度画像 · {jobName}</>}
      open={open}
      onCancel={onClose}
      keyboard
      afterOpenChange={(visible) => {
        if (!visible) return;
        const focusDialogIntroduction = () => dialogInitialFocusRef.current?.focus();
        if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(focusDialogIntroduction);
        else globalThis.setTimeout(focusDialogIntroduction, 0);
      }}
      footer={null}
      width={880}
      styles={{ body: { maxHeight: '78vh', overflow: 'auto', overscrollBehavior: 'contain', scrollbarGutter: 'stable' } }}
    >
      <div
        ref={dialogInitialFocusRef}
        className="deep-profile-modal-introduction"
        tabIndex={-1}
        autoFocus
        aria-label="访谈与深度画像说明"
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          把和用人部门负责人聊「要招什么人」的访谈转写丢进来，AI 会整理成一份 HR 能照着筛简历的深度画像。生成后复制给负责人核对确认。
        </Text>
      </div>

      {(readOnly || READONLY_UI) && (
        <Alert
          type="warning"
          showIcon
          message="当前为只读查看"
          description="既有负责人访谈和深度画像仍会从本地主库读取；保存、导入、生成、确认和补答等写操作已锁定。"
          style={{ marginBottom: 12 }}
        />
      )}

      {!displayReady && loadState !== 'error' && (
        <Alert
          type="info"
          showIcon
          message="正在读取访谈与深度画像"
          description="读取完成前不会显示空材料或未生成状态，也不会开放保存、导入、生成或确认动作。"
        />
      )}
      {!displayReady && loadState === 'error' && (
        <Alert
          type="error"
          showIcon
          message="访谈与深度画像读取失败"
          description={`${loadError} 当前状态未知，未将它显示为空数据，所有写操作保持锁定。`}
          action={<Button loading={loadState === 'loading'} onClick={retryRead}>重试读取</Button>}
        />
      )}
      {displayReady && committedForContext && (
        <Alert
          type="warning"
          showIcon
          message={`${committedForContext.label}，但最新数据刷新失败`}
          description={`${committedForContext.error} 当前保留上次成功数据，请勿重复提交；“重试读取”只会读取最新状态，不会重放原操作。`}
          action={<Button loading={loadState === 'loading'} onClick={retryRead}>重试读取</Button>}
          style={{ marginBottom: 12 }}
        />
      )}
      {displayReady && !committedForContext && loadState === 'error' && (
        <Alert
          type="warning"
          showIcon
          message="最新数据刷新失败，当前显示上次成功数据"
          description={`${loadError} 为避免基于陈旧状态写入，保存、导入、生成、确认和补答暂时锁定。`}
          action={<Button onClick={retryRead}>重试读取</Button>}
          style={{ marginBottom: 12 }}
        />
      )}
      {displayReady && loadState === 'loading' && (
        <Alert
          type="info"
          showIcon
          message="正在刷新最新数据"
          description="当前继续显示上次成功数据；刷新完成前写操作暂时锁定。"
          style={{ marginBottom: 12 }}
        />
      )}

      {displayReady && <>
      <Title level={5}>访谈材料（{interviews.length} 条）</Title>
      {interviews.length ? (
        <Collapse
          bordered={false}
          items={interviews.map((iv, i) => ({
            key: i,
            label: (
              <Space wrap>
                <span>{iv.note || '负责人访谈'} · {fmtTime(iv.created_at)} · {iv.transcript.length} 字</span>
                <Tag>{interviewSourceLabel(iv.source_type)}</Tag>
              </Space>
            ),
            children: (
              <div className="resume-text">
                {iv.transcript.length > 3000 ? `${iv.transcript.slice(0, 3000)}……（此处仅截断显示，生成画像时会用全文）` : iv.transcript}
              </div>
            ),
          }))}
        />
      ) : (
        <div className="empty-box">还没有访谈材料。和负责人聊一次「这个岗位要招什么人」，把转写全文粘贴进来。</div>
      )}

      <Title level={5} style={{ marginTop: 16 }}>添加访谈</Title>
      <Text strong style={{ display: 'block', marginBottom: 8 }}>1. 选择材料来源</Text>
      <Segmented
        block
        options={Object.entries(MATERIAL_SOURCES).map(([value, item]) => ({ value, label: item.label }))}
        value={sourceType}
        disabled={writeLocked}
        onChange={setSourceType}
      />
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
        {MATERIAL_SOURCES[sourceType].hint}
      </Text>
      <Text strong style={{ display: 'block', margin: '12px 0 8px' }}>2. 添加材料</Text>
      {sourceType === 'lark_minutes' ? (
        <>
          <Alert
            type={larkEnabled ? 'success' : larkStatusLoading ? 'info' : larkStatusUnavailable ? 'error' : 'warning'}
            showIcon
            message={larkEnabled
              ? '线上会议导入已启用'
              : larkStatusLoading
                ? '正在确认线上会议导入状态'
                : larkStatusUnavailable
                  ? '无法确认线上会议导入状态'
                  : '本地演示模式未启用外部会议导入'}
            description={larkEnabled
              ? '只有点击下方导入按钮才会请求飞书妙记；粘贴链接和保存画像不会触发导入。'
              : larkStatusLoading
                ? '状态确认完成前不会开放导入动作。'
                : '入口保留用于展示能力边界。当前请切换到“线下录音”或“手动粘贴转写”；如需启用，请联系管理员完成会议导入设置并重启应用。'}
            style={{ marginBottom: 8 }}
          />
          <Input
            aria-label="飞书妙记链接"
            name="deep-profile-lark-minutes-url"
            autoComplete="off"
            placeholder="粘贴飞书妙记链接"
            value={ivUrl}
            disabled={writeLocked}
            onChange={(e) => setIvUrl(e.target.value)}
          />
          <div style={{ marginTop: 8 }}>
            <Button type="primary" disabled={writeLocked || !larkEnabled} loading={savingIv} onClick={handleImportLark}>从飞书妙记导入转写</Button>
          </div>
        </>
      ) : (
        <>
          <TextArea
            aria-label={`${MATERIAL_SOURCES[sourceType].label}内容`}
            name="deep-profile-interview-material"
            autoComplete="off"
            rows={6}
            placeholder={MATERIAL_SOURCES[sourceType].placeholder}
            value={ivText}
            disabled={writeLocked}
            onChange={(e) => setIvText(e.target.value)}
          />
          <div style={{ marginTop: 8 }}>
            <Button disabled={writeLocked} loading={savingIv} onClick={handleSaveInterview}>保存{MATERIAL_SOURCES[sourceType].label}</Button>
          </div>
        </>
      )}

      <div style={{ marginTop: 16 }}>
        {generationStatus === 'checking' && (
          <Alert
            id="deep-profile-generation-progress"
            type="info"
            showIcon
            message="正在确认是否已有生成任务"
            description="确认完成前不会再次发起任务或请求外部 AI 授权。"
            style={{ marginBottom: 10 }}
          />
        )}
        {generationStatus === 'running' && (
          <Alert
            id="deep-profile-generation-progress"
            type="info"
            showIcon
            message="已恢复当前岗位正在生成的画像"
            description="正在继续读取原任务进度；关闭后重新打开仍会接管，不会重复确认授权或再次发起生成。"
            style={{ marginBottom: 10 }}
          />
        )}
        {generationStatus === 'unknown' && (
          <Alert
            id="deep-profile-generation-progress"
            type="error"
            showIcon
            message="生成任务状态暂时无法确认"
            description={`${generationError} 为避免重复任务，生成保持禁用；重试只读取本机任务状态，不会重新生成。`}
            action={<Button onClick={retryGenerationProgress}>重试读取任务状态</Button>}
            style={{ marginBottom: 10 }}
          />
        )}
        {generationStatus === 'error' && (
          <Alert
            type="warning"
            showIcon
            message="上次深度画像生成未完成"
            description={(readOnly || READONLY_UI)
              ? `${generationError || '任务已失败。'} 已有访谈和历史画像仍保留；当前仅可查看历史。${READONLY_UI ? '退出操作只读模式后再处理。' : '请在可写的正式开放岗位中处理。'}`
              : `${generationError || '任务已失败。'} 已有访谈和历史画像仍保留；系统不会自动重放材料或外部调用。确认当前材料后，可点击“重新确认并生成”。`}
            style={{ marginBottom: 10 }}
          />
        )}
        {generationReadiness?.ready === false && (
          <Alert
            id="deep-profile-generation-prerequisite"
            type={generationReadiness.code === 'JOB_INTERVIEW_REQUIRED' ? 'info' : 'warning'}
            showIcon
            message="生成前还需完成准备"
            description={generationReadiness.message}
            style={{ marginBottom: 10 }}
          />
        )}
        {generationReadiness?.ready === true && !externalAiOperational && (
          <Alert
            id="deep-profile-external-ai-prerequisite"
            type="warning"
            showIcon
            message="外部 AI 尚未可用"
            description={externalAiAccess?.readable === false
              ? `${externalAiAccess.error}。生成动作保持禁用；访谈材料仍可在本机保存。`
              : `${(externalAiAccess?.config?.blockers || []).join(' ')} 请先完成配置并验证模型；系统不会自动发送材料。`}
            action={onOpenAiSettings ? <Button onClick={() => openDeepProfileAiSettings({ resumeAction: false })}>打开外部 AI 设置</Button> : null}
            style={{ marginBottom: 10 }}
          />
        )}
        <div className="deep-profile-action-bar">
          <Button
            id="deep-profile-ai-action"
            type="primary"
            disabled={generationLocked}
            aria-describedby={generationPrerequisiteId}
            loading={generating || aiCapabilityChecking}
            onClick={requestDeepProfileGeneration}
          >
            {generationStatus === 'error'
              ? '重新确认并生成'
              : staleDeep
                ? '基于当前已确认画像生成新版深度画像'
                : deep
                  ? '重新生成画像（旧的确认状态会作废）'
                  : '生成深度画像'}
          </Button>
        </div>
      </div>

      {staleDeep && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message="下面是历史深度画像，不再参与当前评分、AI 第二意见或面试脚本"
          description="请先确认当前 JD 对应的简版岗位画像，再生成新版深度画像。历史内容仅供追溯。"
        />
      )}

      {deep ? (
        <DeepDoc
          key={`${jobId}:${deep.version}`}
          deep={deep}
          jobName={jobName}
          jobId={jobId}
          writeLocked={writeLocked}
          writeLockReason={writeLockReason}
          onCommittedAction={(committedLabel, successText) => refreshAfterCommittedAction(
            documentContext,
            committedLabel,
            successText,
          )}
        />
      ) : (
        <Text type="secondary" style={{ display: 'block', marginTop: 14 }}>还没生成过画像。保存访谈后点上面的按钮。</Text>
      )}
      <ExternalAiFirstUsePrompt
        open={aiFirstUseOpen}
        capability="deep_profile"
        readError={aiFirstUseError}
        onEnable={openDeepProfileAiSettings}
        onManual={continueDeepProfileManually}
        onClose={() => {
          setAiFirstUseOpen(false);
          globalThis.setTimeout(() => globalThis.document?.getElementById('deep-profile-ai-action')?.focus(), 0);
        }}
      />
      </>}
    </Modal>
  );
}
