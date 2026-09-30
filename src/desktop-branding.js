
const { PROJECT_ROOT } = require("./paths");
const path = require('path');
const { nativeImage } = require('electron');

const APP_NAME = '招才官';
const DEVELOPER_NAME = 'Zhaocai Guan contributors';
// Keep the installed application identity stable across display-name changes.
const APP_ID = 'io.talentbench.desktop';

const APP_ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="140" y1="100" x2="880" y2="930" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0B2A30"/>
      <stop offset="0.55" stop-color="#0C3B3C"/>
      <stop offset="1" stop-color="#0A1F2B"/>
    </linearGradient>
    <linearGradient id="figure" x1="300" y1="250" x2="720" y2="800" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#F8FAFC"/>
      <stop offset="1" stop-color="#BFEFE7"/>
    </linearGradient>
    <linearGradient id="bench" x1="232" y1="0" x2="792" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2DD4BF"/>
      <stop offset="1" stop-color="#0E9F8E"/>
    </linearGradient>
    <clipPath id="above-bench">
      <rect x="0" y="0" width="1024" height="742"/>
    </clipPath>
  </defs>

  <rect width="1024" height="1024" rx="228" fill="url(#bg)"/>
  <rect x="60" y="60" width="904" height="904" rx="180" fill="none" stroke="#FFFFFF" stroke-opacity="0.07" stroke-width="12"/>

  <!-- person: head and shoulders, cut flat where they meet the bench -->
  <g clip-path="url(#above-bench)">
    <circle cx="476" cy="382" r="122" fill="url(#figure)"/>
    <path d="M232 800c0-150 108-246 244-246s244 96 244 246z" fill="url(#figure)"/>
  </g>

  <!-- bench -->
  <rect x="200" y="742" width="624" height="58" rx="29" fill="url(#bench)"/>

  <!-- spark: the moment of spotting talent -->
  <path d="M742 176c10 66 34 90 100 100-66 10-90 34-100 100-10-66-34-90-100-100 66-10 90-34 100-100z" fill="#F5D36B"/>
  <circle cx="846" cy="408" r="17" fill="#F5D36B" opacity="0.8"/>
</svg>`;

function createAppIcon() {
  const pngIcon = path.join(PROJECT_ROOT, 'assets', 'app-icon.png');
  const fileIcon = nativeImage.createFromPath(pngIcon);
  if (!fileIcon.isEmpty()) return fileIcon;
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;charset=UTF-8,${encodeURIComponent(APP_ICON_SVG)}`);
  return icon.isEmpty() ? undefined : icon;
}

function applyAppBranding(app) {
  app.setName(APP_NAME);
  app.setAppUserModelId(APP_ID);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: `© ${DEVELOPER_NAME}`,
  });
}

function applyDockBranding(app) {
  const icon = createAppIcon();
  if (process.platform === 'darwin' && app.dock && icon) {
    app.dock.setIcon(icon);
  }
  return icon;
}

module.exports = {
  APP_ID,
  APP_NAME,
  DEVELOPER_NAME,
  applyAppBranding,
  applyDockBranding,
  createAppIcon,
};
