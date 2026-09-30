'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { LOCAL_PRINCIPAL, authorizePrincipalRequest } = require("../src/local-principal");

const actionSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/action-server.js"), 'utf8');
const productSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/assessment-product-service.js"), 'utf8');

for (const route of ['/api/assessment/deletion/request', '/api/assessment/deletion/confirm']) {
  assert.equal(
    authorizePrincipalRequest(LOCAL_PRINCIPAL, 'POST', route).capability,
    'assessment.archive',
    `${route} must use the existing Assessment archive capability`,
  );
  assert.match(actionSource, new RegExp(`url\\.pathname === '${route.replaceAll('/', '\\/')}'`));
}

assert.match(actionSource, /getAssessmentProductService\(\)\.requestDeletion\(prepareAssessmentIngress\(body\)\)/,
  'delete request must rebuild the server-owned Assessment audit context');
assert.match(actionSource, /getAssessmentProductService\(\)\.confirmDeletion\(prepareAssessmentIngress\(body\)\)/,
  'delete confirmation must rebuild the server-owned Assessment audit context');
assert.match(productSource, /requestPhysicalDeletion\(\{ database, auditContext, command: deletionCommand \}\)/,
  'request step must delegate persistent request creation and lifecycle transition to the coordinator');
assert.match(productSource, /deletePhysicalArtifacts\(\{ database, dataRoot, auditContext, command: deletionCommand \}\)/,
  'confirm step must delegate to the physical deletion coordinator');
assert.match(productSource, /invalidateDocumentPreviews\(result\.document_id\)/,
  'successful request and confirmation must invalidate old in-memory preview tickets');
const publicDeletionSource = productSource.slice(
  productSource.indexOf('function publicDeletionResult'),
  productSource.indexOf('function publicImportResult'),
);
assert.doesNotMatch(publicDeletionSource, /(storage_relpath|content_sha256|preview_relpath)/,
  'public deletion result must not expose controlled paths or content hashes');

// F019-GATE-001-A deliberately reuses the existing default-off F017 gate.
assert.match(actionSource, /const ASSESSMENT_PHASE_A_ENABLED = process\.env\.HRBOSS_ASSESSMENT_PHASE_A_ENABLED === '1'/);
assert.doesNotMatch(actionSource, /HRBOSS_F019_GATE_A_ENABLED/);

console.log('check-f019-gate-a-product-wiring ok');
