[CmdletBinding()]
param(
  [string]$PackagePath = (Join-Path $PSScriptRoot '..\dist\招才官-win32-x64'),
  [string]$EvidenceRoot = (Join-Path (Get-Location) 'windows-acceptance-evidence'),
  [int]$StartupTimeoutSeconds = 45,
  [int]$ShutdownTimeoutSeconds = 20,
  [switch]$RequireAuthenticode,
  [switch]$KeepTestData
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:Checks = New-Object 'System.Collections.Generic.List[object]'
$script:OwnedProcessIds = New-Object 'System.Collections.Generic.HashSet[int]'
$script:RuntimeRoot = $null
$script:RunDirectory = $null
$script:PackageDirectory = $null
$script:ExecutablePath = $null
$script:SavedEnvironment = @{}

function Write-Utf8File {
  param([string]$Path, [string]$Content)
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Add-Check {
  param(
    [ValidateSet('PASS', 'WARN', 'FAIL')][string]$Status,
    [string]$Code,
    [string]$Title,
    [string]$Detail
  )
  $item = [pscustomobject]@{
    status = $Status
    code = $Code
    title = $Title
    detail = $Detail
  }
  $script:Checks.Add($item)
  $color = if ($Status -eq 'PASS') { 'Green' } elseif ($Status -eq 'WARN') { 'Yellow' } else { 'Red' }
  Write-Host ("[{0}] {1}: {2}" -f $Status, $Title, $Detail) -ForegroundColor $color
}

function Save-EnvironmentValue {
  param([string]$Name)
  if (-not $script:SavedEnvironment.ContainsKey($Name)) {
    $script:SavedEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
  }
}

function Set-TestEnvironmentValue {
  param([string]$Name, [AllowNull()][string]$Value)
  Save-EnvironmentValue -Name $Name
  [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

function Restore-TestEnvironment {
  foreach ($entry in $script:SavedEnvironment.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable([string]$entry.Key, $entry.Value, 'Process')
  }
}

function Quote-ProcessArgument {
  param([string]$Value)
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Resolve-PackageLayout {
  param([string]$InputPath)
  $resolved = (Resolve-Path -LiteralPath $InputPath).Path
  if (Test-Path -LiteralPath $resolved -PathType Container) {
    $exe = Join-Path $resolved 'ZhaocaiGuan.exe'
    $dir = $resolved
  } else {
    $exe = $resolved
    $dir = Split-Path -Parent $resolved
  }
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "未找到 ZhaocaiGuan.exe：$exe"
  }
  return [pscustomobject]@{ Directory = $dir; Executable = $exe }
}

function Get-PeMachine {
  param([string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $reader = New-Object System.IO.BinaryReader($stream)
    if ($reader.ReadUInt16() -ne 0x5A4D) { return 'not-mz' }
    $stream.Seek(0x3C, [System.IO.SeekOrigin]::Begin) | Out-Null
    $peOffset = $reader.ReadUInt32()
    $stream.Seek($peOffset, [System.IO.SeekOrigin]::Begin) | Out-Null
    if ($reader.ReadUInt32() -ne 0x00004550) { return 'not-pe' }
    $machine = $reader.ReadUInt16()
    switch ($machine) {
      0x8664 { return 'x64' }
      0x014c { return 'x86' }
      0xAA64 { return 'arm64' }
      default { return ('0x{0:X4}' -f $machine) }
    }
  } finally {
    $stream.Dispose()
  }
}

function Get-PayloadTreeSha256 {
  param([string]$Root)
  $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $relativePaths = New-Object 'System.Collections.Generic.List[string]'
  foreach ($file in @(Get-ChildItem -LiteralPath $rootPath -File -Recurse -Force)) {
    $relative = $file.FullName.Substring($rootPath.Length).TrimStart('\', '/').Replace('\', '/')
    if ($relative -eq 'ZhaocaiGuan.exe') { continue }
    $relativePaths.Add($relative)
  }
  $ordered = $relativePaths.ToArray()
  [Array]::Sort($ordered, [System.StringComparer]::Ordinal)
  $lines = New-Object 'System.Collections.Generic.List[string]'
  foreach ($relative in $ordered) {
    $fullPath = Join-Path $rootPath ($relative.Replace('/', '\'))
    $hash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $lines.Add("$hash  $relative")
  }
  $content = ($lines.ToArray() -join "`n") + "`n"
  $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($content)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-ProcessTree {
  param([int]$RootProcessId)
  $all = @(Get-CimInstance Win32_Process)
  $known = New-Object 'System.Collections.Generic.HashSet[int]'
  $known.Add($RootProcessId) | Out-Null
  do {
    $changed = $false
    foreach ($process in $all) {
      $parentId = [int]$process.ParentProcessId
      $processId = [int]$process.ProcessId
      if ($known.Contains($parentId) -and $known.Add($processId)) {
        $changed = $true
      }
    }
  } while ($changed)
  return @($all | Where-Object { $known.Contains([int]$_.ProcessId) })
}

function Register-OwnedProcesses {
  param([object[]]$Processes)
  foreach ($process in @($Processes)) {
    $script:OwnedProcessIds.Add([int]$process.ProcessId) | Out-Null
  }
}

function Get-PackageProcesses {
  if (-not $script:PackageDirectory) { return @() }
  $prefix = [System.IO.Path]::GetFullPath($script:PackageDirectory).TrimEnd('\') + '\'
  return @(Get-CimInstance Win32_Process | Where-Object {
    if (-not $_.ExecutablePath) { return $false }
    $candidate = [System.IO.Path]::GetFullPath([string]$_.ExecutablePath)
    return $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
  })
}

function Get-ListeningEndpoints {
  param([int[]]$ProcessIds)
  $set = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($processId in @($ProcessIds)) { $set.Add([int]$processId) | Out-Null }
  try {
    return @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {
      $set.Contains([int]$_.OwningProcess)
    } | Select-Object @{Name='ProcessId';Expression={[int]$_.OwningProcess}}, LocalAddress, LocalPort, State)
  } catch {
    $rows = New-Object 'System.Collections.Generic.List[object]'
    foreach ($line in @(& netstat.exe -ano -p tcp)) {
      if ($line -notmatch '^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$') { continue }
      $endpoint = $Matches[1]
      $processId = [int]$Matches[2]
      if (-not $set.Contains($processId)) { continue }
      if ($endpoint -notmatch '^(.*):(\d+)$') { continue }
      $rows.Add([pscustomobject]@{
        ProcessId = $processId
        LocalAddress = $Matches[1].Trim('[', ']')
        LocalPort = [int]$Matches[2]
        State = 'Listen'
      })
    }
    return @($rows)
  }
}

function Wait-ForApplicationReady {
  param(
    [System.Diagnostics.Process]$Process,
    [string]$DatabasePath,
    [int]$TimeoutSeconds
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastTree = @()
  $lastListeners = @()
  while ([DateTime]::UtcNow -lt $deadline) {
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "应用在就绪前退出，退出码 $($Process.ExitCode)。"
    }
    $lastTree = @(Get-ProcessTree -RootProcessId $Process.Id)
    Register-OwnedProcesses -Processes $lastTree
    $lastListeners = @(Get-ListeningEndpoints -ProcessIds @($lastTree | ForEach-Object { [int]$_.ProcessId }))
    if ((Test-Path -LiteralPath $DatabasePath -PathType Leaf) -and $lastListeners.Count -ge 2 -and $Process.MainWindowHandle -ne 0) {
      return [pscustomobject]@{ Processes = $lastTree; Listeners = $lastListeners }
    }
    Start-Sleep -Milliseconds 500
  }
  throw "应用在 $TimeoutSeconds 秒内未就绪；最后观察到 $($lastTree.Count) 个进程、$($lastListeners.Count) 个监听端口。"
}

function Start-IsolatedApplication {
  param([int]$Cycle, [string]$UserDataDirectory, [string]$DatabasePath)
  $stdout = Join-Path $script:RunDirectory ("cycle-{0}-stdout.log" -f $Cycle)
  $stderr = Join-Path $script:RunDirectory ("cycle-{0}-stderr.log" -f $Cycle)
  $argument = '--user-data-dir=' + (Quote-ProcessArgument -Value $UserDataDirectory)
  Set-TestEnvironmentValue -Name 'ELECTRON_RUN_AS_NODE' -Value $null
  $process = Start-Process -FilePath $script:ExecutablePath -ArgumentList $argument -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $script:OwnedProcessIds.Add([int]$process.Id) | Out-Null
  $ready = Wait-ForApplicationReady -Process $process -DatabasePath $DatabasePath -TimeoutSeconds $StartupTimeoutSeconds
  $ready.Processes | Select-Object Name, ProcessId, ParentProcessId, ExecutablePath, CommandLine | Export-Csv -LiteralPath (Join-Path $script:RunDirectory ("cycle-{0}-processes.csv" -f $Cycle)) -NoTypeInformation -Encoding UTF8
  $ready.Listeners | Export-Csv -LiteralPath (Join-Path $script:RunDirectory ("cycle-{0}-listeners.csv" -f $Cycle)) -NoTypeInformation -Encoding UTF8
  return [pscustomobject]@{ Process = $process; Ready = $ready }
}

function Stop-IsolatedApplication {
  param([int]$Cycle, [System.Diagnostics.Process]$Process)
  $knownTree = @(Get-ProcessTree -RootProcessId $Process.Id)
  Register-OwnedProcesses -Processes $knownTree
  $Process.Refresh()
  if ($Process.HasExited) { throw "第 $Cycle 轮应用在请求关闭前已退出。" }
  if (-not $Process.CloseMainWindow()) { throw "第 $Cycle 轮无法向主窗口发送正常关闭请求。" }
  $deadline = [DateTime]::UtcNow.AddSeconds($ShutdownTimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $remaining = @(Get-PackageProcesses | Where-Object { $script:OwnedProcessIds.Contains([int]$_.ProcessId) })
    if ($remaining.Count -eq 0) { return }
    Register-OwnedProcesses -Processes $remaining
    Start-Sleep -Milliseconds 300
  }
  $remaining = @(Get-PackageProcesses | Where-Object { $script:OwnedProcessIds.Contains([int]$_.ProcessId) })
  $remaining | Select-Object Name, ProcessId, ParentProcessId, ExecutablePath, CommandLine | Export-Csv -LiteralPath (Join-Path $script:RunDirectory ("cycle-{0}-residual.csv" -f $Cycle)) -NoTypeInformation -Encoding UTF8
  throw "第 $Cycle 轮正常退出后仍残留 $($remaining.Count) 个应用进程。"
}

function Invoke-DatabaseProbe {
  param([ValidateSet('write', 'read')][string]$Mode, [string]$ModuleDirectory, [string]$DatabasePath, [string]$Marker)
  $probeScript = Join-Path $script:RuntimeRoot 'database-probe.js'
  $probeSource = @'
'use strict';
const Database = require(process.argv[2]);
const databasePath = process.argv[3];
const mode = process.argv[4];
const marker = process.argv[5];
const db = new Database(databasePath);
try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
  if (!tables.includes('audit_log') || !tables.includes('candidate') || !tables.includes('interview_recording_consent')) {
    throw new Error('required Zhaocai Guan schema is incomplete');
  }
  if (mode === 'write') {
    db.prepare(`
      INSERT INTO audit_log(action, target, who, auto, result, detail_json, created_at)
      VALUES (?, ?, ?, 0, 'ok', ?, ?)
    `).run('windows_release_acceptance_probe', marker, 'windows-self-test', JSON.stringify({ marker }), new Date().toISOString());
    process.stdout.write(JSON.stringify({ ok: true, mode, marker, tableCount: tables.length }));
  } else if (mode === 'read') {
    const row = db.prepare(`
      SELECT id, action, target, result
      FROM audit_log
      WHERE action = 'windows_release_acceptance_probe' AND target = ?
      ORDER BY id DESC LIMIT 1
    `).get(marker);
    if (!row) throw new Error('persistence marker was not found after restart');
    process.stdout.write(JSON.stringify({ ok: true, mode, marker, row, tableCount: tables.length }));
  } else {
    throw new Error(`unknown probe mode: ${mode}`);
  }
} finally {
  db.close();
}
'@
  Write-Utf8File -Path $probeScript -Content $probeSource
  $stdout = Join-Path $script:RunDirectory ("database-probe-{0}.json" -f $Mode)
  $stderr = Join-Path $script:RunDirectory ("database-probe-{0}.log" -f $Mode)
  $arguments = @($probeScript, $ModuleDirectory, $DatabasePath, $Mode, $Marker) | ForEach-Object { Quote-ProcessArgument -Value ([string]$_) }
  Set-TestEnvironmentValue -Name 'ELECTRON_RUN_AS_NODE' -Value '1'
  try {
    $probe = Start-Process -FilePath $script:ExecutablePath -ArgumentList ($arguments -join ' ') -PassThru -Wait -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  } finally {
    Set-TestEnvironmentValue -Name 'ELECTRON_RUN_AS_NODE' -Value $null
  }
  if ($probe.ExitCode -ne 0) {
    $message = if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Raw } else { 'no probe log' }
    throw "数据库 $Mode 探针失败，退出码 $($probe.ExitCode)：$message"
  }
  return (Get-Content -LiteralPath $stdout -Raw | ConvertFrom-Json)
}

function Test-PrivateAcl {
  param([string]$Root)
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $issues = New-Object 'System.Collections.Generic.List[string]'
  $items = @((Get-Item -LiteralPath $Root -Force)) + @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
  foreach ($item in $items) {
    $acl = Get-Acl -LiteralPath $item.FullName
    $hasCurrentUserFullControl = $false
    foreach ($rule in @($acl.Access)) {
      try {
        $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      } catch {
        $issues.Add("identity-unresolved:$($item.FullName):$($rule.IdentityReference)")
        continue
      }
      if ($rule.IsInherited) { $issues.Add("inherited:$($item.FullName):$ruleSid") }
      if ($ruleSid -ne $currentSid) { $issues.Add("unexpected-principal:$($item.FullName):$ruleSid") }
      $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
      if ($ruleSid -eq $currentSid -and $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and (($rule.FileSystemRights -band $fullControl) -eq $fullControl)) {
        $hasCurrentUserFullControl = $true
      }
    }
    if (-not $hasCurrentUserFullControl) { $issues.Add("missing-current-user-full-control:$($item.FullName)") }
  }
  return [pscustomobject]@{ Ok = ($issues.Count -eq 0); Issues = @($issues); ItemCount = $items.Count; CurrentSid = $currentSid }
}

function Stop-OwnedProcessesForCleanup {
  foreach ($process in @(Get-PackageProcesses | Where-Object { $script:OwnedProcessIds.Contains([int]$_.ProcessId) })) {
    try { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop } catch {}
  }
}

function Write-FinalEvidence {
  param([datetime]$StartedAt, [string]$RunId, [hashtable]$Metadata)
  if (-not $script:RunDirectory) { return }
  $failures = @($script:Checks | Where-Object { $_.status -eq 'FAIL' })
  $warnings = @($script:Checks | Where-Object { $_.status -eq 'WARN' })
  $technicalResult = if ($failures.Count -eq 0) { 'PASS' } else { 'FAIL' }
  $releaseDecision = if ($failures.Count -gt 0) { 'NO-GO' } else { 'GO WITH CONDITIONS' }
  $summary = [ordered]@{
    schema_version = 'hrboss_windows_acceptance_v1'
    run_id = $RunId
    started_at = $StartedAt.ToUniversalTime().ToString('o')
    finished_at = [DateTime]::UtcNow.ToString('o')
    technical_result = $technicalResult
    release_decision = $releaseDecision
    decision_note = if ($failures.Count -gt 0) { '存在自动化失败项。' } else { '自动化通过；仍须完成人工录音、授权 Boss 小流量、安装升级卸载、签名与数据治理门禁。' }
    require_authenticode = [bool]$RequireAuthenticode
    package = $Metadata
    failure_count = $failures.Count
    warning_count = $warnings.Count
    checks = @($script:Checks)
  }
  Write-Utf8File -Path (Join-Path $script:RunDirectory 'summary.json') -Content ($summary | ConvertTo-Json -Depth 8)

  $lines = New-Object 'System.Collections.Generic.List[string]'
  $lines.Add('# 招才官 Windows 自动验收摘要')
  $lines.Add('')
  $lines.Add("- Run ID: $RunId")
  $lines.Add("- 自动技术结果: **$technicalResult**")
  $lines.Add("- 发布判定: **$releaseDecision**")
  $lines.Add("- 失败: $($failures.Count)；警告: $($warnings.Count)")
  $lines.Add('- 说明：自动化通过不替代人工录音、Boss 授权小流量、安装/升级/卸载、代码签名和数据治理签字。')
  $lines.Add('')
  $lines.Add('| 状态 | 编号 | 检查 | 证据 |')
  $lines.Add('|---|---|---|---|')
  foreach ($check in $script:Checks) {
    $detail = ([string]$check.detail).Replace('|', '\|').Replace("`r", ' ').Replace("`n", ' ')
    $lines.Add("| $($check.status) | $($check.code) | $($check.title) | $detail |")
  }
  Write-Utf8File -Path (Join-Path $script:RunDirectory 'summary.md') -Content ($lines -join "`n")
  Write-Host "证据目录：$($script:RunDirectory)" -ForegroundColor Cyan
  Write-Host "自动技术结果：$technicalResult；发布判定：$releaseDecision" -ForegroundColor Cyan
}

$startedAt = Get-Date
$runId = '{0}-{1}' -f $startedAt.ToString('yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 8))
$metadata = @{}
$fatalMessage = $null

try {
  if ($env:OS -ne 'Windows_NT') { throw '本脚本只能在真实 Windows 上执行。' }
  if (-not [Environment]::Is64BitOperatingSystem) { throw '需要 64 位 Windows。' }

  $evidenceAbsolute = [System.IO.Path]::GetFullPath($EvidenceRoot)
  $script:RunDirectory = Join-Path $evidenceAbsolute $runId
  New-Item -ItemType Directory -Path $script:RunDirectory -Force | Out-Null
  $script:RuntimeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("HRBOSS-Windows-Acceptance-$runId")
  $userDataDirectory = Join-Path $script:RuntimeRoot 'user-data'
  $dataDirectory = Join-Path $userDataDirectory 'data'
  $databasePath = Join-Path $dataDirectory 'recruiting.db'
  New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
  Write-Utf8File -Path (Join-Path $dataDirectory 'acl-probe.txt') -Content 'isolated ACL reset probe; contains no production data.'

  $layout = Resolve-PackageLayout -InputPath $PackagePath
  $script:PackageDirectory = $layout.Directory
  $script:ExecutablePath = $layout.Executable
  $resourceDirectory = Join-Path $script:PackageDirectory 'resources\app'
  $packageJsonPath = Join-Path $resourceDirectory 'package.json'
  $mainSourcePath = Join-Path $resourceDirectory 'candidate-main.js'
  $preloadSourcePath = Join-Path $resourceDirectory 'preload.js'
  $nativeModulePath = Join-Path $resourceDirectory 'node_modules\better-sqlite3\build\Release\better_sqlite3.node'
  foreach ($required in @($packageJsonPath, $mainSourcePath, $preloadSourcePath, $nativeModulePath, (Join-Path $resourceDirectory 'frontend\dist\index.html'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Windows 包缺少必要文件：$required" }
  }
  $packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
  $exeHash = (Get-FileHash -LiteralPath $script:ExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $nativeHash = (Get-FileHash -LiteralPath $nativeModulePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $payloadTreeHash = Get-PayloadTreeSha256 -Root $script:PackageDirectory
  $metadata = @{
    product = [string]$packageJson.productName
    version = [string]$packageJson.version
    package_directory = $script:PackageDirectory
    executable = $script:ExecutablePath
    executable_sha256 = $exeHash
    native_module_sha256 = $nativeHash
    payload_tree_sha256 = $payloadTreeHash
    os = [Environment]::OSVersion.VersionString
    os_architecture = $env:PROCESSOR_ARCHITECTURE
    powershell = $PSVersionTable.PSVersion.ToString()
    computer = $env:COMPUTERNAME
    user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  }
  Write-Utf8File -Path (Join-Path $script:RunDirectory 'SHA256SUMS.txt') -Content ("$exeHash  ZhaocaiGuan.exe`n$nativeHash  better_sqlite3.node`n")
  Write-Utf8File -Path (Join-Path $script:RunDirectory 'environment.json') -Content ($metadata | ConvertTo-Json -Depth 4)
  Add-Check PASS 'HOST-WIN64' 'Windows x64 真机' "$([Environment]::OSVersion.VersionString) / $($metadata.os_architecture)"
  Add-Check PASS 'PKG-LAYOUT' '正式包布局完整' "$($packageJson.productName) $($packageJson.version)"

  $exeMachine = Get-PeMachine -Path $script:ExecutablePath
  $nativeMachine = Get-PeMachine -Path $nativeModulePath
  if ($exeMachine -ne 'x64' -or $nativeMachine -ne 'x64') {
    Add-Check FAIL 'PKG-PE64' 'Windows 原生架构' "exe=$exeMachine; better_sqlite3.node=$nativeMachine"
  } else {
    Add-Check PASS 'PKG-PE64' 'Windows 原生架构' '主程序与 better_sqlite3.node 均为 PE x64。'
  }

  $nodeExecutables = @(Get-ChildItem -LiteralPath $script:PackageDirectory -Filter 'node.exe' -File -Recurse -ErrorAction Stop)
  if ($nodeExecutables.Count -eq 0) {
    Add-Check PASS 'PKG-NODE' '不依赖外置或内置 node.exe' '包内没有 node.exe；数据库探针稍后使用 Electron 自带 Node。'
  } else {
    Add-Check FAIL 'PKG-NODE' '不依赖外置或内置 node.exe' (($nodeExecutables | ForEach-Object FullName) -join '; ')
  }

  $forbiddenFiles = New-Object 'System.Collections.Generic.List[string]'
  if (Test-Path -LiteralPath (Join-Path $resourceDirectory 'data')) { $forbiddenFiles.Add('resources/app/data') }
  if (Test-Path -LiteralPath (Join-Path $resourceDirectory 'rating-config.json')) { $forbiddenFiles.Add('resources/app/rating-config.json') }
  foreach ($file in @(Get-ChildItem -LiteralPath $resourceDirectory -Filter 'check-*.js' -File -Recurse -ErrorAction Stop)) { $forbiddenFiles.Add($file.FullName) }
  if ($forbiddenFiles.Count -eq 0) {
    Add-Check PASS 'PKG-CLEAN' '包内无历史数据、真实配置和检查脚本' '未发现 data、rating-config.json 或 check-*.js。'
  } else {
    Add-Check FAIL 'PKG-CLEAN' '包内无历史数据、真实配置和检查脚本' ($forbiddenFiles -join '; ')
  }

  $mainSource = Get-Content -LiteralPath $mainSourcePath -Raw
  $preloadSource = Get-Content -LiteralPath $preloadSourcePath -Raw
  if ($mainSource -match 'ELECTRON_RUN_AS_NODE' -and $mainSource -match 'availableLocalPort' -and $mainSource -notmatch 'spawn\([''"]node[''"]') {
    Add-Check PASS 'PKG-RUNTIME' '包内服务使用 Electron 与动态端口' '未调用系统 node；包含动态空闲端口分配。'
  } else {
    Add-Check FAIL 'PKG-RUNTIME' '包内服务使用 Electron 与动态端口' 'candidate-main.js 未满足运行时静态门禁。'
  }
  if ($mainSource -match 'assertTrustedRenderer' -and $preloadSource -notmatch 'getSession|local-api:session') {
    Add-Check PASS 'PKG-TOKEN' '本地令牌不暴露给 renderer' 'IPC 校验存在，preload 未暴露 session。'
  } else {
    Add-Check FAIL 'PKG-TOKEN' '本地令牌不暴露给 renderer' 'IPC/令牌静态门禁不满足。'
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $script:ExecutablePath
  $signatureDetail = "status=$($signature.Status)"
  if ($signature.SignerCertificate) {
    $signatureDetail += "; subject=$($signature.SignerCertificate.Subject); thumbprint=$($signature.SignerCertificate.Thumbprint)"
    $metadata.signer_subject = $signature.SignerCertificate.Subject
    $metadata.signer_thumbprint = $signature.SignerCertificate.Thumbprint
  }
  $metadata.authenticode_status = [string]$signature.Status
  if ($signature.Status -eq 'Valid') {
    Add-Check PASS 'SIGN-AUTHENTICODE' 'Authenticode 签名有效' $signatureDetail
  } elseif ($RequireAuthenticode) {
    Add-Check FAIL 'SIGN-AUTHENTICODE' 'Authenticode 签名有效' $signatureDetail
  } else {
    Add-Check WARN 'SIGN-AUTHENTICODE' 'Authenticode 签名尚未作为技术预发硬失败' "$signatureDetail；正式发布必须使用 -RequireAuthenticode 复验。"
  }

  $preexisting = @(Get-PackageProcesses)
  if ($preexisting.Count -gt 0) { throw "测试前已有同一包的进程在运行，请先正常退出：$($preexisting.ProcessId -join ', ')" }

  $aclSeedLog = Join-Path $script:RunDirectory 'acl-seed.log'
  & icacls.exe $dataDirectory /grant '*S-1-1-0:(OI)(CI)F' /T /C 2>&1 | Out-File -LiteralPath $aclSeedLog -Encoding UTF8
  if ($LASTEXITCODE -ne 0) { throw '无法在隔离测试目录写入 Everyone ACL 探针，不能验证旧宽松权限重置。' }
  $seedAcl = Get-Acl -LiteralPath $dataDirectory
  $everyoneSeeded = $false
  foreach ($rule in @($seedAcl.Access)) {
    try {
      if ($rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq 'S-1-1-0') { $everyoneSeeded = $true }
    } catch {}
  }
  if (-not $everyoneSeeded) { throw 'Everyone ACL 探针未生效，不能验证重置。' }
  Add-Check PASS 'ACL-SEED' '隔离目录已构造旧宽松 ACL' '仅对临时测试目录授予 Everyone，等待应用启动后验证自动移除。'

  $pathValues = @{
    HRBOSS_DATA_DIR = $dataDirectory
    BOSS_DB_PATH = $databasePath
    BOSS_PROFILE_DATA_DIR = (Join-Path $dataDirectory 'boss-profile')
    BOSS_RECOMMEND_PROGRESS_FILE = (Join-Path $dataDirectory 'recommend-fetch-progress.json')
    BOSS_JOB_SYNC_PROGRESS_FILE = (Join-Path $dataDirectory 'boss-jobs-sync-progress.json')
    BOSS_RESUME_PROGRESS_FILE = (Join-Path $dataDirectory 'resume-fetch-progress.json')
    BOSS_SCREENSHOT_IMPORT_PROGRESS_FILE = (Join-Path $dataDirectory 'screenshot-import-progress.json')
    HRBOSS_INTERVIEW_OUTPUT_DIR = (Join-Path $dataDirectory 'interviews')
    HRBOSS_RATING_CONFIG_PATH = (Join-Path $dataDirectory 'nonexistent-rating-config.json')
  }
  foreach ($entry in $pathValues.GetEnumerator()) { Set-TestEnvironmentValue -Name ([string]$entry.Key) -Value ([string]$entry.Value) }
  Set-TestEnvironmentValue -Name 'HRBOSS_RENDERER_URL' -Value $null
  Set-TestEnvironmentValue -Name 'HRBOSS_EXTERNAL_AI_ENABLED' -Value '0'
  Set-TestEnvironmentValue -Name 'BOSS_ACTION_AUTOMATION_ENABLED' -Value '0'
  Set-TestEnvironmentValue -Name 'ENABLE_LARK_IMPORT' -Value '0'
  Set-TestEnvironmentValue -Name 'BOSS_READONLY_UI' -Value '0'

  $cycle1 = Start-IsolatedApplication -Cycle 1 -UserDataDirectory $userDataDirectory -DatabasePath $databasePath
  Add-Check PASS 'RUN-START-1' '首次隔离启动' "$($cycle1.Ready.Processes.Count) 个进程；$($cycle1.Ready.Listeners.Count) 个监听端口。"
  $cycle1Endpoints = @($cycle1.Ready.Listeners | Sort-Object LocalAddress, LocalPort -Unique)
  $nonLoopback = @($cycle1Endpoints | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') })
  if ($nonLoopback.Count -gt 0 -or $cycle1Endpoints.Count -ne 2) {
    Add-Check FAIL 'RUN-LOOPBACK-1' '恰有两个本地服务且仅监听回环地址' (($cycle1Endpoints | ConvertTo-Json -Compress) -join '')
  } else {
    $ports = @($cycle1Endpoints | Select-Object -ExpandProperty LocalPort | Sort-Object)
    Add-Check PASS 'RUN-LOOPBACK-1' '恰有两个本地服务且仅监听回环地址' ("127.0.0.1 ports: {0}" -f ($ports -join ', '))
  }
  if (-not ([System.IO.Path]::GetFullPath($databasePath).StartsWith([System.IO.Path]::GetFullPath($userDataDirectory), [System.StringComparison]::OrdinalIgnoreCase))) {
    Add-Check FAIL 'DATA-PATH' '数据库位于隔离用户数据目录' $databasePath
  } elseif ((Get-Item -LiteralPath $databasePath).Length -le 0) {
    Add-Check FAIL 'DATA-PATH' '数据库位于隔离用户数据目录' '数据库为空文件。'
  } else {
    Add-Check PASS 'DATA-PATH' '数据库位于隔离用户数据目录' $databasePath
  }
  Stop-IsolatedApplication -Cycle 1 -Process $cycle1.Process
  Add-Check PASS 'RUN-QUIT-1' '首次正常退出无残留' '主窗口关闭后，主进程、只读服务、动作服务和子进程均退出。'

  & icacls.exe $dataDirectory /T /C 2>&1 | Out-File -LiteralPath (Join-Path $script:RunDirectory 'acl-after-cycle-1.log') -Encoding UTF8
  $aclResult = Test-PrivateAcl -Root $dataDirectory
  if ($aclResult.Ok) {
    Add-Check PASS 'ACL-PRIVATE' '旧宽松 ACL 已重置为当前用户专属' "$($aclResult.ItemCount) 个目录/文件；SID=$($aclResult.CurrentSid)。"
  } else {
    Write-Utf8File -Path (Join-Path $script:RunDirectory 'acl-issues.txt') -Content ($aclResult.Issues -join "`n")
    Add-Check FAIL 'ACL-PRIVATE' '旧宽松 ACL 已重置为当前用户专属' "$($aclResult.Issues.Count) 个问题，见 acl-issues.txt。"
  }

  $moduleDirectory = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $nativeModulePath))
  $marker = [guid]::NewGuid().ToString('N')
  $writeProbe = Invoke-DatabaseProbe -Mode write -ModuleDirectory $moduleDirectory -DatabasePath $databasePath -Marker $marker
  Add-Check PASS 'DB-WRITE' 'Electron 自带 Node 可加载 Windows SQLite 原生模块' "schema tables=$($writeProbe.tableCount); marker=$marker"

  $cycle2 = Start-IsolatedApplication -Cycle 2 -UserDataDirectory $userDataDirectory -DatabasePath $databasePath
  Add-Check PASS 'RUN-START-2' '同一数据目录重启' "$($cycle2.Ready.Processes.Count) 个进程；数据库重新打开。"
  $cycle2Endpoints = @($cycle2.Ready.Listeners | Sort-Object LocalAddress, LocalPort -Unique)
  $cycle2NonLoopback = @($cycle2Endpoints | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') })
  if ($cycle2NonLoopback.Count -gt 0 -or $cycle2Endpoints.Count -ne 2) {
    Add-Check FAIL 'RUN-LOOPBACK-2' '重启后仍恰有两个回环服务' (($cycle2Endpoints | ConvertTo-Json -Compress) -join '')
  } else {
    $cycle2Ports = @($cycle2Endpoints | Select-Object -ExpandProperty LocalPort | Sort-Object)
    Add-Check PASS 'RUN-LOOPBACK-2' '重启后仍恰有两个回环服务' ("127.0.0.1 ports: {0}" -f ($cycle2Ports -join ', '))
  }
  Stop-IsolatedApplication -Cycle 2 -Process $cycle2.Process
  Add-Check PASS 'RUN-QUIT-2' '第二次正常退出无残留' '重启后再次正常退出，未留下应用进程。'
  $readProbe = Invoke-DatabaseProbe -Mode read -ModuleDirectory $moduleDirectory -DatabasePath $databasePath -Marker $marker
  Add-Check PASS 'DB-PERSIST' 'SQLite 数据跨重启持久化' "audit_log id=$($readProbe.row.id); marker=$marker"

  $finalResidual = @(Get-PackageProcesses | Where-Object { $script:OwnedProcessIds.Contains([int]$_.ProcessId) })
  if ($finalResidual.Count -eq 0) {
    Add-Check PASS 'RUN-RESIDUAL' '最终无进程残留' '两轮启动/退出后未发现测试拥有的包进程。'
  } else {
    Add-Check FAIL 'RUN-RESIDUAL' '最终无进程残留' ($finalResidual.ProcessId -join ', ')
  }
} catch {
  $fatalMessage = $_.Exception.Message
  Add-Check FAIL 'FATAL' 'Windows 自动验收未完成' $fatalMessage
} finally {
  Stop-OwnedProcessesForCleanup
  Restore-TestEnvironment
  if ($script:RuntimeRoot -and (Test-Path -LiteralPath $script:RuntimeRoot) -and -not $KeepTestData) {
    try { Remove-Item -LiteralPath $script:RuntimeRoot -Recurse -Force -ErrorAction Stop } catch {
      Add-Check WARN 'CLEANUP' '隔离测试目录清理' "请人工删除：$($script:RuntimeRoot)。$($_.Exception.Message)"
    }
  } elseif ($script:RuntimeRoot -and $KeepTestData) {
    Add-Check WARN 'CLEANUP' '隔离测试目录按参数保留' $script:RuntimeRoot
  }
  Write-FinalEvidence -StartedAt $startedAt -RunId $runId -Metadata $metadata
}

$failureCount = @($script:Checks | Where-Object { $_.status -eq 'FAIL' }).Count
if ($failureCount -gt 0) { exit 1 }
exit 0
