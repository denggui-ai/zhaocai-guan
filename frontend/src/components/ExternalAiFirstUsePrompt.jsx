import React, { useEffect, useState } from 'react';
import { Alert, Button, Modal, Space, Typography } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { api } from '../api.js';

const { Text } = Typography;

export const EXTERNAL_AI_CAPABILITIES = Object.freeze({
  job_jd: {
    title: 'AI 优化 JD',
    value: '把自然语言招聘需求整理成可编辑 JD 草稿，并提示待补信息。',
    material: '岗位名称、招聘需求和当前 JD 文本',
    result: '只生成可编辑 JD 草稿',
  },
  deep_profile: {
    title: '深度岗位画像',
    value: '把已保存的负责人访谈整理为可核对的深度岗位画像。',
    material: '岗位、已确认 JD/画像和负责人访谈文本',
    result: '只保存为待 HR 核对的画像草稿',
  },
  candidate_assessment: {
    title: '候选人 AI 初评',
    value: '按岗位要求整理候选人材料中的匹配、风险和信息不足。',
    material: '岗位要求、候选人简历和已确认画像',
    result: '只保存为第二意见，不改变 S/A/B/C 或排序',
  },
  assessment_analysis: {
    title: '测评综合分析',
    value: '联合整理已确认测评、简历、岗位和已确认面试材料。',
    material: '岗位、简历、已确认测评和已确认面试材料',
    result: '只保存为第二意见，不自动评级或处置',
  },
  interview_review: {
    title: '面试 AI 复盘',
    value: '把 HR 选择的面试材料整理为可复核的面试报告草稿。',
    material: 'HR 本次勾选的面试转写、笔记和相关已确认材料',
    result: '只保存为面试报告草稿，不成为正式结论',
  },
});

export function externalAiCapabilityAvailable(config, capability) {
  return config?.operational === true
    && config.enabled === true
    && config.apiKeyConfigured === true
    && config.modelVerified === true
    && config.capabilities?.[capability] === true;
}

export async function readExternalAiCapability(capability) {
  try {
    const response = await api.getLlmConfig();
    const config = response?.config || null;
    return {
      readable: true,
      available: externalAiCapabilityAvailable(config, capability),
      config,
      error: '',
    };
  } catch (error) {
    return {
      readable: false,
      available: false,
      config: null,
      error: error?.message || '外部 AI 配置状态暂不可读',
    };
  }
}

export default function ExternalAiFirstUsePrompt({
  open,
  capability,
  material,
  readError = '',
  onEnable,
  onManual,
  onClose,
}) {
  const [showBoundary, setShowBoundary] = useState(false);
  const definition = EXTERNAL_AI_CAPABILITIES[capability] || EXTERNAL_AI_CAPABILITIES.job_jd;

  useEffect(() => {
    if (open) setShowBoundary(false);
  }, [open, capability]);

  return (
    <Modal
      className="external-ai-first-use-modal"
      open={open}
      title="启用外部 AI 辅助"
      onCancel={onClose}
      maskClosable
      keyboard
      destroyOnHidden
      width={560}
      footer={(
        <Space wrap className="external-ai-first-use-actions">
          <Button onClick={onManual}>继续手动处理</Button>
          <Button type="primary" onClick={onEnable}>启用并继续</Button>
        </Space>
      )}
    >
      <div className="external-ai-first-use-copy">
        <Text strong>{definition.title}</Text>
        <p>{definition.value}</p>
      </div>
      {readError && (
        <Alert
          type="warning"
          showIcon
          message="当前无法确认外部 AI 配置"
          description={`${readError}。本地招聘仍可继续；进入设置后会按安全规则重新读取。`}
        />
      )}
      <dl className="external-ai-first-use-boundary">
        <div><dt>将发送</dt><dd>{material || definition.material}</dd></div>
        <div><dt>不会发生</dt><dd>自动发送、自动评级、自动淘汰、自动写回</dd></div>
        <div><dt>结果</dt><dd>{definition.result}</dd></div>
      </dl>
      <Button
        type="link"
        className="external-ai-boundary-toggle"
        aria-expanded={showBoundary}
        aria-controls="external-ai-first-use-boundary-detail"
        onClick={() => setShowBoundary((visible) => !visible)}
      >
        查看发送边界
      </Button>
      {showBoundary && (
        <div id="external-ai-first-use-boundary-detail" className="external-ai-first-use-boundary-detail" role="note">
          <SafetyCertificateOutlined aria-hidden="true" />
          <span>每次真正发送前，招才官仍会展示发送文本、排除项、模型和字符数，并要求 HR 再次确认。启用或返回不会自动外发。</span>
        </div>
      )}
    </Modal>
  );
}
