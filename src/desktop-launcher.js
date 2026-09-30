
const { PROJECT_ROOT } = require("./paths");
const fs = require('fs');
const path = require('path');

const APP_NAME = '招才官';
const APP_ID = 'io.talentbench.desktop';
const LAUNCHER_VERSION = 'mac-brand-v3';

function replacePlistString(plist, key, value) {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
  return plist.replace(pattern, `$1${value}$3`);
}

function brandInfoPlist(infoPath) {
  let plist = fs.readFileSync(infoPath, 'utf8');
  plist = replacePlistString(plist, 'CFBundleDisplayName', APP_NAME);
  plist = replacePlistString(plist, 'CFBundleName', APP_NAME);
  plist = replacePlistString(plist, 'CFBundleIconFile', 'app-icon.icns');
  plist = replacePlistString(plist, 'CFBundleIdentifier', APP_ID);
  plist = replacePlistString(plist, 'LSApplicationCategoryType', 'public.app-category.business');
  fs.writeFileSync(infoPath, plist);
}

function ensureBrandedMacApp(electronExecutable) {
  const resolvedExecutable = path.resolve(String(electronExecutable || ''));
  const resolvedApp = path.resolve(path.dirname(resolvedExecutable), '..', '..');
  const resolvedInfo = path.join(resolvedApp, 'Contents', 'Info.plist');
  const bundledApp = path.join(PROJECT_ROOT, 'electron-spike', 'node_modules', 'electron', 'dist', 'Electron.app');
  const srcApp = fs.existsSync(resolvedInfo) ? resolvedApp : bundledApp;
  const srcInfo = path.join(srcApp, 'Contents', 'Info.plist');
  const runtimeDir = path.join(PROJECT_ROOT, '.runtime');
  const destApp = path.join(runtimeDir, `${APP_NAME}.app`);
  const destInfo = path.join(destApp, 'Contents', 'Info.plist');
  const destIcon = path.join(destApp, 'Contents', 'Resources', 'app-icon.icns');
  const brandedExe = path.join(destApp, 'Contents', 'MacOS', 'Electron');
  const stampFile = path.join(destApp, 'Contents', '.hrboss-brand-stamp');
  const sourceIcon = path.join(PROJECT_ROOT, 'assets', 'app-icon.icns');

  try {
    const srcStat = fs.statSync(srcInfo);
    const iconStamp = fs.existsSync(sourceIcon) ? fs.statSync(sourceIcon).mtimeMs : 'no-icon';
    const stamp = `${LAUNCHER_VERSION}\n${APP_NAME}\n${APP_ID}\n${srcStat.mtimeMs}\n${iconStamp}\n`;
    const needsRefresh =
      !fs.existsSync(brandedExe) ||
      !fs.existsSync(destInfo) ||
      !fs.existsSync(destIcon) ||
      !fs.existsSync(stampFile) ||
      fs.readFileSync(stampFile, 'utf8') !== stamp;

    if (needsRefresh) {
      fs.rmSync(destApp, { recursive: true, force: true });
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.cpSync(srcApp, destApp, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      brandInfoPlist(destInfo);
      if (fs.existsSync(sourceIcon)) fs.copyFileSync(sourceIcon, destIcon);
      fs.writeFileSync(stampFile, stamp);
    }
    return brandedExe;
  } catch (error) {
    console.warn(`使用默认 Electron 启动：${error.message}`);
    return electronExecutable;
  }
}

function getDesktopRuntimeExecutable(electronExecutable) {
  if (process.platform !== 'darwin') return electronExecutable;
  return ensureBrandedMacApp(electronExecutable);
}

module.exports = { getDesktopRuntimeExecutable };
