// A small RFC 6455 server, text frames only, no dependencies.
//
// The dashboard already received pushes over SSE rather than polling, but a
// websocket is cheaper per message (2–10 bytes of framing against SSE's
// "data: " plus base64-free UTF-8 reparse), survives proxies that buffer
// event-streams, and gives the client a way to talk back — used here for
// nothing more than pings and a "send me everything again" resync.
//
// Actions stay on plain HTTP. They are one-shot, they want status codes and
// retries, and multiplexing them over a socket would mean inventing request
// ids and error plumbing that fetch already has.

import { createHash, randomBytes } from "node:crypto"

const MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

export function isWebSocketUpgrade(req) {
  return (
    req.headers.upgrade?.toLowerCase() === "websocket" &&
    /\bupgrade\b/i.test(req.headers.connection ?? "") &&
    !!req.headers["sec-websocket-key"]
  )
}

export function accept(req, socket, { onMessage = () => {}, onClose = () => {} } = {}) {
  const key = req.headers["sec-websocket-key"]
  const digest = createHash("sha1").update(key + MAGIC).digest("base64")
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${digest}\r\n\r\n`,
  )
  socket.setNoDelay(true)

  const conn = new Connection(socket)
  let buffer = Buffer.alloc(0)

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const frame = decode(buffer)
      if (!frame) break
      buffer = buffer.subarray(frame.size)
      if (frame.opcode === 0x8) return conn.close()
      if (frame.opcode === 0x9) { socket.write(encode(frame.payload, 0xa)); continue }
      if (frame.opcode === 0xa) { conn.alive = true; continue }
      if (frame.opcode === 0x1) onMessage(frame.payload.toString("utf8"), conn)
    }
  })
  socket.on("error", () => conn.close())
  socket.on("close", () => { conn.open = false; onClose(conn) })
  return conn
}

class Connection {
  constructor(socket) {
    this.socket = socket
    this.open = true
    this.alive = true
    this.id = randomBytes(6).toString("hex")
    // A half-open socket looks identical to a quiet one until you ping it.
    this.heartbeat = setInterval(() => {
      if (!this.open) return
      if (!this.alive) return this.close()
      this.alive = false
      try { this.socket.write(encode(Buffer.alloc(0), 0x9)) } catch { this.close() }
    }, 20000)
  }
  send(text) {
    if (!this.open) return false
    try {
      this.socket.write(encode(Buffer.from(text, "utf8"), 0x1))
      return true
    } catch {
      this.close()
      return false
    }
  }
  close() {
    if (!this.open) return
    this.open = false
    clearInterval(this.heartbeat)
    try { this.socket.end(encode(Buffer.alloc(0), 0x8)) } catch {}
    try { this.socket.destroy() } catch {}
  }
}

function encode(payload, opcode = 0x1) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | opcode // FIN + opcode; server frames are never masked
  return Buffer.concat([header, payload])
}

/** Returns null until a whole frame is buffered. */
function decode(buf) {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  const maskKey = masked ? buf.subarray(offset, offset + 4) : null
  if (masked) offset += 4
  if (buf.length < offset + len) return null
  const payload = Buffer.from(buf.subarray(offset, offset + len))
  if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
  return { opcode, payload, size: offset + len }
}
