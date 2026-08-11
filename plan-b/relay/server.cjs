const dgram = require('node:dgram')
const {
  EMPTY_PEER_ID,
  TYPE,
  decodeFrame,
  encodeFrame,
  isEmptyPeerId,
  peerKey,
} = require('./protocol.cjs')

const DEFAULT_PORT = 22223
const DEFAULT_PEER_TTL_MS = 90_000

function createRelay({ send, now = () => Date.now(), peerTtlMs = DEFAULT_PEER_TTL_MS } = {}) {
  if (typeof send !== 'function') throw new Error('relay send function is required')
  const rooms = new Map()

  function peersFor(room) {
    let peers = rooms.get(room)
    if (!peers) {
      peers = new Map()
      rooms.set(room, peers)
    }
    return peers
  }

  function removeExpiredPeers() {
    const cutoff = now() - peerTtlMs
    for (const [room, peers] of rooms) {
      for (const [key, peer] of peers) {
        if (peer.lastSeen < cutoff) peers.delete(key)
      }
      if (peers.size === 0) rooms.delete(room)
    }
  }

  function register(frame, rinfo) {
    peersFor(frame.room).set(peerKey(frame.sender), {
      id: frame.sender,
      address: rinfo.address,
      port: rinfo.port,
      lastSeen: now(),
    })
  }

  function authenticatedPeer(frame, rinfo) {
    const peer = rooms.get(frame.room)?.get(peerKey(frame.sender))
    if (!peer || peer.address !== rinfo.address || peer.port !== rinfo.port) return null
    peer.lastSeen = now()
    return peer
  }

  function deliver(frame, target) {
    const delivery = encodeFrame({
      type: TYPE.DELIVERY,
      room: frame.room,
      sender: frame.sender,
      target: target.id,
      sourcePort: frame.sourcePort,
      destinationPort: frame.destinationPort,
      payload: frame.payload,
    })
    send(delivery, target)
  }

  function handle(packet, rinfo) {
    let frame
    try {
      frame = decodeFrame(packet)
    } catch {
      return { accepted: false, reason: 'invalid-frame' }
    }

    removeExpiredPeers()
    if (frame.type === TYPE.REGISTER) {
      if (!isEmptyPeerId(frame.target)) return { accepted: false, reason: 'register-target-not-empty' }
      register(frame, rinfo)
      return { accepted: true, delivered: 0, registered: true }
    }

    if (!authenticatedPeer(frame, rinfo)) return { accepted: false, reason: 'unregistered-peer' }
    if (frame.type === TYPE.KEEPALIVE) return { accepted: true, delivered: 0 }

    if (frame.type === TYPE.BROADCAST) {
      if (!isEmptyPeerId(frame.target)) return { accepted: false, reason: 'broadcast-target-not-empty' }
      let delivered = 0
      for (const peer of peersFor(frame.room).values()) {
        if (peerKey(peer.id) === peerKey(frame.sender)) continue
        deliver(frame, peer)
        delivered += 1
      }
      return { accepted: true, delivered }
    }

    if (frame.type === TYPE.UNICAST) {
      const target = rooms.get(frame.room)?.get(peerKey(frame.target))
      if (!target) return { accepted: false, reason: 'target-offline' }
      deliver(frame, target)
      return { accepted: true, delivered: 1 }
    }

    return { accepted: false, reason: 'client-frame-type-not-supported' }
  }

  return { handle, removeExpiredPeers, rooms }
}

function startRelay(port = DEFAULT_PORT) {
  const socket = dgram.createSocket('udp4')
  const relay = createRelay({
    send: (packet, target) => socket.send(packet, target.port, target.address),
  })
  socket.on('error', (error) => console.error(`relay socket error: ${error.message}`))
  socket.on('message', (packet, rinfo) => {
    const result = relay.handle(packet, rinfo)
    if (!result.accepted) console.warn(`rejected ${rinfo.address}:${rinfo.port}: ${result.reason}`)
  })
  socket.bind(port, '0.0.0.0', () => {
    const address = socket.address()
    console.log(`WEL Plan B relay listening on udp://${address.address}:${address.port}`)
  })
  return { relay, socket }
}

if (require.main === module) {
  const requestedPort = Number(process.argv[2] || DEFAULT_PORT)
  if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
    console.error('usage: node server.cjs [udp-port]')
    process.exit(2)
  }
  startRelay(requestedPort)
}

module.exports = { DEFAULT_PEER_TTL_MS, DEFAULT_PORT, createRelay, startRelay }
