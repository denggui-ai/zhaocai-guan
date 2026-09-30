'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'frontend/src/components/CandidateDetail.jsx'), 'utf8');
const executeStart = source.indexOf('const execute = async () => {');
const executeEnd = source.indexOf('\n    if (!needsConfirm)', executeStart);
assert.ok(executeStart >= 0 && executeEnd > executeStart, '必须保留独立的人工动作执行函数');
const executeSource = source.slice(executeStart, executeEnd);

assert.ok(!source.includes('hrFlowReadError'), '普通 HR 人工处置不得再依赖 Application episode 读取状态');
assert.ok(source.includes("const [hrFlowActionError, setHrFlowActionError] = useState('')"), '必须独立保存人工动作错误');
assert.ok(source.includes('const blocked = readOnly || loading || busy'), '可选终评读取失败不得整体禁用 HR 人工动作');
assert.ok(!source.includes('!!readError || !state'), '人工处置不得继续绑定可选终评读取结果');
assert.ok(!source.includes('!!actionError || !state'), '动作失败不得永久禁用重试按钮');
assert.ok(source.includes('readError=""'), '普通 HR 视图必须直接使用人工处置，不显示 Application 读取错误');
assert.ok(source.includes('人工操作“${label}”失败：${message}。请重试。'), '动作错误必须给出明确中文重试提示');
assert.ok(source.includes('MANUAL_ACTION_FALLBACK_CODES'), '申请轮次不可用时必须保留明确动作映射');
assert.ok(source.includes("'manual_hr_action'"), '兼容写入必须使用独立人工来源标识');
assert.match(source, /useEffect\(\(\) => \{[\s\S]*setHrFlowActionError\(''\);[\s\S]*candidate && candidate\.internal_id, readOnly/, '候选人切换时必须清除旧动作错误');
assert.ok(source.includes("setHrFlowBusy(true);\n      setHrFlowActionError('');"), '新动作开始时必须清除旧动作错误');
assert.match(
  executeSource,
  /if \(onWorkflowChanged\) await onWorkflowChanged\(candidate\.internal_id, candidate\.job_id\);\s*setHrFlowActionError\(''\);\s*return true;/,
  '成功刷新后必须清除动作错误，且不等待可选终评读取结果',
);
assert.match(
  executeSource,
  /setHrFlowActionError\(''\);\s*try \{[\s\S]*return false;[\s\S]*\} finally \{\s*setHrFlowBusy\(false\);\s*\}/,
  '动作失败提前返回也必须经过 outer finally 恢复按钮状态',
);

console.log('PILOT-UX-001 manual action error and retry contract checks passed');
