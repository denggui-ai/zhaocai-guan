// Local collector for the desktop Feishu/Lark P0 interview test.
// It does not call Feishu OpenAPI or any external API. It only inspects local files.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensurePrivateDir, writePrivateFile } = require('./secure-fs');

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v']);
const AUDIO_EXTS = new Set(['.m4a', '.mp3', '.wav', '.aac']);
const TRANSCRIPT_EXTS = new Set(['.txt', '.srt', '.vtt', '.md', '.json', '.html']);

function usage() {
  return `
Usage:
  node feishu-desktop-p0-collect.js [meeting_dir] [--out-dir dir] [--include-transcript]

Examples:
  node feishu-desktop-p0-collect.js
  node feishu-desktop-p0-collect.js '/Users/me/Documents/Feishu/20260709185414_测试会议'

Notes:
  - No Feishu OpenAPI or external API calls.
  - Scans the local Feishu Documents folder or the provided meeting directory.
  - Generates a P0 evidence summary and a Codex input packet.
  - Transcript file contents are not copied into the packet unless --include-transcript is set.
`.trim();
}

function parseArgs(argv) {
  const args = { positional: [], outDir: process.cwd(), includeTranscript: false };
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--help' || item === '-h') args.help = true;
    else if (item === '--include-transcript') args.includeTranscript = true;
    else if (item === '--out-dir') {
      if (!argv[i + 1]) throw new Error('missing value for --out-dir');
      args.outDir = argv[i + 1];
      i += 1;
    } else if (item.startsWith('--')) {
      throw new Error(`unknown option: ${item}`);
    } else {
      args.positional.push(item);
    }
  }
  return args;
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function listFilesRecursive(root, maxDepth = 4, depth = 0) {
  const stat = safeStat(root);
  if (!stat) return [];
  if (stat.isFile()) return [root];
  if (!stat.isDirectory() || depth >= maxDepth) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(child, maxDepth, depth + 1));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function defaultFeishuDir() {
  return path.join(os.homedir(), 'Documents', 'Feishu');
}

function latestMeetingDir(feishuDir) {
  const entries = fs.readdirSync(feishuDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(feishuDir, entry.name);
      const stat = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!entries.length) throw new Error(`no meeting directories found under ${feishuDir}`);
  return entries[0].fullPath;
}

function mdlsRaw(filePath, key) {
  try {
    const value = execFileSync('mdls', ['-raw', '-name', key, filePath], { encoding: 'utf8' }).trim();
    return value === '(null)' ? '' : value;
  } catch {
    return '';
  }
}

function mediaDurationSeconds(filePath) {
  const raw = mdlsRaw(filePath, 'kMDItemDurationSeconds');
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  const rounded = Math.round(seconds);
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

function classify(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (TRANSCRIPT_EXTS.has(ext)) return 'transcript';
  return 'other';
}

function rel(base, filePath) {
  return path.relative(base, filePath) || path.basename(filePath);
}

function readTranscriptPreview(filePath, includeFull) {
  const ext = path.extname(filePath).toLowerCase();
  if (!TRANSCRIPT_EXTS.has(ext)) return '';
  const text = fs.readFileSync(filePath, 'utf8');
  return includeFull ? text : text.slice(0, 1200);
}

function buildReport({ meetingDir, files, outDir, includeTranscript }) {
  const generatedAt = new Date().toISOString();
  const mediaFiles = files.filter((file) => ['video', 'audio'].includes(classify(file))).map((file) => {
    const stat = fs.statSync(file);
    const duration = mediaDurationSeconds(file);
    return {
      path: file,
      name: rel(meetingDir, file),
      type: classify(file),
      bytes: stat.size,
      duration,
      durationText: formatDuration(duration),
      modifiedAt: stat.mtime.toISOString(),
    };
  });
  const transcriptFiles = files.filter((file) => classify(file) === 'transcript').map((file) => {
    const stat = fs.statSync(file);
    return {
      path: file,
      name: rel(meetingDir, file),
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      preview: readTranscriptPreview(file, includeTranscript),
    };
  });

  const hasEnoughRecording = mediaFiles.some((file) => Number.isFinite(file.duration) && file.duration >= 300);
  const hasTranscript = transcriptFiles.length > 0;
  const status = hasTranscript ? 'ready_for_codex_analysis' : 'waiting_for_feishu_minutes_transcript';

  const summaryPath = path.join(outDir, '面试妙记P0自动化收集结果-20260709.md');
  const packetPath = path.join(outDir, '面试妙记P0-Codex输入包-20260709.md');

  const mediaRows = mediaFiles.length
    ? mediaFiles.map((file) => `| \`${file.name}\` | ${file.type} | ${file.durationText} | ${file.bytes} | ${file.modifiedAt} |`).join('\n')
    : '| 无 | - | - | - | - |';
  const transcriptRows = transcriptFiles.length
    ? transcriptFiles.map((file) => `| \`${file.name}\` | ${file.bytes} | ${file.modifiedAt} |`).join('\n')
    : '| 未发现 | - | - |';

  const summary = `# 面试妙记 P0 自动化收集结果

> 生成时间：${generatedAt}  
> 会议目录：\`${meetingDir}\`  
> 口径：只检查本地文件，不调用飞书 OpenAPI 或任何外部 API。

## 自动判断

| 项 | 结果 |
|---|---|
| 当前状态 | \`${status}\` |
| 是否发现录制文件 | ${mediaFiles.length ? '是' : '否'} |
| 是否有 >= 5 分钟录制 | ${hasEnoughRecording ? '是' : '否'} |
| 是否发现 transcript 文件 | ${hasTranscript ? '是' : '否'} |

## 录制文件

| 文件 | 类型 | 时长 | 大小 bytes | 修改时间 |
|---|---|---:|---:|---|
${mediaRows}

## transcript 文件

| 文件 | 大小 bytes | 修改时间 |
|---|---:|---|
${transcriptRows}

## 下一步

${hasTranscript
    ? `已发现 transcript 文件，可用 \`${path.basename(packetPath)}\` 进入 Codex 分析。`
    : '本地目录尚未发现 transcript。请在电脑版飞书打开本场妙记，导出或复制 transcript 到该目录，然后重新运行本脚本。'}
`;

  const transcriptSection = transcriptFiles.length
    ? transcriptFiles.map((file) => `## Transcript: ${file.name}\n\n\`\`\`text\n${file.preview}\n\`\`\`\n`).join('\n')
    : `## Transcript\n\n尚未发现 transcript 文件。请从飞书妙记复制/导出文本后重新运行收集脚本。\n`;

  const packet = `# 面试妙记 P0 Codex 输入包

> 生成时间：${generatedAt}  
> 会议目录：\`${meetingDir}\`  
> 自动状态：\`${status}\`

## 证据摘要

- 录制文件数：${mediaFiles.length}
- transcript 文件数：${transcriptFiles.length}
- 最长录制时长：${formatDuration(Math.max(0, ...mediaFiles.map((file) => file.duration || 0)))}
- 满足 P0 最短录制时长：${hasEnoughRecording ? '是' : '否'}

${transcriptSection}

## Codex 分析提示词

\`\`\`text
你是 HRBOSS 面试 AI 分析助手。请只基于上面的 transcript 生成结构化面试复盘 JSON，不要脑补，不要调用外部工具或 API。

输出要求：
1. 只输出合法 JSON，不要输出 Markdown。
2. 必须包含 schema_version、summary、dimension_matches、concerns、unknowns、followup_questions、decision_support、human_confirm_required、disclaimer。
3. schema_version 固定为 interview_ai_report_p0_v1。
4. 每个能力判断必须引用 transcript 证据；没有聊到就写入 unknowns。
5. decision_support 只能是 建议推进 / 待定 / 不建议推进，且只能作为人工复盘辅助。
6. human_confirm_required 必须为 true。
7. 不得基于年龄、性别、婚育、健康、地域、声音、口音、停顿、情绪等做判断。
8. 不允许输出自动录用、自动淘汰、SABC、百分制评分、质量分或薪资建议。
\`\`\`
`;

  ensurePrivateDir(outDir);
  writePrivateFile(summaryPath, summary);
  writePrivateFile(packetPath, packet);

  return {
    generatedAt,
    meetingDir,
    outDir,
    summaryPath,
    packetPath,
    status,
    mediaFiles,
    transcriptFiles,
    hasEnoughRecording,
    hasTranscript,
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const input = args.positional[0];
  const meetingDir = path.resolve(input || latestMeetingDir(defaultFeishuDir()));
  const stat = safeStat(meetingDir);
  if (!stat || !stat.isDirectory()) throw new Error(`meeting directory not found: ${meetingDir}`);

  const outDir = path.resolve(args.outDir);
  const files = listFilesRecursive(meetingDir);
  const result = buildReport({ meetingDir, files, outDir, includeTranscript: args.includeTranscript });
  console.log(JSON.stringify({
    status: result.status,
    meetingDir: result.meetingDir,
    summaryPath: result.summaryPath,
    packetPath: result.packetPath,
    mediaFiles: result.mediaFiles.map((file) => ({
      path: file.path,
      durationText: file.durationText,
      bytes: file.bytes,
    })),
    transcriptFiles: result.transcriptFiles.map((file) => file.path),
  }, null, 2));
}

if (require.main === module) {
  main();
}
