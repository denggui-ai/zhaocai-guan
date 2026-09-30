import React, { useEffect, useRef, useState } from 'react';
import { Alert, Descriptions, Input, Modal, Space, Tag, Typography } from 'antd';

const { Text } = Typography;
const NAME_ERROR_ID = 'resume-candidate-name-error';

function extractionLabel(draft) {
  if (draft?.extraction_source === 'local_pdf_ocr') return { color: 'blue', text: 'PDF · 本地 OCR 已完成' };
  if (draft?.text_extracted) return { color: 'green', text: '正文已提取' };
  return { color: 'gold', text: '仅附件 · 请人工补全姓名' };
}

function ocrFailureText(code) {
  if (code === 'RESUME_PDF_TOOL_UNAVAILABLE') return 'PDF 处理工具缺失或不可运行。请安装或修复 Poppler（pdftotext、pdfinfo、pdftoppm）后重新选择文件；也可人工确认姓名，先按附件建档。';
  if (code === 'RESUME_OCR_UNAVAILABLE') return '本机没有可用的本地 OCR。请检查 OCR 工具后重新选择 PDF；仍可人工确认姓名后建档。';
  if (code === 'RESUME_OCR_EMPTY') return '已运行本地 OCR，但页面清晰度不足或没有识别到可用文字。';
  if (code === 'RESUME_OCR_PAGE_LIMIT') return 'PDF 页数超过本地 OCR 单次处理上限。';
  if (code === 'RESUME_OCR_TIMEOUT') return 'PDF 正文提取超时；可重新选择文件重试，或先按附件建档。';
  return code ? 'PDF 本地识别未完成；仍可人工确认姓名后建档。' : '';
}

export default function ResumeCandidateImportModal({ open, draft, busy, onCancel, onConfirm }) {
  const nameInputRef = useRef(null);
  const submitErrorRef = useRef(null);
  const submittingRef = useRef(false);
  const [fields, setFields] = useState({ name: '', age: '', degree: '', school: '', work_years: '', salary: '' });
  const [error, setError] = useState('');
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    setFields({
      name: draft?.fields?.name || '',
      age: draft?.fields?.age || '',
      degree: draft?.fields?.degree || '',
      school: draft?.fields?.school || '',
      work_years: draft?.fields?.work_years || '',
      salary: draft?.fields?.salary || '',
    });
    setError('');
    setSubmitError('');
  }, [draft?.draft_id]);

  function update(key, value) {
    setFields((current) => ({ ...current, [key]: value }));
    if (key === 'name' && value.trim()) setError('');
  }

  function focusNameInput() {
    const focus = () => nameInputRef.current?.focus({ cursor: 'end' });
    if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(focus);
    else globalThis.setTimeout(focus, 0);
  }

  function focusSubmitError() {
    const focus = () => submitErrorRef.current?.focus();
    if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(focus);
    else globalThis.setTimeout(focus, 0);
  }

  async function confirm() {
    if (busy || submittingRef.current) return;
    if (!fields.name.trim()) {
      setError('请确认候选人姓名后再建档。');
      focusNameInput();
      return;
    }
    setSubmitError('');
    submittingRef.current = true;
    try {
      await onConfirm?.({ ...fields, name: fields.name.trim() });
    } catch (submitFailure) {
      setSubmitError(submitFailure?.message || '简历建档失败，请检查后重试。');
      focusSubmitError();
    } finally {
      submittingRef.current = false;
    }
  }

  const status = extractionLabel(draft);
  return (
    <Modal
      className="resume-intake-modal"
      classNames={{
        body: 'resume-intake-modal-body',
        content: 'resume-intake-modal-content',
        header: 'resume-intake-modal-header',
        footer: 'resume-intake-modal-footer',
      }}
      title="确认简历建档"
      open={open}
      confirmLoading={busy}
      okText="确认建档"
      cancelText="取消"
      onOk={confirm}
      onCancel={(event) => { if (!busy) onCancel?.(event); }}
      afterOpenChange={(visible) => {
        if (visible && !fields.name.trim()) focusNameInput();
      }}
      keyboard={!busy}
      focusTriggerAfterClose
      closable={!busy}
      maskClosable={!busy}
      okButtonProps={{ disabled: busy }}
      cancelButtonProps={{ disabled: busy }}
      width={720}
      style={{ top: 32 }}
      styles={{
        body: {
          maxHeight: 'calc(100dvh - 180px)',
          overflowY: 'auto',
        },
      }}
    >
      <Space className="resume-intake-content" direction="vertical" size={10} style={{ width: '100%' }}>
        {submitError && (
          <div ref={submitErrorRef} role="alert" tabIndex={-1} aria-live="assertive">
            <Alert
              className="resume-intake-submit-error resume-intake-alert"
              type="error"
              showIcon
              message="简历建档失败，草稿仍保留"
              description={submitError}
            />
          </div>
        )}
        <Alert
          className="resume-intake-guidance resume-intake-alert"
          type="info"
          showIcon
          message="只创建当前岗位的本地候选人记录"
          description="请校对姓名和基础信息。确认后绑定原始简历，但不会自动评级、改变状态、联系候选人或调用 AI。"
        />
        <Descriptions
          className="resume-intake-meta"
          classNames={{
            label: 'resume-intake-meta-label',
            content: 'resume-intake-meta-content',
          }}
          size="small"
          column={1}
          bordered
        >
          <Descriptions.Item label="岗位">{draft?.job_name || `岗位 ${draft?.job_id || ''}`}</Descriptions.Item>
          <Descriptions.Item label="文件">{draft?.file_name || '--'}</Descriptions.Item>
          <Descriptions.Item label="识别状态"><Tag color={status.color}>{status.text}</Tag></Descriptions.Item>
        </Descriptions>
        {draft?.ocr_error_code && (
          <Alert
            className="resume-intake-warning resume-intake-alert"
            type="warning"
            showIcon
            message="PDF 正文提取未完成"
            description={ocrFailureText(draft.ocr_error_code)}
          />
        )}
        <div className="resume-intake-fields">
          <label>
            <Text strong>候选人姓名 *</Text>
            <Input
              id="resume-candidate-name"
              ref={nameInputRef}
              value={fields.name}
              status={error ? 'error' : ''}
              aria-required="true"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? NAME_ERROR_ID : undefined}
              disabled={busy}
              onChange={(event) => update('name', event.target.value)}
              placeholder="请核对或填写姓名"
              maxLength={80}
            />
            {error && <Text id={NAME_ERROR_ID} role="alert" type="danger">{error}</Text>}
          </label>
          <label><Text>年龄</Text><Input value={fields.age} disabled={busy} onChange={(event) => update('age', event.target.value)} placeholder="可留空" maxLength={30} /></label>
          <label><Text>学历</Text><Input value={fields.degree} disabled={busy} onChange={(event) => update('degree', event.target.value)} placeholder="可留空" maxLength={30} /></label>
          <label><Text>院校</Text><Input value={fields.school} disabled={busy} onChange={(event) => update('school', event.target.value)} placeholder="可留空" maxLength={120} /></label>
          <label><Text>工作年限</Text><Input value={fields.work_years} disabled={busy} onChange={(event) => update('work_years', event.target.value)} placeholder="可留空" maxLength={30} /></label>
          <label><Text>期望薪资</Text><Input value={fields.salary} disabled={busy} onChange={(event) => update('salary', event.target.value)} placeholder="可留空" maxLength={40} /></label>
        </div>
        {draft?.text_preview && (
          <div className="resume-intake-preview-block">
            <Text strong>识别正文预览</Text>
            <pre className="resume-intake-preview">{draft.text_preview}</pre>
          </div>
        )}
      </Space>
    </Modal>
  );
}
