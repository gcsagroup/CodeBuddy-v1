Set-StrictMode -Version Latest

# PowerShell does not define this automatic variable until a native process has
# run in the current session. Initialize it so the release gate also works in a
# fresh, strict-mode packaging shell.
$global:LASTEXITCODE = 0

function Resolve-CodeBuddyDumpbin {
    $available = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
    if ($available) {
        return $available.Source
    }

    $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    if ([string]::IsNullOrWhiteSpace($programFilesX86)) {
        throw "Cannot locate Program Files (x86) to discover dumpbin.exe."
    }
    $vsWhere = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $vsWhere -PathType Leaf)) {
        throw "Visual Studio Installer discovery tool not found: $vsWhere"
    }
    $installationPath = & $vsWhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($installationPath)) {
        throw "Visual Studio C++ Build Tools were not found."
    }
    $matches = @(Get-ChildItem -LiteralPath (Join-Path $installationPath "VC\Tools\MSVC") `
            -Filter "dumpbin.exe" -File -Recurse -ErrorAction Stop |
        Where-Object { $_.FullName -match '\\bin\\Hostx64\\x64\\dumpbin\.exe$' } |
        Sort-Object FullName -Descending)
    if ($matches.Count -lt 1) {
        throw "The x64 dumpbin.exe was not found under $installationPath."
    }
    return $matches[0].FullName
}

function Get-CodeBuddyPeDependencies {
    param([Parameter(Mandatory = $true)][string]$BackendPath)

    $resolvedBackend = [IO.Path]::GetFullPath($BackendPath)
    if (-not (Test-Path -LiteralPath $resolvedBackend -PathType Leaf)) {
        throw "The backend executable was not found: $resolvedBackend"
    }
    $dumpbin = Resolve-CodeBuddyDumpbin
    $output = @(& $dumpbin /DEPENDENTS $resolvedBackend 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "dumpbin /DEPENDENTS failed for $resolvedBackend with exit code $LASTEXITCODE."
    }
    $dependencies = @($output |
        ForEach-Object { ([string]$_).Trim() } |
        Where-Object { $_ -match '^[A-Za-z0-9_.-]+\.dll$' } |
        Sort-Object -Unique)
    if ($dependencies.Count -eq 0) {
        throw "No PE imports were found for $resolvedBackend."
    }
    return [ordered]@{
        tool = $dumpbin
        dependencies = $dependencies
        output = ($output -join "`n")
    }
}

function Assert-CodeBuddyDependencySet {
    param([Parameter(Mandatory = $true)][string[]]$DependencyNames)

    $debugPatterns = @(
        '^VCRUNTIME.*D\.dll$',
        '^MSVCP.*D\.dll$',
        '^ucrtbased\.dll$',
        '^mfc.*d\.dll$',
        '^concrt.*d\.dll$',
        '^vcomp.*d\.dll$'
    )
    $debugDependencies = @($DependencyNames | Where-Object {
            $candidate = $_
            $debugPatterns | Where-Object { $candidate -match $_ }
        } | Sort-Object -Unique)
    if ($debugDependencies.Count -gt 0) {
        throw "Debug CRT dependencies are forbidden in a release backend: $($debugDependencies -join ', ')"
    }
}

function Test-CodeBuddySystemDependency {
    param([Parameter(Mandatory = $true)][string]$Name)

    if ($Name -match '^(api-ms-|ext-ms-)') {
        return $true
    }
    return $Name -in @(
        "advapi32.dll", "bcrypt.dll", "bcryptprimitives.dll", "cfgmgr32.dll",
        "combase.dll", "comctl32.dll", "comdlg32.dll", "crypt32.dll", "dbghelp.dll",
        "dwmapi.dll", "gdi32.dll", "imm32.dll", "iphlpapi.dll", "kernel32.dll",
        "ntdll.dll", "normaliz.dll", "ole32.dll", "oleaut32.dll", "pdh.dll",
        "powrprof.dll", "psapi.dll", "rpcrt4.dll", "secur32.dll", "setupapi.dll",
        "shell32.dll", "shlwapi.dll", "ucrtbase.dll", "user32.dll", "userenv.dll",
        "uxtheme.dll", "version.dll", "winhttp.dll", "winmm.dll", "wintrust.dll",
        "ws2_32.dll"
    )
}

function Assert-CodeBuddyReleaseBackend {
    param(
        [Parameter(Mandatory = $true)][string]$BackendPath,
        [string]$ExpectedReleaseBackendPath,
        [string]$ResourceDirectory
    )

    $resolvedBackend = [IO.Path]::GetFullPath($BackendPath)
    $dependencyEvidence = Get-CodeBuddyPeDependencies -BackendPath $resolvedBackend
    $dependencies = @($dependencyEvidence.dependencies)
    Assert-CodeBuddyDependencySet -DependencyNames $dependencies

    $backendSha256 = (Get-FileHash -LiteralPath $resolvedBackend -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedSha256 = $null
    if (-not [string]::IsNullOrWhiteSpace($ExpectedReleaseBackendPath)) {
        $resolvedExpected = [IO.Path]::GetFullPath($ExpectedReleaseBackendPath)
        if (-not (Test-Path -LiteralPath $resolvedExpected -PathType Leaf)) {
            throw "The expected release backend was not found: $resolvedExpected"
        }
        $expectedSha256 = (Get-FileHash -LiteralPath $resolvedExpected -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($backendSha256 -ne $expectedSha256) {
            throw "The packaged backend SHA256 does not match target\release\goose.exe."
        }
    }

    $missingRuntimeFiles = @()
    $missingImportedFiles = @()
    if (-not [string]::IsNullOrWhiteSpace($ResourceDirectory)) {
        $resolvedResources = [IO.Path]::GetFullPath($ResourceDirectory)
        if (-not (Test-Path -LiteralPath $resolvedResources -PathType Container)) {
            throw "The packaged backend resource directory was not found: $resolvedResources"
        }
        $resourceDllNames = @(Get-ChildItem -LiteralPath $resolvedResources -Filter "*.dll" -File |
            Select-Object -ExpandProperty Name)
        Assert-CodeBuddyDependencySet -DependencyNames $resourceDllNames
        $requiredRuntimeNames = @("MSVCP140.dll", "VCRUNTIME140.dll", "VCRUNTIME140_1.dll")
        $missingRuntimeFiles = @($requiredRuntimeNames | Where-Object {
                -not (Test-Path -LiteralPath (Join-Path $resolvedResources $_) -PathType Leaf)
            })
        if ($missingRuntimeFiles.Count -gt 0) {
            throw "The packaged backend is missing required app-local Release CRT files: $($missingRuntimeFiles -join ', ')"
        }

        $missingImportedFiles = @($dependencies | Where-Object {
                -not (Test-CodeBuddySystemDependency -Name $_) -and
                -not (Test-Path -LiteralPath (Join-Path $resolvedResources $_) -PathType Leaf)
            })
        if ($missingImportedFiles.Count -gt 0) {
            throw "The packaged backend is missing imported runtime dependencies: $($missingImportedFiles -join ', ')"
        }
    }

    return [ordered]@{
        path = $resolvedBackend
        sha256 = $backendSha256
        expectedReleaseSha256 = $expectedSha256
        dependencyTool = $dependencyEvidence.tool
        dependencies = $dependencies
        missingRuntimeFiles = $missingRuntimeFiles
        missingImportedFiles = $missingImportedFiles
        dumpbinOutput = $dependencyEvidence.output
    }
}
