const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { version: appVersion } = require('../package.json')
const { decodeProcessOutput, inspectVpnNetwork } = require('./network.cjs')
const { ensureWe8Firewall, isWindows7 } = require('./firewall.cjs')
const { launchGameBound } = require('./game-launch.cjs')
const openvpn = require('./openvpn.cjs')

if (process.platform === 'win32') {
  app.commandLine.appendSwitch('no-sandbox')
}

const API_URL = process.env.VITE_API_BASE_URL || 'http://8.155.145.132:8082/api/v1'
const LOG_DIRECTORY = path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'WELPlatform', 'logs')
const LOG_FILE = path.join(LOG_DIRECTORY, 'main.log')

let mainWindow = null
let tray = null
let isQuitting = false
let vpnShutdownComplete = false

function writeLog(message, error) {
  try {
    fs.mkdirSync(LOG_DIRECTORY, { recursive: true })
    const detail = error instanceof Error ? `${error.stack || error.message}` : String(error || '')
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}${detail ? `\r\n${detail}` : ''}\r\n`, 'utf8')
  } catch {
    // Logging must never prevent the application from starting.
  }
}

function showFatalError(error) {
  writeLog('应用发生致命错误', error)
  const detail = error instanceof Error ? error.message : String(error || '未知错误')
  dialog.showErrorBox('WRH对战平台启动失败', `${detail}\n\n错误日志：${LOG_FILE}`)
}

function frontendEntryPath() {
  const packagedEntry = path.join(process.resourcesPath, 'frontend', 'index.html')
  if (app.isPackaged && fs.existsSync(packagedEntry)) return packagedEntry
  return path.join(__dirname, '..', 'dist', 'index.html')
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180, height: 760, minWidth: 900, minHeight: 620,
    title: `WRH对战平台 v${appVersion}`,
    backgroundColor: '#f4f7f6',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  mainWindow.on('close', (event) => {
    if (isQuitting || process.platform !== 'win32') return
    event.preventDefault()
    mainWindow.hide()
  })
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeLog(`渲染进程退出：${details.reason}，代码 ${details.exitCode}`)
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    writeLog(`前端页面加载失败：${errorCode} ${errorDescription} ${validatedURL}`)
  })
  const entryPath = frontendEntryPath()
  const entryUrl = pathToFileURL(entryPath).toString()
  writeLog(`正在加载前端页面：${entryUrl}`)
  mainWindow.loadURL(entryUrl).catch((error) => {
    showFatalError(error)
    app.quit()
  })
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function trayIconPath() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'welhelper', 'wel.ico')]
    : [path.join(__dirname, '..', 'build', 'icon.ico')]
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

function createTray() {
  if (process.platform !== 'win32' || tray) return
  const iconPath = trayIconPath()
  if (!iconPath) {
    writeLog('未找到系统托盘图标')
    return
  }
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    writeLog(`系统托盘图标无法加载：${iconPath}`)
    return
  }
  tray = new Tray(icon)
  tray.setToolTip(`WRH对战平台 v${appVersion}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主界面', click: showMainWindow },
    { type: 'separator' },
    { label: '退出平台', click: () => { isQuitting = true; app.quit() } },
  ]))
  tray.on('double-click', showMainWindow)
}

function createChineseMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [{ role: 'reload', label: '重新载入' }, { type: 'separator' }, { role: 'quit', label: '退出' }] },
    { label: '编辑', submenu: [{ role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '查看', submenu: [{ role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' }] },
    { label: '帮助', submenu: [
      { label: '关于 WRH对战平台', click: () => dialog.showMessageBox({ type: 'info', title: '关于', message: `WRH对战平台 v${appVersion}` }) },
    ] },
  ]))
}

function resolveGameExecutable(gamePath) {
  const normalized = path.normalize(String(gamePath || '').trim().replace(/^"(.*)"$/, '$1'))
  if (!normalized || !fs.existsSync(normalized)) throw new Error('找不到 WE8 游戏程序')
  if (!fs.statSync(normalized).isFile() || path.extname(normalized).toLowerCase() !== '.exe') throw new Error('选择的 WE8 路径不是可执行文件')
  return normalized
}

function parsePingSummary(host, output) {
  const text = String(output || '').replace(/\r?\n/g, '\n')
  const reachable = /TTL=/i.test(text)
  const loss = text.match(/(\d+)%\s*(?:loss|丢失)/i)?.[1]
  const average = text.match(/(?:Average|平均)\s*[=<]\s*(\d+ms)/i)?.[1]
    || text.match(/平均\s*=\s*(\d+ms)/)?.[1]
  const parts = []
  if (reachable) parts.push('可达')
  else parts.push('不可达')
  if (average) parts.push(`平均 ${average}`)
  if (loss !== undefined) parts.push(`丢包 ${loss}%`)
  return { host, reachable, summary: parts.join('，') }
}

function pingHost(host) {
  const target = String(host || '').trim()
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(target)) throw new Error('Ping 地址不正确')
  const ping = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\ping.exe`
  return new Promise((resolve) => {
    const child = spawn(ping, ['-n', '4', '-w', '1000', target], { windowsHide: true })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.once('error', (error) => resolve({ host: target, reachable: false, summary: `Ping 失败：${error.message}` }))
    child.once('close', () => {
      const output = [decodeProcessOutput(stdout), decodeProcessOutput(stderr)].filter(Boolean).join('\n')
      resolve(parsePingSummary(target, output))
    })
  })
}

ipcMain.handle('openvpn-status', () => openvpn.status())
ipcMain.handle('prepare-openvpn', async () => {
  try {
    return await openvpn.prepare()
  } catch (error) {
    writeLog('准备联机组件失败', error)
    throw error
  }
})
ipcMain.handle('connect-openvpn', async (event, credentials) => {
  const requestFirewallAccess = async () => {
    const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: 'warning',
      title: '需要 Windows 防火墙授权',
      message: '进入房间需要允许 WEL 配置 Windows 防火墙规则。',
      detail: '点击“允许并进入”后，Windows 会显示权限确认。请选择“是”，平台将在规则写入成功后继续进入房间。',
      buttons: ['允许并进入', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (result.response !== 0) throw new Error('已取消 Windows 防火墙授权，无法进入房间')
  }
  return openvpn.connect({ ...credentials, requestFirewallAccess })
})
ipcMain.handle('disconnect-openvpn', () => openvpn.stopConnection())
ipcMain.handle('inspect-openvpn', (_event, { subnetCidr }) => inspectVpnNetwork(subnetCidr))
ipcMain.handle('ping-host', (_event, host) => pingHost(host))
ipcMain.handle('choose-game', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: '选择 WE8 游戏程序', properties: ['openFile'], filters: [{ name: 'WE8 游戏程序', extensions: ['exe'] }] })
  return result.canceled ? null : result.filePaths[0] || null
})
ipcMain.handle('launch-game', async (_event, gamePath) => {
  const executable = resolveGameExecutable(gamePath)
  const network = openvpn.activeNetwork()
  if (!network?.connected) throw new Error('请先进入房间并等待 WEL TAP 网卡连接完成')
  if (!isWindows7()) {
    try {
      await ensureWe8Firewall(executable)
    } catch (error) {
      writeLog('配置 WE8 防火墙规则失败', error)
    }
  }
  const result = await launchGameBound(executable, network)
  writeLog(`WE8 已通过 TAP Socket 绑定启动：${result}`)
})

process.on('uncaughtException', (error) => showFatalError(error))
process.on('unhandledRejection', (error) => showFatalError(error))

writeLog(`正在启动 WRH对战平台 v${appVersion}`)
app.whenReady()
  .then(() => {
    process.env.VITE_API_BASE_URL = API_URL
    createChineseMenu()
    createWindow()
    createTray()
    writeLog('主窗口已创建')
  })
  .catch((error) => {
    showFatalError(error)
    app.quit()
  })
app.on('before-quit', (event) => {
  isQuitting = true
  if (vpnShutdownComplete) return
  event.preventDefault()
  openvpn.stopConnection().finally(() => {
    vpnShutdownComplete = true
    app.quit()
  })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && isQuitting) app.quit() })
