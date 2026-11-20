param([Parameter(Mandatory=$true)][string]$SourceDirectory)
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'prepare-serena-runtime.cjs') $SourceDirectory uv
if ($LASTEXITCODE -ne 0) { throw 'Serena dependency installation failed' }
