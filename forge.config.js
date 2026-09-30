const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function installTargetNativeBinary(_forgeConfig, { platform, arch, outputPaths }) {
  if (platform !== 'win32') return;
  const prebuildInstall = require.resolve('prebuild-install/bin.js');
  for (const outputPath of outputPaths) {
    const moduleDir = path.join(outputPath, 'resources', 'app', 'node_modules', 'better-sqlite3');
    const binary = path.join(moduleDir, 'build', 'Release', 'better_sqlite3.node');
    fs.rmSync(binary, { force: true });
    const result = spawnSync(process.execPath, [
      prebuildInstall,
      '--runtime=electron',
      '--target=42.5.1',
      `--platform=${platform}`,
      `--arch=${arch}`,
    ], {
      cwd: moduleDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_runtime: 'electron',
        npm_config_target: '42.5.1',
        npm_config_platform: platform,
        npm_config_arch: arch,
      },
    });
    if (result.status !== 0) {
      throw new Error(`无法安装 Windows better-sqlite3 预编译文件：${result.stderr || result.stdout}`);
    }
    const signature = fs.readFileSync(binary).subarray(0, 2).toString('ascii');
    if (signature !== 'MZ') throw new Error('Windows 包中的 better_sqlite3.node 不是 PE/COFF 文件。');
  }
}

module.exports = {
  outDir: path.join(__dirname, 'dist'),
  packagerConfig: {
    // 外部 Python/Swift/CLI 仍需读取资源真实路径；首个 Windows 验证版先不用 asar。
    asar: false,
    executableName: 'ZhaocaiGuan',
    appBundleId: 'io.talentbench.desktop',
    appCategoryType: 'public.app-category.business',
    icon: path.join(__dirname, 'assets', 'app-icon.icns'),
    extendInfo: {
      NSMicrophoneUsageDescription: '用于经明确授权的本地面试录音和转写。',
    },
    ignore: [
      /^\/data(?:\/|$)/,
      /^\/tmp(?:\/|$)/,
      /^\/deliverables(?:\/|$)/,
      /^\/dist(?:\/|$)/,
      /^\/fix-evidence(?:\/|$)/,
      /^\/out(?:\/|$)/,
      /^\/\.runtime(?:\/|$)/,
      /^\/\.DS_Store$/,
      /^\/\.github(?:\/|$)/,
      /^\/\.impeccable(?:\/|$)/,
      /^\/\.gitattributes$/,
      /^\/\.gitignore$/,
      /^\/forge\.config\.js$/,
      /^\/(?:.*\/)?\.env(?:\..*)?$/,
      /^\/(?:.*\/)?\.npmrc$/,
      /^\/(?:.*\/)?[^/]+\.(?:pem|key|p12|pfx|crt|cer|mobileprovision)$/i,
      /^\/(?:.*\/)?[^/]+\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i,
      /^\/electron-spike(?:\/|$)/,
      /^\/checks(?:\/|$)/,
      /^\/frontend\/(?!dist(?:\/|$))/,
      /^\/release(?:\/|$)/,
      /^\/handoff(?:\/|$)/,
      /^\/check-[^/]+\.js$/,
      /^\/create-ui-fixture-db\.js$/,
      /^\/rating-config\.json$/,
      /^\/[^/]+\.md$/i,
    ],
  },
  rebuildConfig: {},
  hooks: {
    postPackage: installTargetNativeBinary,
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'zhaocai_guan',
        setupExe: 'ZhaocaiGuan-Setup.exe',
      },
    },
  ],
};
