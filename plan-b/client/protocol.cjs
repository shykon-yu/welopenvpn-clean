const MAGIC = Buffer.from('WLC1')
const VERSION = 1
const HEADER_LENGTH = 28

const TYPE = Object.freeze({
  HELLO: 1,
  BROADCAST: 2,
  UNICAST: 3,
  DELIVERY: 4,
})

function ipv4(value) {
  const octets = String(value || '').trim().split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    throw new Error('IPv4 address is invalid')
  }
  return (((octets[0] << 24) >>> 0) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
}

function ipv4Text(value) {
  const number = Number(value) >>> 0
  return [24, 16, 8, 0].map((shift) => (number >>> shift) & 255).join('.')
}

function port(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0 || number > 65535) throw new Error('port is invalid')
  return number
}

function encodeLocalFrame({ type, sourceAddress = 0, destinationAddress = 0, sourcePort = 0, destinationPort = 0, payload = Buffer.alloc(0) }) {
  const body = Buffer.from(payload)
  if (!Object.values(TYPE).includes(type)) throw new Error('local frame type is invalid')
  if (body.length > 65535) throw new Error('local payload is too large')

  const frame = Buffer.alloc(HEADER_LENGTH + body.length)
  MAGIC.copy(frame, 0)
  frame.writeUInt8(VERSION, 4)
  frame.writeUInt8(type, 5)
  frame.writeUInt32BE(Number(sourceAddress) >>> 0, 8)
  frame.writeUInt32BE(Number(destinationAddress) >>> 0, 12)
  frame.writeUInt16BE(port(sourcePort), 16)
  frame.writeUInt16BE(port(destinationPort), 18)
  frame.writeUInt16BE(body.length, 20)
  body.copy(frame, HEADER_LENGTH)
  return frame
}

function decodeLocalFrame(value) {
  const frame = Buffer.from(value)
  if (frame.length < HEADER_LENGTH || !frame.subarray(0, 4).equals(MAGIC)) throw new Error('local frame magic is invalid')
  if (frame.readUInt8(4) !== VERSION) throw new Error('local frame version is unsupported')
  const type = frame.readUInt8(5)
  if (!Object.values(TYPE).includes(type)) throw new Error('local frame type is invalid')
  const payloadLength = frame.readUInt16BE(20)
  if (frame.length !== HEADER_LENGTH + payloadLength) throw new Error('local frame payload length is invalid')
  return {
    type,
    sourceAddress: frame.readUInt32BE(8),
    destinationAddress: frame.readUInt32BE(12),
    sourcePort: frame.readUInt16BE(16),
    destinationPort: frame.readUInt16BE(18),
    payload: Buffer.from(frame.subarray(HEADER_LENGTH)),
  }
}

module.exports = {
  HEADER_LENGTH,
  TYPE,
  decodeLocalFrame,
  encodeLocalFrame,
  ipv4,
  ipv4Text,
}
