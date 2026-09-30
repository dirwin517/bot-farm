// The transport: a real websocket handshake, pushes without polling, and a
// count of how often botfarm actually talks to opencode when nothing happens.
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { connect as netConnect } from "node:net"
import { Supervisor } from "../src/supervisor.mjs"
import { startServer } from "../src/server.mjs"

const mock = spawn(process.execPath, [new URL("./mock-opencode.mjs", import.meta.url).pathname], { stdio: "ignore" })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (c, m) => (c ? console.log("  ok  " + m) : (failed++, console.error("  FAIL " + m)))

await sleep(600)
const sup = new Supervisor({
  url: "http://127.0.0.1:4096",
  statePath: "/tmp/botfarm-ws-" + Date.now() + ".json",
  registryPath: "/tmp/botfarm-wsreg-" + Date.now() + ".json",
  mcpBase: "http://127.0.0.1:4801",
})

// Count every request botfarm makes to opencode, so "does it poll" is a number.
let calls = []
const realFetch = globalThis.fetch
globalThis.fetch = (url, opts) => {
  const u = String(url)
  if (u.includes("127.0.0.1:4096")) calls.push(u.replace("http://127.0.0.1:4096", ""))
  return realFetch(url, opts)
}

await sup.start()
startServer({ supervisor: sup, port: 4801 })
await sup.adopt(sup.unmanaged.map((x) => x.id))
await sleep(1200)

console.log("websocket handshake")
const key = randomBytes(16).toString("base64")
const socket = netConnect(4801, "127.0.0.1")
const frames = []
let buf = Buffer.alloc(0)
let handshake = ""
await new Promise((resolve) => {
  socket.on("connect", () => {
    socket.write(
      `GET /api/socket HTTP/1.1\r\nHost: 127.0.0.1:4801\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    )
  })
  socket.on("data", (chunk) => {
    if (!handshake) {
      const split = chunk.indexOf("\r\n\r\n")
      handshake = chunk.subarray(0, split).toString()
      chunk = chunk.subarray(split + 4)
      resolve()
    }
    buf = Buffer.concat([buf, chunk])
    while (true) {
      const f = readFrame(buf)
      if (!f) break
      buf = buf.subarray(f.size)
      if (f.opcode === 0x1) frames.push(JSON.parse(f.payload.toString()))
      if (f.opcode === 0x9) socket.write(maskedFrame(Buffer.alloc(0), 0xa)) // answer pings
    }
  })
})
ok(/101 Switching Protocols/.test(handshake), "server answers with 101")
const expected = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")
ok(handshake.includes(expected), "and the correct Sec-WebSocket-Accept")

await sleep(400)
ok(frames.length >= 1, "a snapshot arrives on connect without asking")
ok(Array.isArray(frames[0].sessions) && frames[0].totals, "and it is the same state the dashboard renders")

console.log("\npush, not poll")
const before = frames.length
await sup.send(sup.store.list()[0].id, "hello from the test")
await sleep(700)
ok(frames.length > before, `a change pushes a new frame (${frames.length - before})`)

socket.write(maskedFrame(Buffer.from("resync"), 0x1))
await sleep(400)
ok(frames.length > before + 1, "and the client can ask for a resync over the same socket")

console.log("\nthe client speaks first: masked frames are decoded")
ok(frames.at(-1).at > 0, "the resynced frame is well-formed")

console.log("\nshape negotiation does not cache the message")
const target = sup.store.list()[0]
await sup.send(target.id, "first message")
await sup.send(target.id, "second message")
await sleep(400)
const sent = (await sup.client.messages(target.id, { limit: 10 }))
  .flatMap((m) => (m.parts ?? []).map((p) => p.text ?? ""))
ok(sent.includes("second message"), "the second message carries its own text")
ok(sent.filter((t) => t === "first message").length === 1, "and the first is not resent")

console.log("\ntraffic to opencode while nothing is happening")
// stop the mock's busy session so the board is genuinely quiet
for (const s of sup.store.list()) await sup.abort(s.id).catch(() => {})
await sleep(2500)
calls = []
await sleep(6000)
const perSecond = calls.length / 6
console.log(`  ${calls.length} requests in 6s (${perSecond.toFixed(1)}/s):`, [...new Set(calls.map((c) => c.split("?")[0]))].join(", "))
ok(perSecond < 1.5, `a quiet board is nearly silent (${perSecond.toFixed(1)} requests/second)`)
ok(!calls.some((c) => c.includes("/message")), "and no message polling at all while idle")

socket.destroy()
await sup.stop()
mock.kill()
console.log(failed ? `\n${failed} CHECKS FAILED` : "\nall checks passed")
process.exit(failed ? 1 : 0)

// --- a minimal client-side codec, so the test does not trust the server's ---
function maskedFrame(payload, opcode) {
  const mask = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  const header = Buffer.from([0x80 | opcode, 0x80 | masked.length])
  return Buffer.concat([header, mask, masked])
}
function readFrame(b) {
  if (b.length < 2) return null
  const opcode = b[0] & 0x0f
  let len = b[1] & 0x7f
  let off = 2
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4 }
  else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10 }
  if (b.length < off + len) return null
  return { opcode, payload: b.subarray(off, off + len), size: off + len }
}
