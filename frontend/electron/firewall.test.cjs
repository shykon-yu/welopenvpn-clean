const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  buildRoomFirewallArgs,
  buildWe8FirewallArgs,
  cidrToFirewallSubnet,
  FIREWALL_RULE_VERSION,
  firewallHelperCandidates,
  firewallHelperExitReason,
  firewallLogPath,
  WEL_ROOM_FIREWALL_SUBNET_CIDR,
} = require('./firewall.cjs')

test('normalizes room CIDR for netsh on Windows 7 through Windows 11', () => {
  assert.equal(cidrToFirewallSubnet('10.222.1.123/24'), '10.222.1.0/255.255.255.0')
  assert.equal(cidrToFirewallSubnet('10.222.1.10/32'), '10.222.1.10/255.255.255.255')
  assert.throws(() => cidrToFirewallSubnet('not-a-subnet'), /房间子网格式不正确/)
  assert.throws(() => cidrToFirewallSubnet('10.222.999.0/24'), /房间子网格式不正确/)
})

test('passes room and exact WE8 paths to the native firewall helper', () => {
  assert.deepEqual(buildRoomFirewallArgs('C:\\Program Files\\WEL\\edge.exe', '10.222.1.10/24'), [
    '--subnet', '10.222.1.0/255.255.255.0', '--edge', 'C:\\Program Files\\WEL\\edge.exe',
  ])
  assert.deepEqual(buildWe8FirewallArgs('D:\\Games\\WE8.exe'), ['--game', 'D:\\Games\\WE8.exe'])
  assert.throws(() => buildRoomFirewallArgs('', '10.222.1.0/24'), /组件路径为空/)
  assert.throws(() => buildWe8FirewallArgs(''), /程序路径为空/)
  assert.equal(WEL_ROOM_FIREWALL_SUBNET_CIDR, '10.222.0.0/16')
  assert.equal(FIREWALL_RULE_VERSION, 6)
})

test('uses the bundled native helper without requiring PowerShell', () => {
  const source = fs.readFileSync(path.join(__dirname, 'firewall.cjs'), 'utf8')
  assert.ok(firewallHelperCandidates().some((candidate) => candidate.endsWith('welfirewall.exe')))
  assert.doesNotMatch(source, /runPowerShell|EncodedCommand|HNetCfg/)
  assert.match(firewallHelperExitReason(10), /用户取消/)
  assert.match(firewallHelperExitReason(12), /规则写入失败/)
  assert.match(firewallHelperExitReason(21), /UDP 入站/)
  assert.match(firewallLogPath(), /WELPlatform[/\\]logs[/\\]firewall\.log$/)
  assert.match(source, /buildRoomFirewallArgs\(edgePath, WEL_ROOM_FIREWALL_SUBNET_CIDR\)/)
})

test('native helper repairs exact-path WE8 blocks and installs broad room rules', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'native', 'wel-firewall', 'wel_firewall.c'), 'utf8')
  assert.match(source, /ShellExecuteExW/)
  assert.match(source, /lpVerb = L"runas"/)
  assert.doesNotMatch(source, /is_process_elevated/)
  assert.match(source, /options\.elevated \? apply_rules\(&options\) : elevate_self\(&options\)/)
  assert.match(source, /netsh\.exe/)
  assert.match(source, /delete rule name=all dir=in program=/)
  assert.match(source, /WEL WE8 inbound/)
  assert.match(source, /protocol=any enable=yes profile=any/)
  assert.match(source, /WEL n2n edge inbound/)
  assert.match(source, /remoteip=%ls/)
  assert.match(source, /icmpv4:any,any/)
  assert.match(source, /WEL room UDP inbound/)
  assert.match(source, /WEL_FIREWALL_UDP_IN_FAILED/)
  assert.match(source, /append_netsh_log/)
  assert.match(source, /firewall\.log/)
  assert.match(source, /dotted_subnet_to_cidr/)
  assert.match(source, /10\.222\.0\.0\/255\.255\.0\.0/)
  assert.match(source, /10\.222\.0\.0\/16/)
  assert.match(source, /remoteip=%ls/)
  assert.match(source, /protocol=udp enable=yes profile=any/)
  assert.match(source, /protocol=UDP/)
  assert.match(source, /firewall add allowedprogram program=/)
  assert.match(source, /WEL n2n edge inbound/)
  assert.match(source, /WEL WE8 inbound/)
  assert.ok(
    source.indexOf('firewall add rule name=\\"WEL room UDP inbound') <
      source.indexOf('firewall add rule name=\\"WEL n2n edge inbound'),
  )
})
