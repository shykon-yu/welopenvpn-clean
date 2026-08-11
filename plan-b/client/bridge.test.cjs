const test = require('node:test')
const assert = require('node:assert/strict')
const { TYPE: LOCAL_TYPE, decodeLocalFrame, encodeLocalFrame, ipv4 } = require('./protocol.cjs')
const { TYPE: RELAY_TYPE, decodeFrame, encodeFrame } = require('../relay/protocol.cjs')
const { createBridge, isSyntheticAddress, syntheticAddressForPeer } = require('./bridge.cjs')

const alice = Buffer.from('00000000000000000000000000000001', 'hex')
const bob = Buffer.from('00000000000000000000000000000002', 'hex')

test('uses a stable synthetic address that does not exist in Windows', () => {
  const first = syntheticAddressForPeer(alice)
  assert.equal(first, syntheticAddressForPeer(alice))
  assert.notEqual(first, syntheticAddressForPeer(bob))
  assert.equal(isSyntheticAddress(first), true)
  assert.equal(isSyntheticAddress(ipv4('192.168.1.10')), false)
})

test('translates local discovery into a room broadcast', () => {
  const relayed = []
  const bridge = createBridge({ room: 7, peer: alice, sendRelay: (packet) => relayed.push(packet), sendLocal: () => {} })
  const result = bridge.handleLocal(encodeLocalFrame({
    type: LOCAL_TYPE.BROADCAST,
    sourcePort: 51000,
    destinationPort: 5739,
    payload: Buffer.from('search'),
  }))
  assert.equal(result.accepted, true)
  assert.equal(decodeFrame(relayed[0]).type, RELAY_TYPE.BROADCAST)
  assert.equal(decodeFrame(relayed[0]).payload.toString(), 'search')
})

test('injects relay delivery with the sender synthetic address then routes direct reply', () => {
  const relayed = []
  const local = []
  const bridge = createBridge({ room: 7, peer: alice, sendRelay: (packet) => relayed.push(packet), sendLocal: (packet) => local.push(packet) })
  const result = bridge.handleRelay(encodeFrame({
    type: RELAY_TYPE.DELIVERY,
    room: 7,
    sender: bob,
    target: alice,
    sourcePort: 5739,
    destinationPort: 51000,
    payload: Buffer.from('host'),
  }))
  assert.equal(result.accepted, true)
  const delivery = decodeLocalFrame(local[0])
  assert.equal(delivery.type, LOCAL_TYPE.DELIVERY)
  assert.equal(delivery.sourceAddress, syntheticAddressForPeer(bob))

  const outbound = bridge.handleLocal(encodeLocalFrame({
    type: LOCAL_TYPE.UNICAST,
    destinationAddress: delivery.sourceAddress,
    sourcePort: 51000,
    destinationPort: 5739,
    payload: Buffer.from('join'),
  }))
  assert.equal(outbound.accepted, true)
  const unicast = decodeFrame(relayed[0])
  assert.equal(unicast.type, RELAY_TYPE.UNICAST)
  assert.deepEqual(unicast.target, bob)
})
