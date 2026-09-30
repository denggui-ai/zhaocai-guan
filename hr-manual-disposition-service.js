'use strict';

const crypto = require('crypto');
const workflow = require('./workflow-projection');

const ACTION_ALIASES = Object.freeze({
  continue: 'continue_process',
  continue_process: 'continue_process',
  under_review: 'continue_process',
  '待处理': 'continue_process',
  hold: 'hold',
  reject: 'reject',
  rejected: 'reject',
  '淘汰': 'reject',
  talent_pool: 'talent_pool',
  '暂存人才库': 'talent_pool',
  withdraw: 'withdraw',
  candidate_withdrew: 'withdraw',
  '主动放弃': 'withdraw',
  hired: 'hired',
  '已入职': 'hired',
  reenter: 'reenter',
});

const ACTIONS = Object.freeze({
  continue_process: Object.freeze({ code: 'under_review', label: '待处理', applicationAction: 'continue_process', status: 'active' }),
  hold: Object.freeze({ code: 'under_review', label: '暂缓', applicationAction: 'hold', status: 'active' }),
  reject: Object.freeze({ code: 'rejected', label: '淘汰', applicationAction: 'reject', status: 'closed' }),
  talent_pool: Object.freeze({ code: 'talent_pool', label: '暂存人才库', applicationAction: 'talent_pool', status: 'closed' }),
  withdraw: Object.freeze({ code: 'candidate_withdrew', label: '主动放弃', applicationAction: null, status: 'withdrawn' }),
  hired: Object.freeze({ code: 'hired', label: '录用', applicationAction: null, status: 'closed' }),
});

class HrManualDispositionError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'HrManualDispositionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new HrManualDispositionError(code, message, statusCode);
}

function text(value, maxLength = 500) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

function publicApplication(row) {
  return row ? { ...row, id: Number(row.id), job_id: Number(row.job_id), episode_no: Number(row.episode_no), version: Number(row.version) } : null;
}

function latestApplication(database, candidateId, jobId) {
  return database.prepare(`
    SELECT id, candidate_id, job_id, episode_no, status, reopened_from_application_id,
           disposition_action, version, opened_by, ended_by, opened_at, ended_at,
           created_at, updated_at
    FROM application_episode
    WHERE candidate_id = ? AND job_id = ?
    ORDER BY episode_no DESC, id DESC LIMIT 1
  `).get(candidateId, jobId) || null;
}

function publicCandidate(database, candidateId) {
  return database.prepare(`
    SELECT internal_id, job_id, disposition_status, disposition_code,
           workflow_version, updated_at
    FROM candidate WHERE internal_id = ?
  `).get(candidateId) || null;
}

function payloadHash(input) {
  return crypto.createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
}

function normalizeRequestId(value) {
  const requestId = text(value, 128) || `hr-flow-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) fail('REQUEST_ID_INVALID', '请求标识格式无效。');
  return requestId;
}

function insertApplicationEvent(database, row) {
  database.prepare(`
    INSERT INTO application_event (
      application_id, object_type, object_id, event_type, request_id, request_hash,
      actor_id, reason_code, before_status, after_status, before_version, after_version,
      related_object_type, related_object_id, occurred_at
    ) VALUES (?, 'application', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.applicationId, row.applicationId, row.eventType, row.requestId, row.requestHash,
    row.actorId, row.reasonCode, row.beforeStatus, row.afterStatus,
    row.beforeVersion, row.afterVersion, row.relatedObjectType || null,
    row.relatedObjectId || null, row.occurredAt,
  );
}

function createHrManualDispositionService({ database, actorContext, now } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') throw new Error('database is required');
  const actorId = text(actorContext && actorContext.actor_id, 160);
  if (!actorId) throw new Error('actorContext.actor_id is required');

  function apply(command = {}) {
    const candidateId = text(command.candidate_id || command.candidateId, 160);
    if (!candidateId) fail('CANDIDATE_ID_REQUIRED', '候选人 ID 不能为空。');
    const requestedAction = text(command.action || command.code, 40);
    const action = ACTION_ALIASES[requestedAction];
    if (!action) fail('MANUAL_ACTION_INVALID', '不支持的 HR 人工动作。');
    const requestId = normalizeRequestId(command.request_id || command.requestId);
    const reason = text(command.reason, 500) || `HR 人工操作：${action}`;
    const occurredAt = typeof now === 'function' ? text(now(), 80) : new Date().toISOString();

    return database.transaction(() => {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='application_episode'").get()) {
        fail('APPLICATION_EPISODE_UNAVAILABLE', '申请轮次尚未启用，人工处置已拒绝写入。', 409);
      }
      const candidate = publicCandidate(database, candidateId);
      if (!candidate) fail('CANDIDATE_NOT_FOUND', '候选人不存在。', 404);
      const jobId = Number(candidate.job_id);
      if (command.job_id != null && Number(command.job_id) !== jobId) fail('CANDIDATE_JOB_MISMATCH', '候选人与岗位不匹配。', 409);
      let application = latestApplication(database, candidateId, jobId);
      if (!application) fail('APPLICATION_NOT_FOUND', '候选人缺少申请轮次，请先完成 F018 迁移。', 409);

      const hash = payloadHash({ operation: action, candidate_id: candidateId, job_id: jobId, reason });
      const replay = database.prepare('SELECT request_hash FROM application_event WHERE request_id = ?').get(requestId);
      if (replay) {
        if (replay.request_hash !== hash) fail('REQUEST_ID_REUSED', '请求标识已被其他操作使用。', 409);
        return { action, no_op: true, replayed: true, candidate: publicCandidate(database, candidateId), application: publicApplication(latestApplication(database, candidateId, jobId)) };
      }

      const currentCode = workflow.dispositionCode(candidate.disposition_code, candidate.disposition_status);
      if (action === 'reenter') {
        if (currentCode === 'hired') {
          fail('HIRED_FORBIDDEN', '已录用候选人不能通过普通“重新进入”清除终态。', 409);
        }
        if (application.status === 'active') {
          if (currentCode === 'under_review' && ['continue_process', null].includes(application.disposition_action)) {
            return { action, no_op: true, replayed: false, candidate, application: publicApplication(application) };
          }
          database.prepare(`
            UPDATE application_episode
            SET disposition_action = 'continue_process', version = version + 1, updated_at = ?
            WHERE id = ? AND status = 'active' AND version = ?
          `).run(occurredAt, application.id, application.version);
        } else {
          const nextEpisode = Number(application.episode_no) + 1;
          const inserted = database.prepare(`
            INSERT INTO application_episode (
              candidate_id, job_id, episode_no, status, reopened_from_application_id,
              disposition_action, version, opened_by, opened_at, created_at, updated_at
            ) VALUES (?, ?, ?, 'active', ?, 'continue_process', 1, ?, ?, ?, ?)
          `).run(candidateId, jobId, nextEpisode, application.id, actorId, occurredAt, occurredAt, occurredAt);
          const newId = Number(inserted.lastInsertRowid);
          insertApplicationEvent(database, {
            applicationId: newId, eventType: 'reopened', requestId, requestHash: hash,
            actorId, reasonCode: 'manual_hr_reenter', beforeStatus: application.status,
            afterStatus: 'active', beforeVersion: application.version, afterVersion: 1,
            relatedObjectType: 'application', relatedObjectId: application.id, occurredAt,
          });
          application = latestApplication(database, candidateId, jobId);
        }
        database.prepare(`
          UPDATE candidate SET disposition_status = ?, disposition_code = 'under_review',
            workflow_version = workflow_version + 1, updated_at = ?
          WHERE internal_id = ? AND job_id = ?
        `).run(workflow.DISPOSITION_CODE_TO_LABEL.under_review, occurredAt, candidateId, jobId);
        database.prepare(`
          INSERT INTO status_history (
            candidate_id, layer, from_status, to_status, source, who, reason,
            from_code, to_code, created_at
          ) VALUES (?, 'disposition', ?, ?, 'manual_hr_action', ?, ?, ?, 'under_review', ?)
        `).run(candidateId, candidate.disposition_status, workflow.DISPOSITION_CODE_TO_LABEL.under_review, actorId, reason, currentCode, occurredAt);
        return { action, no_op: false, replayed: false, candidate: publicCandidate(database, candidateId), application: publicApplication(latestApplication(database, candidateId, jobId)) };
      }

      const target = ACTIONS[action];
      const sameApplication = application.status === target.status
        && (target.applicationAction == null || application.disposition_action === target.applicationAction);
      if (currentCode === target.code && sameApplication) {
        return { action, no_op: true, replayed: false, candidate, application: publicApplication(application) };
      }
      if (application.status !== 'active') fail('APPLICATION_REENTRY_REQUIRED', '当前申请轮次已结束，请先点击“重新进入”。', 409);

      const nextVersion = Number(application.version) + 1;
      const terminal = target.status !== 'active';
      const updated = database.prepare(`
        UPDATE application_episode
        SET disposition_action = ?, status = ?, ended_by = ?, ended_at = ?,
            version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'active' AND version = ?
      `).run(
        target.applicationAction, target.status, terminal ? actorId : null,
        terminal ? occurredAt : null, occurredAt, application.id, application.version,
      );
      if (updated.changes !== 1) fail('STALE_VERSION', '申请轮次已变更，请刷新后重试。', 409);

      database.prepare(`
        UPDATE candidate SET disposition_status = ?, disposition_code = ?,
          workflow_version = workflow_version + 1, updated_at = ?
        WHERE internal_id = ? AND job_id = ?
      `).run(target.label, target.code, occurredAt, candidateId, jobId);
      database.prepare(`
        INSERT INTO status_history (
          candidate_id, layer, from_status, to_status, source, who, reason,
          from_code, to_code, created_at
        ) VALUES (?, 'disposition', ?, ?, 'manual_hr_action', ?, ?, ?, ?, ?)
      `).run(candidateId, candidate.disposition_status, target.label, actorId, reason, currentCode, target.code, occurredAt);

      if (terminal) {
        insertApplicationEvent(database, {
          applicationId: application.id,
          eventType: target.status === 'withdrawn' ? 'withdrawn' : 'closed',
          requestId, requestHash: hash, actorId, reasonCode: `manual_hr_${action}`,
          beforeStatus: 'active', afterStatus: target.status,
          beforeVersion: application.version, afterVersion: nextVersion, occurredAt,
        });
      }
      return { action, no_op: false, replayed: false, candidate: publicCandidate(database, candidateId), application: publicApplication(latestApplication(database, candidateId, jobId)) };
    }).immediate();
  }

  return Object.freeze({ apply });
}

module.exports = { ACTIONS, HrManualDispositionError, createHrManualDispositionService };
