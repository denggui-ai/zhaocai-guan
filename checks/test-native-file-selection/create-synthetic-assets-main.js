'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const syntheticRoot = fs.realpathSync(path.resolve(process.env.HRBOSS_B1_SYNTHETIC_ROOT || ''));
const screenshotDir = path.join(syntheticRoot, 'screenshots');
const userData = path.join(syntheticRoot, 'asset-user-data');
fs.mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') {
  fs.chmodSync(screenshotDir, 0o700);
  fs.chmodSync(userData, 0o700);
}
app.setPath('userData', userData);
app.disableHardwareAcceleration();

function writePrivate(target, bytes) {
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
}

async function loadHtml(win, name, html) {
  const target = path.join(syntheticRoot, name);
  writePrivate(target, html);
  await win.loadURL(pathToFileURL(target).toString());
  await new Promise((resolve) => setTimeout(resolve, 250));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await loadHtml(win, 'synthetic-boss-card.html', `<!doctype html>
    <html lang="zh-CN"><meta charset="utf-8">
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 900px; height: 1200px; background: #fff; color: #111; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
      main { padding: 36px 58px; }
      h1 { margin: 0; font-size: 58px; line-height: 1.15; font-weight: 800; }
      h2 { margin: 48px 0 0; font-size: 52px; line-height: 1.15; font-weight: 750; }
      .facts { margin-top: 90px; font-size: 40px; line-height: 1.5; font-weight: 650; }
      .section { margin-top: 64px; font-size: 40px; line-height: 1.55; }
      .section strong { display: block; font-size: 44px; margin-bottom: 12px; }
      .synthetic { position: fixed; right: 36px; bottom: 28px; color: #666; font-size: 24px; }
    </style>
    <main>
      <h1>李合成</h1>
      <h2>合成 OCR 测试岗位</h2>
      <div class="facts">5年 · 本科 · 28岁 · 20K-25K<br>离职-随时到岗</div>
      <div class="section"><strong>工作经历</strong>合成本地软件公司<br>Electron 与 React 测试工程</div>
      <div class="section"><strong>教育经历</strong>合成测试大学 · 本科</div>
      <div class="synthetic">仅供 HRBOSS 自动化测试的合成截图</div>
    </main></html>`);
  const image = await win.webContents.capturePage();
  writePrivate(path.join(screenshotDir, 'synthetic-boss-candidate.png'), image.toPNG());

  await loadHtml(win, 'synthetic-assessment.html', `<!doctype html>
    <html lang="zh-CN"><meta charset="utf-8">
    <style>
      body { padding: 54px; color: #111; font-family: "PingFang SC", sans-serif; font-size: 20px; line-height: 1.7; }
      h1 { font-size: 34px; } h2 { margin-top: 28px; font-size: 25px; }
      .stamp { margin-top: 80px; padding: 14px; border: 2px solid #555; }
    </style>
    <h1>职业潜能测评报告</h1>
    <p>姓名：合成简历候选人 性别：未提供</p>
    <p>岗位：截图导入 · 合成OCR测试岗位</p>
    <p>测评日期：2026-07-29</p>
    <p>信效度：合成样本</p>
    <h2>潜能排列</h2>
    <p>学习能力 4</p><p>协作能力 3</p><p>执行能力 3</p>
    <h2>职业匹配-总览</h2>
    <p>本合成报告仅验证本地 PDF 导入、分析与 HR 人工绑定，不代表真实测评、评分、排序或招聘建议。</p>
    <div class="stamp">SYNTHETIC TEST DATA · 不含真实候选人信息</div>
    </html>`);
  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A4',
    margins: { top: 0.2, bottom: 0.2, left: 0.2, right: 0.2 },
  });
  writePrivate(path.join(syntheticRoot, 'synthetic-assessment.pdf'), pdf);
  win.destroy();
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  app.exit(1);
});
