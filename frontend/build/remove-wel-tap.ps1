param(
  [Parameter(Mandatory = $true)]
  [string]$TapctlPath
)

$ErrorActionPreference = 'SilentlyContinue'

if (-not (Test-Path -LiteralPath $TapctlPath)) {
  exit 0
}

$statePath = Join-Path $env:ProgramData 'WELPlatform\tap-create.txt'

$rememberedGuid = $null
if (Test-Path -LiteralPath $statePath) {
  $stateText = [IO.File]::ReadAllText($statePath)
  $match = [regex]::Match($stateText, '\{[0-9A-Fa-f-]{36}\}')
  if ($match.Success) {
    $rememberedGuid = $match.Value
  }
}

if ($rememberedGuid) {
  & $TapctlPath delete $rememberedGuid | Out-Null
}

$names = @('WEL TAP', 'WEL Virtual LAN')
for ($i = 2; $i -le 50; $i++) {
  $names += "WEL TAP $i"
}

foreach ($name in $names) {
  & $TapctlPath delete $name | Out-Null
}

Start-Sleep -Seconds 1
Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $env:LOCALAPPDATA 'WELPlatform\tap-adapter.json') -Force -ErrorAction SilentlyContinue

exit 0
