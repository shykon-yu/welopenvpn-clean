$ErrorActionPreference = 'SilentlyContinue'

Get-Process -Name 'openvpn-gui' -ErrorAction SilentlyContinue | Stop-Process -Force

$startupFolders = @(
  [Environment]::GetFolderPath('Startup'),
  [Environment]::GetFolderPath('CommonStartup')
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

foreach ($folder in $startupFolders) {
  Remove-Item -LiteralPath (Join-Path $folder 'OpenVPN GUI.lnk') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $folder 'OpenVPN-GUI.lnk') -Force -ErrorAction SilentlyContinue
}

$runKeys = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'
)

foreach ($key in $runKeys) {
  foreach ($name in @('OpenVPN GUI', 'OpenVPN-GUI', 'OpenVPNGUI')) {
    Remove-ItemProperty -LiteralPath $key -Name $name -Force -ErrorAction SilentlyContinue
  }
}

Get-ScheduledTask -ErrorAction SilentlyContinue |
  Where-Object { $_.TaskName -match 'OpenVPN' -and ($_.TaskName -match 'GUI' -or $_.Actions.Execute -match 'openvpn-gui') } |
  ForEach-Object { Unregister-ScheduledTask -TaskName $_.TaskName -TaskPath $_.TaskPath -Confirm:$false -ErrorAction SilentlyContinue }

exit 0
