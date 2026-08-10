const { runPowerShell } = require('./network.cjs')

const WE8_GAME_IN_RULE = 'WEL WE8 UDP 5739 Inbound'
const WE8_GAME_OUT_RULE = 'WEL WE8 UDP 5739 Outbound'
const LEGACY_WE8_RULES = [
  'WEL WE8 Broadcast Outbound',
  'WEL WE8 Game Broadcast Outbound',
  'WEL WE8 Game Inbound',
  'WEL WE8 Game Outbound',
]

function escapePowerShellSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''")
}

function buildWe8FirewallScript(programPath) {
  const normalizedPath = String(programPath || '').trim()
  if (!normalizedPath) throw new Error('WE8 程序路径为空')

  const ruleNames = [WE8_GAME_IN_RULE, WE8_GAME_OUT_RULE, ...LEGACY_WE8_RULES]
  const powershellRuleNames = ruleNames.map((name) => `'${escapePowerShellSingleQuoted(name)}'`).join(', ')

  return `
$ErrorActionPreference = 'Stop'
$programPath = '${escapePowerShellSingleQuoted(normalizedPath)}'
$policy = New-Object -ComObject HNetCfg.FwPolicy2
$ruleNames = @(${powershellRuleNames})
foreach ($ruleName in $ruleNames) {
  try { $policy.Rules.Remove($ruleName) } catch {}
}

function Add-WelWe8Rule([string]$name, [int]$direction) {
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
  if ($direction -eq 1) {
    $rule.LocalPorts = '5739'
  } else {
    $rule.RemotePorts = '5739'
  }
  $policy.Rules.Add($rule)
}

Add-WelWe8Rule '${WE8_GAME_IN_RULE}' 1
Add-WelWe8Rule '${WE8_GAME_OUT_RULE}' 2
`
}

async function ensureWe8Firewall(programPath) {
  if (process.platform !== 'win32') return false
  await runPowerShell(buildWe8FirewallScript(programPath), 12000)
  return true
}

module.exports = {
  LEGACY_WE8_RULES,
  WE8_GAME_IN_RULE,
  WE8_GAME_OUT_RULE,
  buildWe8FirewallScript,
  ensureWe8Firewall,
}
