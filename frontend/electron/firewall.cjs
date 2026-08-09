const { runPowerShell } = require('./network.cjs')

const TAP_UDP_IN_RULE = 'WEL TAP UDP Inbound'
const TAP_UDP_OUT_RULE = 'WEL TAP UDP Outbound'

function normalizeGuid(value) {
  const match = String(value || '').match(/\{?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\}?/i)
  return match ? match[1].toUpperCase() : ''
}

function escapePowerShellSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''")
}

function buildTapUdpFirewallScript(adapterGuid) {
  const guid = normalizeGuid(adapterGuid)
  if (!guid) throw new Error('TAP 网卡 GUID 无效')

  return `
$ErrorActionPreference = 'Stop'
$guid = '${escapePowerShellSingleQuoted(guid)}'
$adapter = Get-WmiObject Win32_NetworkAdapter -ErrorAction SilentlyContinue |
  Where-Object { $_.GUID -and $_.GUID.Trim('{}') -ieq $guid } |
  Select-Object -First 1
if ($null -eq $adapter -or [string]::IsNullOrWhiteSpace($adapter.NetConnectionID)) { exit 2 }

$interfaceName = [string]$adapter.NetConnectionID
$policy = New-Object -ComObject HNetCfg.FwPolicy2
$ruleNames = @('${TAP_UDP_IN_RULE}', '${TAP_UDP_OUT_RULE}')
foreach ($ruleName in $ruleNames) {
  try { $policy.Rules.Remove($ruleName) } catch {}
}

function Add-TapUdpRule([string]$name, [int]$direction) {
  $rule = New-Object -ComObject HNetCfg.FWRule
  $rule.Name = $name
  $rule.Description = 'Allow UDP traffic on the WEL OpenVPN TAP adapter.'
  $rule.Protocol = 17
  $rule.Direction = $direction
  $rule.Action = 1
  $rule.Enabled = $true
  $rule.Profiles = 2147483647
  $rule.InterfaceTypes = 'All'
  $rule.Interfaces = [string[]]@($interfaceName)
  $policy.Rules.Add($rule)
}

Add-TapUdpRule '${TAP_UDP_IN_RULE}' 1
Add-TapUdpRule '${TAP_UDP_OUT_RULE}' 2
`
}

async function ensureTapUdpFirewall(adapterGuid) {
  if (process.platform !== 'win32') return false
  await runPowerShell(buildTapUdpFirewallScript(adapterGuid), 12000)
  return true
}

module.exports = {
  TAP_UDP_IN_RULE,
  TAP_UDP_OUT_RULE,
  buildTapUdpFirewallScript,
  ensureTapUdpFirewall,
  normalizeGuid,
}
