'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const schedule = fs.readFileSync(path.join(root, 'frontend/src/components/InterviewScheduleCanonical.jsx'), 'utf8');
const api = fs.readFileSync(path.join(root, 'frontend/src/api.js'), 'utf8');

assert.match(schedule, /listSessions: \(candidateId, jobId\) => api\.listInterviewSessions\(candidateId, jobId\)/,
  'the production adapter must preserve the existing canonical session API');
assert.match(schedule, /scheduleAdapter\.listSessions\(null, context\.jobId\)/,
  'canonical session timeline must load through the active adapter by current job');
assert.match(schedule, /function mergeCanonicalSessions[\s\S]*candidate_name:[\s\S]*report_status:[\s\S]*cancel_reason:/, 'canonical sessions must retain workbench-only display fields');
assert.match(schedule, /setCanonicalSessions\(null\)[\s\S]*loadCanonicalSessions\(context\)/, 'a job switch must fall back to its workbench while canonical data loads');
assert.match(schedule, /jobContextRef = useRef\(\{ jobId: null, token: 0 \}\)/);
assert.match(schedule, /token: jobContextRef\.current\.token \+ 1/);
assert.match(schedule, /context\.token === jobContextRef\.current\.token[\s\S]*sameJobId\(context\.jobId, jobContextRef\.current\.jobId\)/, 'A-B-A responses must be rejected by job id and monotonic token');

for (const format of ['online', 'offline', 'phone']) {
  assert.match(schedule, new RegExp(`value: '${format}'`), `create and schedule UI must support ${format}`);
}
assert.match(schedule, /scheduleAdapter\.createSession\(\{[\s\S]*interviewFormat: targetFormat/, 'session creation must send the authoritative format');
assert.match(schedule, /scheduleAdapter\.listInterviewers\(true\)/, 'writable UI must load inactive interviewers for directory management');
assert.match(schedule, /scheduleAdapter\.saveInterviewer\(input\)/);
assert.match(schedule, /\.filter\(\(interviewer\) => Number\(interviewer\.active\) === 1\)/, 'only active interviewers may be selected');
assert.match(schedule, /duration < 5 \|\| duration > 480/);
assert.match(schedule, /function scheduleFormErrors\(value, form, interviewers/,
  'schedule required-field validation must have one UI-visible source of truth');
assert.match(schedule, /setScheduleValidationAttempts\(\(current\) => \(\{ \.\.\.current, \[session\.id\]: true \}\)\)/,
  'a failed submit must reveal field-level validation');
assert.match(schedule, /requestAnimationFrame[\s\S]*SCHEDULE_ERROR_FIELD_LABELS\[firstInvalidField\]/,
  'a failed submit must focus the first invalid field');
assert.match(schedule, /message="请补全排期必填项"[\s\S]*description=\{visibleScheduleErrors\.join\('；'\)\}/,
  'required-field errors must be visible next to the schedule form');
for (const requiredField of ['主面试官', '会议链接', '面试地址']) {
  const start = schedule.indexOf(`aria-label="${requiredField}"`);
  assert.notEqual(start, -1, `${requiredField} field must exist`);
  const field = schedule.slice(start, start + 500);
  assert.match(field, /aria-required="true"/, `${requiredField} must expose its required semantics`);
  assert.match(field, /aria-invalid=/, `${requiredField} must expose invalid state after submit`);
  assert.match(field, /aria-describedby=/, `${requiredField} must associate its visible error text`);
  assert.match(field, /status=/, `${requiredField} must expose a visible Ant Design error state`);
}
for (const requiredField of ['面试时间', '面试时长（分钟）']) {
  const start = schedule.indexOf(`aria-label="${requiredField}"`);
  assert.notEqual(start, -1, `${requiredField} field must exist`);
  assert.match(schedule.slice(start, start + 260), /aria-required="true"/, `${requiredField} must expose required semantics`);
}
assert.match(schedule, /人工确认排期<\/Button>\}[\s\S]*?selectedScheduleInPast/,
  'new schedule submit must remain reachable so an empty time can reveal and focus its validation error');
assert.match(schedule, /\{ interviewerId: leadInterviewerId, role: 'lead' \}/);
assert.match(schedule, /role: 'participant'/);
assert.match(schedule, /form\.interviewFormat === 'online'[\s\S]*meetingLink/, 'online schedule must require a real link');
assert.match(schedule, /form\.interviewFormat === 'offline'[\s\S]*locationAddress/, 'offline schedule must require an address');
assert.match(schedule, /meetingLink: form\.interviewFormat === 'online'[\s\S]*locationAddress: form\.interviewFormat === 'offline'/, 'mutually exclusive fields must be cleared in the submitted logistics');
assert.match(schedule, /scheduleAdapter\.confirmSchedule\(session\.id, value\.toISOString\(\), freshRequestId\(session\.id\), logistics\)/, 'schedule and reschedule must submit the full logistics object');
for (const accessibleName of [
  '创建面试候选人',
  '创建面试形式',
  '排期面试形式',
  '主面试官',
  '参与面试官',
  '取消原因',
]) {
  assert.match(schedule, new RegExp(`aria-label="${accessibleName}"`), `${accessibleName} select must have an accessible name`);
}

assert.match(schedule, /function buildInterviewInvitation\(session, job\)/);
for (const sourceField of [
  'session.candidate_name', 'job?.name', 'session.round', 'session.scheduled_at',
  'session.duration_minutes', 'session.interviewer_assignments', 'session.logistics_note',
]) {
  assert.ok(schedule.includes(sourceField), `invitation copy must include ${sourceField}`);
}
assert.match(schedule, /logisticsLocation\(currentLogistics\(session\)\)/, 'invitation copy must include actual link, address, or phone instructions');
assert.match(schedule, /navigator\.clipboard\.writeText\(draft\)/, 'copy remains a renderer-local clipboard action');
assert.match(schedule, /scheduleAdapter\.markInvitationSent\(session\.id\)/);
assert.match(schedule, /确认已由 HR 手工发送邀请/);
assert.match(schedule, /invitation_sent_by[\s\S]*invitation_sent_at/);
for (const status of ['pending', 'confirmed', 'declined', 'reschedule_requested']) {
  assert.match(schedule, new RegExp(`value: '${status}'`), `candidate confirmation UI must expose ${status}`);
}
const candidateConfirmationHandler = schedule.match(/async function recordCandidateConfirmation[\s\S]*?\n  \}/)?.[0] || '';
assert.match(candidateConfirmationHandler, /scheduleAdapter\.recordCandidateConfirmation\(session\.id, status\)/);
assert.doesNotMatch(candidateConfirmationHandler, /session\.status\s*=|setInterviewSessionStatus/, 'candidate confirmation must never advance session status');
assert.match(schedule, /改期会使当前“已发送”和候选人确认状态失效/);
assert.match(schedule, /const \[expandedLogisticsBySession, setExpandedLogisticsBySession\] = useState\(\{\}\)/);
assert.match(schedule, /\.filter\(interviewLogisticsNeedsAttention\)[\s\S]*?setExpandedLogisticsBySession/,
  'invitation and candidate-confirmation todos must auto-reveal their secondary controls');
assert.match(schedule, /navigationTarget\.type === 'session'[\s\S]*?setExpandedLogisticsBySession/,
  'an exact Session navigation target must reveal its invitation and logistics controls');
assert.match(schedule, /activeKey=\{expandedLogisticsBySession\[String\(session\.id\)\] \? \['details'\] : \[\]\}[\s\S]*?onChange=\{\(keys\) =>/,
  'each Session must keep a user-controlled disclosure state after the mandatory auto-reveal');

assert.match(schedule, /function ScheduleConfirmationHistory/);
assert.match(schedule, /confirmation\.logistics_snapshot/);
assert.match(schedule, /logistics_snapshot\?\.previous_schedule/);
assert.match(schedule, /旧记录未登记完整物流/);
assert.match(schedule, /<LogisticsSnapshot snapshot=\{currentLogistics\(session\)\}/, 'current logistics must remain visible in every session card');
assert.match(schedule, /\{!readOnly && <Collapse[\s\S]*title="本地面试官名录"/,
  'the secondary interviewer directory must remain hidden in read-only mode');
assert.match(schedule, /\{!readOnly && canSchedule/);
assert.match(schedule, /\{!readOnly && session\.invitation_status !== 'sent'/);
assert.match(schedule, /\{!readOnly && <>[\s\S]*aria-label="候选人确认状态"/, 'read-only cards must hide confirmation writes');

assert.match(schedule, /const canonicalPartitionReady = Array\.isArray\(canonicalSessions\) && !canonicalLoadError/,
  'session writes must require a successful authoritative read');
assert.match(schedule, /const canonicalWritesBlocked = !canonicalPartitionReady/);
assert.match(schedule, /if \(!Array\.isArray\(response\?\.sessions\)\) throw new Error\('正式面试记录返回格式无效'\)/,
  'malformed successful responses must remain fail closed');
assert.match(schedule, /正式面试权威数据读取失败，相关写操作已暂停/);
assert.match(schedule, /当前工作台缓存仅供查看；恢复成功前不能创建、排期、改期、取消、标记爽约或记录邀约确认/);
assert.match(schedule, /onClick=\{retryCanonicalSessions\}>重新读取正式面试<\/Button>/,
  'authoritative reads must remain explicitly retryable');
assert.match(schedule, /正在读取正式面试[\s\S]*权威数据返回前，相关写操作暂不可用/,
  'the partition must also fail closed while the first authoritative read is pending');
assert.ok((schedule.match(/disabled=\{canonicalWritesBlocked/g) || []).length >= 8,
  'every authoritative-session submit control must expose the partition write lock');

for (const handlerName of [
  'createSession',
  'schedule',
  'cancelSession',
  'markInvitationSent',
  'recordCandidateConfirmation',
]) {
  const handlerStart = schedule.indexOf(`async function ${handlerName}`);
  assert.notEqual(handlerStart, -1, `${handlerName} handler must exist`);
  const nextHandler = schedule.indexOf('\n  async function ', handlerStart + 1);
  const handler = schedule.slice(handlerStart, nextHandler === -1 ? schedule.length : nextHandler);
  assert.match(handler, /if \(!requireCanonicalWritePartition\(\)\) return;/,
    `${handlerName} must fail closed even if invoked outside its disabled button`);
}

const retryStart = schedule.indexOf('async function retryCanonicalSessions()');
const retryEnd = schedule.indexOf('\n  async function ', retryStart + 1);
const retryHandler = schedule.slice(retryStart, retryEnd);
assert.match(retryHandler, /loadCanonicalSessions\(context\)/);
assert.doesNotMatch(retryHandler, /api\.(createInterviewSession|confirmInterviewSchedule|withdrawInterviewLifecycle|markInterviewInvitationSent|recordInterviewCandidateConfirmation)/,
  'recovery must retry only the authoritative GET, never a write');

for (const call of [
  'createSession', 'confirmSchedule', 'cancelSession',
  'markInvitationSent', 'recordCandidateConfirmation',
]) {
  const index = schedule.indexOf(`scheduleAdapter.${call}`);
  assert.notEqual(index, -1, `scheduleAdapter.${call} must exist`);
  const tail = schedule.slice(index, index + 900);
  assert.match(tail, /if \(!isCurrentContext\(context\)\) return;[\s\S]*loadCanonicalSessions\(context\)[\s\S]*if \(!isCurrentContext\(context\)\) return;[\s\S]*onRefresh\(\)/, `${call} must refresh both canonical and workbench data behind the current-job guard`);
}

assert.match(api, /createInterviewSession: \(\{ candidateId, jobId, interviewFormat, mode \}\)[\s\S]*interviewFormat: interviewFormat \|\| mode/);
assert.match(api, /confirmInterviewSchedule: \(sessionId, scheduledAt, requestId, logistics = undefined\)/);
assert.match(api, /listInterviewers: \(includeInactive = false\)/);
assert.match(api, /saveInterviewInterviewer: \(input\)/);
assert.match(api, /markInterviewInvitationSent: \(sessionId\)/);
assert.match(api, /recordInterviewCandidateConfirmation: \(sessionId, status\)/);
assert.match(api, /listInterviewSessions: \(candidateId, jobId\)[\s\S]*operationalReadGet\(`\/interview-session\?\$\{params\.toString\(\)\}`\)/);

assert.doesNotMatch(schedule, /\.ics|日历同步|自动建会|冲突检测|notification/i, 'convenience and external integration scope must stay out of this card');

console.log(JSON.stringify({
  ok: true,
  contract: 'INTERVIEW-LOGISTICS-UI-001',
  canonical_job_guard: 'id-plus-token',
  formats: ['online', 'offline', 'phone'],
  invitation_copy_is_local: true,
  read_only_writes_hidden: true,
  backend_or_external_integration_added: false,
}));
