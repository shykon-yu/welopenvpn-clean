const MAGIC = Buffer.from('WLB1')
const VERSION = 1
const HEADER_LENGTH = 48
const PEER_ID_LENGTH = 16
const EMPTY_PEER_ID = Buffer.alloc(PEER_ID_LENGTH)

const TYPE = Object.freeze({
  REGISTER: 1,
  BROADCAST: 2,
  UNICAST: 3,
  DELIVERY: 4,
  KEEPALIVE: 5,
})

function peerId(value) {
  if (Buffer.isBuffer(value) && value.length === PEER_ID_LENGTH) return Buffer.from(value)
  if (typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value)) return Buffer.from(value, 'hex')
  throw new Error('peer ID must be exactly 16 bytes')
}

function port(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0 || number > 65535) throw new Error('port is invalid')
  return number
}

function roomId(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > 0xffffffff) throw new Error('room ID is invalid')
  return number
}

function encodeFrame({ type, room, sender, target = EMPTY_PEER_ID, sourcePort = 0, destinationPort = 0, payload = Buffer.alloc(0) }) {
  const body = Buffer.from(payload)
  if (!Object.values(TYPE).includes(type)) throw new Error('frame type is invalid')
  if (body.length > 65535) throw new Error('payload is too large')

  const frame = Buffer.alloc(HEADER_LENGTH + body.length)
  MAGIC.copy(frame, 0)
  frame.writeUInt8(VERSION, 4)
  frame.writeUInt8(type, 5)
  frame.writeUInt32BE(roomId(room), 6)
  peerId(sender).copy(frame, 10)
  peerId(target).copy(frame, 26)
  frame.writeUInt16BE(port(sourcePort), 42)
  frame.writeUInt16BE(port(destinationPort), 44)
  frame.writeUInt16BE(body.length, 46)
  body.copy(frame, HEADER_LENGTH)
  return frame
}

function decodeFrame(value) {
  const frame = Buffer.from(value)
  if (frame.length < HEADER_LENGTH || !frame.subarray(0, 4).equals(MAGIC)) throw new Error('frame magic is invalid')
  if (frame.readUInt8(4) !== VERSION) throw new Error('frame version is unsupported')
  const type = frame.readUInt8(5)
  if (!Object.values(TYPE).includes(type)) throw new Error('frame type is invalid')
  const payloadLength = frame.readUInt16BE(46)
  if (frame.length !== HEADER_LENGTH + payloadLength) throw new Error('frame payload length is invalid')
  return {
    type,
    room: roomId(frame.readUInt32BE(6)),
    sender: Buffer.from(frame.subarray(10, 26)),
    target: Buffer.from(frame.subarray(26, 42)),
    sourcePort: frame.readUInt16BE(42),
    destinationPort: frame.readUInt16BE(44),
    payload: Buffer.from(frame.subarray(HEADER_LENGTH)),
  }
}

function peerKey(value) {
  return peerId(value).toString('hex')
}

function isEmptyPeerId(value) {
  return peerId(value).equals(EMPTY_PEER_ID)
}

module.exports = {
  EMPTY_PEER_ID,
  HEADER_LENGTH,
  PEER_ID_LENGTH,
  TYPE,
  decodeFrame,
  encodeFrame,
  isEmptyPeerId,
  peerId,
  peerKey,
}
