// 主窗口预加载脚本：contextIsolation 开着，渲染进程本身拿不到任何 Node/Electron API。
// 这里只经 contextBridge 开窄缝：本地文件与文件夹选择、外部 AI 授权等受控入口。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenshotImport', {
  selectDirectory: () => ipcRenderer.invoke('screenshot-import:select-directory'),
  approveRetry: (request) => ipcRenderer.invoke('screenshot-import:approve-retry', request),
  approveAiFill: (request) => ipcRenderer.invoke('screenshot-import:approve-ai-fill', request),
});

contextBridge.exposeInMainWorld('localInterview', {
  selectMediaFile: () => ipcRenderer.invoke('local-interview:select-media-file'),
  selectSummaryFile: () => ipcRenderer.invoke('local-interview:select-summary-file'),
});

contextBridge.exposeInMainWorld('resumeAttachment', {
  selectAndImport: (request) => ipcRenderer.invoke('resume-attachment:select-and-import', request),
  selectCandidateDraft: (request) => ipcRenderer.invoke('resume-candidate:select-and-preview', request),
});

contextBridge.exposeInMainWorld('localApi', {
  request: (request) => ipcRenderer.invoke('local-api:request', request),
});

// API key 只经过受信主窗口的专用 IPC，使用 Electron 系统安全存储加密持久化；
// 明文不经通用配置读取接口，也不向渲染进程回显。
contextBridge.exposeInMainWorld('llmCredential', {
  configure: (request) => ipcRenderer.invoke('llm-credential:configure', request),
  refreshModels: () => ipcRenderer.invoke('llm-models:refresh'),
  testModel: (request) => ipcRenderer.invoke('llm-model:test', request),
});

// 关闭保护只同步草稿布尔值；目录读取只返回本次启动的固定路径，不接收文件目标。
contextBridge.exposeInMainWorld('settingsState', {
  setExternalAiDirty: (dirty) => ipcRenderer.sendSync('settings-state:external-ai-dirty', dirty === true) === true,
  getLocalPaths: () => ipcRenderer.invoke('settings-state:local-paths'),
});

// 发送预览中的确认按钮只能请求受信主进程弹出系统原生确认；明确确认后，
// 主进程才签发一次性绑定授权。renderer 不能取得 secret 或自行制造凭据。
contextBridge.exposeInMainWorld('llmApproval', {
  confirm: (request) => ipcRenderer.invoke('llm-approval:confirm', request),
});

// 候选人评估与深度画像也必须经过主进程原生确认；renderer 只能请求签发，
// 不能取得签名 secret，也不能自行制造批准布尔值。
contextBridge.exposeInMainWorld('externalAiApproval', {
  confirm: (request) => ipcRenderer.invoke('external-ai-approval:confirm', request),
});

contextBridge.exposeInMainWorld('assessmentArchive', {
  selectAndImport: (request) => ipcRenderer.invoke('assessment:select-and-import', request),
  onImportProgress: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('assessment:import-progress', listener);
    return () => ipcRenderer.removeListener('assessment:import-progress', listener);
  },
});
