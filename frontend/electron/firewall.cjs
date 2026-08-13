const fs = require('node:fs')
const path = require('node:path')
const { runProcess } = require('./network.cjs')

const EDGE_INBOUND_RULE = 'WEL n2n edge inbound'
const WE8_INBOUND_RULE = 'WEL WE8 inbound'
const ROOM_UDP_INBOUND_RULE = 'WEL room UDP inbound'
const ROOM_UDP_OUTBOUND_RULE = 'WEL room UDP outbound'
const ROOM_ICMP_INBOUND_RULE = 'WEL room ICMPv4 inbound'
const ROOM_ICMP_OUTBOUND_RULE = 'WEL room ICMPv4 outbound'
const WEL_ROOM_FIREWALL_SUBNET_CIDR = '10.222.0.0/16'
const FIREWALL_RULE_VERSION = 3

function firewallHelperCandidates() {
  return [
    path.join(process.resourcesPath || '', 'welhelper', 'welfirewall.exe'),
    path.join(__dirname, '..', 'resources', 'welhelper', 'welfirewall.exe'),
  ].filter(Boolean)
}

function locateFirewallHelper() {
  return firewallHelperCandidates().find((candidate) => fs.existsSync(candidate)) || null
}

function firewallHelperExitReason(code) {
  if (Number(code) === 10) return '用户取消了 Windows 防火墙授权'
  if (Number(code) === 11) return 'Windows 无法启动防火墙授权程序'
  if (Number(code) === 12) return 'Windows 防火墙规则写入失败'
  return `Windows 防火墙授权程序退出（代码 ${code ?? '未知'}）`
}

function cidrToFirewallSubnet(subnetCidr) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/.exec(String(subnetCidr || '').trim())
  if (!match) throw new Error('WEL 房间子网格式不正确')

  const octets = match.slice(1, 5).map(Number)
  if (octets.some((octet) => octet > 255)) throw new Error('WEL 房间子网格式不正确')

  const prefixLength = Number(match[5])
  const mask = Array.from({ length: 4 }, (_, index) => {
    const remainingBits = Math.max(0, Math.min(8, prefixLength - index * 8))
    return remainingBits === 0 ? 0 : 256 - (2 ** (8 - remainingBits))
  })
  const network = octets.map((octet, index) => octet & mask[index])
  return `${network.join('.')}/${mask.join('.')}`
}

function buildRoomFirewallArgs(edgePath, subnetCidr = WEL_ROOM_FIREWALL_SUBNET_CIDR) {
  const normalizedEdgePath = String(edgePath || '').trim()
  if (!normalizedEdgePath) throw new Error('n2n 联机组件路径为空')
  return ['--subnet', cidrToFirewallSubnet(subnetCidr), '--edge', normalizedEdgePath]
}

function buildWe8FirewallArgs(programPath) {
  const normalizedPath = String(programPath || '').trim()
  if (!normalizedPath) throw new Error('防火墙程序路径为空')
  return ['--game', normalizedPath]
}

async function runFirewallHelper(args) {
  if (process.platform !== 'win32') return false
  const helper = locateFirewallHelper()
  if (!helper) throw new Error('未找到 Windows 防火墙授权组件，请安装最新完整客户端')
  try {
    await runProcess(helper, args, 45000)
  } catch (error) {
    const match = /退出代码\s+(-?\d+)/.exec(String(error?.message || ''))
    if (match) throw new Error(firewallHelperExitReason(Number(match[1])))
    throw new Error(`Windows 防火墙授权失败：${error.message}`)
  }
  return true
}

async function ensureRoomFirewall(edgePath, subnetCidr = WEL_ROOM_FIREWALL_SUBNET_CIDR) {
  return runFirewallHelper(buildRoomFirewallArgs(edgePath, subnetCidr))
}

async function ensureEdgeFirewall(programPath) {
  return ensureRoomFirewall(programPath)
}

async function ensureRoomUdpFirewall(subnetCidr, edgePath) {
  return ensureRoomFirewall(edgePath, subnetCidr)
}

async function ensureWe8Firewall(programPath) {
  return runFirewallHelper(buildWe8FirewallArgs(programPath))
}

module.exports = {
  EDGE_INBOUND_RULE,
  FIREWALL_RULE_VERSION,
  ROOM_ICMP_INBOUND_RULE,
  ROOM_ICMP_OUTBOUND_RULE,
  ROOM_UDP_INBOUND_RULE,
  ROOM_UDP_OUTBOUND_RULE,
  WE8_INBOUND_RULE,
  WEL_ROOM_FIREWALL_SUBNET_CIDR,
  buildRoomFirewallArgs,
  buildWe8FirewallArgs,
  cidrToFirewallSubnet,
  ensureEdgeFirewall,
  ensureRoomFirewall,
  ensureRoomUdpFirewall,
  ensureWe8Firewall,
  firewallHelperCandidates,
  firewallHelperExitReason,
  locateFirewallHelper,
}
