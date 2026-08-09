param(
  [Parameter(Mandatory = $true)]
  [string]$StatePath,
  [switch]$Restore
)

$ErrorActionPreference = 'SilentlyContinue'

$roots = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)

if ($Restore) {
  if (Test-Path -LiteralPath $StatePath) {
    Get-Content -LiteralPath $StatePath | ForEach-Object {
      $key = $_.Trim()
      if ($key -and (Test-Path -LiteralPath $key)) {
        Remove-ItemProperty -LiteralPath $key -Name 'SystemComponent' -Force -ErrorAction SilentlyContinue
      }
    }
    Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
  }
  exit 0
}

$changed = @()
if (Test-Path -LiteralPath $StatePath) {
  $changed = @(Get-Content -LiteralPath $StatePath | Where-Object { $_.Trim() })
}
for ($attempt = 1; $attempt -le 15; $attempt++) {
  foreach ($root in $roots) {
    Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
      $key = $_.PSPath
      $entry = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
      $displayName = [string]$entry.DisplayName
      if ($displayName -match '(?i)TAP[- ]Windows') {
        $systemComponent = $entry.SystemComponent
        if ($null -eq $systemComponent -or [int]$systemComponent -ne 1) {
          New-ItemProperty -LiteralPath $key -Name 'SystemComponent' -PropertyType DWord -Value 1 -Force | Out-Null
          if ($changed -notcontains $key) { $changed += $key }
        }
      }
    }
  }
  if ($changed.Count -gt 0) { break }
  Start-Sleep -Milliseconds 500
}

$directory = Split-Path -Parent $StatePath
New-Item -ItemType Directory -Path $directory -Force | Out-Null
[IO.File]::WriteAllLines($StatePath, $changed)
exit 0
