'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installRuntimeController({
  app,
  BrowserWindow,
  syntheticRoot,
  candidateCount,
}) {
  const resultPath = path.join(syntheticRoot, 'renderer-result.json');
  const evidenceDir = path.join(syntheticRoot, 'evidence');

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
    while (Date.now() < deadline) {
      try {
        if (await evaluate(win, `Boolean(${expression})`)) return;
      } catch {}
      await delay(40);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async function clickExactText(win, selector, value) {
    const state = await evaluate(win, `(() => {
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.offsetParent !== null
          && (element.textContent || '').trim() === ${JSON.stringify(value)});
      if (target) {
        target.scrollIntoView({ block: 'center', inline: 'nearest' });
        target.focus();
        target.click();
      }
      return {
        clicked: Boolean(target),
        labels: [...document.querySelectorAll(${JSON.stringify(selector)})]
          .filter((element) => element.offsetParent !== null)
          .map((element) => (element.textContent || '').trim()),
      };
    })()`);
    assert.equal(state.clicked, true, `missing visible control ${value}; labels=${JSON.stringify(state.labels)}`);
  }

  async function setSearch(win, value) {
    const changed = await evaluate(win, `(() => {
      const input = document.querySelector('input[aria-label="搜索候选人"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    assert.equal(changed, true, 'candidate search input must exist');
  }

  async function snapshot(win) {
    return evaluate(win, `(() => ({
      viewport: [innerWidth, innerHeight],
      meta: document.querySelector('.candidate-list-meta')?.textContent.trim() || '',
      card_count: document.querySelectorAll('.candidate-card').length,
      names: [...document.querySelectorAll('.candidate-card .candidate-name')]
        .map((element) => (element.textContent || '').trim()),
      body_scroll_width: document.body.scrollWidth,
      body_client_width: document.body.clientWidth,
    }))()`);
  }

  async function capture(win, name) {
    await delay(120);
    const image = await win.capturePage();
    const target = path.join(evidenceDir, `${name}.png`);
    fs.writeFileSync(target, image.toPNG(), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
    return path.basename(target);
  }

  async function runJourney() {
    const win = await waitForWindow();
    win.webContents.setBackgroundThrottling(false);
    win.setContentSize(1280, 800);
    win.show();
    win.focus();
    await waitFor(win, 'Boolean(window.localApi?.request)', 'trusted local API bridge', 45_000);
    await waitFor(win, "document.querySelector('button.nav-item')", 'main navigation', 45_000);

    const totalPages = candidateCount / 10;
    const initialStarted = process.hrtime.bigint();
    await clickExactText(win, 'button.nav-item', '候选人');
    await waitFor(
      win,
      `document.querySelector('.candidate-list-meta')?.textContent.includes(${JSON.stringify(`${candidateCount} 人`)})
        && document.querySelector('.candidate-list-meta')?.textContent.includes(${JSON.stringify(`第 1/${totalPages} 页`)})
        && document.querySelectorAll('.candidate-card').length === 10`,
      `${candidateCount}-candidate first page`,
      45_000,
    );
    const initialInteractiveMs = Number(process.hrtime.bigint() - initialStarted) / 1_000_000;
    const pageOne = await snapshot(win);
    assert.deepEqual(pageOne.viewport, [1280, 800]);
    assert.equal(pageOne.card_count, 10);
    assert.ok(pageOne.body_scroll_width <= pageOne.body_client_width + 1);

    const uniqueName = `B-14 唯一命中 ${candidateCount}`;
    const searchStarted = process.hrtime.bigint();
    await setSearch(win, uniqueName);
    await waitFor(
      win,
      `document.querySelector('.candidate-list-meta')?.textContent.includes('1 人')
        && document.querySelectorAll('.candidate-card').length === 1
        && document.querySelector('.candidate-card .candidate-name')?.textContent.trim() === ${JSON.stringify(uniqueName)}`,
      `${candidateCount}-candidate unique search`,
      10_000,
    );
    const searchFilterMs = Number(process.hrtime.bigint() - searchStarted) / 1_000_000;
    const searchResult = await snapshot(win);

    await setSearch(win, '');
    await waitFor(
      win,
      `document.querySelector('.candidate-list-meta')?.textContent.includes(${JSON.stringify(`${candidateCount} 人`)})
        && document.querySelector('.candidate-list-meta')?.textContent.includes(${JSON.stringify(`第 1/${totalPages} 页`)})
        && document.querySelectorAll('.candidate-card').length === 10`,
      `${candidateCount}-candidate search clear`,
      10_000,
    );
    const screenshot = candidateCount === 1000
      ? await capture(win, 'B-14-1000-candidates-paged-1280x800')
      : null;

    const paginationStarted = process.hrtime.bigint();
    await clickExactText(win, '.ant-pagination-item-2', '2');
    await waitFor(
      win,
      `document.querySelector('.candidate-list-meta')?.textContent.includes(${JSON.stringify(`第 2/${totalPages} 页`)})
        && document.querySelectorAll('.candidate-card').length === 10`,
      `${candidateCount}-candidate second page`,
      10_000,
    );
    const paginationMs = Number(process.hrtime.bigint() - paginationStarted) / 1_000_000;
    const pageTwo = await snapshot(win);
    assert.equal(pageOne.names.some((name) => pageTwo.names.includes(name)), false);

    return {
      ok: true,
      evidence_level: 'E4',
      runtime_boundary: 'real HRBOSS Electron + trusted preload + authenticated local API + temporary SQLite/WAL',
      synthetic_data_only: true,
      external_services_accessed: false,
      candidate_count: candidateCount,
      initial_interactive_ms: Number(initialInteractiveMs.toFixed(3)),
      search_filter_ms: Number(searchFilterMs.toFixed(3)),
      pagination_ms: Number(paginationMs.toFixed(3)),
      page_one: pageOne,
      unique_search: searchResult,
      page_two: pageTwo,
      screenshot,
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
