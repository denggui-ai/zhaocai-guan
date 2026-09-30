import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Checkbox, Collapse, Empty, Input, Modal, Select, Skeleton, Space, Tabs, Tag, Tooltip, Typography } from 'antd';
import {
  AudioOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  FileTextOutlined,
  ImportOutlined,
  LinkOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
  SaveOutlined,
  StopOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { api, clean, fmtTime, has, joinParts, READONLY_UI } from '../api.js';
import {
  createCompletedReviewNavigator,
  createStableInterviewReviewRefresh,
  localInterviewRecordingFinalizationUiState,
  localInterviewTerminationUiState,
} from '../interview-review-navigation.mjs';
import {
  extractInterviewReportMeta,
  extractInterviewReportPayload,
  sessionInterviewReportStateFromGetResponse,
} from '../interview-report-response.mjs';
import {
  confirmationItemId as confirmationReviewItemId,
  normalizeConfirmationStatus,
  normalizeSavedConfirmationItem as normalizeSavedReviewItem,
  strictConfirmationReviewItems,
} from '../interview-confirmation-review.mjs';
import {
  createInterviewVersionConflict,
  isInterviewVersionConflict,
  recoverInterviewVersionConflict,
} from '../interview-version-conflict.mjs';
import { createRequestEpoch } from '../request-epoch.js';
import { actionableInterviewTodoItems, deriveWorkflowState, interviewSessionProgress } from '../interview-workflow-state.mjs';
import { localInterviewMicCheckReady, localInterviewTranscriptionReady } from '../settings-state.mjs';
import ExternalAiFirstUsePrompt, {
  readExternalAiCapability,
} from './ExternalAiFirstUsePrompt.jsx';
import LiveRecordingWaveform, { isRecordingFinalizing } from './LiveRecordingWaveform.jsx';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

const WITHDRAW_REASON_OPTIONS = [
  { value: 'candidate_withdrew', label: '候选人撤回授权/退出流程' },
  { value: 'consent_withdrawn', label: '候选人撤回材料处理同意' },
  { value: 'recruitment_cancelled', label: '本次招聘取消' },
];
const CLOSE_REASON_OPTIONS = [
  { value: 'position_filled', label: '岗位已完成招聘' },
  { value: 'hiring_process_closed', label: '招聘流程正常关闭' },
  { value: 'recruitment_cancelled', label: '本次招聘取消' },
];
const HOLD_REASON_OPTIONS = [
  { value: 'legal_review', label: '法务审查保全' },
  { value: 'dispute_preservation', label: '争议材料保全' },
  { value: 'audit_preservation', label: '审计材料保全' },
];
const HOLD_DURATION_OPTIONS = [
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
  { value: 180, label: '180 天' },
];

const EMPTY_REPORT = {
  schema_version: 'interview_report_v1',
  summary: {
    id: 'summary.main',
    status: 'unknown',
    text: '当前材料不足以形成摘要。',
    reason_code: 'unclear',
    evidence_refs: [],
  },
  match_points: [],
  risks: [],
  unknowns: [],
  followup_questions: [],
  key_facts: [],
  hard_requirements: [],
  competency_evidence: [],
  motivation: {
    id: 'motivation.main',
    label: '求职动机',
    status: 'unknown',
    text: '材料未提及求职动机。',
    reason_code: 'not_mentioned',
    evidence_refs: [],
  },
  contradictions: [],
  assessment_cross_checks: [],
  ai_reference: {
    id: 'ai_reference.main',
    label: 'AI 参考分析',
    status: 'unknown',
    text: '材料不足，仅供 HR 核对。',
    reason_code: 'unclear',
    evidence_refs: [],
  },
  human_confirm_required: true,
  disclaimer: '本报告仅基于已关联面试材料生成，须经 HR 人工确认，不代表自动录用、淘汰、排序或处置。',
};

const INTERVIEW_FORMAT_PRESENTATION = {
  online: { value: 'online', label: '线上', color: 'blue' },
  offline: { value: 'offline', label: '线下', color: 'cyan' },
  phone: { value: 'phone', label: '电话', color: 'purple' },
  unknown: { value: '', label: '未登记', color: 'default' },
};
const INTERVIEW_STATUS_LABELS = Object.freeze({
  draft: '草稿',
  pending_schedule: '待确认面试时间',
  scheduled: '已排期',
  in_progress: '面试中',
  pending_review: '待复盘',
  pending_confirmation: '待确认',
  confirmed: '已确认',
  rejected: '已驳回',
  cancelled: '已取消',
  matched: '已绑定',
  pending_match: '待匹配',
});
const INTERVIEW_SOURCE_LABELS = Object.freeze({
  local_recording: '本地录音',
  lark_minutes: '线上妙记',
  imported_summary: '导入摘要',
  manual: 'HR 人工录入',
});

function interviewStatusLabel(value, fallback = '状态待复核') {
  const key = clean(value);
  return key ? (INTERVIEW_STATUS_LABELS[key] || fallback) : fallback;
}

function interviewSourceLabel(value) {
  const key = clean(value);
  return key ? (INTERVIEW_SOURCE_LABELS[key] || '面试材料') : '';
}

function sessionInterviewFormat(session) {
  const canonical = typeof session?.interview_format === 'string' ? session.interview_format.trim() : '';
  const legacy = typeof session?.mode === 'string' ? session.mode.trim() : '';
  return INTERVIEW_FORMAT_PRESENTATION[canonical || legacy] || INTERVIEW_FORMAT_PRESENTATION.unknown;
}

function pick(row, keys) {
  if (!row) return '';
  for (const key of keys) {
    if (has(row[key])) {
      const value = row[key];
      return value && typeof value === 'object' ? compactText(JSON.stringify(value), 240) : value;
    }
  }
  return '';
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function uiRequestId(action, id) {
  const random = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `ui-${action}-${id}-${random}`;
}

function extractScriptPayload(row) {
  if (!row) return null;
  const parsed = parseMaybeJson(row.script_json || row.scriptJson || row.script);
  if (!parsed) return null;
  return {
    ...parsed,
    id: row.id || parsed.id,
    job_id: row.job_id || row.jobId || parsed.job_id,
    status: row.status || parsed.status || 'draft',
    source: row.source || parsed.source,
    script_text: row.script_text || row.scriptText || parsed.script_text || '',
    updated_at: row.updated_at || row.updatedAt || parsed.updated_at,
  };
}

function scriptText(script) {
  if (!script) return '';
  if (has(script.script_text)) return script.script_text;
  const lines = [script.title ? `# ${script.title}` : '# 面试结构化脚本'];
  if (script.positioning) lines.push('', `> ${script.positioning}`);
  (script.sections || []).forEach((section) => {
    lines.push('', `## ${section.title || '未命名环节'}`);
    if (section.goal) lines.push(`目标：${section.goal}`);
    (section.items || []).forEach((item) => {
      const tags = [item.required ? '必问' : '', item.type === 'followup' ? '追问' : '', item.type === 'confirm' ? '确认' : ''].filter(Boolean).join('/');
      lines.push(`- ${tags ? `【${tags}】` : ''}${item.question || item.text || ''}`);
      if (item.why) lines.push(`  - 追问意图：${item.why}`);
      if (item.expected_signal) lines.push(`  - 观察信号：${item.expected_signal}`);
    });
  });
  if (Array.isArray(script.closing_checklist) && script.closing_checklist.length) {
    lines.push('', '## 结束前确认清单');
    script.closing_checklist.forEach((item) => lines.push(`- ${item}`));
  }
  return lines.join('\n');
}

function plainTextScriptPayload(script, text) {
  const next = { ...(script || { schema_version: 'interview_script_p0_v1', title: '面试结构化脚本' }) };
  delete next.sections;
  delete next.closing_checklist;
  next.editor_format = 'plain_text';
  next.script_text = text;
  return next;
}

function canonicalDraftValue(value) {
  if (Array.isArray(value)) return value.map(canonicalDraftValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalDraftValue(value[key]);
    return result;
  }, {});
}

function draftFingerprint(value) {
  return JSON.stringify(canonicalDraftValue(value ?? null));
}

function draftMapEntryChanged(current, baseline, id) {
  const key = String(id);
  return draftFingerprint(current?.[key]) !== draftFingerprint(baseline?.[key]);
}

function draftMapChanged(current, baseline) {
  const keys = new Set([...Object.keys(current || {}), ...Object.keys(baseline || {})]);
  return [...keys].some((key) => draftMapEntryChanged(current, baseline, key));
}

function mergeServerDraftMap(current, baseline, saved) {
  const merged = { ...(saved || {}) };
  Object.keys(current || {}).forEach((key) => {
    if (draftMapEntryChanged(current, baseline, key)) merged[key] = current[key];
  });
  return merged;
}

const INTERVIEW_WORKSPACE_TAB_KEYS = new Set(['review', 'prepare', 'start', 'evidence']);

function normalizeInterviewWorkspaceTab(value) {
  return INTERVIEW_WORKSPACE_TAB_KEYS.has(value) ? value : 'review';
}

const MIN_RECORDING_DURATION_SECONDS = 5;
const MAX_RECORDING_DURATION_SECONDS = 14_400;

function recordingDurationError(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const seconds = Number(text);
  if (!Number.isInteger(seconds)) return '请输入整数秒数，或留空后手动停止。';
  if (seconds < MIN_RECORDING_DURATION_SECONDS || seconds > MAX_RECORDING_DURATION_SECONDS) {
    return `请输入 ${MIN_RECORDING_DURATION_SECONDS}–${MAX_RECORDING_DURATION_SECONDS} 秒，或留空后手动停止。`;
  }
  return '';
}

function transcriptFromResponse(value) {
  const transcript = value && value.transcript;
  return transcript && typeof transcript === 'object' ? transcript : null;
}

function toRows(data) {
  if (Array.isArray(data && data.recordings)) return data.recordings;
  if (data && data.recording) return [data.recording];
  return [];
}

function recordId(record) {
  return pick(record, ['id', 'recording_id', 'recordingId']);
}

function recordCandidateId(record) {
  return pick(record, ['candidate_id', 'candidateId', 'candidate_internal_id']);
}

function isConfirmed(record) {
  const confirmedAt = pick(record, ['confirmed_at', 'confirmedAt', 'review_confirmed_at']);
  if (has(confirmedAt)) return true;
  const raw = pick(record, ['confirmed', 'is_confirmed', 'status']);
  if (!has(raw)) return false;
  if (raw === true || Number(raw) === 1) return true;
  return /confirmed|done|已确认|true/i.test(String(raw));
}

function recordTitle(record) {
  return pick(record, ['title', 'topic', 'name', 'file_name', 'fileName', 'source']) || `录音 ${recordId(record) || ''}`.trim();
}

function pathRows(record) {
  return [
    ['音频', pick(record, ['audio_path', 'audioPath', 'wav_path', 'wavPath', 'media_path', 'mediaPath', 'file_path', 'filePath'])],
    ['转写 TXT', pick(record, ['transcript_txt_path', 'transcript_path', 'transcriptPath', 'transcript_txt', 'transcriptTxt'])],
    ['转写 SRT', pick(record, ['transcript_srt_path', 'transcript_srt', 'transcriptSrt'])],
    ['转写 JSON', pick(record, ['transcript_json_path', 'transcript_json', 'transcriptJson'])],
    ['Codex 输入', pick(record, ['codex_input_path', 'codex_input', 'codexInput'])],
    ['摘要', pick(record, ['summary_path', 'summaryPath'])],
    ['报告', pick(record, ['report_path', 'reportPath'])],
  ].filter(([, value]) => has(value));
}

function compactText(value, max = 180) {
  const text = clean(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stableDomToken(value, fallback = 'item') {
  const text = clean(value);
  if (!text) return fallback;
  const ascii = text
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  if (ascii) return ascii;
  const encoded = Array.from(text)
    .map((char) => char.codePointAt(0).toString(16))
    .join('-')
    .slice(0, 72);
  return encoded || fallback;
}

function recordDomId(record, index = 0, scope = 'review') {
  return `interview-${scope}-record-${stableDomToken(recordId(record), `row-${index + 1}`)}`;
}

function splitText(value, limit = 8) {
  if (!has(value)) return [];
  return String(value)
    .replace(/\r/g, '\n')
    .replace(/[•●▪◆]/g, '\n')
    .split(/\n+|[；;]/)
    .map((item) => item.replace(/^[\s\-–\d.、）)]+/, '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return splitText(value);
  if (Array.isArray(value.items)) return value.items;
  return [value];
}

function evidenceText(item) {
  const refs = item && (item.evidence_refs || item.evidenceRefs);
  if (!Array.isArray(refs)) return '';
  return refs
    .map((ref) => {
      const span = ref && ref.span;
      const locator = span && span.type === 'text_span'
        ? `材料 ${ref.material_id} · 字符 ${span.start}-${span.end}`
        : span && span.type === 'time_span'
          ? `材料 ${ref.material_id} · ${formatTimestamp(span.start_ms)}–${formatTimestamp(span.end_ms)}${ref.cue_id ? ` · ${ref.cue_id}` : ''}`
          : '';
      return joinParts([locator, ref.time, ref.quote || ref.text || ref.evidence]);
    })
    .filter(has)
    .join(' / ');
}

function pointText(item) {
  const explanation = item && item.explanation;
  if (explanation && typeof explanation === 'object') {
    return joinParts([explanation.fact, explanation.judgment, explanation.impact]);
  }
  return pick(item, [
    'text',
    'summary',
    'evidence',
    'basis',
    'reason',
    'risk',
    'why',
    'why_ask',
    'verification_target',
    'script',
    'content',
    'notes',
    'judgement',
    'decision_reason',
  ]) || evidenceText(item);
}

function pointEvidence(item) {
  if (!item || typeof item === 'string') return '';
  const refs = evidenceText(item);
  return refs || pick(item, [
    'quote',
    'source_text',
    'sourceText',
    'transcript_quote',
    'transcriptQuote',
    'evidence_quote',
    'evidenceQuote',
    'original_text',
    'originalText',
  ]);
}

function normalizePoint(item, fallbackTitle) {
  if (typeof item === 'string') return { title: item, text: '', tag: '' };
  const text = pointText(item);
  const explicitEvidence = pointEvidence(item);
  const title = pick(item, ['title', 'point', 'dimension', 'question', 'field', 'name', 'label', 'competency', 'scenario']) || fallbackTitle;
  return {
    title,
    text,
    evidence: explicitEvidence && explicitEvidence !== text ? explicitEvidence : '',
    tag: pick(item, ['status', 'state', 'judgement', 'severity', 'kind', 'level', 'type', 'competency', 'to']),
  };
}

function formatTimestamp(value) {
  const totalMs = Math.max(0, Number(value) || 0);
  const totalSeconds = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function normalizeItems(values, fallbackTitle, limit = 6) {
  return values
    .flatMap(asArray)
    .map((item) => normalizePoint(item, fallbackTitle))
    .filter((item) => has(item.title) || has(item.text))
    .slice(0, limit);
}

const EVIDENCE_STOP_WORDS = new Set([
  '候选人', '面试', '这个', '那个', '一个', '一种', '可以', '需要', '当前', '目前', '比较', '相关', '情况', '问题',
  '风险点', '匹配点', '追问问题', '未知', '确认', '能力', '经验', '业务',
]);

const EVIDENCE_HINTS = [
  { query: /薪资|薪酬|薪水|月薪|年薪|年包|期望/i, passage: /薪资|薪酬|薪水|月薪|年薪|年包|期望|[kK]|万/ },
  { query: /到岗|入职|离职|notice|周期|交接/i, passage: /到岗|入职|离职|notice|周期|交接|随时|一周|两周|三周|个月/ },
  { query: /GMV|营收|销售额|流水|交易额|业绩|规模/i, passage: /GMV|营收|销售额|流水|交易额|业绩|规模|万|亿/ },
  { query: /ROI|投产|转化率|CVR|CTR|点击率|费比/i, passage: /ROI|投产|转化率|CVR|CTR|点击率|费比|%|倍/ },
  { query: /团队|管理|带人|下属|协作/i, passage: /团队|管理|带人|带领|下属|协作|人/ },
  { query: /离职|稳定|动机|原因/i, passage: /离职|稳定|动机|原因|为什么|因为/ },
  { query: /打法|运营|投放|产品|策略/i, passage: /打法|运营|投放|产品|策略|推广/ },
];

function transcriptText(transcript) {
  return clean(transcript && transcript.text);
}

function transcriptSentences(text) {
  const normalized = clean(text).replace(/\s+/g, ' ');
  if (!normalized) return [];
  const direct = normalized
    .split(/[。！？!?；;\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 6);
  const base = direct.length > 1 ? direct : normalized
    .split(/[，,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 6);
  const chunks = base.length ? base : [normalized];
  return chunks.flatMap((item) => {
    if (item.length <= 110) return [item];
    const rows = [];
    for (let index = 0; index < item.length; index += 82) rows.push(item.slice(index, index + 110));
    return rows;
  }).slice(0, 80);
}

function evidenceTokens(value) {
  const source = clean(value).toLowerCase();
  const tokens = new Set();
  (source.match(/[a-z][a-z0-9_+-]{2,}/g) || []).forEach((word) => tokens.add(word));
  (source.match(/[\u4e00-\u9fa5]{2,}/g) || []).forEach((block) => {
    const maxLen = Math.min(5, block.length);
    for (let length = 2; length <= maxLen; length += 1) {
      for (let index = 0; index <= block.length - length; index += 1) {
        tokens.add(block.slice(index, index + length));
      }
    }
  });
  return Array.from(tokens).filter((token) => token.length >= 2 && !EVIDENCE_STOP_WORDS.has(token)).slice(0, 120);
}

function fallbackEvidence(item, transcript) {
  const text = transcriptText(transcript);
  if (!text) return '';
  const query = joinParts([item.title, item.text, item.tag]);
  const tokens = evidenceTokens(query);
  const sentences = transcriptSentences(text);
  if (!tokens.length || !sentences.length) return '';
  let best = { score: 0, text: '' };
  sentences.forEach((sentence) => {
    let score = 0;
    tokens.forEach((token) => {
      if (sentence.toLowerCase().includes(token)) score += Math.min(token.length, 6);
    });
    EVIDENCE_HINTS.forEach((hint) => {
      if (hint.query.test(query) && hint.passage.test(sentence)) score += 8;
    });
    if (score > best.score) best = { score, text: sentence };
  });
  return best.score >= 6 ? compactText(best.text, 150) : '';
}

function pointRowsWithEvidence(items, transcript) {
  return (items || []).map((item) => ({
    ...item,
    evidence: item.evidence || fallbackEvidence(item, transcript),
  }));
}

const TALK_TRACK_LABELS = {
  candidate_followup_message: '发给候选人',
  business_interviewer_sync: '同步业务面试官',
  internal_hr_note: 'HR 内部备注',
};

function talkTrackLabel(key) {
  return TALK_TRACK_LABELS[key] || clean(key).replace(/[_-]+/g, ' ') || '话术';
}

function talkTrackRows(value) {
  if (!value) return [];
  if (value && typeof value === 'object' && !Array.isArray(value) && !Array.isArray(value.items)) {
    return Object.entries(value).map(([key, body]) => ({ title: talkTrackLabel(key), body: compactText(body, 480) }));
  }
  return asArray(value);
}

function normalizeTalkTracks(report) {
  const rows = [
    ...talkTrackRows(report && report.hr_talk_tracks),
    ...talkTrackRows(report && report.hr_script),
    ...talkTrackRows(report && report.talk_tracks),
    ...talkTrackRows(report && report.talkTracks),
    ...talkTrackRows(report && report.hrTalkTracks),
  ];
  return rows.map((item, index) => {
    if (typeof item === 'string') return { title: `话术 ${index + 1}`, body: item };
    return {
      title: pick(item, ['title', 'scenario', 'stage', 'intent']) || `话术 ${index + 1}`,
      body: pick(item, ['script', 'text', 'body', 'talk_track', 'talkTrack', 'content']) || compactText(JSON.stringify(item), 240),
    };
  }).filter((item) => has(item.body)).slice(0, 6);
}

function reportSummary(report) {
  const summary = report && report.summary;
  if (summary && typeof summary === 'object') {
    return pick(summary, ['one_line', 'overall', 'conclusion', 'ai_summary', 'review_summary', 'text']) || compactText(JSON.stringify(summary), 240);
  }
  return pick(report, ['summary', 'overall', 'conclusion', 'ai_summary', 'review_summary', 'decision_support', 'decision_reason']);
}

function dimensionState(item) {
  return clean(item && (item.state || item.status || item.judgement || item.judgment));
}

function reportView(report) {
  const safeReport = report || {};
  const dimensions = Array.isArray(safeReport.dimension_matches) ? safeReport.dimension_matches : [];
  const matchedDimensions = dimensions.filter((item) => {
    const state = dimensionState(item);
    return !state || /match|pass|符合|匹配|较强|明确|协同|操盘|量化/i.test(state);
  });
  return {
    summary: reportSummary(safeReport),
    matches: normalizeItems([
      safeReport.matches,
      safeReport.match_points,
      safeReport.matchPoints,
      safeReport.matching_points,
      matchedDimensions,
    ], '匹配点', 6),
    risks: normalizeItems([
      safeReport.risks,
      safeReport.risk_points,
      safeReport.riskPoints,
      safeReport.concerns,
      dimensions.filter((item) => /mismatch|risk|风险|不足|短板/i.test(dimensionState(item))),
    ], '风险点', 6),
    unknowns: normalizeItems([
      safeReport.unknowns,
      safeReport.unknown_points,
      safeReport.unknownPoints,
      dimensions.filter((item) => /unknown|待确认|未知|不确定/i.test(dimensionState(item))),
    ], 'Unknown', 6),
    questions: normalizeItems([
      safeReport.followup_questions,
      safeReport.followupQuestions,
      safeReport.interview_questions,
      safeReport.questions,
    ], '追问问题', 6),
    hardRequirements: normalizeItems([safeReport.hard_requirements], '硬性条件', 40),
    competencies: normalizeItems([safeReport.competency_evidence], '胜任力证据', 12),
    motivation: normalizeItems([safeReport.motivation], '求职动机', 1),
    contradictions: normalizeItems([safeReport.contradictions], '风险/矛盾', 12),
    assessmentCrossChecks: normalizeItems([safeReport.assessment_cross_checks], '测评交叉验证', 20),
    aiReference: normalizeItems([safeReport.ai_reference], 'AI 参考分析', 1),
    talkTracks: normalizeTalkTracks(safeReport),
  };
}

const CONFIRMATION_STATUSES = [
  { value: 'pending', label: '待确认' },
  { value: 'confirmed', label: '已确认' },
  { value: 'corrected', label: '已修正' },
  { value: 'unknown', label: '未知' },
  { value: 'rejected', label: '废弃' },
];

const CONFIRMATION_STATUS_LABELS = CONFIRMATION_STATUSES.reduce((acc, item) => {
  acc[item.value] = item.label;
  return acc;
}, {});

const CONFIRMATION_STATUS_COLORS = {
  pending: 'default',
  confirmed: 'green',
  corrected: 'blue',
  unknown: 'orange',
  rejected: 'red',
};

function localJobStatusColor(status) {
  if (status === 'done') return 'green';
  if (status === 'running') return 'blue';
  if (status === 'error') return 'red';
  if (status === 'cancelled') return 'orange';
  return 'default';
}

function localJobStatusText(status) {
  if (status === 'done') return '已完成';
  if (status === 'running') return '运行中';
  if (status === 'error') return '失败';
  if (status === 'cancelled') return '已中止';
  return '空闲';
}

function localMicCheckAlertType(level) {
  if (level === 'pass') return 'success';
  if (level === 'fail') return 'error';
  return 'warning';
}

function confirmationProgress(records, reports, confirmations) {
  return records.reduce((acc, record) => {
    const rows = confirmationRowsForRecord(record, reports, confirmations);
    acc.total += rows.length;
    acc.finished += rows.filter((item) => normalizeConfirmationStatus(item.status) !== 'pending').length;
    return acc;
  }, { total: 0, finished: 0 });
}

function sessionOnlyReportUnits(sessions, records, sessionReports, sessionReportMeta) {
  const recordingIds = new Set(records.map(recordId).map(Number).filter(Number.isInteger));
  return sessions.filter((session) => {
    const materials = Array.isArray(session.materials) ? session.materials : [];
    const linkedToLegacyRecording = materials.some((material) => (
      Number.isInteger(Number(material.interview_recording_id))
      && recordingIds.has(Number(material.interview_recording_id))
    ));
    if (linkedToLegacyRecording) return false;
    const hasReport = !!(sessionReports[session.id] || sessionReportMeta[session.id]);
    if (session.status === 'cancelled' && !hasReport) return false;
    return hasReport || materials.length > 0 || session.status === 'pending_review';
  });
}

const CURRENT_SESSION_STATUS_PRIORITY = Object.freeze({
  in_progress: 0,
  pending_review: 1,
  scheduled: 2,
  draft: 3,
  pending_schedule: 3,
  confirmed: 4,
  cancelled: 5,
});

function sessionActionLabel(session) {
  if (session?.status === 'draft' || session?.status === 'pending_schedule') return '待排期';
  if (session?.status === 'scheduled' && session?.invitation_status !== 'sent') return '待发送邀约';
  if (session?.status === 'scheduled' && (!session?.candidate_confirmation_status || session.candidate_confirmation_status === 'pending')) return '待候选人确认';
  if (session?.status === 'in_progress') return '面试进行中';
  if (session?.status === 'pending_review') return '待人工复盘';
  if (session?.status === 'confirmed') return '已确认入档';
  if (session?.status === 'cancelled') return '已取消，历史可查';
  return interviewStatusLabel(session?.status);
}

function orderedCandidateSessions(sessions) {
  return [...sessions].sort((left, right) => {
    const priority = (CURRENT_SESSION_STATUS_PRIORITY[left?.status] ?? 9)
      - (CURRENT_SESSION_STATUS_PRIORITY[right?.status] ?? 9);
    if (priority) return priority;
    const leftTime = Date.parse(left?.scheduled_at || left?.created_at || '') || 0;
    const rightTime = Date.parse(right?.scheduled_at || right?.created_at || '') || 0;
    return rightTime - leftTime || Number(right?.round || 0) - Number(left?.round || 0);
  });
}

function sessionConfirmationProgress(units, sessionFacts) {
  return units.reduce((acc, session) => {
    const rows = Array.isArray(sessionFacts[session.id]) ? sessionFacts[session.id] : [];
    acc.total += rows.length;
    acc.finished += rows.filter((item) => normalizeConfirmationStatus(item.status) !== 'pending').length;
    return acc;
  }, { total: 0, finished: 0 });
}

function confirmationRowsForRecord(record, reports, confirmations) {
  const id = recordId(record);
  return confirmations[id] && confirmations[id].length
    ? confirmations[id]
    : inferConfirmationItems(reports[id]);
}

function hasPendingConfirmation(record, reports, confirmations) {
  return confirmationRowsForRecord(record, reports, confirmations)
    .some((item) => normalizeConfirmationStatus(item.status) === 'pending');
}

function formatSeconds(value) {
  const total = Number(value);
  if (!Number.isFinite(total) || total < 0) return '暂无';
  const minutes = Math.floor(total / 60);
  const seconds = Math.round(total % 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours}:${String(rest).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function audioQualityColor(level) {
  if (level === 'pass') return 'green';
  if (level === 'warn') return 'orange';
  if (level === 'fail') return 'red';
  return 'default';
}

function audioPayloadFromRecord(record) {
  const raw = parseMaybeJson(record && (record.raw_summary_json || record.rawSummaryJson));
  const stats = raw && raw.audioStats;
  const quality = raw && raw.audioQuality;
  return { stats, quality };
}

function isLocalDemoInterview(record, report) {
  const raw = parseMaybeJson(record && (record.raw_summary_json || record.rawSummaryJson)) || {};
  const markers = [
    report && report.source,
    report && report.generator,
    raw.source,
    raw.source_type,
    raw.mode,
  ].map((value) => clean(value).toLowerCase());
  return !!(
    (report && (report.is_local_demo === true || report.is_fixture === true))
    || raw.is_local_demo === true
    || raw.is_fixture === true
    || markers.some((value) => /local_demo|fixture/.test(value))
  );
}

function AudioQualityPanel({ stats, quality }) {
  if (!stats && !quality) return null;
  const peak = stats && Number.isFinite(stats.maximumAmplitude) ? Math.abs(stats.maximumAmplitude) : null;
  const rms = stats && Number.isFinite(stats.rmsAmplitude) ? stats.rmsAmplitude : null;
  const mean = stats && Number.isFinite(stats.meanNorm) ? stats.meanNorm : null;
  const frequency = stats && Number.isFinite(stats.roughFrequency) ? stats.roughFrequency : null;
  return (
    <section className="audio-quality-card">
      <div className="audio-quality-head">
        <strong>录音质量</strong>
        <Tag color={audioQualityColor(quality && quality.level)}>{quality ? quality.label : '未知'}</Tag>
      </div>
      {quality && <p>{quality.message}</p>}
      {quality && quality.recommendation && <p>{quality.recommendation}</p>}
      <div className="audio-meter-grid">
        <div>
          <span>时长</span>
          <strong>{formatSeconds(stats && stats.lengthSeconds)}</strong>
        </div>
        <div>
          <span>RMS</span>
          <strong>{rms == null ? '暂无' : rms.toFixed(4)}</strong>
        </div>
        <div>
          <span>峰值</span>
          <strong>{peak == null ? '暂无' : peak.toFixed(4)}</strong>
        </div>
        <div>
          <span>粗略频率</span>
          <strong>{frequency == null ? '暂无' : `${Math.round(frequency)}Hz`}</strong>
        </div>
      </div>
      <div className="audio-bars" aria-hidden="true">
        {[rms, mean, peak, frequency == null ? null : Math.min(frequency / 1200, 1)].map((value, index) => (
          <i key={index} style={{ height: `${Math.max(8, Math.min(100, Number(value || 0) * 100))}%` }} />
        ))}
      </div>
    </section>
  );
}

function InterviewStatusPanel({ state, summary }) {
  return (
    <section className={`interview-status-panel ${state.tone || ''}`}>
      <div className="interview-status-main">
        <span aria-hidden="true" />
        <div>
          <strong>{state.label}</strong>
          <p>
            <span>{state.message}</span>
            {summary && <span className="interview-status-metrics">{summary}</span>}
          </p>
        </div>
      </div>
    </section>
  );
}

function InterviewTodoStrip({ items, onSelect }) {
  const actionableItems = actionableInterviewTodoItems(items);
  if (!actionableItems.length) {
    return (
      <section className="interview-todo-complete" role="status" aria-label="面试流程已处理完成">
        <CheckCircleOutlined aria-hidden="true" />
        <div>
          <strong>面试流程已处理完成</strong>
          <small>当前没有面试待办；完成材料仍可在下方分区查看。</small>
        </div>
      </section>
    );
  }
  return (
    <section className="interview-todo-strip" aria-label="面试页内待办清单" role="list">
      {actionableItems.map((item) => (
        <div key={item.key} role="listitem">
          <button
            type="button"
            className={`interview-todo-item ${item.tone || ''}`}
            data-todo-key={item.key}
            aria-label={`${item.label}：${item.statusText}；${item.detail}`}
            onClick={() => onSelect(item)}
            style={{ width: '100%', height: '100%' }}
          >
            <span className="interview-todo-icon">{item.icon}</span>
            <span className="interview-todo-copy">
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </span>
            <span className="interview-todo-status">
              <em>{item.count}</em>
              <small>{item.statusText}</small>
            </span>
          </button>
        </div>
      ))}
    </section>
  );
}

const CONFIRMATION_FIELDS = [
  {
    id: 'salary_expectation',
    label: '薪资期望',
    keywords: [/薪资|薪酬|薪水|月薪|年薪|年包/i],
    valuePatterns: [
      /(?:期望薪资|薪资期望|薪酬期望|薪资|薪酬|月薪|年薪|年包|期望)[^，。；;\n]{0,14}?(面议|可谈|不低于[^，。；;\n]{1,16}|\d+(?:\.\d+)?\s*(?:[kK]|万|w|W)?(?:\s*[-~至到]\s*\d+(?:\.\d+)?\s*(?:[kK]|万|w|W)?)?(?:\s*(?:\/月|\/年|月|年|税前|税后|薪)?)?)/i,
    ],
  },
  {
    id: 'business_scale',
    label: 'GMV/营收数字',
    keywords: [/GMV|营收|收入|销售额|流水|交易额|业绩|业务规模/i],
    valuePatterns: [
      /(?:GMV|营收|收入|销售额|流水|交易额|业绩|业务规模)[^，。；;\n]{0,16}?(\d+(?:\.\d+)?\s*(?:亿|万|w|W|k|K)?(?:\s*[-~至到]\s*\d+(?:\.\d+)?\s*(?:亿|万|w|W|k|K)?)?\s*(?:元|人民币|美金|美元|\/年|\/月|年|月)?)/i,
    ],
  },
  {
    id: 'efficiency_metric',
    label: 'ROI/转化率',
    keywords: [/ROI|投产|转化率|CVR|CTR|点击率|留存率|费比/i],
    valuePatterns: [
      /(?:ROI|投产比?|转化率|CVR|CTR|点击率|留存率|费比)[^，。；;\n]{0,16}?(\d+(?:\.\d+)?\s*(?:%|倍|:1|：1)?)/i,
    ],
  },
  {
    id: 'work_years',
    label: '工作年限',
    keywords: [/工作年限|工作经验|从业|年经验|经验/i],
    valuePatterns: [
      /(\d+(?:\.\d+)?\s*(?:年|个月)(?:以上|左右)?(?:\s*[-~至到]\s*\d+(?:\.\d+)?\s*年)?(?:\s*(?:工作经验|从业经验|经验))?)/i,
    ],
  },
  {
    id: 'team_size',
    label: '团队规模',
    keywords: [/团队|带人|带领|管理|下属|组建|汇报/i],
    valuePatterns: [
      /(?:团队|带领|带过|管理|下属|组建|汇报)[^，。；;\n]{0,18}?(\d+(?:\.\d+)?\s*(?:人|个|名)(?:\s*[-~至到]\s*\d+(?:\.\d+)?\s*(?:人|个|名))?)/i,
    ],
  },
  {
    id: 'arrival_time',
    label: '到岗时间',
    keywords: [/到岗|入职|离职|交接|在职|notice|最快|周期/i],
    valuePatterns: [
      /(?:到岗|入职|离职|交接|在职|notice|最快|周期)[^，。；;\n]{0,18}?((?:随时|立即|一周|两周|二周|三周|一个月|半个月|\d+\s*(?:天|周|个月)|\d{1,2}\s*月\s*\d{0,2}\s*日?))/i,
    ],
  },
];

function splitConfirmationText(text) {
  return clean(text)
    .replace(/\r/g, '\n')
    .replace(/[•●▪◆]/g, '\n')
    .split(/\n+|[。！？!?；;]/)
    .map((item) => item.replace(/^[\s\-–\d.、）)]+/, '').trim())
    .filter(Boolean);
}

function collectConfirmationEntries(source, value, entries = []) {
  if (!has(value)) return entries;
  if (typeof value === 'string' || typeof value === 'number') {
    splitConfirmationText(value).forEach((text) => entries.push({ source, text }));
    return entries;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectConfirmationEntries(source, item, entries));
    return entries;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => collectConfirmationEntries(`${source}.${key}`, item, entries));
  }
  return entries;
}

function confirmationReportEntries(report) {
  const safeReport = report || {};
  const entries = [];
  [
    ['summary', safeReport.summary || safeReport.overall || safeReport.conclusion || safeReport.decision_support || safeReport.decision_reason],
    ['concerns', safeReport.concerns || safeReport.risks || safeReport.risk_points || safeReport.riskPoints],
    ['unknowns', safeReport.unknowns || safeReport.unknown_points || safeReport.unknownPoints],
    ['followup_questions', safeReport.followup_questions || safeReport.followupQuestions || safeReport.interview_questions || safeReport.questions],
    ['hr_talk_tracks', safeReport.hr_talk_tracks || safeReport.hr_script || safeReport.talk_tracks || safeReport.talkTracks || safeReport.hrTalkTracks],
  ].forEach(([source, value]) => collectConfirmationEntries(source, value, entries));

  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.source}:${entry.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractConfirmationValue(text, field) {
  for (const pattern of field.valuePatterns || []) {
    const match = clean(text).match(pattern);
    if (match) {
      return clean(match[1] || match[0])
        .replace(/^[：:，,\s]+/, '')
        .replace(/[，。；;、\s]+$/g, '');
    }
  }
  return '';
}

function inferConfirmationItems(report) {
  const entries = confirmationReportEntries(report);
  return CONFIRMATION_FIELDS.map((field) => {
    const matched = entries.find((entry) => field.keywords.some((keyword) => keyword.test(entry.text)));
    const valueEntry = entries.find((entry) => {
      if (!field.keywords.some((keyword) => keyword.test(entry.text))) return false;
      return has(extractConfirmationValue(entry.text, field));
    });
    const entry = valueEntry || matched;
    return {
      id: field.id,
      label: field.label,
      status: 'pending',
      value: entry ? extractConfirmationValue(entry.text, field) : '',
      corrected_value: '',
      note: '',
      evidence: entry ? compactText(entry.text, 180) : '',
      source: entry ? `ai:${entry.source}` : 'ai:empty',
    };
  });
}

function confirmationItemId(item, index) {
  return confirmationReviewItemId(item, index, CONFIRMATION_FIELDS);
}

function normalizeSavedConfirmationItem(item, index) {
  return normalizeSavedReviewItem(item, index, CONFIRMATION_FIELDS);
}

function confirmationItemsFromResponse(data) {
  const payload = data && (
    data.items ||
    data.confirmations ||
    data.confirmation_items ||
    data.confirmationItems ||
    data.rows ||
    data.data
  );
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  return [];
}

function mergeConfirmationItems(inferredItems, savedItems) {
  const normalizedSaved = (savedItems || []).map(normalizeSavedConfirmationItem);
  if (normalizedSaved.some((item) => item.source === 'interview_report_v1')) return normalizedSaved;
  const savedById = new Map(normalizedSaved.map((item) => [item.id, item]));
  const knownIds = new Set(inferredItems.map((item) => item.id));
  const merged = inferredItems.map((item) => {
    const saved = savedById.get(item.id);
    if (!saved) return item;
    return {
      ...item,
      ...saved,
      id: item.id,
      label: saved.label || item.label,
      value: Object.prototype.hasOwnProperty.call(saved, 'value') && has(saved.value) ? saved.value : item.value,
      evidence: has(saved.evidence) ? saved.evidence : item.evidence,
      source: saved.source || item.source,
    };
  });
  normalizedSaved.forEach((item) => {
    if (!knownIds.has(item.id)) merged.push(item);
  });
  return merged;
}

function StatusTags({ record }) {
  const bound = has(recordCandidateId(record));
  return (
    <Space size={4} wrap>
      <Tag color={bound ? 'green' : 'orange'}>{bound ? '已绑定' : '待匹配'}</Tag>
      {isConfirmed(record) && <Tag icon={<CheckCircleOutlined />} color="cyan">已确认</Tag>}
    </Space>
  );
}

function PathList({ record }) {
  const rows = pathRows(record);
  if (!rows.length) return <Text type="secondary">暂无转写路径</Text>;
  return (
    <div className="interview-path-list">
      {rows.map(([label, value]) => (
        <div className="interview-path-row" key={label}>
          <span>{label}</span>
          <code>{value}</code>
        </div>
      ))}
    </div>
  );
}

function TranscriptEvidence({ record, transcript, loadError, onCopy, onRetry }) {
  const text = transcript && transcript.text;
  const cues = Array.isArray(transcript && transcript.cues) ? transcript.cues : [];
  const lowConfidenceCount = Number(transcript && transcript.low_confidence_cue_count) || 0;
  const label = joinParts([
    transcript && transcript.accuracy_label ? transcript.accuracy_label : 'ASR 转写草稿（未经逐字复核）',
    transcript && transcript.size ? `${Math.round(transcript.size / 1024)}KB` : '',
  ]) || 'ASR 转写草稿（未经逐字复核）';
  return (
    <Collapse
      className="interview-evidence-collapse"
      bordered={false}
      items={[
        {
          key: 'full-transcript',
          classNames: {
            header: 'interview-evidence-collapse-header',
            body: 'interview-evidence-collapse-body',
          },
          label,
          children: (
            <div className="interview-evidence-panel">
              {loadError ? (
                <Alert
                  type="error"
                  showIcon
                  message="全文转写暂不可读"
                  description="读取失败不会按“暂无全文转写”处理；请重新读取后再核验材料。"
                  action={<Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>重新读取</Button>}
                />
              ) : has(text) ? (
                <>
                  <Alert
                    type={lowConfidenceCount > 0 ? 'warning' : 'info'}
                    showIcon
                    message={lowConfidenceCount > 0
                      ? `${lowConfidenceCount} 段转写置信信号偏低，关键事实必须听录音或人工复核`
                      : '这是 ASR 转写草稿，不等于准确逐字稿'}
                    description="AI 只能基于下列带时间戳的草稿整理证据；未复核内容不得直接作为最终事实。"
                  />
                  <div className="interview-evidence-actions">
                    <Text type="secondary">{transcript.path || 'transcript.txt'}</Text>
                    <Button size="small" icon={<CopyOutlined />} onClick={() => onCopy(text)}>
                      复制全文
                    </Button>
                  </div>
                  {cues.length ? (
                    <div className="interview-transcript-text" aria-label="带时间戳的 ASR 转写 cue">
                      {cues.map((cue) => (
                        <p key={cue.cue_id || `${cue.start_ms}-${cue.end_ms}`}>
                          <Tag color={cue.low_confidence ? 'orange' : 'blue'}>
                            {formatTimestamp(cue.start_ms)}–{formatTimestamp(cue.end_ms)}
                          </Tag>
                          {cue.low_confidence && <Tag color="orange">低置信</Tag>}
                          <span>{cue.text}</span>
                        </p>
                      ))}
                    </div>
                  ) : <pre className="interview-transcript-text">{text}</pre>}
                </>
              ) : (
                <div className="interview-muted">暂无全文转写。完成导入后刷新，或检查 transcript.txt 路径。</div>
              )}
              <div className="interview-evidence-paths">
                <div className="interview-section-title">
                  <strong>原始产物路径</strong>
                </div>
                <PathList record={record} />
              </div>
            </div>
          ),
        },
      ]}
    />
  );
}

function InterviewScriptPanel({
  script,
  loadError,
  draft,
  editing,
  readOnly,
  busyKey,
  onGenerate,
  onEdit,
  onDraft,
  onSave,
  onRetry,
}) {
  const previewText = scriptText(script);
  return (
    <section className="interview-script-panel" id="interview-script-panel" tabIndex={-1}>
      <div className="interview-section-title">
        <div>
          <strong>面试结构化脚本</strong>
          <p>面试前根据 JD/岗位画像生成，HR 修改后用于防漏问和面后复盘对照。</p>
        </div>
        <Space wrap>
          {script && <Tag color={script.status === 'confirmed' ? 'green' : 'blue'}>{script.status === 'confirmed' ? '已确认' : '草稿'}</Tag>}
          <Button
            size="small"
            icon={<RobotOutlined />}
            disabled={readOnly || !!loadError || editing}
            loading={busyKey === 'script:generate'}
            onClick={onGenerate}
          >
            根据JD生成脚本
          </Button>
          {script && !editing && (
            <Button size="small" disabled={readOnly || !!loadError} onClick={onEdit}>
              HR 修改
            </Button>
          )}
        </Space>
      </div>

      {loadError && (
        <Alert
          type="error"
          showIcon
          message="面试脚本暂不可读"
          description="读取失败不会按“当前岗位还没有面试脚本”处理；重新读取成功前已禁用生成和保存。"
          action={<Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>重新读取</Button>}
        />
      )}

      {!script && !loadError && (
        <Alert
          type="info"
          showIcon
          message="当前岗位还没有面试脚本"
          description="先生成一版 JD 驱动脚本，HR 再按实际业务口径调整。"
        />
      )}

      {script && !editing && (
        <div className="interview-script-text-preview" aria-label="当前保存的面试脚本">
          <div>
            <strong>当前保存内容</strong>
            <Text type="secondary">预览与编辑器使用同一份文本</Text>
          </div>
          <pre>{previewText || '当前脚本内容为空。'}</pre>
        </div>
      )}

      {editing && (
        <div className="interview-script-editor">
          <TextArea
            aria-label="面试脚本文本"
            name="interview-review-script-text"
            autoComplete="off"
            spellCheck
            rows={12}
            value={draft}
            disabled={readOnly || !!loadError}
            onChange={(event) => onDraft(event.target.value)}
          />
          <Text type="secondary">支持按行编排问题与备注；保存后预览会逐字显示这份内容。</Text>
          <Space>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              disabled={readOnly || !!loadError || !draft.trim()}
              loading={busyKey === 'script:save'}
              onClick={onSave}
            >
              保存脚本
            </Button>
            <Button onClick={() => onEdit(false)}>取消</Button>
          </Space>
        </div>
      )}
    </section>
  );
}

function AssessmentInterviewEvidence({
  archives = [],
  analyses = [],
  candidateName = '',
  candidateDraft = '',
  loadError = '',
  onRetry,
  onPrepareApprovedAiQuestions,
  onCopyCandidateDraft,
}) {
  const activeReports = archives.filter((row) => (
    row.binding_state === 'active'
    && row.review_state === 'ready'
    && row.lifecycle_state === 'active'
    && row.report_type !== 'unknown'
  ));
  if (!activeReports.length && !loadError) return null;
  const supplierQuestions = [...new Set(activeReports.flatMap((row) => (
    Array.isArray(row.analysis?.interview_questions) ? row.analysis.interview_questions : []
  )))].slice(0, 6);
  const currentAi = analyses.find((item) => item.current === true) || null;
  const aiQuestions = Array.isArray(currentAi?.analysis?.interview_questions)
    ? currentAi.analysis.interview_questions.slice(0, 6)
    : [];
  return (
    <Card size="small" title="候选人测评核验题" style={{ marginTop: 12 }}>
      {loadError && (
        <Alert
          type="warning"
          showIcon
          message="测评证据读取失败"
          description={`当前不会把读取失败解释为“没有测评报告”。可继续人工准备面试，也可重试读取：${loadError}`}
          action={typeof onRetry === 'function' ? <Button size="small" onClick={onRetry}>重试读取</Button> : null}
        />
      )}
      {activeReports.length > 0 && (
      <Alert
        type="info"
        showIcon
        message={`已读取 ${activeReports.length} 份 HR 确认测评报告`}
        description="以下问题只用于在面试中核验测评线索，不进入自动评分、排序或处置。面试官应以候选人的具体事实回答为准。"
      />
      )}
      {supplierQuestions.length > 0 && (
        <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
          <Text strong>本地报告提取的核验题</Text>
          {supplierQuestions.map((question, index) => (
            <Text key={`assessment-local-question:${index}`}>{index + 1}. {question}</Text>
          ))}
        </div>
      )}
      {aiQuestions.length > 0 && (
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          <Space wrap style={{ justifyContent: 'space-between' }}>
            <Text strong>已按次批准且当前有效的 AI 核验题</Text>
            {typeof onPrepareApprovedAiQuestions === 'function' && (
              <Button
                size="small"
                onClick={() => onPrepareApprovedAiQuestions(aiQuestions)}
              >
                生成当前候选人临时核验稿
              </Button>
            )}
          </Space>
          {aiQuestions.map((item, index) => (
            <div key={`assessment-ai-question:${index}`}>
              <Text>{index + 1}. {item.question}</Text><br />
              <Text type="secondary">重点听：{item.listen_for}</Text>
              <div>{(item.evidence_refs || []).map((ref) => <Tag key={ref}>{ref}</Tag>)}</div>
            </div>
          ))}
        </div>
      )}
      {candidateDraft && (
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          <Alert
            type="success"
            showIcon
            message="当前候选人临时核验稿"
            description={`仅用于当前候选人${candidateName ? `“${candidateName}”` : ''}页面；切换候选人会清空，未保存到岗位面试脚本模板。`}
          />
          <div className="interview-script-text-preview" aria-label="当前候选人临时核验稿内容">
            <pre>{candidateDraft}</pre>
          </div>
          {typeof onCopyCandidateDraft === 'function' && (
            <Button size="small" onClick={onCopyCandidateDraft}>复制临时核验稿</Button>
          )}
        </div>
      )}
      {!supplierQuestions.length && !aiQuestions.length && (
        <Text type="secondary" style={{ display: 'block', marginTop: 10 }}>
          当前已确认报告没有形成可复用核验题；请由 HR 根据报告摘要人工补充，不会自动调用外部 AI。
        </Text>
      )}
    </Card>
  );
}

function MiniList({ title, items, tone, icon, transcript }) {
  const rows = pointRowsWithEvidence(items, transcript);
  return (
    <section className={`interview-mini-list ${tone || ''}`}>
      <div className="interview-mini-head">
        <span>{icon}</span>
        <strong>{title}</strong>
        <em>{rows.length}</em>
      </div>
      {rows.length ? (
        <ul>
          {rows.map((item, index) => (
            <li key={index}>
              <div>
                <span>{compactText(item.title, 76)}</span>
                {has(item.tag) && <Tag>{item.tag}</Tag>}
              </div>
              {has(item.text) && <p>{compactText(item.text, 120)}</p>}
              {has(item.evidence) && (
                <blockquote className="interview-point-evidence">
                  <span>依据</span>
                  <q>{compactText(item.evidence, 150)}</q>
                </blockquote>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="interview-muted">暂无</div>
      )}
    </section>
  );
}

function ExtendedReviewSections({ view, transcript }) {
  const sections = [
    ['硬性条件逐项核对', view.hardRequirements, 'unknown', <CheckCircleOutlined />],
    ['胜任力证据', view.competencies, 'match', <CheckCircleOutlined />],
    ['求职动机', view.motivation, 'question', <QuestionCircleOutlined />],
    ['风险与矛盾', view.contradictions, 'risk', <WarningOutlined />],
    ['测评报告交叉验证', view.assessmentCrossChecks, 'unknown', <FileTextOutlined />],
    ['AI 参考分析（不含处置决定）', view.aiReference, 'question', <RobotOutlined />],
  ];
  if (!sections.some(([, items]) => Array.isArray(items) && items.length)) return null;
  return (
    <div className="interview-ai-grid interview-decision-brief ai-review-phase-grid">
      {sections.map(([title, items, tone, icon]) => (
        <MiniList
          key={title}
          title={title}
          tone={tone}
          icon={icon}
          items={items}
          transcript={transcript}
        />
      ))}
    </div>
  );
}

function TalkTracks({ items, onCopy }) {
  return (
    <section className="interview-talk-tracks">
      <div className="interview-section-title">
        <strong>HR 话术</strong>
        <em>{items.length}</em>
      </div>
      {items.length ? items.map((item, index) => (
        <div className="interview-talk-track" key={index}>
          <div className="interview-talk-head">
            <strong>{item.title}</strong>
            <Button size="small" icon={<CopyOutlined />} onClick={() => onCopy(item.body)}>
              复制话术
            </Button>
          </div>
          <p>{item.body}</p>
        </div>
      )) : <div className="interview-muted">暂无话术</div>}
    </section>
  );
}

function ReportEditor({ record, report, editingId, draft, readOnly, busyKey, onEdit, onDraft, onSave }) {
  const id = recordId(record);
  const editing = editingId === id;
  return (
    <Collapse
      className="interview-json-collapse"
      ghost
      bordered={false}
      items={[
        {
          key: 'report-json',
          classNames: {
            header: 'interview-json-collapse-header',
            body: 'interview-json-collapse-body',
          },
          label: '高级报告数据',
          children: editing ? (
            <div className="interview-report-editor">
              <TextArea
                aria-label={`录音 ${id || '当前'} 的面试报告 JSON`}
                name={`interview-review-recording-report-${id || 'current'}`}
                autoComplete="off"
                spellCheck={false}
                rows={7}
                value={draft}
                onChange={(event) => onDraft(event.target.value)}
                disabled={readOnly}
              />
              <Space>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  disabled={readOnly || !id}
                  loading={busyKey === `save:${id}`}
                  onClick={() => onSave(record)}
                >
                  保存报告
                </Button>
                <Button onClick={() => onEdit(null)}>取消</Button>
              </Space>
            </div>
          ) : (
            <Button size="small" disabled={readOnly || !id} onClick={() => onEdit(record, report)}>
              编辑报告数据
            </Button>
          ),
        },
      ]}
    />
  );
}

function LlmSendPreviewModal({
  preview,
  busy,
  cancelling,
  onAnalyze,
  onCancelRequest,
  onClose,
  onManualFallback,
}) {
  if (!preview) return null;
  const units = Array.isArray(preview.units) ? preview.units : [];
  const materialIds = Array.isArray(preview.materialIds) ? preview.materialIds : [];
  const context = preview.context && typeof preview.context === 'object' ? preview.context : {};
  const hardRequirements = Array.isArray(context.hard_requirements) ? context.hard_requirements : [];
  const confirmedResumeFacts = Array.isArray(context.confirmed_resume_facts) ? context.confirmed_resume_facts : [];
  const confirmedAssessments = Array.isArray(context.confirmed_assessments) ? context.confirmed_assessments : [];
  const characterCount = units.reduce((sum, unit) => sum + Array.from(String(unit.text || '')).length, 0);
  return (
    <Modal
      title="发送前预览"
      open
      width={780}
      style={{ top: 32 }}
      styles={{
        body: {
          maxHeight: 'calc(100dvh - 180px)',
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          scrollbarGutter: 'stable',
        },
      }}
      closable={!busy}
      maskClosable={!busy}
      onCancel={busy ? undefined : onClose}
      footer={[
        <Button key="manual" disabled={busy} onClick={onManualFallback}>改用人工结构化复盘</Button>,
        busy ? (
          <Button key="cancel-request" danger loading={cancelling} onClick={onCancelRequest}>取消本次请求</Button>
        ) : (
          <Button key="close" onClick={onClose}>返回检查</Button>
        ),
        <Button key="send" type="primary" disabled={busy || units.length === 0} loading={busy} onClick={onAnalyze}>
          确认发送并生成草稿
        </Button>,
      ]}
    >
      <div className="interview-llm-preview">
        <Alert
          type="warning"
          showIcon
          message={`此操作会把下方列出的文本发送到 ${preview.provider || '已配置的外部 AI Provider'}`}
          description="AI 结果只能进入 draft，不会自动确认、排序、定档或作出录用/淘汰决定。"
        />
        <div className="interview-llm-preview-facts">
          <div><span>Provider</span><strong>{preview.provider || '未配置'}</strong></div>
          <div><span>Base URL</span><strong>{preview.baseUrl || '未配置'}</strong></div>
          <div><span>模型</span><strong>{preview.model || '未配置'}</strong></div>
          <div><span>文本规模</span><strong>{characterCount} 字符 / {units.length} 片段</strong></div>
          <div><span>面试轮次记录</span><strong>{preview.sessionId || '未知'}</strong></div>
          <div><span>材料</span><strong>{materialIds.length ? materialIds.join(', ') : '由后端最小化选择'}</strong></div>
        </div>
        <section className="interview-llm-exclusions">
          <strong>明确不发送</strong>
          <div>
            <Tag>原始音频/视频</Tag>
            <Tag>截图</Tag>
            <Tag>完整简历</Tag>
            <Tag>手机/微信/邮箱</Tag>
            <Tag>S/A/B/C 档位</Tag>
            <Tag>排序与处置指令</Tag>
          </div>
        </section>
        <section className="interview-llm-units">
          <div className="interview-section-title">
            <strong>实际发送的最小上下文</strong>
            <em>{hardRequirements.length + confirmedResumeFacts.length + confirmedAssessments.length}</em>
          </div>
          <Alert
            type="info"
            showIcon
            message="只发送 HR 已确认或岗位已确认的下列条目"
            description="未确认的简历原文、测评 PDF 与候选人其他材料不会随本次请求发送。"
          />
          <div>
            <strong>岗位硬性条件</strong>
            {hardRequirements.length
              ? <ul>{hardRequirements.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
              : <Text type="secondary">无已确认硬性条件；模型必须按 Unknown 处理。</Text>}
          </div>
          <div>
            <strong>HR 已确认简历事实</strong>
            {confirmedResumeFacts.length
              ? <ul>{confirmedResumeFacts.map((item) => <li key={item.id}>{item.label}：{item.value}</li>)}</ul>
              : <Text type="secondary">无显式确认事实；不会发送完整简历。</Text>}
          </div>
          <div>
            <strong>HR 已确认测评摘要（测评报告仍独立保存）</strong>
            {confirmedAssessments.length
              ? <ul>{confirmedAssessments.map((item) => (
                <li key={item.document_id}>{item.report_type} / {item.document_id}：{item.summary}</li>
              ))}</ul>
              : <Text type="secondary">无可发送的已确认测评摘要。</Text>}
          </div>
        </section>
        <section className="interview-llm-units" style={{ maxHeight: 'min(320px, 35dvh)' }}>
          <div className="interview-section-title">
            <strong>实际发送文本</strong>
            <em>{units.length}</em>
          </div>
          {units.length ? units.map((unit, index) => (
            <article key={`${unit.materialId || 'material'}-${index}`}>
              <div>
                <Tag color="blue">Material {unit.materialId}</Tag>
                <Text type="secondary">
                  {unit.span && unit.span.type === 'text_span'
                    ? `${unit.span.start}-${unit.span.end}`
                    : unit.span && unit.span.type === 'time_span'
                      ? `${formatTimestamp(unit.span.start_ms)}–${formatTimestamp(unit.span.end_ms)} · ${unit.cueId || 'cue'}`
                      : '受控文本片段'}
                </Text>
                {unit.lowConfidence && <Tag color="orange">低置信，需人工复核</Tag>}
              </div>
              <pre>{unit.text || ''}</pre>
            </article>
          )) : <Alert type="error" showIcon message="预览未返回可发送文本，不能继续。" />}
        </section>
        <Alert
          type="info"
          showIcon
          message="请人工检查残余隐私信息"
          description="系统已排除无关材料，但转写原文仍可能包含口述的姓名、联系方式或其他个人信息；若发现不应外发的内容，请返回修正材料或改用人工结构化复盘。"
        />
        {busy && (
          <Alert
            type="warning"
            showIcon
            message="AI 请求进行中"
            description="可显式取消；取消、超时或失败均不会自动重试。"
          />
        )}
        <Text type="secondary">点击“确认发送并生成草稿”后，还需在系统原生对话框确认本次外发；授权只绑定当前用途、目标和请求，且不可复用。</Text>
        <Text type="secondary">请求失败、超时或取消时不会写入正式事实；系统不会静默换模型重试。</Text>
      </div>
    </Modal>
  );
}

function SessionMaterialSelector({ session, selectedIds, readOnly, onChange }) {
  const materials = Array.isArray(session && session.materials) ? session.materials : [];
  return (
    <section className="interview-session-material-picker">
      <div>
        <strong>本次发送材料</strong>
        <Text type="secondary">只发送人工勾选的转写材料，默认仅选中一份。</Text>
      </div>
      {materials.length ? (
        <Checkbox.Group
          value={selectedIds}
          disabled={readOnly}
          onChange={(values) => onChange(values.map(Number).filter(Number.isInteger))}
          options={materials.map((material) => ({
            value: Number(material.id),
            disabled: material.source_status === 'revoked',
            label: `${material.source_type === 'manual_note'
              ? 'HR 人工笔记（非 ASR）'
              : material.source_type === 'lark_minutes' ? '线上妙记' : '线下录音'} · Material ${material.id}${material.source_status === 'revoked' ? '（已撤销）' : ''}`,
          }))}
        />
      ) : <Text type="secondary">本轮面试尚无可用材料。</Text>}
    </section>
  );
}

function ManualInterviewNoteEditor({ session, readOnly, busyKey, onChanged }) {
  const { message, modal } = AntApp.useApp();
  const note = session?.manual_note || null;
  const [body, setBody] = useState(note?.body || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => setBody(note?.body || ''), [note?.body, note?.version, session?.id]);
  const revoked = note?.status === 'revoked';

  async function saveNote() {
    if (!body.trim()) {
      message.warning('请先填写人工面试笔记。');
      return;
    }
    setSaving(true);
    try {
      await api.saveInterviewManualNote(session.id, body, Number(note?.version || 0));
      message.success('人工面试笔记已保存为独立材料，并保留作者、时间和版本历史。');
      await onChanged();
    } catch (error) {
      message.error(`人工面试笔记保存失败：${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  function revokeNote() {
    let revoked = false;
    modal.confirm({
      title: '撤销这份人工面试笔记？',
      content: '撤销后保留历史，但它不再可被选择为新报告证据；引用它的未确认草稿会变为过期，须重新生成。',
      okText: '确认撤销',
      cancelText: '保留笔记',
      okButtonProps: { danger: true },
      onOk: async () => {
        setSaving(true);
        try {
          await api.revokeInterviewManualNote(session.id, Number(note?.version || 0));
          revoked = true;
          await onChanged();
        } catch (error) {
          message.error(`人工面试笔记撤销失败：${error.message}`);
        } finally {
          setSaving(false);
        }
      },
      // The success notice waits for afterClose so it never fires under the
      // still-closing confirm dialog.
      afterClose: () => {
        if (revoked) message.success('人工面试笔记已撤销，历史仍保留。');
      },
    });
  }

  return (
    <section className="interview-manual-note-editor">
      <div className="interview-section-title">
        <div>
          <strong>无录音时的 HR 人工笔记</strong>
          <p>这是人工材料，不会标记为 ASR 转写；每次保存均保留作者、时间与历史版本。</p>
        </div>
        {note && <Tag color={revoked ? 'red' : 'green'}>{revoked ? '已撤销' : `版本 ${note.version}`}</Tag>}
      </div>
      <TextArea
        aria-label={`面试轮次记录 ${session.id} 人工面试笔记`}
        rows={4}
        value={body}
        disabled={readOnly || !!busyKey || saving || revoked}
        placeholder="记录候选人的关键原话、事实和待核实事项；请勿把它当作录音逐字稿。"
        onChange={(event) => setBody(event.target.value)}
      />
      <Space wrap style={{ marginTop: 8 }}>
        <Button type="primary" disabled={readOnly || !!busyKey || saving || revoked || !body.trim()} loading={saving} onClick={saveNote}>
          {note ? '保存新版本' : '保存为人工材料'}
        </Button>
        {note && !revoked && <Button danger disabled={readOnly || !!busyKey || saving} onClick={revokeNote}>撤销材料</Button>}
        {note?.updated_at && <Text type="secondary">最近保存：{fmtTime(note.updated_at)} · 操作者 {note.updated_by}</Text>}
      </Space>
    </section>
  );
}

function parseHardRequirementLines(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^\[(符合|不符合|待核实)\]\s*(.*?)(?:[：:]\s*(.*))?$/);
    if (!match) return { status: 'unknown', label: line, text: line };
    return {
      status: match[1] === '符合' ? 'met' : match[1] === '不符合' ? 'not_met' : 'unknown',
      label: (match[2] || line).trim(),
      text: (match[3] || match[2] || line).trim(),
    };
  });
}

function parseFactLines(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.search(/[：:]/);
    return separator > 0
      ? { label: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() }
      : { label: '关键事实', value: line };
  });
}

function StructuredManualReportForm({ session, selectedMaterialIds, reportMeta, readOnly, busyKey, onSave }) {
  const [form, setForm] = useState({
    summary: '',
    hardRequirementsText: '',
    competencies: '',
    motivation: '',
    risks: '',
    contradictions: '',
    unknowns: '',
    followupQuestions: '',
    keyFactsText: '',
  });
  const patch = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const disabled = readOnly || !!busyKey || reportMeta?.read_only || !selectedMaterialIds.length;
  const submit = () => onSave({
    summary: form.summary,
    hardRequirements: parseHardRequirementLines(form.hardRequirementsText),
    competencies: form.competencies,
    motivation: form.motivation,
    risks: form.risks,
    contradictions: form.contradictions,
    unknowns: form.unknowns,
    followupQuestions: form.followupQuestions,
    keyFacts: parseFactLines(form.keyFactsText),
  });
  return (
    <section className="interview-structured-manual-report">
      <div className="interview-section-title">
        <div>
          <strong>人工结构化复盘（无需 AI）</strong>
          <p>按 HR 工作项填写即可；系统负责生成合法草稿，JSON 仅保留在下方高级入口。</p>
        </div>
      </div>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <TextArea aria-label="人工复盘摘要" rows={2} placeholder="面试摘要" value={form.summary} disabled={disabled} onChange={patch('summary')} />
        <TextArea aria-label="硬性条件核对" rows={3} placeholder={'每行一项，例如：[符合] 城市：可在上海到岗\n[待核实] 薪资：下一轮确认'} value={form.hardRequirementsText} disabled={disabled} onChange={patch('hardRequirementsText')} />
        <TextArea aria-label="胜任力证据" rows={3} placeholder="每行一条胜任力证据" value={form.competencies} disabled={disabled} onChange={patch('competencies')} />
        <TextArea aria-label="求职动机" rows={2} placeholder="求职动机与离职原因" value={form.motivation} disabled={disabled} onChange={patch('motivation')} />
        <TextArea aria-label="风险与矛盾" rows={3} placeholder="风险（每行一项）" value={form.risks} disabled={disabled} onChange={patch('risks')} />
        <TextArea aria-label="材料矛盾" rows={3} placeholder="矛盾/冲突（每行一项）" value={form.contradictions} disabled={disabled} onChange={patch('contradictions')} />
        <TextArea aria-label="待核实事项" rows={3} placeholder="待核实事项（每行一项）" value={form.unknowns} disabled={disabled} onChange={patch('unknowns')} />
        <TextArea aria-label="下一轮追问" rows={3} placeholder="下一轮追问（每行一题）" value={form.followupQuestions} disabled={disabled} onChange={patch('followupQuestions')} />
        <TextArea aria-label="关键事实" rows={3} placeholder="每行“事实名称：确认值”，保存后仍须逐项人工复核" value={form.keyFactsText} disabled={disabled} onChange={patch('keyFactsText')} />
        <Button type="primary" icon={<SaveOutlined />} disabled={disabled} loading={busyKey === `session-structured-save:${session.id}`} onClick={submit}>
          保存人工结构化草稿
        </Button>
        {!selectedMaterialIds.length && <Text type="warning">请先保存人工笔记或选择一份可用面试材料。</Text>}
      </Space>
    </section>
  );
}

function SessionOnlyReportCard({
  session,
  report,
  reportMeta,
  reportLoadError,
  facts,
  llmAvailable,
  llmUnavailableReason,
  selectedMaterialIds,
  readOnly,
  busyKey,
  editingId,
  draft,
  onPreview,
  onEdit,
  onDraft,
  onSave,
  onMaterialsChange,
  onFactsChange,
  onFactsSave,
  factsDirty,
  onConfirm,
  onRetryReport,
  onManualNoteChanged,
  onStructuredSave,
}) {
  const key = `session:${session.id}`;
  const editing = editingId === key;
  const view = reportView(report);
  const reportLocked = !!(reportMeta && (reportMeta.read_only || reportMeta.legacy || ['confirmed', 'rejected'].includes(reportMeta.status)));
  const factRows = mergeConfirmationItems([], Array.isArray(facts) ? facts : []);
  const pendingFacts = factRows.filter((item) => normalizeConfirmationStatus(item.status) === 'pending').length;
  const interviewFormat = sessionInterviewFormat(session);
  return (
    <article className="interview-record-card ai-review-record-card interview-session-only-card">
      <div className="interview-record-head">
        <div>
          <div className="interview-record-title">
            <FileTextOutlined />
            <strong>第 {session.round} 轮{interviewFormat.label}面试</strong>
          </div>
          <Text type="secondary">面试轮次记录 {session.id} · {fmtTime(session.created_at)}</Text>
        </div>
        <Space wrap>
          <Tag color={interviewFormat.color}>{interviewFormat.label}面试</Tag>
          <Tag>{interviewStatusLabel(session.status)}</Tag>
          {reportMeta && <Tag color={reportMeta.status === 'confirmed' ? 'green' : reportMeta.status === 'rejected' ? 'red' : 'blue'}>{interviewStatusLabel(reportMeta.status)}</Tag>}
          {pendingFacts > 0 && <Tag color="gold">{pendingFacts} 项事实待复核</Tag>}
          <Tooltip title={!selectedMaterialIds.length ? '请先勾选至少一份材料' : llmUnavailableReason || '先预览实际发送文本'}>
            <Button
              id={`interview-ai-review-action-${session.id}`}
              size="small"
              icon={<RobotOutlined />}
              disabled={readOnly || !!busyKey || reportLocked || !!reportLoadError || !selectedMaterialIds.length}
              loading={busyKey === `llm-preview:${session.id}`}
              onClick={onPreview}
            >
              生成 AI 草稿（可选）
            </Button>
          </Tooltip>
          <Button
            size="small"
            type={pendingFacts ? 'default' : 'primary'}
            icon={<CheckCircleOutlined />}
              disabled={readOnly || !!busyKey || reportLocked || !!reportLoadError || !report || pendingFacts > 0 || factsDirty || reportMeta?.stale}
            loading={busyKey === `session-confirm:${session.id}`}
            onClick={onConfirm}
          >
            {factsDirty ? '先保存事实' : (pendingFacts ? '先复核事实' : '人工确认报告')}
          </Button>
        </Space>
      </div>
      <ManualInterviewNoteEditor
        session={session}
        readOnly={readOnly}
        busyKey={busyKey}
        onChanged={onManualNoteChanged}
      />
      <SessionMaterialSelector
        session={session}
        selectedIds={selectedMaterialIds}
        readOnly={readOnly || reportLocked || !!reportLoadError}
        onChange={onMaterialsChange}
      />
      {reportMeta?.stale && (
        <Alert
          type="error"
          showIcon
          message="草稿来源已变化，当前不可确认"
          description="面试材料、人工笔记或已确认岗位/简历/测评上下文已变化。请重新生成 AI 草稿，或重新保存人工结构化草稿。历史草稿不会被覆盖。"
        />
      )}
      <StructuredManualReportForm
        session={session}
        selectedMaterialIds={selectedMaterialIds}
        reportMeta={reportMeta}
        readOnly={readOnly || !!reportLoadError}
        busyKey={busyKey}
        onSave={onStructuredSave}
      />
      {reportLoadError && (
        <Alert
          type="error"
          showIcon
          message="面试轮次报告暂不可读，当前记录已锁定"
          description="读取失败不会按“尚无面试轮次报告”处理；请重新读取后再生成、编辑或确认。"
          action={<Button size="small" icon={<ReloadOutlined />} onClick={onRetryReport}>重新读取</Button>}
        />
      )}
      {report ? (
        <section className="interview-ai-review ai-review-phase">
          <div className="interview-section-title">
            <div><strong>面试轮次报告</strong><p>只有人工确认后才能成为正式报告。</p></div>
            <Tag color="blue">{interviewStatusLabel(reportMeta?.status || 'draft')}</Tag>
          </div>
          <section className="interview-ai-summary ai-review-phase-summary">
            <RobotOutlined />
            <div><strong>复盘摘要</strong><Paragraph>{view.summary || '暂无摘要'}</Paragraph></div>
          </section>
          <div className="interview-ai-grid interview-decision-brief ai-review-phase-grid">
            <MiniList title="风险" tone="risk" icon={<WarningOutlined />} items={view.risks} />
            <MiniList title="待确认" tone="unknown" icon={<QuestionCircleOutlined />} items={view.unknowns} />
            <MiniList title="追问问题" tone="question" icon={<QuestionCircleOutlined />} items={view.questions} />
            <MiniList title="匹配点" tone="match" icon={<CheckCircleOutlined />} items={view.matches} />
          </div>
          <ExtendedReviewSections view={view} />
        </section>
      ) : !reportLoadError ? <Alert type="info" showIcon message="尚无面试轮次报告；可填写人工结构化复盘，或选择生成 AI 草稿。" /> : null}
      {report && (
        <FactConfirmations
          record={{ id: session.id }}
          report={report}
          items={factRows}
          strictReview
          readOnly={readOnly || reportLocked || !!reportLoadError}
          busyKey={busyKey}
          onChange={(_, items) => onFactsChange(items)}
          onSave={(_, items) => onFactsSave(items)}
        />
      )}
      <Collapse
        className="interview-json-collapse"
        ghost
        bordered={false}
        items={[{
          key: 'session-report-json',
          classNames: {
            header: 'interview-json-collapse-header',
            body: 'interview-json-collapse-body',
          },
          label: '高级 JSON 导入 / 调试',
          children: editing ? (
            <div className="interview-report-editor">
              <TextArea
                aria-label={`面试轮次记录 ${session.id} 报告 JSON`}
                name={`interview-review-session-report-${session.id}`}
                autoComplete="off"
                spellCheck={false}
                rows={7}
                value={draft}
                disabled={readOnly || reportLocked || !!reportLoadError}
                onChange={(event) => onDraft(event.target.value)}
              />
              <Space>
                <Button type="primary" icon={<SaveOutlined />} disabled={readOnly || reportLocked || !!reportLoadError} loading={busyKey === `session-save:${session.id}`} onClick={onSave}>保存 draft</Button>
                <Button onClick={() => onEdit(null)}>取消</Button>
              </Space>
            </div>
          ) : (
            <Button size="small" disabled={readOnly || reportLocked || !!reportLoadError} onClick={() => onEdit(session, report)}>打开高级 JSON</Button>
          ),
        }]}
      />
      {report && <Alert type="warning" showIcon message="当前仍是 F-008 复核流程" description="请继续处理关键事实和人工确认；AI 生成本身不会把报告变为 confirmed。" />}
    </article>
  );
}

function FactConfirmations({ record, report, items, strictReview = false, readOnly, busyKey, onChange, onSave }) {
  const id = recordId(record);
  const rows = Array.isArray(items) ? items : inferConfirmationItems(report);
  const finished = rows.filter((item) => normalizeConfirmationStatus(item.status) !== 'pending').length;
  const pending = Math.max(rows.length - finished, 0);

  function patchItem(index, patch) {
    const nextRows = rows.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item));
    onChange(record, nextRows);
  }

  return (
    <section className="interview-confirmations">
      <div className="interview-section-title">
        <strong>关键事实确认</strong>
        <em>{finished}/{rows.length}</em>
      </div>
      {pending > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`还有 ${pending} 个关键事实待确认，确认入档前请先处理。`}
        />
      )}
      <div className="confirmation-grid">
        {rows.map((item, index) => {
          const status = normalizeConfirmationStatus(item.status);
          return (
            <div className="confirmation-item" key={item.id || index}>
              <div className="confirmation-item-head">
                <div>
                  <strong>{item.label || item.id || '确认项'}</strong>
                  <Tag color={CONFIRMATION_STATUS_COLORS[status]}>{CONFIRMATION_STATUS_LABELS[status]}</Tag>
                </div>
                <Select
                  aria-label={`${item.label || item.id || '确认项'}（第 ${index + 1} 项）确认状态`}
                  size="small"
                  value={status}
                  options={CONFIRMATION_STATUSES}
                  disabled={readOnly}
                  onChange={(value) => patchItem(index, {
                    status: value,
                    ...(value === 'corrected' ? {} : { corrected_value: '' }),
                  })}
                />
              </div>
              <div className="confirmation-input-row">
                <label>
                  <span>默认值</span>
                  <Input
                    name={`interview-review-confirmation-value-${item.id || index}`}
                    autoComplete="off"
                    size="small"
                    value={item.value || ''}
                    disabled={readOnly || strictReview}
                    placeholder="待识别"
                    onChange={(event) => patchItem(index, { value: event.target.value })}
                  />
                </label>
                <label>
                  <span>修正值</span>
                  <Input
                    name={`interview-review-confirmation-correction-${item.id || index}`}
                    autoComplete="off"
                    size="small"
                    value={item.corrected_value || ''}
                    disabled={readOnly}
                    placeholder="人工修正"
                    onChange={(event) => patchItem(index, {
                      corrected_value: event.target.value,
                      status: has(event.target.value) ? 'corrected' : status,
                    })}
                  />
                </label>
              </div>
              <label className="confirmation-note">
                <span>备注</span>
                <TextArea
                  name={`interview-review-confirmation-note-${item.id || index}`}
                  autoComplete="off"
                  autoSize={{ minRows: 1, maxRows: 3 }}
                  value={item.note || ''}
                  disabled={readOnly || strictReview}
                  placeholder="备注"
                  onChange={(event) => patchItem(index, { note: event.target.value })}
                />
              </label>
              <div className="confirmation-evidence">
                {has(item.evidence) ? item.evidence : 'AI 报告未识别'}
              </div>
            </div>
          );
        })}
      </div>
      <div className="confirmation-actions">
        <Button
          type="primary"
          size="small"
          icon={<SaveOutlined />}
          disabled={readOnly || !id}
          loading={busyKey === `confirmations:${id}`}
          onClick={() => onSave(record, rows)}
        >
          保存确认项
        </Button>
      </div>
    </section>
  );
}

function runConsentWriteOnce(writeRef, write) {
  if (writeRef.current) return writeRef.current;
  const promise = Promise.resolve().then(write);
  writeRef.current = promise;
  return promise.finally(() => {
    if (writeRef.current === promise) writeRef.current = null;
  });
}

function runOptionalActionOnce(lockRef, action) {
  if (lockRef.current || typeof action !== 'function') return Promise.resolve(false);
  const token = {};
  const promise = Promise.resolve()
    .then(action)
    .then((result) => result !== false)
    .finally(() => {
      if (lockRef.current?.token === token) lockRef.current = null;
    });
  lockRef.current = { token, promise };
  return promise;
}

function restoreConsentTrigger(trigger) {
  if (trigger && trigger.isConnected && typeof trigger.focus === 'function') {
    trigger.focus({ preventScroll: true });
  }
}

function CandidateInterviewLauncher({
  candidate,
  jobId,
  sessions,
  readOnly,
  readOnlyReason,
  consentRefreshToken,
  onCompleted,
  onViewLatestReview,
  onJobChange,
  onOpenSettings,
}) {
  const { modal } = AntApp.useApp();
  const candidateId = candidate && candidate.internal_id;
  const candidateName = (candidate && candidate.name) || candidateId || '候选人';
  const [doctor, setDoctor] = useState(null);
  const [job, setJob] = useState({ status: 'idle' });
  const [duration, setDuration] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [consentChecked, setConsentChecked] = useState(false);
  const [consentAt, setConsentAt] = useState('');
  const [consentRevocationPending, setConsentRevocationPending] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentPolicy, setConsentPolicy] = useState(null);
  const [busyAction, setBusyAction] = useState('');
  const [abortBusy, setAbortBusy] = useState(false);
  const [error, setError] = useState('');
  const [doctorError, setDoctorError] = useState('');
  const [progressError, setProgressError] = useState('');
  const [progressKnown, setProgressKnown] = useState(false);
  const [consentLoadError, setConsentLoadError] = useState('');
  const [consentKnown, setConsentKnown] = useState(false);
  const [completedJobId, setCompletedJobId] = useState('');
  const [viewLatestReviewBusy, setViewLatestReviewBusy] = useState(false);
  const consentWriteRef = useRef(null);
  const consentRevocationRequestIdRef = useRef('');
  const consentConfirmOpenRef = useRef(false);
  const consentLoadSequenceRef = useRef(0);
  const micCheckJobIdRef = useRef('');
  const viewLatestReviewLockRef = useRef(false);

  const refreshDoctor = useCallback(async () => {
    try {
      const data = await api.localInterviewDoctor();
      setDoctor(data.doctor || null);
      setDoctorError('');
    } catch (err) {
      setDoctorError(err.message || '本机录音能力检查失败');
    }
  }, []);

  useEffect(() => {
    micCheckJobIdRef.current = '';
    consentRevocationRequestIdRef.current = '';
  }, [candidateId, jobId]);

  const recordingSessions = orderedCandidateSessions(Array.isArray(sessions) ? sessions : [])
    .filter((session) => sessionInterviewFormat(session).value === 'offline')
    .filter((session) => ['draft', 'scheduled', 'in_progress', 'pending_review'].includes(session.status));
  const selectedRecordingSession = recordingSessions.find((session) => String(session.id) === String(selectedSessionId))
    || recordingSessions[0]
    || null;
  const round = selectedRecordingSession ? String(selectedRecordingSession.round) : '';

  useEffect(() => {
    setSelectedSessionId((current) => (
      recordingSessions.some((session) => String(session.id) === String(current))
        ? current
        : String(recordingSessions[0]?.id || '')
    ));
  }, [candidateId, jobId, recordingSessions.map((session) => `${session.id}:${session.status}`).join('|')]);

  async function refreshDoctorForUser() {
    micCheckJobIdRef.current = '';
    return refreshDoctor();
  }

  const refreshProgress = useCallback(async () => {
    try {
      const data = await api.localInterviewProgress();
      const nextJob = data.job || { status: 'idle' };
      setJob(nextJob);
      setProgressKnown(true);
      setProgressError('');
      if (onJobChange) onJobChange(nextJob);
      const currentTaskDone = nextJob.status === 'done'
        && nextJob.id
        && nextJob.id !== completedJobId
        && nextJob.bind_candidate_id === candidateId;
      if (currentTaskDone) {
        setCompletedJobId(nextJob.id);
        if (typeof onCompleted === 'function') onCompleted();
      }
    } catch (err) {
      setProgressError(err.message || '录音任务状态读取失败');
    }
  }, [candidateId, completedJobId, onCompleted, onJobChange]);

  useEffect(() => {
    if (READONLY_UI) {
      setDoctor(null);
      setDoctorError('');
      setJob({
        status: 'disabled_in_operational_readonly',
        message: '操作只读模式不启动依赖检查，也不读取或恢复运行中任务。',
      });
      setProgressKnown(true);
      setProgressError('');
      return undefined;
    }
    refreshDoctor();
    refreshProgress();
    return undefined;
  }, [refreshDoctor, refreshProgress]);

  useEffect(() => {
    if (READONLY_UI) return undefined;
    const recordingProgressActive = job.status === 'starting'
      || job.status === 'running'
      || job.cleanup_pending === true
      || job.binding_pending === true
      || job.termination_unconfirmed === true
      || job.persistent_state_failed === true;
    const timer = setInterval(refreshProgress, recordingProgressActive ? 450 : 2500);
    return () => clearInterval(timer);
  }, [job.binding_pending, job.cleanup_pending, job.mode, job.persistent_state_failed, job.status, job.termination_unconfirmed, refreshProgress]);

  const refreshConsent = useCallback(async ({ reset = true } = {}) => {
    const sequence = consentLoadSequenceRef.current + 1;
    consentLoadSequenceRef.current = sequence;
    if (reset) {
      setConsentChecked(false);
      setConsentAt('');
      setConsentRevocationPending(false);
    }
    setConsentKnown(false);
    setConsentLoadError('');
    if (!candidateId || !jobId) return false;
    try {
      const { consent, policy } = await api.getInterviewConsent(candidateId, jobId);
      if (consentLoadSequenceRef.current !== sequence) return false;
      setConsentChecked(!!(consent && consent.valid));
      setConsentAt(consent && consent.valid ? consent.consented_at : '');
      setConsentRevocationPending(!!(consent && consent.revocation_pending));
      setConsentPolicy(policy || null);
      setConsentKnown(true);
      setConsentLoadError('');
      return true;
    } catch (err) {
      if (consentLoadSequenceRef.current === sequence) {
        setConsentKnown(false);
        setConsentLoadError(err.message || '录音授权历史读取失败');
      }
      return false;
    }
  }, [candidateId, jobId]);

  useEffect(() => {
    refreshConsent();
    return () => {
      consentLoadSequenceRef.current += 1;
    };
  }, [consentRefreshToken, refreshConsent]);

  useEffect(() => {
    if (!consentChecked || !consentAt) return undefined;
    const consentedAt = Date.parse(consentAt);
    const maxAgeHours = Number(consentPolicy?.max_age_hours || 24);
    if (!Number.isFinite(consentedAt) || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0) return undefined;
    const remaining = consentedAt + maxAgeHours * 60 * 60 * 1000 - Date.now();
    if (remaining <= 0) {
      refreshConsent({ reset: false });
      return undefined;
    }
    const timer = globalThis.setTimeout(
      () => refreshConsent({ reset: false }),
      Math.min(remaining + 250, 2_147_000_000),
    );
    return () => globalThis.clearTimeout(timer);
  }, [consentAt, consentChecked, consentPolicy?.max_age_hours, refreshConsent]);

  /*
   * Authorization reads above are intentionally refreshable: lifecycle
   * withdrawal can revoke consent while the candidate page stays mounted.
   */
  useEffect(() => {
    if (candidateId && jobId) return undefined;
    setConsentChecked(false);
    setConsentAt('');
    setConsentRevocationPending(false);
    setConsentKnown(false);
    setConsentLoadError('');
    return undefined;
  }, [candidateId, jobId]);

  async function runLocalAction(actionKey, action) {
    setBusyAction(actionKey);
    setError('');
    try {
      await action();
      await refreshProgress();
    } catch (err) {
      if (err.code === 'interview_consent_required'
          || err.code === 'INTERVIEW_CONSENT_REVOCATION_PENDING') {
        setConsentChecked(false);
        setConsentAt('');
        setConsentKnown(false);
        await refreshConsent({ reset: false });
      }
      if (err.code === 'INTERVIEW_RECORDING_STOP_FAILED' && err.data && err.data.job) {
        setJob(err.data.job);
        setProgressKnown(true);
        if (onJobChange) onJobChange(err.data.job);
        try { await refreshProgress(); } catch {}
      }
      setError(err.message);
    } finally {
      setTimeout(() => setBusyAction(''), 500);
    }
  }

  async function abortCurrentTask() {
    if (abortBusy || !job?.id) return;
    setAbortBusy(true);
    setError('');
    try {
      const response = await api.abortLocalInterviewTask(job.id, job.bind_job_id);
      if (response?.job) {
        setJob(response.job);
        setProgressKnown(true);
        if (onJobChange) onJobChange(response.job);
      }
      await refreshProgress();
    } catch (err) {
      if (err?.data?.job) {
        setJob(err.data.job);
        setProgressKnown(true);
        if (onJobChange) onJobChange(err.data.job);
      }
      setError(err.message || '本地任务停止未确认');
    } finally {
      setAbortBusy(false);
    }
  }

  function discardPreservedRecording() {
    if (abortBusy
        || !job?.id
        || (job.transcription_retryable !== true && job.mode !== 'retry-transcription')) return;
    modal.confirm({
      title: '确认丢弃这条保留录音？',
      content: (
        <Space direction="vertical" size={4}>
          <Text>系统会永久删除这条尚未归档的原录音及失败转写材料。</Text>
          <Text type="danger">删除后不能再重试转写；此操作只用于候选人撤回授权、面试已关闭或 HR 明确决定不再保留材料。</Text>
        </Space>
      ),
      okText: '确认永久丢弃',
      cancelText: '保留原录音',
      okButtonProps: { danger: true },
      maskClosable: false,
      onOk: abortCurrentTask,
    });
  }

  async function startCandidateMicCheck() {
    const candidateRound = Number(round);
    if (!Number.isInteger(candidateRound) || candidateRound <= 0) {
      throw new Error('麦克风预检必须绑定当前面试的正整数轮次。');
    }
    const result = await api.localInterviewMicCheck(
      'HRBOSS-mic-check',
      8,
      candidateId,
      jobId,
      true,
      candidateRound,
    );
    const startedJobId = String(result?.job?.id || '');
    if (!startedJobId) throw new Error('麦克风测试未返回可核对的任务编号，请重新开始测试。');
    micCheckJobIdRef.current = startedJobId;
    return result;
  }

  async function createRecordingSession() {
    const response = await api.createInterviewSession({
      candidateId,
      jobId,
      interviewFormat: 'offline',
    });
    if (response?.session?.id) setSelectedSessionId(String(response.session.id));
    if (typeof onCompleted === 'function') await onCompleted();
    return response;
  }

  async function persistConsentChange(checked) {
    if (checked && consentRevocationPending) {
      setError('授权撤回仍待完成，不能重新授权；请先重试完成撤回。');
      return;
    }
    const previousChecked = consentChecked;
    const previousAt = consentAt;
    const previousRevocationPending = consentRevocationPending;
    setConsentBusy(true);
    setError('');
    if (!checked && !consentRevocationRequestIdRef.current) {
      consentRevocationRequestIdRef.current = uiRequestId(
        'consent-revoke',
        `${candidateId}-${jobId}`,
      );
    }
    const requestId = checked ? '' : consentRevocationRequestIdRef.current;
    try {
      const { consent, policy, recording_stop_requested: recordingStopRequested } = await api.saveInterviewConsent(
        candidateId,
        jobId,
        checked,
        requestId,
      );
      setConsentChecked(!!(consent && consent.valid));
      setConsentAt(consent && consent.valid ? consent.consented_at : '');
      setConsentRevocationPending(!!(consent && consent.revocation_pending));
      setConsentPolicy(policy || consentPolicy);
      if (!checked) consentRevocationRequestIdRef.current = '';
      if (recordingStopRequested) {
        await refreshProgress();
      }
    } catch (err) {
      if (err.code === 'INTERVIEW_RECORDING_STOP_FAILED') {
        if (err.data && err.data.revoke_failed) {
          setConsentKnown(false);
          await refreshConsent({ reset: false });
          try { await refreshProgress(); } catch {}
          setError(err.message || '录音停止与授权撤回记录均未确认；请勿继续面试或开始新录音。');
          return;
        }
        if (!err.data?.revoke_failed) consentRevocationRequestIdRef.current = '';
        const failedStopConsent = err.data?.consent;
        if (failedStopConsent) {
          setConsentChecked(!!failedStopConsent.valid);
          setConsentAt(failedStopConsent.valid ? failedStopConsent.consented_at : '');
          setConsentRevocationPending(!!failedStopConsent.revocation_pending);
          setConsentKnown(true);
        } else {
          setConsentKnown(false);
          await refreshConsent({ reset: false });
        }
        setConsentPolicy((err.data && err.data.policy) || consentPolicy);
        try { await refreshProgress(); } catch {}
        setError(err.message || '候选人授权已撤回，但录音停止失败；请勿继续面试或开始新录音。');
        return;
      }
      const refreshed = await refreshConsent({ reset: false });
      if (!refreshed) {
        setConsentChecked(previousChecked);
        setConsentAt(previousAt);
        setConsentRevocationPending(previousRevocationPending);
      }
      setError(`授权状态未确认：${err.message}`);
    } finally {
      setConsentBusy(false);
    }
  }

  function handleConsentChange(event) {
    const checked = !!event.target.checked;
    if (consentRevocationPending) {
      setError('授权撤回仍待完成，不能重新授权；请使用“重试完成撤回”。');
      return undefined;
    }
    const closedJob = readOnlyReason === 'closed-job';
    const closedWithdrawalAllowed = closedJob && !checked && consentChecked;
    if (READONLY_UI || (readOnly && !closedWithdrawalAllowed)) {
      setError(closedJob
        ? '岗位已关闭，不能重新授权；仅可撤回当前仍有效的授权。'
        : '当前写入权限未确认，不能修改录音授权。');
      return undefined;
    }
    const withdrawingDuringRecording = !checked
      && taskActive
      && isCurrentCandidateTask
      && ['record', 'mic-check', 'from-file'].includes(job.mode);
    if (!withdrawingDuringRecording) {
      return runConsentWriteOnce(consentWriteRef, () => persistConsentChange(checked));
    }
    if (consentConfirmOpenRef.current || consentWriteRef.current) return undefined;

    const trigger = event.currentTarget || event.target;
    let restoreAfterClose = true;
    consentConfirmOpenRef.current = true;
    modal.confirm({
      title: '撤回授权会立即对当前录音、预检或材料处理发起安全停止，仍要继续吗？',
      content: (
        <Space direction="vertical" size={4}>
          <Text>候选人：{candidateName}</Text>
          <Text>岗位：{jobId || '--'}</Text>
          <Text type="danger">确认撤回后，系统会对当前录音、麦克风预检或材料处理立即发起安全停止；确认进程结束后删除临时音频与转写材料，且不会生成本次复盘。</Text>
        </Space>
      ),
      okText: '撤回并中止当前任务',
      cancelText: '保留授权并继续录音',
      okButtonProps: { danger: true },
      maskClosable: false,
      keyboard: true,
      onOk: async () => {
        await runConsentWriteOnce(consentWriteRef, () => persistConsentChange(false));
        restoreAfterClose = false;
      },
      afterClose: () => {
        consentConfirmOpenRef.current = false;
        if (restoreAfterClose) restoreConsentTrigger(trigger);
      },
    });
    return undefined;
  }

  async function openCompletedInterviewReview() {
    if (viewLatestReviewLockRef.current || typeof onViewLatestReview !== 'function') return false;
    setViewLatestReviewBusy(true);
    setError('');
    try {
      return await runOptionalActionOnce(
        viewLatestReviewLockRef,
        () => onViewLatestReview({
          recording: boundRecording,
          recordingId: boundRecording?.id,
          sessionId: boundRecording?.session_id || boundRecording?.session_consent_link?.session_id,
        }),
      );
    } catch (reviewError) {
      setError(`最新复盘打开失败：${reviewError?.message || '请稍后重试'}`);
      return false;
    } finally {
      setViewLatestReviewBusy(false);
    }
  }

  const ready = localInterviewMicCheckReady(doctor);
  const transcriptionReady = localInterviewTranscriptionReady(doctor);
  const degraded = doctor?.status === 'degraded' || doctor?.degraded === true;
  const closedJob = readOnlyReason === 'closed-job';
  const safetyActionsLocked = READONLY_UI || (readOnly && !closedJob);
  const starting = job && job.status === 'starting';
  const running = job && job.status === 'running';
  const taskActive = starting || running;
  const transcriptionRetryable = job?.transcription_retryable === true;
  const terminationUiState = localInterviewTerminationUiState(job);
  const terminationPending = terminationUiState.pending;
  const taskBusy = taskActive || terminationPending || transcriptionRetryable;
  const recordingFinalizationUiState = localInterviewRecordingFinalizationUiState(job);
  const stopping = isRecordingFinalizing(job);
  const discarding = recordingFinalizationUiState.discarding;
  const isCurrentCandidateTask = !!(job
    && job.bind_candidate_id === candidateId
    && String(job.bind_job_id ?? '') === String(jobId ?? ''));
  const currentTaskActive = taskActive && isCurrentCandidateTask;
  const otherTaskRunning = taskBusy && !isCurrentCandidateTask;
  const currentRecordingRunning = running && job.mode === 'record' && isCurrentCandidateTask;
  const isCurrentMicCheckRun = isCurrentCandidateTask
    && job.mode === 'mic-check'
    && String(job.id || '') === micCheckJobIdRef.current;
  const currentMicCheckRunning = running && isCurrentMicCheckRun;
  const micCheck = job.status === 'done' && isCurrentMicCheckRun && job.result && job.result.micCheck
    ? job.result.micCheck
    : null;
  const micCheckPassed = !!micCheck && (micCheck.level == null ? micCheck.passed === true : micCheck.level === 'pass');
  const environmentNeedsAttention = !!doctorError || degraded || (!!doctor && !ready);
  const showIdleActions = progressKnown
    && !progressError
    && !taskBusy
    && ready
    && !environmentNeedsAttention
    && !readOnly;
  const showAbortAction = currentTaskActive
    && !safetyActionsLocked
    && (
      starting
      || job.mode === 'mic-check'
      || job.mode === 'from-file'
      || job.mode === 'retry-transcription'
      || (job.mode === 'record' && closedJob)
    );
  const showStopAction = currentRecordingRunning && !readOnly;
  const showEnvironmentAction = !taskBusy && environmentNeedsAttention;
  const doctorStatusText = doctorError
    ? '工具状态未知'
    : doctor
    ? (ready ? '录音与转写工具已就绪' : '录音与转写工具未就绪')
    : '正在检查录音工具';
  const microphoneStatusText = currentMicCheckRunning
    ? '正在测试'
    : micCheck
    ? (micCheckPassed ? '最近预检通过' : (micCheck.level === 'fail' ? '预检未通过' : '建议复检'))
    // Product decision: an untested microphone never blocks recording; the
    // status copy only suggests running the pre-check first.
    : '未测试，建议先预检';
  const taskStatusText = !progressKnown
    ? (progressError ? '录音状态未知' : '正在读取录音状态')
    : starting && isCurrentCandidateTask
    ? (job.mode === 'mic-check'
      ? '正在建立麦克风预检'
      : (job.mode === 'from-file'
        ? '正在建立本地材料处理'
        : (job.mode === 'retry-transcription' ? '正在建立转写重试' : '正在建立安全录音')))
    : terminationPending && isCurrentCandidateTask
    ? terminationUiState.label
    : stopping && isCurrentCandidateTask
    ? '正在生成转写'
    : currentRecordingRunning
    ? '正在录音'
    : currentMicCheckRunning
    ? '正在测试麦克风'
    : otherTaskRunning
    ? (job.mode === 'from-file' ? '其他本地材料正在处理' : '其他本地面试任务正在运行')
    : running
    ? (job.mode === 'retry-transcription' ? '正在重试转写' : '正在处理录音材料')
    : job.status === 'done'
    ? '最近一次已完成'
    : job.status === 'error'
    ? '最近一次未完成'
    : job.status === 'cancelled'
    ? '最近一次已停止'
    // Do not claim readiness the start control does not grant. Consent gates
    // the button (see its disabled expression), so saying 可以开始录音 while
    // consent is missing states the opposite of what the UI will allow.
    // Only consent is checked here: micCheck is non-null only while
    // job.status === 'done', which the branch above already claims, so a
    // mic-failure branch at this position would be unreachable. The failed
    // pre-check surfaces in its own result panel instead.
    : !consentChecked
    ? '需先取得候选人材料处理同意'
    : '可以开始录音';
  const taskStatusDimension = !taskBusy && ['done', 'error', 'cancelled'].includes(job.status)
    ? '最近任务'
    : '当前任务';
  const durationValue = duration.trim() ? Number(duration.trim()) : null;
  const durationValidationError = recordingDurationError(duration);
  const topic = `${candidateName}-面试-${jobId || 'job'}`;
  const boundRecording = job && job.result && job.result.autoBoundRecording;
  const bindError = job && job.result && job.result.autoBindError;
  const micFailed = micCheck && micCheck.level === 'fail';
  const resultAudioStats = job && job.result && job.result.audioStats;
  const resultAudioQuality = job && job.result && job.result.audioQuality;
  const progressPercent = job.planned_duration_seconds
    ? Math.min(100, Math.round((Number(job.elapsed_seconds || 0) / Number(job.planned_duration_seconds)) * 100))
    : 0;

  return (
    <section className="candidate-interview-launcher" id="candidate-interview-launcher" tabIndex={-1}>
      <div className="interview-section-title">
        <div>
          <strong>面试录音</strong>
          <p>录音结束后，系统会生成转写并归档到当前候选人。</p>
        </div>
        <Space wrap aria-label="录音状态">
          <Tag
            color={doctorError ? 'red' : ready ? 'green' : 'default'}
            aria-label={`工具状态：${doctorStatusText}`}
          >
            工具：{doctorStatusText}
          </Tag>
          <Tag
            color={currentMicCheckRunning ? 'blue' : (micCheckPassed ? 'green' : micCheck ? 'gold' : 'default')}
            aria-label={`麦克风状态：${microphoneStatusText}`}
          >
            麦克风：{microphoneStatusText}
          </Tag>
          <Tag
            color={progressError && !progressKnown ? 'red' : localJobStatusColor(job.status)}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={`${taskStatusDimension}状态：${taskStatusText}`}
          >
            {taskStatusDimension}：{taskStatusText}
          </Tag>
        </Space>
      </div>

      {READONLY_UI
        ? <Alert type="warning" showIcon message="当前为只读模式，可查看授权与历史记录，无法开始或继续录音。" />
        : closedJob
          ? <Alert type="warning" showIcon message="岗位已关闭，不能重新授权或开始录音；仍可撤回现有授权，并对当前匹配任务发起停止与清理。" />
          : readOnly && <Alert type="warning" showIcon message="当前候选人写入权限未确认；授权、录音与安全停止入口保持锁定，请先刷新候选人数据。" />}
      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
      {degraded && <Alert type="warning" showIcon message="本地录音或转写工具当前不可用" description={doctor?.message || '请检查本机录音与转写软件。'} action={onOpenSettings ? <Button size="small" onClick={onOpenSettings}>查看设置</Button> : null} />}
      {doctorError && <Alert type="warning" showIcon message="无法确认本地录音与转写工具状态" description="请重新检查软件依赖；真实麦克风状态以主动预检为准。" />}
      {progressError && <Alert type="warning" showIcon message={progressKnown ? '录音状态更新失败，正在显示上次结果' : '暂时无法读取录音状态'} description={progressError} />}
      {consentLoadError && <Alert type="warning" showIcon message="暂时无法读取录音授权记录" description={consentLoadError} />}
      {consentRevocationPending && (
        <Alert
          type="error"
          showIcon
          message="录音授权撤回仍待完成"
          description="系统已锁定该候选人与岗位的旧授权；不能重新授权、开始录音或执行候选人麦克风预检。请重试完成撤回。"
          action={(
            <Button
              danger
              size="small"
              loading={consentBusy}
              disabled={safetyActionsLocked || consentBusy || !consentKnown}
              onClick={() => runConsentWriteOnce(consentWriteRef, () => persistConsentChange(false))}
            >
              重试完成撤回
            </Button>
          )}
        />
      )}
      {otherTaskRunning && <Alert type="warning" showIcon message="另一项本地面试或材料任务正在建立、运行或清理；本页不会停止不匹配的任务。" />}
      {terminationPending && isCurrentCandidateTask && (
        <Alert
          type={terminationUiState.blocking ? 'error' : 'info'}
          showIcon
          message={terminationUiState.label}
          description={job.message || '授权已撤回；正在确认录音进程停止并清理未完成材料。'}
        />
      )}
      {!terminationPending
        && job.message
        && isCurrentCandidateTask
        && job.status === 'error'
        && !transcriptionRetryable
        && <Alert type="error" showIcon message={job.message} />}
      {transcriptionRetryable && isCurrentCandidateTask && (
        <Alert
          type="error"
          showIcon
          message="转写失败，原录音已安全保留"
          description={job.message || '系统未写入面试归档。请检查本机转写环境后手动重试；不会自动触网、自动重试或切换外部 ASR。'}
          action={(
            <Space wrap>
              <Button
                type="primary"
                size="small"
                loading={busyAction === 'retry'}
                disabled={READONLY_UI || readOnly || !!busyAction || abortBusy || !transcriptionReady || !!doctorError}
                onClick={() => runLocalAction('retry', () => api.retryLocalInterviewTranscription(
                  job.id,
                  job.bind_candidate_id,
                  job.bind_job_id,
                  job.bind_round,
                ))}
              >
                重试转写
              </Button>
              <Button
                danger
                size="small"
                loading={abortBusy}
                disabled={READONLY_UI || safetyActionsLocked || !!busyAction || abortBusy}
                onClick={discardPreservedRecording}
              >
                永久丢弃原录音
              </Button>
            </Space>
          )}
        />
      )}
      {micCheck && (
        <Alert
          type={localMicCheckAlertType(micCheck.level)}
          showIcon
          message={micCheck.message || '麦克风预检完成'}
          description={(
            <div className="candidate-mic-check-result">
              <p>{micCheck.recommendation || '可根据识别结果决定是否开始正式面试。'}</p>
              <p>临时音频、转写与分析文件已删除；界面仅保留本次会话内的通过状态。</p>
            </div>
          )}
        />
      )}
      {boundRecording && isCurrentCandidateTask && (
        <Alert
          type="success"
          showIcon
          message="录音与转写已归档到当前候选人"
          action={(
            <Space wrap>
              <Button
                size="small"
                type="primary"
                disabled={typeof onViewLatestReview !== 'function' || viewLatestReviewBusy}
                loading={viewLatestReviewBusy}
                onClick={openCompletedInterviewReview}
              >
                查看最新复盘
              </Button>
              {job.result && job.result.summaryPath && (
                <Button
                  size="small"
                  onClick={() => navigator.clipboard && navigator.clipboard.writeText(job.result.summaryPath)}
                >
                  复制材料位置
                </Button>
              )}
            </Space>
          )}
        />
      )}
      {bindError && isCurrentCandidateTask && <Alert type="warning" showIcon message={`录音材料归档失败：${bindError}`} />}

      <div className={`interview-consent-gate ${consentChecked && !consentRevocationPending ? 'ready' : ''}`}>
        <Checkbox
          name="interview-review-recording-consent"
          checked={consentChecked}
          disabled={
            READONLY_UI
            || consentBusy
            || consentRevocationPending
            || terminationPending
            || !consentKnown
            || !candidateId
            || !jobId
            || (readOnly && !(closedJob && consentChecked))
          }
          onChange={handleConsentChange}
        >
          {consentPolicy?.display_text || '已告知候选人本次面试将进行本地录音、转写并用于 AI 复盘和招聘记录；候选人已同意。'}
        </Checkbox>
        <Text className="interview-consent-note" type="secondary">
          {!consentKnown
            ? (consentLoadError ? '授权记录读取失败，暂时无法确认之前是否已授权。' : '正在读取候选人的录音授权记录。')
            : consentRevocationPending
            ? '授权撤回待完成；旧授权已锁定且不可重新使用，请重试完成撤回。'
            : consentChecked && consentAt
            ? `授权已记录：${fmtTime(consentAt)}（${consentPolicy?.max_age_hours || 24} 小时内有效；录音中撤回会立即发起安全停止）`
            : '请先确认候选人同意。录音中撤回授权会发起安全停止，并在确认进程结束后删除未完成材料。'}
        </Text>
      </div>

      <div className="candidate-interview-controls">
        <label>
          <span>面试轮次</span>
          <Select
            aria-label="选择已创建的面试轮次"
            value={selectedRecordingSession ? String(selectedRecordingSession.id) : undefined}
            disabled={readOnly || taskBusy}
            placeholder="先创建面试轮次"
            options={recordingSessions.map((session) => ({
              value: String(session.id),
              label: `第 ${session.round} 轮 · ${interviewStatusLabel(session.status)} · 记录 ${session.id}`,
            }))}
            onChange={setSelectedSessionId}
            style={{ width: '100%' }}
          />
          <small className="candidate-interview-field-hint">录音只绑定到已创建的线下面试轮次，不允许手填自由轮次。</small>
          {!taskBusy && (
            <Button
              size="small"
              disabled={readOnly || !!busyAction || !candidateId || !jobId}
              loading={busyAction === 'create-session'}
              onClick={() => runLocalAction('create-session', createRecordingSession)}
              style={{ marginTop: 6 }}
            >
              {(Array.isArray(sessions) && sessions.length) ? '创建下一轮 Session' : '创建首轮 Session'}
            </Button>
          )}
        </label>
        <label>
          <span>最长录音时长（秒）</span>
          <Input
            name="interview-review-duration-seconds"
            autoComplete="off"
            type="number"
            inputMode="numeric"
            min={MIN_RECORDING_DURATION_SECONDS}
            max={MAX_RECORDING_DURATION_SECONDS}
            step={1}
            placeholder="留空为手动停止"
            value={duration}
            disabled={readOnly || taskBusy}
            status={durationValidationError ? 'error' : undefined}
            aria-invalid={durationValidationError ? 'true' : 'false'}
            aria-describedby="interview-recording-duration-hint"
            onChange={(event) => setDuration(event.target.value)}
          />
          <small
            id="interview-recording-duration-hint"
            className={durationValidationError ? 'candidate-interview-field-error' : 'candidate-interview-field-hint'}
            role={durationValidationError ? 'alert' : undefined}
          >
            {durationValidationError || `${MIN_RECORDING_DURATION_SECONDS}–${MAX_RECORDING_DURATION_SECONDS} 秒；留空则手动停止。`}
          </small>
        </label>
        {(showIdleActions || showStopAction || showAbortAction || showEnvironmentAction) && (
          <Space wrap className="candidate-interview-actions">
            {showIdleActions && (
              <Button
                disabled={readOnly || !!busyAction || consentRevocationPending || !candidateId || !jobId || !consentChecked || !selectedRecordingSession}
                loading={busyAction === 'mic-check'}
                onClick={() => runLocalAction('mic-check', startCandidateMicCheck)}
              >
                测试麦克风
              </Button>
            )}
            {showIdleActions && (
              <Button
                type="primary"
                icon={<AudioOutlined />}
                disabled={readOnly || !!busyAction || consentRevocationPending || micFailed || !candidateId || !jobId || !consentChecked || !!durationValidationError || !selectedRecordingSession}
                loading={busyAction === 'start'}
                onClick={() => runLocalAction('start', () => api.startLocalInterviewRecord(topic, durationValue, candidateId, jobId, Number(round)))}
              >
                开始录音
              </Button>
            )}
            {showStopAction && (
              <Button
                danger
                icon={<StopOutlined />}
                loading={busyAction === 'stop' || stopping}
                disabled={readOnly || !!busyAction || stopping}
                onClick={() => runLocalAction('stop', () => api.stopLocalInterviewRecord(
                  job.id,
                  job.bind_candidate_id,
                  job.bind_job_id,
                  job.bind_round,
                ))}
              >
                {discarding
                  ? recordingFinalizationUiState.buttonLabel
                  : (busyAction === 'stop' ? '正在生成转写…' : recordingFinalizationUiState.buttonLabel)}
              </Button>
            )}
            {showAbortAction && (
              <Button
                danger
                icon={<StopOutlined />}
                loading={abortBusy || terminationPending}
                disabled={abortBusy || terminationPending}
                onClick={job.mode === 'retry-transcription' ? discardPreservedRecording : abortCurrentTask}
              >
                {terminationPending
                  ? '正在停止并清理…'
                  : (starting
                    ? '取消启动并清理'
                    : (job.mode === 'mic-check'
                      ? '取消预检并清理'
                      : (job.mode === 'from-file'
                        ? '取消处理并清理'
                        : (job.mode === 'retry-transcription'
                          ? '停止重试并永久丢弃原录音'
                          : '停止并清理（不生成复盘）'))))}
              </Button>
            )}
            {showEnvironmentAction && (
              <Button
                loading={busyAction === 'environment'}
                disabled={READONLY_UI || readOnly || !!busyAction}
                onClick={() => runLocalAction('environment', refreshDoctorForUser)}
              >
                {doctor ? '重新检查录音环境' : '检查录音环境'}
              </Button>
            )}
          </Space>
        )}
      </div>

      {currentRecordingRunning && (
        <LiveRecordingWaveform
          key={job.id || 'current-recording'}
          liveAudio={job.live_audio}
          stopping={stopping}
          discarding={discarding}
        />
      )}

      {currentRecordingRunning && (
        <div className="recording-duration-bar">
          <div>
            <strong>{formatSeconds(job.elapsed_seconds)}</strong>
            <span>{job.planned_duration_seconds ? ` / ${formatSeconds(job.planned_duration_seconds)}` : ' / 手动停止'}</span>
          </div>
          {job.planned_duration_seconds
            ? <progress aria-label="录音计划进度" value={progressPercent} max="100" />
            : <progress aria-label="录音进行中，等待手动停止" />}
        </div>
      )}

      {isCurrentCandidateTask && job.status === 'done' && (
        <AudioQualityPanel stats={resultAudioStats} quality={resultAudioQuality} />
      )}

      {isCurrentCandidateTask && job.result && job.result.summaryPath && (
        <div className="candidate-interview-summary-path">
          <span>材料保存位置</span>
          <code>{job.result.summaryPath}</code>
        </div>
      )}
    </section>
  );
}

function RecordingCard({
  record,
  sessionId,
  domId,
  report,
  reportMeta,
  reportLoadError,
  llmAvailable,
  llmUnavailableReason,
  transcript,
  confirmations,
  confirmationsDirty,
  strictConfirmations,
  confirmationLoadError,
  showEvidence = false,
  readOnly,
  busyKey,
  editingId,
  draft,
  onConfirm,
  onCopy,
  onEdit,
  onDraft,
  onSave,
  onLlmPreview,
  onConfirmationsChange,
  onConfirmationsSave,
  onRetryConfirmations,
  onRetryReport,
}) {
  const id = recordId(record);
  const view = reportView(report);
  const summary = view.summary || pick(record, ['summary', 'transcript_summary', 'transcriptSummary', 'note', 'abstract']);
  const confirmationRows = Array.isArray(confirmations) ? confirmations : inferConfirmationItems(report);
  const confirmationPending = confirmationRows.some((item) => normalizeConfirmationStatus(item.status) === 'pending');
  const audio = audioPayloadFromRecord(record);
  const localDemo = isLocalDemoInterview(record, report);
  const reportLocked = !!(reportMeta && (reportMeta.read_only || reportMeta.legacy));
  const meta = joinParts([
    `ID ${id || '未知'}`,
    interviewSourceLabel(pick(record, ['source', 'origin'])),
    pick(record, ['created_at', 'createdAt', 'recorded_at', 'recordedAt', 'imported_at', 'importedAt']) ? fmtTime(pick(record, ['created_at', 'createdAt', 'recorded_at', 'recordedAt', 'imported_at', 'importedAt'])) : '',
  ]);

  return (
    <article className="interview-record-card ai-review-record-card" id={domId}>
      <div className="interview-record-head">
        <div>
          <div className="interview-record-title">
            <FileTextOutlined />
            <strong>{recordTitle(record)}</strong>
          </div>
          <Text type="secondary">{meta || '暂无元信息'}</Text>
        </div>
        <Space size={6} wrap>
          {localDemo && <Tag color="gold">本地演示样本</Tag>}
          {reportMeta && (
            <Tag color={reportMeta.status === 'confirmed' ? 'green' : reportMeta.status === 'rejected' ? 'red' : 'blue'}>
              {reportMeta.legacy ? '历史报告待复核' : interviewStatusLabel(reportMeta.status)}
            </Tag>
          )}
          <StatusTags record={record} />
          <Tooltip title={!sessionId ? '只有已归属同一面试轮次的材料可用' : llmUnavailableReason || '先查看发送预览，再人工确认'}>
            <Button
              id={`interview-ai-review-action-${sessionId}-${id}`}
              size="small"
              icon={<RobotOutlined />}
              disabled={readOnly || !!busyKey || reportLocked || !!reportLoadError || !id || !sessionId || reportMeta?.status === 'confirmed' || reportMeta?.status === 'rejected'}
              loading={busyKey === `llm-preview:${sessionId}`}
              onClick={() => onLlmPreview(record, sessionId)}
            >
              生成 AI 草稿（可选）
            </Button>
          </Tooltip>
          <Button
            size="small"
            type={confirmationPending ? 'default' : 'primary'}
            icon={<CheckCircleOutlined />}
            disabled={readOnly || !!busyKey || reportLocked || !!reportLoadError || !!confirmationLoadError || !id || isConfirmed(record) || confirmationPending || confirmationsDirty}
            loading={busyKey === `confirm:${id}`}
            onClick={() => onConfirm(record)}
          >
            {confirmationsDirty ? '先保存确认项' : (confirmationPending ? '先确认事实' : '确认记录')}
          </Button>
        </Space>
      </div>

      {reportLoadError && (
        <Alert
          type="error"
          showIcon
          message="面试报告暂不可读，当前记录已锁定"
          description="读取失败不会按“暂无报告”处理；请重新读取后再生成、编辑、保存或确认。"
          action={<Button size="small" icon={<ReloadOutlined />} onClick={onRetryReport}>重新读取</Button>}
        />
      )}

      {(report || !reportLoadError) && <section className="interview-ai-review ai-review-phase">
        {localDemo && (
          <Alert
            type="warning"
            showIcon
            message="本地演示样本，不代表真实 AI 判断"
            description="这是一条固定 fixture 闭环；未执行真实录音、转写或 AI 调用，仅用于验证页面、证据和人工确认流程。"
          />
        )}
        <div className="interview-section-title">
          <div>
            <strong>面试复盘</strong>
            <p>先核对人工事实；AI 草稿只是可选辅助，不会替代 HR 确认。</p>
          </div>
          <Tag className="ai-phase-badge ai-review ai-review-phase-badge">面试后</Tag>
        </div>
        <section className="interview-ai-summary ai-review-phase-summary">
          <RobotOutlined />
          <div>
            <strong>复盘摘要</strong>
            <Paragraph ellipsis={{ rows: 3, expandable: true, symbol: '展开' }}>
              {summary || '暂无摘要'}
            </Paragraph>
          </div>
        </section>

        <div className="interview-ai-grid interview-decision-brief ai-review-phase-grid">
          <MiniList title="风险" tone="risk" icon={<WarningOutlined />} items={view.risks} transcript={transcript} />
          <MiniList title="待确认" tone="unknown" icon={<QuestionCircleOutlined />} items={view.unknowns} transcript={transcript} />
          <MiniList title="追问问题" tone="question" icon={<QuestionCircleOutlined />} items={view.questions} transcript={transcript} />
          <MiniList title="匹配点" tone="match" icon={<CheckCircleOutlined />} items={view.matches} transcript={transcript} />
        </div>
        <ExtendedReviewSections view={view} transcript={transcript} />
      </section>}

      {(report || !reportLoadError) && <TalkTracks items={view.talkTracks} onCopy={onCopy} />}
      <AudioQualityPanel stats={audio.stats} quality={audio.quality} />
      {confirmationLoadError && (
        <Alert
          type="error"
          showIcon
          message="关键事实确认暂不可读，当前记录已锁定"
          description="下面仅展示 AI 推断默认项，不能据此覆盖已有人工修订。请刷新成功后再编辑、保存或确认入档。"
          action={<Button size="small" icon={<ReloadOutlined />} onClick={onRetryConfirmations}>重新读取</Button>}
        />
      )}
      <FactConfirmations
        record={record}
        report={report}
        items={confirmationRows}
        strictReview={strictConfirmations}
        readOnly={readOnly || reportLocked || !!reportLoadError || !!confirmationLoadError}
        busyKey={busyKey}
        onChange={onConfirmationsChange}
        onSave={onConfirmationsSave}
      />
      <ReportEditor
        record={record}
        report={report}
        editingId={editingId}
        draft={draft}
        readOnly={readOnly || reportLocked || !!reportLoadError}
        busyKey={busyKey}
        onEdit={onEdit}
        onDraft={onDraft}
        onSave={onSave}
      />
      {showEvidence && <TranscriptEvidence record={record} transcript={transcript} onCopy={onCopy} />}
    </article>
  );
}

function RecordingEvidenceCard({ record, domId, transcript, transcriptLoadError, onCopy, onRetry }) {
  const id = recordId(record);
  const meta = joinParts([
    `ID ${id || '未知'}`,
    interviewSourceLabel(pick(record, ['source', 'origin'])),
    pick(record, ['created_at', 'createdAt', 'recorded_at', 'recordedAt', 'imported_at', 'importedAt']) ? fmtTime(pick(record, ['created_at', 'createdAt', 'recorded_at', 'recordedAt', 'imported_at', 'importedAt'])) : '',
  ]);
  return (
    <article className="interview-record-card interview-evidence-record" id={domId}>
      <div className="interview-record-head">
        <div>
          <div className="interview-record-title">
            <FileTextOutlined />
            <strong>{recordTitle(record)}</strong>
          </div>
          <Text type="secondary">{meta || '暂无元信息'}</Text>
        </div>
        <StatusTags record={record} />
      </div>
      <TranscriptEvidence
        record={record}
        transcript={transcript}
        loadError={transcriptLoadError}
        onCopy={onCopy}
        onRetry={onRetry}
      />
    </article>
  );
}

function InterviewReviewLoadingState({ label, rows = 6 }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      style={{ minHeight: 280, padding: '18px 0' }}
    >
      <Text type="secondary">{label}；完成前不会把读取失败或未返回内容当作空数据。</Text>
      <div aria-hidden="true" style={{ marginTop: 18 }}>
        <Skeleton
          active
          title={{ width: '34%' }}
          paragraph={{ rows, width: ['96%', '88%', '92%', '82%', '90%', '68%'] }}
        />
      </div>
    </div>
  );
}

function UnmatchedRow({ record, domId, readOnly, busyKey, onBind }) {
  const id = recordId(record);
  const meta = joinParts([
    `ID ${id || '未知'}`,
    pick(record, ['topic', 'source', 'origin']),
    pick(record, ['created_at', 'createdAt', 'recorded_at', 'recordedAt']) ? fmtTime(pick(record, ['created_at', 'createdAt', 'recorded_at', 'recordedAt'])) : '',
  ]);
  const summary = pick(record, ['summary', 'transcript_summary', 'transcriptSummary', 'note']);
  return (
    <div className="interview-unmatched-row" id={domId}>
      <div className="interview-unmatched-main">
        <div className="interview-record-title">
          <FileTextOutlined />
          <strong>{recordTitle(record)}</strong>
          <Tag color="orange">待匹配</Tag>
        </div>
        <Text type="secondary">{meta || '暂无元信息'}</Text>
        {has(summary) && <p>{compactText(summary, 110)}</p>}
      </div>
      <Button
        type="primary"
        size="small"
        icon={<LinkOutlined />}
        disabled={readOnly || !id || !!busyKey}
        loading={busyKey === `bind:${id}`}
        onClick={() => onBind(record)}
      >
        绑定
      </Button>
    </div>
  );
}

function LifecycleManagementCard({
  session,
  readOnly,
  localJob,
  busyKey,
  activeHold,
  lifecycleState,
  statusError,
  lastResult,
  onWithdraw,
  onClose,
  onApplyHold,
  onReleaseHold,
  onPreviewDeletion,
}) {
  const [withdrawReason, setWithdrawReason] = useState('candidate_withdrew');
  const [closeReason, setCloseReason] = useState('hiring_process_closed');
  const [holdReason, setHoldReason] = useState('legal_review');
  const [holdDays, setHoldDays] = useState(30);
  const sessionKey = String(session.id);
  const statusKnown = ['active', 'closed', 'withdrawn'].includes(lifecycleState);
  const terminal = lifecycleState === 'closed' || lifecycleState === 'withdrawn';
  const blocked = readOnly || !!busyKey || !statusKnown;
  const localTaskBlocksClose = !!(
    localJob
    && localJob.bind_candidate_id === session.candidate_id
    && String(localJob.bind_job_id ?? '') === String(session.job_id ?? '')
    && Number(localJob.bind_round) === Number(session.round)
    && (
      ['starting', 'running'].includes(localJob.status)
      || localJob.cleanup_pending === true
      || localJob.binding_pending === true
      || localJob.termination_unconfirmed === true
      || localJob.persistent_state_failed === true
    )
  );
  const stateLabel = lifecycleState === 'active'
    ? '处理中'
    : lifecycleState === 'closed'
      ? '已关闭'
      : lifecycleState === 'withdrawn'
        ? '已撤回'
        : '状态读取中';

  return (
    <details className="interview-lifecycle-advanced" style={{ margin: '10px 0 14px' }}>
      <summary>
          <Space wrap>
            <strong>高级材料管理</strong>
            <Tag>面试轮次记录 {sessionKey}</Tag>
            <Tag color={lifecycleState === 'active' ? 'green' : lifecycleState === 'withdrawn' ? 'orange' : 'default'}>{stateLabel}</Tag>
            {activeHold && <Tag color="red">Legal Hold 生效中</Tag>}
          </Space>
      </summary>
      <div className="interview-lifecycle-advanced-body">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type={statusError ? 'warning' : 'info'}
              showIcon
              message={statusError || '只管理当前面试轮次的材料'}
              description={statusError ? '生命周期状态不可读，所有管理动作已禁用。' : '撤回、关闭和删除会改变材料保留状态；每次危险操作都需要再次确认。'}
            />
            {lastResult && <Text type="secondary">最近操作：{lastResult}</Text>}
            <Space wrap align="end">
              <div>
                <Text type="secondary">撤回原因</Text>
                <Select
                  aria-label={`面试轮次记录 ${sessionKey} 撤回原因`}
                  value={withdrawReason}
                  options={WITHDRAW_REASON_OPTIONS}
                  disabled={blocked || terminal}
                  onChange={setWithdrawReason}
                  style={{ display: 'block', width: 220, marginTop: 4 }}
                />
              </div>
              <Button
                danger
                disabled={blocked || terminal}
                loading={busyKey === `lifecycle-withdraw:${sessionKey}`}
                onClick={() => onWithdraw(session, withdrawReason)}
              >
                撤回并进入清理期
              </Button>
            </Space>
            <Space wrap align="end">
              <div>
                <Text type="secondary">关闭原因</Text>
                <Select
                  aria-label={`面试轮次记录 ${sessionKey} 关闭原因`}
                  value={closeReason}
                  options={CLOSE_REASON_OPTIONS}
                  disabled={blocked || terminal}
                  onChange={setCloseReason}
                  style={{ display: 'block', width: 220, marginTop: 4 }}
                />
              </div>
              <Button
                danger
                disabled={blocked || terminal || localTaskBlocksClose}
                loading={busyKey === `lifecycle-close:${sessionKey}`}
                onClick={() => onClose(session, closeReason)}
              >
                关闭招聘并开始保留期
              </Button>
              {localTaskBlocksClose && <Text type="danger">请先停止并完成当前录音或材料任务的安全清理。</Text>}
            </Space>
            <Space wrap align="end">
              <div>
                <Text type="secondary">保全原因</Text>
                <Select
                  aria-label={`面试轮次记录 ${sessionKey} Legal Hold 原因`}
                  value={holdReason}
                  options={HOLD_REASON_OPTIONS}
                  disabled={blocked || !!activeHold}
                  onChange={setHoldReason}
                  style={{ display: 'block', width: 200, marginTop: 4 }}
                />
              </div>
              <div>
                <Text type="secondary">有效期</Text>
                <Select
                  aria-label={`面试轮次记录 ${sessionKey} Legal Hold 有效期`}
                  value={holdDays}
                  options={HOLD_DURATION_OPTIONS}
                  disabled={blocked || !!activeHold}
                  onChange={setHoldDays}
                  style={{ display: 'block', width: 110, marginTop: 4 }}
                />
              </div>
              <Button
                disabled={blocked || !!activeHold}
                loading={busyKey === `lifecycle-hold:${sessionKey}`}
                onClick={() => onApplyHold(session, holdReason, holdDays)}
              >
                应用 Legal Hold
              </Button>
              <Button
                danger
                disabled={blocked || !activeHold}
                loading={busyKey === `lifecycle-release:${sessionKey}`}
                onClick={() => onReleaseHold(session, activeHold)}
              >
                解除当前 Hold
              </Button>
            </Space>
            <Space wrap>
              <Button
                danger
                disabled={blocked || !!activeHold}
                loading={busyKey === `lifecycle-dry-run:${sessionKey}` || busyKey === `lifecycle-delete:${sessionKey}`}
                onClick={() => onPreviewDeletion(session)}
              >
                检查并删除到期材料
              </Button>
              <Text type="secondary">系统会先生成 dry-run 清单并显示数量，不会直接删除。</Text>
            </Space>
          </Space>
      </div>
    </details>
  );
}

export default function InterviewReviewPanel({
  candidate,
  readOnly,
  readOnlyReason = '',
  onOpenSettings,
  onOpenInterviewSettings,
  onDirtyChange,
  initialTab = 'review',
  navigationRequestKey,
  navigationTarget,
  onBusyChange,
  aiResumeIntent,
  onAiResumeConsumed,
}) {
  const { message, modal } = AntApp.useApp();
  const candidateId = candidate && candidate.internal_id;
  const jobId = candidate && (candidate.job_id || candidate.jobId);
  const assessmentQuestionContextKey = `${String(candidateId || '')}\u0000${String(jobId || '')}`;
  const [records, setRecords] = useState([]);
  const [unmatched, setUnmatched] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [sessionReports, setSessionReports] = useState({});
  const [sessionReportMeta, setSessionReportMeta] = useState({});
  const [sessionReportLoadErrors, setSessionReportLoadErrors] = useState({});
  const [sessionFacts, setSessionFacts] = useState({});
  const [sessionFactsBaseline, setSessionFactsBaseline] = useState({});
  const [selectedSessionMaterials, setSelectedSessionMaterials] = useState({});
  const [assignments, setAssignments] = useState([]);
  const [assignmentSessionId, setAssignmentSessionId] = useState('');
  const [reports, setReports] = useState({});
  const [reportMeta, setReportMeta] = useState({});
  const [reportLoadErrors, setReportLoadErrors] = useState({});
  const [transcripts, setTranscripts] = useState({});
  const [transcriptLoadErrors, setTranscriptLoadErrors] = useState({});
  const [confirmations, setConfirmations] = useState({});
  const [confirmationsBaseline, setConfirmationsBaseline] = useState({});
  const [confirmationLoadErrors, setConfirmationLoadErrors] = useState({});
  const [script, setScript] = useState(null);
  const [scriptLoadError, setScriptLoadError] = useState('');
  const [scriptDraft, setScriptDraft] = useState('');
  const [scriptEditing, setScriptEditing] = useState(false);
  const [assessmentInterviewEvidence, setAssessmentInterviewEvidence] = useState({
    archives: [],
    analyses: [],
  });
  const [assessmentEvidenceLoadError, setAssessmentEvidenceLoadError] = useState('');
  const [assessmentQuestionDraftState, setAssessmentQuestionDraftState] = useState({
    contextKey: '',
    text: '',
  });
  const [summaryImportError, setSummaryImportError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');
  const [reportError, setReportError] = useState('');
  const [transcriptError, setTranscriptError] = useState('');
  const [confirmationError, setConfirmationError] = useState('');
  const [versionConflict, setVersionConflict] = useState(null);
  const [loadedCandidateId, setLoadedCandidateId] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');
  const [draftBaseline, setDraftBaseline] = useState('');
  const [activeTab, setActiveTab] = useState(() => normalizeInterviewWorkspaceTab(initialTab));
  const [expandedSessionKey, setExpandedSessionKey] = useState('');
  const [localJob, setLocalJob] = useState({ status: 'idle' });
  const [localJobKnown, setLocalJobKnown] = useState(false);
  const [localJobLoadError, setLocalJobLoadError] = useState('');
  const [completedLocalJobId, setCompletedLocalJobId] = useState('');
  const [consentRefreshToken, setConsentRefreshToken] = useState(0);
  const [llmPreview, setLlmPreview] = useState(null);
  const [llmTarget, setLlmTarget] = useState(null);
  const [llmCancelling, setLlmCancelling] = useState(false);
  const [llmConfigStatus, setLlmConfigStatus] = useState(null);
  const [llmConfigLoadError, setLlmConfigLoadError] = useState('');
  const [aiFirstUseOpen, setAiFirstUseOpen] = useState(false);
  const [aiFirstUseError, setAiFirstUseError] = useState('');
  const [aiCapabilityChecking, setAiCapabilityChecking] = useState(false);
  const [pendingAiPreview, setPendingAiPreview] = useState(null);
  const [lifecycleHolds, setLifecycleHolds] = useState({});
  const [lifecycleStates, setLifecycleStates] = useState({});
  const [lifecycleStatusErrors, setLifecycleStatusErrors] = useState({});
  const [lifecycleResults, setLifecycleResults] = useState({});
  const interviewContextKey = `${String(candidateId || '')}\u0000${String(jobId || '')}`;
  const loadRequestRef = useRef(createRequestEpoch());
  const stableRefreshRef = useRef(null);
  const completedReviewNavigatorRef = useRef(null);
  const activeTabRef = useRef(normalizeInterviewWorkspaceTab(initialTab));
  const candidateJobContextRef = useRef(null);
  const loadedCandidateIdRef = useRef('');
  const llmRequestRef = useRef('');
  const lifecycleBusyRef = useRef(false);
  const summaryImportTriggerRef = useRef(null);
  const summaryImportFocusPendingRef = useRef(false);
  const scriptEditingRef = useRef(false);
  const dirtyChangeRef = useRef(onDirtyChange);
  const sessionFactsRef = useRef({});
  const sessionFactsBaselineRef = useRef({});
  const confirmationsRef = useRef({});
  const confirmationsBaselineRef = useRef({});
  const navigationRequestKeyRef = useRef(navigationRequestKey);
  const handledNavigationTargetRef = useRef(null);
  const assessmentQuestionDraft = assessmentQuestionDraftState.contextKey === assessmentQuestionContextKey
    ? assessmentQuestionDraftState.text
    : '';
  if (!stableRefreshRef.current) stableRefreshRef.current = createStableInterviewReviewRefresh();
  if (!completedReviewNavigatorRef.current) {
    completedReviewNavigatorRef.current = createCompletedReviewNavigator();
  }
  candidateJobContextRef.current = {
    candidateId: String(candidateId || ''),
    jobId: String(jobId || ''),
    contextKey: interviewContextKey,
  };
  const scriptDraftDirty = scriptEditing && scriptDraft !== scriptText(script);
  const reportDraftDirty = !!editingId && draft !== draftBaseline;
  const sessionFactsDirty = draftMapChanged(sessionFacts, sessionFactsBaseline);
  const confirmationsDirty = draftMapChanged(confirmations, confirmationsBaseline);
  const hasUnsavedChanges = scriptDraftDirty || reportDraftDirty || sessionFactsDirty || confirmationsDirty;
  const writeBusy = Boolean(
    busyKey
    && !busyKey.startsWith('llm-preview:'),
  );

  useEffect(() => {
    if (
      aiResumeIntent?.capability !== 'interview_review'
      || String(aiResumeIntent.targetId) !== String(candidateId)
      || loading
      || (!llmConfigStatus && !llmConfigLoadError)
    ) return;
    const intent = aiResumeIntent;
    const snapshot = intent.draftSnapshot && typeof intent.draftSnapshot === 'object'
      ? intent.draftSnapshot
      : null;
    if (snapshot) {
      setScriptDraft(String(snapshot.scriptDraft || ''));
      setScriptEditing(snapshot.scriptEditing === true);
      setEditingId(snapshot.editingId == null ? null : snapshot.editingId);
      setDraft(String(snapshot.draft || ''));
      setDraftBaseline(String(snapshot.draftBaseline || ''));
      setSessionFacts(snapshot.sessionFacts || {});
      setSessionFactsBaseline(snapshot.sessionFactsBaseline || {});
      setConfirmations(snapshot.confirmations || {});
      setConfirmationsBaseline(snapshot.confirmationsBaseline || {});
      setAssessmentQuestionDraftState(snapshot.assessmentQuestionDraftState || {
        contextKey: assessmentQuestionContextKey,
        text: '',
      });
      setInterviewActiveTab(snapshot.activeTab || 'review', { preserveCompletedNavigation: true });
      setExpandedSessionKey(String(snapshot.expandedSessionKey || ''));
    }
    const targetSession = sessions.find((item) => String(item.id) === String(intent.sessionId));
    const targetRecord = intent.recordingId == null
      ? null
      : records.find((item) => String(recordId(item)) === String(intent.recordingId)) || null;
    onAiResumeConsumed?.(intent.id);
    globalThis.setTimeout(() => {
      const target = globalThis.document?.getElementById(
        intent.focusTargetId
          || (targetSession ? `interview-ai-review-action-${targetSession.id}` : 'candidate-interview-ai-return-target'),
      );
      target?.focus?.({ preventScroll: false });
      target?.scrollIntoView?.({ block: 'nearest' });
      if (intent.resumeAction !== false
          && llmConfigStatus?.capabilities?.interview_review
          && targetSession
          && Array.isArray(intent.materialIds)
          && intent.materialIds.length) {
        void previewLlmAnalysis({
          record: targetRecord,
          session: targetSession,
          materialIds: intent.materialIds,
        });
      }
    }, 0);
  }, [
    aiResumeIntent?.id,
    candidateId,
    loading,
    llmConfigLoadError,
    llmConfigStatus?.capabilities?.interview_review,
    sessions,
    records,
  ]);

  function setInterviewActiveTab(key, options = {}) {
    const normalized = normalizeInterviewWorkspaceTab(key);
    if (options.preserveCompletedNavigation !== true) {
      completedReviewNavigatorRef.current.invalidate();
    }
    activeTabRef.current = normalized;
    setActiveTab(normalized);
  }

  function currentInterviewNavigationContext() {
    return {
      ...candidateJobContextRef.current,
      activeTab: activeTabRef.current,
    };
  }

  function focusCandidateInterviewSession(sessionId) {
    if (typeof document === 'undefined') return;
    const target = document.getElementById(`candidate-interview-session-${sessionId}`);
    if (!target) return;
    const reduceMotion = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    target.focus({ preventScroll: true });
  }

  function replaceSessionFactsFromServer(saved) {
    const nextBaseline = { ...(saved || {}) };
    const nextFacts = mergeServerDraftMap(
      sessionFactsRef.current,
      sessionFactsBaselineRef.current,
      nextBaseline,
    );
    sessionFactsRef.current = nextFacts;
    sessionFactsBaselineRef.current = nextBaseline;
    setSessionFacts(nextFacts);
    setSessionFactsBaseline(nextBaseline);
  }

  function replaceConfirmationsFromServer(saved) {
    const nextBaseline = { ...(saved || {}) };
    const nextConfirmations = mergeServerDraftMap(
      confirmationsRef.current,
      confirmationsBaselineRef.current,
      nextBaseline,
    );
    confirmationsRef.current = nextConfirmations;
    confirmationsBaselineRef.current = nextBaseline;
    setConfirmations(nextConfirmations);
    setConfirmationsBaseline(nextBaseline);
  }

  function resetConfirmationDraftMaps() {
    sessionFactsRef.current = {};
    sessionFactsBaselineRef.current = {};
    confirmationsRef.current = {};
    confirmationsBaselineRef.current = {};
    setSessionFacts({});
    setSessionFactsBaseline({});
    setConfirmations({});
    setConfirmationsBaseline({});
  }

  function restoreConfirmationDraftBaselines() {
    const savedSessionFacts = { ...sessionFactsBaselineRef.current };
    const savedConfirmations = { ...confirmationsBaselineRef.current };
    sessionFactsRef.current = savedSessionFacts;
    confirmationsRef.current = savedConfirmations;
    setSessionFacts(savedSessionFacts);
    setConfirmations(savedConfirmations);
  }

  useEffect(() => {
    dirtyChangeRef.current = onDirtyChange;
    if (typeof dirtyChangeRef.current === 'function') dirtyChangeRef.current(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange]);

  useEffect(() => {
    scriptEditingRef.current = scriptEditing;
  }, [scriptEditing]);

  useEffect(() => {
    setAssessmentQuestionDraftState({ contextKey: assessmentQuestionContextKey, text: '' });
  }, [assessmentQuestionContextKey]);

  useEffect(() => {
    onBusyChange?.(writeBusy);
  }, [onBusyChange, writeBusy]);

  useEffect(() => () => {
    if (typeof dirtyChangeRef.current === 'function') dirtyChangeRef.current(false);
    candidateJobContextRef.current = null;
  }, []);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  useEffect(() => {
    if (!hasUnsavedChanges || typeof window === 'undefined') return undefined;
    const protectWindowClose = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protectWindowClose);
    return () => window.removeEventListener('beforeunload', protectWindowClose);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (busyKey || !summaryImportFocusPendingRef.current) return undefined;
    summaryImportFocusPendingRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const trigger = summaryImportTriggerRef.current;
      if (trigger?.isConnected && !trigger.disabled && typeof trigger.focus === 'function') {
        trigger.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [busyKey]);

  const performLoad = useCallback(async () => {
    if (!candidateId) {
      loadedCandidateIdRef.current = '';
      setLoadedCandidateId('');
      setAssessmentInterviewEvidence({ archives: [], analyses: [] });
      setAssessmentEvidenceLoadError('');
      setLoading(false);
      return { ok: true, candidateId: '', jobId: '', sessions: [] };
    }
    const candidateKey = String(candidateId);
    const hadCurrentSnapshot = loadedCandidateIdRef.current === candidateKey;
    const requestId = loadRequestRef.current.begin();
    setLoading(true);
    setError('');
    setReportError('');
    setScriptLoadError('');
    setLlmConfigLoadError('');
    setSessionReportLoadErrors({});
    setReportLoadErrors({});
    setTranscriptError('');
    setConfirmationError('');
    setTranscriptLoadErrors({});
    setConfirmationLoadErrors({});
    try {
      const [
        recordRes,
        unmatchedRes,
        scriptRes,
        sessionRes,
        assignmentRes,
        llmConfigRes,
        assessmentArchiveRes,
        assessmentAiRes,
      ] = await Promise.all([
        api.listCandidateInterviewRecordings(candidateId, jobId),
        api.listUnmatchedInterviewRecordings(jobId),
        jobId ? api.getInterviewScript(jobId).catch((err) => ({ script: null, load_error: err.message || '面试脚本暂不可读' })) : Promise.resolve({ script: null }),
        api.listInterviewSessions(candidateId, jobId),
        api.listInterviewAssignments(jobId),
        api.getLlmConfig().catch((err) => ({ config: null, load_error: err.message || 'AI 配置状态暂不可读' })),
        jobId
          ? api.listAssessmentArchives(candidateId, jobId)
            .catch((err) => ({ archives: [], load_error: err?.message || '测评报告读取失败' }))
          : Promise.resolve({ archives: [] }),
        jobId
          ? api.listAssessmentAiAnalyses(candidateId, jobId)
            .catch((err) => ({ analyses: [], load_error: err?.message || '测评 AI 分析读取失败' }))
          : Promise.resolve({ analyses: [] }),
      ]);
      if (!loadRequestRef.current.isCurrent(requestId)) return;
      const nextRecords = toRows(recordRes);
      const nextAssignments = Array.isArray(assignmentRes && assignmentRes.assignments) ? assignmentRes.assignments : [];
      const pendingRecordingIds = new Set(nextAssignments.map((item) => Number(item.interview_recording_id)).filter(Boolean));
      const nextUnmatched = toRows(unmatchedRes).filter((item) => !pendingRecordingIds.has(Number(recordId(item))));
      const nextSessions = Array.isArray(sessionRes && sessionRes.sessions) ? sessionRes.sessions : [];
      const nextScript = extractScriptPayload(scriptRes && scriptRes.script);
      const nextScriptLoadError = clean(scriptRes && scriptRes.load_error);
      const nextLlmConfigLoadError = clean(llmConfigRes && llmConfigRes.load_error);
      setScriptLoadError(nextScriptLoadError);
      setLlmConfigLoadError(nextLlmConfigLoadError);
      setLlmConfigStatus(llmConfigRes && llmConfigRes.config ? llmConfigRes.config : null);
      setAssessmentInterviewEvidence({
        archives: Array.isArray(assessmentArchiveRes?.archives) ? assessmentArchiveRes.archives : [],
        analyses: Array.isArray(assessmentAiRes?.analyses) ? assessmentAiRes.analyses : [],
      });
      setAssessmentEvidenceLoadError([
        clean(assessmentArchiveRes?.load_error),
        clean(assessmentAiRes?.load_error),
      ].filter(Boolean).join('；'));
      const seededReports = {};
      const seededReportMeta = {};
      nextRecords.forEach((record) => {
        const id = recordId(record);
        const report = extractInterviewReportPayload(record.report || record.report_json || record.ai_report);
        if (id && report) seededReports[id] = report;
        const meta = extractInterviewReportMeta(record.report || record.ai_report);
        if (id && meta) seededReportMeta[id] = meta;
      });
      const seededConfirmations = {};
      nextRecords.forEach((record) => {
        const id = recordId(record);
        if (id) seededConfirmations[id] = inferConfirmationItems(seededReports[id]);
      });
      setRecords(nextRecords);
      setUnmatched(nextUnmatched);
      setSessions(nextSessions);
      setSelectedSessionMaterials((current) => Object.fromEntries(nextSessions.map((session) => {
        const available = new Set((session.materials || [])
          .filter((material) => material.source_status !== 'revoked')
          .map((material) => Number(material.id))
          .filter(Number.isInteger));
        const previous = (current[session.id] || []).map(Number).filter((id) => available.has(id));
        const trigger = (session.materials || []).find((material) => (
          material.source_status !== 'revoked'
          &&
          material.interview_recording_id
          && nextRecords.some((record) => Number(recordId(record)) === Number(material.interview_recording_id))
        )) || (session.materials || []).find((material) => material.source_status !== 'revoked');
        return [session.id, previous.length ? previous : (trigger ? [Number(trigger.id)] : [])];
      })));
      setAssignments(nextAssignments);
      setReports(seededReports);
      setReportMeta(seededReportMeta);
      replaceConfirmationsFromServer(seededConfirmations);
      if (!nextScriptLoadError || !hadCurrentSnapshot) {
        setScript(nextScript);
        if (!scriptEditingRef.current) setScriptDraft(scriptText(nextScript));
      }

      const [sessionReportSettled, lifecycleStatusSettled] = await Promise.all([
        Promise.allSettled(nextSessions.map((session) => api.getInterviewReport(session.id))),
        Promise.allSettled(nextSessions.map((session) => api.getInterviewLifecycleStatus(session.id))),
      ]);
      if (!loadRequestRef.current.isCurrent(requestId)) return;
      const nextSessionReports = {};
      const nextSessionReportMeta = {};
      const nextSessionFacts = {};
      const nextSessionReportLoadErrors = {};
      let sessionReportFailed = 0;
      sessionReportSettled.forEach((item, index) => {
        const sessionId = nextSessions[index].id;
        if (item.status !== 'fulfilled') {
          sessionReportFailed += 1;
          nextSessionReportLoadErrors[String(sessionId)] = item.reason?.message || '面试轮次报告暂不可读';
          return;
        }
        const responseState = sessionInterviewReportStateFromGetResponse(item.value);
        if (responseState.report) nextSessionReports[sessionId] = responseState.report;
        if (responseState.meta) nextSessionReportMeta[sessionId] = responseState.meta;
        nextSessionFacts[sessionId] = responseState.facts;
      });
      setSessionReports(nextSessionReports);
      setSessionReportMeta(nextSessionReportMeta);
      replaceSessionFactsFromServer(nextSessionFacts);
      setSessionReportLoadErrors(nextSessionReportLoadErrors);

      const nextLifecycleHolds = {};
      const nextLifecycleStates = {};
      const nextLifecycleStatusErrors = {};
      lifecycleStatusSettled.forEach((item, index) => {
        const sessionId = String(nextSessions[index].id);
        if (item.status !== 'fulfilled' || !item.value?.lifecycle) {
          nextLifecycleStatusErrors[sessionId] = '生命周期状态暂不可读';
          return;
        }
        const lifecycle = item.value.lifecycle;
        nextLifecycleStates[sessionId] = lifecycle.state;
        nextLifecycleHolds[sessionId] = Array.isArray(lifecycle.active_holds) && lifecycle.active_holds.length
          ? lifecycle.active_holds[0]
          : null;
      });
      setLifecycleHolds(nextLifecycleHolds);
      setLifecycleStates(nextLifecycleStates);
      setLifecycleStatusErrors(nextLifecycleStatusErrors);

      const ids = nextRecords.map(recordId).filter(Boolean);
      if (!ids.length) {
        if (sessionReportFailed) setReportError(`有 ${sessionReportFailed} 个面试轮次的报告暂不可读；失败记录已锁定。`);
        loadedCandidateIdRef.current = candidateKey;
        setLoadedCandidateId(candidateKey);
        return {
          ok: true,
          candidateId: candidateKey,
          jobId: String(jobId || ''),
          sessions: nextSessions,
        };
      }
      const [settled, confirmationSettled, transcriptSettled] = await Promise.all([
        Promise.allSettled(ids.map((id) => api.getInterviewAiReport(id))),
        Promise.allSettled(ids.map((id) => api.getInterviewConfirmations(id))),
        Promise.allSettled(ids.map((id) => api.getInterviewTranscript(id))),
      ]);
      if (!loadRequestRef.current.isCurrent(requestId)) return;
      const nextReports = { ...seededReports };
      const nextReportMeta = { ...seededReportMeta };
      const nextReportLoadErrors = {};
      let failed = 0;
      settled.forEach((item, index) => {
        if (item.status === 'fulfilled') {
          const report = extractInterviewReportPayload(item.value);
          if (report) nextReports[ids[index]] = report;
          const meta = extractInterviewReportMeta(item.value);
          if (meta) nextReportMeta[ids[index]] = meta;
        } else {
          failed += 1;
          nextReportLoadErrors[String(ids[index])] = item.reason?.message || '面试报告暂不可读';
        }
      });
      setReports(nextReports);
      setReportMeta(nextReportMeta);
      setReportLoadErrors(nextReportLoadErrors);
      if (sessionReportFailed || failed) {
        setReportError([
          sessionReportFailed ? `${sessionReportFailed} 个面试轮次报告` : '',
          failed ? `${failed} 条面试报告` : '',
        ].filter(Boolean).join('、') + '暂不可读；失败记录已锁定。');
      }

      const nextConfirmations = {};
      ids.forEach((id) => {
        nextConfirmations[id] = inferConfirmationItems(nextReports[id]);
      });
      let confirmationFailed = 0;
      const nextConfirmationLoadErrors = {};
      confirmationSettled.forEach((item, index) => {
        const id = ids[index];
        if (item.status === 'fulfilled') {
          const savedItems = confirmationItemsFromResponse(item.value);
          nextConfirmations[id] = item.value && item.value.confirmation_source === 'interview_report_v1'
            ? mergeConfirmationItems([], savedItems)
            : mergeConfirmationItems(nextConfirmations[id], savedItems);
        } else {
          confirmationFailed += 1;
          nextConfirmationLoadErrors[String(id)] = item.reason?.message || '关键事实确认暂不可读';
        }
      });
      replaceConfirmationsFromServer(nextConfirmations);
      setConfirmationLoadErrors(nextConfirmationLoadErrors);
      if (confirmationFailed) setConfirmationError(`有 ${confirmationFailed} 条记录的关键事实确认暂不可读；失败记录已锁定，不能保存或确认入档。`);

      const nextTranscripts = {};
      const nextTranscriptLoadErrors = {};
      let transcriptFailed = 0;
      transcriptSettled.forEach((item, index) => {
        if (item.status === 'fulfilled') {
          nextTranscripts[ids[index]] = transcriptFromResponse(item.value);
        } else {
          transcriptFailed += 1;
          nextTranscriptLoadErrors[String(ids[index])] = item.reason?.message || '全文转写暂不可读';
        }
      });
      setTranscripts(nextTranscripts);
      setTranscriptLoadErrors(nextTranscriptLoadErrors);
      if (transcriptFailed) setTranscriptError(`有 ${transcriptFailed} 条记录的全文转写暂不可读；失败记录不会显示为“暂无全文转写”。`);
      loadedCandidateIdRef.current = candidateKey;
      setLoadedCandidateId(candidateKey);
      return {
        ok: true,
        candidateId: candidateKey,
        jobId: String(jobId || ''),
        sessions: nextSessions,
      };
    } catch (err) {
      if (!loadRequestRef.current.isCurrent(requestId)) return;
      const loadError = err?.message || '面试资料读取失败';
      setError(loadError);
      if (!hadCurrentSnapshot) {
        setRecords([]);
        setUnmatched([]);
        setSessions([]);
        setSessionReports({});
        setSessionReportMeta({});
        setSessionReportLoadErrors({});
        replaceSessionFactsFromServer({});
        setSelectedSessionMaterials({});
        setAssignments([]);
        setReports({});
        setReportMeta({});
        setReportLoadErrors({});
        setTranscripts({});
        setTranscriptLoadErrors({});
        replaceConfirmationsFromServer({});
        setConfirmationLoadErrors({});
        setScript(null);
        setScriptLoadError('');
        setLlmConfigStatus(null);
        setLlmConfigLoadError('');
        setLifecycleHolds({});
        setLifecycleStates({});
        setLifecycleStatusErrors({});
      }
      return {
        ok: false,
        candidateId: candidateKey,
        jobId: String(jobId || ''),
        sessions: [],
        error: loadError,
      };
    } finally {
      if (loadRequestRef.current.isCurrent(requestId)) setLoading(false);
    }
  }, [candidateId, jobId]);

  const load = useCallback((options = {}) => stableRefreshRef.current.refresh(
    interviewContextKey,
    performLoad,
    options,
  ), [interviewContextKey, performLoad]);

  const refreshLocalJob = useCallback(async () => {
    if (READONLY_UI) {
      setLocalJob({ status: 'disabled_in_operational_readonly' });
      setLocalJobKnown(true);
      setLocalJobLoadError('');
      return;
    }
    try {
      const data = await api.localInterviewProgress();
      const nextJob = data.job || { status: 'idle' };
      setLocalJob(nextJob);
      setLocalJobKnown(true);
      setLocalJobLoadError('');
      if (
        nextJob.status === 'done'
        && nextJob.id
        && nextJob.id !== completedLocalJobId
        && nextJob.bind_candidate_id === candidateId
      ) {
        setCompletedLocalJobId(nextJob.id);
        await load();
      }
    } catch (refreshError) {
      setLocalJobLoadError(refreshError.message || '录音任务状态读取失败');
    }
  }, [candidateId, completedLocalJobId, load]);

  useEffect(() => {
    loadRequestRef.current.invalidate();
    stableRefreshRef.current.setContext(interviewContextKey);
    completedReviewNavigatorRef.current.invalidate();
    loadedCandidateIdRef.current = '';
    setLoadedCandidateId('');
    setEditingId(null);
    setDraft('');
    setDraftBaseline('');
    scriptEditingRef.current = false;
    setScriptEditing(false);
    const nextInitialTab = normalizeInterviewWorkspaceTab(initialTab);
    activeTabRef.current = nextInitialTab;
    setActiveTab(nextInitialTab);
    setExpandedSessionKey('');
    setSummaryImportError('');
    setAssessmentEvidenceLoadError('');
    setLocalJob(READONLY_UI ? { status: 'disabled_in_operational_readonly' } : { status: 'idle' });
    setLocalJobKnown(READONLY_UI);
    setLocalJobLoadError('');
    setCompletedLocalJobId('');
    setRecords([]);
    setUnmatched([]);
    setSessions([]);
    setSessionReports({});
    setSessionReportMeta({});
    setSessionReportLoadErrors({});
    resetConfirmationDraftMaps();
    setSelectedSessionMaterials({});
    setAssignments([]);
    setReports({});
    setReportMeta({});
    setReportLoadErrors({});
    setTranscripts({});
    setTranscriptLoadErrors({});
    setScript(null);
    setScriptLoadError('');
    setLlmPreview(null);
    setLlmTarget(null);
    setLlmConfigStatus(null);
    setLlmConfigLoadError('');
    setLifecycleHolds({});
    setLifecycleStates({});
    setLifecycleStatusErrors({});
    setLifecycleResults({});
    setTranscriptError('');
    setVersionConflict(null);
    lifecycleBusyRef.current = false;
    llmRequestRef.current = '';
    load();
  }, [load]);

  useEffect(() => {
    if (Object.is(navigationRequestKeyRef.current, navigationRequestKey)) return;
    navigationRequestKeyRef.current = navigationRequestKey;
    setInterviewActiveTab(initialTab);
  }, [initialTab, navigationRequestKey]);

  useEffect(() => {
    const targetType = navigationTarget?.type;
    const targetId = navigationTarget?.targetId;
    if (!['session', 'report'].includes(targetType) || targetId == null) return undefined;
    const requestIdentity = `${navigationRequestKey}:${targetType}:${String(targetId)}`;
    if (handledNavigationTargetRef.current === requestIdentity) return undefined;
    const matchedSession = sessions.find((session) => {
      if (targetType === 'session') return String(session.id) === String(targetId);
      return String(session.report_id || '') === String(targetId)
        || String(sessionReportMeta[session.id]?.id || '') === String(targetId);
    });
    if (!matchedSession) return undefined;

    handledNavigationTargetRef.current = requestIdentity;
    setInterviewActiveTab('review');
    setExpandedSessionKey(String(matchedSession.id));
    const timer = globalThis.setTimeout(() => {
      if (typeof document === 'undefined') return;
      const target = document.getElementById(`candidate-interview-session-${matchedSession.id}`);
      if (!target) return;
      const reduceMotion = typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      target.focus({ preventScroll: true });
    }, 0);
    return () => globalThis.clearTimeout(timer);
  }, [navigationRequestKey, navigationTarget?.targetId, navigationTarget?.type, sessionReportMeta, sessions]);

  useEffect(() => {
    if (READONLY_UI) return undefined;
    refreshLocalJob();
    const timer = setInterval(refreshLocalJob, 2500);
    return () => clearInterval(timer);
  }, [refreshLocalJob]);

  useEffect(() => {
    setExpandedSessionKey((current) => {
      if (current && sessions.some((session) => String(session.id) === String(current))) return current;
      const currentSession = orderedCandidateSessions(sessions)[0];
      return currentSession ? String(currentSession.id) : '';
    });
  }, [sessions]);

  const assignableSessions = orderedCandidateSessions(sessions)
    .filter((session) => ['draft', 'scheduled', 'in_progress', 'pending_review'].includes(session.status));
  const selectedAssignmentSession = assignableSessions.find((session) => String(session.id) === String(assignmentSessionId))
    || assignableSessions[0]
    || null;

  useEffect(() => {
    setAssignmentSessionId((current) => (
      assignableSessions.some((session) => String(session.id) === String(current))
        ? current
        : String(assignableSessions[0]?.id || '')
    ));
  }, [candidateId, jobId, assignableSessions.map((session) => `${session.id}:${session.status}`).join('|')]);

  useEffect(() => () => {
    completedReviewNavigatorRef.current.invalidate();
    const requestId = llmRequestRef.current;
    if (requestId) {
      api.cancelInterviewLlm(requestId).catch(() => {});
    }
  }, [candidateId, jobId]);

  async function run(key, action, successText) {
    if (busyKey) return false;
    setBusyKey(key);
    try {
      await action();
      if (successText) message.success(successText);
      await load();
      setVersionConflict((current) => (current?.actionKey === key ? null : current));
      return true;
    } catch (err) {
      if (isInterviewVersionConflict(err)) {
        const hasLocalChanges = hasUnsavedChanges
          || /(?:save|confirmations|fact-review|structured)/.test(key);
        setVersionConflict(createInterviewVersionConflict(err, {
          actionKey: key,
          hasLocalChanges,
        }));
        message.error('服务端版本已变化；本次未写入，请重新读取后再次提交。');
      } else {
        message.error(err.message);
      }
      return false;
    } finally {
      setBusyKey('');
    }
  }

  async function refreshAfterVersionConflict() {
    if (!versionConflict || busyKey) return false;
    const recoveryKey = `version-conflict-refresh:${versionConflict.actionKey || 'interview'}`;
    setBusyKey(recoveryKey);
    setVersionConflict((current) => (current ? { ...current, status: 'refreshing', recoveryError: '' } : current));
    try {
      const recovered = await recoverInterviewVersionConflict(
        versionConflict,
        (options) => load(options),
      );
      setVersionConflict(recovered);
      message.success(versionConflict.hasLocalChanges
        ? '已读取服务端最新版本；本地未保存修改仍保留，请核对后重新提交。'
        : '已读取服务端最新版本，请重新执行刚才的操作。');
      return true;
    } catch (refreshError) {
      setVersionConflict((current) => (current ? {
        ...current,
        status: 'conflict',
        recoveryError: refreshError?.message || '重新读取服务端版本失败',
      } : current));
      message.error(refreshError?.message || '重新读取服务端版本失败');
      return false;
    } finally {
      setBusyKey('');
    }
  }

  function discardEditableDrafts() {
    scriptEditingRef.current = false;
    setScriptEditing(false);
    setScriptDraft(scriptText(script));
    setEditingId(null);
    setDraft('');
    setDraftBaseline('');
    restoreConfirmationDraftBaselines();
  }

  function requestRefresh() {
    if (!hasUnsavedChanges) return load();
    modal.confirm({
      title: '放弃未保存的面试修改并刷新？',
      content: '当前脚本、报告或事实确认仍有未保存内容。继续刷新会放弃这些修改，并重新读取最近一次已保存的数据。',
      okText: '放弃修改并刷新',
      cancelText: '继续编辑',
      okButtonProps: { danger: true },
      onOk: async () => {
        discardEditableDrafts();
        await load();
      },
    });
    return undefined;
  }

  async function navigateToCompletedInterviewReview(context = {}) {
    const result = await completedReviewNavigatorRef.current.navigate({
      context: {
        candidateId: String(candidateId || ''),
        jobId: String(jobId || ''),
      },
      completion: context,
      refresh: () => load({ afterCurrent: true }),
      selectReview: () => setInterviewActiveTab('review', { preserveCompletedNavigation: true }),
      expandSession: setExpandedSessionKey,
      focusSession: focusCandidateInterviewSession,
      getContext: currentInterviewNavigationContext,
    });
    if (result.status === 'missing') {
      throw new Error('录音已归档，但所属面试轮次尚未刷新出来；请稍后重试。');
    }
    if (result.status === 'unavailable') {
      throw new Error('录音归属标识不可用，无法安全定位最新复盘。');
    }
    return result.status === 'navigated';
  }

  async function importLegacySummaryFromPicker() {
    if (readOnly || busyKey) return false;
    if (typeof api.selectInterviewRecordingSummary !== 'function') {
      setSummaryImportError('原生 summary.json 选择器尚未接入；为避免暴露或手输本机路径，本页不会降级为文本输入。');
      return false;
    }
    setBusyKey('import-summary');
    setSummaryImportError('');
    try {
      const selection = await api.selectInterviewRecordingSummary();
      if (selection?.canceled) return false;
      if (!selection || selection.ok !== true || !selection.path) throw new Error(selection?.error || '未取得有效的旧录音摘要文件');
      await api.importInterviewRecordingSummary(selection.path);
      message.success('旧录音摘要已导入');
      await load();
      return true;
    } catch (importError) {
      setSummaryImportError(importError?.message || '旧录音摘要导入失败');
      return false;
    } finally {
      summaryImportFocusPendingRef.current = true;
      setBusyKey('');
    }
  }

  async function runLifecycle(key, action, successText) {
    if (busyKey || lifecycleBusyRef.current) return null;
    lifecycleBusyRef.current = true;
    setBusyKey(key);
    const refreshConsentAfterMutation = /^lifecycle-(?:withdraw|close):/.test(key);
    try {
      const result = await action();
      if (successText) message.success(successText);
      await load();
      if (refreshConsentAfterMutation) setConsentRefreshToken((current) => current + 1);
      return result;
    } catch (err) {
      message.error(err.message);
      if (
        refreshConsentAfterMutation
        && (err?.data?.lifecycle
          || err?.data?.recording_stop_requested
          || err?.data?.lifecycle_write_failed
          || err?.data?.revocation_gate_failed)
      ) {
        await load();
        setConsentRefreshToken((current) => current + 1);
      }
      if (err?.data?.lifecycle) {
        return {
          ...err.data,
          partial_failure: true,
          error: err.message,
        };
      }
      throw err;
    } finally {
      lifecycleBusyRef.current = false;
      setBusyKey('');
    }
  }

  function rememberLifecycleResult(sessionId, text) {
    setLifecycleResults((current) => ({ ...current, [String(sessionId)]: text }));
  }

  function withdrawLifecycle(session, reasonCode) {
    if (busyKey || lifecycleBusyRef.current) return;
    modal.confirm({
      title: '确认撤回面试轮次及该岗位录音授权？',
      content: `面试轮次记录 ${session.id} 撤回后将停止继续处理，现有材料进入 7 天清理期；同时会撤销该候选人在此岗位的共享录音授权，并对任意轮次正在运行的录音或麦克风预检发起安全停止与清理。`,
      okText: '确认撤回',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const response = await runLifecycle(
          `lifecycle-withdraw:${session.id}`,
          () => api.withdrawInterviewLifecycle(session.id, reasonCode),
          '面试轮次已撤回并进入清理期',
        );
        if (response?.partial_failure) {
          rememberLifecycleResult(session.id, '撤回已写入，但录音停止仍待确认；新操作已阻止，请查看录音状态。');
          return;
        }
        rememberLifecycleResult(session.id, `已撤回，预计删除时间 ${fmtTime(response.lifecycle.delete_after)}`);
      },
    });
  }

  function closeLifecycle(session, reasonCode) {
    if (busyKey || lifecycleBusyRef.current) return;
    modal.confirm({
      title: '确认关闭这个面试轮次？',
      content: `面试轮次记录 ${session.id} 关闭后，正式报告将按 180 天保留规则处理，并禁止继续生成新材料。`,
      okText: '确认关闭',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const response = await runLifecycle(
          `lifecycle-close:${session.id}`,
          () => api.closeInterviewLifecycle(session.id, reasonCode),
          '面试轮次已关闭',
        );
        rememberLifecycleResult(session.id, `已关闭，正式报告保留至 ${fmtTime(response.lifecycle.confirmed_report_delete_after)}`);
      },
    });
  }

  function applyLifecycleHold(session, reasonCode, days) {
    if (busyKey || lifecycleBusyRef.current) return;
    const expiresAt = new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000).toISOString();
    modal.confirm({
      title: '确认应用 Legal Hold？',
      content: `面试轮次记录 ${session.id} 的到期删除将在 ${days} 天保全期内被阻止。`,
      okText: '确认应用',
      cancelText: '取消',
      onOk: async () => {
        const response = await runLifecycle(
          `lifecycle-hold:${session.id}`,
          () => api.applyInterviewLegalHold(session.id, reasonCode, expiresAt),
          'Legal Hold 已应用',
        );
        setLifecycleHolds((current) => ({ ...current, [String(session.id)]: response.hold }));
        rememberLifecycleResult(session.id, `Legal Hold 生效至 ${fmtTime(response.hold.expires_at)}`);
      },
    });
  }

  function releaseLifecycleHold(session, hold) {
    if (busyKey || lifecycleBusyRef.current || !hold?.hold_id) return;
    modal.confirm({
      title: '确认解除当前 Legal Hold？',
      content: `面试轮次记录 ${session.id} 解除保全后，到期材料将重新允许进入删除流程。`,
      okText: '确认解除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await runLifecycle(
          `lifecycle-release:${session.id}`,
          () => api.releaseInterviewLegalHold(hold.hold_id, 'legal_review_completed'),
          'Legal Hold 已解除',
        );
        setLifecycleHolds((current) => ({ ...current, [String(session.id)]: null }));
        rememberLifecycleResult(session.id, '当前页面应用的 Legal Hold 已解除');
      },
    });
  }

  async function previewLifecycleDeletion(session) {
    if (busyKey || lifecycleBusyRef.current) return;
    const deletionContext = {
      candidateId: String(candidateId || ''),
      jobId: String(jobId || ''),
      contextKey: interviewContextKey,
      sessionId: String(session.id),
      candidateLabel: candidate?.name || String(candidateId || '未知候选人'),
      jobLabel: candidate?.job_name || candidate?.jobName || String(jobId || '未知岗位'),
    };
    const isCurrentDeletionContext = () => {
      const current = candidateJobContextRef.current;
      return Boolean(
        current
        && current.contextKey === deletionContext.contextKey
        && current.candidateId === deletionContext.candidateId
        && current.jobId === deletionContext.jobId,
      );
    };
    const discardStaleDeletion = () => {
      message.warning('候选人或岗位已切换，本次永久删除清单已作废，请在当前候选人页面重新检查。');
    };
    let response;
    try {
      response = await runLifecycle(
        `lifecycle-dry-run:${session.id}`,
        () => api.previewInterviewDeletion(session.id),
        '',
      );
    } catch {
      return;
    }
    if (!isCurrentDeletionContext()) {
      discardStaleDeletion();
      return;
    }
    const manifest = response && response.manifest;
    if (!manifest || !manifest.manifest_id || !manifest.confirmation_token) {
      message.error('删除清单缺少服务端确认凭据，已停止。');
      return;
    }
    modal.confirm({
      title: `确认永久删除 ${manifest.item_count} 项到期材料？`,
      content: (
        <div>
          <p>候选人：{deletionContext.candidateLabel}</p>
          <p>岗位：{deletionContext.jobLabel}</p>
          <p>面试轮次记录：{session.id}</p>
          <p>策略版本：{manifest.policy_version}</p>
          <p>服务端 dry-run 已锁定 {manifest.item_count} 项材料；确认凭据仅在本次操作中传回服务端。</p>
          <p>删除不可撤销，请先确认没有 Legal Hold，且清单数量符合预期。</p>
        </div>
      ),
      okText: `永久删除 ${manifest.item_count} 项`,
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        if (!isCurrentDeletionContext()) {
          discardStaleDeletion();
          return;
        }
        const result = await runLifecycle(
          `lifecycle-delete:${session.id}`,
          () => {
            if (!isCurrentDeletionContext()) {
              const contextError = new Error('候选人或岗位已切换，永久删除请求已阻止。');
              contextError.code = 'INTERVIEW_CONTEXT_CHANGED';
              throw contextError;
            }
            return api.confirmInterviewDeletion(
              manifest.manifest_id,
              manifest.confirmation_token,
              'retention_due_hr_confirmed',
            );
          },
          '到期材料已按清单删除',
        );
        if (!result || !isCurrentDeletionContext()) return;
        rememberLifecycleResult(session.id, `已删除 ${result.result?.deleted_count ?? manifest.item_count} 项到期材料`);
      },
    });
  }

  function startEdit(record, report) {
    if (!record) {
      setEditingId(null);
      setDraft('');
      setDraftBaseline('');
      return;
    }
    const id = recordId(record);
    const nextDraft = JSON.stringify(report || EMPTY_REPORT, null, 2);
    const openEditor = () => {
      setEditingId(id);
      setDraft(nextDraft);
      setDraftBaseline(nextDraft);
    };
    if (reportDraftDirty && String(editingId) !== String(id)) {
      modal.confirm({
        title: '放弃当前未保存的报告修改？',
        content: '切换到另一份报告会丢失当前 JSON 草稿。',
        okText: '放弃并切换',
        cancelText: '继续编辑',
        okButtonProps: { danger: true },
        onOk: openEditor,
      });
      return;
    }
    openEditor();
  }

  async function saveReport(record) {
    const id = recordId(record);
    let parsed;
    try {
      parsed = JSON.parse(draft);
    } catch (err) {
      message.error(`报告数据格式错误：${err.message}`);
      return;
    }
    const expectedVersion = reportMeta[id] ? reportMeta[id].version : 0;
    const ok = await run(
      `save:${id}`,
      () => api.saveInterviewAiReport(id, parsed, expectedVersion, uiRequestId('report-save', id)),
      'AI 报告草稿已保存',
    );
    if (ok) {
      setEditingId(null);
      setDraft('');
      setDraftBaseline('');
    }
  }

  async function previewLlmAnalysis({ record = null, session, materialIds }) {
    const sessionId = session && session.id;
    if (!sessionId || !Array.isArray(materialIds) || !materialIds.length) {
      message.warning('请先勾选至少一份面试材料。');
      return;
    }
    const requestId = uiRequestId('llm-preview', sessionId);
    setBusyKey(`llm-preview:${sessionId}`);
    try {
      const result = await api.previewInterviewLlm(sessionId, materialIds, requestId);
      if (!result.preview || !Array.isArray(result.preview.units) || result.preview.units.length === 0) {
        throw new Error('没有可发送的最小化文本材料。');
      }
      setLlmTarget({ record, session, sessionId, recordingId: record ? recordId(record) : null, requestId });
      setLlmPreview({ ...result.preview, requestId: result.preview.requestId || requestId });
    } catch (err) {
      message.error(`AI 发送预览失败：${err.message}`);
    } finally {
      setBusyKey('');
    }
  }

  async function requestLlmPreview({ record = null, session, materialIds }) {
    if (aiCapabilityChecking || busyKey) return;
    setAiCapabilityChecking(true);
    const access = await readExternalAiCapability('interview_review');
    setAiCapabilityChecking(false);
    if (access.available) {
      setLlmConfigStatus(access.config);
      await previewLlmAnalysis({ record, session, materialIds });
      return;
    }
    const recordingId = record ? recordId(record) : null;
    setPendingAiPreview({
      record,
      session,
      sessionId: session?.id,
      recordingId,
      materialIds: Array.isArray(materialIds) ? [...materialIds] : [],
      focusTargetId: recordingId == null
        ? `interview-ai-review-action-${session?.id}`
        : `interview-ai-review-action-${session?.id}-${recordingId}`,
    });
    setAiFirstUseError(access.readable ? '' : access.error);
    setAiFirstUseOpen(true);
  }

  function continueInterviewReviewManually() {
    const focusTargetId = pendingAiPreview?.focusTargetId;
    setAiFirstUseOpen(false);
    message.info('可继续填写人工结构化复盘并核对关键事实；不启用 AI 也能完成报告确认。');
    globalThis.setTimeout(() => globalThis.document?.getElementById(focusTargetId)?.focus(), 0);
  }

  async function openInterviewAiSettings() {
    const pending = pendingAiPreview;
    setAiFirstUseOpen(false);
    if (!pending) return;
    await onOpenSettings?.({
      capability: 'interview_review',
      source: 'interview-review',
      sourceLabel: '面试 AI 复盘',
      targetId: candidateId,
      targetLabel: candidate?.name,
      jobId,
      sessionId: pending.sessionId,
      recordingId: pending.recordingId,
      materialIds: pending.materialIds,
      focusTargetId: pending.focusTargetId,
      draftSnapshot: {
        scriptDraft,
        scriptEditing,
        editingId,
        draft,
        draftBaseline,
        sessionFacts,
        sessionFactsBaseline,
        confirmations,
        confirmationsBaseline,
        assessmentQuestionDraftState,
        activeTab,
        expandedSessionKey,
      },
    });
  }

  async function openInterviewAiStatusSettings() {
    await onOpenSettings?.({
      capability: 'interview_review',
      source: 'interview-review',
      sourceLabel: '面试 AI 复盘',
      targetId: candidateId,
      targetLabel: candidate?.name,
      jobId,
      focusTargetId: 'candidate-interview-ai-return-target',
      resumeAction: false,
      draftSnapshot: {
        scriptDraft,
        scriptEditing,
        editingId,
        draft,
        draftBaseline,
        sessionFacts,
        sessionFactsBaseline,
        confirmations,
        confirmationsBaseline,
        assessmentQuestionDraftState,
        activeTab,
        expandedSessionKey,
      },
    });
  }

  async function analyzeLlmPreview() {
    if (!llmPreview || !llmTarget) return;
    const requestId = llmPreview.requestId || llmTarget.requestId;
    if (!requestId) {
      message.error('AI 发送预览已失效，请重新预览。');
      return;
    }
    const meta = llmTarget.recordingId
      ? reportMeta[llmTarget.recordingId]
      : sessionReportMeta[llmTarget.sessionId];
    let approval;
    try {
      approval = await api.confirmInterviewLlmApproval(llmPreview);
    } catch (err) {
      message.error(`AI 一次性授权失败：${err.message}`);
      return;
    }
    if (!approval.approved || !approval.userApproval) {
      message.info('已取消本次 AI 外发。');
      return;
    }
    llmRequestRef.current = requestId;
    setBusyKey('llm-analyze');
    try {
      const result = await api.analyzeInterviewLlm({
        sessionId: llmTarget.sessionId,
        materialIds: llmPreview.materialIds,
        requestHash: llmPreview.requestHash,
        expectedVersion: meta ? meta.version : 0,
        requestId,
        userApproval: approval.userApproval,
      });
      if (llmRequestRef.current !== requestId) return;
      if (result.audit && result.audit.status === 'cancelled') {
        message.info('AI 分析已取消，未写入报告。');
        return;
      }
      message.success('AI 分析结果已通过后端校验并保存为 draft，仍需人工复核。');
      setLlmPreview(null);
      setLlmTarget(null);
      await load();
    } catch (err) {
      if (llmRequestRef.current === requestId) {
        message.error(`AI 分析失败：${err.message}。系统未自动重试，可改用人工结构化复盘。`);
      }
    } finally {
      if (llmRequestRef.current === requestId) {
        llmRequestRef.current = '';
        setBusyKey('');
      }
    }
  }

  async function cancelLlmAnalysis() {
    const requestId = llmRequestRef.current;
    if (!requestId || llmCancelling) return;
    setLlmCancelling(true);
    try {
      const result = await api.cancelInterviewLlm(requestId);
      if (result.cancelled !== true && result.status !== 'cancelled') {
        throw new Error('后端未确认取消，请保持当前页面等待最终状态。');
      }
      llmRequestRef.current = '';
      setBusyKey('');
      setLlmPreview(null);
      setLlmTarget(null);
      message.info('AI 请求已取消，不会自动重试。');
    } catch (err) {
      message.error(`取消 AI 请求失败：${err.message}`);
    } finally {
      setLlmCancelling(false);
    }
  }

  function useManualReportFallback() {
    if (!llmTarget) return;
    if (llmTarget.record) startEdit(llmTarget.record, reports[llmTarget.recordingId]);
    else {
      setExpandedSessionKey(String(llmTarget.sessionId));
      globalThis.setTimeout(() => {
        document.getElementById(`candidate-interview-session-${llmTarget.sessionId}`)?.scrollIntoView({ behavior: 'auto', block: 'start' });
      }, 0);
    }
    setLlmPreview(null);
    setLlmTarget(null);
  }

  function startSessionEdit(session, report) {
    if (!session) {
      setEditingId(null);
      setDraft('');
      setDraftBaseline('');
      return;
    }
    const nextEditingId = `session:${session.id}`;
    const nextDraft = JSON.stringify(report || EMPTY_REPORT, null, 2);
    const openEditor = () => {
      setEditingId(nextEditingId);
      setDraft(nextDraft);
      setDraftBaseline(nextDraft);
    };
    if (reportDraftDirty && String(editingId) !== nextEditingId) {
      modal.confirm({
        title: '放弃当前未保存的报告修改？',
        content: '切换到另一面试轮次会丢失当前 JSON 草稿。',
        okText: '放弃并切换',
        cancelText: '继续编辑',
        okButtonProps: { danger: true },
        onOk: openEditor,
      });
      return;
    }
    openEditor();
  }

  async function saveSessionReport(session) {
    let parsed;
    try {
      parsed = JSON.parse(draft);
    } catch (err) {
      message.error(`报告数据格式错误：${err.message}`);
      return;
    }
    const meta = sessionReportMeta[session.id];
    const ok = await run(
      `session-save:${session.id}`,
      () => api.saveInterviewReport(
        session.id,
        parsed,
        meta ? meta.version : 0,
        uiRequestId('session-report-save', session.id),
        selectedSessionMaterials[session.id] || [],
      ),
      '面试轮次报告草稿已保存',
    );
    if (ok) {
      setEditingId(null);
      setDraft('');
      setDraftBaseline('');
    }
  }

  async function saveStructuredSessionReport(session, form) {
    const meta = sessionReportMeta[session.id];
    return run(
      `session-structured-save:${session.id}`,
      () => api.saveStructuredManualInterviewReport(
        session.id,
        selectedSessionMaterials[session.id] || [],
        form,
        meta ? meta.version : 0,
        uiRequestId('session-structured-report-save', session.id),
      ),
      '人工结构化面试草稿已保存；仍需逐项复核关键事实',
    );
  }

  function updateSessionFacts(sessionId, items) {
    const nextFacts = { ...sessionFactsRef.current, [sessionId]: items };
    sessionFactsRef.current = nextFacts;
    setSessionFacts(nextFacts);
  }

  function markSessionFactsSaved(sessionId, items) {
    const nextFacts = { ...sessionFactsRef.current, [sessionId]: items };
    const nextBaseline = { ...sessionFactsBaselineRef.current, [sessionId]: items };
    sessionFactsRef.current = nextFacts;
    sessionFactsBaselineRef.current = nextBaseline;
    setSessionFacts(nextFacts);
    setSessionFactsBaseline(nextBaseline);
  }

  async function saveSessionFacts(session, items) {
    const meta = sessionReportMeta[session.id];
    const reviewedItems = strictConfirmationReviewItems(items, CONFIRMATION_FIELDS);
    if (!reviewedItems.length) {
      message.warning('请先至少复核一项关键事实。');
      return;
    }
    if (reviewedItems.some((item) => item.status === 'corrected' && !item.corrected_value)) {
      message.warning('标记为“已修正”的关键事实必须填写修正值。');
      return;
    }
    const ok = await run(
      `confirmations:${session.id}`,
      () => api.reviewInterviewReportFacts(
        session.id,
        reviewedItems,
        meta ? meta.version : 0,
        uiRequestId('session-fact-review', session.id),
      ),
      '面试轮次关键事实复核已保存',
    );
    if (ok) markSessionFactsSaved(session.id, items);
  }

  async function confirmSessionReport(session) {
    if (busyKey) return;
    const meta = sessionReportMeta[session.id];
    modal.confirm({
      title: '确认正式归档这份面试报告？',
      content: (
        <div>
          <p>候选人：{candidate?.name || `ID ${candidateId}`}</p>
          <p>岗位：{candidate?.job_name || candidate?.jobName || `ID ${jobId}`} · 第 {session.round || '未知'} 轮</p>
          <p>确认后报告将进入正式确认状态，后续修改需走新版本，不可把 AI 草稿当作未确认内容继续覆盖。</p>
        </div>
      ),
      okText: '确认并正式归档',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => run(
        `session-confirm:${session.id}`,
        () => api.confirmInterviewReport(
          session.id,
          meta ? meta.version : 0,
          uiRequestId('session-report-confirm', session.id),
        ),
        '面试轮次报告已人工确认',
      ),
    });
  }

  function confirmRecordingReport(row, session = null) {
    if (busyKey) return false;
    const rowId = recordId(row);
    const meta = reportMeta[rowId];
    modal.confirm({
      title: '确认正式归档这条面试记录？',
      content: (
        <div>
          <p>候选人：{candidate?.name || `ID ${candidateId}`}</p>
          <p>岗位：{candidate?.job_name || candidate?.jobName || `ID ${jobId}`} · 第 {session?.round || '未知'} 轮 · 记录 ID {rowId}</p>
          <p>确认后该记录进入正式确认状态，不应再作为可随意覆盖的 AI 草稿处理。</p>
        </div>
      ),
      okText: '确认并正式归档',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => run(
        `confirm:${rowId}`,
        () => api.confirmInterviewRecording(rowId, meta ? meta.version : 0, uiRequestId('report-confirm', rowId)),
        '面试报告已人工确认',
      ),
    });
    return true;
  }

  function updateConfirmations(record, items) {
    const id = recordId(record);
    if (!id) return;
    const nextConfirmations = { ...confirmationsRef.current, [id]: items };
    confirmationsRef.current = nextConfirmations;
    setConfirmations(nextConfirmations);
  }

  function markConfirmationsSaved(id, items) {
    const nextConfirmations = { ...confirmationsRef.current, [id]: items };
    const nextBaseline = { ...confirmationsBaselineRef.current, [id]: items };
    confirmationsRef.current = nextConfirmations;
    confirmationsBaselineRef.current = nextBaseline;
    setConfirmations(nextConfirmations);
    setConfirmationsBaseline(nextBaseline);
  }

  async function saveConfirmations(record, items) {
    const id = recordId(record);
    if (confirmationLoadErrors[String(id)]) {
      message.error('关键事实确认尚未读取成功，当前默认项不可保存。请先重新读取。');
      return false;
    }
    const meta = reportMeta[id];
    const strictReview = reports[id]?.schema_version === 'interview_report_v1';
    const savedItems = strictReview
      ? strictConfirmationReviewItems(items, CONFIRMATION_FIELDS)
      : items;
    if (strictReview && !savedItems.length) {
      message.warning('请先至少复核一项关键事实。');
      return false;
    }
    if (strictReview && savedItems.some((item) => item.status === 'corrected' && !item.corrected_value)) {
      message.warning('标记为“已修正”的关键事实必须填写修正值。');
      return false;
    }
    const ok = await run(
      `confirmations:${id}`,
      () => api.saveInterviewConfirmations(id, savedItems, meta ? meta.version : 0, uiRequestId('fact-review', id)),
      '关键事实确认已保存',
    );
    if (ok) markConfirmationsSaved(id, items);
    return ok;
  }

  async function copyTalkTrack(text) {
    try {
      await navigator.clipboard.writeText(text);
      message.success('话术已复制');
    } catch (err) {
      message.error(`复制失败：${err.message}`);
    }
  }

  async function generateScript() {
    if (!jobId) return;
    const ok = await run('script:generate', () => api.generateInterviewScript(jobId), '面试脚本草稿已生成');
    if (ok) {
      scriptEditingRef.current = false;
      setScriptEditing(false);
    }
  }

  function startScriptEdit(next = true) {
    scriptEditingRef.current = !!next;
    setScriptEditing(!!next);
    setScriptDraft(scriptText(script));
  }

  function prepareApprovedAssessmentQuestions(questions) {
    const rows = (Array.isArray(questions) ? questions : [])
      .map((item, index) => {
        const question = clean(item && item.question);
        if (!question) return '';
        const evidence = Array.isArray(item.evidence_refs)
          ? item.evidence_refs.map(clean).filter(Boolean).join('、')
          : '';
        return `${index + 1}. ${question}${evidence ? `（测评证据：${evidence}）` : ''}`;
      })
      .filter(Boolean);
    if (!rows.length) {
      message.warning('当前已批准分析没有可加入的核验题。');
      return;
    }
    setAssessmentQuestionDraftState({
      contextKey: assessmentQuestionContextKey,
      text: `【当前候选人测评 AI 核验题】\n${rows.join('\n')}`,
    });
    message.success('已生成当前候选人的临时核验稿；不会保存到岗位面试脚本模板。');
  }

  async function copyApprovedAssessmentQuestions() {
    if (!assessmentQuestionDraft) return;
    try {
      await navigator.clipboard.writeText(assessmentQuestionDraft);
      message.success('当前候选人临时核验稿已复制。');
    } catch (error) {
      message.error(`复制失败：${error.message}`);
    }
  }

  async function saveScript() {
    if (!jobId) return;
    const nextScript = plainTextScriptPayload(script, scriptDraft);
    const ok = await run('script:save', () => api.saveInterviewScript(jobId, nextScript, scriptDraft), '面试脚本已保存');
    if (ok) {
      scriptEditingRef.current = false;
      setScriptEditing(false);
    }
  }

  const sessionOnlyUnits = sessionOnlyReportUnits(sessions, records, sessionReports, sessionReportMeta);
  const legacyReportCount = records.filter((record) => reports[recordId(record)]).length;
  const sessionReportCount = sessionOnlyUnits.filter((session) => sessionReports[session.id] || sessionReportMeta[session.id]).length;
  const reportUnitCount = records.length + sessionOnlyUnits.length;
  const reportCount = legacyReportCount + sessionReportCount;
  const evidenceCount = records.length
    + sessionOnlyUnits.reduce((sum, session) => sum + (Array.isArray(session.materials) ? session.materials.length : 0), 0)
    + unmatched.length
    + assignments.length;
  const legacyConfirmedCount = records.filter(isConfirmed).length;
  const sessionConfirmedCount = sessionOnlyUnits.filter((session) => sessionReportMeta[session.id]?.status === 'confirmed').length;
  const confirmedCount = legacyConfirmedCount + sessionConfirmedCount;
  const legacyConfirmationStats = confirmationProgress(records, reports, confirmationsBaseline);
  const sessionConfirmationStats = sessionConfirmationProgress(sessionOnlyUnits, sessionFactsBaseline);
  const confirmationStats = {
    total: legacyConfirmationStats.total + sessionConfirmationStats.total,
    finished: legacyConfirmationStats.finished + sessionConfirmationStats.finished,
  };
  const workflowState = deriveWorkflowState({
    script,
    records,
    recordCount: reportUnitCount,
    reportCount,
    confirmationStats,
    confirmedCount,
    localJob: localJobKnown ? localJob : { status: 'unknown' },
    candidateId,
    sessions,
  });
  const workflowSummary = `面试轮次 ${sessions.length} 个 · 面试记录 ${reportUnitCount} 条 · 待处理 ${assignments.length + unmatched.length} 条 · 报告 ${reportCount}/${reportUnitCount} 份`;
  const pendingReviewCount = Math.max(reportUnitCount - reportCount, 0);
  const pendingConfirmationCount = Math.max((confirmationStats.total || 0) - (confirmationStats.finished || 0), 0);
  const pendingArchiveCount = Math.max(reportUnitCount - confirmedCount, 0);
  const currentLocalJob = localJob && (!localJob.bind_candidate_id || localJob.bind_candidate_id === candidateId) ? localJob : null;
  const recordingStarting = currentLocalJob && currentLocalJob.status === 'starting';
  const recordingRunning = currentLocalJob && currentLocalJob.status === 'running' && currentLocalJob.mode === 'record';
  const recordingActive = recordingStarting || recordingRunning;
  const recordingFinalization = localInterviewRecordingFinalizationUiState(currentLocalJob || {});
  const discardingRunning = recordingFinalization.discarding;
  const transcribingRunning = recordingFinalization.transcribing;
  const recordingFailed = currentLocalJob && currentLocalJob.status === 'error';
  const sessionProgress = interviewSessionProgress(sessions);
  const activeSessionProgressCount = sessionProgress.inProgressCount
    + sessionProgress.reviewPendingCount
    + sessionProgress.confirmationPendingCount;
  const interviewProgressEstablished = reportUnitCount > 0
    || activeSessionProgressCount > 0
    || sessionProgress.terminalOnly;
  const pendingReviewActionCount = reportUnitCount > 0
    ? pendingReviewCount
    : sessionProgress.reviewPendingCount;
  const pendingConfirmationActionCount = reportUnitCount > 0
    ? pendingConfirmationCount
    : sessionProgress.confirmationPendingCount;
  const progressedPastReview = reportUnitCount > 0
    || sessionProgress.confirmationPendingCount > 0
    || sessionProgress.terminalOnly;
  const progressedPastConfirmation = (reportUnitCount > 0 && !pendingReviewCount && !pendingConfirmationCount)
    || sessionProgress.terminalOnly;
  const firstReviewPendingIndex = records.findIndex((record) => !reports[recordId(record)]);
  const firstConfirmationPendingIndex = records.findIndex((record) => hasPendingConfirmation(record, reports, confirmationsBaseline));
  const firstArchivePendingIndex = records.findIndex((record) => !isConfirmed(record));
  const firstUnmatchedIndex = unmatched.findIndex((record) => !!record);
  const reviewTargetId = firstReviewPendingIndex >= 0
    ? recordDomId(records[firstReviewPendingIndex], firstReviewPendingIndex, 'review')
    : 'interview-review-records';
  const confirmationTargetId = firstConfirmationPendingIndex >= 0
    ? recordDomId(records[firstConfirmationPendingIndex], firstConfirmationPendingIndex, 'review')
    : 'interview-review-records';
  const archiveTargetId = firstArchivePendingIndex >= 0
    ? recordDomId(records[firstArchivePendingIndex], firstArchivePendingIndex, 'review')
    : 'interview-review-records';
  const bindTargetId = assignments.length
    ? 'interview-assignment-list'
    : firstUnmatchedIndex >= 0
    ? recordDomId(unmatched[firstUnmatchedIndex], firstUnmatchedIndex, 'unmatched')
    : 'interview-unmatched-list';
  const todoItems = [
    {
      key: 'prepare',
      label: '面试准备',
      count: interviewProgressEstablished ? 0 : (scriptLoadError ? '—' : (script ? 0 : 1)),
      statusText: interviewProgressEstablished
        ? '流程已推进'
        : (scriptLoadError ? '读取失败' : (scriptEditing ? '编辑中' : (script ? (script.status === 'confirmed' ? '已确认' : '已生成') : '待生成'))),
      detail: interviewProgressEstablished
        ? '不以历史脚本缺失回退状态'
        : (scriptLoadError ? '重新读取后再生成或编辑' : (script ? '结构化脚本已可用' : '生成面试脚本')),
      tab: 'prepare',
      targetId: 'interview-script-panel',
      tone: interviewProgressEstablished ? 'done' : (scriptLoadError ? 'blocked' : (script ? 'done' : 'warning')),
      icon: <FileTextOutlined />,
    },
    {
      key: 'record',
      label: '录音',
      count: recordingActive
        ? 1
        : (sessionProgress.inProgressCount || (interviewProgressEstablished ? 0 : 1)),
      statusText: recordingFailed
        ? '录音异常'
        : (recordingStarting
          ? '建立录音中'
          : (discardingRunning
          ? '停止清理中'
          : (transcribingRunning ? '转写中' : (recordingRunning || sessionProgress.inProgressCount ? '面试中' : (interviewProgressEstablished ? '已推进' : '待开始'))))),
      detail: reportUnitCount
        ? `${reportUnitCount} 条面试记录`
        : (sessionProgress.total ? `${sessionProgress.total} 个面试轮次` : '麦克风预检/开始录音'),
      tab: 'start',
      targetId: 'candidate-interview-launcher',
      tone: recordingFailed
        ? 'blocked'
        : (recordingActive || sessionProgress.inProgressCount ? 'processing' : (interviewProgressEstablished ? 'done' : 'warning')),
      icon: <AudioOutlined />,
    },
    {
      key: 'review',
      label: '复盘',
      count: pendingReviewActionCount,
      statusText: reportDraftDirty
        ? '有未保存修改'
        : (pendingReviewActionCount ? '待补齐' : (progressedPastReview ? '已处理' : '未开始')),
      detail: reportUnitCount
        ? `${reportCount}/${reportUnitCount} 份报告`
        : (sessionProgress.reviewPendingCount ? `${sessionProgress.reviewPendingCount} 个面试轮次待复盘` : '等待面试记录'),
      tab: 'review',
      targetId: reviewTargetId,
      tone: reportDraftDirty ? 'warning' : (pendingReviewActionCount ? 'warning' : (progressedPastReview ? 'done' : 'idle')),
      icon: <RobotOutlined />,
    },
    {
      key: 'confirm',
      label: '事实确认',
      count: pendingConfirmationActionCount,
      statusText: pendingReviewActionCount
        ? '先复盘'
        : (sessionFactsDirty || confirmationsDirty
          ? '有未保存修改'
          : (pendingConfirmationActionCount ? '待核对' : (progressedPastConfirmation ? '已处理' : '未开始'))),
      detail: confirmationStats.total
        ? `${confirmationStats.finished || 0}/${confirmationStats.total} 个事实`
        : (sessionProgress.confirmationPendingCount ? `${sessionProgress.confirmationPendingCount} 个面试轮次待确认` : (reportUnitCount ? '暂无待核对事实' : '等待复盘结果')),
      tab: 'review',
      targetId: confirmationTargetId,
      tone: pendingReviewActionCount
        ? 'idle'
        : (sessionFactsDirty || confirmationsDirty
          ? 'warning'
          : (pendingConfirmationActionCount ? 'warning' : (progressedPastConfirmation ? 'done' : 'idle'))),
      icon: <QuestionCircleOutlined />,
    },
    {
      key: 'archive',
      label: '入档',
      count: pendingArchiveCount,
      statusText: sessionProgress.terminalOnly && !reportUnitCount
        ? '已结束'
        : (!reportUnitCount
          ? '未开始'
          : (reportDraftDirty || sessionFactsDirty || confirmationsDirty
            ? '先保存本地修改'
            : (versionConflict
              ? (versionConflict.status === 'recovered' ? '请重新提交' : '版本冲突待恢复')
              : (pendingArchiveCount ? (pendingReviewCount ? '先复盘' : (pendingConfirmationCount ? '先确认' : '可入档')) : '已入档')))),
      detail: reportUnitCount
        ? `${confirmedCount}/${reportUnitCount} 条记录确认`
        : (sessionProgress.terminalOnly ? `${sessionProgress.total} 个面试轮次已结束` : '等待面试记录'),
      tab: 'review',
      targetId: archiveTargetId,
      tone: sessionProgress.terminalOnly && !reportUnitCount
        ? 'done'
        : (reportDraftDirty || sessionFactsDirty || confirmationsDirty || versionConflict
          ? 'warning'
          : (!reportUnitCount || pendingReviewCount
          ? 'idle'
          : (pendingArchiveCount ? (pendingConfirmationCount ? 'warning' : 'ready') : 'done'))),
      icon: <ImportOutlined />,
    },
    {
      key: 'bind',
      label: '材料归属',
      count: assignments.length + unmatched.length,
      statusText: assignments.length || unmatched.length ? '待人工处理' : '无待办',
      detail: '待分类/待归属材料',
      tab: 'evidence',
      targetId: bindTargetId,
      tone: assignments.length || unmatched.length ? 'warning' : 'done',
      icon: <LinkOutlined />,
    },
  ];

  function selectTodoItem(item) {
    setInterviewActiveTab(item.tab);
    if (item.targetId && typeof window !== 'undefined' && typeof document !== 'undefined') {
      window.setTimeout(() => {
        const target = document.getElementById(item.targetId);
        if (!target) return;
        const reduceMotion = typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        if (typeof target.focus === 'function') target.focus({ preventScroll: true });
      }, 0);
    }
  }

  function selectWorkspaceTab(key) {
    setInterviewActiveTab(key);
    if (key !== 'start' || typeof window === 'undefined' || typeof document === 'undefined') return;
    window.requestAnimationFrame(() => {
      const launcher = document.getElementById('candidate-interview-launcher');
      launcher?.scrollIntoView({ behavior: 'auto', block: 'start' });
    });
  }

  function bindUnmatched(row) {
    if (busyKey) return false;
    modal.confirm({
      title: '确认绑定这条未匹配录音？',
      content: (
        <div>
          <p>录音：{recordTitle(row)}（ID {recordId(row)}）</p>
          <p>候选人：{candidate?.name || `ID ${candidateId}`} · 岗位：{candidate?.job_name || candidate?.jobName || `ID ${jobId}`}</p>
          <p>轮次：未设置（此旧录音绑定入口只绑定候选人与岗位，不写入面试轮次）</p>
          <p>绑定后该录音及其转写、报告会计入当前候选人的面试证据，请先核对身份和岗位。</p>
        </div>
      ),
      okText: '确认绑定',
      cancelText: '取消',
      onOk: () => run(
        `bind:${recordId(row)}`,
        () => api.bindInterviewRecording(recordId(row), candidateId, jobId),
        '录音已绑定到候选人',
      ),
    });
    return true;
  }

  function classifyAssignment(row, purpose) {
    if (busyKey) return false;
    const candidatePurpose = purpose === 'candidate_interview';
    modal.confirm({
      title: candidatePurpose ? '确认分类为候选人面试？' : '确认分类为岗位画像访谈？',
      content: (
        <div>
          <p>材料：ID {row.id} · {row.source_type === 'lark_minutes' ? '线上妙记' : '线下录音'}</p>
          <p>岗位：{candidate?.job_name || candidate?.jobName || `ID ${jobId}`}</p>
          <p>候选人/轮次：尚未归属，分类完成后仍须在下一步人工确认。</p>
          <p>{candidatePurpose ? '分类后材料将进入候选人归属流程，尚不会自动绑定候选人。' : '分类后材料会进入岗位画像证据链，不会作为候选人面试报告依据。'}</p>
        </div>
      ),
      okText: '确认分类',
      cancelText: '取消',
      onOk: () => run(
        `classify:${row.id}:${purpose}`,
        () => api.classifyInterviewAssignment(
          row.id,
          purpose,
          row.version,
          candidatePurpose ? 'manual_candidate_classification' : 'manual_profile_classification',
          `ui-classify-${row.id}-${Date.now()}`,
        ),
        candidatePurpose ? '已标记为候选人面试，等待归属' : '已保留在岗位画像访谈链路',
      ),
    });
    return true;
  }

  function assignToCurrentCandidate(row) {
    const round = Number(selectedAssignmentSession?.round);
    if (!selectedAssignmentSession || !Number.isInteger(round) || round <= 0) {
      message.warning('请先选择一个已创建的面试轮次。');
      return false;
    }
    const expectedFormat = row.source_type === 'offline_recording' ? 'offline' : 'online';
    if (sessionInterviewFormat(selectedAssignmentSession).value !== expectedFormat) {
      message.warning(`这份材料需要选择${expectedFormat === 'offline' ? '线下' : '线上'}面试轮次。`);
      return false;
    }
    if (busyKey) return false;
    modal.confirm({
      title: '确认材料归属与面试轮次？',
      content: (
        <div>
          <p>材料：ID {row.id}</p>
          <p>候选人：{candidate?.name || `ID ${candidateId}`} · 岗位：{candidate?.job_name || candidate?.jobName || `ID ${jobId}`} · 第 {round} 轮（记录 {selectedAssignmentSession.id}）</p>
          <p>确认后该材料将参与当前候选人的转写、事实复核和正式面试报告；错绑会污染候选人证据链。</p>
        </div>
      ),
      okText: '确认归属',
      cancelText: '取消',
      onOk: () => run(
        `assign:${row.id}`,
        () => api.assignInterviewMaterial(
          row.id,
          candidateId,
          jobId,
          round,
          row.version,
          row.classification === 'assigned' ? 'manual_correction' : 'manual_assignment',
          `ui-assign-${row.id}-${Date.now()}`,
        ),
        '材料已人工归属到当前候选人',
      ),
    });
    return true;
  }

  function renderSessionTimelineItem(session, index) {
    const selectedMaterialIds = selectedSessionMaterials[session.id] || [];
    const interviewFormat = sessionInterviewFormat(session);
    const offlineMaterial = (session.materials || []).find((item) => item.interview_recording_id);
    const linkedRecording = offlineMaterial
      ? records.find((item) => Number(recordId(item)) === Number(offlineMaterial.interview_recording_id))
      : null;
    if (linkedRecording) {
      return (
        <div
          key={`session-${session.id}`}
          id={`candidate-interview-session-${session.id}`}
          className="interview-session-timeline-item"
          tabIndex={-1}
        >
          <Space wrap style={{ marginBottom: 8 }}>
            <Tag color="blue">第 {session.round} 轮</Tag>
            <Tag color={interviewFormat.color}>{interviewFormat.label}</Tag>
            <Tag>{interviewStatusLabel(session.status)}</Tag>
            <Text type="secondary">面试轮次记录 {session.id}</Text>
          </Space>
          <LifecycleManagementCard
            session={session}
            readOnly={readOnly}
            localJob={localJobKnown ? localJob : null}
            busyKey={busyKey}
            activeHold={lifecycleHolds[String(session.id)]}
            lifecycleState={lifecycleStates[String(session.id)]}
            statusError={lifecycleStatusErrors[String(session.id)]}
            lastResult={lifecycleResults[String(session.id)]}
            onWithdraw={withdrawLifecycle}
            onClose={closeLifecycle}
            onApplyHold={applyLifecycleHold}
            onReleaseHold={releaseLifecycleHold}
            onPreviewDeletion={previewLifecycleDeletion}
          />
          <SessionMaterialSelector
            session={session}
            selectedIds={selectedMaterialIds}
            readOnly={readOnly}
            onChange={(values) => setSelectedSessionMaterials((current) => ({ ...current, [session.id]: values }))}
          />
          {renderRecordingCard(linkedRecording, index, session, selectedMaterialIds)}
        </div>
      );
    }
    const llmAvailable = !!(
      llmConfigStatus
      && llmConfigStatus.enabled
      && llmConfigStatus.apiKeyConfigured
      && llmConfigStatus.model
      && llmConfigStatus.modelVerified === true
    );
    const llmUnavailableReason = llmConfigLoadError
      ? 'AI 配置状态暂不可读，请重新读取'
      : !llmAvailable ? '请先在设置页启用 Provider、注入 Key 并刷新验证模型' : '';
    return (
      <div
        key={`session-${session.id}`}
        id={`candidate-interview-session-${session.id}`}
        className="interview-session-timeline-item"
        tabIndex={-1}
      >
        <LifecycleManagementCard
          session={session}
          readOnly={readOnly}
          localJob={localJobKnown ? localJob : null}
          busyKey={busyKey}
          activeHold={lifecycleHolds[String(session.id)]}
          lifecycleState={lifecycleStates[String(session.id)]}
          statusError={lifecycleStatusErrors[String(session.id)]}
          lastResult={lifecycleResults[String(session.id)]}
          onWithdraw={withdrawLifecycle}
          onClose={closeLifecycle}
          onApplyHold={applyLifecycleHold}
          onReleaseHold={releaseLifecycleHold}
          onPreviewDeletion={previewLifecycleDeletion}
        />
          <SessionOnlyReportCard
            session={session}
            report={sessionReports[session.id]}
            reportMeta={sessionReportMeta[session.id]}
            reportLoadError={sessionReportLoadErrors[String(session.id)]}
            facts={sessionFacts[session.id]}
          llmAvailable={llmAvailable}
          llmUnavailableReason={llmUnavailableReason}
          selectedMaterialIds={selectedMaterialIds}
          readOnly={readOnly}
          busyKey={busyKey}
          editingId={editingId}
          draft={draft}
          factsDirty={draftMapEntryChanged(sessionFacts, sessionFactsBaseline, session.id)}
          onPreview={() => requestLlmPreview({ session, materialIds: selectedMaterialIds })}
          onEdit={startSessionEdit}
          onDraft={setDraft}
          onSave={() => saveSessionReport(session)}
          onMaterialsChange={(values) => setSelectedSessionMaterials((current) => ({ ...current, [session.id]: values }))}
          onFactsChange={(items) => updateSessionFacts(session.id, items)}
            onFactsSave={(items) => saveSessionFacts(session, items)}
            onConfirm={() => confirmSessionReport(session)}
            onRetryReport={requestRefresh}
            onManualNoteChanged={requestRefresh}
            onStructuredSave={(form) => saveStructuredSessionReport(session, form)}
          />
      </div>
    );
  }

  function renderRecordingCard(record, index, session = null, selectedMaterialIds = []) {
    const sessionId = session && session.id;
    const id = recordId(record) || `record-${index}`;
    const llmAvailable = !!(
      llmConfigStatus
      && llmConfigStatus.enabled
      && llmConfigStatus.apiKeyConfigured
      && llmConfigStatus.model
      && llmConfigStatus.modelVerified === true
    );
    const llmUnavailableReason = !llmConfigStatus
      ? 'AI 配置状态不可读，可继续使用人工结构化复盘'
      : !llmConfigStatus.enabled
        ? 'AI 通道已关闭，请先在设置页人工启用'
        : !llmConfigStatus.apiKeyConfigured
          ? '当前应用会话未配置 API Key'
          : !llmConfigStatus.model
            ? '请先刷新并选择 GPT / Claude / DeepSeek 模型'
            : llmConfigStatus.modelVerified !== true
              ? '当前模型未经本次会话服务端列表验证，请重新刷新模型'
              : '';
    return (
      <RecordingCard
        key={id}
        record={record}
        sessionId={sessionId}
        domId={recordDomId(record, index, 'review')}
        report={reports[recordId(record)]}
        reportMeta={reportMeta[recordId(record)]}
        reportLoadError={reportLoadErrors[String(recordId(record))]}
        llmAvailable={llmAvailable}
        llmUnavailableReason={llmUnavailableReason}
        transcript={transcripts[recordId(record)]}
        confirmations={confirmations[recordId(record)]}
        confirmationsDirty={draftMapEntryChanged(confirmations, confirmationsBaseline, recordId(record))}
        strictConfirmations={reports[recordId(record)]?.schema_version === 'interview_report_v1'}
        confirmationLoadError={confirmationLoadErrors[String(recordId(record))]}
        showEvidence={false}
        readOnly={readOnly}
        busyKey={busyKey}
        editingId={editingId}
        draft={draft}
        onConfirm={(row) => confirmRecordingReport(row, session)}
        onCopy={copyTalkTrack}
        onEdit={startEdit}
        onDraft={setDraft}
        onSave={saveReport}
        onLlmPreview={() => requestLlmPreview({ record, session, materialIds: selectedMaterialIds })}
        onConfirmationsChange={updateConfirmations}
        onConfirmationsSave={saveConfirmations}
        onRetryConfirmations={requestRefresh}
        onRetryReport={requestRefresh}
      />
    );
  }

  function renderEvidenceCard(record, index) {
    const id = recordId(record) || `evidence-${index}`;
    return (
      <RecordingEvidenceCard
        key={id}
        record={record}
        domId={recordDomId(record, index, 'evidence')}
        transcript={transcripts[recordId(record)]}
        transcriptLoadError={transcriptLoadErrors[String(recordId(record))]}
        onCopy={copyTalkTrack}
        onRetry={requestRefresh}
      />
    );
  }

  function renderUnmatchedRow(record, index) {
    const id = recordId(record) || `unmatched-${index}`;
    return (
      <UnmatchedRow
        key={id}
        record={record}
        domId={recordDomId(record, index, 'unmatched')}
        readOnly={readOnly}
        busyKey={busyKey}
        onBind={bindUnmatched}
      />
    );
  }

  const sessionRecordingIds = new Set(
    sessions.flatMap((session) => (session.materials || []).map((item) => Number(item.interview_recording_id))).filter(Boolean),
  );
  const legacyOnlyRecords = records.filter((record) => !sessionRecordingIds.has(Number(recordId(record))));
  const contextIsCurrent = !!candidateId && loadedCandidateId === String(candidateId);
  const initialLoadPending = !!candidateId && !contextIsCurrent && !error;
  const initialLoadFailed = !!candidateId && !contextIsCurrent && !!error;
  const orderedSessions = orderedCandidateSessions(sessions);
  const currentSessionId = orderedSessions[0] ? String(orderedSessions[0].id) : '';
  const sessionWorkspaceItems = orderedSessions.map((session, index) => ({
    key: String(session.id),
    label: (
      <Space wrap>
        <strong>{candidate?.name || candidateId || '候选人'} · 第 {session.round} 轮</strong>
        <Tag color={String(session.id) === currentSessionId ? 'blue' : 'default'}>
          {String(session.id) === currentSessionId ? '当前面试轮次' : '历史面试轮次'}
        </Tag>
        <Tag>{session.scheduled_at ? fmtTime(session.scheduled_at) : fmtTime(session.created_at)}</Tag>
        <Text type="secondary">当前待办：{sessionActionLabel(session)}</Text>
      </Space>
    ),
    children: renderSessionTimelineItem(session, index),
  }));
  const aiAvailabilityNotice = llmConfigLoadError ? (
    <Alert
      type="warning"
      showIcon
      message="可选 AI 配置状态暂不可读"
      description={`人工复盘、事实确认和入档仍可继续；不会把读取失败当作未配置，也不会自动重试：${llmConfigLoadError}`}
      action={<Space wrap><Button size="small" icon={<ReloadOutlined />} onClick={requestRefresh}>重新读取</Button>{onOpenSettings && <Button size="small" onClick={openInterviewAiStatusSettings}>查看 AI 设置</Button>}</Space>}
    />
  ) : (!llmConfigStatus?.enabled || !llmConfigStatus?.apiKeyConfigured || !llmConfigStatus?.model || llmConfigStatus?.modelVerified !== true) ? (
    <Alert
      type="info"
      showIcon
      message="AI 草稿是可选动作，当前不可用"
      description="人工结构化复盘、关键事实核对和报告确认仍是完整主旅程；JSON 仅用于高级导入和调试。"
      action={onOpenSettings ? <Button size="small" onClick={openInterviewAiStatusSettings}>查看 AI 设置</Button> : null}
    />
  ) : null;

  const tabItems = [
    {
      key: 'prepare',
      label: <span className="interview-tab-label">面试准备</span>,
      children: (
        <div className="interview-tab-pane">
          <InterviewScriptPanel
            script={script}
            loadError={scriptLoadError}
            draft={scriptDraft}
            editing={scriptEditing}
            readOnly={readOnly}
            busyKey={busyKey}
            onGenerate={generateScript}
            onEdit={startScriptEdit}
            onDraft={setScriptDraft}
            onSave={saveScript}
            onRetry={requestRefresh}
          />
          <AssessmentInterviewEvidence
            archives={assessmentInterviewEvidence.archives}
            analyses={assessmentInterviewEvidence.analyses}
            candidateName={candidate?.name || ''}
            candidateDraft={assessmentQuestionDraft}
            loadError={assessmentEvidenceLoadError}
            onRetry={requestRefresh}
            onPrepareApprovedAiQuestions={prepareApprovedAssessmentQuestions}
            onCopyCandidateDraft={copyApprovedAssessmentQuestions}
          />
        </div>
      ),
    },
    {
      key: 'start',
      label: <span className="interview-tab-label">录音与转写</span>,
      children: (
        <div className="interview-tab-pane">
          <CandidateInterviewLauncher
            key={`${String(candidateId || '')}:${String(jobId || '')}`}
            candidate={candidate}
            jobId={jobId}
            sessions={sessions}
            readOnly={readOnly}
            readOnlyReason={readOnlyReason}
            consentRefreshToken={consentRefreshToken}
            onCompleted={load}
            onViewLatestReview={navigateToCompletedInterviewReview}
            onJobChange={setLocalJob}
            onOpenSettings={onOpenInterviewSettings}
          />
        </div>
      ),
    },
    {
      key: 'review',
      label: (
        <span className="interview-tab-label">
          当前面试轮次
          <em>{sessions.length}</em>
        </span>
      ),
      children: (
        <section className="interview-record-list interview-review-records" id="interview-review-records">
            {aiAvailabilityNotice}
            <div className="interview-list-head">
              <strong>候选人面试轮次</strong>
              <Tag color="blue">当前项默认展开</Tag>
            </div>
            {sessionWorkspaceItems.length ? (
              <Collapse
                accordion
                activeKey={expandedSessionKey || undefined}
                onChange={(key) => setExpandedSessionKey(Array.isArray(key) ? String(key[0] || '') : String(key || ''))}
                items={sessionWorkspaceItems}
              />
            ) : null}
            {legacyOnlyRecords.length ? (
              <>
                <div className="interview-list-head" style={{ marginTop: 12 }}>
                  <strong>旧录音兼容记录</strong>
                  <Tag>尚未关联面试轮次</Tag>
                </div>
                {legacyOnlyRecords.map((record, index) => renderRecordingCard(record, index, null))}
              </>
            ) : null}
            {!sessions.length && !legacyOnlyRecords.length && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已绑定面试记录" />
            )}
        </section>
      ),
    },
    {
      key: 'evidence',
      label: (
        <span className="interview-tab-label">
          材料与历史
          <em>{evidenceCount}</em>
        </span>
      ),
      children: (
        <div className="interview-evidence-workspace">
            <section className="interview-unmatched-list" id="interview-assignment-list" style={{ marginBottom: 14 }}>
              <div className="interview-list-head">
                <strong>待分类 / 待归属材料</strong>
                <Space wrap>
                  <Select
                    aria-label="待归属材料选择面试轮次"
                    value={selectedAssignmentSession ? String(selectedAssignmentSession.id) : undefined}
                    placeholder="先创建面试轮次"
                    options={assignableSessions.map((session) => ({
                      value: String(session.id),
                      label: `第 ${session.round} 轮 · ${sessionInterviewFormat(session).label} · 记录 ${session.id}`,
                    }))}
                    onChange={setAssignmentSessionId}
                    disabled={readOnly || !!busyKey}
                    style={{ minWidth: 230 }}
                  />
                  <Tag color="orange">必须人工处理</Tag>
                </Space>
              </div>
              <Alert
                type="info"
                showIcon
                message="飞书/Lark 妙记与线下录音共用人工归属入口"
                description="既有导入失败不会自动重试；材料进入本列表后，仍须人工分类并确认候选人和轮次。"
              />
              {assignments.length ? assignments.map((row) => (
                <div className="interview-unmatched-row" key={`assignment-${row.id}`}>
                  <div className="interview-unmatched-main">
                    <div className="interview-record-title">
                      <FileTextOutlined />
                      <strong>{row.source_type === 'lark_minutes' ? '线上妙记' : '线下录音'}</strong>
                      <Tag color="orange">{row.classification === 'pending_classification' ? '待分类' : '待归属'}</Tag>
                      {row.duplicate_suspect && <Tag color="gold">疑似重复</Tag>}
                    </div>
                    <Text type="secondary">
                      ID {row.id} · 来源指纹 {row.source_key_fingerprint} · {fmtTime(row.material_created_at)}
                    </Text>
                  </div>
                  <Space wrap>
                    {row.classification === 'pending_classification' && (
                      <>
                        <Button
                          size="small"
                          disabled={readOnly || !!busyKey}
                          loading={busyKey === `classify:${row.id}:candidate_interview`}
                          onClick={() => classifyAssignment(row, 'candidate_interview')}
                        >
                          候选人面试
                        </Button>
                        <Button
                          size="small"
                          disabled={readOnly || !!busyKey}
                          loading={busyKey === `classify:${row.id}:hiring_manager_profile_interview`}
                          onClick={() => classifyAssignment(row, 'hiring_manager_profile_interview')}
                        >
                          岗位画像访谈
                        </Button>
                      </>
                    )}
                    {row.classification === 'pending_assignment' && (
                      <Button
                        type="primary"
                        size="small"
                        icon={<LinkOutlined />}
                        disabled={readOnly || !!busyKey}
                        loading={busyKey === `assign:${row.id}`}
                        onClick={() => assignToCurrentCandidate(row)}
                      >
                        归属当前候选人
                      </Button>
                    )}
                  </Space>
                </div>
              )) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前岗位没有待处理材料" />
              )}
            </section>
            <div className="interview-import-row">
              <Button
                ref={summaryImportTriggerRef}
                icon={<ImportOutlined />}
                disabled={readOnly || !!busyKey || typeof api.selectInterviewRecordingSummary !== 'function'}
                loading={busyKey === 'import-summary'}
                onClick={importLegacySummaryFromPicker}
              >
                选择旧 summary.json 并导入
              </Button>
              <Text type="secondary">使用主进程原生文件选择；本页不显示也不接受本机路径文本。</Text>
            </div>
            {summaryImportError && <Alert type="error" showIcon message="旧录音摘要导入失败" description={summaryImportError} />}
            {typeof api.selectInterviewRecordingSummary !== 'function' && (
              <Alert
                type="info"
                showIcon
                message="旧录音原生选择器等待主进程安全接线"
                description="现有录音、转写和飞书/Lark 妙记材料仍可查看与人工归属；不会降级为手输路径。"
              />
            )}
            <div className="interview-record-grid">
              <section className="interview-record-list">
                <div className="interview-list-head">
                  <strong>当前候选人证据</strong>
                  <Tag color="cyan">全文/路径</Tag>
                </div>
                {records.length ? records.map(renderEvidenceCard) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无证据材料" />
                )}
              </section>

              <section className="interview-unmatched-list" id="interview-unmatched-list">
                <div className="interview-list-head">
                  <strong>未匹配录音</strong>
                  <Tag color="orange">待匹配</Tag>
                </div>
                {unmatched.length ? unmatched.map(renderUnmatchedRow) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无未匹配录音" />
                )}
              </section>
            </div>
        </div>
      ),
    },
  ];
  const primaryTabItems = ['review', 'prepare', 'start', 'evidence']
    .map((key) => tabItems.find((item) => item.key === key))
    .filter(Boolean);

  return (
    <section
      id="candidate-interview-ai-return-target"
      className="interview-review-panel"
      tabIndex={-1}
    >
      <div className="interview-review-head">
        <div>
          <div className="interview-review-title">
            <FileTextOutlined />
            <span>面试工作台</span>
            <Tag bordered={false} className="interview-context-tag">HR 主流程</Tag>
          </div>
          <Text type="secondary">{candidate.name || candidateId || '未命名候选人'}</Text>
        </div>
        <Tooltip title={readOnly ? '刷新只读面试历史' : '刷新录音记录'}>
          <Button
            aria-label={readOnly ? '刷新只读面试历史' : '刷新录音记录'}
            icon={<ReloadOutlined aria-hidden="true" />}
            loading={loading}
            onClick={requestRefresh}
          />
        </Tooltip>
      </div>

      {readOnly && <Alert type="warning" showIcon message="只读模式下已禁用绑定、确认和保存动作。" />}
      {localJobLoadError && <Alert type="warning" showIcon message={localJobKnown ? '最新录音任务状态刷新失败，继续显示上次成功结果' : '录音任务状态未知'} description={localJobLoadError} />}
      {versionConflict && (
        <Alert
          type={versionConflict.status === 'recovered' ? 'success' : 'error'}
          showIcon
          message={versionConflict.status === 'recovered' ? '已重新读取服务端最新版本' : '面试数据版本冲突，本次操作未写入'}
          description={versionConflict.status === 'recovered'
            ? (versionConflict.hasLocalChanges
              ? '本地未保存修改已保留；请核对服务端最新内容后重新提交。'
              : '请重新执行刚才的保存或确认操作。')
            : [
              versionConflict.hasLocalChanges
                ? '页面仍保留本地未保存修改；重新读取不会自动合并、保存或确认，请读取后人工核对并再次提交。'
                : '后端已拒绝旧版本写入，没有产生半写入；请重新读取后再次操作。',
              versionConflict.recoveryError,
            ].filter(Boolean).join(' ')}
          action={versionConflict.status === 'recovered' ? null : (
            <Button
              icon={<ReloadOutlined />}
              loading={versionConflict.status === 'refreshing'}
              onClick={refreshAfterVersionConflict}
            >
              重新读取服务端版本
            </Button>
          )}
        />
      )}
      {error && (
        <Alert
          type="error"
          showIcon
          message="面试复盘读取失败"
          description={contextIsCurrent
            ? `当前保留上一次成功读取的内容；本次刷新失败：${error}`
            : `当前无法确认面试记录，不会把读取失败当作空数据：${error}`}
          action={<Button icon={<ReloadOutlined />} loading={loading} onClick={requestRefresh}>重新读取</Button>}
        />
      )}
      {loading && contextIsCurrent && (
        <Text role="status" aria-live="polite" type="secondary">
          正在刷新面试资料；现有内容会保留到本次读取完成。
        </Text>
      )}
      {initialLoadPending ? (
        <InterviewReviewLoadingState label="正在读取候选人面试资料" rows={8} />
      ) : initialLoadFailed ? null : (
        <>
          {reportError && <Alert type="info" showIcon message={reportError} />}
          {transcriptError && <Alert type="warning" showIcon message={transcriptError} />}
          {confirmationError && <Alert type="info" showIcon message={confirmationError} />}
          <InterviewStatusPanel
            state={workflowState}
            summary={workflowSummary}
          />

          <InterviewTodoStrip
            items={todoItems}
            onSelect={selectTodoItem}
          />

          <Tabs
            className="interview-workflow-tabs"
            activeKey={activeTab}
            onChange={selectWorkspaceTab}
            items={primaryTabItems}
          />
        </>
      )}
      <LlmSendPreviewModal
        preview={llmPreview}
        busy={busyKey === 'llm-analyze'}
        cancelling={llmCancelling}
        onAnalyze={analyzeLlmPreview}
        onCancelRequest={cancelLlmAnalysis}
        onClose={() => {
          setLlmPreview(null);
          setLlmTarget(null);
        }}
        onManualFallback={useManualReportFallback}
      />
      <ExternalAiFirstUsePrompt
        open={aiFirstUseOpen}
        capability="interview_review"
        material={pendingAiPreview?.materialIds?.length
          ? `HR 本次勾选的 ${pendingAiPreview.materialIds.length} 份面试材料`
          : undefined}
        readError={aiFirstUseError}
        onEnable={openInterviewAiSettings}
        onManual={continueInterviewReviewManually}
        onClose={continueInterviewReviewManually}
      />
    </section>
  );
}
