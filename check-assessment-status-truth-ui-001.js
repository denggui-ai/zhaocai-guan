'use strict';

const fs = require('fs');
const path = require('path');

const root = __dirname;
const source = fs.readFileSync(path.join(root, 'frontend/src/components/CandidateDetail.jsx'), 'utf8');

function assertIncludes(fragment, label) {
  if (!source.includes(fragment)) throw new Error(`Missing assessment status truth contract: ${label}`);
}

assertIncludes("phase: 'loading'", 'explicit loading state');
assertIncludes("phase: 'error'", 'explicit error state');
assertIncludes('enabled: current.enabled', 'last known enabled state survives read failure');
assertIncludes('...status', 'server capability truth is preserved');
assertIncludes("value: 'assessment'", 'assessment entry is always visible');
assertIncludes("? '报告与分析'", 'enabled assessment label');
assertIncludes(": '已停用'", 'explicit disabled assessment label');
assertIncludes("readOnly={readOnly || assessmentStatus.phase !== 'ready'}", 'writes locked unless status is confirmed');
assertIncludes('状态读取失败不会被解释为“没有测评报告”', 'truthful unknown-state explanation');
assertIncludes('initialStatus={assessmentStatus}', 'runtime capability status reaches archive panel');

if (/\.catch\(\(\)\s*=>\s*\{\s*if \(active\) setAssessmentEnabled\(false\)/s.test(source)) {
  throw new Error('Assessment status failure must not be collapsed into disabled=false UI truth');
}
if (/value:\s*'assessment'[\s\S]{0,500}disabled:/.test(source)) {
  throw new Error('Assessment entry must not disappear or become unreachable when runtime status is unavailable');
}

console.log('check-assessment-status-truth-ui-001: ok');
