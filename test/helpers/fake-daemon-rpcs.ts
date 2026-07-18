// Hand-rolled fakes for the two RPC endpoints lib/daemon.ts probes, so the
// daemon edge-case tests never need a real bitsocial-cli daemon. The PKC fake
// speaks just enough of the websocket protocol (RFC 6455 handshake + small
// unfragmented frames) to answer JSON-RPC subscribe calls from both undici's
// WebSocket (daemon.ts readiness probe) and rpc-websockets (pkc-js). Flip
// `state.ready` to toggle between a healthy daemon and a port that is open
// but not ready (subscribe answered without a subscriptionId).
import crypto from 'node:crypto'
import http from 'node:http'
import type {Duplex} from 'node:stream'

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// Returns the complete frames at the head of `buffer` plus the unconsumed rest.
const decodeFrames = (buffer: Buffer) => {
  const frames: {opcode: number, payload: Buffer}[] = []
  let offset = 0
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 0x0f
    const masked = Boolean(buffer[offset + 1] & 0x80)
    let payloadLength = buffer[offset + 1] & 0x7f
    let headerLength = 2
    if (payloadLength === 126) {
      if (buffer.length - offset < 4) {
        break
      }
      payloadLength = buffer.readUInt16BE(offset + 2)
      headerLength = 4
    }
    else if (payloadLength === 127) {
      if (buffer.length - offset < 10) {
        break
      }
      payloadLength = Number(buffer.readBigUInt64BE(offset + 2))
      headerLength = 10
    }
    const maskLength = masked ? 4 : 0
    if (buffer.length - offset < headerLength + maskLength + payloadLength) {
      break
    }
    const maskKey = buffer.subarray(offset + headerLength, offset + headerLength + maskLength)
    const payload = Buffer.from(buffer.subarray(offset + headerLength + maskLength, offset + headerLength + maskLength + payloadLength))
    if (masked) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4]
      }
    }
    frames.push({opcode, payload})
    offset += headerLength + maskLength + payloadLength
  }
  return {frames, rest: buffer.subarray(offset)}
}

const encodeFrame = (opcode: number, payload: Buffer) => {
  const header = payload.length < 126
    ? Buffer.from([0x80 | opcode, payload.length])
    : Buffer.concat([Buffer.from([0x80 | opcode, 126]), (() => {
        const length = Buffer.alloc(2)
        length.writeUInt16BE(payload.length)
        return length
      })()])
  return Buffer.concat([header, payload])
}

// Upgraded websocket sockets are not covered by closeAllConnections(), so the
// pkc fake registers them in `upgradedSockets` for close() to destroy.
const makeServerHandle = (server: http.Server, state: {ready: boolean}, upgradedSockets = new Set<Duplex>()) => ({
  state,
  server,
  upgradedSockets,
  listen: (port: number) => new Promise<void>(resolve => server.listen(port, '127.0.0.1', () => resolve())),
  close: () => new Promise<void>(resolve => {
    for (const socket of upgradedSockets) {
      socket.destroy()
    }
    server.closeAllConnections()
    server.close(() => resolve())
  })
})

// JSON-RPC over websocket: every *Subscribe call gets {subscriptionId} while
// ready, an empty result otherwise; other methods get an empty result.
export const createFakePkcRpcServer = () => {
  const state = {ready: true}
  let nextSubscriptionId = 1
  const upgradedSockets = new Set<Duplex>()
  const server = http.createServer((request, response) => {
    response.statusCode = 426
    response.end()
  })
  server.on('upgrade', (request, socket) => {
    upgradedSockets.add(socket)
    socket.on('close', () => upgradedSockets.delete(socket))
    const accept = crypto.createHash('sha1').update(`${request.headers['sec-websocket-key']}${WEBSOCKET_GUID}`).digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      ''
    ].join('\r\n'))
    let buffered = Buffer.alloc(0)
    socket.on('error', () => {})
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk])
      const {frames, rest} = decodeFrames(buffered)
      buffered = Buffer.from(rest)
      for (const {opcode, payload} of frames) {
        if (opcode === 8) {
          socket.end(encodeFrame(8, payload))
          return
        }
        if (opcode === 9) {
          socket.write(encodeFrame(10, payload))
          continue
        }
        if (opcode !== 1) {
          continue
        }
        let message: any
        try {
          message = JSON.parse(payload.toString())
        }
        catch {
          continue
        }
        if (message?.id === undefined) {
          continue
        }
        const result = state.ready && String(message.method || '').endsWith('Subscribe')
          ? {subscriptionId: nextSubscriptionId++}
          : {}
        socket.write(encodeFrame(1, Buffer.from(JSON.stringify({jsonrpc: '2.0', id: message.id, result}))))
      }
    })
  })
  return makeServerHandle(server, state, upgradedSockets)
}

// The kubo RPC probe only POSTs /version and checks response.ok.
export const createFakeKuboRpcServer = () => {
  const state = {ready: true}
  const server = http.createServer((request, response) => {
    if (!state.ready) {
      response.statusCode = 500
      return response.end('fake kubo not ready')
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({Version: '0.0.0-fake'}))
  })
  return makeServerHandle(server, state)
}
