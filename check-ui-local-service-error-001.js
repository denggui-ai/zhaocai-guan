#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadApiModule() {
  const sourcePath = path.join(__dirname, 'frontend/src/api.js');
  const source = fs.readFileSync(sourcePath, 'utf8')
    .replace(
      "export const READONLY_UI = import.meta.env.VITE_READONLY_UI === '1';",
      'export const READONLY_UI = false;',
    );
  const executableSource = `${source}\nexport { localApiRequest };\n`;
  return import(`data:text/javascript;base64,${Buffer.from(executableSource).toString('base64')}`);
}

async function expectRejected(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  assert.fail('expected request to reject');
}

async function main() {
  const { localApiRequest } = await loadApiModule();
  const rawTransportError = "Error invoking remote method 'local-api:request': Error: connect ECONNREFUSED 127.0.0.1:62583";
  global.window = {
    localApi: {
      request: async () => {
        throw new Error(rawTransportError);
      },
    },
  };

  const mapped = await expectRejected(() => localApiRequest('readonly', 'GET', '/api/candidates'));
  assert.equal(
    mapped.message,
    '本地数据服务已停止，界面显示的是上次成功读取的数据。请退出并重新打开招才官；若仍然失败，请检查本机是否有残留的招才官进程。',
  );
  assert.equal(mapped.code, 'LOCAL_DATA_SERVICE_UNAVAILABLE');
  assert.equal(mapped.technicalDetails, rawTransportError);
  assert.doesNotMatch(mapped.message, /Error invoking remote method|ECONNREFUSED|127\.0\.0\.1:/);

  global.window.localApi.request = async () => ({
    status: 500,
    body: {
      ok: false,
      code: 'READONLY_PROJECTION_ERROR',
      error: '读取被安全策略拒绝',
    },
  });
  const serverError = await expectRejected(() => localApiRequest('readonly', 'GET', '/api/candidates'));
  assert.equal(serverError.message, '读取被安全策略拒绝');
  assert.equal(serverError.code, 'READONLY_PROJECTION_ERROR');
  assert.equal(serverError.technicalDetails, undefined);

  const candidateSource = fs.readFileSync(
    path.join(__dirname, 'frontend/src/components/CandidateList.jsx'),
    'utf8',
  );
  assert.match(candidateSource, /刷新失败，当前展示上次成功数据/);
  assert.match(candidateSource, /action=\{<Button size="small" onClick=\{onRetry\}>重试<\/Button>\}/);
  assert.match(candidateSource, /detailsExpanded \? '收起详情' : '查看详情'/);
  assert.match(candidateSource, /detailsExpanded && \([\s\S]*candidate-load-error-technical/);
  assert.doesNotMatch(candidateSource, /description=\{loadError\}/);

  delete global.window;
  console.log(JSON.stringify({
    ok: true,
    contract: 'UI-LOCAL-SERVICE-ERROR-001',
    safeMessage: mapped.message,
    technicalDetailsDefaultVisible: false,
    staleDataMessagePreserved: true,
    retryPreserved: true,
    failClosedServerErrorsPreserved: true,
  }));
}

main().catch((error) => {
  delete global.window;
  console.error(error);
  process.exitCode = 1;
});
