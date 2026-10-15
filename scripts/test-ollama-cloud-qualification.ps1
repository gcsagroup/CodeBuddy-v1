[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$')]
    [string]$Model,

    [ValidateSet('v2')]
    [string]$Version = 'v2',

    [string]$GooseBinary,

    [string]$OutputPath,

    [switch]$KeepFixture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$qualificationRoot = Join-Path $repoRoot "evals\codebuddy\ollama-cloud-$Version"
$manifestPath = Join-Path $qualificationRoot 'qualification.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

if (-not $GooseBinary) {
    $GooseBinary = Join-Path $repoRoot 'target\release\goose.exe'
}
$GooseBinary = [IO.Path]::GetFullPath($GooseBinary)
if (-not (Test-Path -LiteralPath $GooseBinary -PathType Leaf)) {
    throw "Goose binary was not found: $GooseBinary"
}

$resultsDirectory = Join-Path $qualificationRoot 'results'
if (-not $OutputPath) {
    $safeModel = $Model -replace '[^A-Za-z0-9._-]', '-'
    $stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
    $OutputPath = Join-Path $resultsDirectory "$stamp-$safeModel.json"
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $OutputPath) {
    throw "Refusing to overwrite an existing qualification result: $OutputPath"
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-WindowsCredentialTarget {
    param([Parameter(Mandatory = $true)][string]$Target)

    if ($env:OS -ne 'Windows_NT' -or -not (Get-Command cmdkey.exe -ErrorAction SilentlyContinue)) {
        return $null
    }

    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& cmdkey.exe /list 2>$null)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
        return $null
    }
    return ($output -join "`n").IndexOf($Target, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-NormalizedFixtureContent {
    param([Parameter(Mandatory = $true)][IO.FileInfo]$File)

    $textExtensions = @('.json', '.md', '.py', '.txt', '.yaml', '.yml')
    if ($textExtensions -contains $File.Extension.ToLowerInvariant()) {
        $text = [IO.File]::ReadAllText($File.FullName, [Text.Encoding]::UTF8)
        return [Text.Encoding]::UTF8.GetBytes($text.Replace("`r`n", "`n"))
    }
    return [IO.File]::ReadAllBytes($File.FullName)
}

function Get-DirectorySha256 {
    param([Parameter(Mandatory = $true)][string]$Directory)

    $root = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/')
    $files = @(Get-ChildItem -LiteralPath $root -File -Recurse | Sort-Object {
        $_.FullName.Substring($root.Length + 1).Replace('\', '/')
    })
    $sha = [Security.Cryptography.SHA256]::Create()

    try {
        foreach ($file in $files) {
            $relativePath = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
            $prefix = [Text.Encoding]::UTF8.GetBytes($relativePath + [char]0)
            $content = Get-NormalizedFixtureContent $file
            $suffix = [byte[]]@(0)
            [void]$sha.TransformBlock($prefix, 0, $prefix.Length, $prefix, 0)
            if ($content.Length -gt 0) {
                [void]$sha.TransformBlock($content, 0, $content.Length, $content, 0)
            }
            [void]$sha.TransformBlock($suffix, 0, $suffix.Length, $suffix, 0)
        }
        [void]$sha.TransformFinalBlock([byte[]]::new(0), 0, 0)
        return ([BitConverter]::ToString($sha.Hash) -replace '-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Remove-SafeQualificationDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$TemporaryBase
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $expectedPrefix = $TemporaryBase.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedPath.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedPath) -notlike 'CodeBuddy-Qualification-*') {
        throw "Refusing to remove an unexpected fixture path: $resolvedPath"
    }
    Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}

function Quote-ProcessArgument {
    param([AllowEmptyString()][string]$Argument)

    if ($Argument -notmatch '[\s"]') {
        return $Argument
    }

    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $Argument.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
            continue
        }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
            [void]$builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append(('\' * $backslashes))
            $backslashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) {
        [void]$builder.Append(('\' * ($backslashes * 2)))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Invoke-ProcessCaptured {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        [hashtable]$Environment = @{}
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = (($Arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' ')
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $startInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $startInfo.EnvironmentVariables.Clear()
    $inheritedEnvironmentAllowlist = @(
        'SystemRoot'
        'WINDIR'
        'ComSpec'
        'PATH'
        'PATHEXT'
        'TEMP'
        'TMP'
        'USERPROFILE'
        'HOMEDRIVE'
        'HOMEPATH'
        'APPDATA'
        'LOCALAPPDATA'
    )
    foreach ($name in $inheritedEnvironmentAllowlist) {
        $value = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)
        if (-not [string]::IsNullOrEmpty($value)) {
            $startInfo.EnvironmentVariables[$name] = $value
        }
    }
    foreach ($entry in $Environment.GetEnumerator()) {
        $startInfo.EnvironmentVariables[[string]$entry.Key] = [string]$entry.Value
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    try {
        if (-not $process.Start()) {
            throw "Failed to start process: $FilePath"
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $timedOut = -not $process.WaitForExit($TimeoutSeconds * 1000)
        if ($timedOut) {
            $process.Kill()
        }
        $process.WaitForExit()
        $stopwatch.Stop()
        return [PSCustomObject]@{
            ExitCode = if ($timedOut) { -1 } else { $process.ExitCode }
            TimedOut = $timedOut
            DurationMs = $stopwatch.ElapsedMilliseconds
            Stdout = $stdoutTask.GetAwaiter().GetResult()
            Stderr = $stderrTask.GetAwaiter().GetResult()
        }
    }
    finally {
        $stopwatch.Stop()
        $process.Dispose()
    }
}

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& git -C $WorkingDirectory -c core.autocrlf=false @Arguments 2>&1)
        $gitExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($gitExitCode -ne 0) {
        throw "Git command failed: git $($Arguments -join ' ')"
    }
    return ($output -join "`n").Trim()
}

function Get-AssistantText {
    param([Parameter(Mandatory = $true)]$RunOutput)

    $parts = @()
    foreach ($message in @($RunOutput.messages)) {
        if ([string]$message.role -ne 'assistant') {
            continue
        }
        foreach ($content in @($message.content)) {
            if ([string]$content.type -eq 'text') {
                $parts += [string]$content.text
            }
        }
    }
    return ($parts -join '').Trim()
}

function Get-ToolCalls {
    param([Parameter(Mandatory = $true)]$RunOutput)

    $calls = @()
    foreach ($message in @($RunOutput.messages)) {
        foreach ($content in @($message.content)) {
            if ([string]$content.type -ne 'toolRequest' -or
                [string]$content.toolCall.status -ne 'success') {
                continue
            }
            $value = $content.toolCall.value
            $argumentsJson = if ($null -eq $value.arguments) {
                '{}'
            }
            else {
                $value.arguments | ConvertTo-Json -Compress -Depth 30
            }
            $calls += [PSCustomObject]@{
                name = [string]$value.name
                argumentsJson = $argumentsJson
                signature = "$([string]$value.name)|$argumentsJson"
            }
        }
    }
    return $calls
}

function Get-MaxConsecutiveIdenticalCalls {
    param([object[]]$Calls)

    $maximum = 0
    $current = 0
    $previous = $null
    foreach ($call in @($Calls)) {
        if ($call.signature -eq $previous) {
            $current++
        }
        else {
            $previous = $call.signature
            $current = 1
        }
        if ($current -gt $maximum) {
            $maximum = $current
        }
    }
    return $maximum
}

function Convert-GooseJson {
    param([Parameter(Mandatory = $true)]$ProcessResult)

    if ($ProcessResult.TimedOut -or $ProcessResult.ExitCode -ne 0) {
        return $null
    }
    try {
        return $ProcessResult.Stdout | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        return $null
    }
}

function Get-TotalTokens {
    param($RunOutput)

    if ($null -eq $RunOutput -or $null -eq $RunOutput.metadata) {
        return $null
    }
    foreach ($name in @('total_tokens', 'totalTokens')) {
        $property = $RunOutput.metadata.PSObject.Properties[$name]
        if ($null -ne $property) {
            return $property.Value
        }
    }
    return $null
}

function Invoke-GooseQualificationRun {
    param(
        [Parameter(Mandatory = $true)][string]$PromptPath,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )

    $arguments = @(
        'run',
        '--provider', 'ollama_cloud',
        '--model', $Model,
        '--no-profile',
        '--with-builtin', 'developer',
        '--no-session',
        '--output-format', 'json',
        '--max-tool-repetitions', [string]$manifest.gates.g1.maxConsecutiveIdenticalToolCalls,
        '--max-turns', '12',
        '--quiet',
        '--instructions', $PromptPath
    )
    return Invoke-ProcessCaptured -FilePath $GooseBinary -Arguments $arguments `
        -WorkingDirectory $WorkingDirectory -TimeoutSeconds $TimeoutSeconds -Environment @{
            GOOSE_KEYRING_SERVICE = 'codebuddy'
            GOOSE_KEYRING_LEGACY_SERVICE = 'goose'
            GOOSE_MODE = 'auto'
            GOOSE_TELEMETRY_OFF = '1'
            PYTHONDONTWRITEBYTECODE = '1'
            NO_COLOR = '1'
        }
}

$fixtureSource = Join-Path $qualificationRoot ([string]$manifest.gates.g1.fixtureDirectory)
$fixtureHash = Get-DirectorySha256 $fixtureSource
if ($fixtureHash -ne [string]$manifest.gates.g1.fixtureSha256) {
    throw "Fixture hash mismatch. Expected $($manifest.gates.g1.fixtureSha256), got $fixtureHash"
}

$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$fixtureRoot = Join-Path $temporaryBase ("CodeBuddy-Qualification-" + [Guid]::NewGuid().ToString('N'))
$g0Prompt = Join-Path $qualificationRoot ([string]$manifest.gates.g0.prompt)
$g1Prompt = Join-Path $qualificationRoot ([string]$manifest.gates.g1.prompt)
$credentialBefore = [ordered]@{
    currentTargetPresent = Test-WindowsCredentialTarget -Target 'secrets.codebuddy'
    legacyTargetPresent = Test-WindowsCredentialTarget -Target 'secrets.goose'
}
$result = $null

try {
    [void](New-Item -ItemType Directory -Path $fixtureRoot)
    Get-ChildItem -LiteralPath $fixtureSource -Force | Copy-Item -Destination $fixtureRoot -Recurse -Force
    [void](Invoke-Git -WorkingDirectory $fixtureRoot -Arguments @('init', '--quiet'))
    [void](Invoke-Git -WorkingDirectory $fixtureRoot -Arguments @('add', '--all'))
    [void](Invoke-Git -WorkingDirectory $fixtureRoot -Arguments @(
        '-c', 'user.name=CodeBuddy Qualification',
        '-c', 'user.email=qualification@codebuddy.invalid',
        'commit', '--quiet', '-m', 'qualification fixture'
    ))
    $baselineTree = Invoke-Git -WorkingDirectory $fixtureRoot -Arguments @('rev-parse', 'HEAD^{tree}')

    $g0Attempts = @()
    for ($attempt = 1; $attempt -le [int]$manifest.gates.g0.repetitions; $attempt++) {
        $processResult = Invoke-GooseQualificationRun -PromptPath $g0Prompt `
            -WorkingDirectory $fixtureRoot -TimeoutSeconds ([int]$manifest.gates.g0.timeoutSeconds)
        $runOutput = Convert-GooseJson $processResult
        $assistantText = if ($null -eq $runOutput) { '' } else { Get-AssistantText $runOutput }
        $exactJson = $false
        try {
            $answer = $assistantText | ConvertFrom-Json -ErrorAction Stop
            $exactJson = $assistantText.StartsWith('{') -and $assistantText.EndsWith('}') -and
                [string]$answer.status -eq [string]$manifest.gates.g0.expected.status -and
                [int]$answer.sum -eq [int]$manifest.gates.g0.expected.sum
        }
        catch {
            $exactJson = $false
        }
        $passed = -not $processResult.TimedOut -and $processResult.ExitCode -eq 0 -and $exactJson
        $g0Attempts += [PSCustomObject]@{
            status = if ($passed) { 'PASS' } else { 'FAIL' }
            exitCode = $processResult.ExitCode
            durationMs = $processResult.DurationMs
            exactJson = $exactJson
            totalTokens = Get-TotalTokens $runOutput
            reason = if ($passed) { $null } elseif ($processResult.TimedOut) { 'Timed out.' } else { 'The response was not the required exact JSON object.' }
        }
        if (-not $passed) {
            break
        }
    }
    while (@($g0Attempts).Count -lt [int]$manifest.gates.g0.repetitions) {
        $g0Attempts += [PSCustomObject]@{ status = 'NOT_RUN'; reason = 'Stopped after the first failed repetition.' }
    }
    $g0Status = if (@($g0Attempts | Where-Object status -ne 'PASS').Count -eq 0) { 'PASS' } else { 'FAIL' }

    $g1Attempts = @()
    if ($g0Status -eq 'PASS') {
        for ($attempt = 1; $attempt -le [int]$manifest.gates.g1.repetitions; $attempt++) {
            $processResult = Invoke-GooseQualificationRun -PromptPath $g1Prompt `
                -WorkingDirectory $fixtureRoot -TimeoutSeconds ([int]$manifest.gates.g1.timeoutSeconds)
            $runOutput = Convert-GooseJson $processResult
            $assistantText = if ($null -eq $runOutput) { '' } else { Get-AssistantText $runOutput }
            $toolCalls = if ($null -eq $runOutput) { @() } else { @(Get-ToolCalls $runOutput) }
            $argumentsText = (@($toolCalls | ForEach-Object argumentsJson) -join "`n")
            $lineCommand = [regex]::IsMatch(
                $argumentsText,
                '(?is)(findstr.{0,500}/N|/N.{0,500}findstr|(?:^|[^a-z])rg(?:\.exe)?\b.{0,500}(?:--line-number|-n\b))'
            )
            $expectedEvidence = "\bsrc[\\/]pricing\.py:$([int]$manifest.gates.g1.expectedLine)\b"
            $reportedEvidence = [regex]::IsMatch($assistantText, $expectedEvidence)
            $maximumIdentical = Get-MaxConsecutiveIdenticalCalls $toolCalls
            # Qualification proof includes the equivalent of: git status --porcelain
            $statusText = Invoke-Git -WorkingDirectory $fixtureRoot -Arguments @('status', '--porcelain')
            $currentTree = Invoke-Git -WorkingDirectory $fixtureRoot -Arguments @('write-tree')
            # The .git directory is intentionally excluded from the content-integrity comparison below.
            $contentRoot = Join-Path $temporaryBase ("CodeBuddy-Qualification-Content-" + [Guid]::NewGuid().ToString('N'))
            try {
                [void](New-Item -ItemType Directory -Path $contentRoot)
                Get-ChildItem -LiteralPath $fixtureRoot -Force | Where-Object Name -ne '.git' |
                    Copy-Item -Destination $contentRoot -Recurse -Force
                $currentFixtureHash = Get-DirectorySha256 $contentRoot
            }
            finally {
                Remove-SafeQualificationDirectory -Path $contentRoot -TemporaryBase $temporaryBase
            }
            $filesystemChanged = $statusText.Length -ne 0 -or $currentTree -ne $baselineTree -or
                $currentFixtureHash -ne $fixtureHash
            $passed = -not $processResult.TimedOut -and $processResult.ExitCode -eq 0 -and
                $lineCommand -and $reportedEvidence -and -not $filesystemChanged -and
                $maximumIdentical -le [int]$manifest.gates.g1.maxConsecutiveIdenticalToolCalls
            $reason = if ($passed) {
                $null
            }
            elseif ($processResult.TimedOut) {
                'Timed out.'
            }
            elseif (-not $lineCommand) {
                'No line-numbered read-only command was observed.'
            }
            elseif (-not $reportedEvidence) {
                'The final answer did not contain the required path:line evidence.'
            }
            elseif ($filesystemChanged) {
                'The disposable fixture changed.'
            }
            else {
                'The tool repetition limit was exceeded or the process failed.'
            }
            $g1Attempts += [PSCustomObject]@{
                status = if ($passed) { 'PASS' } else { 'FAIL' }
                exitCode = $processResult.ExitCode
                durationMs = $processResult.DurationMs
                totalTokens = Get-TotalTokens $runOutput
                toolCallCount = @($toolCalls).Count
                maxConsecutiveIdenticalToolCalls = $maximumIdentical
                lineNumberedCommandObserved = $lineCommand
                reportedEvidence = $reportedEvidence
                filesystemChanged = $filesystemChanged
                reason = $reason
            }
            if (-not $passed) {
                break
            }
        }
    }
    while (@($g1Attempts).Count -lt [int]$manifest.gates.g1.repetitions) {
        $g1Attempts += [PSCustomObject]@{
            status = 'NOT_RUN'
            reason = if ($g0Status -eq 'PASS') {
                'Stopped after the first failed repetition.'
            }
            else {
                'G1 was not started because G0 failed.'
            }
        }
    }
    $g1Status = if (@($g1Attempts | Where-Object status -ne 'PASS').Count -eq 0) { 'PASS' } else { 'FAIL' }

    $sourceRevision = Invoke-Git -WorkingDirectory $repoRoot -Arguments @('rev-parse', 'HEAD')
    $sourceStatus = Invoke-Git -WorkingDirectory $repoRoot -Arguments @('status', '--porcelain')
    $credentialAfter = [ordered]@{
        currentTargetPresent = Test-WindowsCredentialTarget -Target 'secrets.codebuddy'
        legacyTargetPresent = Test-WindowsCredentialTarget -Target 'secrets.goose'
    }
    $credentialMigrationStatus = if ($null -eq $credentialAfter.currentTargetPresent -or
        $null -eq $credentialAfter.legacyTargetPresent) {
        'NOT_RUN'
    }
    elseif ($credentialAfter.currentTargetPresent -and
        (-not $credentialBefore.legacyTargetPresent -or $credentialAfter.legacyTargetPresent)) {
        'PASS'
    }
    else {
        'FAIL'
    }
    $result = [ordered]@{
        qualificationVersion = [string]$manifest.qualificationVersion
        recordedAt = [DateTimeOffset]::Now.ToString('o')
        provider = 'ollama_cloud'
        model = $Model
        status = if ($g0Status -eq 'PASS' -and $g1Status -eq 'PASS') { 'PASS' } else { 'FAIL' }
        sourceRevision = $sourceRevision
        sourceDirty = $sourceStatus.Length -ne 0
        binarySha256 = Get-FileSha256 $GooseBinary
        g0PromptSha256 = Get-FileSha256 $g0Prompt
        g1PromptSha256 = Get-FileSha256 $g1Prompt
        fixtureSha256 = $fixtureHash
        credentialMigration = [ordered]@{
            status = $credentialMigrationStatus
            before = $credentialBefore
            after = $credentialAfter
        }
        g0 = [ordered]@{ status = $g0Status; attempts = $g0Attempts }
        g1 = [ordered]@{ status = $g1Status; baselineGitTree = $baselineTree; attempts = $g1Attempts }
    }

    $outputDirectory = Split-Path -Parent $OutputPath
    if (-not (Test-Path -LiteralPath $outputDirectory)) {
        [void](New-Item -ItemType Directory -Path $outputDirectory)
    }
    $json = $result | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText($OutputPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-Output "Qualification $($result.status): ollama_cloud / $Model"
    Write-Output "Result: $OutputPath"
}
finally {
    if (-not $KeepFixture) {
        Remove-SafeQualificationDirectory -Path $fixtureRoot -TemporaryBase $temporaryBase
    }
}

if ($null -eq $result -or $result.status -ne 'PASS') {
    exit 1
}
