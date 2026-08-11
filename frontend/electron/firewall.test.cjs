const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildEdgeFirewallScript,
  buildRoomUdpFirewallScript,
  buildWe8FirewallScript,
  cidrToFirewallSubnet,
  LEGACY_WE8_RULES,
  EDGE_INBOUND_RULE,
  LEGACY_GAME_DISCOVERY_RULE,
  ROOM_ICMP_INBOUND_RULE,
  ROOM_ICMP_OUTBOUND_RULE,
  ROOM_UDP_INBOUND_RULE,
  ROOM_UDP_OUTBOUND_RULE,
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

test('allows room UDP and ICMPv4 traffic in both directions on the active WEL virtual subnet', () => {
  const script = buildRoomUdpFirewallScript('10.222.1.0/24')
  assert.match(script, new RegExp(ROOM_UDP_INBOUND_RULE))
  assert.match(script, new RegExp(ROOM_UDP_OUTBOUND_RULE))
  assert.match(script, new RegExp(ROOM_ICMP_INBOUND_RULE))
  assert.match(script, new RegExp(ROOM_ICMP_OUTBOUND_RULE))
  assert.match(script, new RegExp(LEGACY_GAME_DISCOVERY_RULE))
  assert.match(script, /Protocol = 17/)
  assert.match(script, /Protocol = 1/)
  assert.match(script, /\$rule\.Protocol = \$definition\.Protocol/)
  assert.match(script, /Direction = 1/)
  assert.match(script, /Direction = 2/)
  assert.match(script, /\$rule\.RemoteAddresses = '10\.222\.1\.0\/255\.255\.255\.0'/)
  assert.doesNotMatch(script, /LocalPorts|RemotePorts|ApplicationName/)
  assert.throws(() => buildRoomUdpFirewallScript('not-a-subnet'), /房间子网格式不正确/)
  assert.throws(() => buildRoomUdpFirewallScript('10.222.999.0/24'), /房间子网格式不正确/)
})

test('normalizes CIDR networks to the firewall subnet format supported by Windows 7', () => {
  assert.equal(cidrToFirewallSubnet('10.222.1.123/24'), '10.222.1.0/255.255.255.0')
  assert.equal(cidrToFirewallSubnet('10.222.1.10/32'), '10.222.1.10/255.255.255.255')
})

test('rejects an empty firewall program path', () => {
  assert.throws(() => buildWe8FirewallScript(''), /防火墙程序路径为空/)
})
