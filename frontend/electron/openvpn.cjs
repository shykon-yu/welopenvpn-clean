const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { inspectVpnNetwork, runPowerShell, waitForVpnNetwork } = require('./network.cjs')
const { ensureTapUdpFirewall } = require('./firewall.cjs')

const DEFAULT_HOST = '8.133.189.9'
const DEFAULT_PORT = 12001
const TAP_NAME = 'TAP-Windows Adapter V9'
const WEL_TAP_NAME = /^(?:WEL Virtual LAN|WEL TAP|TAP-Windows Adapter V9|OpenVPN TAP-Windows6|以太网|本地连接)(?: \d+)?$/i
const OPENVPN_READY = /Initialization Sequence Completed/i
const OPENVPN_PROGRESS = /(?:PUSH_REPLY|open_tun|tap-windows6 device \[.+?\] opened|Successful ARP Flush)/i
const CONNECT_TIMEOUT_MS = 45000
const CONNECT_MAX_ATTEMPTS = 4
const OPENVPN_DATA_CIPHERS = 'AES-256-GCM:AES-128-GCM:AES-256-CBC'
const OPENVPN_FALLBACK_CIPHER = 'AES-256-CBC'
const OPENVPN_REMOTE_CERT_EKU = 'TLS Web Server Authentication'
const APP_DATA_DIRECTORY = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'WELPlatform')
const LOG_DIRECTORY = path.join(APP_DATA_DIRECTORY, 'logs')
const TAP_STATE_PATH = path.join(APP_DATA_DIRECTORY, 'tap-adapter.json')
const INSTALLER_TAP_STATE_PATH = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'WELPlatform', 'tap-create.txt')
const MANAGEMENT_HOST = '127.0.0.1'
const MANAGEMENT_STOP_TIMEOUT_MS = 3000

let connection = null

function runtimeCandidates() {
  const resources = process.resourcesPath || ''
  return [
    path.join(resources, 'openvpn', 'bin', 'openvpn.exe'),
    path.join(resources, 'openvpn', 'openvpn.exe'),
    'C:\\Program Files\\WEL\\OpenVPN\\bin\\openvpn.exe',
    'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe',
  ]
}

function locateOpenVpn() {
  return runtimeCandidates().find((candidate) => fs.existsSync(candidate)) || null
}

function tapctlCandidates() {
  const openvpn = locateOpenVpn()
  return [
    openvpn ? path.join(path.dirname(openvpn), 'tapctl.exe') : '',
    path.join(process.resourcesPath || '', 'openvpn', 'bin', 'tapctl.exe'),
    path.join(__dirname, '..', 'resources', 'openvpn', 'bin', 'tapctl.exe'),
  ].filter(Boolean)
}

function locateTapctl() {
  return tapctlCandidates().find((candidate) => fs.existsSync(candidate)) || null
}

function parseTapctlList(output) {
  return String(output || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => {
      const match = line.match(/\{([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\}/i)
      if (!match) return null
      const name = line
        .slice((match.index || 0) + match[0].length)
        .trim()
        .replace(/^['"]|['"]$/g, '')
      return name ? { guid: `{${match[1]}}`, name } : null
    })
    .filter(Boolean)
}

function isWelTapAdapter(name) {
  const normalized = String(name || '').trim()
  return WEL_TAP_NAME.test(normalized)
}

function parseTapGuid(output) {
  const match = String(output || '').match(/\{([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\}/i)
  return match ? `{${match[1]}}`.toLowerCase() : null
}

function readRememberedTapGuid() {
  try {
    const installerGuid = parseTapGuid(fs.readFileSync(INSTALLER_TAP_STATE_PATH, 'utf8'))
    if (installerGuid) return installerGuid
  } catch {}
  try {
    const state = JSON.parse(fs.readFileSync(TAP_STATE_PATH, 'utf8'))
    return parseTapGuid(state.guid)
  } catch { return null }
}

function rememberTapAdapter(adapter) {
  try {
    fs.mkdirSync(APP_DATA_DIRECTORY, { recursive: true })
    fs.writeFileSync(TAP_STATE_PATH, JSON.stringify({ guid: adapter.guid, name: adapter.name }), 'utf8')
  } catch {
    // Remembering is an optimization; the current connection can still use
    // the adapter GUID returned by tapctl.
  }
}

async function ensureTapReady(adapter) {
  const enabledAdapter = await ensureTapEnabled(adapter)
  rememberTapAdapter(enabledAdapter)
  try { await ensureTapUdpFirewall(enabledAdapter.guid) } catch {}
  return { tapName: enabledAdapter.name, tapNode: enabledAdapter.guid, tapGuid: enabledAdapter.guid }
}

function selectWelTapAdapter(adapters) {
  const owned = adapters.filter(({ name }) => isWelTapAdapter(name))
  return owned.find(({ name }) => name.toLowerCase() === TAP_NAME.toLowerCase())
    || owned.find(({ name }) => name.toLowerCase() === 'wel tap')
    || owned.find(({ name }) => /^以太网(?: \d+)?$/i.test(name))
    || owned.find(({ name }) => /^本地连接(?: \d+)?$/i.test(name))
    || owned.sort((left, right) => {
      const leftNumber = Number(left.name.match(/(\d+)$/)?.[1] || 0)
      const rightNumber = Number(right.name.match(/(\d+)$/)?.[1] || 0)
      return rightNumber - leftNumber
    })[0]
    || null
}

function runTapctl(executable, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true })
    const output = []
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      reject(new Error(`tapctl ${args[0]} 执行超时`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => output.push(chunk))
    child.stderr.on('data', (chunk) => output.push(chunk))
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const detail = Buffer.concat(output).toString('utf8').trim()
      if (code === 0) resolve(detail)
      else reject(new Error(`tapctl ${args[0]} 失败（代码 ${code ?? '未知'}）${detail ? `：${detail}` : ''}`))
    })
  })
}

async function listTapAdapters(tapctl) {
  return parseTapctlList(await runTapctl(tapctl, ['list']))
}

async function ensureTapEnabled(adapter) {
  if (!adapter) return adapter
  const guid = adapter.guid
  const bareGuid = guid.replace(/[{}]/g, '')
  try {
    await runPowerShell(`
$guid = '${bareGuid}'
$adapter = Get-WmiObject Win32_NetworkAdapter -ErrorAction SilentlyContinue |
  Where-Object { $_.GUID -and $_.GUID.Trim('{}') -ieq $guid } |
  Select-Object -First 1
if ($null -eq $adapter) { exit 2 }
$enabled = $adapter.NetEnabled
if ($enabled -ne $true) {
  $result = $adapter.Enable()
  $returnValue = [int]$result.ReturnValue
  if (@(0, 1) -notcontains $returnValue) { exit 4 }
  Start-Sleep -Milliseconds 500
}
`, 6000)
    return adapter
  } catch {
    return adapter
  }
}

async function prepare() {
  const current = status()
  if (!current.ready) throw new Error(current.message)
  if (process.platform !== 'win32') return current

  const tapctl = locateTapctl()
  if (!tapctl) throw new Error('未检测到 WEL 虚拟网卡管理组件，请重新安装客户端')

  let adapters = await listTapAdapters(tapctl)
  const rememberedGuid = readRememberedTapGuid()
  let adapter = (rememberedGuid
    ? adapters.find(({ guid }) => guid.toLowerCase() === rememberedGuid)
    : null) || selectWelTapAdapter(adapters)
  if (adapter) {
    return { ...current, adapterReady: true, ...(await ensureTapReady(adapter)) }
  }

  const createOutput = await runTapctl(tapctl, ['create', '--hwid', 'root\\tap0901'], 20000)
  const createdGuid = parseTapGuid(createOutput)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    adapters = await listTapAdapters(tapctl)
    adapter = (createdGuid ? adapters.find(({ guid }) => guid.toLowerCase() === createdGuid) : null)
      || selectWelTapAdapter(adapters)
    if (adapter) {
      return { ...current, adapterReady: true, ...(await ensureTapReady(adapter)) }
    }
    await wait(500)
  }
  throw new Error('WEL 虚拟网卡创建后未被 Windows 识别，请重启电脑后重试')
}

function safeFilePart(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96)
}

function ensureRuntimeDirectory() {
  const directory = path.join(os.homedir(), 'AppData', 'Local', 'WELPlatform', 'runtime')
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

function ensureLogDirectory() {
  fs.mkdirSync(LOG_DIRECTORY, { recursive: true })
  return LOG_DIRECTORY
}

function recentOutput(output, limit = 2000) {
  return output.join('').replace(/\r?\n/g, '\n').trim().slice(-limit)
}

function readRecentLog(filePath, limit = 2000) {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').replace(/\r?\n/g, '\n').trim().slice(-limit) : ''
  } catch {
    return ''
  }
}

function openVpnConfigPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/')
}

function bundledCaPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'openvpn', 'ca.crt'),
    path.join(__dirname, '..', 'resources', 'openvpn', 'ca.crt'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

function buildConfig({ host, port, username, token, roomID, subnetCidr, tapNode = TAP_NAME }) {
  const caPath = bundledCaPath()
  if (!caPath) throw new Error('联机证书未随客户端安装，请重新安装 WEL职业联盟对战平台')
  const runtime = ensureRuntimeDirectory()
  const prefix = `room-${safeFilePart(roomID)}-${safeFilePart(username)}`
  const authPath = path.join(runtime, `${prefix}.auth`)
  const configPath = path.join(runtime, `${prefix}.ovpn`)
  const logPath = path.join(ensureLogDirectory(), `${prefix}.openvpn.log`)
  const managementPort = 25000 + (Number(roomID) % 1000)
  fs.writeFileSync(authPath, `${username}\r\n${token}\r\n`, { encoding: 'utf8', mode: 0o600 })
  fs.writeFileSync(logPath, '', { encoding: 'utf8' })
  const config = [
    'client',
    'dev-type tap',
    `dev-node "${tapNode}"`,
    'proto udp4',
    'explicit-exit-notify 1',
    `remote ${host} ${port}`,
    `management ${MANAGEMENT_HOST} ${managementPort}`,
    'nobind',
    'persist-key',
    'persist-tun',
    'ip-win32 netsh',
    'auth-nocache',
    `auth-user-pass "${openVpnConfigPath(authPath)}"`,
    `ca "${openVpnConfigPath(caPath)}"`,
    `remote-cert-eku "${OPENVPN_REMOTE_CERT_EKU}"`,
    `data-ciphers ${OPENVPN_DATA_CIPHERS}`,
    `data-ciphers-fallback ${OPENVPN_FALLBACK_CIPHER}`,
    `cipher ${OPENVPN_FALLBACK_CIPHER}`,
    'route-nopull',
    'pull-filter ignore redirect-gateway',
    'pull-filter ignore dhcp-option',
    'verb 3',
    `log "${openVpnConfigPath(logPath)}"`,
    `setenv WEL_ROOM_ID ${roomID}`,
    `setenv WEL_SUBNET ${subnetCidr}`,
  ].join('\r\n') + '\r\n'
  fs.writeFileSync(configPath, config, { encoding: 'utf8', mode: 0o600 })
  return { authPath, configPath, logPath, managementPort }
}

function removeFiles(files) {
  for (const file of files || []) {
    try { fs.rmSync(file, { force: true }) } catch { /* temporary credential cleanup */ }
  }
}

function waitForProcessExit(process, timeoutMs) {
  if (process.exitCode !== null || process.killed) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    process.once('close', () => {
      clearTimeout(timer)
      finish(true)
    })
  })
}

function sendManagementSignal(port, command) {
  return new Promise((resolve, reject) => {
    const net = require('node:net')
    let sent = false
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }
    const socket = net.createConnection({ host: MANAGEMENT_HOST, port }, () => {
      sent = true
      socket.write(`${command}\n`)
      socket.end()
    })
    socket.setTimeout(1500)
    socket.once('timeout', () => {
      socket.destroy()
      finish(new Error('management timeout'))
    })
    socket.once('error', (error) => {
      if (sent && ['ECONNRESET', 'EPIPE', 'ECONNABORTED'].includes(error.code)) finish()
      else finish(error)
    })
    socket.once('close', () => finish())
  })
}

async function stopConnection() {
  if (!connection) return
  const current = connection
  connection = null
  try {
    if (current.managementPort) {
      let exited = false
      try {
        await sendManagementSignal(current.managementPort, 'signal SIGTERM')
        exited = await waitForProcessExit(current.process, MANAGEMENT_STOP_TIMEOUT_MS)
      } catch {
        exited = false
      }
      if (!exited) try { current.process.kill() } catch {}
    } else {
      try { current.process.kill() } catch {}
    }
  } finally {
    removeFiles(current.temporaryFiles)
  }
}

function status() {
  const executable = locateOpenVpn()
  const caPath = bundledCaPath()
  const ready = Boolean(executable && caPath)
  return {
    ready,
    openvpnInstalled: Boolean(executable),
    tapName: TAP_NAME,
    message: ready
      ? '联机组件已准备好'
      : '未检测到 WEL 联机组件，请重新运行完整安装包。',
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableConnectError(error) {
  return /连接超时：未收到 OpenVPN 初始化完成信号|CreateFile failed on tap-windows6 device|Failed to open tap-windows6 adapter/i.test(String(error?.message || error || ''))
}

function isTapOpenError(error) {
  return /CreateFile failed on tap-windows6 device|Failed to open tap-windows6 adapter/i.test(String(error?.message || error || ''))
}

async function recreateWelTapAdapter(prepared) {
  if (process.platform !== 'win32' || !prepared?.tapGuid) return
  const tapctl = locateTapctl()
  if (!tapctl) return
  try { await runTapctl(tapctl, ['delete', prepared.tapGuid], 20000) } catch {}
  await wait(500)
}

async function stopStaleWelOpenVpnProcesses() {
  if (process.platform !== 'win32') return
  try {
    await runPowerShell(`
$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  $processes = @(Get-WmiObject Win32_Process -Filter "Name = 'openvpn.exe'" |
    Where-Object { $_.CommandLine -like '*WELPlatform*' })
  foreach ($process in $processes) { try { $process.Terminate() | Out-Null } catch {} }
  if ($processes.Count -eq 0) { exit 0 }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
exit 2
`, 5000)
  } catch {
    // Best effort only. A normal connection attempt can still proceed.
  }
}

async function connectAttempt({ executable, host, port, roomID, username, token, subnetCidr, tapNode }) {
  await stopConnection()
  const files = buildConfig({
    host: host || DEFAULT_HOST,
    port: Number(port) || DEFAULT_PORT,
    username,
    token,
    roomID,
    subnetCidr,
    tapNode,
  })
  const child = spawn(executable, ['--config', files.configPath], { windowsHide: true })
  const output = []
  let failed = ''
  let initialized = false
  child.stdout.on('data', (chunk) => output.push(chunk.toString()))
  child.stderr.on('data', (chunk) => output.push(chunk.toString()))
  child.once('error', (error) => { failed = error.message })
  child.once('close', (code) => {
    if (!initialized) failed = `OpenVPN 进程提前退出（代码 ${code ?? '未知'}）`
  })
  connection = { process: child, temporaryFiles: [files.authPath, files.configPath], logPath: files.logPath, managementPort: files.managementPort }

  try {
    const startedAt = Date.now()
    while (Date.now() - startedAt < CONNECT_TIMEOUT_MS) {
      if (failed) break
      const liveOutput = recentOutput(output)
      const fileOutput = readRecentLog(files.logPath)
      if (OPENVPN_READY.test(liveOutput) || OPENVPN_READY.test(fileOutput)) {
        initialized = true
        const network = await waitForVpnNetwork(subnetCidr, 8000)
        if (!network.connected) throw new Error(`OpenVPN 已连接，但未获取 ${subnetCidr} 的虚拟 IP`)
        return inspectVpnNetwork(subnetCidr)
      }
      if (OPENVPN_PROGRESS.test(liveOutput) || OPENVPN_PROGRESS.test(fileOutput)) {
        const network = await waitForVpnNetwork(subnetCidr, 8000)
        if (network.connected) {
          initialized = true
          return inspectVpnNetwork(subnetCidr)
        }
      }
      await wait(300)
    }
    const liveOutput = recentOutput(output)
    const fileOutput = readRecentLog(files.logPath)
    const reason = failed || '连接超时：未收到 OpenVPN 初始化完成信号'
    const detail = [reason, liveOutput || fileOutput].filter(Boolean).join('\n')
    throw new Error(`OpenVPN 连接失败：${detail || '连接超时'}\n日志文件：${files.logPath}`)
  } catch (error) {
    await stopConnection()
    throw error
  }
}

async function connect({ host, port, roomID, username, token, subnetCidr }) {
  const executable = locateOpenVpn()
  if (!executable) throw new Error('未检测到 OpenVPN 运行组件，请重新运行完整安装包')
  if (!token || !username || !roomID || !subnetCidr) throw new Error('OpenVPN 房间凭据不完整')

  await stopConnection()
  await stopStaleWelOpenVpnProcesses()
  await wait(500)
  let prepared = await prepare()

  let lastError = null
  for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await connectAttempt({ executable, host, port, roomID, username, token, subnetCidr, tapNode: prepared.tapNode })
    } catch (error) {
      lastError = error
      if (attempt >= CONNECT_MAX_ATTEMPTS || !isRetryableConnectError(error)) throw error
      if (isTapOpenError(error)) {
        await recreateWelTapAdapter(prepared)
        prepared = await prepare()
      }
      await wait(attempt * 1200)
    }
  }
  throw lastError
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  CONNECT_MAX_ATTEMPTS,
  CONNECT_TIMEOUT_MS,
  OPENVPN_DATA_CIPHERS,
  OPENVPN_FALLBACK_CIPHER,
  OPENVPN_PROGRESS,
  OPENVPN_REMOTE_CERT_EKU,
  TAP_NAME,
  connect,
  isWelTapAdapter,
  isRetryableConnectError,
  openVpnConfigPath,
  parseTapGuid,
  parseTapctlList,
  prepare,
  readRecentLog,
  selectWelTapAdapter,
  status,
  stopConnection,
}
