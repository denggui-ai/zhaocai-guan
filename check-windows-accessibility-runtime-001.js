#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = __dirname;

function privateDirectory(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o700);
  return target;
}

function runSyncChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with ${result.signal || result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result;
}

function processTable() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('cannot snapshot the process table');
  return result.stdout.trim().split('\n').map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}

function descendantPids(rootPid, rows) {
  const owned = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.ppid) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
    }
  }
  owned.delete(rootPid);
  return owned;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopExactPids(pids) {
  const targets = [...pids]
    .filter((pid) => Number.isInteger(pid) && pid > 1 && isAlive(pid))
    .sort((left, right) => right - left);
  for (const pid of targets) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && targets.some(isAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  for (const pid of targets.filter(isAlive)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

async function runElectron(electronPath, args, env, timeoutMs, baselinePids) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, args, {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ownedPids = new Set([child.pid]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const monitor = setInterval(() => {
      for (const pid of descendantPids(child.pid, processTable())) {
        if (!baselinePids.has(pid)) ownedPids.add(pid);
      }
    }, 250);
    const timeout = setTimeout(async () => {
      clearInterval(monitor);
      await stopExactPids(ownedPids);
      reject(new Error(`B-15 Electron journey timed out\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.once('error', async (error) => {
      clearTimeout(timeout);
      clearInterval(monitor);
      await stopExactPids(ownedPids);
      reject(error);
    });
    child.once('exit', async (code, signal) => {
      clearTimeout(timeout);
      clearInterval(monitor);
      await new Promise((done) => setTimeout(done, 800));
      const survivors = [...ownedPids].filter((pid) => !baselinePids.has(pid) && isAlive(pid));
      await stopExactPids(survivors);
      resolve({ code, signal, stdout, stderr, survivors });
    });
  });
}

function copyEvidence(source, sourceRoot, targetRoot) {
  const resolvedSource = fs.realpathSync(source);
  const resolvedRoot = fs.realpathSync(sourceRoot);
  assert.ok(resolvedSource.startsWith(`${resolvedRoot}${path.sep}`), `evidence escaped synthetic root: ${resolvedSource}`);
  const target = path.join(targetRoot, path.basename(resolvedSource));
  fs.copyFileSync(resolvedSource, target);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  return path.basename(target);
}

async function run() {
  const createdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-b15-windows-a11y-'));
  const syntheticRoot = fs.realpathSync(createdRoot);
  if (process.platform !== 'win32') fs.chmodSync(syntheticRoot, 0o700);
  const keepArtifacts = process.env.HRBOSS_KEEP_B15_ARTIFACTS === '1';
  try {
    const distRoot = path.join(syntheticRoot, 'dist');
    const resultPath = path.join(syntheticRoot, 'result.json');
    const userData = privateDirectory(path.join(syntheticRoot, 'electron-user-data'));
    const runtimeEvidence = privateDirectory(path.join(syntheticRoot, 'runtime-evidence'));
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    runSyncChecked(npm, ['--prefix', 'frontend', 'run', 'build', '--', '--outDir', distRoot, '--emptyOutDir'], {
      env: {
        ...process.env,
        VITE_READONLY_UI: '0',
        HRBOSS_EXTERNAL_AI_ENABLED: '0',
        BOSS_ACTION_AUTOMATION_ENABLED: '0',
      },
      timeout: 120_000,
    });

    const electronPath = require('electron');
    assert.equal(typeof electronPath, 'string');
    const baselinePids = new Set(processTable().map((row) => row.pid));
    const runtimeEnv = {
      ...process.env,
      HRBOSS_VISUAL_RUNTIME_DIST: distRoot,
      HRBOSS_VISUAL_RUNTIME_RESULT: resultPath,
      HRBOSS_VISUAL_RUNTIME_USER_DATA: userData,
      HRBOSS_VISUAL_RUNTIME_EVIDENCE_DIR: runtimeEvidence,
      HRBOSS_EXTERNAL_AI_ENABLED: '0',
      BOSS_ACTION_AUTOMATION_ENABLED: '0',
    };
    delete runtimeEnv.ELECTRON_RUN_AS_NODE;
    const runtime = await runElectron(
      electronPath,
      [path.join(ROOT, 'check-ui-visual-runtime-main.js')],
      runtimeEnv,
      180_000,
      baselinePids,
    );
    assert.equal(fs.existsSync(resultPath), true, `missing visual runtime result\n${runtime.stderr}`);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(result.ok, true, result.error || runtime.stderr);
    assert.equal(runtime.code, 0, `visual runtime exited with ${runtime.signal || runtime.code}\n${runtime.stderr}`);
    assert.deepEqual(runtime.survivors, [], `spawned PID survivors: ${runtime.survivors.join(', ')}`);

    assert.equal(result.scaled_shell.zoomFactor, 1.25);
    assert.deepEqual(result.scaled_shell.electronContentSize, [1360, 768]);
    assert.deepEqual(result.scaled_shell.cssViewport, [1088, 614]);
    assert.ok(result.scaled_shell.document.overflow <= 1);
    const windowsMenu = result.candidate_disposition_menu['1360x768@125%'];
    assert.deepEqual(windowsMenu.viewport, [1088, 614]);
    assert.equal(windowsMenu.menuRole, 'menu');
    assert.deepEqual(windowsMenu.itemRoles, ['menuitem', 'menuitem', 'menuitem', 'menuitem']);
    assert.ok(windowsMenu.itemLayouts.every((item) => item.whiteSpace === 'nowrap'
      && item.width > 0 && item.height <= item.lineHeight + 1));
    assert.ok(windowsMenu.documentOverflow <= 1);
    assert.equal(windowsMenu.focus.label, '打开更多 HR 人工处置');
    assert.deepEqual(result.windows_125_candidate_toggle.viewport, [1088, 614]);
    assert.equal(result.windows_125_candidate_toggle.contained, true);
    assert.ok(result.windows_125_candidate_toggle.toolbarOverflow <= 1);
    assert.ok(result.windows_125_candidate_toggle.documentOverflow <= 1);

    assert.equal(result.skip_link_keyboard.focused.focusVisible, true);
    assert.deepEqual(result.skip_link_keyboard.activation, {
      id: 'main-workspace',
      tag: 'MAIN',
      visibleMainCount: 1,
    });
    assert.equal(result.candidate_roving_focus.role, 'option');
    assert.equal(result.candidate_roving_focus.tabStopCount, 1);
    assert.equal(result.candidate_roving_focus.focusVisible, true);
    assert.equal(result.candidate_enter_activation.selectedLabels.length, 1);
    assert.equal(result.candidate_space_activation.selectedLabels.length, 1);
    assert.equal(result.candidate_sider_focus.collapseFocused, true);
    assert.equal(result.candidate_sider_focus.restoreFocused, true);
    assert.ok(result.candidate_tab_journey.some((stop) => stop.region === 'taskbar'));
    assert.ok(result.candidate_tab_journey.some((stop) => stop.region === 'workspace'));

    assert.equal(result.chromium_accessibility_tree.source, 'Chromium Accessibility.getFullAXTree');
    assert.ok(result.chromium_accessibility_tree.node_count > 0);
    assert.ok(result.chromium_accessibility_tree.semantic_node_count > 0);
    assert.ok(Object.values(result.chromium_accessibility_tree.required_nodes).every(Boolean));

    const evidenceDirectory = privateDirectory(path.resolve(
      process.env.HRBOSS_B15_EVIDENCE_DIR || path.join(ROOT, 'fix-evidence', '20260729', 'B-15'),
    ));
    const screenshotSources = [
      result.skip_link_keyboard.evidence,
      result.evidence.candidate_keyboard_1100x720,
      result.candidate_disposition_menu['1360x768@125%'].evidence,
      result.evidence.candidate_windows_125_percent,
    ];
    const screenshots = screenshotSources.map((source) => copyEvidence(source, runtimeEvidence, evidenceDirectory));
    const { evidence: _windowsMenuEvidence, ...persistedWindowsMenu } = windowsMenu;
    const { evidence: _skipLinkEvidence, ...persistedSkipLink } = result.skip_link_keyboard;
    const persistedAccessibilityTree = {
      ...result.chromium_accessibility_tree,
      nodes: result.chromium_accessibility_tree.nodes.map((node) => ({
        ...node,
        properties: Object.fromEntries(
          Object.entries(node.properties).filter(([name]) => name !== 'url'),
        ),
      })),
    };
    const evidence = {
      ok: true,
      evidence_level: {
        windows_125_equivalent_viewport: 'E3',
        keyboard_navigation: 'E3',
        chromium_screen_reader_tree: 'E3',
        native_windows_nvda: 'U',
      },
      scope_note: 'The audit requested a Windows 125% equivalent viewport. This run uses a real Electron 1360x768 content window at 1.25 page zoom, yielding a measured 1088x614 CSS viewport. Chromium AX is exercised directly; a native Windows/NVDA host is not available and is not claimed.',
      synthetic_data_only: true,
      real_candidate_data_read: false,
      external_services_accessed: false,
      windows_125: {
        zoom_factor: result.scaled_shell.zoomFactor,
        electron_content_size: result.scaled_shell.electronContentSize,
        css_viewport: result.scaled_shell.cssViewport,
        document_overflow_px: result.scaled_shell.document.overflow,
        header_height_px: result.scaled_shell.headerHeight,
        workspace_y_px: result.scaled_shell.workspaceY,
        candidate_disposition_menu: persistedWindowsMenu,
        candidate_toggle: result.windows_125_candidate_toggle,
      },
      keyboard: {
        skip_link: persistedSkipLink,
        candidate_roving_focus: result.candidate_roving_focus,
        candidate_roving_return_focus: result.candidate_roving_return_focus,
        enter_activation: result.candidate_enter_activation,
        space_activation: result.candidate_space_activation,
        list_collapse_restore_focus: result.candidate_sider_focus,
        tab_journey: result.candidate_tab_journey,
      },
      screen_reader: persistedAccessibilityTree,
      screenshots,
      process_cleanup: {
        strategy: 'baseline PID snapshot plus exact descendant PID ownership',
        survivors: [],
      },
    };
    const evidencePath = path.join(evidenceDirectory, 'B-15-windows-accessibility-runtime-evidence.json');
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(evidencePath, 0o600);
    console.log(JSON.stringify({
      ok: true,
      evidence_level: evidence.evidence_level,
      windows_125: {
        content_size: evidence.windows_125.electron_content_size,
        css_viewport: evidence.windows_125.css_viewport,
        document_overflow_px: evidence.windows_125.document_overflow_px,
      },
      keyboard: {
        roving_role: evidence.keyboard.candidate_roving_focus.role,
        tab_stop_count: evidence.keyboard.candidate_roving_focus.tabStopCount,
        enter_selected_count: evidence.keyboard.enter_activation.selectedLabels.length,
        space_selected_count: evidence.keyboard.space_activation.selectedLabels.length,
      },
      accessibility_tree: {
        source: evidence.screen_reader.source,
        node_count: evidence.screen_reader.node_count,
        required_nodes: evidence.screen_reader.required_nodes,
      },
      screenshots,
      evidence_path: evidencePath,
    }, null, 2));
  } finally {
    if (keepArtifacts) {
      console.log(`[B-15] artifacts retained at ${syntheticRoot}`);
    } else {
      fs.rmSync(syntheticRoot, { recursive: true, force: true });
    }
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
