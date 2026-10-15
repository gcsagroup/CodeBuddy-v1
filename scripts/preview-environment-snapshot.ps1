param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
function Digest([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [Convert]::ToHexString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant() }
  finally { $sha.Dispose() }
}
$items = @()
foreach ($entry in @(
  @{Scope='User'; Path='Registry::HKEY_CURRENT_USER\Environment'},
  @{Scope='Machine'; Path='Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'}
)) {
  $key = Get-Item -LiteralPath $entry.Path
  foreach ($name in ($key.GetValueNames() | Sort-Object)) {
    $raw = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $items += [ordered]@{scope=$entry.Scope; name=$name; kind=[string]$key.GetValueKind($name); hash=(Digest ($raw | ConvertTo-Json -Compress))}
  }
}
$items += [ordered]@{scope='Process'; name='PATH'; kind='String'; hash=(Digest $env:PATH)}
foreach ($scheme in @('codebuddy','goose','codeagentpro')) {
  $location = "Registry::HKEY_CURRENT_USER\Software\Classes\$scheme"
  if (Test-Path -LiteralPath $location) {
    foreach ($key in @((Get-Item -LiteralPath $location)) + @(Get-ChildItem -LiteralPath $location -Recurse)) {
      foreach ($name in ($key.GetValueNames() | Sort-Object)) {
        $items += [ordered]@{scope='Protocol'; name="$($key.Name):$name"; kind=[string]$key.GetValueKind($name); hash=(Digest ([string]$key.GetValue($name)))}
      }
    }
  } else { $items += [ordered]@{scope='Protocol'; name=$scheme; kind='Absent'; hash=''} }
}
$parent = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$items | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Output "Saved environment fingerprints: $OutputPath"
