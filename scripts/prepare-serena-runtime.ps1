param([Parameter(Mandatory=$true)][string]$SourceDirectory)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$python = Join-Path $repo 'runtime/py/dependencies/python/python.exe'
$source = (Resolve-Path -LiteralPath $SourceDirectory).Path
if (!(Test-Path -LiteralPath (Join-Path $source 'src/serena/cli.py'))) { throw 'Expected the verified Serena source directory' }
$license = Get-Content -LiteralPath (Join-Path $source 'LICENSE') -Raw
if (!$license.StartsWith('MIT License')) { throw 'Expected MIT licensed source at revision 74c38a65f03fc0764d7ee4b3016ef6a07572ed64' }
& uv pip install --python $python --target (Join-Path $repo 'runtime/assets/serena') $source
if ($LASTEXITCODE -ne 0) { throw 'Serena dependency installation failed' }
