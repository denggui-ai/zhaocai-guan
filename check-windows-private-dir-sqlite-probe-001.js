'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PREFIX = '[windows-private-dir-probe]';
const MAX_BUFFER = 16 * 1024 * 1024;
const SUCCESS_CLASSIFICATION = 'HARDEN_PRIVATE_DIR_SQLITE_FIRST_REOPEN_AND_LIVE_OK';

function nullable(value) {
  return value === undefined ? null : value;
}

function describeError(error) {
  if (!error) return null;
  return {
    name: nullable(error.name),
    message: nullable(error.message),
    code: nullable(error.code),
    errno: nullable(error.errno),
    syscall: nullable(error.syscall),
    path: nullable(error.path),
    stack: nullable(error.stack),
    ownKeys: Object.getOwnPropertyNames(error),
  };
}

function printRawBlock(label, streamName, value) {
  const output = String(value || '');
  console.log(`${PREFIX} ${label} ${streamName} BEGIN`);
  if (output) process.stdout.write(output);
  if (!output.endsWith('\n')) process.stdout.write('\n');
  console.log(`${PREFIX} ${label} ${streamName} END`);
}

function runCommand(label, command, args, options = {}) {
  console.log(`${PREFIX} ${label} command ${JSON.stringify({ command, args })}`);
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
    ...options,
  });
  console.log(`${PREFIX} ${label} result ${JSON.stringify({
    status: nullable(result.status),
    signal: nullable(result.signal),
    error: describeError(result.error),
  }, null, 2)}`);
  printRawBlock(label, 'stdout', result.stdout);
  printRawBlock(label, 'stderr', result.stderr);
  return result;
}

const WINDOWS_PATH_RESOLVER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class HrbossWindowsPathProbe
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint bufferLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern uint GetShortPathNameW(string longPath, StringBuilder shortPath, uint bufferLength);

    public static string GetLongPath(string input)
    {
        return Resolve(input, true);
    }

    public static string GetShortPath(string input)
    {
        return Resolve(input, false);
    }

    private static string Resolve(string input, bool longPath)
    {
        var buffer = new StringBuilder(32768);
        uint length = longPath
            ? GetLongPathNameW(input, buffer, (uint)buffer.Capacity)
            : GetShortPathNameW(input, buffer, (uint)buffer.Capacity);
        if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (length >= buffer.Capacity) throw new InvalidOperationException("Resolved Windows path exceeds the probe buffer.");
        return buffer.ToString();
    }
}
'@

$inputPath = [Environment]::GetEnvironmentVariable('HRBOSS_ICACLS_PROBE_DIR')
if ([string]::IsNullOrWhiteSpace($inputPath)) {
    throw 'HRBOSS_ICACLS_PROBE_DIR is missing.'
}

$longPath = $null
$longError = $null
try { $longPath = [HrbossWindowsPathProbe]::GetLongPath($inputPath) }
catch { $longError = $_.Exception.ToString() }

$shortPath = $null
$shortError = $null
try { $shortPath = [HrbossWindowsPathProbe]::GetShortPath($inputPath) }
catch { $shortError = $_.Exception.ToString() }

[ordered]@{
    inputPath = $inputPath
    longPath = $longPath
    longError = $longError
    shortPath = $shortPath
    shortError = $shortError
    longEqualsInput = $longPath -eq $inputPath
    shortEqualsInput = $shortPath -eq $inputPath
    longEqualsShort = $longPath -eq $shortPath
} | ConvertTo-Json -Compress
`;

const WINDOWS_ACL_AUDITOR = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$inputPath = [Environment]::GetEnvironmentVariable('HRBOSS_ICACLS_PROBE_DIR')
$singleItem = [Environment]::GetEnvironmentVariable('HRBOSS_ICACLS_PROBE_SINGLE') -eq '1'
if ([string]::IsNullOrWhiteSpace($inputPath)) {
    throw 'HRBOSS_ICACLS_PROBE_DIR is missing.'
}

$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$inheritOnly = [System.Security.AccessControl.PropagationFlags]::InheritOnly
$objectInherit = [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$containerInherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit
$issues = New-Object 'System.Collections.Generic.List[string]'
$rows = New-Object 'System.Collections.Generic.List[object]'
$items = @((Get-Item -LiteralPath $inputPath -Force))
if ($items[0].PSIsContainer -and -not $singleItem) {
    $items += @(Get-ChildItem -LiteralPath $inputPath -Recurse -Force -ErrorAction Stop)
}

foreach ($item in $items) {
    try {
        $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        $currentRules = @($rules | Where-Object { $_.IdentityReference.Value -eq $currentSid })
        $unexpected = @($rules | Where-Object { $_.IdentityReference.Value -ne $currentSid } | ForEach-Object { $_.IdentityReference.Value } | Select-Object -Unique)
        $inherited = @($rules | Where-Object { $_.IsInherited })
        $denied = @($rules | Where-Object { $_.AccessControlType -ne $allow })
        $effectiveFull = @($currentRules | Where-Object {
            $_.AccessControlType -eq $allow -and
            (($_.FileSystemRights -band $fullControl) -eq $fullControl) -and
            (($_.PropagationFlags -band $inheritOnly) -eq 0)
        })
        $objectInheritance = @($currentRules | Where-Object {
            $_.AccessControlType -eq $allow -and
            (($_.FileSystemRights -band $fullControl) -eq $fullControl) -and
            (($_.InheritanceFlags -band $objectInherit) -ne 0)
        })
        $containerInheritance = @($currentRules | Where-Object {
            $_.AccessControlType -eq $allow -and
            (($_.FileSystemRights -band $fullControl) -eq $fullControl) -and
            (($_.InheritanceFlags -band $containerInherit) -ne 0)
        })
        if ($rules.Count -eq 0) { $issues.Add("empty-dacl:$($item.FullName)") }
        if ($currentRules.Count -eq 0) { $issues.Add("missing-current-sid:$($item.FullName)") }
        if ($effectiveFull.Count -eq 0) { $issues.Add("missing-current-effective-full-control:$($item.FullName)") }
        if ($item.PSIsContainer -and $objectInheritance.Count -eq 0) { $issues.Add("missing-current-object-inherit:$($item.FullName)") }
        if ($item.PSIsContainer -and $containerInheritance.Count -eq 0) { $issues.Add("missing-current-container-inherit:$($item.FullName)") }
        if ($unexpected.Count -gt 0) { $issues.Add("unexpected-principal:$($item.FullName):$($unexpected -join ',')") }
        if ($inherited.Count -gt 0) { $issues.Add("inherited-ace:$($item.FullName)") }
        if ($denied.Count -gt 0) { $issues.Add("deny-ace:$($item.FullName)") }
        if (-not $acl.AreAccessRulesProtected) { $issues.Add("inheritance-enabled:$($item.FullName)") }
        $rows.Add([pscustomobject][ordered]@{
            fullName = $item.FullName
            isDirectory = [bool]$item.PSIsContainer
            sddl = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
            areAccessRulesProtected = [bool]$acl.AreAccessRulesProtected
            ruleCount = $rules.Count
            currentSidRuleCount = $currentRules.Count
            currentEffectiveFullControlCount = $effectiveFull.Count
            currentObjectInheritFullControlCount = $objectInheritance.Count
            currentContainerInheritFullControlCount = $containerInheritance.Count
            inheritedRuleCount = $inherited.Count
            unexpectedSids = @($unexpected)
            denyRuleCount = $denied.Count
            error = $null
        })
    } catch {
        $issues.Add("acl-read-error:$($item.FullName):$($_.Exception.Message)")
        $rows.Add([pscustomobject][ordered]@{
            fullName = $item.FullName
            isDirectory = [bool]$item.PSIsContainer
            sddl = $null
            areAccessRulesProtected = $null
            ruleCount = $null
            currentSidRuleCount = $null
            currentEffectiveFullControlCount = $null
            currentObjectInheritFullControlCount = $null
            currentContainerInheritFullControlCount = $null
            inheritedRuleCount = $null
            unexpectedSids = @()
            denyRuleCount = $null
            error = $_.Exception.ToString()
        })
    }
}

[ordered]@{
    ok = ($issues.Count -eq 0)
    currentSid = $currentSid
    itemCount = $items.Count
    # Windows PowerShell 5.1's dynamic binder can throw "Argument types do
    # not match" for @($genericList) inside a hashtable. Materialize the
    # lists through their CLR API before ConvertTo-Json.
    issues = $issues.ToArray()
    items = $rows.ToArray()
} | ConvertTo-Json -Depth 8 -Compress
`;

function resolveWindowsPathForms(root) {
  const encodedCommand = Buffer.from(WINDOWS_PATH_RESOLVER, 'utf16le').toString('base64');
  const result = runCommand('path-resolver', 'powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedCommand,
  ], {
    env: { ...process.env, HRBOSS_ICACLS_PROBE_DIR: root },
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      error: describeError(result.error) || { message: `PowerShell exited with status ${result.status}` },
    };
  }
  try {
    const resolved = JSON.parse(String(result.stdout || '').replace(/^\uFEFF/, '').trim());
    return { ok: true, ...resolved };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

function inspectAclTree(label, target, options = {}) {
  const encodedCommand = Buffer.from(WINDOWS_ACL_AUDITOR, 'utf16le').toString('base64');
  const command = runCommand(`${label}-semantic-acl`, 'powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedCommand,
  ], {
    env: {
      ...process.env,
      HRBOSS_ICACLS_PROBE_DIR: target,
      HRBOSS_ICACLS_PROBE_SINGLE: options.single ? '1' : '0',
    },
  });
  if (command.error || command.status !== 0) {
    const failed = {
      ok: false,
      target,
      commandStatus: nullable(command.status),
      commandError: describeError(command.error),
      parseError: null,
      issues: ['acl-auditor-command-failed'],
      items: [],
    };
    console.log(`${PREFIX} semantic ACL result ${label} ${JSON.stringify(failed, null, 2)}`);
    return failed;
  }
  try {
    const parsed = JSON.parse(String(command.stdout || '').replace(/^\uFEFF/, '').trim());
    const result = { target, commandStatus: command.status, commandError: null, parseError: null, ...parsed };
    console.log(`${PREFIX} semantic ACL result ${label} ${JSON.stringify(result, null, 2)}`);
    return result;
  } catch (error) {
    const failed = {
      ok: false,
      target,
      commandStatus: command.status,
      commandError: null,
      parseError: describeError(error),
      issues: ['acl-auditor-json-invalid'],
      items: [],
    };
    console.log(`${PREFIX} semantic ACL result ${label} ${JSON.stringify(failed, null, 2)}`);
    return failed;
  }
}

function inspectAclItem(label, target) {
  const audit = inspectAclTree(label, target, { single: true });
  return {
    audit,
    item: Array.isArray(audit.items) ? audit.items[0] || null : null,
  };
}

function aclFingerprint(audit) {
  if (!audit || !Array.isArray(audit.items)) return null;
  return audit.items
    .map((item) => `${normalizedWindowsSpelling(item.fullName)}|${item.sddl || '<missing>'}`)
    .sort()
    .join('\n');
}

function normalizedSddlFingerprint(audit, root) {
  if (!audit || !Array.isArray(audit.items)) return null;
  const normalizedRoot = normalizedWindowsSpelling(root);
  return audit.items
    .map((item) => {
      const normalizedPath = normalizedWindowsSpelling(item.fullName);
      const relative = normalizedPath && normalizedRoot && normalizedPath.startsWith(normalizedRoot)
        ? normalizedPath.slice(normalizedRoot.length)
        : normalizedPath;
      return `${relative}|${item.sddl || '<missing>'}`;
    })
    .sort()
    .join('\n');
}

function inspectAcl(label, target) {
  return runCommand(label, 'icacls', [target, '/T', '/C']);
}

function normalizedWindowsSpelling(value) {
  if (!value) return null;
  let normalized = path.win32.normalize(String(value));
  if (/^\\\\\?\\UNC\\/i.test(normalized)) normalized = `\\\\${normalized.slice(8)}`;
  else if (/^\\\\\?\\/i.test(normalized)) normalized = normalized.slice(4);
  return normalized.toLowerCase();
}

function sameWindowsSpelling(left, right) {
  const normalizedLeft = normalizedWindowsSpelling(left);
  const normalizedRight = normalizedWindowsSpelling(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function aclAuditAvailable(audit, minimumItems = 1) {
  return Boolean(
    audit
    && audit.commandStatus === 0
    && !audit.commandError
    && !audit.parseError
    && Array.isArray(audit.items)
    && audit.items.length >= minimumItems
    && audit.items.every((item) => item && !item.error && typeof item.sddl === 'string')
  );
}

function privateAclItemOk(item) {
  if (!item || item.ruleCount <= 0 || item.currentSidRuleCount !== item.ruleCount) return false;
  if (item.currentEffectiveFullControlCount <= 0) return false;
  if (item.areAccessRulesProtected !== true || item.inheritedRuleCount !== 0) return false;
  if (!Array.isArray(item.unexpectedSids) || item.unexpectedSids.length !== 0) return false;
  if (item.denyRuleCount !== 0) return false;
  if (!item.isDirectory) return true;
  return item.currentObjectInheritFullControlCount > 0
    && item.currentContainerInheritFullControlCount > 0;
}

function findAclItem(audit, target) {
  if (!aclAuditAvailable(audit)) return null;
  const exact = audit.items.find((item) => sameWindowsSpelling(item.fullName, target));
  if (exact) return exact;
  // PowerShell expands 8.3 parent aliases in FullName. The probe filenames are
  // unique within each isolated root, so a unique basename match is a safe
  // diagnostic fallback without pretending the two spellings are text-equal.
  const basename = path.win32.basename(target).toLowerCase();
  const basenameMatches = audit.items.filter((item) => (
    path.win32.basename(String(item.fullName || '')).toLowerCase() === basename
  ));
  return basenameMatches.length === 1 ? basenameMatches[0] : null;
}

function privateAclSubtreeOk(audit, subtree) {
  if (!aclAuditAvailable(audit)) return false;
  const subtreeItem = findAclItem(audit, subtree);
  if (!subtreeItem || !subtreeItem.isDirectory) return false;
  const normalizedSubtree = normalizedWindowsSpelling(subtreeItem.fullName);
  const items = audit.items.filter((item) => {
    const normalizedItem = normalizedWindowsSpelling(item.fullName);
    return normalizedItem === normalizedSubtree
      || (normalizedItem && normalizedSubtree && normalizedItem.startsWith(`${normalizedSubtree}\\`));
  });
  return items.length >= 2 && items.every(privateAclItemOk);
}

function configureProbeDatabase(database, dbPath, ensurePrivateFile) {
  ensurePrivateFile(dbPath);
  database.pragma('busy_timeout = 5000');
  const journalMode = String(database.pragma('journal_mode = WAL', { simple: true }) || '').toLowerCase();
  database.pragma('foreign_keys = ON');
  return journalMode;
}

function inspectSqliteFiles(label, dbPath) {
  const files = [
    { kind: 'db', path: dbPath },
    { kind: 'wal', path: `${dbPath}-wal` },
    { kind: 'shm', path: `${dbPath}-shm` },
  ];
  const states = files.map((entry) => {
    try {
      const stat = fs.statSync(entry.path);
      return { ...entry, exists: true, size: stat.size, error: null };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ...entry, exists: false, size: null, error: null };
      return { ...entry, exists: false, size: null, error: describeError(error) };
    }
  });
  console.log(`${PREFIX} sqlite files ${label} ${JSON.stringify(states, null, 2)}`);
  return states.map((state) => {
    if (!state.exists) return { ...state, aclStatus: null, aclError: null };
    const acl = runCommand(`${label}-icacls-${state.kind}`, 'icacls', [state.path]);
    return {
      ...state,
      aclStatus: nullable(acl.status),
      aclError: describeError(acl.error),
    };
  });
}

function attemptSqlite({
  Database,
  ensurePrivateFile,
  label,
  directory,
  filename,
  phase,
  expectExisting,
  afterConstructor,
}) {
  if (!directory) {
    const skipped = {
      label,
      phase,
      ok: false,
      skipped: true,
      directory: null,
      dbPath: null,
      errno: null,
    };
    console.log(`${PREFIX} sqlite result ${JSON.stringify(skipped, null, 2)}`);
    return skipped;
  }

  const dbPath = path.join(directory, filename);
  let database = null;
  let opened = false;
  let privateFileHardened = false;
  let journalMode = null;
  let existingRowFound = null;
  let wrote = false;
  let closed = false;
  let constructorError = null;
  let operationError = null;
  let afterConstructorError = null;
  let closeError = null;
  let operationStage = null;
  try {
    database = new Database(dbPath);
    opened = true;
  } catch (error) {
    constructorError = describeError(error);
  }

  if (typeof afterConstructor === 'function') {
    try {
      afterConstructor({ opened, constructorError, dbPath });
    } catch (error) {
      afterConstructorError = describeError(error);
    }
  }

  if (database && !constructorError) {
    try {
      // Mirror db.openDb's order around the constructor. The second pass is the
      // important one: Windows recursively hardens a directory that now contains
      // an explicitly hardened SQLite file before trying to reopen that file.
      operationStage = 'configure-private-file-and-wal';
      journalMode = configureProbeDatabase(database, dbPath, ensurePrivateFile);
      privateFileHardened = true;
      operationStage = expectExisting ? 'read-write-existing-database' : 'create-write-database';
      if (expectExisting) {
        const existing = database.prepare('SELECT value FROM probe WHERE value = ?').get('first-open');
        existingRowFound = Boolean(existing && existing.value === 'first-open');
        const before = database.prepare('SELECT COUNT(*) AS n FROM probe').get();
        database.prepare('INSERT INTO probe(value) VALUES (?)').run('second-open');
        const after = database.prepare('SELECT COUNT(*) AS n FROM probe').get();
        wrote = Boolean(existingRowFound && before && after && after.n === before.n + 1);
      } else {
        database.exec('CREATE TABLE probe(value TEXT NOT NULL)');
        database.prepare('INSERT INTO probe(value) VALUES (?)').run('first-open');
        const row = database.prepare('SELECT value FROM probe').get();
        wrote = Boolean(row && row.value === 'first-open');
      }
      operationStage = null;
    } catch (error) {
      operationError = describeError(error);
    }
  }

  if (database) {
    try {
      database.close();
      closed = true;
    } catch (error) {
      closeError = describeError(error);
    }
  }

  const validationFailure = !constructorError && !operationError
    && (!privateFileHardened || journalMode !== 'wal' || !wrote)
    ? 'SQLite phase completed without the required private-file/WAL/read-write invariants'
    : null;
  const failureStage = constructorError
    ? 'constructor'
    : operationError
      ? operationStage
      : afterConstructorError
        ? 'after-constructor-evidence'
        : closeError
          ? 'close'
          : validationFailure
            ? 'validation'
            : null;
  const constructorOk = opened && !constructorError;
  const postConstructorOk = constructorOk
    && privateFileHardened
    && journalMode === 'wal'
    && wrote
    && !operationError;
  const closeOk = closed && !closeError;
  const primaryError = constructorError || operationError || afterConstructorError || closeError;
  const result = {
    label,
    phase,
    ok: constructorOk && postConstructorOk && closeOk && !afterConstructorError,
    skipped: false,
    directory,
    dbPath,
    opened,
    constructorOk,
    postConstructorOk,
    closeOk,
    privateFileHardened,
    journalMode,
    existingRowFound,
    wrote,
    closed,
    failureStage,
    validationFailure,
    errno: primaryError ? primaryError.errno : null,
    constructorError,
    operationError,
    afterConstructorError,
    closeError,
  };
  console.log(`${PREFIX} sqlite result ${JSON.stringify(result, null, 2)}`);
  return result;
}

function runLiveConnectionScenario({ Database, hardenPrivateDir, ensurePrivateFile, failures, roots }) {
  const kind = 'live-wal-second-connection';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-icacls-live-wal-'));
  roots.push(root);
  const dbPath = path.join(root, 'probe-live-wal.db');
  const nativeRealPath = safeNativeRealPath(root);
  const pathForms = resolveWindowsPathForms(root);
  console.log(`${PREFIX} live scenario paths ${JSON.stringify({
    kind,
    osTmpdir: os.tmpdir(),
    mkdtempOriginal: root,
    nativeRealPath,
    pathForms,
    hardenTarget: root,
    dbPath,
  }, null, 2)}`);
  if (!pathForms.ok || !pathForms.longPath || !pathForms.shortPath) {
    failures.push(`${kind}: Windows long/short path resolution failed`);
  }

  const beforeAcl = inspectAcl(`${kind}-icacls-before-first-hardenPrivateDir`, root);
  const initialDirectoryAclOk = !beforeAcl.error && beforeAcl.status === 0;
  if (!initialDirectoryAclOk) failures.push(`${kind}: initial icacls failed`);

  let initialHardenError = null;
  try {
    hardenPrivateDir(root);
    console.log(`${PREFIX} live initial hardenPrivateDir result ${JSON.stringify({ kind, ok: true, root })}`);
  } catch (error) {
    initialHardenError = describeError(error);
    failures.push(`${kind}: initial hardenPrivateDir failed`);
    console.log(`${PREFIX} live initial hardenPrivateDir result ${JSON.stringify({
      kind,
      ok: false,
      root,
      error: initialHardenError,
    }, null, 2)}`);
  }

  let keeper = null;
  let keeperOpenError = null;
  let keeperAfterHardenError = null;
  let keeperCloseError = null;
  let keeperJournalMode = null;
  let keeperInitialWrite = false;
  let keeperAfterHardenWrite = false;
  let liveFilesBeforeHarden = [];
  let liveFilesAfterHarden = [];
  let secondHardenError = null;
  let secondConnection = null;
  let cleanReopen = null;
  let cleanCloseAclOk = false;
  let postHardenDirectoryAclOk = false;
  let livePrivateAclAfter = null;
  let livePrivateAclAfterOk = false;
  let cleanPrivateAcl = null;
  let cleanPrivateAclOk = false;

  try {
    try {
      keeper = new Database(dbPath);
      keeperJournalMode = configureProbeDatabase(keeper, dbPath, ensurePrivateFile);
      keeper.exec('CREATE TABLE probe(value TEXT NOT NULL)');
      keeper.prepare('INSERT INTO probe(value) VALUES (?)').run('first-open');
      keeperInitialWrite = keeper.prepare('SELECT COUNT(*) AS n FROM probe').get().n === 1;
    } catch (error) {
      keeperOpenError = describeError(error);
      failures.push(`${kind}: keeper connection setup failed`);
    }

    liveFilesBeforeHarden = inspectSqliteFiles(`${kind}-before-second-hardenPrivateDir`, dbPath);
    const walBefore = liveFilesBeforeHarden.find((entry) => entry.kind === 'wal');
    const shmBefore = liveFilesBeforeHarden.find((entry) => entry.kind === 'shm');
    const sidecarsPresentBefore = Boolean(walBefore && walBefore.exists && shmBefore && shmBefore.exists);
    const liveFileAclBeforeOk = liveFilesBeforeHarden.every((entry) => (
      !entry.error && (!entry.exists || (entry.aclStatus === 0 && !entry.aclError))
    ));
    if (!sidecarsPresentBefore) {
      failures.push(`${kind}: live WAL/SHM sidecars were not present before recursive hardening`);
    }
    if (!liveFileAclBeforeOk) failures.push(`${kind}: live DB/WAL/SHM ACL inspection failed before hardening`);

    try {
      hardenPrivateDir(root);
      console.log(`${PREFIX} live second hardenPrivateDir result ${JSON.stringify({ kind, ok: true, root })}`);
    } catch (error) {
      secondHardenError = describeError(error);
      failures.push(`${kind}: second hardenPrivateDir with live WAL failed`);
      console.log(`${PREFIX} live second hardenPrivateDir result ${JSON.stringify({
        kind,
        ok: false,
        root,
        error: secondHardenError,
      }, null, 2)}`);
    }

    // Match db.openDb's exact observed failure boundary: no stat, icacls, or SQL
    // runs between recursive hardening and the second Database constructor. The
    // callback then captures the unmodified post-harden ACL before ensurePrivateFile.
    secondConnection = attemptSqlite({
      Database,
      ensurePrivateFile,
      label: kind,
      directory: root,
      filename: path.basename(dbPath),
      phase: 'second-connection-while-keeper-live',
      expectExisting: true,
      afterConstructor: () => {
        liveFilesAfterHarden = inspectSqliteFiles(`${kind}-after-second-hardenPrivateDir`, dbPath);
        const walAfter = liveFilesAfterHarden.find((entry) => entry.kind === 'wal');
        const shmAfter = liveFilesAfterHarden.find((entry) => entry.kind === 'shm');
        const sidecarsPresentAfter = Boolean(walAfter && walAfter.exists && shmAfter && shmAfter.exists);
        const liveFileAclAfterOk = liveFilesAfterHarden.every((entry) => (
          !entry.error && (!entry.exists || (entry.aclStatus === 0 && !entry.aclError))
        ));
        if (!sidecarsPresentAfter) {
          failures.push(`${kind}: live WAL/SHM sidecars disappeared during recursive hardening`);
        }
        if (!liveFileAclAfterOk) failures.push(`${kind}: live DB/WAL/SHM ACL inspection failed after hardening`);
        const afterAcl = inspectAcl(`${kind}-directory-icacls-after-second-hardenPrivateDir`, root);
        postHardenDirectoryAclOk = !afterAcl.error && afterAcl.status === 0;
        if (!postHardenDirectoryAclOk) failures.push(`${kind}: post-harden directory icacls failed`);
        livePrivateAclAfter = inspectAclTree(`${kind}-after-second-hardenPrivateDir`, root);
        livePrivateAclAfterOk = livePrivateAclAfter.ok === true;
        if (!livePrivateAclAfterOk) failures.push(`${kind}: live post-harden ACL semantics failed`);
      },
    });
    if (!secondConnection.ok) failures.push(`${kind}: second live connection failed`);

    if (keeper) {
      try {
        const first = keeper.prepare('SELECT value FROM probe WHERE value = ?').get('first-open');
        const inserted = keeper.prepare('INSERT INTO probe(value) VALUES (?)').run('keeper-after-harden');
        const persisted = keeper.prepare('SELECT value FROM probe WHERE value = ?').get('keeper-after-harden');
        keeperAfterHardenWrite = Boolean(
          first && first.value === 'first-open'
          && inserted && inserted.changes === 1
          && persisted && persisted.value === 'keeper-after-harden'
        );
      } catch (error) {
        keeperAfterHardenError = describeError(error);
        failures.push(`${kind}: keeper connection lost read/write access after recursive hardening`);
      }
    }
  } finally {
    if (keeper) {
      try {
        keeper.close();
      } catch (error) {
        keeperCloseError = describeError(error);
        failures.push(`${kind}: keeper close failed`);
      }
    }
  }

  const filesAfterKeeperClose = inspectSqliteFiles(`${kind}-after-keeper-close`, dbPath);
  let cleanHardenError = null;
  try {
    hardenPrivateDir(root);
    console.log(`${PREFIX} live clean-close hardenPrivateDir result ${JSON.stringify({ kind, ok: true, root })}`);
  } catch (error) {
    cleanHardenError = describeError(error);
    failures.push(`${kind}: hardenPrivateDir after keeper close failed`);
    console.log(`${PREFIX} live clean-close hardenPrivateDir result ${JSON.stringify({
      kind,
      ok: false,
      root,
      error: cleanHardenError,
    }, null, 2)}`);
  }
  cleanReopen = attemptSqlite({
    Database,
    ensurePrivateFile,
    label: kind,
    directory: root,
    filename: path.basename(dbPath),
    phase: 'clean-reopen-after-live-connections-close',
    expectExisting: true,
    afterConstructor: () => {
      const cleanCloseAcl = inspectAcl(`${kind}-directory-icacls-after-clean-close-harden`, root);
      cleanCloseAclOk = !cleanCloseAcl.error && cleanCloseAcl.status === 0;
      if (!cleanCloseAclOk) failures.push(`${kind}: clean-close directory icacls failed`);
      cleanPrivateAcl = inspectAclTree(`${kind}-after-clean-close-harden`, root);
      cleanPrivateAclOk = cleanPrivateAcl.ok === true;
      if (!cleanPrivateAclOk) failures.push(`${kind}: clean-close ACL semantics failed`);
    },
  });
  if (!cleanReopen.ok) failures.push(`${kind}: clean reopen failed`);

  const walBefore = liveFilesBeforeHarden.find((entry) => entry.kind === 'wal');
  const shmBefore = liveFilesBeforeHarden.find((entry) => entry.kind === 'shm');
  const walAfter = liveFilesAfterHarden.find((entry) => entry.kind === 'wal');
  const shmAfter = liveFilesAfterHarden.find((entry) => entry.kind === 'shm');
  const sidecarsPresentBefore = Boolean(walBefore && walBefore.exists && shmBefore && shmBefore.exists);
  const sidecarsPresentAfter = Boolean(walAfter && walAfter.exists && shmAfter && shmAfter.exists);
  const liveFileAclBeforeOk = liveFilesBeforeHarden
    .every((entry) => !entry.error && (!entry.exists || (entry.aclStatus === 0 && !entry.aclError)));
  const liveFileAclAfterOk = liveFilesAfterHarden
    .every((entry) => !entry.error && (!entry.exists || (entry.aclStatus === 0 && !entry.aclError)));
  const probeInfraOk = Boolean(
    pathForms.ok && pathForms.longPath && pathForms.shortPath
    && initialDirectoryAclOk && !initialHardenError && !keeperOpenError
    && keeperJournalMode === 'wal' && keeperInitialWrite
    && sidecarsPresentBefore && liveFileAclBeforeOk
  );
  const recursiveHardenCommandOk = Boolean(probeInfraOk && !secondHardenError);
  const secondConnectionConstructorOk = Boolean(
    recursiveHardenCommandOk && secondConnection && secondConnection.constructorOk
  );
  const secondConnectionPostConstructorOk = Boolean(
    secondConnectionConstructorOk && secondConnection.postConstructorOk
  );
  const secondConnectionCloseOk = Boolean(
    secondConnectionConstructorOk && secondConnection.closeOk
  );
  const secondConnectionAttemptOk = Boolean(
    secondConnectionPostConstructorOk
    && secondConnectionCloseOk
    && !secondConnection.afterConstructorError
  );
  const secondConnectionWhileKeeperLiveOk = Boolean(
    recursiveHardenCommandOk && secondConnectionAttemptOk
  );
  const postHardenEvidenceOk = Boolean(
    recursiveHardenCommandOk
    && sidecarsPresentAfter
    && liveFileAclAfterOk
    && postHardenDirectoryAclOk
    && livePrivateAclAfterOk
  );
  const recursiveHardenWithLiveFilesOk = Boolean(recursiveHardenCommandOk && postHardenEvidenceOk);
  const keeperAfterHardenOk = Boolean(recursiveHardenCommandOk
    && !keeperAfterHardenError && keeperAfterHardenWrite);
  const cleanCloseReopenOk = Boolean(
    !keeperCloseError && !cleanHardenError
    && cleanCloseAclOk && cleanPrivateAclOk
    && cleanReopen && cleanReopen.ok
  );
  const livePhaseOk = Boolean(
    probeInfraOk
    && recursiveHardenCommandOk
    && secondConnectionWhileKeeperLiveOk
    && postHardenEvidenceOk
    && keeperAfterHardenOk
  );
  const result = {
    kind,
    available: true,
    ok: livePhaseOk && cleanCloseReopenOk,
    probeInfraOk,
    sidecarsPresentBefore,
    sidecarsPresentAfter,
    liveFileAclBeforeOk,
    liveFileAclAfterOk,
    initialDirectoryAclOk,
    postHardenDirectoryAclOk,
    livePrivateAclAfterOk,
    cleanPrivateAclOk,
    recursiveHardenCommandOk,
    secondConnectionConstructorOk,
    secondConnectionPostConstructorOk,
    secondConnectionCloseOk,
    secondConnectionAttemptOk,
    postHardenEvidenceOk,
    recursiveHardenWithLiveFilesOk,
    keeperAfterHardenOk,
    secondConnectionWhileKeeperLiveOk,
    livePhaseOk,
    cleanCloseAclOk,
    cleanCloseReopenOk,
    root,
    dbPath,
    keeperJournalMode,
    keeperInitialWrite,
    keeperAfterHardenWrite,
    keeperOpenError,
    keeperAfterHardenError,
    keeperCloseError,
    secondHardenError,
    cleanHardenError,
    liveFilesBeforeHarden,
    liveFilesAfterHarden,
    filesAfterKeeperClose,
    livePrivateAclAfter,
    cleanPrivateAcl,
    secondConnection,
    cleanReopen,
  };
  console.log(`${PREFIX} live scenario result ${JSON.stringify(result, null, 2)}`);
  return result;
}

function safeNativeRealPath(root) {
  try {
    return { ok: true, path: fs.realpathSync.native(root), error: null };
  } catch (error) {
    return { ok: false, path: null, error: describeError(error) };
  }
}

function selectHardenTarget(kind, root, pathForms) {
  if (kind === 'mkdtemp-original') return root;
  if (kind === 'win32-long-path') return pathForms.longPath || null;
  if (kind === 'win32-short-path') return pathForms.shortAliasAvailable ? pathForms.shortPath : null;
  throw new Error(`Unknown harden path kind: ${kind}`);
}

function runScenario({ Database, hardenPrivateDir, ensurePrivateFile, kind, failures, roots }) {
  const slug = kind.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hrboss-icacls-${slug}-`));
  roots.push(root);

  const nativeRealPath = safeNativeRealPath(root);
  const resolved = resolveWindowsPathForms(root);
  const pathForms = {
    ...resolved,
    shortAliasAvailable: Boolean(
      resolved.ok
      && resolved.longPath
      && resolved.shortPath
      && !sameWindowsSpelling(resolved.longPath, resolved.shortPath)
    ),
  };
  const hardenTarget = selectHardenTarget(kind, root, pathForms);
  console.log(`${PREFIX} scenario paths ${JSON.stringify({
    kind,
    osTmpdir: os.tmpdir(),
    mkdtempOriginal: root,
    nativeRealPath,
    pathForms,
    hardenTarget,
    originalMatchesLongSpelling: sameWindowsSpelling(root, pathForms.longPath),
    originalMatchesShortSpelling: sameWindowsSpelling(root, pathForms.shortPath),
  }, null, 2)}`);

  if (!pathForms.ok || !pathForms.longPath || !pathForms.shortPath) {
    failures.push(`${kind}: Windows long/short path resolution failed`);
  }
  if (kind === 'win32-short-path' && !pathForms.shortAliasAvailable) {
    console.log(`${PREFIX} scenario ${kind} SKIP: NO_8DOT3_ALIAS`);
    return { kind, available: false, ok: null, root, hardenTarget: null, pathForms };
  }
  if (!hardenTarget) {
    failures.push(`${kind}: no harden target available`);
    return { kind, available: false, ok: false, root, hardenTarget: null, pathForms };
  }

  const beforeAcl = inspectAcl(`${kind}-icacls-before-hardenPrivateDir`, hardenTarget);
  const beforeAclOk = !beforeAcl.error && beforeAcl.status === 0;
  if (!beforeAclOk) failures.push(`${kind}: icacls before hardenPrivateDir failed`);

  let hardenError = null;
  try {
    hardenPrivateDir(hardenTarget);
    console.log(`${PREFIX} hardenPrivateDir result ${JSON.stringify({ kind, ok: true, hardenTarget }, null, 2)}`);
  } catch (error) {
    hardenError = describeError(error);
    console.log(`${PREFIX} hardenPrivateDir result ${JSON.stringify({ kind, ok: false, hardenTarget, error: hardenError }, null, 2)}`);
    failures.push(`${kind}: hardenPrivateDir failed`);
  }

  const afterAcl = inspectAcl(`${kind}-icacls-after-hardenPrivateDir`, hardenTarget);
  const afterAclOk = !afterAcl.error && afterAcl.status === 0;
  if (!afterAclOk) failures.push(`${kind}: icacls after hardenPrivateDir failed`);
  const initialPrivateAcl = inspectAclTree(`${kind}-after-hardenPrivateDir`, hardenTarget);
  const initialPrivateAclOk = initialPrivateAcl.ok === true;
  if (!initialPrivateAclOk) failures.push(`${kind}: initial private ACL semantics failed`);

  const filename = `probe-${slug}.db`;
  const firstSqlite = attemptSqlite({
    Database,
    ensurePrivateFile,
    label: kind,
    directory: hardenTarget,
    filename,
    phase: 'first-open',
    expectExisting: false,
  });
  if (!firstSqlite.ok) failures.push(`${kind}: SQLite first create/write/close failed`);

  const afterFirstCloseAcl = inspectAcl(`${kind}-icacls-after-first-sqlite-close`, hardenTarget);
  const afterFirstCloseAclOk = !afterFirstCloseAcl.error && afterFirstCloseAcl.status === 0;
  if (!afterFirstCloseAclOk) {
    failures.push(`${kind}: icacls after first SQLite close failed`);
  }

  const nestedFixture = {
    attempted: firstSqlite.ok,
    path: path.join(hardenTarget, 'nested-private'),
    leafPath: path.join(hardenTarget, 'nested-private', 'existing.txt'),
    seeded: false,
    seedObserved: false,
    repaired: null,
    inheritedChildOk: null,
    inheritedChildAudit: null,
  };
  if (nestedFixture.attempted) {
    fs.mkdirSync(nestedFixture.path);
    fs.writeFileSync(nestedFixture.leafPath, 'existing private leaf', 'utf8');
    const nestedWide = runCommand(`${kind}-nested-wide-acl`, 'icacls', [
      nestedFixture.path,
      '/grant',
      '*S-1-1-0:(OI)(CI)F',
      '/T',
    ]);
    nestedFixture.seeded = !nestedWide.error && nestedWide.status === 0;
    const nestedSeedAudit = inspectAclTree(`${kind}-nested-wide-acl-seed`, nestedFixture.path);
    nestedFixture.seedAudit = nestedSeedAudit;
    nestedFixture.seedObserved = Boolean(
      aclAuditAvailable(nestedSeedAudit, 2)
      && nestedSeedAudit.items.some((item) => (
        Array.isArray(item.unexpectedSids) && item.unexpectedSids.includes('S-1-1-0')
      ))
    );
    if (!nestedFixture.seeded || !nestedFixture.seedObserved) {
      failures.push(`${kind}: failed to seed nested ACL fixture`);
    }
  }

  const emptyDaclRecovery = {
    attempted: kind === 'mkdtemp-original' && firstSqlite.ok,
    resetOk: null,
    stripOk: null,
    observed: null,
    recovered: null,
    seedAudit: null,
  };
  if (emptyDaclRecovery.attempted) {
    const resetEmptyTarget = runCommand(`${kind}-empty-dacl-reset`, 'icacls', [firstSqlite.dbPath, '/reset']);
    emptyDaclRecovery.resetOk = !resetEmptyTarget.error && resetEmptyTarget.status === 0;
    const stripInherited = runCommand(`${kind}-empty-dacl-strip-inherited`, 'icacls', [
      firstSqlite.dbPath,
      '/inheritance:r',
    ]);
    emptyDaclRecovery.stripOk = !stripInherited.error && stripInherited.status === 0;
    emptyDaclRecovery.seedAudit = inspectAclTree(`${kind}-seeded-empty-dacl`, firstSqlite.dbPath);
    const seededItem = emptyDaclRecovery.seedAudit.items && emptyDaclRecovery.seedAudit.items[0];
    emptyDaclRecovery.observed = Boolean(
      seededItem
      && seededItem.ruleCount === 0
      && seededItem.areAccessRulesProtected === true
    );
    if (!emptyDaclRecovery.resetOk || !emptyDaclRecovery.stripOk || !emptyDaclRecovery.observed) {
      failures.push(`${kind}: failed to establish protected empty-DACL recovery fixture`);
    }
  }
  const wideAclRepair = {
    attempted: kind !== 'mkdtemp-original' && firstSqlite.ok,
    grantOk: null,
    observed: null,
    repaired: null,
    seedAudit: null,
  };
  if (wideAclRepair.attempted) {
    const grantEveryone = runCommand(`${kind}-wide-acl-grant-everyone`, 'icacls', [
      firstSqlite.dbPath,
      '/grant',
      '*S-1-1-0:F',
    ]);
    wideAclRepair.grantOk = !grantEveryone.error && grantEveryone.status === 0;
    wideAclRepair.seedAudit = inspectAclTree(`${kind}-seeded-wide-acl`, firstSqlite.dbPath);
    const seededItem = wideAclRepair.seedAudit.items && wideAclRepair.seedAudit.items[0];
    wideAclRepair.observed = Boolean(
      seededItem
      && Array.isArray(seededItem.unexpectedSids)
      && seededItem.unexpectedSids.includes('S-1-1-0')
    );
    if (!wideAclRepair.grantOk || !wideAclRepair.observed) {
      failures.push(`${kind}: failed to establish wide-ACL repair fixture`);
    }
  }

  let rehardenError = null;
  try {
    hardenPrivateDir(hardenTarget);
    console.log(`${PREFIX} second hardenPrivateDir result ${JSON.stringify({ kind, ok: true, hardenTarget }, null, 2)}`);
  } catch (error) {
    rehardenError = describeError(error);
    console.log(`${PREFIX} second hardenPrivateDir result ${JSON.stringify({
      kind,
      ok: false,
      hardenTarget,
      error: rehardenError,
    }, null, 2)}`);
    failures.push(`${kind}: second hardenPrivateDir failed`);
  }

  let afterSecondHardenAclOk = false;
  let secondPrivateAcl = null;
  let secondPrivateAclOk = false;
  let dbItemPrivateAclOk = false;
  let nestedSubtreePrivateAclOk = false;
  const reopenedSqlite = attemptSqlite({
    Database,
    ensurePrivateFile,
    label: kind,
    directory: hardenTarget,
    filename,
    phase: 'second-open-existing-db',
    expectExisting: true,
    afterConstructor: () => {
      const afterSecondHardenAcl = inspectAcl(`${kind}-icacls-after-second-hardenPrivateDir`, hardenTarget);
      afterSecondHardenAclOk = !afterSecondHardenAcl.error && afterSecondHardenAcl.status === 0;
      if (!afterSecondHardenAclOk) failures.push(`${kind}: icacls after second hardenPrivateDir failed`);
      secondPrivateAcl = inspectAclTree(`${kind}-after-second-hardenPrivateDir`, hardenTarget);
      secondPrivateAclOk = secondPrivateAcl.ok === true;
      dbItemPrivateAclOk = privateAclItemOk(findAclItem(secondPrivateAcl, firstSqlite.dbPath));
      nestedSubtreePrivateAclOk = !nestedFixture.attempted
        || privateAclSubtreeOk(secondPrivateAcl, nestedFixture.path);
      if (!secondPrivateAclOk) failures.push(`${kind}: second private ACL semantics failed`);
      if (!dbItemPrivateAclOk) failures.push(`${kind}: database ACL was not repaired`);
      if (!nestedSubtreePrivateAclOk) failures.push(`${kind}: nested subtree ACL was not repaired`);
    },
  });
  if (!reopenedSqlite.ok) failures.push(`${kind}: SQLite reopen/write/close failed`);
  if (emptyDaclRecovery.attempted) {
    emptyDaclRecovery.fixtureEstablished = Boolean(
      emptyDaclRecovery.resetOk
      && emptyDaclRecovery.stripOk
      && emptyDaclRecovery.observed
    );
    emptyDaclRecovery.aclRecovered = Boolean(
      emptyDaclRecovery.fixtureEstablished && dbItemPrivateAclOk
    );
    emptyDaclRecovery.recovered = emptyDaclRecovery.aclRecovered;
    if (!emptyDaclRecovery.aclRecovered) failures.push(`${kind}: protected empty-DACL file was not recovered`);
  }
  if (wideAclRepair.attempted) {
    wideAclRepair.fixtureEstablished = Boolean(wideAclRepair.grantOk && wideAclRepair.observed);
    wideAclRepair.aclRepaired = Boolean(
      wideAclRepair.fixtureEstablished && dbItemPrivateAclOk
    );
    wideAclRepair.repaired = wideAclRepair.aclRepaired;
    if (!wideAclRepair.aclRepaired) failures.push(`${kind}: explicit Everyone ACL was not repaired`);
  }
  if (nestedFixture.attempted) {
    nestedFixture.fixtureEstablished = Boolean(nestedFixture.seeded && nestedFixture.seedObserved);
    nestedFixture.repaired = Boolean(nestedFixture.fixtureEstablished && nestedSubtreePrivateAclOk);
    try {
      const inheritedChild = path.join(nestedFixture.path, 'created-after-harden.txt');
      fs.writeFileSync(inheritedChild, 'inherits from hardened nested directory', 'utf8');
      nestedFixture.inheritedChildAudit = inspectAclTree(`${kind}-nested-child-created-after-harden`, inheritedChild);
      const childItem = nestedFixture.inheritedChildAudit.items && nestedFixture.inheritedChildAudit.items[0];
      nestedFixture.inheritedChildOk = Boolean(
        childItem
        && childItem.ruleCount > 0
        && childItem.currentSidRuleCount > 0
        && childItem.currentEffectiveFullControlCount > 0
        && childItem.inheritedRuleCount > 0
        && Array.isArray(childItem.unexpectedSids)
        && childItem.unexpectedSids.length === 0
        && childItem.denyRuleCount === 0
      );
    } catch {
      nestedFixture.inheritedChildOk = false;
    }
    if (!nestedFixture.repaired || !nestedFixture.inheritedChildOk) {
      failures.push(`${kind}: nested directory ACL propagation was not preserved`);
    }
  }

  return {
    kind,
    available: true,
    ok: beforeAclOk
      && !hardenError
      && afterAclOk
      && initialPrivateAclOk
      && firstSqlite.ok
      && afterFirstCloseAclOk
      && !rehardenError
      && afterSecondHardenAclOk
      && secondPrivateAclOk
      && dbItemPrivateAclOk
      && nestedSubtreePrivateAclOk
      && (!emptyDaclRecovery.attempted || emptyDaclRecovery.recovered)
      && (!wideAclRepair.attempted || wideAclRepair.repaired)
      && (!nestedFixture.attempted || (nestedFixture.repaired && nestedFixture.inheritedChildOk))
      && reopenedSqlite.ok,
    root,
    hardenTarget,
    pathForms,
    beforeAclOk,
    afterAclOk,
    initialPrivateAclOk,
    initialPrivateAcl,
    afterFirstCloseAclOk,
    afterSecondHardenAclOk,
    secondPrivateAclOk,
    dbItemPrivateAclOk,
    nestedSubtreePrivateAclOk,
    secondPrivateAcl,
    initialHardenCommandOk: !hardenError,
    rehardenCommandOk: !rehardenError,
    pathSqliteOk: Boolean(firstSqlite.ok && reopenedSqlite.ok),
    emptyDaclRecovery,
    wideAclRepair,
    nestedFixture,
    firstSqlite,
    reopenedSqlite,
  };
}

function runReparseContainmentScenario({ hardenPrivateDir, failures, roots }) {
  const kind = 'reparse-containment';
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-icacls-external-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-icacls-reparse-'));
  // Cleanup is reverse-order, so register the external target before the root
  // that contains the junction.
  roots.push(external, root);
  const sentinel = path.join(external, 'outside-sentinel.txt');
  const junction = path.join(root, 'outside-junction');
  const rootJunction = path.join(os.tmpdir(), `hrboss-icacls-root-junction-${process.pid}-${Date.now()}`);
  const sentinelContent = `outside-${process.pid}-${Date.now()}`;
  fs.writeFileSync(sentinel, sentinelContent, 'utf8');

  const grantExternal = runCommand(`${kind}-seed-external-dir`, 'icacls', [
    external,
    '/grant',
    '*S-1-1-0:(OI)(CI)F',
  ]);
  const grantSentinel = runCommand(`${kind}-seed-external-file`, 'icacls', [
    sentinel,
    '/grant',
    '*S-1-1-0:F',
  ]);
  const seedCommandsOk = !grantExternal.error && grantExternal.status === 0
    && !grantSentinel.error && grantSentinel.status === 0;
  const beforeAudit = inspectAclTree(`${kind}-external-before`, external);
  const beforeFingerprint = aclFingerprint(beforeAudit);
  const rootBefore = inspectAclItem(`${kind}-root-before`, root);
  const rootBeforeSddl = rootBefore.item && rootBefore.item.sddl;
  const beforeEvidenceOk = aclAuditAvailable(beforeAudit, 2)
    && aclAuditAvailable(rootBefore.audit, 1)
    && Boolean(beforeFingerprint && rootBeforeSddl);
  const everyoneSeeded = Boolean(
    beforeAudit.items
    && beforeAudit.items.length >= 2
    && beforeAudit.items.every((item) => (
      Array.isArray(item.unexpectedSids) && item.unexpectedSids.includes('S-1-1-0')
    ))
  );

  let setupError = null;
  let hardenError = null;
  let rootJunctionHardenError = null;
  let junctionCreated = false;
  let junctionResolvedOutside = false;
  try {
    fs.symlinkSync(external, junction, 'junction');
    junctionCreated = fs.lstatSync(junction).isSymbolicLink();
    junctionResolvedOutside = sameWindowsSpelling(fs.realpathSync.native(junction), fs.realpathSync.native(external));
  } catch (error) {
    setupError = describeError(error);
  }

  if (!setupError) {
    try {
      hardenPrivateDir(root);
    } catch (error) {
      hardenError = describeError(error);
    }
  }

  const rootAfter = inspectAclItem(`${kind}-root-after`, root);
  const rootAfterSddl = rootAfter.item && rootAfter.item.sddl;
  const rootAfterEvidenceOk = aclAuditAvailable(rootAfter.audit, 1) && Boolean(rootAfterSddl);
  const rootAclUnchanged = Boolean(rootBeforeSddl && rootAfterSddl && rootBeforeSddl === rootAfterSddl);

  let rootJunctionCreated = false;
  let rootJunctionResolvedOutside = false;
  try {
    fs.symlinkSync(external, rootJunction, 'junction');
    rootJunctionCreated = fs.lstatSync(rootJunction).isSymbolicLink();
    rootJunctionResolvedOutside = sameWindowsSpelling(
      fs.realpathSync.native(rootJunction),
      fs.realpathSync.native(external),
    );
    try {
      hardenPrivateDir(rootJunction);
    } catch (error) {
      rootJunctionHardenError = describeError(error);
    }
  } catch (error) {
    setupError = setupError || describeError(error);
  }

  const afterAudit = inspectAclTree(`${kind}-external-after`, external);
  const afterFingerprint = aclFingerprint(afterAudit);
  const afterEvidenceOk = aclAuditAvailable(afterAudit, 2) && Boolean(afterFingerprint);
  const externalAclUnchanged = Boolean(
    beforeFingerprint
    && afterFingerprint
    && beforeFingerprint === afterFingerprint
  );
  let sentinelContentUnchanged = false;
  try {
    sentinelContentUnchanged = fs.readFileSync(sentinel, 'utf8') === sentinelContent;
  } catch {}
  let junctionRemoved = false;
  let rootJunctionRemoved = false;
  try {
    if (junctionCreated) fs.unlinkSync(junction);
    junctionRemoved = !fs.existsSync(junction);
  } catch {}

  const externalAfterRootJunction = inspectAclTree(`${kind}-external-after-root-junction`, external);
  const rootJunctionEvidenceOk = aclAuditAvailable(externalAfterRootJunction, 2);
  const externalStillUnchanged = Boolean(
    normalizedSddlFingerprint(beforeAudit, external)
    && normalizedSddlFingerprint(externalAfterRootJunction, external)
    && normalizedSddlFingerprint(beforeAudit, external)
      === normalizedSddlFingerprint(externalAfterRootJunction, external)
  );
  try {
    if (rootJunctionCreated) fs.unlinkSync(rootJunction);
    rootJunctionRemoved = !fs.existsSync(rootJunction);
  } catch {}

  const rejectedBeforeMutation = Boolean(
    hardenError
    && /重解析点|符号链接|目录联接/.test(String(hardenError.message || ''))
    && rootAclUnchanged
  );
  const rootReparseRejected = Boolean(
    rootJunctionHardenError
    && /重解析点|符号链接|目录联接/.test(String(rootJunctionHardenError.message || ''))
  );
  const fixtureInfraOk = Boolean(
    seedCommandsOk
    && everyoneSeeded
    && beforeEvidenceOk
    && rootAfterEvidenceOk
    && !setupError
    && junctionCreated
    && junctionResolvedOutside
    && rootJunctionCreated
    && rootJunctionResolvedOutside
    && afterEvidenceOk
    && rootJunctionEvidenceOk
    && junctionRemoved
    && rootJunctionRemoved
  );
  const mutationEvidenceOk = Boolean(
    beforeEvidenceOk && rootAfterEvidenceOk && afterEvidenceOk && rootJunctionEvidenceOk
  );
  const ok = Boolean(
    fixtureInfraOk
    && rejectedBeforeMutation
    && rootAclUnchanged
    && rootJunctionCreated
    && rootJunctionResolvedOutside
    && rootReparseRejected
    && externalAclUnchanged
    && externalStillUnchanged
    && sentinelContentUnchanged
    && junctionRemoved
    && rootJunctionRemoved
  );
  const result = {
    kind,
    available: true,
    ok,
    root,
    external,
    sentinel,
    junction,
    rootJunction,
    seedCommandsOk,
    fixtureInfraOk,
    mutationEvidenceOk,
    beforeEvidenceOk,
    rootAfterEvidenceOk,
    afterEvidenceOk,
    rootJunctionEvidenceOk,
    everyoneSeeded,
    junctionCreated,
    junctionResolvedOutside,
    rejectedBeforeMutation,
    rootAclUnchanged,
    rootJunctionCreated,
    rootJunctionResolvedOutside,
    rootReparseRejected,
    externalAclUnchanged,
    externalStillUnchanged,
    sentinelContentUnchanged,
    junctionRemoved,
    rootJunctionRemoved,
    setupError,
    hardenError,
    rootJunctionHardenError,
    beforeAudit,
    afterAudit,
    externalAfterRootJunction,
    rootBefore,
    rootAfter,
  };
  console.log(`${PREFIX} reparse containment result ${JSON.stringify(result, null, 2)}`);
  if (!ok) failures.push(`${kind}: reparse boundary did not fail closed before external ACL mutation`);
  return result;
}

function runAncestorReparseScenario({ hardenPrivateDir, failures, roots }) {
  const kind = 'ancestor-reparse-containment';
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-icacls-ancestor-external-'));
  const link = path.join(os.tmpdir(), `hrboss-icacls-ancestor-link-${process.pid}-${Date.now()}`);
  const target = path.join(link, 'private-child');
  const realTarget = path.join(external, 'private-child');
  const sentinel = path.join(realTarget, 'sentinel.txt');
  roots.push(external);
  fs.mkdirSync(realTarget);
  fs.writeFileSync(sentinel, 'ancestor reparse sentinel', 'utf8');
  const seedTarget = runCommand(`${kind}-seed-target`, 'icacls', [
    realTarget,
    '/grant',
    '*S-1-1-0:(OI)(CI)F',
    '/T',
  ]);
  const before = inspectAclTree(`${kind}-before`, realTarget);
  const beforeFingerprint = normalizedSddlFingerprint(before, realTarget);
  const beforeEvidenceOk = aclAuditAvailable(before, 2) && Boolean(beforeFingerprint);
  let setupError = null;
  let hardenError = null;
  let linkCreated = false;
  try {
    fs.symlinkSync(external, link, 'junction');
    linkCreated = fs.lstatSync(link).isSymbolicLink();
    try {
      hardenPrivateDir(target);
    } catch (error) {
      hardenError = describeError(error);
    }
  } catch (error) {
    setupError = describeError(error);
  }
  const after = inspectAclTree(`${kind}-after`, realTarget);
  const afterFingerprint = normalizedSddlFingerprint(after, realTarget);
  const afterEvidenceOk = aclAuditAvailable(after, 2) && Boolean(afterFingerprint);
  const externalAclUnchanged = Boolean(
    beforeFingerprint && afterFingerprint && beforeFingerprint === afterFingerprint
  );
  let contentUnchanged = false;
  try { contentUnchanged = fs.readFileSync(sentinel, 'utf8') === 'ancestor reparse sentinel'; } catch {}
  let linkRemoved = false;
  try {
    if (linkCreated) fs.unlinkSync(link);
    linkRemoved = !fs.existsSync(link);
  } catch {}
  const rejected = Boolean(
    hardenError
    && /重解析点|符号链接|目录联接/.test(String(hardenError.message || ''))
  );
  const fixtureInfraOk = Boolean(
    !seedTarget.error
    && seedTarget.status === 0
    && beforeEvidenceOk
    && afterEvidenceOk
    && !setupError
    && linkCreated
    && linkRemoved
  );
  const ok = Boolean(
    fixtureInfraOk
    && rejected
    && externalAclUnchanged
    && contentUnchanged
    && linkRemoved
  );
  const result = {
    kind,
    available: true,
    ok,
    external,
    link,
    target,
    realTarget,
    linkCreated,
    fixtureInfraOk,
    beforeEvidenceOk,
    afterEvidenceOk,
    rejected,
    externalAclUnchanged,
    contentUnchanged,
    linkRemoved,
    setupError,
    hardenError,
    before,
    after,
  };
  console.log(`${PREFIX} ancestor reparse containment result ${JSON.stringify(result, null, 2)}`);
  if (!ok) failures.push(`${kind}: ancestor reparse boundary did not fail closed`);
  return result;
}

function classifyResults(results) {
  const original = results.find((result) => result.kind === 'mkdtemp-original');
  const longPath = results.find((result) => result.kind === 'win32-long-path');
  const shortPath = results.find((result) => result.kind === 'win32-short-path');
  const liveWal = results.find((result) => result.kind === 'live-wal-second-connection');
  const reparse = results.find((result) => result.kind === 'reparse-containment');
  const ancestorReparse = results.find((result) => result.kind === 'ancestor-reparse-containment');
  if (!reparse) return 'REPARSE_CONTAINMENT_SCENARIO_MISSING';
  if (!reparse.fixtureInfraOk || !reparse.mutationEvidenceOk) {
    return 'REPARSE_CONTAINMENT_PROBE_INFRA_FAILURE';
  }
  if (reparse.ok !== true) {
    if (reparse.externalAclUnchanged === false) return 'REPARSE_EXTERNAL_ACL_MUTATION';
    return 'REPARSE_CONTAINMENT_FAILURE';
  }
  if (!ancestorReparse) return 'ANCESTOR_REPARSE_CONTAINMENT_SCENARIO_MISSING';
  if (!ancestorReparse.fixtureInfraOk) return 'ANCESTOR_REPARSE_CONTAINMENT_PROBE_INFRA_FAILURE';
  if (ancestorReparse.ok !== true) return 'ANCESTOR_REPARSE_CONTAINMENT_FAILURE';
  const availableBaseResults = [original, longPath, shortPath].filter((result) => (
    result && result.available !== false
  ));
  if (availableBaseResults.some((result) => !result.initialHardenCommandOk)) {
    return 'BASE_INITIAL_HARDEN_COMMAND_FAILURE';
  }
  if (availableBaseResults.some((result) => !result.rehardenCommandOk)) {
    return 'BASE_REHARDEN_COMMAND_FAILURE';
  }
  if (original && original.emptyDaclRecovery && original.emptyDaclRecovery.attempted) {
    if (!original.emptyDaclRecovery.fixtureEstablished) {
      return 'EMPTY_DACL_RECOVERY_PROBE_INFRA_FAILURE';
    }
    if (!original.emptyDaclRecovery.aclRecovered) return 'EMPTY_DACL_RECOVERY_FAILURE';
  }
  const wideAclResults = [longPath, shortPath].filter((result) => (
    result && result.wideAclRepair && result.wideAclRepair.attempted
  ));
  if (wideAclResults.some((result) => !result.wideAclRepair.fixtureEstablished)) {
    return 'WIDE_ACL_REPAIR_PROBE_INFRA_FAILURE';
  }
  if (wideAclResults.some((result) => !result.wideAclRepair.aclRepaired)) {
    return 'WIDE_ACL_REPAIR_FAILURE';
  }
  const nestedResults = [original, longPath, shortPath].filter((result) => (
    result && result.nestedFixture && result.nestedFixture.attempted
  ));
  if (nestedResults.some((result) => !result.nestedFixture.fixtureEstablished)) {
    return 'NESTED_ACL_PROPAGATION_PROBE_INFRA_FAILURE';
  }
  if (nestedResults.some((result) => (
    !result.nestedFixture.repaired || !result.nestedFixture.inheritedChildOk
  ))) return 'NESTED_ACL_PROPAGATION_FAILURE';
  if (availableBaseResults.some((result) => (
    !aclAuditAvailable(result.initialPrivateAcl)
    || !aclAuditAvailable(result.secondPrivateAcl)
    || !result.beforeAclOk
    || !result.afterAclOk
    || !result.afterFirstCloseAclOk
    || !result.afterSecondHardenAclOk
  ))) return 'BASE_ACL_EVIDENCE_PROBE_INFRA_FAILURE';
  if (availableBaseResults.some((result) => (
    !result.initialPrivateAclOk
    || !result.secondPrivateAclOk
    || !result.dbItemPrivateAclOk
    || !result.nestedSubtreePrivateAclOk
  ))) return 'BASE_PRIVATE_ACL_SEMANTICS_FAILURE';
  // Base path/reopen failures take precedence. A live-WAL label is meaningful
  // only after the independent first-open and clean-close reopen cases pass.
  if (longPath && longPath.pathSqliteOk === false) return 'WINDOWS_LONG_PATH_OR_GENERAL_SQLITE_FAILURE';
  if (original && original.pathSqliteOk === false && longPath && longPath.pathSqliteOk === true) {
    return shortPath && shortPath.available && shortPath.pathSqliteOk === false
      ? 'PATH_FORM_SPECIFIC_OR_RUNNER_8DOT3'
      : 'MKDTEMP_ORIGINAL_PATH_SPECIFIC';
  }
  const baseOk = Boolean(
    original && original.pathSqliteOk === true
    && longPath && longPath.pathSqliteOk === true
    && (!shortPath || !shortPath.available || shortPath.pathSqliteOk === true)
  );
  if (!baseOk) return 'MIXED_BASE_PATH_RESULTS_REVIEW_FULL_LOG';
  if (!liveWal) return 'LIVE_WAL_SCENARIO_MISSING';
  if (!liveWal.probeInfraOk) {
    return liveWal.sidecarsPresentBefore
      ? 'LIVE_WAL_PROBE_INFRA_FAILURE'
      : 'LIVE_WAL_NOT_ESTABLISHED';
  }
  if (!liveWal.recursiveHardenCommandOk) return 'LIVE_WAL_RECURSIVE_HARDEN_COMMAND_FAILURE';
  if (!liveWal.secondConnectionConstructorOk) return 'LIVE_WAL_SECOND_CONNECTION_CONSTRUCTOR_FAILURE';
  if (!liveWal.postHardenEvidenceOk) return 'LIVE_WAL_POST_HARDEN_EVIDENCE_FAILURE';
  if (!liveWal.secondConnectionPostConstructorOk) return 'LIVE_WAL_SECOND_CONNECTION_POST_CONSTRUCTOR_FAILURE';
  if (!liveWal.secondConnectionCloseOk) return 'LIVE_WAL_SECOND_CONNECTION_CLOSE_FAILURE';
  if (!liveWal.secondConnectionWhileKeeperLiveOk) return 'LIVE_WAL_SECOND_CONNECTION_MIXED_FAILURE';
  if (!liveWal.keeperAfterHardenOk) return 'LIVE_WAL_KEEPER_ACCESS_FAILURE';
  if (!liveWal.cleanCloseReopenOk) return 'CLEAN_REOPEN_AFTER_LIVE_FAILURE';
  if (liveWal.ok === true) return SUCCESS_CLASSIFICATION;
  return 'MIXED_LIVE_WAL_RESULTS_REVIEW_FULL_LOG';
}

function main() {
  if (process.platform !== 'win32') {
    console.log(`${PREFIX} SKIP: Windows-only icacls and SQLite probe.`);
    return;
  }

  process.env.SQLITE_USE_URI = '1';
  const Database = require('better-sqlite3');
  const { hardenPrivateDir, ensurePrivateFile } = require('./secure-fs');

  const failures = [];
  const roots = [];
  const results = [];

  try {
    const whoami = runCommand('whoami', 'whoami', []);
    console.log(`${PREFIX} whoami parsed identity ${JSON.stringify(String(whoami.stdout || '').trim())}`);
    if (whoami.error || whoami.status !== 0) failures.push('whoami failed');
    for (const kind of ['mkdtemp-original', 'win32-long-path', 'win32-short-path']) {
      results.push(runScenario({ Database, hardenPrivateDir, ensurePrivateFile, kind, failures, roots }));
    }
    results.push(runLiveConnectionScenario({
      Database,
      hardenPrivateDir,
      ensurePrivateFile,
      failures,
      roots,
    }));
    results.push(runReparseContainmentScenario({
      hardenPrivateDir,
      failures,
      roots,
    }));
    results.push(runAncestorReparseScenario({
      hardenPrivateDir,
      failures,
      roots,
    }));
    const classification = classifyResults(results);
    console.log(`${PREFIX} classification ${JSON.stringify({
      classification,
      results: results.map((result) => {
        const {
          kind,
          available,
          ok,
          hardenTarget,
          firstSqlite,
          reopenedSqlite,
          secondConnection,
          cleanReopen,
        } = result;
        return {
          kind,
          available,
          ok,
          hardenTarget: hardenTarget || result.root || null,
          firstSqliteOk: firstSqlite ? firstSqlite.ok : null,
          firstSqliteOpened: firstSqlite ? firstSqlite.opened : null,
          firstSqliteFailureStage: firstSqlite ? firstSqlite.failureStage : null,
          firstSqliteConstructorCode: firstSqlite && firstSqlite.constructorError
            ? firstSqlite.constructorError.code
            : null,
          firstSqliteOperationCode: firstSqlite && firstSqlite.operationError
            ? firstSqlite.operationError.code
            : null,
          firstSqliteErrno: firstSqlite ? firstSqlite.errno : null,
          reopenedSqliteOk: reopenedSqlite ? reopenedSqlite.ok : null,
          reopenedSqliteOpened: reopenedSqlite ? reopenedSqlite.opened : null,
          reopenedSqliteFailureStage: reopenedSqlite ? reopenedSqlite.failureStage : null,
          reopenedSqliteConstructorCode: reopenedSqlite && reopenedSqlite.constructorError
            ? reopenedSqlite.constructorError.code
            : null,
          reopenedSqliteOperationCode: reopenedSqlite && reopenedSqlite.operationError
            ? reopenedSqlite.operationError.code
            : null,
          reopenedSqliteErrno: reopenedSqlite ? reopenedSqlite.errno : null,
          liveSecondConnectionOk: secondConnection ? secondConnection.ok : null,
          liveSecondConnectionOpened: secondConnection ? secondConnection.opened : null,
          liveSecondConnectionFailureStage: secondConnection ? secondConnection.failureStage : null,
          liveSecondConnectionConstructorCode: secondConnection && secondConnection.constructorError
            ? secondConnection.constructorError.code
            : null,
          liveSecondConnectionOperationCode: secondConnection && secondConnection.operationError
            ? secondConnection.operationError.code
            : null,
          cleanReopenOk: cleanReopen ? cleanReopen.ok : null,
          cleanReopenOpened: cleanReopen ? cleanReopen.opened : null,
          cleanReopenFailureStage: cleanReopen ? cleanReopen.failureStage : null,
          cleanReopenConstructorCode: cleanReopen && cleanReopen.constructorError
            ? cleanReopen.constructorError.code
            : null,
          cleanReopenOperationCode: cleanReopen && cleanReopen.operationError
            ? cleanReopen.operationError.code
            : null,
          initialPrivateAclOk: result.initialPrivateAclOk ?? null,
          secondPrivateAclOk: result.secondPrivateAclOk ?? null,
          dbItemPrivateAclOk: result.dbItemPrivateAclOk ?? null,
          nestedSubtreePrivateAclOk: result.nestedSubtreePrivateAclOk ?? null,
          pathSqliteOk: result.pathSqliteOk ?? null,
          emptyDaclObserved: result.emptyDaclRecovery
            ? result.emptyDaclRecovery.observed
            : null,
          emptyDaclRecovered: result.emptyDaclRecovery
            ? result.emptyDaclRecovery.recovered
            : null,
          wideAclObserved: result.wideAclRepair
            ? result.wideAclRepair.observed
            : null,
          wideAclRepaired: result.wideAclRepair
            ? result.wideAclRepair.repaired
            : null,
          livePrivateAclAfterOk: result.livePrivateAclAfterOk ?? null,
          cleanPrivateAclOk: result.cleanPrivateAclOk ?? null,
          reparseCreated: result.junctionCreated ?? null,
          reparseProbeInfraOk: result.kind === 'reparse-containment'
            ? result.fixtureInfraOk
            : null,
          reparseRejectedBeforeMutation: result.rejectedBeforeMutation ?? null,
          externalAclUnchanged: result.externalAclUnchanged ?? null,
          sentinelContentUnchanged: result.sentinelContentUnchanged ?? null,
          ancestorReparseRejected: result.kind === 'ancestor-reparse-containment'
            ? result.rejected
            : null,
          ancestorReparseProbeInfraOk: result.kind === 'ancestor-reparse-containment'
            ? result.fixtureInfraOk
            : null,
          ancestorExternalAclUnchanged: result.kind === 'ancestor-reparse-containment'
            ? result.externalAclUnchanged
            : null,
          nestedAclPropagationOk: result.nestedFixture
            ? result.nestedFixture.inheritedChildOk
            : null,
        };
      }),
    }, null, 2)}`);
    if (classification !== SUCCESS_CLASSIFICATION) {
      failures.push(`classification: ${classification}`);
    }
  } catch (error) {
    failures.push(`unexpected probe error: ${error.message || error}`);
    console.log(`${PREFIX} unexpected error ${JSON.stringify(describeError(error), null, 2)}`);
  } finally {
    for (const root of roots.reverse()) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        console.log(`${PREFIX} cleanup ${JSON.stringify({ ok: true, root })}`);
      } catch (error) {
        failures.push(`cleanup failed: ${root}`);
        console.log(`${PREFIX} cleanup ${JSON.stringify({ ok: false, root, error: describeError(error) }, null, 2)}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Windows private-directory probe failed: ${failures.join('; ')}`);
  }
  console.log(`${PREFIX} PASS: hardenPrivateDir preserved private ACL semantics, SQLite reopen/live-WAL access, empty-DACL recovery, and reparse containment.`);
}

try {
  main();
} catch (error) {
  console.error(`${PREFIX} FATAL ${JSON.stringify(describeError(error), null, 2)}`);
  process.exitCode = 1;
}
