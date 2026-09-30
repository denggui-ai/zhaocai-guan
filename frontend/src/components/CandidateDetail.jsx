import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Select, Tag, Space, Typography, Card, Collapse, ConfigProvider, Segmented, Modal, Dropdown, Drawer } from 'antd';
import { CheckCircleFilled, InfoCircleOutlined, MoreOutlined, QuestionCircleOutlined, RobotOutlined, UploadOutlined, WarningFilled } from '@ant-design/icons';
import { api, candidateScreenshotUrl, has, fmtTime, recLabel, joinParts, parseSections, soReport } from '../api.js';
import { SabcBadge, highlight } from './CandidateList.jsx';
import { candidateEducation, candidateSourceLabel } from '../candidate-utils.js';
import InterviewReviewPanel from './InterviewReviewPanel.jsx';
import AssessmentArchivePanel from './AssessmentArchivePanel.jsx';
import ApplicationFinalReviewPanel from './ApplicationFinalReviewPanel.jsx';
import CandidateJourneyOperationsPanel from './CandidateJourneyOperationsPanel.jsx';
import { communicationDrawerEscapeAction } from '../candidate-communication-drawer-state.mjs';
import ExternalAiFirstUsePrompt, {
  readExternalAiCapability,
} from './ExternalAiFirstUsePrompt.jsx';

const { Title, Text, Paragraph } = Typography;
const REPORT_SCHEMA_VERSION = 'candidate_evaluation_report_v1';
const COMMUNICATION_OPTIONS = Object.freeze([
  { value: 'not_contacted', label: '尚未开始沟通' },
  { value: 'greeted', label: '已人工联系（未确认回复）' },
  { value: 'replied', label: '候选人已回复' },
  { value: 'resume_requested', label: '已人工请求简历' },
  { value: 'resume_received', label: '已收到简历' },
]);
const COMMUNICATION_RANK = Object.freeze({
  not_contacted: 0,
  greeted: 1,
  replied: 2,
  resume_requested: 3,
  resume_received: 4,
});
const COMMUNICATION_LABEL_TO_CODE = Object.freeze({
  未打招呼: 'not_contacted',
  已打招呼: 'greeted',
  已回复: 'replied',
  已求简历: 'resume_requested',
  已收到简历: 'resume_received',
});

// Keep candidate workspace tabs on AntD's documented public surface. The
// semantic colors remain sourced from theme.js through its CSS variables;
// this local component-token layer only removes the filled Segmented track so
// the evidence workspace can use its established compact underline treatment.
const CANDIDATE_SEGMENTED_THEME = Object.freeze({
  token: {
    boxShadowTertiary: 'none',
  },
  components: {
    Segmented: {
      itemActiveBg: 'transparent',
      itemColor: 'var(--hb-v2-ink-muted)',
      itemHoverBg: 'transparent',
      itemHoverColor: 'var(--hb-v2-brand-hover)',
      itemSelectedBg: 'transparent',
      itemSelectedColor: 'var(--hb-v2-brand-active)',
      trackBg: 'transparent',
      trackPadding: 0,
    },
  },
});

function handleSegmentedBoundaryKey(event, options, value, onChange) {
  if (event.key === 'Enter' || event.key === ' ') {
    const focusedRadio = event.target?.matches?.('input[type="radio"]') ? event.target : null;
    const radioIndex = focusedRadio
      ? [...event.currentTarget.querySelectorAll('input[type="radio"]')].indexOf(focusedRadio)
      : -1;
    const focusedOption = radioIndex >= 0 ? options[radioIndex] : null;
    if (event.key === 'Enter' && focusedRadio && focusedOption && !focusedOption.disabled) {
      event.preventDefault();
      onChange(focusedOption.value);
    } else if (event.target === event.currentTarget) {
      event.preventDefault();
      onChange(value);
    }
    return;
  }
  if (event.key !== 'Home' && event.key !== 'End') return;

  const available = options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => !option.disabled);
  const target = event.key === 'Home' ? available[0] : available[available.length - 1];
  if (!target) return;

  event.preventDefault();
  onChange(target.option.value);
  const group = event.currentTarget;
  window.requestAnimationFrame(() => {
    group.querySelectorAll('input[type="radio"]')[target.index]?.focus();
  });
}

function currentCommunicationCode(candidate) {
  const stored = String(candidate?.communication_code || '').trim();
  if (Object.hasOwn(COMMUNICATION_RANK, stored)) return stored;
  return COMMUNICATION_LABEL_TO_CODE[String(candidate?.comm_status || '').trim()] || 'not_contacted';
}

function Field({ label, value, fill }) {
  return (
    <div className="field-box candidate-v2-fact">
      <dt className="field-label">{label}</dt>
      <dd>{has(value) ? value : <span className="placeholder-text">-- {fill}</span>}</dd>
    </div>
  );
}

function EmptyBox({ text }) {
  return <div className="empty-box">{text}</div>;
}

function clipText(value, max = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').replace(/\s*([，。；：、])\s*/g, '$1').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function textPoints(value, limit = 4, max = 92) {
  const text = String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[•●▪◆]/g, '\n')
    .replace(/([。！？!?；;])\s*/g, '$1\n')
    .replace(/\n\s*[-–]\s*/g, '\n')
    .replace(/\n\s*\d+[\.、）)]\s*/g, '\n');
  const seen = new Set();
  return text
    .split(/\n+/)
    .map((item) => item.replace(/^[\s,，.。;；:：、]+|[\s,，]+$/g, '').trim())
    .filter(Boolean)
    .map((item) => clipText(item, max))
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    })
    .slice(0, limit);
}

function sentenceMatches(value, pattern, limit = 4) {
  return textPoints(value, 24, 96).filter((item) => pattern.test(item)).slice(0, limit);
}

function datePart(value) {
  const text = String(value || '');
  const match = text.match(/^(\d{4})(\d{2})/);
  if (!match) return text;
  return `${match[1]}.${match[2]}`;
}

function dateRange(start, end) {
  return joinParts([datePart(start), datePart(end)]).replace(' · ', ' - ');
}

function SectionHeader({ title, count, action, level = 3 }) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className="section-header">
      <div style={{ display: 'flex', alignItems: 'baseline' }}>
        <Heading className="section-kicker" style={{ margin: 0, fontSize: 'inherit', lineHeight: 'inherit' }}>{title}</Heading>
        {count != null && <span className="section-count">{count}</span>}
      </div>
      {action}
    </div>
  );
}

function BulletList({ items, muted }) {
  const rows = (items || []).filter(Boolean);
  if (!rows.length) return <div className="placeholder-text">暂无</div>;
  return (
    <ul className={`clean-bullets ${muted ? 'muted' : ''}`}>
      {rows.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  );
}

function ResumeEntry({ title, meta, text }) {
  return (
    <div className="resume-entry">
      <div className="resume-entry-head">
        <strong>{title || '未命名经历'}</strong>
        {has(meta) && <span>{meta}</span>}
      </div>
      <BulletList items={textPoints(text, 4)} />
    </div>
  );
}

function SideBlock({ title, children }) {
  return (
    <div className="resume-side-block">
      <SectionHeader title={title} />
      {children}
    </div>
  );
}

function extractSkillTags(candidate, sections, limit = 12) {
  const source = [
    ...(Array.isArray(sections && sections.skill) ? sections.skill.map((item) => item.text) : []),
    candidate.geek_desc,
  ].join(' ');
  const known = ['Java', 'Spring Boot', 'SpringCloud', 'Dubbo', 'Redis', 'MySQL', 'SQL', 'Kafka', 'RocketMQ', 'RabbitMQ', 'Docker', 'Kubernetes', 'DDD', 'OMS', 'WMS', 'ERP', 'TMS', 'AI', 'Cursor', 'Copilot', 'Claude'];
  return [...new Set(known.filter((tag) => new RegExp(tag.replace(/\s+/g, '\\s*'), 'i').test(source)))].slice(0, limit);
}

function renderResume(children, candidate, { readOnly = false, onOpenAttachments } = {}) {
  const row = children.resume_online[0];
  if (!row) {
    return (
      <div>
        <EmptyBox text="当前没有可读的结构化在线简历。可上传本机附件。" />
        {!readOnly && onOpenAttachments && <Button size="small" onClick={onOpenAttachments}>上传附件简历</Button>}
      </div>
    );
  }
  if (Number(row.is_paywalled) === 1) {
    return (
      <div>
        <EmptyBox text="在线简历当前不可见；不会把付费墙或权限限制当作候选人资料缺失。" />
        {!readOnly && onOpenAttachments && <Button size="small" onClick={onOpenAttachments}>上传附件简历</Button>}
      </div>
    );
  }
  const s = parseSections(row);
  if (!s) {
    return (
      <div>
        <EmptyBox text="在线简历格式异常，当前材料不会参与判断。" />
        {onOpenAttachments && <Button size="small" onClick={onOpenAttachments}>查看附件简历</Button>}
      </div>
    );
  }
  const basic = Array.isArray(s.basic) ? s.basic[0] || {} : {};
  const work = Array.isArray(s.work) ? s.work : [];
  const proj = Array.isArray(s.proj) ? s.proj : [];
  const edu = Array.isArray(s.edu) ? s.edu : [];
  const expect = Array.isArray(s.expect) ? s.expect : [];
  const skills = extractSkillTags({ ...candidate, geek_desc: [candidate.geek_desc, basic.description].filter(Boolean).join(' ') }, s, 14);
  return (
    <div className="resume-clean-layout">
      <div className="resume-main-column">
        <section className="resume-section">
          <SectionHeader title="工作经历" count={work.length} />
          {work.length ? work.slice(0, 5).map((item, i) => (
            <ResumeEntry key={i} title={joinParts([item.company, item.title])} meta={dateRange(item.start, item.end)} text={item.desc} />
          )) : <EmptyBox text="暂无工作经历" />}
        </section>
        <section className="resume-section">
          <SectionHeader title="项目经历" count={proj.length} />
          {proj.length ? proj.slice(0, 4).map((item, i) => (
            <ResumeEntry key={i} title={item.name} meta={joinParts([item.role, dateRange(item.start, item.end)])} text={item.desc} />
          )) : <EmptyBox text="暂无项目经历" />}
        </section>
      </div>
      <div className="resume-side-column">
        <SideBlock title="技能标签">
          <Space size={[6, 6]} wrap>
            {skills.length ? skills.map((tag) => <Tag key={tag}>{tag}</Tag>) : <span className="placeholder-text">暂无</span>}
          </Space>
        </SideBlock>
        <SideBlock title="教育经历">
          {edu.length ? edu.slice(0, 3).map((item, i) => (
            <div className="side-line" key={i}>
              <strong>{item.school || '未知学校'}</strong>
              <span>{joinParts([item.major, item.degree, dateRange(item.start, item.end), (item.tags || []).join('/')])}</span>
            </div>
          )) : <span className="placeholder-text">暂无</span>}
        </SideBlock>
        <SideBlock title="求职期望">
          {expect.length ? expect.slice(0, 2).map((item, i) => (
            <div className="side-line" key={i}>
              <strong>{item.position || '期望职位'}</strong>
              <span>{joinParts([item.city, item.salary]) || '暂无'}</span>
            </div>
          )) : <span className="placeholder-text">暂无</span>}
        </SideBlock>
        <SideBlock title="自我描述">
          <BulletList items={textPoints(basic.description, 5, 88)} muted />
        </SideBlock>
      </div>
    </div>
  );
}

function AttachmentResume({ list, readOnly, uploading, notice, onUpload }) {
  const rows = list || [];
  return (
    <div>
      <SectionHeader
        title="附件简历"
        count={rows.length}
        action={!readOnly && (
          <Button type="primary" icon={<UploadOutlined />} loading={uploading} onClick={onUpload}>
            手动上传简历
          </Button>
        )}
      />
      <Paragraph type="secondary" style={{ marginBottom: 10 }}>
        支持 PDF、Word、RTF 和 TXT。上传后保存在本机，并把可提取正文作为当前候选人的简历证据；不会改变评级、状态或人工处置。
      </Paragraph>
      {notice && <Paragraph type={notice.type === 'error' ? 'danger' : notice.type}>{notice.text}</Paragraph>}
      {!rows.length ? <EmptyBox text="还没有附件简历，可直接从本机手动上传。" /> : rows.map((row) => (
        <div className="resume-item" key={row.id}>
          <div className="resume-title">{row.file_name || row.resume_id || `附件 ${row.id}`}</div>
          <div className="resume-meta">
            {[row.file_type, row.download_status, Number(row.is_paywalled) === 1 ? '付费墙' : '', Number(row.has_contact) === 1 ? '含联系方式' : ''].filter(Boolean).join(' · ')}
          </div>
          <div className="resume-text">上传时间：{fmtTime(row.downloaded_at || row.created_at)}</div>
        </div>
      ))}
    </div>
  );
}

function ScreenshotPreview({ candidate, sections }) {
  const files = Array.isArray(sections && sections.screenshot_files) ? sections.screenshot_files : [];
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    setSrc('');
    setError('');
    setPreviewOpen(false);
    candidateScreenshotUrl(candidate.internal_id).then((url) => {
      objectUrl = url;
      if (active) setSrc(url);
    }).catch((err) => {
      if (active) setError(err.message);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [candidate.internal_id, readAttempt]);
  return (
    <div className="screenshot-review">
      <div className="screenshot-review-head">
        <div>
          <SectionHeader title="拼合截图" />
          <Text type="secondary">{files.length ? files.join('、') : '本地截图导入'}</Text>
        </div>
        <Button size="small" disabled={!src} onClick={() => setPreviewOpen(true)}>放大查看</Button>
      </div>
      <div className="screenshot-frame">
        {src ? (
          <img src={src} alt={`${candidate.name || '候选人'}拼合截图`} width={1200} height={1600} style={{ width: '100%', height: 'auto', display: 'block' }} />
        ) : error ? (
          <Alert
            type="error"
            showIcon
            message="截图读取失败"
            description={error}
            action={<Button size="small" onClick={() => setReadAttempt((attempt) => attempt + 1)}>重试</Button>}
          />
        ) : (
          <Text type="secondary">正在安全读取截图…</Text>
        )}
      </div>
      <Modal
        title={`${candidate.name || '候选人'} · 拼合截图`}
        open={previewOpen}
        footer={null}
        width="min(94vw, 1200px)"
        onCancel={() => setPreviewOpen(false)}
        destroyOnHidden
      >
        {src ? <img src={src} alt={`${candidate.name || '候选人'}拼合截图放大预览`} width={1200} height={1600} style={{ width: '100%', height: 'auto', display: 'block' }} /> : null}
      </Modal>
    </div>
  );
}

function PointCard({ type, title, text, tag }) {
  const risk = type === 'risk';
  return (
    <div className={`ai-point ${risk ? 'risk' : 'match'}`}>
      <div className="ai-point-icon">{risk ? <WarningFilled /> : <CheckCircleFilled />}</div>
      <div>
        <div className="ai-point-title">
          {clipText(title || (risk ? '待核实点' : '匹配点'), 76)}
          {React.isValidElement(tag) ? tag : has(tag) && <Tag>{tag}</Tag>}
        </div>
        {has(text) && <div className="ai-point-text">{clipText(text, 100)}</div>}
      </div>
    </div>
  );
}

function isV1Report(rep) {
  return rep && rep.schema_version === REPORT_SCHEMA_VERSION && Array.isArray(rep.radar) && Array.isArray(rep.dimension_matches);
}

function isLocalDemoReport(rep) {
  if (!rep) return false;
  const markers = [rep.generator, rep.source, rep.mode].map((value) => String(value || '').toLowerCase());
  return rep.is_local_demo === true || rep.is_fixture === true || markers.some((value) => /local_demo|fixture/.test(value));
}

function aiReportSource(rep) {
  if (!rep) return { key: 'invalid', label: '报告数据异常', color: 'orange' };
  if (isLocalDemoReport(rep)) return { key: 'local_demo', label: '本地样本', color: 'purple' };
  if (isV1Report(rep)) return { key: 'real_ai', label: '真实 AI', color: 'cyan' };
  return { key: 'legacy', label: '历史记录 · 来源待核验', color: 'default' };
}

function emptyAssessmentCopy(status, loading, readOnly) {
  if (loading) return 'AI 初评尚未运行，正在检查本地样本和真实 AI 的可用配置。';
  if (readOnly) return 'AI 初评尚未运行。当前为只读模式，不会执行本地样本或真实 AI 调用。';
  if (status && status.can_real_assess) return 'AI 初评尚未运行；真实 AI 已配置，可由 HR 明确发起生成。';
  if (status && status.can_local_demo) return 'AI 初评尚未运行；真实 AI 待配置，可选择生成带有明确标识的本地样本。';
  return 'AI 初评尚未运行，待完成本地样本或真实 AI 配置后再生成。';
}

function stateTag(state) {
  if (state === 'Match') return <Tag color="green">Match</Tag>;
  if (state === 'Mismatch') return <Tag color="orange">Mismatch</Tag>;
  return <Tag icon={<QuestionCircleOutlined />}>Unknown</Tag>;
}

function evidenceText(evidence) {
  const rows = Array.isArray(evidence) ? evidence : [];
  return rows.map((item) => item && item.text).filter(has).slice(0, 2).join('；');
}

function explanationText(item) {
  const exp = (item && item.explanation) || {};
  return [exp.fact, exp.judgment, exp.impact].filter(has).join('；');
}

function clampScore(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function radarScorePercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return clampScore(n <= 10 ? n * 10 : n, 0, 100);
}

function pointsForRadar(data, center, radius) {
  const step = (Math.PI * 2) / data.length;
  return data.map((item, i) => {
    const angle = -Math.PI / 2 + i * step;
    const percent = radarScorePercent(item.score);
    const r = percent == null ? null : radius * (percent / 100);
    return {
      x: r == null ? null : center + Math.cos(angle) * r,
      y: r == null ? null : center + Math.sin(angle) * r,
      angle,
      percent,
      ...item,
    };
  });
}

function RadarProfile({ report }) {
  const localDemo = isLocalDemoReport(report);
  const data = isV1Report(report)
    ? report.radar.map((item) => ({
      axis: item.dimension,
      score: item.score,
      state: item.state,
      basis: item.state === 'Unknown' ? '证据不足，待面试核实' : item.state,
    })).filter((item) => has(item.axis))
    : [];
  const size = 270;
  const center = size / 2;
  const radius = 78;
  const labelRadius = 106;
  const levels = [0.25, 0.5, 0.75, 1];
  if (!data.length) {
    return (
      <section className="radar-card">
        <div className="radar-head">
          <SectionHeader title="能力雷达" />
          <Tag>待候选人匹配报告</Tag>
        </div>
        <EmptyBox text="生成候选人匹配报告后，这里会显示动态雷达；旧点评不会生成正式雷达。" />
        <Text type="secondary" className="radar-note">没有匹配报告时不生成雷达占位结论。</Text>
      </section>
    );
  }
  const chartPoints = pointsForRadar(data, center, radius);
  const knownPoints = chartPoints.filter((p) => p.x != null && p.y != null);
  const polygon = knownPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  return (
    <section className="radar-card">
      <div className="radar-head">
        <SectionHeader title="能力雷达" />
        <Space size={6}>
          <Tag color="cyan">候选人匹配报告</Tag>
          {localDemo && <Tag color="purple">本地样本</Tag>}
        </Space>
      </div>
      <div className="radar-body">
        <svg className="radar-svg" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="候选人能力雷达图">
          {levels.map((level) => (
            <polygon
              key={level}
              className="radar-grid"
              points={pointsForRadar(data.map((item) => ({ ...item, score: level * 100 })), center, radius)
                .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
            />
          ))}
          {data.map((item, i) => {
            const angle = -Math.PI / 2 + i * ((Math.PI * 2) / data.length);
            const x = center + Math.cos(angle) * radius;
            const y = center + Math.sin(angle) * radius;
            const labelX = center + Math.cos(angle) * labelRadius;
            const labelY = center + Math.sin(angle) * labelRadius;
            return (
              <g key={item.axis}>
                <line className="radar-axis" x1={center} y1={center} x2={x} y2={y} />
                <text
                  className="radar-label"
                  x={labelX}
                  y={labelY}
                  textAnchor={Math.abs(labelX - center) < 8 ? 'middle' : labelX > center ? 'start' : 'end'}
                  dominantBaseline="middle"
                >
                  {item.axis}
                </text>
                {item.state === 'Unknown' && (
                  <>
                    <circle className="radar-dot unknown" cx={center + Math.cos(angle) * radius * 0.72} cy={center + Math.sin(angle) * radius * 0.72} r="8" />
                    <text
                      className="radar-unknown-mark"
                      x={center + Math.cos(angle) * radius * 0.72}
                      y={center + Math.sin(angle) * radius * 0.72}
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      ?
                    </text>
                  </>
                )}
              </g>
            );
          })}
          {knownPoints.length >= 3 && <polygon className="radar-fill" points={polygon} />}
          {knownPoints.length >= 2 && (
            <polyline
              className="radar-line"
              points={knownPoints.length >= 3 ? `${polygon} ${knownPoints[0].x.toFixed(1)},${knownPoints[0].y.toFixed(1)}` : polygon}
            />
          )}
          {knownPoints.map((point) => (
            <circle key={point.axis} className="radar-dot" cx={point.x} cy={point.y} r="3.5" />
          ))}
        </svg>
        <div className="radar-score-list">
          {data.map((item) => (
            <div className="radar-score-row" key={item.axis}>
              <div className="radar-score-meta">
                <span>{item.axis}</span>
                <strong className={item.score == null ? 'unknown' : ''}>{item.score == null ? 'Unknown' : item.score}</strong>
              </div>
              <div className={`radar-bar ${item.score == null ? 'unknown' : ''}`}>
                {item.score != null && <span style={{ width: `${radarScorePercent(item.score)}%` }} />}
              </div>
              <div className="radar-basis">{item.basis}</div>
            </div>
          ))}
        </div>
      </div>
      <Text type="secondary" className="radar-note">Unknown 表示证据不足，不按 0 分处理。</Text>
    </section>
  );
}

function AssessPrerequisites({ status, loading, error, onRetry, onOpenAiSettings, onOpenResumeMaterials }) {
  const statusItem = (label, value, color) => (
    <div className="assess-prereq-item">
      <span>{label}</span>
      <Tag color={color}>{value}</Tag>
    </div>
  );
  if (loading) {
    return (
      <section className="assess-prereq">
        <SectionHeader title="生成前置条件" />
        <Text type="secondary">正在检查在线简历、候选人匹配报告和统一 AI 设置。</Text>
      </section>
    );
  }
  if (error) {
    return (
      <section className="assess-prereq">
        <SectionHeader title="生成前置条件" />
        <Alert
          type="warning"
          showIcon
          message="前置条件暂不可读"
          description={error}
          action={<Button size="small" onClick={onRetry}>重新检查</Button>}
        />
      </section>
    );
  }
  if (!status) return null;
  const blockers = Array.isArray(status.blockers) ? status.blockers : [];
  return (
    <section className="assess-prereq">
      <SectionHeader title="生成前置条件" />
      <div className="assess-prereq-grid">
        {statusItem('在线简历', status.has_resume ? (status.is_paywalled ? '付费墙' : '已存在') : '缺少', status.has_resume && !status.is_paywalled ? 'green' : 'orange')}
        {statusItem('统一 AI 设置', status.ai_config_present ? '已配置' : '缺少', status.ai_config_present ? 'green' : 'gold')}
        {statusItem('候选人匹配报告', status.has_v1_report ? (status.latest_report_is_local_demo ? '本地样本' : '已存在') : '未生成', status.has_v1_report ? (status.latest_report_is_local_demo ? 'purple' : 'cyan') : 'default')}
        {statusItem('本地样本', status.can_local_demo ? '可生成' : '不可生成', status.can_local_demo ? 'blue' : 'default')}
      </div>
      {(!status.has_resume || status.is_paywalled || !status.ai_config_present) && (
        <Space wrap>
          {(!status.has_resume || status.is_paywalled) && onOpenResumeMaterials && <Button size="small" onClick={onOpenResumeMaterials}>查看简历材料</Button>}
          {!status.ai_config_present && onOpenAiSettings && <Button size="small" onClick={onOpenAiSettings}>查看 AI 设置</Button>}
        </Space>
      )}
      {blockers.length > 0 && (
        <div className="assess-blockers">
          {blockers.map((item, index) => <div key={index}>{item}</div>)}
        </div>
      )}
    </section>
  );
}

function AiReviewPanel({
  candidate,
  list,
  sections,
  onAssess,
  assessBusy,
  readOnly,
  onOpenAiSettings,
  onOpenResumeMaterials,
  aiResumeIntent,
  onAiResumeConsumed,
}) {
  const [assessStatus, setAssessStatus] = useState(null);
  const [assessStatusLoading, setAssessStatusLoading] = useState(false);
  const [assessStatusError, setAssessStatusError] = useState('');
  const [assessStatusAttempt, setAssessStatusAttempt] = useState(0);
  const [aiFirstUseOpen, setAiFirstUseOpen] = useState(false);
  const [aiFirstUseError, setAiFirstUseError] = useState('');
  const [aiCapabilityChecking, setAiCapabilityChecking] = useState(false);
  const rows = list || [];
  const latest = rows[0];
  const rep = latest ? soReport(latest) : null;
  const v1 = isV1Report(rep);
  const localDemo = isLocalDemoReport(rep);
  const reportSource = latest ? aiReportSource(rep) : null;

  useEffect(() => {
    let alive = true;
    if (!candidate || !candidate.internal_id) {
      setAssessStatus(null);
      setAssessStatusError('');
      setAssessStatusLoading(false);
      return () => { alive = false; };
    }
    setAssessStatusLoading(true);
    setAssessStatusError('');
    api.assessStatus(candidate.internal_id)
      .then((data) => {
        if (!alive) return;
        setAssessStatus(data.status || null);
      })
      .catch((err) => {
        if (!alive) return;
        setAssessStatus(null);
        setAssessStatusError(err.message);
      })
      .finally(() => {
        if (alive) setAssessStatusLoading(false);
      });
    return () => { alive = false; };
  }, [candidate && candidate.internal_id, rows.length, assessStatusAttempt]);

  const banners = [];
  if (rep && rep.deep_profile_missing) banners.push('该岗位还没生成深度画像，本次只对照简版画像，参考价值有限。');
  else if (latest && Number(latest.profile_confirmed) === 0) banners.push('评估所用画像尚未确认，结论仅供初筛参考。');
  if (latest && rep && !v1) banners.push('这是一条历史第二意见，不是当前候选人匹配报告；重新生成后才会展示正式雷达。');
  if (localDemo) banners.push('当前展示的是本地样本报告，只用于验证 UI/DB/能力雷达链路，不代表真实 AI 判断。');

  const dimensions = v1 && Array.isArray(rep.dimension_matches) ? rep.dimension_matches : [];
  const summary = clipText(rep && rep.overall, 160);
  const matches = v1
    ? dimensions.filter((item) => item.state === 'Match').slice(0, 4).map((item) => ({
      title: item.dimension,
      text: explanationText(item) || evidenceText(item.evidence),
      tag: stateTag(item.state),
    }))
    : rep && Array.isArray(rep.matches) && rep.matches.length
      ? rep.matches.slice(0, 4).map((item) => ({ title: item.point, text: item.evidence, tag: item.competency }))
      : [];
  const risks = v1
    ? [
      ...(Array.isArray(rep.risks) ? rep.risks.map((item) => ({ title: item.point || item.dimension || '待核实点', text: item.basis || item.reason || item.source_risk, tag: item.severity || '风险' })) : []),
      ...dimensions.filter((item) => item.state === 'Mismatch').map((item) => ({ title: item.dimension, text: item.risk || explanationText(item), tag: stateTag(item.state) })),
    ].slice(0, 4)
    : rep && Array.isArray(rep.concerns) && rep.concerns.length
      ? rep.concerns.slice(0, 4).map((item) => ({ title: item.point, text: item.basis, tag: item.severity || '中' }))
      : [];
  const unknowns = v1
    ? (Array.isArray(rep.unknowns) && rep.unknowns.length
      ? rep.unknowns
      : dimensions.filter((item) => item.state === 'Unknown').map((item) => ({ dimension: item.dimension, reason: item.risk || '简历证据不足' })))
    : [];
  const questions = v1 && Array.isArray(rep.interview_questions) ? rep.interview_questions : [];
  const advice = v1
    ? (questions[0] && questions[0].question) || '建议面试围绕 Unknown 和风险维度继续核实。'
    : (rep && has(rep.advice) ? rep.advice : '报告未提供建议，请由 HR 基于原始材料人工复核。');

  async function requestRealAssessment() {
    if (assessBusy || aiCapabilityChecking) return;
    setAiCapabilityChecking(true);
    const access = await readExternalAiCapability('candidate_assessment');
    setAiCapabilityChecking(false);
    if (access.available) {
      await onAssess('real');
      return;
    }
    setAiFirstUseError(access.readable ? '' : access.error);
    setAiFirstUseOpen(true);
  }

  function continueCandidateReviewManually() {
    setAiFirstUseOpen(false);
    globalThis.setTimeout(() => globalThis.document?.getElementById('candidate-ai-assessment-action')?.focus(), 0);
  }

  async function openCandidateAiSettings(options = {}) {
    setAiFirstUseOpen(false);
    await onOpenAiSettings?.({
      capability: 'candidate_assessment',
      source: 'candidate-detail',
      sourceLabel: '候选人 AI 初评',
      targetId: candidate.internal_id,
      targetLabel: candidate.name,
      jobId: candidate.job_id,
      focusTargetId: 'candidate-ai-assessment-action',
      resumeAction: options.resumeAction !== false,
    });
  }

  useEffect(() => {
    if (
      aiResumeIntent?.capability !== 'candidate_assessment'
      || String(aiResumeIntent.targetId) !== String(candidate?.internal_id)
      || assessStatusLoading
      || (!assessStatus && !assessStatusError)
    ) return;
    const intent = aiResumeIntent;
    onAiResumeConsumed?.(intent.id);
    globalThis.setTimeout(() => {
      const target = globalThis.document?.getElementById(intent.focusTargetId || 'candidate-ai-assessment-action');
      target?.focus?.({ preventScroll: false });
      target?.scrollIntoView?.({ block: 'nearest' });
      if (intent.resumeAction !== false && assessStatus?.can_real_assess) void onAssess('real');
    }, 0);
  }, [
    aiResumeIntent?.id,
    candidate?.internal_id,
    assessStatusLoading,
    assessStatusError,
    assessStatus?.can_real_assess,
  ]);

  const assessmentAction = !readOnly && (
    <Space className="ai-actions" size={8} wrap>
      <Button
        id="candidate-ai-assessment-action"
        type={assessStatus?.can_real_assess ? 'default' : 'primary'}
        loading={assessBusy || aiCapabilityChecking}
        disabled={assessStatusLoading || !!assessStatusError}
        onClick={requestRealAssessment}
      >
        {assessStatus?.can_real_assess
          ? (rows.length ? '重新生成匹配报告' : '生成真实 AI 报告')
          : '启用真实 AI 辅助'}
      </Button>
      {assessStatus && !assessStatus.can_real_assess && assessStatus.can_local_demo && (
        <Button loading={assessBusy} onClick={() => onAssess('local-demo')}>
          {rows.length ? '重新生成本地样本报告' : '生成本地样本报告'}
        </Button>
      )}
    </Space>
  );

  const aiFirstUsePrompt = (
    <ExternalAiFirstUsePrompt
      open={aiFirstUseOpen}
      capability="candidate_assessment"
      readError={aiFirstUseError}
      onEnable={openCandidateAiSettings}
      onManual={continueCandidateReviewManually}
      onClose={continueCandidateReviewManually}
    />
  );

  const phaseHeader = (
    <div className="ai-phase-strip ai-phase-initial">
      <div>
        <span>AI 初评</span>
        <strong>资料/简历阶段</strong>
      </div>
      <Text type="secondary">和面试后的 AI 复盘分开查看。</Text>
    </div>
  );

  const scoreRow = (
    <div className="ai-score-row">
      <Space size={[6, 6]} wrap>
        <SabcBadge value={candidate.sabc} />
        {has(candidate.verdict_label) && <Tag>{candidate.verdict_label}</Tag>}
        {has(candidate.sabc_source) ? <Tag>评级来源 {candidate.sabc_source}</Tag> : <Tag>评级来源 待配置</Tag>}
        {reportSource && <Tag color={reportSource.color}>{reportSource.label}</Tag>}
      </Space>
      {latest && (
        <Text type="secondary" className="ai-time">
          评估时间：{fmtTime(latest.created_at)}
          {rep && rep.deep_profile_version != null ? ` · 画像 v${rep.deep_profile_version}` : ''}
        </Text>
      )}
    </div>
  );

  if (!latest) {
    return (
      <div className="ai-clean-panel">
        {phaseHeader}
        {scoreRow}
        <AssessPrerequisites
          status={assessStatus}
          loading={assessStatusLoading}
          error={assessStatusError}
          onRetry={() => setAssessStatusAttempt((current) => current + 1)}
          onOpenAiSettings={() => openCandidateAiSettings({ resumeAction: false })}
          onOpenResumeMaterials={onOpenResumeMaterials}
        />
        <section className="ai-summary" role="status" aria-live="polite">
          <InfoCircleOutlined className="ai-summary-icon" />
          <div>
            <SectionHeader title="AI 初评未运行" action={<Tag>未运行</Tag>} />
            <p>{emptyAssessmentCopy(assessStatus, assessStatusLoading, readOnly)}</p>
            <Text type="secondary">没有 AI 报告时，不会把候选人简介、规则评级或空值拼装成 AI 结论。</Text>
          </div>
        </section>
        <EmptyBox text="匹配点、风险点和 Unknown 尚未生成。Unknown 表示证据不足，不按 0 分处理，也不代表候选人不合格。" />
        <section className="ai-advice">
          <div>
            <SectionHeader title="生成入口" action={<InfoCircleOutlined />} />
            <p>完成前置条件后，HR 可按需生成辅助报告。</p>
          </div>
          {assessmentAction}
        </section>
        {aiFirstUsePrompt}
      </div>
    );
  }

  return (
    <div className="ai-clean-panel">
      {phaseHeader}
      {scoreRow}
      {banners.map((b, i) => <div className="so-banner" key={i}>{b}</div>)}
      <AssessPrerequisites
        status={assessStatus}
        loading={assessStatusLoading}
        error={assessStatusError}
        onRetry={() => setAssessStatusAttempt((current) => current + 1)}
        onOpenAiSettings={() => openCandidateAiSettings({ resumeAction: false })}
        onOpenResumeMaterials={onOpenResumeMaterials}
      />
      <RadarProfile report={rep} />
      <section className="ai-summary">
        <RobotOutlined className="ai-summary-icon" />
        <div>
          <SectionHeader title={v1 ? 'AI匹配报告' : 'AI摘要'} action={<Tag color={reportSource.color}>{reportSource.label}</Tag>} />
          <p>{summary || '报告未提供摘要，请查看原始材料并由 HR 人工复核。'}</p>
        </div>
      </section>
      <div className="ai-review-grid">
        <section className="ai-column match">
          <SectionHeader title="匹配点" count={matches.length} />
          {matches.length ? matches.map((item, i) => <PointCard key={i} type="match" {...item} />) : <EmptyBox text="暂无明确匹配点" />}
        </section>
        <section className="ai-column risk">
          <SectionHeader title="风险点" count={risks.length} />
          {risks.length ? risks.map((item, i) => <PointCard key={i} type="risk" {...item} />) : <EmptyBox text="暂无明显风险点，面试仍需核实关键经历。" />}
        </section>
      </div>
      {v1 && (
        <div className="v1-report-grid">
          <section className="v1-report-block">
            <SectionHeader title="Unknown" count={unknowns.length} />
            {unknowns.length ? unknowns.slice(0, 6).map((item, i) => (
              <div className="v1-unknown-row" key={i}>
                <strong>{item.dimension || item.point || '待判断维度'}</strong>
                <span>{item.reason || item.question || '没有足够简历证据，建议面试核实。'}</span>
              </div>
            )) : <EmptyBox text="暂无 Unknown 维度" />}
          </section>
          <section className="v1-report-block">
            <SectionHeader title="面试问题" count={questions.length} />
            {questions.length ? questions.slice(0, 5).map((item, i) => (
              <div className="v1-question-row" key={i}>
                <strong>{item.question}</strong>
                {has(item.verification_target) && <span>{item.verification_target}</span>}
              </div>
            )) : <EmptyBox text="暂无建议问题" />}
          </section>
        </div>
      )}
      <section className="ai-advice">
        <div>
          <SectionHeader title="建议" action={<InfoCircleOutlined />} />
          <p>{clipText(advice, 150)}</p>
          {v1 && <Text type="secondary" className="v1-disclaimer">{rep.disclaimer || '本报告仅用于招聘辅助。'}</Text>}
        </div>
        {assessmentAction}
      </section>
      {rows.length > 1 && (
        <Collapse
          className="history-collapse"
          bordered={false}
          ghost
          items={[
            {
              key: '1',
              label: `历史评估（${rows.length - 1} 次）`,
              children: rows.slice(1).map((r, i) => {
                const p = soReport(r);
                return (
                  <div key={i} className="history-line">
                    {fmtTime(r.created_at)}：{clipText((p && p.overall) || '数据异常', 120)}
                  </div>
                );
              }),
            },
          ]}
        />
      )}
      {aiFirstUsePrompt}
    </div>
  );
}

function WriteActions({ actions }) {
  const rows = actions || [];
  if (!rows.length) return <Text type="secondary">暂无自动动作记录。</Text>;
  return rows.map((a, i) => (
    <div key={i} style={{ padding: '6px 0', borderBottom: i < rows.length - 1 ? '1px solid #f0f0f0' : 'none' }}>
      <Space size={6}>
        <Text strong>{a.action_type || ''}</Text>
        <Tag>{a.status || ''}</Tag>
        {has(a.decision) && <Tag>{a.decision}</Tag>}
      </Space>
      <div style={{ fontSize: 12, color: 'var(--hb-muted)' }}>{fmtTime(a.executed_at || a.updated_at || a.created_at)}</div>
    </div>
  ));
}

function flowTime(row) {
  return fmtTime(row.executed_at || row.updated_at || row.created_at);
}

function flowSortTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function FlowEvent({ title, meta, body }) {
  return (
    <div className="flow-event">
      <div className="flow-event-dot" aria-hidden="true" />
      <div>
        <div className="flow-event-head">
          <strong>{title}</strong>
          {has(meta) && <span>{meta}</span>}
        </div>
        {has(body) && <p>{body}</p>}
      </div>
    </div>
  );
}

const FLOW_STATUS_LABELS = Object.freeze({
  new: '新入库',
  screening: '初筛中',
  contact_pending: '待沟通',
  communicating: '沟通中',
  resume_pending: '待补简历',
  interview_pending_schedule: '待确认面试时间',
  interview_scheduled: '已安排面试',
  interview_in_progress: '面试中',
  interview_pending_review: '待面试复盘',
  report_pending_confirmation: '报告待确认',
  report_confirmed: '报告已确认',
  legacy_review_required: '待人工复核',
  under_review: '人工复核中',
  pending: '待处理',
  running: '处理中',
  success: '已完成',
  done: '已完成',
  completed: '已完成',
  confirmed: '已确认',
  recorded: '已记录',
  failed: '失败',
  error: '异常',
  hold: '暂缓',
  rejected: '已淘汰',
  talent_pool: '已进入人才库',
  hired: '已录用',
  candidate_withdrew: '候选人已放弃',
  do_not_contact: '不再联系',
});
const FLOW_TODO_LABELS = Object.freeze({
  candidate_rating_required: '候选人待评级',
  contact_required: '候选人待沟通',
  resume_followup_required: '跟进候选人简历',
  assessment_report_required: '补充候选人测评报告',
  assessment_review_required: '核对测评报告信息',
  assessment_binding_confirmation_required: '确认测评报告归属',
  candidate_next_action_due: '候选人下一步即将到期',
  candidate_next_action_overdue: '候选人下一步已逾期',
  offer_send_followup_required: '准备发送 Offer',
  offer_response_followup_required: '跟进 Offer 回复',
  offer_negotiation_followup_required: '跟进 Offer 协商',
  onboarding_handoff_required: '完成入职交接',
  material_classification_required: '面试材料待分类',
  material_assignment_required: '面试材料待归属',
  schedule_confirmation_required: '人工确认面试时间',
  interview_preparation_required: '准备面试脚本',
  report_draft_required: '生成面试报告草稿',
  report_fact_review_required: '复核报告关键事实',
  report_confirmation_required: '人工确认面试报告',
  final_review_required: '填写结构化终评',
  final_disposition_confirmation_required: '确认终评处置',
  legacy_status_review_required: '复核历史状态',
  task_failed_retryable: '失败任务可重试',
});
const FLOW_SOURCE_LABELS = Object.freeze({
  candidate: '候选人资料',
  candidate_status: '候选人状态',
  interview_session: '面试轮次',
  interview_recording: '面试记录',
  interview_report: '面试报告',
  assessment_report: '测评报告',
  assessment_document: '测评报告',
  application: '招聘申请',
  comment: 'HR 备注',
  contact: '联系方式记录',
  hr_manual: 'HR 人工操作',
  manual_hr_action: 'HR 人工操作',
  system: '系统',
  write_action: '自动动作',
});
const FLOW_EVENT_LABELS = Object.freeze({
  candidate_created: '候选人已入库',
  status_changed: '招聘状态已更新',
  interview_scheduled: '面试已安排',
  interview_completed: '面试已完成',
  report_generated: '面试报告已生成',
  report_confirmed: '面试报告已确认',
  manual_disposition: 'HR 已完成人工处置',
});

function flowStatusLabel(value, fallback = '待人工复核') {
  const key = String(value || '').trim();
  return key ? (FLOW_STATUS_LABELS[key] || fallback) : '';
}

function flowSourceLabel(value) {
  const key = String(value || '').trim();
  return key ? (FLOW_SOURCE_LABELS[key] || '业务记录') : '';
}

function flowTodoLabel(value) {
  const key = String(value || '').trim();
  return key ? (FLOW_TODO_LABELS[key] || '待人工复核事项') : '';
}

function timelineVisibleRecordCount(timeline) {
  if (!timeline || timeline.data_class === 'fixture') return 0;
  const projectedCount = (Array.isArray(timeline.events) ? timeline.events.length : 0)
    + (Array.isArray(timeline.pending_todos) ? timeline.pending_todos.length : 0);
  const contractCount = Number(timeline.visible_record_count);
  return Number.isInteger(contractCount) && contractCount >= 0 ? contractCount : projectedCount;
}

function timelineEventBody(event) {
  return joinParts([
    event && event.detail,
    event && event.action_required ? `待办：${flowTodoLabel(event.action_required)}` : '',
  ]);
}

function decisionSummaryFromTimeline(timeline) {
  if (!timeline) {
    return {
      task: '确定性待办尚未加载',
      taskMeta: '读取统一时间线后显示当前任务',
      workflow: '招聘状态尚未加载',
      taskCode: '',
      taskTodo: null,
    };
  }
  if (timeline.data_class === 'fixture') {
    return {
      task: 'Fixture 不进入正式待办',
      taskMeta: '当前记录已与正式时间线隔离',
      workflow: 'Fixture 已隔离',
      taskCode: '',
      taskTodo: null,
    };
  }
  const todos = Array.isArray(timeline.pending_todos) ? timeline.pending_todos : null;
  const firstTodo = todos && todos[0];
  const remainingCount = todos ? Math.max(0, todos.length - 1) : 0;
  return {
    task: firstTodo ? flowTodoLabel(firstTodo.code) : (todos ? '当前无确定性待办' : '确定性待办尚未加载'),
    taskMeta: firstTodo
      ? joinParts([
        remainingCount ? `另有 ${remainingCount} 项` : '',
        flowSourceLabel(firstTodo.source?.entity_type),
        fmtTime(firstTodo.source?.time),
      ]) || '来自统一时间线'
      : (todos ? '统一时间线当前未列出待办' : '待办字段尚未加载'),
    workflow: has(timeline.workflow_status)
      ? flowStatusLabel(timeline.workflow_status, '状态待人工复核')
      : '招聘状态尚未加载',
    taskCode: firstTodo?.code || '',
    taskTodo: firstTodo || null,
  };
}

function CandidateFlowPanel({ data, actions }) {
  const rows = [
    ...(data.status_history || []).map((row) => ({
      id: `status-${row.id}`,
      time: row.created_at,
      title: `${flowStatusLabel(row.from_status, '初始')} → ${flowStatusLabel(row.to_status, '状态变更')}`,
      meta: joinParts([flowSourceLabel(row.layer), flowSourceLabel(row.source), row.who, fmtTime(row.created_at)]),
      body: row.reason || '',
    })),
    ...(data.comment || []).map((row) => ({
      id: `comment-${row.id}`,
      time: row.created_at,
      title: row.purpose_tag || '备注',
      meta: joinParts([row.author, row.polarity, fmtTime(row.created_at)]),
      body: row.body || '',
    })),
    ...(data.contact || []).map((row) => ({
      id: `contact-${row.id}`,
      time: row.created_at,
      title: `${row.type || '联系方式'}已记录`,
      meta: joinParts([row.source, row.confidence, fmtTime(row.created_at)]),
      body: '联系方式加密存储，当前页面只展示记录状态。',
    })),
  ].sort((a, b) => flowSortTime(b.time) - flowSortTime(a.time));
  const actionRows = actions || [];

  return (
    <div className="flow-panel">
      <div className="flow-metrics">
        <div>
          <strong>{data.status_history.length}</strong>
          <span>状态流转</span>
        </div>
        <div>
          <strong>{data.comment.length}</strong>
          <span>备注</span>
        </div>
        <div>
          <strong>{actionRows.length}</strong>
          <span>自动动作</span>
        </div>
      </div>
      <div className="flow-grid">
        <section className="flow-section">
          <SectionHeader title="沟通与状态时间线" count={rows.length} />
          {rows.length ? rows.map((row) => (
            <FlowEvent key={row.id} title={row.title} meta={row.meta} body={row.body} />
          )) : <EmptyBox text="暂无沟通、备注或状态流转记录。" />}
        </section>
        <section className="flow-section">
          <SectionHeader title="自动动作" count={actionRows.length} />
          {actionRows.length ? actionRows.map((action, index) => (
            <FlowEvent
              key={action.id || index}
              title={joinParts([FLOW_EVENT_LABELS[action.action_type] || '自动动作', flowStatusLabel(action.status, '状态待复核')]) || '自动动作'}
              meta={joinParts([flowStatusLabel(action.decision, '需人工查看'), flowTime(action)])}
              body={action.boss_code || ''}
            />
          )) : <WriteActions actions={actionRows} />}
        </section>
      </div>
    </div>
  );
}

function CanonicalTimelinePanel({ timeline }) {
  if (!timeline) return <EmptyBox text="统一时间线尚未加载。" />;
  if (timeline.data_class === 'fixture') return <EmptyBox text="Fixture 已从正式时间线和待办隔离。" />;
  return (
    <div className="flow-panel">
      <div className="flow-metrics">
        <div><strong>{timeline.events.length}</strong><span>结构化事件</span></div>
        <div><strong>{timeline.pending_todos.length}</strong><span>确定性待办</span></div>
        <div><strong>{flowStatusLabel(timeline.workflow_status)}</strong><span>当前招聘状态</span></div>
      </div>
      <div className="flow-grid">
        <section className="flow-section">
          <SectionHeader title="招聘进展时间线" count={timeline.events.length} />
          {timeline.events.length ? timeline.events.map((event) => (
            <FlowEvent
              key={event.event_id}
              title={event.summary || FLOW_EVENT_LABELS[event.event_type] || '招聘进展已更新'}
              meta={joinParts([
                flowStatusLabel(event.status_code, '状态已记录'),
                event.source_entity && `${flowSourceLabel(event.source_entity.type)} #${event.source_entity.id}`,
                fmtTime(event.occurred_at),
              ])}
              body={timelineEventBody(event)}
            />
          )) : <EmptyBox text="暂无结构化事件。" />}
        </section>
        <section className="flow-section">
          <SectionHeader title="候选人待办" count={timeline.pending_todos.length} />
          {timeline.pending_todos.length ? timeline.pending_todos.map((item) => (
            <FlowEvent
              key={item.todo_id}
              title={flowTodoLabel(item.code)}
              meta={joinParts([flowSourceLabel(item.source?.entity_type), flowStatusLabel(item.source?.status, '待处理'), fmtTime(item.source?.time)])}
              body=""
            />
          )) : <EmptyBox text="当前候选人无确定性待办。" />}
        </section>
      </div>
    </div>
  );
}

const MANUAL_ACTIONS = Object.freeze([
  { action: 'continue_process', label: '继续推进' },
  { action: 'hold', label: '暂缓' },
  { action: 'reject', label: '淘汰', danger: true },
  { action: 'talent_pool', label: '进入人才库' },
  { action: 'withdraw', label: '主动放弃', danger: true },
  { action: 'hired', label: '标记录用' },
]);

// Single source of truth for which dispositions render as destructive. Derived
// from MANUAL_ACTIONS above so the menu and the confirm dialog cannot drift from
// it — or from each other. 标记录用 is a positive terminal outcome, not a
// destructive one, which is why it carries no danger flag.
const DESTRUCTIVE_DISPOSITIONS = Object.freeze(
  MANUAL_ACTIONS.filter((item) => item.danger).map((item) => item.action),
);

const TASK_PRIMARY_ACTIONS = Object.freeze({
  candidate_rating_required: { kind: 'domain', domain: 'profile', label: '查看候选人资料' },
  candidate_screening_required: { kind: 'domain', domain: 'profile', label: '继续资料筛选' },
  legacy_status_review_required: { kind: 'domain', domain: 'flow', label: '复核历史状态' },
  contact_required: { kind: 'communication', label: '记录沟通事实' },
  communication_followup_required: { kind: 'communication', label: '记录沟通事实' },
  resume_followup_required: { kind: 'communication', label: '记录沟通事实' },
  assessment_report_required: { kind: 'domain', domain: 'assessment', label: '打开测评报告' },
  assessment_review_required: { kind: 'domain', domain: 'assessment', label: '核对测评报告' },
  assessment_binding_confirmation_required: { kind: 'domain', domain: 'assessment', label: '确认测评归属' },
  candidate_next_action_due: { kind: 'domain', domain: 'flow', label: '查看下一步' },
  candidate_next_action_overdue: { kind: 'domain', domain: 'flow', label: '立即跟进' },
  offer_send_followup_required: { kind: 'domain', domain: 'flow', label: '跟进 Offer' },
  offer_response_followup_required: { kind: 'domain', domain: 'flow', label: '查看 Offer' },
  offer_negotiation_followup_required: { kind: 'domain', domain: 'flow', label: '继续协商' },
  onboarding_handoff_required: { kind: 'domain', domain: 'flow', label: '入职交接' },
  schedule_confirmation_required: { kind: 'todo', label: '确认面试时间' },
  interview_preparation_required: { kind: 'todo', label: '准备面试脚本' },
  report_draft_required: { kind: 'todo', label: '填写面试报告' },
  report_fact_review_required: { kind: 'todo', label: '复核报告事实' },
  report_confirmation_required: { kind: 'todo', label: '确认面试报告' },
  final_review_required: { kind: 'domain', domain: 'final-review', label: '打开结构化终评' },
  final_disposition_confirmation_required: { kind: 'domain', domain: 'final-review', label: '打开结构化终评' },
  task_failed_retryable: { kind: 'domain', domain: 'flow', label: '查看失败记录' },
});

const MANUAL_ACTION_CONFIRMATIONS = Object.freeze({
  continue_process: {
    title: '确认继续推进当前候选人？',
    target: '当前岗位：继续推进（保持申请有效并进入后续人工流程）',
    consequence: '执行后会刷新候选人队列和待办；不会自动发消息、请求简历、安排面试或调用 AI。',
  },
  hold: {
    title: '确认暂缓当前岗位？',
    target: '当前岗位暂缓（保留当前岗位申请）',
    consequence: '候选人会进入当前岗位的“暂缓”队列；不会影响其他岗位关系，HR 可稍后重新推进。',
  },
  reject: {
    title: '确认淘汰候选人？',
    target: '淘汰（结束当前岗位申请）',
    consequence: '执行后当前申请会结束；后续如需继续推进，可由 HR 使用“重新进入”新建申请轮次。',
  },
  talent_pool: {
    title: '确认加入人才库？',
    target: '人才库（结束当前岗位申请）',
    consequence: '执行后当前申请会结束，候选人资料会保留在人才库中。',
  },
  withdraw: {
    title: '确认记录候选人主动放弃？',
    target: '主动放弃（结束当前岗位申请）',
    consequence: '请仅在候选人明确表达放弃时执行；后续如需继续推进，可由 HR 使用“重新进入”新建申请轮次。',
  },
  hired: {
    title: '确认标记录用？',
    target: '已录用（录用终态）',
    consequence: '执行后当前申请会结束；录用终态不能通过普通“重新进入”撤销。',
  },
  reenter: {
    title: '确认让候选人重新进入当前岗位？',
    target: '当前岗位：重新进入（新建有效申请轮次）',
    consequence: '系统会保留既有历史并建立新的当前申请轮次；不会恢复旧轮次的终态或自动执行后续动作。',
  },
});

const MANUAL_ACTION_FALLBACK_CODES = Object.freeze({
  continue_process: 'under_review',
  hold: 'hold',
  reject: 'rejected',
  talent_pool: 'talent_pool',
  withdraw: 'candidate_withdrew',
  hired: 'hired',
  reenter: 'under_review',
});
const MANUAL_ACTION_FALLBACK_ERRORS = new Set([
  'F018_DISABLED',
  'APPLICATION_EPISODE_UNAVAILABLE',
  'APPLICATION_NOT_FOUND',
]);

function canUseManualActionFallback(error) {
  if (MANUAL_ACTION_FALLBACK_ERRORS.has(error && error.code)) return true;
  return /Application.*未启用|申请轮次尚未启用|缺少申请轮次/.test(String(error && error.message || ''));
}

function manualActionLabel(application, candidate) {
  if (application && application.status === 'active') {
    if (application.disposition_action === 'hold') return '暂缓';
    if (application.disposition_action === 'continue_process') return '继续推进';
    return '待 HR 处理';
  }
  const byCode = {
    new: '新入库',
    under_review: '评估中',
    rejected: '淘汰',
    talent_pool: '人才库',
    hired: '已录用',
    candidate_withdrew: '主动放弃',
    do_not_contact: '不再联系',
  };
  const code = candidate.disposition_code === 'do_not_contact' && candidate.disposition_status === '主动放弃'
    ? 'candidate_withdrew'
    : candidate.disposition_code
    || (candidate.disposition_status === '主动放弃' ? 'candidate_withdrew' : '')
    || (candidate.disposition_status === '不再联系' ? 'do_not_contact' : '')
    || candidate.disposition_status
    || '';
  return byCode[code] || candidate.disposition_status || '待 HR 处理';
}

function candidateDispositionLabel(candidate) {
  const code = candidate.disposition_code || candidate.disposition_status || '';
  const labels = {
    new: '新入库',
    under_review: '评估中',
    continue_process: '继续推进',
    hold: '暂缓',
    rejected: '淘汰',
    talent_pool: '人才库',
    candidate_withdrew: '主动放弃',
    do_not_contact: '不再联系',
    hired: '已录用',
  };
  if (candidate.disposition_status === '主动放弃') return '主动放弃';
  if (candidate.disposition_status === '不再联系') return '不再联系';
  return labels[code] || candidate.disposition_status;
}

function CommunicationBackfillPanel({
  currentCode,
  code,
  reason,
  busy,
  notice,
  readOnly,
  onCodeChange,
  onReasonChange,
  onSubmit,
}) {
  const isRollback = (COMMUNICATION_RANK[code] ?? 0) < (COMMUNICATION_RANK[currentCode] ?? 0);
  const unchanged = code === currentCode;
  const disabled = readOnly || busy || !code || unchanged || (isRollback && !String(reason || '').trim());
  return (
    <Card
      size="small"
      className="detail-card candidate-command-card communication-backfill-card"
      classNames={{
        header: 'candidate-command-card-header',
        body: 'candidate-command-card-body',
        title: 'candidate-command-card-title',
        extra: 'candidate-command-card-extra',
      }}
      title="记录沟通结果"
      extra={<span className="candidate-command-state candidate-command-state-fact">人工事实回填</span>}
    >
      <Paragraph type="secondary" className="candidate-command-copy">
        记录已在 Boss、电话等渠道发生的沟通；不代发消息，也不改变 HR 处置。
      </Paragraph>
      <div className="communication-backfill-form">
        <label>
          <span>当前沟通事实</span>
          <Select
            className="communication-backfill-control"
            aria-label="选择已发生的沟通事实"
            value={code}
            options={COMMUNICATION_OPTIONS}
            disabled={readOnly || busy}
            onChange={onCodeChange}
          />
        </label>
        {unchanged ? (
          <Text type="secondary" className="communication-backfill-idle">选择不同事实后填写备注并确认保存。</Text>
        ) : (
          <>
            <label>
              <span>备注{isRollback ? '（回退更正必填）' : '（可选）'}</span>
              <Input.TextArea
                className="communication-backfill-control communication-backfill-note"
                name="candidate-communication-note"
                autoComplete="off"
                aria-label="沟通事实备注"
                value={reason}
                maxLength={300}
                autoSize={{ minRows: 2, maxRows: 3 }}
                placeholder={isRollback ? '说明为什么需要更正为较早状态' : '例如：候选人表示本周五前补发简历'}
                disabled={readOnly || busy}
                onChange={(event) => onReasonChange(event.target.value)}
              />
            </label>
            <div className="communication-backfill-actions">
              <Button type="primary" loading={busy} disabled={disabled} onClick={onSubmit}>保存沟通事实</Button>
              <Text className="communication-backfill-help" type="secondary">拒绝、推进和录用仍在“HR 人工处置”中单独完成。</Text>
            </div>
          </>
        )}
      </div>
      {code === 'resume_received' && (
        <Alert type="info" showIcon message="下一步：核对新简历并继续本地筛选；收到简历不会自动推进或处置候选人。" />
      )}
      {isRollback && <Alert type="warning" showIcon message="这是沟通事实回退更正，需要填写原因；不会回退面试或处置状态。" />}
      {notice && <Alert type={notice.type} showIcon message={notice.message} />}
    </Card>
  );
}

function ManualDispositionPanel({
  candidate,
  state,
  loading,
  readError,
  actionError,
  busy,
  readOnly,
  taskCode,
  taskTodo,
  onAction,
  onOpenCommunication,
  onOpenTaskDomain,
  onOpenTaskTodo,
  communicationTriggerRef,
}) {
  const panelRef = useRef(null);
  const moreActionButtonRef = useRef(null);
  const reentryButtonRef = useRef(null);
  const menuSelectionRef = useRef(false);
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const active = (state && state.active_application)
    || (candidate.application_status === 'active' ? {
      status: 'active',
      disposition_action: candidate.application_disposition_action,
    } : null);
  const applications = state && Array.isArray(state.applications) ? state.applications : [];
  const latest = applications[0] || null;
  const candidateCode = candidate.disposition_code === 'do_not_contact' && candidate.disposition_status === '主动放弃'
    ? 'candidate_withdrew'
    : candidate.disposition_code
    || (candidate.disposition_status === '主动放弃' ? 'candidate_withdrew' : '')
    || (candidate.disposition_status === '不再联系' ? 'do_not_contact' : '');
  const globalDoNotContact = candidateCode === 'do_not_contact';
  const hired = candidateCode === 'hired';
  const terminalWithoutState = ['rejected', 'talent_pool', 'hired', 'candidate_withdrew', 'do_not_contact'].includes(candidateCode);
  const shouldReenter = !globalDoNotContact && !hired && !active && (latest || terminalWithoutState);
  const blocked = readOnly || loading || busy;
  const contextualTaskAction = TASK_PRIMARY_ACTIONS[taskCode] || null;
  const primaryAction = MANUAL_ACTIONS.find((item) => item.action === 'continue_process');
  const secondaryAction = MANUAL_ACTIONS.find((item) => item.action === 'hold');
  const moreActions = ['talent_pool', 'reject', 'withdraw', 'hired']
    .map((action) => MANUAL_ACTIONS.find((item) => item.action === action))
    .filter(Boolean);
  const moreActionMenuId = 'candidate-disposition-more-menu';
  const focusDispositionReturnTarget = () => {
    const trigger = moreActionButtonRef.current;
    const reentry = reentryButtonRef.current;
    const target = trigger && trigger.isConnected
      ? trigger
      : reentry && reentry.isConnected
        ? reentry
        : panelRef.current;
    if (!target || !target.isConnected) return;
    const focusTarget = () => target.focus();
    if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(focusTarget);
    else globalThis.setTimeout(focusTarget, 0);
  };
  const renderVisibleAction = (item, primary = false) => (
    <Button
      key={item.action}
      className={`candidate-disposition-action ${primary ? 'is-primary' : 'is-standard'}`}
      type={primary ? 'primary' : 'default'}
      disabled={blocked}
      loading={busy && active && active.disposition_action === item.action}
      aria-label={item.action === 'hold' ? '当前岗位暂缓' : undefined}
      onClick={() => onAction(item.action, item.label, ['continue_process', 'hold'].includes(item.action))}
    >
      {item.label}
    </Button>
  );
  const renderContextualTaskAction = () => {
    if (!contextualTaskAction) return null;
    const opensCommunication = contextualTaskAction.kind === 'communication';
    const opensTodoTarget = contextualTaskAction.kind === 'todo';
    const todoTargetUnavailable = opensTodoTarget && (!taskTodo?.action || typeof onOpenTaskTodo !== 'function');
    return (
      <Button
        ref={opensCommunication ? communicationTriggerRef : undefined}
        data-communication-drawer-trigger={opensCommunication ? true : undefined}
        className="candidate-disposition-action candidate-task-primary-action"
        type="primary"
        disabled={blocked || todoTargetUnavailable}
        onClick={opensCommunication
          ? onOpenCommunication
          : opensTodoTarget
            ? () => onOpenTaskTodo(taskTodo)
            : () => onOpenTaskDomain?.(contextualTaskAction.domain)}
      >
        {contextualTaskAction.label}
      </Button>
    );
  };
  const moreActionItems = moreActions.flatMap((item, index) => [
    ...(index === 1 ? [{
      type: 'divider',
      className: 'candidate-disposition-more-divider',
      style: { margin: '5px 7px', background: 'var(--hb-border)' },
    }] : []),
    {
      key: item.action,
      label: <span className="candidate-disposition-more-label">{item.label}</span>,
      danger: DESTRUCTIVE_DISPOSITIONS.includes(item.action),
      className: `candidate-disposition-more-item${DESTRUCTIVE_DISPOSITIONS.includes(item.action)
        ? ' candidate-disposition-more-item-danger'
        : ''}`,
    },
  ]);
  const handleMoreActionsOpenChange = (open) => {
    setMoreActionsOpen(open);
    if (open) {
      menuSelectionRef.current = false;
      return;
    }
    if (menuSelectionRef.current) {
      menuSelectionRef.current = false;
      return;
    }
    focusDispositionReturnTarget();
  };
  const handleMoreAction = ({ key }) => {
    const item = moreActions.find((action) => action.action === key);
    if (!item || blocked) return;
    menuSelectionRef.current = true;
    setMoreActionsOpen(false);
    onAction(
      item.action,
      item.label,
      true,
      focusDispositionReturnTarget,
    );
  };
  return (
    <Card
      ref={panelRef}
      size="small"
      className="detail-card candidate-command-card candidate-disposition-card candidate-taskbar"
      classNames={{
        header: 'candidate-command-card-header',
        body: 'candidate-command-card-body',
        title: 'candidate-command-card-title',
        extra: 'candidate-command-card-extra',
      }}
      title="HR 人工处置"
      tabIndex={-1}
      aria-label="HR 人工处置"
      extra={(
        <Space size={8} wrap>
          <span className={`candidate-command-state ${active && active.disposition_action === 'hold' ? 'is-hold' : ''}`}>
            {manualActionLabel(active || latest, candidate)}
          </span>
          {contextualTaskAction?.kind !== 'communication' && (
            <Button
              ref={communicationTriggerRef}
              data-communication-drawer-trigger
              size="small"
              disabled={blocked}
              onClick={onOpenCommunication}
            >
              记录沟通事实
            </Button>
          )}
        </Space>
      )}
    >
      <Paragraph type="secondary" className="candidate-command-copy">
        仅由 HR 操作；是否需要测评或面试报告以岗位画像和当前待办为准。“暂缓”仅暂缓当前岗位，沟通备注在抽屉中按需填写。
      </Paragraph>
      {readError && <Text type="secondary" className="candidate-command-message">{readError} 人工处置仍可使用；若申请轮次不可用，系统会改用兼容状态入口。</Text>}
      {globalDoNotContact ? (
        <Text type="secondary" className="candidate-command-message">当前为“不再联系”，不能用当前岗位的“重新进入”清除全局禁止触达。</Text>
      ) : hired ? (
        <Text type="secondary" className="candidate-command-message">当前为“录用”终态，不能通过普通“重新进入”撤销；当前页面没有撤销入口，如需纠正，请联系负责人核对后另行处理。</Text>
      ) : shouldReenter ? (
        <div className="candidate-disposition-reentry">
          <span>当前岗位关系已结束</span>
          <Button ref={reentryButtonRef} type="primary" disabled={blocked} loading={busy} onClick={() => onAction('reenter', '重新进入', true)}>重新进入</Button>
        </div>
      ) : (
        <div className="candidate-disposition-actions" role="group" aria-label="HR 人工处置操作">
          <div className={`candidate-disposition-visible-actions${contextualTaskAction ? ' has-contextual-primary' : ''}`}>
            {contextualTaskAction ? renderContextualTaskAction() : renderVisibleAction(primaryAction, true)}
            {contextualTaskAction && renderVisibleAction(primaryAction)}
            {renderVisibleAction(secondaryAction)}
            <Dropdown
              autoFocus
              open={moreActionsOpen}
              onOpenChange={handleMoreActionsOpenChange}
              trigger={['click']}
              overlayClassName="candidate-disposition-more-dropdown"
              menu={{
                id: moreActionMenuId,
                'aria-label': '更多 HR 人工处置',
                className: 'candidate-disposition-more-menu',
                style: {
                  minWidth: 210,
                  padding: 7,
                  border: '1px solid var(--hb-border)',
                  borderRadius: 'var(--hb-radius)',
                  boxShadow: 'var(--hb-shadow-popover)',
                },
                items: moreActionItems,
                selectable: false,
                onClick: handleMoreAction,
              }}
            >
              <Button
                ref={moreActionButtonRef}
                className="candidate-disposition-more-trigger"
                icon={<MoreOutlined aria-hidden="true" />}
                disabled={blocked}
                loading={busy}
                aria-label="打开更多 HR 人工处置"
                aria-haspopup="menu"
                aria-expanded={moreActionsOpen}
                aria-controls={moreActionsOpen ? moreActionMenuId : undefined}
              >
                更多处置
              </Button>
            </Dropdown>
          </div>
        </div>
      )}
      {actionError && (
        <div className="candidate-command-error" role="alert">
          <Text type="danger">{actionError}</Text>
        </div>
      )}
    </Card>
  );
}

export default function CandidateDetail({ candidate, jobName, childrenData, actions, query, onAssess, assessBusy, readOnly, readOnlyReason = '', assessmentMaintenanceAllowed = false, initialDomain, initialInterviewTab = 'review', interviewNavigationRequestKey = 0, interviewNavigationTarget = null, timeline, onAssessmentChanged, onOpenAiSettings, onOpenInterviewSettings, onWorkflowChanged, onOpenTaskTodo, onChooseCandidate, onDirtyChange, onBusyChange, aiResumeIntent, onAiResumeConsumed }) {
  const [activeDomain, setActiveDomain] = useState('profile');
  const [activePanel, setActivePanel] = useState('online');
  const [interviewDirty, setInterviewDirty] = useState(false);
  const [finalReviewDirty, setFinalReviewDirty] = useState(false);
  const [journeyOperationsDirty, setJourneyOperationsDirty] = useState(false);
  const [journeyOperationsBusy, setJourneyOperationsBusy] = useState(false);
  const [interviewWriteBusy, setInterviewWriteBusy] = useState(false);
  const [assessmentWriteBusy, setAssessmentWriteBusy] = useState(false);
  const [assessmentStatus, setAssessmentStatus] = useState({
    phase: 'loading',
    enabled: false,
    error: '',
  });
  const [assessmentStatusAttempt, setAssessmentStatusAttempt] = useState(0);
  const [hrFlowActionError, setHrFlowActionError] = useState('');
  const [hrFlowBusy, setHrFlowBusy] = useState(false);
  const [communicationCode, setCommunicationCode] = useState('not_contacted');
  const [communicationReason, setCommunicationReason] = useState('');
  const [communicationBaseline, setCommunicationBaseline] = useState({ code: 'not_contacted', reason: '' });
  const [communicationBusy, setCommunicationBusy] = useState(false);
  const [communicationNotice, setCommunicationNotice] = useState(null);
  const [communicationOpen, setCommunicationOpen] = useState(false);
  const [resumeImportBusy, setResumeImportBusy] = useState(false);
  const [resumeImportNotice, setResumeImportNotice] = useState(null);
  const communicationTriggerRef = useRef(null);
  const communicationFocusPendingRef = useRef(false);
  const communicationDirty = communicationCode !== communicationBaseline.code
    || communicationReason !== communicationBaseline.reason;

  const handleInterviewDirtyChange = useCallback((dirty) => {
    setInterviewDirty(dirty === true);
  }, []);

  const handleFinalReviewDirtyChange = useCallback((dirty) => {
    setFinalReviewDirty(dirty === true);
  }, []);

  useEffect(() => {
    onDirtyChange?.(interviewDirty || finalReviewDirty || journeyOperationsDirty || communicationDirty);
  }, [communicationDirty, finalReviewDirty, interviewDirty, journeyOperationsDirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(() => {
    onBusyChange?.(
      hrFlowBusy
      || communicationBusy
      || resumeImportBusy
      || journeyOperationsBusy
      || interviewWriteBusy
      || assessmentWriteBusy,
    );
  }, [
    assessmentWriteBusy,
    communicationBusy,
    hrFlowBusy,
    interviewWriteBusy,
    journeyOperationsBusy,
    onBusyChange,
    resumeImportBusy,
  ]);

  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  useEffect(() => {
    setActiveDomain(initialDomain || 'profile');
    setActivePanel('online');
    setInterviewDirty(false);
    setFinalReviewDirty(false);
    setJourneyOperationsDirty(false);
    setJourneyOperationsBusy(false);
    setInterviewWriteBusy(false);
    setAssessmentWriteBusy(false);
    setResumeImportNotice(null);
    const initialCommunicationCode = currentCommunicationCode(candidate);
    setCommunicationCode(initialCommunicationCode);
    setCommunicationReason('');
    setCommunicationBaseline({ code: initialCommunicationCode, reason: '' });
    setCommunicationNotice(null);
    communicationFocusPendingRef.current = false;
    setCommunicationOpen(false);
  }, [candidate && candidate.internal_id, initialDomain, interviewNavigationRequestKey]);

  useEffect(() => {
    if (!aiResumeIntent) return;
    if (String(aiResumeIntent?.targetId || '') !== String(candidate?.internal_id || '')) return;
    if (aiResumeIntent.capability === 'candidate_assessment') {
      setActiveDomain('profile');
      setActivePanel('ai');
    } else if (aiResumeIntent.capability === 'assessment_analysis') {
      setActiveDomain('assessment');
    } else if (aiResumeIntent.capability === 'interview_review') {
      setActiveDomain('interview');
    }
  }, [aiResumeIntent?.id, candidate?.internal_id]);

  const requestDomainChange = useCallback((nextDomain) => {
    if (!nextDomain || nextDomain === activeDomain) return;
    const anyWriteBusy = hrFlowBusy
      || communicationBusy
      || resumeImportBusy
      || journeyOperationsBusy
      || interviewWriteBusy
      || assessmentWriteBusy;
    if (anyWriteBusy) {
      Modal.warning({
        title: '当前操作正在提交',
        content: '请等待写入、AI 操作及提交后的最新数据刷新完成后再切换分区。',
        okText: '知道了',
      });
      return;
    }
    const currentDomainDirty = activeDomain === 'interview'
      ? interviewDirty
      : activeDomain === 'final-review'
        ? finalReviewDirty
        : activeDomain === 'flow' && journeyOperationsDirty;
    const applyChange = () => {
      if (activeDomain === 'interview') setInterviewDirty(false);
      if (activeDomain === 'final-review') setFinalReviewDirty(false);
      if (activeDomain === 'flow') setJourneyOperationsDirty(false);
      setActiveDomain(nextDomain);
    };
    if (!currentDomainDirty) {
      applyChange();
      return;
    }
    Modal.confirm({
      title: '当前分区还有未保存草稿',
      content: '切换分区后，当前未保存的面试、终评或招聘推进草稿将丢失。已保存记录不受影响。',
      okText: '放弃草稿并切换',
      okButtonProps: { danger: true },
      cancelText: '继续编辑',
      onOk: applyChange,
    });
  }, [
    activeDomain,
    assessmentWriteBusy,
    communicationBusy,
    finalReviewDirty,
    hrFlowBusy,
    interviewDirty,
    interviewWriteBusy,
    journeyOperationsBusy,
    journeyOperationsDirty,
    resumeImportBusy,
  ]);

  useEffect(() => {
    let active = true;
    setAssessmentStatus((current) => ({
      ...current,
      phase: 'loading',
    }));
    api.getAssessmentStatus().then((status) => {
      if (active) {
        setAssessmentStatus({
          ...status,
          phase: 'ready',
          enabled: status.enabled === true,
          error: '',
        });
      }
    }).catch((error) => {
      if (active) {
        setAssessmentStatus((current) => ({
          phase: 'error',
          enabled: current.enabled,
          error: error && error.message ? error.message : '未知错误',
        }));
      }
    });
    setHrFlowActionError('');
    return () => { active = false; };
  }, [candidate && candidate.internal_id, readOnly, assessmentMaintenanceAllowed, assessmentStatusAttempt]);

  function runManualAction(action, label, needsConfirm = false, returnFocus) {
    const execute = async () => {
      setHrFlowBusy(true);
      setHrFlowActionError('');
      try {
        const requestId = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : `hr-flow-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        try {
          await api.applyManualCandidateAction(candidate.internal_id, candidate.job_id, action, `HR 人工操作：${label}`, requestId);
        } catch (err) {
          if (!canUseManualActionFallback(err)) {
            const message = err && err.message ? err.message : '未知错误';
            setHrFlowActionError(`人工操作“${label}”失败：${message}。请重试。`);
            return false;
          }
          const fallbackCode = MANUAL_ACTION_FALLBACK_CODES[action];
          if (!fallbackCode) {
            setHrFlowActionError(`人工操作“${label}”失败：当前动作没有兼容状态映射。`);
            return false;
          }
          try {
            await api.changeCandidateStatus(
              candidate.internal_id,
              'disposition',
              fallbackCode,
              `HR 人工操作：${label}（申请轮次不可用时的兼容入口）`,
              'manual_hr_action',
            );
          } catch (fallbackError) {
            const primaryMessage = err && err.message ? err.message : '申请轮次不可用';
            const fallbackMessage = fallbackError && fallbackError.message ? fallbackError.message : '兼容状态写入失败';
            setHrFlowActionError(`人工操作“${label}”失败：${primaryMessage}；兼容入口也失败：${fallbackMessage}。请重试。`);
            return false;
          }
        }
        try {
          if (onWorkflowChanged) await onWorkflowChanged(candidate.internal_id, candidate.job_id);
          setHrFlowActionError('');
          return true;
        } catch (err) {
          const message = err && err.message ? err.message : '未知错误';
          setHrFlowActionError(`人工操作已提交，但最新状态刷新失败：${message}`);
          return true;
        }
      } finally {
        setHrFlowBusy(false);
      }
    };
    if (!needsConfirm) return execute();
    const confirmation = MANUAL_ACTION_CONFIRMATIONS[action] || {
      title: `确认${label}？`,
      target: label,
      consequence: '执行后会刷新候选人、队列和工作台。',
    };
    const candidateLabel = candidate.name || candidate.internal_id || '当前候选人';
    const jobLabel = jobName || candidate.job_name || `当前岗位（ID ${candidate.job_id}）`;
    return Modal.confirm({
      title: confirmation.title,
      content: (
        <div style={{ display: 'grid', gap: 8 }}>
          <div>候选人：<strong>{candidateLabel}</strong></div>
          <div>岗位：<strong>{jobLabel}</strong></div>
          <div>目标状态：<strong>{confirmation.target}</strong></div>
          <Text type="secondary">{confirmation.consequence}</Text>
        </div>
      ),
      okText: action === 'hired' ? '确认标记录用' : `确认${label}`,
      cancelText: '取消',
      okButtonProps: { danger: DESTRUCTIVE_DISPOSITIONS.includes(action) },
      onOk: execute,
      focusTriggerAfterClose: typeof returnFocus !== 'function',
      afterClose: returnFocus,
    });
  }

  async function saveCommunicationFact() {
    if (!candidate || communicationBusy || readOnly) return;
    const currentCode = communicationBaseline.code;
    if (communicationCode === currentCode) {
      setCommunicationNotice({ type: 'info', message: '当前沟通事实没有变化，本次未提交；备注只随真实状态变更记录。' });
      return;
    }
    const isRollback = (COMMUNICATION_RANK[communicationCode] ?? 0) < (COMMUNICATION_RANK[currentCode] ?? 0);
    const reason = String(communicationReason || '').trim();
    if (isRollback && !reason) {
      setCommunicationNotice({ type: 'warning', message: '回退更正需要填写原因。' });
      return;
    }
    const option = COMMUNICATION_OPTIONS.find((item) => item.value === communicationCode);
    setCommunicationBusy(true);
    setCommunicationNotice(null);
    try {
      const response = await api.changeCandidateStatus(
        candidate.internal_id,
        'comm',
        communicationCode,
        reason || `HR 人工记录沟通事实：${option?.label || communicationCode}`,
        'manual_communication_backfill',
      );
      const committedCode = response?.candidate
        ? currentCommunicationCode(response.candidate)
        : communicationCode;
      setCommunicationCode(committedCode);
      setCommunicationReason('');
      setCommunicationBaseline({ code: committedCode, reason: '' });
      try {
        if (onWorkflowChanged) await onWorkflowChanged(candidate.internal_id, candidate.job_id);
        setCommunicationNotice({ type: 'success', message: '沟通事实已保存，候选人列表和本地待办已刷新。' });
      } catch (error) {
        setCommunicationNotice({
          type: 'warning',
          message: `沟通事实已保存，但最新列表或待办刷新失败：${error?.message || '请手动刷新本地数据。'}`,
        });
      }
    } catch (error) {
      setCommunicationNotice({ type: 'error', message: `沟通事实保存失败：${error?.message || '请重试。'}` });
    } finally {
      setCommunicationBusy(false);
    }
  }

  function requestCommunicationDrawerClose() {
    if (communicationBusy) return false;
    communicationFocusPendingRef.current = true;
    setCommunicationOpen(false);
    return true;
  }

  function focusCommunicationTrigger() {
    const refTrigger = communicationTriggerRef.current;
    const trigger = refTrigger && refTrigger.isConnected
      ? refTrigger
      : (typeof document !== 'undefined' && document.querySelector('[data-communication-drawer-trigger]'));
    if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  function handleCommunicationDrawerOpenChange(open) {
    if (open || !communicationFocusPendingRef.current) return;
    communicationFocusPendingRef.current = false;
    globalThis.setTimeout(focusCommunicationTrigger, 0);
  }

  useEffect(() => {
    if (communicationOpen || !communicationFocusPendingRef.current) return undefined;
    // rc-drawer restores its captured active element after its close motion. The
    // runtime trigger can be BODY when a test or assistive action invokes click(),
    // so restore our explicit trigger once that motion has settled as a fallback.
    const timer = globalThis.setTimeout(focusCommunicationTrigger, 400);
    return () => globalThis.clearTimeout(timer);
  }, [communicationOpen, candidate && candidate.internal_id]);

  useEffect(() => {
    if (!communicationOpen || typeof document === 'undefined') return undefined;
    const handleCommunicationDrawerEscape = (event) => {
      const nestedLayerOpen = [...document.querySelectorAll('.candidate-communication-drawer [aria-expanded="true"]')]
        .some((element) => element.getClientRects().length > 0);
      const action = communicationDrawerEscapeAction({
        key: event.key,
        busy: communicationBusy,
        nestedLayerOpen,
      });
      if (action === 'ignore' || action === 'nested') return;
      event.preventDefault();
      event.stopPropagation();
      if (action === 'close') requestCommunicationDrawerClose();
    };
    document.addEventListener('keydown', handleCommunicationDrawerEscape, true);
    return () => document.removeEventListener('keydown', handleCommunicationDrawerEscape, true);
  }, [communicationOpen, communicationBusy]);

  async function uploadResumeAttachment() {
    if (!candidate || resumeImportBusy) return;
    setResumeImportBusy(true);
    setResumeImportNotice(null);
    let response;
    try {
      response = await api.importResumeAttachment(candidate.internal_id, candidate.job_id);
    } catch (error) {
      setResumeImportNotice({ type: 'error', text: `手动上传简历失败：${error.message}` });
      setResumeImportBusy(false);
      return;
    }
    if (response.canceled) {
      setResumeImportBusy(false);
      return;
    }
    const result = response.result || {};
    setResumeImportNotice({
      type: result.ai_ready ? 'success' : 'warning',
      text: result.ai_ready
        ? '简历已上传并提取正文，可以进入 AI 初评。'
        : '简历附件已保存，但本机未能提取正文；仍可查看附件记录。',
    });
    setActivePanel('attachment');
    try {
      if (onWorkflowChanged) await onWorkflowChanged(candidate.internal_id, candidate.job_id);
    } catch (error) {
      setResumeImportNotice({
        type: 'warning',
        text: `简历已保存，但最新数据刷新失败：${error && error.message ? error.message : '请稍后重新打开候选人查看。'}`,
      });
    } finally {
      setResumeImportBusy(false);
    }
  }

  if (!candidate) {
    return (
      <div className="candidate-detail-unselected" role="status" aria-label="尚未选择候选人">
        <div className="candidate-detail-unselected-copy">
          <Text strong>尚未选择候选人</Text>
          <Text type="secondary">从候选人列表选择后，这里会显示资料、证据与下一步操作。</Text>
        </div>
        {onChooseCandidate && (
          <Button type="primary" onClick={onChooseCandidate}>
            前往候选人列表
          </Button>
        )}
      </div>
    );
  }
  const c = candidate;
  const children = childrenData;
  const resumeRow = children.resume_online[0];
  const cView = { ...c, sections_json: resumeRow && resumeRow.sections_json };
  const edu = candidateEducation(cView);
  const sections = resumeRow && Number(resumeRow.is_paywalled) !== 1 ? parseSections(resumeRow) : null;
  const basic = Array.isArray(sections && sections.basic) ? sections.basic[0] || {} : {};
  const expect = Array.isArray(sections && sections.expect) ? sections.expect[0] || {} : {};
  const facts = {
    age: c.age || basic.age,
    degree: edu.degree || basic.degree,
    school: edu.school,
    schoolTier: edu.school_tier,
    workYears: c.work_years || basic.work_years,
    salary: c.salary || expect.salary,
    city: expect.city,
    status: basic.status,
  };
  const heroSummary = clipText(c.geek_desc || basic.description, 132);
  const sourceLabel = candidateSourceLabel(c);
  const latestAiReport = children.ai_review.length ? soReport(children.ai_review[0]) : null;
  const latestAiSource = children.ai_review.length ? aiReportSource(latestAiReport) : null;
  const aiStatusLabel = !children.ai_review.length
    ? 'AI 初评未运行'
    : latestAiSource.key === 'local_demo'
      ? `本地样本 ${children.ai_review.length}`
      : latestAiSource.key === 'real_ai'
        ? `真实 AI ${children.ai_review.length}`
        : `历史记录 ${children.ai_review.length}`;
  const onlineTabLabel = c.source === '截图导入' ? '截图简历' : '在线简历';
  const screenshotAvailable = c.source === '截图导入' && sections && has(sections.stitched_file);
  const panel = screenshotAvailable || activePanel !== 'screenshot' ? activePanel : 'online';
  const flowCount = timelineVisibleRecordCount(timeline);
  const communicationLabel = COMMUNICATION_OPTIONS.find((item) => item.value === communicationBaseline.code)?.label || '沟通状态未知';
  const dispositionLabel = candidateDispositionLabel(c) || '新入库';
  const heroMeta = joinParts([has(c.rec_position) ? recLabel(c.rec_position) : '', facts.workYears, facts.city]);
  const decisionSummary = decisionSummaryFromTimeline(timeline);
  const finalReviewVisible = activeDomain === 'final-review'
    || initialDomain === 'final-review'
    || ['final_review_required', 'final_disposition_confirmation_required'].includes(decisionSummary.taskCode);
  const factRows = [
    ['年龄', facts.age],
    ['学历', facts.degree],
    ['院校', facts.school],
    ['工作年限', facts.workYears],
    ['学历核验', c.degree_verified],
    ['院校档次', facts.schoolTier],
    ['期望薪资', facts.salary],
    ['期望城市', facts.city],
  ];
  const knownFactRows = factRows.filter(([, value]) => has(value));
  const missingFactRows = factRows.filter(([, value]) => !has(value));
  const activeDomainLabel = {
    profile: '资料',
    interview: '面试',
    assessment: '测评',
    'final-review': '结构化终评',
    flow: '流程',
  }[activeDomain] || '候选人资料';
  const domainOptions = [
    {
      className: 'candidate-domain-tab-option',
      label: (
        <span className="candidate-domain-option">
          <strong>资料</strong>
          <em>{knownFactRows.length} 项事实</em>
        </span>
      ),
      value: 'profile',
    },
    {
      className: 'candidate-domain-tab-option',
      label: (
        <span className="candidate-domain-option">
          <strong>面试</strong>
          <em>记录与复盘</em>
        </span>
      ),
      value: 'interview',
    },
    {
      className: 'candidate-domain-tab-option',
      label: (
        <span className="candidate-domain-option">
          <strong>测评</strong>
          <em>{assessmentStatus.phase === 'loading'
            ? '检查中'
            : assessmentStatus.phase === 'error'
              ? '状态未知'
              : assessmentStatus.enabled
                ? '报告与分析'
                : '已停用'}</em>
        </span>
      ),
      value: 'assessment',
    },
    ...(finalReviewVisible ? [{
      className: 'candidate-domain-tab-option candidate-final-review-domain-option',
      label: (
        <span className="candidate-domain-option">
          <strong>终评</strong>
          <em>独立人工确认</em>
        </span>
      ),
      value: 'final-review',
    }] : []),
    {
      className: 'candidate-domain-tab-option',
      label: (
        <span className="candidate-domain-option">
          <strong>流程</strong>
          <em>{flowCount || '—'}</em>
        </span>
      ),
      value: 'flow',
    },
  ];
  const profileMaterialItems = [
    {
      key: 'online',
      label: onlineTabLabel,
    },
    ...(screenshotAvailable ? [{
      key: 'screenshot',
      label: '拼合截图',
    }] : []),
    {
      key: 'attachment',
      label: `附件简历${children.resume_attachment.length ? `（${children.resume_attachment.length}）` : ''}`,
    },
  ];
  const activeMaterialLabel = profileMaterialItems.find((item) => item.key === panel)?.label || onlineTabLabel;
  const aiPanelLabel = children.ai_review.length ? `AI 初评（${children.ai_review.length}）` : 'AI 初评 · 未运行';

  return (
    <div className="detail-shell candidate-v2-detail" data-read-only={readOnly ? 'true' : 'false'}>
      <Card
        className="detail-card candidate-overview-card"
        classNames={{ body: 'candidate-overview-card-body' }}
      >
        <header className="candidate-hero candidate-v2-hero">
          <div className="hero-main">
            <div className="hero-title-row">
              <Title level={2}>{c.name || '未命名候选人'}</Title>
              <SabcBadge value={c.sabc} />
            </div>
            {heroMeta && <div className="hero-meta">{heroMeta}</div>}
            <Paragraph className="hero-desc">
              {has(heroSummary) ? highlight(heroSummary, query) : <span className="placeholder-text">-- 在线简历补全后显示候选人摘要</span>}
            </Paragraph>
            <Text type="secondary" className="candidate-source-meta">
              来源：{sourceLabel} · 资料更新：{fmtTime(c.updated_at || c.created_at)}
            </Text>
          </div>
          <div className="candidate-hero-side">
            <div className="candidate-status-summary" aria-label="候选人当前状态">
              <div><span>沟通事实</span><strong>{communicationLabel}</strong></div>
              <div><span>当前处置</span><strong>{dispositionLabel}</strong></div>
            </div>
          </div>
        </header>
        <section className="candidate-facts-section" aria-labelledby="candidate-facts-title">
          <h3 id="candidate-facts-title" className="candidate-v2-facts-title">候选人事实</h3>
          {knownFactRows.length ? (
            <dl className="fact-grid candidate-fact-strip candidate-v2-facts-list" aria-label="已知候选人关键事实">
              {knownFactRows.map(([label, value]) => (
                <Field key={label} label={label} value={value} fill="待补全" />
              ))}
            </dl>
          ) : (
            <p className="candidate-v2-facts-note">关键事实尚未从现有资料中提取。</p>
          )}
          {missingFactRows.length > 0 && (
            <Collapse
              className="candidate-missing-facts"
              bordered={false}
              ghost
              size="small"
              items={[{
                key: 'missing-facts',
                label: `待补全资料（${missingFactRows.length} 项）`,
                classNames: {
                  header: 'candidate-missing-facts-header',
                  body: 'candidate-missing-facts-body',
                },
                children: (
                  <dl className="fact-grid candidate-fact-strip candidate-v2-facts-list" aria-label="待补全候选人事实">
                    {missingFactRows.map(([label, value]) => (
                      <Field key={label} label={label} value={value} fill="待从简历或人工资料补全" />
                    ))}
                  </dl>
                ),
              }]}
            />
          )}
          <small className="candidate-v2-facts-note">
            缺失项来自在线简历待补全，不会按默认值参与判断；已显示 {knownFactRows.length} 项已知事实{missingFactRows.length ? `，另有 ${missingFactRows.length} 项待补全` : ''}。
          </small>
        </section>
      </Card>

      <div className={`candidate-v2-body candidate-v2-single-workspace${readOnly ? ' is-read-only' : ''}`}>
        <section className="candidate-v2-workspace" aria-label="候选人评估工作区">
          <Card
            className="detail-card candidate-workspace-card"
            classNames={{ body: 'candidate-workspace-card-body' }}
          >
            {assessmentStatus.error && (
              <Alert
                type={assessmentStatus.phase === 'loading' ? 'info' : 'error'}
                showIcon
                message={assessmentStatus.phase === 'loading' ? '正在重新读取测评功能状态' : '测评功能状态读取失败'}
                description={assessmentStatus.phase === 'loading'
                  ? '读取完成前保留安全查看入口，写操作继续锁定。'
                  : `不能把状态未知当作功能已关闭。当前仅保留安全查看入口，写操作已锁定。${assessmentStatus.error}`}
                action={assessmentStatus.phase === 'error' ? (
                  <Button size="small" onClick={() => setAssessmentStatusAttempt((value) => value + 1)}>
                    重试
                  </Button>
                ) : null}
                style={{ marginBottom: 12 }}
              />
            )}
            <div className="candidate-workspace-head">
              <div className="candidate-workspace-heading">
                <span>当前任务</span>
                <h2>{decisionSummary.task}</h2>
                <small>
                  {decisionSummary.taskMeta} · 招聘状态：{decisionSummary.workflow}。只汇总已记录事实和统一时间线待办；不生成推荐或分数。
                </small>
              </div>
            </div>
            {!readOnly && (
              <ManualDispositionPanel
                candidate={c}
                state={null}
                loading={false}
                readError=""
                actionError={hrFlowActionError}
                busy={hrFlowBusy}
                readOnly={readOnly}
                onAction={runManualAction}
                taskCode={decisionSummary.taskCode}
                taskTodo={decisionSummary.taskTodo}
                communicationTriggerRef={communicationTriggerRef}
                onOpenCommunication={() => {
                  communicationFocusPendingRef.current = false;
                  setCommunicationOpen(true);
                }}
                onOpenTaskDomain={requestDomainChange}
                onOpenTaskTodo={onOpenTaskTodo}
              />
            )}
            <div className="candidate-domain-navigation" aria-label="候选人工作区导航">
              <ConfigProvider theme={CANDIDATE_SEGMENTED_THEME}>
                <Segmented
                  block
                  name="candidate-workspace-domain"
                  className="candidate-domain-tabs"
                  aria-label="候选人工作区分区"
                  value={activeDomain}
                  onChange={requestDomainChange}
                  onKeyDown={(event) => handleSegmentedBoundaryKey(event, domainOptions, activeDomain, requestDomainChange)}
                  options={domainOptions}
                />
              </ConfigProvider>
            </div>
            <div className="candidate-domain-panel" role="region" aria-label={`候选人${activeDomainLabel}工作区`}>
              {activeDomain === 'profile' && (
                <>
                  <Space className="detail-tabs candidate-profile-tools" size={8} wrap role="toolbar" aria-label={`候选人资料查看工具，${aiStatusLabel}`}>
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        'aria-label': '切换简历材料',
                        selectable: true,
                        selectedKeys: panel === 'ai' ? [] : [panel],
                        items: profileMaterialItems,
                        onClick: ({ key }) => setActivePanel(key),
                      }}
                    >
                      <Button aria-haspopup="menu" aria-pressed={panel !== 'ai'}>
                        简历材料：{panel === 'ai' ? onlineTabLabel : activeMaterialLabel}
                      </Button>
                    </Dropdown>
                    <Button aria-pressed={panel === 'ai'} onClick={() => setActivePanel('ai')}>{aiPanelLabel}</Button>
                  </Space>
                  <div className="detail-panel">
                    {panel === 'online' && renderResume(children, cView, {
                      readOnly,
                      onOpenAttachments: () => setActivePanel('attachment'),
                    })}
                    {panel === 'screenshot' && <ScreenshotPreview candidate={c} sections={sections} />}
                    {panel === 'attachment' && (
                      <AttachmentResume
                        list={children.resume_attachment}
                        readOnly={readOnly}
                        uploading={resumeImportBusy}
                        notice={resumeImportNotice}
                        onUpload={uploadResumeAttachment}
                      />
                    )}
                    {panel === 'ai' && (
                      <AiReviewPanel
                        candidate={c}
                        list={children.ai_review}
                        sections={sections}
                        onAssess={onAssess}
                        assessBusy={assessBusy}
                        readOnly={readOnly}
                        onOpenAiSettings={onOpenAiSettings}
                        onOpenResumeMaterials={() => setActivePanel(children.resume_attachment.length ? 'attachment' : 'online')}
                        aiResumeIntent={aiResumeIntent}
                        onAiResumeConsumed={onAiResumeConsumed}
                      />
                    )}
                  </div>
                </>
              )}
              {activeDomain === 'interview' && (
                <InterviewReviewPanel
                  candidate={c}
                  readOnly={readOnly}
                  readOnlyReason={readOnlyReason}
                  onOpenSettings={onOpenAiSettings}
                  onOpenInterviewSettings={onOpenInterviewSettings}
                  initialTab={initialInterviewTab}
                  navigationRequestKey={interviewNavigationRequestKey}
                  navigationTarget={interviewNavigationTarget}
                  onDirtyChange={handleInterviewDirtyChange}
                  onBusyChange={setInterviewWriteBusy}
                  aiResumeIntent={aiResumeIntent}
                  onAiResumeConsumed={onAiResumeConsumed}
                />
              )}
              {activeDomain === 'assessment' && (
                assessmentStatus.enabled ? (
                  <>
                    <Text type="secondary">手动绑定 · AI 综合分析，仅作为独立辅助材料。</Text>
                    <AssessmentArchivePanel
                      candidate={c}
                      readOnly={readOnly || assessmentStatus.phase !== 'ready'}
                      assessmentMaintenanceAllowed={assessmentStatus.phase === 'ready' && assessmentMaintenanceAllowed}
                      initialStatus={assessmentStatus}
                      onChanged={onAssessmentChanged}
                      onOpenAiSettings={onOpenAiSettings}
                      onBusyChange={setAssessmentWriteBusy}
                      aiResumeIntent={aiResumeIntent}
                      onAiResumeConsumed={onAiResumeConsumed}
                    />
                  </>
                ) : (
                  <Alert
                    type="warning"
                    showIcon
                    message={assessmentStatus.phase === 'ready' ? '测评功能未启用' : '测评功能状态尚未确认'}
                    description={assessmentStatus.phase === 'ready'
                      ? '测评报告已由当前启动配置明确停用。已有招聘资料不受影响；重新启用后可继续查看和处理历史档案。'
                      : '状态读取失败不会被解释为“没有测评报告”。请重试；确认功能可用前不开放写操作。'}
                    action={assessmentStatus.phase === 'ready' && onOpenAiSettings
                      ? <Button
                          size="small"
                          onClick={() => onOpenAiSettings({
                            capability: 'assessment_analysis',
                            source: 'assessment-archive',
                            sourceLabel: '测评综合分析',
                            targetId: c.internal_id,
                            targetLabel: c.name,
                            jobId: c.job_id,
                            focusTargetId: 'assessment-ai-analysis-action',
                            resumeAction: false,
                          })}
                        >
                          查看设置
                        </Button>
                      : null}
                  />
                )
              )}
              {activeDomain === 'final-review' && (
                <ApplicationFinalReviewPanel
                  candidate={c}
                  readOnly={readOnly}
                  onWorkflowChanged={onWorkflowChanged}
                  onDirtyChange={handleFinalReviewDirtyChange}
                />
              )}
              {activeDomain === 'flow' && (
                <>
                  <CandidateJourneyOperationsPanel
                    candidate={c}
                    readOnly={readOnly}
                    onChanged={onWorkflowChanged}
                    onDirtyChange={setJourneyOperationsDirty}
                    onBusyChange={setJourneyOperationsBusy}
                  />
                  <CanonicalTimelinePanel timeline={timeline} />
                </>
              )}
            </div>
          </Card>
        </section>
      </div>
      {!readOnly && (
        <Drawer
          rootClassName="candidate-communication-drawer"
          title={`记录沟通事实 · ${c.name || '当前候选人'}`}
          open={communicationOpen}
          width="min(420px, calc(100vw - 24px))"
          closable={!communicationBusy}
          keyboard={false}
          maskClosable={!communicationBusy}
          destroyOnHidden
          afterOpenChange={handleCommunicationDrawerOpenChange}
          onClose={requestCommunicationDrawerClose}
        >
          <CommunicationBackfillPanel
            currentCode={communicationBaseline.code}
            code={communicationCode}
            reason={communicationReason}
            busy={communicationBusy}
            notice={communicationNotice}
            readOnly={readOnly}
            onCodeChange={(value) => {
              setCommunicationCode(value);
              setCommunicationReason('');
              setCommunicationNotice(null);
            }}
            onReasonChange={setCommunicationReason}
            onSubmit={saveCommunicationFact}
          />
        </Drawer>
      )}
    </div>
  );
}
