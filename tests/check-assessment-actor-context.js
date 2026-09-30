'use strict';

const assert = require('assert');

const {
  createAssessmentAuditContext,
  prepareAssessmentIngress,
  requireAssessmentInstanceId,
  sanitizeAssessmentDto,
} = require("../src/assessment-actor-context");

function env(instanceId) {
  return { HRBOSS_LOCAL_API_INSTANCE_ID: instanceId };
}

assert.throws(
  () => requireAssessmentInstanceId({}),
  (error) => error && error.code === 'ASSESSMENT_INSTANCE_ID_REQUIRED',
  'missing instance ID must be rejected',
);
assert.throws(
  () => createAssessmentAuditContext(env('   ')),
  (error) => error && error.code === 'ASSESSMENT_INSTANCE_ID_REQUIRED',
  'blank instance ID must be rejected',
);

const firstContext = createAssessmentAuditContext(env('synthetic-session-a'));
assert.deepStrictEqual(firstContext, {
  actor_id: 'local-primary-operator',
  actor_type: 'local_os_subject',
  actor_source: 'server_local_instance',
  actor_session_id: 'synthetic-session-a',
  assurance: 'local_instance_only',
});
assert.deepStrictEqual(
  createAssessmentAuditContext(env('synthetic-session-a')),
  firstContext,
  'the same application session must produce the same context',
);
assert.strictEqual(
  createAssessmentAuditContext(env('synthetic-session-b')).actor_id,
  firstContext.actor_id,
  'actor ID remains fixed between application sessions',
);
assert.notStrictEqual(
  createAssessmentAuditContext(env('synthetic-session-b')).actor_session_id,
  firstContext.actor_session_id,
  'different application sessions must remain distinguishable',
);

const nestedBusinessContent = {
  note: 'Keep actor=quoted-in-a-business-note and deleted_by=quoted-as-text.',
  actor: 'nested-business-field-is-not-an-ingress-claim',
  'actor-id': 'nested-hyphenated-business-field-is-not-an-ingress-claim',
  'confirmed.by': 'nested-dotted-business-field-is-not-an-ingress-claim',
};
const input = {
  documentId: 'synthetic-document-1',
  expected_version: 3,
  nestedBusinessContent,
  actor: 'forged-actor-value',
  actorId: 'forged-actor-id-camel',
  actor_id: 'forged-actor-id-snake',
  'actor-id': 'forged-actor-id-hyphen',
  actorType: 'forged-actor-type',
  actor_source: 'forged-actor-source',
  actorSessionId: 'forged-session',
  assurance: 'forged-assurance',
  createdBy: 'forged-created-by',
  created_by: 'forged-created-by-snake',
  requestedBy: 'forged-requested-by',
  requested_by: 'forged-requested-by-snake',
  confirmedBy: 'forged-confirmed-by',
  confirmed_by: 'forged-confirmed-by-snake',
  'confirmed.by': 'forged-confirmed-by-dot',
  reviewedBy: 'forged-reviewed-by',
  reviewed_by: 'forged-reviewed-by-snake',
  revokedBy: 'forged-revoked-by',
  revoked_by: 'forged-revoked-by-snake',
  deletedBy: 'forged-deleted-by',
  deleted_by: 'forged-deleted-by-snake',
  actorContext: { actor_id: 'forged-actor-context' },
  audit_context: { actor_id: 'forged-audit-context' },
};
const inputSnapshot = { ...input };
const command = sanitizeAssessmentDto(input);

assert.deepStrictEqual(input, inputSnapshot, 'sanitizing must not mutate the source DTO');
assert.strictEqual(command.documentId, 'synthetic-document-1');
assert.strictEqual(command.expected_version, 3);
assert.strictEqual(
  command.nestedBusinessContent,
  nestedBusinessContent,
  'nested business content must not be recursively scanned or rewritten',
);
for (const key of Object.keys(input)) {
  if (!['documentId', 'expected_version', 'nestedBusinessContent'].includes(key)) {
    assert.ok(!Object.hasOwn(command, key), `reserved top-level claim must be removed: ${key}`);
  }
}

const prepared = prepareAssessmentIngress(input, env('synthetic-server-owned-session'));
assert.deepStrictEqual(prepared.auditContext, {
  actor_id: 'local-primary-operator',
  actor_type: 'local_os_subject',
  actor_source: 'server_local_instance',
  actor_session_id: 'synthetic-server-owned-session',
  assurance: 'local_instance_only',
});
assert.deepStrictEqual(prepared.command, command);
assert.deepStrictEqual(input, inputSnapshot, 'preparing ingress must not mutate the source DTO');

const finalEnvelope = JSON.stringify(prepared);
for (const forgedValue of [
  'forged-actor-value',
  'forged-actor-id-camel',
  'forged-actor-id-snake',
  'forged-actor-id-hyphen',
  'forged-confirmed-by-dot',
  'forged-session',
  'forged-actor-context',
  'forged-audit-context',
]) {
  assert.ok(!finalEnvelope.includes(forgedValue), `forged identity leaked into final envelope: ${forgedValue}`);
}

assert.throws(
  () => prepareAssessmentIngress({ actorContext: { actor_id: 'forged' } }, {}),
  (error) => error && error.code === 'ASSESSMENT_INSTANCE_ID_REQUIRED',
  'a caller-provided context must not substitute for the server instance ID',
);
assert.throws(() => sanitizeAssessmentDto(null), /Assessment DTO must be an object/);
assert.throws(() => sanitizeAssessmentDto([]), /Assessment DTO must be an object/);

console.log('check-assessment-actor-context: PASS');
