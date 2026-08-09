const test = require('node:test')
const assert = require('node:assert/strict')
const { TAP_UDP_IN_RULE, TAP_UDP_OUT_RULE, WE8_BROADCAST_OUT_RULE, buildTapUdpFirewallScript, buildWe8BroadcastFirewallScript, normalizeGuid } = require('./firewall.cjs')

test('normalizes TAP adapter GUIDs for firewall binding', () => {
  assert.equal(normalizeGuid('{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}'), 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')
  assert.equal(normalizeGuid('bad-guid'), '')
})

test('builds TAP-bound UDP firewall rules without changing network profile', () => {
  const script = buildTapUdpFirewallScript('{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}')
  assert.match(script, /Win32_NetworkAdapter/)
  assert.match(script, /NetConnectionID/)
  assert.match(script, new RegExp(TAP_UDP_IN_RULE))
  assert.match(script, new RegExp(TAP_UDP_OUT_RULE))
  assert.match(script, /\$rule\.Protocol = 17/)
  assert.match(script, /\$rule\.Profiles = 2147483647/)
  assert.match(script, /\$rule\.Interfaces = \[string\[\]\]@\(\$interfaceName\)/)
  assert.doesNotMatch(script, /Set-NetConnectionProfile/)
  assert.doesNotMatch(script, /metric=/)
})

test('rejects invalid TAP GUIDs', () => {
  assert.throws(() => buildTapUdpFirewallScript('not-a-guid'), /GUID 无效/)
})

test('builds a WE8 broadcast outbound firewall rule for limited broadcast', () => {
  const script = buildWe8BroadcastFirewallScript('D:\\WEL\\WE8.exe')
  assert.match(script, new RegExp(WE8_BROADCAST_OUT_RULE))
  assert.match(script, /\$rule\.ApplicationName = \$programPath/)
  assert.match(script, /\$rule\.Protocol = 17/)
  assert.match(script, /\$rule\.Direction = 2/)
  assert.match(script, /\$rule\.RemoteAddresses = '255\.255\.255\.255'/)
  assert.match(script, /Allow WE8 to send limited broadcast packets/)
})
