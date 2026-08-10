const { runPowerShell } = require('./network.cjs')

const EDGE_INBOUND_RULE = 'WEL n2n edge inbound'
const WE8_INBOUND_RULE = 'WEL WE8 inbound'
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

module.exports = {
  LEGACY_WE8_RULES,
  EDGE_INBOUND_RULE,
  WE8_INBOUND_RULE,
  buildEdgeFirewallScript,
  buildWe8FirewallScript,
  buildProgramInboundFirewallScript,
  ensureEdgeFirewall,
  ensureWe8Firewall,
}
