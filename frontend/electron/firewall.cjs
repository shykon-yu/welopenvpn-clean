const { runPowerShell } = require('./network.cjs')

const EDGE_INBOUND_RULE = 'WEL n2n edge inbound'
const WE8_INBOUND_RULE = 'WEL WE8 inbound'
const ROOM_UDP_INBOUND_RULE = 'WEL room UDP inbound'
const ROOM_UDP_OUTBOUND_RULE = 'WEL room UDP outbound'
const ROOM_ICMP_INBOUND_RULE = 'WEL room ICMPv4 inbound'
const ROOM_ICMP_OUTBOUND_RULE = 'WEL room ICMPv4 outbound'
const LEGACY_GAME_DISCOVERY_RULE = 'WEL game discovery UDP 5739 inbound'
const LEGACY_WE8_RULES = [
  'WEL WE8 UDP 5739 Inbound',
  'WEL WE8 UDP 5739 Outbound',
  'WEL WE8 UDP 5739 Reply Inbound',
  'WEL WE8 UDP 5739 Reply Outbound',
  'WEL WE8 Broadcast Outbound',
  'WEL WE8 Game Broadcast Outbound',
  'WEL WE8 Game Inbound',
  'WEL WE8 Game Outbound',
]
const LEGACY_TAP_RULES = [
  'WEL TAP UDP Any Inbound',
  'WEL TAP UDP Any Outbound',
  'WEL TAP UDP Inbound',
  'WEL TAP UDP Outbound',
]

function escapePowerShellSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''")
}

function cidrToFirewallSubnet(subnetCidr) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/.exec(String(subnetCidr || '').trim())
  if (!match) throw new Error('WEL 房间子网格式不正确')

  const octets = match.slice(1, 5).map(Number)
  if (octets.some((octet) => octet > 255)) throw new Error('WEL 房间子网格式不正确')

  const prefixLength = Number(match[5])
  const mask = Array.from({ length: 4 }, (_, index) => {
    const remainingBits = Math.max(0, Math.min(8, prefixLength - index * 8))
    return remainingBits === 0 ? 0 : 256 - (2 ** (8 - remainingBits))
  })
  const network = octets.map((octet, index) => octet & mask[index])
  return `${network.join('.')}/${mask.join('.')}`
}

function buildProgramInboundFirewallScript(ruleName, description, programPath, legacyRuleNames = []) {
  const normalizedPath = String(programPath || '').trim()
  if (!normalizedPath) throw new Error('防火墙程序路径为空')

  const ruleNames = [ruleName, ...legacyRuleNames]
  const powershellRuleNames = ruleNames.map((name) => `'${escapePowerShellSingleQuoted(name)}'`).join(', ')

  return `
$ErrorActionPreference = 'Stop'
$programPath = '${escapePowerShellSingleQuoted(normalizedPath)}'
$policy = New-Object -ComObject HNetCfg.FwPolicy2
$ruleNames = @(${powershellRuleNames})
foreach ($ruleName in $ruleNames) {
  try { $policy.Rules.Remove($ruleName) } catch {}
}

$rule = New-Object -ComObject HNetCfg.FWRule
$rule.Name = '${escapePowerShellSingleQuoted(ruleName)}'
$rule.Description = '${escapePowerShellSingleQuoted(description)}'
$rule.ApplicationName = $programPath
$rule.Protocol = 256
$rule.Direction = 1
$rule.Action = 1
$rule.Enabled = $true
$rule.Profiles = 2147483647
$rule.InterfaceTypes = 'All'
$policy.Rules.Add($rule)
`
}

function buildEdgeFirewallScript(programPath) {
  return buildProgramInboundFirewallScript(
    EDGE_INBOUND_RULE,
    'Allow WEL n2n edge inbound traffic.',
    programPath,
    [...LEGACY_TAP_RULES],
  )
}

function buildWe8FirewallScript(programPath) {
  return buildProgramInboundFirewallScript(
    WE8_INBOUND_RULE,
    'Allow WEL WE8 inbound discovery and game traffic.',
    programPath,
    LEGACY_WE8_RULES,
  )
}

function buildRoomUdpFirewallScript(subnetCidr) {
  const subnet = cidrToFirewallSubnet(subnetCidr)
  return `
$ErrorActionPreference = 'Stop'
$policy = New-Object -ComObject HNetCfg.FwPolicy2
$ruleNames = @(
  '${LEGACY_GAME_DISCOVERY_RULE}',
  '${ROOM_UDP_INBOUND_RULE}',
  '${ROOM_UDP_OUTBOUND_RULE}',
  '${ROOM_ICMP_INBOUND_RULE}',
  '${ROOM_ICMP_OUTBOUND_RULE}'
)
foreach ($ruleName in $ruleNames) {
  try { $policy.Rules.Remove($ruleName) } catch {}
}

$ruleDefinitions = @(
  @{ Name = '${ROOM_UDP_INBOUND_RULE}'; Protocol = 17; Direction = 1; Description = 'Allow inbound UDP traffic from the active WEL virtual room subnet.' },
  @{ Name = '${ROOM_UDP_OUTBOUND_RULE}'; Protocol = 17; Direction = 2; Description = 'Allow outbound UDP traffic to the active WEL virtual room subnet.' },
  @{ Name = '${ROOM_ICMP_INBOUND_RULE}'; Protocol = 1; Direction = 1; Description = 'Allow inbound ICMPv4 traffic from the active WEL virtual room subnet.' },
  @{ Name = '${ROOM_ICMP_OUTBOUND_RULE}'; Protocol = 1; Direction = 2; Description = 'Allow outbound ICMPv4 traffic to the active WEL virtual room subnet.' }
)
foreach ($definition in $ruleDefinitions) {
  $rule = New-Object -ComObject HNetCfg.FWRule
  $rule.Name = $definition.Name
  $rule.Description = $definition.Description
  $rule.Protocol = $definition.Protocol
  $rule.RemoteAddresses = '${escapePowerShellSingleQuoted(subnet)}'
  $rule.Direction = $definition.Direction
  $rule.Action = 1
  $rule.Enabled = $true
  $rule.Profiles = 2147483647
  $rule.InterfaceTypes = 'All'
  $policy.Rules.Add($rule)
}
`
}

async function ensureEdgeFirewall(programPath) {
  if (process.platform !== 'win32') return false
  await runPowerShell(buildEdgeFirewallScript(programPath), 12000)
  return true
}

async function ensureWe8Firewall(programPath) {
  if (process.platform !== 'win32') return false
  await runPowerShell(buildWe8FirewallScript(programPath), 12000)
  return true
}

async function ensureRoomUdpFirewall(subnetCidr) {
  if (process.platform !== 'win32') return false
  await runPowerShell(buildRoomUdpFirewallScript(subnetCidr), 12000)
  return true
}

module.exports = {
  LEGACY_WE8_RULES,
  EDGE_INBOUND_RULE,
  LEGACY_GAME_DISCOVERY_RULE,
  ROOM_UDP_INBOUND_RULE,
  ROOM_UDP_OUTBOUND_RULE,
  ROOM_ICMP_INBOUND_RULE,
  ROOM_ICMP_OUTBOUND_RULE,
  WE8_INBOUND_RULE,
  buildEdgeFirewallScript,
  buildRoomUdpFirewallScript,
  buildWe8FirewallScript,
  buildProgramInboundFirewallScript,
  cidrToFirewallSubnet,
  ensureEdgeFirewall,
  ensureRoomUdpFirewall,
  ensureWe8Firewall,
}
