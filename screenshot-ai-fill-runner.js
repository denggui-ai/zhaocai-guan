'use strict';

// Runs the external-AI field fill inside the main process.
//
// The import pipeline is a chain of spawned CLIs, but the API key lives in the
// encrypted settings store and this app deliberately exposes no read bridge for
// it. Assessment analysis already resolves that the same way — the model call
// happens in-process — so this follows that boundary rather than exporting the
// key into a subprocess environment.
//
// Operates on drafts that are already staged and awaiting review, so a failure
// here costs nothing: the drafts stand exactly as local recognition left them.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const {
  readFieldsFromScreenshot, runPool, weakFields, EXTRACTION_METHOD, DEFAULT_CONCURRENCY,
} = require('./screenshot-field-ai');

const AI_ACTOR = 'external-ai-vision';

// Only messages this app wrote itself are shown to the HR. Anything else — a
// TLS failure, a provider stack trace — can carry the URL or request detail, so
// it is counted but not repeated back.
function safeFailureReason(error) {
  return error && typeof error.code === 'string' && error.message
    ? error.message
    : '外部 AI 调用失败。';
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function pendingDrafts(database, jobId) {
  const rows = Number.isInteger(jobId) && jobId > 0
    ? database.prepare(`
      SELECT id, current_json, field_evidence_json, context_json
      FROM screenshot_ocr_draft WHERE status = 'pending_review' AND job_id = ? ORDER BY id
    `).all(jobId)
    : database.prepare(`
      SELECT id, current_json, field_evidence_json, context_json
      FROM screenshot_ocr_draft WHERE status = 'pending_review' ORDER BY id
    `).all();
  return rows.map((row) => ({
    id: row.id,
    current: parseJson(row.current_json),
    evidence: parseJson(row.field_evidence_json),
    context: parseJson(row.context_json),
  }));
}

// The screenshots stay in the folder the HR picked — the evidence batch records
// their hashes but keeps no copy — so a draft can only be re-read while that
// folder is still there. Missing files are skipped, not treated as failures.
function resolveScreenshot(draft) {
  const directory = String(draft.context.source_dir_path || '');
  const files = Array.isArray(draft.current.files) ? draft.current.files : [];
  if (!directory || !files.length) return '';
  const candidate = path.join(directory, String(files[0]));
  try {
    return fs.statSync(candidate).isFile() ? candidate : '';
  } catch {
    return '';
  }
}

// `status` and `readImageJson` both come from the runtime that holds the
// settings-page configuration, so whatever the HR saved there is what runs
// here. Reading the state from anywhere else is what made this feature look
// permanently unconfigured while the settings page said otherwise.
async function fillPendingDraftsWithAi(options = {}) {
  const database = options.database;
  const status = options.status || null;
  const readImageJson = options.readImageJson;
  const summary = {
    attempted: 0, filled: 0, corroborated: 0, failed: 0, skipped_missing_file: 0,
    skipped_reason: null, failed_reason: null,
    model: (status && status.model) || null,
    blockers: (status && status.blockers) || [],
  };
  if (!database || typeof database.prepare !== 'function') {
    summary.skipped_reason = 'database_unavailable';
    return summary;
  }
  if (!status) {
    summary.skipped_reason = 'external_ai_status_unavailable';
    return summary;
  }
  if (!status.enabled) {
    summary.skipped_reason = 'external_ai_disabled';
    return summary;
  }
  if (!status.operational) {
    summary.skipped_reason = 'external_ai_not_configured';
    return summary;
  }
  if (typeof readImageJson !== 'function') {
    summary.skipped_reason = 'ai_channel_unavailable';
    return summary;
  }
  const applyFill = options.applyFill;
  if (typeof applyFill !== 'function') {
    summary.skipped_reason = 'apply_unavailable';
    return summary;
  }
  const concurrency = Number(options.concurrency) > 0 ? Number(options.concurrency) : DEFAULT_CONCURRENCY;
  const at = options.at || new Date().toISOString();

  const targets = [];
  const approvedMaterials = Array.isArray(options.approvedMaterials)
    ? new Map(options.approvedMaterials.map((item) => [Number(item.draft_id), item]))
    : null;
  for (const draft of pendingDrafts(database, Number(options.jobId))) {
    if (approvedMaterials && !approvedMaterials.has(Number(draft.id))) continue;
    const fields = weakFields(draft.current.facts || {}, draft.evidence || {});
    if (!fields.length) continue;
    const file = resolveScreenshot(draft);
    if (!file) {
      summary.skipped_missing_file += 1;
      continue;
    }
    let approvedBytes = null;
    if (approvedMaterials) {
      const approved = approvedMaterials.get(Number(draft.id));
      approvedBytes = fs.readFileSync(file);
      const actualHash = crypto.createHash('sha256').update(approvedBytes).digest('hex');
      if (approvedBytes.length !== Number(approved.size_bytes) || actualHash !== String(approved.source_sha256 || '')) {
        const error = new Error('本次 AI 补全批准后截图材料已变化，已阻止外发。');
        error.code = 'SCREENSHOT_AI_FILL_MATERIAL_CHANGED';
        throw error;
      }
    }
    targets.push({
      draft,
      fields,
      file,
      approvedBytes,
      approvedMaterial: approvedMaterials ? approvedMaterials.get(Number(draft.id)) : null,
    });
  }
  if (approvedMaterials && targets.length !== approvedMaterials.size) {
    const error = new Error('本次 AI 补全批准后待补全草稿已变化，已阻止外发。');
    error.code = 'SCREENSHOT_AI_FILL_MATERIAL_CHANGED';
    throw error;
  }
  summary.attempted = targets.length;

  // Read concurrently, write serially. Each call costs seconds, so doing them
  // one at a time would put a 13-candidate batch back into minutes; the writes
  // stay sequential because they are synchronous SQLite transactions anyway.
  // A failure per draft is survivable — the draft stands as local recognition
  // left it — but a batch that fails on every draft has to say why, or the HR
  // sees "13 failed" with nothing to act on.
  const answers = await runPool(targets, concurrency, async (target) => {
    try {
      return await readFieldsFromScreenshot(
        (input) => readImageJson(input, target.approvedMaterial),
        target.file,
        { bytes: target.approvedBytes },
      );
    } catch (error) {
      if (!summary.failed_reason) summary.failed_reason = safeFailureReason(error);
      return null;
    }
  });

  for (let index = 0; index < targets.length; index += 1) {
    const { draft, fields, file } = targets[index];
    const answer = answers[index];
    if (!answer) {
      summary.failed += 1;
      continue;
    }
    const facts = {};
    const evidence = {};
    for (const field of fields) {
      const value = answer[field];
      if (value === null || value === undefined || String(value).trim() === '') continue;
      const text = String(value).trim();
      if ((draft.current.facts || {})[field] === text) {
        evidence[field] = { ai_corroborated: true };
        summary.corroborated += 1;
        continue;
      }
      facts[field] = text;
      evidence[field] = {
        field_key: `facts.${field}`,
        extracted_value: text,
        extraction_method: EXTRACTION_METHOD,
        confidence: null,
        source_spans: [],
        ai_source_file: path.basename(file),
      };
      summary.filled += 1;
    }
    if (!Object.keys(facts).length && !Object.keys(evidence).length) continue;
    try {
      applyFill(draft.id, { facts, evidence, actor: AI_ACTOR, at });
    } catch (error) {
      if (!summary.failed_reason) summary.failed_reason = safeFailureReason(error);
      summary.failed += 1;
    }
  }
  return summary;
}

module.exports = { AI_ACTOR, fillPendingDraftsWithAi };
