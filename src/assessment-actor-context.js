'use strict';

const ACTOR_ID = 'local-primary-operator';
const ACTOR_TYPE = 'local_os_subject';
const ACTOR_SOURCE = 'server_local_instance';
const ASSURANCE = 'local_instance_only';

// Assessment ingress only. Existing non-Assessment actor handling is intentionally
// left unchanged until a separately authorized migration is available.
const RESERVED_IDENTITY_KEYS = new Set([
  'actor',
  'actorid',
  'actortype',
  'actorsource',
  'actorsessionid',
  'assurance',
  'createdby',
  'requestedby',
  'confirmedby',
  'reviewedby',
  'revokedby',
  'deletedby',
  'actorcontext',
  'auditcontext',
]);

function normalizedIdentityKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function requireAssessmentInstanceId(env = process.env) {
  const instanceId = String((env && env.HRBOSS_LOCAL_API_INSTANCE_ID) || '').trim();
  if (!instanceId) {
    const error = new Error('HRBOSS_LOCAL_API_INSTANCE_ID is required for Assessment ingress');
    error.code = 'ASSESSMENT_INSTANCE_ID_REQUIRED';
    throw error;
  }
  return instanceId;
}

function createAssessmentAuditContext(env = process.env) {
  return Object.freeze({
    actor_id: ACTOR_ID,
    actor_type: ACTOR_TYPE,
    actor_source: ACTOR_SOURCE,
    actor_session_id: requireAssessmentInstanceId(env),
    assurance: ASSURANCE,
  });
}

function sanitizeAssessmentDto(dto) {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
    throw new TypeError('Assessment DTO must be an object');
  }

  const entries = Object.entries(dto).filter(([key]) => (
    !RESERVED_IDENTITY_KEYS.has(normalizedIdentityKey(key))
  ));
  return Object.freeze(Object.fromEntries(entries));
}

function prepareAssessmentIngress(dto, env = process.env) {
  // The audit context is always rebuilt from the server-controlled environment;
  // actor/audit contexts supplied in the DTO are discarded with other claims.
  return Object.freeze({
    auditContext: createAssessmentAuditContext(env),
    command: sanitizeAssessmentDto(dto),
  });
}

module.exports = {
  createAssessmentAuditContext,
  prepareAssessmentIngress,
  requireAssessmentInstanceId,
  sanitizeAssessmentDto,
};
