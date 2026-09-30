[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArtifactPath,
  [Parameter(Mandatory = $true)][string]$EvidencePath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') { throw 'Authenticode evidence must be collected on Windows.' }
$artifact = (Resolve-Path -LiteralPath $ArtifactPath).Path
if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) { throw "Artifact is not a file: $artifact" }
$output = [System.IO.Path]::GetFullPath($EvidencePath)
if (Test-Path -LiteralPath $output) { throw "Evidence output already exists: $output" }
$parent = Split-Path -Parent $output
if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }

$signature = Get-AuthenticodeSignature -LiteralPath $artifact
$certificate = $signature.SignerCertificate
$evidence = [ordered]@{
  schema_version = 'hrboss_windows_authenticode_v1'
  collected_at = [DateTime]::UtcNow.ToString('o')
  artifact_name = [System.IO.Path]::GetFileName($artifact)
  artifact_sha256 = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
  status = [string]$signature.Status
  signer_subject = if ($certificate) { [string]$certificate.Subject } else { $null }
  signer_thumbprint = if ($certificate) { [string]$certificate.Thumbprint } else { $null }
  certificate_not_after = if ($certificate) { $certificate.NotAfter.ToUniversalTime().ToString('o') } else { $null }
}

$encoding = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($output, ($evidence | ConvertTo-Json -Depth 4), $encoding)
Write-Host "Authenticode evidence written: $output"
