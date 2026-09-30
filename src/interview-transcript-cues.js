const ASR_TRANSCRIPT_SCHEMA_VERSION = 'hrboss_asr_transcript_v1';
const ASR_TRANSCRIPT_ACCURACY_LABEL = 'ASR 转写草稿（未经逐字复核）';
const LOW_CONFIDENCE_THRESHOLD = 0.65;
const MAX_CUES = 20000;
const MAX_CUE_TEXT_CHARS = 4000;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampConfidence(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Number(Math.min(1, Math.max(0, number)).toFixed(4));
}

function parseTimestampMs(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  const text = String(value || '').trim();
  const clock = text.match(/^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (clock) {
    return (((Number(clock[1]) * 60 + Number(clock[2])) * 60 + Number(clock[3])) * 1000)
      + Number(clock[4]);
  }
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text));
  return null;
}

function timestampPair(value) {
  if (Array.isArray(value) && value.length >= 2) {
    return [parseTimestampMs(value[0]), parseTimestampMs(value[1])];
  }
  if (value && typeof value === 'object') {
    return [
      parseTimestampMs(value.from ?? value.start ?? value.start_ms),
      parseTimestampMs(value.to ?? value.end ?? value.end_ms),
    ];
  }
  return [null, null];
}

function normalizeCueText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CUE_TEXT_CHARS);
}

function maskRange(value) {
  return '█'.repeat([...String(value)].length);
}

function redactTranscriptForExternalAi(value) {
  let result = String(value || '');
  const preserveLengthReplace = (pattern) => {
    result = result.replace(pattern, (match) => maskRange(match));
  };
  preserveLengthReplace(/(?<!\d)1[3-9]\d{9}(?!\d)/g);
  preserveLengthReplace(/(?<!\d)\d{17}[\dXx](?!\d)/g);
  preserveLengthReplace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  result = result.replace(/((?:微信|wechat|weixin|wx)\s*[:：]?\s*)([A-Za-z][-_A-Za-z0-9]{5,19})/gi,
    (_match, prefix, identifier) => `${prefix}${maskRange(identifier)}`);
  return result;
}

function average(values) {
  const usable = values.map(finiteNumber).filter((value) => value !== null);
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function cueConfidence(segment) {
  const direct = clampConfidence(
    segment.confidence
    ?? segment.probability
    ?? segment.prob
    ?? segment.avg_probability,
  );
  if (direct !== null) return { confidence: direct, basis: 'segment_probability' };

  const tokens = Array.isArray(segment.tokens) ? segment.tokens : [];
  const tokenProbability = clampConfidence(average(tokens.map((token) => (
    token && (token.p ?? token.probability ?? token.prob ?? token.confidence)
  ))));
  if (tokenProbability !== null) return { confidence: tokenProbability, basis: 'token_probability' };

  const avgLogprob = finiteNumber(segment.avg_logprob ?? segment.avgLogprob);
  if (avgLogprob !== null) {
    return {
      confidence: clampConfidence(Math.exp(Math.min(0, avgLogprob))),
      basis: 'average_log_probability',
    };
  }
  return { confidence: null, basis: 'unavailable' };
}

function normalizeWhisperSegments(value) {
  let payload = value;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return []; }
  }
  const segments = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload && payload.transcription)
      ? payload.transcription
      : (Array.isArray(payload && payload.segments) ? payload.segments : []));
  return segments.slice(0, MAX_CUES).map((segment) => {
    if (!segment || typeof segment !== 'object') return null;
    let [startMs, endMs] = timestampPair(segment.timestamps);
    if (startMs === null || endMs === null) {
      startMs = parseTimestampMs(segment.start_ms ?? segment.start);
      endMs = parseTimestampMs(segment.end_ms ?? segment.end);
      // OpenAI-style Whisper JSON represents start/end in seconds.
      if (startMs !== null && endMs !== null
          && !Object.hasOwn(segment, 'start_ms') && !Object.hasOwn(segment, 'end_ms')) {
        startMs = Math.round(Number(segment.start) * 1000);
        endMs = Math.round(Number(segment.end) * 1000);
      }
    }
    const text = normalizeCueText(segment.text ?? segment.content);
    if (!text || !Number.isInteger(startMs) || !Number.isInteger(endMs)
        || startMs < 0 || endMs <= startMs) return null;
    const confidence = cueConfidence(segment);
    const noSpeechProbability = clampConfidence(
      segment.no_speech_prob ?? segment.noSpeechProbability,
    );
    const lowConfidence = confidence.confidence !== null
      ? confidence.confidence < LOW_CONFIDENCE_THRESHOLD
      : (noSpeechProbability !== null && noSpeechProbability >= 0.5);
    return {
      start_ms: startMs,
      end_ms: endMs,
      text,
      confidence: confidence.confidence,
      confidence_basis: confidence.basis,
      confidence_status: confidence.confidence === null && noSpeechProbability === null
        ? 'unknown'
        : (lowConfidence ? 'low' : 'usable'),
      low_confidence: lowConfidence,
    };
  }).filter(Boolean);
}

function parseSrtCues(value) {
  const blocks = String(value || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    if (cues.length >= MAX_CUES) break;
    const lines = block.split('\n').map((line) => line.trim());
    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex < 0) continue;
    const match = lines[timeIndex].match(
      /^(\d{1,3}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{3})/,
    );
    if (!match) continue;
    const startMs = parseTimestampMs(match[1]);
    const endMs = parseTimestampMs(match[2]);
    const text = normalizeCueText(lines.slice(timeIndex + 1).join(' '));
    if (!text || !Number.isInteger(startMs) || !Number.isInteger(endMs) || endMs <= startMs) continue;
    cues.push({
      start_ms: startMs,
      end_ms: endMs,
      text,
      confidence: null,
      confidence_basis: 'unavailable',
      confidence_status: 'unknown',
      low_confidence: false,
    });
  }
  return cues;
}

function canonicalCue(cue, index) {
  return {
    cue_id: `cue-${String(index + 1).padStart(6, '0')}`,
    start_ms: cue.start_ms,
    end_ms: cue.end_ms,
    text: cue.text,
    confidence: cue.confidence,
    confidence_basis: cue.confidence_basis,
    confidence_status: cue.confidence_status,
    low_confidence: cue.low_confidence === true,
  };
}

function buildCanonicalTranscript({ whisperJson, srt, engine = 'whisper.cpp' } = {}) {
  const whisperCues = normalizeWhisperSegments(whisperJson);
  const srtCues = parseSrtCues(srt);
  const source = whisperCues.length ? whisperCues : srtCues;
  if (!source.length) throw new Error('ASR output does not contain any timestamped transcript cues');
  const cues = source.map(canonicalCue);
  return {
    schema_version: ASR_TRANSCRIPT_SCHEMA_VERSION,
    source_kind: 'asr',
    engine: String(engine || 'whisper.cpp').slice(0, 120),
    review_status: 'unreviewed',
    accuracy_label: ASR_TRANSCRIPT_ACCURACY_LABEL,
    cue_count: cues.length,
    low_confidence_cue_count: cues.filter((cue) => cue.low_confidence).length,
    cues,
  };
}

function readCanonicalTranscript(value) {
  let payload = value;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return null; }
  }
  if (!payload || payload.schema_version !== ASR_TRANSCRIPT_SCHEMA_VERSION
      || !Array.isArray(payload.cues)) return null;
  const cues = payload.cues.slice(0, MAX_CUES).map((cue, index) => {
    const text = normalizeCueText(cue && cue.text);
    const startMs = parseTimestampMs(cue && cue.start_ms);
    const endMs = parseTimestampMs(cue && cue.end_ms);
    if (!text || !Number.isInteger(startMs) || !Number.isInteger(endMs) || endMs <= startMs) return null;
    const confidence = clampConfidence(cue.confidence);
    const lowConfidence = cue.low_confidence === true
      || cue.confidence_status === 'low'
      || (confidence !== null && confidence < LOW_CONFIDENCE_THRESHOLD);
    return {
      cue_id: /^cue-\d{6}$/.test(String(cue.cue_id || ''))
        ? String(cue.cue_id)
        : `cue-${String(index + 1).padStart(6, '0')}`,
      start_ms: startMs,
      end_ms: endMs,
      text,
      confidence,
      confidence_basis: String(cue.confidence_basis || (confidence === null ? 'unavailable' : 'segment_probability')),
      confidence_status: confidence === null && cue.confidence_status !== 'low'
        ? 'unknown'
        : (lowConfidence ? 'low' : 'usable'),
      low_confidence: lowConfidence,
    };
  }).filter(Boolean);
  if (!cues.length) return null;
  return {
    schema_version: ASR_TRANSCRIPT_SCHEMA_VERSION,
    source_kind: 'asr',
    engine: String(payload.engine || 'whisper.cpp'),
    review_status: payload.review_status === 'reviewed' ? 'reviewed' : 'unreviewed',
    accuracy_label: payload.review_status === 'reviewed'
      ? 'HR 已复核转写'
      : ASR_TRANSCRIPT_ACCURACY_LABEL,
    cue_count: cues.length,
    low_confidence_cue_count: cues.filter((cue) => cue.low_confidence).length,
    cues,
  };
}

module.exports = {
  ASR_TRANSCRIPT_ACCURACY_LABEL,
  ASR_TRANSCRIPT_SCHEMA_VERSION,
  LOW_CONFIDENCE_THRESHOLD,
  buildCanonicalTranscript,
  parseSrtCues,
  parseTimestampMs,
  redactTranscriptForExternalAi,
  readCanonicalTranscript,
};
