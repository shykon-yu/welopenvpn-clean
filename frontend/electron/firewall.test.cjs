const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildWe8FirewallScript,
  LEGACY_WE8_RULES,
  WE8_GAME_IN_RULE,
  WE8_GAME_OUT_RULE,
  WE8_GAME_REPLY_IN_RULE,
  WE8_GAME_REPLY_OUT_RULE,
} = require('./firewall.cjs')

test('scopes WE8 firewall rules to the selected executable and UDP 5739', () => {
  const script = buildWe8FirewallScript('C:\\Games\\WE8.exe')
  assert.match(script, /C:\\Games\\WE8\.exe/)
  assert.match(script, /RemoteAddresses = '10\.222\.0\.0\/255\.255\.0\.0,255\.255\.255\.255'/)
  assert.match(script, new RegExp(WE8_GAME_IN_RULE))
  assert.match(script, new RegExp(WE8_GAME_OUT_RULE))
  assert.match(script, new RegExp(WE8_GAME_REPLY_IN_RULE))
  assert.match(script, new RegExp(WE8_GAME_REPLY_OUT_RULE))
  assert.match(script, /Add-WelWe8Rule 'WEL WE8 UDP 5739 Inbound' 1 '5739' \$null/)
  assert.match(script, /Add-WelWe8Rule 'WEL WE8 UDP 5739 Outbound' 2 \$null '5739'/)
  assert.match(script, /Add-WelWe8Rule 'WEL WE8 UDP 5739 Reply Inbound' 1 \$null '5739'/)
  assert.match(script, /Add-WelWe8Rule 'WEL WE8 UDP 5739 Reply Outbound' 2 '5739' \$null/)
  for (const rule of LEGACY_WE8_RULES) assert.match(script, new RegExp(rule))
})

test('rejects an empty WE8 path', () => {
  assert.throws(() => buildWe8FirewallScript(''), /WE8 程序路径为空/)
})
