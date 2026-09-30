'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = __dirname;

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function extractFunction(code, name) {
  const start = code.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = code.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < code.length; index += 1) {
    if (code[index] === '{') depth += 1;
    if (code[index] === '}') depth -= 1;
    if (depth === 0) return code.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadFunction(code, name) {
  const sandbox = {};
  vm.runInNewContext(`${extractFunction(code, name)}\nthis.loaded = ${name};`, sandbox);
  return sandbox.loaded;
}

async function assertSingleFlight(runOnce, kind) {
  const ref = { current: null };
  let writes = 0;
  let release;
  const pendingWrite = new Promise((resolve) => { release = resolve; });
  const write = () => {
    writes += 1;
    return pendingWrite;
  };
  const first = runOnce(ref, write);
  const second = runOnce(ref, write);
  await Promise.resolve();
  assert.equal(writes, 1, `${kind}: repeated confirmation must invoke one write`);
  release('done');
  await Promise.all([first, second]);
  await runOnce(ref, async () => { writes += 1; });
  assert.equal(writes, 2, `${kind}: gate must reopen after completion`);
}

async function main() {
  const interview = source('frontend/src/components/InterviewReviewPanel.jsx');

  assert.match(interview, /title: '撤回授权会立即对当前录音、预检或材料处理发起安全停止，仍要继续吗？'/);
  assert.match(interview, /系统会对当前录音、麦克风预检或材料处理立即发起安全停止；确认进程结束后删除临时音频与转写材料，且不会生成本次复盘/);
  assert.match(interview, /okText: '撤回并中止当前任务'/);
  assert.match(interview, /cancelText: '保留授权并继续录音'/);
  assert.match(interview, /onOk:[\s\S]{0,220}persistConsentChange\(false\)/);
  assert.match(interview, /afterClose:[\s\S]{0,220}restoreConsentTrigger\(trigger\)/);
  assert.doesNotMatch(
    interview.slice(interview.indexOf("afterClose: () => {", interview.indexOf("title: '撤回授权")), interview.indexOf('});', interview.indexOf("afterClose: () => {", interview.indexOf("title: '撤回授权")))),
    /persistConsentChange|saveInterviewConsent/,
    'cancel/close path must not write consent',
  );

  await assertSingleFlight(loadFunction(interview, 'runConsentWriteOnce'), 'consent');

  const restoreConsent = loadFunction(interview, 'restoreConsentTrigger');
  {
    let focused = 0;
    let focusOptions = null;
    restoreConsent({
      isConnected: true,
      focus(options) {
        focused += 1;
        focusOptions = options;
      },
    });
    assert.equal(focused, 1, 'cancelled confirmation must restore trigger focus');
    assert.equal(focusOptions.preventScroll, true);
  }

  console.log('PASS UX-G0-C destructive-action safety checks');
  console.log('PASS cancel paths perform 0 writes by construction');
  console.log('PASS repeated submit performs 1 write while pending');
  console.log('PASS cancelled confirmation restores trigger focus');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
