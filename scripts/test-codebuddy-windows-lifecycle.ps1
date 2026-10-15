[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CurrentInstallerPath,
    [string]$PreviousInstallerPath,
    [Parameter(Mandatory = $true)][string]$IsolatedRoot,
    [Parameter(Mandatory = $true)][string]$EvidencePath,
    [switch]$ConfirmIsolatedLifecycle,
    [switch]$ConfirmDisposableWindowsAccount,
    [string]$ExpectedDisposableWindowsAccountSid,
    [switch]$PreflightOnly,
    [string[]]$AdditionalProtectedPath = @(),
    [switch]$CleanupIsolatedRoot,
    [ValidateRange(30, 600)][int]$TimeoutSeconds = 180,
    [ValidateRange(4096, 1048576)][int]$MaxLogBytes = 65536
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "target\codebuddy-lifecycle"))
$allowedEvidenceRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "target\codebuddy-lifecycle-evidence"))
$probeScript = Join-Path $repoRoot "ui\desktop\scripts\installed-lifecycle-probe.cjs"
$distributionInstallId = "CodeBuddy"
$script:allowedDisposableWindowsAccountNames = @("CodexSandboxOffline", "CodexSandboxOnline")
$CurrentInstallerPath = [IO.Path]::GetFullPath($CurrentInstallerPath)
$IsolatedRoot = [IO.Path]::GetFullPath($IsolatedRoot).TrimEnd('\')
$EvidencePath = [IO.Path]::GetFullPath($EvidencePath)
if (-not [string]::IsNullOrWhiteSpace($PreviousInstallerPath)) {
    $PreviousInstallerPath = [IO.Path]::GetFullPath($PreviousInstallerPath)
}

function Test-DisposableWindowsIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$IdentityName,
        [Parameter(Mandatory = $true)][string]$IdentitySid,
        [string]$ExpectedSid
    )
    if ([string]::IsNullOrWhiteSpace($ExpectedSid)) {
        throw "An expected disposable Windows account SID is required."
    }
    if (-not [string]::Equals($IdentitySid, $ExpectedSid, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Disposable Windows account SID mismatch. Expected $ExpectedSid; current SID is $IdentitySid."
    }
    $accountName = @($IdentityName -split '\\')[-1]
    if ($script:allowedDisposableWindowsAccountNames -notcontains $accountName) {
        throw "Live testing requires a dedicated Windows account name: CodexSandboxOffline or CodexSandboxOnline."
    }
    return [ordered]@{ name = $IdentityName; sid = $IdentitySid }
}

function Assert-LeafFile {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Name)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Name was not found: $Path"
    }
}

function Assert-DirectChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Child,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if (-not [string]::Equals((Split-Path -Parent $Child), $Parent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name must be a direct child of $Parent"
    }
    if (-not (Test-Path -LiteralPath $Parent)) {
        New-Item -ItemType Directory -Path $Parent -Force | Out-Null
    }
    $parentItem = Get-Item -LiteralPath $Parent -Force
    if ($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "$Name parent cannot be a reparse point: $Parent"
    }
}

function Limit-Text {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrEmpty($Value)) { return "" }
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    if ($bytes.Length -le $MaxLogBytes) { return $Value }
    return [Text.Encoding]::UTF8.GetString($bytes, 0, $MaxLogBytes) + "`n[TRUNCATED]"
}

function Quote-ProcessArgument {
    param([AllowEmptyString()][string]$Argument)
    if ($Argument -notmatch '[\s"]') { return $Argument }
    return '"' + ($Argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
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
        if (-not $process.Start()) { throw "Failed to start: $FilePath" }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            $process.WaitForExit()
            throw "Process timed out after $TimeoutSeconds seconds: $FilePath"
        }
        return [ordered]@{
            exitCode = $process.ExitCode
            stdout = Limit-Text $stdout.GetAwaiter().GetResult()
            stderr = Limit-Text $stderr.GetAwaiter().GetResult()
        }
    }
    finally { $process.Dispose() }
}

function Wait-Until {
    param([Parameter(Mandatory = $true)][scriptblock]$Condition, [string]$Description)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "Timed out waiting for $Description."
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
        productVersion = $item.VersionInfo.ProductVersion
    }
}

function Get-InstalledExecutable {
    $candidates = foreach ($match in @(Get-ChildItem -LiteralPath $script:installRoot -Filter "CodeBuddy.exe" -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object FullName -Match '[\\/]app-[^\\/]+[\\/]CodeBuddy\.exe$')) {
        $versionText = (Split-Path -Leaf (Split-Path -Parent $match.FullName)).Substring(4)
        $version = $null
        if ([version]::TryParse($versionText, [ref]$version)) {
            [PSCustomObject]@{ path = $match.FullName; version = $version }
        }
    }
    $current = @($candidates | Sort-Object version -Descending | Select-Object -First 1)
    if ($current.Count -eq 0) { return $null }
    return $current[0].path
}

function Get-UninstallRegistrationKeys {
    $uninstallRoot = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
    if (-not (Test-Path -LiteralPath $uninstallRoot)) { return @() }
    return @(Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction SilentlyContinue | Where-Object {
        $properties = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
        $_.PSChildName -match 'CodeBuddy' -or $properties.DisplayName -eq 'CodeBuddy'
    } | Select-Object -ExpandProperty PSPath)
}

function Get-ProductShortcutPaths {
    $roots = @(
        [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::StartMenu)
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    return @($roots | ForEach-Object {
        Get-ChildItem -LiteralPath $_ -Filter "CodeBuddy*.lnk" -File -Recurse -ErrorAction SilentlyContinue
    } | Select-Object -ExpandProperty FullName)
}

function Invoke-LivePreflight {
    if (-not $ConfirmIsolatedLifecycle) { throw "Live lifecycle testing requires -ConfirmIsolatedLifecycle." }
    if (-not $ConfirmDisposableWindowsAccount) {
        throw "Live lifecycle testing requires -ConfirmDisposableWindowsAccount."
    }
    if ($env:CODEBUDDY_DISPOSABLE_TEST_ACCOUNT -ne "true") {
        throw "Set CODEBUDDY_DISPOSABLE_TEST_ACCOUNT=true only inside a disposable Windows test account."
    }
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $validatedIdentity = Test-DisposableWindowsIdentity -IdentityName $currentIdentity.Name `
        -IdentitySid $currentIdentity.User.Value -ExpectedSid $ExpectedDisposableWindowsAccountSid
    $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    $roamingAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if (@($localAppData, $roamingAppData, $userProfile) | Where-Object { [string]::IsNullOrWhiteSpace($_) }) {
        throw "Windows known profile folders are unavailable."
    }
    $protectedPaths = @(
        (Join-Path $localAppData $distributionInstallId),
        (Join-Path $roamingAppData $distributionInstallId),
        (Join-Path $userProfile ".CodeBuddy")
    ) + $AdditionalProtectedPath
    foreach ($overrideName in @("CODEBUDDY_HOME", "GOOSE_PATH_ROOT")) {
        $overridePath = [Environment]::GetEnvironmentVariable($overrideName, "Process")
        if (-not [string]::IsNullOrWhiteSpace($overridePath)) { $protectedPaths += $overridePath }
    }
    if (@($protectedPaths | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0 -or
        (Test-Path -LiteralPath "HKCU:\Software\Classes\codebuddy") -or
        @(Get-UninstallRegistrationKeys).Count -gt 0 -or @(Get-ProductShortcutPaths).Count -gt 0) {
        throw "Refusing live testing because an existing protected footprint was found in this Windows account."
    }
    if (@(Get-Process -Name "CodeBuddy" -ErrorAction SilentlyContinue).Count -gt 0) {
        throw "Close all CodeBuddy processes before running the isolated lifecycle test."
    }
    $installRoot = Join-Path $localAppData $distributionInstallId
    return [ordered]@{
        currentSid = $validatedIdentity.sid
        localAppData = $localAppData
        roamingAppData = $roamingAppData
        nonInstallProtectedPaths = @($protectedPaths | Where-Object {
            -not [string]::Equals($_, $installRoot, [StringComparison]::OrdinalIgnoreCase)
        } | Sort-Object -Unique)
    }
}

function Test-UninstallResidueAbsent {
    return -not (Test-Path -LiteralPath (Join-Path $script:installRoot "Update.exe")) -and
        -not (Test-Path -LiteralPath (Join-Path $script:installRoot "packages")) -and
        @(Get-ChildItem -LiteralPath $script:installRoot -Directory -Filter "app-*" -ErrorAction SilentlyContinue).Count -eq 0 -and
        @(Get-UninstallRegistrationKeys).Count -eq 0 -and @(Get-ProductShortcutPaths).Count -eq 0 -and
        -not (Test-Path -LiteralPath "HKCU:\Software\Classes\codebuddy")
}

function Assert-ProtectedHostPathsAbsent {
    foreach ($protectedPath in $preflight.nonInstallProtectedPaths) {
        if (Test-Path -LiteralPath $protectedPath) {
            throw "A protected host path was created during lifecycle testing: $protectedPath"
        }
    }
}

function Get-InstalledProcesses {
    if (-not (Test-Path -LiteralPath $script:installRoot)) { return @() }
    $prefix = [IO.Path]::GetFullPath($script:installRoot).TrimEnd('\') + '\'
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
        [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
}

function Stop-InstalledProcessTree {
    foreach ($entry in @(Get-InstalledProcesses)) {
        try {
            & taskkill.exe /PID $entry.ProcessId /T /F 2>&1 | Out-Null
        }
        catch {
            Stop-Process -Id $entry.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    Wait-Until -Description "the isolated CodeBuddy process tree to stop" -Condition {
        @(Get-InstalledProcesses).Count -eq 0
    }
}

function Invoke-Installer {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Phase)
    $result = Invoke-BoundedProcess -FilePath $Path -Arguments @("--silent")
    $script:evidence.phases += [ordered]@{ name = $Phase; result = if ($result.exitCode -eq 0) { "pass" } else { "fail" }; process = $result }
    if ($result.exitCode -ne 0) { throw "$Phase failed with exit code $($result.exitCode)." }
    Wait-Until -Description "$Phase installed executable" -Condition { $null -ne (Get-InstalledExecutable) }
}

function Invoke-Uninstall {
    param([Parameter(Mandatory = $true)][string]$Phase)
    Stop-InstalledProcessTree
    $update = Join-Path $script:installRoot "Update.exe"
    Assert-LeafFile -Path $update -Name "isolated Squirrel uninstaller"
    $result = Invoke-BoundedProcess -FilePath $update -Arguments @("--uninstall", "-s")
    $script:evidence.phases += [ordered]@{ name = $Phase; result = if ($result.exitCode -eq 0) { "pass" } else { "fail" }; process = $result }
    if ($result.exitCode -ne 0) { throw "$Phase failed with exit code $($result.exitCode)." }
    Wait-Until -Description "$Phase Update.exe, packages, app-*, registry, protocol, and shortcuts to disappear" -Condition {
        Test-UninstallResidueAbsent
    }
}

function Invoke-InstalledProbe {
    param([Parameter(Mandatory = $true)][string]$Phase)
    $port = Get-Random -Minimum 20000 -Maximum 40000
    $env:ENABLE_PLAYWRIGHT = "true"
    $env:PLAYWRIGHT_DEBUG_PORT = [string]$port
    $executable = Get-InstalledExecutable
    if (-not $executable) { throw "No isolated installed executable is available for $Phase." }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $executable
    $startInfo.Arguments = "--dir " + (Quote-ProcessArgument $script:fixtureRoot)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($startInfo)
    if (-not $process) { throw "Failed to launch installed CodeBuddy for $Phase." }
    $process.Dispose()

    $probe = Invoke-BoundedProcess -FilePath (Get-Command node).Source -Arguments @(
        $probeScript,
        "--port", [string]$port,
        "--fixture-root", $script:fixtureRoot,
        "--fixture-file", $script:fixtureFile,
        "--expected-content", $script:fixtureContent
    )
    $script:evidence.phases += [ordered]@{ name = $Phase; result = if ($probe.exitCode -eq 0) { "pass" } else { "fail" }; process = $probe }
    if ($probe.exitCode -ne 0 -or $probe.stdout -notmatch '"SAFE_LOCAL_TASK":"PASS"') {
        throw "$Phase installed probe failed: $($probe.stderr)"
    }
    return ($probe.stdout.Trim() | ConvertFrom-Json)
}

function Assert-Sentinel {
    if (-not (Test-Path -LiteralPath $script:sentinelPath -PathType Leaf)) {
        throw "The retained lifecycle sentinel is missing: $script:sentinelPath"
    }
    $hash = (Get-FileHash -LiteralPath $script:sentinelPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $script:sentinelHash) { throw "The retained lifecycle sentinel changed." }
}

function Write-EnvironmentUnavailableEvidence {
    param([Parameter(Mandatory = $true)][string]$Reason)
    $blocked = [ordered]@{
        schemaVersion = 1
        startedAtUtc = [DateTime]::UtcNow.ToString("o")
        finishedAtUtc = [DateTime]::UtcNow.ToString("o")
        result = "environment_unavailable"
        isolatedRoot = $IsolatedRoot
        currentInstaller = Get-ArtifactEvidence $CurrentInstallerPath
        previousInstaller = if ($PreviousInstallerPath) { Get-ArtifactEvidence $PreviousInstallerPath } else { $null }
        gates = [ordered]@{
            INSTALL = "ENVIRONMENT_UNAVAILABLE"
            FIRST_LAUNCH = "NOT_RUN"
            PROJECT_OPEN = "NOT_RUN"
            SAFE_LOCAL_TASK = "NOT_RUN"
            STOP = "NOT_RUN"
            CRASH_RESTART_RECOVERY = "NOT_RUN"
            UPGRADE = "NOT_RUN"
            REINSTALL_PREVIOUS = "NOT_RUN"
            ROLLBACK = "NOT_APPLICABLE_REINSTALL_PREVIOUS"
            UNINSTALL = "NOT_RUN"
            RETAINED_DATA = "NOT_RUN"
            PROTECTED_HOST_PATHS_ABSENT = "NOT_RUN"
        }
        reason = Limit-Text $Reason
    }
    [IO.File]::WriteAllText(
        $EvidencePath,
        (($blocked | ConvertTo-Json -Depth 10) + "`n"),
        [Text.UTF8Encoding]::new($false)
    )
}

$preflight = Invoke-LivePreflight
if ($PreflightOnly) {
    Write-Output "PREFLIGHT=PASS"
    Write-Output "CURRENT_SID=$($preflight.currentSid)"
    exit 0
}
Assert-LeafFile -Path $CurrentInstallerPath -Name "current installer"
Assert-LeafFile -Path $probeScript -Name "installed lifecycle probe"
if ($PreviousInstallerPath) { Assert-LeafFile -Path $PreviousInstallerPath -Name "previous installer" }
if ([IO.Path]::GetFileName($CurrentInstallerPath) -ne "CodeBuddy-Setup.exe") {
    throw "The current installer must be named CodeBuddy-Setup.exe."
}

Assert-DirectChildPath -Parent $allowedRoot -Child $IsolatedRoot -Name "IsolatedRoot"
Assert-DirectChildPath -Parent $allowedEvidenceRoot -Child $EvidencePath -Name "EvidencePath"
if (Test-Path -LiteralPath $EvidencePath) {
    throw "Refusing to overwrite existing lifecycle evidence: $EvidencePath"
}
if (Test-Path -LiteralPath $IsolatedRoot) {
    throw "Refusing to reuse an existing lifecycle root: $IsolatedRoot"
}

$originalGoosePathRoot = $env:GOOSE_PATH_ROOT
$originalCodeBuddyHome = $env:CODEBUDDY_HOME
$originalMigrateLegacy = $env:CODEBUDDY_MIGRATE_LEGACY
$originalCodeProRuntimeMode = $env:CODEPRO_RUNTIME_MODE
$originalDisableProtocolRegistration = $env:CODEBUDDY_DISABLE_PROTOCOL_REGISTRATION
$originalUserDataDir = $env:CODEBUDDY_USER_DATA_DIR
$originalEnablePlaywright = $env:ENABLE_PLAYWRIGHT
$originalDebugPort = $env:PLAYWRIGHT_DEBUG_PORT
$actualLocalAppData = $preflight.localAppData
$actualRoamingAppData = $preflight.roamingAppData
if ([string]::IsNullOrWhiteSpace($actualLocalAppData) -or [string]::IsNullOrWhiteSpace($actualRoamingAppData)) {
    $reason = "Windows known application-data folders are unavailable."
    Write-EnvironmentUnavailableEvidence -Reason $reason
    throw $reason
}
$script:installRoot = Join-Path $actualLocalAppData $distributionInstallId
$realUserDataRoot = Join-Path $actualRoamingAppData $distributionInstallId
$backendProfile = Join-Path $IsolatedRoot "ProductHome"
$isolatedUserData = Join-Path $IsolatedRoot "ElectronProfile"
$script:fixtureRoot = Join-Path $IsolatedRoot "fixture-project"
$script:fixtureFile = Join-Path $script:fixtureRoot "README.txt"
$script:fixtureContent = "CodeBuddy isolated lifecycle fixture`n"
$script:sentinelPath = Join-Path $isolatedUserData "lifecycle-sentinel.json"
New-Item -ItemType Directory -Path $isolatedUserData, $backendProfile, $script:fixtureRoot -Force | Out-Null
[IO.File]::WriteAllText($script:fixtureFile, $script:fixtureContent, [Text.UTF8Encoding]::new($false))

$script:evidence = [ordered]@{
    schemaVersion = 1
    startedAtUtc = [DateTime]::UtcNow.ToString("o")
    finishedAtUtc = $null
    result = "running"
    isolatedRoot = $IsolatedRoot
    accountIsolation = "disposable_windows_account"
    installRoot = $script:installRoot
    userDataRoot = $isolatedUserData
    currentInstaller = Get-ArtifactEvidence $CurrentInstallerPath
    previousInstaller = if ($PreviousInstallerPath) { Get-ArtifactEvidence $PreviousInstallerPath } else { $null }
    phases = @()
    gates = [ordered]@{
        INSTALL = "NOT_RUN"
        FIRST_LAUNCH = "NOT_RUN"
        PROJECT_OPEN = "NOT_RUN"
        SAFE_LOCAL_TASK = "NOT_RUN"
        STOP = "NOT_RUN"
        CRASH_RESTART_RECOVERY = "NOT_RUN"
        UPGRADE = if ($PreviousInstallerPath) { "NOT_RUN" } else { "ENVIRONMENT_UNAVAILABLE" }
        REINSTALL_PREVIOUS = if ($PreviousInstallerPath) { "NOT_RUN" } else { "ENVIRONMENT_UNAVAILABLE" }
        ROLLBACK = "NOT_APPLICABLE_REINSTALL_PREVIOUS"
        UNINSTALL = "NOT_RUN"
        RETAINED_DATA = "NOT_RUN"
        PROTECTED_HOST_PATHS_ABSENT = "NOT_RUN"
    }
    error = $null
}

$installed = $false
try {
    $env:GOOSE_PATH_ROOT = $backendProfile
    $env:CODEBUDDY_HOME = $backendProfile
    $env:CODEBUDDY_MIGRATE_LEGACY = "0"
    $env:CODEPRO_RUNTIME_MODE = "durable"
    $env:CODEBUDDY_DISABLE_PROTOCOL_REGISTRATION = "true"
    $env:CODEBUDDY_USER_DATA_DIR = $isolatedUserData

    $firstInstaller = if ($PreviousInstallerPath) { $PreviousInstallerPath } else { $CurrentInstallerPath }
    Invoke-Installer -Path $firstInstaller -Phase "install_initial"
    $installed = $true
    $script:evidence.gates.INSTALL = "PASS"
    $initialProbe = Invoke-InstalledProbe -Phase "first_launch_project_probe"
    $script:evidence.gates.FIRST_LAUNCH = "PASS"
    $script:evidence.gates.PROJECT_OPEN = "PASS"
    $script:evidence.gates.SAFE_LOCAL_TASK = "PASS"
    Stop-InstalledProcessTree
    $script:evidence.gates.STOP = "PASS"

    New-Item -ItemType Directory -Path (Split-Path -Parent $script:sentinelPath) -Force | Out-Null
    $sentinel = [ordered]@{ schemaVersion = 1; value = [Guid]::NewGuid().ToString("N") }
    [IO.File]::WriteAllText(
        $script:sentinelPath,
        (($sentinel | ConvertTo-Json -Compress) + "`n"),
        [Text.UTF8Encoding]::new($false)
    )
    $script:sentinelHash = (Get-FileHash -LiteralPath $script:sentinelPath -Algorithm SHA256).Hash.ToLowerInvariant()

    if ($PreviousInstallerPath) {
        $previousVersion = [string]$initialProbe.appVersion
        Invoke-Installer -Path $CurrentInstallerPath -Phase "upgrade_current"
        $currentProbe = Invoke-InstalledProbe -Phase "upgrade_project_probe"
        Assert-Sentinel
        if ([string]$currentProbe.appVersion -eq $previousVersion) {
            throw "UPGRADE blocked because previous and current installers expose the same app version."
        }
        $script:evidence.gates.UPGRADE = "PASS"
        Stop-InstalledProcessTree
    }

    $null = Invoke-InstalledProbe -Phase "pre_crash_probe"
    Stop-InstalledProcessTree
    $null = Invoke-InstalledProbe -Phase "post_crash_restart_probe"
    Assert-Sentinel
    $script:evidence.gates.CRASH_RESTART_RECOVERY = "PASS"
    Stop-InstalledProcessTree

    if ($PreviousInstallerPath) {
        Invoke-Uninstall -Phase "remove_current_for_reinstall_previous"
        $installed = $false
        Invoke-Installer -Path $PreviousInstallerPath -Phase "reinstall_previous"
        $installed = $true
        $reinstallPreviousProbe = Invoke-InstalledProbe -Phase "reinstall_previous_project_probe"
        Assert-Sentinel
        if ([string]$reinstallPreviousProbe.appVersion -ne $previousVersion) {
            throw "REINSTALL_PREVIOUS did not install the previous application version."
        }
        $script:evidence.gates.REINSTALL_PREVIOUS = "PASS"
        Stop-InstalledProcessTree
    }

    Invoke-Uninstall -Phase "final_uninstall"
    $installed = $false
    Assert-ProtectedHostPathsAbsent
    $script:evidence.gates.UNINSTALL = "PASS"
    $script:evidence.gates.PROTECTED_HOST_PATHS_ABSENT = "PASS"
    Assert-Sentinel
    $script:evidence.gates.RETAINED_DATA = "PASS"
    $script:evidence.result = "pass"
}
catch {
    $script:evidence.result = "fail"
    $script:evidence.error = Limit-Text $_.Exception.Message
    throw
}
finally {
    try {
        try { Stop-InstalledProcessTree } catch { }
        if (Test-Path -LiteralPath (Join-Path $script:installRoot "Update.exe") -PathType Leaf) {
            try { [void](Invoke-BoundedProcess -FilePath (Join-Path $script:installRoot "Update.exe") -Arguments @("--uninstall", "-s")) } catch { }
        }
        $script:evidence.finishedAtUtc = [DateTime]::UtcNow.ToString("o")
        $json = $script:evidence | ConvertTo-Json -Depth 12
        [IO.File]::WriteAllText($EvidencePath, $json + "`n", [Text.UTF8Encoding]::new($false))
    }
    finally {
        $env:GOOSE_PATH_ROOT = $originalGoosePathRoot
        $env:CODEBUDDY_HOME = $originalCodeBuddyHome
        $env:CODEBUDDY_MIGRATE_LEGACY = $originalMigrateLegacy
        $env:CODEPRO_RUNTIME_MODE = $originalCodeProRuntimeMode
        $env:CODEBUDDY_DISABLE_PROTOCOL_REGISTRATION = $originalDisableProtocolRegistration
        $env:CODEBUDDY_USER_DATA_DIR = $originalUserDataDir
        $env:ENABLE_PLAYWRIGHT = $originalEnablePlaywright
        $env:PLAYWRIGHT_DEBUG_PORT = $originalDebugPort
    }
}

Write-Output "INSTALL=PASS"
Write-Output "FIRST_LAUNCH=PASS"
Write-Output "PROJECT_OPEN=PASS"
Write-Output "SAFE_LOCAL_TASK=PASS"
Write-Output "STOP=PASS"
Write-Output "CRASH_RESTART_RECOVERY=PASS"
Write-Output "UPGRADE=$($script:evidence.gates.UPGRADE)"
Write-Output "REINSTALL_PREVIOUS=$($script:evidence.gates.REINSTALL_PREVIOUS)"
Write-Output "ROLLBACK=NOT_APPLICABLE (see REINSTALL_PREVIOUS)"
Write-Output "UNINSTALL=PASS"
Write-Output "PROTECTED_HOST_PATHS_ABSENT=PASS"
Write-Output "RETAINED_DATA=PASS"
Write-Output "EVIDENCE_PATH=$EvidencePath"

if ($CleanupIsolatedRoot) {
    if (-not [string]::Equals(
            (Split-Path -Parent $IsolatedRoot),
            $allowedRoot,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw "Refusing cleanup outside the verified lifecycle root."
    }
    Remove-Item -LiteralPath $IsolatedRoot -Recurse -Force
    Write-Output "ISOLATED_DATA_CLEANUP=PASS"
}
else {
    Write-Output "ISOLATED_DATA_CLEANUP=NOT_RUN (retained at $IsolatedRoot)"
}
