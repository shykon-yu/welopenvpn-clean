const test = require('node:test')
const assert = require('node:assert/strict')
const { analyzeNetwork, findNetstatLines, findRoomAddress, formatProcessExitCode, isIPv4InCIDR, parseAdapterOutput, parseTasklistPids, runElevatedPowerShell } = require('./network.cjs')

test('uses a hidden elevated PowerShell process for Windows firewall fallback', () => {
  assert.equal(typeof runElevatedPowerShell, 'function')
})

test('formats unsigned Windows crash exit codes as signed hexadecimal values', () => {
  assert.equal(formatProcessExitCode(4294967295), '-1 (0xFFFFFFFF)')
  assert.equal(formatProcessExitCode(5), '5')
})

test('matches only addresses in the room subnet', () => {
  assert.equal(isIPv4InCIDR('10.222.3.10', '10.222.3.0/24'), true)
  assert.equal(isIPv4InCIDR('10.222.4.10', '10.222.3.0/24'), false)
  assert.equal(isIPv4InCIDR('invalid', '10.222.3.0/24'), false)
})

test('finds the real room address from operating system interfaces', () => {
  const result = findRoomAddress('10.222.3.0/24', {
    Ethernet: [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
    VPN: [{ family: 'IPv4', address: '10.222.3.11', internal: false }],
  })
  assert.deepEqual(result, { name: 'VPN', address: '10.222.3.11' })
})

test('returns only the active room adapter details', () => {
  const status = analyzeNetwork('10.222.3.0/24', { name: 'VPN', address: '10.222.3.11' }, [
    {
      description: 'WEL TAP', ipEnabled: true,
      interfaceIndex: 18, interfaceMetric: 25,
      ipAddresses: ['10.222.3.11'], subnets: ['255.255.255.0'],
      defaultGateways: ['10.222.3.1'], dnsServers: ['10.222.3.1'],
    },
    {
      description: 'TAP-Windows Adapter V9', ipEnabled: true,
      interfaceIndex: 19, interfaceMetric: 1,
      ipAddresses: ['10.0.0.2'], subnets: ['255.255.255.0'],
      defaultGateways: [], dnsServers: [],
    },
    {
      description: 'Gateway NC Adapter', ipEnabled: true,
      interfaceIndex: 20, interfaceMetric: 5,
      ipAddresses: ['192.168.88.2'], subnets: ['255.255.255.0'],
      defaultGateways: [], dnsServers: [],
    },
  ])

  assert.equal(status.connected, true)
  assert.equal(status.actualIp, '10.222.3.11')
  assert.equal(status.interfaceIndex, 18)
  assert.equal(status.adapterName, 'VPN')
  assert.equal(status.adapterDescription, 'WEL TAP')
  assert.equal(status.macAddress, null)
})

test('parses base64 encoded PowerShell adapter fields', () => {
  const encode = (value) => Buffer.from(value, 'utf8').toString('base64')
  const output = `${encode('WEL TAP')}|True|18|25|${encode('10.222.1.10')}|${encode('255.255.255.0')}|||${encode('00:FF:12:34:56:78')}\n`
  const adapters = parseAdapterOutput(output)
  assert.equal(adapters.length, 1)
  assert.equal(adapters[0].description, 'WEL TAP')
  assert.equal(adapters[0].interfaceIndex, 18)
  assert.equal(adapters[0].interfaceMetric, 25)
  assert.deepEqual(adapters[0].defaultGateways, [])
  assert.equal(adapters[0].macAddress, '00:FF:12:34:56:78')
})

test('parses WE8 tasklist rows and matches netstat endpoints by PID', () => {
  const processes = parseTasklistPids([
    '"WE8.exe","3108","Console","1","42,000 K"',
    '"explorer.exe","1200","Console","1","80,000 K"',
    '"dpnsvr.exe","5520","Console","1","8,000 K"',
  ].join('\r\n'))
  assert.deepEqual(processes, [
    { name: 'WE8', pid: 3108 },
    { name: 'dpnsvr', pid: 5520 },
  ])

  const endpoints = findNetstatLines([
    '  UDP    0.0.0.0:5739           *:*                                    3108',
    '  UDP    0.0.0.0:49288          *:*                                    10908',
    '  TCP    10.222.1.13:2300        10.222.1.14:49820       ESTABLISHED     5520',
  ].join('\r\n'), processes)
  assert.equal(endpoints.length, 2)
  assert.match(endpoints[0], /5739/)
  assert.match(endpoints[1], /ESTABLISHED/)
})
