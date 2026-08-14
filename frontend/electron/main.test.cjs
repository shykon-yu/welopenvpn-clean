const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const client = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')

test('hides the Windows window into the system tray when closed', () => {
  assert.match(client, /new Tray\(icon\)/)
  assert.match(client, /process\.platform !== 'win32'/)
  assert.match(client, /mainWindow\.hide\(\)/)
  assert.match(client, /tray\.setContextMenu\(Menu\.buildFromTemplate\(/)
  assert.match(client, /label: '打开主界面'/)
  assert.match(client, /label: '退出平台'/)
  assert.match(client, /tray\.on\('double-click', showMainWindow\)/)
})

test('packages a dedicated tray icon with the Windows client', () => {
  const packageJson = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  const iconMatch = packageJson.match(/"from": "build\/icon\.ico"[\s\S]*?"to": "welhelper\/([^"]+\.ico)"/)
  assert.ok(iconMatch, 'package.json 应打包 build/icon.ico 到 welhelper/<name>.ico')
  const iconName = iconMatch[1]
  // 托盘图标路径必须引用同一个资源名，避免改名后托盘失效
  assert.match(client, new RegExp(`welhelper[^\\n]*${iconName.replace(/\./g, '\\.')}`))
})

test('starts WE8 through the TAP socket-binding launcher only after room connection', () => {
  assert.match(client, /const \{ launchGameBound \} = require\('\.\/game-launch\.cjs'\)/)
  assert.match(client, /const network = openvpn\.activeNetwork\(\)/)
  assert.match(client, /请先进入房间并等待 WEL TAP 网卡连接完成/)
  assert.match(client, /await launchGameBound\(executable, network\)/)
  assert.doesNotMatch(client, /cmd\.exe'.*start/)
})

test('repairs WE8 firewall rules before launching the game on every Windows version', () => {
  assert.match(client, /const firewall = await ensureWe8Firewall\(executable\)/)
  assert.match(client, /ensureWe8Firewall\(executable\)[\s\S]*await launchGameBound\(executable, network\)/)
  assert.match(client, /firewall\.warnings[\s\S]*launch\.warnings/)
  assert.doesNotMatch(client, /if \(!isWindows7\(\)\)/)
})
