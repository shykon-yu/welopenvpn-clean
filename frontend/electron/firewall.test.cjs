const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildEdgeFirewallScript,
  buildWe8FirewallScript,
  LEGACY_WE8_RULES,
  EDGE_INBOUND_RULE,
  WE8_INBOUND_RULE,
} = require('./firewall.cjs')

test('allows all inbound traffic for the selected WE8 executable', () => {
  const script = buildWe8FirewallScript('C:\\Games\\WE8.exe')
  assert.match(script, /C:\\Games\\WE8\.exe/)
  assert.match(script, new RegExp(WE8_INBOUND_RULE))
  assert.match(script, /\$rule\.Protocol = 256/)
  assert.match(script, /\$rule\.Direction = 1/)
  assert.doesNotMatch(script, /LocalPorts|RemotePorts|RemoteAddresses/)
  for (const rule of LEGACY_WE8_RULES) assert.match(script, new RegExp(rule))
})

test('allows all inbound traffic for the bundled n2n edge executable', () => {
  const script = buildEdgeFirewallScript('C:\\Program Files\\WEL\\resources\\welhelper\\edge.exe')
  assert.match(script, /edge\.exe/)
  assert.match(script, new RegExp(EDGE_INBOUND_RULE))
  assert.match(script, /\$rule\.Protocol = 256/)
  assert.match(script, /\$rule\.Direction = 1/)
})

test('rejects an empty firewall program path', () => {
  assert.throws(() => buildWe8FirewallScript(''), /防火墙程序路径为空/)
})
