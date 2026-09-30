// Local ASR model benchmark for HRBOSS interview transcription research.
// Runs whisper.cpp models against the same WAV file and writes comparable artifacts.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensurePrivateDir, writePrivateFile } = require('./secure-fs');

const DEFAULT_AUDIO = path.join(__dirname, '..', 'tmp', 'feishu-import-transcribe-check', 'audio.wav');
const DEFAULT_OUT_DIR = path.join(__dirname, '..', 'tmp', 'asr-model-benchmark');
const MODEL_DIR = path.join(os.homedir(), '.cache', 'whisper.cpp');
const KNOWN_MODELS = {
  tiny: path.join(MODEL_DIR, 'ggml-tiny.bin'),
  base: path.join(MODEL_DIR, 'ggml-base.bin'),
  small: path.join(MODEL_DIR, 'ggml-small.bin'),
  medium: path.join(MODEL_DIR, 'ggml-medium.bin'),
  large: path.join(MODEL_DIR, 'ggml-large-v3.bin'),
};

function usage() {
  return `
Usage:
  node asr-model-benchmark-p0.js [--audio wav] [--models base,small] [--out-dir dir]

Examples:
  node asr-model-benchmark-p0.js
  node asr-model-benchmark-p0.js --audio /path/to/audio.wav --models base,small

Notes:
  - This script uses local whisper.cpp only.
  - It does not download models and does not call transcription APIs.
`.trim();
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--help') {
      args.help = true;
      continue;
    }
    if (!item.startsWith('--')) throw new Error(`unexpected argument: ${item}`);
    const key = item.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  return args;
}

function which(bin) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return '';
}

function ensureDir(dir) {
  return ensurePrivateDir(dir);
}

function modelPath(modelSpec) {
  if (modelSpec.includes('/') || modelSpec.endsWith('.bin')) return path.resolve(modelSpec);
  return KNOWN_MODELS[modelSpec] || path.join(MODEL_DIR, `ggml-${modelSpec}.bin`);
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function countSrtSegments(filePath) {
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\d+$/.test(line.trim())) count = Number(line.trim());
  }
  return count;
}

function readJsonSummary(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const transcription = Array.isArray(data.transcription) ? data.transcription : [];
    return {
      jsonOk: true,
      segmentCount: transcription.length,
      first: transcription[0] || null,
      last: transcription[transcription.length - 1] || null,
    };
  } catch (err) {
    return {
      jsonOk: false,
      segmentCount: 0,
      first: null,
      last: null,
      jsonError: err.message,
    };
  }
}

function runWhisper({ whisperCli, modelName, model, audio, outDir }) {
  const modelOutDir = ensureDir(path.join(outDir, modelName.replace(/[\\/:"*?<>|]+/g, '-')));
  const outputBase = path.join(modelOutDir, 'transcript');
  const startedAt = new Date();
  const start = process.hrtime.bigint();
  const result = spawnSync(whisperCli, [
    '-m', model,
    '-f', audio,
    '-l', 'zh',
    '-otxt',
    '-osrt',
    '-oj',
    '-of', outputBase,
  ], { encoding: 'utf8' });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const finishedAt = new Date();
  const txtPath = `${outputBase}.txt`;
  const srtPath = `${outputBase}.srt`;
  const jsonPath = `${outputBase}.json`;
  const json = readJsonSummary(jsonPath);
  const transcriptText = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8') : '';
  return {
    modelName,
    modelPath: model,
    status: result.status === 0 ? 'done' : 'error',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs: Math.round(elapsedMs),
    txtPath,
    srtPath,
    jsonPath,
    txtBytes: fileSize(txtPath),
    srtBytes: fileSize(srtPath),
    jsonBytes: fileSize(jsonPath),
    srtSegmentCount: countSrtSegments(srtPath),
    jsonOk: json.jsonOk,
    jsonSegmentCount: json.segmentCount,
    firstSegment: json.first,
    lastSegment: json.last,
    sampleText: transcriptText.slice(0, 500),
    stderrTail: String(result.stderr || '').slice(-3000),
    stdoutTail: String(result.stdout || '').slice(-3000),
  };
}

function writeMarkdown({ summary, outDir }) {
  const lines = [];
  lines.push('# ASR Model Benchmark P0');
  lines.push('');
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push(`> Audio: \`${summary.audio}\``);
  lines.push('');
  lines.push('| Model | Status | Runtime | TXT | SRT Segments | JSON OK | Last Timestamp |');
  lines.push('|---|---|---:|---:|---:|---|---|');
  for (const item of summary.results) {
    const last = item.lastSegment && item.lastSegment.timestamps ? item.lastSegment.timestamps.to : '';
    lines.push(`| ${item.modelName} | ${item.status} | ${(item.elapsedMs / 1000).toFixed(1)}s | ${item.txtBytes} | ${item.srtSegmentCount} | ${item.jsonOk ? 'yes' : 'no'} | ${last} |`);
  }
  lines.push('');
  lines.push('## Sample Text');
  for (const item of summary.results) {
    lines.push('');
    lines.push(`### ${item.modelName}`);
    lines.push('');
    lines.push('```text');
    lines.push(item.sampleText.trim());
    lines.push('```');
  }
  writePrivateFile(path.join(outDir, 'benchmark-summary.md'), `${lines.join('\n')}\n`);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const whisperCli = which('whisper-cli');
  if (!whisperCli) throw new Error('whisper-cli not found. Install with: brew install whisper-cpp');
  const audio = path.resolve(args.audio || DEFAULT_AUDIO);
  if (!fs.existsSync(audio)) throw new Error(`audio file not found: ${audio}`);
  const outDir = ensureDir(path.resolve(args['out-dir'] || DEFAULT_OUT_DIR));
  const requested = String(args.models || 'base,small').split(',').map((item) => item.trim()).filter(Boolean);
  const results = [];
  const skipped = [];
  for (const modelName of requested) {
    const model = modelPath(modelName);
    if (!fs.existsSync(model)) {
      skipped.push({ modelName, modelPath: model, reason: 'model file not found' });
      continue;
    }
    console.error(`Benchmarking ${modelName}: ${model}`);
    results.push(runWhisper({ whisperCli, modelName, model, audio, outDir }));
  }
  const summary = {
    ok: results.length > 0,
    audio,
    outDir,
    requested,
    skipped,
    results,
  };
  writePrivateFile(path.join(outDir, 'benchmark-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeMarkdown({ summary, outDir });
  console.log(JSON.stringify(summary, null, 2));
  if (results.length === 0) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}
