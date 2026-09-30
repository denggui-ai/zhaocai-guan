'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(file) {
  return fs.readFileSync(path.join(__dirname, file), 'utf8');
}

const app = read('frontend/src/App.jsx');
const settings = read('frontend/src/components/SettingsPanel.jsx');
const job = read('frontend/src/components/JobManagementPanel.jsx');
const deep = read('frontend/src/components/DeepProfileModal.jsx');
const candidate = read('frontend/src/components/CandidateDetail.jsx');
const assessment = read('frontend/src/components/AssessmentArchivePanel.jsx');
const interview = read('frontend/src/components/InterviewReviewPanel.jsx');

assert.match(app, /const \[aiSettingsReturnContext, setAiSettingsReturnContext\] = useState\(null\)/);
assert.match(app, /const \[aiResumeIntent, setAiResumeIntent\] = useState\(null\)/);
assert.match(app, /handleOpenSettings\([\s\S]*?'settings-integrations'[\s\S]*?'settings-external-ai-title'/);
assert.match(app, /setAiSettingsReturnContext\(nextIntent\)/);
assert.match(app, /setAiResumeIntent\(\{ \.\.\.intent, resumeAction, resumedAt: Date\.now\(\) \}\)/);
assert.match(app, /preserveSourceDraft: Boolean\(intent\.draftSnapshot\)/);
assert.match(app, /if \(intent\.capability === 'job_jd'\) setJobManagementView\('editor'\)/);
assert.match(app, /if \(intent\.capability === 'deep_profile'\)[\s\S]*setDeepOpen\(true\)/);
assert.match(app, /if \(intent\.capability === 'candidate_assessment'\) setDetailInitialDomain\('profile'\)/);
assert.match(app, /if \(intent\.capability === 'assessment_analysis'\) setDetailInitialDomain\('assessment'\)/);
assert.match(app, /if \(intent\.capability === 'interview_review'\)[\s\S]*setDetailInitialDomain\('interview'\)/);
assert.match(app, /focusSettingsTarget\(intent\.focusTargetId\)/,
  'source return must win the module-heading focus race');
assert.match(settings, /hasAiReturnContext \? '返回刚才的 AI 操作' : '返回工作台'/);
assert.match(settings, /llmNextStep\.state === 'ready' && hasAiReturnContext\) onReturnToAiOperation\?\.\(\)/);
assert.match(settings, /hasAiReturnContext\) onReturnToAiOperation\?\.\(\{ resumeAction: false \}\)/);

for (const [name, source, capability] of [
  ['job JD', job, 'job_jd'],
  ['deep profile', deep, 'deep_profile'],
  ['candidate assessment', candidate, 'candidate_assessment'],
  ['assessment analysis', assessment, 'assessment_analysis'],
  ['interview review', interview, 'interview_review'],
]) {
  assert.match(source, new RegExp(`aiResumeIntent\\?\\.capability !== '${capability}'`), `${name} must match its return intent`);
  assert.match(source, /onAiResumeConsumed\?\.\(intent\.id\)/, `${name} must consume a return intent once`);
  assert.match(source, /focusTargetId/, `${name} must preserve or restore the source focus target`);
  assert.match(source, /intent\.resumeAction !== false/, `${name} must distinguish restore-only return from an explicit resumed action`);
}

assert.match(job, /draftSnapshot: \{[\s\S]*jdBrief,[\s\S]*profileForm,[\s\S]*hardBarForm,[\s\S]*activeSection/);
assert.match(deep, /draftSnapshot: \{[\s\S]*ivText,[\s\S]*ivUrl,[\s\S]*sourceType/);
assert.match(interview, /draftSnapshot: \{[\s\S]*scriptDraft,[\s\S]*sessionFacts,[\s\S]*confirmations/);
assert.match(job, /optimizeJdWithAi[\s\S]*api\.confirmExternalAiApproval/);
assert.match(deep, /handleGenerate[\s\S]*api\.confirmExternalAiApproval/);
assert.match(candidate, /void onAssess\('real'\)/);
assert.match(assessment, /void generateAiAnalysis\(\)/);
assert.match(assessment, /generateAiAnalysis[\s\S]*api\.confirmExternalAiApproval/);
assert.match(interview, /void previewLlmAnalysis\(/);
assert.match(interview, /analyzeLlmPreview[\s\S]*api\.confirmInterviewLlmApproval/);
assert.match(candidate, /if \(!aiResumeIntent\) return;[\s\S]*aiResumeIntent\.capability/,
  'candidate workspace must ignore the empty return intent without a renderer error');

const interviewResume = interview.slice(
  interview.indexOf("aiResumeIntent?.capability !== 'interview_review'"),
  interview.indexOf('function setInterviewActiveTab'),
);
assert.doesNotMatch(interviewResume, /analyzeInterviewLlm|confirmInterviewLlmApproval/,
  'returning to interview review may restore the preview, but must not send or approve automatically');

console.log(JSON.stringify({
  ok: true,
  contract: 'ai-first-use-return-001',
  capabilities: 5,
  return_context: 'in-memory',
  evidence_level: 'source-contract-only',
  native_confirmation_runtime_check: 'check:ai-native-approval-runtime',
  automatic_external_send_claimed_by_this_check: false,
}));
