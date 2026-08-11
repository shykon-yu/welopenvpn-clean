const dgram = require('node:dgram')
const crypto = require('node:crypto')
const {
  TYPE: LOCAL_TYPE,
  decodeLocalFrame,
  encodeLocalFrame,
  ipv4,
  ipv4Text,
} = require('./protocol.cjs')
const {
  EMPTY_PEER_ID,
  TYPE: RELAY_TYPE,
  decodeFrame,
  encodeFrame,
  peerId,
  peerKey,
} = require('../relay/protocol.cjs')

const DEFAULT_LOCAL_PORT = 22224
const DEFAULT_RELAY_PORT = 22223
const SYNTHETIC_PREFIX = ipv4('198.18.0.0')
const SYNTHETIC_MASK = ipv4('255.254.0.0')

function syntheticAddressForPeer(value) {
  const digest = crypto.createHash('sha256').update(peerId(value)).digest()
  // 198.18.0.0/15 is reserved for benchmark testing. These values never
  // reach the operating-system routing table; the hook handles them in-process.
  return (SYNTHETIC_PREFIX | (digest.readUInt16BE(0) & 0x1ffff)) >>> 0
}

function isSyntheticAddress(value) {
  return (((Number(value) >>> 0) & SYNTHETIC_MASK) >>> 0) === SYNTHETIC_PREFIX
}

function parsePeerId(value) {
  if (typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value)) return peerId(value)
  throw new Error('peer ID must be 32 hexadecimal characters')
}

function createBridge({ room, peer, sendRelay, sendLocal, logger = () => {} }) {
  const peerToSynthetic = new Map()
  const syntheticToPeer = new Map()

  function rememberPeer(value) {
    const id = peerId(value)
    const key = peerKey(id)
    let address = peerToSynthetic.get(key)
    if (address === undefined) {
      address = syntheticAddressForPeer(id)
      const owner = syntheticToPeer.get(address)
      if (owner && owner !== key) throw new Error(`synthetic address collision: ${ipv4Text(address)}`)
      peerToSynthetic.set(key, address)
      syntheticToPeer.set(address, key)
    }
    return address
  }

  function registration() {
    return encodeFrame({ type: RELAY_TYPE.REGISTER, room, sender: peer })
  }

  function handleLocal(packet) {
    const frame = decodeLocalFrame(packet)
    if (frame.type === LOCAL_TYPE.HELLO) return { accepted: true, relay: null }
    if (frame.type !== LOCAL_TYPE.BROADCAST && frame.type !== LOCAL_TYPE.UNICAST) {
      return { accepted: false, reason: 'unsupported-local-frame' }
    }

    const target = frame.type === LOCAL_TYPE.UNICAST ? syntheticToPeer.get(frame.destinationAddress) : null
    if (frame.type === LOCAL_TYPE.UNICAST && !target) {
      logger(`dropping packet for unknown synthetic peer ${ipv4Text(frame.destinationAddress)}`)
      return { accepted: false, reason: 'unknown-synthetic-peer' }
    }

    const relay = encodeFrame({
      type: frame.type === LOCAL_TYPE.BROADCAST ? RELAY_TYPE.BROADCAST : RELAY_TYPE.UNICAST,
      room,
      sender: peer,
      target: target ? Buffer.from(target, 'hex') : EMPTY_PEER_ID,
      sourcePort: frame.sourcePort,
      destinationPort: frame.destinationPort,
      payload: frame.payload,
    })
    sendRelay(relay)
    return { accepted: true, relay }
  }

  function handleRelay(packet) {
    const frame = decodeFrame(packet)
    if (frame.type !== RELAY_TYPE.DELIVERY || frame.room !== room) return { accepted: false, reason: 'unsupported-relay-frame' }
    const sourceAddress = rememberPeer(frame.sender)
    const local = encodeLocalFrame({
      type: LOCAL_TYPE.DELIVERY,
      sourceAddress,
      sourcePort: frame.sourcePort,
      destinationPort: frame.destinationPort,
      payload: frame.payload,
    })
    sendLocal(local)
    return { accepted: true, local, sourceAddress }
  }

  return { handleLocal, handleRelay, registration, rememberPeer, peerToSynthetic, syntheticToPeer }
}

function startBridge({ room, peer, relayHost, relayPort = DEFAULT_RELAY_PORT, localPort = DEFAULT_LOCAL_PORT, logger = console.log }) {
  const relaySocket = dgram.createSocket('udp4')
  const localSocket = dgram.createSocket('udp4')
  let hookEndpoint = null
  const bridge = createBridge({
    room,
    peer,
    sendRelay: (packet) => relaySocket.send(packet, relayPort, relayHost),
    sendLocal: (packet) => {
      if (hookEndpoint) localSocket.send(packet, hookEndpoint.port, hookEndpoint.address)
    },
    logger,
  })

  function register() {
    relaySocket.send(bridge.registration(), relayPort, relayHost)
  }

  localSocket.on('error', (error) => logger(`Plan B local bridge error: ${error.message}`))
  relaySocket.on('error', (error) => logger(`Plan B relay socket error: ${error.message}`))
  localSocket.on('message', (packet, rinfo) => {
    if (rinfo.address !== '127.0.0.1' && rinfo.address !== '::1') return
    hookEndpoint = { address: rinfo.address, port: rinfo.port }
    try { bridge.handleLocal(packet) } catch (error) { logger(`Plan B rejected local packet: ${error.message}`) }
  })
  relaySocket.on('message', (packet) => {
    try { bridge.handleRelay(packet) } catch (error) { logger(`Plan B rejected relay packet: ${error.message}`) }
  })
  localSocket.bind(localPort, '127.0.0.1', () => {
    relaySocket.bind(0, '0.0.0.0', () => {
      register()
      logger(`WEL Plan B bridge: relay udp://${relayHost}:${relayPort}, local udp://127.0.0.1:${localPort}`)
    })
  })
  const keepalive = setInterval(register, 30_000)
  return {
    bridge,
    close: () => {
      clearInterval(keepalive)
      localSocket.close()
      relaySocket.close()
    },
    localSocket,
    relaySocket,
  }
}

function readOptions(argv) {
  const options = { relayPort: DEFAULT_RELAY_PORT, localPort: DEFAULT_LOCAL_PORT }
  for (let index = 2; index < argv.length; index += 1) {
    const name = argv[index]
    const value = argv[index + 1]
    if (name === '--room') options.room = Number(value)
    else if (name === '--peer') options.peer = parsePeerId(value)
    else if (name === '--relay-host') options.relayHost = value
    else if (name === '--relay-port') options.relayPort = Number(value)
    else if (name === '--local-port') options.localPort = Number(value)
    else throw new Error(`unknown option: ${name}`)
    index += 1
  }
  if (!Number.isInteger(options.room) || options.room < 1) throw new Error('--room must be a positive integer')
  if (!options.peer || !options.relayHost) throw new Error('--peer and --relay-host are required')
  if (!Number.isInteger(options.relayPort) || options.relayPort < 1 || options.relayPort > 65535) throw new Error('--relay-port is invalid')
  if (!Number.isInteger(options.localPort) || options.localPort < 1 || options.localPort > 65535) throw new Error('--local-port is invalid')
  return options
}

if (require.main === module) {
  try {
    startBridge(readOptions(process.argv))
  } catch (error) {
    console.error(`usage: node bridge.cjs --room <id> --peer <32-hex-id> --relay-host <host> [--relay-port <port>] [--local-port <port>]\n${error.message}`)
    process.exit(2)
  }
}

module.exports = {
  DEFAULT_LOCAL_PORT,
  DEFAULT_RELAY_PORT,
  SYNTHETIC_MASK,
  SYNTHETIC_PREFIX,
  createBridge,
  isSyntheticAddress,
  startBridge,
  syntheticAddressForPeer,
}
