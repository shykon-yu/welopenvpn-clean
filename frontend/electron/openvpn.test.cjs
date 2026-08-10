const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const {
  CONNECT_MAX_ATTEMPTS,
  CONNECT_TIMEOUT_MS,
  DEFAULT_PORT,
  N2N_PROGRESS,
  buildEdgeArgs,
  isWelTapAdapter,
  isRetryableConnectError,
  n2nCommunity,
  parseTapGuid,
  parseTapctlList,
  parseWmiTapAdapters,
  readRecentLog,
  selectWelTapAdapter,
  transportConfigPath,
} = require('./openvpn.cjs')

test('uses n2n-safe paths in generated runtime values', () => {
  assert.equal(
    transportConfigPath('C:\\Users\\Administrator\\AppData\\Local\\WELPlatform\\runtime\\room.n2n.txt'),
    'C:/Users/Administrator/AppData/Local/WELPlatform/runtime/room.n2n.txt',
  )
})

test('builds n2n edge arguments from backend-assigned room leases', () => {
  assert.equal(DEFAULT_PORT, 22222)
  assert.equal(n2nCommunity(1, ''), 'wel-room-1')
  assert.equal(n2nCommunity(1, 'wel-10.222.1.0-24'), 'wel-10.222.1.0-24')
  assert.deepEqual(buildEdgeArgs({
    host: 'game.example.test',
    port: 22222,
    roomID: 1,
    username: 'room-1-user-5',
    subnetCidr: '10.222.1.0/24',
    virtualIP: '10.222.1.10',
    community: 'wel-10.222.1.0-24',
    tapName: '{11111111-2222-3333-4444-555555555555}',
  }), [
    '-d', '{11111111-2222-3333-4444-555555555555}',
    '-E',
    '-c', 'wel-10.222.1.0-24',
    '-l', 'game.example.test:22222',
    '-a', '10.222.1.10/24',
    '-t', '5645',
    '-I', 'room-1-user-5',
  ])
})

test('does not generate OpenVPN client configuration while connecting', () => {
  const client = fs.readFileSync(path.join(__dirname, 'openvpn.cjs'), 'utf8')
  assert.match(client, /path\.join\(resources, 'welhelper', 'edge\.exe'\)/)
  assert.match(client, /'welhelper', 'weltap\.exe'/)
  assert.match(client, /installBundledTapDriver/)
  assert.match(client, /'-a', `\$\{virtualIP\}\/\$\{prefixFromCidr\(subnetCidr\)\}`/)
  assert.match(client, /'-d', tapName/)
  assert.match(client, /ensureEdgeFirewall\(executable\)/)
  assert.match(client, /stopStaleWelN2nProcesses/)
  assert.doesNotMatch(client, /'ip-win32 dynamic'/)
  assert.doesNotMatch(client, /'dev-type tap'/)
  assert.doesNotMatch(client, /route-nopull/)
  assert.doesNotMatch(client, /remote-cert-eku/)
})

test('reads the latest n2n log tail safely', () => {
  const tempPath = path.join(os.tmpdir(), `wel-n2n-${Date.now()}.log`)
  fs.writeFileSync(tempPath, 'first line\r\ncreated local tap device\r\n', 'utf8')
  assert.match(readRecentLog(tempPath), /created local tap device/)
  fs.rmSync(tempPath, { force: true })
})

test('detects n2n network setup progress', () => {
  assert.match('created local tap device', N2N_PROGRESS)
  assert.match('successfully joined edge community', N2N_PROGRESS)
  assert.match('supernode_connect completed', N2N_PROGRESS)
  assert.doesNotMatch('UDPv4 link remote: [AF_INET]8.133.189.9:12001', N2N_PROGRESS)
})

test('retries transient n2n and TAP startup failures only', () => {
  assert.equal(CONNECT_TIMEOUT_MS, 45000)
  assert.equal(CONNECT_MAX_ATTEMPTS, 4)
  assert.equal(isRetryableConnectError(new Error('n2n 连接失败：连接超时：未获取虚拟 IP')), true)
  assert.equal(isRetryableConnectError(new Error('CreateFile failed on tap-windows device')), true)
  assert.equal(isRetryableConnectError(new Error('Failed to open tap adapter')), true)
  assert.equal(isRetryableConnectError(new Error('n2n 进程提前退出（代码 1）')), false)
})

test('parses and reuses Windows-assigned WEL network connection names', () => {
  const adapters = parseTapctlList([
    '{11111111-2222-3333-4444-555555555555}\t以太网',
    '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}    "本地连接 17"',
    'No adapters found.',
  ].join('\r\n'))
  assert.deepEqual(adapters, [
    { guid: '{11111111-2222-3333-4444-555555555555}', name: '以太网' },
    { guid: '{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}', name: '本地连接 17' },
  ])
  assert.equal(isWelTapAdapter('以太网'), true)
  assert.equal(isWelTapAdapter('本地连接 17'), true)
  assert.equal(isWelTapAdapter('WEL Virtual LAN'), true)
  assert.equal(isWelTapAdapter('WEL Virtual LAN 2'), true)
  assert.equal(isWelTapAdapter('TAP-Windows Adapter V9 #2'), true)
  assert.equal(isWelTapAdapter('TAP-Windows Adapter V9 #3'), true)
  assert.equal(isWelTapAdapter('Other TAP 17'), false)
  assert.equal(selectWelTapAdapter(adapters).name, '以太网')
  assert.equal(selectWelTapAdapter(adapters.slice(1)).name, '本地连接 17')
  assert.equal(selectWelTapAdapter([
    { guid: '{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}', name: 'WEL Virtual LAN 2' },
  ]).name, 'WEL Virtual LAN 2')
  assert.equal(selectWelTapAdapter([
    { guid: '{DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD}', name: 'TAP-Windows Adapter V9 #3' },
  ]).name, 'TAP-Windows Adapter V9 #3')
  assert.equal(selectWelTapAdapter([
    { guid: '{EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE}', name: 'Ethernet 7' },
  ]).name, 'Ethernet 7')
  assert.equal(parseTapGuid('Adapter {CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC} created'), '{cccccccc-cccc-cccc-cccc-cccccccccccc}')
})

test('accepts a tapctl adapter when its display name is absent', () => {
  const guid = '{FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF}'
  assert.deepEqual(parseTapctlList(guid), [
    { guid: guid.toLowerCase(), name: 'TAP-Windows Adapter V9' },
  ])
})

test('falls back to WMI TAP adapters when tapctl cannot list Win7 devices', () => {
  const encode = (value) => Buffer.from(value, 'utf8').toString('base64')
  const adapters = parseWmiTapAdapters([
    `${encode('{11111111-2222-3333-4444-555555555555}')}|${encode('本地连接')}|${encode('TAP-Windows Adapter V9')}`,
    `${encode('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')}||${encode('TAP-Windows Adapter V9')}`,
  ].join('\r\n'))
  assert.deepEqual(adapters, [
    { guid: '{11111111-2222-3333-4444-555555555555}', name: '本地连接' },
    { guid: '{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}', name: 'TAP-Windows Adapter V9' },
  ])
})

test('opens the remembered TAP adapter without creating or deleting adapters', () => {
  const client = fs.readFileSync(path.join(__dirname, 'openvpn.cjs'), 'utf8')
  assert.match(client, /tapName: enabledAdapter\.name/)
  assert.match(client, /tapNode: enabledAdapter\.guid/)
  assert.doesNotMatch(client, /runTapctl\(tapctl, \['create'/)
  assert.doesNotMatch(client, /runTapctl\(tapctl, \['delete'/)
  assert.match(client, /ensureTapEnabled/)
  assert.match(client, /Win32_NetworkAdapter/)
  assert.match(client, /\.Enable\(\)/)
  assert.match(client, /tapGuid: enabledAdapter\.guid/)
  assert.match(client, /readRememberedTapGuid\(\)/)
  assert.match(client, /INSTALLER_TAP_STATE_PATH/)
  assert.match(client, /listTapAdaptersFromWmi/)
  assert.match(client, /ServiceName -match '[^']*tap0\?\(801\|901\)/)
  assert.match(client, /Name -match '[^']*TAP-Windows Adapter/)
  assert.match(client, /await prepare\(\)/)
})

test('green editions install TAP only when no enumerated TAP adapter exists', () => {
  const client = fs.readFileSync(path.join(__dirname, 'openvpn.cjs'), 'utf8')
  assert.match(client, /let adapters = await listTapAdapters\(tapctl\)/)
  assert.match(client, /if \(adapter\) \{\s*return \{ \.\.\.current, adapterReady: true/)
  assert.match(client, /const installer = locateTapInstaller\(\)/)
  assert.match(client, /await installBundledTapDriver\(installer\)/)
  assert.match(client, /find\(\(\{ guid \}\) => Boolean\(parseTapGuid\(guid\)\)\)/)
  assert.doesNotMatch(client, /const owned = adapters\.filter\(\(\{ name \}\)/)
  assert.doesNotMatch(client, /runTapctl\(tapctl, \['delete'/)
})
