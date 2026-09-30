import React, { useEffect, useRef, useState } from 'react';
import { localInterviewRecordingFinalizationUiState } from '../interview-review-navigation.mjs';

const BAR_COUNT = 20;
const EMPTY_WAVEFORM = Object.freeze(Array.from({ length: BAR_COUNT }, () => 0));
const AUDIO_LEVEL_WARNING_ENTER = 0.9;
const AUDIO_LEVEL_WARNING_EXIT = 0.85;
const AUDIO_LEVEL_CLIPPING_ENTER = 0.995;
const AUDIO_LEVEL_CLIPPING_EXIT = 0.97;

export function isRecordingFinalizing(job) {
  return localInterviewRecordingFinalizationUiState(job).finalizing;
}

function isFiniteAudioValue(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function clampAudioValue(value) {
  return isFiniteAudioValue(value) ? Math.min(1, Math.max(0, Number(value))) : 0;
}

function nextAudioStrengthState(previousState, value) {
  const normalized = clampAudioValue(value);
  if (previousState === 'clipping' && normalized >= AUDIO_LEVEL_CLIPPING_EXIT) return 'clipping';
  if (normalized >= AUDIO_LEVEL_CLIPPING_ENTER) return 'clipping';
  if (previousState === 'warning' && normalized >= AUDIO_LEVEL_WARNING_EXIT) return 'warning';
  if (normalized >= AUDIO_LEVEL_WARNING_ENTER) return 'warning';
  return 'normal';
}

function audioBarStrengthState(value) {
  const normalized = clampAudioValue(value);
  if (normalized >= AUDIO_LEVEL_CLIPPING_ENTER) return 'clipping';
  if (normalized >= AUDIO_LEVEL_WARNING_ENTER) return 'warning';
  return 'normal';
}

function sampledAtMilliseconds(value) {
  if (isFiniteAudioValue(value)) {
    const numeric = Number(value);
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function resampleWaveform(values, count = BAR_COUNT) {
  const source = Array.isArray(values)
    ? values.filter(isFiniteAudioValue).map(clampAudioValue)
    : [];
  if (!source.length) return null;
  if (source.length === 1) return Array.from({ length: count }, () => source[0]);
  return Array.from({ length: count }, (_, index) => {
    const sourcePosition = (index / Math.max(count - 1, 1)) * (source.length - 1);
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(source.length - 1, Math.ceil(sourcePosition));
    const ratio = sourcePosition - leftIndex;
    return source[leftIndex] + ((source[rightIndex] - source[leftIndex]) * ratio);
  });
}

function usePrefersReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = (event) => setReducedMotion(event.matches);
    setReducedMotion(mediaQuery.matches);
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', updatePreference);
      return () => mediaQuery.removeEventListener('change', updatePreference);
    }
    mediaQuery.addListener(updatePreference);
    return () => mediaQuery.removeListener(updatePreference);
  }, []);

  return reducedMotion;
}

export default function LiveRecordingWaveform({ liveAudio, stopping = false, discarding = false }) {
  const reducedMotion = usePrefersReducedMotion();
  const [, requestFreshnessCheck] = useState(0);
  const frameRef = useRef(0);
  const renderedValuesRef = useRef([...EMPTY_WAVEFORM]);
  const targetValuesRef = useRef([...EMPTY_WAVEFORM]);
  const frozenValuesRef = useRef(null);
  const wasStoppingRef = useRef(false);
  const levelHistoryRef = useRef([...EMPTY_WAVEFORM]);
  const lastLevelSampleKeyRef = useRef('');
  const [renderedValues, setRenderedValues] = useState([...EMPTY_WAVEFORM]);
  const [signalStrengthState, setSignalStrengthState] = useState('normal');

  const rawLevel = liveAudio && liveAudio.level;
  const rawPeak = liveAudio && liveAudio.peak;
  const level = clampAudioValue(rawLevel);
  const peak = clampAudioValue(rawPeak);
  const silentMilliseconds = Math.max(0, Number(liveAudio && liveAudio.silent_ms) || 0);
  const hasLevel = isFiniteAudioValue(rawLevel) || isFiniteAudioValue(rawPeak);
  const rawSampledAt = liveAudio && liveAudio.sampled_at;
  const hasSampleTimestamp = rawSampledAt !== null
    && rawSampledAt !== undefined
    && String(rawSampledAt).trim() !== '';
  const sampledAt = sampledAtMilliseconds(rawSampledAt);
  const sampleAge = sampledAt ? Date.now() - sampledAt : 0;
  const sampleIsFresh = !!sampledAt && sampleAge >= -10_000 && sampleAge <= 1_800;
  const waveformValues = resampleWaveform(liveAudio && liveAudio.waveform);
  const hasLiveData = !!liveAudio && sampleIsFresh && (!!waveformValues || hasLevel);
  const inputActive = !liveAudio || liveAudio.active !== false;
  const sustainedSilence = hasLiveData && silentMilliseconds >= 3_000;
  const levelAmplitude = Math.max(level, peak * 0.82);
  const levelSampleKey = [
    liveAudio && liveAudio.seq,
    liveAudio && liveAudio.sampled_at,
    isFiniteAudioValue(rawLevel) ? Number(rawLevel).toFixed(5) : '',
    isFiniteAudioValue(rawPeak) ? Number(rawPeak).toFixed(5) : '',
  ].join(':');

  if (!waveformValues && hasLiveData && inputActive && !sustainedSilence && levelSampleKey !== lastLevelSampleKeyRef.current) {
    levelHistoryRef.current = [...levelHistoryRef.current.slice(1), levelAmplitude];
    lastLevelSampleKeyRef.current = levelSampleKey;
  } else if (!hasLiveData || !inputActive || sustainedSilence) {
    levelHistoryRef.current = [...EMPTY_WAVEFORM];
  }

  const calculatedTarget = !hasLiveData || !inputActive || sustainedSilence
    ? [...EMPTY_WAVEFORM]
    : (waveformValues || levelHistoryRef.current);

  if (stopping && !wasStoppingRef.current) {
    const hasRenderedSignal = renderedValuesRef.current.some((value) => value > 0.004);
    frozenValuesRef.current = hasRenderedSignal
      ? [...renderedValuesRef.current]
      : calculatedTarget;
  } else if (!stopping) {
    frozenValuesRef.current = null;
  }
  wasStoppingRef.current = stopping;
  const targetValues = stopping ? (frozenValuesRef.current || calculatedTarget) : calculatedTarget;
  const targetKey = targetValues.map((value) => value.toFixed(4)).join(',');
  targetValuesRef.current = targetValues;

  useEffect(() => {
    if (!sampledAt || stopping) return undefined;
    const millisecondsUntilStale = 1_820 - (Date.now() - sampledAt);
    if (millisecondsUntilStale <= 0) return undefined;
    const timer = setTimeout(() => requestFreshnessCheck((version) => (version + 1) % 1_000_000), millisecondsUntilStale);
    return () => clearTimeout(timer);
  }, [sampledAt, stopping]);

  useEffect(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    if (reducedMotion) {
      renderedValuesRef.current = targetValuesRef.current;
      setRenderedValues(targetValuesRef.current);
      return undefined;
    }

    const animate = () => {
      let settled = true;
      const nextValues = renderedValuesRef.current.map((currentValue, index) => {
        const targetValue = targetValuesRef.current[index] || 0;
        const difference = targetValue - currentValue;
        if (Math.abs(difference) <= 0.004) return targetValue;
        settled = false;
        return currentValue + (difference * 0.22);
      });
      renderedValuesRef.current = nextValues;
      setRenderedValues(nextValues);
      if (!settled) {
        frameRef.current = requestAnimationFrame(animate);
      } else {
        frameRef.current = 0;
      }
    };

    frameRef.current = requestAnimationFrame(animate);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [reducedMotion, targetKey]);

  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
  }, []);

  const signalStrength = Math.max(level, peak);
  const currentStrength = Math.round(signalStrength * 100);
  const displayedStrength = hasLiveData && inputActive && !sustainedSilence ? currentStrength : 0;
  const audioState = stopping
    ? 'stopping'
    : !hasLiveData
    ? (liveAudio && hasSampleTimestamp && !sampleIsFresh ? 'stale' : 'waiting')
    : sustainedSilence
    ? 'silent'
    : !inputActive
    ? 'inactive'
    : 'active';
  const displayedStrengthState = audioState === 'active' ? signalStrengthState : 'unavailable';
  const strengthText = hasLiveData && !stopping
    ? `强度 ${displayedStrength}%${displayedStrengthState === 'clipping'
      ? ' · 峰值过高'
      : displayedStrengthState === 'warning'
      ? ' · 收音较强'
      : audioState === 'active'
      ? ' · 正常'
      : ''}`
    : '真实音频数据';
  const statusText = stopping
    ? (discarding
      ? '正在停止录音并清理未完成材料；不会生成本次转写或复盘，波形已冻结。'
      : '录音已停止，正在生成转写；波形已冻结。')
    : !hasLiveData
    ? (liveAudio && hasSampleTimestamp && !sampleIsFresh ? '等待新的收音数据…' : '等待收音数据…')
    : sustainedSilence
    ? '已连续约 3 秒未检测到有效声音，请检查麦克风位置或输入设备。'
    : !inputActive
    ? '当前未检测到有效声音，正在继续监听。'
    : signalStrengthState === 'clipping'
    ? '音量接近爆音，请稍微远离麦克风或降低输入音量。'
    : signalStrengthState === 'warning'
    ? '当前音量偏高，请与麦克风保持适当距离。'
    : '正在接收真实麦克风输入。';

  useEffect(() => {
    if (audioState !== 'active') {
      setSignalStrengthState('normal');
      return;
    }
    setSignalStrengthState((previousState) => nextAudioStrengthState(previousState, signalStrength));
  }, [audioState, signalStrength]);

  return (
    <section
      className={`live-recording-waveform is-${audioState}`}
      data-audio-state={audioState}
      data-strength-state={displayedStrengthState}
      data-finalization-mode={discarding ? 'discarding' : (stopping ? 'transcribing' : '')}
      aria-label="实时录音波形"
    >
      <div className="live-recording-waveform-head">
        <div>
          <span className="live-recording-dot" aria-hidden="true" />
          <strong>{stopping ? (discarding ? '正在停止并清理' : '录音已停止') : '实时收音'}</strong>
        </div>
        <span className="live-recording-strength">{strengthText}</span>
      </div>
      <div
        className="live-recording-bars"
        role="meter"
        aria-label="实时麦克风收音强度"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={displayedStrength}
        aria-valuetext={audioState === 'active' ? `${strengthText}。${statusText}` : statusText}
      >
        {renderedValues.map((value, index) => (
          <i
            // The backend supplies amplitudes, so these bars never animate without real input data.
            key={index}
            className={`is-strength-${audioBarStrengthState(value)}`}
            aria-hidden="true"
            style={{ transform: `scaleY(${Math.max(0.08, clampAudioValue(value))})` }}
          />
        ))}
      </div>
      <p className="live-recording-waveform-status" role="status" aria-live="polite" aria-atomic="true">
        {statusText}
      </p>
    </section>
  );
}
