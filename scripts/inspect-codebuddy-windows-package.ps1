[CmdletBinding()]
param(
    [string]$InstallerPath,
    [string]$PackagedAppPath,
    [string]$ExpectedReleaseBackendPath,
    [string]$EvidencePath,
    [ValidateRange(4096, 1048576)]
    [int]$MaxLogBytes = 65536,
    [ValidateRange(10, 300)]
    [int]$TimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$outRoot = Join-Path $repoRoot "ui\desktop\out"
$peInspectionScript = Join-Path $repoRoot "scripts\codebuddy-windows-pe.ps1"
. $peInspectionScript

if ([string]::IsNullOrWhiteSpace($ExpectedReleaseBackendPath)) {
    $ExpectedReleaseBackendPath = Join-Path $repoRoot "target\release\goose.exe"
}

function Resolve-SingleFile {
    param(
        [string]$ProvidedPath,
        [Parameter(Mandatory = $true)][string]$SearchRoot,
        [Parameter(Mandatory = $true)][string]$Filter,
        [Parameter(Mandatory = $true)][string]$Description
    )

    if (-not [string]::IsNullOrWhiteSpace($ProvidedPath)) {
        $resolved = [IO.Path]::GetFullPath($ProvidedPath)
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            throw "$Description was not found: $resolved"
        }
        return $resolved
    }

    $matches = @(Get-ChildItem -LiteralPath $SearchRoot -Filter $Filter -File -Recurse -ErrorAction SilentlyContinue)
    if ($matches.Count -ne 1) {
        throw "Expected exactly one $Description under $SearchRoot, found $($matches.Count). Pass its path explicitly."
    }
    return $matches[0].FullName
}

function Quote-ProcessArgument {
    param([AllowEmptyString()][string]$Argument)
    if ($Argument -notmatch '[\s"]') {
        return $Argument
    }
    return '"' + ($Argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Limit-Text {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrEmpty($Value)) {
        return ""
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    if ($bytes.Length -le $MaxLogBytes) {
        return $Value
    }
    return [Text.Encoding]::UTF8.GetString($bytes, 0, $MaxLogBytes) + "`n[TRUNCATED]"
}

function Invoke-BoundedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = (($Arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join " ")
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw "Failed to execute package probe: $FilePath"
        }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            $process.WaitForExit()
            throw "Package probe timed out after $TimeoutSeconds seconds."
        }
        return [ordered]@{
            exitCode = $process.ExitCode
            stdout = Limit-Text $stdout.GetAwaiter().GetResult()
            stderr = Limit-Text $stderr.GetAwaiter().GetResult()
        }
    }
    finally {
        $process.Dispose()
    }
}

function Get-ArtifactEvidence {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-Item -LiteralPath $Path
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    return [ordered]@{
        path = $item.FullName
        bytes = $item.Length
        sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        signatureStatus = $signature.Status.ToString()
        signerSubject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
        productVersion = $item.VersionInfo.ProductVersion
        fileVersion = $item.VersionInfo.FileVersion
    }
}

if (-not (Test-Path -LiteralPath $outRoot -PathType Container)) {
    throw "Electron output directory was not found: $outRoot"
}

$InstallerPath = Resolve-SingleFile -ProvidedPath $InstallerPath `
    -SearchRoot (Join-Path $outRoot "make") -Filter "CodeBuddy-Setup.exe" `
    -Description "CodeBuddy installer"
$PackagedAppPath = Resolve-SingleFile -ProvidedPath $PackagedAppPath `
    -SearchRoot $outRoot -Filter "CodeBuddy.exe" -Description "packaged CodeBuddy executable"

if ([IO.Path]::GetFileName($InstallerPath) -ne "CodeBuddy-Setup.exe") {
    throw "Unexpected installer name: $InstallerPath"
}
if ($PackagedAppPath -notmatch '[\\/]CodeBuddy-win32-[^\\/]+[\\/]CodeBuddy\.exe$') {
    throw "The packaged executable is outside a CodeBuddy-win32 directory: $PackagedAppPath"
}

$packageRoot = Split-Path -Parent $PackagedAppPath
$resourcesRoot = Join-Path $packageRoot "resources"
$backendMatches = @(Get-ChildItem -LiteralPath $resourcesRoot -Filter "goose.exe" -File -Recurse -ErrorAction SilentlyContinue)
if ($backendMatches.Count -ne 1) {
    throw "Expected exactly one packaged resources goose.exe, found $($backendMatches.Count)."
}
$asarPath = Join-Path $resourcesRoot "app.asar"
if (-not (Test-Path -LiteralPath $asarPath -PathType Leaf)) {
    throw "The packaged Electron app is missing resources\app.asar."
}

$backendResourceDirectory = Split-Path -Parent $backendMatches[0].FullName
try {
    $backendReleaseEvidence = Assert-CodeBuddyReleaseBackend `
        -BackendPath $backendMatches[0].FullName `
        -ExpectedReleaseBackendPath $ExpectedReleaseBackendPath `
        -ResourceDirectory $backendResourceDirectory
}
catch {
    if (-not [string]::IsNullOrWhiteSpace($EvidencePath)) {
        $failedDependencies = $null
        try {
            $failedDependencies = Get-CodeBuddyPeDependencies -BackendPath $backendMatches[0].FullName
        }
        catch {
            $failedDependencies = [ordered]@{ error = $_.Exception.Message }
        }
        $failedEvidence = [ordered]@{
            schemaVersion = 2
            checkedAtUtc = [DateTime]::UtcNow.ToString("o")
            result = "fail"
            error = $_.Exception.Message
            backend = Get-ArtifactEvidence $backendMatches[0].FullName
            backendDependencies = $failedDependencies
        } | ConvertTo-Json -Depth 8
        $resolvedFailureEvidence = [IO.Path]::GetFullPath($EvidencePath)
        New-Item -ItemType Directory -Path (Split-Path -Parent $resolvedFailureEvidence) -Force | Out-Null
        [IO.File]::WriteAllText(
            $resolvedFailureEvidence,
            $failedEvidence + "`n",
            [Text.UTF8Encoding]::new($false)
        )
        Write-Output "EVIDENCE_PATH=$resolvedFailureEvidence"
    }
    throw
}

$backendProbe = Invoke-BoundedProcess -FilePath $backendMatches[0].FullName -Arguments @("--version")
if ($backendProbe.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($backendProbe.stdout)) {
    throw "The packaged goose.exe did not return a version."
}

$evidence = [ordered]@{
    schemaVersion = 2
    checkedAtUtc = [DateTime]::UtcNow.ToString("o")
    result = "pass"
    installer = Get-ArtifactEvidence $InstallerPath
    application = Get-ArtifactEvidence $PackagedAppPath
    backend = Get-ArtifactEvidence $backendMatches[0].FullName
    expectedReleaseBackend = Get-ArtifactEvidence $ExpectedReleaseBackendPath
    backendDependencies = $backendReleaseEvidence
    appAsar = Get-ArtifactEvidence $asarPath
    backendVersionProbe = $backendProbe
}
$json = $evidence | ConvertTo-Json -Depth 8

if (-not [string]::IsNullOrWhiteSpace($EvidencePath)) {
    $resolvedEvidence = [IO.Path]::GetFullPath($EvidencePath)
    $evidenceParent = Split-Path -Parent $resolvedEvidence
    New-Item -ItemType Directory -Path $evidenceParent -Force | Out-Null
    [IO.File]::WriteAllText($resolvedEvidence, $json + "`n", [Text.UTF8Encoding]::new($false))
    Write-Output "EVIDENCE_PATH=$resolvedEvidence"
}

Write-Output "PACKAGE_CHECK=PASS"
Write-Output "INSTALLER_SHA256=$($evidence.installer.sha256)"
Write-Output "INSTALLER_SIGNATURE=$($evidence.installer.signatureStatus)"
Write-Output "APPLICATION_VERSION=$($evidence.application.productVersion)"
Write-Output "BACKEND_VERSION=$($backendProbe.stdout.Trim())"
