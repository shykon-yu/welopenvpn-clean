const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildBroadcastRouteScript,
  LIMITED_BROADCAST_ADDRESS,
  normalizeRouteTarget,
} = require('./broadcast-route.cjs')

test('binds the limited broadcast route to the active WEL TAP interface', () => {
  const script = buildBroadcastRouteScript('10.222.1.10', 8, 'add')
  assert.match(script, new RegExp(LIMITED_BROADCAST_ADDRESS.replaceAll('.', '\\.')))
  assert.match(script, /route\.exe'/)
  assert.match(script, /ADD \$destination MASK \$mask \$nextHop METRIC 1 IF \$interfaceIndex/)
  assert.match(script, /\$nextHop = '10\.222\.1\.10'/)
  assert.match(script, /\$interfaceIndex = 8/)
  assert.match(script, /Win32_IP4RouteTable/)
  assert.doesNotMatch(script, /0\.0\.0\.0|CHANGE|-p/)
})

test('removes only the exact WEL TAP broadcast route', () => {
  const script = buildBroadcastRouteScript('10.222.1.10', 8, 'remove')
  assert.match(script, /\$existingRoutes = @\(Get-WmiObject Win32_IP4RouteTable/)
  assert.match(script, /DELETE \$destination MASK \$mask \$existingNextHop IF \$interfaceIndex/)
  assert.match(script, /\$ErrorActionPreference = 'SilentlyContinue'/)
  assert.doesNotMatch(script, /ADD \$destination/)
})

test('rejects invalid broadcast route targets', () => {
  assert.deepEqual(normalizeRouteTarget('10.222.1.10', 8), { virtualIP: '10.222.1.10', interfaceIndex: 8 })
  assert.throws(() => normalizeRouteTarget('10.222.999.10', 8), /TAP IP/)
  assert.throws(() => normalizeRouteTarget('10.222.1.10', 0), /接口索引/)
  assert.throws(() => buildBroadcastRouteScript('10.222.1.10', 8, 'change'), /操作不正确/)
})
