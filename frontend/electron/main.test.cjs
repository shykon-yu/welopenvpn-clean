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
  assert.match(packageJson, /"from": "build\/icon\.ico"[\s\S]*"to": "welhelper\/wel\.ico"/)
})
