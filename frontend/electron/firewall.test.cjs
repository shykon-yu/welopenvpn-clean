const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildWe8FirewallScript,
  LEGACY_WE8_RULES,
  WE8_GAME_IN_RULE,
  WE8_GAME_OUT_RULE,
} = require('./firewall.cjs')

test('scopes WE8 firewall rules to the selected executable and UDP 5739', () => {
  const script = buildWe8FirewallScript('C:\\Games\\WE8.exe')
  assert.match(script, /C:\\Games\\WE8\.exe/)
  assert.match(script, /RemoteAddresses = '10\.222\.0\.0\/255\.255\.0\.0,255\.255\.255\.255'/)
  assert.match(script, /LocalPorts = '5739'/)
  assert.match(script, /RemotePorts = '5739'/)
  assert.match(script, new RegExp(WE8_GAME_IN_RULE))
  assert.match(script, new RegExp(WE8_GAME_OUT_RULE))
  for (const rule of LEGACY_WE8_RULES) assert.match(script, new RegExp(rule))
})

test('rejects an empty WE8 path', () => {
  assert.throws(() => buildWe8FirewallScript(''), /WE8 程序路径为空/)
})
