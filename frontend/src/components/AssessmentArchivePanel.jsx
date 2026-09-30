import React, { useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Empty, Input, Modal, Progress, Select, Skeleton, Space, Spin, Tag, Typography } from 'antd';
import { api, assessmentPreviewUrl, fmtTime, READONLY_UI } from '../api.js';
import ExternalAiFirstUsePrompt, {
  readExternalAiCapability,
} from './ExternalAiFirstUsePrompt.jsx';

const { Text, Title } = Typography;
const REPORT_OPTIONS = [
  { value: 'career_potential', label: '职业潜力报告' },
  { value: 'workplace_style', label: '职场风格报告' },
  { value: 'team_role', label: '团队角色报告' },
  { value: 'unknown', label: '自动识别（推荐）' },
];
const CLASSIFIABLE_REPORT_OPTIONS = REPORT_OPTIONS.filter((item) => item.value !== 'unknown');
const REPORT_LABELS = Object.fromEntries(REPORT_OPTIONS.map((item) => [item.value, item.label]));

function requestId(prefix) {
  const id = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${id}`;
}

function stateColor(state) {
  if (state === 'active' || state === 'accepted' || state === 'ready' || state === 'none') return 'green';
  if (state === 'pending') return 'gold';
  if (state === 'revoked' || state === 'rejected' || state === 'deleted') return 'default';
  return 'orange';
}

function analysisState(row) {
  if (row?.analysis_status === 'ready' && row?.report_type === 'unknown') {
    return { color: 'gold', label: '未识别' };
  }
  return { color: stateColor(row?.analysis_status), label: row?.analysis_status || 'pending' };
}

function retentionDue(row) {
  return Boolean(row?.delete_after && Number.isFinite(Date.parse(row.delete_after)) && Date.parse(row.delete_after) <= Date.now());
}

function assessmentNameMismatch(row, candidate) {
  const candidateName = String(candidate && candidate.name || '').replace(/\s+/g, '').trim().toLocaleLowerCase();
  const reportName = String(row && row.analysis && row.analysis.subject_name || '').replace(/\s+/g, '').trim().toLocaleLowerCase();
  return Boolean(candidateName && reportName && candidateName !== reportName);
}

function assessmentAnalysisFailure(row) {
  const code = String(row?.analysis_error_code || '');
  if (code === 'ASSESSMENT_REPORT_OCR_UNAVAILABLE') {
    return '扫描型 PDF 已安全保存，但本机没有可用的本地 OCR；请根据原文件封面手动选择报告类型，确认绑定后可查看 PNG 预览。';
  }
  if (code === 'ASSESSMENT_REPORT_OCR_EMPTY') {
    return '已运行本地 OCR，但页面清晰度不足或没有识别到可用文字；请根据原文件封面手动选择报告类型，或重新扫描后导入。';
  }
  if (code === 'ASSESSMENT_REPORT_OCR_PAGE_LIMIT') {
    return '报告页数超过本地 OCR 单次处理上限；文件已保存，可以手动选择报告类型，或拆分后重新导入。';
  }
  if (code === 'ASSESSMENT_REPORT_OCR_TIMEOUT') {
    return '本地 OCR 处理超时；文件已保存，可以手动选择报告类型，或稍后重新导入。';
  }
  return '文件已保存但报告文字分析未完成；请根据原文件封面手动选择报告类型，确认绑定后可查看 PNG 预览。';
}

function AssessmentAnalysis({ row, candidate }) {
  const analysis = row.analysis;
  if (row.report_type === 'unknown' && row.analysis_status === 'ready') {
    return (
      <Alert
        type="warning"
        showIcon
        message="未识别报告类型"
        description="文件已受控归档，但不会进入组合分析或外部 AI 证据。请在下方人工选择报告类型，再单独确认绑定。"
      />
    );
  }
  if (!analysis) {
    if (row.analysis_status === 'failed') return <Alert type="warning" showIcon message="报告文字识别未完成" description={assessmentAnalysisFailure(row)} />;
    return <Text type="secondary">正在提取报告类型和核心结论…</Text>;
  }
  const candidateName = String(candidate && candidate.name || '').trim();
  const reportName = String(analysis.subject_name || '').trim();
  const nameMismatch = assessmentNameMismatch(row, candidate);
  return (
    <div style={{ display: 'grid', gap: 8, padding: '10px 12px', background: '#f6fffb', border: '1px solid #b7eb8f', borderRadius: 8 }}>
      {nameMismatch && (
        <Alert
          type="warning"
          showIcon
          message={`报告姓名“${reportName}”与当前候选人“${candidateName}”不一致`}
          description="系统会要求当前 HR 明确确认姓名不一致后才能绑定，不需要第二审批人。"
        />
      )}
      <Text strong>自动提取结论</Text>
      {analysis.source === 'supplier_pdf_local_ocr' && <Tag color="blue">扫描 PDF · 本地 OCR</Tag>}
      <Text>{analysis.summary || '已识别报告，但未提取到摘要。'}</Text>
      <Space wrap>
        {analysis.subject_name && <Tag>受测者 {analysis.subject_name}</Tag>}
        {analysis.assessed_job && <Tag>报告岗位 {analysis.assessed_job}</Tag>}
        {analysis.validity && <Tag color={analysis.validity === '高' ? 'green' : 'gold'}>信效度 {analysis.validity}</Tag>}
      </Space>
      {(analysis.highlights || []).map((item) => (
        <div key={`${item.label}:${item.value}`}><Text type="secondary">{item.label}：</Text><Text>{item.value}</Text></div>
      ))}
    </div>
  );
}

function inferCareerCategory(candidate) {
  const title = `${candidate?.rec_position || ''} ${candidate?.job_name || ''} ${candidate?.position_name || ''}`;
  if (/销售|商务|客户开发|渠道/.test(title)) return '销售类';
  if (/运营|投放|市场|推广|增长|媒介|品牌/.test(title)) return '市场类';
  if (/客服|服务|人事|招聘|行政|支持/.test(title)) return '服务类';
  if (/研发|研究|产品|设计/.test(title)) return '研发类';
  if (/技术|工程|开发|数据|运维|测试/.test(title)) return '技术类';
  return null;
}

function AssessmentPortfolio({ archives, candidate }) {
  const analyzedReports = archives.filter((row) => (
    row.analysis_status === 'ready' && row.report_type !== 'unknown' && row.analysis
  ));
  const reports = analyzedReports.filter((row) => row.binding_state === 'active');
  if (!analyzedReports.length) return null;
  const activeCount = reports.length;
  const pendingCount = analyzedReports.filter((row) => row.binding_state === 'pending').length;
  if (!reports.length) {
    return (
      <Card title="候选人测评组合报告" extra={<Tag color="gold">待确认 {pendingCount}</Tag>}>
        <Alert type="info" showIcon message="等待 HR 确认绑定" description="单份报告已经完成解析；确认绑定后才会进入候选人组合画像和岗位匹配辅助材料，不改变列表排序。" />
      </Card>
    );
  }
  const category = inferCareerCategory(candidate);
  const careerMatches = reports.flatMap((row) => row.analysis.career_matches || []);
  const categoryMatches = category ? careerMatches.filter((item) => item.category === category) : careerMatches;
  const bestMatch = [...categoryMatches].sort((left, right) => Number(right.percentage) - Number(left.percentage))[0] || null;
  const profileItems = reports.flatMap((row) => (row.analysis.highlights || []).slice(0, 3));
  const questions = [...new Set(reports.flatMap((row) => row.analysis.interview_questions || []))].slice(0, 6);
  const watchouts = [...new Set(reports.flatMap((row) => row.analysis.watchouts || []))].slice(0, 5);
  const mismatches = reports
    .filter((row) => assessmentNameMismatch(row, candidate))
    .map((row) => row.analysis.subject_name);
  const score = bestMatch ? Math.round(Number(bestMatch.percentage) * 10) / 10 : null;
  const scoreLevel = score == null ? null : score >= 85 ? '高匹配' : score >= 70 ? '较高匹配' : score >= 55 ? '中等匹配' : '需重点核实';
  const reportTypes = [...new Set(reports.map((row) => REPORT_LABELS[row.report_type] || '未识别报告'))];
  const missingReportTypes = CLASSIFIABLE_REPORT_OPTIONS
    .filter((option) => !reports.some((row) => row.report_type === option.value))
    .map((option) => option.label);
  const validityLabels = [...new Set(reports.map((row) => row.analysis.validity).filter(Boolean))];

  return (
    <Card
      title="候选人测评组合报告"
      extra={<Space wrap><Tag>已确认 {activeCount}</Tag>{pendingCount > 0 && <Tag color="gold">待确认 {pendingCount}</Tag>}</Space>}
      styles={{ body: { display: 'grid', gap: 14 } }}
    >
      {pendingCount > 0 && <Alert type="info" showIcon message={`${pendingCount} 份待确认报告暂未计入以下组合结论`} />}
      <section className="assessment-evidence-overview" aria-labelledby="assessment-provider-evidence-title">
        <h3 id="assessment-provider-evidence-title">证据覆盖与限制</h3>
        <Space wrap>
          {reportTypes.map((label) => <Tag key={label}>已确认 · {label}</Tag>)}
          {validityLabels.map((label) => <Tag key={label}>报告信效度 {label}</Tag>)}
        </Space>
        <Text>以下组合只使用 HR 已确认绑定且已完成解析的供应商报告；待确认报告不会进入结论。</Text>
        <Text type="secondary">
          {missingReportTypes.length
            ? `当前未纳入已确认的${missingReportTypes.join('、')}；这表示证据覆盖不完整，不代表候选人能力不足。`
            : '三类供应商报告均已纳入；仍需结合简历与面试事实交叉核验。'}
        </Text>
      </section>

      <div className="assessment-evidence-grid">
        <section className="assessment-evidence-block assessment-evidence-block-warning">
          <h3>限制与风险</h3>
          <div className="assessment-evidence-items">
            {mismatches.length > 0 && <Text type="warning">报告受测者 {mismatches.join('、')} 与当前候选人 {candidate.name} 不一致；使用前必须先核对文件归属。</Text>}
            {watchouts.map((item) => <Text key={item}>• {item}</Text>)}
            {!mismatches.length && !watchouts.length && <Text type="secondary">暂未提取到明确风险提示；“未提取到”不等于不存在，仍应在面试中验证。</Text>}
          </div>
        </section>
        <section className="assessment-evidence-block assessment-evidence-block-info">
          <h3>需核验问题</h3>
          <div className="assessment-evidence-items">
            {questions.length ? questions.slice(0, 4).map((item, index) => <Text key={item}>{index + 1}. {item}</Text>) : <Text type="secondary">当前报告未生成验证题，请由 HR 根据岗位要求补充核验。</Text>}
          </div>
        </section>
      </div>

      <div className="assessment-evidence-grid">
        <section className="assessment-evidence-block">
          <h3>综合画像证据</h3>
          <div className="assessment-evidence-items">
            {profileItems.slice(0, 6).map((item, index) => (
              <div key={`${item.label}:${index}`}><Text type="secondary">{item.label}：</Text><Text>{item.value}</Text></div>
            ))}
            {!profileItems.length && <Text type="secondary">当前报告没有形成可展示的画像条目。</Text>}
          </div>
        </section>
        <section className="assessment-evidence-block">
          <h3>供应商职业方向数据</h3>
          <div className="assessment-evidence-items">
            {careerMatches.length ? [...careerMatches].sort((a, b) => b.percentage - a.percentage).slice(0, 5).map((item) => (
              <div key={`${item.category}:${item.name}`} className="assessment-career-match-row">
                <Text>{item.category} · {item.name}</Text><Text strong>{Number(item.percentage).toFixed(1)}%</Text>
              </div>
            )) : <Text type="secondary">当前报告不包含职业匹配百分比。</Text>}
          </div>
        </section>
      </div>

      {score != null ? (
        <section className="assessment-secondary-score" aria-label="供应商匹配数值参考">
          <div>
            <h3>供应商数值参考（次级）</h3>
            <Text type="secondary">{category ? `${category}岗位方向` : '职业方向最高值'} · 不参与默认排序</Text>
          </div>
          <div className="assessment-secondary-score-value">
            <strong>{score}</strong><span>/ 100</span><Tag>{scoreLevel}</Tag>
          </div>
          <Text>{bestMatch.category}{bestMatch.name} · 来源于供应商职业匹配百分比，仅供 HR 与其他证据交叉核验。</Text>
        </section>
      ) : (
        <Alert type="info" showIcon message="尚无可量化的供应商职业匹配百分比" description="缺少数值不降低候选人评级；请以岗位、简历和面试证据继续人工判断。" />
      )}
    </Card>
  );
}

const CONFIDENCE_LABELS = { high: '高', medium: '中', low: '低' };
const RECOMMENDATION_LABELS = {
  advance: '建议推进',
  hold: '建议暂缓核实',
  reject: '建议不推进',
  insufficient_evidence: '证据不足',
};

function assessmentAiReadiness(config, configError, readOnly) {
  if (readOnly) return { ready: false, title: '只读模式不能调用外部 AI', description: '' };
  if (configError) return { ready: false, title: 'AI 配置状态读取失败', description: configError };
  if (!config) return { ready: false, title: '正在读取 AI 配置', description: '读取完成后会显示具体缺少的步骤。' };
  if (!config.apiKeyConfigured) {
    return { ready: false, title: 'AI 分析暂不可用：尚未配置 API Key', description: '请到设置页填写并保存 API Key。' };
  }
  if (!config.model || config.modelVerified !== true) {
    return { ready: false, title: 'API Key 已配置；还需验证可用模型', description: '到设置页点击“验证可用模型”；当前模型有效时会立即恢复，否则重新选择后保存。' };
  }
  if (config.enabled !== true) {
    return { ready: false, title: '模型已验证；还需启用外部 AI', description: '到设置页点击“保存并启用”。实际发送候选人材料时仍会再次确认。' };
  }
  return { ready: true, title: 'AI 分析已可用', description: `将使用 ${config.model}；发送前仍会逐次确认。` };
}

function AssessmentAiAnalysisCard({
  analyses,
  busy,
  hasActiveReports,
  onGenerate,
  readOnly,
  aiConfig,
  aiConfigError,
  onOpenSettings,
  aiCapabilityChecking,
}) {
  const current = analyses.find((item) => item.current) || null;
  const latest = current || analyses[0] || null;
  const analysis = latest && latest.analysis;
  const readiness = assessmentAiReadiness(aiConfig, aiConfigError, readOnly);
  const evidenceSections = analysis ? [
    ['优势证据', analysis.strengths, 'assessment-evidence-block'],
    ['风险证据', analysis.risks, 'assessment-evidence-block assessment-evidence-block-warning'],
    ['材料矛盾', analysis.contradictions, 'assessment-evidence-block assessment-evidence-block-warning'],
  ] : [];
  const evidenceItems = analysis ? [
    ...(analysis.strengths || []),
    ...(analysis.risks || []),
    ...(analysis.contradictions || []),
    ...(analysis.interview_questions || []),
  ] : [];
  const citedEvidenceRefs = [...new Set(evidenceItems.flatMap((item) => item.evidence_refs || []))];
  const evidenceKinds = [
    ['J', '岗位'],
    ['R', '简历'],
    ['A', '已确认测评'],
    ['I', '已确认面试'],
  ];
  const coveredEvidenceKinds = evidenceKinds.filter(([prefix]) => citedEvidenceRefs.some((ref) => String(ref).startsWith(prefix)));
  const missingEvidenceKinds = evidenceKinds.filter(([prefix]) => !citedEvidenceRefs.some((ref) => String(ref).startsWith(prefix)));
  return (
    <Card
      title="AI 测评综合分析"
      extra={(
        <Button
          id="assessment-ai-analysis-action"
          type="primary"
          disabled={readOnly || busy || !hasActiveReports}
          loading={busy || aiCapabilityChecking}
          onClick={onGenerate}
          title={!hasActiveReports ? '请先确认至少一份测评报告绑定' : (!readiness.ready ? readiness.title : '')}
        >
          {current ? '重新生成 AI 分析' : '生成 AI 综合分析'}
        </Button>
      )}
      styles={{ body: { display: 'grid', gap: 12 } }}
    >
      {!hasActiveReports && <Alert type="info" showIcon message="请先人工确认至少一份测评报告绑定" />}
      {hasActiveReports && !readiness.ready && (
        <Alert
          type="warning"
          showIcon
          message={readiness.title}
          description={readiness.description}
          action={onOpenSettings ? <Button onClick={onOpenSettings}>{readOnly ? '查看 AI 配置状态' : '去完成 AI 配置'}</Button> : null}
        />
      )}
      {hasActiveReports && readiness.ready && !analysis && <Alert type="info" showIcon message={readiness.title} description={readiness.description} />}
      {latest && !latest.current && (
        <Alert type="warning" showIcon message="岗位、简历、面试或已确认测评材料已变化" description="下面是历史分析，仅供 HR 人工参考；如需当前分析请重新生成。" />
      )}
      {latest && latest.current && latest.ranking_eligible === false && (
        <Alert
          type="warning"
          showIcon
          message="当前 AI 结论为低置信度或证据不足"
          description="AI 内容仅供 HR 人工核验；测评缺失不降级，任何测评或 AI 分数都不改变默认排序。"
        />
      )}
      {!analysis ? (
        <Text type="secondary">点击生成后，AI 会联合分析已确认测评、当前岗位、在线简历和已确认面试报告；没有的材料会按证据不足处理。</Text>
      ) : (
        <>
          <section className="assessment-evidence-overview" aria-labelledby="assessment-ai-evidence-title">
            <h3 id="assessment-ai-evidence-title">证据覆盖、置信度与缺失材料</h3>
            <Space wrap>
              <Tag color={analysis.confidence === 'low' ? 'gold' : 'blue'}>AI 置信度 {CONFIDENCE_LABELS[analysis.confidence] || '低'}</Tag>
              {coveredEvidenceKinds.map(([, label]) => <Tag key={label}>已引用 · {label}</Tag>)}
            </Space>
            <Text type="secondary">
              {missingEvidenceKinds.length
                ? `当前结论未引用${missingEvidenceKinds.map(([, label]) => label).join('、')}；可能是材料未提供，或材料没有形成有效引用。`
                : '岗位、简历、已确认测评和已确认面试均形成了引用；引用齐全仍不代表结论无需人工核验。'}
            </Text>
            <Text type="secondary">证据引用：J=岗位，R=简历，A=已确认测评，I=已确认面试。</Text>
          </section>

          <section className="assessment-evidence-block assessment-evidence-block-warning">
            <h3>限制与需核验项</h3>
            <div className="assessment-evidence-items">
              <Text>• AI 只分析当前送入的结构化材料，未引用的材料不能视为已验证。</Text>
              {latest && !latest.current && <Text type="warning">• 当前显示历史分析；岗位或候选人材料已变化。</Text>}
              {(analysis.contradictions || []).length > 0 && <Text type="warning">• 存在 {analysis.contradictions.length} 项材料矛盾，需在面试中核对。</Text>}
              <Text>• 测评缺失不降级，AI 内容不会改变 SABC、默认排序，也不会自动录用或淘汰。</Text>
            </div>
          </section>

          <div className="assessment-evidence-grid">
            {evidenceSections.map(([title, items, className]) => (
              <section key={title} className={className}>
                <h3>{title}</h3>
                <div className="assessment-evidence-items">
                  {(items || []).length ? items.map((item, index) => (
                    <div key={`${title}:${index}`}>
                      <Text>• {item.point}</Text>
                      <div>{(item.evidence_refs || []).map((ref) => <Tag key={ref}>{ref}</Tag>)}</div>
                    </div>
                  )) : <Text type="secondary">暂无明确结论。</Text>}
                </div>
              </section>
            ))}
            <section className="assessment-evidence-block assessment-evidence-block-info">
              <h3>AI 面试核验题</h3>
              <div className="assessment-evidence-items">
                {(analysis.interview_questions || []).length ? analysis.interview_questions.map((item, index) => (
                  <div key={`ai-question:${index}`}>
                    <Text>{index + 1}. {item.question}</Text><br />
                    <Text type="secondary">重点听：{item.listen_for}</Text>
                    <div>{(item.evidence_refs || []).map((ref) => <Tag key={ref}>{ref}</Tag>)}</div>
                  </div>
                )) : <Text type="secondary">暂无核验题。</Text>}
              </div>
            </section>
          </div>

          <section className="assessment-secondary-score" aria-label="AI 匹配分次级参考">
            <div>
              <h3>AI 匹配分（次级参考）</h3>
              <Text type="secondary">不参与默认排序，仅供交叉核验</Text>
            </div>
            <div className="assessment-secondary-score-value"><strong>{analysis.fit_score}</strong><span>/ 100</span></div>
          </section>

          <section className="assessment-decision-support">
            <div className="assessment-decision-support-heading">
              <h3>HR 决策参考（证据核验后阅读）</h3>
              <Tag>{RECOMMENDATION_LABELS[analysis.decision_support?.recommendation] || '证据不足'}</Tag>
            </div>
            <Text>{analysis.overall}</Text>
            {analysis.decision_support?.reason && <Text type="secondary">参考理由：{analysis.decision_support.reason}</Text>}
            <Text type="secondary">最终推进、暂缓或淘汰仍须由 HR 结合完整材料人工决定。</Text>
          </section>
        </>
      )}
    </Card>
  );
}

function AssessmentArchiveSkeleton() {
  return (
    <div className="assessment-archive-skeleton" role="status" aria-live="polite" aria-label="正在读取测评档案">
      <div className="assessment-archive-skeleton-copy">正在读取测评档案；完成前不会显示为空数据。</div>
      {[0, 1].map((index) => (
        <div className="assessment-archive-skeleton-card" key={index} aria-hidden="true">
          <Skeleton active title={{ width: index ? '38%' : '48%' }} paragraph={{ rows: 3, width: ['96%', '84%', '72%'] }} />
        </div>
      ))}
    </div>
  );
}

export default function AssessmentArchivePanel({
  candidate,
  readOnly,
  assessmentMaintenanceAllowed = false,
  initialStatus = null,
  onChanged,
  onOpenAiSettings,
  onBusyChange,
  aiResumeIntent,
  onAiResumeConsumed,
}) {
  const { message } = AntApp.useApp();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [hasLoadedSuccessfully, setHasLoadedSuccessfully] = useState(false);
  const [operationNotice, setOperationNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [writeBusy, setWriteBusy] = useState(false);
  const [archives, setArchives] = useState([]);
  const [aiAnalyses, setAiAnalyses] = useState([]);
  const [aiConfig, setAiConfig] = useState(null);
  const [aiConfigError, setAiConfigError] = useState('');
  const [assessmentStatus, setAssessmentStatus] = useState(initialStatus);
  const [jobQueueCount, setJobQueueCount] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [reportType, setReportType] = useState('unknown');
  const [assessmentDate, setAssessmentDate] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewPage, setPreviewPage] = useState(1);
  const [importProgress, setImportProgress] = useState(null);
  const [importFailures, setImportFailures] = useState([]);
  const [manualReportTypes, setManualReportTypes] = useState({});
  const [aiFirstUseOpen, setAiFirstUseOpen] = useState(false);
  const [aiFirstUseError, setAiFirstUseError] = useState('');
  const [aiCapabilityChecking, setAiCapabilityChecking] = useState(false);
  const importRequestRef = useRef(null);
  const importBusyRef = useRef(false);
  const previewRequestRef = useRef(0);
  const ownedPreviewUrlRef = useRef('');
  const contextKey = candidate ? `${candidate.internal_id}:${candidate.job_id}` : '';
  const contextRef = useRef(contextKey);
  const loadSequence = useRef(0);
  const contextIsCurrent = contextRef.current === contextKey;
  const visibleArchives = contextIsCurrent ? archives : [];
  const visibleQueueCount = contextIsCurrent ? jobQueueCount : 0;
  const administrativeReadOnly = readOnly && !assessmentMaintenanceAllowed;

  function beginWrite() {
    setBusy(true);
    setWriteBusy(true);
  }

  function endWrite() {
    setBusy(false);
    setWriteBusy(false);
  }

  function replacePreviewUrl(nextUrl = '') {
    const currentUrl = ownedPreviewUrlRef.current;
    if (currentUrl && currentUrl !== nextUrl) URL.revokeObjectURL(currentUrl);
    ownedPreviewUrlRef.current = nextUrl;
    setPreviewUrl(nextUrl);
  }

  function closeImportModal() {
    if (importBusyRef.current) return;
    setImportOpen(false);
  }

  async function load(expectedContext = contextKey, options = {}) {
    if (!candidate || expectedContext !== contextRef.current) return;
    const background = options.background === true;
    const sequence = ++loadSequence.current;
    const candidateId = candidate.internal_id;
    const jobId = candidate.job_id;
    if (!background) setLoading(true);
    try {
      const [data, queueData, aiData, aiConfigData, statusData] = await Promise.all([
        api.listAssessmentArchives(candidateId, jobId),
        api.listAssessmentQueue(jobId),
        // Assessment storage and manual confirmation are independent of AI
        // readiness. A missing JD/profile must not blank the local PDF list.
        api.listAssessmentAiAnalyses(candidateId, jobId).catch(() => ({ analyses: [] })),
        api.getLlmConfig().catch((error) => ({ config: null, error: error.message || 'AI 配置状态不可读' })),
        api.getAssessmentStatus(),
      ]);
      if (sequence !== loadSequence.current || expectedContext !== contextRef.current) return;
      setArchives(data.archives || []);
      setJobQueueCount((queueData.queue || []).length);
      setAiAnalyses(aiData.analyses || []);
      setAiConfig(aiConfigData.config || null);
      setAiConfigError(aiConfigData.error || '');
      setAssessmentStatus(statusData || null);
      setHasLoadedSuccessfully(true);
      setLoadError('');
      return { ok: true };
    } catch (error) {
      const errorMessage = error && error.message ? error.message : '测评档案读取失败，请重试。';
      if (sequence === loadSequence.current && expectedContext === contextRef.current) setLoadError(errorMessage);
      return { ok: false, error: errorMessage };
    } finally {
      if (!background && sequence === loadSequence.current && expectedContext === contextRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    contextRef.current = contextKey;
    loadSequence.current += 1;
    previewRequestRef.current += 1;
    setBusy(false);
    setWriteBusy(false);
    setArchives([]);
    setLoadError('');
    setHasLoadedSuccessfully(false);
    setOperationNotice(null);
    setAiAnalyses([]);
    setAiConfig(null);
    setAiConfigError('');
    setAssessmentStatus(null);
    setJobQueueCount(0);
    setManualReportTypes({});
    replacePreviewUrl('');
    setPreview(null);
    setPreviewPage(1);
    if (contextKey) load(contextKey);
    else setLoading(false);
  }, [contextKey]);
  useEffect(() => () => {
    previewRequestRef.current += 1;
    const currentUrl = ownedPreviewUrlRef.current;
    ownedPreviewUrlRef.current = '';
    if (currentUrl) URL.revokeObjectURL(currentUrl);
  }, []);
  useEffect(() => api.watchAssessmentImportProgress((progress) => {
    if (progress && progress.request_id === importRequestRef.current) setImportProgress(progress);
  }), []);
  useEffect(() => {
    onBusyChange?.(writeBusy);
  }, [onBusyChange, writeBusy]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  async function notifyChanged(expectedContext = contextKey) {
    if (expectedContext !== contextRef.current || typeof onChanged !== 'function') return;
    await onChanged(candidate.internal_id, candidate.job_id);
  }

  async function refreshAfterCommittedAction(expectedContext, committedLabel, options = {}) {
    const refreshed = await load(expectedContext, { background: true });
    let refreshError = refreshed && refreshed.ok ? '' : (refreshed && refreshed.error) || '测评档案刷新失败。';
    if (options.notify !== false) {
      try {
        await notifyChanged(expectedContext);
      } catch (error) {
        refreshError = refreshError || (error && error.message) || '候选人列表刷新失败。';
      }
    }
    if (expectedContext !== contextRef.current) return false;
    if (refreshError) {
      setLoadError('');
      setOperationNotice({
        type: 'warning',
        text: `${committedLabel}，但最新数据刷新失败：${refreshError} 当前保留上次成功数据，请重试刷新，勿重复提交。`,
      });
      return false;
    }
    setOperationNotice(null);
    return true;
  }

  async function retryOperationRefresh() {
    const refreshed = await load(contextKey);
    if (contextKey !== contextRef.current) return;
    if (refreshed && refreshed.ok) {
      setOperationNotice(null);
      return;
    }
    setLoadError('');
    setOperationNotice((current) => ({
      type: 'warning',
      text: `${current?.text || '操作已提交，但最新数据仍未刷新。'} 请稍后再次重试，勿重复提交。`,
    }));
  }

  async function resolveDuplicateDocuments(duplicates) {
    const expectedContext = contextKey;
    beginWrite();
    try {
      for (const duplicate of duplicates) {
        await api.resolveAssessmentDuplicate(
          duplicate.document_id,
          candidate.internal_id,
          candidate.job_id,
          requestId('assessment-duplicate-resolve'),
          { identityMismatchAcknowledged: duplicate.identity_name_mismatch === true },
        );
      }
      if (expectedContext !== contextRef.current) return;
      message.success(`${duplicates.length} 份重复 PDF 已纠正绑定到当前候选人。`);
      await refreshAfterCommittedAction(expectedContext, '重复 PDF 绑定纠正已提交');
    } catch (error) {
      message.error(error.message);
    } finally {
      endWrite();
    }
  }

  function confirmDuplicateResolution(duplicates) {
    const mismatches = duplicates.filter((item) => item.identity_name_mismatch);
    Modal.confirm({
      title: `发现 ${duplicates.length} 份重复 PDF，是否纠正到当前候选人？`,
      content: (
        <div style={{ display: 'grid', gap: 8 }}>
          <Text>确认后，相同文件若已绑定到其他候选人，将改绑到当前候选人；同一候选人的其他不同报告不受影响。</Text>
          {mismatches.map((item) => (
            <Text type="warning" key={item.document_id}>
              报告姓名“{item.report_subject_name || '未识别'}”与当前候选人“{candidate.name || '未命名'}”不一致；本次确认同时表示 HR 已核对并接受该差异。
            </Text>
          ))}
        </div>
      ),
      okText: '确认纠正绑定',
      cancelText: '暂不处理',
      onOk: () => resolveDuplicateDocuments(duplicates),
    });
  }

  async function importPdf(retryFailure = null) {
    if (importBusyRef.current) return;
    if (assessmentStatus?.import_enabled !== true) {
      message.error('本机测评 PDF 导入能力尚未就绪；请先处理页面提示的留存策略或本地工具缺失。');
      return;
    }
    const retryingSingleFile = retryFailure && Number.isInteger(Number(retryFailure.index));
    const importRequestId = requestId(retryingSingleFile ? 'assessment-import-retry' : 'assessment-import');
    importRequestRef.current = importRequestId;
    importBusyRef.current = true;
    if (!retryingSingleFile) setImportFailures([]);
    setImportProgress({ request_id: importRequestId, phase: 'selecting', current: 0, total: 0, succeeded: 0, failed: 0 });
    beginWrite();
    try {
      const response = await api.importAssessmentPdf({
        candidate_id: candidate.internal_id,
        job_id: candidate.job_id,
        report_type: reportType,
        assessment_date: assessmentDate || null,
        request_id: importRequestId,
        single_file_retry: retryingSingleFile,
        retry_item_index: retryingSingleFile ? Number(retryFailure.index) : null,
      });
      if (response.canceled) {
        setImportProgress(null);
        return;
      }
      const items = Array.isArray(response.items)
        ? response.items
        : response.result ? [{ index: 1, ok: true, result: response.result }] : [];
      const failures = items.filter((item) => !item.ok);
      const successes = items.filter((item) => item.ok);
      const duplicateItems = successes
        .filter((item) => item.result && item.result.duplicate)
        .map((item) => item.result);
      const duplicates = duplicateItems.length;
      const imported = successes.length - duplicates;
      const normalizedFailures = retryingSingleFile
        ? failures.map((item) => ({
          ...item,
          index: Number(retryFailure.index),
          retry_count: Number(retryFailure.retry_count || 0) + 1,
        }))
        : failures.map((item) => ({ ...item, retry_count: 0 }));
      setImportFailures((current) => {
        if (!retryingSingleFile) return normalizedFailures;
        return [
          ...current.filter((item) => Number(item.index) !== Number(retryFailure.index)),
          ...normalizedFailures,
        ].sort((left, right) => Number(left.index) - Number(right.index));
      });
      if (!retryingSingleFile && !failures.length) setImportOpen(false);
      if (retryingSingleFile && !failures.length && importFailures.length === 1) setImportOpen(false);
      if (retryingSingleFile && failures.length) {
        message.warning(`第 ${retryFailure.index} 份报告仍未导入，请核对后再次重新选择这一份。`);
      } else if (retryingSingleFile && duplicates) {
        message.warning(`第 ${retryFailure.index} 份报告已重新选择，但系统识别为重复文件。`);
      } else if (retryingSingleFile) {
        message.success(`第 ${retryFailure.index} 份报告已单独重试成功。`);
      } else if (failures.length) message.warning(`${imported} 份已导入，${duplicates} 份重复，${failures.length} 份失败；可在窗口内逐份重新选择失败项。`);
      else if (duplicates) message.warning(`${imported} 份已导入，${duplicates} 份为重复文件。`);
      else message.success(`${imported} 份 PDF 已完成分析，等待 HR 分别确认绑定。`);
      await refreshAfterCommittedAction(contextKey, '测评 PDF 导入已提交', { notify: false });
      if (duplicateItems.length) confirmDuplicateResolution(duplicateItems);
    } catch (error) {
      if (retryingSingleFile) {
        setImportFailures((current) => current.map((item) => (
          Number(item.index) === Number(retryFailure.index)
            ? {
              ...item,
              retry_count: Number(item.retry_count || 0) + 1,
              error: error && error.message ? error.message : '单份重试失败。',
            }
            : item
        )));
      }
      message.error(error.message);
    } finally {
      importRequestRef.current = null;
      importBusyRef.current = false;
      endWrite();
    }
  }

  async function performConfirm(row, identityMismatchAcknowledged = false) {
    const expectedContext = contextKey;
    beginWrite();
    try {
      await api.confirmAssessmentBinding(
        row.binding_id,
        row.binding_version,
        requestId('assessment-confirm'),
        candidate.internal_id,
        candidate.job_id,
        { identityMismatchAcknowledged },
      );
      if (expectedContext !== contextRef.current) return;
      message.success('测评报告绑定已确认。');
      await refreshAfterCommittedAction(expectedContext, '测评报告绑定确认已提交');
    } catch (error) {
      message.error(error.message);
    } finally {
      endWrite();
    }
  }

  async function confirmReportType(row) {
    const expectedContext = contextKey;
    const selectedReportType = manualReportTypes[row.binding_id];
    if (!selectedReportType) {
      message.warning('请先选择报告类型。');
      return;
    }
    beginWrite();
    try {
      await api.confirmAssessmentMetadata(
        row,
        selectedReportType,
        requestId('assessment-metadata-confirm'),
      );
      if (expectedContext !== contextRef.current) return;
      setManualReportTypes((current) => {
        const next = { ...current };
        delete next[row.binding_id];
        return next;
      });
      message.success('报告类型已确认；请继续核对并确认候选人绑定。');
      await refreshAfterCommittedAction(expectedContext, '测评报告类型确认已提交');
    } catch (error) {
      message.error(error.message);
    } finally {
      endWrite();
    }
  }

  function confirm(row) {
    if (!assessmentNameMismatch(row, candidate)) {
      performConfirm(row);
      return;
    }
    Modal.confirm({
      title: '报告姓名与候选人不一致，仍要确认绑定吗？',
      content: `报告姓名“${row.analysis?.subject_name || '未识别'}”，当前候选人“${candidate.name || '未命名'}”。请核对文件归属；确认后将作为当前候选人的有效测评证据。`,
      okText: '已核对，确认绑定',
      cancelText: '取消',
      onOk: () => performConfirm(row, true),
    });
  }

  async function performRevoke(row) {
    const expectedContext = contextKey;
    beginWrite();
    try {
      await api.revokeAssessmentBinding(
        row.binding_id,
        row.binding_version,
        requestId('assessment-revoke'),
        candidate.internal_id,
        candidate.job_id,
      );
      if (expectedContext !== contextRef.current) return;
      message.success('测评报告绑定已撤销。');
      await refreshAfterCommittedAction(expectedContext, '测评报告绑定撤销已提交');
    } catch (error) {
      message.error(error.message);
    } finally {
      endWrite();
    }
  }

  function revoke(row) {
    Modal.confirm({
      title: '确认撤销 PDF 测评报告绑定？',
      content: '撤销后该文件不再作为当前候选人和岗位的有效测评参考；系统不会因此自动改变候选人评分或流程状态。',
      okText: '确认撤销',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => performRevoke(row),
    });
  }

  async function performDeletion(row) {
    const expectedContext = contextKey;
    const effectiveAt = row.deletion_effective_at || new Date().toISOString();
    const deletionRequestId = row.deletion_request_id || requestId('assessment-delete');
    beginWrite();
    try {
      let expectedVersion = row.document_version;
      if (!row.deletion_request_id) {
        const requested = await api.requestAssessmentDeletion(row, deletionRequestId, effectiveAt);
        expectedVersion = requested.result.version;
      }
      await api.confirmAssessmentDeletion(row, expectedVersion, deletionRequestId, effectiveAt);
      if (expectedContext !== contextRef.current) return;
      message.success('测评 PDF、PNG 预览和可识别内容已按留存策略删除，仅保留审计墓碑。');
      await refreshAfterCommittedAction(expectedContext, '测评报告永久删除已提交');
    } catch (error) {
      message.error(error.message);
      await load(expectedContext, { background: true });
    } finally {
      endWrite();
    }
  }

  function requestDeletion(row) {
    Modal.confirm({
      title: row.deletion_request_id ? '重试完成测评物理删除？' : '确认永久删除这份测评报告？',
      content: '仅在留存期限已到、绑定已撤销且无 Hold/争议时执行。确认后原 PDF 和 PNG 预览不可恢复，只保留不含正文的审计墓碑。',
      okText: row.deletion_request_id ? '重试物理删除' : '永久删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => performDeletion(row),
    });
  }

  async function loadPreviewPage(info, page, expectedContext, requestSequence) {
    const nextUrl = await assessmentPreviewUrl(info.preview_id, page);
    if (expectedContext !== contextRef.current || requestSequence !== previewRequestRef.current) {
      URL.revokeObjectURL(nextUrl);
      return false;
    }
    replacePreviewUrl(nextUrl);
    setPreviewPage(page);
    return true;
  }

  async function changePreviewPage(page) {
    if (!preview) return;
    const expectedContext = contextKey;
    const requestSequence = ++previewRequestRef.current;
    setBusy(true);
    try {
      await loadPreviewPage(preview, page, expectedContext, requestSequence);
    } catch (error) {
      if (expectedContext === contextRef.current && requestSequence === previewRequestRef.current) {
        message.error(error.message);
      }
    } finally {
      if (expectedContext === contextRef.current && requestSequence === previewRequestRef.current) setBusy(false);
    }
  }

  async function openPreview(row) {
    if (READONLY_UI) {
      message.warning('操作只读模式不生成 PDF/PNG 动态预览；历史元数据仍可查看。');
      return;
    }
    const expectedContext = contextKey;
    const requestSequence = ++previewRequestRef.current;
    setBusy(true);
    try {
      const data = await api.createAssessmentPreview(row, requestId('assessment-view'));
      if (expectedContext !== contextRef.current || requestSequence !== previewRequestRef.current) return;
      const loaded = await loadPreviewPage(data.preview, 1, expectedContext, requestSequence);
      if (!loaded || expectedContext !== contextRef.current || requestSequence !== previewRequestRef.current) return;
      setPreview(data.preview);
    } catch (error) {
      if (expectedContext === contextRef.current && requestSequence === previewRequestRef.current) {
        message.error(error.message);
      }
    } finally {
      if (expectedContext === contextRef.current && requestSequence === previewRequestRef.current) setBusy(false);
    }
  }

  function closePreview() {
    previewRequestRef.current += 1;
    setBusy(false);
    replacePreviewUrl('');
    setPreview(null);
    setPreviewPage(1);
  }

  async function generateAiAnalysis() {
    const expectedContext = contextKey;
    const aiRequestId = requestId('assessment-ai-analysis');
    beginWrite();
    try {
      const approval = await api.confirmExternalAiApproval(
        'assessment-ai-analysis',
        candidate.internal_id,
        aiRequestId,
        { jobId: candidate.job_id },
      );
      if (!approval.approved) {
        message.info('已取消 AI 测评综合分析。');
        return;
      }
      const generated = await api.generateAssessmentAiAnalysis(candidate.internal_id, candidate.job_id, {
        requestId: approval.requestId || aiRequestId,
        userApproval: approval.userApproval,
      });
      if (expectedContext !== contextRef.current) return;
      message.success('AI 测评综合分析已生成；仅作为辅助材料，不改变默认排序。');
      await refreshAfterCommittedAction(expectedContext, 'AI 测评综合分析生成已提交');
    } catch (error) {
      message.error(error.message);
    } finally {
      endWrite();
    }
  }

  async function requestAiAnalysis() {
    if (busy || aiCapabilityChecking) return;
    setAiCapabilityChecking(true);
    const access = await readExternalAiCapability('assessment_analysis');
    setAiCapabilityChecking(false);
    if (access.available) {
      await generateAiAnalysis();
      return;
    }
    setAiFirstUseError(access.readable ? '' : access.error);
    setAiFirstUseOpen(true);
  }

  function continueAssessmentManually() {
    setAiFirstUseOpen(false);
    message.info('已确认的测评事实仍可由 HR 手工核对；不启用 AI 不影响测评归档或招聘处置。');
    globalThis.setTimeout(() => globalThis.document?.getElementById('assessment-ai-analysis-action')?.focus(), 0);
  }

  async function openAssessmentAiSettings(options = {}) {
    setAiFirstUseOpen(false);
    await onOpenAiSettings?.({
      capability: 'assessment_analysis',
      source: 'assessment-archive',
      sourceLabel: '测评综合分析',
      targetId: candidate.internal_id,
      targetLabel: candidate.name,
      jobId: candidate.job_id,
      focusTargetId: 'assessment-ai-analysis-action',
      resumeAction: options.resumeAction !== false,
    });
  }

  const hasActiveReports = visibleArchives.some(
    (row) => row.binding_state === 'active' && row.analysis_status === 'ready' && row.report_type !== 'unknown',
  );
  const aiAnalysisReady = assessmentAiReadiness(aiConfig, aiConfigError, readOnly).ready;

  useEffect(() => {
    if (
      aiResumeIntent?.capability !== 'assessment_analysis'
      || String(aiResumeIntent.targetId) !== String(candidate?.internal_id)
      || loading
      || busy
    ) return;
    const intent = aiResumeIntent;
    onAiResumeConsumed?.(intent.id);
    globalThis.setTimeout(() => {
      const target = globalThis.document?.getElementById(intent.focusTargetId || 'assessment-ai-analysis-action');
      target?.focus?.({ preventScroll: false });
      target?.scrollIntoView?.({ block: 'nearest' });
      if (intent.resumeAction !== false && hasActiveReports && aiAnalysisReady) {
        void generateAiAnalysis();
      }
    }, 0);
  }, [
    aiResumeIntent?.id,
    candidate?.internal_id,
    loading,
    hasActiveReports,
    aiAnalysisReady,
    busy,
  ]);

  return (
    <div className="assessment-archive-panel">
      <Alert
        type="info"
        showIcon
        message="PDF 测评供 HR 人工判断参考"
        description="导入后先自动提取报告事实；HR 确认绑定后，可生成联合岗位、简历和面试材料的 AI 综合分析，作为人工辅助且不改变默认排序。系统不会直接打开原始 PDF。"
      />
      {readOnly && assessmentMaintenanceAllowed && (
        <Alert
          type="warning"
          showIcon
          message="岗位已关闭，招聘推进动作已禁用"
          description="仍可查看历史测评，并执行撤销绑定、到期永久删除或重试物理删除等行政清理；不能导入、纠正绑定、确认报告类型、确认绑定或生成 AI 分析。"
        />
      )}
      {operationNotice && (
        <Alert
          type={operationNotice.type}
          showIcon
          message={operationNotice.text}
          action={<Button loading={loading} onClick={retryOperationRefresh}>重试刷新</Button>}
        />
      )}
      {loadError && (
        <Alert
          type={hasLoadedSuccessfully ? 'warning' : 'error'}
          showIcon
          message={hasLoadedSuccessfully ? '刷新失败，当前显示上次成功数据' : '测评档案读取失败'}
          description={loadError}
          action={<Button loading={loading} onClick={() => load(contextKey)}>重试</Button>}
        />
      )}
      {assessmentStatus && !assessmentStatus.retention_policy_configured && (
        <Alert
          type="error"
          showIcon
          message="测评留存策略尚未配置，已禁止继续导入"
          description="当前启动没有提供可用的测评留存策略。请联系维护人员补齐策略版本和留存天数，配置完成并重启应用后再导入；已有历史档案仍可查看。"
        />
      )}
      {assessmentStatus?.retention_policy_configured && (
        <Alert
          type="info"
          showIcon
          message="当前测评留存策略"
          description={`策略版本：${assessmentStatus.retention_policy_version || '未标识'}；留存 ${assessmentStatus.retention_days || '未标识'} 天。到期后仍需 HR 二次确认才会物理删除 PDF 与 PNG 预览。`}
        />
      )}
      {assessmentStatus && assessmentStatus.retention_policy_configured
        && assessmentStatus.import_enabled === false
        && Array.isArray(assessmentStatus.missing_required_dependencies)
        && assessmentStatus.missing_required_dependencies.length > 0 && (
        <Alert
          type="error"
          showIcon
          message="本机缺少测评 PDF 导入所需工具"
          description={`缺少：${assessmentStatus.missing_required_dependencies.join('、')}。历史测评仍可查看；补齐本地 PDF 工具并重启应用后才能导入新报告。`}
        />
      )}
      {assessmentStatus && assessmentStatus.import_enabled === true
        && assessmentStatus.text_analysis_available === false && (
        <Alert
          type="warning"
          showIcon
          message="可安全归档，但本机暂不能自动提取报告文字"
          description="导入与 PNG 预览可继续使用；报告类型和候选人归属需要 HR 手工核对确认。外部 AI 不会被自动调用。"
        />
      )}
      <Space align="center" style={{ justifyContent: 'space-between' }}>
        <div>
          <Title level={5} style={{ margin: 0 }}>受控 PDF 测评报告</Title>
          <Text type="secondary">文件完成当前技术检查后仅生成 PNG 栅格预览；不代表文件绝对安全。</Text>
        </div>
        <Button type="primary" disabled={readOnly || assessmentStatus?.import_enabled !== true} loading={busy} onClick={() => { setImportFailures([]); setImportProgress(null); setImportOpen(true); }}>批量导入 PDF</Button>
      </Space>
      {visibleQueueCount > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`当前岗位有 ${visibleQueueCount} 份待人工确认档案`}
          description="本页只处理当前候选人；其他档案请切换到对应候选人后处理。"
        />
      )}
      {!loading && contextIsCurrent && hasLoadedSuccessfully && <AssessmentPortfolio archives={visibleArchives} candidate={candidate} />}
      {!loading && contextIsCurrent && hasLoadedSuccessfully && (
        <AssessmentAiAnalysisCard
          analyses={aiAnalyses}
          busy={busy}
          hasActiveReports={hasActiveReports}
          onGenerate={requestAiAnalysis}
          readOnly={readOnly}
          aiConfig={aiConfig}
          aiConfigError={aiConfigError}
          onOpenSettings={() => openAssessmentAiSettings({ resumeAction: false })}
          aiCapabilityChecking={aiCapabilityChecking}
        />
      )}
      {(!contextIsCurrent || loading) ? <AssessmentArchiveSkeleton /> : !hasLoadedSuccessfully ? null : !visibleArchives.length ? <Empty description="暂无 PDF 测评报告" /> : visibleArchives.map((row) => (
        <Card size="small" key={row.binding_id}>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Space wrap>
              <strong>{REPORT_LABELS[row.report_type] || '未识别报告'}</strong>
              <Tag color={analysisState(row).color}>分析 {analysisState(row).label}</Tag>
              <Tag color={stateColor(row.binding_state)}>绑定 {row.binding_state}</Tag>
              <Tag color={stateColor(row.lifecycle_state)}>生命周期 {row.lifecycle_state}</Tag>
              <Tag color={stateColor(row.legal_hold_state)}>Hold {row.legal_hold_state}</Tag>
            </Space>
            <Text type="secondary">测评日期：{row.assessment_date || 'Unknown'} · 归档时间：{fmtTime(row.created_at)}</Text>
            <Text type="secondary">留存策略：{row.retention_policy_version || '未配置'} · 可删除时间：{fmtTime(row.delete_after)}</Text>
            <AssessmentAnalysis row={row} candidate={candidate} />
            <Space>
              {row.binding_state === 'pending' && row.report_type === 'unknown' && (
                <Space.Compact>
                  <Select
                    aria-label={`报告 ${row.binding_id} 的类型`}
                    value={manualReportTypes[row.binding_id]}
                    placeholder="选择报告类型"
                    options={CLASSIFIABLE_REPORT_OPTIONS}
                    disabled={readOnly || busy}
                    style={{ minWidth: 150 }}
                    onChange={(value) => setManualReportTypes((current) => ({ ...current, [row.binding_id]: value }))}
                  />
                  <Button
                    size="small"
                    disabled={readOnly || busy || !manualReportTypes[row.binding_id]}
                    onClick={() => confirmReportType(row)}
                  >
                    确认报告类型
                  </Button>
                </Space.Compact>
              )}
              {row.binding_state === 'pending' && row.report_type !== 'unknown' && row.review_state === 'ready' && (
                <Button size="small" disabled={readOnly || busy} onClick={() => confirm(row)}>
                  人工确认绑定
                </Button>
              )}
              {row.binding_state === 'active' && row.lifecycle_state === 'active' && (
                <Button
                  size="small"
                  disabled={READONLY_UI || busy}
                  title={READONLY_UI ? '操作只读模式不生成动态预览' : undefined}
                  onClick={() => openPreview(row)}
                >查看 PNG 预览</Button>
              )}
              {['pending', 'active'].includes(row.binding_state) && (
                <Button danger size="small" disabled={administrativeReadOnly || busy} onClick={() => revoke(row)}>撤销绑定</Button>
              )}
              {row.binding_state === 'revoked' && row.lifecycle_state === 'active' && retentionDue(row) && (
                <Button danger size="small" disabled={administrativeReadOnly || busy} onClick={() => requestDeletion(row)}>永久删除</Button>
              )}
              {row.binding_state === 'revoked' && row.lifecycle_state === 'deletion_pending' && row.deletion_request_id && (
                <Button danger size="small" disabled={administrativeReadOnly || busy} onClick={() => requestDeletion(row)}>重试物理删除</Button>
              )}
            </Space>
          </Space>
        </Card>
      ))}

      <Modal
        title="批量导入 PDF 测评报告"
        open={importOpen}
        confirmLoading={busy}
        onOk={() => importPdf()}
        onCancel={closeImportModal}
        okText="选择 PDF（可多选）并导入"
        cancelButtonProps={{ disabled: busy }}
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert type="info" showIcon message="可一次选择同一候选人的多份报告" description="系统逐份识别报告类型、受测者、日期和主要结论；导入完成后由 HR 对每份报告分别确认绑定。" />
          <Text>报告类型</Text>
          <Select aria-label="批量导入报告类型" value={reportType} disabled={busy} onChange={setReportType} options={REPORT_OPTIONS} style={{ width: '100%' }} />
          <Text>测评日期（可留空）</Text>
          <Input
            aria-label="批量导入测评日期"
            name="assessment-archive-import-date"
            autoComplete="off"
            type="date"
            value={assessmentDate}
            disabled={busy}
            onChange={(event) => setAssessmentDate(event.target.value)}
          />
          {busy && importProgress && importProgress.total > 0 && (
            <div>
              <Text>正在逐份分析：{importProgress.current} / {importProgress.total}</Text>
              <Progress
                percent={Math.round((importProgress.current / importProgress.total) * 100)}
                status={importProgress.failed > 0 ? 'exception' : 'active'}
                format={() => `${importProgress.current}/${importProgress.total}`}
              />
            </div>
          )}
          {importFailures.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`${importFailures.length} 份报告导入失败`}
              description={(
                <div style={{ display: 'grid', gap: 8 }}>
                  <Text type="secondary">无需重选整批。请点击对应失败项，并在系统文件选择器中只重新选择这一份 PDF；系统不会保存或显示原文件路径。</Text>
                  {importFailures.map((item) => (
                    <Space key={`assessment-import-failure:${item.index}`} align="start" style={{ justifyContent: 'space-between' }}>
                      <Text>
                        第 {item.index} 份：{item.error}
                        {Number(item.retry_count || 0) > 0 ? `（已重试 ${item.retry_count} 次）` : ''}
                      </Text>
                      <Button
                        size="small"
                        disabled={readOnly || busy || assessmentStatus?.import_enabled !== true}
                        onClick={() => importPdf(item)}
                      >
                        重新选择这一份
                      </Button>
                    </Space>
                  ))}
                </div>
              )}
            />
          )}
        </Space>
      </Modal>

      <Modal title="PDF 测评 PNG 预览" open={Boolean(preview)} footer={null} onCancel={closePreview} width={900}>
        {previewUrl ? <img src={previewUrl} alt={`PDF 测评第 ${previewPage} 页栅格预览`} width={1240} height={1754} style={{ width: '100%', height: 'auto', maxHeight: '70vh', objectFit: 'contain' }} /> : <Spin />}
        {preview && (
          <Space style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}>
            <Button disabled={previewPage <= 1 || busy} onClick={() => changePreviewPage(previewPage - 1)}>上一页</Button>
            <Text>{previewPage} / {preview.page_count}</Text>
            <Button disabled={previewPage >= preview.page_count || busy} onClick={() => changePreviewPage(previewPage + 1)}>下一页</Button>
          </Space>
        )}
      </Modal>
      <ExternalAiFirstUsePrompt
        open={aiFirstUseOpen}
        capability="assessment_analysis"
        readError={aiFirstUseError}
        onEnable={openAssessmentAiSettings}
        onManual={continueAssessmentManually}
        onClose={continueAssessmentManually}
      />
    </div>
  );
}
