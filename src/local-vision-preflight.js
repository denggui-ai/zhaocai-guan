'use strict';

const { execFile } = require('child_process');
const path = require('path');

const ERROR_CODE = 'SCREENSHOT_OCR_VISION_UNAVAILABLE';
const RECOVERY = '请在“终端”运行 xcode-select --install，完成安装后返回重试。已安装 Xcode 或命令行工具时，请检查 xcode-select 选择的开发者工具目录。';
const PROBE_OPTIONS = Object.freeze({ encoding: 'utf8', shell: false, timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024, windowsHide: true });

function runCommand(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout) => {
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout });
    });
  });
}

function unavailable(reason) {
  return { available: false, code: ERROR_CODE, message: `截图本地识别暂不可用：${reason}。${RECOVERY}` };
}

async function probeLocalVisionReadiness({ platform = process.platform, run = runCommand } = {}) {
  if (platform !== 'darwin') return unavailable('当前系统不支持 macOS Vision');
  const probes = [
    // Check selection before running Apple's Swift shim: on a machine without
    // CLT, invoking the shim can display the system installation dialog.
    ['/usr/bin/xcode-select', ['-p'], '未找到已配置的 Apple 命令行工具', (out) => path.isAbsolute(out.trim())],
    ['/usr/bin/xcrun', ['--find', 'swift'], '未找到可用的 Swift', (out) => path.isAbsolute(out.trim())],
    ['/usr/bin/swift', ['--version'], 'Swift 无法运行或检查超时', (out) => /\bSwift version\s+\d/i.test(out)],
    ['/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], '未找到可用的 macOS SDK', (out) => path.isAbsolute(out.trim())],
  ];
  for (const [command, args, reason, validOutput] of probes) {
    let result;
    try { result = await run(command, args, PROBE_OPTIONS); } catch { return unavailable(reason); }
    if (!result || result.status !== 0 || !validOutput(String(result.stdout || ''))) return unavailable(reason);
  }
  // This verifies the tools used by vision-ocr.swift, without compiling it or
  // reading any selected image. Do not cache failures; installation can finish
  // while the application is still running, and retry must probe again.
  return { available: true, engine: 'macos_vision' };
}

async function assertLocalVisionReady(options) {
  const result = await probeLocalVisionReadiness(options);
  if (!result.available) {
    const error = new Error(result.message);
    error.code = result.code;
    throw error;
  }
  return result;
}

module.exports = { assertLocalVisionReady, probeLocalVisionReadiness };
