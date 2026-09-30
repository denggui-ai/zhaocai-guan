'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, 'frontend', 'src', 'components', 'InterviewScheduleCanonical.jsx'),
  'utf8',
);

assert.match(source, /function buildInterviewInvitation\(session, job\)/, 'canonical schedule must build its own invitation copy');
assert.match(source, /session\.candidate_name/, 'invitation must use the current session candidate');
assert.match(source, /job\?\.name/, 'invitation must use the current job');
assert.match(source, /fmtTime\(session\.scheduled_at\)/, 'invitation must use the confirmed schedule time');
assert.match(source, /session\.mode === 'offline'/, 'invitation must distinguish online and offline interviews');
assert.match(source, /<Input\.TextArea[\s\S]*value=\{draft\}[\s\S]*onChange=/, 'HR must be able to edit the invitation before copying');
assert.match(source, /navigator\.clipboard\.writeText\(draft\)/, 'copy must only use the local clipboard');
assert.match(source, /请先完成本轮排期/, 'unscheduled sessions must tell HR to schedule first');
assert.match(source, /系统不会自动发送/, 'the UI must state that it does not auto-send');
assert.match(source, /不自动发送、不保存/, 'the editable copy must state its local-only boundary');
assert.match(source, /<InterviewInvitationEditor key=\{invitationEditorKey\} session=\{session\} job=\{job\}/, 'invitation editor must stay inside an existing session card');

console.log(JSON.stringify({ ok: true, contract: 'restore-interview-copy-001' }));
