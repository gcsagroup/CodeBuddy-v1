param([switch]$OrdinaryChat, [switch]$SkipOptionalToolCheck)
$ErrorActionPreference = 'Stop'
$candidates = @()
if ($env:CODEBUDDY_NODE) { $candidates += $env:CODEBUDDY_NODE }
$installed = Get-Command node -ErrorAction SilentlyContinue
if ($installed) { $candidates += $installed.Source }
$codexRuntime = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node'
if (Test-Path -LiteralPath $codexRuntime) {
  $candidates += Get-ChildItem -LiteralPath $codexRuntime -Directory | ForEach-Object { Join-Path $_.FullName 'bin\node.exe' }
}
foreach ($candidate in ($candidates | Select-Object -Unique)) {
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  $version = & $candidate --version
  if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 24) {
    if ($OrdinaryChat) { $env:CODEPRO_UNIFIED_MODE = 'false' }
    $previewArguments = @()
    if ($SkipOptionalToolCheck) { $previewArguments += '--skip-optional-tool-check' }
    & $candidate (Join-Path $PSScriptRoot 'scripts\start-harness-preview.cjs') @previewArguments
    exit $LASTEXITCODE
  }
}
throw 'Node.js 24+ is required. Set CODEBUDDY_NODE to an existing Node 24+ executable and try again.'
