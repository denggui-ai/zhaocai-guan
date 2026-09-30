'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installRuntimeController({ app, BrowserWindow, syntheticRoot, selectionQueue }) {
  const resultPath = path.join(syntheticRoot, 'runtime-result.json');
  const evidenceDir = path.join(syntheticRoot, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(evidenceDir, 0o700);

  async function waitForWindow(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      if (win) return win;
      await delay(100);
    }
    throw new Error('timed out waiting for the HRBOSS main window');
  }

  async function evaluate(win, source) {
    return win.webContents.executeJavaScript(source, true);
  }

  async function waitFor(win, expression, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        if (await evaluate(win, `Boolean(${expression})`)) return;
      } catch (error) {
        lastError = error.message;
      }
      await delay(120);
    }
    throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError}` : ''}`);
  }

  async function clickExact(win, selector, text) {
    const clicked = await evaluate(win, `(() => {
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.offsetParent !== null && (element.textContent || '').trim() === ${JSON.stringify(text)});
      if (!target) return false;
      target.focus();
      target.click();
      return true;
    })()`);
    assert.equal(clicked, true, `missing visible clickable text: ${text}`);
  }

  async function clickContaining(win, selector, text) {
    const clicked = await evaluate(win, `(() => {
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.offsetParent !== null && (element.textContent || '').includes(${JSON.stringify(text)}));
      if (!target) return false;
      target.focus();
      target.click();
      return true;
    })()`);
    assert.equal(clicked, true, `missing visible clickable text containing: ${text}`);
  }

  async function setInput(win, selector, value) {
    const changed = await evaluate(win, `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input || input.offsetParent === null) return false;
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    assert.equal(changed, true, `missing visible input: ${selector}`);
  }

  async function capture(win, name) {
    win.setMinimumSize(900, 650);
    win.setContentSize(1280, 800);
    await delay(180);
    const image = await win.webContents.capturePage();
    const target = path.join(evidenceDir, `${name}.png`);
    fs.writeFileSync(target, image.toPNG(), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
    return path.basename(target);
  }

  async function runJourney() {
    const win = await waitForWindow();
    await waitFor(win, "document.readyState === 'complete' && Boolean(document.querySelector('#root'))", 'renderer load');
    await waitFor(win, "[...document.querySelectorAll('button.nav-item')].some((el) => (el.textContent || '').trim() === '候选人')", 'candidate navigation');
    await clickExact(win, 'button.nav-item', '候选人');
    await waitFor(win, "Boolean(document.querySelector('.candidate-sider-toolbar button')?.offsetParent)", 'candidate workspace');

    await clickExact(win, '.candidate-sider-toolbar button', '上传简历建档');
    await waitFor(win, "Boolean(document.querySelector('.resume-intake-modal')?.offsetParent)", 'resume HR preview', 60_000);
    await waitFor(win, "document.querySelector('#resume-candidate-name')?.value === '合成简历候选人'", 'synthetic resume extraction');
    const resumePreviewEvidence = await capture(win, 'B-1-resume-preview-1280x800');
    const resumePreview = await evaluate(win, `(() => ({
      title: document.querySelector('.resume-intake-modal .ant-modal-title')?.textContent.trim(),
      name: document.querySelector('#resume-candidate-name')?.value,
      warning: document.querySelector('.resume-intake-guidance')?.textContent.trim(),
    }))()`);
    assert.equal(resumePreview.title, '确认简历建档');
    assert.match(resumePreview.warning, /不会自动评级、改变状态、联系候选人或调用 AI/);
    await clickExact(win, '.resume-intake-modal .ant-modal-footer button', '确认建档');
    await waitFor(win, "!document.querySelector('.resume-intake-modal')?.offsetParent", 'resume modal close', 60_000);
    await waitFor(win, "[...document.querySelectorAll('.candidate-card')].some((el) => (el.textContent || '').includes('合成简历候选人'))", 'resume candidate persistence');
    await waitFor(win, "(document.querySelector('.candidate-focus-identity')?.textContent || '').includes('合成简历候选人')", 'resume candidate selected detail');
    const resumeCommittedEvidence = await capture(win, 'B-1-resume-confirmed-selected-1280x800');

    await clickExact(win, '.candidate-module-actions button', '候选人操作');
    await waitFor(win, "[...document.querySelectorAll('.ant-dropdown-menu')].some((el) => el.offsetParent !== null && (el.textContent || '').includes('导入 Boss App 截图'))", 'candidate action menu');
    await clickExact(win, '.ant-dropdown-menu-item', '导入 Boss App 截图');
    // The folder picker is now preceded by the pre-import guidance, because the
    // rules it states are decided by what gets selected and cannot be fixed
    // afterwards. The picker must not open until the HR has acknowledged it.
    await waitFor(win, "Boolean(document.querySelector('.screenshot-import-guide')?.offsetParent)", 'screenshot import guidance');
    await clickExact(win, '.screenshot-import-guide .ant-modal-confirm-btns button', '选择截图文件夹');
    await waitFor(win, "Boolean(document.querySelector('.screenshot-ocr-review-modal')?.offsetParent)", 'OCR HR review', 180_000);
    await waitFor(win, "Boolean(document.querySelector('.screenshot-ocr-review-modal input[aria-label=\"姓名\"]')?.value)", 'OCR extracted draft');
    const ocrExtractedName = await evaluate(win, "document.querySelector('.screenshot-ocr-review-modal input[aria-label=\"姓名\"]')?.value || ''");
    assert.ok(ocrExtractedName, 'Vision OCR must produce a candidate name draft before HR confirmation');
    const changed = await evaluate(win, `(() => {
      const input = document.querySelector('.screenshot-ocr-review-modal input[aria-label="姓名"]');
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '李合成测试');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    assert.equal(changed, true, 'OCR name input must remain human-editable');
    const ocrReviewEvidence = await capture(win, 'B-1-ocr-human-review-1280x800');
    await clickExact(win, '.screenshot-ocr-review-modal button', '人工确认并入库');
    await waitFor(win, "(document.body.textContent || '').includes('已人工确认并写入正式候选人档案')", 'OCR commit feedback', 60_000);
    await waitFor(win, "![...document.querySelectorAll('.screenshot-ocr-review-modal button')].some((el) => (el.textContent || '').trim() === '人工确认并入库')", 'OCR draft confirmation', 60_000);
    await evaluate(win, `(() => {
      const modal = document.querySelector('.screenshot-ocr-review-modal');
      const button = modal?.querySelector('.ant-modal-close');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await delay(250);
    const staleEditPrompt = await evaluate(win, "[...document.querySelectorAll('.ant-modal-confirm')].some((el) => el.offsetParent !== null && (el.textContent || '').includes('当前 OCR 修改尚未保存'))");
    if (staleEditPrompt) await clickExact(win, '.ant-modal-confirm button', '放弃修改并关闭');
    await waitFor(win, "!document.querySelector('.screenshot-ocr-review-modal')?.offsetParent", 'OCR review close');
    await waitFor(win, "[...document.querySelectorAll('.candidate-card')].some((el) => (el.textContent || '').includes('李合成测试'))", 'OCR candidate list refresh', 60_000);
    await clickContaining(win, '.candidate-card', '李合成测试');
    await waitFor(win, "(document.querySelector('.candidate-focus-identity')?.textContent || '').includes('李合成测试')", 'OCR candidate selected detail');
    const ocrCommittedEvidence = await capture(win, 'B-1-ocr-confirmed-selected-1280x800');

    await clickContaining(win, '.candidate-card', '合成简历候选人');
    await waitFor(win, "(document.querySelector('.candidate-focus-identity')?.textContent || '').includes('合成简历候选人')", 'resume candidate reselected');
    await clickContaining(win, '.candidate-domain-navigation .ant-segmented-item', '测评');
    await waitFor(win, "[...document.querySelectorAll('.assessment-archive-panel button')].some((el) => (el.textContent || '').trim() === '批量导入 PDF' && !el.disabled)", 'assessment import readiness', 60_000);
    await clickExact(win, '.assessment-archive-panel button', '批量导入 PDF');
    await waitFor(win, "[...document.querySelectorAll('.ant-modal')].some((el) => el.offsetParent !== null && (el.textContent || '').includes('批量导入 PDF 测评报告'))", 'assessment import modal');
    const assessmentTypeOpened = await evaluate(win, `(() => {
      const input = document.querySelector('input[aria-label="批量导入报告类型"]');
      const selector = input?.closest('.ant-select')?.querySelector('.ant-select-selector');
      if (!selector) return false;
      selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      selector.click();
      return true;
    })()`);
    assert.equal(assessmentTypeOpened, true, 'assessment report type combobox must be reachable');
    await waitFor(win, "Boolean(document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')?.offsetParent)", 'assessment type options');
    await clickExact(win, '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', '职业潜力报告');
    await setInput(win, 'input[aria-label="批量导入测评日期"]', '2026-07-29');
    await clickExact(win, '.ant-modal-footer button', '选择 PDF（可多选）并导入');
    await waitFor(win, "[...document.querySelectorAll('.assessment-archive-panel button')].some((el) => (el.textContent || '').trim() === '人工确认绑定')", 'assessment pending HR binding', 180_000);
    const assessmentPendingEvidence = await capture(win, 'B-1-assessment-pending-confirmation-1280x800');
    await clickExact(win, '.assessment-archive-panel button', '人工确认绑定');
    await delay(250);
    const mismatchVisible = await evaluate(win, "[...document.querySelectorAll('.ant-modal-confirm')].some((el) => el.offsetParent !== null && (el.textContent || '').includes('报告姓名与候选人不一致'))");
    if (mismatchVisible) await clickExact(win, '.ant-modal-confirm button', '已核对，确认绑定');
    await waitFor(win, "[...document.querySelectorAll('.assessment-archive-panel button')].some((el) => (el.textContent || '').trim() === '查看 PNG 预览')", 'active assessment binding', 60_000);
    const assessmentActiveEvidence = await capture(win, 'B-1-assessment-active-1280x800');

    assert.equal(selectionQueue.remaining(), 0, 'every signed native dialog result must be consumed exactly once');
    return {
      ok: true,
      evidence: [
        resumePreviewEvidence,
        resumeCommittedEvidence,
        ocrReviewEvidence,
        ocrCommittedEvidence,
        assessmentPendingEvidence,
        assessmentActiveEvidence,
      ],
      resume: {
        extracted_name: resumePreview.name,
        human_confirmation: true,
        selected_detail_verified: true,
      },
      screenshot_ocr: {
        extracted_name: ocrExtractedName,
        human_corrected_name: '李合成测试',
        human_confirmation: true,
        selected_detail_verified: true,
      },
      assessment: {
        report_type: 'career_potential',
        human_binding_confirmation: true,
        active_preview_available: true,
      },
      signed_dialog_entries_remaining: selectionQueue.remaining(),
    };
  }

  app.whenReady().then(async () => {
    let result;
    try {
      result = await runJourney();
    } catch (error) {
      result = {
        ok: false,
        error: error && error.stack ? error.stack : String(error),
        signed_dialog_entries_remaining: selectionQueue.remaining(),
      };
    }
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(resultPath, 0o600);
    process.exitCode = result.ok ? 0 : 1;
    app.quit();
  });
}

module.exports = {
  installRuntimeController,
};
