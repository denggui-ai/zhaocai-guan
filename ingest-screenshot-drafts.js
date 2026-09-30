const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { buildScreenshotIdentity, normalizeMonthlySalary } = require('./screenshot-normalization');
const { parseResumeStructure } = require('./resume-structure');

const DATA_DIR = process.env.HRBOSS_DATA_DIR ? path.resolve(process.env.HRBOSS_DATA_DIR) : path.join(__dirname, 'data');
const DEFAULT_DRAFTS = path.join(DATA_DIR, 'import', 'screenshot-drafts.json');
const DEFAULT_STITCHED_INDEX = path.join(DATA_DIR, 'import', 'stitched-candidates', 'index.json');
const DEFAULT_OCR = path.join(DATA_DIR, 'import', 'screenshot-ocr.json');
const RUN_TYPE = '截图 OCR 草稿暂存';
const OCR_REVIEW_STATUS = Object.freeze({
  PENDING: 'pending_review',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
});
const OCR_CONFIDENCE_WARNING_THRESHOLD = 0.8;
const EDITABLE_FACT_FIELDS = new Set([
  'work_years',
  'degree',
  'age',
  'salary',
  'availability',
  'recent_focus',
  'work_experience_text',
  'education_text',
]);

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function clean(value) {
  return value === undefined || value === null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function text(value) {
  const out = clean(value);
  return out || null;
}

function readJson(file, fallback = null) {
  if (!file || !fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function hash(parts, length = 16) {
  return crypto.createHash('sha1').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, length);
}

function inferJobTitleFromOcr(ocrRows) {
  const rows = Array.isArray(ocrRows) ? ocrRows : [];
  for (const image of rows) {
    const lines = Array.isArray(image.lines) ? image.lines : [];
    const hit = lines
      .map((line) => ({ ...line, text: clean(line.text), top: Number(line.top || 0), height: Number(line.height || 0) }))
      .filter((line) => line.top >= 150 && line.top <= 330 && line.height >= 40)
      .map((line) => line.text)
      .find((line) => line.length >= 6 && !/BOSS|推荐|最新|筛选|广州|登录|安全提示/.test(line));
    if (hit) return hit;
  }
  return '';
}

function normalizeJobName(jobName, ocrRows) {
  const explicit = clean(jobName);
  if (explicit) return explicit;
  const inferred = inferJobTitleFromOcr(ocrRows);
  return inferred ? `截图导入 · ${inferred}` : '截图导入 · Boss App 候选人';
}

function stitchedByDraftId(stitchedIndex) {
  const rows = stitchedIndex && Array.isArray(stitchedIndex.rows) ? stitchedIndex.rows : [];
  const map = new Map();
  for (const row of rows) {
    if (row.draft_id) map.set(row.draft_id, row);
  }
  return map;
}

function evidenceFromManifest(manifest) {
  if (!manifest) return null;
  if (manifest.schema_version !== 'screenshot_evidence_batch_v1' || !manifest.batch_id) {
    throw new Error('截图证据 manifest 格式错误。');
  }
  const derivedByDraftId = new Map();
  const sourceSizeByHash = new Map((Array.isArray(manifest.sources) ? manifest.sources : [])
    .map((row) => [row.source_sha256, Number(row.size_bytes)]));
  for (const row of (Array.isArray(manifest.derived) ? manifest.derived : [])) {
    if (row.draft_id) derivedByDraftId.set(row.draft_id, {
      ...row,
      source_sizes: (Array.isArray(row.source_hashes) ? row.source_hashes : [])
        .map((sourceHash) => sourceSizeByHash.get(sourceHash)),
    });
  }
  return {
    batchId: manifest.batch_id,
    sourceSizeByHash,
    sourceHashes: (Array.isArray(manifest.sources) ? manifest.sources : [])
      .map((row) => row.source_sha256)
      .filter(Boolean),
    derivedByDraftId,
  };
}

function fileNames(files) {
  return (files || []).map((file) => path.basename(file));
}

function compactLines(value, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const line of String(value || '').split(/\n+/)) {
    const row = clean(line);
    if (!row || seen.has(row)) continue;
    seen.add(row);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function parseRecentFocus(facts = {}) {
  const line = compactLines(facts.recent_focus, 1)[0] || '';
  const parts = line.split(/[，,]/).map(clean).filter(Boolean);
  return {
    position: parts[0] || '',
    city: parts[1] || '',
  };
}

function buildGeekDesc(draft = {}) {
  const facts = draft.facts || {};
  const parts = [
    ...compactLines(facts.recent_focus, 2),
    ...compactLines(facts.work_experience_text, 3),
    ...compactLines(facts.education_text, 2),
  ];
  return parts.join('；');
}

function buildResumeStructure(draft = {}) {
  const facts = draft.facts || {};
  return parseResumeStructure(draft.ocr_text || '', {
    source: 'boss_app_screenshot',
    basic_hints: {
      name: draft.name,
      age: facts.age,
      degree: facts.degree,
      work_years: facts.work_years,
      salary: facts.salary,
    },
    section_texts: {
      work: facts.work_experience_text,
      education: facts.education_text,
    },
  });
}

function buildSections(draft = {}, stitchedRow = null, jobName = '', evidence = null) {
  const facts = draft.facts || {};
  const salary = normalizeMonthlySalary(facts.salary);
  const expect = parseRecentFocus(facts);
  const structure = buildResumeStructure(draft);
  return {
    source: 'boss_app_screenshot',
    screenshot_draft_id: draft.draft_id,
    screenshot_files: fileNames(draft.files),
    stitched_file: stitchedRow ? stitchedRow.stitched_file : null,
    evidence_batch_id: evidence ? evidence.batchId : null,
    source_hashes: evidence ? evidence.sourceHashes : [],
    derived_hash: evidence && evidence.derived ? evidence.derived.derived_sha256 : null,
    evidence_path: evidence && evidence.derived ? evidence.derived.relative_path : null,
    basic: [{
      ...structure.basic,
      status: clean(facts.availability),
      description: buildGeekDesc(draft),
    }],
    expect: [{
      position: expect.position || jobName.replace(/^截图导入 · /, ''),
      city: expect.city,
      salary: clean(facts.salary),
      salary_raw: salary.raw,
      salary_normalized: salary,
    }],
    work: structure.work.map((item) => ({ ...item, source: 'boss_app_screenshot' })),
    proj: structure.project.map((item) => ({ ...item, source: 'boss_app_screenshot' })),
    edu: structure.education.map((item) => ({ ...item, source: 'boss_app_screenshot' })),
    resume_structure: structure,
    // OCR 全文不是技能事实。F-002 后只能保留在待校对草稿/原始证据中，不能写入规则会读取的 skill。
    skill: [],
  };
}

function buildRawJson(draft, stitchedRow, sourceDir, importedAt, evidence = null) {
  const salary = normalizeMonthlySalary(draft.facts && draft.facts.salary);
  return JSON.stringify({
    source: 'boss_app_screenshot',
    imported_at: importedAt,
    draft_id: draft.draft_id,
    source_dir: sourceDir,
    files: draft.files || [],
    stitched_file: stitchedRow ? stitchedRow.stitched_file : null,
    evidence_batch_id: evidence ? evidence.batchId : null,
    source_hashes: evidence ? evidence.sourceHashes : [],
    derived_hash: evidence && evidence.derived ? evidence.derived.derived_sha256 : null,
    evidence_path: evidence && evidence.derived ? evidence.derived.relative_path : null,
    facts: draft.facts || {},
    normalized_facts: { salary },
    ocr_text: draft.ocr_text || '',
  });
}

function mapDraftToCandidate(draft, options) {
  const stitchedRow = options.stitchedMap.get(draft.draft_id) || null;
  const derivedEvidence = options.evidence
    ? options.evidence.derivedByDraftId.get(draft.draft_id) || null
    : null;
  const evidence = options.evidence
    ? {
      batchId: options.evidence.batchId,
      sourceHashes: derivedEvidence && Array.isArray(derivedEvidence.source_hashes)
        ? derivedEvidence.source_hashes
        : options.evidence.sourceHashes,
      derived: derivedEvidence,
    }
    : null;
  const facts = draft.facts || {};
  const structure = buildResumeStructure(draft);
  const sourceFiles = fileNames(draft.files);
  return {
    candidate: {
      job_id: options.jobId,
      geek_id: `screenshot:${options.identityKey || draft.draft_id}`,
      source: '截图导入',
      rec_position: `Boss App 截图 / ${sourceFiles.length} 张${sourceFiles.length ? ` / ${sourceFiles[0]}` : ''}`,
      name: text(draft.name),
      age: text(facts.age),
      degree: text(facts.degree),
      school: text(structure.basic.school),
      work_years: text(facts.work_years),
      salary: text(facts.salary),
      geek_desc: text(buildGeekDesc(draft)),
      raw_json: buildRawJson(draft, stitchedRow, options.sourceDir, options.importedAt, evidence),
      comm_status: '未打招呼',
      disposition_status: '新入库',
    },
    sections: buildSections(draft, stitchedRow, options.jobName, evidence),
  };
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}

function sanitizeFieldEvidence(fieldEvidence = {}) {
  return Object.fromEntries(Object.entries(fieldEvidence || {}).map(([key, value]) => {
    const trace = value && typeof value === 'object' ? value : {};
    return [key, {
      field_key: trace.field_key || (key === 'name' ? 'name' : `facts.${key}`),
      extracted_value: trace.extracted_value == null ? null : String(trace.extracted_value),
      confidence: trace.confidence != null && Number.isFinite(Number(trace.confidence)) ? Number(trace.confidence) : null,
      source_spans: (Array.isArray(trace.source_spans) ? trace.source_spans : []).map((span) => ({
        source_file: path.basename(String(span.source_file || '')),
        line_index: span.line_index != null && Number.isInteger(Number(span.line_index)) ? Number(span.line_index) : null,
        text: String(span.text || ''),
        confidence: span.confidence != null && Number.isFinite(Number(span.confidence)) ? Number(span.confidence) : null,
        bbox: span.bbox && typeof span.bbox === 'object' ? {
          left: Number(span.bbox.left || 0),
          top: Number(span.bbox.top || 0),
          width: Number(span.bbox.width || 0),
          height: Number(span.bbox.height || 0),
        } : null,
      })),
      conflict_values: [...new Set((Array.isArray(trace.conflict_values) ? trace.conflict_values : [])
        .filter((item) => item != null && String(item).trim())
        .map(String))],
      extraction_method: trace.extraction_method == null ? null : String(trace.extraction_method),
      trusted: trace.trusted === true,
      rejected_value: trace.rejected_value == null ? null : String(trace.rejected_value),
      rejected_reason: trace.rejected_reason == null ? null : String(trace.rejected_reason),
      ai_corroborated: trace.ai_corroborated === true,
      ai_source_file: trace.ai_source_file == null ? null : path.basename(String(trace.ai_source_file)),
    }];
  }));
}

function sanitizeDraft(draft = {}) {
  return {
    draft_id: String(draft.draft_id || ''),
    source: 'Boss App截图导入草稿',
    name: draft.name == null ? '' : String(draft.name).trim(),
    files: fileNames(draft.files),
    facts: Object.fromEntries([...EDITABLE_FACT_FIELDS].map((key) => [key, draft.facts && draft.facts[key] != null
      ? String(draft.facts[key]).trim()
      : null])),
    ocr_text: String(draft.ocr_text || ''),
  };
}

function buildReviewFlags(fieldEvidence) {
  const fields = [];
  for (const trace of Object.values(fieldEvidence || {})) {
    if (trace && trace.field_key === 'name' && trace.trusted !== true) {
      fields.push({ field_key: 'name', kind: 'name_evidence_untrusted' });
    }
    // A field that was read but discarded as implausible looks identical to a
    // field that was never read. Say which one happened.
    if (trace && trace.rejected_value) {
      fields.push({
        field_key: trace.field_key,
        kind: 'value_rejected',
        rejected_value: trace.rejected_value,
        reason: trace.rejected_reason || '',
      });
    }
    if (!trace || !trace.extracted_value) continue;
    if (Array.isArray(trace.conflict_values) && trace.conflict_values.length > 1) {
      fields.push({ field_key: trace.field_key, kind: 'conflict', values: trace.conflict_values });
    }
    if (!Number.isFinite(trace.confidence)) {
      fields.push({ field_key: trace.field_key, kind: 'confidence_unknown' });
    } else if (trace.confidence < OCR_CONFIDENCE_WARNING_THRESHOLD && trace.ai_corroborated !== true) {
      // A second reader already agreed with this value; warning about it again
      // would send the HR to re-check something that has been checked twice.
      fields.push({ field_key: trace.field_key, kind: 'low_confidence', confidence: trace.confidence });
    }
  }
  return {
    requires_manual_review: true,
    confidence_warning_threshold: OCR_CONFIDENCE_WARNING_THRESHOLD,
    fields,
  };
}

function publicDraftRow(row) {
  if (!row) return null;
  const current = parseJson(row.current_json, {});
  const context = parseJson(row.context_json, {});
  const storedIdentity = parseJson(row.identity_json);
  return {
    id: row.id,
    draft_id: row.draft_id,
    evidence_batch_id: row.evidence_batch_id,
    job_id: row.job_id,
    job_name: row.job_name,
    status: row.status,
    original: parseJson(row.original_json, {}),
    current,
    normalized_facts: {
      salary: normalizeMonthlySalary(current.facts && current.facts.salary),
    },
    field_evidence: parseJson(row.field_evidence_json, {}),
    review_flags: parseJson(row.review_flags_json, {}),
    identity: storedIdentity && storedIdentity.content_fingerprint ? storedIdentity : {
      identity_key: row.identity_key,
      source_fingerprint: row.source_fingerprint,
      content_fingerprint: row.content_fingerprint,
      status: row.identity_status,
    },
    candidate_id: row.candidate_id,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
    name_verification: context.name_verification || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function writeReviewAudit(database, { draftId, action, before, after, actor, at }) {
  database.prepare(`
    INSERT INTO screenshot_ocr_review_audit
      (screenshot_draft_id, action, before_json, after_json, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    draftId,
    action,
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
    actor,
    at,
  );
}

function stageScreenshotOcrDraft({ draft, job, jobName, sourceDir, stitchedRow, evidence, importedAt }) {
  const database = db.conn();
  const current = sanitizeDraft(draft);
  if (!current.draft_id) throw new Error('OCR 草稿缺少 draft_id。');
  const fieldEvidence = sanitizeFieldEvidence(draft.field_evidence || {});
  const identity = buildScreenshotIdentity({
    name: current.name,
    facts: current.facts,
    sourceHashes: evidence ? evidence.sourceHashes : [],
  });
  const context = {
    source_dir_name: path.basename(String(sourceDir || '')),
    // Needed to re-read the originals later: the evidence batch records their
    // hashes but keeps no copy, and only the basename was retained before.
    source_dir_path: String(sourceDir || ''),
    stitched_row: stitchedRow || null,
    evidence: evidence ? {
      batch_id: evidence.batchId,
      source_hashes: evidence.sourceHashes,
      derived: evidence.derived || null,
    } : null,
  };
  return database.transaction(() => {
    let duplicate = null;
    if (identity.source_fingerprint) {
      duplicate = database.prepare(`
        SELECT * FROM screenshot_ocr_draft
        WHERE job_id = ? AND source_fingerprint = ?
        ORDER BY id LIMIT 1
      `).get(job.id, identity.source_fingerprint);
    }
    if (!duplicate && identity.content_identity_key) {
      duplicate = database.prepare(`
        SELECT * FROM screenshot_ocr_draft
        WHERE job_id = ? AND identity_key = ?
        ORDER BY id LIMIT 1
      `).get(job.id, identity.content_identity_key);
    }
    if (!duplicate) {
      for (const existingRow of database.prepare('SELECT * FROM screenshot_ocr_draft WHERE job_id = ? ORDER BY id').all(job.id)) {
        const storedIdentity = parseJson(existingRow.identity_json);
        const existingCurrent = parseJson(existingRow.current_json, {});
        const existingContext = parseJson(existingRow.context_json, {});
        const existingIdentity = storedIdentity && storedIdentity.content_fingerprint
          ? storedIdentity
          : buildScreenshotIdentity({
            name: existingCurrent.name,
            facts: existingCurrent.facts,
            sourceHashes: existingContext.evidence ? existingContext.evidence.source_hashes : [],
          });
        const sameSource = identity.source_fingerprint && existingIdentity.source_fingerprint === identity.source_fingerprint;
        const sameContent = identity.content_identity_key && existingIdentity.identity_key === identity.content_identity_key;
        if (sameSource || sameContent) {
          if (!existingRow.identity_key) {
            database.prepare(`
              UPDATE screenshot_ocr_draft
              SET identity_key = ?, source_fingerprint = ?, content_fingerprint = ?, identity_status = ?, identity_json = ?
              WHERE id = ?
            `).run(
              existingIdentity.identity_key,
              existingIdentity.source_fingerprint,
              existingIdentity.content_fingerprint,
              existingIdentity.status,
              JSON.stringify(existingIdentity),
              existingRow.id,
            );
          }
          duplicate = database.prepare('SELECT * FROM screenshot_ocr_draft WHERE id = ?').get(existingRow.id);
          break;
        }
      }
    }
    if (duplicate) {
      return { created: false, reusedReason: 'stable_identity', row: publicDraftRow(duplicate) };
    }

    const sameNameRows = identity.normalized_name
      ? database.prepare('SELECT * FROM screenshot_ocr_draft WHERE job_id = ? ORDER BY id').all(job.id).filter((row) => {
        const otherCurrent = parseJson(row.current_json, {});
        const storedIdentity = parseJson(row.identity_json);
        const otherIdentity = storedIdentity && storedIdentity.content_fingerprint
          ? storedIdentity
          : buildScreenshotIdentity({ name: otherCurrent.name, facts: otherCurrent.facts });
        return otherIdentity.normalized_name === identity.normalized_name
          && otherIdentity.identity_key !== identity.identity_key;
      })
      : [];
    if (sameNameRows.length) {
      identity.status = 'pending_manual_merge';
      identity.possible_duplicate_draft_ids = sameNameRows.map((row) => row.id);
      identity.reason = 'same_name_different_content';
    }
    const reviewFlags = buildReviewFlags(fieldEvidence);
    reviewFlags.identity_review = {
      status: identity.status,
      reason: identity.reason || null,
      possible_duplicate_draft_ids: identity.possible_duplicate_draft_ids || [],
    };
    if (identity.status === 'pending_manual_merge') {
      reviewFlags.fields.push({
        field_key: 'identity',
        kind: 'same_name_different_content',
        possible_duplicate_draft_ids: identity.possible_duplicate_draft_ids,
      });
    } else if (identity.status === 'insufficient') {
      reviewFlags.fields.push({ field_key: 'identity', kind: 'identity_insufficient' });
    }
    const draftKey = identity.identity_key
      ? `job:${job.id}:identity:${identity.identity_key}`
      : (evidence && evidence.batchId
        ? `${evidence.batchId}:${current.draft_id}`
        : `legacy:${hash([current.draft_id, JSON.stringify(current)])}`);
    const result = database.prepare(`
      INSERT INTO screenshot_ocr_draft (
        draft_key, draft_id, evidence_batch_id, job_id, job_name, status,
        original_json, current_json, field_evidence_json, review_flags_json, context_json,
        identity_key, source_fingerprint, content_fingerprint, identity_status, identity_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(draft_key) DO NOTHING
    `).run(
      draftKey,
      current.draft_id,
      evidence ? evidence.batchId : null,
      job.id,
      jobName,
      OCR_REVIEW_STATUS.PENDING,
      JSON.stringify(current),
      JSON.stringify(current),
      JSON.stringify(fieldEvidence),
      JSON.stringify(reviewFlags),
      JSON.stringify(context),
      identity.identity_key,
      identity.source_fingerprint,
      identity.content_fingerprint,
      identity.status,
      JSON.stringify(identity),
      importedAt,
      importedAt,
    );
    const row = database.prepare('SELECT * FROM screenshot_ocr_draft WHERE draft_key = ?').get(draftKey);
    if (result.changes) {
      writeReviewAudit(database, {
        draftId: row.id,
        action: 'created',
        before: null,
        after: { status: OCR_REVIEW_STATUS.PENDING, draft: current },
        actor: 'local-ocr',
        at: importedAt,
      });
    }
    return { created: result.changes === 1, row: publicDraftRow(row) };
  })();
}

function listScreenshotOcrDrafts(options = {}) {
  const status = options.status ? String(options.status) : '';
  if (status && !Object.values(OCR_REVIEW_STATUS).includes(status)) throw new Error('OCR 草稿状态无效。');
  const where = [];
  const values = [];
  if (status) {
    where.push('status = ?');
    values.push(status);
  }
  if (options.jobId != null && String(options.jobId).trim()) {
    where.push('job_id = ?');
    values.push(Number(options.jobId));
  }
  const rows = db.conn().prepare(`
    SELECT * FROM screenshot_ocr_draft
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC, id DESC
  `).all(...values);
  return rows.map(publicDraftRow);
}

function getScreenshotOcrDraft(id) {
  return publicDraftRow(db.conn().prepare('SELECT * FROM screenshot_ocr_draft WHERE id = ?').get(Number(id)));
}

function listScreenshotOcrReviewAudit(id) {
  return db.conn().prepare(`
    SELECT id, screenshot_draft_id, action, before_json, after_json, actor, created_at
    FROM screenshot_ocr_review_audit
    WHERE screenshot_draft_id = ?
    ORDER BY id
  `).all(Number(id)).map((row) => ({
    ...row,
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    before_json: undefined,
    after_json: undefined,
  }));
}

function requireActor(actor) {
  const value = clean(actor);
  if (!value) throw new Error('人工校对必须提供 actor。');
  return value;
}

function nameWasManuallyCorrected(row, current) {
  const original = parseJson(row.original_json, {});
  return clean(original.name) !== clean(current.name);
}

function assertConfirmableName(row, current, options = {}) {
  const currentName = clean(current.name);
  if (!currentName) throw new Error('确认失败：候选人姓名为空，请先人工校对。');
  const evidence = parseJson(row.field_evidence_json, {});
  const trace = evidence && evidence.name && typeof evidence.name === 'object' ? evidence.name : null;
  const conflicts = trace && Array.isArray(trace.conflict_values) ? trace.conflict_values.filter(Boolean) : [];
  const externalAiName = trace
    && trace.trusted !== true
    && trace.extraction_method === 'external_ai_vision_v1';
  if (externalAiName) {
    if (options.nameVerifiedByHr !== true) {
      throw new Error('确认失败：外部 AI 读取的姓名必须查看原图并勾选「我已人工核对姓名」。');
    }
    const originalAiValue = clean(trace.extracted_value);
    return {
      verified: true,
      method: originalAiValue === currentName ? 'explicit_hr_confirmation' : 'explicit_hr_correction',
      evidence_method: trace.extraction_method,
      value: currentName,
      original_ai_value: originalAiValue,
    };
  }
  if (nameWasManuallyCorrected(row, current)) return null;
  // Name the specific gap instead of a blanket "evidence insufficient". The HR
  // has to act on this message, and every reason below implies a different fix.
  const reasons = [];
  if (!trace || trace.trusted !== true) reasons.push('姓名未通过版式定位');
  if (trace && clean(trace.extracted_value) !== currentName) reasons.push('当前姓名与识别结果不一致');
  if (!trace || !Array.isArray(trace.source_spans) || !trace.source_spans.length) reasons.push('缺少截图出处');
  if (conflicts.length > 1) {
    reasons.push(`同一批截图识别出多个姓名（${conflicts.join('、')}）`);
  }
  const confidence = Number(trace && trace.confidence);
  if (!Number.isFinite(confidence)) {
    reasons.push('识别置信度缺失');
  } else if (confidence < OCR_CONFIDENCE_WARNING_THRESHOLD) {
    reasons.push(`识别置信度 ${confidence.toFixed(2)}，低于确认门槛 ${OCR_CONFIDENCE_WARNING_THRESHOLD}`);
  }
  if (reasons.length) {
    throw new Error(`确认失败：${reasons.join('；')}。请核对截图后手动修改姓名，改过即可确认。`);
  }
  return null;
}

function applyDraftChanges(current, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('changes 必须是对象。');
  const unknownTopLevel = Object.keys(changes).filter((key) => !['name', 'facts'].includes(key));
  if (unknownTopLevel.length) throw new Error(`不允许修改 OCR 草稿字段：${unknownTopLevel.join(', ')}`);
  const next = { ...current, facts: { ...(current.facts || {}) } };
  if (Object.hasOwn(changes, 'name')) next.name = changes.name == null ? '' : String(changes.name).trim();
  if (Object.hasOwn(changes, 'facts')) {
    if (!changes.facts || typeof changes.facts !== 'object' || Array.isArray(changes.facts)) throw new Error('changes.facts 必须是对象。');
    for (const [key, value] of Object.entries(changes.facts)) {
      if (!EDITABLE_FACT_FIELDS.has(key)) throw new Error(`不允许修改 OCR 事实字段：${key}`);
      next.facts[key] = value == null ? null : String(value).trim();
    }
  }
  return next;
}

function editScreenshotOcrDraft(id, { changes, actor, at = new Date().toISOString() } = {}) {
  const reviewer = requireActor(actor);
  const database = db.conn();
  return database.transaction(() => {
    const row = database.prepare('SELECT * FROM screenshot_ocr_draft WHERE id = ?').get(Number(id));
    if (!row) throw new Error('OCR 草稿不存在。');
    if (row.status !== OCR_REVIEW_STATUS.PENDING) throw new Error(`只有 pending_review 草稿可修改；当前为 ${row.status}。`);
    const before = parseJson(row.current_json, {});
    const after = applyDraftChanges(before, changes);
    if (JSON.stringify(before) === JSON.stringify(after)) return publicDraftRow(row);
    database.prepare(`
      UPDATE screenshot_ocr_draft
      SET current_json = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
      WHERE id = ? AND status = ?
    `).run(JSON.stringify(after), reviewer, at, at, row.id, OCR_REVIEW_STATUS.PENDING);
    writeReviewAudit(database, { draftId: row.id, action: 'edited', before, after, actor: reviewer, at });
    return publicDraftRow(database.prepare('SELECT * FROM screenshot_ocr_draft WHERE id = ?').get(row.id));
  })();
}

// Applies an external-AI reading to a draft that is still awaiting review.
// Deliberately does not set reviewed_by: a machine filling a field is not a
// human having reviewed it, and the confirm gate must keep asking.
function applyAiFieldFill(id, { facts = {}, evidence = {}, actor, at = new Date().toISOString() } = {}) {
  const filler = requireActor(actor);
  const database = db.conn();
  return database.transaction(() => {
    const row = database.prepare('SELECT * FROM screenshot_ocr_draft WHERE id = ?').get(Number(id));
    if (!row) throw new Error('OCR 草稿不存在。');
    if (row.status !== OCR_REVIEW_STATUS.PENDING) {
      throw new Error(`只有 pending_review 草稿可补全；当前为 ${row.status}。`);
    }
    const before = parseJson(row.current_json, {});
    const after = { ...before, facts: { ...(before.facts || {}) } };
    if (Object.hasOwn(facts, 'name')) throw new Error('姓名不接受外部 AI 补全。');
    for (const [key, value] of Object.entries(facts)) {
      if (!EDITABLE_FACT_FIELDS.has(key)) throw new Error(`不允许补全 OCR 事实字段：${key}`);
      after.facts[key] = value == null ? null : String(value).trim();
    }
    const beforeEvidence = parseJson(row.field_evidence_json, {});
    const afterEvidence = { ...beforeEvidence };
    for (const [key, patch] of Object.entries(evidence)) {
      if (key === 'name') throw new Error('姓名证据不接受外部 AI 补全。');
      afterEvidence[key] = { ...(beforeEvidence[key] || {}), ...(patch || {}) };
    }
    const unchanged = JSON.stringify(before) === JSON.stringify(after)
      && JSON.stringify(beforeEvidence) === JSON.stringify(afterEvidence);
    if (unchanged) return publicDraftRow(row);
    database.prepare(`
      UPDATE screenshot_ocr_draft
      SET current_json = ?, field_evidence_json = ?, review_flags_json = ?, updated_at = ?
      WHERE id = ? AND status = ?
    `).run(
      JSON.stringify(after),
      JSON.stringify(afterEvidence),
      JSON.stringify(buildReviewFlags(afterEvidence)),
      at,
      row.id,
      OCR_REVIEW_STATUS.PENDING,
    );
    writeReviewAudit(database, { draftId: row.id, action: 'edited', before, after, actor: filler, at });
    return publicDraftRow(database.prepare('SELECT * FROM screenshot_ocr_draft WHERE id = ?').get(row.id));
  })();
}

function rejectScreenshotOcrDraft(id, { actor, at = new Date().toISOString() } = {}) {
  const reviewer = requireActor(actor);
  const database = db.conn();
  return database.transaction(() => {
    const row = database.prepare('SELECT * FROM screenshot_ocr_draft WHERE id = ?').get(Number(id));
    if (!row) throw new Error('OCR 草稿不存在。');
    if (row.status === OCR_REVIEW_STATUS.REJECTED) return { ...publicDraftRow(row), idempotent: true };
    if (row.status === OCR_REVIEW_STATUS.CONFIRMED) throw new Error('已确认草稿不能驳回。');
    const current = parseJson(row.current_json, {});
    database.prepare(`
      UPDATE screenshot_ocr_draft
      SET status = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
      WHERE id = ? AND status = ?
    `).run(OCR_REVIEW_STATUS.REJECTED, reviewer, at, at, row.id, OCR_REVIEW_STATUS.PENDING);
    writeReviewAudit(database, {
      draftId: row.id,
      action: 'rejected',
      before: { status: OCR_REVIEW_STATUS.PENDING, draft: current },
      after: { status: OCR_REVIEW_STATUS.REJECTED, draft: current },
      actor: reviewer,
      at,
    });
    return publicDraftRow(database.prepare('SELECT * FROM screenshot_ocr_draft WHERE id = ?').get(row.id));
  })();
}

function findExistingScreenshotCandidateGeekId(database, jobId, identity) {
  const rows = database.prepare(`
    SELECT geek_id, name, raw_json
    FROM candidate
    WHERE job_id = ? AND source = '截图导入'
  `).all(jobId);
  for (const row of rows) {
    const raw = parseJson(row.raw_json, {});
    const existingIdentity = raw.screenshot_identity || buildScreenshotIdentity({
      name: row.name,
      facts: raw.facts || {},
      sourceHashes: raw.source_hashes || [],
    });
    if (identity.source_fingerprint && existingIdentity.source_fingerprint === identity.source_fingerprint) return row.geek_id;
    if (identity.identity_key && existingIdentity.identity_key === identity.identity_key) return row.geek_id;
  }
  return null;
}

function confirmScreenshotOcrDraft(id, { actor, nameVerifiedByHr = false, at = new Date().toISOString() } = {}) {
  const reviewer = requireActor(actor);
  const database = db.conn();
  return database.transaction(() => {
    const row = database.prepare('SELECT * FROM screenshot_ocr_draft WHERE id = ?').get(Number(id));
    if (!row) throw new Error('OCR 草稿不存在。');
    if (row.status === OCR_REVIEW_STATUS.CONFIRMED) {
      return { ...publicDraftRow(row), inserted: false, idempotent: true };
    }
    if (row.status === OCR_REVIEW_STATUS.REJECTED) throw new Error('已驳回草稿不能确认。');
    const current = parseJson(row.current_json, {});
    const nameVerification = assertConfirmableName(row, current, { nameVerifiedByHr });
    const context = parseJson(row.context_json, {});
    if (nameVerification) {
      context.name_verification = {
        ...nameVerification,
        verified_by: reviewer,
        verified_at: at,
      };
    }
    const contextEvidence = context.evidence;
    const identity = buildScreenshotIdentity({
      name: current.name,
      facts: current.facts,
      sourceHashes: contextEvidence ? contextEvidence.source_hashes : [],
    });
    database.prepare(`
      UPDATE screenshot_ocr_draft
      SET identity_key = ?, source_fingerprint = ?, content_fingerprint = ?, identity_status = ?, identity_json = ?, context_json = ?
      WHERE id = ?
    `).run(
      identity.identity_key,
      identity.source_fingerprint,
      identity.content_fingerprint,
      identity.status,
      JSON.stringify(identity),
      JSON.stringify(context),
      row.id,
    );
    const evidence = contextEvidence ? {
      batchId: contextEvidence.batch_id,
      sourceHashes: contextEvidence.source_hashes || [],
      derivedByDraftId: new Map([[row.draft_id, contextEvidence.derived || null]]),
    } : null;
    const mapped = mapDraftToCandidate(current, {
      jobId: row.job_id,
      jobName: row.job_name,
      sourceDir: context.source_dir_name || '',
      importedAt: at,
      stitchedMap: new Map([[row.draft_id, context.stitched_row || null]]),
      evidence,
      identityKey: identity.identity_key,
    });
    const legacyGeekId = findExistingScreenshotCandidateGeekId(database, row.job_id, identity);
    if (legacyGeekId) mapped.candidate.geek_id = legacyGeekId;
    const review = {
      status: OCR_REVIEW_STATUS.CONFIRMED,
      screenshot_draft_record_id: row.id,
      reviewed_by: reviewer,
      reviewed_at: at,
      field_evidence: parseJson(row.field_evidence_json, {}),
      review_flags: parseJson(row.review_flags_json, {}),
      name_verification: context.name_verification || null,
    };
    mapped.sections.ocr_review = review;
    mapped.sections.screenshot_identity = identity;
    const raw = parseJson(mapped.candidate.raw_json, {});
    mapped.candidate.raw_json = JSON.stringify({ ...raw, ocr_review: review, screenshot_identity: identity });

    const candidate = db.upsertCandidate(mapped.candidate, at);
    db.insertResumeOnline({
      candidate_id: candidate.internal_id,
      sections_json: mapped.sections,
      is_paywalled: 0,
      raw_json: mapped.candidate.raw_json,
      fetched_at: at,
    });
    database.prepare(`
      UPDATE screenshot_ocr_draft
      SET status = ?, candidate_id = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
      WHERE id = ? AND status = ?
    `).run(OCR_REVIEW_STATUS.CONFIRMED, candidate.internal_id, reviewer, at, at, row.id, OCR_REVIEW_STATUS.PENDING);
    writeReviewAudit(database, {
      draftId: row.id,
      action: 'confirmed',
      before: { status: OCR_REVIEW_STATUS.PENDING, draft: current },
      after: {
        status: OCR_REVIEW_STATUS.CONFIRMED,
        draft: current,
        candidate_id: candidate.internal_id,
        name_verification: context.name_verification || null,
      },
      actor: reviewer,
      at,
    });
    return {
      ...publicDraftRow(database.prepare('SELECT * FROM screenshot_ocr_draft WHERE id = ?').get(row.id)),
      inserted: candidate.inserted,
      idempotent: false,
    };
  })();
}

function getOrCreateScreenshotJob({ encryptJobId, jobName, importedAt }) {
  if (!encryptJobId) {
    const existing = db.conn().prepare(`
      SELECT id, is_fixture, source_type
      FROM job
      WHERE name = ? AND hr_owner = '本地截图'
      ORDER BY id
      LIMIT 1
    `).get(jobName);
    if (existing) return existing;
  }
  return db.upsertJob({
    encrypt_job_id: encryptJobId || `local-screenshot-job-${hash([jobName])}`,
    numeric_job_id: null,
    name: jobName,
    hr_owner: '本地截图',
    created_at: importedAt,
  });
}

function ingestScreenshotDrafts(options = {}) {
  const draftsPath = options.draftsPath || DEFAULT_DRAFTS;
  const stitchedIndexPath = options.stitchedIndexPath || DEFAULT_STITCHED_INDEX;
  const ocrPath = options.ocrPath || DEFAULT_OCR;
  const manifestPath = options.manifestPath || '';
  const payload = readJson(draftsPath);
  if (!payload || !Array.isArray(payload.drafts)) throw new Error(`截图草稿不存在或格式错误：${draftsPath}`);
  const stitchedIndex = readJson(stitchedIndexPath, { rows: [] });
  const ocrRows = readJson(ocrPath, []);
  const evidence = evidenceFromManifest(readJson(manifestPath));
  const jobName = normalizeJobName(options.jobName, ocrRows);
  const sourceDir = payload.source_dir || path.dirname(draftsPath);
  const importedAt = options.importedAt || new Date().toISOString();
  const job = getOrCreateScreenshotJob({ encryptJobId: options.encryptJobId, jobName, importedAt });
  const stitchedMap = stitchedByDraftId(stitchedIndex);
  let created = 0;
  let reused = 0;
  const rows = [];

  for (const draft of payload.drafts) {
    const derivedEvidence = evidence ? evidence.derivedByDraftId.get(draft.draft_id) || null : null;
    const sourceIdentity = evidence && !derivedEvidence ? (Array.isArray(draft.files) ? draft.files : []).map((file) => {
      const bytes = fs.readFileSync(file);
      const sourceHash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (evidence.sourceSizeByHash.get(sourceHash) !== bytes.length) {
        throw new Error('截图草稿原图与已验证 evidence manifest 不一致。');
      }
      return { sourceHash, size: bytes.length };
    }) : [];
    const draftEvidence = evidence ? {
      batchId: evidence.batchId,
      sourceHashes: derivedEvidence && Array.isArray(derivedEvidence.source_hashes)
        ? derivedEvidence.source_hashes
        : sourceIdentity.map((item) => item.sourceHash),
      derived: derivedEvidence || {
        source_hashes: sourceIdentity.map((item) => item.sourceHash),
        source_sizes: sourceIdentity.map((item) => item.size),
        identity_only: true,
      },
    } : null;
    const staged = stageScreenshotOcrDraft({
      draft,
      job,
      jobName,
      sourceDir,
      importedAt,
      stitchedRow: stitchedMap.get(draft.draft_id) || null,
      evidence: draftEvidence,
    });
    if (staged.created) created += 1;
    else reused += 1;
    rows.push({ id: staged.row.id, draft_id: staged.row.draft_id, name: staged.row.current.name, status: staged.row.status, created: staged.created });
  }

  db.writeRunLog({
    run_type: RUN_TYPE,
    account: 'local-screenshot',
    job: String(job.id),
    status: '待校对',
    count_new: created,
    count_total: rows.length,
    error_summary: null,
    started_at: importedAt,
    finished_at: importedAt,
  });
  db.writeAuditLog({
    action: RUN_TYPE,
    target: String(job.id),
    who: 'local-screenshot',
    auto: 0,
    result: '待人工校对',
    detail_json: JSON.stringify({
      evidence_batch_id: evidence ? evidence.batchId : null,
      created,
      reused,
      total: rows.length,
    }),
    created_at: importedAt,
  });
  return {
    ok: true,
    job_id: job.id,
    job_name: jobName,
    evidence_batch_id: evidence ? evidence.batchId : null,
    status: OCR_REVIEW_STATUS.PENDING,
    draft_created: created,
    draft_reused: reused,
    pending_review: rows.filter((row) => row.status === OCR_REVIEW_STATUS.PENDING).length,
    inserted: 0,
    updated: 0,
    total: rows.length,
    rows,
  };
}

function main() {
  const dbPath = argValue('db', db.DB_PATH);
  db.openDb(dbPath);
  const result = ingestScreenshotDrafts({
    draftsPath: argValue('drafts', DEFAULT_DRAFTS),
    stitchedIndexPath: argValue('stitched-index', DEFAULT_STITCHED_INDEX),
    ocrPath: argValue('ocr', DEFAULT_OCR),
    manifestPath: argValue('manifest', ''),
    jobName: argValue('job-name', ''),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

module.exports = {
  RUN_TYPE,
  OCR_CONFIDENCE_WARNING_THRESHOLD,
  OCR_REVIEW_STATUS,
  applyAiFieldFill,
  assertConfirmableName,
  buildSections,
  buildGeekDesc,
  confirmScreenshotOcrDraft,
  editScreenshotOcrDraft,
  getScreenshotOcrDraft,
  ingestScreenshotDrafts,
  listScreenshotOcrDrafts,
  listScreenshotOcrReviewAudit,
  normalizeJobName,
  rejectScreenshotOcrDraft,
};
