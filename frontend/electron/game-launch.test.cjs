const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  broadcastAddressFromCidr,
  gameRuntimeCandidates,
  normalizeNetwork,
} = require('./game-launch.cjs')

test('builds socket-binding settings from the active TAP network', () => {
  assert.equal(broadcastAddressFromCidr('10.222.1.0/24'), '10.222.1.255')
  assert.deepEqual(normalizeNetwork({
    actualIp: '10.222.1.10',
    interfaceIndex: 8,
    subnetCidr: '10.222.1.0/24',
  }), {
    tapIP: '10.222.1.10',
    interfaceIndex: 8,
    subnetCidr: '10.222.1.0/24',
    broadcastIP: '10.222.1.255',
  })
  assert.deepEqual(normalizeNetwork({
    actualIp: '10.222.1.10',
    interfaceIndex: null,
    subnetCidr: '10.222.1.0/24',
  }), {
    tapIP: '10.222.1.10',
    interfaceIndex: 0,
    subnetCidr: '10.222.1.0/24',
    broadcastIP: '10.222.1.255',
  })
  assert.throws(() => normalizeNetwork({
    actualIp: 'not-an-ip',
    subnetCidr: '10.222.1.0/24',
  }), /TAP/)
})

test('locates the paired 32-bit launcher and hook runtime', () => {
  assert.match(gameRuntimeCandidates()[0], /welhelper[\\/]game-runtime$/)
})

test('hooks WE8 UDP sockets before rewriting discovery destinations', () => {
  const hook = fs.readFileSync(path.join(__dirname, '..', '..', 'native', 'wel-game', 'wel_game_hook.c'), 'utf8')
  const launcher = fs.readFileSync(path.join(__dirname, '..', '..', 'native', 'wel-game', 'wel_game_launcher.c'), 'utf8')
  assert.match(hook, /wel_bind/)
  assert.match(hook, /wel_connect/)
  assert.match(hook, /wel_send/)
  assert.match(hook, /wel_sendto/)
  assert.match(hook, /wel_setsockopt/)
  assert.match(hook, /wel_wsaconnect/)
  assert.match(hook, /wel_wsasend/)
  assert.match(hook, /wel_wsasendto/)
  assert.match(hook, /wsock32\.dll/)
  assert.match(hook, /WEL_HOOK_READY_EVENT/)
  assert.match(hook, /IP_UNICAST_IF/)
  assert.match(hook, /htons\(5739\)/)
  assert.match(hook, /INADDR_BROADCAST/)
  assert.match(launcher, /CREATE_SUSPENDED/)
  assert.match(launcher, /CreateRemoteThread/)
  assert.match(launcher, /Game network module did not initialize/)
  assert.match(launcher, /ResumeThread/)
  assert.doesNotMatch(hook + launcher, /WinDivert/)
})
