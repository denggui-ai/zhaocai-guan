'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { ensurePrivateDir, writePrivateFile } = require('./secure-fs');
const {
  assertResumeFile,
  extractResumeDocumentText,
  importManualResumeAttachment,
} = require('./manual-resume-import');
const { consumeResumeFileSelection } = require('./resume-file-selection');
const { parseResumeStructure, withBasicOverrides } = require('./resume-structure');

const NEW_CANDIDATE_BINDING = '__local_resume_new_candidate__';
const DRAFT_TTL_MS = 10 * 60 * 1000;

class ResumeCandidateIntakeError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'ResumeCandidateIntakeError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new ResumeCandidateIntakeError(code, message, statusCode);
}

function clean(value, maximum = 160) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\0\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function inferFields(text, fileName) {
  return Object.freeze(parseResumeStructure(text, {
    source: 'local_resume_upload',
    file_name: fileName,
  }).basic);
}

function createResumeCandidateIntakeService(options = {}) {
  const database = options.database;
  if (!database || typeof database.prepare !== 'function') fail('RESUME_DATABASE_REQUIRED', '本地候选人数据库不可用。', 500);
  if (typeof options.upsertCandidate !== 'function') fail('RESUME_CANDIDATE_WRITER_REQUIRED', '本地候选人建档服务不可用。', 500);
  const dataRoot = path.resolve(String(options.dataRoot || ''));
  if (!options.dataRoot || !path.isAbsolute(String(options.dataRoot))) fail('RESUME_DATA_ROOT_INVALID', '本地简历存储目录不可用。', 500);
  const selectionSecret = String(options.selectionSecret || '');
  const pendingRoot = ensurePrivateDir(path.join(dataRoot, 'resume-intake', 'pending'));
  const drafts = new Map();
  const consumedSelections = new Set();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const extractDocument = options.extractDocument || extractResumeDocumentText;
  const writeAuditLog = typeof options.writeAuditLog === 'function' ? options.writeAuditLog : null;

  function removeDraft(draft) {
    drafts.delete(draft.id);
    try { fs.rmSync(draft.directory, { recursive: true, force: true }); } catch {}
  }

  function prune() {
    const timestamp = now();
    for (const draft of drafts.values()) if (draft.expires_at <= timestamp) removeDraft(draft);
  }

  function assertJob(jobId) {
    const job = database.prepare('SELECT id, name, status FROM job WHERE id = ?').get(jobId);
    if (!job) fail('JOB_NOT_FOUND', '请选择有效岗位。', 404);
    if (job.status === 'closed') fail('JOB_CLOSED', '岗位已关闭，请重新开启后再上传简历建档。', 409);
    return job;
  }

  async function prepare({ selectionToken, command, actor }) {
    prune();
    const jobId = Number(command && command.job_id);
    const requestId = clean(command && command.request_id, 128);
    if (!Number.isInteger(jobId) || jobId <= 0 || !requestId) fail('RESUME_INTAKE_BINDING_REQUIRED', '请选择当前岗位。');
    const job = assertJob(jobId);
    const selection = consumeResumeFileSelection(
      selectionSecret,
      selectionToken,
      { candidate_id: NEW_CANDIDATE_BINDING, job_id: jobId, request_id: requestId },
      consumedSelections,
      { now: now() },
    );
    const inspected = assertResumeFile(selection.source_path);
    const bytes = fs.readFileSync(inspected.resolved);
    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const id = crypto.randomUUID();
    const directory = ensurePrivateDir(path.join(pendingRoot, id));
    const stagedPath = path.join(directory, `source${inspected.extension}`);
    writePrivateFile(stagedPath, bytes);
    let extraction;
    try {
      extraction = await extractDocument(stagedPath, inspected.extension, {
        ...options,
        dataRoot,
        controlledRoot: dataRoot,
        ocrWorkRoot: ensurePrivateDir(path.join(dataRoot, 'resume-intake', 'ocr-work')),
      });
    } catch (error) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
      throw error;
    }
    const fileName = path.basename(inspected.resolved);
    const structure = parseResumeStructure(extraction.text, {
      source: 'local_resume_upload',
      file_name: fileName,
    });
    const fields = Object.freeze({ ...structure.basic });
    const draft = Object.freeze({
      id,
      directory,
      staged_path: stagedPath,
      content_sha256: contentHash,
      file_name: fileName,
      file_type: inspected.extension.slice(1),
      byte_size: inspected.stat.size,
      job_id: jobId,
      job_name: job.name,
      extraction,
      fields,
      structure,
      actor: clean(actor, 160) || 'local-primary-operator',
      created_at: now(),
      expires_at: now() + DRAFT_TTL_MS,
    });
    drafts.set(id, draft);
    return Object.freeze({
      draft_id: id,
      expires_at: new Date(draft.expires_at).toISOString(),
      job_id: jobId,
      job_name: job.name,
      file_name: fileName,
      file_type: draft.file_type,
      byte_size: draft.byte_size,
      text_extracted: Boolean(extraction.text),
      extraction_source: extraction.extraction_source,
      ocr: extraction.ocr,
      ocr_error_code: extraction.ocr_error_code,
      fields,
      text_preview: clean(String(extraction.text || '').slice(0, 1000), 1000),
    });
  }

  async function commit(command = {}) {
    prune();
    const draftId = clean(command.draft_id, 80);
    const jobId = Number(command.job_id);
    const draft = drafts.get(draftId);
    if (!draft) fail('RESUME_INTAKE_DRAFT_EXPIRED', '简历建档草稿已失效，请重新选择文件。', 409);
    if (draft.job_id !== jobId) fail('RESUME_INTAKE_CONTEXT_MISMATCH', '简历建档岗位上下文已变化。', 409);
    assertJob(jobId);
    if (!fs.existsSync(draft.staged_path) || hashFile(draft.staged_path) !== draft.content_sha256) {
      removeDraft(draft);
      fail('RESUME_INTAKE_SOURCE_CHANGED', '简历建档文件发生变化，请重新选择。', 409);
    }
    const fields = {
      name: clean(command.name, 80),
      age: clean(command.age, 30),
      degree: clean(command.degree, 30),
      school: clean(command.school, 120),
      work_years: clean(command.work_years, 30),
      salary: clean(command.salary, 40),
    };
    const suppliedFieldKeys = Object.keys(fields).filter((key) => Object.prototype.hasOwnProperty.call(command, key));
    const correctedFieldKeys = suppliedFieldKeys.filter((key) => {
      const maximum = key === 'name' ? 80 : key === 'school' ? 120 : key === 'age' ? 30 : 40;
      return fields[key] !== clean(draft.fields[key], maximum);
    });
    if (!fields.name) fail('CANDIDATE_NAME_REQUIRED', '请确认候选人姓名。');
    const geekId = `local-resume:${draft.content_sha256}`;
    let existing = database.prepare(`
      SELECT internal_id, name, age, degree, school, work_years, salary
      FROM candidate WHERE job_id = ? AND geek_id = ?
    `).get(jobId, geekId);
    let inserted = false;
    let pendingCorrections = [];
    if (!existing) {
      const result = options.upsertCandidate({
        job_id: jobId,
        geek_id: geekId,
        source: '本地简历',
        name: fields.name,
        age: fields.age || null,
        degree: fields.degree || null,
        school: fields.school || null,
        work_years: fields.work_years || null,
        salary: fields.salary || null,
        comm_status: '未打招呼',
        disposition_status: '新入库',
        raw_json: JSON.stringify({
          source: 'local_resume_upload',
          content_sha256: draft.content_sha256,
          original_file_name: draft.file_name,
        }),
      });
      existing = { internal_id: result.internal_id };
      inserted = result.inserted === true;
    } else {
      pendingCorrections = correctedFieldKeys.filter((key) => {
        const maximum = key === 'name' ? 80 : key === 'school' ? 120 : key === 'age' ? 30 : 40;
        return clean(existing[key], maximum) !== fields[key];
      });
    }
    try {
      const structuredResume = withBasicOverrides(
        draft.structure,
        Object.fromEntries(suppliedFieldKeys.map((key) => [key, fields[key]])),
      );
      const imported = await importManualResumeAttachment({
        ...options,
        database,
        dataRoot,
        sourcePath: draft.staged_path,
        candidateId: existing.internal_id,
        jobId,
        actor: draft.actor,
        preExtractedText: draft.extraction.text,
        preExtractionSource: draft.extraction.extraction_source,
        preOcr: draft.extraction.ocr,
        preOcrErrorCode: draft.extraction.ocr_error_code,
        preStructuredResume: structuredResume,
        originalFileName: draft.file_name,
      });
      if (!inserted && pendingCorrections.length) {
        const values = pendingCorrections.map((key) => fields[key] || null);
        const updated = database.prepare(`
          UPDATE candidate
          SET ${pendingCorrections.map((key) => `${key} = ?`).join(', ')}, updated_at = ?
          WHERE internal_id = ? AND job_id = ?
        `).run(...values, new Date(now()).toISOString(), existing.internal_id, jobId);
        if (updated.changes !== 1) fail('RESUME_DUPLICATE_CORRECTION_FAILED', '重复简历校对内容未能写入，请刷新后重试。', 409);
        writeAuditLog?.({
          action: '重复简历人工校对',
          target: existing.internal_id,
          who: draft.actor,
          auto: 0,
          result: '成功',
          detail_json: JSON.stringify({ fields: pendingCorrections, source_sha256: draft.content_sha256 }),
        });
      }
      removeDraft(draft);
      return Object.freeze({
        candidate_id: existing.internal_id,
        job_id: jobId,
        inserted,
        duplicate: !inserted,
        duplicate_corrections_applied: true,
        applied_correction_fields: inserted ? [] : pendingCorrections,
        unapplied_correction_fields: [],
        ai_ready: imported.ai_ready,
        text_extracted: imported.text_extracted,
        extraction_source: imported.extraction_source,
        ocr_error_code: imported.ocr_error_code,
      });
    } catch (error) {
      if (inserted) {
        // Keep the new local record visible and recoverable instead of hiding a
        // partial failure. The draft remains available for the HR to retry.
        error.message = `候选人已建档，但附件写入未完成：${error.message}`;
      }
      throw error;
    }
  }

  return Object.freeze({ commit, prepare, prune });
}

module.exports = {
  DRAFT_TTL_MS,
  NEW_CANDIDATE_BINDING,
  ResumeCandidateIntakeError,
  createResumeCandidateIntakeService,
  inferFields,
};
