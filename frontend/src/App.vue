<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { FolderOpen, Gamepad2, LogOut, Play, RefreshCw, Router, ShieldCheck, Users } from 'lucide-vue-next'
import { ApiError, authApi, clearToken, getAccessToken, hasToken, roomApi, setToken, type Lease, type Room, type RoomMember, type User } from './api'
import type { DesktopLeaseStatus, PingResult } from './electron'
import packageInfo from '../package.json'

const APP_VERSION = `v${packageInfo.version}`

type DesktopStatus = {
  ready: boolean
  message: string
  openvpnInstalled: boolean
  tapName?: string
}

const user = ref<User | null>(null)
const rooms = ref<Room[]>([])
const activeLease = ref<Lease | null>(null)
const roomMembers = ref<RoomMember[]>([])
const networkStatus = ref<DesktopLeaseStatus | null>(null)
const loading = ref(false)
const errorMessage = ref('')
const notice = ref('')
const desktopStatus = ref<DesktopStatus | null>(null)
const pingResults = ref<Record<number, PingResult | undefined>>({})
const selectedMemberId = ref<number | null>(null)
const form = ref({ username: '', password: '' })
const GAME_PATH_KEY = 'we8.game-path'
const LEGACY_GAME_PATH_KEY = 'pes8.game-path'
const gamePath = ref(localStorage.getItem(GAME_PATH_KEY) ?? localStorage.getItem(LEGACY_GAME_PATH_KEY) ?? '')
const totalOnline = computed(() => rooms.value.reduce((total, room) => total + room.members, 0))
const activeRoom = computed(() => activeLease.value ? rooms.value.find(room => room.id === activeLease.value?.room_id) ?? null : null)
const activeRoomName = computed(() => activeRoom.value?.name ?? (activeLease.value ? `房间 ${activeLease.value.room_id}` : '未进入房间'))
const roomInfoTitle = computed(() => activeLease.value ? activeRoomName.value : '未进入房间')
const roomInfoSubtitle = computed(() => {
  if (!activeLease.value) return '请选择一个可用房间进入'
  return networkStatus.value?.connected ? `${activeRoomName.value} · 网络已连接` : `${activeRoomName.value} · 正在确认网络`
})
const virtualIpLabel = computed(() => {
  if (!activeLease.value) return '待分配'
  return networkStatus.value?.actualIp ? `${networkStatus.value.actualIp} / ${activeLease.value.subnet_cidr}` : '尚未获取'
})
const connectionTitle = computed(() => {
  if (desktopStatus.value?.ready) return '联机组件已准备完成'
  return '需要安装 WEL 联机组件'
})
const gamePathLabel = computed(() => gamePath.value.trim() || '未选择 WE8 游戏程序')
const desktop = () => window.we8Desktop
const heartbeatIntervalMs = 5 * 60 * 1000
const sessionCheckIntervalMs = 30 * 1000
const roomMembersIntervalMs = 15 * 1000
let heartbeatTimer: number | undefined
let sessionCheckTimer: number | undefined
let roomMembersTimer: number | undefined
let signingOut = false

function stopLeaseHeartbeat() {
  if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer)
  heartbeatTimer = undefined
}

function startLeaseHeartbeat() {
  stopLeaseHeartbeat()
  if (!activeLease.value) return
  void renewLease()
  heartbeatTimer = window.setInterval(() => { void renewLease() }, heartbeatIntervalMs)
}

function stopSessionMonitor() {
  if (sessionCheckTimer !== undefined) window.clearInterval(sessionCheckTimer)
  sessionCheckTimer = undefined
}

function startSessionMonitor() {
  stopSessionMonitor()
  if (!user.value) return
  sessionCheckTimer = window.setInterval(() => { void checkSession() }, sessionCheckIntervalMs)
}

function stopRoomMembersMonitor() {
  if (roomMembersTimer !== undefined) window.clearInterval(roomMembersTimer)
  roomMembersTimer = undefined
  roomMembers.value = []
}

function startRoomMembersMonitor() {
  stopRoomMembersMonitor()
  if (!activeLease.value) return
  void loadRoomMembers()
  roomMembersTimer = window.setInterval(() => { void loadRoomMembers() }, roomMembersIntervalMs)
}

function clearRoomSessionState() {
  activeLease.value = null
  networkStatus.value = null
  pingResults.value = {}
  selectedMemberId.value = null
}

async function loadRoomMembers() {
  const lease = activeLease.value
  if (!lease) return
  try {
    const result = await roomApi.members(lease.room_id)
    if (activeLease.value?.room_id === lease.room_id) roomMembers.value = result.members
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) await forceSignedOut(error.message)
  }
}

async function checkSession() {
  if (!user.value || signingOut) return
  try {
    await authApi.me()
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) await forceSignedOut(error.message)
  }
}

async function forceSignedOut(message: string) {
  if (signingOut) return
  signingOut = true
  stopLeaseHeartbeat()
  stopSessionMonitor()
  stopRoomMembersMonitor()
  const lease = activeLease.value
  if (lease) {
    try { await desktop()?.disconnectVpn(lease.username) } catch { /* the server has already revoked this session */ }
  }
  clearRoomSessionState()
  user.value = null
  rooms.value = []
  clearToken()
  notice.value = ''
  errorMessage.value = message
  signingOut = false
}

async function refreshDesktopStatus() {
  if (!desktop()) return
  try {
    desktopStatus.value = await desktop()!.desktopStatus()
  } catch (error) {
    desktopStatus.value = null
    errorMessage.value = messageOf(error)
  }
}

async function ensureDesktopReady() {
  if (!desktop()) return true
  try {
    desktopStatus.value = await desktop()!.prepareDesktop()
    return true
  } catch (error) {
    desktopStatus.value = await desktop()!.desktopStatus().catch(() => null)
    errorMessage.value = messageOf(error)
    return false
  }
}

async function renewLease() {
  const lease = activeLease.value
  if (!lease) return
  try {
    const result = await roomApi.heartbeat(lease.room_id)
    if (activeLease.value?.room_id === lease.room_id) activeLease.value.expires_at = result.expires_at
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      await forceSignedOut(error.message)
      return
    }
    if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
      stopLeaseHeartbeat()
      stopRoomMembersMonitor()
      try { await desktop()?.disconnectVpn(lease.username) } catch { /* local connection may already be gone */ }
      activeLease.value = null
      networkStatus.value = null
      await loadRooms()
      errorMessage.value = error.message
      return
    }
    errorMessage.value = `房间连接续期失败，将自动重试：${messageOf(error)}`
  }
}

async function loadRooms() {
  loading.value = true
  errorMessage.value = ''
  try { rooms.value = (await roomApi.list()).rooms } catch (error) { errorMessage.value = messageOf(error) } finally { loading.value = false }
}

async function authenticate() {
  loading.value = true
  errorMessage.value = ''
  try {
    const session = await authApi.login({ username: form.value.username, password: form.value.password })
    setToken(session.token)
    user.value = session.user
    form.value.password = ''
    activeLease.value = (await authApi.roomSession()).lease
    startLeaseHeartbeat()
    startRoomMembersMonitor()
    await loadRooms()
    startSessionMonitor()
  } catch (error) { errorMessage.value = messageOf(error) } finally { loading.value = false }
}

async function restoreSession() {
  if (!hasToken()) return
  let previousLease: Lease | null = null
  try {
    user.value = (await authApi.me()).user
    previousLease = (await authApi.roomSession()).lease
  } catch (error) {
    clearToken()
    if (error instanceof ApiError && error.status === 401) errorMessage.value = error.message
    return
  }

  clearRoomSessionState()
  await loadRooms()
  startSessionMonitor()
  if (previousLease) {
    try { await desktop()?.disconnectVpn(previousLease.username) } catch { /* best effort cleanup */ }
    try { await roomApi.leave(previousLease.room_id) } catch { /* stale room state will expire server-side */ }
    notice.value = '已清理上次房间状态，请重新进入房间'
    await loadRooms()
  }
}

function connectDesktopVpn(lease: Lease) {
  const configuredBasePort = Number(import.meta.env.VITE_OPENVPN_BASE_PORT ?? 12000)
  const serverPort = Number(lease.server_port)
  return desktop()!.connectVpn({
    host: import.meta.env.VITE_OPENVPN_HOST ?? lease.server_host,
    port: Number.isFinite(serverPort) && serverPort > 0 ? serverPort : configuredBasePort + lease.room_id,
    username: lease.username,
    roomID: lease.room_id,
    token: getAccessToken(),
    subnetCidr: lease.subnet_cidr,
  })
}

async function joinRoom(room: Room) {
  loading.value = true
  errorMessage.value = ''
  let lease: Lease | null = null
  try {
    if (desktop() && !(await ensureDesktopReady())) return
    lease = (await roomApi.join(room.id)).lease
    activeLease.value = lease
    if (desktop()) {
      networkStatus.value = await connectDesktopVpn(lease)
    }
    startLeaseHeartbeat()
    startRoomMembersMonitor()
    notice.value = '已进入房间'
    await loadRooms()
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      await forceSignedOut(error.message)
      return
    }
    stopLeaseHeartbeat()
    stopRoomMembersMonitor()
    if (lease) {
      try { await desktop()?.disconnectVpn(lease.username) } catch { /* connection setup may be incomplete */ }
    }
    if (lease) try { await roomApi.leave(room.id) } catch { /* the lease reaper will clean it up */ }
    activeLease.value = null
    networkStatus.value = null
    errorMessage.value = messageOf(error)
  } finally { loading.value = false }
}

async function releaseActiveLease() {
  const lease = activeLease.value
  if (!lease) return
  stopLeaseHeartbeat()
  stopRoomMembersMonitor()
  let cleanupError: unknown
  try { await desktop()?.disconnectVpn(lease.username) } catch (error) { cleanupError = error }
  try {
    await roomApi.leave(lease.room_id)
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) cleanupError ??= error
  }
  clearRoomSessionState()
  if (cleanupError) throw cleanupError
}

async function leaveRoom() {
  if (!activeLease.value) return
  loading.value = true
  try {
    await releaseActiveLease()
    notice.value = '已退出房间'
    await loadRooms()
  } catch (error) { errorMessage.value = messageOf(error) } finally { loading.value = false }
}

function saveGamePath() {
  localStorage.setItem(GAME_PATH_KEY, gamePath.value)
  localStorage.removeItem(LEGACY_GAME_PATH_KEY)
  notice.value = '游戏路径已保存'
}
async function chooseGame() {
  errorMessage.value = ''
  if (!desktop()) {
    notice.value = '浏览器预览不会弹出本机文件选择器，请在 Windows 客户端测试'
    return
  }
  try {
    const selectedPath = await desktop()!.chooseGame()
    if (!selectedPath) return
    gamePath.value = selectedPath
    saveGamePath()
  } catch (error) {
    errorMessage.value = messageOf(error)
  }
}

async function inspectVpnBeforeLaunch(lease: Lease) {
  const inspected: DesktopLeaseStatus | null = await desktop()!.inspectVpn({ username: lease.username, subnetCidr: lease.subnet_cidr })
  if (!inspected.connected) throw new Error('尚未获取房间虚拟 IP，请退出房间后重新进入')
  return inspected
}

async function launchGame() {
  errorMessage.value = ''
  if (!activeLease.value) { errorMessage.value = '请先进入一个房间并连接虚拟网络'; return }
  if (!gamePath.value.trim()) { errorMessage.value = '请先选择 WE8 游戏程序路径'; return }
  if (!desktop()) { notice.value = '浏览器预览不会启动本机程序，请在 Windows 客户端测试'; return }
  try {
    const checkedStatus = await inspectVpnBeforeLaunch(activeLease.value)
    if (!checkedStatus) return
    networkStatus.value = checkedStatus
    await desktop()!.launchGame(gamePath.value)
  } catch (error) { errorMessage.value = messageOf(error) }
}
async function pingMember(member: RoomMember) {
  if (!desktop()) return
  pingResults.value = { ...pingResults.value, [member.user_id]: { host: member.virtual_ip, reachable: false, summary: '正在 Ping...' } }
  try {
    const result = await desktop()!.pingHost(member.virtual_ip)
    pingResults.value = { ...pingResults.value, [member.user_id]: result }
  } catch (error) {
    pingResults.value = {
      ...pingResults.value,
      [member.user_id]: { host: member.virtual_ip, reachable: false, summary: messageOf(error) },
    }
  }
}

function openMemberDetail(member: RoomMember) {
  selectedMemberId.value = member.user_id
}

function closeMemberDetail() {
  selectedMemberId.value = null
}

const selectedMember = computed(() => roomMembers.value.find(member => member.user_id === selectedMemberId.value) ?? null)
const selectedMemberPing = computed(() => selectedMember.value ? pingResults.value[selectedMember.value.user_id] ?? null : null)
async function logout() {
  loading.value = true
  errorMessage.value = ''
  try {
    await releaseActiveLease()
  } catch {
    errorMessage.value = '房间清理未完全成功，服务器将在超时后自动回收'
  }
  try {
    await authApi.logout()
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      errorMessage.value ||= '服务器登录状态未完全清理，将在有效期结束后自动失效'
    }
  } finally {
    stopLeaseHeartbeat()
    stopSessionMonitor()
    stopRoomMembersMonitor()
    user.value = null
    networkStatus.value = null
    clearToken()
    rooms.value = []
    loading.value = false
  }
}
function messageOf(error: unknown) {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return '发生未知错误'
}

onMounted(restoreSession)
onMounted(refreshDesktopStatus)
onBeforeUnmount(() => {
  stopLeaseHeartbeat()
  stopSessionMonitor()
  stopRoomMembersMonitor()
})
</script>

<template>
  <main v-if="!user" class="auth-shell">
    <section class="auth-panel">
      <div class="brand-mark"><Gamepad2 :size="28" /></div>
      <p class="eyebrow">WE8 ONLINE ARENA</p>
      <h1>WEL职业联盟对战平台 <span class="app-version">{{ APP_VERSION }}</span></h1>
      <form @submit.prevent="authenticate">
        <label>账号<input v-model.trim="form.username" autocomplete="username" placeholder="3 至 32 位账号" required /></label>
        <label>密码<input v-model="form.password" type="password" autocomplete="current-password" placeholder="至少 6 位" minlength="6" required /></label>
        <p v-if="errorMessage" class="form-error">{{ errorMessage }}</p>
        <button class="primary-button" :disabled="loading">{{ loading ? '处理中...' : '登录平台' }}</button>
      </form>
    </section>
  </main>

  <main v-else class="app-shell">
    <aside class="sidebar">
      <div class="sidebar-brand"><span class="brand-mark"><Gamepad2 :size="22" /></span><span>WE8 Arena <span class="app-version">{{ APP_VERSION }}</span></span></div>
      <div class="user-row"><span class="avatar">{{ user.nickname.slice(0, 1) }}</span><span><strong>{{ user.nickname }}</strong><small>@{{ user.username }}</small></span></div>
      <nav><a class="active"><Users :size="18" /> 对战房间</a></nav>
      <div class="sidebar-actions"><button class="logout" @click="logout"><LogOut :size="17" /> 退出登录</button></div>
    </aside>

    <section class="content">
      <section v-if="desktop()" class="connection-strip">
        <div>
          <p class="eyebrow">联机准备</p>
          <h3>{{ connectionTitle }}</h3>
          <span>{{ desktopStatus?.message ?? '正在检测 OpenVPN、TAP 与管理员权限' }}</span>
        </div>
        <div class="connection-actions">
          <span class="secure"><ShieldCheck :size="17" /> {{ desktopStatus?.ready ? '可联机' : '不可联机' }}</span>
          <button class="secondary-button" @click="refreshDesktopStatus" :disabled="loading">重新检测</button>
        </div>
      </section>
      <header class="topbar"><div><p class="eyebrow">游戏大厅</p><h2>选择一个对战房间</h2></div><div class="topbar-actions"><div class="online"><span></span>{{ totalOnline }} 人在线</div></div></header>
      <section v-if="desktop()" class="game-path-panel"><div><p class="eyebrow">当前游戏路径</p><span :class="['game-path', { empty: !gamePath.trim() }]">{{ gamePathLabel }}</span></div><button class="secondary-button" @click="chooseGame"><FolderOpen :size="17" /> 选择游戏</button></section>
      <p v-if="errorMessage" class="banner error">{{ errorMessage }}</p><p v-if="notice" class="banner notice">{{ notice }}</p>

      <section class="connection-strip room-status-strip" :class="{ connected: activeLease }">
        <div><p class="eyebrow">房间信息</p><h3>{{ roomInfoTitle }}</h3><span><Router :size="15" /> {{ roomInfoSubtitle }}</span></div>
        <div class="connection-actions"><span class="secure"><ShieldCheck :size="17" /> 虚拟 IP：{{ virtualIpLabel }}</span><button class="primary-button launch" @click="launchGame" :disabled="!activeLease || !networkStatus?.connected"><Play :size="17" /> 启动 WE8</button><button v-if="activeLease" class="secondary-button" @click="leaveRoom" :disabled="loading">退出房间</button></div>
      </section>

      <div class="room-workspace">
        <section class="room-section"><div class="section-heading"><h3>可用房间</h3><button class="icon-button" title="刷新房间" @click="loadRooms" :disabled="loading"><RefreshCw :size="18" :class="{ spinning: loading }" /></button></div>
          <div class="room-grid"><article v-for="room in rooms" :key="room.id" class="room-card" :class="{ unavailable: room.status !== 'open' }"><div class="room-card-top"><span class="region">{{ room.region }}</span><span :class="['room-state', room.status]">{{ room.status === 'open' ? '可进入' : '维护中' }}</span></div><h3>{{ room.name }}</h3><p>{{ room.subnet_cidr }}</p><div class="room-card-footer"><span><Users :size="16" /> {{ room.members }} / {{ room.capacity }}</span><button class="join-button" :disabled="loading || room.status !== 'open' || Boolean(activeLease) || (desktop() && !desktopStatus?.ready)" @click="joinRoom(room)">进入</button></div></article></div>
        </section>
        <aside v-if="activeLease" class="room-members-panel"><div class="section-heading"><div><p class="eyebrow">{{ roomInfoTitle }}</p><h3>房间成员</h3></div><span class="member-count">{{ roomMembers.length }} 人</span></div><div v-if="roomMembers.length" class="member-list"><div v-for="member in roomMembers" :key="member.user_id" class="member-row"><span class="member-avatar">{{ member.nickname.slice(0, 1) }}</span><span><strong>{{ member.nickname }}</strong><small>@{{ member.username }}</small></span><button class="mini-button" @click="openMemberDetail(member)">详情</button><em v-if="member.is_self">我</em></div></div><p v-else class="member-empty">正在读取房间成员...</p></aside>
      </div>

      <teleport to="body">
        <div v-if="selectedMember" class="modal-backdrop" @click.self="closeMemberDetail">
          <section class="member-modal" role="dialog" aria-modal="true" :aria-label="`${selectedMember.nickname} 详情`">
            <header class="member-modal-header">
              <div>
                <p class="eyebrow">房间成员详情</p>
                <h3>{{ selectedMember.nickname }}</h3>
              </div>
              <button class="icon-button modal-close" title="关闭" @click="closeMemberDetail">×</button>
            </header>
            <div class="member-modal-body">
              <div class="detail-row"><span>账号</span><strong>@{{ selectedMember.username }}</strong></div>
              <div class="detail-row"><span>身份</span><strong>{{ selectedMember.is_self ? '当前用户' : '房间成员' }}</strong></div>
              <div class="detail-row"><span>虚拟 IP</span><strong>{{ selectedMember.virtual_ip || '未分配' }}</strong></div>
              <div class="detail-row"><span>真实 IP</span><strong>{{ selectedMember.real_ip || '未知' }}</strong></div>
              <div class="detail-row">
                <span>Ping</span>
                <strong :class="['ping-result', { ok: selectedMemberPing?.reachable }]">{{ selectedMemberPing?.summary || '尚未测试' }}</strong>
              </div>
            </div>
            <footer class="member-modal-footer">
              <button class="secondary-button" :disabled="!selectedMember.virtual_ip || !desktop()" @click="pingMember(selectedMember)">Ping</button>
              <button class="primary-button" @click="closeMemberDetail">关闭</button>
            </footer>
          </section>
        </div>
      </teleport>

    </section>
  </main>
</template>
