import React from 'react';
import { Button, Card, Segmented, Space, Tag, Typography } from 'antd';

const { Paragraph, Text, Title } = Typography;

export const JOB_MANAGEMENT_SECTIONS = Object.freeze([
  { label: 'JD 与版本', value: 'jd' },
  { label: '岗位画像', value: 'profile' },
]);

export const JOB_MANAGEMENT_ACTION_SCHEMA = Object.freeze({
  navigateSection: Object.freeze({ id: 'navigate-section', mutates: false }),
  editDraft: Object.freeze({ id: 'edit-draft', mutates: true }),
  resetDraft: Object.freeze({ id: 'reset-draft', mutates: true }),
  optimizeJd: Object.freeze({ id: 'optimize-jd', mutates: true }),
  copyJd: Object.freeze({ id: 'copy-jd', mutates: false }),
  saveJdDraft: Object.freeze({ id: 'save-jd-draft', mutates: true }),
  activateJdVersion: Object.freeze({ id: 'activate-jd-version', mutates: true }),
  saveProfileDraft: Object.freeze({ id: 'save-profile-draft', mutates: true }),
  confirmProfileVersion: Object.freeze({ id: 'confirm-profile-version', mutates: true }),
  refreshData: Object.freeze({ id: 'refresh-data', mutates: false }),
});

const ACTIONS_BY_ID = Object.freeze(Object.fromEntries(
  Object.values(JOB_MANAGEMENT_ACTION_SCHEMA).map((action) => [action.id, action]),
));

export function createJobManagementActionAdapter({ handlers = {}, locked = false } = {}) {
  const execute = (actionId, ...args) => {
    const contract = ACTIONS_BY_ID[actionId];
    if (!contract) throw new Error(`unknown job management action: ${actionId}`);
    if (locked && contract.mutates) return false;
    const handler = handlers[actionId];
    return typeof handler === 'function' ? handler(...args) : false;
  };
  const isEnabled = (actionId) => {
    const contract = ACTIONS_BY_ID[actionId];
    return !!contract && !(locked && contract.mutates) && typeof handlers[actionId] === 'function';
  };
  return Object.freeze({ execute, isEnabled, locked: !!locked, schema: JOB_MANAGEMENT_ACTION_SCHEMA });
}

const JOB_STATUS_META = Object.freeze({
  draft: { label: '草稿', color: 'default' },
  open: { label: '招聘中', color: 'green' },
  published: { label: '招聘中', color: 'green' },
  paused: { label: '暂缓', color: 'orange' },
  closed: { label: '已关闭', color: 'default' },
});

export function JobManagementWorkspace({
  title,
  status,
  mode = 'formal',
  readOnly = false,
  activeSection,
  actionAdapter,
  onReturnLedger,
  description,
  children,
}) {
  const statusMeta = JOB_STATUS_META[status] || { label: status || '状态待确认', color: 'default' };
  const modeLabel = mode === 'fixture' ? '演示数据' : '本地岗位';
  const navigateActionId = JOB_MANAGEMENT_ACTION_SCHEMA.navigateSection.id;

  return (
    <section
      className="job-management-shell"
      aria-label="职位管理工作区"
      data-job-management-action-schema={Object.values(JOB_MANAGEMENT_ACTION_SCHEMA).map((action) => action.id).join(',')}
    >
      <div className="job-management-main">
        <Card className="job-management-card">
          <div className="job-management-hero">
            <div>
              <Text className="job-management-kicker">职位管理</Text>
              <Title level={3} tabIndex={-1} data-job-editor-heading>{title || '未命名岗位'}</Title>
              {description && <Paragraph>{description}</Paragraph>}
              <Space size={[6, 6]} wrap>
                <Tag color={statusMeta.color}>{statusMeta.label}</Tag>
                <Tag color={mode === 'fixture' ? 'gold' : 'blue'}>{modeLabel}</Tag>
                {readOnly && <Tag color="green">只读</Tag>}
              </Space>
            </div>
            {typeof onReturnLedger === 'function' && (
              <Button onClick={onReturnLedger}>返回岗位台账</Button>
            )}
          </div>
        </Card>

        <div className="job-management-section-tabs">
          <Segmented
            options={JOB_MANAGEMENT_SECTIONS}
            value={activeSection}
            onChange={(nextSection) => actionAdapter?.execute(navigateActionId, nextSection)}
            aria-label="职位管理分区"
          />
          <Text type="secondary">{mode === 'fixture' ? '当前为演示模式，修改不会影响你的岗位。' : '先启用 JD，再确认岗位画像，用于后续筛选与面试。'}</Text>
        </div>

        {children}
      </div>
    </section>
  );
}
