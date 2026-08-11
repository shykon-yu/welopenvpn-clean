const test = require('node:test')
const assert = require('node:assert/strict')
const { TYPE, decodeFrame, encodeFrame } = require('./protocol.cjs')
const { createRelay } = require('./server.cjs')

const alice = Buffer.from('00000000000000000000000000000001', 'hex')
const bob = Buffer.from('00000000000000000000000000000002', 'hex')
const room = 1
const aliceEndpoint = { address: '198.51.100.10', port: 40001 }
const bobEndpoint = { address: '198.51.100.11', port: 40002 }

function register(relay, sender, endpoint) {
  return relay.handle(encodeFrame({ type: TYPE.REGISTER, room, sender }), endpoint)
}

test('encodes and decodes a binary relay frame', () => {
  const frame = encodeFrame({
    type: TYPE.UNICAST,
    room,
    sender: alice,
    target: bob,
    sourcePort: 5739,
    destinationPort: 5739,
    payload: Buffer.from('we8'),
  })
  assert.deepEqual(decodeFrame(frame), {
    type: TYPE.UNICAST,
    room,
    sender: alice,
    target: bob,
    sourcePort: 5739,
    destinationPort: 5739,
    payload: Buffer.from('we8'),
  })
})

test('fans a room broadcast out to every registered peer except its sender', () => {
  const delivered = []
  const relay = createRelay({ send: (packet, target) => delivered.push({ packet, target }) })
  assert.equal(register(relay, alice, aliceEndpoint).registered, true)
  assert.equal(register(relay, bob, bobEndpoint).registered, true)

  const result = relay.handle(encodeFrame({
    type: TYPE.BROADCAST,
    room,
    sender: alice,
    sourcePort: 5739,
    destinationPort: 5739,
    payload: Buffer.from('search'),
  }), aliceEndpoint)

  assert.deepEqual(result, { accepted: true, delivered: 1 })
  assert.equal(delivered.length, 1)
  assert.deepEqual(delivered[0].target, {
    id: bob,
    address: bobEndpoint.address,
    port: bobEndpoint.port,
    lastSeen: delivered[0].target.lastSeen,
  })
  const frame = decodeFrame(delivered[0].packet)
  assert.equal(frame.type, TYPE.DELIVERY)
  assert.deepEqual(frame.sender, alice)
  assert.deepEqual(frame.target, bob)
  assert.equal(frame.payload.toString(), 'search')
})

test('routes a room unicast only to its target peer', () => {
  const delivered = []
  const relay = createRelay({ send: (packet, target) => delivered.push({ packet, target }) })
  register(relay, alice, aliceEndpoint)
  register(relay, bob, bobEndpoint)

  const result = relay.handle(encodeFrame({
    type: TYPE.UNICAST,
    room,
    sender: alice,
    target: bob,
    sourcePort: 49820,
    destinationPort: 5739,
    payload: Buffer.from('join'),
  }), aliceEndpoint)

  assert.deepEqual(result, { accepted: true, delivered: 1 })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].target.address, bobEndpoint.address)
  assert.equal(decodeFrame(delivered[0].packet).payload.toString(), 'join')
})

test('rejects a frame from an endpoint that did not register the sender', () => {
  const relay = createRelay({ send: () => assert.fail('must not send') })
  register(relay, alice, aliceEndpoint)
  const result = relay.handle(encodeFrame({ type: TYPE.BROADCAST, room, sender: alice }), {
    address: '198.51.100.200',
    port: 49999,
  })
  assert.deepEqual(result, { accepted: false, reason: 'unregistered-peer' })
})
