import React, { Suspense, useEffect, useRef, useState, useCallback } from 'react';
import { Alert, Button, Dropdown, Layout, Modal, Skeleton, Space, App as AntApp } from 'antd';
import {
  CalendarOutlined,
  DesktopOutlined,
  HomeOutlined,
  InfoCircleOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoreOutlined,
  ProfileOutlined,
  ReadOutlined,
  SettingOutlined,
  TeamOutlined,
  UpOutlined,
  UploadOutlined,
  UsergroupAddOutlined,
} from '@ant-design/icons';
import TopBar from './components/TopBar.jsx';
import DashboardPanel from './components/DashboardPanel.jsx';
import WorkflowGuidePanel from './components/WorkflowGuidePanel.jsx';
import { api, sleep, READONLY_UI } from './api.js';
import { createRequestEpoch } from './request-epoch.js';
import ResumeCandidateImportModal from './components/ResumeCandidateImportModal.jsx';
import ScreenshotImportTaskPanel from './components/ScreenshotImportTaskPanel.jsx';
import FeatureErrorBoundary, { createRetryableLazy } from './components/FeatureErrorBoundary.jsx';
import {
  isScreenshotImportTaskActive,
  normalizeScreenshotImportTask,
  screenshotImportTaskNeedsAttention,
} from './screenshot-import-task.mjs';

const CandidateList = createRetryableLazy(() => import('./components/CandidateList.jsx'));
const CandidateDetail = createRetryableLazy(() => import('./components/CandidateDetail.jsx'));
const JobLedgerPanel = createRetryableLazy(() => import('./components/JobLedgerPanel.jsx'));
const JobManagementDemo = createRetryableLazy(() => import('./components/JobManagementDemo.jsx'));
const JobManagementPanel = createRetryableLazy(() => import('./components/JobManagementPanel.jsx'));
const TalentPoolDemo = createRetryableLazy(() => import('./components/TalentPoolDemo.jsx'));
const SettingsPanel = createRetryableLazy(() => import('./components/SettingsPanel.jsx'));
const DeepProfileModal = createRetryableLazy(() => import('./components/DeepProfileModal.jsx'));
const ScreenshotOcrReviewModal = createRetryableLazy(() => import('./components/ScreenshotOcrReviewModal.jsx'));
const InterviewSchedulePanel = createRetryableLazy(() => import('./components/InterviewSchedulePanel.jsx'));
const InterviewScheduleCanonical = createRetryableLazy(() => import('./components/InterviewScheduleCanonical.jsx'));
const { Header, Sider, Content } = Layout;
const PRIMARY_NAV_ITEMS = ['工作台', '职位管理', '候选人', '面试安排', '人才库'];
const UTILITY_NAV_ITEMS = ['使用指南', '设置', '关于/版本', '本机状态'];
const DESKTOP_UTILITY_MENU_ITEMS = Object.freeze([
  {
    key: 'guide',
    label: '使用指南',
    description: '流程说明与操作帮助',
    icon: ReadOutlined,
    navigation: '使用指南',
  },
  {
    key: 'settings-center',
    label: '设置中心',
    description: '状态、连接、面试与数据',
    icon: SettingOutlined,
  },
  {
    key: 'local-status',
    label: '本机状态',
    description: '服务、数据和运行检查',
    icon: DesktopOutlined,
    sectionId: 'settings-overview',
    focusTargetId: 'settings-overview-title',
  },
  {
    key: 'about',
    label: '关于招才官',
    description: '版本与本机诊断',
    icon: InfoCircleOutlined,
    sectionId: 'settings-advanced',
    focusTargetId: 'settings-about-title',
  },
]);
const CONFIGURABLE_SETTINGS_SECTIONS = new Set([
  'settings-brand',
  'settings-integrations',
  'settings-interview-tools',
  'settings-data',
]);
const SETTINGS_SECTION_IDS = new Set([
  'settings-overview',
  ...CONFIGURABLE_SETTINGS_SECTIONS,
  'settings-advanced',
]);
const SETTINGS_RETURN_NAV_STATE_KEY = 'hrbossSettingsReturnNav';
const SETTINGS_RETURN_NAV_ITEMS = new Set([...PRIMARY_NAV_ITEMS, '使用指南']);
const SETTINGS_UTILITY_SECTIONS = Object.freeze({
  设置: 'settings-overview',
  '关于/版本': 'settings-advanced',
  本机状态: 'settings-overview',
});
const NAV_ICON_MAP = {
  工作台: HomeOutlined,
  使用指南: ReadOutlined,
  设置: SettingOutlined,
  '关于/版本': InfoCircleOutlined,
  本机状态: DesktopOutlined,
  职位管理: ProfileOutlined,
  候选人: TeamOutlined,
  人才库: UsergroupAddOutlined,
  面试安排: CalendarOutlined,
};
const MOBILE_NAV_ITEMS = [...PRIMARY_NAV_ITEMS, ...UTILITY_NAV_ITEMS];
const FINISHED_PROGRESS_VISIBLE_MS = 5 * 60 * 1000;
const BRAND_NAME_STORAGE_KEY = 'hrboss.ui.brandName.v1';
const BRAND_MARK_STORAGE_KEY = 'hrboss.ui.brandMark.v1';
const APP_NAV_COLLAPSED_STORAGE_KEY = 'hrboss.ui.appNavCollapsed.v1';
const APP_NAV_UTILITY_MENU_ID = 'app-nav-utility-menu';
const CANDIDATE_LIST_COLLAPSED_STORAGE_KEY = 'hrboss.ui.candidateListCollapsed.v1';
const CANDIDATE_LIST_PANEL_ID = 'candidate-list-panel';
const CANDIDATE_LIST_SELECTED_WIDTH = 'clamp(400px, 46%, 620px)';
const CANDIDATE_LIST_EMPTY_WIDTH = 'clamp(520px, 68%, 820px)';
const CURRENT_JOB_ID_STORAGE_KEY = 'hrboss.ui.currentJobId.v1';
const DEFAULT_BRAND_NAME = '招才官';
const DEFAULT_BRAND_MARK = '招';
const EMPTY_CANDIDATE_CHILDREN = Object.freeze({
  resume_online: Object.freeze([]),
  resume_attachment: Object.freeze([]),
  ai_review: Object.freeze([]),
  status_history: Object.freeze([]),
  comment: Object.freeze([]),
  contact: Object.freeze([]),
});

function ModuleLoadingFallback({ modal = false }) {
  return (
    <div
      className={`module-loading-skeleton ${modal ? 'module-loading-skeleton-modal' : ''}`}
      role="status"
      aria-live="polite"
      aria-label="正在加载"
    >
      <div className="module-loading-skeleton-card">
        <Skeleton active title={{ width: '32%' }} paragraph={{ rows: 4, width: ['96%', '88%', '92%', '68%'] }} />
        <span className="module-loading-skeleton-label">正在加载…</span>
      </div>
    </div>
  );
}

function ModuleSemanticHeading({ children }) {
  return <h1 className="module-semantic-heading" data-module-heading tabIndex={-1}>{children}</h1>;
}

function normalizeBrandName(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 32) : DEFAULT_BRAND_NAME;
}

function normalizeBrandMark(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 4).toUpperCase() : DEFAULT_BRAND_MARK;
}

function isLegacyDefaultBrandName(value) {
  return ['招聘工作台', 'Boss 招聘', 'TalentBench 识才台', 'TalentBench', '识才台'].includes(value);
}

function readBrandName() {
  if (typeof window === 'undefined') return DEFAULT_BRAND_NAME;
  try {
    const stored = String(window.localStorage.getItem(BRAND_NAME_STORAGE_KEY) || '').trim();
    if (!stored || isLegacyDefaultBrandName(stored)) return DEFAULT_BRAND_NAME;
    return normalizeBrandName(stored);
  } catch {
    return DEFAULT_BRAND_NAME;
  }
}

function readBrandMark() {
  if (typeof window === 'undefined') return DEFAULT_BRAND_MARK;
  try {
    const storedMark = String(window.localStorage.getItem(BRAND_MARK_STORAGE_KEY) || '').trim();
    const storedName = String(window.localStorage.getItem(BRAND_NAME_STORAGE_KEY) || '').trim();
    if (storedMark === 'TB' && (!storedName || isLegacyDefaultBrandName(storedName))) return DEFAULT_BRAND_MARK;
    return normalizeBrandMark(storedMark);
  } catch {
    return DEFAULT_BRAND_MARK;
  }
}

function readStoredBoolean(key, fallback = false) {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function persistUiPreference(key, value) {
  if (READONLY_UI || typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}

function writeStoredBoolean(key, value) {
  return persistUiPreference(key, value ? '1' : '0');
}

function readStoredJobId() {
  if (typeof window === 'undefined') return null;
  try {
    const stored = String(window.localStorage.getItem(CURRENT_JOB_ID_STORAGE_KEY) || '').trim();
    return stored || null;
  } catch {
    return null;
  }
}

function writeStoredJobId(value) {
  if (READONLY_UI || typeof window === 'undefined') return false;
  if (value == null) {
    try {
      window.localStorage.removeItem(CURRENT_JOB_ID_STORAGE_KEY);
      return true;
    } catch {
      return false;
    }
  }
  return persistUiPreference(CURRENT_JOB_ID_STORAGE_KEY, value);
}

function readSettingsSectionFromHash() {
  if (typeof window === 'undefined') return '';
  const sectionId = String(window.location.hash || '').replace(/^#/, '');
  return SETTINGS_SECTION_IDS.has(sectionId) ? sectionId : '';
}

function normalizeSettingsReturnNav(value) {
  const nav = String(value || '').trim();
  return SETTINGS_RETURN_NAV_ITEMS.has(nav) ? nav : '工作台';
}

function readSettingsReturnNavFromHistory() {
  if (typeof window === 'undefined') return '工作台';
  return normalizeSettingsReturnNav(window.history.state?.[SETTINGS_RETURN_NAV_STATE_KEY]);
}

function replaceSettingsRoute(sectionId, returnNav) {
  const normalizedSection = SETTINGS_SECTION_IDS.has(sectionId) ? sectionId : 'settings-overview';
  const previousState = window.history.state && typeof window.history.state === 'object'
    ? window.history.state
    : {};
  window.history.replaceState({
    ...previousState,
    [SETTINGS_RETURN_NAV_STATE_KEY]: normalizeSettingsReturnNav(returnNav),
  }, '', `#${normalizedSection}`);
}

function clearSettingsRoute() {
  if (typeof window === 'undefined' || !readSettingsSectionFromHash()) return;
  const previousState = window.history.state && typeof window.history.state === 'object'
    ? { ...window.history.state }
    : {};
  delete previousState[SETTINGS_RETURN_NAV_STATE_KEY];
  window.history.replaceState(
    Object.keys(previousState).length ? previousState : null,
    '',
    window.location.href.replace(/#.*$/, ''),
  );
}

function pickPreferredJob(jobList, preferredId, options = {}) {
  const preferred = jobList.find((item) => String(item.id) === String(preferredId));
  if (preferred && !(options.preferReal && preferred.is_fixture)) return preferred;
  const real = jobList.find((item) => !item.is_fixture);
  return real || preferred || jobList[0] || null;
}

function progressDoneKey(progress) {
  if (!progress || !['done', 'error'].includes(progress.status)) return '';
  return progress.finished_at || progress.updated_at || '';
}

function isRecentProgress(progress, maxAgeMs = FINISHED_PROGRESS_VISIBLE_MS) {
  const raw = progressDoneKey(progress);
  if (!raw) return false;
  const time = Date.parse(raw);
  return Number.isFinite(time) && Date.now() - time <= maxAgeMs;
}

function rateSkipText(summary) {
  const parts = [
    Number(summary.skipped_paywalled || 0) ? `${summary.skipped_paywalled} 人付费墙` : '',
    Number(summary.skipped_missing_resume || 0) ? `${summary.skipped_missing_resume} 人缺在线简历` : '',
    Number(summary.skipped_manual || 0) ? `${summary.skipped_manual} 个人工评级` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('、') : '无';
}

function sameJobId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function sameCandidateId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function normalizeCandidateChildren(value) {
  const children = value && typeof value === 'object' ? value : EMPTY_CANDIDATE_CHILDREN;
  return Object.fromEntries(Object.keys(EMPTY_CANDIDATE_CHILDREN).map((key) => [
    key,
    Array.isArray(children[key]) ? children[key] : [],
  ]));
}

function candidateStableReference(candidate) {
  const value = String(candidate?.internal_id || '').trim();
  if (!value) return { visible: 'ID 待补全', full: '候选人稳定 ID 待补全' };
  const visible = value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
  return { visible: `ID ${visible}`, full: `候选人稳定 ID：${value}` };
}

function isCurrentJobContext(ref, context) {
  const current = ref.current;
  return !!context
    && current.token === context.token
    && sameJobId(current.jobId, context.jobId);
}

function isUnchangedJobContext(ref, context) {
  const current = ref.current;
  return !!context
    && current.token === context.token
    && (context.jobId == null ? current.jobId == null : sameJobId(current.jobId, context.jobId));
}

function isCurrentCandidateContext(ref, context) {
  const current = ref.current;
  return !!context
    && current.token === context.token
    && sameJobId(current.jobId, context.jobId)
    && sameCandidateId(current.candidateId, context.candidateId);
}

export default function App() {
  const { message, modal } = AntApp.useApp();

  const [jobs, setJobs] = useState([]);
  const [jobsState, setJobsState] = useState('loading');
  const [jobsError, setJobsError] = useState('');
  const jobsRef = useRef(jobs);
  const jobsStateRef = useRef(jobsState);
  jobsRef.current = jobs;
  jobsStateRef.current = jobsState;
  const [activeNav, setActiveNav] = useState(() => (readSettingsSectionFromHash() ? '设置' : '工作台'));
  const [moduleAnnouncement, setModuleAnnouncement] = useState('');
  const previousActiveNavRef = useRef('工作台');
  const [appNavCollapsed, setAppNavCollapsed] = useState(() => readStoredBoolean(APP_NAV_COLLAPSED_STORAGE_KEY, false));
  const [utilityMenuOpen, setUtilityMenuOpen] = useState(false);
  const [activeDesktopUtilityKey, setActiveDesktopUtilityKey] = useState('');
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [aiSettingsReturnContext, setAiSettingsReturnContext] = useState(null);
  const [aiResumeIntent, setAiResumeIntent] = useState(null);
  const utilityMenuTriggerRef = useRef(null);
  const appNavCollapseButtonRef = useRef(null);
  const appNavRestoreButtonRef = useRef(null);
  const appNavFocusHandoffRef = useRef('');
  const [jobManagementView, setJobManagementView] = useState('ledger');
  const previousJobManagementRouteRef = useRef('ledger');
  const jobManagementModuleActiveRef = useRef(false);
  const jobManagementReturnFocusRef = useRef(null);
  const settingsHashWriteInProgressRef = useRef(false);
  const [jobEditorDirty, setJobEditorDirty] = useState(false);
  const [settingsReturnNav, setSettingsReturnNav] = useState(readSettingsReturnNavFromHistory);
  const [jobId, setJobId] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [candidateListState, setCandidateListState] = useState('idle');
  const [candidateListError, setCandidateListError] = useState('');
  const [candidateListErrorDetails, setCandidateListErrorDetails] = useState('');
  const candidateAuthorityWriteBlocked = !['ready', 'empty'].includes(candidateListState);
  const [workbench, setWorkbench] = useState(null);
  const [workbenchState, setWorkbenchState] = useState('idle');
  const [workbenchError, setWorkbenchError] = useState('');
  const [workbenchNavigationTarget, setWorkbenchNavigationTarget] = useState(null);
  const currentJobContextRef = useRef({ jobId: null, token: 0 });
  const currentCandidateContextRef = useRef({ jobId: null, candidateId: null, token: 0 });
  const jobsRequestRef = useRef(createRequestEpoch());
  const jobRequestRef = useRef(createRequestEpoch());
  const detailRequestRef = useRef(createRequestEpoch());
  const candidatesRef = useRef([]);
  const workbenchRef = useRef(null);

  const [query, setQuery] = useState('');
  const [comm, setComm] = useState('');
  const [disp, setDisp] = useState('');
  const [sabc, setSabc] = useState('');
  const [education, setEducation] = useState('');

  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null); // { candidate, children, actions }
  const detailRef = useRef(null);
  const [detailState, setDetailState] = useState('idle');
  const [detailError, setDetailError] = useState('');
  const [detailInitialDomain, setDetailInitialDomain] = useState('profile');
  const [detailInterviewNavigation, setDetailInterviewNavigation] = useState({ tab: 'review', target: null, requestKey: 0 });
  const [candidateWorkspaceDirty, setCandidateWorkspaceDirty] = useState(false);
  const candidateWorkspaceDirtyRef = useRef(false);
  const [candidateWorkspaceBusy, setCandidateWorkspaceBusy] = useState(false);
  const candidateWorkspaceBusyRef = useRef(false);
  const [candidateWorkspaceRevision, setCandidateWorkspaceRevision] = useState(0);
  const discardConfirmationRef = useRef(null);
  const settingsDiscardConfirmationRef = useRef(null);
  const [candidateListCollapsed, setCandidateListCollapsed] = useState(() => readStoredBoolean(CANDIDATE_LIST_COLLAPSED_STORAGE_KEY, false));
  const candidateListCollapseButtonRef = useRef(null);
  const candidateListRestoreButtonRef = useRef(null);
  const candidateListFocusHandoffRef = useRef('');
  const [assessBusy, setAssessBusy] = useState(false);
  const [resumeIntakeBusy, setResumeIntakeBusy] = useState(false);
  const [resumeCandidateDraft, setResumeCandidateDraft] = useState(null);

  const [deepOpen, setDeepOpen] = useState(false);
  const [screenshotReviewOpen, setScreenshotReviewOpen] = useState(false);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  useEffect(() => {
    if (!jobEditorDirty && !candidateWorkspaceDirty && !candidateWorkspaceBusy) return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [candidateWorkspaceBusy, candidateWorkspaceDirty, jobEditorDirty]);

  useEffect(() => {
    if (!utilityMenuOpen) return undefined;
    const closeMenuOnEscape = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setUtilityMenuOpen(false);
      globalThis.requestAnimationFrame(() => utilityMenuTriggerRef.current?.focus());
    };
    document.addEventListener('keydown', closeMenuOnEscape, true);
    return () => document.removeEventListener('keydown', closeMenuOnEscape, true);
  }, [utilityMenuOpen]);

  useEffect(() => {
    if (candidateAuthorityWriteBlocked && screenshotReviewOpen) setScreenshotReviewOpen(false);
  }, [candidateAuthorityWriteBlocked, screenshotReviewOpen]);

  const [rateBusy, setRateBusy] = useState(false);
  const [rateLabel, setRateLabel] = useState('重新评级');

  const [localRefreshBusy, setLocalRefreshBusy] = useState(false);
  const [screenshotImportBusy, setScreenshotImportBusy] = useState(false);
  const screenshotImportBusyRef = useRef(false);
  const [screenshotImportProgress, setScreenshotImportProgress] = useState(null);
  const screenshotImportTaskRef = useRef(null);
  const screenshotImportTaskRequestRef = useRef(0);
  const [screenshotImportTaskOpen, setScreenshotImportTaskOpen] = useState(false);
  const [screenshotImportTaskLoadState, setScreenshotImportTaskLoadState] = useState('idle');
  const [screenshotImportTaskError, setScreenshotImportTaskError] = useState('');
  const [screenshotImportRetryBusy, setScreenshotImportRetryBusy] = useState(false);
  const screenshotImportRetryBusyRef = useRef(false);
  const [screenshotPendingReview, setScreenshotPendingReview] = useState({
    jobId: null,
    status: 'idle',
    count: null,
    error: '',
  });
  const screenshotPendingRequestRef = useRef(0);
  screenshotImportTaskRef.current = screenshotImportProgress;
  const screenshotImportRunning = isScreenshotImportTaskActive(screenshotImportProgress);
  const screenshotImportActionBlocked = screenshotImportBusy || screenshotImportRunning;

  useEffect(() => {
    if (previousActiveNavRef.current === activeNav) return undefined;
    previousActiveNavRef.current = activeNav;
    if (activeNav === '职位管理' && jobManagementView === 'editor') return undefined;
    setModuleAnnouncement(`已进入${activeNav}模块`);

    let focusObserver = null;
    let observerTimeout = null;
    const focusWorkspace = () => {
      const workspace = document.getElementById('main-workspace');
      if (!(workspace instanceof HTMLElement)) return false;
      globalThis.scrollTo?.({ top: 0, left: 0, behavior: 'auto' });
      workspace.scrollTop = 0;
      workspace.scrollLeft = 0;
      const moduleHeading = workspace.querySelector('[data-module-heading]');
      const focusTarget = moduleHeading instanceof HTMLElement ? moduleHeading : workspace;
      focusTarget.focus({ preventScroll: true });
      focusObserver?.disconnect();
      if (observerTimeout) globalThis.clearTimeout(observerTimeout);
      return true;
    };

    if (!focusWorkspace() && typeof MutationObserver !== 'undefined') {
      const observerRoot = document.querySelector('.main-frame') || document.body;
      focusObserver = new MutationObserver(focusWorkspace);
      focusObserver.observe(observerRoot, { childList: true, subtree: true });
      observerTimeout = globalThis.setTimeout(() => focusObserver?.disconnect(), 2000);
    }

    return () => {
      focusObserver?.disconnect();
      if (observerTimeout) globalThis.clearTimeout(observerTimeout);
    };
  }, [activeNav]);

  useEffect(() => {
    const routeKey = jobManagementView === 'editor'
      ? `editor:${jobId ?? 'none'}`
      : 'ledger';
    const wasJobManagementActive = jobManagementModuleActiveRef.current;
    jobManagementModuleActiveRef.current = activeNav === '职位管理';
    if (activeNav !== '职位管理') {
      previousJobManagementRouteRef.current = routeKey;
      return undefined;
    }
    if (!wasJobManagementActive && jobManagementView === 'ledger') {
      previousJobManagementRouteRef.current = routeKey;
      return undefined;
    }
    if (wasJobManagementActive && previousJobManagementRouteRef.current === routeKey) return undefined;
    previousJobManagementRouteRef.current = routeKey;

    const currentJobName = jobs.find((item) => sameJobId(item.id, jobId))?.name || '当前岗位';
    if (jobManagementView === 'ledger') setModuleAnnouncement('已返回岗位台账');

    let canceled = false;
    let timer = 0;
    let attempts = 0;
    const focusJobManagementRoute = () => {
      if (canceled) return;
      const visibleDialog = [...document.querySelectorAll('[role="dialog"]')]
        .some((element) => element instanceof HTMLElement && element.offsetParent !== null);
      let focusTarget = null;
      if (!visibleDialog && jobManagementView === 'editor') {
        focusTarget = document.querySelector('[data-job-editor-heading]');
      } else if (!visibleDialog) {
        const descriptor = jobManagementReturnFocusRef.current;
        if (descriptor) {
          focusTarget = [...document.querySelectorAll('[data-job-ledger-focus-job-id]')]
            .find((element) => (
              element instanceof HTMLElement
              && element.offsetParent !== null
              && element.dataset.jobLedgerFocusJobId === String(descriptor.jobId)
              && element.dataset.jobLedgerFocusAction === descriptor.action
            )) || null;
        }
        if (!focusTarget && document.querySelector('.job-ledger-page')) {
          focusTarget = document.querySelector('#main-workspace [data-module-heading]');
        }
      }
      if (focusTarget instanceof HTMLElement && focusTarget.offsetParent !== null) {
        if (jobManagementView === 'editor') {
          const visibleJobName = String(focusTarget.textContent || '').trim() || currentJobName;
          setModuleAnnouncement(`已进入岗位“${visibleJobName}”的 JD 与画像编辑视图`);
          globalThis.scrollTo?.({ top: 0, left: 0, behavior: 'auto' });
          focusTarget.focus({ preventScroll: true });
        } else {
          focusTarget.focus();
          focusTarget.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
          jobManagementReturnFocusRef.current = null;
        }
        return;
      }
      attempts += 1;
      if (attempts < 120) timer = globalThis.setTimeout(focusJobManagementRoute, 16);
    };
    timer = globalThis.setTimeout(focusJobManagementRoute, 0);
    return () => {
      canceled = true;
      globalThis.clearTimeout(timer);
    };
  }, [activeNav, jobId, jobManagementView]);

  const operationMenuButtonRef = useRef(null);
  const modalReturnFocusRef = useRef(null);
  const [brandName, setBrandName] = useState(readBrandName);
  const [brandMark, setBrandMark] = useState(readBrandMark);

  const refreshScreenshotPendingCount = useCallback(async (context = currentJobContextRef.current) => {
    if (READONLY_UI || !context?.jobId) return null;
    const requestId = screenshotPendingRequestRef.current + 1;
    screenshotPendingRequestRef.current = requestId;
    if (isCurrentJobContext(currentJobContextRef, context)) {
      setScreenshotPendingReview({ jobId: context.jobId, status: 'loading', count: null, error: '' });
    }
    try {
      const result = await api.listScreenshotOcrDrafts('pending_review', context.jobId);
      if (requestId !== screenshotPendingRequestRef.current
          || !isCurrentJobContext(currentJobContextRef, context)) return null;
      if (!Array.isArray(result?.drafts)) throw new Error('待校对草稿响应无效，请重试读取。');
      const count = result.drafts.length;
      setScreenshotPendingReview({ jobId: context.jobId, status: 'ready', count, error: '' });
      return count;
    } catch (err) {
      if (requestId !== screenshotPendingRequestRef.current
          || !isCurrentJobContext(currentJobContextRef, context)) return null;
      setScreenshotPendingReview({
        jobId: context.jobId,
        status: 'error',
        count: null,
        error: err.message || '读取失败',
      });
      return null;
    }
  }, []);

  const refreshScreenshotImportTask = useCallback(async (options = {}) => {
    const requestId = screenshotImportTaskRequestRef.current + 1;
    screenshotImportTaskRequestRef.current = requestId;
    if (options.showLoading) setScreenshotImportTaskLoadState('loading');
    try {
      let legacyProgress = null;
      let progressError = null;
      try {
        const response = await api.screenshotImportProgress();
        legacyProgress = response?.progress || null;
      } catch (error) {
        progressError = error;
      }

      // A requested historical run must not inherit another run's status/job.
      if (options.runId && String(legacyProgress?.run_id || '') !== String(options.runId)) {
        legacyProgress = null;
      }
      let detailedTask = legacyProgress?.ai_task || null;
      if (legacyProgress?.run_id && detailedTask?.run_id
          && String(legacyProgress.run_id) !== String(detailedTask.run_id)) {
        detailedTask = null;
      }
      const detailedRunId = options.runId || legacyProgress?.run_id || detailedTask?.run_id || '';
      if (detailedRunId) {
        let response;
        try {
          response = await api.screenshotImportTask(detailedRunId);
        } catch (error) {
          if (!detailedTask) throw error;
        }
        if (response?.task && String(response.task.run_id || response.task.task_id || '') !== String(detailedRunId)) {
          throw new Error('截图任务已变化，请刷新后重试。');
        }
        detailedTask = response?.task || detailedTask;
      }
      if (!legacyProgress && !detailedTask && progressError) throw progressError;

      const overallStatus = String(legacyProgress?.status || '');
      const rawTask = detailedTask ? {
        ...legacyProgress,
        ...detailedTask,
        status: ['running', 'done', 'error'].includes(overallStatus)
          ? overallStatus
          : detailedTask.status,
        stage: legacyProgress?.stage || detailedTask.phase,
        message: legacyProgress?.message || detailedTask.message,
        error: legacyProgress?.error || detailedTask.error,
        source_dir_name: legacyProgress?.source_dir_name || detailedTask.source_dir_name,
        started_at: legacyProgress?.started_at || detailedTask.created_at,
        finished_at: legacyProgress?.finished_at || detailedTask.finished_at,
        updated_at: legacyProgress?.updated_at || detailedTask.updated_at,
        detail_draft_count: legacyProgress?.detail_draft_count
          ?? detailedTask.detail_draft_count,
        pending_review_count: legacyProgress?.result?.pending_review
          ?? detailedTask.pending_review_count,
        result: legacyProgress?.result || detailedTask.result,
        progress: {
          done: legacyProgress?.ocr_done ?? detailedTask.processed_count,
          total: legacyProgress?.ocr_total
            ?? detailedTask.counts?.image_count
            ?? detailedTask.image_count,
        },
      } : legacyProgress;
      const task = rawTask ? normalizeScreenshotImportTask(rawTask) : null;
      if (requestId !== screenshotImportTaskRequestRef.current) return null;
      if (task) {
        const targetJobId = task.result?.job_id;
        task.pending_review_state = { jobId: targetJobId || null, status: 'idle', count: null, error: '' };
        if (targetJobId) {
          try {
            const context = currentJobContextRef.current;
            let count;
            if (sameJobId(targetJobId, context.jobId)) {
              count = await refreshScreenshotPendingCount(context);
              if (!Number.isFinite(count)) throw new Error('待校对数量暂未读取成功，请刷新任务重试。');
            } else {
              const result = await api.listScreenshotOcrDrafts('pending_review', targetJobId);
              if (!Array.isArray(result?.drafts)) throw new Error('待校对草稿响应无效，请重试读取。');
              count = result.drafts.length;
            }
            task.pending_review_state = { jobId: targetJobId, status: 'ready', count, error: '' };
          } catch (error) {
            task.pending_review_state = { jobId: targetJobId, status: 'error', count: null, error: error.message };
          }
        }
      }
      if (requestId !== screenshotImportTaskRequestRef.current) return null;
      screenshotImportTaskRef.current = task;
      setScreenshotImportProgress(task);
      setScreenshotImportTaskLoadState('ready');
      setScreenshotImportTaskError('');
      return task;
    } catch (error) {
      if (requestId !== screenshotImportTaskRequestRef.current) return null;
      setScreenshotImportTaskLoadState('error');
      setScreenshotImportTaskError(error?.message || '截图任务读取失败');
      if (options.throwOnError) throw error;
      return null;
    }
  }, [refreshScreenshotPendingCount]);

  const acceptScreenshotPendingCount = useCallback((count, targetJobId) => {
    const context = currentJobContextRef.current;
    if (!sameJobId(targetJobId, context.jobId)) return;
    screenshotPendingRequestRef.current += 1;
    // A draft confirmation/rejection supersedes an in-flight task count read.
    screenshotImportTaskRequestRef.current += 1;
    setScreenshotPendingReview({
      jobId: context.jobId,
      status: 'ready',
      count: Math.max(0, Number(count) || 0),
      error: '',
    });
  }, []);

  useEffect(() => {
    const context = currentJobContextRef.current;
    if (READONLY_UI || !context.jobId) {
      screenshotPendingRequestRef.current += 1;
      setScreenshotPendingReview({ jobId: null, status: 'idle', count: null, error: '' });
      return;
    }
    refreshScreenshotPendingCount(context);
  }, [jobId, refreshScreenshotPendingCount]);

  function clearJobContext() {
    const context = {
      jobId: null,
      token: currentJobContextRef.current.token + 1,
    };
    currentJobContextRef.current = context;
    currentCandidateContextRef.current = {
      jobId: null,
      candidateId: null,
      token: currentCandidateContextRef.current.token + 1,
    };
    writeStoredJobId(null);
    jobRequestRef.current.invalidate();
    detailRequestRef.current.invalidate();
    screenshotPendingRequestRef.current += 1;
    candidatesRef.current = [];
    detailRef.current = null;
    workbenchRef.current = null;
    jobManagementReturnFocusRef.current = null;
    modalReturnFocusRef.current = null;
    setJobId(null);
    setQuery('');
    setComm('');
    setDisp('');
    setSabc('');
    setEducation('');
    setCandidates([]);
    setCandidateListState('empty');
    setCandidateListError('');
    setCandidateListErrorDetails('');
    setWorkbench(null);
    setWorkbenchState('idle');
    setWorkbenchError('');
    setWorkbenchNavigationTarget(null);
    setSelectedId(null);
    setDetail(null);
    setDetailState('idle');
    setDetailError('');
    setDetailInitialDomain('profile');
    setDetailInterviewNavigation((current) => ({ tab: 'review', target: null, requestKey: current.requestKey + 1 }));
    candidateWorkspaceDirtyRef.current = false;
    setCandidateWorkspaceDirty(false);
    candidateWorkspaceBusyRef.current = false;
    setCandidateWorkspaceBusy(false);
    setCandidateWorkspaceRevision((value) => value + 1);
    setAssessBusy(false);
    setResumeIntakeBusy(false);
    setResumeCandidateDraft(null);
    setRateBusy(false);
    setRateLabel('重新评级');
    setLocalRefreshBusy(false);
    setScreenshotImportBusy(false);
    setScreenshotImportProgress(null);
    setScreenshotPendingReview({ jobId: null, status: 'idle', count: null, error: '' });
    setDeepOpen(false);
    setScreenshotReviewOpen(false);
    setJobEditorDirty(false);
    setJobManagementView('ledger');
    return context;
  }

  function beginJobContext(id) {
    const context = {
      jobId: id,
      token: currentJobContextRef.current.token + 1,
    };
    currentJobContextRef.current = context;
    writeStoredJobId(id);
    currentCandidateContextRef.current = {
      jobId: id,
      candidateId: null,
      token: currentCandidateContextRef.current.token + 1,
    };
    jobRequestRef.current.invalidate();
    detailRequestRef.current.invalidate();
    screenshotPendingRequestRef.current += 1;
    setScreenshotPendingReview({ jobId: id, status: 'loading', count: null, error: '' });
    setJobId(id);
    setQuery('');
    setComm('');
    setDisp('');
    setSabc('');
    setEducation('');
    candidatesRef.current = [];
    setCandidates([]);
    setCandidateListState('loading');
    setCandidateListError('');
    setCandidateListErrorDetails('');
    workbenchRef.current = null;
    setWorkbench(null);
    setWorkbenchError('');
    setWorkbenchState('loading');
    setWorkbenchNavigationTarget(null);
    setSelectedId(null);
    detailRef.current = null;
    setDetail(null);
    setDetailState('idle');
    setDetailError('');
    setDetailInitialDomain('profile');
    setDetailInterviewNavigation((current) => ({ tab: 'review', target: null, requestKey: current.requestKey + 1 }));
    candidateWorkspaceDirtyRef.current = false;
    setCandidateWorkspaceDirty(false);
    candidateWorkspaceBusyRef.current = false;
    setCandidateWorkspaceBusy(false);
    setAssessBusy(false);
    setResumeIntakeBusy(false);
    setResumeCandidateDraft(null);
    setRateBusy(false);
    setRateLabel('重新评级');
    setLocalRefreshBusy(false);
    return context;
  }

  function authoritativeJobForContext(context = currentJobContextRef.current) {
    if (jobsStateRef.current !== 'ready'
        || !context?.jobId
        || !isCurrentJobContext(currentJobContextRef, context)) return null;
    return jobsRef.current.find((item) => sameJobId(item.id, context.jobId)) || null;
  }

  const loadCandidates = useCallback(async (id) => {
    const context = currentJobContextRef.current;
    if (!sameJobId(id, context.jobId)) return false;
    const requestId = jobRequestRef.current.begin();
    setCandidateListState(candidatesRef.current.length ? 'refreshing' : 'loading');
    setCandidateListError('');
    setCandidateListErrorDetails('');
    setWorkbenchState('loading');
    setWorkbenchError('');
    const [candidateResult, workbenchResult] = await Promise.allSettled([
      api.listCandidates(id),
      api.getWorkbench(id),
    ]);
    if (!isCurrentJobContext(currentJobContextRef, context)
        || !jobRequestRef.current.isCurrent(requestId)) return false;

    let coreError = null;
    if (candidateResult.status === 'fulfilled') {
      const nextCandidates = Array.isArray(candidateResult.value?.candidates) ? candidateResult.value.candidates : [];
      candidatesRef.current = nextCandidates;
      setCandidates(nextCandidates);
      setCandidateListState(nextCandidates.length ? 'ready' : 'empty');
    } else {
      const error = candidateResult.reason instanceof Error
        ? candidateResult.reason
        : new Error(String(candidateResult.reason || '候选人读取失败'));
      setCandidateListError(error.message);
      setCandidateListErrorDetails(typeof error.technicalDetails === 'string' ? error.technicalDetails : '');
      setCandidateListState(candidatesRef.current.length ? 'stale' : 'error');
      coreError = error;
    }

    if (workbenchResult.status === 'fulfilled') {
      const nextWorkbench = workbenchResult.value?.workbench || null;
      workbenchRef.current = nextWorkbench;
      setWorkbench(nextWorkbench);
      setWorkbenchState(nextWorkbench ? 'ready' : 'empty');
    } else {
      const error = workbenchResult.reason instanceof Error
        ? workbenchResult.reason
        : new Error(String(workbenchResult.reason || '工作台读取失败'));
      setWorkbenchError(error.message);
      setWorkbenchState(workbenchRef.current ? 'stale' : 'error');
      coreError = coreError || error;
    }

    if (coreError) throw coreError;
    return true;
  }, []);

  const boot = useCallback(async (retries = 3) => {
    const bootToken = currentJobContextRef.current.token;
    const jobsRequestId = jobsRequestRef.current.begin();
    setJobsState('loading');
    setJobsError('');
    let jobResponse = null;
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        jobResponse = await api.listJobs();
        break;
      } catch (err) {
        lastError = err;
        if (attempt < retries) await sleep(1000);
      }
    }
    if (currentJobContextRef.current.token !== bootToken
        || !jobsRequestRef.current.isCurrent(jobsRequestId)) return false;
    if (!jobResponse) {
      // Blocking read failures live on the inline jobs error surfaces only;
      // a toast would repeat the same error on a second channel.
      setJobsError(lastError?.message || '岗位读取失败');
      setJobsState('error');
      return false;
    }

    const js = Array.isArray(jobResponse.jobs) ? jobResponse.jobs : [];
    setJobs(js);
    setJobsState(js.length ? 'ready' : 'empty');
    const next = pickPreferredJob(js, readStoredJobId());
    if (!next) {
      clearJobContext();
      return true;
    }
    beginJobContext(next.id);
    try {
      await loadCandidates(next.id);
    } catch {
      // loadCandidates has already surfaced the failure inline on the
      // candidate list and workbench surfaces.
    }
    return true;
  }, [loadCandidates]);

  useEffect(() => {
    boot();
  }, [boot]);

  const confirmDiscardUnsavedChanges = useCallback((options = {}) => {
    const includeJobEditor = options.includeJobEditor !== false;
    const includeCandidateWorkspace = options.includeCandidateWorkspace !== false;
    const jobDraftActive = includeJobEditor
      && jobEditorDirty
      && activeNav === '职位管理'
      && jobManagementView === 'editor';
    const candidateDraftActive = includeCandidateWorkspace
      && candidateWorkspaceDirtyRef.current
      && activeNav === '候选人';
    const candidateWriteActive = includeCandidateWorkspace
      && candidateWorkspaceBusyRef.current
      && activeNav === '候选人';
    if (candidateWriteActive) {
      message.warning('候选人工作区正在保存，请等待完成后再切换候选人、模块或岗位。');
      return Promise.resolve(false);
    }
    if (!jobDraftActive && !candidateDraftActive) return Promise.resolve(true);
    if (discardConfirmationRef.current) return discardConfirmationRef.current;

    const scopeLabel = jobDraftActive && candidateDraftActive
      ? '职位与候选人工作区'
      : jobDraftActive
        ? 'JD 或岗位画像'
        : '候选人工作区';
    const confirmation = new Promise((resolve) => {
      const finish = (confirmed) => {
        discardConfirmationRef.current = null;
        if (confirmed) {
          if (jobDraftActive) setJobEditorDirty(false);
          if (candidateDraftActive) {
            candidateWorkspaceDirtyRef.current = false;
            setCandidateWorkspaceDirty(false);
          }
        }
        resolve(confirmed);
      };
      modal.confirm({
        title: `${scopeLabel}还有未保存草稿`,
        content: '继续后，当前未保存内容将丢失；已保存记录不受影响。取消会保留当前候选人、分区和草稿。',
        okText: '放弃草稿并继续',
        okButtonProps: { danger: true },
        cancelText: '继续编辑',
        onOk: () => finish(true),
        onCancel: () => finish(false),
      });
    });
    discardConfirmationRef.current = confirmation;
    return confirmation;
  }, [activeNav, candidateWorkspaceDirty, jobEditorDirty, jobManagementView, message, modal]);

  const confirmDiscardSettingsChanges = useCallback(() => {
    if (activeNav !== '设置' || !settingsDirty) return Promise.resolve(true);
    if (settingsDiscardConfirmationRef.current) return settingsDiscardConfirmationRef.current;

    const confirmation = new Promise((resolve) => {
      const finish = (confirmed) => {
        settingsDiscardConfirmationRef.current = null;
        resolve(confirmed);
        if (!confirmed) {
          globalThis.requestAnimationFrame(() => utilityMenuTriggerRef.current?.focus());
        }
      };
      modal.confirm({
        className: 'settings-unsaved-switch-modal',
        title: '设置有未保存修改',
        content: '离开设置会丢失本页草稿；已保存的配置不会受影响。',
        okText: '放弃草稿并离开',
        okButtonProps: { danger: true },
        cancelText: '留在本页',
        onOk: () => finish(true),
        onCancel: () => finish(false),
      });
    });
    settingsDiscardConfirmationRef.current = confirmation;
    return confirmation;
  }, [activeNav, modal, settingsDirty]);

  function confirmDiscardJobEditorChanges() {
    return confirmDiscardUnsavedChanges({ includeCandidateWorkspace: false });
  }

  const handleJobEditorDirtyChange = useCallback((dirty) => {
    setJobEditorDirty(dirty === true);
  }, []);

  const handleCandidateWorkspaceDirtyChange = useCallback((dirty) => {
    candidateWorkspaceDirtyRef.current = dirty === true;
    setCandidateWorkspaceDirty(dirty === true);
  }, []);

  const handleCandidateWorkspaceBusyChange = useCallback((busy) => {
    candidateWorkspaceBusyRef.current = busy === true;
    setCandidateWorkspaceBusy(busy === true);
  }, []);

  async function handleJobChange(id) {
    if (!sameJobId(id, currentJobContextRef.current.jobId)) {
      const canLeave = await confirmDiscardUnsavedChanges();
      if (!canLeave) return false;
      setJobEditorDirty(false);
      candidateWorkspaceDirtyRef.current = false;
      setCandidateWorkspaceDirty(false);
    }
    const context = beginJobContext(id);
    // loadCandidates surfaces its failure inline on the candidate list and
    // workbench surfaces; the same blocking error gets no second channel.
    const loaded = await loadCandidates(id).catch(() => false);
    return loaded && isCurrentJobContext(currentJobContextRef, context);
  }

  async function handleOpenTalentCandidate(candidateId, candidateJobId) {
    if (!candidateId) return;
    try {
      const resetCandidateWorkspace = activeNav === '候选人' && candidateWorkspaceDirtyRef.current;
      const canNavigate = await confirmDiscardUnsavedChanges();
      if (!canNavigate) return;
      if (resetCandidateWorkspace) setCandidateWorkspaceRevision((value) => value + 1);
      if (candidateJobId && !sameJobId(candidateJobId, currentJobContextRef.current.jobId)) {
        await handleJobChange(candidateJobId);
      }
      const context = currentJobContextRef.current;
      if (candidateJobId && !sameJobId(candidateJobId, context.jobId)) return;
      setActiveNav('候选人');
      await handleSelectCandidate(candidateId, context, { initialDomain: 'profile' });
    } catch (err) {
      message.error(`打开候选人失败：${err.message}`);
    }
  }

  async function handleOpenInterviewScheduleCandidate(candidateId, domain = 'profile') {
    if (!candidateId) return;
    const resetCandidateWorkspace = activeNav === '候选人' && candidateWorkspaceDirtyRef.current;
    const canNavigate = await confirmDiscardUnsavedChanges();
    if (!canNavigate) return;
    if (resetCandidateWorkspace) setCandidateWorkspaceRevision((value) => value + 1);
    const context = currentJobContextRef.current;
    setActiveNav('候选人');
    await handleSelectCandidate(candidateId, context, { initialDomain: domain || 'profile' });
  }

  const clearCandidateSelection = useCallback(() => {
    currentCandidateContextRef.current = {
      jobId: currentJobContextRef.current.jobId,
      candidateId: null,
      token: currentCandidateContextRef.current.token + 1,
    };
    detailRequestRef.current.invalidate();
    setSelectedId(null);
    detailRef.current = null;
    setDetail(null);
    setDetailState('idle');
    setDetailError('');
    setDetailInitialDomain('profile');
    setDetailInterviewNavigation((current) => ({ tab: 'review', target: null, requestKey: current.requestKey + 1 }));
    candidateWorkspaceDirtyRef.current = false;
    setCandidateWorkspaceDirty(false);
    candidateWorkspaceBusyRef.current = false;
    setCandidateWorkspaceBusy(false);
  }, []);

  const handleCandidateSelectionInvalidated = useCallback(async () => {
    const canLeave = await confirmDiscardUnsavedChanges({ includeJobEditor: false });
    if (!canLeave) return false;
    clearCandidateSelection();
    return true;
  }, [clearCandidateSelection, confirmDiscardUnsavedChanges]);

  async function loadCandidateDetail(candidateContext) {
    if (!isCurrentCandidateContext(currentCandidateContextRef, candidateContext)) return false;
    const requestId = detailRequestRef.current.begin();
    const previousDetail = detailRef.current
      && sameCandidateId(detailRef.current.candidate?.internal_id, candidateContext.candidateId)
      && (detailRef.current.candidate?.job_id == null
        || sameJobId(detailRef.current.candidate.job_id, candidateContext.jobId))
      ? detailRef.current
      : null;
    setDetailState(previousDetail ? 'refreshing' : 'loading');
    setDetailError('');
    const [candidateResult, childrenResult, actionsResult, timelineResult] = await Promise.allSettled([
      api.getCandidate(candidateContext.candidateId),
      api.getChildren(candidateContext.candidateId),
      api.getWriteActions(candidateContext.candidateId),
      api.getCandidateTimeline(candidateContext.candidateId),
    ]);
    if (!isCurrentCandidateContext(currentCandidateContextRef, candidateContext)
        || !detailRequestRef.current.isCurrent(requestId)) return false;

    const resultError = (result, fallback) => (
      result.status === 'rejected'
        ? (result.reason?.message || String(result.reason || fallback))
        : fallback
    );
    const candidate = candidateResult.status === 'fulfilled' ? candidateResult.value?.candidate : null;
    const candidateInvalid = !candidate
      || !sameCandidateId(candidate.internal_id, candidateContext.candidateId)
      || (candidate.job_id != null && !sameJobId(candidate.job_id, candidateContext.jobId));
    if (candidateResult.status === 'rejected' || candidateInvalid) {
      const errorMessage = candidateResult.status === 'rejected'
        ? resultError(candidateResult, '候选人核心资料读取失败')
        : '候选人核心资料与当前岗位上下文不一致';
      // The stale/error alerts in the detail pane carry this failure inline;
      // toasting it as well would put the same blocking error on two channels.
      setDetailState(previousDetail ? 'stale' : 'error');
      setDetailError(errorMessage);
      return false;
    }

    const resourceErrors = {};
    let children = previousDetail?.children || normalizeCandidateChildren();
    if (childrenResult.status === 'fulfilled' && childrenResult.value?.children) {
      children = normalizeCandidateChildren(childrenResult.value.children);
    } else {
      resourceErrors.children = resultError(childrenResult, '候选人材料未返回');
    }
    let nextActions = previousDetail?.actions || [];
    if (actionsResult.status === 'fulfilled' && Array.isArray(actionsResult.value?.actions)) {
      nextActions = actionsResult.value.actions;
    } else {
      resourceErrors.actions = resultError(actionsResult, '自动动作记录未返回');
    }
    let nextTimeline = previousDetail?.timeline || null;
    if (timelineResult.status === 'fulfilled' && timelineResult.value?.timeline) {
      nextTimeline = timelineResult.value.timeline;
    } else {
      resourceErrors.timeline = resultError(timelineResult, '统一时间线未返回');
    }

    const nextDetail = {
      candidate,
      children,
      actions: nextActions,
      timeline: nextTimeline,
      resourceErrors,
    };
    detailRef.current = nextDetail;
    setDetail(nextDetail);
    const partial = Object.keys(resourceErrors).length > 0;
    setDetailState(partial ? 'partial' : 'ready');
    setDetailError(partial ? Object.values(resourceErrors).join('；') : '');
    return true;
  }

  async function handleSelectCandidate(id, expectedContext = currentJobContextRef.current, options = {}) {
    if (!isCurrentJobContext(currentJobContextRef, expectedContext)) return false;
    const { initialDomain = 'profile', initialInterviewTab = 'review', initialInterviewTarget = null } = options;
    const changesCandidate = !sameCandidateId(id, currentCandidateContextRef.current.candidateId);
    const resetSameCandidateWorkspace = !changesCandidate && candidateWorkspaceDirtyRef.current;
    if (changesCandidate || candidateWorkspaceDirtyRef.current) {
      const canLeave = await confirmDiscardUnsavedChanges({ includeJobEditor: false });
      if (!canLeave || !isCurrentJobContext(currentJobContextRef, expectedContext)) return false;
      candidateWorkspaceDirtyRef.current = false;
      setCandidateWorkspaceDirty(false);
      if (resetSameCandidateWorkspace) setCandidateWorkspaceRevision((value) => value + 1);
    }
    const candidateContext = {
      jobId: expectedContext.jobId,
      candidateId: id,
      token: currentCandidateContextRef.current.token + 1,
    };
    currentCandidateContextRef.current = candidateContext;
    detailRequestRef.current.invalidate();
    setDetailInitialDomain(initialDomain);
    setDetailInterviewNavigation((current) => ({
      tab: initialInterviewTab,
      target: initialInterviewTarget,
      requestKey: current.requestKey + 1,
    }));
    setSelectedId(id);
    setAssessBusy(false);
    if (!sameCandidateId(detailRef.current?.candidate?.internal_id, id)) {
      detailRef.current = null;
      setDetail(null);
    }
    return loadCandidateDetail(candidateContext);
  }

  async function refreshCandidateDetail(candidateContext) {
    return loadCandidateDetail(candidateContext);
  }

  async function handleAssessmentChanged(_candidateId, candidateJobId) {
    // AssessmentArchivePanel refreshes its own content. Only refresh the left list
    // here so the selected candidate, assessment tab and scroll position stay put.
    const context = currentJobContextRef.current;
    if (candidateJobId && sameJobId(candidateJobId, context.jobId)) await loadCandidates(candidateJobId);
  }

  async function handleCandidateWorkflowChanged(candidateId, candidateJobId) {
    const context = currentJobContextRef.current;
    if (candidateJobId && !sameJobId(candidateJobId, context.jobId)) return;
    const candidateContext = { ...currentCandidateContextRef.current };
    const refreshes = [];
    if (isCurrentCandidateContext(currentCandidateContextRef, candidateContext)
        && sameCandidateId(candidateId, candidateContext.candidateId)
        && sameJobId(candidateJobId, candidateContext.jobId)) {
      refreshes.push(refreshCandidateDetail(candidateContext));
    }
    if (candidateJobId) refreshes.push(loadCandidates(candidateJobId));
    const results = await Promise.all(refreshes);
    if (results.some((result) => result === false)) {
      throw new Error('部分候选人数据未能刷新，已保留最近一次成功内容。');
    }
  }

  async function handlePrepareCandidateFromResume() {
    const context = currentJobContextRef.current;
    if (!context.jobId) return;
    const currentJob = authoritativeJobForContext(context);
    if (!currentJob) {
      message.warning('当前岗位已不在最新岗位台账中，请重新选择岗位后再上传简历建档。');
      return;
    }
    if (currentJob?.status === 'closed') {
      message.warning('岗位已关闭，请重新开启后再上传简历建档。');
      return;
    }
    if (candidateAuthorityWriteBlocked) {
      message.warning('候选人数据尚未可靠读取，请先重试并等待恢复后再上传简历建档。');
      return;
    }
    setResumeIntakeBusy(true);
    try {
      const response = await api.prepareCandidateFromResume(context.jobId);
      if (!isCurrentJobContext(currentJobContextRef, context) || response.canceled) return;
      setResumeCandidateDraft(response.result);
    } catch (error) {
      if (isCurrentJobContext(currentJobContextRef, context)) message.error(`简历预处理失败：${error.message}`);
    } finally {
      if (isCurrentJobContext(currentJobContextRef, context)) setResumeIntakeBusy(false);
    }
  }

  async function handleCommitCandidateFromResume(fields) {
    const context = currentJobContextRef.current;
    const draft = resumeCandidateDraft;
    if (!draft || !isCurrentJobContext(currentJobContextRef, context)) return;
    const currentJob = authoritativeJobForContext(context);
    if (!currentJob || !sameJobId(draft.job_id, currentJob.id)) {
      message.warning('简历建档岗位上下文已失效，请重新选择岗位和简历。');
      setResumeCandidateDraft(null);
      return;
    }
    if (currentJob.status === 'closed') {
      message.warning('岗位已关闭，请重新开启后再确认简历建档。');
      return;
    }
    if (candidateAuthorityWriteBlocked) {
      message.warning('候选人数据尚未可靠读取，请先重试并等待恢复后再确认建档。');
      return;
    }
    let committed = false;
    setResumeIntakeBusy(true);
    try {
      const response = await api.commitCandidateFromResume({
        draft_id: draft.draft_id,
        job_id: context.jobId,
        ...fields,
      });
      committed = true;
      // The draft is single-use. Once the backend commit succeeds, never leave it
      // open in a state that invites HR to submit the same write again.
      setResumeCandidateDraft(null);
      if (!isCurrentJobContext(currentJobContextRef, context)) return;
      const listRefreshed = await loadCandidates(context.jobId);
      if (!isCurrentJobContext(currentJobContextRef, context)) return;
      if (!listRefreshed) {
        message.warning('简历建档已完成，但数据暂未刷新；请稍后使用“刷新本地数据”查看，勿重复提交。', 7);
        return;
      }
      const detailRefreshed = await handleSelectCandidate(
        response.result.candidate_id,
        context,
        { initialDomain: 'profile' },
      );
      if (isCurrentJobContext(currentJobContextRef, context)) {
        if (!detailRefreshed) {
          message.warning('简历建档已完成，但数据暂未刷新；请稍后使用“刷新本地数据”查看，勿重复提交。', 7);
          return;
        }
        if (response.result.duplicate && response.result.applied_correction_fields?.length) {
          message.success('同一岗位已存在这份简历；已打开原候选人并应用本次人工校对。');
        } else {
          message.success(response.result.duplicate ? '同一岗位已存在这份简历，已打开原候选人。' : '候选人已从本地简历建档。');
        }
      }
    } catch (error) {
      if (isCurrentJobContext(currentJobContextRef, context)) {
        if (committed) {
          message.warning(`简历建档已完成，但数据暂未刷新：${error.message}。请稍后刷新，勿重复提交。`, 7);
        } else {
          throw new Error(`简历建档失败：${error.message}`);
        }
      }
    } finally {
      if (isCurrentJobContext(currentJobContextRef, context)) setResumeIntakeBusy(false);
    }
  }

  function focusSettingsTarget(targetId) {
    if (!targetId) return;
    const focusTarget = () => {
      const target = document.getElementById(targetId);
      if (!(target instanceof HTMLElement)) return false;
      target.focus({ preventScroll: true });
      return true;
    };
    globalThis.requestAnimationFrame(focusTarget);
    globalThis.setTimeout(focusTarget, 120);
  }

  const handleSettingsSectionChange = useCallback((sectionId) => {
    if (CONFIGURABLE_SETTINGS_SECTIONS.has(sectionId)) {
      setActiveDesktopUtilityKey('settings-center');
    } else if (sectionId === 'settings-overview') {
      setActiveDesktopUtilityKey('settings-center');
    } else if (sectionId === 'settings-advanced') {
      setActiveDesktopUtilityKey('about');
    }
  }, []);

  async function handleOpenSettings(
    sectionId = 'settings-overview',
    returnNav = activeNav,
    focusTargetId = '',
    options = {},
  ) {
    const preserveSourceDraft = options.preserveSourceDraft === true;
    if (preserveSourceDraft && candidateWorkspaceBusyRef.current && activeNav === '候选人') {
      message.warning('候选人工作区正在保存，请等待完成后再打开设置。');
      return false;
    }
    if (!preserveSourceDraft) {
      const canLeave = await confirmDiscardUnsavedChanges();
      if (!canLeave) return false;
      setJobEditorDirty(false);
      candidateWorkspaceDirtyRef.current = false;
      setCandidateWorkspaceDirty(false);
    }
    const normalizedReturnNav = normalizeSettingsReturnNav(returnNav && returnNav !== '设置' ? returnNav : '工作台');
    setSettingsReturnNav(normalizedReturnNav);
    settingsHashWriteInProgressRef.current = true;
    try {
      replaceSettingsRoute(sectionId, normalizedReturnNav);
      window.dispatchEvent(new Event('hashchange'));
    } catch {
      window.location.hash = sectionId;
    } finally {
      settingsHashWriteInProgressRef.current = false;
    }
    handleSettingsSectionChange(sectionId);
    setActiveNav('设置');
    focusSettingsTarget(focusTargetId || `${sectionId}-title`);
    return true;
  }

  async function handleOpenAiSettings(intent = {}) {
    const sourceReturnNav = normalizeSettingsReturnNav(
      intent.returnNav || (activeNav === '设置' ? settingsReturnNav : activeNav),
    );
    const nextIntent = {
      ...intent,
      id: intent.id || `ai-intent:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      returnNav: sourceReturnNav,
      targetId: intent.targetId == null ? '' : String(intent.targetId),
    };
    const opened = await handleOpenSettings(
      'settings-integrations',
      sourceReturnNav,
      'settings-external-ai-title',
      {
        preserveSourceDraft: Boolean(intent.draftSnapshot)
          || (!jobEditorDirty && !candidateWorkspaceDirtyRef.current),
      },
    );
    if (opened) setAiSettingsReturnContext(nextIntent);
    return opened;
  }

  async function handleReturnToAiOperation(options = {}) {
    const intent = aiSettingsReturnContext;
    if (!intent) return handleOpenNav('工作台');
    const destination = normalizeSettingsReturnNav(intent.returnNav);
    const resumeAction = options.resumeAction === undefined
      ? intent.resumeAction !== false
      : options.resumeAction === true;
    setAiResumeIntent({ ...intent, resumeAction, resumedAt: Date.now() });
    setAiSettingsReturnContext(null);
    const opened = await handleOpenNav(destination);
    if (!opened) {
      setAiResumeIntent(null);
      setAiSettingsReturnContext(intent);
      return false;
    }
    if (intent.capability === 'job_jd') setJobManagementView('editor');
    if (intent.capability === 'candidate_assessment') setDetailInitialDomain('profile');
    if (intent.capability === 'assessment_analysis') setDetailInitialDomain('assessment');
    if (intent.capability === 'interview_review') {
      setDetailInitialDomain('interview');
      setDetailInterviewNavigation((current) => ({
        tab: 'review',
        target: null,
        requestKey: current.requestKey + 1,
      }));
    }
    if (intent.capability === 'deep_profile') {
      globalThis.setTimeout(() => setDeepOpen(true), 0);
    }
    focusSettingsTarget(intent.focusTargetId);
    return true;
  }

  function handleAiResumeConsumed(intentId) {
    setAiResumeIntent((current) => (current?.id === intentId ? null : current));
  }

  async function handleOpenDesktopUtility(key) {
    const descriptor = DESKTOP_UTILITY_MENU_ITEMS.find((item) => item.key === key);
    if (!descriptor) return false;
    if (descriptor.navigation) {
      const canLeaveSettings = await confirmDiscardSettingsChanges();
      if (!canLeaveSettings) return false;
      return handleOpenNav(descriptor.navigation);
    }
    const sectionId = descriptor.key === 'settings-center'
      ? 'settings-overview'
      : descriptor.sectionId;
    const returnNav = activeNav === '设置' ? settingsReturnNav : activeNav;
    const opened = await handleOpenSettings(
      sectionId,
      returnNav,
      descriptor.focusTargetId || `${sectionId}-title`,
    );
    if (opened) setActiveDesktopUtilityKey(descriptor.key);
    return opened;
  }

  function handleOpenUtilityNav(item) {
    const settingsSection = SETTINGS_UTILITY_SECTIONS[item];
    if (!settingsSection) return handleOpenNav(item);
    const returnNav = activeNav === '设置' ? settingsReturnNav : activeNav;
    return handleOpenSettings(settingsSection, returnNav);
  }

  async function handleOpenNav(nav) {
    const leavesJobEditor = activeNav === '职位管理' && jobManagementView === 'editor';
    const leavesCandidateWorkspace = activeNav === '候选人' && nav !== '候选人';
    const returnsToJobEditorFromSettings = activeNav === '设置'
      && settingsReturnNav === '职位管理'
      && nav === '职位管理'
      && jobManagementView === 'editor';
    if (leavesJobEditor || leavesCandidateWorkspace) {
      const canLeave = await confirmDiscardUnsavedChanges();
      if (!canLeave) return false;
      setJobEditorDirty(false);
      candidateWorkspaceDirtyRef.current = false;
      setCandidateWorkspaceDirty(false);
    }
    setWorkbenchNavigationTarget(null);
    if (nav === '职位管理' && !returnsToJobEditorFromSettings) setJobManagementView('ledger');
    if (activeNav === '设置' && nav !== '设置') {
      clearSettingsRoute();
      setAiSettingsReturnContext(null);
    }
    setActiveNav(nav);
    return true;
  }

  useEffect(() => {
    const syncExternalSettingsHash = () => {
      const sectionId = readSettingsSectionFromHash();
      if (!sectionId || settingsHashWriteInProgressRef.current || activeNav === '设置') return;
      void handleOpenSettings(sectionId, activeNav).then((opened) => {
        if (!opened && readSettingsSectionFromHash() === sectionId) clearSettingsRoute();
      });
    };
    window.addEventListener('hashchange', syncExternalSettingsHash);
    return () => window.removeEventListener('hashchange', syncExternalSettingsHash);
  }, [activeNav, confirmDiscardUnsavedChanges, handleSettingsSectionChange]);

  async function handleReturnJobLedger() {
    const canLeave = await confirmDiscardJobEditorChanges();
    if (!canLeave) return false;
    setJobEditorDirty(false);
    setJobManagementView('ledger');
    return true;
  }

  async function handleOpenCandidateTaskTodo(item) {
    const action = item?.action || {};
    const actionType = String(action.type || '').trim();
    const targetId = action.target_id;
    const reportTask = [
      'report_draft_required',
      'report_fact_review_required',
      'report_confirmation_required',
    ].includes(String(item?.code || '').trim());
    if (!reportTask || !['open_session', 'open_report'].includes(actionType) || targetId == null) {
      return handleOpenWorkbenchTodo(item, '候选人');
    }

    const context = { ...currentJobContextRef.current };
    if (item?.job_id != null && !sameJobId(item.job_id, context.jobId)) {
      return handleOpenWorkbenchTodo(item, '候选人');
    }
    const candidateId = item?.candidate_id || currentCandidateContextRef.current.candidateId;
    if (!candidateId) return handleOpenWorkbenchTodo(item, '候选人');
    const opened = await handleSelectCandidate(candidateId, context, {
      initialDomain: 'interview',
      initialInterviewTab: 'review',
      initialInterviewTarget: {
        type: actionType === 'open_report' ? 'report' : 'session',
        targetId,
      },
    });
    if (!opened
        && isCurrentJobContext(currentJobContextRef, context)
        && sameCandidateId(currentCandidateContextRef.current.candidateId, candidateId)) {
      message.warning('未能刷新目标面试记录；已保留最近一次成功内容或当前错误恢复入口。');
    }
    return opened;
  }

  async function handleOpenWorkbenchTodo(item, fallbackNav = '候选人') {
    const action = item?.action || {};
    const actionType = String(action.type || '').trim();
    const targetId = action.target_id;
    const hasTarget = targetId !== null && targetId !== undefined && String(targetId).trim() !== '';
    const context = { ...currentJobContextRef.current };
    const itemJobId = item?.job_id;
    const resetCandidateWorkspace = activeNav === '候选人' && candidateWorkspaceDirtyRef.current;
    const canNavigate = await confirmDiscardUnsavedChanges();
    if (!canNavigate) return;
    if (resetCandidateWorkspace) setCandidateWorkspaceRevision((value) => value + 1);
    const openFallback = (notice) => {
      handleOpenNav(fallbackNav);
      if (notice) message.info(notice);
    };

    if (itemJobId != null && !sameJobId(itemJobId, context.jobId)) {
      openFallback('岗位已切换，旧待办目标未继续定位；已打开当前岗位的对应模块。');
      return;
    }

    if (actionType === 'open_job_jd' || actionType === 'open_job_profile') {
      if (!hasTarget || !sameJobId(targetId, context.jobId)) {
        openFallback('待办中的岗位目标已失效，已打开岗位台账。');
        return;
      }
      jobManagementReturnFocusRef.current = null;
      setJobManagementView('editor');
      setActiveNav('职位管理');
      return;
    }

    const candidateDomains = {
      open_candidate: { domain: 'profile', interviewTab: 'review' },
      open_candidate_interview: { domain: 'interview', interviewTab: 'prepare' },
      open_candidate_assessment: { domain: 'assessment', interviewTab: 'review' },
      open_candidate_final_review: { domain: 'final-review', interviewTab: 'review' },
      open_candidate_flow: { domain: 'flow', interviewTab: 'review' },
    };
    if (Object.prototype.hasOwnProperty.call(candidateDomains, actionType)) {
      if (!hasTarget) {
        openFallback('待办没有可定位的候选人，已打开候选人模块。');
        return;
      }
      const candidateTarget = candidateDomains[actionType];
      setActiveNav('候选人');
      const opened = await handleSelectCandidate(targetId, context, {
        initialDomain: candidateTarget.domain,
        initialInterviewTab: candidateTarget.interviewTab,
      });
      if (!opened
          && isCurrentJobContext(currentJobContextRef, context)
          && sameCandidateId(currentCandidateContextRef.current.candidateId, targetId)) {
        message.warning('未能刷新该候选人；已保留最近一次成功详情或当前错误恢复入口。');
      }
      return;
    }

    if (actionType === 'open_session' || actionType === 'open_report') {
      if (!hasTarget) {
        openFallback('待办没有可定位的面试记录，已打开面试安排模块。');
        return;
      }
      setWorkbenchNavigationTarget({
        key: `${context.token}:${actionType}:${String(targetId)}:${Date.now()}`,
        jobId: context.jobId,
        type: actionType === 'open_report' ? 'report' : 'session',
        targetId,
      });
      setActiveNav('面试安排');
      return;
    }

    if (actionType === 'open_interview_assignment') {
      openFallback('当前面试材料待办没有稳定的对象锚点，已打开面试安排模块。');
      return;
    }
    if (actionType === 'retry_task') {
      openFallback('当前失败任务没有独立详情锚点，已打开对应模块供人工检查。');
      return;
    }
    openFallback(actionType ? '该待办目标暂时无法定位，已打开对应模块。' : '该待办未提供定位目标，已打开对应模块。');
  }

  function handleWorkbenchNavigationConsumed(key) {
    setWorkbenchNavigationTarget((current) => (current?.key === key ? null : current));
  }

  async function handleOpenManagedJob(id) {
    const opened = await handleJobChange(id);
    if (!opened) throw new Error('岗位上下文未能完成切换，请重试。');
    setJobManagementView('editor');
  }

  async function handleOpenManagedJobWithFocus(id, focusDescriptor) {
    const returnFocusDescriptor = focusDescriptor
      ? {
        jobId: String(focusDescriptor.jobId || id),
        action: focusDescriptor.action === 'name' ? 'name' : 'manage',
      }
      : null;
    jobManagementReturnFocusRef.current = returnFocusDescriptor;
    try {
      return await handleOpenManagedJob(id);
    } catch (error) {
      if (jobManagementReturnFocusRef.current === returnFocusDescriptor) {
        jobManagementReturnFocusRef.current = null;
      }
      throw error;
    }
  }

  async function handleJobsChanged(preferredId) {
    const applied = await refreshJobs(preferredId || currentJobContextRef.current.jobId);
    if (!applied) throw new Error('岗位台账刷新失败，请重试。');
    return true;
  }

  useEffect(() => {
    writeStoredBoolean(APP_NAV_COLLAPSED_STORAGE_KEY, appNavCollapsed);
  }, [appNavCollapsed]);

  useEffect(() => {
    const focusTarget = appNavFocusHandoffRef.current;
    if (!focusTarget) return undefined;
    appNavFocusHandoffRef.current = '';
    let timer = 0;
    let attempts = 0;
    const focusReplacementControl = () => {
      const target = focusTarget === 'restore'
        ? appNavRestoreButtonRef.current
        : appNavCollapseButtonRef.current;
      if (target?.isConnected && typeof target.focus === 'function') {
        target.focus();
        return;
      }
      attempts += 1;
      if (attempts < 8) timer = globalThis.setTimeout(focusReplacementControl, 16);
    };
    timer = globalThis.setTimeout(focusReplacementControl, 0);
    return () => globalThis.clearTimeout(timer);
  }, [appNavCollapsed]);

  function setAppNavCollapsedWithFocus(collapsed) {
    if (collapsed) setUtilityMenuOpen(false);
    appNavFocusHandoffRef.current = collapsed ? 'restore' : 'collapse';
    setAppNavCollapsed(collapsed);
  }

  useEffect(() => {
    writeStoredBoolean(CANDIDATE_LIST_COLLAPSED_STORAGE_KEY, candidateListCollapsed);
  }, [candidateListCollapsed]);

  useEffect(() => {
    const focusTarget = candidateListFocusHandoffRef.current;
    if (!focusTarget) return undefined;
    candidateListFocusHandoffRef.current = '';
    let timer = 0;
    let attempts = 0;
    const focusReplacementControl = () => {
      const target = focusTarget === 'restore'
        ? candidateListRestoreButtonRef.current
        : candidateListCollapseButtonRef.current;
      if (target?.isConnected && typeof target.focus === 'function') {
        target.focus();
        return;
      }
      attempts += 1;
      if (attempts < 8) timer = globalThis.setTimeout(focusReplacementControl, 16);
    };
    timer = globalThis.setTimeout(focusReplacementControl, 0);
    return () => globalThis.clearTimeout(timer);
  }, [candidateListCollapsed]);

  function setCandidateListCollapsedWithFocus(collapsed) {
    candidateListFocusHandoffRef.current = collapsed ? 'restore' : 'collapse';
    setCandidateListCollapsed(collapsed);
  }

  function handleCandidateListToggleKeyDown(event, collapsed) {
    if (!['Enter', ' ', 'Spacebar'].includes(event.key)) return;
    event.preventDefault();
    setCandidateListCollapsedWithFocus(collapsed);
  }

  function focusCandidateChooser() {
    if (candidateListCollapsed) setCandidateListCollapsed(false);
    let attempts = 0;
    const focusChooser = () => {
      const panel = document.getElementById(CANDIDATE_LIST_PANEL_ID);
      const target = panel?.querySelector('[role="option"][tabindex="0"], [role="option"], input[aria-label="搜索候选人"]');
      if (target instanceof HTMLElement) {
        target.focus({ preventScroll: false });
        target.scrollIntoView({ block: 'nearest' });
        return;
      }
      attempts += 1;
      if (attempts < 8) globalThis.setTimeout(focusChooser, 16);
    };
    globalThis.setTimeout(focusChooser, 0);
  }

  async function handleAssess(mode = 'real') {
    if (!detail) return;
    const context = { ...currentCandidateContextRef.current };
    const candidateId = detail.candidate.internal_id;
    if (!isCurrentCandidateContext(currentCandidateContextRef, context)
        || !sameCandidateId(candidateId, context.candidateId)) return;
    const currentJob = authoritativeJobForContext(currentJobContextRef.current);
    if (!currentJob || !sameJobId(currentJob.id, context.jobId)) {
      message.warning('当前岗位上下文已失效，请重新选择岗位后再生成候选人报告。');
      return;
    }
    if (READONLY_UI || currentJob.status === 'closed') {
      message.warning(READONLY_UI
        ? '当前为操作只读模式，不能生成候选人报告。'
        : '岗位已关闭，请重新开启后再生成候选人报告。');
      return;
    }
    let committed = false;
    setAssessBusy(true);
    try {
      if (mode === 'local-demo') {
        await api.assessLocalDemo(candidateId);
        committed = true;
      }
      else {
        const requestId = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : `candidate-assessment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const approval = await api.confirmExternalAiApproval('candidate-assessment', candidateId, requestId, { candidateId });
        if (!isCurrentCandidateContext(currentCandidateContextRef, context)) return;
        if (!approval.approved) return;
        await api.assess(candidateId, {
          requestId,
          userApproval: approval.userApproval,
        });
        committed = true;
      }
      if (!isCurrentCandidateContext(currentCandidateContextRef, context)) return;
      const refreshed = await refreshCandidateDetail(context);
      if (!isCurrentCandidateContext(currentCandidateContextRef, context)) return;
      if (!refreshed) {
        message.warning(`${mode === 'local-demo' ? '本地样本报告' : '匹配报告'}已生成，但数据暂未刷新；请稍后使用“刷新本地数据”查看，勿重复生成。`, 7);
        return;
      }
      message.success(mode === 'local-demo' ? '本地样本报告已生成' : '匹配报告已生成');
    } catch (err) {
      if (isCurrentCandidateContext(currentCandidateContextRef, context)) {
        if (committed) {
          message.warning(`匹配报告已生成，但数据暂未刷新：${err.message}。请稍后刷新，勿重复生成。`, 7);
        } else {
          message.error(`评估失败：${err.message}`);
        }
      }
    } finally {
      if (isCurrentCandidateContext(currentCandidateContextRef, context)) setAssessBusy(false);
    }
  }

  async function handleRunRate() {
    const context = currentJobContextRef.current;
    if (!context.jobId) return;
    const currentJob = authoritativeJobForContext(context);
    if (!currentJob || READONLY_UI || currentJob.status === 'closed') {
      message.warning(!currentJob
        ? '当前岗位已不在最新岗位台账中，请重新选择岗位后再运行规则评级。'
        : READONLY_UI
          ? '当前为操作只读模式，不能启动规则评级。'
          : '岗位已关闭，请重新开启后再运行规则评级。');
      return;
    }
    if (candidateAuthorityWriteBlocked) {
      message.warning('候选人数据尚未可靠读取，请先重试并等待恢复后再运行规则评级。');
      return;
    }
    setRateBusy(true);
    setRateLabel('正在启动评级…');
    try {
      try {
        await api.startRate(context.jobId);
      } catch (err) {
        if (!/评级中/.test(err.message)) throw err;
      }
      if (!isCurrentJobContext(currentJobContextRef, context)) return;
      await pollRate(context);
    } catch (err) {
      if (isCurrentJobContext(currentJobContextRef, context)) {
        message.error(`评级失败：${err.message}`);
        setRateBusy(false);
        setRateLabel('重新评级');
      }
    }
  }

  async function pollRate(context) {
    const id = context.jobId;
    const deadline = Date.now() + 10 * 60 * 1000;
    let consecutiveErrors = 0;
    while (Date.now() < deadline) {
      if (!isCurrentJobContext(currentJobContextRef, context)) return false;
      let p;
      try {
        p = await api.rateProgress(id);
        if (!isCurrentJobContext(currentJobContextRef, context)) return false;
        consecutiveErrors = 0;
      } catch (error) {
        if (!isCurrentJobContext(currentJobContextRef, context)) return false;
        consecutiveErrors += 1;
        if (consecutiveErrors >= 5) throw new Error(`连续无法读取评级状态：${error.message}`);
        await sleep(2000);
        continue;
      }
      if (p.status === 'running') {
        setRateLabel(`规则评级中… 已评 ${p.done}/${p.total == null ? '?' : p.total}`);
        await sleep(2000);
        continue;
      }
      if (p.status === 'done') {
        const s = p.summary;
        await loadCandidates(id);
        if (!isCurrentJobContext(currentJobContextRef, context)) return false;
        const pend = s.pending ? `；${s.pending} 人待确认（缺规则口径或关键信息）` : '';
        message.success(`规则评级 ${s.rated} 人：S ${s.byTier.S || 0} / A ${s.byTier.A || 0} / B ${s.byTier.B || 0} / C ${s.byTier.C || 0} / D ${s.byTier.D || 0}。跳过：${rateSkipText(s)}${pend}。`, 8);
        break;
      }
      if (p.status === 'error') {
        throw new Error(p.error || '未知错误');
      }
      throw new Error(`评级任务状态丢失或服务已重启（${p.status || 'unknown'}），请刷新数据后再试。`);
    }
    if (Date.now() >= deadline) throw new Error('规则评级等待超过 10 分钟，已停止轮询；请刷新后检查结果。');
    if (isCurrentJobContext(currentJobContextRef, context)) {
      setRateBusy(false);
      setRateLabel('重新评级');
    }
    return true;
  }

  async function handleRefreshLocal() {
    const context = currentJobContextRef.current;
    if (!context.jobId) return;
    const resetCandidateWorkspace = activeNav === '候选人' && candidateWorkspaceDirtyRef.current;
    const canRefresh = await confirmDiscardUnsavedChanges();
    if (!canRefresh || !isCurrentJobContext(currentJobContextRef, context)) return;
    if (resetCandidateWorkspace) setCandidateWorkspaceRevision((value) => value + 1);
    const candidateContext = { ...currentCandidateContextRef.current };
    setLocalRefreshBusy(true);
    try {
      const loaded = await loadCandidates(context.jobId);
      if (!loaded || !isCurrentJobContext(currentJobContextRef, context)) return;
      if (isCurrentCandidateContext(currentCandidateContextRef, candidateContext)) {
        await refreshCandidateDetail(candidateContext);
      }
      if (!isCurrentJobContext(currentJobContextRef, context)) return;
      message.success('本地数据已刷新');
    } catch (err) {
      if (isCurrentJobContext(currentJobContextRef, context)) message.error(`刷新失败：${err.message}`);
    } finally {
      if (isCurrentJobContext(currentJobContextRef, context)) setLocalRefreshBusy(false);
    }
  }


  // Shown before the folder picker, because every rule here is decided by what
  // the HR selects and can no longer be fixed afterwards. The order is by how
  // much damage each mistake does: a candidate whose first screenshot does not
  // show the name header gets silently merged into the previous candidate,
  // which looks like a successful import.
  function confirmScreenshotImportGuidance() {
    return new Promise((resolve) => {
      Modal.confirm({
        title: '导入前请确认这几点',
        className: 'screenshot-import-guide',
        width: 560,
        okText: '选择截图文件夹',
        cancelText: '取消',
        content: (
          <div>
            <p><strong>1. 每位候选人的第一张要能看到姓名</strong>（详情页顶部）。识别按文件名顺序逐张走，遇到带姓名的详情页就当作新的一位；某位的第一张若是往下滚的页面，这几张会被并到上一位名下。</p>
            <p><strong>2. 不要重命名打乱顺序。</strong>按文件名排序（数字按大小排），iPhone 默认的 IMG_0001、IMG_0002… 天然正确。</p>
            <p><strong>3. 选文件夹本身</strong>，只读这个文件夹下的图片，<strong>不含子文件夹</strong>；支持 PNG / JPG / JPEG / WebP。</p>
            <p><strong>4. 列表页可以一起放进来</strong>，会被自动识别并跳过，不会变成候选人。</p>
            <p><strong>5. 张数没有硬上限</strong>。Mac 本地 Vision 实测 76 张约 21 秒；Windows 外部 AI 的耗时和费用随模型、网络与张数变化，选图后会逐图预览并由你确认是否发送。一个批次开始后不能中途取消。</p>
            <p style={{ marginBottom: 0 }}>
              某位候选人缺了带姓名的首图时，可以把他的截图改名成 <code>张三-第1页.png</code>、<code>张三-第2页.png</code>
              （连续从 1 开始、最多 20 张），系统会按文件名把它们归成一组。
            </p>
          </div>
        ),
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }

  async function handleImportScreenshots() {
    if (READONLY_UI) {
      message.warning('当前为全局只读模式，不能选择或导入截图文件夹。');
      return;
    }
    if (screenshotImportBusyRef.current || isScreenshotImportTaskActive(screenshotImportTaskRef.current)) {
      setScreenshotImportTaskOpen(true);
      refreshScreenshotImportTask({ showLoading: true });
      message.info('已有截图识别任务正在运行，请在任务中心查看进度，完成前不能重复导入。');
      return;
    }
    const context = currentJobContextRef.current;
    const currentJob = authoritativeJobForContext(context);
    if (!currentJob || currentJob.status === 'closed') {
      message.warning(!currentJob
        ? '当前岗位已不在最新岗位台账中，请重新选择岗位后再导入候选人截图。'
        : '岗位已关闭，请重新开启后再导入候选人截图。');
      return;
    }
    if (candidateAuthorityWriteBlocked) {
      message.warning('候选人数据尚未可靠读取，请先重试并等待恢复后再导入候选人截图。');
      return;
    }
    screenshotImportBusyRef.current = true;
    setScreenshotImportBusy(true);
    try {
      if (!await confirmScreenshotImportGuidance()) {
        return;
      }
      // The guidance can stay open for as long as the HR reads it. Re-check the
      // job before spending their time on a folder picker whose result would
      // only be rejected afterwards.
      const jobAfterGuidance = authoritativeJobForContext(context);
      if (!jobAfterGuidance || jobAfterGuidance.status === 'closed') {
        message.warning('岗位上下文已变化，本次未打开文件夹选择；请重新选择岗位后再导入候选人截图。');
        return;
      }
      if (isScreenshotImportTaskActive(screenshotImportTaskRef.current)) {
        setScreenshotImportTaskOpen(true);
        message.info('等待导入指引期间已有截图任务启动，本次不再重复选择文件夹。');
        return;
      }
      let selected;
      if (window.screenshotImport && window.screenshotImport.selectDirectory) {
        selected = await window.screenshotImport.selectDirectory();
        if (!selected.ok) throw new Error(selected.error || '选择文件夹失败');
        if (selected.canceled) return;
      } else {
        const dir = window.prompt('请输入 Boss App 截图文件夹路径');
        selected = dir ? { ok: true, path: dir } : { ok: true, canceled: true };
        if (selected.canceled) return;
      }
      const latestJob = authoritativeJobForContext(context);
      if (!latestJob || latestJob.status === 'closed') {
        message.warning('岗位上下文已变化，本次截图选择未导入；请重新选择岗位后再试。');
        return;
      }
      if (isScreenshotImportTaskActive(screenshotImportTaskRef.current)) {
        setScreenshotImportTaskOpen(true);
        message.info('选择文件夹期间已有截图任务启动，本次未重复提交。');
        return;
      }
      const started = await api.importScreenshots(selected.path);
      if (started?.task) {
        const task = normalizeScreenshotImportTask(started.task);
        screenshotImportTaskRef.current = task;
        setScreenshotImportProgress(task);
      }
      await refreshScreenshotImportTask({ runId: started?.run_id || '', showLoading: false });
      setScreenshotImportTaskOpen(true);
      message.success('已开始截图识别，可在任务中心查看逐张进度。', 5);
    } catch (err) {
      message.error(`导入截图失败：${err.message}`);
    } finally {
      screenshotImportBusyRef.current = false;
      setScreenshotImportBusy(false);
    }
  }

  async function handleRetryScreenshotImportItems(itemIds) {
    const task = normalizeScreenshotImportTask(screenshotImportTaskRef.current);
    const safeItemIds = [...new Set((itemIds || []).map(String).filter(Boolean))];
    if (!task.task_id || !safeItemIds.length) return false;
    if (screenshotImportRetryBusyRef.current || isScreenshotImportTaskActive(task)) {
      message.info('截图任务仍在运行，请等待完成后再重试问题项。');
      return false;
    }
    screenshotImportRetryBusyRef.current = true;
    setScreenshotImportRetryBusy(true);
    setScreenshotImportTaskOpen(true);
    try {
      const approval = await api.approveScreenshotImportRetry(task.task_id, safeItemIds);
      if (!approval.approved) {
        message.info('已取消发送截图，本次未执行重试。');
        return false;
      }
      const result = await api.retryScreenshotImportItems(task.task_id, safeItemIds, {
        requestId: approval.requestId,
        userApproval: approval.userApproval,
      });
      if (result?.task) {
        const nextTask = normalizeScreenshotImportTask({ ...task, ...result.task });
        screenshotImportTaskRef.current = nextTask;
        setScreenshotImportProgress(nextTask);
      }
      await refreshScreenshotImportTask({ runId: task.task_id, showLoading: false });
      message.success(`已开始重试 ${safeItemIds.length} 张截图，可在任务中心继续查看进度。`);
      return true;
    } catch (error) {
      message.error(`截图重试失败：${error.message}`);
      return false;
    } finally {
      screenshotImportRetryBusyRef.current = false;
      setScreenshotImportRetryBusy(false);
    }
  }

  async function refreshScreenshotReviewJob(targetJobId) {
    const context = { ...currentJobContextRef.current };
    const jobsRequestId = jobsRequestRef.current.begin();
    jobsStateRef.current = 'loading';
    setJobsState('loading');
    setJobsError('');
    let nextJobs;
    try {
      const response = await api.listJobs();
      nextJobs = Array.isArray(response.jobs) ? response.jobs : [];
    } catch (error) {
      if (isUnchangedJobContext(currentJobContextRef, context)
          && jobsRequestRef.current.isCurrent(jobsRequestId)) {
        jobsStateRef.current = 'error';
        setJobsError(error.message || '岗位读取失败');
        setJobsState('error');
      }
      throw error;
    }
    if (!isUnchangedJobContext(currentJobContextRef, context)
        || !jobsRequestRef.current.isCurrent(jobsRequestId)) return null;
    const nextState = nextJobs.length ? 'ready' : 'empty';
    jobsRef.current = nextJobs;
    jobsStateRef.current = nextState;
    setJobs(nextJobs);
    setJobsState(nextState);
    return nextJobs.find((item) => sameJobId(item.id, targetJobId)) || null;
  }

  async function handleOpenScreenshotReviewFromTask() {
    const task = normalizeScreenshotImportTask(screenshotImportTaskRef.current);
    const targetJobId = task.result?.job_id;
    if (targetJobId && (jobsStateRef.current !== 'ready'
        || !jobsRef.current.some((item) => sameJobId(item.id, targetJobId)))) {
      try {
        const targetJob = await refreshScreenshotReviewJob(targetJobId);
        if (!targetJob) {
          message.warning('这批 OCR 草稿所属岗位不在最新岗位台账中，暂未打开校对窗口。');
          return;
        }
      } catch (error) {
        message.error(`刷新 OCR 草稿所属岗位失败：${error.message}`);
        return;
      }
    }
    if (targetJobId && !sameJobId(targetJobId, currentJobContextRef.current.jobId)) {
      const changed = await handleJobChange(targetJobId);
      if (!changed) {
        message.warning('未能切换到这批 OCR 草稿所属岗位，暂未打开校对窗口。');
        return;
      }
    }
    const currentJob = authoritativeJobForContext(currentJobContextRef.current);
    if (!currentJob || currentJob.status === 'closed') {
      message.warning('这批 OCR 草稿所属岗位不可写，暂不能进入人工确认。');
      return;
    }
    setScreenshotImportTaskOpen(false);
    setScreenshotReviewOpen(true);
  }

  async function refreshJobs(preferredId = currentJobContextRef.current.jobId, options = {}) {
    const context = currentJobContextRef.current;
    const jobsRequestId = jobsRequestRef.current.begin();
    setJobsState('loading');
    setJobsError('');
    let js;
    try {
      const response = await api.listJobs();
      js = Array.isArray(response.jobs) ? response.jobs : [];
    } catch (error) {
      if (isUnchangedJobContext(currentJobContextRef, context)
          && jobsRequestRef.current.isCurrent(jobsRequestId)) {
        setJobsError(error.message || '岗位读取失败');
        setJobsState('error');
      }
      throw error;
    }
    if (!isUnchangedJobContext(currentJobContextRef, context)
        || !jobsRequestRef.current.isCurrent(jobsRequestId)) return false;
    setJobs(js);
    setJobsState(js.length ? 'ready' : 'empty');
    const next = pickPreferredJob(js, preferredId, options);
    if (!next) {
      const clearedContext = clearJobContext();
      return isUnchangedJobContext(currentJobContextRef, clearedContext);
    }
    let appliedContext = context;
    if (!sameJobId(next.id, context.jobId)) appliedContext = beginJobContext(next.id);
    const loaded = await loadCandidates(next.id);
    if (!loaded) return false;
    return isCurrentJobContext(currentJobContextRef, appliedContext);
  }

  const screenshotImportDoneRef = useRef('');
  useEffect(() => {
    if (READONLY_UI) return undefined;
    let dead = false;
    async function pollScreenshotImportProgress() {
      const task = await refreshScreenshotImportTask({ showLoading: false });
      if (dead || !task) return;
      const finishedAt = progressDoneKey(task);
      const requestId = screenshotImportTaskRequestRef.current;
      const isCurrentCompletion = () => !dead && !screenshotImportBusyRef.current
        && requestId === screenshotImportTaskRequestRef.current
        && screenshotImportTaskRef.current?.task_id === task.task_id
        && screenshotImportTaskRef.current?.status === task.status
        && progressDoneKey(screenshotImportTaskRef.current) === finishedAt;
      const doneKey = finishedAt ? `${task.task_id || 'legacy'}:${task.status}:${finishedAt}` : '';
      if (!isCurrentCompletion() || !doneKey || doneKey === screenshotImportDoneRef.current || !isRecentProgress(task)) return;
      screenshotImportDoneRef.current = doneKey;
      const result = task.result || {};
      const context = currentJobContextRef.current;
      const targetJobId = result.job_id;
      const pendingCount = task.pending_review_state?.status === 'ready'
        ? task.pending_review_state.count : null;
      if (task.status === 'error') {
        setScreenshotImportTaskOpen(true);
        message.error(task.message || task.error || '截图导入失败，请在任务中心查看失败项。');
        return;
      }
      // Restored completion metadata is not a new intake event. A confirmed or
      // rejected batch with an empty live queue must not reopen on restart.
      if (pendingCount === 0 && !screenshotImportTaskNeedsAttention(task)) return;
      if (targetJobId && !sameJobId(targetJobId, context.jobId)) {
        setScreenshotImportTaskOpen(true);
        const targetName = result.job_name ? `“${result.job_name}”` : '其他岗位';
        const pendingText = Number.isFinite(pendingCount) ? `${pendingCount} 条待校对` : '待校对数量暂未读取成功';
        message.info(`${targetName}的截图任务已完成：${pendingText}。当前岗位未切换；可在截图任务中心进入对应校对。`, 7);
        return;
      }
      if (!context.jobId) {
        setScreenshotImportTaskOpen(true);
        message.info('截图识别任务已完成；请选择所属岗位后打开待校对草稿。');
        return;
      }
      const refreshed = await loadCandidates(context.jobId).catch(() => false);
      if (!isCurrentCompletion() || !isCurrentJobContext(currentJobContextRef, context)) return;
      if (!refreshed) {
        message.warning('OCR 草稿已暂存，但当前岗位数据暂未刷新；校对草稿仍可继续处理。', 7);
      } else if (!Number.isFinite(pendingCount)) {
        message.warning('OCR 草稿已暂存，但待校对数量暂未刷新；请打开校对窗口重试。', 7);
      } else if (pendingCount > 0) {
        message.success(`OCR 草稿已暂存：当前 ${pendingCount} 条待人工校对，尚未写入正式候选人。`, 7);
      }
      if (screenshotImportTaskNeedsAttention(task) || !Number.isFinite(pendingCount)) {
        setScreenshotImportTaskOpen(true);
      } else if (pendingCount > 0) {
        setScreenshotReviewOpen(true);
      }
    }
    pollScreenshotImportProgress();
    const timer = setInterval(pollScreenshotImportProgress, 2500);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [message, refreshScreenshotImportTask]);

  function handleBrandNameChange(nextName) {
    const normalized = normalizeBrandName(nextName);
    setBrandName(normalized);
    return {
      persisted: persistUiPreference(BRAND_NAME_STORAGE_KEY, normalized),
      value: normalized,
    };
  }

  function handleBrandMarkChange(nextMark) {
    const normalized = normalizeBrandMark(nextMark);
    setBrandMark(normalized);
    return {
      persisted: persistUiPreference(BRAND_MARK_STORAGE_KEY, normalized),
      value: normalized,
    };
  }

  const job = jobs.find((j) => String(j.id) === String(jobId));
  const jobClosed = job?.status === 'closed';
  const currentJobAuthoritative = jobsState === 'ready'
    && Boolean(job)
    && sameJobId(job.id, currentJobContextRef.current.jobId);
  const jobAuthorityWriteBlocked = !currentJobAuthoritative;
  const jobReadOnly = READONLY_UI || jobAuthorityWriteBlocked || jobClosed;
  const candidateCountsUnavailable = candidateListState === 'error' && candidates.length === 0;
  const listSummaryText = jobId
    ? `${jobReadOnly ? (jobClosed ? '岗位已关闭 · ' : '操作只读 · ') : ''}${job ? job.name : '岗位'} · ${candidateCountsUnavailable ? '—' : candidates.length} 人`
    : '';
  const focusCandidate = detail && detail.candidate ? detail.candidate : null;
  const focusCandidateName = focusCandidate ? (focusCandidate.name || '未命名候选人') : '未选择候选人';
  const focusCandidateJob = job?.name || focusCandidate?.job_name || focusCandidate?.rec_position || `岗位 ${jobId || '待选择'}`;
  const focusCandidateReference = candidateStableReference(focusCandidate);
  const currentJobIsFixture = job?.is_fixture === true;
  const candidateActionItems = [
    {
      key: 'import-screenshots',
      label: screenshotImportActionBlocked ? '截图识别中…' : '导入 Boss App 截图',
      disabled: jobReadOnly || candidateAuthorityWriteBlocked || !jobId || screenshotImportBusy || screenshotImportRunning,
    },
    {
      key: 'review-screenshot-ocr',
      label: screenshotPendingReview?.status === 'ready' && screenshotPendingReview.count > 0
        ? `校对 OCR 草稿（${screenshotPendingReview.count}）`
        : '校对 OCR 草稿',
      disabled: jobReadOnly || candidateAuthorityWriteBlocked || !jobId,
    },
    {
      key: 'rate',
      label: rateBusy ? rateLabel : '批量规则评级',
      disabled: jobReadOnly || candidateAuthorityWriteBlocked || !jobId || rateBusy,
    },
  ];

  function handleCandidateAction({ key }) {
    if (candidateAuthorityWriteBlocked
        && ['import-screenshots', 'review-screenshot-ocr', 'rate'].includes(key)) {
      message.warning('候选人数据尚未可靠读取，请先重试并等待恢复后再执行写操作。');
      return;
    }
    if (key === 'import-screenshots') handleImportScreenshots();
    else if (key === 'review-screenshot-ocr') {
      rememberOperationMenuFocus();
      setScreenshotReviewOpen(true);
    } else if (key === 'rate') handleRunRate();
  }
  function handleOpenDeepProfileFromGuide() {
    if (!job) {
      message.info('请先建立并选择一个岗位，再生成深度画像。');
      handleOpenNav('职位管理');
      return;
    }
    modalReturnFocusRef.current = document.activeElement instanceof HTMLElement
      && document.activeElement !== document.body
      ? document.activeElement
      : null;
    setDeepOpen(true);
  }

  function rememberOperationMenuFocus() {
    modalReturnFocusRef.current = operationMenuButtonRef.current;
  }

  function closeGlobalModal(setOpen) {
    setOpen(false);
    const returnTarget = modalReturnFocusRef.current;
    modalReturnFocusRef.current = null;
    const restore = () => {
      const activeElement = document.activeElement;
      const focusIsUnclaimed = !activeElement || activeElement === document.body || activeElement === returnTarget;
      if (focusIsUnclaimed && returnTarget?.isConnected && typeof returnTarget.focus === 'function') returnTarget.focus();
    };
    if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(restore);
    else globalThis.setTimeout(restore, 0);
    globalThis.setTimeout(restore, 120);
  }
  return (
    <Layout className={`app-frame ${appNavCollapsed ? 'app-nav-is-collapsed' : 'app-nav-is-expanded'}`}>
      <a
        className="skip-link"
        href="#main-workspace"
        onClick={(event) => {
          event.preventDefault();
          const workspace = document.getElementById('main-workspace');
          if (workspace instanceof HTMLElement) {
            workspace.focus({ preventScroll: true });
            workspace.scrollTo({ top: 0, left: 0, behavior: 'auto' });
          }
        }}
      >
        跳到主要内容
      </a>
      <div className="module-route-announcer" role="status" aria-live="polite" aria-atomic="true">
        {moduleAnnouncement}
      </div>
      <Sider
        id="app-primary-navigation"
        width={196}
        collapsedWidth={0}
        collapsed={appNavCollapsed}
        trigger={null}
        theme="light"
        className={`app-nav ${appNavCollapsed ? 'app-nav-collapsed' : 'app-nav-expanded'}`}
        aria-hidden={appNavCollapsed ? 'true' : undefined}
      >
        {!appNavCollapsed && (
          <div className="app-nav-content">
            <div className="app-nav-brand-row">
              <div className="brand-mark" role="img" title={`当前工作区：${brandName}`} aria-label={`当前工作区：${brandName}`}>
                <span aria-hidden="true">{brandMark}</span>
                <strong>{brandName}</strong>
              </div>
              <Button
                ref={appNavCollapseButtonRef}
                type="text"
                size="small"
                className="app-nav-toggle app-nav-collapse-toggle"
                icon={<MenuFoldOutlined aria-hidden="true" />}
                aria-label="收起主侧栏"
                title="收起主侧栏"
                aria-controls="app-primary-navigation"
                aria-expanded="true"
                onClick={() => setAppNavCollapsedWithFocus(true)}
              />
            </div>
            <nav className="nav-primary" aria-label="主导航">
              {PRIMARY_NAV_ITEMS.map((item) => {
                const NavIcon = NAV_ICON_MAP[item];
                return (
                  <button
                    key={item}
                    type="button"
                    className={`nav-item ${activeNav === item ? 'active' : ''}`}
                    aria-current={activeNav === item ? 'page' : undefined}
                    onClick={() => handleOpenNav(item)}
                  >
                    <NavIcon className="nav-item-icon" aria-hidden="true" />
                    <span>{item}</span>
                  </button>
                );
              })}
            </nav>
            <nav className="nav-utility app-nav-footer" aria-label="帮助与设置">
              <Dropdown
                trigger={['click']}
                placement="topLeft"
                autoFocus
                open={utilityMenuOpen}
                onOpenChange={setUtilityMenuOpen}
                overlayClassName="app-nav-utility-dropdown"
                menu={{
                  id: APP_NAV_UTILITY_MENU_ID,
                  selectedKeys: activeNav === '使用指南'
                    ? ['guide']
                    : (activeNav === '设置' && activeDesktopUtilityKey
                      ? [activeDesktopUtilityKey]
                      : []),
                  selectable: true,
                  items: DESKTOP_UTILITY_MENU_ITEMS.map((item) => {
                    const UtilityIcon = item.icon;
                    const selected = item.navigation
                      ? activeNav === item.navigation
                      : activeNav === '设置' && activeDesktopUtilityKey === item.key;
                    return {
                      key: item.key,
                      className: 'app-nav-utility-menu-item',
                      icon: <UtilityIcon aria-hidden="true" />,
                      label: (
                        <span
                          className="app-nav-utility-menu-copy"
                          aria-current={selected ? 'page' : undefined}
                        >
                          <span className="app-nav-utility-menu-title">{item.label}</span>
                          <span className="app-nav-utility-menu-description">{item.description}</span>
                        </span>
                      ),
                    };
                  }),
                  onClick: ({ key }) => {
                    setUtilityMenuOpen(false);
                    handleOpenDesktopUtility(key);
                  },
                }}
              >
                <Button
                  ref={utilityMenuTriggerRef}
                  type="text"
                  className={`app-nav-footer-main ${['设置', '使用指南'].includes(activeNav) ? 'active' : ''}`}
                  icon={<SettingOutlined aria-hidden="true" />}
                  aria-label="打开设置与帮助菜单"
                  aria-haspopup="menu"
                  aria-expanded={utilityMenuOpen}
                  aria-controls={APP_NAV_UTILITY_MENU_ID}
                  data-active={['设置', '使用指南'].includes(activeNav) ? 'true' : 'false'}
                  data-active-nav={['设置', '使用指南'].includes(activeNav) ? activeNav : undefined}
                  onKeyDown={(event) => {
                    if (!['Enter', ' ', 'Spacebar'].includes(event.key) || event.repeat) return;
                    event.preventDefault();
                    setUtilityMenuOpen((open) => !open);
                  }}
                >
                  <span className="app-nav-footer-label">设置与帮助</span>
                  <UpOutlined
                    className={`app-nav-footer-disclosure ${utilityMenuOpen ? 'open' : ''}`}
                    aria-hidden="true"
                  />
                </Button>
              </Dropdown>
            </nav>
          </div>
        )}
      </Sider>
      <Layout className="main-frame">
        <nav className="mobile-module-nav" aria-label="移动端主导航">
          <div className="mobile-module-brand" role="img" title={`当前工作区：${brandName}`} aria-label={`当前工作区：${brandName}`}>
            <span aria-hidden="true">{brandMark}</span>
            <strong>{brandName}</strong>
          </div>
          <label className="mobile-module-field">
            <span>当前模块</span>
            <select
              aria-label="切换模块"
              value={activeNav}
              onChange={(event) => {
                const nextNav = event.target.value;
                handleOpenUtilityNav(nextNav);
              }}
            >
              {MOBILE_NAV_ITEMS.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </label>
        </nav>
        <Header className={`top-header ${appNavCollapsed ? 'top-header-app-nav-collapsed' : ''}`}>
          {appNavCollapsed && (
            <Button
              ref={appNavRestoreButtonRef}
              type="text"
              size="small"
              className="app-nav-toggle app-nav-restore-toggle"
              icon={<MenuUnfoldOutlined aria-hidden="true" />}
              aria-label="展开主侧栏"
              title="展开主侧栏"
              aria-controls="app-primary-navigation"
              aria-expanded="false"
              onClick={() => setAppNavCollapsedWithFocus(false)}
            />
          )}
          <TopBar
            readOnly={jobReadOnly}
            readOnlyReason={READONLY_UI ? 'global' : (jobClosed ? 'closed-job' : '')}
            showJobContext={activeNav !== '设置'}
            showSabcFilter={activeNav === '候选人'}
            jobs={jobs}
            jobId={jobId}
            onJobChange={handleJobChange}
            sabc={sabc}
            onSabcChange={setSabc}
            localRefreshBusy={localRefreshBusy}
            onRefreshLocal={handleRefreshLocal}
            screenshotImportProgress={screenshotImportProgress}
            screenshotPendingReview={screenshotPendingReview}
            onOpenScreenshotImportTask={!READONLY_UI ? () => {
              setScreenshotImportTaskOpen(true);
              refreshScreenshotImportTask({ showLoading: true });
            } : undefined}
          />
        </Header>
        {activeNav === '工作台' ? (
          <Layout className="workspace">
            <Content id="main-workspace" tabIndex={-1} className="detail-content">
              <ModuleSemanticHeading>工作台</ModuleSemanticHeading>
              <FeatureErrorBoundary featureKey={`workbench:${jobId ?? 'none'}`} featureLabel="工作台">
                <DashboardPanel
                  jobs={jobs}
                  job={job}
                  jobId={jobId}
                  candidates={candidates}
                  workbench={workbench}
                  jobsLoadState={jobsState}
                  jobsLoadError={jobsError}
                  loadState={workbenchState}
                  loadError={workbenchError}
                  readOnly={jobReadOnly}
                  screenshotImportProgress={screenshotImportProgress}
                  screenshotImportActive={screenshotImportActionBlocked}
                  onOpenNav={handleOpenNav}
                  onOpenTodo={handleOpenWorkbenchTodo}
                  onOpenDeepProfile={handleOpenDeepProfileFromGuide}
                  onUploadResume={handlePrepareCandidateFromResume}
                  onImportScreenshots={handleImportScreenshots}
                  onRetryJobs={() => boot()}
                  onRetry={() => loadCandidates(jobId).catch(() => { /* surfaced inline by loadCandidates */ })}
                />
              </FeatureErrorBoundary>
            </Content>
          </Layout>
        ) : activeNav === '使用指南' ? (
          <Layout className="workspace">
            <Content id="main-workspace" tabIndex={-1} className="detail-content">
              <ModuleSemanticHeading>使用指南</ModuleSemanticHeading>
              <FeatureErrorBoundary
                featureKey={`guide:${jobId ?? 'none'}`}
                featureLabel="使用指南"
                onExit={() => handleOpenNav('工作台')}
              >
                <Suspense fallback={<ModuleLoadingFallback />}>
                  <WorkflowGuidePanel
                    jobs={jobs}
                    job={job}
                    candidates={candidates}
                    workbench={workbench}
                    jobsLoadState={jobsState}
                    jobsLoadError={jobsError}
                    loadState={workbenchState}
                    loadError={workbenchError}
                    onRetry={() => boot()}
                    onOpenNav={handleOpenNav}
                    onOpenDeepProfile={handleOpenDeepProfileFromGuide}
                  />
                </Suspense>
              </FeatureErrorBoundary>
            </Content>
          </Layout>
        ) : activeNav === '职位管理' ? (
          <Layout className="workspace">
            <Content id="main-workspace" tabIndex={-1} className="detail-content">
              <ModuleSemanticHeading>职位管理</ModuleSemanticHeading>
              <FeatureErrorBoundary
                featureKey={`jobs:${jobManagementView}:${jobId ?? 'none'}:${job?.is_fixture ? 'fixture' : 'formal'}`}
                featureLabel={jobManagementView === 'ledger' ? '岗位台账' : '职位管理'}
                onExit={jobManagementView === 'ledger' ? () => handleOpenNav('工作台') : handleReturnJobLedger}
                exitLabel={jobManagementView === 'ledger' ? '返回工作台' : '返回岗位台账'}
              >
                <Suspense fallback={<ModuleLoadingFallback />}>
                  {jobManagementView === 'ledger' ? (
                    <JobLedgerPanel
                      jobs={jobs}
                      jobId={jobId}
                      loadState={jobsState}
                      loadError={jobsError}
                      readOnly={READONLY_UI}
                      onOpenJob={handleOpenManagedJobWithFocus}
                      onJobsChanged={handleJobsChanged}
                      onRetry={() => boot()}
                    />
                  ) : (
                    <>
                      <div className="job-module-action-strip" role="group" aria-label="职位模块操作">
                        <div>
                          <strong>职位操作</strong>
                          <span>岗位画像在下方固定分区。</span>
                        </div>
                        <Space size={8} wrap>
                          <Button
                            size="small"
                            disabled={!jobId}
                            onClick={(event) => {
                              modalReturnFocusRef.current = event.currentTarget;
                              setDeepOpen(true);
                            }}
                          >
                            查看深度画像
                          </Button>
                        </Space>
                      </div>
                      {job?.is_fixture ? <JobManagementDemo
                        key={`job-demo-${jobId}`}
                        jobs={jobs}
                        jobId={jobId}
                        candidates={candidates}
                        readOnly={jobReadOnly}
                        onJobChange={handleJobChange}
                        onReturnLedger={handleReturnJobLedger}
                      /> : <JobManagementPanel
                        key={`job-editor-${jobId}`}
                        job={job}
                        workbench={workbench}
                        loadState={workbenchState}
                        loadError={workbenchError}
                        readOnly={jobReadOnly}
                        onRefresh={() => loadCandidates(jobId)}
                        onDirtyChange={handleJobEditorDirtyChange}
                        onReturnLedger={handleReturnJobLedger}
                        onOpenAiSettings={(intent) => handleOpenAiSettings({
                          ...intent,
                          returnNav: '职位管理',
                        })}
                        aiResumeIntent={aiResumeIntent}
                        onAiResumeConsumed={handleAiResumeConsumed}
                      />}
                    </>
                  )}
                </Suspense>
              </FeatureErrorBoundary>
            </Content>
          </Layout>
        ) : activeNav === '面试安排' ? (
          <Layout className="workspace">
            <Content id="main-workspace" tabIndex={-1} className="detail-content">
              <ModuleSemanticHeading>面试安排</ModuleSemanticHeading>
              <FeatureErrorBoundary
                featureKey={`interviews:${jobId ?? 'none'}:${job?.is_fixture ? 'fixture' : 'formal'}`}
                featureLabel="面试安排"
                onExit={() => handleOpenNav('工作台')}
              >
                <Suspense fallback={<ModuleLoadingFallback />}>
                  {job?.is_fixture ? <InterviewSchedulePanel
                    job={job}
                    jobId={jobId}
                    candidates={candidates}
                    readOnly={jobReadOnly}
                    onOpenCandidate={handleOpenInterviewScheduleCandidate}
                    onOpenCandidates={() => handleOpenNav('候选人')}
                    onOpenSettings={() => handleOpenSettings('settings-interview-tools', '面试安排')}
                    navigationTarget={workbenchNavigationTarget}
                    onNavigationTargetConsumed={handleWorkbenchNavigationConsumed}
                  /> : <InterviewScheduleCanonical
                    job={job}
                    workbench={workbench}
                    loadState={workbenchState}
                    loadError={workbenchError}
                    readOnly={jobReadOnly}
                    onOpenCandidate={handleOpenInterviewScheduleCandidate}
                    onOpenCandidates={() => handleOpenNav('候选人')}
                    onOpenJobs={() => handleOpenNav('职位管理')}
                    onOpenSettings={() => handleOpenSettings('settings-interview-tools', '面试安排')}
                    onRefresh={() => loadCandidates(jobId)}
                    navigationTarget={workbenchNavigationTarget}
                    onNavigationTargetConsumed={handleWorkbenchNavigationConsumed}
                  />}
                </Suspense>
              </FeatureErrorBoundary>
            </Content>
          </Layout>
        ) : activeNav === '人才库' ? (
          <Layout className="workspace">
            <Content id="main-workspace" tabIndex={-1} className="detail-content">
              <ModuleSemanticHeading>人才库</ModuleSemanticHeading>
              <FeatureErrorBoundary
                featureKey={`talent:${jobId ?? 'none'}`}
                featureLabel="人才库"
                onExit={() => handleOpenNav('工作台')}
              >
                <Suspense fallback={<ModuleLoadingFallback />}>
                  <TalentPoolDemo
                    jobId={jobId}
                    fixtureJob={!!job?.is_fixture}
                    readOnly={jobReadOnly}
                    onOpenCandidate={handleOpenTalentCandidate}
                    onOpenCandidates={() => handleOpenNav('候选人')}
                    onCandidateAdded={(_, targetJobId) => loadCandidates(targetJobId)}
                  />
                </Suspense>
              </FeatureErrorBoundary>
            </Content>
          </Layout>
        ) : activeNav === '设置' ? (
          <Layout className="workspace">
            <Content id="main-workspace" tabIndex={-1} className="detail-content">
              <ModuleSemanticHeading>设置</ModuleSemanticHeading>
              <FeatureErrorBoundary
                featureKey="settings"
                featureLabel="设置"
                onExit={() => handleOpenNav(settingsReturnNav || '工作台')}
                exitLabel="返回上一模块"
              >
                <Suspense fallback={<ModuleLoadingFallback />}>
                  <SettingsPanel
                    jobs={jobs}
                    job={job}
                    candidates={candidates}
                    jobsLoadState={jobsState}
                    jobsLoadError={jobsError}
                    workbench={workbench}
                    workbenchState={workbenchState}
                    workbenchError={workbenchError}
                    readOnly={READONLY_UI}
                    screenshotImportProgress={screenshotImportProgress}
                    brandMark={brandMark}
                    brandName={brandName}
                    defaultBrandMark={DEFAULT_BRAND_MARK}
                    defaultBrandName={DEFAULT_BRAND_NAME}
                    onBrandMarkChange={handleBrandMarkChange}
                    onBrandNameChange={handleBrandNameChange}
                    onOpenNav={handleOpenUtilityNav}
                    onSectionChange={handleSettingsSectionChange}
                    onDirtyChange={setSettingsDirty}
                    returnNav={settingsReturnNav}
                    aiReturnContext={aiSettingsReturnContext}
                    onReturnToAiOperation={handleReturnToAiOperation}
                  />
                </Suspense>
              </FeatureErrorBoundary>
            </Content>
          </Layout>
        ) : (
          <Suspense fallback={<ModuleLoadingFallback />}>
            <Layout className={`workspace candidate-workspace ${candidateListCollapsed ? 'candidate-workspace-focused' : 'candidate-workspace-list-open'} ${selectedId ? 'candidate-workspace-has-selection' : 'candidate-workspace-no-selection'}`}>
            <Sider
              id={CANDIDATE_LIST_PANEL_ID}
              width={selectedId ? CANDIDATE_LIST_SELECTED_WIDTH : CANDIDATE_LIST_EMPTY_WIDTH}
              collapsedWidth={0}
              collapsed={candidateListCollapsed}
              trigger={null}
              theme="light"
              className={`candidate-sider ${candidateListCollapsed ? 'candidate-sider-collapsed' : 'candidate-sider-open'}`}
	            >
	              <div className="candidate-sider-inner" aria-hidden={candidateListCollapsed ? 'true' : undefined}>
	                <div className="candidate-sider-toolbar">
	                  <div className="candidate-sider-heading">
	                    <span className="candidate-sider-title">候选人列表</span>
	                    <Button
	                      ref={candidateListCollapseButtonRef}
	                      type="text"
	                      className="candidate-list-panel-toggle candidate-list-collapse-toolbar"
	                      icon={<MenuFoldOutlined className="candidate-list-panel-toggle-icon" aria-hidden="true" />}
	                      aria-label="收起候选人列表"
	                      title="收起候选人列表"
	                      aria-controls={CANDIDATE_LIST_PANEL_ID}
	                      aria-expanded={!candidateListCollapsed}
	                      onKeyDown={(event) => handleCandidateListToggleKeyDown(event, true)}
	                      onClick={() => setCandidateListCollapsedWithFocus(true)}
	                    />
	                  </div>
	                  <Button
	                    size="small"
	                    type="primary"
	                    icon={<UploadOutlined />}
	                    loading={resumeIntakeBusy && !resumeCandidateDraft}
	                    disabled={jobReadOnly || candidateAuthorityWriteBlocked || !jobId}
	                    onClick={handlePrepareCandidateFromResume}
	                  >
	                    上传简历建档
	                  </Button>
	                  {screenshotPendingReview?.status === 'ready' && screenshotPendingReview.count > 0 ? (
	                    <Button
	                      size="small"
	                      disabled={jobReadOnly || candidateAuthorityWriteBlocked || !jobId}
	                      onClick={() => handleCandidateAction({ key: 'review-screenshot-ocr' })}
	                    >
	                      {`待核对 OCR 草稿（${screenshotPendingReview.count}）`}
	                    </Button>
	                  ) : null}
	                  <div className="candidate-module-actions">
	                    <Dropdown
	                      trigger={['click']}
	                      menu={{ items: candidateActionItems, onClick: handleCandidateAction }}
	                    >
	                      <Button
	                        ref={operationMenuButtonRef}
	                        size="small"
	                        icon={<MoreOutlined aria-hidden="true" />}
	                        disabled={jobReadOnly || !jobId}
	                        aria-label="候选人模块操作"
	                      >
	                        候选人操作
	                      </Button>
	                    </Dropdown>
	                  </div>
	                </div>
		                <FeatureErrorBoundary
		                  featureKey={`candidate-list:${jobId ?? 'none'}`}
		                  featureLabel="候选人列表"
		                  onExit={() => handleOpenNav('工作台')}
		                  focusOnError={!candidateListCollapsed}
		                >
		                  <CandidateList
                      key={`candidate-list-${jobId ?? 'none'}`}
                      candidates={candidates}
                      loadState={candidateListState}
                      loadError={candidateListError}
                      loadErrorDetails={candidateListErrorDetails}
                      onRetry={() => loadCandidates(jobId).catch(() => { /* surfaced inline by loadCandidates */ })}
                      selectedId={selectedId}
                      onSelectionInvalidated={handleCandidateSelectionInvalidated}
                      onSelect={(id) => handleSelectCandidate(id, currentJobContextRef.current, { initialDomain: 'profile' })}
                      query={query}
                      onQueryChange={setQuery}
                      comm={comm}
                      onCommChange={setComm}
                      disp={disp}
                      onDispChange={setDisp}
                      sabc={sabc}
                      onSabcChange={setSabc}
                      education={education}
                      onEducationChange={setEducation}
		                    summaryText={listSummaryText}
		                  />
		                </FeatureErrorBoundary>
	              </div>
	            </Sider>
	            <Content id="main-workspace" tabIndex={-1} className={`detail-content candidate-detail-content ${candidateListCollapsed ? 'candidate-detail-content-focused' : ''}`}>
	              <ModuleSemanticHeading>候选人</ModuleSemanticHeading>
	              {(candidateListCollapsed || focusCandidate) && (
	                <div
	                  className={`candidate-focus-bar candidate-identity-anchor${candidateListCollapsed ? ' is-list-collapsed' : ' is-list-open'}`}
	                  role="region"
	                  aria-label="当前候选人身份锚点"
	                >
	                  {candidateListCollapsed && (
	                    <Button
	                      ref={candidateListRestoreButtonRef}
	                      type="text"
	                      icon={<MenuUnfoldOutlined className="candidate-list-panel-toggle-icon" aria-hidden="true" />}
	                      className="candidate-list-panel-toggle candidate-list-restore-control"
	                      aria-label="展开候选人列表"
	                      title="展开候选人列表"
	                      aria-controls={CANDIDATE_LIST_PANEL_ID}
	                      aria-expanded={!candidateListCollapsed}
	                      onKeyDown={(event) => handleCandidateListToggleKeyDown(event, false)}
	                      onClick={() => setCandidateListCollapsedWithFocus(false)}
	                    >
	                      展开候选人列表
	                    </Button>
	                  )}
	                  {focusCandidate && (
	                    <div className="candidate-focus-identity">
	                      <strong title={`完整姓名：${focusCandidateName}`}>{focusCandidateName}</strong>
	                      <span className="candidate-focus-job" title={`当前岗位：${focusCandidateJob}`}>{focusCandidateJob}</span>
	                      <span className="candidate-focus-reference" title={focusCandidateReference.full}>{focusCandidateReference.visible}</span>
	                    </div>
	                  )}
	                </div>
	              )}
	              <FeatureErrorBoundary
	                featureKey={`candidate-detail:${jobId ?? 'none'}:${selectedId ?? 'none'}`}
	                featureLabel="候选人详情"
	                onExit={() => handleOpenNav('工作台')}
	              >
	                {detail ? (
                    <>
                      {detailState === 'refreshing' && (
                        <Alert
                          className="candidate-detail-recovery-alert"
                          type="info"
                          showIcon
                          message="正在刷新候选人详情"
                          description="最近一次成功内容仍可查看；刷新完成前请勿重复提交刚才的操作。"
                        />
                      )}
                      {['partial', 'stale'].includes(detailState) && (
                        <Alert
                          className="candidate-detail-recovery-alert"
                          type={detailState === 'stale' ? 'error' : 'warning'}
                          showIcon
                          message={detailState === 'stale'
                            ? '刷新失败，正在显示最近一次成功详情'
                            : '候选人核心资料已保留，部分辅助记录读取失败'}
                          description={`${detailError || '辅助记录暂不可用'}。请只重试读取，不要重复提交刚才的操作。`}
                          action={(
                            <Button
                              size="small"
                              onClick={() => refreshCandidateDetail({ ...currentCandidateContextRef.current })}
                            >
                              重试读取
                            </Button>
                          )}
                        />
                      )}
                      <CandidateDetail
                      key={`${jobId}:${detail.candidate.internal_id}:${candidateWorkspaceRevision}`}
                      candidate={detail.candidate}
                      jobName={job?.name || `岗位 ${jobId}`}
                      childrenData={detail.children}
                      actions={detail.actions}
                      query={query}
                      onAssess={handleAssess}
                      assessBusy={assessBusy}
                      readOnly={jobReadOnly || candidateAuthorityWriteBlocked}
                      readOnlyReason={READONLY_UI ? 'global' : (jobClosed ? 'closed-job' : ((jobAuthorityWriteBlocked || candidateAuthorityWriteBlocked) ? 'authority' : ''))}
				      assessmentMaintenanceAllowed={jobClosed && !READONLY_UI}
				      initialDomain={detailInitialDomain}
				      initialInterviewTab={detailInterviewNavigation.tab}
				      interviewNavigationRequestKey={detailInterviewNavigation.requestKey}
				      interviewNavigationTarget={detailInterviewNavigation.target}
			                    timeline={detail.timeline}
	                    onAssessmentChanged={handleAssessmentChanged}
	                    onWorkflowChanged={handleCandidateWorkflowChanged}
	                    onOpenTaskTodo={handleOpenCandidateTaskTodo}
	                    onOpenAiSettings={(intent) => handleOpenAiSettings({
	                      ...intent,
	                      returnNav: '候选人',
	                    })}
	                    onOpenInterviewSettings={() => handleOpenSettings('settings-interview-tools', '候选人')}
	                    aiResumeIntent={aiResumeIntent}
	                    onAiResumeConsumed={handleAiResumeConsumed}
	                    onDirtyChange={handleCandidateWorkspaceDirtyChange}
	                    onBusyChange={handleCandidateWorkspaceBusyChange}
	                  />
                    </>
                  ) : detailState === 'loading' ? (
                    <ModuleLoadingFallback />
                  ) : detailState === 'error' ? (
                    <Alert
                      type="error"
                      showIcon
                      message="候选人详情读取失败"
                      description={detailError}
                      action={<Button onClick={() => handleSelectCandidate(selectedId, currentJobContextRef.current, { initialDomain: detailInitialDomain, initialInterviewTab: detailInterviewNavigation.tab, initialInterviewTarget: detailInterviewNavigation.target })}>重试</Button>}
                    />
                  ) : (
                    <CandidateDetail
                      candidate={null}
                      readOnly={jobReadOnly || candidateAuthorityWriteBlocked}
                      onChooseCandidate={focusCandidateChooser}
                    />
                  )}
	              </FeatureErrorBoundary>
            </Content>
            </Layout>
          </Suspense>
        )}
      </Layout>

      {deepOpen && (
        <FeatureErrorBoundary
          featureKey={`deep-profile:${jobId ?? 'none'}:open`}
          featureLabel="深度岗位画像"
          onExit={() => closeGlobalModal(setDeepOpen)}
          exitLabel="关闭"
          modal
        >
          <Suspense fallback={<ModuleLoadingFallback modal />}>
            <DeepProfileModal
              open
              jobId={jobId}
              jobName={job ? job.name : `岗位 ${jobId}`}
              readOnly={jobReadOnly || currentJobIsFixture}
              onClose={() => closeGlobalModal(setDeepOpen)}
              onOpenAiSettings={async (intent) => {
                const opened = await handleOpenAiSettings({
                  ...intent,
                  returnNav: activeNav,
                });
                if (opened) closeGlobalModal(setDeepOpen);
                return opened;
              }}
              aiResumeIntent={aiResumeIntent}
              onAiResumeConsumed={handleAiResumeConsumed}
            />
          </Suspense>
        </FeatureErrorBoundary>
      )}
      {!jobReadOnly && !candidateAuthorityWriteBlocked && screenshotReviewOpen && (
        <FeatureErrorBoundary
          featureKey={`screenshot-review:${jobId ?? 'none'}:open`}
          featureLabel="截图识别复核"
          onExit={() => closeGlobalModal(setScreenshotReviewOpen)}
          exitLabel="关闭"
          modal
        >
          <Suspense fallback={<ModuleLoadingFallback modal />}>
            <ScreenshotOcrReviewModal
              open
              jobId={jobId}
              onClose={() => closeGlobalModal(setScreenshotReviewOpen)}
              onPendingCountChange={(count) => acceptScreenshotPendingCount(count, jobId)}
              onConfirmed={async (confirmedJobId) => {
                const context = currentJobContextRef.current;
                if (!sameJobId(jobId, context.jobId)) return;
                const applied = await refreshJobs(confirmedJobId || context.jobId);
                if (!applied) return;
                await handleCandidateSelectionInvalidated();
              }}
            />
          </Suspense>
        </FeatureErrorBoundary>
      )}
      {!READONLY_UI && screenshotImportTaskOpen && (
        <FeatureErrorBoundary
          featureKey="screenshot-import-task:open"
          featureLabel="截图导入任务中心"
          onExit={() => setScreenshotImportTaskOpen(false)}
          exitLabel="关闭"
          modal
        >
          <Suspense fallback={<ModuleLoadingFallback modal />}>
            <ScreenshotImportTaskPanel
              open
              task={screenshotImportProgress}
              loadState={screenshotImportTaskLoadState}
              loadError={screenshotImportTaskError}
              retryBusy={screenshotImportRetryBusy}
              pendingReviewState={screenshotImportProgress?.result?.job_id
                && sameJobId(screenshotImportProgress.result.job_id, screenshotPendingReview.jobId)
                ? screenshotPendingReview
                : screenshotImportProgress?.pending_review_state}
              onClose={() => setScreenshotImportTaskOpen(false)}
              onRefresh={() => refreshScreenshotImportTask({
                runId: screenshotImportProgress?.task_id || '',
                showLoading: true,
              })}
              onRetry={handleRetryScreenshotImportItems}
              onOpenReview={handleOpenScreenshotReviewFromTask}
            />
          </Suspense>
        </FeatureErrorBoundary>
      )}
      <ResumeCandidateImportModal
        open={Boolean(resumeCandidateDraft)}
        draft={resumeCandidateDraft}
        busy={resumeIntakeBusy}
        onCancel={() => {
          if (!resumeIntakeBusy) setResumeCandidateDraft(null);
        }}
        onConfirm={handleCommitCandidateFromResume}
      />
    </Layout>
  );
}
