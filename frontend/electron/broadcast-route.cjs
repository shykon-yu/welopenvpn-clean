const { runPowerShell } = require('./network.cjs')

const LIMITED_BROADCAST_ADDRESS = '255.255.255.255'
const LIMITED_BROADCAST_MASK = '255.255.255.255'

function normalizeRouteTarget(virtualIP, interfaceIndex) {
  const address = String(virtualIP || '').trim()
  const octets = address.split('.').map(Number)
  const index = Number(interfaceIndex)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    throw new Error('WEL 广播路由的 TAP IP 不正确')
  }
  if (!Number.isInteger(index) || index <= 0) throw new Error('WEL 广播路由的 TAP 接口索引不正确')
  return { virtualIP: address, interfaceIndex: index }
}

function buildBroadcastRouteScript(virtualIP, interfaceIndex, action = 'add') {
  const target = normalizeRouteTarget(virtualIP, interfaceIndex)
  if (!['add', 'remove'].includes(action)) throw new Error('WEL 广播路由操作不正确')
  const addRoute = action === 'add'
    ? `
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
& $routeExe ADD $destination MASK $mask $nextHop METRIC 1 IF $interfaceIndex 2>&1 | Out-Null
$routeExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($routeExitCode -ne 0) { throw '无法把游戏广播路由绑定到 WEL TAP 网卡' }

Start-Sleep -Milliseconds 200
$installed = @(Get-WmiObject Win32_IP4RouteTable -ErrorAction Stop |
  Where-Object {
    $_.Destination -eq $destination -and
    $_.Mask -eq $mask -and
    [int]$_.InterfaceIndex -eq $interfaceIndex
  })
if ($installed.Count -eq 0) { throw 'WEL TAP 广播路由写入后未生效' }
`
    : ''

  return `
$ErrorActionPreference = 'Stop'
$destination = '${LIMITED_BROADCAST_ADDRESS}'
$mask = '${LIMITED_BROADCAST_MASK}'
$nextHop = '${target.virtualIP}'
$interfaceIndex = ${target.interfaceIndex}
$routeExe = Join-Path $env:SystemRoot 'System32\\route.exe'

# A missing route is normal on the first connection. Enumerate first so
# route.exe never turns "Element not found" into a terminating PS error.
$existingRoutes = @(Get-WmiObject Win32_IP4RouteTable -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Destination -eq $destination -and
    $_.Mask -eq $mask -and
    [int]$_.InterfaceIndex -eq $interfaceIndex
  })
foreach ($existingRoute in $existingRoutes) {
  $existingNextHop = [string]$existingRoute.NextHop
  if (-not $existingNextHop) { continue }
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  & $routeExe DELETE $destination MASK $mask $existingNextHop IF $interfaceIndex 2>&1 | Out-Null
  $ErrorActionPreference = $previousErrorActionPreference
}
${addRoute}`
}

async function ensureBroadcastRoute(network) {
  if (process.platform !== 'win32') return null
  const target = normalizeRouteTarget(network?.actualIp, network?.interfaceIndex)
  try {
    await runPowerShell(buildBroadcastRouteScript(target.virtualIP, target.interfaceIndex, 'add'), 10000)
    return target
  } catch (error) {
    try { await runPowerShell(buildBroadcastRouteScript(target.virtualIP, target.interfaceIndex, 'remove'), 8000) } catch {}
    throw error
  }
}

async function removeBroadcastRoute(route) {
  if (process.platform !== 'win32' || !route) return false
  const target = normalizeRouteTarget(route.virtualIP, route.interfaceIndex)
  await runPowerShell(buildBroadcastRouteScript(target.virtualIP, target.interfaceIndex, 'remove'), 8000)
  return true
}

module.exports = {
  LIMITED_BROADCAST_ADDRESS,
  LIMITED_BROADCAST_MASK,
  buildBroadcastRouteScript,
  ensureBroadcastRoute,
  normalizeRouteTarget,
  removeBroadcastRoute,
}
