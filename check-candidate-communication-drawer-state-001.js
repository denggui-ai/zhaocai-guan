#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const state = await import(pathToFileURL(path.join(__dirname, 'frontend/src/candidate-communication-drawer-state.mjs')).href);
  assert.equal(state.communicationDrawerEscapeAction({ key: 'Enter' }), 'ignore');
  assert.equal(state.communicationDrawerEscapeAction({ key: 'Escape' }), 'close');
  assert.equal(state.communicationDrawerEscapeAction({ key: 'Escape', nestedLayerOpen: true }), 'nested');
  assert.equal(state.communicationDrawerEscapeAction({ key: 'Escape', busy: true }), 'block');
  assert.equal(state.communicationDrawerEscapeAction({ key: 'Escape', busy: true, nestedLayerOpen: true }), 'block');

  const source = fs.readFileSync(path.join(__dirname, 'frontend/src/components/CandidateDetail.jsx'), 'utf8');
  assert.match(source, /communicationTriggerRef/);
  assert.match(source, /keyboard=\{false\}/);
  assert.match(source, /document\.addEventListener\('keydown', handleCommunicationDrawerEscape, true\)/);
  assert.match(source, /document\.removeEventListener\('keydown', handleCommunicationDrawerEscape, true\)/);
  assert.match(source, /candidate-communication-drawer \[aria-expanded="true"\]/);
  assert.match(source, /afterOpenChange=\{handleCommunicationDrawerOpenChange\}/);
  assert.match(source, /data-communication-drawer-trigger/);
  assert.match(source, /trigger && trigger\.isConnected[\s\S]*trigger\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /setTimeout\(focusCommunicationTrigger, 400\)/);

  console.log(JSON.stringify({
    ok: true,
    contract: 'CANDIDATE-COMMUNICATION-DRAWER-STATE-001',
    one_escape_close: true,
    nested_escape_precedence: true,
    busy_lock: true,
    focus_restore: true,
  }));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
