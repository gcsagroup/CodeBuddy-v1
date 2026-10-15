param(
    [switch]$UseExistingBackend,
    [switch]$UseExistingReleaseBackend,
    [switch]$SkipDependencyInstall,
    [switch]$SkipTests,
    [ValidateRange(1, 16)][int]$CheckJobs = 1,
    [ValidateRange(1, 16)][int]$BuildJobs = 1,
    [switch]$SkipInstaller,
    [switch]$RunInstallerSmoke,
    [string]$PreviousInstallerPath,
    [string]$ExpectedDisposableWindowsAccountSid
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$uiRoot = Join-Path $repoRoot "ui"
$desktopRoot = Join-Path $uiRoot "desktop"
$packagePlatform = "win32"
$packageArchitecture = "x64"
$backendSource = Join-Path $repoRoot "target\release\goose.exe"
$desktopBin = Join-Path $desktopRoot "src\bin"
$backendTarget = Join-Path $desktopBin "goose.exe"
$packagingBin = $desktopBin
$packagingStageRoot = Join-Path $repoRoot "target\codebuddy-package"
$packagingManifestPath = Join-Path $packagingStageRoot "backend-manifest.json"
$packageInspectionScript = Join-Path $repoRoot "scripts\inspect-codebuddy-windows-package.ps1"
$peInspectionScript = Join-Path $repoRoot "scripts\codebuddy-windows-pe.ps1"
$installerSmokeScript = Join-Path $repoRoot "scripts\test-codebuddy-windows-installer.ps1"
$installerLifecycleScript = Join-Path $repoRoot "scripts\test-codebuddy-windows-lifecycle.ps1"
$allowedDisposableWindowsAccountNames = @("CodexSandboxOffline", "CodexSandboxOnline")
. $peInspectionScript

function Get-DisposableIdentityArguments {
    param([string]$ExpectedSid)
    if ([string]::IsNullOrWhiteSpace($ExpectedSid)) {
        throw "-RunInstallerSmoke requires -ExpectedDisposableWindowsAccountSid."
    }
    return @(
        "-ConfirmDisposableWindowsAccount",
        "-ExpectedDisposableWindowsAccountSid",
        $ExpectedSid
    )
}

function Assert-DisposableWindowsIdentity {
    param([Parameter(Mandatory = $true)][string]$ExpectedSid)
    if ($env:CODEBUDDY_DISPOSABLE_TEST_ACCOUNT -ne "true") {
        throw "-RunInstallerSmoke requires CODEBUDDY_DISPOSABLE_TEST_ACCOUNT=true."
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not [string]::Equals($identity.User.Value, $ExpectedSid, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Disposable Windows account SID mismatch. Expected $ExpectedSid; current SID is $($identity.User.Value)."
    }
    $accountName = @($identity.Name -split '\\')[-1]
    if ($allowedDisposableWindowsAccountNames -notcontains $accountName) {
        throw "Installer smoke requires a dedicated Windows account name: CodexSandboxOffline or CodexSandboxOnline."
    }
}

function Get-ExactPackagedExecutable {
    param(
        [Parameter(Mandatory = $true)][string]$DesktopRoot,
        [Parameter(Mandatory = $true)][string]$Platform,
        [Parameter(Mandatory = $true)][string]$Architecture
    )
    if ($Platform -ne "win32" -or $Architecture -ne "x64") {
        throw "The CodeBuddy Windows package target must be win32/x64."
    }
    $packageDirectory = [IO.Path]::GetFullPath(
        (Join-Path $DesktopRoot "out\CodeBuddy-win32-x64")
    )
    if (-not (Test-Path -LiteralPath $packageDirectory -PathType Container)) {
        throw "Electron package completed without producing the exact packaged application directory: $packageDirectory"
    }
    $packageDirectoryItem = Get-Item -LiteralPath $packageDirectory -Force
    if ($packageDirectoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing a reparse-point packaged application directory: $packageDirectory"
    }
    $executablePath = Join-Path $packageDirectory "CodeBuddy.exe"
    if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
        throw "Electron package completed without producing the exact packaged application: $executablePath"
    }
    return (Get-Item -LiteralPath $executablePath -Force)
}

function Get-ExactSquirrelInstaller {
    param(
        [Parameter(Mandatory = $true)][string]$DesktopRoot,
        [Parameter(Mandatory = $true)][string]$Platform,
        [Parameter(Mandatory = $true)][string]$Architecture
    )
    if ($Platform -ne "win32" -or $Architecture -ne "x64") {
        throw "The CodeBuddy Squirrel installer target must be win32/x64."
    }
    $relativeDirectories = @("out", "out\make", "out\make\squirrel.windows", "out\make\squirrel.windows\x64")
    foreach ($relativeDirectory in $relativeDirectories) {
        $directory = [IO.Path]::GetFullPath((Join-Path $DesktopRoot $relativeDirectory))
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            throw "Electron make completed without producing the exact Squirrel installer directory: $directory"
        }
        $directoryItem = Get-Item -LiteralPath $directory -Force
        if ($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing a reparse-point Squirrel installer directory: $directory"
        }
    }
    $installerPath = [IO.Path]::GetFullPath(
        (Join-Path $DesktopRoot "out\make\squirrel.windows\x64\CodeBuddy-Setup.exe")
    )
    if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
        throw "Electron make completed without producing the exact Squirrel installer: $installerPath"
    }
    return (Get-Item -LiteralPath $installerPath -Force)
}

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Require-Command {
    param([string]$Name, [string]$InstallHint)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command '$Name'. $InstallHint"
    }
}

function Assert-LastExitCode {
    param([string]$Step)
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

function Use-PackagingBackendStage {
    $targetRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "target")).TrimEnd('\') + '\'
    $stageRoot = [IO.Path]::GetFullPath($packagingStageRoot)
    if (-not $stageRoot.StartsWith($targetRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to reset a packaging stage outside the Cargo target directory: $stageRoot"
    }

    if (Test-Path -LiteralPath $stageRoot) {
        $stageItem = Get-Item -LiteralPath $stageRoot -Force
        if ($stageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing to reset a reparse-point packaging stage: $stageRoot"
        }
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path (Join-Path $stageRoot "bin") -Force | Out-Null
    return Join-Path $stageRoot "bin"
}

function Sync-PackagingBackendStage {
    param([Parameter(Mandatory = $true)][string]$StageBin)

    Get-ChildItem -LiteralPath $desktopBin -Force |
        Where-Object { $_.Name -ne "goose.exe" } |
        ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $StageBin -Recurse -Force
        }
    Copy-Item -LiteralPath $backendSource -Destination (Join-Path $StageBin "goose.exe") -Force
}

function Write-PackagingBackendManifest {
    param([Parameter(Mandatory = $true)][string]$StageBin)

    $stagedBackend = Join-Path $StageBin "goose.exe"
    $releaseHash = (Get-FileHash -LiteralPath $backendSource -Algorithm SHA256).Hash.ToLowerInvariant()
    $stagedHash = (Get-FileHash -LiteralPath $stagedBackend -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($releaseHash -ne $stagedHash) {
        throw "The staged backend SHA256 does not match target\release\goose.exe."
    }
    $sourceCommit = (& git rev-parse HEAD).Trim()
    Assert-LastExitCode "source commit capture"
    $sourceStatus = @(& git status --porcelain=v1)
    Assert-LastExitCode "source state capture"
    $manifest = [ordered]@{
        schemaVersion = 1
        profile = "release"
        target = "x86_64-pc-windows-msvc"
        sourceCommit = $sourceCommit
        sourceDirty = $sourceStatus.Count -gt 0
        cargoLockSha256 = (Get-FileHash -LiteralPath (Join-Path $repoRoot "Cargo.lock") -Algorithm SHA256).Hash.ToLowerInvariant()
        releaseBackendPath = [IO.Path]::GetFullPath($backendSource)
        resourceDirectory = [IO.Path]::GetFullPath($StageBin)
        backendSha256 = $releaseHash
        createdAtUtc = [DateTime]::UtcNow.ToString("o")
    }
    [IO.File]::WriteAllText(
        $packagingManifestPath,
        ($manifest | ConvertTo-Json -Depth 4) + "`n",
        [Text.UTF8Encoding]::new($false)
    )
}

function Copy-AppLocalVisualCppRuntime {
    param([Parameter(Mandatory = $true)][string]$Destination)

    if ([string]::IsNullOrWhiteSpace($env:VCToolsRedistDir)) {
        throw "Visual C++ redistributable discovery requires VCToolsRedistDir from VsDevCmd."
    }

    $destinationPath = [IO.Path]::GetFullPath($Destination)
    if (-not (Test-Path -LiteralPath $destinationPath -PathType Container)) {
        throw "The backend resource directory does not exist: $destinationPath"
    }
    $destinationItem = Get-Item -LiteralPath $destinationPath -Force
    if ($destinationItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to copy the Visual C++ runtime into a reparse-point directory: $destinationPath"
    }

    $x64RedistRoot = Join-Path $env:VCToolsRedistDir "x64"
    $crtDirectories = @(
        Get-ChildItem -LiteralPath $x64RedistRoot -Directory -Filter "Microsoft.VC*.CRT" -ErrorAction Stop
    )
    if ($crtDirectories.Count -ne 1) {
        throw "Expected exactly one x64 Visual C++ CRT redistributable directory under $x64RedistRoot; found $($crtDirectories.Count)."
    }

    $runtimeFiles = @(Get-ChildItem -LiteralPath $crtDirectories[0].FullName -File -Filter "*.dll")
    $requiredRuntimeNames = @("MSVCP140.dll", "VCRUNTIME140.dll", "VCRUNTIME140_1.dll")
    foreach ($requiredRuntimeName in $requiredRuntimeNames) {
        if (-not ($runtimeFiles | Where-Object {
            [string]::Equals($_.Name, $requiredRuntimeName, [StringComparison]::OrdinalIgnoreCase)
        })) {
            throw "The Visual C++ CRT redistributable is missing $requiredRuntimeName."
        }
    }

    foreach ($runtimeFile in $runtimeFiles) {
        $signature = Get-AuthenticodeSignature -LiteralPath $runtimeFile.FullName
        if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
            throw "Refusing unsigned or invalid Visual C++ runtime file $($runtimeFile.FullName): $($signature.Status)."
        }
        $targetPath = Join-Path $destinationPath $runtimeFile.Name
        Copy-Item -LiteralPath $runtimeFile.FullName -Destination $targetPath -Force
        if ((Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath $runtimeFile.FullName -Algorithm SHA256).Hash) {
            throw "Visual C++ runtime copy verification failed for $($runtimeFile.Name)."
        }
    }
}

function Ensure-V8BuildJunction {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("debug", "release")]
        [string]$Profile
    )

    $metadataOutput = & cargo metadata --format-version 1
    Assert-LastExitCode "Cargo metadata for the V8 build junction"
    # Windows PowerShell treats JSON object keys case-insensitively, while Cargo metadata can
    # contain distinct feature keys such as USB and usb. Let Node select only the paths needed.
    $metadataSelector = @'
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const metadata = JSON.parse(input.replace(/^\uFEFF/, ''));
  const packages = metadata.packages.filter((entry) => entry.name === 'v8-goose');
  if (packages.length !== 1) {
    throw new Error(`Expected exactly one v8-goose package, found ${packages.length}.`);
  }
  process.stdout.write(JSON.stringify({
    manifestPath: packages[0].manifest_path,
    targetDirectory: metadata.target_directory,
  }));
});
'@
    $selectedMetadataOutput = $metadataOutput | & node -e $metadataSelector
    Assert-LastExitCode "V8 path selection from Cargo metadata"
    $selectedMetadata = ($selectedMetadataOutput -join "`n") | ConvertFrom-Json

    $sourceRoot = [IO.Path]::GetFullPath((Split-Path -Parent $selectedMetadata.manifestPath))
    $targetRoot = [IO.Path]::GetFullPath([string]$selectedMetadata.targetDirectory)
    if ((Split-Path -Qualifier $sourceRoot) -eq (Split-Path -Qualifier $targetRoot)) {
        return
    }

    $profileRoot = Join-Path $targetRoot $Profile
    $junctionPath = Join-Path $profileRoot "gn_root"
    New-Item -ItemType Directory -Path $profileRoot -Force | Out-Null

    $existing = Get-Item -LiteralPath $junctionPath -Force -ErrorAction SilentlyContinue
    if ($existing) {
        $existingTarget = @($existing.Target) | Select-Object -First 1
        if (-not ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            [string]::IsNullOrWhiteSpace($existingTarget) -or
            -not [string]::Equals(
                [IO.Path]::GetFullPath($existingTarget),
                $sourceRoot,
                [StringComparison]::OrdinalIgnoreCase
            )) {
            throw "Refusing to replace unexpected V8 build path: $junctionPath"
        }
        return
    }

    # A junction works across Windows volumes without Developer Mode or elevation.
    New-Item -ItemType Junction -Path $junctionPath -Target $sourceRoot | Out-Null
}

function Import-VisualStudioBuildEnvironment {
    $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    if ([string]::IsNullOrWhiteSpace($programFilesX86)) {
        throw "Cannot locate Program Files (x86) to discover Visual Studio Build Tools."
    }

    $vsWhere = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $vsWhere)) {
        throw "Visual Studio Installer discovery tool not found: $vsWhere"
    }

    $installationPath = & $vsWhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath | Select-Object -First 1
    Assert-LastExitCode "Visual Studio Build Tools discovery"
    if ([string]::IsNullOrWhiteSpace($installationPath)) {
        throw "Visual Studio C++ Build Tools were not found."
    }

    $vsDevCmd = Join-Path $installationPath "Common7\Tools\VsDevCmd.bat"
    if (-not (Test-Path -LiteralPath $vsDevCmd)) {
        throw "Visual Studio developer environment script not found: $vsDevCmd"
    }

    $environmentLines = & cmd.exe /d /c "call `"$vsDevCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
    Assert-LastExitCode "Visual Studio developer environment import"
    $protectedProcessEnvironmentNames = @("PSModulePath")
    foreach ($line in $environmentLines) {
        $separator = $line.IndexOf('=')
        if ($separator -gt 0) {
            $name = $line.Substring(0, $separator)
            $value = $line.Substring($separator + 1)
            if ($protectedProcessEnvironmentNames -contains $name) {
                continue
            }
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
        }
    }

    $llvmBin = Join-Path $installationPath "VC\Tools\Llvm\x64\bin"
    if ((Test-Path -LiteralPath (Join-Path $llvmBin "libclang.dll")) -and
        [string]::IsNullOrWhiteSpace($env:LIBCLANG_PATH)) {
        $env:LIBCLANG_PATH = $llvmBin
    }
    if ([string]::IsNullOrWhiteSpace($env:CXXFLAGS)) {
        $env:CXXFLAGS = "/utf-8 /EHsc"
    }

    Require-Command "cmake" "Install the C++ CMake tools component with Visual Studio Build Tools."
    Require-Command "cl" "Install the MSVC x64 compiler with Visual Studio Build Tools."
}

Push-Location $repoRoot
try {
    Write-Host "CodeBuddy Windows build" -ForegroundColor Green
    Write-Host "Repository: $repoRoot"

    if ($SkipInstaller -and $RunInstallerSmoke) {
        throw "-RunInstallerSmoke cannot be combined with -SkipInstaller."
    }
    if (-not [string]::IsNullOrWhiteSpace($PreviousInstallerPath) -and -not $RunInstallerSmoke) {
        throw "-PreviousInstallerPath requires -RunInstallerSmoke."
    }
    if ($UseExistingBackend -and $UseExistingReleaseBackend) {
        throw "-UseExistingBackend and -UseExistingReleaseBackend cannot be combined."
    }
    if ($UseExistingBackend) {
        throw "-UseExistingBackend is disabled for Windows distribution builds because an unverified development backend cannot be packaged. Use -UseExistingReleaseBackend with target\release\goose.exe instead."
    }

    Require-Command "git" "Install Git for Windows."
    Require-Command "node" "Install Node.js 24.x."
    Require-Command "pnpm" "Install pnpm 10.30 or newer."

    Write-Step "Checking tool versions"
    git --version
    Assert-LastExitCode "git version check"
    node --version
    Assert-LastExitCode "Node.js version check"
    pnpm --version
    Assert-LastExitCode "pnpm version check"

    if (-not $UseExistingBackend) {
        if (-not $UseExistingReleaseBackend) {
            Require-Command "cargo" "Install Rust with rustup and the Visual Studio C++ Build Tools."
            Import-VisualStudioBuildEnvironment

            Write-Step "Running Rust quality gates"
            Ensure-V8BuildJunction -Profile "debug"
            cargo fmt --all -- --check
            Assert-LastExitCode "cargo fmt"
            # Match the default features used by the Windows release below. --all-features
            # also enables macOS MLX and optional CUDA/Vulkan backends that are not in this package.
            # vendor/v8 exists only so cargo-machete can inspect it. Its Windows build requires
            # Developer Mode symlink privileges and is not linked into the desktop release.
            # Serial compilation avoids zero-byte .rmeta artifacts and follow-on E0463
            # errors when Windows runs the large Goose all-target graph in parallel.
            cargo clippy --workspace --all-targets --exclude v8 --jobs $CheckJobs -- -D warnings
            Assert-LastExitCode "cargo clippy"

            if (-not $SkipTests) {
                Write-Step "Running Rust provider and workspace tests"
                # Windows link.exe can exhaust the PDB record limit on the largest test
                # binaries (LNK1201/LNK1318). Test behavior is unchanged without debug symbols,
                # and serial linking keeps PDB/resource usage inside a bounded Windows budget.
                $env:CARGO_PROFILE_TEST_DEBUG = "0"
                $env:CARGO_INCREMENTAL = "0"
                cargo test -p goose-providers declarative
                Assert-LastExitCode "Rust declarative provider tests"
                cargo test --workspace --jobs 1
                Assert-LastExitCode "Rust workspace tests"
            }

            Write-Step "Building the Goose-compatible backend used by CodeBuddy"
            Ensure-V8BuildJunction -Profile "release"
            # The optimized Goose graph can otherwise run several memory-heavy rustc
            # processes at once and exhaust Windows commit memory.
            cargo build --release -p goose-cli --bin goose --jobs $BuildJobs
            Assert-LastExitCode "Rust release build"
        }
        else {
            Write-Step "Using the existing release backend"
        }

        if (-not (Test-Path -LiteralPath $backendSource)) {
            throw "The release backend was not found: $backendSource."
        }
        Assert-CodeBuddyReleaseBackend -BackendPath $backendSource `
            -ExpectedReleaseBackendPath $backendSource | Out-Null

        $packagingBin = Use-PackagingBackendStage
        Sync-PackagingBackendStage -StageBin $packagingBin
        Get-ChildItem -LiteralPath (Join-Path $repoRoot "target\release") -Filter "*.dll" -ErrorAction SilentlyContinue |
            ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $packagingBin -Force }
    }
    elseif (-not (Test-Path -LiteralPath $backendTarget)) {
        throw "-UseExistingBackend requires $backendTarget."
    }

    if ([string]::IsNullOrWhiteSpace($env:VCToolsRedistDir)) {
        Import-VisualStudioBuildEnvironment
    }
    Copy-AppLocalVisualCppRuntime -Destination $packagingBin
    Assert-CodeBuddyReleaseBackend -BackendPath (Join-Path $packagingBin "goose.exe") `
        -ExpectedReleaseBackendPath $backendSource -ResourceDirectory $packagingBin | Out-Null
    Write-PackagingBackendManifest -StageBin $packagingBin
    $env:CODEBUDDY_BACKEND_RESOURCE_DIR = $packagingBin
    $env:CODEBUDDY_BACKEND_MANIFEST_PATH = $packagingManifestPath

    if (-not $SkipDependencyInstall) {
        Write-Step "Installing locked UI dependencies"
        Push-Location $uiRoot
        try {
            pnpm install --frozen-lockfile
            Assert-LastExitCode "pnpm install"
        }
        finally {
            Pop-Location
        }
    }

    Push-Location $desktopRoot
    try {
        Write-Step "Building the desktop SDK and translations"
        pnpm run build-goose-sdk
        Assert-LastExitCode "SDK build"
        pnpm run i18n:compile
        Assert-LastExitCode "i18n compile"

        Write-Step "Running CodeBuddy distribution and type checks"
        pnpm run test:distribution
        Assert-LastExitCode "distribution tests"
        pnpm run typecheck
        Assert-LastExitCode "TypeScript typecheck"
        pnpm run lint:check
        Assert-LastExitCode "desktop lint and i18n checks"

        if (-not $SkipTests) {
            Write-Step "Running desktop unit tests"
            pnpm run test:run
            Assert-LastExitCode "desktop unit tests"
        }

        $env:GOOSE_BUNDLE_NAME = "CodeBuddy"
        Write-Step "Preparing Windows support binaries"
        node .\scripts\prepare-platform-binaries.js
        Assert-LastExitCode "Windows support binary preparation"
        Write-Step "Packaging CodeBuddy"
        pnpm exec electron-forge package --platform $packagePlatform --arch $packageArchitecture
        Assert-LastExitCode "Electron package"

        if (-not $SkipInstaller) {
            Write-Step "Creating the CodeBuddy Windows installer"
            pnpm exec electron-forge make --platform $packagePlatform --arch $packageArchitecture
            Assert-LastExitCode "Electron installer"
        }
    }
    finally {
        Pop-Location
    }

    $packagedExecutable = Get-ExactPackagedExecutable -DesktopRoot $desktopRoot `
        -Platform $packagePlatform -Architecture $packageArchitecture

    $installer = $null
    if (-not $SkipInstaller) {
        $installer = Get-ExactSquirrelInstaller -DesktopRoot $desktopRoot `
            -Platform $packagePlatform -Architecture $packageArchitecture

        Write-Step "Validating the CodeBuddy Windows package and installer"
        $inspectionEvidence = Join-Path $repoRoot "target\codebuddy-package-inspection.json"
        $inspectionArguments = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $packageInspectionScript,
            "-InstallerPath", $installer.FullName,
            "-PackagedAppPath", $packagedExecutable.FullName,
            "-ExpectedReleaseBackendPath", $backendSource,
            "-EvidencePath", $inspectionEvidence
        )
        & powershell.exe @inspectionArguments
        Assert-LastExitCode "Windows package inspection"

        if ($RunInstallerSmoke) {
            $disposableIdentityArguments = Get-DisposableIdentityArguments `
                -ExpectedSid $ExpectedDisposableWindowsAccountSid
            Assert-DisposableWindowsIdentity -ExpectedSid $ExpectedDisposableWindowsAccountSid
            $installerSmokeArguments = @(
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-File", $installerSmokeScript,
                "-PreflightOnly"
            )
            $installerSmokeArguments += $disposableIdentityArguments
            & powershell.exe @installerSmokeArguments
            Assert-LastExitCode "Windows installer smoke preflight"

            $lifecycleId = [Guid]::NewGuid().ToString("N")
            $lifecycleRoot = Join-Path $repoRoot "target\codebuddy-lifecycle\$lifecycleId"
            $lifecycleEvidence = Join-Path $repoRoot "target\codebuddy-lifecycle-evidence\$lifecycleId.json"
            $lifecycleArguments = @(
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-File", $installerLifecycleScript,
                "-CurrentInstallerPath", $installer.FullName,
                "-IsolatedRoot", $lifecycleRoot,
                "-EvidencePath", $lifecycleEvidence,
                "-ConfirmIsolatedLifecycle"
            )
            $lifecycleArguments += $disposableIdentityArguments
            if (-not [string]::IsNullOrWhiteSpace($PreviousInstallerPath)) {
                $lifecycleArguments += @("-PreviousInstallerPath", $PreviousInstallerPath)
            }
            & powershell.exe @lifecycleArguments
            Assert-LastExitCode "Windows isolated lifecycle validation"
        }
    }

    Write-Host "`nBuild complete." -ForegroundColor Green
    Write-Host "Application: $($packagedExecutable.FullName)" -ForegroundColor Green
    if ($installer) {
        Write-Host "Installer: $($installer.FullName)" -ForegroundColor Green
    }
}
finally {
    Pop-Location
}
