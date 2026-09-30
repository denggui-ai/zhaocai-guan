import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Descriptions, Input, Space, Tag, Typography } from 'antd';
import {
  CheckCircleOutlined,
  FileSearchOutlined,
  ReloadOutlined,
  StopOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { api, fmtTime, READONLY_UI } from '../api.js';
import {
  localInterviewRecordingFinalizationUiState,
  localInterviewTerminationUiState,
} from '../interview-review-navigation.mjs';
import { localInterviewMicCheckReady } from '../settings-state.mjs';
import LiveRecordingWaveform, { isRecordingFinalizing } from './LiveRecordingWaveform.jsx';

const { Text } = Typography;

function statusColor(status) {
  if (status === 'done') return 'green';
  if (status === 'running') return 'blue';
  if (status === 'error') return 'red';
  return 'default';
}

function statusText(status, mode = '') {
  if (status === 'done') return '已完成';
  if (status === 'starting') {
    if (mode === 'mic-check') return '正在建立麦克风预检';
    if (mode === 'from-file') return '正在建立本地材料处理';
    return '正在建立安全录音';
  }
  if (status === 'running') {
    if (mode === 'mic-check') return '正在测试麦克风';
    if (mode === 'from-file') return '正在处理本地材料';
    return '正在录音';
  }
  if (status === 'cancelled') return '已停止并清理';
  if (status === 'error') return '失败';
  return '空闲';
}

function formatSeconds(value) {
  const total = Number(value);
  if (!Number.isFinite(total) || total < 0) return '暂无';
  const minutes = Math.floor(total / 60);
  const seconds = Math.round(total % 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours}:${String(rest).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function qualityColor(level) {
  if (level === 'pass') return 'green';
  if (level === 'warn') return 'orange';
  if (level === 'fail') return 'red';
  return 'default';
}

function AudioQuality({ result }) {
  const stats = result && result.audioStats;
  const quality = (result && result.audioQuality) || null;
  if (!stats && !quality) return null;
  const peak = stats && Number.isFinite(stats.maximumAmplitude) ? Math.abs(stats.maximumAmplitude) : null;
  const rms = stats && Number.isFinite(stats.rmsAmplitude) ? stats.rmsAmplitude : null;
  const mean = stats && Number.isFinite(stats.meanNorm) ? stats.meanNorm : null;
  const frequency = stats && Number.isFinite(stats.roughFrequency) ? stats.roughFrequency : null;
  return (
    <div className="audio-quality-card">
      <div className="audio-quality-head">
        <strong>录音质量</strong>
        <Tag color={qualityColor(quality && quality.level)}>{quality ? quality.label : '未知'}</Tag>
      </div>
      {quality && <p>{quality.message}</p>}
      {quality && quality.recommendation && <p>{quality.recommendation}</p>}
      <div className="audio-meter-grid">
        <div>
          <span>时长</span>
          <strong>{formatSeconds(stats && stats.lengthSeconds)}</strong>
        </div>
        <div>
          <span>RMS</span>
          <strong>{rms == null ? '暂无' : rms.toFixed(4)}</strong>
        </div>
        <div>
          <span>峰值</span>
          <strong>{peak == null ? '暂无' : peak.toFixed(4)}</strong>
        </div>
        <div>
          <span>粗略频率</span>
          <strong>{frequency == null ? '暂无' : `${Math.round(frequency)}Hz`}</strong>
        </div>
      </div>
      <div className="audio-bars" aria-hidden="true">
        {[rms, mean, peak, frequency == null ? null : Math.min(frequency / 1200, 1)].map((value, index) => (
          <i key={index} style={{ height: `${Math.max(8, Math.min(100, Number(value || 0) * 100))}%` }} />
        ))}
      </div>
    </div>
  );
}

function micCheckAlertType(level) {
  if (level === 'pass') return 'success';
  if (level === 'fail') return 'error';
  return 'warning';
}

function MicCheckResult({ result }) {
  const check = result && result.micCheck;
  if (!check) return null;
  return (
    <div className="local-interview-mic-result">
      <Alert
        showIcon
        type={micCheckAlertType(check.level)}
        message={check.message || '麦克风预检完成'}
        description={`${check.recommendation || ''} 临时音频、转写与分析文件已删除。`}
      />
    </div>
  );
}

function ResultPaths({ result }) {
  if (!result) return <Text type="secondary">暂无产物</Text>;
  const items = [
    ['summary.json', result.summaryPath],
    ['音频', result.wavPath],
    ['转写 TXT', result.transcriptTxt],
    ['转写 SRT', result.transcriptSrt],
    ['转写 JSON', result.transcriptJson],
    ['Codex 输入包', result.codexInput],
  ].filter(([, value]) => value);
  return (
    <div className="local-interview-paths">
      {items.map(([label, value]) => (
        <div key={label} className="local-interview-path">
          <span>{label}</span>
          <code>{value}</code>
        </div>
      ))}
    </div>
  );
}

export default function LocalInterviewPanel({
  readOnly,
  jobClosed = false,
  contextJobId = null,
  onOpenSettings,
  fixtureMode = false,
}) {
  const [topic, setTopic] = useState('候选人面试录音');
  const [filePath, setFilePath] = useState('');
  const [materialConsent, setMaterialConsent] = useState(false);
  const [micCheckConsent, setMicCheckConsent] = useState(false);
  const [doctor, setDoctor] = useState(null);
  const [job, setJob] = useState({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [abortBusy, setAbortBusy] = useState(false);
  const [error, setError] = useState('');
  const [doctorError, setDoctorError] = useState('');
  const [progressError, setProgressError] = useState('');
  const [progressKnown, setProgressKnown] = useState(false);

  const refreshProgress = useCallback(async () => {
    try {
      const data = await api.localInterviewProgress();
      setJob(data.job || { status: 'idle' });
      setProgressKnown(true);
      setProgressError('');
    } catch (err) {
      setProgressError(err.message || '录音任务状态读取失败');
    }
  }, []);

  const refreshDoctor = useCallback(async () => {
    try {
      const data = await api.localInterviewDoctor();
      setDoctor(data.doctor || null);
      setDoctorError('');
    } catch (err) {
      setDoctorError(err.message || '本机录音能力检查失败');
    }
  }, []);

  useEffect(() => {
    if (fixtureMode) {
      setDoctor({ ready: true, status: 'ready', message: 'Fixture 隔离模拟，不检查真实设备。' });
      setDoctorError('');
      setJob({ status: 'idle' });
      setProgressKnown(true);
      setProgressError('');
      return undefined;
    }
    if (READONLY_UI) {
      setDoctor(null);
      setDoctorError('');
      setJob({
        status: 'disabled_in_operational_readonly',
        message: '操作只读模式不启动依赖检查，也不读取或恢复运行中任务。',
      });
      setProgressKnown(true);
      setProgressError('');
      return undefined;
    }
    refreshDoctor();
    refreshProgress();
    return undefined;
  }, [fixtureMode, refreshDoctor, refreshProgress]);

  useEffect(() => {
    if (fixtureMode || READONLY_UI) return undefined;
    const progressActive = job.status === 'starting'
      || job.status === 'running'
      || job.cleanup_pending === true
      || job.binding_pending === true
      || job.termination_unconfirmed === true
      || job.persistent_state_failed === true;
    const timer = setInterval(refreshProgress, progressActive ? 450 : 2500);
    return () => clearInterval(timer);
  }, [
    fixtureMode,
    job.binding_pending,
    job.cleanup_pending,
    job.persistent_state_failed,
    job.status,
    job.termination_unconfirmed,
    refreshProgress,
  ]);

  async function runAction(action) {
    setBusy(true);
    setError('');
    try {
      await action();
      if (!fixtureMode) await refreshProgress();
    } catch (err) {
      setError(err.message);
    } finally {
      setTimeout(() => setBusy(false), 800);
    }
  }

  async function chooseFile() {
    if (readOnly) {
      setError('当前为只读模式，不能选择或导入本地音视频文件。');
      return;
    }
    if (fixtureMode) {
      setFilePath('Fixture 隔离音视频（未读取真实文件）');
      return;
    }
    if (window.localInterview && window.localInterview.selectMediaFile) {
      const selected = await window.localInterview.selectMediaFile();
      if (!selected.ok) throw new Error(selected.error || '选择文件失败');
      if (!selected.canceled) setFilePath(selected.path);
      return;
    }
    const value = window.prompt('请输入本地音视频文件路径');
    if (value) setFilePath(value);
  }

  const starting = job && job.status === 'starting';
  const running = job && job.status === 'running';
  const taskActive = starting || running;
  const terminationUiState = localInterviewTerminationUiState(job);
  const terminationPending = terminationUiState.pending;
  const taskBusy = taskActive || terminationPending;
  const boundToOtherJob = job?.bind_job_id != null
    && contextJobId != null
    && String(job.bind_job_id) !== String(contextJobId);
  const safetyActionsLocked = READONLY_UI || (readOnly && !jobClosed);
  const taskActionAllowed = !boundToOtherJob && !safetyActionsLocked;
  const recordingFinalizationUiState = localInterviewRecordingFinalizationUiState(job);
  const stopping = isRecordingFinalizing(job);
  const discarding = recordingFinalizationUiState.discarding;
  const legacyReady = !!(doctor && (doctor.toolchainReady === true || doctor.ready === true));
  const ready = localInterviewMicCheckReady(doctor);
  const importReady = doctor?.capabilities?.import?.ready === true
    || (doctor?.capabilities == null && legacyReady);
  const degraded = doctor?.status === 'degraded' || doctor?.degraded === true;
  const showDoctorRecovery = !taskBusy
    && !READONLY_UI
    && (Boolean(doctorError) || Boolean(doctor && (!ready || !importReady)));
  const doctorStatusText = doctor ? (ready ? '工具已就绪' : '工具未就绪') : (doctorError ? '状态未知' : '检查中');
  const importStatusText = doctor ? (importReady ? '工具已就绪' : '工具未就绪') : (doctorError ? '状态未知' : '检查中');
  const taskStatusText = progressKnown ? statusText(job.status, job.mode) : (progressError ? '状态未知' : '读取中');
  const progressPercent = job.planned_duration_seconds
    ? Math.min(100, Math.round((Number(job.elapsed_seconds || 0) / Number(job.planned_duration_seconds)) * 100))
    : 0;

  function runMicCheck() {
    if (!fixtureMode) return api.localInterviewMicCheck('HRBOSS-mic-check', 8, null, null, micCheckConsent, null);
    setJob({
      status: 'done',
      mode: 'mic-check',
      result: {
        micCheck: {
          level: 'pass',
          message: 'Fixture 麦克风预检通过',
          recommendation: '仅验证同形交互，未访问真实麦克风或 ASR。',
          transcriptText: '合成短句',
          audioStats: { rmsAmplitude: 0.08, maximumAmplitude: 0.28 },
        },
      },
    });
    return Promise.resolve();
  }

  function runImport() {
    if (!fixtureMode) return api.importLocalInterviewFile(filePath.trim(), topic, null, null, materialConsent);
    setJob({
      status: 'done',
      mode: 'from-file',
      message: 'Fixture 导入模拟完成；没有读取文件、写入业务数据或调用外部服务。',
      result: { transcriptText: '合成转写结果' },
    });
    return Promise.resolve();
  }

  function runDoctorCheck() {
    if (!fixtureMode) return refreshDoctor();
    setDoctor({ ready: true, toolchainReady: true, status: 'ready', microphone: { tested: false, status: 'not_tested' }, message: 'Fixture 隔离模拟，不检查真实设备。' });
    return Promise.resolve();
  }

  function runStop() {
    if (!fixtureMode) {
      return api.stopLocalInterviewRecord(
        job.id,
        job.bind_candidate_id,
        job.bind_job_id,
        job.bind_round,
      );
    }
    setJob((current) => ({
      ...current,
      status: 'done',
      message: 'Fixture 停止模拟完成；未访问真实录音任务。',
    }));
    return Promise.resolve();
  }

  function runAbort() {
    if (!fixtureMode) return api.abortLocalInterviewTask(job.id, job.bind_job_id);
    setJob((current) => ({
      ...current,
      status: 'cancelled',
      cleanup_pending: false,
      message: 'Fixture 取消与清理模拟完成；未访问真实录音或材料任务。',
    }));
    return Promise.resolve();
  }

  async function abortCurrentTask() {
    if (abortBusy || !job?.id) return;
    setAbortBusy(true);
    setError('');
    try {
      const response = await runAbort();
      if (!fixtureMode && response?.job) setJob(response.job);
      if (!fixtureMode) await refreshProgress();
    } catch (err) {
      if (err?.data?.job) setJob(err.data.job);
      setError(err.message || '本地任务停止未确认');
    } finally {
      setAbortBusy(false);
    }
  }

  return (
    <div className="local-interview-panel">
      <Card
        size="small"
        className="local-interview-card"
        title={(
          <div className="local-panel-title">
            <strong>本地面试录音</strong>
            <span>备用录音/导入工作台</span>
          </div>
        )}
      >
        <Space direction="vertical" size={12} className="local-interview-stack">
          {READONLY_UI
            ? <Alert type="warning" showIcon message="当前为操作只读；不启动本机依赖检查，不轮询或恢复录音任务，录音、导入和停止等动作保持锁定。" />
            : jobClosed
              ? <Alert type="warning" showIcon message="岗位已关闭；不能开始录音或导入。当前岗位的运行任务仍可停止并清理，但不会生成转写或归档。" />
              : readOnly && <Alert type="warning" showIcon message="当前写入权限未确认；录音、导入与任务停止入口保持锁定。" />}
          {fixtureMode && <Alert type="info" showIcon message="Fixture · 隔离模拟" description="与正式页面使用相同骨架；本区域不访问真实麦克风、文件、业务 API 或外部服务。" />}
          {degraded && <Alert type="warning" showIcon message="这台电脑暂不能录音或转写" description={doctor.message} action={onOpenSettings ? <Button size="small" onClick={onOpenSettings}>查看设置</Button> : null} />}
          {doctorError && <Alert type="warning" showIcon message="暂时无法确认录音环境" description={doctorError} />}
          {progressError && <Alert type="warning" showIcon message={progressKnown ? '最新录音任务状态刷新失败，继续显示上次成功结果' : '录音任务状态未知'} description={progressError} />}
          {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
          {terminationPending && (
            <Alert
              type={terminationUiState.blocking ? 'error' : 'info'}
              showIcon
              message={terminationUiState.label}
              description={job.message || '正在确认进程结束并清理未完成材料。'}
            />
          )}
          {boundToOtherJob && taskBusy && (
            <Alert
              type="warning"
              showIcon
              message="当前显示的是其他岗位的本地任务"
              description={`任务 ${job.id || '--'} · 岗位 ${job.bind_job_id || '--'} · 候选人 ${job.bind_candidate_id || '未绑定'}。本页不会停止不匹配的任务，请回对应候选人或岗位页面处理。`}
            />
          )}
          {!boundToOtherJob && job.bind_candidate_id && taskBusy && (
            <Alert
              type="info"
              showIcon
              message="当前为已绑定候选人的正式任务"
              description={`任务 ${job.id || '--'} · 岗位 ${job.bind_job_id || '--'} · 候选人 ${job.bind_candidate_id} · 第 ${job.bind_round || '--'} 轮。停止请求会精确匹配此任务。`}
            />
          )}
          {job.message && <Alert type={job.status === 'error' ? 'error' : 'info'} showIcon message={job.message} />}
          <Alert type="info" showIcon message="正式面试录音请在候选人的面试工作台开始；系统会先核验知情同意记录。" />
          <Descriptions size="small" bordered column={2}>
            <Descriptions.Item label="录音与转写工具">
              <Tag color={ready ? 'green' : doctorError ? 'red' : 'default'}>{doctorStatusText}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="文件导入工具">
              <Tag color={importReady ? 'green' : doctorError ? 'red' : 'default'}>{importStatusText}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="任务状态">
              <Tag color={progressError && !progressKnown ? 'red' : statusColor(job.status)}>{taskStatusText}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="开始时间">{job.started_at ? fmtTime(job.started_at) : '暂无'}</Descriptions.Item>
            <Descriptions.Item label="结束时间">{job.finished_at ? fmtTime(job.finished_at) : '暂无'}</Descriptions.Item>
            <Descriptions.Item label="已录时长">{formatSeconds(job.elapsed_seconds)}</Descriptions.Item>
            <Descriptions.Item label="预计时长">{job.planned_duration_seconds ? formatSeconds(job.planned_duration_seconds) : '手动停止'}</Descriptions.Item>
          </Descriptions>
          {running && job.mode === 'record' && (
            <LiveRecordingWaveform
              key={job.id || 'current-recording'}
              liveAudio={job.live_audio}
              stopping={stopping}
              discarding={discarding}
            />
          )}
          {running && (
            <div className="recording-duration-bar">
              <div>
                <strong>{formatSeconds(job.elapsed_seconds)}</strong>
                <span>{job.planned_duration_seconds ? ` / ${formatSeconds(job.planned_duration_seconds)}` : ' / 手动停止'}</span>
              </div>
              {job.planned_duration_seconds
                ? <progress aria-label="录音计划进度" value={progressPercent} max="100" />
                : <progress aria-label="录音进行中，等待手动停止" />}
            </div>
          )}

          <div className="local-interview-grid">
            <label>
              <span>主题</span>
              <Input
                name="local-interview-topic"
                autoComplete="off"
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                disabled={readOnly || taskBusy}
              />
            </label>
          </div>

          {taskBusy ? (
            <Space wrap className="local-interview-actions">
              {starting && (
                <Text type="secondary">
                  {job.mode === 'from-file'
                    ? '正在建立本地材料处理任务，处理工具尚未获准读取文件内容。'
                    : (job.mode === 'mic-check'
                      ? '正在建立麦克风预检并确认本地守护状态，尚未打开麦克风。'
                      : '正在建立安全录音并确认本地守护状态，尚未打开麦克风。')}
                </Text>
              )}
              {running && job.mode === 'record' && !jobClosed && taskActionAllowed && (
                <Button
                  danger
                  icon={<StopOutlined />}
                  loading={stopping}
                  disabled={stopping || busy}
                  onClick={() => runAction(runStop)}
                >
                  {discarding
                    ? '正在停止并清理…'
                    : (stopping ? '正在停止并生成转写' : '停止录音并转写')}
                </Button>
              )}
              {taskActive
                && taskActionAllowed
                && (
                  starting
                  || job.mode === 'mic-check'
                  || job.mode === 'from-file'
                  || (job.mode === 'record' && jobClosed)
                ) && (
                <Button
                  danger
                  icon={<StopOutlined />}
                  loading={abortBusy || terminationPending}
                  disabled={abortBusy || terminationPending}
                  onClick={abortCurrentTask}
                >
                  {terminationPending
                    ? '正在停止并清理…'
                    : (starting
                      ? '取消启动并清理'
                      : (job.mode === 'mic-check'
                        ? '取消预检并清理'
                        : (job.mode === 'from-file' ? '取消处理并清理' : '停止并清理（不生成转写）')))}
                </Button>
              )}
              {taskActive && !taskActionAllowed && (
                <Text type="secondary">当前任务不属于本页或写入权限未确认，本页不会发送全局停止指令。</Text>
              )}
            </Space>
          ) : (
            <>
              <Space direction="vertical" size={6} className="local-interview-stack">
                <Text strong>录音前检查</Text>
                <Text type="secondary">正式录音开始前，可先确认麦克风收音是否清晰；测试材料仅在本机处理并在完成后删除。</Text>
                <Checkbox
                  name="local-interview-mic-check-consent"
                  checked={micCheckConsent}
                  disabled={readOnly || busy || taskBusy || degraded || !ready}
                  onChange={(event) => setMicCheckConsent(event.target.checked)}
                >
                  已告知在场说话人，并同意进行约 8 秒本地麦克风测试；测试后的音频、转写与分析文件将删除。
                </Checkbox>
                <Space wrap className="local-interview-actions">
                  <Button
                    icon={<CheckCircleOutlined />}
                    disabled={readOnly || busy || taskBusy || degraded || !ready || !micCheckConsent}
                    loading={busy}
                    onClick={() => runAction(runMicCheck)}
                  >
                    {fixtureMode ? '模拟检测麦克风' : '检测麦克风'}
                  </Button>
                  {showDoctorRecovery && (
                    <Button
                      icon={<ReloadOutlined />}
                      loading={busy}
                      onClick={() => runAction(runDoctorCheck)}
                      disabled={busy}
                    >
                      重新检查录音环境
                    </Button>
                  )}
                </Space>
              </Space>

              <Space direction="vertical" size={6} className="local-interview-stack">
                <Text strong>导入已有音视频</Text>
                <Text type="secondary">选择已取得授权的面试音视频，生成转写材料供招聘复盘。</Text>
                <Input
                  aria-label="本地音视频文件路径"
                  name="local-interview-media-file-path"
                  autoComplete="off"
                  value={filePath}
                  onChange={(event) => setFilePath(event.target.value)}
                  disabled={readOnly || busy || taskBusy || degraded || !importReady}
                  placeholder="请选择本地音视频文件"
                />
                <Checkbox name="local-interview-material-consent" checked={materialConsent} disabled={readOnly || busy || taskBusy || degraded || !importReady} onChange={(event) => setMaterialConsent(event.target.checked)}>
                  已确认该音视频已取得相关人员授权，可用于本地转写和招聘复盘。
                </Checkbox>
                <Space wrap className="local-interview-actions">
                  <Button icon={<FileSearchOutlined />} disabled={readOnly || busy || taskBusy || degraded || !importReady} onClick={() => runAction(chooseFile)}>
                    {fixtureMode ? '模拟选择音视频' : '选择音视频文件'}
                  </Button>
                  <Button
                    type="primary"
                    icon={<UploadOutlined />}
                    disabled={readOnly || busy || taskBusy || degraded || !importReady || !filePath.trim() || !materialConsent}
                    onClick={() => runAction(runImport)}
                  >
                    {fixtureMode ? '模拟导入并转写' : '导入并转写'}
                  </Button>
                </Space>
              </Space>
            </>
          )}

          <Card size="small" title="任务产物" className="local-interview-result">
            <MicCheckResult result={job.result} />
            <AudioQuality result={job.result} />
            <ResultPaths result={job.result} />
            {job.error && <Alert type="error" showIcon message={job.error} />}
            {job.log_path && (
              <div className="local-interview-path">
                <span>日志</span>
                <code>{job.log_path}</code>
              </div>
            )}
          </Card>
        </Space>
      </Card>
    </div>
  );
}
