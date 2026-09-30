'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  LIVE_AUDIO_TELEMETRY_PREFIX,
  createLiveAudioTelemetrySampler,
  measurePcm16Le,
  normalizedAudioLevel,
  parseLiveAudioTelemetryLine,
  sanitizeLiveAudioTelemetry,
} = require('./local-interview-p0');

const EXPECTED_TELEMETRY_KEYS = [
  'active',
  'level',
  'peak',
  'sampled_at',
  'seq',
  'silent_ms',
  'waveform',
];

function pcm16(samples) {
  const output = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => output.writeInt16LE(sample, index * 2));
  return output;
}

function wav16Mono(samples, sampleRate = 16000) {
  const data = pcm16(samples);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const measured = measurePcm16Le(pcm16([-32768, 0, 16384, -16384]));
assert.equal(measured.sampleCount, 4);
assert.equal(measured.peak, 1);
assert.ok(measured.rms > 0.6 && measured.rms < 0.7);
assert.deepEqual(measurePcm16Le(Buffer.alloc(0)), { rms: 0, peak: 0, sampleCount: 0 });
assert.deepEqual(measurePcm16Le('not-pcm'), { rms: 0, peak: 0, sampleCount: 0 });

const normalized = [0, 0.001, 0.01, 0.1, 1].map(normalizedAudioLevel);
assert.deepEqual([...normalized].sort((a, b) => a - b), normalized,
  'visual audio strength must remain monotonic');
assert.equal(normalized[0], 0);
assert.equal(normalized.at(-1), 1);
for (const value of [...normalized, normalizedAudioLevel(Infinity), normalizedAudioLevel(-Infinity)]) {
  assert.ok(Number.isFinite(value) && value >= 0 && value <= 1,
    'normalized strengths must remain finite and inside 0..1');
}

const sanitized = sanitizeLiveAudioTelemetry({
  level: 4,
  peak: -2,
  active: true,
  silent_ms: 3210.4,
  seq: 17,
  sampled_at: '2026-07-22T08:00:00.000Z',
  waveform: Array.from({ length: 40 }, (_, index) => index / 10),
  pcm: Buffer.from('raw audio must not escape'),
  audio_chunk_base64: 'c2Vuc2l0aXZl',
  device_name: 'synthetic microphone',
});
assert.deepEqual(Object.keys(sanitized).sort(), EXPECTED_TELEMETRY_KEYS);
assert.equal(sanitized.level, 1);
assert.equal(sanitized.peak, 0);
assert.equal(sanitized.silent_ms, 3210);
assert.equal(sanitized.waveform.length, 24, 'telemetry history must remain bounded');
assert.ok(sanitized.waveform.every((value) => value >= 0 && value <= 1));
const sanitizedJson = JSON.stringify(sanitized);
assert.doesNotMatch(sanitizedJson, /raw audio|audio_chunk|base64|device_name|synthetic microphone/i,
  'progress telemetry must never include raw audio or device details');
assert.ok(Buffer.byteLength(sanitizedJson) < 2048, 'one telemetry frame must remain a compact progress payload');

for (const malformed of [
  null,
  {},
  { ...sanitized, seq: -1 },
  { ...sanitized, seq: 1.5 },
  { ...sanitized, silent_ms: -1 },
  { ...sanitized, sampled_at: 'not-a-date' },
]) {
  assert.equal(sanitizeLiveAudioTelemetry(malformed), null, 'invalid telemetry must fail closed');
}

const parsed = parseLiveAudioTelemetryLine(`${LIVE_AUDIO_TELEMETRY_PREFIX}${sanitizedJson}`);
assert.deepEqual(parsed, sanitized);
assert.equal(parseLiveAudioTelemetryLine('ordinary recorder diagnostic'), null);
assert.equal(parseLiveAudioTelemetryLine(`${LIVE_AUDIO_TELEMETRY_PREFIX}{broken-json`), null);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-live-audio-check-'));
const wavPath = path.join(tempRoot, 'recording.wav');
const emitted = [];
let clock = Date.parse('2026-07-22T08:00:00.000Z');
try {
  fs.writeFileSync(wavPath, wav16Mono(new Array(160).fill(0)), { mode: 0o600 });
  const sampler = createLiveAudioTelemetrySampler({
    wavPath,
    intervalMs: 250,
    emit: (frame) => emitted.push(frame),
    now: () => clock,
  });

  const firstSilent = sampler.sampleNow();
  assert.ok(firstSilent);
  assert.equal(firstSilent.active, false, 'a silent PCM frame must not claim active microphone input');
  assert.equal(firstSilent.silent_ms, 250);
  assert.equal(firstSilent.level, 0);

  clock += 250;
  fs.appendFileSync(wavPath, pcm16(new Array(160).fill(0)));
  const secondSilent = sampler.sampleNow();
  assert.equal(secondSilent.silent_ms, 500, 'silence must accumulate across real sample intervals');
  assert.ok(secondSilent.seq > firstSilent.seq);

  clock += 250;
  fs.appendFileSync(wavPath, pcm16(Array.from({ length: 160 }, (_, index) => (
    index % 4 < 2 ? 12000 : -12000
  ))));
  const speaking = sampler.sampleNow();
  assert.equal(speaking.silent_ms, 0, 'a non-silent PCM frame must reset the silence duration');
  assert.equal(speaking.active, true);
  assert.ok(speaking.level > 0 && speaking.peak > 0);
  assert.ok(speaking.waveform.length <= 24);

  const frozen = sampler.stop();
  assert.equal(frozen.active, false, 'stop must emit a final inactive frame for frontend freeze');
  assert.equal(sampler.sampleNow(), null, 'no telemetry may be sampled after stop');
  const countAfterStop = emitted.length;
  sampler.stop();
  assert.equal(emitted.length, countAfterStop, 'stop must be idempotent and clear its work once');

  for (const frame of emitted) {
    assert.deepEqual(Object.keys(frame).sort(), EXPECTED_TELEMETRY_KEYS);
    assert.doesNotMatch(JSON.stringify(frame), /pcm|base64|device/i);
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  contract: 'LOCAL-INTERVIEW-LIVE-AUDIO-001',
  numeric_range: '0..1',
  waveform_max: 24,
  raw_audio_exposed: false,
  silence_accumulates: true,
  stop_emits_inactive_frame: true,
}, null, 2));
