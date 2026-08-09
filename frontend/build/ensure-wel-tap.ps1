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

function Remove-NumberedWelTapAdapters {
  Get-TapAdapters |
    Where-Object {
      $_.NetConnectionID -match '^(WEL TAP|WEL Virtual LAN)( \d+)?$'
    } |
    ForEach-Object {
      if (-not [string]::IsNullOrEmpty($_.GUID)) {
        & $TapctlPath delete $_.GUID | Out-Null
      }
    }
}

# Keep the Windows-assigned connection name such as Ethernet/Local Area
# Connection. The client opens the adapter by GUID, so renaming is unnecessary.
Remove-NumberedWelTapAdapters
Start-Sleep -Milliseconds 500

$tapAdapters = @(Get-TapAdapters)
$singleTapAdapter = $tapAdapters | Select-Object -First 2
if ($singleTapAdapter.Count -eq 1) {
  exit 0
}

# Create one tap0901 adapter and keep the Windows-assigned connection name.
& $TapctlPath create --hwid 'root\tap0901' | Out-Null
$createExitCode = $LASTEXITCODE
if ($createExitCode -eq 0) {
  for ($attempt = 1; $attempt -le 20; $attempt++) {
    $tapAdapters = @(Get-TapAdapters)
    if ($tapAdapters.Count -eq 1) {
      exit 0
    }
    Start-Sleep -Milliseconds 500
  }
}

# Exit 3 tells the NSIS installer to install the official TAP-only MSI
# features, then run this adapter preparation step again.
exit 3
