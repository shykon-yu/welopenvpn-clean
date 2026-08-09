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
      $_.ServiceName -eq 'tap0901' -or
      $_.PNPDeviceID -match 'TAP0901'
    })
}

# Keep the Windows-assigned connection name such as Ethernet/Local Area
# Connection. The client opens the adapter by GUID, so renaming is unnecessary.
$tapAdapters = @(Get-TapAdapters)
$singleTapAdapter = $tapAdapters | Select-Object -First 2
if ($singleTapAdapter.Count -eq 1) {
  exit 0
}

# Exit 3 tells the NSIS installer to install the official TAP-only package and
# then re-check the adapter list. WEL itself no longer creates extra adapters.
exit 3
