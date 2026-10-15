[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackagedAppPath,
    [Parameter(Mandatory = $true)][string]$IsolatedRoot,
    [Parameter(Mandatory = $true)][string]$EvidencePath,
    [switch]$ConfirmIsolatedRuntime,
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
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "target\codebuddy-packaged-runtime"))
$allowedEvidenceRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "target\codebuddy-lifecycle-evidence"))
$probeScript = Join-Path $repoRoot "ui\desktop\scripts\installed-lifecycle-probe.cjs"
$distributionInstallId = "CodeBuddy"
$script:allowedDisposableWindowsAccountNames = @("CodexSandboxOffline", "CodexSandboxOnline")
$PackagedAppPath = [IO.Path]::GetFullPath($PackagedAppPath)
$IsolatedRoot = [IO.Path]::GetFullPath($IsolatedRoot).TrimEnd('\')
$EvidencePath = [IO.Path]::GetFullPath($EvidencePath)
$packageRoot = Split-Path -Parent $PackagedAppPath

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

function Limit-Text {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrEmpty($Value)) { return "" }
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    if ($bytes.Length -le $MaxLogBytes) { return $Value }
    return [Text.Encoding]::UTF8.GetString($bytes, 0, $MaxLogBytes) + "`n[TRUNCATED]"
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

function Quote-ProcessArgument {
    param([AllowEmptyString()][string]$Argument)
    if ($Argument -notmatch '[\s"]') { return $Argument }
    return '"' + ($Argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-BoundedProcess {
    param([Parameter(Mandatory = $true)][string]$FilePath, [string[]]$Arguments = @())
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

function Get-PackageProcesses {
    $prefix = [IO.Path]::GetFullPath($packageRoot).TrimEnd('\') + '\'
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
        [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
}

function Stop-PackageProcessTree {
    foreach ($entry in @(Get-PackageProcesses)) {
        try { & taskkill.exe /PID $entry.ProcessId /T /F 2>&1 | Out-Null }
        catch { Stop-Process -Id $entry.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (@(Get-PackageProcesses).Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "Timed out stopping the packaged CodeBuddy process tree."
}

function Get-ProtocolCommand {
    $protocolKey = "HKCU:\Software\Classes\codebuddy\shell\open\command"
    if (-not (Test-Path -LiteralPath $protocolKey)) { return $null }
    return (Get-ItemProperty -LiteralPath $protocolKey)."(default)"
}

function Get-TextSha256 {
    param([Parameter(Mandatory = $true)][string]$Value)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-', '').ToLowerInvariant()
    }
    finally { $hasher.Dispose() }
}

function Get-RegistryTreeFingerprint {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return "absent" }
    $records = foreach ($key in @((Get-Item -LiteralPath $Path)) + @(Get-ChildItem -LiteralPath $Path -Recurse -ErrorAction SilentlyContinue)) {
        $properties = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
        foreach ($property in @($properties.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | Sort-Object Name)) {
            "$($key.Name)|$($property.Name)|$([string]$property.Value)"
        }
    }
    return Get-TextSha256 (($records | Sort-Object) -join "`n")
}

function Get-UninstallRegistrationKeys {
    $uninstallRoot = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
    if (-not (Test-Path -LiteralPath $uninstallRoot)) { return @() }
    return @(Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction SilentlyContinue | Where-Object {
        $properties = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
        $_.PSChildName -match 'CodeBuddy' -or $properties.DisplayName -eq 'CodeBuddy'
    } | Select-Object -ExpandProperty PSPath)
}

function Get-UninstallFingerprint {
    $records = @(Get-UninstallRegistrationKeys | ForEach-Object { "$_|$(Get-RegistryTreeFingerprint $_)" })
    if ($records.Count -eq 0) { return "absent" }
    return Get-TextSha256 (($records | Sort-Object) -join "`n")
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

function Get-ShortcutFingerprint {
    $records = @(Get-ProductShortcutPaths | Sort-Object | ForEach-Object {
        $item = Get-Item -LiteralPath $_
        "$($item.FullName)|$($item.Length)|$((Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash)"
    })
    if ($records.Count -eq 0) { return "absent" }
    return Get-TextSha256 ($records -join "`n")
}

function Invoke-LivePreflight {
    if (-not $ConfirmIsolatedRuntime) { throw "Packaged runtime testing requires -ConfirmIsolatedRuntime." }
    if (-not $ConfirmDisposableWindowsAccount) {
        throw "Packaged runtime testing requires -ConfirmDisposableWindowsAccount."
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
    $pathFingerprints = [ordered]@{}
    foreach ($protectedPath in @($protectedPaths | Sort-Object -Unique)) {
        $pathFingerprints[$protectedPath] = Get-DirectoryFingerprint -Path $protectedPath
    }
    $protocolFingerprint = Get-RegistryTreeFingerprint "HKCU:\Software\Classes\codebuddy"
    $uninstallFingerprint = Get-UninstallFingerprint
    $shortcutFingerprint = Get-ShortcutFingerprint
    if (@($pathFingerprints.Values | Where-Object exists).Count -gt 0 -or $protocolFingerprint -ne "absent" -or
        $uninstallFingerprint -ne "absent" -or $shortcutFingerprint -ne "absent") {
        throw "Refusing live testing because an existing protected footprint was found in this Windows account."
    }
    return [ordered]@{
        currentSid = $validatedIdentity.sid
        pathFingerprints = $pathFingerprints
        protocolFingerprint = $protocolFingerprint
        uninstallFingerprint = $uninstallFingerprint
        shortcutFingerprint = $shortcutFingerprint
    }
}

function Assert-ProtectedHostStateUnchanged {
    foreach ($entry in $preflight.pathFingerprints.GetEnumerator()) {
        $after = Get-DirectoryFingerprint -Path $entry.Key
        if (-not (Test-SameDirectoryFingerprint -Before $entry.Value -After $after)) {
            throw "Protected host path changed during packaged runtime testing: $($entry.Key)"
        }
    }
    if ((Get-RegistryTreeFingerprint "HKCU:\Software\Classes\codebuddy") -ne $preflight.protocolFingerprint -or
        (Get-UninstallFingerprint) -ne $preflight.uninstallFingerprint -or
        (Get-ShortcutFingerprint) -ne $preflight.shortcutFingerprint) {
        throw "Protected registry or shortcut state changed during packaged runtime testing."
    }
}

function Get-DirectoryFingerprint {
    param([Parameter(Mandatory = $true)][string]$Path)
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $fullPath)) {
        return [ordered]@{
            exists = $false
            directories = 0
            files = 0
            bytes = 0
            sha256 = $null
        }
    }

    $prefix = $fullPath + '\'
    $records = [Collections.Generic.List[string]]::new()
    $directoryCount = 0
    $fileCount = 0
    [long]$totalBytes = 0
    $contentHashedFiles = @('recent-dirs.json', 'settings.json', 'window-state.json')
    foreach ($entry in @(Get-ChildItem -LiteralPath $fullPath -Force -Recurse | Sort-Object FullName)) {
        $relativePath = $entry.FullName.Substring($prefix.Length).Replace('/', '\')
        if ($entry.PSIsContainer) {
            $directoryCount += 1
            $records.Add("D`t$relativePath`t$($entry.LastWriteTimeUtc.Ticks)`t$([int]$entry.Attributes)")
            continue
        }
        $fileCount += 1
        $totalBytes += $entry.Length
        $contentHash = '-'
        if ($contentHashedFiles -contains $relativePath) {
            $contentHash = (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        $records.Add(
            "F`t$relativePath`t$($entry.Length)`t$($entry.LastWriteTimeUtc.Ticks)`t$([int]$entry.Attributes)`t$contentHash"
        )
    }

    $canonical = [Text.Encoding]::UTF8.GetBytes(($records -join "`n"))
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $treeHash = [BitConverter]::ToString($hasher.ComputeHash($canonical)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $hasher.Dispose()
    }
    return [ordered]@{
        exists = $true
        directories = $directoryCount
        files = $fileCount
        bytes = $totalBytes
        sha256 = $treeHash
    }
}

function Test-SameDirectoryFingerprint {
    param(
        [Parameter(Mandatory = $true)]$Before,
        [Parameter(Mandatory = $true)]$After
    )
    return $Before.exists -eq $After.exists -and
        $Before.directories -eq $After.directories -and
        $Before.files -eq $After.files -and
        $Before.bytes -eq $After.bytes -and
        $Before.sha256 -eq $After.sha256
}

function Invoke-PackagedProbe {
    param([Parameter(Mandatory = $true)][string]$Phase)
    $port = Get-Random -Minimum 20000 -Maximum 40000
    $env:PLAYWRIGHT_DEBUG_PORT = [string]$port
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $PackagedAppPath
    $startInfo.Arguments = "--dir " + (Quote-ProcessArgument $script:fixtureRoot)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($startInfo)
    if (-not $process) { throw "Failed to launch packaged CodeBuddy for $Phase." }
    $rootPid = $process.Id
    $process.Dispose()
    $probe = Invoke-BoundedProcess -FilePath (Get-Command node).Source -Arguments @(
        $probeScript,
        "--port", [string]$port,
        "--fixture-root", $script:fixtureRoot,
        "--fixture-file", $script:fixtureFile,
        "--expected-content", $script:fixtureContent
    )
    if ($probe.exitCode -ne 0 -or $probe.stdout -notmatch '"SAFE_LOCAL_TASK":"PASS"') {
        throw "$Phase failed: $($probe.stderr)"
    }
    Stop-PackageProcessTree
    return [ordered]@{
        name = $Phase
        result = "pass"
        rootPid = $rootPid
        probe = ($probe.stdout.Trim() | ConvertFrom-Json)
    }
}

$preflight = Invoke-LivePreflight
if ($PreflightOnly) {
    Write-Output "PREFLIGHT=PASS"
    Write-Output "CURRENT_SID=$($preflight.currentSid)"
    exit 0
}
if (-not (Test-Path -LiteralPath $PackagedAppPath -PathType Leaf)) {
    throw "Packaged CodeBuddy executable was not found: $PackagedAppPath"
}
if (-not (Test-Path -LiteralPath $probeScript -PathType Leaf)) {
    throw "Installed lifecycle probe was not found: $probeScript"
}
Assert-DirectChildPath -Parent $allowedRoot -Child $IsolatedRoot -Name "IsolatedRoot"
Assert-DirectChildPath -Parent $allowedEvidenceRoot -Child $EvidencePath -Name "EvidencePath"
if (Test-Path -LiteralPath $EvidencePath) {
    throw "Refusing to overwrite existing packaged runtime evidence: $EvidencePath"
}
if (Test-Path -LiteralPath $IsolatedRoot) { throw "Refusing to reuse an existing runtime root." }
if (@(Get-PackageProcesses).Count -gt 0) {
    throw "Refusing packaged runtime testing while packaged processes are already running."
}

$oldEnvironment = [ordered]@{
    APPDATA = $env:APPDATA
    LOCALAPPDATA = $env:LOCALAPPDATA
    GOOSE_PATH_ROOT = $env:GOOSE_PATH_ROOT
    CODEBUDDY_HOME = $env:CODEBUDDY_HOME
    CODEBUDDY_MIGRATE_LEGACY = $env:CODEBUDDY_MIGRATE_LEGACY
    ENABLE_PLAYWRIGHT = $env:ENABLE_PLAYWRIGHT
    PLAYWRIGHT_DEBUG_PORT = $env:PLAYWRIGHT_DEBUG_PORT
    CODEBUDDY_DISABLE_PROTOCOL_REGISTRATION = $env:CODEBUDDY_DISABLE_PROTOCOL_REGISTRATION
    CODEBUDDY_USER_DATA_DIR = $env:CODEBUDDY_USER_DATA_DIR
    CODEPRO_RUNTIME_MODE = $env:CODEPRO_RUNTIME_MODE
}
if ([string]::IsNullOrWhiteSpace($oldEnvironment.APPDATA)) {
    throw "APPDATA is unavailable; the real user profile cannot be protected by fingerprinting."
}
$realUserDataRoot = Join-Path $oldEnvironment.APPDATA $distributionInstallId
$realUserDataBefore = Get-DirectoryFingerprint -Path $realUserDataRoot
$appData = Join-Path $IsolatedRoot "AppData\Roaming"
$localAppData = Join-Path $IsolatedRoot "AppData\Local"
$backendProfile = Join-Path $IsolatedRoot "BackendProfile"
$script:fixtureRoot = Join-Path $IsolatedRoot "fixture-project"
$script:fixtureFile = Join-Path $script:fixtureRoot "README.txt"
$script:fixtureContent = "CodeBuddy packaged lifecycle fixture`n"
New-Item -ItemType Directory -Path $appData, $localAppData, $backendProfile, $script:fixtureRoot -Force | Out-Null
[IO.File]::WriteAllText($script:fixtureFile, $script:fixtureContent, [Text.UTF8Encoding]::new($false))

$protocolBefore = Get-ProtocolCommand
$evidence = [ordered]@{
    schemaVersion = 1
    startedAtUtc = [DateTime]::UtcNow.ToString("o")
    finishedAtUtc = $null
    result = "running"
    artifact = [ordered]@{
        path = $PackagedAppPath
        bytes = (Get-Item -LiteralPath $PackagedAppPath).Length
        sha256 = (Get-FileHash -LiteralPath $PackagedAppPath -Algorithm SHA256).Hash.ToLowerInvariant()
        signatureStatus = (Get-AuthenticodeSignature -LiteralPath $PackagedAppPath).Status.ToString()
    }
    isolatedRoot = $IsolatedRoot
    realUserData = [ordered]@{
        before = $realUserDataBefore
        after = $null
    }
    gates = [ordered]@{
        FIRST_LAUNCH = "NOT_RUN"
        PROJECT_OPEN = "NOT_RUN"
        SAFE_LOCAL_TASK = "NOT_RUN"
        CRASH_RESTART_RECOVERY = "NOT_RUN"
        PROTOCOL_HANDLER_UNCHANGED = "NOT_RUN"
        REAL_USER_DATA_UNCHANGED = "NOT_RUN"
        PROTECTED_HOST_STATE_UNCHANGED = "NOT_RUN"
    }
    phases = @()
    error = $null
}

try {
    $env:APPDATA = $appData
    $env:LOCALAPPDATA = $localAppData
    $env:GOOSE_PATH_ROOT = $backendProfile
    $env:CODEBUDDY_HOME = $backendProfile
    $env:CODEBUDDY_MIGRATE_LEGACY = "0"
    $env:ENABLE_PLAYWRIGHT = "true"
    $env:CODEBUDDY_DISABLE_PROTOCOL_REGISTRATION = "true"
    $env:CODEBUDDY_USER_DATA_DIR = Join-Path $appData $distributionInstallId
    $env:CODEPRO_RUNTIME_MODE = "durable"

    $evidence.phases += Invoke-PackagedProbe -Phase "first_launch_project_safe_task"
    $evidence.gates.FIRST_LAUNCH = "PASS"
    $evidence.gates.PROJECT_OPEN = "PASS"
    $evidence.gates.SAFE_LOCAL_TASK = "PASS"
    $evidence.phases += Invoke-PackagedProbe -Phase "forced_crash_restart_recovery"
    $evidence.gates.CRASH_RESTART_RECOVERY = "PASS"
    if ((Get-ProtocolCommand) -ne $protocolBefore) {
        throw "The codebuddy protocol handler changed during the isolated packaged runtime test."
    }
    $evidence.gates.PROTOCOL_HANDLER_UNCHANGED = "PASS"
    $realUserDataAfter = Get-DirectoryFingerprint -Path $realUserDataRoot
    $evidence.realUserData.after = $realUserDataAfter
    if (-not (Test-SameDirectoryFingerprint -Before $realUserDataBefore -After $realUserDataAfter)) {
        $evidence.gates.REAL_USER_DATA_UNCHANGED = "FAIL"
        throw "The real CodeBuddy user-data directory changed during the isolated packaged runtime test."
    }
    $evidence.gates.REAL_USER_DATA_UNCHANGED = "PASS"
    Assert-ProtectedHostStateUnchanged
    $evidence.gates.PROTECTED_HOST_STATE_UNCHANGED = "PASS"
    $evidence.result = "pass"
}
catch {
    $evidence.result = "fail"
    $evidence.error = Limit-Text $_.Exception.Message
    throw
}
finally {
    try {
        try { Stop-PackageProcessTree } catch { }
        if ($null -eq $evidence.realUserData.after) {
            try {
                $evidence.realUserData.after = Get-DirectoryFingerprint -Path $realUserDataRoot
                $evidence.gates.REAL_USER_DATA_UNCHANGED = if (
                    Test-SameDirectoryFingerprint -Before $realUserDataBefore -After $evidence.realUserData.after
                ) { "PASS" } else { "FAIL" }
            }
            catch {
                $evidence.gates.REAL_USER_DATA_UNCHANGED = "FAIL"
            }
        }
        $evidence.finishedAtUtc = [DateTime]::UtcNow.ToString("o")
        [IO.File]::WriteAllText(
            $EvidencePath,
            (($evidence | ConvertTo-Json -Depth 12) + "`n"),
            [Text.UTF8Encoding]::new($false)
        )
    }
    finally {
        foreach ($entry in $oldEnvironment.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
        }
    }
}

Write-Output "PACKAGED_RUNTIME=PASS"
Write-Output "FIRST_LAUNCH=PASS"
Write-Output "PROJECT_OPEN=PASS"
Write-Output "SAFE_LOCAL_TASK=PASS"
Write-Output "CRASH_RESTART_RECOVERY=PASS"
Write-Output "PROTOCOL_HANDLER_UNCHANGED=PASS"
Write-Output "REAL_USER_DATA_UNCHANGED=PASS"
Write-Output "PROTECTED_HOST_STATE_UNCHANGED=PASS"
Write-Output "EVIDENCE_PATH=$EvidencePath"

if ($CleanupIsolatedRoot) {
    if (-not [string]::Equals(
            (Split-Path -Parent $IsolatedRoot),
            $allowedRoot,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw "Refusing cleanup outside the verified packaged runtime root."
    }
    Remove-Item -LiteralPath $IsolatedRoot -Recurse -Force
    Write-Output "ISOLATED_DATA_CLEANUP=PASS"
}
else {
    Write-Output "ISOLATED_DATA_CLEANUP=NOT_RUN (retained at $IsolatedRoot)"
}
