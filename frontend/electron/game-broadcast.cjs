const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const HELPER_READY_TIMEOUT_MS = 10000
const HELPER_STOP_TIMEOUT_MS = 3000
const WINDOWS_11_BUILD = 22000

function ipv4ToNumber(value) {
  const octets = String(value || '').trim().split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null
  return octets.reduce((number, octet) => ((number << 8) | octet) >>> 0, 0)
}

function numberToIPv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.')
}

function broadcastAddressFromCidr(cidr) {
  const [networkText, prefixText] = String(cidr || '').trim().split('/')
  const network = ipv4ToNumber(networkText)
  const prefix = Number(prefixText)
  if (network === null || !Number.isInteger(prefix) || prefix < 1 || prefix > 30) {
    throw new Error('WEL 房间子网无法生成游戏广播地址')
  }
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return numberToIPv4(((network & mask) | (~mask >>> 0)) >>> 0)
}

function windowsBuildFromRelease(release = os.release()) {
  const build = Number(String(release || '').split('.')[2])
  return Number.isInteger(build) ? build : 0
}

function runtimeVariantForRelease(release = os.release()) {
  return windowsBuildFromRelease(release) >= WINDOWS_11_BUILD ? 'net-modern' : 'net-compat'
}

function helperCandidates(release = os.release()) {
  const variant = runtimeVariantForRelease(release)
  return [
    path.join(process.resourcesPath || '', 'welhelper', variant, 'welnet.exe'),
    path.join(__dirname, '..', 'resources', 'welhelper', variant, 'welnet.exe'),
  ].filter(Boolean)
}

function locateGameBroadcastHelper(release = os.release()) {
  return helperCandidates(release).find((candidate) => fs.existsSync(candidate)) || null
}

function appendHelperLog(logPath, stream, chunk) {
  if (!logPath) return
  try {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '')
    fs.appendFileSync(logPath, `[game-broadcast:${stream}] ${text}`, 'utf8')
  } catch {
    // Diagnostics must never interrupt the room connection.
  }
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('close', () => finish(true))
  })
}

async function startGameBroadcastRedirect(network, subnetCidr, logPath) {
  if (process.platform !== 'win32') return null
  const tapIP = String(network?.actualIp || '').trim()
  const interfaceIndex = Number(network?.interfaceIndex)
  if (ipv4ToNumber(tapIP) === null || !Number.isInteger(interfaceIndex) || interfaceIndex <= 0) {
    throw new Error('WEL 游戏广播转发器缺少有效的 TAP 网卡信息')
  }

  const broadcastIP = broadcastAddressFromCidr(subnetCidr)
  const executable = locateGameBroadcastHelper()
  if (!executable) throw new Error('未找到 WEL 游戏广播组件，请安装最新完整客户端')

  const child = spawn(executable, [
    '--tap-ip', tapIP,
    '--broadcast-ip', broadcastIP,
    '--interface-index', String(interfaceIndex),
  ], {
    cwd: path.dirname(executable),
    windowsHide: true,
  })
  const redirector = { process: child, executable, tapIP, broadcastIP, interfaceIndex, stopping: false }
  let output = ''

  await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const onData = (stream) => (chunk) => {
      appendHelperLog(logPath, stream, chunk)
      output = (output + chunk.toString('utf8')).slice(-3000)
      if (/(?:^|\r?\n)READY\b/.test(output)) finish()
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish(new Error(`WEL 游戏广播组件启动超时${output.trim() ? `：${output.trim()}` : ''}`))
    }, HELPER_READY_TIMEOUT_MS)

    child.stdout.on('data', onData('stdout'))
    child.stderr.on('data', onData('stderr'))
    child.once('error', (error) => finish(new Error(`WEL 游戏广播组件无法启动：${error.message}`)))
    child.once('close', (code) => {
      finish(new Error(`WEL 游戏广播组件提前退出（代码 ${code ?? '未知'}）${output.trim() ? `：${output.trim()}` : ''}`))
    })
  })

  return redirector
}

async function stopGameBroadcastRedirect(redirector) {
  if (!redirector?.process) return false
  redirector.stopping = true
  try { redirector.process.kill() } catch {}
  const exited = await waitForExit(redirector.process, HELPER_STOP_TIMEOUT_MS)
  if (!exited) try { redirector.process.kill('SIGKILL') } catch {}
  return true
}

module.exports = {
  HELPER_READY_TIMEOUT_MS,
  WINDOWS_11_BUILD,
  broadcastAddressFromCidr,
  helperCandidates,
  locateGameBroadcastHelper,
  runtimeVariantForRelease,
  startGameBroadcastRedirect,
  stopGameBroadcastRedirect,
  windowsBuildFromRelease,
}
