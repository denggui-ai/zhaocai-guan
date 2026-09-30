// Local interview recorder/transcriber for HRBOSS P0.
// No Feishu OpenAPI and no external transcription API. Uses local microphone/files,
// Apple afconvert, SoX rec, and whisper.cpp when available.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ensurePrivateFile, hardenPrivateDir, writePrivateFile } = require('./secure-fs');
const { GUARDIAN_IPC_SCHEMA } = require('./local-interview-guardian-protocol');
const {
  getInterviewMaterialRoot,
  prepareInterviewMaterialDirectory,
  prepareInterviewMaterialFileTarget,
  readAndValidateInterviewSummary,
  readControlledTextFile,
  validateImportedMediaSource,
  validateInterviewMaterialFile,
} = require('./interview-material-paths');
const {
  buildCanonicalTranscript,
  readCanonicalTranscript,
} = require('./interview-transcript-cues');

const DEFAULT_MODEL = path.join(os.homedir(), '.cache', 'whisper.cpp', 'ggml-base.bin');
const DEFAULT_OUTPUT_ROOT = getInterviewMaterialRoot();
const AUDIO_EXTS = new Set(['.wav', '.aiff', '.aif', '.m4a', '.mp3', '.aac', '.flac', '.ogg']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v']);
const WINDOWS_LOCAL_ASR_REASON = 'windows_local_recording_asr_not_packaged';
const WINDOWS_LOCAL_ASR_MESSAGE = '当前 Windows 候选包未打包本地录音与 ASR 能力；麦克风预检、录音、导入转写和本地转写均已禁用。';
const LIVE_AUDIO_TELEMETRY_PREFIX = '@@HRBOSS_LIVE_AUDIO@@';
const LIVE_AUDIO_SAMPLE_INTERVAL_MS = 200;
const LIVE_AUDIO_WAVEFORM_SIZE = 24;
const LIVE_AUDIO_HEADER_READ_LIMIT = 16 * 1024;
const LIVE_AUDIO_MAX_READ_BYTES = 64 * 1024;
const LIVE_AUDIO_SILENCE_RMS = 0.003;
const LOCAL_INTERVIEW_PROBE_TIMEOUT_MS = 3_000;
const LOCAL_INTERVIEW_PROBE_MAX_BUFFER = 1024 * 1024;
const LOCAL_INTERVIEW_TOOL_ENV = Object.freeze({
  rec: 'HRBOSS_INTERVIEW_REC_PATH',
  sox: 'HRBOSS_INTERVIEW_SOX_PATH',
  afconvert: 'HRBOSS_INTERVIEW_AFCONVERT_PATH',
  ffmpeg: 'HRBOSS_INTERVIEW_FFMPEG_PATH',
  'whisper-cli': 'HRBOSS_INTERVIEW_WHISPER_CLI_PATH',
});
const DARWIN_LOCAL_INTERVIEW_TOOL_DIRS = Object.freeze([
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]);

function installLocalInterviewParentDeathGuard() {
  const groupId = Number(process.env.HRBOSS_LOCAL_INTERVIEW_WORKER_GROUP_ID);
  if (!process.connected) return false;
  if (process.platform === 'win32') {
    const onDisconnect = () => process.exit(130);
    process.once('disconnect', onDisconnect);
    return () => process.off('disconnect', onDisconnect);
  }
  if (!Number.isSafeInteger(groupId) || groupId <= 0) return false;
  let activated = false;
  const onDisconnect = () => {
    if (activated) return;
    activated = true;
    try { process.kill(-groupId, 'SIGTERM'); } catch {}
    // Keep this timer referenced. If the graceful recorder/ASR path resists,
    // the still-live group member terminates its own exact group.
    setTimeout(() => {
      try { process.kill(-groupId, 'SIGKILL'); } catch {}
    }, 4000);
  };
  process.once('disconnect', onDisconnect);
  return () => process.off('disconnect', onDisconnect);
}

function closeLocalInterviewWorkerIpc(deactivateParentDeathGuard) {
  deactivateParentDeathGuard();
  if (!process.connected || typeof process.disconnect !== 'function') return;
  try {
    process.disconnect();
  } catch (error) {
    if (process.connected) throw error;
  }
}

function localInterviewWorkerEnvelope(message) {
  return {
    schema_version: GUARDIAN_IPC_SCHEMA,
    action_instance_id: String(process.env.HRBOSS_LOCAL_INTERVIEW_ACTION_INSTANCE_ID || ''),
    guardian_instance_id: String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_INSTANCE_ID || ''),
    job_id: String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_JOB_ID || ''),
    ...message,
  };
}

function sendLocalInterviewWorkerMessage(message) {
  if (!process.connected || typeof process.send !== 'function') return false;
  try {
    process.send(localInterviewWorkerEnvelope(message));
    return true;
  } catch {
    return false;
  }
}

function trustedLocalInterviewWorkerMessage(message) {
  return !!message
    && message.schema_version === GUARDIAN_IPC_SCHEMA
    && message.action_instance_id === String(process.env.HRBOSS_LOCAL_INTERVIEW_ACTION_INSTANCE_ID || '')
    && message.guardian_instance_id === String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_INSTANCE_ID || '')
    && message.job_id === String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_JOB_ID || '');
}

function waitForLocalInterviewCaptureAuthorization(options = {}) {
  const expectedHash = String(
    options.expectedHash || process.env.HRBOSS_LOCAL_INTERVIEW_CAPTURE_TOKEN_SHA256 || '',
  );
  const timeoutMs = Math.max(
    250,
    Math.min(30_000, Number(options.timeoutMs) || 10_000),
  );
  if (!process.connected
      || typeof process.send !== 'function'
      || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    return Promise.reject(new Error('local interview capture authorization channel is unavailable'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      if (error) reject(error);
      else resolve(true);
    };
    const onDisconnect = () => finish(new Error('local interview capture authorization parent disconnected'));
    const onMessage = (message) => {
      if (!trustedLocalInterviewWorkerMessage(message) || message.type !== 'capture_authorized') return;
      const token = String(message.capture_token || '');
      const actualHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
      const expected = Buffer.from(expectedHash, 'hex');
      const actual = Buffer.from(actualHash, 'hex');
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        finish(new Error('local interview capture authorization token is invalid'));
        return;
      }
      finish();
    };
    const timer = setTimeout(
      () => finish(new Error('local interview capture authorization timed out')),
      timeoutMs,
    );
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    if (!sendLocalInterviewWorkerMessage({ type: 'worker_ready' })) {
      finish(new Error('local interview worker readiness acknowledgement failed'));
    }
  });
}

function clampUnit(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.min(1, Math.max(0, Number(value)));
}

function roundedUnit(value) {
  return Number(clampUnit(value).toFixed(4));
}

function normalizedAudioLevel(amplitude) {
  const safe = Math.abs(Number(amplitude));
  if (!Number.isFinite(safe) || safe <= 0) return 0;
  // Map -60 dBFS..0 dBFS to a stable visual range. This remains an audio
  // magnitude only; it is never persisted as or reconstructed into raw PCM.
  const dbfs = 20 * Math.log10(Math.max(safe, 0.000001));
  return roundedUnit((dbfs + 60) / 60);
}

function measurePcm16Le(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) {
    return { rms: 0, peak: 0, sampleCount: 0 };
  }
  const sampleCount = Math.floor(buffer.length / 2);
  let peak = 0;
  let sumSquares = 0;
  for (let index = 0; index < sampleCount * 2; index += 2) {
    const amplitude = Math.abs(buffer.readInt16LE(index)) / 32768;
    if (amplitude > peak) peak = amplitude;
    sumSquares += amplitude * amplitude;
  }
  return {
    rms: Math.sqrt(sumSquares / sampleCount),
    peak,
    sampleCount,
  };
}

function sanitizeLiveAudioTelemetry(value) {
  if (!value || typeof value !== 'object') return null;
  const seq = Number(value.seq);
  const silentMs = Number(value.silent_ms);
  const sampledAtMs = Date.parse(String(value.sampled_at || ''));
  if (!Number.isSafeInteger(seq) || seq < 0
      || !Number.isFinite(silentMs) || silentMs < 0
      || !Number.isFinite(sampledAtMs)) {
    return null;
  }
  const waveform = Array.isArray(value.waveform)
    ? value.waveform.slice(-LIVE_AUDIO_WAVEFORM_SIZE).map(roundedUnit)
    : [];
  return {
    level: roundedUnit(value.level),
    peak: roundedUnit(value.peak),
    active: value.active === true,
    silent_ms: Math.min(Number.MAX_SAFE_INTEGER, Math.round(silentMs)),
    seq,
    sampled_at: new Date(sampledAtMs).toISOString(),
    waveform,
  };
}

function parseLiveAudioTelemetryLine(line) {
  const text = String(line || '');
  if (!text.startsWith(LIVE_AUDIO_TELEMETRY_PREFIX)) return null;
  try {
    return sanitizeLiveAudioTelemetry(JSON.parse(text.slice(LIVE_AUDIO_TELEMETRY_PREFIX.length)));
  } catch {
    return null;
  }
}

function parsePcm16WavHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12
      || buffer.toString('ascii', 0, 4) !== 'RIFF'
      || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let format = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    if (chunkId === 'fmt ') {
      if (chunkSize < 16 || payloadOffset + 16 > buffer.length) return null;
      format = {
        audioFormat: buffer.readUInt16LE(payloadOffset),
        channels: buffer.readUInt16LE(payloadOffset + 2),
        sampleRate: buffer.readUInt32LE(payloadOffset + 4),
        bitsPerSample: buffer.readUInt16LE(payloadOffset + 14),
      };
    } else if (chunkId === 'data') {
      if (!format || format.audioFormat !== 1 || format.bitsPerSample !== 16) return null;
      return { ...format, dataOffset: payloadOffset };
    }
    const nextOffset = payloadOffset + chunkSize + (chunkSize % 2);
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset || nextOffset > buffer.length) return null;
    offset = nextOffset;
  }
  return null;
}

function createLiveAudioTelemetrySampler({
  wavPath,
  intervalMs = LIVE_AUDIO_SAMPLE_INTERVAL_MS,
  emit = (frame) => process.stderr.write(`${LIVE_AUDIO_TELEMETRY_PREFIX}${JSON.stringify(frame)}\n`),
  now = () => Date.now(),
} = {}) {
  const safeIntervalMs = Math.max(100, Math.min(1000, Math.round(Number(intervalMs) || LIVE_AUDIO_SAMPLE_INTERVAL_MS)));
  let timer = null;
  let sampling = false;
  let stopped = false;
  let wavFormat = null;
  let readOffset = null;
  let seq = 0;
  let silentMs = 0;
  let lastSampleMs = null;
  let waveform = [];
  let lastFrame = null;

  const safeEmit = (frame) => {
    const sanitized = sanitizeLiveAudioTelemetry(frame);
    if (!sanitized) return null;
    lastFrame = sanitized;
    try { emit(sanitized); } catch {}
    return sanitized;
  };

  const readHeader = (fd, size) => {
    const length = Math.min(size, LIVE_AUDIO_HEADER_READ_LIMIT);
    if (length < 12) return null;
    const header = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, header, 0, length, 0);
    return parsePcm16WavHeader(header.subarray(0, bytesRead));
  };

  const sampleNow = () => {
    if (stopped || sampling || !wavPath) return null;
    sampling = true;
    let fd = null;
    try {
      fd = fs.openSync(wavPath, 'r');
      const size = fs.fstatSync(fd).size;
      if (!wavFormat) wavFormat = readHeader(fd, size);
      if (!wavFormat) return null;
      if (readOffset == null) readOffset = wavFormat.dataOffset;
      if (size <= readOffset) return null;

      let start = readOffset;
      let length = size - start;
      if (length > LIVE_AUDIO_MAX_READ_BYTES) {
        start = Math.max(wavFormat.dataOffset, size - LIVE_AUDIO_MAX_READ_BYTES);
        if ((start - wavFormat.dataOffset) % 2) start += 1;
        length = size - start;
      }
      length -= length % 2;
      if (length < 2) return null;
      const pcm = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(fd, pcm, 0, length, start);
      const usableBytes = bytesRead - (bytesRead % 2);
      if (usableBytes < 2) return null;
      readOffset = start + usableBytes;

      const measured = measurePcm16Le(pcm.subarray(0, usableBytes));
      if (!measured.sampleCount) return null;
      const sampledMs = Number(now());
      if (!Number.isFinite(sampledMs)) return null;
      const elapsedMs = lastSampleMs == null
        ? safeIntervalMs
        : Math.max(0, Math.min(1000, Math.round(sampledMs - lastSampleMs)));
      lastSampleMs = sampledMs;
      if (measured.rms < LIVE_AUDIO_SILENCE_RMS) {
        silentMs = Math.min(Number.MAX_SAFE_INTEGER, silentMs + elapsedMs);
      } else {
        silentMs = 0;
      }
      const level = normalizedAudioLevel(measured.rms);
      waveform = [...waveform, level].slice(-LIVE_AUDIO_WAVEFORM_SIZE);
      seq += 1;
      return safeEmit({
        level,
        peak: normalizedAudioLevel(measured.peak),
        active: measured.rms >= LIVE_AUDIO_SILENCE_RMS,
        silent_ms: silentMs,
        seq,
        sampled_at: new Date(sampledMs).toISOString(),
        waveform,
      });
    } catch {
      // Live metering is best-effort and must never interrupt recording.
      return null;
    } finally {
      if (fd != null) {
        try { fs.closeSync(fd); } catch {}
      }
      sampling = false;
    }
  };

  const start = () => {
    if (timer || stopped) return;
    timer = setInterval(sampleNow, safeIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    sampleNow();
  };

  const stop = () => {
    if (stopped) return lastFrame;
    if (timer) clearInterval(timer);
    timer = null;
    // Capture bytes already flushed by SoX, then emit one inactive frame so a
    // duration-limited recording also freezes while local ASR is running.
    sampleNow();
    stopped = true;
    const sampledMs = Number(now());
    const frozenSampledMs = Number.isFinite(sampledMs) ? sampledMs : Date.now();
    const frozen = lastFrame || {
      level: 0,
      peak: 0,
      active: false,
      silent_ms: 0,
      seq: 0,
      sampled_at: new Date(frozenSampledMs).toISOString(),
      waveform: [],
    };
    return safeEmit({
      ...frozen,
      active: false,
      seq: frozen.seq + 1,
      sampled_at: new Date(frozenSampledMs).toISOString(),
    });
  };

  return { sampleNow, start, stop };
}

function localInterviewCapability(platform = process.platform) {
  if (platform !== 'win32') return null;
  return {
    capability: 'local_recording_asr',
    platform: 'win32',
    status: 'degraded',
    degraded: true,
    ready: false,
    reason: WINDOWS_LOCAL_ASR_REASON,
    message: WINDOWS_LOCAL_ASR_MESSAGE,
    tools: {},
    whisperModel: null,
  };
}

function assertLocalInterviewActionSupported(platform = process.platform) {
  const capability = localInterviewCapability(platform);
  if (!capability) return;
  const error = new Error(capability.message);
  error.code = capability.reason;
  throw error;
}

function usage() {
  return `
Usage:
  node local-interview-p0.js --help
  node local-interview-p0.js --doctor
  node local-interview-p0.js --mic-check [--duration seconds] [--topic name] [--out-dir dir]
  node local-interview-p0.js --record [--duration seconds] [--topic name] [--out-dir dir]
  node local-interview-p0.js --from-file media_file [--topic name] [--out-dir dir]
  node local-interview-p0.js --transcribe wav_file [--topic name] [--out-dir dir]

Examples:
  node local-interview-p0.js --doctor
  node local-interview-p0.js --mic-check --duration 8
  node local-interview-p0.js --record --duration 600 --topic HRBOSS-P0-direct
  node local-interview-p0.js --from-file '/Users/me/Documents/Feishu/meeting/video.mp4'

Env:
  WHISPER_CPP_MODEL             Optional model path. Default: ${DEFAULT_MODEL}
  HRBOSS_INTERVIEW_OUTPUT_DIR   Optional output root. Default: ${DEFAULT_OUTPUT_ROOT}
  HRBOSS_INTERVIEW_REC_PATH     Optional absolute path to SoX rec.
  HRBOSS_INTERVIEW_SOX_PATH     Optional absolute path to SoX.
  HRBOSS_INTERVIEW_AFCONVERT_PATH Optional absolute path to afconvert.
  HRBOSS_INTERVIEW_FFMPEG_PATH  Optional absolute path to ffmpeg.
  HRBOSS_INTERVIEW_WHISPER_CLI_PATH Optional absolute path to whisper-cli.

Notes:
  - Direct recording uses the local default microphone via SoX "rec".
  - Media extraction uses macOS afconvert first, then ffmpeg as fallback.
  - Transcription uses local whisper.cpp "whisper-cli".
  - This script never calls Feishu OpenAPI or any external transcription API.
`.trim();
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (['help', 'doctor', 'mic-check', 'record'].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  return args;
}

function executablePath(candidate) {
  if (!candidate) return '';
  try {
    if (!fs.statSync(candidate).isFile()) return '';
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return '';
  }
}

function which(bin, pathEnv = process.env.PATH || '') {
  if (bin.includes('/')) return executablePath(bin);
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = executablePath(path.join(dir, bin));
    if (candidate) return candidate;
  }
  return '';
}

function resolveLocalInterviewTool(name, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const envName = LOCAL_INTERVIEW_TOOL_ENV[name];
  const explicit = envName ? String(env[envName] || '').trim() : '';
  if (explicit) return executablePath(path.resolve(explicit));

  const fromPath = which(name, env.PATH || '');
  if (fromPath) return fromPath;

  const fallbackDirectories = Array.isArray(options.fallbackDirectories)
    ? options.fallbackDirectories
    : (platform === 'darwin' ? DARWIN_LOCAL_INTERVIEW_TOOL_DIRS : []);
  for (const dir of fallbackDirectories) {
    const candidate = executablePath(path.join(dir, name));
    if (candidate) return candidate;
  }
  return '';
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} 本地处理失败。`);
  }
  return result;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function slug(input) {
  return String(input || 'local-interview')
    .trim()
    .replace(/[\\/:"*?<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'local-interview';
}

function outputDir(topic, explicitOutDir) {
  if (explicitOutDir) return prepareInterviewMaterialDirectory(explicitOutDir, { root: DEFAULT_OUTPUT_ROOT });
  const root = DEFAULT_OUTPUT_ROOT;
  return path.join(root, `${timestamp()}_${slug(topic || 'HRBOSS-P0-local')}`);
}

function ensureDir(dir) {
  return hardenPrivateDir(prepareInterviewMaterialDirectory(dir, { root: DEFAULT_OUTPUT_ROOT }));
}

function mediaKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.wav') return 'wav';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'unknown';
}

function modelPath(env = process.env) {
  return env.WHISPER_CPP_MODEL || DEFAULT_MODEL;
}

function doctor(platform = process.platform, options = {}) {
  const capability = localInterviewCapability(platform);
  if (capability) {
    console.log(JSON.stringify(capability, null, 2));
    return capability;
  }
  const env = options.env || process.env;
  const probeTimeoutMs = Math.max(50, Math.min(
    10_000,
    Number(options.probeTimeoutMs) || LOCAL_INTERVIEW_PROBE_TIMEOUT_MS,
  ));
  const resolverOptions = {
    platform,
    env,
    ...(Array.isArray(options.fallbackDirectories) ? { fallbackDirectories: options.fallbackDirectories } : {}),
  };
  const tool = (name, versionArgs = ['--version']) => {
    const location = resolveLocalInterviewTool(name, resolverOptions);
    if (!location) return { path: null, runnable: false };
    const result = spawnSync(location, versionArgs, {
      encoding: 'utf8',
      timeout: probeTimeoutMs,
      maxBuffer: LOCAL_INTERVIEW_PROBE_MAX_BUFFER,
      windowsHide: true,
    });
    const errorCode = String(result.error?.code || '');
    return {
      path: location,
      runnable: result.status === 0,
      timed_out: errorCode === 'ETIMEDOUT',
      ...(errorCode && errorCode !== 'ETIMEDOUT' ? { error_code: errorCode } : {}),
    };
  };
  const sox = tool('sox', ['--version']);
  const recPath = resolveLocalInterviewTool('rec', resolverOptions);
  const tools = {
    // `rec --version` can open the default input device on macOS. Doctor only
    // proves that the SoX frontend is discoverable; the explicit 8-second
    // mic-check owns permission, device and real-signal verification.
    rec: {
      path: recPath || null,
      runnable: Boolean(recPath) && sox.runnable,
      probe: 'toolchain_only',
      microphone_tested: false,
    },
    sox,
    afconvert: (() => {
      const location = resolveLocalInterviewTool('afconvert', resolverOptions);
      return { path: location || null, runnable: !!location };
    })(),
    ffmpeg: tool('ffmpeg', ['-version']),
    'whisper-cli': tool('whisper-cli', ['--help']),
  };
  const model = modelPath(env);
  const transcriptionReady = tools['whisper-cli'].runnable && fs.existsSync(model);
  const recordingReady = tools.rec.runnable && tools.sox.runnable;
  const micCheckReady = recordingReady && transcriptionReady;
  const importReady = (tools.afconvert.runnable || tools.ffmpeg.runnable) && transcriptionReady;
  const toolchainReady = micCheckReady;
  const unresolved = [
    ...(!tools.rec.runnable ? ['rec'] : []),
    ...(!tools.sox.runnable ? ['sox'] : []),
    ...(!tools['whisper-cli'].runnable ? ['whisper-cli'] : []),
    ...(!fs.existsSync(model) ? ['whisper-model'] : []),
  ];
  const result = {
    schemaVersion: 'local_interview_doctor_v2',
    tools,
    whisperModel: fs.existsSync(model) ? model : null,
    capabilities: {
      recording: { ready: recordingReady },
      transcription: { ready: transcriptionReady },
      micCheck: { ready: micCheckReady },
      import: { ready: importReady },
    },
    toolchainReady,
    // Backward-compatible alias. `ready` means software toolchain readiness,
    // never microphone permission or real input quality.
    ready: toolchainReady,
    readyScope: 'software_only',
    readiness: {
      appDiscovery: {
        ready: toolchainReady,
        status: toolchainReady ? 'pass' : 'fail',
        unresolved,
      },
      microphone: {
        ready: false,
        tested: false,
        status: 'untested',
      },
    },
    microphone: {
      tested: false,
      status: 'not_tested',
      message: '软件检查不会访问麦克风；请由用户主动运行 8 秒麦克风预检。',
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) {
    console.error([
      '',
      'Missing local prerequisites. Suggested setup:',
      '  brew install sox whisper.cpp',
      `  mkdir -p "${path.dirname(DEFAULT_MODEL)}"`,
      `  curl -L -o "${DEFAULT_MODEL}" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin`,
    ].join('\n'));
    process.exitCode = 1;
  }
  return result;
}

function record({ duration, topic, outDir }) {
  assertLocalInterviewActionSupported();
  const dir = ensureDir(outputDir(topic, outDir));
  const wavPath = prepareInterviewMaterialFileTarget(path.join(dir, 'recording.wav'), 'audio', { root: DEFAULT_OUTPUT_ROOT });
  const rec = resolveLocalInterviewTool('rec');
  if (!rec) throw new Error('SoX rec is required. Install with: brew install sox');

  const args = ['-q', '-r', '16000', '-c', '1', '-b', '16', wavPath];
  if (duration) args.push('trim', '0', String(duration));

  console.error(duration
    ? `Recording ${duration}s to ${wavPath}`
    : `Recording to ${wavPath}. Press Ctrl-C to stop.`);

  const child = spawn(rec, args, { stdio: 'inherit' });
  const telemetry = createLiveAudioTelemetrySampler({ wavPath });
  return new Promise((resolve, reject) => {
    let interrupted = false;
    let aborted = false;
    let startAcknowledgementFailed = false;
    let settled = false;
    const stop = () => {
      interrupted = true;
      if (child.exitCode == null && !child.killed) child.kill('SIGINT');
    };
    const abort = () => {
      aborted = true;
      if (child.exitCode == null && !child.killed) child.kill('SIGTERM');
    };
    const cleanup = () => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', abort);
      process.removeListener('SIGHUP', abort);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      telemetry.stop();
      callback();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', abort);
    process.once('SIGHUP', abort);
    child.once('spawn', () => {
      const guardianManaged = process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_MANAGED_WORKER === '1';
      if (guardianManaged && !sendLocalInterviewWorkerMessage({ type: 'capture_started' })) {
        startAcknowledgementFailed = true;
        aborted = true;
        try { child.kill('SIGTERM'); } catch {}
        return;
      }
      telemetry.start();
    });
    child.once('error', (error) => {
      settle(() => reject(error));
    });
    child.on('exit', (code, signal) => {
      settle(() => {
        if (startAcknowledgementFailed) reject(new Error('recording start acknowledgement failed'));
        else if (aborted) resolve({ dir, wavPath, aborted: true });
        else if (code === 0 || interrupted || signal === 'SIGINT') resolve({ dir, wavPath, aborted: false });
        else reject(new Error(`rec exited with code=${code} signal=${signal}`));
      });
    });
  });
}

function extractWav(source, { topic, outDir } = {}) {
  assertLocalInterviewActionSupported();
  const imported = validateImportedMediaSource(source);
  const extension = path.extname(imported.path).toLowerCase();
  const dir = ensureDir(outputDir(topic || path.basename(imported.path, extension), outDir));
  const sourcePath = prepareInterviewMaterialFileTarget(
    path.join(dir, `source${extension}`),
    'source_media',
    { root: DEFAULT_OUTPUT_ROOT },
  );
  try {
    fs.copyFileSync(imported.path, sourcePath);
  } catch {
    throw new Error('音视频材料复制到受控目录失败。');
  }
  ensurePrivateFile(sourcePath);
  validateInterviewMaterialFile(sourcePath, 'source_media', { root: DEFAULT_OUTPUT_ROOT });
  const kind = mediaKind(sourcePath);
  const wavPath = kind === 'wav'
    ? sourcePath
    : prepareInterviewMaterialFileTarget(path.join(dir, 'audio.wav'), 'audio', { root: DEFAULT_OUTPUT_ROOT });

  if (kind === 'wav') return { dir, sourcePath, wavPath };

  try {
    const afconvert = resolveLocalInterviewTool('afconvert');
    if (!afconvert) throw new Error('afconvert is not available');
    run(afconvert, ['-f', 'WAVE', '-d', 'LEI16@16000', sourcePath, wavPath]);
  } catch (afErr) {
    const ffmpeg = resolveLocalInterviewTool('ffmpeg');
    if (!ffmpeg) throw afErr;
    run(ffmpeg, ['-y', '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', wavPath]);
  }

  ensurePrivateFile(wavPath);
  validateInterviewMaterialFile(wavPath, 'audio', { root: DEFAULT_OUTPUT_ROOT });
  return { dir, sourcePath, wavPath };
}

function transcribeWav(wavPath, { dir, language = 'zh' } = {}) {
  assertLocalInterviewActionSupported();
  const whisperCli = resolveLocalInterviewTool('whisper-cli');
  if (!whisperCli) throw new Error('whisper-cli is required. Install with: brew install whisper.cpp');
  const model = modelPath();
  if (!fs.existsSync(model)) throw new Error(`whisper.cpp model not found: ${model}`);
  const outputBase = path.join(dir || path.dirname(wavPath), 'transcript');
  prepareInterviewMaterialFileTarget(`${outputBase}.txt`, 'transcript_txt', { root: DEFAULT_OUTPUT_ROOT });
  prepareInterviewMaterialFileTarget(`${outputBase}.srt`, 'transcript_srt', { root: DEFAULT_OUTPUT_ROOT });
  prepareInterviewMaterialFileTarget(`${outputBase}.json`, 'transcript_json', { root: DEFAULT_OUTPUT_ROOT });

  run(whisperCli, [
    '-m', model,
    '-f', wavPath,
    '-l', language,
    '-otxt',
    '-osrt',
    '-oj',
    '-of', outputBase,
  ], { stdio: 'inherit' });

  const txtPath = `${outputBase}.txt`;
  const srtPath = `${outputBase}.srt`;
  const jsonPath = `${outputBase}.json`;
  const rawWhisperJson = fs.readFileSync(jsonPath, 'utf8');
  const rawSrt = fs.readFileSync(srtPath, 'utf8');
  const canonicalTranscript = buildCanonicalTranscript({
    whisperJson: rawWhisperJson,
    srt: rawSrt,
    engine: 'whisper.cpp',
  });
  writePrivateFile(jsonPath, `${JSON.stringify(canonicalTranscript, null, 2)}\n`);

  return {
    txtPath,
    srtPath,
    jsonPath,
    canonicalTranscript,
  };
}

function audioStats(wavPath) {
  const sox = resolveLocalInterviewTool('sox');
  if (!sox) return null;
  const result = spawnSync(sox, [wavPath, '-n', 'stat'], { encoding: 'utf8' });
  const raw = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0 && !raw.trim()) return null;
  const fields = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z ()]+):\s+(-?\d+(?:\.\d+)?)/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    fields[key] = Number(match[2]);
  }
  return {
    lengthSeconds: fields.length_seconds ?? null,
    maximumAmplitude: fields.maximum_amplitude ?? null,
    minimumAmplitude: fields.minimum_amplitude ?? null,
    meanNorm: fields.mean_norm ?? null,
    rmsAmplitude: fields.rms_amplitude ?? null,
    roughFrequency: fields.rough_frequency ?? null,
  };
}

function cleanTranscriptText(text) {
  return String(text || '')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[()（）]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreMicCheck({ transcriptText, stats }) {
  const cleaned = cleanTranscriptText(transcriptText);
  const compact = cleaned.replace(/\s+/g, '');
  const meaningful = compact.replace(/[，。,.!?！？、"'`~\-_:;；：]/g, '');
  const lowSignal = !meaningful || /^(拍摄|拍攝|音乐|音樂|字幕|謝謝|谢谢|嗯|啊)+$/i.test(meaningful);
  const rms = stats && Number.isFinite(stats.rmsAmplitude) ? stats.rmsAmplitude : null;
  const max = stats && Number.isFinite(stats.maximumAmplitude) ? Math.abs(stats.maximumAmplitude) : null;

  if (lowSignal) {
    return {
      passed: false,
      level: 'fail',
      message: '没有识别到稳定人声。',
      recommendation: '请确认系统输入设备是当前麦克风，并让说话人靠近麦克风后重新预检。',
    };
  }
  if (meaningful.length < 8) {
    return {
      passed: false,
      level: 'warn',
      message: '已识别到人声，但内容过短，关键数字可能不稳定。',
      recommendation: '请用正常面试音量再说一遍预检短句，特别确认姓名、薪资、到岗时间这类短数字字段。',
    };
  }
  if ((rms != null && rms < 0.003) || (max != null && max < 0.03)) {
    return {
      passed: false,
      level: 'warn',
      message: '已识别到人声，但录音音量偏低。',
      recommendation: '建议提高输入音量、靠近麦克风，或切换外置麦克风后再开始正式面试。',
    };
  }
  return {
    passed: true,
    level: 'pass',
    message: '麦克风预检通过，已识别到可用人声。',
    recommendation: '可以开始正式录音；正式面试中仍建议慢速确认关键数字。',
  };
}

function scoreAudioQuality(stats) {
  const duration = stats && Number.isFinite(stats.lengthSeconds) ? stats.lengthSeconds : null;
  const rms = stats && Number.isFinite(stats.rmsAmplitude) ? stats.rmsAmplitude : null;
  const max = stats && Number.isFinite(stats.maximumAmplitude) ? Math.abs(stats.maximumAmplitude) : null;
  const clipped = max != null && max >= 0.98;
  if (!stats) {
    return {
      level: 'unknown',
      label: '未知',
      message: '未能读取音频统计。',
      recommendation: '如果转写异常，请重新录音或检查音频文件。',
    };
  }
  if ((duration != null && duration < 5) || (rms != null && rms < 0.003) || (max != null && max < 0.03)) {
    return {
      level: 'warn',
      label: '偏弱',
      message: '录音时长较短或音量偏低。',
      recommendation: '正式面试建议靠近麦克风、提高输入音量，并重复确认关键数字。',
    };
  }
  if (clipped) {
    return {
      level: 'warn',
      label: '可能爆音',
      message: '检测到峰值接近满幅，可能存在爆音或削波。',
      recommendation: '建议降低输入音量或拉远麦克风，避免转写误差。',
    };
  }
  return {
    level: 'pass',
    label: '可用',
    message: '录音音量和时长处于可用范围。',
    recommendation: '可以进入复盘；关键数字仍需人工确认。',
  };
}

function writePacket({ dir, topic, sourcePath, wavPath, transcript, extra = {} }) {
  const canonicalWav = validateInterviewMaterialFile(wavPath, 'audio', { root: DEFAULT_OUTPUT_ROOT }).path;
  const canonicalSource = sourcePath
    ? validateInterviewMaterialFile(sourcePath, 'source_media', { root: DEFAULT_OUTPUT_ROOT }).path
    : '';
  const canonicalTxt = validateInterviewMaterialFile(transcript.txtPath, 'transcript_txt', { root: DEFAULT_OUTPUT_ROOT }).path;
  const canonicalSrt = validateInterviewMaterialFile(transcript.srtPath, 'transcript_srt', { root: DEFAULT_OUTPUT_ROOT }).path;
  const canonicalJson = validateInterviewMaterialFile(transcript.jsonPath, 'transcript_json', { root: DEFAULT_OUTPUT_ROOT }).path;
  const txt = readControlledTextFile(canonicalTxt, 'transcript_txt', { root: DEFAULT_OUTPUT_ROOT }).text;
  const srt = readControlledTextFile(canonicalSrt, 'transcript_srt', { root: DEFAULT_OUTPUT_ROOT }).text;
  const canonicalTranscript = transcript.canonicalTranscript
    || readCanonicalTranscript(readControlledTextFile(canonicalJson, 'transcript_json', { root: DEFAULT_OUTPUT_ROOT }).text);
  if (!canonicalTranscript) throw new Error('transcript.json is not a canonical timestamped ASR transcript');
  const packetPath = prepareInterviewMaterialFileTarget(path.join(dir, 'codex-input.md'), 'report', { root: DEFAULT_OUTPUT_ROOT });
  const summaryPath = prepareInterviewMaterialFileTarget(path.join(dir, 'summary.json'), 'summary', { root: DEFAULT_OUTPUT_ROOT });
  const payload = {
    createdAt: new Date().toISOString(),
    topic: topic || '',
    sourcePath: canonicalSource,
    wavPath: canonicalWav,
    transcriptTxt: canonicalTxt,
    transcriptSrt: canonicalSrt,
    transcriptJson: canonicalJson,
    summaryPath,
    codexInput: packetPath,
    transcriptSchemaVersion: canonicalTranscript.schema_version,
    transcriptReviewStatus: canonicalTranscript.review_status,
    transcriptAccuracyLabel: canonicalTranscript.accuracy_label,
    cueCount: canonicalTranscript.cue_count,
    lowConfidenceCueCount: canonicalTranscript.low_confidence_cue_count,
    ...extra,
  };
  writePrivateFile(packetPath, `# HRBOSS Local Interview Codex Input

> Generated: ${payload.createdAt}  
> Source: \`${sourcePath || wavPath}\`  
> Transcript TXT: \`${transcript.txtPath}\`  
> Transcript SRT: \`${transcript.srtPath}\`

## Transcript TXT

\`\`\`text
${txt}
\`\`\`

## Transcript SRT

\`\`\`srt
${srt.slice(0, 20000)}
\`\`\`

## Codex Analysis Prompt

\`\`\`text
你是 HRBOSS 面试 AI 分析助手。上面的 transcript 是未经 HR 逐字复核的 ASR 转写草稿。请只基于带时间戳的证据生成结构化面试复盘草稿，不要脑补，不要调用外部工具或 API。

输出要求：
1. 只输出合法 JSON，不要输出 Markdown。
2. 必须覆盖岗位硬性条件逐项核对、胜任力证据、求职动机、风险与矛盾、待核实事项、下一轮追问、带原文与时间戳的证据、非决策性的 AI 参考分析。
3. schema_version 固定为 interview_ai_report_p0_v1。
4. 每个能力判断必须引用 transcript 证据；没有聊到就写入 unknowns。
5. 不得给出推进、补面、暂缓、淘汰、录用等处置建议；这些决定只由 HR 做出。
6. human_confirm_required 必须为 true，产物必须标注为待 HR 校对的草稿。
7. 不得基于年龄、性别、婚育、健康、地域、声音、口音、停顿、情绪等做判断。
8. 不允许输出自动录用、自动淘汰、SABC、百分制评分、质量分或薪资建议。
\`\`\`
`);
  writePrivateFile(summaryPath, `${JSON.stringify(payload, null, 2)}\n`);
  const checked = readAndValidateInterviewSummary(summaryPath, { root: DEFAULT_OUTPUT_ROOT });
  return { summaryPath: checked.path, packetPath: checked.summary.codexInput };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || process.argv.length <= 2) {
    console.log(usage());
    return;
  }
  if (args.doctor) {
    doctor();
    return;
  }

  // Windows packages intentionally expose this capability as degraded until the
  // native recording/ASR toolchain is packaged and accepted on a real device.
  // Keep this before any output directory, file target, copy, or child process.
  assertLocalInterviewActionSupported();

  const topic = args.topic || 'HRBOSS-P0-local';
  const micCheckPrompt = '麦克风测试，林晨，二十二K到二十五K，两周到岗。';
  let dir;
  let sourcePath = '';
  let wavPath;
  let mode = 'transcribe';

  if (args['mic-check']) {
    const duration = args.duration ? Number(args.duration) : 8;
    if (!Number.isFinite(duration) || duration < 3 || duration > 20) throw new Error('--duration for --mic-check must be 3 to 20 seconds');
    mode = 'mic-check';
    console.error(`Mic check prompt: ${micCheckPrompt}`);
    const recorded = await record({ duration, topic: topic || 'HRBOSS-mic-check', outDir: args['out-dir'] });
    if (recorded.aborted) {
      fs.rmSync(recorded.wavPath, { force: true });
      process.exitCode = 130;
      return;
    }
    dir = recorded.dir;
    wavPath = recorded.wavPath;
  } else if (args.record) {
    const duration = args.duration ? Number(args.duration) : 0;
    if (args.duration && (!Number.isFinite(duration) || duration <= 0)) throw new Error('--duration must be a positive number');
    mode = 'record';
    const recorded = await record({ duration, topic, outDir: args['out-dir'] });
    if (recorded.aborted) {
      fs.rmSync(recorded.wavPath, { force: true });
      process.exitCode = 130;
      return;
    }
    dir = recorded.dir;
    wavPath = recorded.wavPath;
  } else if (args['from-file']) {
    mode = 'from-file';
    const extracted = extractWav(args['from-file'], { topic, outDir: args['out-dir'] });
    dir = extracted.dir;
    sourcePath = extracted.sourcePath;
    wavPath = extracted.wavPath;
  } else if (args.transcribe) {
    const extracted = extractWav(args.transcribe, { topic, outDir: args['out-dir'] });
    dir = extracted.dir;
    sourcePath = extracted.sourcePath;
    wavPath = extracted.wavPath;
  } else if (args['retry-recording']) {
    mode = 'record';
    dir = ensureDir(outputDir(topic, args['out-dir']));
    wavPath = validateInterviewMaterialFile(
      args['retry-recording'],
      'audio',
      { root: DEFAULT_OUTPUT_ROOT },
    ).path;
    if (path.dirname(wavPath) !== dir || path.basename(wavPath) !== 'recording.wav') {
      throw new Error('--retry-recording must be the owned recording.wav in --out-dir');
    }
  } else {
    throw new Error('No action selected. Use --help.');
  }

  if (args.record
      && process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_MANAGED_WORKER === '1'
      && !sendLocalInterviewWorkerMessage({ type: 'transcription_started' })) {
    throw new Error('local interview transcription start acknowledgement failed');
  }
  const transcript = transcribeWav(wavPath, { dir, language: args.language || 'zh' });
  validateInterviewMaterialFile(wavPath, 'audio', { root: DEFAULT_OUTPUT_ROOT });
  const transcriptText = readControlledTextFile(transcript.txtPath, 'transcript_txt', { root: DEFAULT_OUTPUT_ROOT }).text;
  const stats = audioStats(wavPath);
  const audioQuality = scoreAudioQuality(stats);
  const micCheck = mode === 'mic-check'
    ? {
      prompt: micCheckPrompt,
      transcriptText: cleanTranscriptText(transcriptText),
      audioStats: stats,
      ...scoreMicCheck({ transcriptText, stats }),
    }
    : null;
  const extra = micCheck
    ? { mode, transcriptText: cleanTranscriptText(transcriptText), audioStats: stats, micCheck }
    : { mode, transcriptText: cleanTranscriptText(transcriptText), audioStats: stats, audioQuality };
  const packet = writePacket({ dir, topic, sourcePath, wavPath, transcript, extra });
  console.log(JSON.stringify({ ok: true, dir, sourcePath, wavPath, ...transcript, ...packet, transcriptText: cleanTranscriptText(transcriptText), audioStats: stats, audioQuality, micCheck }, null, 2));
}

if (require.main === module) {
  const guardianManaged = process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_MANAGED_WORKER === '1';
  const deactivateParentDeathGuard = guardianManaged
    ? installLocalInterviewParentDeathGuard()
    : null;
  Promise.resolve()
    .then(() => {
      if (guardianManaged && typeof deactivateParentDeathGuard !== 'function') {
        throw new Error('local interview worker parent-death guard is unavailable');
      }
      return guardianManaged ? waitForLocalInterviewCaptureAuthorization() : true;
    })
    .then(() => {
      const fromFileWork = process.argv.includes('--from-file')
        || process.argv.includes('--transcribe')
        || process.argv.includes('--retry-recording');
      if (guardianManaged && fromFileWork
          && !sendLocalInterviewWorkerMessage({ type: 'processing_started' })) {
        throw new Error('local interview processing start acknowledgement failed');
      }
    })
    .then(() => main())
    .then(() => {
      if (guardianManaged) closeLocalInterviewWorkerIpc(deactivateParentDeathGuard);
    })
    .catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  LIVE_AUDIO_TELEMETRY_PREFIX,
  WINDOWS_LOCAL_ASR_MESSAGE,
  WINDOWS_LOCAL_ASR_REASON,
  assertLocalInterviewActionSupported,
  createLiveAudioTelemetrySampler,
  doctor,
  installLocalInterviewParentDeathGuard,
  localInterviewCapability,
  measurePcm16Le,
  normalizedAudioLevel,
  parseLiveAudioTelemetryLine,
  resolveLocalInterviewTool,
  sanitizeLiveAudioTelemetry,
  waitForLocalInterviewCaptureAuthorization,
};
