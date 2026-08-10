const { runPowerShell } = require('./network.cjs')

const WE8_GAME_IN_RULE = 'WEL WE8 UDP 5739 Inbound'
const WE8_GAME_OUT_RULE = 'WEL WE8 UDP 5739 Outbound'
const WE8_GAME_REPLY_IN_RULE = 'WEL WE8 UDP 5739 Reply Inbound'
const WE8_GAME_REPLY_OUT_RULE = 'WEL WE8 UDP 5739 Reply Outbound'
const TAP_UDP_IN_RULE = 'WEL TAP UDP Any Inbound'
const TAP_UDP_OUT_RULE = 'WEL TAP UDP Any Outbound'
const LEGACY_WE8_RULES = [
  'WEL WE8 Broadcast Outbound',
  'WEL WE8 Game Broadcast Outbound',
  'WEL WE8 Game Inbound',
  'WEL WE8 Game Outbound',
]

function escapePowerShellSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''")
}

function ipv4ToNumber(value) {
  const parts = String(value || '').split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return parts.reduce((result, part) => ((result << 8) | part) >>> 0, 0)
}

function subnetMaskFromCidr(cidr) {
  const prefix = Number(String(cidr || '').split('/')[1])
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return [24, 16, 8, 0].map((shift) => (mask >>> shift) & 255).join('.')
}

function firewallAddressScope(cidr) {
  const [network] = String(cidr || '').trim().split('/')
  const mask = subnetMaskFromCidr(cidr)
  const networkNumber = ipv4ToNumber(network)
  const maskNumber = ipv4ToNumber(mask)
  if (networkNumber === null || maskNumber === null) throw new Error('WEL 网段地址无效')
  const normalizedNetwork = (networkNumber & maskNumber) >>> 0
  const address = [24, 16, 8, 0].map((shift) => (normalizedNetwork >>> shift) & 255).join('.')
  return `${address}/${mask},255.255.255.255`
}

function buildTapUdpFirewallScript(subnetCidr) {
  const addressScope = firewallAddressScope(subnetCidr)

  return `
$ErrorActionPreference = 'Stop'
$addressScope = '${escapePowerShellSingleQuoted(addressScope)}'
$policy = New-Object -ComObject HNetCfg.FwPolicy2
foreach ($ruleName in @('${TAP_UDP_IN_RULE}', '${TAP_UDP_OUT_RULE}', 'WEL TAP UDP Inbound', 'WEL TAP UDP Outbound')) {
  try { $policy.Rules.Remove($ruleName) } catch {}
}

function Add-WelTapUdpRule([string]$name, [int]$direction) {
  $rule = New-Object -ComObject HNetCfg.FWRule
  $rule.Name = $name
  $rule.Description = 'Allow UDP traffic on the WEL TAP interface.'
  $rule.Protocol = 17
  $rule.Direction = $direction
  $rule.Action = 1
  $rule.Enabled = $true
  $rule.Profiles = 2147483647
  $rule.InterfaceTypes = 'All'
  $rule.LocalAddresses = $addressScope
  $rule.RemoteAddresses = $addressScope
  $policy.Rules.Add($rule)
}

Add-WelTapUdpRule '${TAP_UDP_IN_RULE}' 1
Add-WelTapUdpRule '${TAP_UDP_OUT_RULE}' 2
`
}

async function ensureTapUdpFirewall(subnetCidr) {
  if (process.platform !== 'win32') return false
  await runPowerShell(buildTapUdpFirewallScript(subnetCidr), 12000)
  return true
}

function buildWe8FirewallScript(programPath) {
  const normalizedPath = String(programPath || '').trim()
  if (!normalizedPath) throw new Error('WE8 程序路径为空')

  const ruleNames = [
    WE8_GAME_IN_RULE,
    WE8_GAME_OUT_RULE,
    WE8_GAME_REPLY_IN_RULE,
    WE8_GAME_REPLY_OUT_RULE,
    ...LEGACY_WE8_RULES,
  ]
  const powershellRuleNames = ruleNames.map((name) => `'${escapePowerShellSingleQuoted(name)}'`).join(', ')

  return `
$ErrorActionPreference = 'Stop'
$programPath = '${escapePowerShellSingleQuoted(normalizedPath)}'
$policy = New-Object -ComObject HNetCfg.FwPolicy2
$ruleNames = @(${powershellRuleNames})
foreach ($ruleName in $ruleNames) {
  try { $policy.Rules.Remove($ruleName) } catch {}
}

function Add-WelWe8Rule([string]$name, [int]$direction, [string]$localPorts, [string]$remotePorts) {
  $rule = New-Object -ComObject HNetCfg.FWRule
  $rule.Name = $name
  $rule.Description = 'Allow WEL WE8 discovery and game UDP traffic only.'
  $rule.ApplicationName = $programPath
  $rule.Protocol = 17
  $rule.Direction = $direction
  $rule.Action = 1
  $rule.Enabled = $true
  $rule.Profiles = 2147483647
  $rule.InterfaceTypes = 'All'
  $rule.RemoteAddresses = '10.222.0.0/255.255.0.0,255.255.255.255'
  if ($localPorts) { $rule.LocalPorts = $localPorts }
  if ($remotePorts) { $rule.RemotePorts = $remotePorts }
  $policy.Rules.Add($rule)
}

Add-WelWe8Rule '${WE8_GAME_IN_RULE}' 1 '5739' $null
Add-WelWe8Rule '${WE8_GAME_OUT_RULE}' 2 $null '5739'
Add-WelWe8Rule '${WE8_GAME_REPLY_IN_RULE}' 1 $null '5739'
Add-WelWe8Rule '${WE8_GAME_REPLY_OUT_RULE}' 2 '5739' $null
`
}

async function ensureWe8Firewall(programPath) {
  if (process.platform !== 'win32') return false
  await runPowerShell(buildWe8FirewallScript(programPath), 12000)
  return true
}

module.exports = {
  LEGACY_WE8_RULES,
  TAP_UDP_IN_RULE,
  TAP_UDP_OUT_RULE,
  WE8_GAME_IN_RULE,
  WE8_GAME_OUT_RULE,
  WE8_GAME_REPLY_IN_RULE,
  WE8_GAME_REPLY_OUT_RULE,
  buildWe8FirewallScript,
  buildTapUdpFirewallScript,
  ensureTapUdpFirewall,
  ensureWe8Firewall,
}
