const assert = require('assert');
const {
  ASR_TRANSCRIPT_ACCURACY_LABEL,
  buildCanonicalTranscript,
  parseSrtCues,
  readCanonicalTranscript,
} = require('./interview-transcript-cues');
const {
  buildEvidenceUnits,
  buildPreview,
  buildChatBody,
} = require('./f009-interview-llm');
const {
  REPORT_DISCLAIMER,
  validateInterviewReport,
} = require('./interview-report-v1');

const whisperJson = {
  transcription: [
    {
      timestamps: { from: '00:00:01,200', to: '00:00:04,500' },
      text: '我负责过三次直播项目，主要做投放复盘。',
      tokens: [{ p: 0.93 }, { p: 0.87 }],
    },
    {
      timestamps: { from: '00:00:05,000', to: '00:00:08,200' },
      text: '期望薪资可能是二十五K。',
      tokens: [{ p: 0.22 }, { p: 0.31 }],
    },
  ],
};
const canonical = buildCanonicalTranscript({ whisperJson, engine: 'synthetic-whisper' });
assert.equal(canonical.schema_version, 'hrboss_asr_transcript_v1');
assert.equal(canonical.review_status, 'unreviewed');
assert.equal(canonical.accuracy_label, ASR_TRANSCRIPT_ACCURACY_LABEL);
assert.equal(canonical.cue_count, 2);
assert.equal(canonical.low_confidence_cue_count, 1);
assert.deepEqual(
  canonical.cues.map((cue) => [cue.cue_id, cue.start_ms, cue.end_ms, cue.confidence_status]),
  [
    ['cue-000001', 1200, 4500, 'usable'],
    ['cue-000002', 5000, 8200, 'low'],
  ],
);
assert.deepEqual(readCanonicalTranscript(JSON.stringify(canonical)), canonical);

const legacySrt = `1
00:00:09,000 --> 00:00:11,500
两周可以到岗。
`;
assert.deepEqual(parseSrtCues(legacySrt).map((cue) => [cue.start_ms, cue.end_ms, cue.text]), [
  [9000, 11500, '两周可以到岗。'],
]);
assert.equal(buildCanonicalTranscript({ srt: legacySrt }).cues[0].confidence_status, 'unknown');

const materials = [{
  id: 7,
  session_id: 9,
  text: canonical.cues.map((cue) => cue.text).join('\n'),
  cues: canonical.cues,
}];
const units = buildEvidenceUnits(materials);
assert.equal(units.length, 2);
assert.deepEqual(units[0].span, { type: 'time_span', start_ms: 1200, end_ms: 4500 });
assert.equal(units[0].cueId, 'cue-000001');
assert.equal(units[0].quote, canonical.cues[0].text);
assert.equal(units[1].lowConfidence, true);

const context = {
  hard_requirements: [{ id: 'hard_requirement.salary', label: '期望月薪不高于 25K' }],
  confirmed_resume_facts: [{ id: 'resume_fact.project', label: '项目经历', value: 'HR 已确认三次直播项目' }],
  confirmed_assessments: [{
    document_id: 'assessment-synthetic-1',
    report_type: 'workplace_style',
    summary: '已确认测评摘要：偏好结构化复盘。',
  }],
};
// normalizeMinimalContext stamps summary_status so the model can tell an
// available summary from a bound-but-unsummarised assessment.
const expectedContext = {
  ...context,
  confirmed_assessments: [{
    document_id: 'assessment-synthetic-1',
    report_type: 'workplace_style',
    summary_status: 'available',
    summary: '已确认测评摘要：偏好结构化复盘。',
  }],
};
const preview = buildPreview({
  provider: 'synthetic',
  baseUrl: 'https://ai.example.test/v1',
  requestId: 'cue-synthetic-preview',
  sessionId: 9,
  materials,
  context,
  model: 'gpt-synthetic',
});
assert.deepEqual(preview.context, expectedContext);
assert.ok(preview.requestHash);
const chatPayload = JSON.parse(buildChatBody(preview).messages[1].content);
assert.deepEqual(chatPayload.minimal_context, expectedContext);
assert.equal(chatPayload.allowed_evidence_refs[0].cue_id, 'cue-000001');
assert.equal(chatPayload.allowed_evidence_refs[0].quote, canonical.cues[0].text);

const cueRef = {
  material_id: 7,
  cue_id: 'cue-000001',
  span: { type: 'time_span', start_ms: 1200, end_ms: 4500 },
  quote: canonical.cues[0].text,
};
const report = {
  schema_version: 'interview_report_v1',
  summary: {
    id: 'summary.main',
    status: 'supported',
    text: '候选人提供了一项项目经历。',
    evidence_refs: [cueRef],
  },
  match_points: [],
  risks: [],
  unknowns: [],
  followup_questions: [{
    id: 'question.salary',
    status: 'supported',
    question: '请人工复核低置信薪资数字。',
    evidence_refs: [{
      material_id: 7,
      cue_id: 'cue-000002',
      span: { type: 'time_span', start_ms: 5000, end_ms: 8200 },
      quote: canonical.cues[1].text,
    }],
  }],
  key_facts: [],
  hard_requirements: [{
    id: 'hard_requirement.salary',
    label: '期望月薪不高于 25K',
    status: 'unknown',
    text: '薪资 cue 置信信号偏低，不能直接确认。',
    reason_code: 'unclear',
    evidence_refs: [],
  }],
  competency_evidence: [{
    id: 'competency.project',
    label: '项目交付能力',
    status: 'supported',
    text: '候选人描述了直播项目与投放复盘。',
    evidence_refs: [cueRef],
  }],
  motivation: {
    id: 'motivation.main',
    label: '求职动机',
    status: 'unknown',
    text: '材料未提及。',
    reason_code: 'not_mentioned',
    evidence_refs: [],
  },
  contradictions: [],
  assessment_cross_checks: [{
    id: 'assessment_cross_check.1',
    assessment_document_id: 'assessment-synthetic-1',
    label: '工作风格测评交叉验证',
    status: 'consistent',
    text: '面试中描述了结构化复盘，与已确认测评摘要一致。',
    evidence_refs: [cueRef],
  }, {
    id: 'assessment_cross_check.2',
    assessment_document_id: 'assessment-synthetic-2',
    label: '未覆盖测评',
    status: 'not_covered',
    text: '面试材料未涉及该维度。',
    reason_code: 'not_mentioned',
    evidence_refs: [],
  }, {
    id: 'assessment_cross_check.3',
    assessment_document_id: 'assessment-synthetic-3',
    label: '冲突测评',
    status: 'conflict',
    text: '面试中给出的复盘口径与该测评摘要存在冲突，需 HR 核实。',
    evidence_refs: [cueRef],
  }],
  ai_reference: {
    id: 'ai_reference.main',
    label: 'AI 参考分析',
    status: 'supported',
    text: '当前只有项目复盘证据，其余由 HR 继续核对。',
    evidence_refs: [cueRef],
  },
  human_confirm_required: true,
  disclaimer: REPORT_DISCLAIMER,
};
const validated = validateInterviewReport(report, {
  sessionId: 9,
  resolveMaterial(materialId) {
    return materialId === 7 ? {
      session_id: 9,
      text: materials[0].text,
      time_ranges: canonical.cues.map((cue) => ({ start_ms: cue.start_ms, end_ms: cue.end_ms })),
      cues: canonical.cues,
    } : null;
  },
});
assert.equal(validated.hard_requirements[0].status, 'unknown');
assert.equal(validated.assessment_cross_checks[0].status, 'consistent');
assert.equal(validated.assessment_cross_checks[1].status, 'not_covered');
assert.equal(validated.assessment_cross_checks[2].status, 'conflict');
assert.throws(() => validateInterviewReport({
  ...report,
  summary: {
    ...report.summary,
    evidence_refs: [{ ...cueRef, quote: '伪造原文' }],
  },
}, {
  sessionId: 9,
  resolveMaterial: () => ({
    session_id: 9,
    text: materials[0].text,
    time_ranges: canonical.cues.map((cue) => ({ start_ms: cue.start_ms, end_ms: cue.end_ms })),
    cues: canonical.cues,
  }),
}), (error) => error && error.code === 'EVIDENCE_CUE_MISMATCH');

console.log('Timestamped ASR cue, low-confidence, minimal-context and report evidence checks passed.');
