'use strict';

const path = require('path');
const { approvalBinding } = require('./external-ai-user-approval');

function screenshotApprovalBinding(preview, requestId, actor) {
  if (!preview || preview.requires_external_ai !== true) throw new Error('截图外部 AI 发送预览不完整。');
  return approvalBinding({
    purpose: preview.purpose,
    targetId: preview.targetId,
    requestId,
    actor,
    materialSha256: preview.materialHash,
    provider: preview.provider,
    baseUrl: preview.baseUrl,
    model: preview.model,
  });
}

function screenshotApprovalDialog(preview, binding) {
  const extensions = Object.entries(preview.extensionCounts || {})
    .map(([extension, count]) => `${extension} ${count} 张`)
    .join('、') || '未知格式';
  const operation = preview.operation === 'retry' ? '重试失败/未识别截图'
    : preview.operation === 'ai_fill' ? '补全待校对截图草稿的弱识别字段'
      : '识别并导入截图';
  const imageRows = (preview.items || []).map((item) => (
    `${item.ordinal}. ${item.fileName} · ${item.sizeBytes} 字节 · SHA-256 ${item.contentHashPrefix}…${
      Array.isArray(item.fieldKeys) && item.fieldKeys.length ? ` · 补全 ${item.fieldKeys.join(', ')}` : ''
    }`
  ));
  return {
    type: 'warning',
    title: preview.operation === 'retry' ? '确认重试并发送截图到外部 AI'
      : preview.operation === 'ai_fill' ? '确认发送待校对截图到外部 AI 补全'
        : '确认发送截图到外部 AI',
    message: '这是一次会产生外部数据传输和潜在费用的操作。',
    detail: [
      `操作：${operation}；截图 ${preview.imageCount} 张，共 ${preview.totalBytes} 字节（${extensions}）。`,
      `Provider：${binding.provider}；服务地址：${new URL(binding.base_url).host}；模型：${binding.model}。`,
      `请求：${binding.request_id}；材料：${binding.material_sha256.slice(0, 12)}…。`,
      '',
      '—— 将外发的图像清单 ——',
      ...imageRows,
      '—— 清单结束 ——',
      '',
      '批准后仅会发送本预览中按内容哈希锁定的图像；目录路径、本地任务状态和 API 凭据不会发送。',
      '确认令牌绑定本次用途、目标、请求、逐图内容哈希、Provider、服务地址和模型，十分钟内一次有效。',
    ].join('\n'),
    buttons: ['取消', '确认发送'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

class PendingScreenshotApprovalVault {
  constructor() { this.entries = new Map(); }

  put(dir, approval) {
    this.entries.set(path.resolve(dir), { ...approval });
  }

  attach(request = {}) {
    if (request.service !== 'action'
        || String(request.method || 'GET').toUpperCase() !== 'POST'
        || request.requestPath !== '/screenshot-import/start') return request;
    const dir = request.body && typeof request.body.dir === 'string' ? path.resolve(request.body.dir) : '';
    const approval = dir ? this.entries.get(dir) : null;
    if (!approval) return request;
    this.entries.delete(dir);
    return {
      ...request,
      body: { ...(request.body || {}), requestId: approval.requestId, userApproval: approval.userApproval },
    };
  }
}

module.exports = {
  PendingScreenshotApprovalVault,
  screenshotApprovalBinding,
  screenshotApprovalDialog,
};
