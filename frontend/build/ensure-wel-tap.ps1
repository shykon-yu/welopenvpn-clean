param(
  [Parameter(Mandatory = $true)]
  [string]$TapctlPath
)

$ErrorActionPreference = 'SilentlyContinue'

if (-not (Test-Path -LiteralPath $TapctlPath)) {
  exit 2
}

function Get-TapAdapters {
  @(Get-WmiObject -Class Win32_NetworkAdapter -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ServiceName -match '^(?i:tap0?(801|901))$' -or
      $_.PNPDeviceID -match '(?i)TAP0?(801|901)' -or
      $_.Name -match '(?i)TAP-Windows Adapter|OpenVPN TAP-Windows|WEL TAP'
    })
}

# Keep the Windows-assigned connection name such as Ethernet/Local Area
# Connection. The client opens the adapter by GUID, so renaming is unnecessary.
$tapAdapters = @(Get-TapAdapters)
if ($tapAdapters.Count -gt 0) {
  exit 0
}

# Exit 3 tells the NSIS installer to install the official TAP-only package and
# then re-check the adapter list. WEL itself no longer creates extra adapters.
exit 3
