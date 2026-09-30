'use strict';

const fs = require('fs');
const path = require('path');
const { spawnAssessmentParser } = require('./assessment-parser-runner');

const ANALYSIS_SCHEMA_VERSION = 'assessment_report_analysis_v2';
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60 * 1000;

class AssessmentReportAnalysisError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AssessmentReportAnalysisError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AssessmentReportAnalysisError(code, message);
}

function clean(value, maximum = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function matchClean(text, pattern, maximum) {
  const match = text.match(pattern);
  return match ? clean(match[1], maximum) : null;
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function parseLevelItems(text, startPattern, endPattern, maximum = 8) {
  const start = text.search(startPattern);
  if (start < 0) return [];
  const remainder = text.slice(start);
  const end = remainder.search(endPattern);
  const block = end > 0 ? remainder.slice(0, end) : remainder.slice(0, 6000);
  const items = [];
  for (const match of block.matchAll(/^\s*([\u4e00-\u9fff]{2,8})\s+(-?[1-5])(?:级)?\s*$/gm)) {
    if (!items.some((item) => item.name === match[1])) items.push({ name: match[1], level: Number(match[2]) });
    if (items.length >= maximum) break;
  }
  return items;
}

function parseCareerMatches(text) {
  const categories = ['销售类', '市场类', '服务类', '研发类', '技术类'];
  const matches = [];
  const overview = text.indexOf('职业匹配-总览');
  if (overview < 0) return matches;
  const source = text.slice(overview, overview + 9000);
  for (const category of categories) {
    const pattern = new RegExp(`${category}\\s*\\n\\s*(\\d+(?:\\.\\d+)?)%\\s+(\\d+(?:\\.\\d+)?)%\\s+(\\d+(?:\\.\\d+)?)%\\s*\\n\\s*([\\u4e00-\\u9fff]{2,8})\\s+([\\u4e00-\\u9fff]{2,8})\\s+([\\u4e00-\\u9fff]{2,8})`);
    const found = source.match(pattern);
    if (!found) continue;
    for (let index = 0; index < 3; index += 1) {
      matches.push({ category, name: found[4 + index], percentage: Number(found[1 + index]) });
    }
  }
  return matches.sort((left, right) => right.percentage - left.percentage);
}

function analyzeAssessmentReportText(input, options = {}) {
  const text = String(input || '').replace(/\r/g, '');
  if (!text.trim()) fail('ASSESSMENT_REPORT_TEXT_EMPTY', 'PDF 未提取到可分析文字。');

  let reportType = 'unknown';
  let reportTypeLabel = '未识别报告';
  if (/职业潜能测评报告|职业匹配-总览/.test(text)) {
    reportType = 'career_potential';
    reportTypeLabel = '职业潜能报告';
  } else if (/职场风格测评报告|在职场中较常展现的行为是/.test(text)) {
    reportType = 'workplace_style';
    reportTypeLabel = '职场风格报告';
  } else if (/团队角色测评报告|团队角色呈现为/.test(text)) {
    reportType = 'team_role';
    reportTypeLabel = '团队角色报告';
  }

  const subjectName = matchClean(text, /姓名[：:]\s*([^\s]+)\s+性别[：:]/, 40);
  const assessedJob = matchClean(text, /^\s*岗位[：:]\s*([^\n]+)/m, 80);
  const assessmentDate = matchClean(text, /(?:测试|测评)日期[：:]\s*(\d{4}-\d{2}-\d{2})/, 10);
  const validity = matchClean(text, /^\s*信效度[：:]\s*([^\s]+)/m, 20);
  const highlights = [];
  let strengths = [];
  let watchouts = [];
  let careerMatches = [];
  const interviewQuestions = [];
  const decisionSupport = {};
  const details = {};

  if (reportType === 'career_potential') {
    strengths = parseLevelItems(text, /^潜能排列\s*$/m, /职业匹配-总览|本系统著作权/, 8);
    careerMatches = parseCareerMatches(text);
    if (strengths.length) highlights.push({ label: '优势潜能', value: strengths.slice(0, 4).map((item) => `${item.name} ${item.level}级`).join('、') });
    if (careerMatches.length) highlights.push({ label: '高匹配方向', value: careerMatches.slice(0, 3).map((item) => `${item.category}${item.name} ${item.percentage.toFixed(2)}%`).join('、') });
    if (careerMatches.length) {
      decisionSupport.score = careerMatches[0].percentage;
      decisionSupport.score_label = '供应商职业方向最高匹配';
      decisionSupport.direction = `${careerMatches[0].category}${careerMatches[0].name}`;
      decisionSupport.basis = '供应商报告职业匹配百分比';
    }
    for (const item of strengths.slice(0, 3)) {
      interviewQuestions.push(`请举例说明你在实际工作中如何运用“${item.name}”，结果如何？`);
    }
  } else if (reportType === 'workplace_style') {
    const behavior = parseLevelItems(text, /在职场中较常展现的行为是/, /注意！|本系统著作权/, 8);
    const motivation = parseLevelItems(text, /能够明显激励[^\n]*的动机特质是[：:]?/, /本系统著作权/, 8);
    const adaptiveMode = matchClean(text, /适应模式[：:]\s*([A-Z]+)/, 12);
    const naturalMode = matchClean(text, /自然模式[：:]\s*([A-Z]+)/, 12);
    const combinedModes = [...text.matchAll(/综合模式[：:]\s*([A-Z]+)/g)].map((item) => item[1]);
    const combinedMode = combinedModes.length ? combinedModes[combinedModes.length - 1] : null;
    const consistency = matchClean(text, /一致性分析[：:]\s*([^\n]+)/, 40);
    const pressure = text.match(/压力源[：:]\s*([^\s]+)\s+可能影响[：:]\s*([^\s]+)/);
    strengths = behavior;
    details.behavior = behavior;
    details.motivation = motivation;
    details.adaptive_mode = adaptiveMode;
    details.natural_mode = naturalMode;
    details.combined_mode = combinedMode;
    details.consistency = consistency;
    details.pressure_source = pressure ? clean(pressure[1], 30) : null;
    details.pressure_impact = pressure ? clean(pressure[2], 30) : null;
    if (combinedMode) highlights.push({ label: '综合模式', value: combinedMode });
    if (behavior.length) highlights.push({ label: '常见行为', value: behavior.slice(0, 4).map((item) => `${item.name} ${item.level}级`).join('、') });
    if (consistency) highlights.push({ label: '当前状态', value: consistency });
    if (pressure) {
      highlights.push({ label: '压力提示', value: `${clean(pressure[1], 30)}（影响${clean(pressure[2], 30)}）` });
      watchouts.push(`压力源：${clean(pressure[1], 30)}，可能影响：${clean(pressure[2], 30)}`);
      interviewQuestions.push(`当工作要求你持续面对“${clean(pressure[1], 30)}”时，你通常如何调整？请举一个近期例子。`);
    }
    for (const item of behavior.slice(0, 2)) {
      interviewQuestions.push(`请用具体项目说明“${item.name}”如何影响你的工作结果。`);
    }
    if (combinedMode) {
      decisionSupport.profile_label = `综合行为模式 ${combinedMode}`;
      decisionSupport.basis = '供应商职场风格行为模式';
    }
  } else if (reportType === 'team_role') {
    const naturalRole = matchClean(text, /团队角色呈现为[：:]\s*([^\n]+)/, 60);
    const managementStyle = matchClean(text, /期待的管理方式[：:]\s*([^\n]+)/, 80);
    const transitionRole = matchClean(text, /角色转变方向[：:]\s*([^\n]+)/, 60);
    const currentState = matchClean(text, /目前状态[：:]\s*([^\n]+)/, 40);
    const currentRole = matchClean(text, /在职场中\/他人眼中，呈现为[：:]\s*([^\n]+)/, 60);
    Object.assign(details, {
      natural_role: naturalRole,
      management_style: managementStyle,
      transition_role: transitionRole,
      current_state: currentState,
      current_role: currentRole,
    });
    if (naturalRole) highlights.push({ label: '自然团队角色', value: naturalRole });
    if (currentRole) highlights.push({ label: '职场呈现角色', value: currentRole });
    if (managementStyle) highlights.push({ label: '期待管理方式', value: managementStyle });
    if (currentState) highlights.push({ label: '当前状态', value: currentState });
    if (naturalRole) interviewQuestions.push(`你认为自己在团队中更接近“${naturalRole}”吗？请用一次真实协作经历说明。`);
    if (naturalRole && currentRole && naturalRole !== currentRole) {
      interviewQuestions.push(`报告显示你的自然角色与职场呈现角色不同，这种转变通常由什么工作情境触发？`);
    }
    if (currentRole) {
      decisionSupport.profile_label = `当前团队角色 ${currentRole}`;
      decisionSupport.basis = '供应商团队角色模型';
    }
  }

  const facts = unique([
    reportTypeLabel,
    subjectName ? `受测者 ${subjectName}` : null,
    assessedJob ? `测评岗位 ${assessedJob}` : null,
    validity ? `信效度 ${validity}` : null,
    ...highlights.slice(0, 2).map((item) => `${item.label}：${item.value}`),
  ]);

  return Object.freeze({
    schema_version: ANALYSIS_SCHEMA_VERSION,
    source: String(options.source || 'supplier_pdf_text'),
    ...(options.ocr && typeof options.ocr === 'object' ? { ocr: options.ocr } : {}),
    report_type: reportType,
    report_type_label: reportTypeLabel,
    subject_name: subjectName,
    assessed_job: assessedJob,
    assessment_date: assessmentDate,
    validity,
    summary: facts.join('；').slice(0, 900),
    highlights: highlights.slice(0, 8),
    strengths: strengths.slice(0, 8),
    watchouts: watchouts.slice(0, 6),
    career_matches: careerMatches,
    interview_questions: unique(interviewQuestions).slice(0, 6),
    decision_support: decisionSupport,
    details,
  });
}

function inspectPdf(input, controlledRootInput) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) {
    fail('ASSESSMENT_REPORT_FILE_INVALID', 'PDF 分析输入无效。');
  }
  if (typeof controlledRootInput !== 'string' || !path.isAbsolute(controlledRootInput)) {
    fail('ASSESSMENT_REPORT_ROOT_INVALID', 'PDF 分析受控目录无效。');
  }
  try {
    const root = fs.realpathSync(controlledRootInput);
    const targetStat = fs.lstatSync(input);
    const target = fs.realpathSync(input);
    const relative = path.relative(root, target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile() || !relative
        || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('invalid');
    return { target, root, stat: fs.statSync(target) };
  } catch {
    fail('ASSESSMENT_REPORT_FILE_INVALID', 'PDF 分析输入无效。');
  }
}

function resolveExecutable(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) {
    fail('ASSESSMENT_REPORT_TOOL_UNAVAILABLE', 'PDF 文字提取工具不可用。');
  }
  try {
    const target = fs.realpathSync(input);
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new Error('invalid');
    fs.accessSync(target, fs.constants.X_OK);
    return target;
  } catch {
    fail('ASSESSMENT_REPORT_TOOL_UNAVAILABLE', 'PDF 文字提取工具不可用。');
  }
}

function extractText(fileInfo, executable, options) {
  return new Promise((resolve, reject) => {
    const parserRunner = options.parserRunner || spawnAssessmentParser;
    let runner;
    try {
      runner = parserRunner(executable, ['-layout', '-nopgbrk', fileInfo.target, '-'], {
        inputPath: fileInfo.target,
        workingDirectory: fileInfo.root,
        maxFileBytes: MAX_TEXT_BYTES + MAX_ERROR_BYTES,
      });
    } catch (error) {
      reject(new AssessmentReportAnalysisError(error.code || 'ASSESSMENT_REPORT_PROCESS_FAILED', 'PDF 文字提取进程不可用。'));
      return;
    }
    const stdout = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError = null;
    const timeoutMs = Math.min(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const timer = setTimeout(() => {
      terminalError = new AssessmentReportAnalysisError('ASSESSMENT_REPORT_TIMEOUT', 'PDF 文字提取超时。');
      runner.kill();
    }, timeoutMs);
    runner.child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_TEXT_BYTES) {
        terminalError = new AssessmentReportAnalysisError('ASSESSMENT_REPORT_TEXT_LIMIT', 'PDF 可提取文字超过限制。');
        runner.kill();
      } else stdout.push(chunk);
    });
    runner.child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_ERROR_BYTES) {
        terminalError = new AssessmentReportAnalysisError('ASSESSMENT_REPORT_ERROR_LIMIT', 'PDF 文字提取诊断超过限制。');
        runner.kill();
      }
    });
    runner.child.once('error', () => {
      terminalError = terminalError || new AssessmentReportAnalysisError('ASSESSMENT_REPORT_PROCESS_FAILED', 'PDF 文字提取失败。');
    });
    runner.child.once('close', (code) => {
      clearTimeout(timer);
      const resourceError = runner.finish();
      if (terminalError) return reject(terminalError);
      if (resourceError) return reject(new AssessmentReportAnalysisError(resourceError.code, 'PDF 文字提取资源检查失败。'));
      if (code !== 0) return reject(new AssessmentReportAnalysisError('ASSESSMENT_REPORT_PROCESS_FAILED', 'PDF 文字提取失败。'));
      const current = fs.statSync(fileInfo.target);
      if (current.dev !== fileInfo.stat.dev || current.ino !== fileInfo.stat.ino || current.size !== fileInfo.stat.size
          || current.mtimeMs !== fileInfo.stat.mtimeMs) {
        return reject(new AssessmentReportAnalysisError('ASSESSMENT_REPORT_FILE_CHANGED', 'PDF 分析输入发生变化。'));
      }
      return resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

async function analyzeAssessmentReportPdf(input, options = {}) {
  const fileInfo = inspectPdf(input, options.controlledRoot);
  const executable = resolveExecutable(options.pdftotextExecutablePath);
  const text = await extractText(fileInfo, executable, options);
  return analyzeAssessmentReportText(text);
}

module.exports = {
  ANALYSIS_SCHEMA_VERSION,
  AssessmentReportAnalysisError,
  analyzeAssessmentReportPdf,
  analyzeAssessmentReportText,
};
