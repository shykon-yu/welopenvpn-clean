param(
  [Parameter(Mandatory = $true)]
  [string]$TapctlPath,
  [Parameter(Mandatory = $true)]
  [string]$BeforeListPath
)

$ErrorActionPreference = 'SilentlyContinue'

if (-not (Test-Path -LiteralPath $TapctlPath)) {
  exit 2
}

function Get-TapGuids([string]$Text) {
  $result = @()
  foreach ($match in [regex]::Matches($Text, '\{[0-9A-Fa-f-]{36}\}')) {
    if ($result -notcontains $match.Value.ToLowerInvariant()) {
      $result += $match.Value.ToLowerInvariant()
    }
  }
  return @($result)
}

$beforeText = ''
if (Test-Path -LiteralPath $BeforeListPath) {
  $beforeText = [IO.File]::ReadAllText($BeforeListPath)
}
$beforeGuids = @(Get-TapGuids $beforeText)
$selectedGuid = $null

for ($attempt = 1; $attempt -le 30; $attempt++) {
  $afterText = (& $TapctlPath list 2>&1 | Out-String)
  $afterGuids = @(Get-TapGuids $afterText)
  foreach ($guid in $afterGuids) {
    if ($beforeGuids -notcontains $guid) {
      $selectedGuid = $guid
      break
    }
  }
  if ($null -ne $selectedGuid) { break }
  if ($beforeGuids.Count -eq 0 -and $afterGuids.Count -eq 1) {
    $selectedGuid = $afterGuids[0]
    break
  }
  Start-Sleep -Milliseconds 1000
}

if ($null -eq $selectedGuid) {
  exit 3
}

$stateDirectory = Join-Path $env:ProgramData 'WELPlatform'
$statePath = Join-Path $stateDirectory 'tap-create.txt'
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
[IO.File]::WriteAllText($statePath, $selectedGuid)
Remove-Item -LiteralPath (Join-Path $env:LOCALAPPDATA 'WELPlatform\tap-adapter.json') -Force -ErrorAction SilentlyContinue
exit 0
