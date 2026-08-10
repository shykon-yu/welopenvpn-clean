const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { inspectVpnNetwork, runPowerShell, waitForVpnNetwork } = require('./network.cjs')
const { ensureEdgeFirewall } = require('./firewall.cjs')

const DEFAULT_HOST = '8.133.189.9'
const DEFAULT_PORT = 22222
const TAP_NAME = 'TAP-Windows Adapter V9'
const WEL_TAP_NAME = /^(?:WEL Virtual LAN|WEL TAP|TAP-Windows Adapter V9|OpenVPN TAP-Windows6|以太网|本地连接)(?: \d+| #\d+)?$/i
const N2N_PROGRESS = /(?:supernode|register|edge|tuntap|wintap|tap|peer|packet|created local tap|successfully joined)/i
const CONNECT_TIMEOUT_MS = 45000
const CONNECT_MAX_ATTEMPTS = 4
const APP_DATA_DIRECTORY = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'WELPlatform')
const LOG_DIRECTORY = path.join(APP_DATA_DIRECTORY, 'logs')
const TAP_STATE_PATH = path.join(APP_DATA_DIRECTORY, 'tap-adapter.json')
const INSTALLER_TAP_STATE_PATH = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'WELPlatform', 'tap-create.txt')
const STOP_TIMEOUT_MS = 3000

let connection = null
let preparedTap = null

function runtimeCandidates() {
  const resources = process.resourcesPath || ''
  return [
    path.join(resources, 'welhelper', 'edge.exe'),
    path.join(__dirname, '..', 'resources', 'welhelper', 'edge.exe'),
    'C:\\Program Files\\WEL\\welhelper\\edge.exe',
  ]
}

function locateEdge() {
  return runtimeCandidates().find((candidate) => fs.existsSync(candidate)) || null
}

function tapInstallerCandidates() {
  return [
    path.join(process.resourcesPath || '', 'welhelper', 'weltap.exe'),
    path.join(__dirname, '..', 'resources', 'welhelper', 'weltap.exe'),
  ].filter(Boolean)
}

function locateTapInstaller() {
  return tapInstallerCandidates().find((candidate) => fs.existsSync(candidate)) || null
}

function tapctlCandidates() {
  return [
    path.join(process.resourcesPath || '', 'welhelper', 'tapctl.exe'),
    path.join(__dirname, '..', 'resources', 'welhelper', 'tapctl.exe'),
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
      // tapctl enumerates TAP devices. The GUID is authoritative; a missing
      // or localized connection name must not make an existing device look
      // absent and trigger another driver installation.
      // Keep the registry's original casing because n2n 3.0 compares the
      // Windows adapter ID with strcmp() when opening the device.
      return { guid: `{${match[1]}}`, name: name || TAP_NAME }
    })
    .filter(Boolean)
}

function decodeBase64Field(value) {
  if (!value) return ''
  try {
    return Buffer.from(String(value), 'base64').toString('utf8')
  } catch {
    return ''
  }
}

function parseWmiTapAdapters(output) {
  return String(output || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => {
      const fields = line.trim().split('|')
      if (fields.length < 3) return null
      const guid = decodeBase64Field(fields[0]).trim()
      const name = decodeBase64Field(fields[1]).trim() || decodeBase64Field(fields[2]).trim()
      if (!guid) return null
      const exactGuid = extractTapGuid(`{${guid.replace(/[{}]/g, '')}}`)
      if (!exactGuid) return null
      return { guid: exactGuid, name: name || TAP_NAME }
    })
    .filter(Boolean)
}

function isWelTapAdapter(name) {
  const normalized = String(name || '').trim()
  return WEL_TAP_NAME.test(normalized)
}

function extractTapGuid(output) {
  const match = String(output || '').match(/\{([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\}/i)
  return match ? `{${match[1]}}` : null
}

function parseTapGuid(output) {
  return extractTapGuid(output)?.toLowerCase() || null
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
  preparedTap = { tapName: enabledAdapter.name, tapNode: enabledAdapter.guid, tapGuid: enabledAdapter.guid }
  return preparedTap
}

function selectWelTapAdapter(adapters) {
  return (adapters || []).find(({ guid }) => Boolean(parseTapGuid(guid))) || null
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
  try {
    const adapters = parseTapctlList(await runTapctl(tapctl, ['list']))
    if (adapters.length > 0) return adapters
  } catch {
    // Win7 can have a healthy TAP driver while tapctl cannot enumerate it.
  }
  return listTapAdaptersFromWmi()
}

async function listTapAdaptersFromWmi() {
  const output = await runPowerShell(`
function Encode-Value($value) {
  if ($null -eq $value) { return '' }
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value))
}

Get-WmiObject -Class Win32_NetworkAdapter -ErrorAction SilentlyContinue |
  Where-Object {
    $_.GUID -and (
      $_.ServiceName -match '^(?i:tap0?(801|901))$' -or
      $_.PNPDeviceID -match '(?i)TAP0?(801|901)' -or
      $_.Name -match '(?i)TAP-Windows Adapter|OpenVPN TAP-Windows|WEL TAP'
    )
  } |
  ForEach-Object {
    [Console]::Out.WriteLine(
      (Encode-Value $_.GUID) + '|' +
      (Encode-Value $_.NetConnectionID) + '|' +
      (Encode-Value $_.Name)
    )
  }
`, 8000)
  return parseWmiTapAdapters(output)
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
  if (preparedTap?.tapNode) {
    return { ...current, adapterReady: true, ...preparedTap }
  }

  const tapctl = locateTapctl()
  if (!tapctl) throw new Error('未检测到 WEL 虚拟网卡管理组件，请重新安装客户端')

  let adapters = await listTapAdapters(tapctl)
  const rememberedGuid = readRememberedTapGuid()
  const adapter = (rememberedGuid
    ? adapters.find(({ guid }) => guid.toLowerCase() === rememberedGuid)
    : null) || selectWelTapAdapter(adapters)
  if (adapter) {
    return { ...current, adapterReady: true, ...(await ensureTapReady(adapter)) }
  }

  const installer = locateTapInstaller()
  if (!installer) throw new Error('未找到 TAP 虚拟网卡，且绿色版缺少 TAP 驱动安装文件')

  await installBundledTapDriver(installer)
  adapters = await waitForTapAdapter(tapctl)
  const installedAdapter = selectWelTapAdapter(adapters)
  if (!installedAdapter) throw new Error('TAP 虚拟网卡驱动安装后仍未检测到网卡，请重启 Windows 后重试')
  return { ...current, adapterReady: true, ...(await ensureTapReady(installedAdapter)) }
}

function installBundledTapDriver(installer) {
  return new Promise((resolve, reject) => {
    const child = spawn(installer, ['/S'], { windowsHide: true })
    child.once('error', reject)
    child.once('close', (code) => {
      if ([0, 1641, 3010].includes(Number(code))) resolve()
      else reject(new Error(`TAP 虚拟网卡驱动安装失败（代码 ${code ?? '未知'}）`))
    })
  })
}

async function waitForTapAdapter(tapctl) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const adapters = await listTapAdapters(tapctl)
    if (adapters.length > 0) return adapters
    await wait(500)
  }
  return []
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

function transportConfigPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/')
}

function subnetMaskFromCidr(cidr) {
  const prefix = Number(String(cidr || '').split('/')[1])
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return '255.255.255.0'
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return [24, 16, 8, 0].map((shift) => (mask >>> shift) & 255).join('.')
}

function prefixFromCidr(cidr) {
  const prefix = Number(String(cidr || '').split('/')[1])
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return 24
  return prefix
}

function buildConfig({ host, port, username, roomID, subnetCidr, virtualIP, community, transportKey, tapName }) {
  const runtime = ensureRuntimeDirectory()
  const prefix = `room-${safeFilePart(roomID)}-${safeFilePart(username)}`
  const configPath = path.join(runtime, `${prefix}.n2n.txt`)
  const logPath = path.join(ensureLogDirectory(), `${prefix}.n2n.log`)
  fs.writeFileSync(logPath, '', { encoding: 'utf8' })
  const config = [
    `community=${community}`,
    `supernode=${host}:${port}`,
    `virtual_ip=${virtualIP}`,
    `netmask=${subnetMaskFromCidr(subnetCidr)}`,
    `tap_name=${tapName || ''}`,
    `identity=${username}`,
    `room_id=${roomID}`,
  ].join('\r\n') + '\r\n'
  fs.writeFileSync(configPath, config, { encoding: 'utf8', mode: 0o600 })
  return { configPath, logPath, community, transportKey }
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

async function stopConnection() {
  if (!connection) return
  const current = connection
  connection = null
  try {
    try { current.process.kill() } catch {}
    const exited = await waitForProcessExit(current.process, STOP_TIMEOUT_MS)
    if (!exited) try { current.process.kill('SIGKILL') } catch {}
  } finally {
    removeFiles(current.temporaryFiles)
  }
}

function status() {
  const executable = locateEdge()
  const tapctl = locateTapctl()
  const ready = Boolean(executable && tapctl)
  return {
    ready,
    openvpnInstalled: Boolean(executable),
    n2nInstalled: Boolean(executable),
    tapName: TAP_NAME,
    message: ready
      ? '联机组件已准备好'
      : '未检测到 n2n 联机组件，请重新运行完整安装包。',
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableConnectError(error) {
  return /连接超时：未获取虚拟 IP|TAP|adapter|网卡|CreateFile|DeviceIoControl/i.test(String(error?.message || error || ''))
}

async function stopStaleWelN2nProcesses() {
  if (process.platform !== 'win32') return
  try {
    await runPowerShell(`
$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  $processes = @(Get-WmiObject Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
    ($_.Name -ieq 'edge.exe') -and
      ($_.CommandLine -like '*wel-room-*' -or $_.CommandLine -like '*WELPlatform*')
    })
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

function n2nCommunity(roomID, community) {
  const value = String(community || '').trim()
  return value || `wel-room-${roomID}`
}

function buildEdgeArgs({ host, port, roomID, username, subnetCidr, virtualIP, community, transportKey, tapName }) {
  if (!virtualIP) throw new Error('n2n 房间虚拟 IP 未分配，请重新进入房间')
  const args = [
    '-E',
    '-S1',
    '-c', n2nCommunity(roomID, community),
    '-l', `${host}:${port}`,
    '-a', `${virtualIP}/${prefixFromCidr(subnetCidr)}`,
    '-t', '5645',
  ]
  if (tapName) args.unshift('-d', tapName)
  if (transportKey) args.push('-k', transportKey)
  if (username) args.push('-I', username)
  return args
}

async function connectAttempt({ executable, host, port, roomID, username, subnetCidr, virtualIP, community, transportKey, tapName }) {
  await stopConnection()
  const files = buildConfig({
    host: host || DEFAULT_HOST,
    port: Number(port) || DEFAULT_PORT,
    username,
    roomID,
    subnetCidr,
    virtualIP,
    community,
    transportKey,
    tapName,
  })
  const edgeArgs = buildEdgeArgs({
    host: host || DEFAULT_HOST,
    port: Number(port) || DEFAULT_PORT,
    roomID,
    username,
    subnetCidr,
    virtualIP,
    community,
    transportKey,
    tapName,
  })
  const child = spawn(executable, edgeArgs, {
    windowsHide: true,
    env: { ...process.env, ...(transportKey ? { N2N_KEY: transportKey } : {}) },
  })
  const output = []
  let failed = ''
  let initialized = false
  child.stdout.on('data', (chunk) => output.push(chunk.toString()))
  child.stderr.on('data', (chunk) => output.push(chunk.toString()))
  child.once('error', (error) => { failed = error.message })
  child.once('close', (code) => {
    if (!initialized) failed = `n2n 进程提前退出（代码 ${code ?? '未知'}）`
  })
  connection = { process: child, temporaryFiles: [files.configPath], logPath: files.logPath }

  try {
    const startedAt = Date.now()
    while (Date.now() - startedAt < CONNECT_TIMEOUT_MS) {
      if (failed) break
      const liveOutput = recentOutput(output)
      if (liveOutput) {
        try { fs.appendFileSync(files.logPath, liveOutput + '\r\n', 'utf8') } catch {}
      }
      if (N2N_PROGRESS.test(liveOutput) || Date.now() - startedAt > 1000) {
        const network = await waitForVpnNetwork(subnetCidr, 3000)
        if (network.connected && (!virtualIP || network.actualIp === virtualIP)) {
          initialized = true
          return inspectVpnNetwork(subnetCidr)
        }
      }
      await wait(300)
    }
    const liveOutput = recentOutput(output)
    const fileOutput = readRecentLog(files.logPath)
    const reason = failed || '连接超时：未获取虚拟 IP'
    const detail = [reason, liveOutput || fileOutput].filter(Boolean).join('\n')
    throw new Error(`n2n 连接失败：${detail || '连接超时'}\n日志文件：${files.logPath}`)
  } catch (error) {
    await stopConnection()
    throw error
  }
}

async function connect({ host, port, roomID, username, subnetCidr, virtualIP, community, transportKey }) {
  const executable = locateEdge()
  if (!executable) throw new Error('未检测到 n2n 联机组件 edge.exe，请重新运行完整安装包')
  if (!username || !roomID || !subnetCidr) throw new Error('n2n 房间凭据不完整')
  if (!virtualIP) throw new Error('n2n 房间虚拟 IP 未分配，请重新进入房间')

  await stopConnection()
  await stopStaleWelN2nProcesses()
  await wait(500)
  const prepared = await prepare()
  const tapNode = prepared.tapNode
  try {
    await ensureEdgeFirewall(executable)
  } catch {
    // Non-elevated clients keep the normal Windows firewall confirmation flow.
  }

  let lastError = null
  for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await connectAttempt({ executable, host, port, roomID, username, subnetCidr, virtualIP, community, transportKey, tapName: tapNode })
    } catch (error) {
      lastError = error
      if (attempt >= CONNECT_MAX_ATTEMPTS || !isRetryableConnectError(error)) throw error
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
  N2N_PROGRESS,
  TAP_NAME,
  buildEdgeArgs,
  connect,
  isWelTapAdapter,
  isRetryableConnectError,
  n2nCommunity,
  transportConfigPath,
  parseTapGuid,
  parseTapctlList,
  parseWmiTapAdapters,
  prepare,
  readRecentLog,
  selectWelTapAdapter,
  status,
  stopConnection,
}
