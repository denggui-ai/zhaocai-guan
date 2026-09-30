'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function read(relative) {
  return fs.readFileSync(path.join(__dirname, relative), 'utf8');
}

const app = read('frontend/src/App.jsx');
const ocr = read('frontend/src/components/ScreenshotOcrReviewModal.jsx');
const topBar = read('frontend/src/components/TopBar.jsx');
const schedule = read('frontend/src/components/InterviewScheduleCanonical.jsx');
const database = read('db.js');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} body is incomplete`);
}

assert.match(ocr, /onPendingCountChange\?\.\(nextDrafts\.length\)/, 'OCR 审核列表变化后必须上报最新待校对数');
assert.match(app, /const \[screenshotPendingReview, setScreenshotPendingReview\] = useState/, '当前待校对数必须与持久任务进度分开存储');
assert.match(app, /api\.listScreenshotOcrDrafts\('pending_review', context\.jobId\)/, '岗位进入或导入完成后必须读取当前岗位权威草稿队列');
assert.match(app, /requestId !== screenshotPendingRequestRef\.current[\s\S]*!isCurrentJobContext/, '迟到的跨岗位待校对读取不得覆盖当前岗位');
assert.match(app, /onPendingCountChange=\{\(count\) => acceptScreenshotPendingCount\(count, jobId\)\}/, '校对列表变化后必须更新独立的权威计数');
assert.doesNotMatch(app, /onPendingCountChange=\{\(count\) => setScreenshotImportProgress/, '校对计数不得再写回会被轮询覆盖的任务进度');
assert.match(app, /OCR 草稿已暂存：当前 \$\{pendingCount\} 条待人工校对/, '导入完成提示必须使用同一次权威队列读取，重启后不得复述旧任务计数');
assert.match(topBar, /screenshotPendingReview\?\.status === 'ready'[\s\S]*Number\.isFinite\(screenshotPendingReview\.count\)/, '顶部只在权威计数读取成功后显示数值，包括 0');
assert.match(topBar, /OCR 待校对：\$\{screenshotPendingReview\.count\} 条/);
assert.match(topBar, /OCR 草稿已暂存，待校对数量读取失败/);

const scheduleFormErrors = vm.runInNewContext(`(${extractFunction(schedule, 'scheduleFormErrors')})`);
const validationNow = Date.parse('2030-01-01T00:00:00.000Z');
const validScheduleForm = {
  durationMinutes: 45,
  leadInterviewerId: 1,
  participantInterviewerIds: [],
  interviewFormat: 'phone',
};
const interviewers = [{ id: 1, active: 1 }];
assert.equal(
  scheduleFormErrors({ valueOf: () => validationNow - 1 }, validScheduleForm, interviewers, validationNow).time,
  '面试时间必须晚于当前时间',
  '前端提交校验必须按传入的当前时间语义拦截过去时间',
);
assert.equal(
  scheduleFormErrors({ valueOf: () => validationNow + 1 }, validScheduleForm, interviewers, validationNow).time,
  undefined,
  '前端提交校验必须允许未来时间',
);
assert.match(schedule, /async function schedule\(session\)[\s\S]*const validationErrors = scheduleFormErrors\(value, form, interviewers\)[\s\S]*if \(firstInvalidField\)[\s\S]*return;/,
  '排期提交必须使用语义校验并在首个错误处停止写入');
assert.match(schedule, /const canonicalWritesBlocked = !canonicalPartitionReady;/, '权威分区未就绪时必须关闭本地权威写入');
const guardedScheduleControls = schedule.match(
  /disabled=\{canonicalWritesBlocked \|\| !selectedScheduleTime \|\| selectedScheduleInPast \|\| isCommittedAction\(`schedule:\$\{session\.id\}`\)\}/g,
) || [];
assert.equal(
  guardedScheduleControls.length,
  2,
  '改期确认层和按钮必须同时覆盖权威分区未就绪、无时间、过去时间和 committed-action 四项禁用条件',
);
assert.match(
  schedule,
  /disabled=\{canonicalWritesBlocked \|\| selectedScheduleInPast \|\| isCommittedAction\(`schedule:\$\{session\.id\}`\)\}[\s\S]*onClick=\{\(\) => schedule\(session\)\}/,
  '首次排期按钮必须锁住权威分区、过去时间和已提交动作，同时允许空表单进入校验并聚焦首个错误',
);
assert.match(schedule, /<DatePicker[\s\S]*disabledDate=\{/,
  '日期选择器必须保留过去日期禁用入口，最终提交仍由 scheduleFormErrors 独立兜底');
assert.match(database, /INTERVIEW_SCHEDULE_IN_PAST/, '数据层必须独立拦截过去时间');

console.log(JSON.stringify({
  ok: true,
  contract: 'PILOT-UX-MIN-002',
  ocr_pending_count_refresh: true,
  past_interview_schedule_guard: true,
  new_data_model: false,
  new_dependency: false,
}));
