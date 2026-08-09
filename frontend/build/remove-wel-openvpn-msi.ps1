param(
  [Parameter(Mandatory = $true)]
  [string]$TapctlPath
)

$ErrorActionPreference = 'SilentlyContinue'
$programDataState = Join-Path $env:ProgramData 'WELPlatform'
$migrationMarker = Join-Path $programDataState 'tap-msi-2.5.10.ready'

if (-not (Test-Path -LiteralPath $migrationMarker)) {
  exit 0
}

$tapState = Join-Path $programDataState 'tap-create.txt'
if ((Test-Path -LiteralPath $TapctlPath) -and (Test-Path -LiteralPath $tapState)) {
  $match = [regex]::Match([IO.File]::ReadAllText($tapState), '\{[0-9A-Fa-f-]{36}\}')
  if ($match.Success) {
    & $TapctlPath delete $match.Value | Out-Null
  }
}

$uninstallRoots = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)

foreach ($root in $uninstallRoots) {
  Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
    $entry = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
    if ($entry.DisplayName -like 'OpenVPN 2.5.10-I601*' -and $_.PSChildName -match '^\{[0-9A-Fa-f-]{36}\}$') {
      $process = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" `
        -ArgumentList @('/x', $_.PSChildName, '/qn', '/norestart') `
        -WindowStyle Hidden -Wait -PassThru
      if ($null -eq $process -or @(0, 1605, 1641, 3010) -notcontains $process.ExitCode) {
        exit 3
      }
    }
  }
}

Remove-Item -LiteralPath $tapState -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $migrationMarker -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $env:LOCALAPPDATA 'WELPlatform\tap-adapter.json') -Force -ErrorAction SilentlyContinue
exit 0
