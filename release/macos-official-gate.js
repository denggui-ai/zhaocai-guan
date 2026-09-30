#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ENTITLEMENTS = path.join(__dirname, 'macos-official-entitlements.plist');
const PRODUCTION_TOOLS = Object.freeze({
  codesign: '/usr/bin/codesign',
  ditto: '/usr/bin/ditto',
  spctl: '/usr/sbin/spctl',
  xcrun: '/usr/bin/xcrun',
});

function fail(message) {
  throw new Error(message);
}

function readReleaseConfiguration(env = process.env) {
  const identity = String(env.HRBOSS_MAC_DEVELOPER_ID_APPLICATION || '').trim();
  const notaryProfile = String(env.HRBOSS_MAC_NOTARY_PROFILE || '').trim();
  const identityMatch = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/.exec(identity);
  if (!identityMatch) {
    fail(
      'HRBOSS_MAC_DEVELOPER_ID_APPLICATION must be an explicit '
      + '"Developer ID Application: … (TEAMID)" identity; ad-hoc signing is forbidden.',
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(notaryProfile)) {
    fail(
      'HRBOSS_MAC_NOTARY_PROFILE must name a notarytool keychain profile '
      + 'using only letters, digits, dot, underscore, or hyphen.',
    );
  }
  return {
    identity,
    notaryProfile,
    teamId: identityMatch[1],
  };
}

function assertExecutable(filePath, label) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
  } catch {
    fail(`${label} is unavailable or is not executable: ${filePath}`);
  }
}

function resolveTools(env = process.env) {
  const offlineTest = env.HRBOSS_MAC_OFFICIAL_OFFLINE_TEST === '1';
  const fixtureGate = env.HRBOSS_UI_FIXTURE_GATE === '1';
  const requestedToolRoot = String(env.HRBOSS_MAC_OFFICIAL_TOOL_ROOT || '').trim();

  if (!offlineTest && requestedToolRoot) {
    fail('HRBOSS_MAC_OFFICIAL_TOOL_ROOT is forbidden outside the explicit offline-test gate.');
  }
  if (offlineTest !== fixtureGate) {
    fail('Offline official-release tooling requires both HRBOSS_MAC_OFFICIAL_OFFLINE_TEST=1 and HRBOSS_UI_FIXTURE_GATE=1.');
  }
  if (!offlineTest) {
    for (const [label, filePath] of Object.entries(PRODUCTION_TOOLS)) assertExecutable(filePath, label);
    return { ...PRODUCTION_TOOLS, offlineTest: false };
  }
  if (!path.isAbsolute(requestedToolRoot)) {
    fail('HRBOSS_MAC_OFFICIAL_TOOL_ROOT must be an absolute directory inside the system temporary root.');
  }

  let toolRoot;
  let temporaryRoot;
  try {
    toolRoot = fs.realpathSync(requestedToolRoot);
    temporaryRoot = fs.realpathSync(os.tmpdir());
  } catch {
    fail('Offline official-release tool root could not be resolved.');
  }
  if (toolRoot !== temporaryRoot && !toolRoot.startsWith(`${temporaryRoot}${path.sep}`)) {
    fail('Offline official-release tool root must remain inside the system temporary root.');
  }

  const tools = {
    codesign: path.join(toolRoot, 'codesign'),
    ditto: path.join(toolRoot, 'ditto'),
    signer: path.join(toolRoot, 'electron-osx-sign'),
    spctl: path.join(toolRoot, 'spctl'),
    xcrun: path.join(toolRoot, 'xcrun'),
    offlineTest: true,
  };
  for (const [label, filePath] of Object.entries(tools)) {
    if (label !== 'offlineTest') assertExecutable(filePath, label);
  }
  return tools;
}

function runExternal(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    env: options.env || process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) fail(`${path.basename(binary)} could not be started: ${result.error.message}`);
  if (result.status !== 0) {
    const diagnostic = `${result.stderr || ''}${result.stdout || ''}`.trim().slice(-4000);
    fail(`${path.basename(binary)} failed with exit ${result.status}${diagnostic ? `: ${diagnostic}` : ''}`);
  }
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function assertAppPath(appPath) {
  if (!path.isAbsolute(appPath) || path.extname(appPath) !== '.app') {
    fail('Official release app path must be an absolute .app directory.');
  }
  let stat;
  try {
    stat = fs.statSync(appPath);
  } catch {
    fail(`Official release app does not exist: ${appPath}`);
  }
  if (!stat.isDirectory()) fail(`Official release app is not a directory: ${appPath}`);
}

function assertZipPath(zipPath) {
  if (!path.isAbsolute(zipPath) || path.extname(zipPath) !== '.zip') {
    fail('Notary submission path must be an absolute .zip path.');
  }
  if (fs.existsSync(zipPath)) fail(`Refusing to overwrite an existing notary submission: ${zipPath}`);
}

function assertDmgPath(dmgPath) {
  if (!path.isAbsolute(dmgPath) || path.extname(dmgPath) !== '.dmg') {
    fail('Official disk image path must be an absolute .dmg file.');
  }
  let stat;
  try {
    stat = fs.statSync(dmgPath);
  } catch {
    fail(`Official disk image does not exist: ${dmgPath}`);
  }
  if (!stat.isFile()) fail(`Official disk image is not a file: ${dmgPath}`);
}

function verifyDeveloperIdArtifact(artifactPath, config, tools, { deep, requireRuntime }) {
  const verificationArgs = ['--verify'];
  if (deep) verificationArgs.push('--deep');
  verificationArgs.push('--strict', '--verbose=4', artifactPath);
  runExternal(tools.codesign, verificationArgs);
  const displayed = runExternal(
    tools.codesign,
    ['--display', '--verbose=4', artifactPath],
  );
  const details = `${displayed.stdout}\n${displayed.stderr}`;
  if (!/Authority=Developer ID Application:/.test(details)) {
    fail('Signed artifact is not backed by a Developer ID Application authority.');
  }
  if (!details.includes(`TeamIdentifier=${config.teamId}`)) {
    fail(`Signed artifact TeamIdentifier does not match configured team ${config.teamId}.`);
  }
  if (requireRuntime && !/(?:flags=.*\bruntime\b|Runtime Version=)/i.test(details)) {
    fail('Signed app does not report Hardened Runtime.');
  }
}

function verifyDeveloperIdApp(appPath, config, tools) {
  verifyDeveloperIdArtifact(appPath, config, tools, { deep: true, requireRuntime: true });
}

function verifyDeveloperIdDmg(dmgPath, config, tools) {
  verifyDeveloperIdArtifact(dmgPath, config, tools, { deep: false, requireRuntime: false });
}

function verifyNotarizedApp(appPath, config, tools, env = process.env) {
  verifyDeveloperIdApp(appPath, config, tools);
  runExternal(tools.xcrun, ['stapler', 'validate', appPath], { env });
  runExternal(tools.spctl, ['--assess', '--type', 'execute', '--verbose=4', appPath], { env });
}

function buildOsxSignOptions(appPath, config) {
  const normalizedAppPath = path.resolve(appPath);
  return {
    app: normalizedAppPath,
    identity: config.identity,
    platform: 'darwin',
    type: 'distribution',
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: (filePath) => {
      const fileOptions = { hardenedRuntime: true };
      if (path.resolve(filePath) === normalizedAppPath) fileOptions.entitlements = ENTITLEMENTS;
      return fileOptions;
    },
  };
}

async function signDeveloperIdApp(appPath, config, tools, env = process.env) {
  if (tools.offlineTest) {
    runExternal(tools.signer, [
      appPath,
      `--identity=${config.identity}`,
      '--platform=darwin',
      '--type=distribution',
      '--hardened-runtime',
      '--timestamp',
      `--entitlements=${ENTITLEMENTS}`,
      '--no-pre-auto-entitlements',
      '--no-pre-embed-provisioning-profile',
    ], { env });
  } else {
    const { signAsync } = require('@electron/osx-sign');
    await signAsync(buildOsxSignOptions(appPath, config));
  }
  verifyDeveloperIdApp(appPath, config, tools);
}

function parseAcceptedNotaryResult(rawOutput) {
  let parsed;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    fail('notarytool did not return valid JSON; formal release is blocked.');
  }
  if (parsed?.status !== 'Accepted') {
    fail(`notarytool status is ${JSON.stringify(parsed?.status || 'Unknown')}, not Accepted.`);
  }
  return parsed;
}

function notarizeAndStapleApp(appPath, submissionZip, config, tools, env = process.env) {
  runExternal(tools.ditto, [
    '-c',
    '-k',
    '--sequesterRsrc',
    '--keepParent',
    appPath,
    submissionZip,
  ], { env });
  const notarization = runExternal(tools.xcrun, [
    'notarytool',
    'submit',
    submissionZip,
    '--keychain-profile',
    config.notaryProfile,
    '--wait',
    '--output-format',
    'json',
  ], { env });
  const result = parseAcceptedNotaryResult(notarization.stdout);
  runExternal(tools.xcrun, ['stapler', 'staple', appPath], { env });
  runExternal(tools.xcrun, ['stapler', 'validate', appPath], { env });
  runExternal(tools.spctl, ['--assess', '--type', 'execute', '--verbose=4', appPath], { env });
  verifyDeveloperIdApp(appPath, config, tools);
  process.stdout.write(`Notarization Accepted${result.id ? ` (${result.id})` : ''}; ticket stapled and validated.\n`);
}

function notarizeAndStapleDmg(dmgPath, config, tools, env = process.env) {
  runExternal(tools.codesign, [
    '--force',
    '--sign',
    config.identity,
    '--timestamp',
    dmgPath,
  ], { env });
  verifyDeveloperIdDmg(dmgPath, config, tools);
  const notarization = runExternal(tools.xcrun, [
    'notarytool',
    'submit',
    dmgPath,
    '--keychain-profile',
    config.notaryProfile,
    '--wait',
    '--output-format',
    'json',
  ], { env });
  const result = parseAcceptedNotaryResult(notarization.stdout);
  runExternal(tools.xcrun, ['stapler', 'staple', dmgPath], { env });
  runExternal(tools.xcrun, ['stapler', 'validate', dmgPath], { env });
  runExternal(tools.spctl, [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    '--verbose=4',
    dmgPath,
  ], { env });
  verifyDeveloperIdDmg(dmgPath, config, tools);
  process.stdout.write(`DMG notarization Accepted${result.id ? ` (${result.id})` : ''}; ticket stapled and validated.\n`);
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, appPath, submissionZip] = argv;
  const config = readReleaseConfiguration(env);
  const tools = resolveTools(env);
  if (!fs.existsSync(ENTITLEMENTS)) fail(`Official release entitlements are missing: ${ENTITLEMENTS}`);

  if (command === 'preflight') {
    if (!tools.offlineTest) require.resolve('@electron/osx-sign');
    process.stdout.write('Official macOS release preflight PASS (configuration and tools only; no signing performed).\n');
    return;
  }

  if (command === 'notarize-dmg') {
    assertDmgPath(appPath);
    notarizeAndStapleDmg(appPath, config, tools, env);
    return;
  }
  assertAppPath(appPath);
  if (command === 'sign-app') {
    await signDeveloperIdApp(appPath, config, tools, env);
    process.stdout.write('Developer ID Application signature and Hardened Runtime verified.\n');
    return;
  }
  if (command === 'verify-app') {
    verifyDeveloperIdApp(appPath, config, tools);
    return;
  }
  if (command === 'verify-notarized-app') {
    verifyNotarizedApp(appPath, config, tools, env);
    return;
  }
  if (command === 'notarize-app') {
    assertZipPath(submissionZip);
    notarizeAndStapleApp(appPath, submissionZip, config, tools, env);
    return;
  }
  fail('Usage: macos-official-gate.js preflight|sign-app APP|verify-app APP|verify-notarized-app APP|notarize-app APP SUBMISSION_ZIP|notarize-dmg DMG');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildOsxSignOptions,
  main,
  notarizeAndStapleApp,
  notarizeAndStapleDmg,
  parseAcceptedNotaryResult,
  readReleaseConfiguration,
  resolveTools,
  signDeveloperIdApp,
  verifyDeveloperIdApp,
  verifyNotarizedApp,
};
