[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$')]
    [string]$Provider,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$')]
    [string]$Model,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$Reasoning,

    [Parameter(Mandatory = $true)]
    [string]$Observations,

    [Parameter(Mandatory = $true)]
    [string]$ArtifactOut,

    [Parameter(Mandatory = $true)]
    [string]$RegistryOut,

    [string]$CompilerBinary,

    [datetime]$EvaluatedAt = (Get-Date).ToUniversalTime(),

    [datetime]$ExpiresAt = (Get-Date).ToUniversalTime().AddDays(30)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$suite = Join-Path $repoRoot 'crates\goose\tests\fixtures\coordinator\v1\suite.json'
if (-not $CompilerBinary) {
    $CompilerBinary = Join-Path $repoRoot 'target\release\codepro_qualification_compiler.exe'
}
$CompilerBinary = [IO.Path]::GetFullPath($CompilerBinary)
$Observations = [IO.Path]::GetFullPath($Observations)
$ArtifactOut = [IO.Path]::GetFullPath($ArtifactOut)
$RegistryOut = [IO.Path]::GetFullPath($RegistryOut)

foreach ($inputPath in @($suite, $CompilerBinary, $Observations)) {
    if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) {
        throw "Required qualification input was not found: $inputPath"
    }
}
foreach ($outputPath in @($ArtifactOut, $RegistryOut)) {
    if (Test-Path -LiteralPath $outputPath) {
        throw "Refusing to overwrite qualification output: $outputPath"
    }
}
if ($ExpiresAt.ToUniversalTime() -le $EvaluatedAt.ToUniversalTime() -or
    $ExpiresAt.ToUniversalTime() -gt $EvaluatedAt.ToUniversalTime().AddDays(31)) {
    throw 'Qualification expiry must be after evaluation and no more than 31 days later.'
}

$arguments = @(
    '--suite', $suite,
    '--observations', $Observations,
    '--provider', $Provider,
    '--model', $Model,
    '--reasoning', $Reasoning,
    '--evaluated-at', $EvaluatedAt.ToUniversalTime().ToString('o'),
    '--expires-at', $ExpiresAt.ToUniversalTime().ToString('o'),
    '--artifact-out', $ArtifactOut,
    '--registry-out', $RegistryOut
)

& $CompilerBinary @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Qualification compiler failed with exit code $LASTEXITCODE"
}

