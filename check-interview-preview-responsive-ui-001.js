'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, 'frontend/src/components/InterviewReviewPanel.jsx'),
  'utf8',
);

function assertIncludes(fragment, label) {
  if (!source.includes(fragment)) throw new Error(`Missing interview preview responsive contract: ${label}`);
}

assertIncludes("maxHeight: 'calc(100dvh - 180px)'", 'viewport-bound modal body');
assertIncludes("overflowY: 'auto'", 'body owns overflow while footer stays outside');
assertIncludes("overscrollBehavior: 'contain'", 'nested scroll containment');
assertIncludes("scrollbarGutter: 'stable'", 'stable scroll gutter');
assertIncludes("maxHeight: 'min(320px, 35dvh)'", 'send-unit list is low-height aware');

console.log('check-interview-preview-responsive-ui-001: ok');
