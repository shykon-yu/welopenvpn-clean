const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  broadcastAddressFromCidr,
  helperCandidates,
  runtimeVariantForRelease,
  windowsBuildFromRelease,
} = require('./game-broadcast.cjs')

test('calculates the directed broadcast for the active room subnet', () => {
  assert.equal(broadcastAddressFromCidr('10.222.1.0/24'), '10.222.1.255')
  assert.equal(broadcastAddressFromCidr('10.80.16.0/20'), '10.80.31.255')
  assert.throws(() => broadcastAddressFromCidr('10.222.1.0/33'), /子网/)
})

test('selects compatible packet runtimes by Windows build', () => {
  assert.equal(windowsBuildFromRelease('6.1.7601'), 7601)
  assert.equal(runtimeVariantForRelease('6.1.7601'), 'net-compat')
  assert.equal(runtimeVariantForRelease('10.0.19045'), 'net-compat')
  assert.equal(runtimeVariantForRelease('10.0.22000'), 'net-modern')
  assert.equal(runtimeVariantForRelease('10.0.26100'), 'net-modern')
  assert.match(helperCandidates('10.0.26100')[0], /welhelper[\\/]net-modern[\\/]welnet\.exe$/)
})

test('limits the native packet filter to WE8 discovery broadcasts', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'native', 'wel-broadcast', 'wel_broadcast.c'), 'utf8')
  assert.match(source, /outbound and ip and udp\.DstPort == 5739/)
  assert.match(source, /ip\.DstAddr == 255\.255\.255\.255/)
  assert.match(source, /ip_header->SrcAddr = options\.tap_ip/)
  assert.match(source, /ip_header->DstAddr = options\.broadcast_ip/)
  assert.match(source, /WinDivertHelperCalcChecksums/)
  assert.doesNotMatch(source, /WE8\.exe|CreateRemoteThread|WriteProcessMemory/)
})
