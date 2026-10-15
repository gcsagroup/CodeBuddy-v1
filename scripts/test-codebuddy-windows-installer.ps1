[CmdletBinding()]
param(
    [string]$InstallerPath,
    [string]$PackagedAppPath,
    [switch]$InstallUninstall,
    [switch]$ConfirmDisposableWindowsAccount,
    [string]$ExpectedDisposableWindowsAccountSid,
    [switch]$PreflightOnly,
    [string[]]$AdditionalProtectedPath = @(),
    [ValidateRange(10, 600)]
    [int]$TimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$desktopRoot = Join-Path $repoRoot "ui\desktop"
$outRoot = Join-Path $desktopRoot "out"
$distributionInstallId = "CodeBuddy"
$script:allowedDisposableWindowsAccountNames = @("CodexSandboxOffline", "CodexSandboxOnline")

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
            throw "Failed to start: $FilePath"
        }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            $process.WaitForExit()
            throw "Process timed out after $TimeoutSeconds seconds: $FilePath"
        }
        return [PSCustomObject]@{
            ExitCode = $process.ExitCode
            Stdout = $stdout.GetAwaiter().GetResult()
            Stderr = $stderr.GetAwaiter().GetResult()
        }
    }
    finally {
        $process.Dispose()
    }
}

function Wait-Until {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Condition,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (& $Condition) {
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Timed out waiting for $Description."
}

function Get-InstalledAppProcesses {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)

    $prefix = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') + '\'
    return @(Get-CimInstance Win32_Process -Filter "Name = 'CodeBuddy.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
            [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(
                $prefix,
                [StringComparison]::OrdinalIgnoreCase
            )
        })
}

function Stop-InstalledAppProcesses {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)

    foreach ($process in @(Get-InstalledAppProcesses -InstallRoot $InstallRoot)) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Get-GooseInstallFingerprint {
    param([Parameter(Mandatory = $true)][string]$LocalAppData)

    $candidates = @(
        (Join-Path $LocalAppData "goose"),
        (Join-Path $LocalAppData "Goose"),
        (Join-Path $LocalAppData "Programs\goose"),
        (Join-Path $LocalAppData "Programs\Goose")
    ) | Sort-Object -Unique

    $entries = foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            Get-ChildItem -LiteralPath $candidate -File -Recurse -ErrorAction SilentlyContinue |
                Sort-Object FullName |
                ForEach-Object {
                    "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)"
                }
        }
    }
    return ($entries -join "`n")
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

function Assert-NoInstallerEnvironmentOverrides {
    param([Parameter(Mandatory = $true)][Collections.IDictionary]$EnvironmentValues)
    foreach ($name in @(
            "CODEBUDDY_HOME",
            "GOOSE_PATH_ROOT",
            "CODEBUDDY_MIGRATE_LEGACY",
            "CODEBUDDY_USER_DATA_DIR"
        )) {
        if ($EnvironmentValues.Contains($name) -and
            -not [string]::IsNullOrWhiteSpace([string]$EnvironmentValues[$name])) {
            throw "$name must be unset for installer smoke testing."
        }
    }
}

function Assert-NoProtectedFootprint {
    param(
        [string[]]$ExistingPaths = @(),
        [bool]$ProtocolExists,
        [string[]]$UninstallKeys = @(),
        [string[]]$Shortcuts = @()
    )
    if ($ExistingPaths.Count -gt 0 -or $ProtocolExists -or
        $UninstallKeys.Count -gt 0 -or $Shortcuts.Count -gt 0) {
        throw "Refusing live testing because an existing protected footprint was found in this Windows account."
    }
}

function Invoke-LivePreflight {
    if (-not $ConfirmDisposableWindowsAccount) {
        throw "Live installer smoke testing requires -ConfirmDisposableWindowsAccount."
    }
    if ($env:CODEBUDDY_DISPOSABLE_TEST_ACCOUNT -ne "true") {
        throw "Set CODEBUDDY_DISPOSABLE_TEST_ACCOUNT=true only inside a disposable Windows test account."
    }
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $validatedIdentity = Test-DisposableWindowsIdentity -IdentityName $currentIdentity.Name `
        -IdentitySid $currentIdentity.User.Value -ExpectedSid $ExpectedDisposableWindowsAccountSid
    $environmentValues = [ordered]@{}
    foreach ($name in @("CODEBUDDY_HOME", "GOOSE_PATH_ROOT", "CODEBUDDY_MIGRATE_LEGACY", "CODEBUDDY_USER_DATA_DIR")) {
        $environmentValues[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    }
    Assert-NoInstallerEnvironmentOverrides -EnvironmentValues $environmentValues

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
    $existingPaths = @($protectedPaths | Where-Object { Test-Path -LiteralPath $_ })
    $protocolRoot = "HKCU:\Software\Classes\codebuddy"
    $uninstallKeys = @(Get-UninstallRegistrationKeys)
    $shortcuts = @(Get-ProductShortcutPaths)
    Assert-NoProtectedFootprint -ExistingPaths $existingPaths `
        -ProtocolExists (Test-Path -LiteralPath $protocolRoot) `
        -UninstallKeys $uninstallKeys -Shortcuts $shortcuts
    if (@(Get-Process -Name "CodeBuddy" -ErrorAction SilentlyContinue).Count -gt 0) {
        throw "Close all CodeBuddy processes before running the live installer smoke test."
    }
    return [ordered]@{
        currentSid = $validatedIdentity.sid
        localAppData = $localAppData
        roamingAppData = $roamingAppData
        userProfile = $userProfile
    }
}

function Test-UninstallResidueAbsent {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)
    return -not (Test-Path -LiteralPath (Join-Path $InstallRoot "Update.exe")) -and
        -not (Test-Path -LiteralPath (Join-Path $InstallRoot "packages")) -and
        @(Get-ChildItem -LiteralPath $InstallRoot -Directory -Filter "app-*" -ErrorAction SilentlyContinue).Count -eq 0 -and
        @(Get-UninstallRegistrationKeys).Count -eq 0 -and
        @(Get-ProductShortcutPaths).Count -eq 0 -and
        -not (Test-Path -LiteralPath "HKCU:\Software\Classes\codebuddy")
}

function Get-InstalledExecutable {
    $candidates = foreach ($match in @(Get-ChildItem -LiteralPath $script:installRoot -Filter "CodeBuddy.exe" -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object FullName -Match '[\\/]app-([^\\/]+)[\\/]CodeBuddy\.exe$')) {
        $versionText = [regex]::Match($match.FullName, '[\\/]app-([^\\/]+)[\\/]').Groups[1].Value
        $version = $null
        if ([version]::TryParse($versionText, [ref]$version)) {
            [PSCustomObject]@{ path = $match.FullName; version = $version }
        }
    }
    return @($candidates | Sort-Object version -Descending | Select-Object -First 1).path
}

if ($InstallUninstall -or $PreflightOnly) {
    $preflight = Invoke-LivePreflight
    if ($PreflightOnly) {
        Write-Output "PREFLIGHT=PASS"
        Write-Output "CURRENT_SID=$($preflight.currentSid)"
        exit 0
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
if (-not (Test-Path -LiteralPath (Join-Path $resourcesRoot "app.asar") -PathType Leaf)) {
    throw "The packaged Electron app is missing resources\app.asar."
}

$backendVersion = Invoke-BoundedProcess -FilePath $backendMatches[0].FullName -Arguments @("--version")
if ($backendVersion.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($backendVersion.Stdout)) {
    throw "The packaged goose.exe did not return a version."
}

$installerHash = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
$installerSignature = Get-AuthenticodeSignature -LiteralPath $InstallerPath
Write-Output "PACKAGE_CHECK=PASS"
Write-Output "Installer: $InstallerPath"
Write-Output "Installer SHA256: $installerHash"
Write-Output "Signature: $($installerSignature.Status)"
Write-Output "Application: $PackagedAppPath"
Write-Output "Backend: $($backendVersion.Stdout.Trim())"

if (-not $InstallUninstall) {
    Write-Output "INSTALL_UNINSTALL=NOT_RUN (pass -InstallUninstall to perform the live smoke test)"
    exit 0
}

$localAppData = $preflight.localAppData
$appData = $preflight.roamingAppData
$installRoot = Join-Path $localAppData $distributionInstallId
$script:installRoot = $installRoot
$userDataRoot = Join-Path $appData $distributionInstallId
$installed = $false
$uninstallAttempted = $false
$gooseBefore = Get-GooseInstallFingerprint -LocalAppData $localAppData

try {
    $installResult = Invoke-BoundedProcess -FilePath $InstallerPath -Arguments @("--silent")
    if ($installResult.ExitCode -ne 0) {
        throw "Installer failed with exit code $($installResult.ExitCode): $($installResult.Stderr)"
    }
    $installed = $true

    $updateExe = Join-Path $installRoot "Update.exe"
    Wait-Until -Description "the Squirrel Update.exe" -Condition {
        Test-Path -LiteralPath $updateExe -PathType Leaf
    }
    Wait-Until -Description "the installed CodeBuddy executable" -Condition {
        @(Get-ChildItem -LiteralPath $installRoot -Filter "CodeBuddy.exe" -File -Recurse -ErrorAction SilentlyContinue).Count -gt 0
    }
    $installedExe = Get-InstalledExecutable

    Start-Process -FilePath $installedExe | Out-Null
    Wait-Until -Description "an installed CodeBuddy process" -Condition {
        @(Get-InstalledAppProcesses -InstallRoot $installRoot).Count -gt 0
    }
    Stop-InstalledAppProcesses -InstallRoot $installRoot
    Wait-Until -Description "CodeBuddy to exit" -Condition {
        @(Get-InstalledAppProcesses -InstallRoot $installRoot).Count -eq 0
    }

    $uninstallAttempted = $true
    $uninstallResult = Invoke-BoundedProcess -FilePath $updateExe -Arguments @("--uninstall", "-s")
    if ($uninstallResult.ExitCode -ne 0) {
        throw "Uninstaller failed with exit code $($uninstallResult.ExitCode): $($uninstallResult.Stderr)"
    }
    Wait-Until -Description "Squirrel install, registry, protocol, and shortcut residue to be removed" -Condition {
        Test-UninstallResidueAbsent -InstallRoot $installRoot
    }

    $gooseAfter = Get-GooseInstallFingerprint -LocalAppData $localAppData
    if ($gooseAfter -ne $gooseBefore) {
        throw "The upstream Goose installation changed during the CodeBuddy smoke test."
    }

    Write-Output "INSTALL_UNINSTALL=PASS"
}
finally {
    Stop-InstalledAppProcesses -InstallRoot $installRoot

    $updateExe = Join-Path $installRoot "Update.exe"
    if ($installed -and -not $uninstallAttempted -and (Test-Path -LiteralPath $updateExe -PathType Leaf)) {
        try {
            [void](Invoke-BoundedProcess -FilePath $updateExe -Arguments @("--uninstall", "-s"))
        }
        catch {
            Write-Warning "Automatic uninstall during cleanup failed: $($_.Exception.Message)"
        }
    }

    if (Test-Path -LiteralPath $installRoot) {
        Write-Warning "Installer leftovers remain for inspection: $installRoot"
    }
    if (Test-Path -LiteralPath $userDataRoot) {
        Write-Warning "Smoke-test userData remains for inspection: $userDataRoot"
    }
}
