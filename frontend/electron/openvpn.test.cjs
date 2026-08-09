const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { CONNECT_MAX_ATTEMPTS, CONNECT_TIMEOUT_MS, OPENVPN_DATA_CIPHERS, OPENVPN_FALLBACK_CIPHER, OPENVPN_PROGRESS, OPENVPN_REMOTE_CERT_EKU, isWelTapAdapter, isRetryableConnectError, openVpnConfigPath, parseTapGuid, parseTapctlList, parseWmiTapAdapters, readRecentLog, selectWelTapAdapter } = require('./openvpn.cjs')

test('uses OpenVPN-safe paths in generated config values', () => {
  assert.equal(
    openVpnConfigPath('C:\\Users\\Administrator\\AppData\\Local\\WELPlatform\\runtime\\room.auth'),
    'C:/Users/Administrator/AppData/Local/WELPlatform/runtime/room.auth',
  )
})

test('sends explicit exit notify to shrink stale UDP sessions on reconnect', () => {
  const client = fs.readFileSync(path.join(__dirname, 'openvpn.cjs'), 'utf8')
  assert.match(client, /'explicit-exit-notify 1'/)
})

test('configures the TAP address statically instead of using DHCP emulation', () => {
  const client = fs.readFileSync(path.join(__dirname, 'openvpn.cjs'), 'utf8')
  assert.match(client, /'ip-win32 netsh'/)
  assert.match(client, /'dev-type tap'/)
  assert.doesNotMatch(client, /'dev tap'/)
  assert.doesNotMatch(client, /'tun-mtu 1400'/)
  assert.doesNotMatch(client, /'mssfix 1360'/)
  assert.doesNotMatch(client, /clearArpCache/)
})

test('keeps client and server cipher settings aligned', () => {
  const generator = fs.readFileSync(path.join(__dirname, '..', '..', 'deploy', 'openvpn', 'generate-room-configs.sh'), 'utf8')
  assert.match(generator, new RegExp(`data-ciphers ${OPENVPN_DATA_CIPHERS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(generator, new RegExp(`data-ciphers-fallback ${OPENVPN_FALLBACK_CIPHER}`))
  assert.match(generator, new RegExp(`cipher ${OPENVPN_FALLBACK_CIPHER}`))
  assert.match(generator, /setenv WEL_ROOM_ID \$\{room_id\}/)
  assert.match(generator, /setenv WEL_API_BASE_URL \$\{api_base\}/)
})

test('checks server certificate EKU without requiring missing key usage extension', () => {
  const client = fs.readFileSync(path.join(__dirname, 'openvpn.cjs'), 'utf8')
  assert.match(client, new RegExp(`remote-cert-eku "\\$\\{OPENVPN_REMOTE_CERT_EKU\\}"`))
  assert.equal(OPENVPN_REMOTE_CERT_EKU, 'TLS Web Server Authentication')
  assert.doesNotMatch(client, /remote-cert-tls server/)
})

test('reads the latest openvpn log tail safely', () => {
  const tempPath = path.join(os.tmpdir(), `wel-openvpn-${Date.now()}.log`)
  fs.writeFileSync(tempPath, 'first line\r\nInitialization Sequence Completed\r\n', 'utf8')
  assert.match(readRecentLog(tempPath), /Initialization Sequence Completed/)
  fs.rmSync(tempPath, { force: true })
})

test('detects OpenVPN network configuration progress before final ready line', () => {
  assert.match('PUSH_REPLY,route-gateway 10.222.1.1,ifconfig 10.222.1.10 255.255.255.0', OPENVPN_PROGRESS)
  assert.match('tap-windows6 device [WEL TAP] opened', OPENVPN_PROGRESS)
  assert.doesNotMatch('UDPv4 link remote: [AF_INET]8.133.189.9:12001', OPENVPN_PROGRESS)
})

test('retries transient OpenVPN and TAP startup failures only', () => {
  assert.equal(CONNECT_TIMEOUT_MS, 45000)
  assert.equal(CONNECT_MAX_ATTEMPTS, 4)
  assert.equal(isRetryableConnectError(new Error('OpenVPN 连接失败：连接超时：未收到 OpenVPN 初始化完成信号')), true)
  assert.equal(isRetryableConnectError(new Error('CreateFile failed on tap-windows6 device')), true)
  assert.equal(isRetryableConnectError(new Error('Failed to open tap-windows6 adapter')), true)
  assert.equal(isRetryableConnectError(new Error('OpenVPN 进程提前退出（代码 1）')), false)
})

test('parses and reuses Windows-assigned WEL network connection names', () => {
  const adapters = parseTapctlList([
    '{11111111-2222-3333-4444-555555555555}\t以太网',
    '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}    "本地连接 17"',
    'No adapters found.',
  ].join('\r\n'))
  assert.deepEqual(adapters, [
    { guid: '{11111111-2222-3333-4444-555555555555}', name: '以太网' },
    { guid: '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}', name: '本地连接 17' },
  ])
  assert.equal(isWelTapAdapter('以太网'), true)
  assert.equal(isWelTapAdapter('本地连接 17'), true)
  assert.equal(isWelTapAdapter('WEL Virtual LAN'), true)
  assert.equal(isWelTapAdapter('WEL Virtual LAN 2'), true)
  assert.equal(isWelTapAdapter('Other TAP 17'), false)
  assert.equal(selectWelTapAdapter(adapters).name, '以太网')
  assert.equal(selectWelTapAdapter(adapters.slice(1)).name, '本地连接 17')
  assert.equal(selectWelTapAdapter([
    { guid: '{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}', name: 'WEL Virtual LAN 2' },
  ]).name, 'WEL Virtual LAN 2')
  assert.equal(parseTapGuid('Adapter {CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC} created'), '{cccccccc-cccc-cccc-cccc-cccccccccccc}')
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

test('opens the remembered TAP adapter by GUID to avoid localized names', () => {
  const client = fs.readFileSync(path.join(__dirname, 'openvpn.cjs'), 'utf8')
  assert.match(client, /`dev-node "\$\{tapNode\}"`/)
  assert.match(client, /tapNode: enabledAdapter\.guid/)
  assert.doesNotMatch(client, /tapNode: adapter\.name/)
  assert.doesNotMatch(client, /runTapctl\(tapctl, \['create'/)
  assert.match(client, /ensureTapEnabled/)
  assert.match(client, /ensureTapUdpFirewall\(enabledAdapter\.guid\)/)
  assert.match(client, /Win32_NetworkAdapter/)
  assert.match(client, /\.Enable\(\)/)
  assert.match(client, /recreateWelTapAdapter/)
  assert.match(client, /tapGuid: enabledAdapter\.guid/)
  assert.match(client, /readRememberedTapGuid\(\)/)
  assert.match(client, /INSTALLER_TAP_STATE_PATH/)
  assert.match(client, /listTapAdaptersFromWmi/)
  assert.match(client, /ServiceName -eq 'tap0901'/)
  assert.match(client, /stopStaleWelOpenVpnProcesses/)
  assert.match(client, /await wait\(500\)/)
  assert.doesNotMatch(client, /Set-ItemProperty -LiteralPath \$connectionKey -Name 'Name'/)
  assert.match(client, /await prepare\(\)/)
})
